#!/usr/bin/env node
/**
 * Deterministic tests for the monitor's update pacing.
 *
 * Atoll accounts extension registrations per bundle in a rolling window, and the
 * dashboard tab carries volatile counters, so the tab is rewritten on a floor
 * instead of on every database write. The finish sneak peek is the only signal a
 * closed notch can render as text, so it is allowed once per burst. Both rules
 * are pure decisions so they can be tested without a database or an Atoll RPC.
 *
 *   node tools/test-pacing.js
 */
'use strict';

const assert = require('node:assert/strict');
const monitor = require('../plugins/hermes-monitor.js');
const {
  EXPERIENCE_MIN_INTERVAL_MS,
  PEEK_MIN_INTERVAL_MS,
  START_PREVIEW_MIN_INTERVAL_MS,
  FINISH_PREVIEW_MIN_INTERVAL_MS,
  PREVIEW_DURATION_S,
  peekDecision,
  startPreviewDecision,
  finishPreviewDecision,
  experienceSendDecision,
} = monitor._pacing;
const { shouldReschedule } = require('../lib/wake-schedule.js');

assert.equal(typeof peekDecision, 'function', 'finish peek decision is exported');
assert.equal(typeof startPreviewDecision, 'function', 'start preview decision is exported');
assert.equal(typeof finishPreviewDecision, 'function', 'finish preview decision is exported');
assert.equal(typeof experienceSendDecision, 'function', 'experience pacing decision is exported');
assert.equal(PREVIEW_DURATION_S, 2.5, 'start and finish previews use a 2.5 second duration');
assert.ok(EXPERIENCE_MIN_INTERVAL_MS >= 5000, 'the tab floor keeps RPC pressure well under the reference cadence');
assert.ok(START_PREVIEW_MIN_INTERVAL_MS >= 5000, 'start previews are burst-limited independently');
assert.ok(FINISH_PREVIEW_MIN_INTERVAL_MS >= 5000, 'finish previews are burst-limited independently');

// --- peek gating ---------------------------------------------------------
assert.deepEqual(
  peekDecision({ pulse: false, nowMs: 100000, lastPeekAtMs: 0 }),
  { peek: false, suppressed: false },
  'an ordinary refresh never asks for a sneak peek',
);
assert.deepEqual(
  peekDecision({ pulse: true, nowMs: 100000, lastPeekAtMs: 0 }),
  { peek: true, suppressed: false },
  'the first finish shows the completion text',
);
assert.deepEqual(
  peekDecision({ pulse: true, nowMs: 100000, lastPeekAtMs: 100000 - PEEK_MIN_INTERVAL_MS + 1 }),
  { peek: false, suppressed: true },
  'a second finish inside the peek window is suppressed and reported',
);
assert.deepEqual(
  peekDecision({ pulse: true, nowMs: 100000, lastPeekAtMs: 100000 - PEEK_MIN_INTERVAL_MS }),
  { peek: true, suppressed: false },
  'the finish peek window reopens exactly at the floor',
);
assert.deepEqual(
  startPreviewDecision({ started: true, nowMs: 100000, lastStartAtMs: 0 }),
  { peek: true, suppressed: false },
  'a real new turn opens a start preview',
);
assert.deepEqual(
  startPreviewDecision({ started: true, nowMs: 100000, lastStartAtMs: 100000 - START_PREVIEW_MIN_INTERVAL_MS + 1 }),
  { peek: false, suppressed: true },
  'a second start inside the start window is suppressed independently',
);
assert.deepEqual(
  finishPreviewDecision({ finished: true, nowMs: 100000, lastFinishAtMs: 100000 - FINISH_PREVIEW_MIN_INTERVAL_MS + 1 }),
  { peek: false, suppressed: true },
  'a second finish inside the finish window is suppressed independently',
);
assert.deepEqual(
  finishPreviewDecision({ finished: true, nowMs: 100000, lastFinishAtMs: 100000 - FINISH_PREVIEW_MIN_INTERVAL_MS }),
  { peek: true, suppressed: false },
  'the finish preview window reopens exactly at its own floor',
);
assert.deepEqual(
  finishPreviewDecision({ finished: true, nowMs: 100000, lastFinishAtMs: 100000 - 1, lastStartAtMs: 0 }),
  { peek: false, suppressed: true },
  'finish suppression does not depend on the start preview timestamp',
);

