/**
 * hermes-monitor — local Hermes session / turn monitor for the Mac notch.
 *
 * Read-only and local-only. The source of truth is ~/.hermes/state.db:
 *   - session_turn_leases: a confirmed in-flight turn
 *   - sessions.ended_at/end_reason: a durable session boundary
 *
 * No transcript bodies, credentials, network calls, or writes to state.db.
 * A pulse is emitted when a watched turn/session transitions to finished. The
 * host briefly presents a compact completion status without auto-expanding the
 * notch.
 */
'use strict';

const path = require('path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const {
  createLiveActivity,
  createNotchExperience,
  AtollColors,
  AtollLiveActivityPriority,
  createColor,
  systemFont,
} = require('@ebullioscopic/atoll-js');

const HERMES_HOME = process.env.HERMES_HOME || path.join(process.env.HOME, '.hermes');
const DB = path.join(HERMES_HOME, 'state.db');
// Preserve Hermes' existing closed-notch wing icon; custom mark changes stay in the tab UI.
const WING_ICON = path.join(__dirname, '..', 'assets', 'hermes-monitor-icon.png');
let wingIconData = null;
function wingIcon() {
  if (wingIconData === null) wingIconData = fs.readFileSync(WING_ICON).toString('base64');
  return wingIconData;
}
// The wing's living state: the running-turn count itself pulses. Atoll's
// trailing 'animation' content takes a base64 lottie, so each digit ships as
// an embedded PNG asset (SF Semibold, green) with an opacity/scale pulse.
const DIGIT_PNG = {
  '0': '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',
  '1': 'iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAYAAADHCaiQAAACpUlEQVR4nO3aTasOcRjH8S+dwhvAa/CQsxSLKQuPeQfSSAp5WFjN0sbo8AJkwSixsLGxsfsvbCiFhcUpZaOULNkgTc07OHfNzG++nxdwuurbNfc197lBkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJkiRJ0jRtYyGaruwFngDHt/BnPrR1tc6MbGcBmq6cBT5tMe4srRGs6cou4D5wlYWKDdx05RDwDNjHgsUFbrrS3xU3gbvADhZuLfCQ6oATY88yFTFHVtOVM8BH44ZtcNOVncA94NrYs0zRrAM3XTkIPAf2jz3LVK3N+JC6Dmx4SIUFbrqyB3gMnBp7ljmY1ZHVdOX0cEgZN2mDh0NqY3gsKylw05UDwzdS/UGlpEd005X+1eedccM2uOnK7uGQ6j9zV+Uf8BC4zIJMboObrhwZDqlVxv0KHGvr6goLM7nAw/9s+1ehVXkKHGrrqrBAk3xEr8jP/nHc1tULFiw18GvgQltX31i4KT6it+I3cAM4ady8DX4PnGvr6vPYg0xJwgb/Be4Ah42bt8FfgPNtXb0Ze5CpmvMGPxpef4wbtsE/gEttXb0ce5A5mFvgV8DFtq6+jz3IXMwl8C/gVltXD8YeZG7mEPjt8PqzOfYgczTlI+sPcBs4aty8Dd4ctrbfXoVtcH9IrRs3dIPbuup/waHgDdYKGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZOJyBwxk4nIHDGTicgcMZWJIkSZLEgvwHGtJsLgsTPdQAAAAASUVORK5CYII=',
  '2': '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',
  '3': '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',
  '4': 'iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAYAAADHCaiQAAAEDklEQVR4nO3dy4sdRRjG4Z/lFVwIXiA7F16DG9cuLFFX7l2ppFQwYjQIarS8QTRQ3kUFNQakohtRkLgQCUigwaALQVBceQcRRRENioGgkYb5B1LdZ071970PzG6+oTjv9KHfqeozICIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIn06CYdyHU4HPgcuXsXPLyl287oGfHpwVeH2xl3AuQ6XAPfjhLuAgVeB8S3aBVcB5zrcDFyFI24CznU4F3gaZ9wEDDwHnIMzLgLOdbgauAmHgpPO+wpOmQ8YeMhL53UXcK7DpZ46r6uAcx3GPxfuBU7DMbMBA7cAVzbO7sMIkwHnOpwHPNU4/hWwEyOC4c57duPs7SXFoxhhLuBch2uAGxvH95cUD2GIqYAndt7fgHsxxlTAwMPARY2z95QUx5BNCcY6767G8UMlxTcwyETAEzvv0fHGCqNMBDyx8+4pKY7VyKTgvPN+OWF2EYLjznsc2F5SPIZhwcA+b2vn3VdSPIxxwWnn/cXLLlNwus97d0nxDxwIDvd5D5YU38KJsOCzzS2d9x/gDhxZXMC5DmPnjY3jj5UUv8WRsMCzza299QvgWZwJTs42H/fQeRcd8MSzzXtLih/jUHDQeX8GHsCp4KDz7iwp/olTwXjnfb+k+A6OBcOd929gB84Fw5330ZLiDzgXjHbez4AXZl7SIgWDnfc/4LaS4r8rWNPiBIOd96WS4qczL2mxQqedd7yxavHjxtFZ6TXgiWeb7ywp/jXzehatq4BzHbZOONv8bknxvZmXtHihs7PNrZ33CHDXCpa1eN0EDNw64WxzLin+NPN6TAgdnW1+snH8kwk3ZeZ1ETDwfOPZ5mMbnXfsvtJjwLkO1wI3NI4/U1IcT2pIjwHnOpwx4e31G+DxmZdkzrqv4EeACyZ81MJ4SlJ6DDjX4TLgvsbxN0uKH868JJPCGjvva8CpDeO/j0/jr2BZJq3rCt4OXNE4u6uk+OvM6zFr0wPOddgCPNE4/hHw+sxLMm0dV/CLwFmNnXe8sRrPOEuPAec6XAdcP6Hzjk/kS48B5zqcCbzcOP6dOm//V/Bu4PzG2R3qvB0HnOtw+fjQdeP42yXFD2ZekhubdQWPH897cuM+b+svhmzW/y7MdWi98/0aWNcHpWybMLv/BL//QEnxACtwCn27cONrabad4Pd/P4ZscbNBVkwBG6eAjVPAxilg4xSwcQrYOAVsnAI2TgEbp4CN25TNhiXK7RsklBS7eV11BRungI1TwMYpYOMUsHEK2DgFbJwCNk4BG6eAjVPAxilg4xSwcQrYOAVsnAI2rveHz9Zp97oXICIiIiIiIsztf3Lo4lW0UAtYAAAAAElFTkSuQmCC',
  '5': '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',
  '6': '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',
  '7': 'iVBORw0KGgoAAAANSUhEUgAAAHgAAACgCAYAAADHCaiQAAAE30lEQVR4nO3deeilUxzH8ff8jH0JWbJESLZESPbzh0iJIgqJQyRLKIpDlmE4ln8RWTohhCSRaBiHsSRCCCF7svzLYGaMHvNMBjNmuuf63ed8z+f1/3N+t/vue++v+5xzL4iIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIjIBMyY7j8YUl5Mo6J30/58T033H5TppcDGKbBxCmycAhunwMYpsHEKbJwCG6fAximwcQps3MwWPnAfh5Dy3sAbBUu8xgRoglfdbMpcxQRUOU3TLaR8APBywRKvRO8OZAI0wYant6MJXomQ8qHAHEY3L3p3MBOiCV65aylzNROkwP8hpHwksD+jeyl69xwTpMArEFLu3r6uodL33qUUeMWOBfZidDl6N5cJU+DlCCl3z8ssKn7vXUqBl+9EYDdGNzd69wIDoMD/EFKeOYb3zkFMb0eB/+1UYEdG93z07kUGQoGXEVJeA7iCyv9zXpYC/92ZwLaMbk70bh4DosC9kPJawGUYee9dSoH/ci6wJaN7NnpXcsfpf6HA/Dm96wGXWJvejgIvcQGwKaN7Jnr3KgPUfOCQ8obARRant9N8YOBiYKOC5/Dp6N1E9lutiqYDh5Q3Ac63Or20Hhi4FFi/4PqnonevM2DNBg4pbwGcY3l6mw4MXA6sXXD9k9G7kn3S06LJwCHlbfqPJU1Pb7OBgSuB7sbCqJ6I3r1JBZoLHFLeob8laH56mwzMkq04JWeyHo/evUUlmgocUt61344zqsVj2Ks1rZoKzJJtsFOF0/s2FWkmcEh5z34rbDPT21RglhwgKzmL9Vj07h0q00TgkPJ+QHcMpanpbSYw5cc/H43evUuFzAcOKTugOwJaMr2lZ5Qmxnxgyqf3kejde1TKdOCQ8hHAQQVL/F7z9JoPTPnh7Yejd+9TMbOBQ8rHAPu0PL1mA/eHt2cVLvNQ9O4DKmcyMHACsHvh9Ja+vA+CucAh5dXGcADswejdhxhgLjBwCrBTwfWLrEyvucAh5dXHcPzzgejdRxhhKjBwBrBdwfWLLE2vqcD98c9up2SJ+6N3H2OImcDA2cBWhdM7G2NMBA4pr9ufUihxX/TuE4wxEbg/X7RZwfULLU6vicAh5Q36E4Il7o3efYpB1Qfuz/ZuXHD9QqvTW33gkHIX9sLCZVL07jOMqjpw/70a3Uv0qBYA12FYtYFDypsD541hej/HsGoD999ptU7B9QusT2+1gUPKWwNnFS5zT/TuC4yrMnB/Q2HNgut/A66nAdUFDilvD5xWuMzd0bsvaUB1gfuzud1twZLpjTSiqsAh5Z2BkwqXuSt69xWNqCpwv8ux25Izql9bmt6qAoeU9wCOK1zmzujd1zSkmsD9TosZhdN7A42pInBIeV/gqMJl7ojefUNjqgg8hrs9v7Q4vVUEDil3v9x52Bim91saNNXA9M4HbqRRgw4cUj4cOKRwmdtbnd7BBx7DHuX5LU/voAOHlI8Guv+eS9wWvfuOhk0Z/u3en4GbaNwgAwPHA90nV6XT+z2Nmxrob/eWfpvrT5regQYGTgZ2KVzj1ujdD2N6PFWbGuBv93Zf1l06vTeP6SFVb1CBgdOB7gu7S9wSvftxTI9HREREREREMOUPiOQIUlLG4/IAAAAASUVORK5CYII=',
  '8': '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',
  '9': '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',
};
const digitLottieCache = new Map();
function digitPulseLottie(count) {
  const key = String(count);
  const png = DIGIT_PNG[key];
  if (!png) return null; // 10+ running turns: fall back to plain text below
  const cached = digitLottieCache.get(key);
  if (cached) return cached;
  const data = Buffer.from(JSON.stringify({
    v: '5.7.4', fr: 30, ip: 0, op: 60, w: 120, h: 160, nm: 'digit_pulse', ddd: 0,
    assets: [{ id: 'digit', w: 120, h: 160, u: '', p: `data:image/png;base64,${png}`, e: 1 }],
    layers: [{
      ddd: 0, ind: 1, ty: 2, nm: 'digit', refId: 'digit', sr: 1,
      ks: {
        o: { a: 1, k: [
          { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] }, t: 0, s: [100] },
          { i: { x: [0.42], y: [1] }, o: { x: [0.58], y: [0] }, t: 30, s: [60] },
          { t: 60, s: [100] },
        ] },
        r: { a: 0, k: 0 },
        p: { a: 0, k: [60, 80, 0] },
        a: { a: 0, k: [60, 80, 0] },
        s: { a: 1, k: [
          { i: { x: [0.42, 0.42, 0.42], y: [1, 1, 1] }, o: { x: [0.58, 0.58, 0.58], y: [0, 0, 0] }, t: 0, s: [100, 100, 100] },
          { i: { x: [0.42, 0.42, 0.42], y: [1, 1, 1] }, o: { x: [0.58, 0.58, 0.58], y: [0, 0, 0] }, t: 30, s: [92, 92, 100] },
          { t: 60, s: [100, 100, 100] },
        ] },
      },
      ao: 0, ip: 0, op: 60, st: 0, bm: 0,
    }],
  })).toString('base64');
  digitLottieCache.set(key, data);
  return data;
}
const HOUR_MS = 3600e3;
const DAY_S = 24 * 3600;
const RECENT_SESSION_WINDOW_S = 7 * DAY_S;
const SESSION_QUERY_LIMIT = 400;

