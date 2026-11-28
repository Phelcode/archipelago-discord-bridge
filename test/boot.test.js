import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { restartRunningMultiworlds } from '../src/index.js';

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
    startMultiworld: (c, d, mw, port) => { calls.push(['start', mw.name, port]); return { pid: 4242, logFile: '/tmp/log' }; },
    stopMultiworld: () => { calls.push(['stop']); return true; },
    waitForPort: async () => true,
    ...overrides,
  };
}

test('a running game with a multiworld is restarted on boot, keeping its port', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setMultiworld('g', { name: 'g', status: 'running', multidata: zip, userIds: [], port: 39500 });
  const ap = apStub();
  await restartRunningMultiworlds(config, db, ap);
  assert.deepEqual(ap.calls, [['start', 'g', 39500]]);
  const g = db.getMultiworld('g');
  assert.equal(g.status, 'running');
  assert.equal(g.pid, 4242);
  assert.equal(g.port, 39500);
  assert.ok(g.startedAt);
});

test('running game without multiworld, and generating games, are marked stopped without starting', async () => {
  const { config, db } = makeEnv();
  db.setMultiworld('nomulti', { name: 'nomulti', status: 'running', userIds: [] });
  db.setMultiworld('halfgen', { name: 'halfgen', status: 'generating', userIds: [] });
  db.setMultiworld('setup', { name: 'setup', status: 'setup', userIds: [] });
  const ap = apStub();
  await restartRunningMultiworlds(config, db, ap);
  assert.deepEqual(ap.calls, []);
  assert.equal(db.getMultiworld('nomulti').status, 'stopped');
  assert.equal(db.getMultiworld('halfgen').status, 'stopped');
  assert.equal(db.getMultiworld('setup').status, 'setup');
});

test('a server that never comes up marks the game stopped and kills the process', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setMultiworld('g', { name: 'g', status: 'running', multidata: zip, userIds: [] });
  const ap = apStub({ waitForPort: async () => false });
  await restartRunningMultiworlds(config, db, ap);
  assert.deepEqual(ap.calls, [['start', 'g', 39100], ['stop']]);
  assert.equal(db.getMultiworld('g').status, 'stopped');
});

test('boot restart failure surfaces the server log tail in the error', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  const logFile = path.join(config.dataDir, 'server.log');
  fs.writeFileSync(logFile, 'usage: MultiServer.py ...\nerror: unrecognized arguments: --logtime\n');
  db.setMultiworld('g', { name: 'g', status: 'running', multidata: zip, userIds: [] });
  const ap = apStub({ waitForPort: async () => false, startMultiworld: () => ({ pid: 1, logFile }) });
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.map(String).join(' '));
  try {
    await restartRunningMultiworlds(config, db, ap);
  } finally {
    console.error = orig;
  }
  assert.equal(db.getMultiworld('g').status, 'stopped');
  assert.match(errors.join('\n'), /unrecognized arguments: --logtime/);
});

test('startMultiworld throwing marks the game stopped', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setMultiworld('g', { name: 'g', status: 'running', multidata: zip, userIds: [] });
  const ap = apStub({
    startMultiworld: () => { throw new Error('boom'); },
  });
  await restartRunningMultiworlds(config, db, ap);
  assert.equal(db.getMultiworld('g').status, 'stopped');
});

test('busy or taken ports are skipped when picking the restart port', async () => {
  const { config, db } = makeEnv();
  const zip = makeZip(config);
  db.setMultiworld('g', { name: 'g', status: 'running', multidata: zip, userIds: [], port: 39100 });
  db.setMultiworld('other', { name: 'other', status: 'running', multidata: zip, userIds: [], port: 39101 });
  const ap = apStub({ isPortListening: async (p) => p === 39100 });
  await restartRunningMultiworlds(config, db, ap);
  assert.deepEqual(ap.calls, [['start', 'g', 39102], ['start', 'other', 39101]]);
  assert.equal(db.getMultiworld('g').port, 39102);
  assert.equal(db.getMultiworld('other').port, 39101);
});
