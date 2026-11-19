import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ModalBuilder, LabelBuilder, FileUploadBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { roleOf, canHost, isOwner } from './permissions.js';
import * as ap from '../ap/manager.js';

export class UserError extends Error {}

const STRING = 3;
const INTEGER = 4;
const USER = 6;

const gameOption = (required) => ({
  name: 'game', description: 'Game session name', type: STRING, required,
});

export const COMMAND_DEFINITIONS = [
  { name: 'commands', description: 'List all commands with a one-line summary' },
  { name: 'help', description: 'Step-by-step intro for your role (owner/host/player/spectator)' },
  { name: 'register', description: 'Register as a player (opens an upload form for your player yaml)', options: [] },
  { name: 'unregister', description: 'Remove your player registration' },
  {
    name: 'profile',
    description: 'Show your role/registration and choose who can see replies to your commands',
    options: [
      {
        name: 'responses',
        description: 'Who can see replies to your commands',
        type: STRING,
        required: false,
        choices: [
          { name: 'private — only I see the replies', value: 'private' },
          { name: 'public — everyone sees the replies (default)', value: 'public' },
        ],
      },
    ],
  },
  { name: 'join', description: 'Join a game session with your registered player yaml', options: [gameOption(true)] },
  { name: 'leave', description: 'Leave a game session', options: [gameOption(true)] },
  { name: 'players', description: 'List registered players (and players of a game)', options: [gameOption(false)] },
  { name: 'setup-game', description: '[host] Create a new game session (opens a form)', options: [] },
  { name: 'upload-apworld', description: '[host] Upload a custom .apworld file (usable in every game; opens an upload form)', options: [] },
  {
    name: 'start',
    description: '[host] Generate the multiworld if needed, then start the Archipelago server',
    options: [gameOption(true), { name: 'port', description: 'Port to listen on (optional)', type: INTEGER, required: false }],
  },
  { name: 'stop', description: '[host] Stop the Archipelago server for a game', options: [gameOption(true)] },
  { name: 'delete-game', description: '[host] Delete a game session and its files', options: [gameOption(true)] },
  {
    name: 'status',
    description: 'Show game sessions and server status (active games by default)',
    options: [
      gameOption(false),
      {
        name: 'scope', description: 'Which games to list', type: STRING, required: false,
        choices: [
          { name: 'active — started or waiting to be started (default)', value: 'active' },
          { name: 'finished — stopped games', value: 'finished' },
          { name: 'all — every game', value: 'all' },
        ],
      },
    ],
  },
  { name: 'stats', description: 'Per-player stats: checks found / total and completion status', options: [gameOption(false)] },
  { name: 'game-stats', description: 'Gamewide stats: total checks, found, hints, seed', options: [gameOption(false)] },
  { name: 'hints', description: 'Show your hints (if hints are enabled)', options: [gameOption(false)] },
  {
    name: 'received',
    description: 'Items sent to you in a game (what was unlocked for you, by whom, when)',
    options: [
      gameOption(false),
      {
        name: 'scope', description: 'Which items to show', type: STRING, required: false,
        choices: [
          { name: 'new — since you last ran /received (default)', value: 'new' },
          { name: 'all — everything received so far', value: 'all' },
        ],
      },
    ],
  },
  { name: 'block', description: 'Mark yourself blocked — you get a DM when someone sends you an item' },
  { name: 'unblock', description: 'Mark yourself unblocked (default; no DMs for incoming items)' },
  {
    name: 'role',
    description: '[owner] Manage roles',
    options: [
      {
        name: 'add', description: 'Assign a role to a user', type: 1,
        options: [
          { name: 'user', description: 'The Discord user', type: USER, required: true },
          { name: 'role', description: 'The role to assign', type: STRING, required: true, choices: [{ name: 'host', value: 'host' }] },
        ],
      },
      {
        name: 'remove', description: 'Remove a role from a user', type: 1,
        options: [
          { name: 'user', description: 'The Discord user', type: USER, required: true },
          { name: 'role', description: 'The role to remove', type: STRING, required: true, choices: [{ name: 'host', value: 'host' }] },
        ],
      },
      { name: 'list', description: 'List role assignments', type: 1, options: [] },
    ],
  },
];

// Installation contexts (where the app can be installed) and interaction
// contexts (surfaces where commands can be used). GUILD_INSTALL=0,
// USER_INSTALL=1; GUILD=0, BOT_DM=1, PRIVATE_CHANNEL=2.
export const INTEGRATION_TYPES_BOTH = [0, 1];
export const CONTEXTS_ALL = [0, 1, 2];

export function globalCommandPayload(definitions) {
  return definitions.map((def) => ({
    ...def,
    integration_types: INTEGRATION_TYPES_BOTH,
    contexts: CONTEXTS_ALL,
  }));
}

export function guildCommandPayload(definitions) {
  return definitions.map((def) => ({ ...def, integration_types: [0], contexts: [0] }));
}