const nowS = () => Date.now() / 1000;

// In-memory transition memory is intentional: this plugin never writes to
// Hermes state. The LaunchAgent keeps it alive; a restart starts cleanly with
// no false "finished" animation for old rows.
let previousSnapshot = null;
let lastFinish = null;
let finishPulseUntilMs = 0;
let previousExperienceSignature = null;
const FINISH_PULSE_MS = 5500;

// ---------- WIB helpers ----------
function wibParts(ms) {
  const d = new Date(ms + 7 * HOUR_MS);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    h: d.getUTCHours(),
    mi: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
  };
}
function startOfTodayWibS() {
  const t = wibParts(Date.now());
  return (Date.UTC(t.y, t.mo - 1, t.d) - 7 * HOUR_MS) / 1000;
}

function shortId(id) {
  const value = String(id || '');
  return value.length <= 8 ? value : value.slice(-6);
}
function finiteNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function countValue(value) {
  const n = finiteNumber(value);
  return n == null ? 0 : Math.max(0, Math.floor(n));
}
function metadataLabel(value, fallback = '—') {
  const clean = String(value ?? fallback)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 64);
  return clean || fallback;
}
function sessionTitle(row) {
  const raw = String(row?.title || row?.display_name || '').trim();
  const id = String(row?.id || '');
  return raw && raw !== id ? metadataLabel(raw, 'Untitled session') : 'Untitled session';
}
// ---------- read-only SQLite ----------
function watchStateDb(onChange, { dbPath = DB, debounceMs = 60, onError = () => {}, fswatchBin } = {}) {
  const directory = path.dirname(dbPath);
  const targets = { database: dbPath, wal: `${dbPath}-wal` };
  const binary = fswatchBin || (process.env.PATH || '').split(path.delimiter)
    .map((part) => path.join(part, 'fswatch')).find((candidate) => fs.existsSync(candidate));
  let closed = false;
  let debounceTimer;
  let directoryRetry;
  const watchers = new Map();

  const report = (error) => { try { onError(error); } catch {} };
  const queueChange = () => {
    if (closed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!closed) onChange();
    }, debounceMs);
  };
  const spawnWatcher = (name, monitor, watchedPath) => {
    if (closed || watchers.has(name) || !binary) return;
    if (monitor === 'kqueue_monitor' && !fs.existsSync(watchedPath)) return;
    let child;
    try {
      child = spawn(binary, [
        '-0', '--latency=0.05', `--monitor=${monitor}`, '--format=%p', watchedPath,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      report(error);
      return;
    }
    watchers.set(name, child);
    let output = '';
    let errorOutput = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const entries = output.split('\0');
      output = entries.pop() || '';
      for (const entry of entries) {
        const changedPath = path.resolve(entry);
        if (name === 'directory') {
          if (changedPath !== dbPath && changedPath !== targets.wal) continue;
          queueChange();
          if (changedPath === dbPath) spawnWatcher('database', 'kqueue_monitor', targets.database);
          else spawnWatcher('wal', 'kqueue_monitor', targets.wal);
        } else if (changedPath === watchedPath) queueChange();
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { errorOutput = (errorOutput + chunk).slice(-1000); });
    child.on('error', (error) => report(error));
    child.on('exit', (code, signal) => {
      if (watchers.get(name) === child) watchers.delete(name);
      if (closed) return;
      if (code !== 0 && code !== null) report(new Error(`${name} fswatch exited (${code}/${signal || 'no signal'}): ${errorOutput.trim()}`));
      if (name === 'directory') {
        clearTimeout(directoryRetry);
        directoryRetry = setTimeout(() => spawnWatcher('directory', 'fsevents_monitor', directory), 5000);
      } else if (fs.existsSync(watchedPath)) {
        setTimeout(() => spawnWatcher(name, 'kqueue_monitor', watchedPath), 250);
      }
    });
  };

  if (!binary) report(new Error('fswatch is not installed; monitor will use its fallback refresh'));
  else {
    spawnWatcher('directory', 'fsevents_monitor', directory);
    spawnWatcher('database', 'kqueue_monitor', targets.database);
    spawnWatcher('wal', 'kqueue_monitor', targets.wal);
  }

  return () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearTimeout(directoryRetry);
    for (const child of watchers.values()) child.kill('SIGTERM');
    watchers.clear();
  };
}

