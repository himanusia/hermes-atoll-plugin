#!/usr/bin/env node
/**
 * Deterministic tests for the Hermes monitor's Atoll descriptors and local panel.
 * No RPC, network requests, transcript reads, or state.db writes.
 */
'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const zlib = require('node:zlib');
const monitor = require('../plugins/hermes-monitor.js');
const { liveActivity, tab, experienceSignature, surfacePlan, needsActionDescription, shouldRenderActivity, sessionDeepLink, chronologicalRecentActions, formatWibTime, sessionArcMarkup } = monitor._render;
const now = Date.now() / 1000;

assert.deepEqual(
  chronologicalRecentActions([{ label: 'latest', at: 30 }, { label: 'earlier', at: 20 }]).map((action) => action.label),
  ['earlier', 'latest'],
  'recent tool results render in execution order, oldest first',
);
assert.equal(formatWibTime(Date.UTC(2026, 8, 28, 3, 0, 0) / 1000), '10:00', 'tool timestamps are fixed WIB wall times');
assert.equal(sessionArcMarkup(true), '<span class="arc-border arc-row" aria-hidden="true"></span>');
assert.equal(sessionArcMarkup(false), '');

function unpackDashboard(wrapper) {
  const bootStart = wrapper.indexOf('<script>') + '<script>'.length;
  const bootEnd = wrapper.indexOf('</script>', bootStart);
  assert.ok(bootEnd > bootStart, 'gzip loader script is embedded');
  const bootScript = wrapper.slice(bootStart, bootEnd);
  new vm.Script(bootScript);
  const payload = bootScript.match(/const p='([^']+)'/);
  assert.ok(payload, 'compressed HTML payload is embedded');
  const html = zlib.gunzipSync(Buffer.from(payload[1], 'base64')).toString('utf8');
  const appStart = html.indexOf('<script>') + '<script>'.length;
  const appEnd = html.lastIndexOf('</script>');
  assert.ok(appEnd > appStart, 'dashboard JavaScript is embedded');
  new vm.Script(html.slice(appStart, appEnd));
  return html;
}

function session(overrides = {}) {
  return {
    id: 'session-000001', label: '000001', title: 'Fixture session', status: 'open', turnActive: false,
    activity: 'idle', activityDescription: 'executing tool: web_search', source: 'desktop', model: 'example-model',
    provider: 'example-provider', billingMode: 'subscription', profile: 'default',
    startedAt: now - 900, lastActivityAt: now - 90, endedAt: null, turnStartedAt: null,
    messageCount: 8, toolCallCount: 3, apiCallCount: 4,
    inputTokens: 1200, outputTokens: 730, cacheReadTokens: 160,
    cacheWriteTokens: 0, reasoningTokens: 480,
    recentActions: [{ label: 'Edited a file', at: now - 10 }, { label: 'Ran a command', at: now - 25 }],
    ...overrides,
  };
}

const sessions = [
  session({ id: 'session-running-0001', label: '000001', title: 'Active coding task', status: 'running', turnActive: true, activity: 'working', lastActivityAt: now - 5, turnStartedAt: now - 45 }),
  session({ id: 'session-open-0002', label: '000002', title: 'Research notes' }),
  session({ id: 'session-ended-0003', label: '000003', title: 'Finished session', status: 'ended', endedAt: now - 30 }),
];
const metrics = {
  dbOk: true, state: 'running', pulse: false, finishedNow: [], active: [sessions[0]],
  sessions, sessionsToday: 9, recentDone: null, lastFinish: null, observedAt: Date.now(),
};

