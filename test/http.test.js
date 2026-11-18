import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nacl from 'tweetnacl';
import { createApp, createDispatcher, chunkContent } from '../src/index.js';
import { Store } from '../src/store.js';

const keypair = nacl.sign.keyPair();
const publicKeyHex = Buffer.from(keypair.publicKey).toString('hex');

let server;
let baseUrl;
let db;
let sent;

const fakeApi = {
  async editOriginal(token, payload) { sent.push({ token, payload }); },
  async followup(token, payload) { sent.push({ token, payload }); },
  async registerCommands() { return []; },
  async downloadAttachment() { throw new Error('no network'); },
};

function makeConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-http-'));
  return {
    discordToken: 't', discordPublicKey: publicKeyHex, discordApplicationId: 'app',
    discordOwnerId: 'owner-1', discordGuildId: 'guild-1', discordApiBase: 'http://127.0.0.1:1',
    port: 0, dataDir, apDir: '/nonexistent', apPython: 'python3', apProbeScript: 'x.py',
    apVersion: '0.6.9', hintsEnabled: true, basePort: 39100, publicHost: 'localhost',
    maxAttachmentBytes: 1024,
  };
}

async function postInteraction(body) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + raw), keypair.secretKey)).toString('hex');
  const res = await fetch(`${baseUrl}/interactions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signature-Ed25519': signature,
      'X-Signature-Timestamp': timestamp,
    },
    body: raw,
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  const config = makeConfig();
  db = new Store(path.join(config.dataDir, 'db.json'));
  const dispatch = createDispatcher({ config, db, api: fakeApi });
  const app = createApp({ config, db, api: fakeApi, dispatch });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('PING gets PONG', async () => {
  const { status, body } = await postInteraction({ type: 1 });
  assert.equal(status, 200);
  assert.deepEqual(body, { type: 1 });
});

test('invalid signature is rejected', async () => {
  const res = await fetch(`${baseUrl}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': '00', 'X-Signature-Timestamp': '1' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

test('host-only command is denied ephemerally for non-hosts', async () => {
  const { status, body } = await postInteraction({
    type: 2, token: 't1', guild_id: 'guild-1',
    data: { name: 'setup-game', options: [{ name: 'name', type: 3, value: 'x' }] },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  assert.equal(status, 200);
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /host/);
});

test('owner-only command is denied for hosts', async () => {
  db.addHost('host-1');
  const { body } = await postInteraction({
    type: 2, token: 't2', guild_id: 'guild-1',
    data: { name: 'role', options: [{ name: 'list', type: 1, options: [] }] },
    member: { user: { id: 'host-1', username: 'h' } },
  });
  assert.equal(body.type, 4);
  assert.match(body.data.content, /owner/);
});

test('wrong guild is rejected with an ephemeral reply', async () => {
  const { status, body } = await postInteraction({
    type: 2, token: 't3', guild_id: 'other-guild',
    data: { name: 'help', options: [] },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  assert.equal(status, 200);
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
});

test('/help defers then edits the original response', async () => {
  sent = [];
  const { status, body } = await postInteraction({
    type: 2, token: 't4', guild_id: 'guild-1',
    data: { name: 'help', options: [] },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  assert.equal(status, 200);
  assert.equal(body.type, 5);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].token, 't4');
  assert.match(sent[0].payload.content, /\/stats/);
});

test('ephemeral command defers with the ephemeral flag', async () => {
  const { body } = await postInteraction({
    type: 2, token: 't5', guild_id: 'guild-1',
    data: { name: 'me', options: [] },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  assert.equal(body.type, 5);
  assert.equal(body.data.flags, 64);
});

test('user-install DM interaction (no guild, no member) is handled', async () => {
  const config2 = makeConfig();
  config2.discordGuildId = null;
  const db2 = new Store(path.join(config2.dataDir, 'db.json'));
  const app2 = createApp({ config: config2, db: db2, api: fakeApi, dispatch: createDispatcher({ config: config2, db: db2, api: fakeApi }) });
  await new Promise((resolve) => {
    const s = app2.listen(0, '127.0.0.1', resolve);
    app2.on('listening', () => {});
    setTimeout(() => resolve(), 50);
  });
  const port = app2.address().port;
  sent = [];
  const raw = JSON.stringify({
    type: 2, token: 'dm1', guild_id: null, context: 1,
    data: { name: 'help', options: [] },
    user: { id: 'user-1', username: 'tester' },
    authorizing_integration_owners: { '1': 'user-1' },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + raw), keypair.secretKey)).toString('hex');
  const res = await fetch(`http://127.0.0.1:${port}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).type, 5);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.content, /\/stats/);
  app2.close();
});

test('/register with an attachment option resolves and downloads the file', async () => {
  const yaml = 'name: Carol\ngame: ChecksFinder\nChecksFinder: {}\n';
  const apiWithDownload = {
    ...fakeApi,
    downloads: [],
    async downloadAttachment(url) {
      this.downloads.push(url);
      return Buffer.from(yaml);
    },
  };
  const config3 = makeConfig();
  const db3 = new Store(path.join(config3.dataDir, 'db.json'));
  const dispatch3 = createDispatcher({ config: config3, db: db3, api: apiWithDownload });
  const app3 = createApp({ config: config3, db: db3, api: apiWithDownload, dispatch: dispatch3 });
  await new Promise((resolve) => app3.listen(0, '127.0.0.1', resolve));
  const port = app3.address().port;
  sent = [];
  const raw = JSON.stringify({
    type: 2, token: 't-att', guild_id: 'guild-1',
    data: {
      name: 'register',
      options: [{ name: 'yaml', type: 10, value: 'att-123' }],
      resolved: {
        attachments: {
          'att-123': { id: 'att-123', filename: 'carol.yaml', size: yaml.length, url: 'https://cdn.discordapp.com/attachments/1/2/carol.yaml', content_type: 'application/x-yaml' },
        },
      },
    },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + raw), keypair.secretKey)).toString('hex');
  const res = await fetch(`http://127.0.0.1:${port}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body: raw,
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).type, 5); // deferred (register is ephemeral)
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.content, /Registered as player \*\*Carol\*\*/);
  assert.deepEqual(apiWithDownload.downloads, ['https://cdn.discordapp.com/attachments/1/2/carol.yaml']);
  assert.equal(db3.getPlayer('user-1').slot, 'Carol');
  app3.close();
});

test('/register without an attachment answers with a modal (type 9) file upload', async () => {
  const { status, body } = await postInteraction({
    type: 2, token: 't-modal', guild_id: 'guild-1',
    data: { name: 'register', options: [] },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  assert.equal(status, 200);
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, 'bridge_register');
  const fileComp = body.data.components.find((c) => c.component?.type === 19);
  assert.ok(fileComp, 'modal has a file upload component');
  assert.equal(fileComp.component.custom_id, 'yaml');
  assert.equal(fileComp.type, 18, 'file upload wrapped in a Label');
});

test('modal submit for register downloads the uploaded file and registers', async () => {
  const yaml = 'name: Dave\ngame: ChecksFinder\nChecksFinder: {}\n';
  const apiDl = {
    ...fakeApi,
    async downloadAttachment() { return Buffer.from(yaml); },
  };
  const config4 = makeConfig();
  const db4 = new Store(path.join(config4.dataDir, 'db.json'));
  const app4 = createApp({ config: config4, db: db4, api: apiDl, dispatch: createDispatcher({ config: config4, db: db4, api: apiDl }) });
  await new Promise((resolve) => app4.listen(0, '127.0.0.1', resolve));
  const port = app4.address().port;
  sent = [];
  const raw = JSON.stringify({
    type: 3, token: 't-modalsubmit', guild_id: 'guild-1',
    data: {
      custom_id: 'bridge_register',
      components: [
        { type: 18, label: 'Player yaml file', component: { type: 19, custom_id: 'yaml', values: ['a9'] } },
        { type: 18, label: 'Name', component: { type: 4, custom_id: 'name', value: '' } },
      ],
      resolved: { attachments: { a9: { id: 'a9', filename: 'dave.yaml', size: yaml.length, url: 'https://cdn/dave.yaml' } } },
    },
    member: { user: { id: 'user-1', username: 'tester' } },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + raw), keypair.secretKey)).toString('hex');
  const res = await fetch(`http://127.0.0.1:${port}/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
    body: raw,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.type, 5);
  assert.equal(body.data.flags, 64); // ephemeral
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.content, /Registered as player \*\*Dave\*\*/);
  assert.equal(db4.getPlayer('user-1').slot, 'Dave');
  app4.close();
});

test('upload-apworld modal submit is host-only', async () => {
  const zip = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(50)]);
  const apiDl = { ...fakeApi, async downloadAttachment() { return zip; } };
  const config5 = makeConfig();
  const db5 = new Store(path.join(config5.dataDir, 'db.json'));
  db5.setGame('g', { name: 'g', status: 'setup', playerIds: [], apworlds: [] });
  const app5 = createApp({ config: config5, db: db5, api: apiDl, dispatch: createDispatcher({ config: config5, db: db5, api: apiDl }) });
  await new Promise((resolve) => app5.listen(0, '127.0.0.1', resolve));
  const port = app5.address().port;
  const postModal = async (userId) => {
    sent = [];
    const raw = JSON.stringify({
      type: 3, token: `t-${userId}`, guild_id: 'guild-1',
      data: {
        custom_id: 'bridge_upload_apworld',
        components: [
          { type: 18, label: 'Game', component: { type: 4, custom_id: 'game', value: 'g' } },
          { type: 18, label: 'File', component: { type: 19, custom_id: 'file', values: ['a1'] } },
        ],
        resolved: { attachments: { a1: { id: 'a1', filename: 'w.apworld', size: zip.length, url: 'https://cdn/w.apworld' } } },
      },
      member: { user: { id: userId, username: 'u' } },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(nacl.sign.detached(Buffer.from(timestamp + raw), keypair.secretKey)).toString('hex');
    const res = await fetch(`http://127.0.0.1:${port}/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': signature, 'X-Signature-Timestamp': timestamp },
      body: raw,
    });
    return { status: res.status, body: await res.json() };
  };
  const denied = await postModal('user-1');
  assert.equal(denied.body.type, 4);
  assert.match(denied.body.data.content, /host/);
  db5.addHost('host-1');
  const ok = await postModal('host-1');
  assert.equal(ok.body.type, 5);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent.length, 1);
  assert.match(sent[0].payload.content, /w\.apworld/);
  app5.close();
});

test('health endpoint', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('chunkContent splits long messages', () => {
  const text = 'a\n'.repeat(2000);
  const chunks = chunkContent(text, 1900);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 1900);
  assert.equal(chunks.join('\n').replace(/\n+/g, '\n').length > 0, true);
});
