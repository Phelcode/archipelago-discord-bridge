import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = {
  DISCORD_TOKEN: 't',
  DISCORD_APPLICATION_ID: 'a',
  DISCORD_OWNER_ID: 'o',
  DISCORD_PUBLIC_KEY: 'pk',
};

test('gateway mode is the default and does not require the public key', () => {
  const { DISCORD_PUBLIC_KEY, ...env } = base;
  const config = loadConfig(env);
  assert.equal(config.useGateway, true);
  assert.equal(config.discordPublicKey, null);
  assert.equal(config.gatewayIntents, 0);
});

test('HTTP endpoint mode requires the public key', () => {
  const { DISCORD_PUBLIC_KEY, ...env } = { ...base, DISCORD_GATEWAY: 'false' };
  assert.throws(() => loadConfig(env), /DISCORD_PUBLIC_KEY/);
  const config = loadConfig({ ...base, DISCORD_GATEWAY: 'false' });
  assert.equal(config.useGateway, false);
  assert.equal(config.discordPublicKey, 'pk');
});

test('missing core env vars throw', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
});
