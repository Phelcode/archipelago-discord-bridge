import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { verifySignature, isFreshTimestamp } from './discord/verify.js';
import { createDiscordApi } from './discord/api.js';
import { PERMISSIONS, EPHEMERAL_COMMANDS, COMMAND_DEFINITIONS, parseInteraction, handleCommand, UserError } from './discord/commands.js';
import { canHost, isOwner } from './discord/permissions.js';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

export function chunkContent(text, max = 1900) {
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length) chunks.push(rest);
  return chunks;
}

export function createApp({ config, db, api }) {
  async function processInteraction(interaction) {
    const token = interaction.token;
    const userId = interaction.member?.user?.id || interaction.user?.id;
    const userName = interaction.member?.user?.username || interaction.user?.username || userId;
    const { options, attachments, subcommand, subOptions } = parseInteraction(interaction);
    const ctx = { config, db, api, userId, userName, options, attachments, subcommand, subOptions };
    try {
      const content = await handleCommand(interaction.data.name, ctx);
      const chunks = chunkContent(String(content));
      await api.editOriginal(token, { content: chunks[0] });
      for (const chunk of chunks.slice(1)) {
        await api.followup(token, { content: chunk });
      }
    } catch (err) {
      if (err instanceof UserError) {
        await api.editOriginal(token, { content: `❌ ${err.message}` });
      } else {
        console.error(`Error handling /${interaction.data.name}:`, err);
        await api.editOriginal(token, { content: `❌ Something went wrong: ${err.message}` }).catch(() => {});
      }
    }
  }

  async function handleInteractions(req, res) {
    const raw = await readBody(req);
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    if (!verifySignature(config.discordPublicKey, signature, timestamp, raw.toString('utf8')) ||
        !isFreshTimestamp(timestamp)) {
      sendJson(res, 401, { error: 'invalid signature' });
      return;
    }
    let interaction;
    try {
      interaction = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { error: 'invalid json' });
      return;
    }
    if (interaction.type === 1) {
      sendJson(res, 200, { type: 1 });
      return;
    }
    if (interaction.type !== 2) {
      sendJson(res, 400, { error: 'unsupported interaction type' });
      return;
    }
    if (config.discordGuildId && interaction.guild_id !== config.discordGuildId) {
      sendJson(res, 403, { error: 'wrong guild' });
      return;
    }
    const name = interaction.data?.name;
    const perm = PERMISSIONS[name] || 'all';
    const userId = interaction.member?.user?.id || interaction.user?.id;
    if (perm === 'owner' && !isOwner(config, userId)) {
      sendJson(res, 200, { type: 4, data: { flags: 64, content: '❌ Only the owner can use this command.' } });
      return;
    }
    if (perm === 'host' && !canHost(db, config, userId)) {
      sendJson(res, 200, { type: 4, data: { flags: 64, content: '❌ Only hosts (or the owner) can use this command.' } });
      return;
    }
    const ephemeral = EPHEMERAL_COMMANDS.has(name);
    sendJson(res, 200, { type: 5, data: ephemeral ? { flags: 64 } : {} });
    processInteraction(interaction).catch((err) => console.error('Interaction processing failed:', err));
  }

  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/interactions') {
      handleInteractions(req, res).catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
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
  const api = createDiscordApi({
    token: config.discordToken,
    applicationId: config.discordApplicationId,
    apiBase: config.discordApiBase,
  });
  const app = createApp({ config, db, api });
  app.listen(config.port, () => {
    console.log(`archipelago-discord-bridge listening on port ${config.port} (data dir: ${config.dataDir})`);
  });
  try {
    await api.registerCommands(COMMAND_DEFINITIONS);
    console.log(`Registered ${COMMAND_DEFINITIONS.length} slash commands with Discord.`);
  } catch (err) {
    console.error('Could not register slash commands (interactions endpoint still works if commands were registered before):', err.message);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
