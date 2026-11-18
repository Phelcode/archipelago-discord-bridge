import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { handleCommand, parseInteraction, UserError } from '../src/discord/commands.js';
import * as realAp from '../src/ap/manager.js';

function makeConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-cfg-'));
  return {
    discordOwnerId: 'owner-1',
    dataDir,
    basePort: 39000,
    publicHost: 'ap.example.com',
    maxAttachmentBytes: 25 * 1024 * 1024,
    hintsEnabled: true,
  };
}

function makeCtx(overrides = {}) {
  const config = overrides.config || makeConfig();
  const db = overrides.db || new Store(path.join(config.dataDir, 'db.json'));
  const api = overrides.api || {
    async downloadAttachment() { throw new Error('no network in tests'); },
  };
  const ap = overrides.ap || realAp;
  return {
    config,
    db,
    api,
    ap,
    userId: overrides.userId || 'user-1',
    userName: 'tester',
    options: overrides.options || {},
    attachments: overrides.attachments || {},
    subcommand: overrides.subcommand || null,
    subOptions: overrides.subOptions || {},
  };
}

function commandInteraction(name, options = [], resolved = {}) {
  return {
    type: 2,
    token: 'tok',
    data: { name, options, resolved },
    member: { user: { id: 'user-1', username: 'tester' } },
    guild_id: 'guild-1',
  };
}

test('parseInteraction parses options, users and attachments', () => {
  const interaction = commandInteraction('upload-apworld', [
    { name: 'game', type: 3, value: 'mygame' },
    { name: 'file', type: 10, value: 'att-1' },
  ], {
    attachments: { 'att-1': { id: 'att-1', filename: 'x.apworld', url: 'https://cdn/x', size: 10 } },
  });
  const parsed = parseInteraction(interaction);
  assert.equal(parsed.options.game, 'mygame');
  assert.equal(parsed.attachments.file.filename, 'x.apworld');
});

test('parseInteraction parses subcommands', () => {
  const interaction = commandInteraction('role', [
    { name: 'add', type: 1, options: [
      { name: 'user', type: 6, value: 'u-9' },
      { name: 'role', type: 3, value: 'host' },
    ] },
  ], { users: { 'u-9': { id: 'u-9' } } });
  const parsed = parseInteraction(interaction);
  assert.equal(parsed.subcommand, 'add');
  assert.equal(parsed.subOptions.user, 'u-9');
  assert.equal(parsed.subOptions.role, 'host');
});

test('help lists role-appropriate commands', async () => {
  const ctx = makeCtx({ userId: 'owner-1' });
  const out = await handleCommand('help', ctx);
  assert.match(out, /owner/);
  assert.match(out, /\/role/);
  const spectator = await handleCommand('help', makeCtx({ userId: 'nobody' }));
  assert.match(spectator, /spectator/);
  assert.doesNotMatch(spectator, /\/setup-game/);
});

test('register validates and stores the player yaml', async () => {
  const yaml = 'name: Alice\ngame: ChecksFinder\nChecksFinder: {}\n';
  const ctx = makeCtx({
    attachments: { yaml: { filename: 'alice.yaml', size: yaml.length, url: 'https://cdn/alice.yaml' } },
    api: { async downloadAttachment() { return Buffer.from(yaml); } },
  });
  const out = await handleCommand('register', ctx);
  assert.match(out, /Alice/);
  assert.match(out, /ChecksFinder/);
  assert.equal(ctx.db.getPlayer('user-1').slot, 'Alice');
  assert.ok(fs.existsSync(path.join(ctx.config.dataDir, 'players', 'user-1.yaml')));
});

test('register rejects bad yaml', async () => {
  const ctx = makeCtx({
    attachments: { yaml: { filename: 'bad.yaml', size: 5, url: 'u' } },
    api: { async downloadAttachment() { return Buffer.from('foo: bar\n'); } },
  });
  await assert.rejects(() => handleCommand('register', ctx), UserError);
});

