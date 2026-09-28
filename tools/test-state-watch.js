#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const monitor = require('../plugins/hermes-monitor.js');
const watchStateDb = monitor._watch?.watchStateDb;
assert.equal(typeof watchStateDb, 'function', 'monitor exposes a local state.db change watcher');

const scratch = path.join(os.homedir(), '.hermes', 'scratch');
fs.mkdirSync(scratch, { recursive: true });
const dir = fs.mkdtempSync(path.join(scratch, 'notch-state-watch-'));
const dbPath = path.join(dir, 'state.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE probe (value INTEGER)');
let notifications = 0;
const waiters = [];
const waitForCount = (target, timeoutMs = 2500) => new Promise((resolve, reject) => {
  if (notifications >= target) return resolve();
  const waiter = () => {
    if (notifications < target) return;
    clearTimeout(timer);
    waiters.splice(waiters.indexOf(waiter), 1);
    resolve();
  };
  const timer = setTimeout(() => {
    waiters.splice(waiters.indexOf(waiter), 1);
    reject(new Error(`no WAL change notification ${target} within ${timeoutMs}ms`));
  }, timeoutMs);
  waiters.push(waiter);
});
const stop = watchStateDb(() => {
  notifications++;
  for (const waiter of [...waiters]) waiter();
}, { dbPath, debounceMs: 80 });

async function run() {
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const initialCount = notifications;
    const firstChange = waitForCount(initialCount + 1);
    db.prepare('INSERT INTO probe(value) VALUES (?)').run(1);
    await firstChange;
    assert.equal(notifications, initialCount + 1, 'one SQLite transaction is coalesced into one wake-up');

    const beforeNoise = notifications;
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'ignored');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(notifications, beforeNoise, 'unrelated directory changes are ignored');

    const secondChange = waitForCount(beforeNoise + 1);
    db.prepare('INSERT INTO probe(value) VALUES (?)').run(2);
    await secondChange;
    console.log('PASS: SQLite WAL writes wake the monitor without polling and unrelated files are ignored');
  } finally {
    stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
