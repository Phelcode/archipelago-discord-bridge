import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { pollRunningGames } from '../src/watcher.js';

function makeEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-watch-'));
  const config = { dataDir, apDir: dataDir, basePort: 39100, watchIntervalMs: 30000 };
  const db = new Store(path.join(dataDir, 'db.json'));
  return { config, db };
}

function apStub(probeResult, overrides = {}) {
  const calls = { probe: 0 };
  return {
    calls,
    isServerProcessAlive: () => true,
    probe: async () => { calls.probe += 1; return probeResult; },
    ...overrides,
  };
}

const RECEIVED = {
  players: [
    { slot: 1, name: 'Alice' },
    { slot: 2, name: 'Bob' },
  ],
  received: {
    1: [{ item_id: 10, item: 'Map Bombs', location_id: 3, location: 'Tile 3', sender_slot: 2, sender_name: 'Bob', flags: 1 }],
    2: [],
  },
};

test('blocked players get a DM for each new item; last-received index advances for everyone', async () => {
  const { config, db } = makeEnv();
  db.setPlayer('u1', { slot: 'Alice', game: 'G' });
  db.setPlayer('u2', { slot: 'Bob', game: 'G' });
  db.setPreference('u1', 'blocked', true);
  db.setGame('g', { name: 'g', status: 'running', port: 39001, playerIds: ['u1', 'u2'] });
  const ap = apStub(RECEIVED);
  const dms = [];
  await pollRunningGames(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(ap.calls.probe, 1);
  assert.equal(dms.length, 1);
  assert.equal(dms[0][0], 'u1');
  assert.match(dms[0][1], /Map Bombs/);
  assert.match(dms[0][1], /Bob/);
  assert.match(dms[0][1], /\*\*g\*\*/);
  assert.equal(db.getPreference('u1').lastReceivedIndex.g, 1);
  assert.equal(db.getPreference('u2').lastReceivedIndex.g, 0); // u2 unblocked: index still advances, no DM

  // second tick: nothing new -> no further DMs
  await pollRunningGames(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(dms.length, 1);
});

test('unblocked players get no DMs even with new items', async () => {
  const { config, db } = makeEnv();
  db.setPlayer('u1', { slot: 'Alice', game: 'G' });
  db.setGame('g', { name: 'g', status: 'running', port: 39001, playerIds: ['u1'] });
  const ap = apStub(RECEIVED);
  const dms = [];
  await pollRunningGames(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  assert.equal(dms.length, 0);
  assert.equal(db.getPreference('u1').lastReceivedIndex.g, 1);
});

test('non-running or dead games are skipped; probe failures are tolerated', async () => {
  const { config, db } = makeEnv();
  db.setPlayer('u1', { slot: 'Alice', game: 'G' });
  db.setPreference('u1', 'blocked', true);
  db.setGame('stopped', { name: 'stopped', status: 'stopped', playerIds: ['u1'] });
  db.setGame('dead', { name: 'dead', status: 'running', playerIds: ['u1'] });
  db.setGame('boom', { name: 'boom', status: 'running', playerIds: ['u1'] });
  const ap = apStub(RECEIVED, { isServerProcessAlive: (g) => g.name !== 'dead' });
  const origProbe = ap.probe;
  ap.probe = async (c, game) => {
    ap.calls.probe += 1;
    if (game.name === 'boom') throw new Error('conn refused');
    return origProbe(c, game);
  };
  const dms = [];
  await pollRunningGames(config, db, ap, async (uid, text) => { dms.push([uid, text]); });
  // 'stopped' is not running and 'dead' is not alive, so only 'boom' is probed (and fails) -> no DMs
  assert.equal(ap.calls.probe, 1);
  assert.equal(dms.length, 0);
});
