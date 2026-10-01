#!/usr/bin/env node
'use strict';
// Synthetic display-only fixtures. Never reads or writes Hermes session data.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { AtollClient } = require('@ebullioscopic/atoll-js');
const monitor = require('../plugins/hermes-monitor');
const PHASES = ['start', 'running-1', 'running-12', 'needs-action', 'complete', 'idle', 'hidden'];
const DEMO_ID = 'hermes.monitor.debug-demo';
const REAL_ID = 'hermes.monitor.v3';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(phase) {
  if (!PHASES.includes(phase)) throw new Error(`Unknown phase: ${phase}`);
  const n = phase === 'running-12' ? 12 : ['start', 'running-1'].includes(phase) ? 1 : 0;
  const sessions = Array.from({ length: n }, (_, i) => ({id: `demo-${i}`, title: 'Demo Hermes', status: 'running', turnActive: true}));
  if (phase === 'needs-action') sessions.push({id: 'demo-approval', title: 'Demo approval', status: 'needs-action', needsAction: true, turnActive: false});
  const m = {dbOk: true, state: n ? 'running' : phase === 'complete' ? 'done' : phase === 'needs-action' ? 'needs-action' : 'idle', active: sessions.filter(s => s.turnActive), sessions, sessionsToday: 0, previewEnabled: false};
  if (phase === 'start' || phase === 'complete') {
    m.previewEnabled = true;
    m.preview = {kind: phase === 'start' ? 'start' : 'finish', title: 'Demo Hermes', subtitle: phase === 'start' ? 'Cek animasi notch dan preview request' : 'Complete'};
  }
  return m;
}
function descriptor(phase, hold) {
  if (phase === 'hidden') return null;
  const d = monitor._render.liveActivity(fixture(phase));
  d.id = DEMO_ID;
  d.metadata = {...d.metadata, source: 'synthetic-debug-demo'};
  if (d.sneakPeekConfig.enabled) d.sneakPeekConfig.duration = hold;
  return d;
}
function capture(dir, phase, socket) {
  fs.mkdirSync(dir, {recursive: true});
  const full = path.join(dir, `.raw-${phase}.png`);
  const dest = path.join(dir, `${phase}.png`);
  execFileSync('/Applications/CuaDriver.app/Contents/MacOS/cua-driver', ['call', 'get_desktop_state', '--socket', socket, '--json', JSON.stringify({screenshot_out_file: full})], {stdio: 'pipe', timeout: 10000});
  // Retain only the native notch silhouette and content; discard menus,
  // desktop wallpaper, and unrelated windows.
  execFileSync('python3', ['-c', 'from PIL import Image;import sys;im=Image.open(sys.argv[1]);cx=im.width//2;im.crop((cx-285,0,cx+285,86)).save(sys.argv[2])', full, dest], {timeout: 10000});
  fs.unlinkSync(full);
  return dest;
}
async function main(args) {
  const phase = args[0] || 'all';
  const val = (key, fallback) => {const i = args.indexOf(key); return i < 0 ? fallback : args[i+1];};
  const hold = Number(val('--seconds', '6'));
  if (!Number.isFinite(hold) || hold < 2 || hold > 30) throw new Error('--seconds must be 2..30');
  const phases = phase === 'all' ? PHASES : [phase];
  phases.forEach(p => fixture(p));
  if (args.includes('--dry-run')) {
    console.log(JSON.stringify(phases.map(p => {const d=descriptor(p,hold);return {phase:p,id:d?.id || null,count:fixture(p).active.length,preview:d?.sneakPeekTitle || null,content:d?.trailingContent.type || null};}),null,2));
    return;
  }
  const dir = val('--capture-dir', null), socket = val('--socket', null);
  if (dir && !socket) throw new Error('--capture-dir requires --socket');
  const root = path.resolve(__dirname, '..');
  const host = path.join(root, 'host.js');
  const processes = execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'}).split('\n');
  const hostPids = processes.filter(l => l.trim().split(/\s+/).slice(1).includes(host)).map(l => Number(l.trim().split(/\s+/)[0]));
  const client = new AtollClient({bundleIdentifier:'dev.hima.notch-plugins'});
  let paused = false;
  const manifest = [];
  try {
    await client.connect();
    if (hostPids.length) {
      hostPids.forEach(pid => process.kill(pid, 'SIGTERM'));
      paused = true;
      await sleep(1200);
    }
    await client.dismissLiveActivity(REAL_ID);
    await sleep(800);
    for (const p of phases) {
      await client.dismissLiveActivity(DEMO_ID);
      await sleep(800); // Let native view/cache teardown finish.
      const d = descriptor(p,hold);
      if (d) await client.presentLiveActivity(d);
      await sleep(1100);
      const file = dir ? capture(path.resolve(dir),p,socket) : null;
      const row = {phase:p,source:'synthetic-debug-demo',timestamp:new Date().toISOString(),screenshot:file};
      manifest.push(row);
      console.log(JSON.stringify(row));
      await sleep(Math.max(0,hold*1000-1100));
    }
  } finally {
    try {await client.dismissLiveActivity(DEMO_ID);} catch (_) {}
    client.disconnect();
    if (paused) {
      const log = fs.openSync(path.join(process.env.HOME,'.hermes/logs/notch/hermes-atoll.log'),'a');
      const child=spawn(process.execPath,[host],{cwd:root,detached:true,stdio:['ignore',log,log]});
      child.unref(); fs.closeSync(log);
      console.log(JSON.stringify({restoredHostPid:child.pid}));
    }
    if (dir) fs.writeFileSync(path.join(path.resolve(dir),'manifest.json'),JSON.stringify(manifest,null,2));
  }
}
module.exports={PHASES,fixture,descriptor};
if (require.main === module) main(process.argv.slice(2)).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
