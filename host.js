#!/usr/bin/env node
/**
 * hermes-notch host — loads every plugin in ./plugins and drives them into Atoll.
 *
 *   node host.js          stay alive, refresh each plugin on its own interval
 *   node host.js --once   one refresh cycle after connect, then exit (diagnostics)
 *
 * Transport: Atoll RPC (JSON-RPC 2.0 over ws://127.0.0.1:9020), SDK @ebullioscopic/atoll-js.
 * Plugin contract: { id, fallbackPollMs?, watch?, build({ forcePresent }) }.
 * Builds are synchronous; the host owns all I/O to Atoll.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { AtollClient } = require('@ebullioscopic/atoll-js');
const { createResourceState, reconcileResources } = require('./lib/resource-reconciler.js');

const PLUGINS_DIR = path.join(__dirname, 'plugins');
const BUNDLE_ID = 'dev.hima.notch-plugins'; // authorized in Atoll settings
const CONNECT_TIMEOUT_MS = 6000;
const RETRY_MS = 10000;
const ONCE = process.argv.includes('--once');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- load plugins ----------
const plugins = fs.readdirSync(PLUGINS_DIR)
  .filter((f) => f.endsWith('.js') && !f.startsWith('.'))
  .map((f) => {
    try {
      const mod = require(path.join(PLUGINS_DIR, f));
      if (!mod.id || typeof mod.build !== 'function') throw new Error('missing id/build');
      mod.fallbackPollMs = Math.max(15000, Number(mod.fallbackPollMs ?? mod.intervalMs) || 60000);
      log(`plugin loaded: ${mod.id} (${f}, fallback every ${mod.fallbackPollMs / 1000}s)`);
      return mod;
    } catch (e) {
      log(`plugin load FAILED: ${f}: ${e.message}`);
      return null;
    }
  })
  .filter(Boolean);

if (!plugins.length) { console.error('no plugins in', PLUGINS_DIR); process.exit(1); }

// ---------- atoll client ----------
const client = new AtollClient({ bundleIdentifier: BUNDLE_ID });
const state = new Map();
const watchers = new Map();
const refreshTimers = new Map();
const pulseTimers = new Map();
const pulseRetryTimers = new Map();
const pendingPulses = new Map();
const refreshing = new Set();
const refreshAgain = new Set();
let bootstrapped = false;

client.on?.('connected', onConnected);
client.on?.('disconnected', () => { bootstrapped = false; log('disconnected from Atoll (will re-present on reconnect)'); });
client.on?.('error', (e) => log('client error:', e?.message || e));

async function onConnected() {
  if (bootstrapped) return;
  bootstrapped = true;
  log('connected to Atoll');
  try {
    const ok = await client.requestAuthorization();
    log('authorized:', ok);
    if (!ok) { bootstrapped = false; return; }
    await dismissLegacy();
    for (const p of plugins) state.set(p.id, createResourceState());
    startWatchers();
    await cycle();
  } catch (e) {
    log('post-connect error:', e?.message || e);
    bootstrapped = false;
  }
}

function startWatchers() {
  for (const p of plugins) {
    if (typeof p.watch !== 'function' || watchers.has(p.id)) continue;
    try {
      const close = p.watch(
        () => scheduleRefresh(p),
        (error) => log(`${p.id}: state watcher error: ${error?.message || error}`),
      );
      if (typeof close === 'function') watchers.set(p.id, close);
    } catch (error) {
      log(`${p.id}: state watcher failed: ${error?.message || error}`);
    }
  }
}

function scheduleRefresh(p, delayMs = 80) {
  if (!bootstrapped || !client.isConnected) return;
  clearTimeout(refreshTimers.get(p.id));
  refreshTimers.set(p.id, setTimeout(() => {
    refreshTimers.delete(p.id);
    void refresh(p);
  }, delayMs));
}

async function dismissLegacy() {
  for (const p of plugins) {
    const ids = p.legacyIds || {};
    for (const id of ids.activities || []) {
      try { await client.dismissLiveActivity(id); log(`legacy activity dismissed: ${id}`); } catch {}
    }
    for (const id of ids.experiences || []) {
      try { await client.dismissNotchExperience(id); log(`legacy experience dismissed: ${id}`); } catch {}
    }
  }
}

function schedulePulseRetry(p, delayMs) {
  if (!pendingPulses.has(p.id) || pulseRetryTimers.has(p.id)) return;
  pulseRetryTimers.set(p.id, setTimeout(() => {
    pulseRetryTimers.delete(p.id);
    void retryPulse(p);
  }, delayMs));
}

async function retryPulse(p) {
  const pending = pendingPulses.get(p.id);
  if (!pending) return;
  if (Date.now() >= pending.expiresAt) {
    pendingPulses.delete(p.id);
    log(`${p.id}: finish pulse retry window expired`);
    return;
  }
  if (!bootstrapped || !client.isConnected) return schedulePulseRetry(p, 500);
  if (refreshing.has(p.id)) return schedulePulseRetry(p, 150);

  refreshing.add(p.id);
  const st = state.get(p.id) || createResourceState();
  state.set(p.id, st);
  try {
    await reconcileResources(p, pending.built, st, client, log);
    if (st.presented.activities.has(pending.activityId)) {
      pendingPulses.delete(p.id);
      log(`${p.id}: finish pulse delivered on retry`);
    } else {
      pending.attempts++;
      schedulePulseRetry(p, Math.min(1500, 250 * (2 ** Math.min(pending.attempts, 3))));
    }
  } catch (error) {
    log(`${p.id}: finish pulse retry failed: ${error?.message || error}`);
    pending.attempts++;
    schedulePulseRetry(p, Math.min(1500, 250 * (2 ** Math.min(pending.attempts, 3))));
  } finally {
    refreshing.delete(p.id);
    if (refreshAgain.delete(p.id)) scheduleRefresh(p, 0);
  }
}

function schedulePulseExpiry(p, durationMs) {
  clearTimeout(pulseTimers.get(p.id));
  pulseTimers.set(p.id, setTimeout(() => {
    pulseTimers.delete(p.id);
    const pending = pendingPulses.get(p.id);
    if (pending && Date.now() >= pending.expiresAt) {
      pendingPulses.delete(p.id);
      clearTimeout(pulseRetryTimers.get(p.id));
      pulseRetryTimers.delete(p.id);
    }
    void refresh(p);
  }, Math.max(0, Number(durationMs) || 0) + 150));
}

async function refresh(p) {
  if (!bootstrapped || !client.isConnected) return;
  if (refreshing.has(p.id)) { refreshAgain.add(p.id); return; }
  refreshing.add(p.id);
  const st = state.get(p.id) || createResourceState();
  state.set(p.id, st);
  try {
    const built = p.build({ forcePresent: st.presented.experiences.size === 0 }) || {};
    if (built.pulse) {
      const durationMs = Number(built.pulseDurationMs) || 5500;
      const n = (built._metrics?.finishedNow || []).length;
      log(`${p.id}: PULSE - ${n || 1} finished; sneak-peek requested`);
      pendingPulses.set(p.id, { built, activityId: built.liveActivity?.id, expiresAt: Date.now() + durationMs, attempts: 0 });
      schedulePulseExpiry(p, durationMs);
    }
    await reconcileResources(p, built, st, client, log);
    if (built.pulse) {
      if (st.presented.activities.has(built.liveActivity?.id)) {
        pendingPulses.delete(p.id);
        clearTimeout(pulseRetryTimers.get(p.id));
        pulseRetryTimers.delete(p.id);
      } else schedulePulseRetry(p, 250);
    }
    if (Number(built.nextWakeInMs) > 0) scheduleRefresh(p, Number(built.nextWakeInMs));
  } catch (error) {
    log(`${p.id}: build/reconcile error: ${error?.message || error}`);
  } finally {
    refreshing.delete(p.id);
    if (refreshAgain.delete(p.id)) scheduleRefresh(p, 0);
  }
}

async function cycle() { for (const p of plugins) await refresh(p); }

// ---------- main ----------
process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message || e));


(async () => {
  for (;;) {
    try {
      await Promise.race([
        client.connect(),
        sleep(CONNECT_TIMEOUT_MS).then(() => { throw new Error(`no connection within ${CONNECT_TIMEOUT_MS}ms`); }),
      ]);
      break;
    } catch (e) {
      log('connect attempt failed:', e.message, `— retrying in ${RETRY_MS / 1000}s`);
      await sleep(RETRY_MS);
    }
  }

  await sleep(1200);
  if (!bootstrapped) { log('connected event missing — bootstrapping manually'); await onConnected(); }

  if (ONCE) { await sleep(2500); log('--once: exiting'); process.exit(0); }

  for (const p of plugins) setInterval(() => refresh(p), p.fallbackPollMs);

  // Watchdog: the SDK gives up reconnecting after 5 attempts; restart it.
  setInterval(() => {
    if (!client.isConnected) {
      log('watchdog: not connected — reconnecting');
      bootstrapped = false;
      client.connect().catch((e) => log('watchdog connect failed:', e?.message || e));
    }
  }, 30000);

  log('host running');
})();
