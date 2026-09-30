#!/usr/bin/env node
/** Capture the plugin's real expanded dashboard renderer with safe dummy rows. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { AtollClient } = require('@ebullioscopic/atoll-js');
const monitor = require('../plugins/hermes-monitor');

const ROOT = path.resolve(__dirname, '..');
const DRIVER = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver';
const DEMO_ID = 'hermes.monitor.tab.v17';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const arg = (a, n, d) => { const i = a.indexOf(n); return i < 0 ? d : a[i + 1]; };
function hostPids() {
  const host = path.join(ROOT, 'host.js');
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((x) => x.split(/\s+/).slice(1).includes(host)).map((x) => Number(x.split(/\s+/)[0])).filter(Number.isInteger);
}
function restoreHost() {
  const logPath = path.join(process.env.HOME, '.hermes/logs/notch/hermes-atoll.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const fd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'host.js')], { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] });
  child.unref(); fs.closeSync(fd); return child.pid;
}
function dummyMetrics() {
  const now = Date.now() / 1000;
  const session = (id, title, extra = {}) => ({
    id, label: id.slice(-6), title, status: 'open', turnActive: false, activity: 'idle', activityDescription: '',
    source: 'fixture', model: 'demo-model', provider: 'demo-provider', billingMode: 'sample', profile: 'demo',
    startedAt: now - 1800, lastActivityAt: now - 20, endedAt: null, turnStartedAt: null,
    messageCount: 8, toolCallCount: 3, apiCallCount: 4, inputTokens: 1200, outputTokens: 730,
    cacheReadTokens: 160, cacheWriteTokens: 0, reasoningTokens: 480,
    recentActions: [{ label: 'Read a file', at: now - 35 }, { label: 'Ran a command', at: now - 20 }], ...extra,
  });
  const sessions = [
    session('fixture-running-01', 'Build the release notes', { status: 'running', turnActive: true, activity: 'working', activityDescription: 'Running a local check', turnStartedAt: now - 45, lastActivityAt: now - 4 }),
    session('fixture-approval-02', 'Approve the sample deploy', { status: 'needs-action', needsAction: true, activity: 'needs input', activityDescription: 'Waiting for your approval' }),
    session('fixture-open-03', 'Research the API shape'),
    session('fixture-ended-04', 'Finished dummy task', { status: 'ended', endedAt: now - 60, activity: 'idle' }),
  ];
  return { dbOk: true, state: 'running', pulse: false, pulseActive: false, finishedNow: [], startedNow: [], active: [sessions[0]], sessions, needsActionCount: 1, sessionsToday: 4, recentDone: sessions[3], lastFinish: null, lastFinishTitle: null, lastFinishText: null, observedAt: Date.now(), nextWakeInMs: 0 };
}
async function main(argv) {
  const socket = arg(argv, '--socket', null); if (!socket) throw new Error('--socket is required');
  const output = path.resolve(arg(argv, '--output', path.join(process.env.HOME, '.hermes/cache/scratch/atoll-demo/hermes-expanded-demo.raw.png')));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const client = new AtollClient({ bundleIdentifier: 'dev.hima.notch-plugins' }); let paused = false;
  try {
    await client.connect(); const pids = hostPids();
    if (pids.length) { pids.forEach((pid) => process.kill(pid, 'SIGTERM')); paused = true; await sleep(1200); }
    for (const id of ['hermes.monitor.v3', 'hermes.monitor.tab.v17', DEMO_ID]) {
      try { await client.dismissLiveActivity(id); } catch (_) {}
      try { await client.dismissNotchExperience(id); } catch (_) {}
    }
    await sleep(800);
    const experience = monitor._render.tab(dummyMetrics()); experience.id = DEMO_ID;
    if (experience.tab) experience.tab.title = '\u200B';
    await client.presentNotchExperience(experience);
    await sleep(900);
    // Open the actual Atoll tab, not a synthetic browser window.
    // Sparkles is the Hermes tab pill just left of the music control.
    execFileSync(path.join(ROOT, 'tools', 'click'), ['760', '18'], { timeout: 10000 });
    await sleep(2200);
    execFileSync(DRIVER, ['call', 'get_desktop_state', '--socket', socket, '--json', JSON.stringify({ screenshot_out_file: output })], { stdio: 'pipe', timeout: 10000 });
    const manifest = { source: 'synthetic-debug-panel', experienceId: DEMO_ID, screenshot: output, capturedAt: new Date().toISOString(), dummySessions: 4, states: ['running', 'needs-action', 'open', 'ended'] };
    fs.writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    try { await client.dismissNotchExperience(DEMO_ID); } catch (_) {}
    client.disconnect(); if (paused) console.log(JSON.stringify({ restoredHostPid: restoreHost() }));
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
