import http from 'node:http';
import path from 'node:path';
import { Events } from 'discord.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { createDiscordClient } from './discord/client.js';
import { registerAllCommands, COMMAND_DEFINITIONS } from './discord/commands.js';

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

async function main() {
  const config = loadConfig();
  const db = new Store(path.join(config.dataDir, 'db.json'));
  for (const game of db.listGames()) {
    if (game.status === 'running' || game.status === 'generating') {
      game.status = 'stopped';
      db.setGame(game.name, game);
    }
  }
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