test('register rejects non-yaml filename', async () => {
  const ctx = makeCtx({
    attachments: { yaml: { filename: 'evil.apworld', size: 5, url: 'u' } },
    api: { async downloadAttachment() { return Buffer.from('x'); } },
  });
  await assert.rejects(() => handleCommand('register', ctx), /not a \.yaml/);
});

test('setup-game creates a game and join adds the player', async () => {
  const ctx = makeCtx({ userId: 'host-1' });
  ctx.db.addHost('host-1');
  ctx.options = { name: 'My Game', password: 'pw' };
  const out = await handleCommand('setup-game', ctx);
  assert.match(out, /my-game/);
  assert.equal(ctx.db.getGame('my-game').password, 'pw');

  const playerCtx = makeCtx({ db: ctx.db, config: ctx.config, userId: 'user-1' });
  playerCtx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  playerCtx.options = { game: 'my-game' };
  const joinOut = await handleCommand('join', playerCtx);
  assert.match(joinOut, /Alice/);
  assert.deepEqual(ctx.db.getGame('my-game').playerIds, ['user-1']);
});

test('setup-game discards previous players and yamls', async () => {
  const ctx = makeCtx({ userId: 'host-1' });
  ctx.db.addHost('host-1');
  ctx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  ctx.db.setGame('old', { name: 'old', status: 'stopped', playerIds: ['user-1'], apworlds: [] });
  const playersDir = path.join(ctx.config.dataDir, 'players');
  fs.mkdirSync(playersDir, { recursive: true });
  fs.writeFileSync(path.join(playersDir, 'user-1.yaml'), 'name: Alice\n');

  ctx.options = { name: 'new-game' };
  const out = await handleCommand('setup-game', ctx);
  assert.match(out, /new-game/);
  assert.match(out, /discarded/);
  assert.equal(ctx.db.getPlayer('user-1'), null);
  assert.deepEqual(ctx.db.data.players, {});
  assert.deepEqual(ctx.db.getGame('old').playerIds, []);
  assert.equal(fs.existsSync(playersDir), false);
  assert.ok(ctx.db.getGame('new-game'));
});

test('join requires registration', async () => {
  const ctx = makeCtx();
  ctx.options = { game: 'x' };
  await assert.rejects(() => handleCommand('join', ctx), /Unknown game/);
  ctx.db.setGame('x', { name: 'x', status: 'setup', playerIds: [], apworlds: [] });
  await assert.rejects(() => handleCommand('join', ctx), /register/);
});

test('upload-apworld validates zip magic and stores the file', async () => {
  const ctx = makeCtx();
  ctx.db.setGame('g', { name: 'g', status: 'setup', playerIds: [], apworlds: [] });
  const zipBuf = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100)]);
  ctx.options = { game: 'g' };
  ctx.attachments = { file: { filename: 'cool.apworld', size: zipBuf.length, url: 'u' } };
  ctx.api = { async downloadAttachment() { return zipBuf; } };
  const out = await handleCommand('upload-apworld', ctx);
  assert.match(out, /cool\.apworld/);
  assert.ok(fs.existsSync(path.join(ctx.config.dataDir, 'games', 'g', 'apworlds', 'cool.apworld')));

  ctx.attachments = { file: { filename: 'fake.apworld', size: 4, url: 'u' } };
  ctx.api = { async downloadAttachment() { return Buffer.from('nope'); } };
  await assert.rejects(() => handleCommand('upload-apworld', ctx), /not a valid zip/);
});

test('stats renders probe output per player', async () => {
  const ctx = makeCtx();
  ctx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  ctx.db.setGame('g', { name: 'g', status: 'running', port: 39001, playerIds: ['user-1'], apworlds: [] });
  ctx.ap = {
    ...realAp,
    async probe() {
      return {
        room: { seed_name: '123', games: ['ChecksFinder'], hint_cost: 5, location_check_points: 1 },
        players: [{ slot: 2, name: 'Alice', game: 'ChecksFinder', checked: [1, 2], checked_names: ['Tile 1', 'Tile 2'], missing_count: 23, total: 25, hint_points: 2, status: 20 }],
        hints: { 2: [] },
      };
    },
  };
  ctx.options = { game: 'g' };
  const out = await handleCommand('stats', ctx);
  assert.match(out, /Alice/);
  assert.match(out, /2\/25 checks \(8%\)/);
  assert.match(out, /playing/);
  assert.match(out, /ap\.example\.com:39001/);
});

