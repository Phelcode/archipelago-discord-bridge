import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  assert.deepEqual(config.discordGuildIds, []);
  assert.equal(config.port, 3000);
  assert.equal(config.basePort, 38281);
  assert.equal(config.hintsEnabled, true);
  assert.equal(config.publicHost, 'localhost');
  assert.equal(config.maxAttachmentBytes, 25 * 1024 * 1024);
  assert.equal(config.watchIntervalMs, 30000);
});

test('env overrides are applied', () => {
  const config = loadConfig({
    ...base,
    DISCORD_GUILD_ID: 'g1, g2 ',
    PORT: '4000',
    BASE_PORT: '39000',
    HINTS_ENABLED: 'false',
    AP_SERVER_HOST: 'ap.example.com',
    MAX_ATTACHMENT_MB: '5',
  });
  assert.deepEqual(config.discordGuildIds, ['g1', 'g2']);
  assert.equal(config.port, 4000);
  assert.equal(config.basePort, 39000);
  assert.equal(config.hintsEnabled, false);
  assert.equal(config.publicHost, 'ap.example.com');
  assert.equal(config.maxAttachmentBytes, 5 * 1024 * 1024);
});

test('apVersion is detected from the AP checkout Utils.py, AP_VERSION env wins, fallback 0.6.9', () => {
  const apDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-apver-'));
  fs.writeFileSync(path.join(apDir, 'Utils.py'), '__version__ = "0.6.9"\nversion_tuple = tuplize_version(__version__)\n');
  assert.equal(loadConfig({ ...base, AP_DIR: apDir }).apVersion, '0.6.9');
  fs.writeFileSync(path.join(apDir, 'Utils.py'), '__version__ = "0.7.1"\n');
  assert.equal(loadConfig({ ...base, AP_DIR: apDir }).apVersion, '0.7.1');
  assert.equal(loadConfig({ ...base, AP_DIR: apDir, AP_VERSION: '0.6.9' }).apVersion, '0.6.9');
  // no AP checkout present: fallback
  assert.equal(loadConfig({ ...base, AP_DIR: path.join(apDir, 'missing') }).apVersion, '0.6.9');
});
