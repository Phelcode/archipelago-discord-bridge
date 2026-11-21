import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// Archipelago accepts seeds in [0, 10^20); we stay well inside safe-integer
// range. A random seed is always picked explicitly when none is given.
export function resolveSeed(seed) {
  if (seed !== undefined && seed !== null && seed !== '') return Number(seed);
  return crypto.randomInt(1, 2 ** 48);
}

export function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'game';
}

export function gameDir(config, game) {
  return path.join(config.dataDir, 'games', slugify(game.name));
}

function ensureDirs(dir) {
  fs.mkdirSync(path.join(dir, 'apworlds'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'Players'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'output'), { recursive: true });
}

function apEnv(config, game) {
  return {
    ...process.env,
    SKIP_REQUIREMENTS_UPDATE: '1',
    XDG_DATA_HOME: path.join(config.dataDir, 'xdg', slugify(game.name)),
  };
}

function runProcess(config, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.apPython, args, {
      cwd: config.apDir,
      env: options.env || apEnv(config, options.game || { name: 'default' }),
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

// .apworld files are global: uploaded once, they are installed into every
// game's world directory at generation time.
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
export function installApworlds(config, game) {
  const srcDir = apworldDir(config);
  const files = listApworlds(config);
  const targets = [
    path.join(config.apDir, 'custom_worlds'),
    path.join(config.dataDir, 'xdg', slugify(game.name), 'Archipelago', 'worlds'),
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

export function stagePlayers(config, db, game) {
  const playersDir = path.join(gameDir(config, game), 'Players');
  fs.rmSync(playersDir, { recursive: true, force: true });
  fs.mkdirSync(playersDir, { recursive: true });
  const staged = [];
  for (const userId of game.playerIds) {
    const player = db.getPlayer(userId);
    if (!player) continue;
    const src = path.join(config.dataDir, 'players', `${userId}.yaml`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(playersDir, `${player.slot}.yaml`);
    fs.copyFileSync(src, dest);
    staged.push(player.slot);
  }
  return staged;
}

export async function generateGame(config, db, game, seed) {
  ensureDirs(gameDir(config, game));
  installApworlds(config, game);
  const staged = stagePlayers(config, db, game);
  if (staged.length === 0) {
    throw new Error('No players joined this game yet. Players must /register and /join first.');
  }
  const outputDir = path.join(gameDir(config, game), 'output');
  const seedNumber = resolveSeed(seed);
  const args = [
    path.join(config.apDir, 'Generate.py'),
    '--player_files_path', path.join(gameDir(config, game), 'Players'),
    '--outputpath', outputDir,
    '--log_level', 'warning',
    '--seed', String(seedNumber),
  ];
  const { stdout } = await runProcess(config, args, { env: apEnv(config, game), game });
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

export function startGame(config, db, game, port) {
  ensureDirs(gameDir(config, game));
  installApworlds(config, game);
  if (!game.multidata || !fs.existsSync(game.multidata)) {
    throw new Error('Game has not been generated yet.');
  }
  const logFile = path.join(gameDir(config, game), 'server.log');
  const logStream = fs.openSync(logFile, 'a');
  const args = [
    path.join(config.apDir, 'MultiServer.py'),
    game.multidata,
    '--host', '0.0.0.0',
    '--port', String(port),
    '--auto_shutdown', '0',
    '--loglevel', 'info',
  ];
  if (game.password) args.push('--password', game.password);
  const child = spawn(config.apPython, args, {
    cwd: config.apDir,
    env: apEnv(config, game),
    stdio: ['ignore', logStream, logStream],
    detached: false,
  });
  child.unref();
  runningServers.set(game.name, child);
  return { pid: child.pid, logFile };
}

export function stopGame(config, game) {
  const child = runningServers.get(game.name);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    runningServers.delete(game.name);
    return true;
  }
  if (game.pid) {
    try { process.kill(game.pid, 'SIGTERM'); return true; } catch { return false; }
  }
  return false;
}

export function isServerProcessAlive(game) {
  if (!game.pid) return false;
  try { process.kill(game.pid, 0); return true; } catch { return false; }
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
export function parseItemSends(logFile) {
  let text;
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch {
    return [];
  }
  const sends = [];
  const re = /^\[[^\]]+ at ([^\]]+)\]: \(Team #\d+\) (.+) sent (.+) to (.+) \((.+)\)$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    sends.push({ at: m[1], sender: m[2], item: m[3], receiver: m[4], location: m[5] });
  }
  return sends;
}

export async function probe(config, game, mode, slot, timeoutMs, knownSlots, onlySlots) {
  const slots = knownSlots || [];
  const args = [
    config.apProbeScript,
    '--host', '127.0.0.1',
    '--port', String(game.port),
    '--mode', mode,
    '--ap-version', config.apVersion,
    '--timeout', String(Math.ceil(timeoutMs / 1000)),
  ];
  if (game.password) args.push('--password', game.password);
  if (slots.length) args.push('--slots', slots.join(','));
  if (onlySlots && onlySlots.length) args.push('--only', onlySlots.join(','));
  if (slot !== null && slot !== undefined) args.push('--slot', String(slot));
  const { stdout } = await runProcess(config, args, {
    env: { ...process.env, SKIP_REQUIREMENTS_UPDATE: '1' },
    game,
    timeoutMs,
  });
  return JSON.parse(stdout);
}
