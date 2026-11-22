import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { createDispatcher, chunkContent } from '../src/discord/dispatch.js';
import { MODAL_REGISTER, MODAL_UPLOAD_APWORLD, MODAL_SETUP_MULTIWORLD } from '../src/discord/commands.js';

function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-disp-'));
  return {
    discordOwnerId: 'owner-1',
    discordGuildIds: [],
    dataDir,
    basePort: 39000,
    publicHost: 'ap.example.com',
    maxAttachmentBytes: 25 * 1024 * 1024,
    hintsEnabled: true,
    ...overrides,
  };
}

function setup(overrides = {}, download) {
  const config = makeConfig(overrides.config || {});
  const db = overrides.db || new Store(path.join(config.dataDir, 'db.json'));
  const dispatch = createDispatcher({ config, db, download: download || (async () => { throw new Error('no network in tests'); }) });
  return { config, db, dispatch };
}

function baseInteraction(kind, extra = {}) {
  const calls = { reply: [], deferReply: [], editReply: [], followUp: [], showModal: [] };
  const flagSet = new Set();
  const interaction = {
    user: { id: 'user-1', username: 'tester' },
    guildId: 'guild-1',
    flags: { has: (f) => flagSet.has(Number(f)) },
    isChatInputCommand() { return kind === 'chat'; },
    isModalSubmit() { return kind === 'modal'; },
    reply: async (p) => { calls.reply.push(p); if (p?.flags !== undefined) flagSet.add(Number(p.flags)); },
    deferReply: async (p) => { calls.deferReply.push(p); if (p?.flags !== undefined) flagSet.add(Number(p.flags)); },
    editReply: async (c) => { calls.editReply.push(c); },
    followUp: async (p) => { calls.followUp.push(p); },
    showModal: async (m) => { calls.showModal.push(m); },
    ...extra,
  };
  return { interaction, calls };
}

function chat(name, { options = [], userId = 'user-1', guildId = 'guild-1', attachments = {}, users = {} } = {}) {
  return baseInteraction('chat', {
    commandName: name,
    user: { id: userId, username: 'tester' },
    guildId,
    options: {
      data: options,
      getAttachment: (n) => attachments[n] || null,
      getUser: (n) => users[n] || null,
    },
  });
}

function modal(customId, { fieldTypes = {}, textValues = {}, uploadedFiles = {}, userId = 'user-1', guildId = 'guild-1' } = {}) {
  return baseInteraction('modal', {
    customId,
    user: { id: userId, username: 'tester' },
    guildId,
    fields: {
      fields: new Map(Object.entries(fieldTypes)),
      getUploadedFiles: (id) => uploadedFiles[id],
      getTextInputValue: (id) => textValues[id],
    },
  });
}

test('chunkContent splits long messages on newlines under the limit', () => {
  const line = 'x'.repeat(100);
  const text = Array.from({ length: 40 }, () => line).join('\n');
  const chunks = chunkContent(text);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1900);
  assert.equal(chunks.join('\n'), text);
  assert.deepEqual(chunkContent('short'), ['short']);
});

test('DM interactions (no guild) are accepted even when DISCORD_GUILD_ID is configured', async () => {
  const { dispatch } = setup({ config: { discordGuildIds: ['guild-1'] } });
  const { interaction, calls } = chat('commands', { guildId: null });
  await dispatch(interaction);
  assert.equal(calls.reply.length, 0);
  assert.deepEqual(calls.deferReply, [{}]);
  assert.match(calls.editReply[0], /\*\*Commands\*\*/);
});

test('owner-only commands are denied for non-owners', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = chat('role', { options: [{ name: 'list', type: 1, options: [] }] });
  await dispatch(interaction);
  assert.equal(calls.reply.length, 1);
  assert.match(calls.reply[0].content, /Only the owner/);
  assert.equal(calls.deferReply.length, 0);
});

test('host-only commands are denied for non-hosts (no modal shown)', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = chat('setup-multiworld');
  await dispatch(interaction);
  assert.equal(calls.reply.length, 1);
  assert.match(calls.reply[0].content, /Only hosts/);
  assert.equal(calls.showModal.length, 0);
});

test('delete-multiworld is host-only', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = chat('delete-multiworld', { options: [{ name: 'multiworld', type: 3, value: 'g' }] });
  await dispatch(interaction);
  assert.equal(calls.reply.length, 1);
  assert.match(calls.reply[0].content, /Only hosts/);
  assert.equal(calls.deferReply.length, 0);
});

test('always-modal commands open a modal', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = chat('register');
  await dispatch(interaction);
  assert.equal(calls.showModal.length, 1);
  assert.equal(calls.showModal[0].toJSON().custom_id, MODAL_REGISTER);
  assert.equal(calls.deferReply.length, 0);
  assert.equal(calls.reply.length, 0);
});

test('regular commands defer then edit the reply with the result', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = chat('commands');
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{}]);
  assert.equal(calls.editReply.length, 1);
  assert.match(calls.editReply[0], /\*\*Commands\*\*/);
  assert.match(calls.editReply[0], /\/register/);
});

test('private-responses preference makes every reply ephemeral', async () => {
  const { db, dispatch } = setup();
  db.setPreference('user-1', 'privateResponses', true);
  const { interaction, calls } = chat('help');
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{ flags: 64 }]);
});

