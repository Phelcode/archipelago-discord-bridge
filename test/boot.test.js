import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { restartRunningGames } from '../src/index.js';

function makeEnv() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-boot-'));
  const config = { dataDir, apDir: dataDir, basePort: 39100, publicHost: 'ap.example.com' };
  const db = new Store(path.join(dataDir, 'db.json'));
  return { config, db };
}

function makeZip(config, name = 'x.zip') {
  const zip = path.join(config.dataDir, name);
  fs.writeFileSync(zip, 'PK');
  return zip;
}

function apStub(overrides = {}) {
  const calls = [];
  return {
    calls,
    isPortListening: async () => false,
    startGame: (c, d, game, port) => { calls.push(['start', game.name, port]); return { pid: 4242, logFile: '/tmp/log' }; },
    stopGame: () => { calls.push(['stop']); return true; },
    waitForPort: async () => true,
    ...overrides,
  };
}

test('a running game with a multiworld is restarted on boot, keeping its port', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setGame('g', { name: 'g', status: 'running', multidata: zip, playerIds: [], port: 39500 });
  const ap = apStub();
  await restartRunningGames(config, db, ap);
  assert.deepEqual(ap.calls, [['start', 'g', 39500]]);
  const g = db.getGame('g');
  assert.equal(g.status, 'running');
  assert.equal(g.pid, 4242);
  assert.equal(g.port, 39500);
  assert.ok(g.startedAt);
});

test('running game without multiworld, and generating games, are marked stopped without starting', async () => {
  const { config, db } = makeEnv();
  db.setGame('nomulti', { name: 'nomulti', status: 'running', playerIds: [] });
  db.setGame('halfgen', { name: 'halfgen', status: 'generating', playerIds: [] });
  db.setGame('setup', { name: 'setup', status: 'setup', playerIds: [] });
  const ap = apStub();
  await restartRunningGames(config, db, ap);
  assert.deepEqual(ap.calls, []);
  assert.equal(db.getGame('nomulti').status, 'stopped');
  assert.equal(db.getGame('halfgen').status, 'stopped');
  assert.equal(db.getGame('setup').status, 'setup');
});

test('a server that never comes up marks the game stopped and kills the process', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setGame('g', { name: 'g', status: 'running', multidata: zip, playerIds: [] });
  const ap = apStub({ waitForPort: async () => false });
  await restartRunningGames(config, db, ap);
  assert.deepEqual(ap.calls, [['start', 'g', 39100], ['stop']]);
  assert.equal(db.getGame('g').status, 'stopped');
});

test('startGame throwing marks the game stopped', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setGame('g', { name: 'g', status: 'running', multidata: zip, playerIds: [] });
  const ap = apStub({
    startGame: () => { throw new Error('boom'); },
  });
  await restartRunningGames(config, db, ap);
  assert.equal(db.getGame('g').status, 'stopped');
});

test('busy or taken ports are skipped when picking the restart port', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setGame('g', { name: 'g', status: 'running', multidata: zip, playerIds: [], port: 39100 });
  db.setGame('other', { name: 'other', status: 'running', multidata: zip, playerIds: [], port: 39101 });
  const ap = apStub({ isPortListening: async (p) => p === 39100 });
  await restartRunningGames(config, db, ap);
  assert.deepEqual(ap.calls, [['start', 'g', 39102], ['start', 'other', 39101]]);
  assert.equal(db.getGame('g').port, 39102);
  assert.equal(db.getGame('other').port, 39101);
});
