import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import {
  handleCommand, handleModal, UserError,
  globalCommandPayload, guildCommandPayload, registerAllCommands,
  registerModal, uploadApworldModal, setupGameModal, generateModal,
  ALWAYS_MODAL, COMMAND_DEFINITIONS, MODAL_REGISTER, MODAL_UPLOAD_APWORLD, MODAL_SETUP_GAME, MODAL_GENERATE,
} from '../src/discord/commands.js';
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
  const ap = overrides.ap || realAp;
  return {
    config,
    db,
    ap,
    userId: overrides.userId || 'user-1',
    userName: 'tester',
    download: overrides.download || (async () => { throw new Error('no network in tests'); }),
    options: overrides.options || {},
    attachments: overrides.attachments || {},
    subcommand: overrides.subcommand || null,
    subOptions: overrides.subOptions || {},
    modal: overrides.modal || null,
  };
}

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
    download: async () => Buffer.from(yaml),
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
    download: async () => Buffer.from('foo: bar\n'),
  });
  await assert.rejects(() => handleCommand('register', ctx), UserError);
});

test('register rejects non-yaml filename', async () => {
  const ctx = makeCtx({
    attachments: { yaml: { filename: 'evil.apworld', size: 5, url: 'u' } },
    download: async () => Buffer.from('x'),
  });
  await assert.rejects(() => handleCommand('register', ctx), /not a \.yaml/);
});

