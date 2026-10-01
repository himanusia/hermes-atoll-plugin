#!/usr/bin/env node
/**
 * Record a real Atoll notch animation with synthetic, display-only data.
 * The host is paused while the owned demo activity is presented and is
 * restored in finally. Every frame is captured through the current CuaDriver
 * daemon, cropped to the notch only, and assembled into a timed GIF.
 *
 *   node tools/record-demo-gif.js --socket /path/to/cua.sock
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { AtollClient } = require('@ebullioscopic/atoll-js');
const { descriptor } = require('./demo-effects');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver';
const DEMO_ID = 'hermes.monitor.debug-demo';
const REAL_ACTIVITY_ID = 'hermes.monitor.v3';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function arg(args, name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
function hostPids() {
  const host = path.join(ROOT, 'host.js');
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line.split(/\s+/).slice(1).includes(host))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter(Number.isInteger);
}
function captureFrame(socket, raw, png) {
  execFileSync(DRIVER, ['call', 'get_desktop_state', '--socket', socket, '--json', JSON.stringify({ screenshot_out_file: raw })], { stdio: 'pipe', timeout: 10000 });
  // The notch is centered. Keep only its black silhouette band; this excludes
  // menu-bar icons, desktop windows, and the wallpaper below the notch.
  execFileSync('python3', ['-c', [
    'from PIL import Image',
    'import sys',
    'im=Image.open(sys.argv[1]).convert("RGB")',
    'cx=im.width//2',
    'im.crop((cx-285,0,cx+285,86)).save(sys.argv[2])',
  ].join(';'), raw, png], { timeout: 10000 });
  fs.unlinkSync(raw);
}
function restoreHost() {
  const logPath = path.join(process.env.HOME, '.hermes/logs/notch/hermes-atoll.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'host.js')], { cwd: ROOT, detached: true, stdio: ['ignore', log, log] });
  child.unref();
  fs.closeSync(log);
  return child.pid;
}

async function main(argv) {
  const socket = arg(argv, '--socket', null);
  if (!socket) throw new Error('--socket is required (use the already-running CuaDriver daemon socket)');
  const phase = arg(argv, '--phase', 'running-1');
  const seconds = Number(arg(argv, '--seconds', '3'));
  const fps = Number(arg(argv, '--fps', '10'));
  const output = path.resolve(arg(argv, '--output', path.join(process.env.HOME, '.hermes/cache/scratch/atoll-demo/hermes-notch-demo.gif')));
  if (!Number.isFinite(seconds) || seconds < 2 || seconds > 10) throw new Error('--seconds must be 2..10');
  if (!Number.isFinite(fps) || fps < 5 || fps > 20) throw new Error('--fps must be 5..20');
  const frameCount = Math.max(1, Math.round(seconds * fps));
  const dir = path.dirname(output);
  const frames = path.join(dir, 'frames');
  fs.rmSync(frames, { recursive: true, force: true });
  fs.mkdirSync(frames, { recursive: true });
  const client = new AtollClient({ bundleIdentifier: 'dev.hima.notch-plugins' });
  let paused = false;
  const manifest = { source: 'synthetic-debug-demo', phase, requestedSeconds: seconds, requestedFps: fps, frameCount, output, frames: [] };
  try {
    await client.connect();
    const pids = hostPids();
    if (pids.length) {
      pids.forEach((pid) => process.kill(pid, 'SIGTERM'));
      paused = true;
      await sleep(1200);
    }
    try { await client.dismissLiveActivity(REAL_ACTIVITY_ID); } catch (_) {}
    try { await client.dismissLiveActivity(DEMO_ID); } catch (_) {}
    await sleep(800);
    const demo = descriptor(phase, seconds + 2);
    if (!demo) throw new Error(`phase ${phase} has no activity descriptor`);
    await client.presentLiveActivity(demo);
    await sleep(500);
    const interval = 1000 / fps;
    const startedAt = Date.now();
    for (let index = 0; index < frameCount; index += 1) {
      const target = startedAt + index * interval;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
      const name = `frame-${String(index).padStart(3, '0')}.png`;
      const png = path.join(frames, name);
      captureFrame(socket, path.join(frames, `.raw-${name}`), png);
      manifest.frames.push({ index, capturedAt: new Date().toISOString(), path: `frames/${name}` });
    }
    const capturedMs = manifest.frames.map((frame) => Date.parse(frame.capturedAt)).filter(Number.isFinite);
    const gaps = capturedMs.slice(1).map((time, index) => Math.max(40, time - capturedMs[index]));
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianIntervalMs = sortedGaps.length ? sortedGaps[Math.floor(sortedGaps.length / 2)] : Math.round(1000 / fps);
    manifest.captureSpanSeconds = capturedMs.length > 1 ? (capturedMs.at(-1) - capturedMs[0]) / 1000 : 0;
    manifest.medianIntervalMs = medianIntervalMs;
    manifest.gifDurationSeconds = (gaps.reduce((sum, gap) => sum + gap, 0) + medianIntervalMs) / 1000;
    manifest.timing = 'GIF frame durations preserve the measured native capture cadence; no speed-up';
    fs.writeFileSync(path.join(dir, 'hermes-notch-demo.manifest.json'), `${JSON.stringify(manifest, null, 2)}\\n`);
    const timingFile = path.join(dir, '.hermes-notch-demo-timing.json');
    fs.writeFileSync(timingFile, JSON.stringify({ frames: manifest.frames.map((frame) => path.join(dir, frame.path)), capturedMs }));
    execFileSync('python3', ['-c', [
      'from PIL import Image',
      'from datetime import datetime',
      'import json,sys',
      'data=json.load(open(sys.argv[1]))',
      'paths=data["frames"]',
      'ts=data["capturedMs"]',
      'gaps=[max(40,b-a) for a,b in zip(ts,ts[1:])]',
      'g=sorted(gaps)[len(gaps)//2] if gaps else 100',
      'durations=[round(x/10)*10 for x in (gaps+[g])]',
      'imgs=[Image.open(p).convert("RGB") for p in paths]',
      'imgs[0].save(sys.argv[2],save_all=True,append_images=imgs[1:],duration=durations,loop=0,optimize=True)',
    ].join(';'), timingFile, output], { timeout: 30000 });
    fs.unlinkSync(timingFile);
    console.log(JSON.stringify({ output, phase, frameCount: manifest.frames.length, captureSpanSeconds: manifest.captureSpanSeconds, gifDurationSeconds: manifest.gifDurationSeconds, source: manifest.source }, null, 2));
  } finally {
    try { await client.dismissLiveActivity(DEMO_ID); } catch (_) {}
    client.disconnect();
    if (paused) console.log(JSON.stringify({ restoredHostPid: restoreHost() }));
    fs.writeFileSync(path.join(dir, 'hermes-notch-demo.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
