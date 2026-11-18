import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordApi } from '../src/discord/api.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(calls.length, url, opts);
  };
  return calls;
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

test('editOriginal retries 404 Unknown Webhook then succeeds', async () => {
  const calls = stubFetch((n) =>
    n <= 2 ? jsonResponse(404, { message: 'Unknown Webhook', code: 10015 }) : jsonResponse(200, { id: 'm1' }));
  const api = createDiscordApi({ token: 't', applicationId: 'app', apiBase: 'https://api.test' });
  const result = await api.editOriginal('tok', { content: 'hi' });
  assert.deepEqual(result, { id: 'm1' });
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/webhooks\/app\/tok\/messages\/@original$/);
  assert.equal(calls[0].opts.method, 'PATCH');
});

test('editOriginal gives up after bounded retries on persistent 10015', async () => {
  const calls = stubFetch(() => jsonResponse(404, { message: 'Unknown Webhook', code: 10015 }));
  const api = createDiscordApi({ token: 't', applicationId: 'app', apiBase: 'https://api.test' });
  await assert.rejects(() => api.editOriginal('tok', { content: 'hi' }), /404/);
  assert.equal(calls.length, 5); // 1 initial + 4 retries
});

test('other 404 errors are not retried', async () => {
  const calls = stubFetch(() => jsonResponse(404, { message: 'Unknown Channel', code: 10003 }));
  const api = createDiscordApi({ token: 't', applicationId: 'app', apiBase: 'https://api.test' });
  await assert.rejects(() => api.followup('tok', { content: 'hi' }), /404/);
  assert.equal(calls.length, 1);
});

test('respondToInteraction posts to the callback endpoint with retries enabled', async () => {
  const calls = stubFetch((n) =>
    n === 1 ? jsonResponse(404, { message: 'Unknown Webhook', code: 10015 }) : jsonResponse(204, ''));
  const api = createDiscordApi({ token: 't', applicationId: 'app', apiBase: 'https://api.test' });
  await api.respondToInteraction('int1', 'tok', { type: 5 });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/interactions\/int1\/tok\/callback$/);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { type: 5 });
});