const API_BASE = 'https://discord.com/api/v10';

class RateLimitError extends Error {
  constructor(retryAfterMs) {
    super(`rate limited, retry_after ${Math.round(retryAfterMs / 1000)}s`);
    this.retryAfterMs = retryAfterMs;
  }
}

// Registration uses plain fetch with an explicit timeout instead of the
// discord.js REST queue: the library silently waits out rate limits and
// retries aborted requests (15s x 4) with no log output, which made a stuck
// registration indistinguishable from a working one. Here every step is
// logged and bounded. Short 429s are waited out inline; long ones (bulk
// command PUTs can be limited for minutes) throw RateLimitError so the
// scheduler retries later instead of blocking.
async function apiFetch(config, method, path, body, timeoutMs = 10000, maxInline429Ms = 30000) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${config.discordToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    const waitMs = Math.max(0, (data.retry_after ?? 1)) * 1000;
    if (waitMs > maxInline429Ms) throw new RateLimitError(waitMs);
    console.warn(`[commands] 429 on ${method} ${path}, waiting ${waitMs}ms as Discord asks`);
    await new Promise((r) => setTimeout(r, waitMs));
    return apiFetch(config, method, path, body, timeoutMs, maxInline429Ms);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Discord API ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Compare only the fields we control; API responses carry extra metadata
// (id, version, localizations, ...) that must not trigger a re-PUT.
function canonicalOption(opt) {
  const c = { name: opt.name, description: opt.description, type: opt.type, required: Boolean(opt.required) };
  if (opt.choices) c.choices = opt.choices.map((ch) => ({ name: ch.name, value: ch.value }));
  if (opt.options) c.options = opt.options.map(canonicalOption);
  return c;
}

function canonicalCommand(def) {
  return {
    name: def.name,
    description: def.description,
    type: def.type ?? 1,
    options: (def.options || []).map(canonicalOption),
    integration_types: def.integration_types ?? [0],
    contexts: def.contexts ?? [0, 1, 2],
  };
}

function sameCommands(existing, desired) {
  if (!Array.isArray(existing) || existing.length !== desired.length) return false;
  const sort = (list) => [...list].map(canonicalCommand).sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify(sort(existing)) === JSON.stringify(sort(desired));
}

// PUT commands replaces the whole list server-side (clears stale + registers
// current, atomically), but bulk-overwriting application commands is heavily
// rate-limited by Discord — so only PUT when the registered set differs.
async function putCommandsIfChanged(config, path, payload, label, maxInline429Ms) {
  let current = null;
  try {
    current = await apiFetch(config, 'GET', path, undefined, 10000, maxInline429Ms);
  } catch (err) {
    console.warn(`[commands] could not read current ${label} commands (${err.message}); re-registering`);
  }
  if (current !== null && sameCommands(current, payload)) {
    console.log(`[commands] ${label} commands already up to date (${payload.length}), skipping PUT`);
    return;
  }
  await apiFetch(config, 'PUT', path, payload, 10000, maxInline429Ms);
  console.log(`[commands] registered ${payload.length} ${label} commands.`);
}

export async function registerAllCommands(config, { guildIds = [], definitions, retryDelayMs = 5000, maxInline429Ms = 30000 }) {
  try {
    await apiFetch(config, 'PATCH', '/applications/@me', { integration_types: INTEGRATION_TYPES_BOTH });
    console.log('[commands] integration types set to guild + user install');
  } catch (err) {
    console.warn(`[commands] could not set integration_types (${err.message}); enable Guild + User install in the dev portal if needed.`);
  }
  const globalPayload = globalCommandPayload(definitions);
  const globalPath = `/applications/${config.discordApplicationId}/commands`;
  console.log(`[commands] checking/registering ${definitions.length} global commands...`);
  try {
    await putCommandsIfChanged(config, globalPath, globalPayload, 'global', maxInline429Ms);
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.warn(`[commands] global command PUT ${err.message}; scheduler will wait out the cooldown`);
      throw err;
    }
    console.warn(`[commands] global registration failed (${err.message}); retrying once in ${retryDelayMs}ms...`);
    await new Promise((r) => setTimeout(r, retryDelayMs));
    await putCommandsIfChanged(config, globalPath, globalPayload, 'global', maxInline429Ms); // throws if still failing
  }
  for (const guildId of guildIds) {
    const guildPath = `/applications/${config.discordApplicationId}/guilds/${guildId}/commands`;
    try {
      await putCommandsIfChanged(config, guildPath, guildCommandPayload(definitions), `guild ${guildId}`, maxInline429Ms);
    } catch (err) {
      // Typically 403 Missing Access when the app isn't in that guild with the
      // bot + applications.commands scopes. Global commands still apply.
      console.warn(`[commands] guild registration in ${guildId} failed (${err.message}); add the app to that guild with the bot + applications.commands scopes for instant guild commands. Global commands still apply.`);
    }
  }
}

