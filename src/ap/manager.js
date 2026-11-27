import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { userIdsOf } from '../store.js';

// Archipelago accepts seeds in [0, 10^20); we stay well inside safe-integer
// range. A random seed is always picked explicitly when none is given.
export function resolveSeed(seed) {
  if (seed !== undefined && seed !== null && seed !== '') return Number(seed);
  return crypto.randomInt(1, 2 ** 48);
}

export function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'multiworld';
}

export function multiworldDir(config, mw) {
  return path.join(config.dataDir, 'multiworlds', slugify(mw.name));
}

function ensureDirs(dir) {
  fs.mkdirSync(path.join(dir, 'apworlds'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Players'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
}

function apEnv(config, mw) {
  return {
    ...process.env,
    SKIP_REQUIREMENTS_UPDATE: '1',
    XDG_DATA_HOME: path.join(config.dataDir, 'xdg', slugify(mw.name)),
  };
}

function runProcess(config, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.apPython, args, {
      cwd: config.apDir,
      env: options.env || apEnv(config, options.multiworld || { name: 'default' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    const timer = options.timeoutMs
      ? setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Process timed out')); }, options.timeoutMs)
      : null;
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Process exited with code ${code}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`));
    });
  });
}

// Some worlds put a per-player file at the root of the generated AP_*.zip
// (e.g. Minecraft's <slot>.apmc) that the player must load in their game.
// Extracts those root-level files (skipping subfolders like data/ and
// non-patch extensions) into outDir. Returns a map of basename-without-
// extension -> extracted path. Pure JS (zlib) so no extra dependency is
// needed; handles stored (0) and deflated (8) entries.
export function extractPlayerFiles(zipPath, outDir) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${zipPath} is not a zip archive`);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  fs.mkdirSync(outDir, { recursive: true });
  const skipExt = new Set(['yaml', 'yml', 'txt', 'json', 'md']);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    const dot = name.lastIndexOf('.');
    if (name.endsWith('/') || name.includes('/') || dot <= 0) continue;
    if (skipExt.has(name.slice(dot + 1).toLowerCase())) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataOff, dataOff + compSize);
    let data = null;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    if (!data) continue;
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, data);
    out[name.slice(0, dot)] = dest;
  }
  return out;
}

// .apworld files are global: uploaded once, they are installed into every
// multiworld's world directory at generation time.
export function apworldDir(config) {
  return path.join(config.dataDir, 'apworlds');
}

export function listApworlds(config) {
  try {
    return fs.readdirSync(apworldDir(config)).filter((f) => f.toLowerCase().endsWith('.apworld')).sort();
  } catch {
    return [];
  }
}

export function saveApworld(config, filename, buffer) {
  const dir = apworldDir(config);
  fs.mkdirSync(dir, { recursive: true });
  const safeName = path.basename(filename);
  fs.writeFileSync(path.join(dir, safeName), buffer);
  return safeName;
}

// AP loads custom apworlds from <apDir>/custom_worlds when the install dir is
// writable (our container runs as root, so it always is), and from
// $XDG_DATA_HOME/Archipelago/worlds otherwise. Install into both so the
// apworlds are found either way.
export function installApworlds(config, mw) {
  const srcDir = apworldDir(config);
  const files = listApworlds(config);
  const targets = [
    path.join(config.apDir, 'custom_worlds'),
    path.join(config.dataDir, 'xdg', slugify(mw.name), 'Archipelago', 'worlds'),
  ];
  for (const dir of targets) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
      fs.copyFileSync(path.join(srcDir, file), path.join(dir, file));
    }
  }
  return targets[0];
}

