import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Events } from 'discord.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createDiscordClient } from './discord/client.js';
import { scheduleCommandRegistration, COMMAND_DEFINITIONS } from './discord/commands.js';
import { startWatcher } from './watcher.js';
import * as ap from './ap/manager.js';

function createHealthServer(config) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.listen(config.port, () => {
    console.log(`archipelago-discord-bridge health endpoint on port ${config.port} (data dir: ${config.dataDir})`);
  });
  return server;
}

// On boot, multiworlds marked running are restarted:
// their Archipelago server is spawned again (reusing the existing multiworld)
// on their old port or the next free one. Games stuck in 'generating', or
// running without a multiworld, are marked stopped.
export async function restartRunningMultiworlds(config, db, apImpl = ap) {
  for (const mw of db.listMultiworlds()) {
    if (mw.status === 'generating') {
      mw.status = 'stopped';
      db.setMultiworld(mw.name, mw);
    }
  }
  const running = db.listMultiworlds().filter((g) => g.status === 'running');
  for (const mw of running) {
    if (!mw.multidata || !fs.existsSync(mw.multidata)) {
      mw.status = 'stopped';
      db.setMultiworld(mw.name, mw);
      console.warn(`[boot] multiworld "${mw.name}" is marked running but has no generated multiworld; marked stopped`);
      continue;
    }
    const used = new Set(db.listMultiworlds().filter((g) => g.name !== mw.name && g.port).map((g) => g.port));
    let port = mw.port && !used.has(mw.port) ? mw.port : config.basePort;
    while (used.has(port) || (await apImpl.isPortListening(port))) port += 1;
    try {
      const { pid, logFile } = apImpl.startMultiworld(config, db, mw, port);
      const up = await apImpl.waitForPort(port, 15000);
      if (!up) {
        const tail = ap.logTail(logFile);
        throw new Error(`server did not come up on port ${port} (see ${logFile})${tail ? `: ${tail}` : ''}`);
      }
      mw.port = port;
      mw.pid = pid;
      mw.startedAt = new Date().toISOString();
      db.setMultiworld(mw.name, mw);
      console.log(`[boot] restarted running multiworld "${mw.name}" on ${config.publicHost}:${port}`);
    } catch (err) {
      try { apImpl.stopMultiworld(config, mw); } catch { /* already dead */ }
      mw.status = 'stopped';
      db.setMultiworld(mw.name, mw);
      console.error(`[boot] failed to restart multiworld "${mw.name}": ${err.message}`);
    }
  }
}

async function main() {
  const config = loadConfig();
  try {
    if (await ap.ensureApRequirements(config)) {
      console.log('[boot] Archipelago venv synced with docker/requirements-ap.txt');
    }
  } catch (err) {
    console.error(`[boot] failed to sync Archipelago venv with docker/requirements-ap.txt: ${err.message}`);
  }
  const db = new Store(path.join(config.dataDir, 'db.json'));
  await restartRunningMultiworlds(config, db);
  const client = createDiscordClient({ config, db });
  client.once(Events.ClientReady, (readyClient) => {
    scheduleCommandRegistration(readyClient, config, { guildIds: config.discordGuildIds, definitions: COMMAND_DEFINITIONS });
  });
  createHealthServer(config);
  await client.login(config.discordToken);
  startWatcher(config, db, ap, (userId, text) => client.users.send(userId, text), config.watchIntervalMs);
  console.log(`[watch] polling running games every ${config.watchIntervalMs}ms for blocked-player item DMs`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