// Registers commands when called (on client ready) and retries every
// intervalMs until it succeeds, so a transient failure can't leave the app
// without slash commands. Returns a stop function.
// Delay before the next registration attempt. After a 429 cooldown we wait
// until the first interval tick AFTER the cooldown ends — retrying exactly at
// retry_after often still 429s, because Discord's rate-limit windows reset on
// coarse wall-clock boundaries, not precisely at retry_after.
export function nextRetryDelay(notBefore, now, intervalMs) {
  const remaining = notBefore - now;
  return remaining > 0 ? Math.max(intervalMs, Math.ceil(remaining / intervalMs) * intervalMs) : intervalMs;
}

export function scheduleCommandRegistration(config, opts, { intervalMs = 60000 } = {}) {
  let stopped = false;
  let timer = null;
  let notBefore = 0; // earliest next attempt; set from 429 retry_after so we never hammer a rate-limited route
  const attempt = async () => {
    try {
      await registerAllCommands(config, opts);
      return true;
    } catch (err) {
      if (err instanceof RateLimitError) {
        notBefore = Date.now() + err.retryAfterMs;
        console.error(`[commands] registration ${err.message}; next attempt no earlier than ${new Date(notBefore).toISOString()}`);
      } else {
        console.error('[commands] registration failed:', err.message);
      }
      return false;
    }
  };
  // Own unref'd timer chain — a long cooldown never delays any other timer.
  const loop = async () => {
    if (stopped) return;
    const ok = await attempt();
    if (ok || stopped) return;
    timer = setTimeout(loop, nextRetryDelay(notBefore, Date.now(), intervalMs));
    if (timer.unref) timer.unref();
  };
  console.log('[commands] registering slash commands...');
  loop();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export const PERMISSIONS = {
  commands: 'all',
  help: 'all',
  register: 'all',
  unregister: 'all',
  profile: 'all',
  join: 'all',
  leave: 'all',
  players: 'all',
  'setup-game': 'host',
  'upload-apworld': 'host',
  start: 'host',
  stop: 'host',
  'delete-game': 'host',
  role: 'owner',
  status: 'all',
  stats: 'all',
  'game-stats': 'all',
  hints: 'all',
  received: 'all',
  block: 'all',
  unblock: 'all',
};

export const EPHEMERAL_COMMANDS = new Set(['register', 'unregister', 'profile', 'hints', 'role', 'received', 'block', 'unblock']);

// Modals (components v2: File Upload type 19 / Text Input type 4 inside a Label).
export const MODAL_REGISTER = 'bridge_register';
export const MODAL_UPLOAD_APWORLD = 'bridge_upload_apworld';
export const MODAL_SETUP_GAME = 'bridge_setup_game';
export const MODAL_PERMISSIONS = {
  [MODAL_REGISTER]: 'all',
  [MODAL_UPLOAD_APWORLD]: 'host',
  [MODAL_SETUP_GAME]: 'host',
};

const fileUploadField = (customId, labelText) =>
  new LabelBuilder()
    .setLabel(labelText)
    .setDescription('Upload the file here')
    .setFileUploadComponent(new FileUploadBuilder().setCustomId(customId).setMinValues(1).setMaxValues(1).setRequired(true));
const textField = (customId, labelText, { required = true, maxLength = 100 } = {}) =>
  new LabelBuilder()
    .setLabel(labelText)
    .setTextInputComponent(new TextInputBuilder().setCustomId(customId).setStyle(TextInputStyle.Short).setRequired(required).setMaxLength(maxLength));

export function registerModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_REGISTER)
    .setTitle('Register as player')
    .addLabelComponents(
      fileUploadField('yaml', 'Player yaml file (.yaml)'),
      textField('name', 'Slot name override (optional)', { required: false }),
    );
}

export function uploadApworldModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_UPLOAD_APWORLD)
    .setTitle('Upload .apworld')
    .addLabelComponents(
      fileUploadField('file', '.apworld file (available to all games)'),
    );
}

export function setupGameModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_SETUP_GAME)
    .setTitle('Create game session')
    .addLabelComponents(
      textField('name', 'Game session name'),
      textField('password', 'Server password (optional)', { required: false }),
      textField('seed', 'Seed (optional, random if empty)', { required: false, maxLength: 20 }),
    );
}

// Commands that always answer with a modal instead of taking inline options.
export const ALWAYS_MODAL = {
  register: registerModal,
  'upload-apworld': uploadApworldModal,
  'setup-game': setupGameModal,
};

const STATUS_NAMES = { 0: 'offline', 5: 'connected', 10: 'ready', 20: 'playing', 30: 'goal reached' };