export function stagePlayers(config, db, mw) {
  const playersDir = path.join(multiworldDir(config, mw), 'Players');
  fs.rmSync(playersDir, { recursive: true, force: true });
  fs.mkdirSync(playersDir, { recursive: true });
  const staged = [];
  for (const userId of userIdsOf(mw)) {
    for (const world of db.getWorlds(userId)) {
      const src = path.join(config.dataDir, 'players', userId, `${world.slot}.yaml`);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(playersDir, `${world.slot}.yaml`);
      fs.copyFileSync(src, dest);
      staged.push(world.slot);
    }
  }
  return staged;
}

export async function generateMultiworld(config, db, mw, seed) {
  ensureDirs(multiworldDir(config, mw));
  installApworlds(config, mw);
  const staged = stagePlayers(config, db, mw);
  if (staged.length === 0) {
    throw new Error(`No players joined this multiworld yet. Players must /register multiworld: ${mw.name} first.`);
  }
  const outputDir = path.join(multiworldDir(config, mw), 'output');
  const seedNumber = resolveSeed(seed);
  const args = [
    path.join(config.apDir, 'Generate.py'),
    '--player_files_path', path.join(multiworldDir(config, mw), 'Players'),
    '--outputpath', outputDir,
    '--log_level', 'warning',
    '--seed', String(seedNumber),
  ];
  const { stdout } = await runProcess(config, args, { env: apEnv(config, mw), game: mw });
  const files = fs.readdirSync(outputDir).filter((f) => f.endsWith('.zip'));
  if (files.length === 0) throw new Error(`Generation produced no .zip output.\n${stdout.slice(-2000)}`);
  files.sort();
  const zipFile = files[files.length - 1];
  const match = zipFile.match(/^AP_(\d+)\.zip$/);
  return {
    multidata: path.join(outputDir, zipFile),
    spoiler: path.join(outputDir, zipFile.replace(/\.zip$/, '_Spoiler.txt')),
    seed: match ? match[1] : zipFile,
    seedNumber,
    players: staged,
    log: stdout,
  };
}

const runningServers = new Map();

export function startMultiworld(config, db, mw, port) {
  ensureDirs(multiworldDir(config, mw));
  installApworlds(config, mw);
  if (!mw.multidata || !fs.existsSync(mw.multidata)) {
    throw new Error('Game has not been generated yet.');
  }
  const logFile = path.join(multiworldDir(config, mw), 'server.log');
  const logStream = fs.openSync(logFile, 'a');
  const args = [
    path.join(config.apDir, 'MultiServer.py'),
    mw.multidata,
    '--host', '0.0.0.0',
    '--port', String(port),
    '--auto_shutdown', '0',
    '--loglevel', 'info',
    '--release_mode', 'enabled', // lets the bridge send !release as the target slot
  ];
  if (mw.password) args.push('--password', mw.password);
  const child = spawn(config.apPython, args, {
    cwd: config.apDir,
    env: apEnv(config, mw),
    stdio: ['ignore', logStream, logStream],
    detached: false,
  });
  child.unref();
  runningServers.set(mw.name, child);
  return { pid: child.pid, logFile };
}

export function stopMultiworld(config, mw) {
  closeProbeDaemon(mw);
  const child = runningServers.get(mw.name);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    runningServers.delete(mw.name);
    return true;
  }
  if (mw.pid) {
    try { process.kill(mw.pid, 'SIGTERM'); return true; } catch { return false; }
  }
  return false;
}

// One long-lived probe process per mw, holding one websocket per player
// slot. Reusing the connections means the AP server sees a join/leave notice
// only when the daemon starts or a socket drops — not on every poll.
const probeDaemons = new Map(); // "name:port" -> daemon handle

export function closeProbeDaemon(mw) {
  const key = `${mw.name}:${mw.port}`;
  const d = probeDaemons.get(key);
  if (d) {
    try { d.proc.kill(); } catch { /* already dead */ }
    probeDaemons.delete(key);
  }
}