const NEEDS_ACTION_PATTERN = /\b(?:needs?\s+(?:your\s+)?(?:input|action|approval|confirmation)|(?:user\s+)?input\s+(?:required|needed)|approval\s+required|confirmation\s+required|permission\s+required|awaiting\s+(?:you|your\s+)?(?:input|approval|confirmation|response)|waiting\s+for\s+(?:you|the\s+user|user|your\s+)?(?:input|approval|confirmation|response)|requires?\s+(?:your\s+)?(?:approval|confirmation|input)|please\s+(?:approve|confirm|respond))\b/i;
function needsActionDescription(description) {
  return NEEDS_ACTION_PATTERN.test(String(description || '').replace(/[\u0000-\u001F\u007F]/g, ' '));
}
function activityState(description) {
  const d = String(description || '').toLowerCase();
  if (needsActionDescription(d)) return 'needs input';
  if (/tool|execut|compil|search|delegat|stream|api|compress/.test(d)) return 'working';
  return 'running';
}

function sessionRows(db) {
  const cutoff = nowS() - RECENT_SESSION_WINDOW_S;
  return db.prepare(
    `SELECT id, title, display_name, source, model, billing_provider, billing_mode, profile_name,
            started_at, last_activity_at, last_activity_description,
            ended_at, message_count, tool_call_count, api_call_count,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            reasoning_tokens
       FROM sessions
      WHERE started_at >= ? OR ended_at >= ? OR ended_at IS NULL
      ORDER BY COALESCE(last_activity_at, ended_at, started_at) DESC
      LIMIT ${SESSION_QUERY_LIMIT}`,
  ).all(cutoff, cutoff);
}

const TOOL_ACTION_LABELS = {
  terminal: 'Ran a command',
  read_file: 'Read a file',
  search_files: 'Searched files',
  write_file: 'Edited a file',
  patch: 'Edited a file',
  web_search: 'Searched the web',
  web_extract: 'Read a web source',
  browser_exec: 'Used the browser',
  computer_use: 'Used the desktop',
  delegate_task: 'Delegated work',
  process_manage: 'Managed a process',
  session_search: 'Searched session history',
  tool_search: 'Found an integration',
  tool_describe: 'Inspected an integration',
  tool_call: 'Used an integration',
  clarify: 'Requested input',
};

function toolActionLabel(toolName) {
  const name = String(toolName || '').replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 80);
  if (TOOL_ACTION_LABELS[name]) return TOOL_ACTION_LABELS[name];
  if (/^(?:browser_vault|password|payment|secret|credential)/i.test(name)) return 'Secure browser step';
  if (name.startsWith('mcp__')) return 'Used an integration';
  return 'Used a tool';
}

