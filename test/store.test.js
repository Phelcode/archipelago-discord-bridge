import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-store-'));
  return new Store(path.join(dir, 'db.json'));
}

test('store persists hosts, players and games', () => {
  const store = tempStore();
  store.addHost('111');
  store.addHost('111');
  assert.deepEqual(store.data.hosts, ['111']);
  store.setPlayer('222', { slot: 'Alice', game: 'ChecksFinder' });
  store.setMultiworld('mygame', { name: 'mygame', status: 'setup', userIds: ['222'], apworlds: [] });
  store.save();

  const reloaded = new Store(store.file);
  assert.equal(reloaded.isHost('111'), true);
  assert.equal(reloaded.isHost('999'), false);
  assert.equal(reloaded.getPlayer('222').slot, 'Alice');
  assert.equal(reloaded.getMultiworld('mygame').status, 'setup');
});

test('store remove operations', () => {
  const store = tempStore();
  store.addHost('111');
  store.removeHost('111');
  assert.equal(store.isHost('111'), false);
  store.setPlayer('222', { slot: 'Bob', game: 'X' });
  store.removePlayer('222');
  assert.equal(store.getPlayer('222'), null);
});

test('store starts empty when file is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-store-'));
  const file = path.join(dir, 'db.json');
  const store = new Store(file);
  assert.deepEqual(store.data, { hosts: [], players: {}, worlds: {}, multiworlds: {}, preferences: {} });
  fs.writeFileSync(file, '{not json');
  const store2 = new Store(file);
  assert.deepEqual(store2.data, { hosts: [], players: {}, worlds: {}, multiworlds: {}, preferences: {} });
});

test('store persists per-user preferences and tolerates old db files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-store-'));
  const file = path.join(dir, 'db.json');
  fs.writeFileSync(file, JSON.stringify({ hosts: ['1'], players: {}, multiworlds: {} })); // no preferences key
  const store = new Store(file);
  assert.deepEqual(store.getPreference('1'), {});
  store.setPreference('1', 'privateResponses', true);
  assert.equal(new Store(file).getPreference('1').privateResponses, true);
});