async function daemonRequest(config, mw, req, timeoutMs, knownSlots) {
  const key = `${mw.name}:${mw.port}`;
  let d = probeDaemons.get(key);
  if (!d || d.dead) {
    const args = [config.apProbeScript, '--daemon', '--host', '127.0.0.1', '--port', String(mw.port), '--ap-version', config.apVersion, '--timeout', '20'];
    if (mw.password) args.push('--password', mw.password);
    if (knownSlots.length) args.push('--slots', knownSlots.join(','));
    const proc = spawn(config.apPython, args, { env: { ...process.env, SKIP_REQUIREMENTS_UPDATE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    d = { proc, dead: false, buf: '', waiters: [] };
    proc.stdout.on('data', (chunk) => {
      d.buf += chunk.toString();
      let idx;
      while ((idx = d.buf.indexOf('\n')) >= 0) {
        const line = d.buf.slice(0, idx);
        d.buf = d.buf.slice(idx + 1);
        const w = d.waiters.shift();
        if (w) { try { w.resolve(JSON.parse(line)); } catch { w.resolve({ error: 'bad probe response' }); } }
      }
    });
    proc.stderr.on('data', (c) => console.error(`[probe:${mw.name}] ${String(c).trimEnd()}`));
    proc.on('exit', (code) => {
      d.dead = true;
      if (probeDaemons.get(key) === d) probeDaemons.delete(key);
      for (const w of d.waiters.splice(0)) w.resolve({ error: `probe daemon exited (${code})` });
    });
    probeDaemons.set(key, d);
  }
  return new Promise((resolve) => {
    const w = { resolve };
    d.waiters.push(w);
    try {
      d.proc.stdin.write(JSON.stringify(req) + '\n');
    } catch {
      d.proc.kill();
      resolve({ error: 'probe daemon not writable' });
      return;
    }
    setTimeout(() => {
      const i = d.waiters.indexOf(w);
      if (i >= 0) {
        d.waiters.splice(i, 1);
        d.proc.kill(); // stuck daemon; next request respawns it
        resolve({ error: 'probe request timed out' });
      }
    }, timeoutMs);
  });
}

export function isServerProcessAlive(mw) {
  if (!mw.pid) return false;
  try { process.kill(mw.pid, 0); return true; } catch { return false; }
}

export function isPortListening(port, host = '127.0.0.1', timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once('connect', () => { socket.end(); resolve(true); });
    socket.once('error', () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
  });
}

export async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.end(); resolve(true); });
      socket.once('error', () => resolve(false));
      setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
    });
    if (open) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// MultiServer logs every item send with a timestamp, e.g.:
// [MultiServer at 2026-01-02 03:04:05,678]: (Team #1) Alice sent Map Bombs to Bob (Tile 3)
// The wire protocol's ReceivedItems has no timestamps, so "when" comes from this log.
export function parseItemSendsText(text) {
  const sends = [];
  const re = /^\[[^\]]+ at ([^\]]+)\]: \(Team #\d+\) (.+) sent (.+) to (.+) \((.+)\)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    sends.push({ at: m[1], sender: m[2], item: m[3], receiver: m[4], location: m[5] });
  }
  return sends;
}

export function parseItemSends(logFile) {
  try {
    return parseItemSendsText(fs.readFileSync(logFile, 'utf8'));
  } catch {
    return [];
  }
}

export async function probe(config, mw, mode, slot, timeoutMs, knownSlots, onlySlots) {
  const slots = knownSlots || [];
  const req = { mode, slot: slot ?? null, only: onlySlots?.length ? onlySlots : null };
  const response = await daemonRequest(config, mw, req, timeoutMs, slots);
  if (response.error) throw new Error(response.error);
  return response;
}

// Sends a text command (e.g. "!release") as the given slot over the multiworld's
// persistent probe daemon. Used by /release.
export async function say(config, mw, slotName, text) {
  const req = { mode: 'say', name: slotName, text };
  const response = await daemonRequest(config, mw, req, 15000, [slotName]);
  if (response.error) throw new Error(response.error);
  return response;
}
