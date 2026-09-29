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
const { EXPERIENCE_MIN_INTERVAL_MS, PEEK_MIN_INTERVAL_MS, peekDecision, experienceSendDecision } = monitor._pacing;
const { shouldReschedule } = require('../lib/wake-schedule.js');

assert.equal(typeof peekDecision, 'function', 'peek decision is exported');
assert.equal(typeof experienceSendDecision, 'function', 'experience pacing decision is exported');
assert.ok(EXPERIENCE_MIN_INTERVAL_MS >= 5000, 'the tab floor keeps RPC pressure well under the reference cadence');
assert.ok(PEEK_MIN_INTERVAL_MS >= 5000, 'a finish burst cannot re-expand the notch back to back');

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
  'the peek window reopens exactly at the floor',
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

console.log('PASS: finish sneak peek fires once per burst and reports suppression');
console.log('PASS: dashboard rewrites are floored with a deferred trailing update');
console.log('PASS: the shortest armed wake always wins over a longer deferred one');