const COMMAND_SUMMARIES = {
  commands: 'List all commands with a one-line summary',
  help: 'Step-by-step intro for your role',
  register: 'Register as a player (upload your .yaml in the form)',
  unregister: 'Remove your player registration',
  profile: 'Your role/registration; set private or public replies',
  join: 'Join a game session with your registered yaml',
  leave: 'Leave a game session',
  players: 'List registered players (🔒 = blocked), or players of one game',
  'setup-game': '[host] Create a game session (opens a form)',
  'upload-apworld': '[host] Upload a .apworld (usable in every game; opens a form)',
  start: '[host] Generate the multiworld if needed, then start the server',
  stop: '[host] Stop the server',
  'delete-game': '[host] Delete a game session and its files',
  status: 'Game sessions and server status (active by default; scope: finished|all)',
  stats: 'Per-player checks found/total and completion status',
  'game-stats': 'Gamewide totals: checks, hints, seed',
  hints: 'Your hints (if hints are enabled)',
  received: 'Items sent to you (what/who/when) — new since last check by default, scope: all for the full list',
  block: 'Mark yourself blocked — get a DM when someone sends you an item',
  unblock: 'Mark yourself unblocked (default)',
  role: '[owner] Assign or remove host roles',
};

// "Active" games are started (running) or waiting to be started (set up /
// generating / generated). "Finished" games are stopped.
const ACTIVE_STATUSES = new Set(['setup', 'generating', 'generated', 'running']);

function formatGameLine(ctx, g) {
  const alive = g.status === 'running' && ctx.ap.isServerProcessAlive(g);
  const players = (g.playerIds || []).map((id) => ctx.db.getPlayer(id)?.slot || id).join(', ') || 'none';
  return [
    `**${g.name}** — status: ${alive ? 'running' : g.status}${alive && g.port ? ` on ${ctx.config.publicHost}:${g.port}` : ''}`,
    `  players: ${players} | seed: ${g.seed ?? 'not generated'}`,
  ].join('\n');
}

export function statusName(status) {
  return STATUS_NAMES[status] ?? `status ${status}`;
}

function resolveGame(ctx, name) {
  const db = ctx.db;
  const games = db.listGames();
  if (name) {
    const game = db.getGame(ctx.ap.slugify(name));
    if (!game) {
      throw new UserError(`Unknown game "${name}".${games.length ? ` Known games: ${games.map((g) => g.name).join(', ')}` : ''}`);
    }
    return game;
  }
  const running = games.filter((g) => g.status === 'running');
  if (running.length === 1) return running[0];
  if (running.length > 1) throw new UserError(`Multiple games are running; specify one: ${running.map((g) => g.name).join(', ')}`);
  if (games.length === 1) return games[0];
  if (games.length === 0) throw new UserError('No games have been set up yet. A host can create one with /setup-game.');
  return games[games.length - 1];
}

// Generates the multiworld if the game doesn't have one yet (called by
// /start). Returns the generation result when a generation ran, null when an
// existing multiworld was reused (kept across restarts, so the seed is stable).
async function ensureGenerated(ctx, game) {
  if (game.multidata && fs.existsSync(game.multidata)) return null;
  let seed = game.requestedSeed;
  if (seed !== undefined && seed !== null && String(seed).trim() !== '') {
    seed = Number(seed);
    if (!Number.isInteger(seed)) throw new UserError('Seed must be an integer.');
  }
  const prevStatus = game.status === 'generating' ? 'setup' : game.status;
  game.status = 'generating';
  ctx.db.setGame(game.name, game);
  let result;
  try {
    result = await ctx.ap.generateGame(ctx.config, ctx.db, game, seed);
  } catch (err) {
    game.status = prevStatus;
    ctx.db.setGame(game.name, game);
    throw err;
  }
  game.status = 'generated';
  game.multidata = result.multidata;
  game.spoiler = result.spoiler;
  game.seed = result.seed;
  game.seedNumber = result.seedNumber;
  game.generatedAt = new Date().toISOString();
  ctx.db.setGame(game.name, game);
  return result;
}

function gamePlayerSlots(db, game) {
  const slots = [];
  for (const userId of game.playerIds || []) {
    const player = db.getPlayer(userId);
    if (player) slots.push(player.slot);
  }
  return slots;
}

function parsePlayerYaml(buffer, overrideName) {
  let text;
  try {
    text = buffer.toString('utf8');
  } catch {
    throw new UserError('The uploaded file is not valid UTF-8 text.');
  }
  let doc;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    throw new UserError(`Could not parse yaml: ${e.message || e}`);
  }
  if (!doc || typeof doc !== 'object') throw new UserError('The yaml file must contain a mapping at the top level.');
  let game = doc.game;
  if (game && typeof game === 'object') {
    const keys = Object.keys(game);
    game = keys.length === 1 ? keys[0] : null;
  }
  if (!game || typeof game !== 'string') throw new UserError('The yaml must set "game" (e.g. `game: Hollow Knight`).');
  const slot = overrideName || doc.name;
  if (!slot || typeof slot !== 'string') throw new UserError('The yaml must set "name" (your slot name), or pass the name option.');
  return { slot: String(slot), game: String(game) };
}