const activity = liveActivity(metrics);
assert.equal(activity.leadingIcon.type, 'image');
assert.ok(activity.leadingIcon.data.length > 300, 'wing icon png payload is embedded');
// 44x26 box = 88x52px padded asset drawn 1:1, landing the tile at the
// album-art's measured ear position (x1524 @2x) — see build-wing-icon.py.
assert.deepEqual(activity.leadingIcon.size, { width: 44, height: 26 });
assert.equal(activity.leadingIcon.cornerRadius, 0);
assert.equal(activity.badgeIcon, undefined);
assert.equal(activity.trailingContent.type, 'animation');
assert.ok(activity.trailingContent.data.length > 300, 'digit pulse lottie is embedded');
assert.deepEqual(activity.trailingContent.size, { width: 10, height: 16 });
const digitLottie = JSON.parse(Buffer.from(activity.trailingContent.data, 'base64').toString('utf8'));
assert.ok(digitLottie.assets[0].p.startsWith('data:image/png;base64,'), 'digit png rides inside the lottie');
const twoRunning = { ...metrics, active: [sessions[0], sessions[1]], sessions: [sessions[0], { ...sessions[1], turnActive: true }, sessions[2]] };
assert.notEqual(liveActivity(twoRunning).trailingContent.data, activity.trailingContent.data, 'digit follows the count');
assert.equal(activity.allowsMusicCoexistence, true);
assert.equal(activity.priority, 'high');
assert.match(activity.subtitle, /1 running/);
assert.equal(needsActionDescription('Waiting for your approval'), true);
assert.equal(needsActionDescription('User input required'), true);
assert.equal(needsActionDescription('Sending input to a tool'), false);
const waitingSession = session({ id: 'session-needs-action-0004', label: '000004', title: 'Approve deployment', status: 'needs-action', needsAction: true, activity: 'needs input' });
const needsActionMetrics = { ...metrics, state: 'needs-action', pulse: false, pulseActive: false, active: [], sessions: [waitingSession] };
const needsActionActivity = liveActivity(needsActionMetrics);
assert.equal(needsActionActivity.trailingContent.type, 'text', 'needs-action has a distinct closed-notch marker');
assert.equal(needsActionActivity.trailingContent.text, '!');
assert.deepEqual(needsActionActivity.trailingContent.color, { red: 1, green: 0xc2 / 255, blue: 0x62 / 255, alpha: 1 });
assert.equal(needsActionActivity.leadingIcon.data, activity.leadingIcon.data, 'state changes do not replace the closed-notch wing');
assert.equal(needsActionActivity.subtitle, '1 needs action');
assert.equal(needsActionActivity.metadata.needs_action_sessions, '1');
assert.equal(surfacePlan(needsActionMetrics).keepActivity, true, 'a session awaiting user action keeps the notch activity alive');
assert.equal(shouldRenderActivity(needsActionMetrics, surfacePlan(needsActionMetrics)), true, 'needs-action is presented even with no active turn or finish pulse');
assert.equal(surfacePlan(needsActionMetrics, true).keepActivity, false, 'the explicit force-idle override still wins');
const needsActionHTML = unpackDashboard(tab(needsActionMetrics).tab.webContent.html);
assert.ok(needsActionHTML.includes("s[1]==='a'?'needs-action'"));
assert.ok(needsActionHTML.includes("time.textContent=s.status==='needs-action'?'Needs action'"));
const finishActivity = liveActivity({ ...metrics, state: 'done', active: [], sessions: [], pulse: true, finishedNow: [{ kind: 'turn', label: '42a' }] });
assert.equal(finishActivity.sneakPeekTitle, 'Hermes');
assert.equal(finishActivity.sneakPeekSubtitle, 'Complete');
const sessionFinishActivity = liveActivity({ ...metrics, state: 'done', active: [], sessions: [], pulse: true, finishedNow: [{ kind: 'session', label: '42a' }] });
assert.equal(sessionFinishActivity.sneakPeekSubtitle, 'Session ended');
assert.match(finishActivity.sneakPeekTitle, /^Hermes$/);
assert.equal(finishActivity.sneakPeekConfig.enabled, true, 'a finished turn must render its completion text on the closed notch');
assert.equal(finishActivity.sneakPeekConfig.showOnUpdate, true, 'a finish may arrive as an in-place update, so it must be allowed to animate');
const runningActivity = liveActivity(metrics);
assert.equal(runningActivity.sneakPeekConfig.enabled, false, 'ordinary count changes never animate');
assert.equal(runningActivity.sneakPeekConfig.showOnUpdate, false, 'ordinary count changes never animate');
const suppressedPeek = liveActivity({ ...metrics, state: 'done', active: [], sessions: [], pulse: true, suppressPeek: true, finishedNow: [{ kind: 'turn', label: '42a' }] });
assert.equal(suppressedPeek.sneakPeekConfig.enabled, false, 'a burst suppresses the second peek');
assert.equal(suppressedPeek.sneakPeekSubtitle, 'Complete', 'the completion text stays available for the hover state');
assert.equal(finishActivity.accentColor.red, 0x7e / 255, 'finish tone is muted, not neon');
const pulseTailActivity = liveActivity({ ...metrics, state: 'done', active: [], sessions: [], pulse: false, pulseActive: true, lastFinishText: '2 complete' });
assert.equal(pulseTailActivity.subtitle, '2 complete', 'the pulse grace window keeps the completion text instead of "0 running"');
assert.equal(pulseTailActivity.trailingContent.type, 'text', 'zero running turns render a digit, not a hidden slot');
assert.equal(pulseTailActivity.trailingContent.text, '0', 'the count visibly lands on zero before the wing retracts');

