#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
let lifecycle;
try { lifecycle = require('../lib/resource-reconciler.js'); }
catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
assert.equal(typeof lifecycle?.createResourceState, 'function', 'resource reconciler exposes its state factory');
assert.equal(typeof lifecycle?.reconcileResources, 'function', 'resource reconciler exposes resource reconciliation');

const { createResourceState, reconcileResources } = lifecycle;
const calls = [];
const client = {
  presentLiveActivity: async (descriptor) => calls.push(`present-activity:${descriptor.id}`),
  updateLiveActivity: async (descriptor) => calls.push(`update-activity:${descriptor.id}`),
  dismissLiveActivity: async (id) => calls.push(`dismiss-activity:${id}`),
  presentNotchExperience: async (descriptor) => calls.push(`present-experience:${descriptor.id}`),
  updateNotchExperience: async (descriptor) => calls.push(`update-experience:${descriptor.id}`),
  dismissNotchExperience: async (id) => calls.push(`dismiss-experience:${id}`),
};
const plugin = { id: 'hermes.monitor', ownedIds: { activities: ['activity'], experiences: ['tab'] }, persistentIds: { experiences: ['tab'] } };
const state = createResourceState();
const log = () => {};

async function run() {
  await reconcileResources(plugin, {
    liveActivity: null,
    experiences: [{ id: 'tab', version: 'idle' }],
    keepPresented: { activities: [], experiences: ['tab'] },
  }, state, client, log);
  assert.deepEqual(calls, ['dismiss-activity:activity', 'present-experience:tab'], 'idle keeps tab while removing stale wing');

  calls.length = 0;
  await reconcileResources(plugin, { liveActivity: null, experiences: [] }, state, client, log);
  assert.deepEqual(calls, [], 'declared persistent tab survives an omitted keep-presented policy');

  calls.length = 0;
  await reconcileResources(plugin, {
    liveActivity: { id: 'activity', version: 'running' },
    experiences: [{ id: 'tab', version: 'running' }],
    keepPresented: { activities: ['activity'], experiences: ['tab'] },
  }, state, client, log);
  assert.deepEqual(calls, ['present-activity:activity', 'update-experience:tab'], 'new turn presents wing and refreshes the existing tab');

  calls.length = 0;
  await reconcileResources(plugin, {
    liveActivity: { id: 'activity', version: 'finished' },
    experiences: [],
    keepPresented: { activities: ['activity'], experiences: ['tab'] },
    pulse: true,
  }, state, client, log);
  assert.deepEqual(calls, ['present-activity:activity'], 'finish pulse re-presents wing without touching the tab');

  calls.length = 0;
  await reconcileResources(plugin, {
    liveActivity: null,
    experiences: [],
    keepPresented: { activities: ['activity'], experiences: ['tab'] },
  }, state, client, log);
  assert.deepEqual(calls, [], 'pulse grace keeps both resources without redundant RPC');

  await reconcileResources(plugin, {
    liveActivity: null,
    experiences: [],
    keepPresented: { activities: [], experiences: ['tab'] },
  }, state, client, log);
  assert.deepEqual(calls, ['dismiss-activity:activity'], 'pulse expiry dismisses only the wing');
  assert.ok(!calls.some((call) => call.includes('dismiss-experience:tab')), 'the idle Hermes tab is never dismissed');

  let failOnce = true;
  const retryCalls = [];
  const retryClient = {
    ...client,
    presentLiveActivity: async (descriptor) => {
      retryCalls.push(`present:${descriptor.id}`);
      if (failOnce) { failOnce = false; throw new Error('temporary RPC failure'); }
    },
  };
  const retryState = createResourceState();
  const pendingPulse = {
    liveActivity: { id: 'activity', version: 'finish' },
    experiences: [],
    keepPresented: { activities: ['activity'], experiences: ['tab'] },
    pulse: true,
  };
  await reconcileResources(plugin, pendingPulse, retryState, retryClient, log);
  assert.ok(!retryState.presented.activities.has('activity'), 'a failed sneak-peek is not marked as delivered');
  await reconcileResources(plugin, pendingPulse, retryState, retryClient, log);
  assert.deepEqual(retryCalls, ['present:activity', 'present:activity'], 'the same pulse can be retried without changing ids');
  assert.ok(retryState.presented.activities.has('activity'), 'a successful retry becomes delivered');
  console.log('PASS: tab persists through empty, idle, active, finish-pulse, and post-pulse states');
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