function recentToolActions(db, rows) {
  const ids = [...new Set(rows.map((row) => String(row.id || '')).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const placeholders = ids.map(() => '?').join(',');
    const found = db.prepare(
      `SELECT session_id, tool_name, timestamp, id
         FROM (
           SELECT session_id, tool_name, timestamp, id,
                  ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp DESC, id DESC) AS rank
             FROM messages
            WHERE role = 'tool' AND active = 1 AND tool_name IS NOT NULL
              AND session_id IN (${placeholders})
         )
        WHERE rank <= 24
        ORDER BY session_id, timestamp DESC, id DESC`,
    ).all(...ids);
    const bySession = new Map();
    for (const row of found) {
      const sessionId = String(row.session_id || '');
      const label = toolActionLabel(row.tool_name);
      const actions = bySession.get(sessionId) || [];
      if (actions.length && actions[actions.length - 1].label === label) continue;
      if (actions.length >= 7) continue;
      actions.push({ label, at: finiteNumber(row.timestamp) });
      bySession.set(sessionId, actions);
    }
    return bySession;
  } catch {
    return new Map();
  }
}

function countSessionsToday(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE started_at >= ?').get(startOfTodayWibS());
  return row ? Number(row.c) : null;
}

function finishEvent(id, kind, row = null) {
  const at = finiteNumber(row?.ended_at) || nowS();
  return {
    id: String(id || ''),
    kind,
    at,
    label: shortId(id),
    reason: String(row?.end_reason || ''),
  };
}

const FINISH_CONFIRM_MS = 750;

function resetTransitionState() {
  previousSnapshot = null;
  lastFinish = null;
  finishPulseUntilMs = 0;
}

function detectTransitions(leases, rows, observedAt = nowS()) {
  const active = new Map();
  const rawLeases = new Map();
  for (const row of leases) {
    const id = String(row.conversation_id || '');
    const expires = finiteNumber(row.expires_at);
    if (!id || expires == null) continue;
    const lease = {
      id,
      acquiredAt: finiteNumber(row.acquired_at),
      expiresAt: expires,
    };
    rawLeases.set(id, lease);
    if (expires > observedAt) active.set(id, lease);
  }

  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const openSessions = new Set(
    rows.filter((row) => row.ended_at == null).map((row) => String(row.id)),
  );
  const finished = [];
  const pendingFinishes = new Map(previousSnapshot?.pendingFinishes || []);
  const trackedLeases = new Map(active);
  let nextWakeInMs = null;

  if (previousSnapshot) {
    // A lease row whose expiry passed is not proof of completion. Keep tracking
    // a previously valid lease until its row is actually removed.
    for (const [id, lease] of previousSnapshot.trackedLeases) {
      if (rawLeases.has(id)) {
        if (!active.has(id)) trackedLeases.set(id, lease);
        pendingFinishes.delete(id);
      } else if (!pendingFinishes.has(id)) {
        pendingFinishes.set(id, { firstMissingAt: observedAt, lease });
      }
    }

    // A durable session close wins over an inferred lease-release event.
    for (const id of previousSnapshot.openSessions) {
      const row = byId.get(id);
      if (row && row.ended_at != null) {
        finished.push(finishEvent(id, 'session', row));
        active.delete(id);
        trackedLeases.delete(id);
        pendingFinishes.delete(id);
      }
    }
    for (const row of rows) {
      const endedAt = finiteNumber(row.ended_at);
      const id = String(row.id || '');
      if (endedAt != null && endedAt > previousSnapshot.observedAt && !finished.some((event) => event.id === id)) {
        finished.push(finishEvent(id, 'session', row));
        active.delete(id);
        trackedLeases.delete(id);
        pendingFinishes.delete(id);
      }
    }
  }

  for (const [id, candidate] of [...pendingFinishes]) {
    if (rawLeases.has(id) || active.has(id)) {
      pendingFinishes.delete(id);
      continue;
    }
    const row = byId.get(id);
    if (row && row.ended_at != null) {
      if (!finished.some((event) => event.id === id)) finished.push(finishEvent(id, 'session', row));
      active.delete(id);
      trackedLeases.delete(id);
      pendingFinishes.delete(id);
      continue;
    }
    const elapsedMs = (observedAt - candidate.firstMissingAt) * 1000;
    if (elapsedMs >= FINISH_CONFIRM_MS) {
      if (!finished.some((event) => event.id === id)) finished.push(finishEvent(id, 'turn', row));
      pendingFinishes.delete(id);
      continue;
    }
    // Preserve the last confirmed state while a missing lease is debounced.
    active.set(id, candidate.lease);
    const remainingMs = Math.max(1, FINISH_CONFIRM_MS - elapsedMs);
    nextWakeInMs = nextWakeInMs == null ? remainingMs : Math.min(nextWakeInMs, remainingMs);
  }

  for (const [id, lease] of rawLeases) {
    if (active.has(id) && lease.expiresAt > observedAt) trackedLeases.set(id, lease);
  }
  previousSnapshot = { trackedLeases, openSessions, pendingFinishes, observedAt };
  if (finished.length) lastFinish = finished[finished.length - 1];
  return { active, byId, openSessions, finished, nextWakeInMs: Math.ceil(nextWakeInMs || 0) };
}

// ---------- collect ----------
function collect() {
  let db;
  let leases;
  let rows;
  let actionsBySession;
  let sessionsToday;
  let queryFailed = false;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
    db.exec('PRAGMA busy_timeout=2000');
    db.exec('BEGIN');
    leases = db.prepare('SELECT conversation_id, holder, acquired_at, expires_at FROM session_turn_leases').all();
    rows = sessionRows(db);
    actionsBySession = recentToolActions(db, rows);
    sessionsToday = countSessionsToday(db);
    db.exec('COMMIT');
  } catch {
    try { db?.exec('ROLLBACK'); } catch {}
    queryFailed = true;
  } finally {
    try { db?.close(); } catch {}
  }

  if (queryFailed || !leases || !rows || sessionsToday == null) {
    return {
      dbOk: false,
      state: 'offline',
      pulse: false,
      pulseActive: false,
      finishedNow: [],
      active: [],
      sessions: [],
      needsActionCount: 0,
      sessionsToday,
      recentDone: null,
      lastFinish,
      observedAt: Date.now(),
      nextWakeInMs: 0,
    };
  }

  const transition = detectTransitions(leases, rows, nowS());
  const active = [...transition.active.values()]
    .filter((lease) => !needsActionDescription(transition.byId.get(lease.id)?.last_activity_description))
    .map((lease) => {
      const row = transition.byId.get(lease.id);
      return {
        id: lease.id,
        label: shortId(lease.id),
        source: String(row?.source || 'local'),
        model: String(row?.model || ''),
        activity: activityState(row?.last_activity_description),
        lastActivityAt: finiteNumber(row?.last_activity_at),
      };
    })
    .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

  const sessions = rows.map((row) => {
    const id = String(row.id || '');
    const lease = transition.active.get(id);
    const endedAt = finiteNumber(row.ended_at);
    const needsAction = endedAt == null && needsActionDescription(row.last_activity_description);
    const turnActive = Boolean(lease) && !needsAction;
    return {
      id,
      label: shortId(id),
      title: sessionTitle(row),
      status: endedAt != null ? 'ended' : needsAction ? 'needs-action' : turnActive ? 'running' : 'open',
      needsAction,
      turnActive,
      turnStartedAt: turnActive ? lease.acquiredAt : null,
      activity: needsAction ? 'needs input' : turnActive ? activityState(row.last_activity_description) : 'idle',
      activityDescription: needsAction || turnActive ? metadataLabel(row.last_activity_description, '') : '',
      recentActions: actionsBySession?.get(id) || [],
      source: metadataLabel(row.source, 'local'),
      model: metadataLabel(row.model, 'Unknown model'),
      provider: metadataLabel(row.billing_provider),
      billingMode: metadataLabel(row.billing_mode),
      profile: metadataLabel(row.profile_name, 'default'),
      startedAt: finiteNumber(row.started_at),
      lastActivityAt: finiteNumber(row.last_activity_at),
      endedAt,
      messageCount: countValue(row.message_count),
      toolCallCount: countValue(row.tool_call_count),
      apiCallCount: countValue(row.api_call_count),
      inputTokens: countValue(row.input_tokens),
      outputTokens: countValue(row.output_tokens),
      cacheReadTokens: countValue(row.cache_read_tokens),
      cacheWriteTokens: countValue(row.cache_write_tokens),
      reasoningTokens: countValue(row.reasoning_tokens),
    };
  }).sort((a, b) =>
    Number(b.needsAction) - Number(a.needsAction) ||
    Number(b.turnActive) - Number(a.turnActive) ||
    Number(b.status === 'open') - Number(a.status === 'open') ||
    (b.lastActivityAt || b.endedAt || b.startedAt || 0) -
      (a.lastActivityAt || a.endedAt || a.startedAt || 0));

  const needsActionCount = sessions.filter((session) => session.needsAction).length;
  const recentDone = rows
    .filter((row) => row.ended_at != null)
    .sort((a, b) => Number(b.ended_at) - Number(a.ended_at))[0] || null;

  const pulse = transition.finished.length > 0;
  if (pulse) finishPulseUntilMs = Date.now() + FINISH_PULSE_MS;
  const pulseActive = pulse || Date.now() < finishPulseUntilMs;
  const state = pulse ? 'done' : active.length ? 'running' : needsActionCount ? 'needs-action' : 'idle';
  return {
    dbOk: true,
    state,
    pulse,
    pulseActive,
    finishedNow: transition.finished,
    active,
    sessions,
    needsActionCount,
    sessionsToday,
    recentDone,
    lastFinish,
    observedAt: Date.now(),
    nextWakeInMs: transition.nextWakeInMs,
  };
}