test('game-stats aggregates gamewide numbers', async () => {
  const ctx = makeCtx();
  ctx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  ctx.db.setPlayer('user-2', { slot: 'Bob', game: 'ChecksFinder' });
  ctx.db.setGame('g', { name: 'g', status: 'running', port: 39001, playerIds: ['user-1', 'user-2'], apworlds: [] });
  ctx.ap = {
    ...realAp,
    async probe() {
      return {
        room: { seed_name: '42', games: ['ChecksFinder'], hint_cost: 5, location_check_points: 1 },
        players: [
          { slot: 1, name: 'Bob', game: 'ChecksFinder', checked: [5], checked_names: [], missing_count: 24, total: 25, hint_points: 1, status: 30 },
          { slot: 2, name: 'Alice', game: 'ChecksFinder', checked: [1, 2], checked_names: [], missing_count: 23, total: 25, hint_points: 0, status: 20 },
        ],
        hints: { 2: [{ item: 'Map Bombs', location: 'Tile 3', finding_player_name: 'Alice', found: false }] },
      };
    },
  };
  const out = await handleCommand('game-stats', ctx);
  assert.match(out, /3\/50\*\* \(6%\)/);
  assert.match(out, /completed \(goal\): 1/);
  assert.match(out, /Hints: 1 created, 0 found/);
});

test('hints shows only the player hints and respects HINTS_ENABLED', async () => {
  const ctx = makeCtx();
  ctx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  ctx.db.setGame('g', { name: 'g', status: 'running', port: 39001, playerIds: ['user-1'], apworlds: [] });
  ctx.ap = {
    ...realAp,
    async probe() {
      return {
        room: {},
        players: [{ slot: 2, name: 'Alice', game: 'ChecksFinder', checked: [], missing_count: 25, total: 25, hint_points: 0, status: 20 }],
        hints: { 2: [{ item: 'Map Bombs', location: 'Tile 3', finding_player_name: 'Alice', found: true, entrance: '' }] },
      };
    },
  };
  const out = await handleCommand('hints', ctx);
  assert.match(out, /Map Bombs/);
  assert.match(out, /Tile 3/);

  const noHints = makeCtx({ config: { ...ctx.config, hintsEnabled: false }, db: ctx.db });
  await assert.rejects(() => handleCommand('hints', noHints), /disabled/);
});

test('stats on a non-running game fails with a clear message', async () => {
  const ctx = makeCtx();
  ctx.db.setGame('g', { name: 'g', status: 'setup', playerIds: [], apworlds: [] });
  ctx.options = { game: 'g' };
  await assert.rejects(() => handleCommand('stats', ctx), /not running/);
});

test('role add/remove/list manage hosts', async () => {
  const ctx = makeCtx({ userId: 'owner-1' });
  ctx.subcommand = 'add';
  ctx.subOptions = { user: 'host-9', role: 'host' };
  const out = await handleCommand('role', ctx);
  assert.match(out, /host-9/);
  assert.equal(ctx.db.isHost('host-9'), true);

  ctx.subcommand = 'list';
  const list = await handleCommand('role', ctx);
  assert.match(list, /host-9/);
  assert.match(list, /owner-1/);

  ctx.subcommand = 'remove';
  await handleCommand('role', ctx);
  assert.equal(ctx.db.isHost('host-9'), false);
});

test('role rejects assigning the owner', async () => {
  const ctx = makeCtx({ userId: 'owner-1' });
  ctx.subcommand = 'add';
  ctx.subOptions = { user: 'owner-1', role: 'host' };
  await assert.rejects(() => handleCommand('role', ctx), /owner/);
});
