import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Events } from 'discord.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createDiscordClient } from './discord/client.js';
import { registerAllCommands, COMMAND_DEFINITIONS } from './discord/commands.js';
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

// On boot, games that were running when the container stopped are restarted:
// their Archipelago server is spawned again (reusing the existing multiworld)
// on their old port or the next free one. Games stuck in 'generating', or
// running without a multiworld, are marked stopped.
export async function restartRunningGames(config, db, apImpl = ap) {
  for (const game of db.listGames()) {
    if (game.status === 'generating') {
      game.status = 'stopped';
      db.setGame(game.name, game);
    }
  }
  const running = db.listGames().filter((g) => g.status === 'running');
  for (const game of running) {
    if (!game.multidata || !fs.existsSync(game.multidata)) {
      game.status = 'stopped';
      db.setGame(game.name, game);
      console.warn(`[boot] game "${game.name}" was running but has no generated multiworld; marked stopped`);
      continue;
    }
    const used = new Set(db.listGames().filter((g) => g.name !== game.name && g.port).map((g) => g.port));
    let port = game.port && !used.has(game.port) ? game.port : config.basePort;
    while (used.has(port) || (await apImpl.isPortListening(port))) port += 1;
    try {
      const { pid, logFile } = apImpl.startGame(config, db, game, port);
      const up = await apImpl.waitForPort(port, 15000);
      if (!up) throw new Error(`server did not come up on port ${port} (see ${logFile})`);
      game.port = port;
      game.pid = pid;
      game.startedAt = new Date().toISOString();
      db.setGame(game.name, game);
      console.log(`[boot] restarted running game "${game.name}" on ${config.publicHost}:${port}`);
    } catch (err) {
      try { apImpl.stopGame(config, game); } catch { /* already dead */ }
      game.status = 'stopped';
      db.setGame(game.name, game);
      console.error(`[boot] failed to restart game "${game.name}": ${err.message}`);
    }
  }
}

async function main() {
  const config = loadConfig();
  const db = new Store(path.join(config.dataDir, 'db.json'));
  await restartRunningGames(config, db);
  const client = createDiscordClient({ config, db });
  client.once(Events.ClientReady, async (readyClient) => {
    try {
      await registerAllCommands(readyClient, { guildId: config.discordGuildId, definitions: COMMAND_DEFINITIONS });
      console.log(`Registered ${COMMAND_DEFINITIONS.length} slash commands with Discord (guild + user install).`);
    } catch (err) {
      console.error('Could not register slash commands with Discord (set installation contexts and commands in the dev portal if needed):', err.message);
    }
  });
  createHealthServer(config);
  await client.login(config.discordToken);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