const experience = tab(metrics);
assert.equal(experience.tab.title, '\u200B');
assert.equal(experience.tab.preferredHeight, 160);
assert.equal(experience.tab.appearance.enableGlassHighlight, false);
assert.equal(experience.tab.appearance.tintOpacity, 1);
assert.equal(experience.tab.appearance.border.width, 0);
assert.equal(experience.tab.appearance.tintColor.red, 8 / 255);
assert.equal(experience.tab.appearance.tintColor.green, 30 / 255);
assert.equal(experience.tab.appearance.tintColor.blue, 37 / 255);
assert.equal(experience.tab.appearance.border.color.red, 0);
assert.equal(experience.tab.appearance.border.opacity, 0);
assert.equal(experience.priority, 'high');
assert.equal(experience.tab.iconSymbolName, 'sparkles');
assert.equal(experience.tab.badgeIcon, undefined, 'native tab has no image badge or backdrop');
assert.deepEqual(experience.accentColor, { red: 1, green: 1, blue: 1, alpha: 1 }, 'active native tab uses a white glyph tint');
assert.equal(experience.tab.allowWebInteraction, true);
assert.equal(experience.tab.contentLayout, 'contentOnly');
assert.deepEqual(experience.tab.sections, []);
assert.equal(experience.tab.webContent.preferredHeight, 128);
assert.equal(experience.tab.webContent.isTransparent, false);
assert.equal(experience.tab.webContent.allowLocalhostRequests, false);
assert.equal(experience.tab.webContent.allowRemoteRequests, false);
assert.equal(experience.tab.webContent.maximumContentWidth, undefined);

