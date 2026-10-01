#!/usr/bin/env node
/**
 * Deterministic test for hermes-monitor's finish detection.
 *
 * Feeds synthetic lease/session snapshots through the plugin's own
 * detectTransitions() and asserts the emitted pulse events. No state.db, no
 * Atoll, no timing — the transition math is pure.
 *
 *   node tools/test-transitions.js
 */
'use strict';

const assert = require('node:assert');
const monitor = require('../plugins/hermes-monitor.js');

const detect = monitor._detectTransitions;
const preview = monitor._preview;
if (typeof detect !== 'function') {
  console.error('FAIL: plugin does not export _detectTransitions');
  process.exit(1);
}
if (typeof preview?.extractRequestText !== 'function' || typeof preview?.sanitizeRequest !== 'function') {
  console.error('FAIL: plugin does not export request preview helpers');
  process.exit(1);
}

assert.equal(preview.extractRequestText('\u0000json:[{"type":"text","text":"Fix the parser"},{"type":"image_url","image_url":{"url":"https://secret.invalid/image"}}]'), 'Fix the parser', 'structured request previews keep text parts only');
assert.equal(preview.extractRequestText('\u0000json:{"text":"Use the safe field","api_content":"must not be read"}'), 'Use the safe field', 'structured previews never fall back to non-text fields');
assert.equal(preview.extractRequestText('\u0000json:[{"type":"image_url","image_url":{"url":"https://secret.invalid/image"}}]'), '', 'image-only requests have no text preview');
assert.equal(preview.sanitizeRequest('  fix\tthis\nplease  '), 'fix this please', 'request whitespace and controls collapse');
const secretPreview = preview.sanitizeRequest('Deploy with token=sk-live-abcdefghijklmnop and Bearer ghp_abcdefghijklmnopqrstuvwxyz');
assert.ok(!secretPreview.includes('sk-live-abcdefghijklmnop') && !secretPreview.includes('ghp_abcdefghijklmnopqrstuvwxyz'), 'obvious credentials are redacted');
assert.ok(secretPreview.includes('[redacted]'), 'redaction leaves a bounded visible marker');
assert.equal(preview.sanitizeRequest(''), 'New request', 'empty requests use the compact fallback');
const requestQueries = [];
const fakeRequestDb = {
  prepare(sql) {
    requestQueries.push(sql);
    return { all: () => [{ session_id: 'request-session', content: '\u0000json:[{"type":"text","text":"Read only content"}]' }] };
  },
};
assert.equal(preview.recentUserRequests(fakeRequestDb, ['request-session']).get('request-session'), 'Read only content', 'the request lookup reads the latest eligible user content');
assert.ok(requestQueries.every((sql) => !sql.includes('api_content')), 'request lookup never selects the provider-only content column');

const now = Date.now() / 1000;
const lease = (id, ttl = 300, acquired = now - 30) => ({
  conversation_id: id,
  holder: `pid=1:turn=${id}:platform=desktop`,
  acquired_at: acquired,
  expires_at: now + ttl,
});
const row = (id, extra = {}) => ({
  id,
  title: `Session ${id}`,
  source: 'desktop',
  model: 'gpt-6-luna-900k',
  started_at: now - 600,
  last_activity_at: now - 3,
  last_activity_description: 'receiving stream response',
  ended_at: null,
  end_reason: null,
  message_count: 12,
  ...extra,
});

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    monitor._resetTransitions();
    fn();
    console.log(`PASS: ${name}`);
    pass++;
  } catch (e) {
    console.log(`FAIL: ${name}\n      ${e.message}`);
    fail++;
  }
}

// 1. First observation must NOT fire a pulse (no previous snapshot).
check('first observation produces no pulse or start preview', () => {
  const out = detect([lease('s1')], [row('s1')]);
  assert.deepStrictEqual(out.finished, [], 'expected zero finish events on first look');
  assert.deepStrictEqual(out.started, [], 'the initial active lease is only a baseline');
  assert.strictEqual(out.active.size, 1, 'expected one active lease');
});

// A session can keep the same id for several turns. acquired_at is the durable
// turn identity: refreshes of one lease do not replay its request preview, while
// a new lease for the same session emits exactly one start event.
check('acquired_at keys one start preview per lease', () => {
  detect([lease('same-session', 300, now - 30)], [row('same-session')], now);
  const sameLease = detect([lease('same-session', 300, now - 30)], [row('same-session')], now + 0.1);
  assert.deepStrictEqual(sameLease.started, [], 'refreshing one lease must not replay its start');
  const nextTurn = detect([lease('same-session', 300, now + 0.2)], [row('same-session')], now + 0.3);
  assert.equal(nextTurn.started.length, 1, 'a changed acquired_at marks one real new turn');
  assert.equal(nextTurn.started[0].id, 'same-session');
  assert.equal(nextTurn.started[0].title, 'Session same-session');
  assert.match(nextTurn.started[0].leaseKey, /same-session/);
  const refresh = detect([lease('same-session', 300, now + 0.2)], [row('same-session')], now + 0.4);
  assert.deepStrictEqual(refresh.started, [], 'the new lease is still emitted only once');
});

