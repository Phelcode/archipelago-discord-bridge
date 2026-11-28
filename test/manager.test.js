import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { resolveSeed, slugify, saveApworld, listApworlds, installApworlds, parseItemSends, stagePlayers, multiworldDir, ensureApRequirements, apRequirementsPath, extractPlayerFiles, probe, say, closeProbeDaemon, startMultiworld, logTail, isPortListening, waitForPort } from '../src/ap/manager.js';
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
    '[Server at 2026-01-02 03:07:00,000]: (Team #2) Carol sent Bow to Dave (Tile 7)',
    '[2026-01-02 03:08:00] (Team #1) Dave sent Potion to Bob (Tile 8)',
    '(Team #1) Eve sent Lantern to Bob (Tile 9)',
  ].join('\n') + '\n');
  const sends = parseItemSends(log);
  assert.equal(sends.length, 5);
  assert.deepEqual(sends[0], { at: '2026-01-02 03:04:05,678', sender: 'Alice', item: 'Map Bombs', receiver: 'Bob', location: 'Tile 3' });
  assert.deepEqual(sends[1], { at: '2026-01-02 03:05:00,000', sender: 'Bob', item: 'Progressive Sword', receiver: 'Alice', location: 'Tile 1' });
  assert.deepEqual(sends[2], { at: '2026-01-02 03:07:00,000', sender: 'Carol', item: 'Bow', receiver: 'Dave', location: 'Tile 7' });
  assert.deepEqual(sends[3], { at: '2026-01-02 03:08:00', sender: 'Dave', item: 'Potion', receiver: 'Bob', location: 'Tile 8' });
  assert.deepEqual(sends[4], { at: '', sender: 'Eve', item: 'Lantern', receiver: 'Bob', location: 'Tile 9' });
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
test('ensureApRequirements pip-installs the requirements file into the AP venv, and skips when not possible', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-req-'));
  const apDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-apdir-'));
  const marker = path.join(dataDir, 'args.txt');
  const fakePython = path.join(dataDir, 'fake-python');
  fs.writeFileSync(fakePython, `#!/bin/sh\necho "$@" > "${marker}"\n`);
  fs.chmodSync(fakePython, 0o755);
  const config = { dataDir, apDir, apPython: fakePython };
  const reqPath = path.join(dataDir, 'requirements-ap.txt');
  fs.writeFileSync(reqPath, 'requests\n');

  assert.equal(await ensureApRequirements(config, reqPath), true);
  assert.match(fs.readFileSync(marker, 'utf8'), /^-m pip install .* -r .*requirements-ap\.txt/);

  // no venv python or no requirements file: skipped, nothing spawned
  assert.equal(await ensureApRequirements({ ...config, apPython: path.join(dataDir, 'missing-python') }, reqPath), false);
  assert.equal(await ensureApRequirements(config, path.join(dataDir, 'missing.txt')), false);

  // pip failure rejects so the caller can log it
  fs.writeFileSync(fakePython, '#!/bin/sh\nexit 1\n');
  await assert.rejects(() => ensureApRequirements(config, reqPath));

  // default path points at the repo's docker/requirements-ap.txt
  assert.ok(apRequirementsPath().endsWith(path.join('docker', 'requirements-ap.txt')));
  assert.ok(fs.existsSync(apRequirementsPath()));
});

test('requirements-ap.txt covers the world-load deps seen as ModuleNotFoundError in server logs', () => {
  const req = fs.readFileSync(apRequirementsPath(), 'utf8');
  for (const pkg of ['requests', 'setuptools', 'cryptography', 'pyevermizer', 'zilliandomizer']) {
    assert.match(req, new RegExp(`^${pkg}$`, 'm'), `requirements-ap.txt missing ${pkg}`);
  }
});

test('extractPlayerFiles pulls root-level output files from an AP zip (any entry but spoiler/hints/multidata), parsing AP_<seed>_P<n>_<player> names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-zip-'));
  const zip = path.join(dir, 'AP_123.zip');
  fs.writeFileSync(zip, buildZip([
    { name: 'AP_123_P1_Alice.apmc', data: Buffer.from('alice-apmc-data'), deflate: true },
    { name: 'AP_123_P2_Bob.apmc', data: Buffer.from('bob-apmc-data') },
    { name: 'AP_123_Spoiler.txt', data: Buffer.from('spoiler') },
    { name: 'AP_123_Hints.txt', data: Buffer.from('hints') },
    { name: 'data/multidata', data: Buffer.from('multidata') },
    { name: 'AP_123.zip', data: Buffer.from('nested') },
    { name: 'plain.apbp', data: Buffer.from('plain-name-entry') },
  ]));
  const outDir = path.join(dir, 'player-files');
  const files = extractPlayerFiles(zip, outDir);
  assert.deepEqual(files.map((f) => [f.player, f.entry]).sort(), [
    ['Alice', 'AP_123_P1_Alice.apmc'],
    ['Bob', 'AP_123_P2_Bob.apmc'],
    ['plain', 'plain.apbp'],
  ]);
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'alice-apmc-data');
  assert.equal(fs.readFileSync(files[2].path, 'utf8'), 'plain-name-entry');
  assert.ok(!fs.existsSync(path.join(outDir, 'data')));
  assert.ok(!fs.existsSync(path.join(outDir, 'AP_123_Spoiler.txt')));
  // not a zip -> throws
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(bad, 'PK not really');
  assert.throws(() => extractPlayerFiles(bad, path.join(dir, 'out2')));
});

