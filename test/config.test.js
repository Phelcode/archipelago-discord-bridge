import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const base = {
  DISCORD_TOKEN: 't',
  DISCORD_APPLICATION_ID: 'a',
  DISCORD_OWNER_ID: 'o',
};

test('missing core env vars throw', () => {
  assert.throws(() => loadConfig({}), /DISCORD_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 't' }), /DISCORD_APPLICATION_ID/);
  assert.throws(() => loadConfig({ DISCORD_TOKEN: 't', DISCORD_APPLICATION_ID: 'a' }), /DISCORD_OWNER_ID/);
});

test('loads defaults (no public key or gateway env vars needed)', () => {
  const config = loadConfig(base);
  assert.equal(config.discordToken, 't');
  assert.equal(config.discordApplicationId, 'a');
  assert.equal(config.discordOwnerId, 'o');
  assert.equal(config.discordGuildId, null);
  assert.equal(config.port, 3000);
  assert.equal(config.basePort, 38281);
  assert.equal(config.hintsEnabled, true);
  assert.equal(config.publicHost, 'localhost');
  assert.equal(config.maxAttachmentBytes, 25 * 1024 * 1024);
});

test('env overrides are applied', () => {
  const config = loadConfig({
    ...base,
    DISCORD_GUILD_ID: 'g1',
    PORT: '4000',
    BASE_PORT: '39000',
    HINTS_ENABLED: 'false',
    AP_SERVER_HOST: 'ap.example.com',
    MAX_ATTACHMENT_MB: '5',
  });
  assert.equal(config.discordGuildId, 'g1');
  assert.equal(config.port, 4000);
  assert.equal(config.basePort, 39000);
  assert.equal(config.hintsEnabled, false);
  assert.equal(config.publicHost, 'ap.example.com');
  assert.equal(config.maxAttachmentBytes, 5 * 1024 * 1024);
});
