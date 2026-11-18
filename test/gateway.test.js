import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startGateway } from '../src/discord/gateway.js';
import { createDispatcher } from '../src/index.js';
import { Store } from '../src/store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake gateway server: speaks just enough of the gateway protocol.
class FakeGateway {
  constructor() {
    this.sockets = [];
    this.received = [];
  }
  asWebSocketClass() {
    const self = this;
    return class FakeWebSocket {
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        self.sockets.push(this);
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
          this.serverSend({ op: 10, d: { heartbeat_interval: 40 } });
        }, 0);
      }
      send(data) {
        const payload = JSON.parse(data);
        self.received.push(payload);
        if (payload.op === 3) this.serverSend({ op: 11 }); // heartbeat ACK
      }
      close(code = 1000) {
        this.readyState = 3;
        this.closedWith = code;
        this.onclose?.({ code });
      }
      serverSend(payload) {
        this.onmessage?.({ data: JSON.stringify(payload) });
      }
    };
  }
  lastSocket() {
    return this.sockets[this.sockets.length - 1];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeInteraction(overrides = {}) {
  return {
    id: 'int-1',
    token: 'tok-1',
    type: 2,
    guild_id: 'guild-1',
    data: { name: 'help', options: [] },
    member: { user: { id: 'user-1', username: 'tester' } },
    ...overrides,
  };
}

test('gateway identifies, heartbeats and forwards INTERACTION_CREATE', async () => {
  const gw = new FakeGateway();
  const interactions = [];
  const gwClient = startGateway({
    token: 'tok',
    intents: 0,
    url: 'wss://fake-gateway',
    WebSocketImpl: gw.asWebSocketClass(),
    onInteraction: (i) => interactions.push(i),
    minReconnectDelayMs: 5,
    maxReconnectDelayMs: 20,
    logger: { info() {}, warn() {}, error() {} },
  });
  await sleep(10);
  const sock = gw.lastSocket();
  // client should have identified after hello
  const identify = gw.received.find((p) => p.op === 2);
  assert.ok(identify, 'identify sent');
  assert.equal(identify.d.intents, 0);
  assert.equal(identify.d.token, 'tok');
  // server sends READY then an interaction
  sock.serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: 'wss://fake-resume' } });
  sock.serverSend({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: makeInteraction() });
  await sleep(10);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0].data.name, 'help');
  // heartbeats were sent with the last seq
  await sleep(90);
  const beats = gw.received.filter((p) => p.op === 3);
  assert.ok(beats.length >= 1, 'heartbeats sent');
  assert.equal(beats[beats.length - 1].d, 2);
  // server-requested heartbeat (op 1) triggers an immediate one
  const before = gw.received.filter((p) => p.op === 3).length;
  sock.serverSend({ op: 1 });
  assert.ok(gw.received.filter((p) => p.op === 3).length > before);
  gwClient.stop();
});

test('gateway dispatch answers via the interaction callback endpoint', async () => {
  const gw = new FakeGateway();
  const responses = [];
  const edits = [];
  const fakeApi = {
    async respondToInteraction(id, token, body) { responses.push({ id, token, body }); },
    async editOriginal(token, payload) { edits.push({ token, payload }); },
    async followup() {},
  };
  const config = {
    discordOwnerId: 'owner-1', discordGuildId: null, hintsEnabled: true,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'adb-gw-')), basePort: 39000,
    publicHost: 'localhost', maxAttachmentBytes: 1024,
  };
  const db = new Store(path.join(config.dataDir, 'db.json'));
  const dispatch = createDispatcher({ config, db, api: fakeApi });
  const gwClient = startGateway({
    token: 'tok',
    url: 'wss://fake-gateway',
    WebSocketImpl: gw.asWebSocketClass(),
    onInteraction: async (interaction) => {
      const response = await dispatch(interaction);
      if (response) await fakeApi.respondToInteraction(interaction.id, interaction.token, response);
    },
    minReconnectDelayMs: 5,
    logger: { info() {}, warn() {}, error() {} },
  });
  await sleep(10);
  const sock = gw.lastSocket();
  sock.serverSend({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'wss://r' } });
  sock.serverSend({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: makeInteraction() });
  await sleep(30);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, 'int-1');
  assert.equal(responses[0].body.type, 5); // deferred
  assert.equal(edits.length, 1);
  assert.match(edits[0].payload.content, /\/stats/);
  gwClient.stop();
});

test('gateway recovers after a missing ACK: reconnects and does not flap again', async () => {
  // ACK heartbeats only on the second and later sockets (first connection loses ACKs)
  const sockets = [];
  let count = 0;
  class FlakyAckWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      count += 1;
      this.sockIndex = count;
      sockets.push(this);
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
        this.serverSend({ op: 10, d: { heartbeat_interval: 40 } });
      }, 0);
    }
    send(data) {
      const p = JSON.parse(data);
      if (p.op === 3 && this.sockIndex >= 2) this.serverSend({ op: 11 });
    }
    close(code = 1000) {
      this.readyState = 3;
      this.closedWith = code;
      this.onclose?.({ code });
    }
    serverSend(p) {
      this.onmessage?.({ data: JSON.stringify(p) });
    }
  }
  const gwClient = startGateway({
    token: 'tok',
    url: 'wss://fake-gateway',
    WebSocketImpl: FlakyAckWS,
    onInteraction: () => {},
    minReconnectDelayMs: 5,
    maxReconnectDelayMs: 20,
    logger: { info() {}, warn() {}, error() {} },
  });
  try {
    await sleep(250);
    assert.ok(sockets.length >= 2, 'reconnected after missing ACK');
    assert.ok(sockets.some((s) => s.closedWith === 4000), 'closed with 4000 on missing ACK');
    const countAfter = sockets.length;
    await sleep(250);
    assert.equal(sockets.length, countAfter, 'no further reconnects once ACKs arrive');
  } finally {
    gwClient.stop();
  }
});

test('gateway does not reconnect on fatal close codes', async () => {
  const gw = new FakeGateway();
  let errors = 0;
  const gwClient = startGateway({
    token: 'bad',
    url: 'wss://fake-gateway',
    WebSocketImpl: gw.asWebSocketClass(),
    onInteraction: () => {},
    minReconnectDelayMs: 5,
    logger: { info() {}, warn() {}, error() { errors += 1; } },
  });
  await sleep(10);
  const sock = gw.lastSocket();
  sock.readyState = 3;
  sock.onclose?.({ code: 4004, reason: 'Authentication failed.' });
  await sleep(30);
  assert.equal(gw.sockets.length, 1, 'no reconnect after fatal close');
  assert.ok(errors > 0);
  gwClient.stop();
});