function validateApworld(filename, buffer) {
  if (!filename.toLowerCase().endsWith('.apworld')) {
    throw new UserError('The file must have a .apworld extension.');
  }
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new UserError('The .apworld file is not a valid zip archive.');
  }
}

function formatStats(config, game, probeResult) {
  const room = probeResult.room || {};
  const lines = [
    `**Stats for "${game.name}"**${room.seed_name ? ` (seed ${room.seed_name})` : ''} — server on ${config.publicHost}:${game.port}`,
  ];
  for (const p of probeResult.players) {
    const pct = p.total > 0 ? Math.round((p.checked.length / p.total) * 100) : 0;
    lines.push(`• **${p.name}** (${p.game}): ${p.checked.length}/${p.total} checks (${pct}%), ${statusName(p.status)}, ${p.hint_points} hint points`);
  }
  if (!probeResult.players.length) lines.push('No player slots found.');
  return lines.join('\n');
}

function formatGameStats(game, probeResult) {
  const room = probeResult.room || {};
  let total = 0;
  let checked = 0;
  let hints = 0;
  let foundHints = 0;
  let completed = 0;
  const perGame = {};
  for (const p of probeResult.players) {
    total += p.total;
    checked += p.checked.length;
    if (p.status === 30) completed += 1;
    perGame[p.game] = (perGame[p.game] || 0) + p.total;
    for (const h of probeResult.hints?.[p.slot] || []) {
      hints += 1;
      if (h.found) foundHints += 1;
    }
  }
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  const lines = [
    `**Gamewide stats for "${game.name}"**${room.seed_name ? ` (seed ${room.seed_name})` : ''}`,
    `Checks found: **${checked}/${total}** (${pct}%) — remaining: ${total - checked}`,
    `Players: ${probeResult.players.length}, completed (goal): ${completed}`,
    `Hints: ${hints} created, ${foundHints} found`,
    `Games in multiworld: ${Object.entries(perGame).map(([g, n]) => `${g} (${n} checks)`).join(', ') || room.games?.join(', ') || 'unknown'}`,
    `Hint cost: ${room.hint_cost ?? '?'}% of a check, check value: ${room.location_check_points ?? '?'} points`,
  ];
  return lines.join('\n');
}