// 2. A missing lease is confirmed after a short grace period; until then the
// last-known running state is retained and no "done" notification is sent.
check('lease release → confirmed turn finish pulse', () => {
  detect([lease('s1')], [row('s1')], now);
  const early = detect([], [row('s1')], now + 0.1);
  assert.deepStrictEqual(early.finished, [], 'a one-sample gap must not claim the turn is done');
  assert.strictEqual(early.active.size, 1, 'keep the last-known active state during confirmation');
  assert.ok(early.nextWakeInMs > 0, 'host needs a timer to confirm without another database write');
  const out = detect([], [row('s1')], now + 1);
  assert.strictEqual(out.finished.length, 1, 'confirmed absence should emit exactly one finish event');
  assert.strictEqual(out.finished[0].id, 's1');
  assert.strictEqual(out.finished[0].kind, 'turn');
  assert.strictEqual(out.finished[0].label, 's1');
  assert.equal(out.finished[0].title, 'Session s1');
});

check('deleted session keeps its last snapshot title on completion', () => {
  detect([lease('deleted-session')], [row('deleted-session', { title: 'Important work' })], now);
  detect([], [], now + 0.1);
  const out = detect([], [], now + 1);
  assert.equal(out.finished.length, 1, 'missing lease must still complete after the grace period');
  assert.equal(out.finished[0].title, 'Important work', 'completion title comes from the last observed session snapshot');
});

// 3. No change = no pulse.
check('steady state produces no pulse', () => {
  detect([lease('s3')], [row('s3')], now);
  const out = detect([lease('s3')], [row('s3')], now + 0.1);
  assert.deepStrictEqual(out.finished, [], 'expected zero finish events');
  assert.strictEqual(out.active.size, 1);
});

// 4. Durable session close (ended_at set) while a lease was never seen.
check('session end → session finish pulse', () => {
  detect([lease('s4')], [row('s4')]);                       // establish previous
  const closed = row('s4', { ended_at: now - 1, end_reason: 'agent_close' });
  const out = detect([], [closed]);                          // closed on next poll
  assert.strictEqual(out.finished.length, 1, 'expected one finish event');
  assert.strictEqual(out.finished[0].kind, 'session', 'durable ended_at must take precedence over a lease release');
});

// 5. Session closed without any prior lease = session-kind event.
check('session closed without an observed lease → session pulse', () => {
  detect([], [row('s5')]);                                   // open, no lease
  const out = detect([], [row('s5', { ended_at: now - 1, end_reason: 'agent_close' })]);
  assert.strictEqual(out.finished.length, 1, 'expected one finish event');
  assert.strictEqual(out.finished[0].kind, 'session');
  assert.strictEqual(out.finished[0].reason, 'agent_close');
});

// 6. A session that starts and closes between observations still produces one finish event.
check('new session closed between observations → finish pulse', () => {
  const baselineAt = now;
  detect([], [], baselineAt);
  const closed = row('short-session', { started_at: now + 0.1, ended_at: now + 0.2, end_reason: 'agent_close' });
  const out = detect([], [closed], now + 0.3);
  assert.strictEqual(out.finished.length, 1, 'expected one finish event for the unseen short session');
  assert.strictEqual(out.finished[0].id, 'short-session');
  assert.strictEqual(out.finished[0].kind, 'session');
});

// 7. Leases that already expired count as NOT active (no false "running").
check('expired lease is not active', () => {
  const expired = { ...lease('s6'), expires_at: now - 5 };
  const out = detect([expired], [row('s6')]);
  assert.strictEqual(out.active.size, 0, 'expired lease must not count as an active turn');
});

// 7. Two concurrent turns finishing together → two events.
check('two simultaneous finishes → two events', () => {
  detect([lease('a'), lease('b')], [row('a'), row('b')], now);
  const early = detect([], [row('a'), row('b')], now + 0.1);
  assert.deepStrictEqual(early.finished, []);
  assert.strictEqual(early.active.size, 2);
  const out = detect([], [row('a'), row('b')], now + 1);
  assert.strictEqual(out.finished.length, 2, 'expected two confirmed finish events');
  assert.deepStrictEqual(out.finished.map((e) => e.id).sort(), ['a', 'b']);
});

// 8. A session closed during sleep (never observed open) does not pulse.
check('session already closed on first look → no pulse', () => {
  const out = detect([], [row('cold', { ended_at: now - 3600, end_reason: 'agent_close' })]);
  assert.deepStrictEqual(out.finished, [], 'cold rows must not retro-pulse');
});

check('lease expiry is not proof the turn completed', () => {
  detect([lease('stale-lease')], [row('stale-lease')], now);
  const expired = { ...lease('stale-lease'), expires_at: now + 0.1 };
  const out = detect([expired], [row('stale-lease')], now + 0.2);
  assert.strictEqual(out.active.size, 0, 'expired lease must not count as running');
  assert.deepStrictEqual(out.finished, [], 'an expired row still in the database must not send a completion notification');
});

console.log(`\n${pass}/${pass + fail} transitions tests passed`);
process.exit(fail === 0 ? 0 : 1);