test('handleModal routes the register modal to the register handler', async () => {
  const yaml = 'name: Dave\ngame: ChecksFinder\nChecksFinder: {}\n';
  const ctx = makeCtx({
    download: async () => Buffer.from(yaml),
    modal: { fields: { name: '' }, files: { yaml: [{ id: 'a1', filename: 'dave.yaml', size: yaml.length, url: 'https://cdn/dave.yaml' }] } },
  });
  const out = await handleModal(MODAL_REGISTER, ctx);
  assert.match(out, /Dave/);
  assert.equal(ctx.db.getPlayer('user-1').slot, 'Dave');
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
  ctx.download = async () => zipBuf;
  const out = await handleCommand('upload-apworld', ctx);
  assert.match(out, /cool\.apworld/);
  assert.ok(fs.existsSync(path.join(ctx.config.dataDir, 'games', 'g', 'apworlds', 'cool.apworld')));

  ctx.attachments = { file: { filename: 'fake.apworld', size: 4, url: 'u' } };
  ctx.download = async () => Buffer.from('nope');
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

test('command payloads support guild and user install in all contexts', () => {
  const global = globalCommandPayload(COMMAND_DEFINITIONS);
  assert.ok(global.length >= 15);
  for (const def of global) {
    assert.deepEqual(def.integration_types, [0, 1]);
    assert.deepEqual(def.contexts, [0, 1, 2]);
  }
  const guild = guildCommandPayload(COMMAND_DEFINITIONS);
  for (const def of guild) {
    assert.deepEqual(def.integration_types, [0]);
    assert.deepEqual(def.contexts, [0]);
  }
});

test('form commands take no inline options and always open a modal', () => {
  const byName = Object.fromEntries(COMMAND_DEFINITIONS.map((d) => [d.name, d]));
  const expectedModal = {
    register: MODAL_REGISTER,
    'upload-apworld': MODAL_UPLOAD_APWORLD,
    'setup-game': MODAL_SETUP_GAME,
    generate: MODAL_GENERATE,
  };
  for (const [name, customId] of Object.entries(expectedModal)) {
    assert.ok(ALWAYS_MODAL[name], `${name} is always-modal`);
    assert.deepEqual(byName[name].options, [], `${name} has no inline options`);
    assert.equal(ALWAYS_MODAL[name]().toJSON().custom_id, customId);
  }
  // required options must precede optional ones (Discord validation rule)
  for (const def of COMMAND_DEFINITIONS) {
    const opts = def.options || [];
    const firstOptional = opts.findIndex((o) => !o.required);
    if (firstOptional !== -1) {
      assert.ok(opts.slice(firstOptional).every((o) => !o.required), `${def.name}: required option after optional`);
    }
  }
});

test('modal builders produce file-upload (type 19) and text (type 4) components inside labels', () => {
  const reg = registerModal().toJSON();
  assert.equal(reg.custom_id, 'bridge_register');
  const fileComp = reg.components.find((c) => c.component.type === 19);
  assert.ok(fileComp, 'register modal has a file upload component');
  assert.equal(fileComp.component.custom_id, 'yaml');
  assert.ok(reg.components.some((c) => c.component.type === 4 && c.component.custom_id === 'name'));

  const up = uploadApworldModal().toJSON();
  assert.equal(up.custom_id, 'bridge_upload_apworld');
  assert.ok(up.components.some((c) => c.component.type === 19 && c.component.custom_id === 'file'));
  assert.ok(up.components.some((c) => c.component.type === 4 && c.component.custom_id === 'game'));

  const setup = setupGameModal().toJSON();
  assert.equal(setup.custom_id, 'bridge_setup_game');
  assert.ok(setup.components.some((c) => c.component.type === 4 && c.component.custom_id === 'name'));
  assert.ok(setup.components.some((c) => c.component.type === 4 && c.component.custom_id === 'password'));

  const gen = generateModal().toJSON();
  assert.equal(gen.custom_id, 'bridge_generate');
  assert.ok(gen.components.some((c) => c.component.type === 4 && c.component.custom_id === 'game'));
  assert.ok(gen.components.some((c) => c.component.type === 4 && c.component.custom_id === 'seed'));
});

test('profile replaces the built-in /me name', () => {
  const names = COMMAND_DEFINITIONS.map((d) => d.name);
  assert.ok(names.includes('profile'));
  assert.ok(!names.includes('me'));
  assert.ok(!names.includes('whoami'));
});

test('profile shows role/registration and sets the private-responses preference', async () => {
  const ctx = makeCtx({ userId: 'user-1' });
  ctx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  let out = await handleCommand('profile', ctx);
  assert.match(out, /Role: \*\*player\*\*/);
  assert.match(out, /Alice/);
  assert.match(out, /public/);

  ctx.options = { responses: 'private' };
  out = await handleCommand('profile', ctx);
  assert.match(out, /private \(only you can see them\)/);
  assert.equal(ctx.db.getPreference('user-1').privateResponses, true);

  ctx.options = { responses: 'public' };
  await handleCommand('profile', ctx);
  assert.equal(ctx.db.getPreference('user-1').privateResponses, false);

  ctx.options = { responses: 'banana' };
  await assert.rejects(() => handleCommand('profile', ctx), /private.*public/);
});

test('setup-game and generate read fields from modal submits', async () => {
  const ctx = makeCtx({ userId: 'host-1' });
  ctx.db.addHost('host-1');
  ctx.modal = { fields: { name: 'Modal Game', password: 'pw' }, files: {} };
  const out = await handleCommand('setup-game', ctx);
  assert.match(out, /modal-game/);
  assert.equal(ctx.db.getGame('modal-game').password, 'pw');

  const genCtx = makeCtx({ db: ctx.db, config: ctx.config, userId: 'host-1' });
  genCtx.db.setPlayer('user-1', { slot: 'Alice', game: 'ChecksFinder' });
  const g = genCtx.db.getGame('modal-game');
  g.playerIds = ['user-1'];
  genCtx.db.setGame('modal-game', g);
  genCtx.ap = { ...realAp, async generateGame(c, d, game, seed) { return { multidata: '/tmp/x.zip', spoiler: '/tmp/s.txt', seed: '1', seedNumber: seed, players: ['Alice'], log: '' }; } };
  genCtx.modal = { fields: { game: 'modal-game', seed: '424242' }, files: {} };
  const genOut = await handleCommand('generate', genCtx);
  assert.match(genOut, /424242/);
  assert.equal(genCtx.db.getGame('modal-game').seedNumber, 424242);

  genCtx.modal = { fields: { game: 'modal-game', seed: 'abc' }, files: {} };
  await assert.rejects(() => handleCommand('generate', genCtx), /integer/);
});

function mockClient({ failGuild = false, failAppEdit = false } = {}) {
  const calls = [];
  const client = {
    application: {
      edit: async (patch) => { if (failAppEdit) throw new Error('403'); calls.push(['app', patch]); },
      commands: { set: async (defs) => { calls.push(['global', defs]); } },
    },
    guilds: {
      fetch: async (id) => ({
        commands: {
          set: async (defs) => {
            if (failGuild) throw new Error('Discord APIError: 403 Missing Access');
            calls.push(['guild', id, defs]);
          },
        },
      }),
    },
  };
  return { client, calls };
}

test('registerAllCommands updates the app and registers global (+guild) commands', async () => {
  const { client, calls } = mockClient();
  await registerAllCommands(client, { guildId: 'g1', definitions: COMMAND_DEFINITIONS });
  assert.deepEqual(calls[0], ['app', { integration_types: [0, 1] }]);
  assert.equal(calls[1][0], 'global');
  assert.equal(calls[1][1][0].integration_types[1], 1);
  assert.deepEqual(calls[1][1][0].contexts, [0, 1, 2]);
  assert.equal(calls[2][0], 'guild');
  assert.equal(calls[2][1], 'g1');
  assert.deepEqual(calls[2][2][0].integration_types, [0]);

  const second = mockClient();
  await registerAllCommands(second.client, { guildId: null, definitions: COMMAND_DEFINITIONS });
  assert.equal(second.calls.filter((c) => c[0] === 'guild').length, 0);
  assert.equal(second.calls.filter((c) => c[0] === 'global').length, 1);
});

test('registerAllCommands warns but succeeds when app-edit or guild registration is denied', async () => {
  const { client } = mockClient({ failAppEdit: true, failGuild: true });
  await registerAllCommands(client, { guildId: 'g1', definitions: COMMAND_DEFINITIONS }); // must not throw
  const noGuild = mockClient({ failGuild: true });
  await registerAllCommands(noGuild.client, { guildId: null, definitions: COMMAND_DEFINITIONS }); // must not throw
});