test('role subcommand is ephemeral and parses user options', async () => {
  const { db, dispatch } = setup();
  const { interaction, calls } = chat('role', {
    userId: 'owner-1',
    options: [{ name: 'add', type: 1, options: [{ name: 'user', type: 6, value: 'u-9' }, { name: 'role', type: 3, value: 'host' }] }],
    users: { user: { id: 'u-9' } },
  });
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{ flags: 64 }]);
  assert.match(calls.editReply[0], /Assigned role \*\*host\*\* to <@u-9>/);
  assert.equal(db.isHost('u-9'), true);
});

test('register modal submit downloads the uploaded yaml and registers the player', async () => {
  const yaml = 'name: Dave\ngame: ChecksFinder\nChecksFinder: {}\n';
  const { db, dispatch } = setup({}, async () => Buffer.from(yaml));
  const { interaction, calls } = modal(MODAL_REGISTER, {
    fieldTypes: { yaml: { type: 19 }, name: { type: 4 } },
    uploadedFiles: { yaml: new Map([['a1', { id: 'a1', name: 'dave.yaml', size: yaml.length, url: 'https://cdn/dave.yaml' }]]) },
    textValues: { name: '' },
  });
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{ flags: 64 }]); // register is always ephemeral
  assert.match(calls.editReply[0], /Registered world \*\*Dave\*\*/);
  assert.equal(db.getPlayer('user-1').slot, 'Dave');
});

test('setup-multiworld modal submit creates the game for a host', async () => {
  const { db, dispatch } = setup();
  db.addHost('host-1');
  const { interaction, calls } = modal(MODAL_SETUP_MULTIWORLD, {
    userId: 'host-1',
    fieldTypes: { name: { type: 4 }, password: { type: 4 } },
    textValues: { name: 'My Game', password: 'pw' },
  });
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{}]);
  assert.match(calls.editReply[0], /Created multiworld \*\*my-game\*\*/);
  assert.equal(db.getMultiworld('my-game').password, 'pw');
});

test('host modals are denied for non-hosts', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = modal(MODAL_UPLOAD_APWORLD, { fieldTypes: { file: { type: 19 } } });
  await dispatch(interaction);
  assert.equal(calls.reply.length, 1);
  assert.match(calls.reply[0].content, /Only hosts/);
  assert.equal(calls.deferReply.length, 0);
});

test('upload-apworld modal submit stores the file globally (no game field)', async () => {
  const zipBuf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
  const { config, db, dispatch } = setup({}, async () => zipBuf);
  db.addHost('host-1');
  const { interaction, calls } = modal(MODAL_UPLOAD_APWORLD, {
    userId: 'host-1',
    fieldTypes: { file: { type: 19 } },
    uploadedFiles: { file: new Map([['a1', { id: 'a1', name: 'cool.apworld', size: zipBuf.length, url: 'https://cdn/cool.apworld' }]]) },
  });
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{}]);
  assert.match(calls.editReply[0], /Uploaded \*\*cool\.apworld\*\*/);
  assert.match(calls.editReply[0], /every multiworld/);
  assert.ok(fs.existsSync(path.join(config.dataDir, 'apworlds', 'cool.apworld')));
  assert.equal(fs.existsSync(path.join(config.dataDir, 'games')), false);
});

test('unknown modal custom ids are rejected', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = modal('bridge_nope');
  await dispatch(interaction);
  assert.equal(calls.reply.length, 1);
  assert.match(calls.reply[0].content, /Unknown form/);
});

test('non-command interactions are ignored', async () => {
  const { dispatch } = setup();
  const { interaction, calls } = baseInteraction('component');
  await dispatch(interaction);
  assert.deepEqual(calls, { reply: [], deferReply: [], editReply: [], followUp: [], showModal: [] });
});

test('UserError results in a ❌ editReply, unexpected errors in "Something went wrong"', async () => {
  const { dispatch } = setup();
  const stats = chat('stats', { options: [{ name: 'multiworld', type: 3, value: 'nope' }] });
  await dispatch(stats.interaction);
  assert.match(stats.calls.editReply[0], /^❌ /);
  assert.match(stats.calls.editReply[0], /Unknown multiworld/);

  const boom = modal(MODAL_REGISTER, {
    fieldTypes: { yaml: { type: 19 } },
    uploadedFiles: { yaml: new Map([['a1', { id: 'a1', name: 'x.yaml', size: 3, url: 'u' }]]) },
  });
  const { dispatch: dispatch2 } = setup({}, async () => { throw new Error('boom'); });
  await dispatch2(boom.interaction);
  assert.match(boom.calls.editReply[0], /Something went wrong: boom/);
});

test('long replies are chunked: one editReply plus followUps', async () => {
  const { db, dispatch } = setup();
  for (let i = 0; i < 60; i += 1) db.setPlayer(`u${i}`, { slot: `SlotNumber${i}`, game: 'ChecksFinder' });
  const { interaction, calls } = chat('players');
  await dispatch(interaction);
  assert.equal(calls.editReply.length, 1);
  assert.ok(calls.followUp.length >= 1);
  for (const p of calls.followUp) assert.ok(p.content.length <= 1900);
});

test('followUps inherit the ephemeral flag of the deferred reply', async () => {
  const { db, dispatch } = setup();
  db.setPreference('user-1', 'privateResponses', true);
  for (let i = 0; i < 60; i += 1) db.setPlayer(`u${i}`, { slot: `SlotNumber${i}`, game: 'ChecksFinder' });
  const { interaction, calls } = chat('players');
  await dispatch(interaction);
  assert.deepEqual(calls.deferReply, [{ flags: 64 }]);
  assert.ok(calls.followUp.length >= 1);
  for (const p of calls.followUp) assert.equal(p.flags, 64);
});