function writeFakeProbeDaemon(dir, respond) {
  const script = path.join(dir, 'fake-probe.mjs');
  const countFile = path.join(dir, 'count.txt');
  fs.writeFileSync(countFile, '0');
  fs.writeFileSync(script, `import readline from 'node:readline';\nimport fs from 'node:fs';\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on('line', () => {\n  const n = Number(fs.readFileSync(${JSON.stringify(countFile)}, 'utf8')) + 1;\n  fs.writeFileSync(${JSON.stringify(countFile)}, String(n));\n  console.log(JSON.stringify(${respond}));\n});\n`);
  return { script, countFile };
}

test('isPortListening/waitForPort detect a server bound to IPv4-only or IPv6-only loopback', async () => {
  const s4 = net.createServer();
  await new Promise((r) => s4.listen(0, '127.0.0.1', r));
  const p4 = s4.address().port;
  assert.equal(await isPortListening(p4), true);
  assert.equal(await waitForPort(p4, 2000), true);
  await new Promise((r) => s4.close(r));
  assert.equal(await isPortListening(p4, null, 300), false);

  const s6 = net.createServer();
  const ok6 = await new Promise((resolve) => {
    s6.once('error', () => resolve(false));
    s6.listen(0, '::1', () => resolve(true));
  });
  if (!ok6) return; // no IPv6 loopback in this environment
  const p6 = s6.address().port;
  assert.equal(await isPortListening(p6), true);
  assert.equal(await waitForPort(p6, 2000), true);
  await new Promise((r) => s6.close(r));
});

test('startMultiworld passes --logtime only when the AP checkout supports it; logTail returns the log end', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-start-'));
  const apDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-apdir-'));
  const marker = path.join(dataDir, 'args.txt');
  const fakePython = path.join(dataDir, 'fake-python');
  fs.writeFileSync(fakePython, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + marker + '"\n');
  fs.chmodSync(fakePython, 0o755);
  fs.writeFileSync(path.join(apDir, 'MultiServer.py'), "parser.add_argument('--logtime', action='store_true')\n");
  const multidata = path.join(dataDir, 'AP_1.zip');
  fs.writeFileSync(multidata, 'PK');
  const config = { dataDir, apDir, apPython: fakePython };
  const db = new Store(path.join(dataDir, 'db.json'));
  const mw = { name: 'g', multidata, apworlds: [] };
  const waitForFile = async (file) => {
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
  };
  fs.rmSync(marker, { force: true });
  startMultiworld(config, db, mw, 39111);
  await waitForFile(marker);
  assert.match(fs.readFileSync(marker, 'utf8'), /(^|\n)--logtime(\n|$)/);
  fs.writeFileSync(path.join(apDir, 'MultiServer.py'), '# old AP without the flag\n');
  fs.rmSync(marker, { force: true });
  startMultiworld(config, db, mw, 39112);
  await waitForFile(marker);
  assert.doesNotMatch(fs.readFileSync(marker, 'utf8'), /--logtime/);
  const logFile = path.join(multiworldDir(config, mw), 'server.log');
  fs.appendFileSync(logFile, 'line1\nline2\n');
  assert.equal(logTail(logFile), 'line1\nline2\n');
  assert.equal(logTail(logFile, 4), 'ne2\n');
  assert.equal(logTail(path.join(dataDir, 'missing.log')), '');
});

test('probe retries once after a daemon error (e.g. stale socket keepalive 1011) and succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-probe1-'));
  const { script, countFile } = writeFakeProbeDaemon(dir, `(n === 1 ? { error: 'sent 1011 (internal error) keepalive ping timeout; no close frame received' } : { ok: true, n })`);
  const config = { dataDir: dir, apPython: process.execPath, apProbeScript: script, apVersion: '0.6.9' };
  const mw = { name: 'g1', port: 39991 };
  try {
    const res = await probe(config, mw, 'stats', null, 5000, ['Alice']);
    assert.deepEqual(res, { ok: true, n: 2 });
    assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
  } finally {
    closeProbeDaemon(mw);
  }
});

test('probe throws the daemon error after a single retry when errors persist', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-probe2-'));
  const { script, countFile } = writeFakeProbeDaemon(dir, `{ error: 'sent 1011 (internal error) keepalive ping timeout; no close frame received' }`);
  const config = { dataDir: dir, apPython: process.execPath, apProbeScript: script, apVersion: '0.6.9' };
  const mw = { name: 'g2', port: 39992 };
  try {
    await assert.rejects(() => probe(config, mw, 'stats', null, 5000, ['Alice']), /keepalive ping timeout/);
    assert.equal(fs.readFileSync(countFile, 'utf8'), '2');
    await assert.rejects(() => say(config, mw, 'Alice', '!release'), /keepalive ping timeout/);
    assert.equal(fs.readFileSync(countFile, 'utf8'), '4');
  } finally {
    closeProbeDaemon(mw);
  }
});

test('startMultiworld binds the AP server dual-stack (--host ::) on the given port', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-start-'));
  const apDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adb-apdir-'));
  const marker = path.join(dataDir, 'args.txt');
  const fakePython = path.join(dataDir, 'fake-python');
  fs.writeFileSync(fakePython, `#!/bin/sh\necho "$@" > "${marker}"\n`);
  fs.chmodSync(fakePython, 0o755);
  const config = { dataDir, apDir, apPython: fakePython };
  const multidata = path.join(dataDir, 'game.archipelago');
  fs.writeFileSync(multidata, 'x');
  startMultiworld(config, null, { name: 'mw', multidata, password: null }, 38281);
  for (let i = 0; i < 50 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
  const args = fs.readFileSync(marker, 'utf8');
  assert.match(args, /--host :: /);
  assert.match(args, /--port 38281/);
});