// ---------- rendering ----------
const SKIN = {
  // Measured desktop-app tokens: idle #7e8d8f, running #79a0c1 (the app's accent
  // blue), done #55a583 (--ui-green), offline #e75e78 (--ui-red).
  idle: { color: createColor(0x7e / 255, 0x8d / 255, 0x8f / 255, 1) },
  'needs-action': { color: createColor(0x7e / 255, 0x8d / 255, 0x8f / 255, 1) },
  running: { color: createColor(0x79 / 255, 0xa0 / 255, 0xc1 / 255, 1) },
  done: { color: createColor(0x7e / 255, 0x8d / 255, 0x8f / 255, 1) },
  offline: { color: createColor(0xe7 / 255, 0x5e / 255, 0x78 / 255, 1) },
};

function finishText(m) {
  const events = Array.isArray(m.finishedNow) ? m.finishedNow : [];
  if (!events.length) return 'Complete';
  if (events.length === 1) {
    const event = events[0];
    return event.kind === 'session'
      ? 'Session ended'
      : 'Complete';
  }
  return `${events.length} complete`;
}

const FORCE_IDLE_PATH = path.join(__dirname, '..', '.force-idle');
const ACTIVITY_ID = 'hermes.monitor.v3';
const EXPERIENCE_ID = 'hermes.monitor.tab.v17';
const fsExists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
function surfacePlan(m, forceIdle = fsExists(FORCE_IDLE_PATH)) {
  const needsAction = Number(m.needsActionCount) > 0 || (m.sessions || []).some((session) => session.needsAction || session.status === 'needs-action');
  return {
    keepActivity: !forceIdle && ((m.active || []).length > 0 || needsAction || Boolean(m.pulseActive) || Boolean(m.pulse)),
    keepExperience: true,
    pulse: Boolean(m.pulse),
  };
}
function shouldRenderActivity(m, plan) {
  const needsAction = Number(m.needsActionCount) > 0 || (m.sessions || []).some((session) => session.needsAction || session.status === 'needs-action');
  return Boolean(plan.keepActivity) && ((m.active || []).length > 0 || needsAction || Boolean(m.pulseActive) || Boolean(m.pulse));
}
function liveActivity(m) {
  const skin = SKIN[m.state] || SKIN.offline;
  const openCount = (m.sessions || []).filter((session) => session.status !== 'ended').length;
  const runningCount = (m.sessions || []).filter((session) => session.turnActive && !session.needsAction).length;
  const needsActionCount = (m.sessions || []).filter((session) => session.needsAction || session.status === 'needs-action').length;
  let subtitle;
  if (!m.dbOk) subtitle = 'Hermes offline';
  else if (m.pulse) subtitle = finishText(m);
  else if (needsActionCount) subtitle = m.active.length
    ? `${m.active.length} running · ${needsActionCount} needs action`
    : `${needsActionCount} needs action`;
  else subtitle = `${m.active.length} running`;

  return createLiveActivity({
    id: ACTIVITY_ID,
    title: 'Hermes',
    subtitle,
    leadingIcon: { type: 'image', data: wingIcon(), size: { width: 44, height: 26 }, cornerRadius: 0 },
    // Right side of the notch: how many turns are running, and the count itself
    // pulses as the live state animation. badgeIcon is OMITTED entirely (not
    // {type:'none'}): an explicit none still made Atoll draw its fallback
    // placeholder plate ("app.dashed" outline + tint chip) next to the icon.
    trailingContent: needsActionCount > 0
      ? { type: 'text', text: '!', font: systemFont(14, 'bold'), color: createColor(1, 0xc2 / 255, 0x62 / 255, 1) }
      : runningCount > 0
        ? (digitPulseLottie(runningCount)
          // The animation box is capped at 10pt so Atoll's trailing floor (26pt, same
          // as the music wing) applies - the closed notch then matches the music
          // width exactly in both the standalone and the paired state.
          ? { type: 'animation', data: digitPulseLottie(runningCount), size: { width: 10, height: 16 } }
          : { type: 'text', text: String(runningCount), font: systemFont(13, 'semibold'), color: createColor(121 / 255, 160 / 255, 193 / 255, 1) })
        : { type: 'none' },
    priority: AtollLiveActivityPriority.High,
    accentColor: skin.color,
    // Coexists with music (2026-09-26, on request): when a track plays the
    // digit rides the music wing, so the closed notch keeps Hermes visible
    // without adding any width to the music layout.
    allowsMusicCoexistence: true,
    metadata: {
      state: m.state,
      active_turns: String(m.active.length),
      needs_action_sessions: String(needsActionCount),
      open_sessions: String((m.sessions || []).filter((session) => session.status !== 'ended').length),
      sessions_today: String(m.sessionsToday ?? '?'),
      source: 'local-state-db',
    },
    // Keep completion in the activity's compact status; auto-expanding the
    // notch for this short message makes the panel disproportionately wide.
    sneakPeekConfig: {
      enabled: false,
      showOnUpdate: false,
    },
    sneakPeekTitle: 'Hermes',
    sneakPeekSubtitle: m.pulse ? finishText(m) : null,
  });
}

