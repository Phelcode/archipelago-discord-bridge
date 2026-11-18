import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { verifySignature, isFreshTimestamp } from './discord/verify.js';
import { createDiscordApi } from './discord/api.js';
import { startGateway } from './discord/gateway.js';
import { PERMISSIONS, EPHEMERAL_COMMANDS, COMMAND_DEFINITIONS, MODAL_PERMISSIONS, MODAL_REGISTER, ALWAYS_MODAL, parseInteraction, handleCommand, handleModal, registerAllCommands, UserError } from './discord/commands.js';
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

export async function processInteraction(interaction, { config, db, api }, produce) {
  const token = interaction.token;
  const userId = interaction.member?.user?.id || interaction.user?.id;
  const userName = interaction.member?.user?.username || interaction.user?.username || userId;
  const parsed = parseInteraction(interaction);
  const ctx = { config, db, api, userId, userName, ...parsed };
  try {
    const content = await produce(ctx);
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

// Returns the initial interaction response object (PONG, ephemeral denial, or
// deferred reply). After a deferred reply, the actual answer is sent via the
// followup webhook in processInteraction. Used by both the HTTP endpoint and
// the gateway transport.
export function createDispatcher({ config, db, api }) {
  return async function dispatch(interaction) {
    if (interaction.type === 1) return { type: 1 };
    if (interaction.type !== 2 && interaction.type !== 3) return null;
    // When DISCORD_GUILD_ID is set, only interactions from that guild are
    // accepted; user-installed (DM / private channel) interactions have no
    // guild_id and are rejected in that case.
    if (config.discordGuildId && interaction.guild_id !== config.discordGuildId) {
      return { type: 4, data: { flags: 64, content: '❌ This app is restricted to a specific server.' } };
    }
    const userId = interaction.member?.user?.id || interaction.user?.id;
    const parsed = parseInteraction(interaction);

    if (interaction.type === 3) {
      // MODAL_SUBMIT
      const customId = parsed.modalCustomId;
      if (!MODAL_PERMISSIONS[customId]) {
        return { type: 4, data: { flags: 64, content: '❌ Unknown form.' } };
      }
      const perm = MODAL_PERMISSIONS[customId];
      if (perm === 'owner' && !isOwner(config, userId)) {
        return { type: 4, data: { flags: 64, content: '❌ Only the owner can use this form.' } };
      }
      if (perm === 'host' && !canHost(db, config, userId)) {
        return { type: 4, data: { flags: 64, content: '❌ Only hosts (or the owner) can use this form.' } };
      }
      const ephemeral = customId === MODAL_REGISTER;
      processInteraction(interaction, { config, db, api }, (ctx) => handleModal(customId, ctx))
        .catch((err) => console.error('Modal processing failed:', err));
      return { type: 5, data: ephemeral ? { flags: 64 } : {} };
    }

    const name = interaction.data?.name;
    const perm = PERMISSIONS[name] || 'all';
    if (perm === 'owner' && !isOwner(config, userId)) {
      return { type: 4, data: { flags: 64, content: '❌ Only the owner can use this command.' } };
    }
    if (perm === 'host' && !canHost(db, config, userId)) {
      return { type: 4, data: { flags: 64, content: '❌ Only hosts (or the owner) can use this command.' } };
    }
    // These commands always answer with a modal (file upload / form fields).
    if (ALWAYS_MODAL[name]) return ALWAYS_MODAL[name]();
    const ephemeral = EPHEMERAL_COMMANDS.has(name);
    processInteraction(interaction, { config, db, api }, (ctx) => handleCommand(name, ctx))
      .catch((err) => console.error('Interaction processing failed:', err));
    return { type: 5, data: ephemeral ? { flags: 64 } : {} };
  };
}

export function createApp({ config, db, api, dispatch }) {
  async function handleInteractions(req, res) {
    const raw = await readBody(req);
    if (!config.discordPublicKey ||
        !verifySignature(config.discordPublicKey, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], raw.toString('utf8')) ||
        !isFreshTimestamp(req.headers['x-signature-timestamp'])) {
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
    const response = await dispatch(interaction);
    if (response === null) {
      sendJson(res, 400, { error: 'unsupported interaction type' });
      return;
    }
    sendJson(res, 200, response);
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
  const dispatch = createDispatcher({ config, db, api });
  const app = createApp({ config, db, api, dispatch });
  app.listen(config.port, () => {
    console.log(`archipelago-discord-bridge listening on port ${config.port} (data dir: ${config.dataDir})`);
  });
  try {
    await registerAllCommands(api, { guildId: config.discordGuildId, definitions: COMMAND_DEFINITIONS });
    console.log(`Registered ${COMMAND_DEFINITIONS.length} slash commands with Discord (guild + user install).`);
  } catch (err) {
    console.error('Could not register slash commands with Discord (set installation contexts and commands in the dev portal if needed):', err.message);
  }
  if (config.useGateway) {
    startGateway({
      token: config.discordToken,
      intents: config.gatewayIntents,
      url: config.gatewayUrl,
      onInteraction: async (interaction) => {
        try {
          const response = await dispatch(interaction);
          if (response) await api.respondToInteraction(interaction.id, interaction.token, response);
        } catch (err) {
          console.error('[gateway] failed to send initial interaction response:', err.message);
        }
      },
    });
    console.log('Gateway mode: receiving interactions over the Discord gateway (no public URL needed).');
  } else {
    console.log('HTTP endpoint mode: receiving interactions at POST /interactions (requires a public HTTPS URL in the dev portal).');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