const handlers = {
  async commands(ctx) {
    const lines = ['**Commands**'];
    for (const def of COMMAND_DEFINITIONS) {
      lines.push(`• \`/${def.name}\` — ${COMMAND_SUMMARIES[def.name] || def.description}`);
    }
    return lines.join('\n');
  },

  async help(ctx) {
    const role = roleOf(ctx.db, ctx.config, ctx.userId);
    const lines = [`**Getting started — your role: ${role}**`, ''];
    if (isOwner(ctx.config, ctx.userId)) {
      lines.push('You are the owner: `/role add host @user` makes someone a host.', '');
    }
    if (canHost(ctx.db, ctx.config, ctx.userId)) {
      lines.push(
        '**Hosting a game**',
        '1. `/setup-game` — create the session (form: name, optional password, optional seed)',
        '2. Players `/register` (upload their yaml) and `/join game: <name>`',
        '3. Optional: `/upload-apworld` — add a custom game (.apworld, usable in every game)',
        '4. `/start game: <name>` — generates the multiworld and starts the server',
        '5. `/stop game:` stops it, `/delete-game game:` removes it',
      );
    } else if (ctx.db.getPlayer(ctx.userId)) {
      lines.push(
        '**Playing**',
        '1. `/join game: <name>` — join a session (you are registered)',
        '2. `/stats`, `/game-stats` — watch progress; `/hints` — your hints',
      );
    } else {
      lines.push(
        '**Spectating** — `/status`, `/stats`, `/game-stats`, `/players` work for everyone.',
        'To play: `/register` (upload your player yaml in the form), then `/join game: <name>`.',
      );
    }
    lines.push('', '`/commands` lists everything; `/profile` sets private vs public replies.');
    return lines.join('\n');
  },

  async register(ctx) {
    const att = ctx.attachments.yaml || ctx.modal?.files?.yaml?.[0];
    if (!att) throw new UserError('Attach a .yaml file in the form.');
    if (!/\.ya?ml$/i.test(att.filename)) throw new UserError(`"${att.filename}" is not a .yaml file.`);
    if (att.size > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const buffer = Buffer.from(await ctx.download(att.url));
    if (buffer.length > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const { slot, game } = parsePlayerYaml(buffer, ctx.options.name || ctx.modal?.fields?.name);
    const playersDir = path.join(ctx.config.dataDir, 'players');
    fs.mkdirSync(playersDir, { recursive: true });
    fs.writeFileSync(path.join(playersDir, `${ctx.userId}.yaml`), buffer);
    ctx.db.setPlayer(ctx.userId, { slot, game, registeredAt: new Date().toISOString() });
    return `Registered as player **${slot}** (game: ${game}). Use /join to enter a game session.`;
  },

  async unregister(ctx) {
    if (!ctx.db.getPlayer(ctx.userId)) throw new UserError('You are not registered.');
    ctx.db.removePlayer(ctx.userId);
    try { fs.unlinkSync(path.join(ctx.config.dataDir, 'players', `${ctx.userId}.yaml`)); } catch { /* ignore */ }
    return 'Your player registration was removed.';
  },

  async profile(ctx) {
    const role = roleOf(ctx.db, ctx.config, ctx.userId);
    const player = ctx.db.getPlayer(ctx.userId);
    const blocked = Boolean(ctx.db.getPreference(ctx.userId).blocked);
    const responses = ctx.options.responses;
    let confirmation = null;
    if (responses !== undefined && responses !== null) {
      if (!['private', 'public'].includes(responses)) throw new UserError('responses must be "private" or "public".');
      ctx.db.setPreference(ctx.userId, 'privateResponses', responses === 'private');
      confirmation = `✅ Replies to your commands are now **${responses === 'private' ? 'private (only you can see them)' : 'public (everyone can see them)'}**.`;
    }
    const current = ctx.db.getPreference(ctx.userId).privateResponses
      ? 'private (only you can see them)'
      : 'public (everyone can see them) — default';
    return [
      '**Your profile**',
      `Role: **${role}**`,
      player ? `Registered as player: **${player.slot}** (${player.game})` : 'Not registered as a player — use /register',
      `Replies to your commands: **${current}**`,
      'Change it with `/profile responses: private` or `/profile responses: public`.',
      `Blocked (DM when someone sends you an item): **${blocked ? 'yes' : 'no (default)'}** — change with /block or /unblock`,
      confirmation,
    ].filter(Boolean).join('\n');
  },

  async block(ctx) {
    ctx.db.setPreference(ctx.userId, 'blocked', true);
    return '✅ You are now marked **blocked**: while blocked, you get a DM whenever someone sends you an item. `/unblock` to turn it off.';
  },

  async unblock(ctx) {
    ctx.db.setPreference(ctx.userId, 'blocked', false);
    return '✅ You are now **unblocked** (the default): no DMs for incoming items.';
  },

  async received(ctx) {
    const player = ctx.db.getPlayer(ctx.userId);
    if (!player) throw new UserError('You must /register first.');
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status !== 'running') throw new UserError(`Game **${game.name}** is not running (status: ${game.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, game, 'received', null, 30000, gamePlayerSlots(ctx.db, game));
    const me = probeResult.players.find((p) => p.name === player.slot);
    if (!me) throw new UserError(`Your slot "${player.slot}" was not found in the running game.`);
    const all = probeResult.received?.[me.slot] || [];
    const prefs = ctx.db.getPreference(ctx.userId);
    const seen = prefs.lastReceivedIndex?.[game.name] || 0;
    const scope = ctx.options.scope || 'new';
    const items = scope === 'all' ? all : all.slice(seen);
    ctx.db.setPreference(ctx.userId, 'lastReceivedIndex', { ...(prefs.lastReceivedIndex || {}), [game.name]: all.length });
    if (!items.length) {
      return scope === 'all'
        ? `You have not received any items yet in **${game.name}**.`
        : `Nothing new since your last /received in **${game.name}** (${all.length} received in total — /received scope: all for the full list).`;
    }
    // "when" comes from the server log (the wire protocol has no timestamps)
    const sends = ctx.ap.parseItemSends(path.join(ctx.ap.gameDir(ctx.config, game), 'server.log'));
    const timeByKey = new Map();
    for (const s of sends) {
      if (s.receiver === player.slot) timeByKey.set(`${s.item}|${s.sender}`, s.at);
    }
    const header = scope === 'all'
      ? `**Items received by ${player.slot}** (game ${game.name}) — full list (${all.length}):`
      : `**Items received by ${player.slot}** (game ${game.name}) — new since last check:`;
    const lines = [header];
    items.forEach((it, i) => {
      const idx = (scope === 'all' ? i : seen + i) + 1;
      const when = timeByKey.get(`${it.item}|${it.sender_name}`) || 'time not in server log';
      lines.push(`• #${idx} **${it.item}** from **${it.sender_name}** (found at ${it.location}) — ${when}`);
    });
    return lines.join('\n');
  },

  async join(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    const player = ctx.db.getPlayer(ctx.userId);
    if (!player) throw new UserError('You must /register with your player yaml before joining a game.');
    game.playerIds = game.playerIds || [];
    if (!game.playerIds.includes(ctx.userId)) game.playerIds.push(ctx.userId);
    ctx.db.setGame(game.name, game);
    return `Joined game **${game.name}** as slot **${player.slot}**.`;
  },

  async leave(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    game.playerIds = (game.playerIds || []).filter((id) => id !== ctx.userId);
    ctx.db.setGame(game.name, game);
    return `Left game **${game.name}**.`;
  },

  async players(ctx) {
    const blockedTag = (userId) => (ctx.db.getPreference(userId).blocked ? ' 🔒 blocked' : '');
    if (ctx.options.game) {
      const game = resolveGame(ctx, ctx.options.game);
      const lines = [`**Players in "${game.name}" (${(game.playerIds || []).length}):**`];
      for (const userId of game.playerIds || []) {
        const p = ctx.db.getPlayer(userId);
        lines.push(`• <@${userId}> — slot ${p ? `**${p.slot}** (${p.game})` : '(registration missing)'}${blockedTag(userId)}`);
      }
      if (!lines[1]) lines.push('(none yet — players use /join)');
      return lines.join('\n');
    }
    const lines = ['**Registered players:**'];
    const entries = Object.entries(ctx.db.data.players);
    if (!entries.length) lines.push('(none yet — anyone can /register)');
    for (const [userId, p] of entries) lines.push(`• <@${userId}> — **${p.slot}** (${p.game})${blockedTag(userId)}`);
    return lines.join('\n');
  },

  async 'setup-game'(ctx) {
    const name = String(ctx.options.name || ctx.modal?.fields?.name || '').trim();
    if (!name) throw new UserError('Provide a game name.');
    const password = ctx.options.password || ctx.modal?.fields?.password || null;
    const seedRaw = String(ctx.options.seed ?? ctx.modal?.fields?.seed ?? '').trim();
    if (seedRaw !== '' && !Number.isInteger(Number(seedRaw))) throw new UserError('Seed must be an integer.');
    const slug = ctx.ap.slugify(name);
    if (ctx.db.getGame(slug)) throw new UserError(`A game named "${name}" already exists.`);
    // A new game discards previous player registrations and their uploaded
    // yamls; everyone has to /register again for the new game.
    ctx.db.clearPlayers();
    for (const existing of ctx.db.listGames()) {
      existing.playerIds = [];
      ctx.db.setGame(existing.name, existing);
    }
    fs.rmSync(path.join(ctx.config.dataDir, 'players'), { recursive: true, force: true });
    const game = {
      name: slug,
      displayName: name,
      password: password || null,
      createdBy: ctx.userId,
      status: 'setup',
      playerIds: [],
      requestedSeed: seedRaw || null,
      multidata: null,
      seed: null,
      seedNumber: null,
      port: null,
      pid: null,
      createdAt: new Date().toISOString(),
    };
    ctx.db.setGame(slug, game);
    return `Created game **${slug}** (previous player registrations and yamls were discarded — everyone must /register again). Next: players /register and /join, hosts /upload-apworld, then /start — it generates the multiworld (seed ${seedRaw || 'random'}) and starts the server.`;
  },

  async 'upload-apworld'(ctx) {
    const att = ctx.attachments.file || ctx.modal?.files?.file?.[0];
    if (!att) throw new UserError('Attach a .apworld file in the form.');
    if (att.size > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const buffer = Buffer.from(await ctx.download(att.url));
    if (buffer.length > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    validateApworld(att.filename, buffer);
    const saved = ctx.ap.saveApworld(ctx.config, att.filename, buffer);
    const all = ctx.ap.listApworlds(ctx.config);
    return `Uploaded **${saved}** — apworlds are global and used by every game (${all.length} stored: ${all.join(', ')}).`;
  },

  async start(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status === 'running' && ctx.ap.isServerProcessAlive(game)) throw new UserError('This game is already running.');
    const gen = await ensureGenerated(ctx, game);
    let port = ctx.options.port;
    if (!port) {
      const used = new Set(ctx.db.listGames().map((g) => g.port).filter(Boolean));
      port = ctx.config.basePort;
      while (used.has(port)) port += 1;
    }
    const { pid, logFile } = ctx.ap.startGame(ctx.config, ctx.db, game, port);
    const up = await ctx.ap.waitForPort(port);
    if (!up) {
      ctx.ap.stopGame(ctx.config, game);
      throw new UserError(`Server did not start listening on port ${port}. See log: ${logFile}`);
    }
    game.status = 'running';
    game.port = port;
    game.pid = pid;
    game.startedAt = new Date().toISOString();
    ctx.db.setGame(game.name, game);
    return [
      gen ? `Generated multiworld for **${game.name}** (seed ${game.seedNumber}, id ${game.seed}; players: ${gen.players.join(', ')}; spoiler: \`${game.spoiler}\`).` : null,
      `Server for **${game.name}** is running: \`${ctx.config.publicHost}:${port}\`${game.password ? ' (password required)' : ' (no password)'}.`,
      `Seed: ${game.seedNumber ?? game.seed ?? '?'}, log: \`${logFile}\``,
    ].filter(Boolean).join('\n');
  },

  async stop(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    const stopped = ctx.ap.stopGame(ctx.config, game);
    game.status = 'stopped';
    game.stoppedAt = new Date().toISOString();
    ctx.db.setGame(game.name, game);
    return stopped ? `Stopped game **${game.name}**.` : `Game **${game.name}** was not running.`;
  },

  async 'delete-game'(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status === 'running') ctx.ap.stopGame(ctx.config, game);
    ctx.db.removeGame(game.name);
    fs.rmSync(ctx.ap.gameDir(ctx.config, game), { recursive: true, force: true });
    return `Deleted game **${game.name}** (server stopped if it was running, session and files removed).`;
  },

  async status(ctx) {
    if (ctx.options.game) return formatGameLine(ctx, resolveGame(ctx, ctx.options.game));
    const scope = ctx.options.scope || 'active';
    const all = ctx.db.listGames();
    const games = all.filter((g) => (scope === 'all' ? true : scope === 'finished' ? g.status === 'stopped' : ACTIVE_STATUSES.has(g.status)));
    if (!all.length) return 'No games yet. A host can create one with /setup-game.';
    if (!games.length) {
      if (scope === 'finished') return 'No finished games. /status lists active games by default; /status scope: all lists everything.';
      return 'No active games (started or waiting to be started). Finished games: /status scope: finished — everything: /status scope: all.';
    }
    const apworlds = ctx.ap.listApworlds(ctx.config);
    const header = scope === 'all' ? '**All games**' : scope === 'finished' ? '**Finished games**' : '**Active games** (started or waiting to be started)';
    const lines = [header, `Available .apworld files (used by every game): ${apworlds.length ? apworlds.join(', ') : 'none'}`];
    for (const g of games) lines.push(formatGameLine(ctx, g));
    return lines.join('\n');
  },

  async stats(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status !== 'running') throw new UserError(`Game **${game.name}** is not running (status: ${game.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, game, 'stats', null, 30000, gamePlayerSlots(ctx.db, game));
    return formatStats(ctx.config, game, probeResult);
  },

  async 'game-stats'(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status !== 'running') throw new UserError(`Game **${game.name}** is not running (status: ${game.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, game, 'stats', null, 30000, gamePlayerSlots(ctx.db, game));
    return formatGameStats(game, probeResult);
  },

  async hints(ctx) {
    if (!ctx.config.hintsEnabled) throw new UserError('Hints are disabled on this bridge (HINTS_ENABLED=false).');
    const player = ctx.db.getPlayer(ctx.userId);
    if (!player) throw new UserError('You must /register first.');
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status !== 'running') throw new UserError(`Game **${game.name}** is not running (status: ${game.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, game, 'hints', null, 30000, gamePlayerSlots(ctx.db, game));
    const me = probeResult.players.find((p) => p.name === player.slot);
    if (!me) throw new UserError(`Your slot "${player.slot}" was not found in the running game.`);
    const hints = probeResult.hints?.[me.slot] || [];
    if (!hints.length) return `No hints for **${player.slot}** in game **${game.name}** yet.`;
    const lines = [`**Hints for ${player.slot}** (game ${game.name}):`];
    for (const h of hints) {
      lines.push(`• ${h.found ? '✅' : '🔎'} **${h.item}** is at **${h.location}** in ${h.finding_player_name}'s world${h.entrance ? ` (${h.entrance})` : ''}`);
    }
    return lines.join('\n');
  },

  async role(ctx) {
    const sub = ctx.subcommand;
    if (sub === 'list') {
      const lines = ['**Roles**', `• owner: <@${ctx.config.discordOwnerId}> (from .env)`];
      for (const id of ctx.db.data.hosts) lines.push(`• host: <@${id}>`);
      if (!ctx.db.data.hosts.length) lines.push('• host: (none)');
      return lines.join('\n');
    }
    if (sub === 'add' || sub === 'remove') {
      const target = ctx.subOptions.user;
      const role = ctx.subOptions.role;
      if (!target) throw new UserError('Specify a user.');
      if (role !== 'host') throw new UserError('Only the "host" role can be assigned.');
      if (target === ctx.config.discordOwnerId) throw new UserError('The owner already has all permissions.');
      if (sub === 'add') {
        ctx.db.addHost(target);
        return `Assigned role **host** to <@${target}>.`;
      }
      ctx.db.removeHost(target);
      return `Removed role **host** from <@${target}>.`;
    }
    throw new UserError('Unknown subcommand.');
  },
};

export async function handleCommand(name, ctx) {
  const handler = handlers[name];
  if (!handler) throw new UserError(`Unknown command "${name}".`);
  ctx.ap = ctx.ap || ap;
  return handler(ctx);
}

export async function handleModal(customId, ctx) {
  ctx.ap = ctx.ap || ap;
  if (customId === MODAL_REGISTER) return handlers.register(ctx);
  if (customId === MODAL_UPLOAD_APWORLD) return handlers['upload-apworld'](ctx);
  if (customId === MODAL_SETUP_GAME) return handlers['setup-game'](ctx);
  throw new UserError('Unknown form.');
}