function scriptJSON(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function sessionDeepLink(sessionId) {
  return `hermes://session/${encodeURIComponent(String(sessionId ?? ''))}`;
}

function dashboardHTML(m) {
  const sessions = Array.isArray(m.sessions) ? m.sessions : [];
  const openCount = sessions.filter((session) => session.status !== 'ended').length;
  const runningCount = sessions.filter((session) => session.turnActive).length;
  const recentCount = sessions.length - openCount;
  const activityCode = { running: 'r', working: 'w', 'needs input': 'n', idle: 'i' };
  const renderSource = (visibleSessions) => {
    const data = {
      d: Boolean(m.dbOk) ? 1 : 0,
      r: runningCount,
      o: openCount,
      t: sessions.length,
      e: recentCount,
      s: visibleSessions.map((session) => [
        session.id,
        session.status === 'running' ? 'r' : session.status === 'needs-action' ? 'a' : session.status === 'ended' ? 'e' : 'o',
        activityCode[session.activity] || 'i',
        session.source,
        session.model,
        session.provider,
        session.billingMode,
        session.profile,
        session.startedAt,
        session.lastActivityAt,
        session.endedAt,
        session.messageCount,
        session.toolCallCount,
        session.apiCallCount,
        session.inputTokens,
        session.outputTokens,
        session.cacheReadTokens,
        session.cacheWriteTokens,
        session.reasoningTokens,
        session.turnStartedAt,
        session.title,
        session.activityDescription,
        session.recentActions,
      ]),
      c: visibleSessions.length,
    };
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'">
<style>
/* Display calibration: Atoll's webview renders css as out = 0.8 x srgb_to_p3(css),
   so every color below is the pre-compensated inverse of the intended on-screen
   value. The palette mirrors the LIVE Hermes desktop window as measured on screen
   (surfaces #0d242d/#081e25/#182a30, text #a3acae, accent blue #79a0c1, ok green #55a583).
*/
:root{color-scheme:dark;--bg:#001f26;--sidebar:#001f26;--panel:#03252e;--panel2:#102b31;--line:#2d4c5b;--text:#a1acae;--muted:#a2bbbb;--dim:#859c9f;--accent:#97c8f1;--green:#6acea4;--red:#ef9fa9;--ended:#50646a;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;font-synthesis:none}
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:var(--bg);color:var(--text)}button{font:inherit}
.panel{display:grid;grid-template-columns:200px minmax(0,1fr);width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;border-radius:0 0 16px 16px;background:var(--panel)}
.sidebar{display:flex;flex-direction:column;min-width:0;min-height:0;padding:14px 16px 16px;background:var(--sidebar);}
.session-list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#46545b transparent;padding:2px 3px 5px}
.session-row{display:flex;align-items:center;gap:9px;width:100%;min-height:32px;margin:1px 0;padding:5px 10px;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--text);text-align:left;text-decoration:none;cursor:pointer}
.session-row:hover{background:var(--panel2);border-radius:0}
.session-row[aria-selected="true"],.session-row[aria-selected="true"]:hover{border-color:transparent;background:transparent}
.session-row[aria-selected="true"] .row-title{color:var(--accent)}
.status-dot{flex:0 0 5px;width:5px;height:5px;border-radius:50%;background:var(--dim)}
.session-row[data-status="running"] .status-dot{background:var(--accent)}
.session-row[data-status="needs-action"] .status-dot{background:var(--red)}
.session-row[data-status="ended"] .status-dot{background:var(--ended)}
.row-title{flex:1;min-width:0;overflow:hidden;font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.row-ago{flex:0 0 auto;color:var(--dim);font-size:10px;white-space:nowrap}
.list-empty{padding:14px 7px;color:var(--dim);font-size:11px;line-height:1.45}
.detail{position:relative;display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;padding:20px 24px 24px;overflow:hidden}
.detail-content{display:flex;flex:1;flex-direction:column;gap:10px;min-height:0}
.state-line{display:flex;align-items:center;gap:7px;min-width:0}
.state-label{color:var(--muted);font-size:9px;font-weight:500;letter-spacing:.12em}
.model-name{flex:0 1 auto;min-width:0;overflow:hidden;color:var(--dim);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.session-name{overflow:hidden;font-size:18px;font-weight:500;letter-spacing:0;text-overflow:ellipsis;white-space:nowrap}
.activity-line{overflow:hidden;color:var(--muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.recent-section{display:flex;flex:1;flex-direction:column;gap:9px;min-height:0;padding-top:5px}
.recent-heading{color:var(--dim);font-size:9px;font-weight:500;letter-spacing:.12em}
.recent-actions{display:flex;flex:1;flex-direction:column;gap:7px;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#46545b transparent;margin:0;padding:0;list-style:none}
.recent-action{display:flex;align-items:center;gap:12px;min-height:22px;color:var(--text);font-size:11px}
.recent-action-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.recent-action-ago{flex:0 0 auto;color:var(--dim);font-size:10px;white-space:nowrap}
.recent-empty{color:var(--dim);font-size:11px;line-height:1.4}
.stats-line{color:var(--dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.context-line{color:var(--dim);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty-detail{display:none;flex:1;align-items:center;justify-content:center;min-height:0;text-align:center}
.empty-detail.visible{display:flex}
.empty-inner{max-width:300px}
.empty-title{font-size:16px;font-weight:500}
.empty-copy{margin-top:7px;color:var(--muted);font-size:11px;line-height:1.5}
.offline-bar{display:none;position:absolute;right:20px;bottom:12px;color:var(--red);font-size:9px}
.offline-bar.visible{display:block}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
@media(max-width:760px){.panel{grid-template-columns:200px minmax(0,1fr)}.detail{padding:20px 24px 24px}}
@media(max-height:160px){.panel{height:100%}.sidebar{padding:5px 8px 8px}.session-row{min-height:16px;margin:0;padding:0 6px;gap:7px}.session-list{flex:0 1 auto;max-height:52px}.row-title{font-size:11px;line-height:12px}.row-ago{font-size:10px;line-height:11px}.detail{padding:8px 12px 12px;gap:4px}.detail-content{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#46545b transparent;gap:3px}.detail-content::-webkit-scrollbar{width:3px}.detail-content::-webkit-scrollbar-thumb{background:#46545b;border-radius:2px}.state-line{gap:6px}.state-label{font-size:10px;line-height:12px}.session-name{font-size:18px;line-height:20px;letter-spacing:0}.activity-line{font-size:10px;line-height:12px}.recent-section{flex:0 0 auto;gap:3px;padding-top:0}.recent-heading{font-size:8px;line-height:10px}.recent-actions{flex:0 0 auto;gap:3px;overflow:visible}.recent-action{min-height:14px;font-size:9px}.recent-action-ago{font-size:8px}.recent-empty{font-size:8px}.model-name{font-size:11px;line-height:13px}.stats-line{font-size:11px;line-height:13px}.context-line{font-size:8px;line-height:10px}.empty-title{font-size:13px}.empty-copy{font-size:9px}.offline-bar{font-size:8px}}
</style>
</head>
<body>
<main class="panel" aria-label="Hermes sessions">
  <aside class="sidebar">
    <div class="session-list" id="session-list" role="listbox" aria-label="Sessions"></div>
  </aside>
  <section class="detail" aria-label="Selected session details">
    <div class="detail-content" id="detail-content">
      <div class="state-line"><span class="state-label" id="state-label">OPEN</span><span class="model-name" id="model-name"></span></div>
      <div class="session-name" id="session-name">Session</div>
      <div class="activity-line" id="activity-line">Idle</div>
      <div class="recent-section" aria-label="Recent actions"><div class="recent-heading">RECENT ACTIONS</div><ol class="recent-actions" id="recent-actions"></ol></div>
      <div class="stats-line" id="stats-line"></div>
      <div class="context-line" id="context-line"></div>
    </div>
    <div class="empty-detail" id="empty-detail"><div class="empty-inner"><div class="empty-title" id="empty-title">No sessions yet</div><div class="empty-copy" id="empty-copy">This panel stays available while Hermes is idle.</div></div></div>
    <div class="offline-bar" id="offline-bar">Local state database unavailable</div>

  </section>
</main>
<script>
const sessionDeepLink=${sessionDeepLink.toString()};
const DATA=(()=>{const p=${scriptJSON(data)};return {dbOk:!!p.d,runningCount:p.r,openCount:p.o,recentCount:p.e,totalCount:p.t,shownCount:p.c,sessions:p.s.map((s)=>({id:s[0],label:s[0].length<=8?s[0]:s[0].slice(-6),status:s[1]==='a'?'needs-action':s[1]==='r'?'running':s[1]==='e'?'ended':'open',needsAction:s[1]==='a',turnActive:s[1]==='r',activity:{r:'running',w:'working',n:'needs input',i:'idle'}[s[2]]||'idle',source:s[3],model:s[4],provider:s[5],billingMode:s[6],profile:s[7],startedAt:s[8],lastActivityAt:s[9],endedAt:s[10],messageCount:s[11],toolCallCount:s[12],apiCallCount:s[13],inputTokens:s[14],outputTokens:s[15],cacheReadTokens:s[16],cacheWriteTokens:s[17],reasoningTokens:s[18],turnStartedAt:s[19],title:s[20],activityDescription:s[21]||'',recentActions:(s[22]||[]).map((a)=>({label:a.label,at:a.at}))}))}})();
(() => {
  const list=document.getElementById('session-list');
  const detailContent=document.getElementById('detail-content');
  const emptyDetail=document.getElementById('empty-detail');
  const recentActionsNode=document.getElementById('recent-actions');
  let selectedId='';
  try{const key='hermes-monitor:';if(window.name.startsWith(key))selectedId=decodeURIComponent(window.name.slice(key.length));}catch{}
  const persistSelection=()=>{window.name='hermes-monitor:'+encodeURIComponent(selectedId);};
  const all=Array.isArray(DATA.sessions)?DATA.sessions:[];
  const n=(value)=>new Intl.NumberFormat('en-US').format(Math.max(0,Number(value)||0));
  const set=(id,value)=>{const node=document.getElementById(id);if(node)node.textContent=String(value??'—');};
  const ago=(ts)=>{if(!ts)return '—';const sec=Math.max(0,Math.floor(Date.now()/1000-Number(ts)));if(sec<5)return 'now';if(sec<60)return sec+'s';if(sec<3600)return Math.floor(sec/60)+'m '+String(sec%60).padStart(2,'0')+'s';if(sec<86400)return Math.floor(sec/3600)+'h '+String(Math.floor((sec%3600)/60)).padStart(2,'0')+'m';return Math.floor(sec/86400)+'d';};
  const tok=(value)=>{const x=Math.max(0,Number(value)||0);if(x<1000)return String(x);if(x<100000)return (x/1000).toFixed(1).replace('.0','')+'k';if(x<999500)return Math.round(x/1000)+'k';return (x/1000000).toFixed(1).replace('.0','')+'M';};
  const visible=()=>all.filter((s)=>s.status!=='ended');
  function renderList(items){
    list.replaceChildren();
    if(!items.length){const empty=document.createElement('div');empty.className='list-empty';empty.textContent='No open sessions';list.append(empty);return;}
    for(const s of items){
      const row=document.createElement('a');row.className='session-row';row.href=sessionDeepLink(s.id);row.dataset.sessionId=s.id;row.setAttribute('role','option');row.setAttribute('aria-selected',String(s.id===selectedId));
      row.dataset.status=s.status;
      row.innerHTML='<span class="status-dot" aria-hidden="true"></span><span class="row-title"></span><span class="row-ago"></span>';
      row.querySelector('.row-title').textContent=s.title||'Untitled session';
      row.setAttribute('aria-label',s.title||'Untitled session');
      const time=row.querySelector('.row-ago');
      // Only a live turn gets a ticking timer; idle/ended sessions show state, not a stale clock.
      if(s.turnActive&&s.turnStartedAt){time.dataset.ageTs=String(s.turnStartedAt);time.textContent=ago(s.turnStartedAt);}
      else{time.removeAttribute('data-age-ts');time.textContent=s.status==='needs-action'?'Needs action':s.status==='ended'?'Ended':'Idle';}
      list.append(row);
    }
  }
  function renderDetail(s){
    if(!s){
      detailContent.style.display='none';emptyDetail.classList.add('visible');
      set('empty-title',DATA.dbOk?'No open sessions':'Session data unavailable');
      set('empty-copy',DATA.dbOk?'This panel stays available while Hermes is idle.':'The local state database could not be read.');return;
    }
    detailContent.style.display='flex';emptyDetail.classList.remove('visible');
    set('state-label',s.status==='needs-action'?'NEEDS ACTION':s.status==='running'?'RUNNING':s.status==='ended'?'ENDED':'OPEN');
    set('session-name',s.title||'Untitled session');set('model-name',s.model);
    const activityFallback=s.needsAction?'Waiting for your input':s.turnActive?(s.activity==='working'?'Working':'Running'):'Idle';
    set('activity-line',s.activityDescription||activityFallback);
    recentActionsNode.replaceChildren();
    const recentActions=Array.isArray(s.recentActions)?s.recentActions:[];
    if(!recentActions.length){const item=document.createElement('li');item.className='recent-empty';item.textContent='No tool activity recorded yet';recentActionsNode.append(item);}
    else for(const action of recentActions){
      const item=document.createElement('li');item.className='recent-action';
      const label=document.createElement('span');label.className='recent-action-name';label.textContent=String(action.label||'Used a tool');
      const time=document.createElement('span');time.className='recent-action-ago';
      const at=Number(action.at);if(Number.isFinite(at)){time.dataset.ageTs=String(at);time.textContent=ago(at);}else time.textContent='—';
      item.append(label,time);recentActionsNode.append(item);
    }
    const tokens=(Number(s.inputTokens)||0)+(Number(s.outputTokens)||0);
    set('stats-line',n(s.messageCount)+' msgs \u00b7 '+n(s.toolCallCount)+' tools \u00b7 '+n(s.apiCallCount)+' API \u00b7 '+tok(tokens)+' tok');
    const contextParts=[s.profile&&s.profile!=='—'?'Profile '+s.profile:'',s.provider&&s.provider!=='—'?'Provider '+s.provider:'',s.source?'Source '+s.source:'',s.startedAt?'Started '+ago(s.startedAt):''].filter(Boolean);
    set('context-line',contextParts.join(' \u00b7 '));
  }
  function render(){
    const items=visible();
    set('running-count',DATA.runningCount+' running');
    if(!items.some((s)=>s.id===selectedId))selectedId=items[0]?.id||'';
    persistSelection();
    renderList(items);renderDetail(all.find((s)=>s.id===selectedId)||null);updateTimes();
  }
  function updateTimes(){for(const node of document.querySelectorAll('[data-age-ts]'))node.textContent=ago(node.dataset.ageTs);}
  list.addEventListener('click',(event)=>{const row=event.target.closest('a[data-session-id]');if(!row)return;selectedId=row.dataset.sessionId;persistSelection();for(const candidate of list.querySelectorAll('a[data-session-id]'))candidate.setAttribute('aria-selected',String(candidate.dataset.sessionId===selectedId));renderDetail(all.find((s)=>s.id===selectedId)||null);updateTimes();});
  render();
  setInterval(updateTimes,1000);
})();
</script>
</body>
</html>`;
  };

  const packSource = (source) => {
    const payload = zlib.gzipSync(Buffer.from(source, 'utf8'), { level: 9 }).toString('base64');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; object-src 'none'"></head><body><script>(()=>{const p='${payload}';try{const b=Uint8Array.from(atob(p),c=>c.charCodeAt(0));const stream=new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));new Response(stream).text().then((html)=>{document.open();document.write(html);document.close()}).catch(()=>{document.body.textContent='Unable to load sessions'})}catch{document.body.textContent='Unable to load sessions'}})();</script></body></html>`;
  };

  const included = [...sessions];
  let html = packSource(renderSource(included));
  while (Buffer.byteLength(html, 'utf8') > 15000) {
    const oldestEnded = included.findLastIndex((session) => session.status === 'ended');
    const oldestInactive = included.findLastIndex((session) => !session.turnActive);
    const drop = oldestEnded >= 0 ? oldestEnded : oldestInactive;
    if (drop < 0) break;
    included.splice(drop, 1);
    html = packSource(renderSource(included));
  }
  return html;
}


function tab(m) {
  const experience = createNotchExperience({
    id: EXPERIENCE_ID,
    // Keep the tab glyph white; zero tint opacity is the SDK's available
    // attempt to suppress Atoll's selected-tab fill independently.
    accentColor: createColor(1, 1, 1, 1),
    priority: AtollLiveActivityPriority.High,
    tab: {
      title: '\u200B',
      iconSymbolName: 'sparkles',
      preferredHeight: 160,
      // Flat single-surface design (2026-09-26, on request): the webview paints
      // one solid background edge to edge (--panel target #0d242d), color-matched to
      // the zone Atoll draws above it, so no seam/frame/third surface shows.
      // No border and no shadow: nothing may render "behind" the panel.
      appearance: {
        tintColor: createColor(8/255, 30/255, 37/255, 1),
        tintOpacity: 1,
        enableGlassHighlight: false,
        liquidGlassVariant: { rawValue: 0 },
        border: { color: AtollColors.black, opacity: 0, width: 0 },
        shadow: { color: AtollColors.black, opacity: 0, radius: 0, offset: { width: 0, height: 0 } },
        // Width: the notch width stays at the user's baseline (the host never
        // writes it). The web-vs-native card gap (openNotch-86 vs -39) is Atoll's
        // own web-tab inset and no descriptor lever closes it (probed 2026-09-26).
        contentInsets: { top: -59, leading: -24, bottom: 0, trailing: -24 },
      },
      sections: [],
      webContent: {
        html: dashboardHTML(m),
        preferredHeight: 128,
        isTransparent: false,
        allowLocalhostRequests: false,
        allowRemoteRequests: false,
      },
      allowWebInteraction: true,
      contentLayout: 'contentOnly',
    },
  });
  return experience;
}

function experienceSignature(m) {
  const stableSessions = (Array.isArray(m.sessions) ? m.sessions : [])
    .map((session) => ({
      id: String(session.id || ''),
      title: String(session.title || 'Untitled session'),
      status: String(session.status || 'open'),
      turnActive: Boolean(session.turnActive),
      activity: String(session.activity || 'idle'),
      source: String(session.source || ''),
      model: String(session.model || ''),
      provider: String(session.provider || ''),
      billingMode: String(session.billingMode || ''),
      profile: String(session.profile || ''),
      startedAt: session.startedAt ?? null,
      lastActivityAt: session.lastActivityAt ?? null,
      activityDescription: String(session.activityDescription || ''),
      recentActions: (Array.isArray(session.recentActions) ? session.recentActions : []).map((action) => [String(action.label || ''), action.at ?? null]),
      endedAt: session.endedAt ?? null,
      turnStartedAt: session.turnStartedAt ?? null,
      messageCount: session.messageCount ?? null,
      toolCallCount: session.toolCallCount ?? null,
      inputTokens: session.inputTokens ?? null,
      outputTokens: session.outputTokens ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({ dbOk: Boolean(m.dbOk), sessions: stableSessions });
}

function build({ forcePresent = false } = {}) {
  const metrics = collect();
  const plan = surfacePlan(metrics);
  const signature = experienceSignature(metrics);
  const sendExperience = forcePresent || signature !== previousExperienceSignature;
  if (sendExperience) previousExperienceSignature = signature;
  return {
    liveActivity: shouldRenderActivity(metrics, plan) ? liveActivity(metrics) : null,
    experiences: sendExperience ? [tab(metrics)] : [],
    keepPresented: {
      activities: plan.keepActivity ? [ACTIVITY_ID] : [],
      experiences: plan.keepExperience ? [EXPERIENCE_ID] : [],
    },
    pulse: plan.keepActivity && plan.pulse,
    pulseDurationMs: plan.pulse ? FINISH_PULSE_MS : 0,
    nextWakeInMs: metrics.nextWakeInMs || 0,
    _metrics: metrics,
  };
}

module.exports = {
  id: 'hermes.monitor',
  fallbackPollMs: 15000,
  watch: (onChange, onError) => watchStateDb(onChange, { onError }),
  legacyIds: {
    activities: ['hima.demo', 'hima.test-run', 'hima.test', 'hermes.monitor', 'hermes.monitor.v2'],
    experiences: ['hima.demo-tab', 'hima.system', 'hima.clock', 'hima.web', 'hima.system-run', 'hermes.monitor.tab', 'hermes.monitor.tab.v2', 'hermes.monitor.tab.v3', 'hermes.monitor.tab.v4', 'hermes.monitor.tab.v5', 'hermes.monitor.wprobe', 'hermes.monitor.wprobe2', 'hermes.monitor.wprobe3', 'hermes.monitor.nprobe', 'hermes.monitor.tab.v6', 'hermes.monitor.tab.v7', 'hermes.monitor.tab.v8', 'hermes.monitor.tab.v9', 'hermes.monitor.tab.v10', 'hermes.monitor.tab.v11', 'hermes.monitor.nprobe2', 'hermes.monitor.nprobe3', 'hermes.monitor.tab.v12', 'hermes.monitor.tab.v13', 'hermes.monitor.tab.v14', 'hermes.monitor.tab.v15', 'hermes.monitor.tab.v16'],
  },
  build,
  ownedIds: { activities: [ACTIVITY_ID], experiences: [EXPERIENCE_ID] },
  persistentIds: { experiences: [EXPERIENCE_ID] },
  debug: collect,
  _detectTransitions: detectTransitions,
  _resetTransitions: resetTransitionState,
  _render: { liveActivity, tab, experienceSignature, surfacePlan, needsActionDescription, shouldRenderActivity, sessionDeepLink, toolActionLabel },
  _watch: { watchStateDb },
};

if (require.main === module) {
  console.log(JSON.stringify(collect(), null, 2));
}