// --- tab rewrite pacing --------------------------------------------------
assert.deepEqual(
  experienceSendDecision({ changed: false, forcePresent: false, nowMs: 100000, lastSentAtMs: 0 }),
  { send: false, deferredInMs: 0 },
  'an unchanged dashboard is never re-sent',
);
assert.deepEqual(
  experienceSendDecision({ changed: true, forcePresent: false, nowMs: 100000, lastSentAtMs: 0 }),
  { send: true, deferredInMs: 0 },
  'the first dashboard state is sent immediately',
);
assert.deepEqual(
  experienceSendDecision({ changed: true, forcePresent: false, nowMs: 100000, lastSentAtMs: 100000 - 1000 }),
  { send: false, deferredInMs: EXPERIENCE_MIN_INTERVAL_MS - 1000 },
  'a change inside the floor is deferred instead of dropped',
);
assert.deepEqual(
  experienceSendDecision({ changed: true, forcePresent: false, nowMs: 100000, lastSentAtMs: 100000 - EXPERIENCE_MIN_INTERVAL_MS }),
  { send: true, deferredInMs: 0 },
  'the deferred state lands as soon as the floor elapses',
);
assert.deepEqual(
  experienceSendDecision({ changed: true, forcePresent: true, nowMs: 100000, lastSentAtMs: 100000 - 10 }),
  { send: true, deferredInMs: 0 },
  'nothing was presented yet, so the first dashboard must not wait',
);

// --- wake scheduling -----------------------------------------------------
assert.equal(shouldReschedule(null, 5000), true, 'the first wake is always armed');
assert.equal(shouldReschedule(5000, 750), true, 'a finish confirmation outranks a pending dashboard rewrite');
assert.equal(shouldReschedule(750, 5000), false, 'a deferred rewrite must not push a finish wake later');
assert.equal(shouldReschedule(750, 750), false, 'an equal wake is not re-armed');

const { createResourceState, reconcileResources } = require('../lib/resource-reconciler.js');
const previewCalls = [];
const previewClient = {
  presentLiveActivity: async (descriptor) => previewCalls.push(`present:${descriptor.id}`),
  updateLiveActivity: async (descriptor) => previewCalls.push(`update:${descriptor.id}`),
  dismissLiveActivity: async (id) => previewCalls.push(`dismiss:${id}`),
  presentNotchExperience: async () => {},
  updateNotchExperience: async () => {},
  dismissNotchExperience: async () => {},
};
const previewPlugin = { id: 'hermes.monitor', ownedIds: { activities: ['activity'], experiences: [] }, persistentIds: { experiences: [] } };
const previewState = createResourceState();
async function verifyNativePreviewTrigger() {
  await reconcileResources(previewPlugin, {
    liveActivity: { id: 'activity', version: 'ordinary' }, experiences: [],
    keepPresented: { activities: ['activity'], experiences: [] },
  }, previewState, previewClient);
  previewCalls.length = 0;
  await reconcileResources(previewPlugin, {
    liveActivity: { id: 'activity', version: 'start-preview' }, experiences: [],
    keepPresented: { activities: ['activity'], experiences: [] }, preview: true,
  }, previewState, previewClient);
  assert.deepEqual(previewCalls, ['present:activity'], 'an explicit preview trigger presents the stable activity id instead of updating it');
  previewCalls.length = 0;
  await reconcileResources(previewPlugin, {
    liveActivity: { id: 'activity', version: 'ordinary-update' }, experiences: [],
    keepPresented: { activities: ['activity'], experiences: [] },
  }, previewState, previewClient);
  assert.deepEqual(previewCalls, ['update:activity'], 'ordinary refreshes still update without a native peek');
}

verifyNativePreviewTrigger().then(() => {
  console.log('PASS: start and finish preview pacing are independent and fixed at 2.5 seconds');
  console.log('PASS: explicit preview trigger re-presents the stable native activity id; ordinary refresh updates');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
