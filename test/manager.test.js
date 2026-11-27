import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSeed, slugify, saveApworld, listApworlds, installApworlds, parseItemSends, stagePlayers, multiworldDir, extractPlayerFiles } from '../src/ap/manager.js';
import { Store } from '../src/store.js';
import { buildZip } from './zip.js';

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
  assert.equal(slugify('---'), 'multiworld');
});

test('apworlds are stored globally and installed into every game', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-ap-'));
  const apDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-apdir-'));
  const config = { dataDir, apDir };
  const zipBuf = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(10)]);
  assert.deepEqual(listApworlds(config), []);
  saveApworld(config, 'cool.apworld', zipBuf);
  saveApworld(config, '../evil.apworld', zipBuf); // basename is applied
  assert.deepEqual(listApworlds(config), ['cool.apworld', 'evil.apworld']);
  assert.ok(fs.existsSync(path.join(dataDir, 'apworlds', 'cool.apworld')));
  assert.equal(fs.existsSync(path.join(dataDir, 'evil.apworld')), false);

  installApworlds(config, { name: 'My Game' });
  // writable install dir (container runs as root): AP reads <apDir>/custom_worlds
  assert.deepEqual(fs.readdirSync(path.join(apDir, 'custom_worlds')).sort(), ['cool.apworld', 'evil.apworld']);
  // read-only install dir fallback: AP reads $XDG_DATA_HOME/Archipelago/worlds
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'xdg', 'my-game', 'Archipelago', 'worlds')).sort(), ['cool.apworld', 'evil.apworld']);
  // a second game gets the same global apworlds
  installApworlds(config, { name: 'other' });
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'xdg', 'other', 'Archipelago', 'worlds')).sort(), ['cool.apworld', 'evil.apworld']);
  assert.deepEqual(fs.readdirSync(path.join(apDir, 'custom_worlds')).sort(), ['cool.apworld', 'evil.apworld']);
});

test('parseItemSends extracts timestamped item sends from a MultiServer log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-log-'));
  const log = path.join(dir, 'server.log');
  fs.writeFileSync(log, [
    '[MultiServer at 2026-01-02 03:04:05,678]: (Team #1) Alice sent Map Bombs to Bob (Tile 3)',
    '[MultiServer at 2026-01-02 03:05:00,000]: (Team #1) Bob sent Progressive Sword to Alice (Tile 1)',
    '[MultiServer at 2026-01-02 03:06:00,000]: some other log line',
  ].join('\n') + '\n');
  const sends = parseItemSends(log);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[0], { at: '2026-01-02 03:04:05,678', sender: 'Alice', item: 'Map Bombs', receiver: 'Bob', location: 'Tile 3' });
  assert.deepEqual(sends[1], { at: '2026-01-02 03:05:00,000', sender: 'Bob', item: 'Progressive Sword', receiver: 'Alice', location: 'Tile 1' });
  assert.deepEqual(parseItemSends(path.join(dir, 'missing.log')), []);
});

test('stagePlayers stages each (player, mw) member once even with duplicate ids', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-stage-'));
  const config = { dataDir, apDir: dataDir };
  const db = new Store(path.join(dataDir, 'db.json'));
  db.setPlayer('u1', { slot: 'Alice', game: 'ChecksFinder' });
  fs.mkdirSync(path.join(dataDir, 'players', 'u1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'players', 'u1', 'Alice.yaml'), 'name: Alice\ngame: ChecksFinder\nChecksFinder: {}\n');
  const mw = { name: 'g', userIds: ['u1', 'u1'] };
  const staged = stagePlayers(config, db, mw);
  assert.deepEqual(staged, ['Alice']);
  assert.deepEqual(fs.readdirSync(path.join(multiworldDir(config, mw), 'Players')), ['Alice.yaml']);
});

test('stagePlayers stages every world (slot) of every member user', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-stage2-'));
  const config = { dataDir, apDir: dataDir };
  const db = new Store(path.join(dataDir, 'db.json'));
  db.setPlayer('u1', { slot: 'Alice', game: 'ChecksFinder' });
  db.setPlayer('u1', { slot: 'Alice2', game: 'HollowKnight' });
  db.setPlayer('u2', { slot: 'Bob', game: 'ChecksFinder' });
  fs.mkdirSync(path.join(dataDir, 'players', 'u1'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'players', 'u2'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'players', 'u1', 'Alice.yaml'), 'name: Alice\n');
  fs.writeFileSync(path.join(dataDir, 'players', 'u1', 'Alice2.yaml'), 'name: Alice2\n');
  fs.writeFileSync(path.join(dataDir, 'players', 'u2', 'Bob.yaml'), 'name: Bob\n');
  const mw = { name: 'g', userIds: ['u1', 'u2'] };
  const staged = stagePlayers(config, db, mw);
  assert.deepEqual(staged.sort(), ['Alice', 'Alice2', 'Bob']);
  assert.deepEqual(fs.readdirSync(path.join(multiworldDir(config, mw), 'Players')).sort(), ['Alice.yaml', 'Alice2.yaml', 'Bob.yaml']);
});
test('extractPlayerFiles pulls root-level player files (e.g. .apmc) from an AP zip, skipping subfolders and yaml', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-zip-'));
  const zip = path.join(dir, 'AP_123.zip');
  fs.writeFileSync(zip, buildZip([
    { name: 'Alice.apmc', data: Buffer.from('alice-apmc-data'), deflate: true },
    { name: 'Bob.apmc', data: Buffer.from('bob-apmc-data') },
    { name: 'data/multidata', data: Buffer.from('multidata') },
    { name: 'Alice.yaml', data: Buffer.from('name: Alice') },
    { name: 'readme.txt', data: Buffer.from('hi') },
  ]));
  const outDir = path.join(dir, 'player-files');
  const files = extractPlayerFiles(zip, outDir);
  assert.deepEqual(Object.keys(files).sort(), ['Alice', 'Bob']);
  assert.equal(fs.readFileSync(files.Alice, 'utf8'), 'alice-apmc-data');
  assert.equal(fs.readFileSync(files.Bob, 'utf8'), 'bob-apmc-data');
  assert.ok(!fs.existsSync(path.join(outDir, 'data')));
  // not a zip -> throws
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, 'PK not really');
  assert.throws(() => extractPlayerFiles(bad, path.join(dir, 'out2')));
});
