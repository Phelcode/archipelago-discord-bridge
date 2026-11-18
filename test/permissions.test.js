import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roleOf, canHost, isOwner } from '../src/discord/permissions.js';
import { Store } from '../src/store.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const config = { discordOwnerId: 'owner-1' };

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-perm-'));
  return new Store(path.join(dir, 'db.json'));
}

test('owner from config has owner role and host permissions', () => {
  const db = makeDb();
  assert.equal(roleOf(db, config, 'owner-1'), 'owner');
  assert.equal(canHost(db, config, 'owner-1'), true);
  assert.equal(isOwner(config, 'owner-1'), true);
  assert.equal(isOwner(config, 'other'), false);
});

test('host role is read from the store', () => {
  const db = makeDb();
  db.addHost('host-1');
  assert.equal(roleOf(db, config, 'host-1'), 'host');
  assert.equal(canHost(db, config, 'host-1'), true);
});

test('registered player has player role but not host', () => {
  const db = makeDb();
  db.setPlayer('player-1', { slot: 'Alice', game: 'X' });
  assert.equal(roleOf(db, config, 'player-1'), 'player');
  assert.equal(canHost(db, config, 'player-1'), false);
});

test('everyone else is a spectator', () => {
  const db = makeDb();
  assert.equal(roleOf(db, config, 'random'), 'spectator');
  assert.equal(canHost(db, config, 'random'), false);
});
