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
function requiredPositiveInt(argv, name) {
  const raw = arg(argv, name, null);
  const value = Number(raw);
  if (raw == null || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer for the exact Atoll window`);
  return value;
}
function driverCall(socket, tool, input) {
  let output;
  try {
    output = execFileSync(DRIVER, [
      'call', tool, '--socket', socket, '--json', JSON.stringify(input),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || '').trim();
    throw new Error(`CuaDriver ${tool} failed: ${detail.slice(0, 500)}`);
  }
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`CuaDriver ${tool} returned non-JSON output: ${String(output).slice(0, 500)}`);
  }
}
function snapshotWindow(socket, pid, windowId) {
  return driverCall(socket, 'get_window_state', {
    pid,
    window_id: windowId,
    include_screenshot: false,
    max_elements: 2000,
  });
}
const EXPECTED_DUMMY_LABELS = [
  'Hermes sessions',
  'Build the release notes',
  'Approve the sample deploy',
  'Research the API shape',
];
function stateText(state) {
  const elements = Array.isArray(state?.elements) ? state.elements : [];
  return elements.flatMap((element) => [element.label, element.value, element.role])
    .concat(state?.tree_markdown || [])
    .filter((value) => value != null)
    .join('\\n')
    .toLocaleLowerCase();
}
function isExpandedHermesState(state) {
  if (!state || state.degraded || state.elements_complete === false) return false;
  const text = stateText(state);
  return Array.isArray(state.elements) && state.elements.length > 0
    && EXPECTED_DUMMY_LABELS.every((label) => text.includes(label.toLocaleLowerCase()));
}
function resolveAXTab(state, label) {
  const wanted = String(label || '').trim().toLocaleLowerCase();
  if (!wanted) throw new Error('--tab-label must be the exact current AX label; coordinates are not accepted');
  const matches = (Array.isArray(state?.elements) ? state.elements : []).filter((element) => {
    const labels = [element.label, element.value]
      .filter((value) => value != null)
      .map((value) => String(value).trim().toLocaleLowerCase());
    const actions = Array.isArray(element.actions) ? element.actions.map(String) : [];
    return labels.includes(wanted) && actions.some((action) => /press|open|select/i.test(action));
  });
  if (matches.length !== 1) {
    throw new Error(`expected exactly one actionable AX element labelled ${JSON.stringify(label)}, found ${matches.length}; pass the label from a fresh get_window_state response`);
  }
  const element = matches[0];
  if (element.element_token) return { element_token: element.element_token };
  if (Number.isInteger(element.element_index) && /^s[0-9a-f]{8}$/.test(String(state.snapshot_id || ''))) {
    return { element_index: element.element_index, snapshot_id: state.snapshot_id };
  }
  throw new Error('the AX snapshot exposed no usable element token; refusing to fall back to coordinates');
}
function pressAXTab(socket, pid, windowId, state, label) {
  const target = resolveAXTab(state, label);
  return driverCall(socket, 'click', {
    ...target,
    pid,
    window_id: windowId,
    action: 'press',
    delivery_mode: 'background',
  });
}
async function waitForExpandedState(socket, pid, windowId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() <= deadline) {
    lastState = snapshotWindow(socket, pid, windowId);
    if (isExpandedHermesState(lastState)) return lastState;
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  const detail = lastState?.degraded_reason || 'the exact window did not expose the expected synthetic session labels';
  throw new Error(`expanded Hermes AX state was not verified in the background: ${detail}`);
}
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
  const pid = requiredPositiveInt(argv, '--pid');
  const windowId = requiredPositiveInt(argv, '--window-id');
  const tabLabel = arg(argv, '--tab-label', null);
  const output = path.resolve(arg(argv, '--output', path.join(process.env.HOME, '.hermes/cache/scratch/atoll-demo/hermes-expanded-demo.raw.png')));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const client = new AtollClient({ bundleIdentifier: 'dev.hima.notch-plugins' }); let paused = false;
  try {
    await client.connect(); const pids = hostPids();
    if (pids.length) { pids.forEach((pid) => process.kill(pid, 'SIGTERM')); paused = true; await sleep(1200); }
    try { await client.dismissLiveActivity('hermes.monitor.v3'); } catch (_) {}
    await sleep(800);
    const experience = monitor._render.tab(dummyMetrics()); experience.id = DEMO_ID;
    if (experience.tab) experience.tab.title = '\u200B';
    try { await client.updateNotchExperience(experience); } catch (_) { await client.presentNotchExperience(experience); }
    await sleep(900);

    // Select only through a caller-supplied, exact AX element token. If the
    // correct panel is already expanded, no action is sent at all. CuaDriver's
    // background AX press does not move the pointer or steal focus; coordinates
    // and the old coordinate helper are deliberately forbidden.
    let state = snapshotWindow(socket, pid, windowId);
    let selection = 'already-open';
    if (!isExpandedHermesState(state)) {
      if (!tabLabel) {
        throw new Error('the correct Hermes tab is not already expanded; pass --tab-label with the exact actionable AX label from get_window_state, or open the tab and retry');
      }
      pressAXTab(socket, pid, windowId, state, tabLabel);
      state = await waitForExpandedState(socket, pid, windowId);
      selection = 'background-ax';
    }
    if (!isExpandedHermesState(state)) throw new Error('refusing to capture: the expected expanded Hermes AX state was not verified');
    driverCall(socket, 'get_desktop_state', { screenshot_out_file: output });
    const manifest = { source: 'synthetic-debug-panel', experienceId: DEMO_ID, screenshot: output, capturedAt: new Date().toISOString(), dummySessions: 4, states: ['running', 'needs-action', 'open', 'ended'], selection, assertedWindow: { pid, windowId }, tabLabel: tabLabel || null, uiAssertion: EXPECTED_DUMMY_LABELS };
    fs.writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
  } finally {
    try { await client.dismissNotchExperience(DEMO_ID); } catch (_) {}
    client.disconnect(); if (paused) console.log(JSON.stringify({ restoredHostPid: restoreHost() }));
  }
}
if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.stack || e.message); process.exitCode = 1; });