const wrapper = experience.tab.webContent.html;
assert.ok(Buffer.byteLength(wrapper, 'utf8') <= 15000, 'compressed RPC HTML stays below the safe payload ceiling');
assert.equal(experience.tab.webContent.allowLocalhostRequests, false);
assert.equal(experience.tab.webContent.allowRemoteRequests, false);
assert.equal(experience.tab.webContent.maximumContentWidth, undefined);
assert.match(wrapper, /DecompressionStream\('gzip'\)/);
assert.match(wrapper, /connect-src 'none'/);
const html = unpackDashboard(wrapper);
assert.match(html, /grid-template-columns:200px minmax\(0,1fr\)/);
assert.ok(!html.includes('data-filter'), 'search and filters are gone');
assert.ok(!html.includes('Search sessions'));
assert.match(html, /Selected session details/);
assert.ok(!html.includes('sidehead') && !html.includes('counts-line'), 'one full card: no separate title/count strip');
assert.match(html, /class="activity-line" id="activity-line"/);
assert.match(html, /class="recent-section" aria-label="Recent actions"/);
assert.match(html, /class="recent-actions" id="recent-actions"/);
assert.match(html, /class="context-line" id="context-line"/);
assert.ok(html.includes('No tool activity recorded yet'), 'details have an explicit empty activity state');
assert.ok(html.includes('RECENT STEPS · OLDEST FIRST'), 'the detail timeline explains its chronological order');
assert.ok(html.includes('recentActions:(s[22]||[])'), 'recent tool steps are serialized per session');
assert.ok(html.includes('Edited a file') && html.includes('Ran a command'), 'safe recent action labels are present');
assert.ok(html.includes("time.textContent='FINISHED · '+formatWibTime(at)"), 'tool rows show a static completion time, not a ticking age');
assert.ok(!html.includes('time.dataset.ageTs=String(at)'), 'completed actions are excluded from the live timer');
assert.ok(html.includes('if(s.turnActive&&s.turnStartedAt)'), 'only a real in-flight turn receives a ticking duration');
assert.ok(html.includes('sessionArcMarkup(s.turnActive)'), 'the live turn alone receives Hermes Desktop’s animated row border');
assert.match(html, /@keyframes arc-border/);
assert.match(html, /--idle-dot:color-mix\(in srgb,var\(--text\) 36%,transparent\)/, 'idle status matches Hermes Desktop’s quaternary text tone');
assert.match(html, /n\(s\.apiCallCount\)\+' API/, 'details include API call volume as well as tool and message counts');
assert.equal(monitor._render.toolActionLabel('search_files'), 'Searched files');
assert.equal(monitor._render.toolActionLabel('mcp__private__operation'), 'Used an integration', 'unknown integration names do not expose arguments or service details');
assert.ok(!html.includes('usage-grid') && !html.includes('session-metadata') && !html.includes('info-grid') && !html.includes('disclosure-toggle'), 'detail tables and collapsible sections are gone');
assert.match(html, /class="state-label" id="state-label">OPEN<\/span><span class="model-name" id="model-name"><\/span>/);
assert.ok(!html.includes('@keyframes dot-pulse'));
assert.match(html, /class="state-line"><span class="state-label" id="state-label">OPEN<\/span>/);
assert.ok(!html.includes('state-mark'), 'session state is textual, not another repeated decorative icon');
assert.match(html, /@media\(max-height:160px\)/);
assert.match(html, /\.panel\{[^}]*height:100%[^}]*overflow:hidden[^}]*border-radius:0 0 16px 16px/);
assert.match(html, /@media\(max-height:160px\)\{\.panel\{height:100%\}/, 'compact Atoll viewport uses its full height so bottom padding matches the side inset');
assert.ok(html.includes('ok green #55a583).\n*/\n:root'), 'palette comment closes before CSS variables so the live card theme is applied');
assert.match(html, /\.session-row\{min-height:16px;margin:0;padding:0 6px;gap:7px\}/);
assert.match(html, /\.session-list\{flex:0 1 auto;max-height:52px\}/);
assert.match(html, /\.row-title\{font-size:11px;line-height:12px\}/);
assert.match(html, /\.row-ago\{font-size:10px;line-height:11px\}/);
assert.match(html, /\.session-name\{font-size:18px;line-height:20px;letter-spacing:0\}/);
assert.ok(!html.includes('text-rendering:optimizeLegibility'));
assert.ok(!html.includes('font-weight:700'), 'dashboard typography avoids heavy all-bold hierarchy');
assert.match(html, /\.row-title\{[^}]*font-weight:500/);
assert.match(html, /\.state-label\{[^}]*font-weight:500/);
assert.match(html, /\.session-name\{[^}]*font-weight:500/);
assert.match(html, /\.empty-title\{[^}]*font-weight:500/);
assert.match(html, /--accent:#97c8f1/);
assert.match(html, /\.session-row\[aria-selected="true"\],\.session-row\[aria-selected="true"\]:hover\{border-color:transparent;background:var\(--panel2\)\}/);
assert.match(html, /\.session-row\[aria-selected="true"\] \.row-title\{color:var\(--accent\)\}/);
assert.ok(!html.includes('row-mark') && !html.includes('LOGO_MARK'), 'session rows use titles without repeated decorative icons');
assert.ok(html.includes('class="status-dot" aria-hidden="true"'), 'each session row carries one simple status dot');
assert.ok(html.includes('row.dataset.status=s.status'), 'the status dot is color-coded from the row status');
assert.match(html, /\.status-dot\{[^}]*border-radius:50%/, 'status indicators are small round dots, not decorative icons');
assert.ok(html.includes("row.querySelector('.row-title').textContent=s.title"), 'visible session rows are titled from the state database, not the id');
assert.ok(html.includes("set('session-name',s.title||'Untitled session')"), 'selected-session heading uses its human title');
assert.ok(html.includes('activityDescription:s[21]'), 'safe current activity details are carried into the panel');
assert.ok(html.includes("set('activity-line',s.activityDescription||"), 'session details show live activity or a concise state fallback');
assert.ok(html.includes('class="activity-line" id="activity-line"'), 'session detail includes a dedicated activity line');
assert.ok(html.includes('row.href=sessionDeepLink(s.id)'), 'each session title is a direct link to its durable session id');
assert.ok(html.includes("event.target.closest('a[data-session-id]')"), 'clicking a session row uses a user-activated anchor');
assert.ok(!html.includes('event.preventDefault()'), 'row click does not cancel the native deep-link gesture');
assert.equal(sessionDeepLink('session/a ?&'), 'hermes://session/session%2Fa%20%3F%26', 'session identifiers are URL encoded exactly once');
assert.match(html, /title:s\[20\]/);
assert.match(html, /activityDescription:s\[21\]/);
assert.ok(html.includes('Active coding task') && html.includes('Research notes'), 'session titles are serialized for display');
assert.ok(!html.includes("row.querySelector('.row-id')") && !html.includes("'Session #'+s.label"));
assert.ok(html.includes("window.name='hermes-monitor:'"), 'selected session id survives a content refresh');
assert.match(html, /\.session-row\[data-status="running"\]\{background:color-mix/, 'running sessions have a distinct fill');
assert.match(html, / msgs \u00b7 .* tok/, 'detail shows one compact stats line');
assert.match(html, /html,body\{[^}]*background:var\(--bg\)[^}]*\}/);
assert.match(html, /\.panel\{[^}]*border-radius:0 0 16px 16px;/);
assert.match(html, /\.panel\{[^}]*background:var\(--panel\)/);
assert.match(html, /\.sidebar\{[^}]*background:var\(--sidebar\)/);
assert.ok(!html.includes('--rim') && !html.includes('border-left:1.5px solid'), 'flat single surface: no rim');
assert.ok(!html.includes('.panel{background:linear-gradient'), 'the card surface stays flat; the only gradient is the live-session border');
assert.match(html, /turnStartedAt:s\[19\]/);
assert.ok(html.includes("if(s.turnActive&&s.turnStartedAt){time.dataset.ageTs=String(s.turnStartedAt);"), 'only active turns get a ticking timer');
assert.ok(html.includes("time.removeAttribute('data-age-ts');time.textContent=s.status==='needs-action'?'Needs action':s.status==='ended'?'Ended':'Idle';"), 'idle, needs-action, and ended sessions do not keep a ticking timer');
assert.ok(!/rgba\(|filter:\s*blur|backdrop-filter/.test(html), 'dashboard must not apply translucent blur treatments');
assert.ok(!html.includes('activity-indicator'), 'do not duplicate the running pulse with a second floating dot');
assert.ok(!html.includes('@keyframes wave') && !html.includes('class="wave"'));
assert.match(html, /prefers-reduced-motion/);
for (const item of sessions) assert.ok(html.includes(JSON.stringify(item.id)), `missing session ${item.label}`);
assert.ok(!html.includes('Hermes finished') && !html.includes('Sessions today'));
assert.ok(!html.includes('last_activity_description'), 'raw activity descriptions stay private');
assert.ok(html.includes('Active coding task'), 'human session title is shown in place of the id');

const volatileChange = {
  ...metrics,
  sessions: sessions.map((s) => ({ ...s, lastActivityAt: (s.lastActivityAt || now) + 30, messageCount: s.messageCount + 1, inputTokens: s.inputTokens + 17 })),
  observedAt: Date.now() + 30000,
};
assert.notEqual(experienceSignature(metrics), experienceSignature(volatileChange), 'rendered counters and row times must not remain stale');
const rosterChange = {
  ...metrics,
  sessions: sessions.map((s, i) => i === 0 ? { ...s, status: 'open', turnActive: false } : s),
};
assert.notEqual(experienceSignature(metrics), experienceSignature(rosterChange), 'turn-state transitions should refresh the dashboard');
const nextTurn = { ...metrics, sessions: sessions.map((s, i) => i === 0 ? { ...s, turnStartedAt: (s.turnStartedAt || now) + 60 } : s) };
assert.notEqual(experienceSignature(metrics), experienceSignature(nextTurn), 'a new turn rebakes the row timer');
const toolHistoryChange = { ...metrics, sessions: sessions.map((s, i) => i === 0 ? { ...s, recentActions: [{ label: 'Searched files', at: now }] } : s) };
assert.notEqual(experienceSignature(metrics), experienceSignature(toolHistoryChange), 'new tool actions refresh the session detail');

const idle = session({ id: 'idle-session-0004', label: '000004' });
const idleMetrics = { ...metrics, state: 'idle', active: [], sessions: [idle], pulse: false };
assert.equal(liveActivity(idleMetrics).trailingContent.type, 'text', 'an idle wing still renders its count instead of a placeholder');
assert.equal(liveActivity(idleMetrics).trailingContent.text, '0');
assert.equal(liveActivity(idleMetrics).badgeIcon, undefined);
assert.equal(tab(idleMetrics).tab.allowWebInteraction, true);
assert.equal(tab(idleMetrics).tab.badgeIcon, undefined, 'native tab does not request badge chrome behind the glyph');
assert.equal(tab(idleMetrics).accentColor.alpha, 1, 'native active glyph tint stays opaque');
assert.equal(tab(idleMetrics).accentColor.red, 1, 'native active glyph tint remains white');
const idleHTML = unpackDashboard(tab(idleMetrics).tab.webContent.html);
assert.ok(idleHTML.includes('"idle-session-0004","o","i"'));
assert.ok(idleHTML.includes('This panel stays available while Hermes is idle'));

const emptyMetrics = { ...metrics, state: 'idle', active: [], sessions: [], pulse: false };
const emptyHTML = unpackDashboard(tab(emptyMetrics).tab.webContent.html);
assert.ok(emptyHTML.includes('No sessions yet'));
assert.equal(tab(emptyMetrics).tab.sections.length, 0);

assert.deepEqual(surfacePlan(metrics), { keepActivity: true, keepExperience: true, pulse: false });
assert.deepEqual(surfacePlan(idleMetrics), { keepActivity: false, keepExperience: true, pulse: false });
assert.deepEqual(surfacePlan(emptyMetrics), { keepActivity: false, keepExperience: true, pulse: false });
assert.deepEqual(surfacePlan({ ...emptyMetrics, pulse: true }), { keepActivity: true, keepExperience: true, pulse: true });

const unsafe = session({ id: 'unsafe-id', label: 'unsafe', model: '</script><img src=x onerror=alert(1)>' });
const safeHTML = unpackDashboard(tab({ ...metrics, sessions: [unsafe], active: [], state: 'idle' }).tab.webContent.html);
assert.ok(!safeHTML.includes('</script><img src=x'));
assert.ok(safeHTML.includes(String.fromCharCode(92) + 'u003c/script' + String.fromCharCode(92) + 'u003e'));

console.log('PASS: running count pulses as a digit on the right; idle drops it but keeps the session tab');
console.log('PASS: tab stays high-priority and interactive in running, idle, and empty states');
console.log('PASS: concise session list, compact layout, single stats line, and local-only requests are embedded');
console.log('PASS: visible counter/time changes refresh the dashboard; selection, roster, and state updates are wired');
console.log('PASS: Hermes tab glyph and desktop palette, white running linework, bottom-radius CSS, and idle timer stop are configured; native tab chrome and visible height remain Atoll-owned');
console.log('PASS: session titles render safely; transcript-only activity stays out; unsafe script content is escaped');
console.log('PASS: one solid card with bottom-radius CSS; zero running turns retract cleanly');
console.log('PASS: running rows count the current turn (lease start), not last activity');
