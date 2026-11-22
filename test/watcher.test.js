import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { pollRunningMultiworlds } from '../src/watcher.js';
import { multiworldDir, parseItemSendsText } from '../src/ap/manager.js';

function makeEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-watch-'));
  const config = { dataDir, apDir: dataDir, basePort: 39100, watchIntervalMs: 30000 };
  const db = new Store(path.join(dataDir, 'db.json'));
  return { config, db };
}

function writeLog(config, mw, lines) {
  const dir = multiworldDir(config, mw);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'server.log'), lines.join('\n') + '\n');
}

function apStub() {
  const calls = { probe: 0 };
  return {
    calls,
    isServerProcessAlive: () => true,
    probe: async () => { calls.probe += 1; throw new Error('watcher must not probe'); },
    multiworldDir,
    parseItemSendsText,
  };
}

const SEND_ALICE = '[MultiServer at 2026-01-02 03:04:05,678]: (Team #1) Bob sent Map Bombs to Alice (Tile 3)';
const SEND_ALICE_2 = '[MultiServer at 2026-01-02 03:06:00,000]: (Team #1) Bob sent Progressive Sword to Alice (Tile 4)';
const SEND_BOB = '[MultiServer at 2026-01-02 03:05:00,000]: (Team #1) Alice sent Key to Bob (Tile 9)';

test('blocked players get a DM per new item send in the log; offset advances; no probing', async () => {
  const { config, db } = makeEnv();
  db.setPlayer('u1', { slot: 'Alice', game: 'G' });
  db.setPlayer('u2', { slot: 'Bob', game: 'G' });
  db.setPreference('u1', 'blocked', true);
  db.setMultiworld('g', { name: 'g', status: 'running', port: 39001, userIds: ['u1', 'u2'] });
  writeLog(config, db.getMultiworld('g'), [SEND_ALICE, SEND_BOB]);
  const ap = apStub();
  const dms = [];
  await pollRunningMultiworlds(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(ap.calls.probe, 0, 'watcher never opens a websocket');
  assert.equal(dms.length, 1); // only Alice is blocked; Bob's send is ignored
  assert.equal(dms[0][0], 'u1');
  assert.match(dms[0][1], /Map Bombs/);
  assert.match(dms[0][1], /Bob/);
  assert.match(dms[0][1], /2026-01-02 03:04:05,678/);
  assert.equal(db.getPreference('u1').lastReceivedIndex.g, 1);
  assert.ok(db.getMultiworld('g').logOffset > 0);

  // second tick with one more send to Alice: exactly one more DM
  const logFile = path.join(multiworldDir(config, db.getMultiworld('g')), 'server.log');
  fs.appendFileSync(logFile, SEND_ALICE_2 + '\n');
  await pollRunningMultiworlds(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(dms.length, 2);
  assert.match(dms[1][1], /Progressive Sword/);
  assert.equal(db.getPreference('u1').lastReceivedIndex.g, 2);

  // third tick, nothing new: no DM
  await pollRunningMultiworlds(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(dms.length, 2);
});

test('games with no blocked players are not even read; non-running/dead games skipped', async () => {
  const { config, db } = makeEnv();
  db.setPlayer('u1', { slot: 'Alice', game: 'G' });
  db.setMultiworld('g', { name: 'g', status: 'running', port: 39001, userIds: ['u1'] });
  writeLog(config, db.getMultiworld('g'), [SEND_ALICE]);
  db.setMultiworld('stopped', { name: 'stopped', status: 'stopped', userIds: ['u1'] });
  db.setMultiworld('dead', { name: 'dead', status: 'running', userIds: ['u1'] });
  db.setPreference('u1', 'blocked', true); // blocked, but only in 'dead'/'stopped'... move to dead:
  db.setMultiworld('g', { name: 'g', status: 'running', port: 39001, userIds: ['u1'], logOffset: 0 });
  const ap = apStub();
  ap.isServerProcessAlive = (g) => g.name !== 'dead';
  const dms = [];
  await pollRunningMultiworlds(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  // u1 is blocked and in 'g' (running+alive) -> one DM from g; dead/stopped skipped
  assert.equal(dms.length, 1);

  // now unblock everyone -> log not read, no offset change
  db.setPreference('u1', 'blocked', false);
  const before = db.getMultiworld('g').logOffset;
  await pollRunningMultiworlds(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(dms.length, 1);
  assert.equal(db.getMultiworld('g').logOffset, before);
});
