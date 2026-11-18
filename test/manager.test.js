import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSeed, slugify, saveApworld, listApworlds, installApworlds } from '../src/ap/manager.js';

test('resolveSeed passes through an explicit seed', () => {
  assert.equal(resolveSeed(12345), 12345);
  assert.equal(resolveSeed('777'), 777);
});

test('resolveSeed generates a random seed when none is given', () => {
  for (const seed of [undefined, null, '']) {
    const value = resolveSeed(seed);
    assert.ok(Number.isInteger(value));
    assert.ok(value >= 1 && value < 2 ** 48);
  }
  const a = resolveSeed();
  const b = resolveSeed();
  assert.notEqual(a, b);
});

test('slugify', () => {
  assert.equal(slugify('My Game!'), 'my-game');
  assert.equal(slugify('---'), 'game');
});

test('apworlds are stored globally and installed into every game', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-ap-'));
  const config = { dataDir };
  const zipBuf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(10)]);
  assert.deepEqual(listApworlds(config), []);
  saveApworld(config, 'cool.apworld', zipBuf);
  saveApworld(config, '../evil.apworld', zipBuf); // basename is applied
  assert.deepEqual(listApworlds(config), ['cool.apworld', 'evil.apworld']);
  assert.ok(fs.existsSync(path.join(dataDir, 'apworlds', 'cool.apworld')));
  assert.equal(fs.existsSync(path.join(dataDir, 'evil.apworld')), false);

  const worldsDir = installApworlds(config, { name: 'My Game' });
  assert.deepEqual(fs.readdirSync(worldsDir).sort(), ['cool.apworld', 'evil.apworld']);
  // a second game gets the same global apworlds
  const worldsDir2 = installApworlds(config, { name: 'other' });
  assert.deepEqual(fs.readdirSync(worldsDir2).sort(), ['cool.apworld', 'evil.apworld']);
});
