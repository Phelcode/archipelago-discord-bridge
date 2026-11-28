import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ModalBuilder, LabelBuilder, FileUploadBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { roleOf, canHost, isOwner } from './permissions.js';
import { userIdsOf } from '../store.js';
import * as ap from '../ap/manager.js';

export class UserError extends Error {}

const STRING = 3;
const INTEGER = 4;
const USER = 6;

const multiworldOption = (required) => ({
  name: 'multiworld', description: 'Multiworld name', type: STRING, required,
});

export const COMMAND_DEFINITIONS = [
  { name: 'commands', description: 'List all commands with a one-line summary' },
  { name: 'help', description: 'Step-by-step intro for your role (owner/host/player/spectator)' },
  { name: 'glossary', description: 'Archipelago terms used in this app (multiworld, world, slot, seed, …)' },
  { name: 'register', description: 'Register a world/slot (modal form for your .yaml); repeat for more worlds; multiworld: also joins it', options: [multiworldOption(false)] },
    {
    name: 'unregister',
    description: 'Remove a registered world and its yaml; with several worlds, world: is required',
    options: [{ name: 'world', description: 'Slot name of the world to remove (required if you have several)', type: STRING, required: false }],
  },
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
  {
    name: 'release',
    description: '[host] Release a player (like AP !release): sends out all their remaining items',
    options: [
      { name: 'player', description: 'Slot name or @user to release', type: STRING, required: true },
      multiworldOption(false),
    ],
  },
  { name: 'players', description: 'List registered players and their worlds; with multiworld: the slots in it (incl. live status)', options: [multiworldOption(false)] },
  { name: 'setup-multiworld', description: '[host] Create a new multiworld (opens a form)', options: [] },
  { name: 'upload-apworld', description: '[host] Upload a custom .apworld file (usable in every multiworld; opens an upload form)', options: [] },
  {
    name: 'start',
    description: '[host] Generate the multiworld if needed, then start the Archipelago server',
    options: [multiworldOption(true), { name: 'port', description: 'Port to listen on (optional)', type: INTEGER, required: false }],
  },
  { name: 'stop', description: '[host] Stop the Archipelago server for a multiworld', options: [multiworldOption(true)] },
  { name: 'delete-multiworld', description: '[host] Delete a multiworld and its files', options: [multiworldOption(true)] },
  {
    name: 'status',
    description: 'Show multiworlds and server status (active multiworlds by default)',
    options: [
      multiworldOption(false),
      {
        name: 'scope', description: 'Which multiworlds to list', type: STRING, required: false,
        choices: [
          { name: 'active — started or waiting to be started (default)', value: 'active' },
          { name: 'finished — stopped multiworlds', value: 'finished' },
          { name: 'all — every multiworld', value: 'all' },
        ],
      },
    ],
  },
  { name: 'stats', description: 'Per-slot stats: checks found / total and connection status', options: [multiworldOption(false)] },
  { name: 'multiworld-stats', description: 'Multiworld-wide totals: checks found/total, hints, seed', options: [multiworldOption(false)] },
  { name: 'hints', description: 'Show your hints (if hints are enabled)', options: [multiworldOption(false)] },
  {
    name: 'received',
    description: 'Items sent to you in a multiworld (what was unlocked for you, by whom, when)',
    options: [
      multiworldOption(false),
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

// Registration goes through discord.js's REST layer, which handles 429
// cooldowns and retries itself. PUT commands is a full server-side replace
// (clears stale + registers current, atomically) — and the command routes are
// heavily rate-limited, so the scheduler only calls this when the persisted
// hash shows the command set changed. Every step is logged.
function fmtErr(err) {
  const base = err?.message || err?.name || String(err);
  return typeof err?.retryAfter === 'number' ? `${base}, retry_after ${err.retryAfter}s` : base;
}

export async function registerAllCommands(client, { guildIds = [], definitions }) {
  try {
    await client.application.edit({ integration_types: INTEGRATION_TYPES_BOTH });
    console.log('[commands] integration types set to guild + user install');
  } catch (err) {
    console.warn(`[commands] could not set integration_types (${fmtErr(err)}); enable Guild + User install in the dev portal if needed.`);
  }
  // A global PUT failure must not block guild registration: guild command
  // routes have their own, generous rate-limit buckets and are the instant
  // path. The global error is rethrown after the guild loop so the scheduler
  // keeps retrying it.
  let globalError = null;
  console.log(`[commands] registering ${definitions.length} global commands...`);
  try {
    await client.application.commands.set(globalCommandPayload(definitions));
    console.log(`[commands] registered ${definitions.length} global commands (guild + user install, all contexts incl. DMs).`);
  } catch (err) {
    globalError = err;
    console.error(`[commands] global PUT failed: ${fmtErr(err)}`);
  }
  for (const guildId of guildIds) {
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.commands.set(guildCommandPayload(definitions));
      console.log(`[commands] registered ${definitions.length} commands in guild ${guildId} (instant there).`);
    } catch (err) {
      console.warn(`[commands] guild registration in ${guildId} failed (${fmtErr(err)}); add the app to that guild with the bot + applications.commands scopes for instant guild commands. Global commands still apply.`);
    }
  }
  if (globalError) throw globalError;
}

export function payloadHash(definitions, guildIds) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ global: globalCommandPayload(definitions), guild: guildCommandPayload(definitions), guildIds }))
    .digest('hex');
}

function registrationStateFile(config) {
  return path.join(config.dataDir, 'commands-state.json');
}

// Retries on its own unref'd timer until registration succeeds, so a failed
// attempt never leaves the app commandless and never delays other timers.
// The hash of the last successfully registered command set is persisted in
// DATA_DIR, so steady-state boots make zero calls to the rate-limited
// command routes (every call there can extend Discord's cooldown window).
export function scheduleCommandRegistration(client, config, opts, { intervalMs = 60000 } = {}) {
  const hash = payloadHash(opts.definitions, opts.guildIds || []);
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(registrationStateFile(config), 'utf8'));
  } catch { /* no state yet */ }
  if (state.hash === hash && state.lastSuccessAt) {
    console.log('[commands] command set unchanged since last successful registration; no API calls made');
    return () => {};
  }
  let stopped = false;
  let timer = null;
  // notBefore: persisted across restarts. Hitting a rate-limited route during
  // its cooldown extends the window, so after a 429 we make ZERO calls until
  // the cooldown has fully elapsed (plus one interval tick of slack, since
  // network timing is never exact) — even across container restarts.
  let notBefore = state.notBefore || 0;
  const saveState = (extra) => {
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(registrationStateFile(config), JSON.stringify({ ...state, ...extra }));
    } catch { /* best effort */ }
  };
  // Returns 0 on success, else the ms to wait before the next attempt.
  const attempt = async () => {
    try {
      await registerAllCommands(client, opts);
      saveState({ hash, lastSuccessAt: Date.now(), notBefore: 0 });
      return 0;
    } catch (err) {
      const retryAfterMs = typeof err?.retryAfter === 'number' ? err.retryAfter * 1000 : 0;
      if (retryAfterMs > 0) {
        notBefore = Date.now() + retryAfterMs + intervalMs;
        saveState({ notBefore });
      }
      const remaining = notBefore - Date.now();
      const wait = remaining > 0 ? Math.ceil(remaining / intervalMs) * intervalMs : intervalMs;
      console.error(`[commands] registration failed: ${fmtErr(err)}; next attempt at ${new Date(Date.now() + wait).toISOString()}`);
      return wait;
    }
  };
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
  const loop = async () => {
    if (stopped) return;
    const pending = notBefore - Date.now();
    if (pending > 0) {
      console.log(`[commands] a persisted rate-limit cooldown is still active; waiting ${Math.round(pending / 1000)}s before the next attempt`);
      await sleep(Math.ceil(pending / intervalMs) * intervalMs);
      if (stopped) return;
    }
    const wait = await attempt();
    if (!wait || stopped) return;
    timer = setTimeout(loop, wait);
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
  glossary: 'all',
  register: 'all',
  unregister: 'all',
  profile: 'all',
  release: 'host',
  players: 'all',
  'setup-multiworld': 'host',
  'upload-apworld': 'host',
  start: 'host',
  stop: 'host',
  'delete-multiworld': 'host',
  role: 'owner',
  status: 'all',
  stats: 'all',
  'multiworld-stats': 'all',
  hints: 'all',
  received: 'all',
  block: 'all',
  unblock: 'all',
};

export const EPHEMERAL_COMMANDS = new Set(['register', 'unregister', 'profile', 'hints', 'role', 'received', 'block', 'unblock']);

// Modals (components v2: File Upload type 19 / Text Input type 4 inside a Label).
export const MODAL_REGISTER = 'bridge_register';
export const MODAL_UPLOAD_APWORLD = 'bridge_upload_apworld';
export const MODAL_SETUP_MULTIWORLD = 'bridge_setup_multiworld';
export const MODAL_PERMISSIONS = {
  [MODAL_REGISTER]: 'all',
  [MODAL_UPLOAD_APWORLD]: 'host',
  [MODAL_SETUP_MULTIWORLD]: 'host',
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
    .setTitle('Register a world')
    .addLabelComponents(
      fileUploadField('yaml', 'World yaml file (.yaml) — one per world/slot'),
      textField('name', 'Slot name override (optional)', { required: false }),
    );
}

export function uploadApworldModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_UPLOAD_APWORLD)
    .setTitle('Upload .apworld')
    .addLabelComponents(
      fileUploadField('file', '.apworld file (usable in every multiworld)'),
    );
}

export function setupGameModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_SETUP_MULTIWORLD)
    .setTitle('Create multiworld')
    .addLabelComponents(
      textField('name', 'Multiworld name'),
      textField('password', 'Server password (optional)', { required: false }),
      textField('seed', 'Seed (optional, random if empty)', { required: false, maxLength: 20 }),
    );
}

// Commands that always answer with a modal (forms support file uploads).
export const ALWAYS_MODAL = {
  register: registerModal,
  'upload-apworld': uploadApworldModal,
  'setup-multiworld': setupGameModal,
};

const STATUS_NAMES = { 0: 'offline', 5: 'connected', 10: 'ready', 20: 'playing', 30: 'goal reached' };

export const COMMAND_SUMMARIES = {
  commands: 'List all commands with a one-line summary',
  help: 'Step-by-step intro for your role',
  glossary: 'Archipelago terms used here (multiworld, world, slot, seed, room, yaml, apworld, check, hint, release)',
  register: 'Register a world/slot (upload your .yaml in the form); repeat for more; multiworld: auto-joins it',
  unregister: 'Remove one registered world (world: required if you have several); with a single world, removes it',
  profile: 'Your role/registration; set private or public replies',
  release: '[host] Release a player (AP !release) — sends out all their remaining items',
  players: 'List registered players (🔒 = blocked), ; multiworld: lists its slots with live status',
  'setup-multiworld': '[host] Create a multiworld (opens a form)',
  'upload-apworld': '[host] Upload a .apworld (usable in every multiworld; opens a form)',
  start: '[host] Generate the multiworld if needed, then start the server',
  stop: '[host] Stop the server',
  'delete-multiworld': '[host] Delete a multiworld and its files',
  status: 'Multiworlds and server status (active by default; scope: finished|all)',
  stats: 'Per-slot checks found/total and connection status',
  'multiworld-stats': 'Multiworld totals: checks found/total, hints, seed',
  hints: 'Your hints (if hints are enabled)',
  received: 'Items sent to you (what/who/when) — new since last check by default, scope: all for the full list',
  block: 'Mark yourself blocked — get a DM when someone sends you an item',
  unblock: 'Mark yourself unblocked (default)',
  role: '[owner] Assign or remove host roles',
};

// "Active" games are started (running) or waiting to be started (set up /
// generating / generated). "Finished" games are stopped.
const ACTIVE_STATUSES = new Set(['setup', 'generating', 'generated', 'running']);

function formatMultiworldLine(ctx, g) {
  const alive = g.status === 'running' && ctx.ap.isServerProcessAlive(g);
  const players = userIdsOf(g).flatMap((id) => ctx.db.getWorlds(id).map((w) => w.slot)).join(', ') || 'none';
  return [
    `**${g.name}** — status: ${alive ? 'running' : g.status}${alive && g.port ? ` on ${ctx.config.publicHost}:${g.port}` : ''}`,
    `  players: ${players} | seed: ${g.seed ?? 'not generated'}`,
  ].join('\n');
}

export function statusName(status) {
  return STATUS_NAMES[status] ?? `status ${status}`;
}

function joinMultiworld(ctx, mw) {
  mw.userIds = mw.userIds || [];
  if (!mw.userIds.includes(ctx.userId)) mw.userIds.push(ctx.userId);
  ctx.db.setMultiworld(mw.name, mw);
}

function resolveMultiworld(ctx, name) {
  const db = ctx.db;
  const mws = db.listMultiworlds();
  if (name) {
    const mw = db.getMultiworld(ctx.ap.slugify(name));
    if (!mw) {
      throw new UserError(`Unknown multiworld "${name}".${mws.length ? ` Known multiworlds: ${mws.map((g) => g.name).join(', ')}` : ''}`);
    }
    return mw;
  }
  const running = mws.filter((g) => g.status === 'running');
  if (running.length === 1) return running[0];
  if (running.length > 1) throw new UserError(`Multiple multiworlds are running; specify one: ${running.map((g) => g.name).join(', ')}`);
  if (mws.length === 1) return mws[0];
  if (mws.length === 0) throw new UserError('No multiworlds have been set up yet. A host can create one with /setup-multiworld.');
  return mws[mws.length - 1];
}

// Generates the multiworld if it doesn't have one yet (called by
// /start). Returns the generation result when a generation ran, null when an
// existing multiworld was reused (kept across restarts, so the seed is stable).
async function ensureGenerated(ctx, mw) {
  if (mw.multidata && fs.existsSync(mw.multidata)) return null;
  let seed = mw.requestedSeed;
  if (seed !== undefined && seed !== null && String(seed).trim() !== '') {
    seed = Number(seed);
    if (!Number.isInteger(seed)) throw new UserError('Seed must be an integer.');
  }
  const prevStatus = mw.status === 'generating' ? 'setup' : mw.status;
  mw.status = 'generating';
  ctx.db.setMultiworld(mw.name, mw);
  let result;
  try {
    result = await ctx.ap.generateMultiworld(ctx.config, ctx.db, mw, seed);
  } catch (err) {
    mw.status = prevStatus;
    ctx.db.setMultiworld(mw.name, mw);
    throw err;
  }
  mw.status = 'generated';
  mw.multidata = result.multidata;
  mw.spoiler = result.spoiler;
  mw.seed = result.seed;
  mw.seedNumber = result.seedNumber;
  mw.generatedAt = new Date().toISOString();
  ctx.db.setMultiworld(mw.name, mw);
  return result;
}

export function multiworldSlots(db, mw) {
  const slots = [];
  for (const userId of userIdsOf(mw)) {
    for (const world of db.getWorlds(userId)) slots.push(world.slot);
  }
  return [...new Set(slots)];
}

// Some worlds put a per-player file at the root of the generated AP_*.zip
// (e.g. Minecraft's <slot>.apmc). Extract them and post them in the channel
// the command was run in, mentioning each player (a DM can fail for users who
// never opened a DM with the app). Returns human-readable notes about what
// was posted.
async function sendPlayerFiles(ctx, mw, onlyUserId = null) {
  const notes = [];
  if (!mw.multidata || !fs.existsSync(mw.multidata)) return notes;
  if (typeof ctx.postToChannel !== 'function') return notes;
  let files;
  try {
    files = ctx.ap.extractPlayerFiles(mw.multidata, path.join(ctx.ap.multiworldDir(ctx.config, mw), 'player-files'));
  } catch (err) {
    console.error(`[files] could not extract player files from ${mw.multidata}: ${err.message}`);
    return notes;
  }
  // zip entries are named AP_<seed>_P<n>_<playerName>.<ext>; the player name
  // is the yaml "name", which is the slot unless overridden at registration
  const byPlayer = new Map(files.map((f) => [f.player, f]));
  const attachments = [];
  const lines = [];
  for (const userId of userIdsOf(mw)) {
    if (onlyUserId && userId !== onlyUserId) continue;
    for (const world of ctx.db.getWorlds(userId)) {
      let file = byPlayer.get(world.slot);
      if (!file) {
        try {
          const doc = YAML.parse(fs.readFileSync(path.join(ctx.config.dataDir, 'players', userId, `${world.slot}.yaml`), 'utf8'));
          if (doc?.name) file = byPlayer.get(String(doc.name));
        } catch { /* no staged yaml */ }
      }
      if (!file) continue;
      attachments.push({ attachment: fs.readFileSync(file.path), name: file.entry });
      lines.push(`• **${file.entry}** → <@${userId}> (${world.slot}, ${world.game})`);
      notes.push(`**${file.entry}** → <@${userId}> (${world.slot})`);
    }
  }
  if (!attachments.length) return notes;
  const header = `Player files for multiworld **${mw.name}** — load yours in your game:`;
  for (let i = 0; i < attachments.length; i += 10) { // Discord allows 10 files per message
    try {
      const chunkLines = lines.slice(i, i + 10).join('\n');
      await ctx.postToChannel(i === 0 ? `${header}\n${chunkLines}` : chunkLines, attachments.slice(i, i + 10));
    } catch (err) {
      console.error(`[files] posting player files failed: ${err.message}`);
      notes.push(`could not post player files (${err.message})`);
    }
  }
  return notes;
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

function formatStats(config, mw, probeResult) {
  const room = probeResult.room || {};
  const lines = [
    `**Stats for "${mw.name}"**${room.seed_name ? ` (seed ${room.seed_name})` : ''} — server on ${config.publicHost}:${mw.port}`,
  ];
  for (const p of probeResult.players) {
    const pct = p.total > 0 ? Math.round((p.checked.length / p.total) * 100) : 0;
    lines.push(`• **${p.name}** (${p.game}): ${p.checked.length}/${p.total} checks (${pct}%), ${statusName(p.status)}, ${p.hint_points} hint points`);
  }
  if (!probeResult.players.length) lines.push('No player slots found.');
  return lines.join('\n');
}

function formatGameStats(mw, probeResult) {
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
    `**Multiworld-wide stats for "${mw.name}"**${room.seed_name ? ` (seed ${room.seed_name})` : ''}`,
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
        '**Hosting a multiworld**',
        '1. `/setup-multiworld` — create the multiworld (form: name, optional password, optional seed)',
        '2. Players `/register multiworld: <name>` (one yaml per world/slot)',
        '3. Optional: `/upload-apworld` — add a custom AP world package (.apworld, usable in every multiworld)',
        '4. `/start multiworld: <name>` — generates the multiworld and starts the server',
        '5. `/stop multiworld:` stops it, `/delete-multiworld multiworld:` removes it',
        '6. `/release multiworld: <name> player: <slot or @user>` — release a player who can\'t continue (sends out their remaining items)',
      );
    } else if (ctx.db.getPlayer(ctx.userId)) {
      lines.push(
        '**Playing**',
        '1. `/register [multiworld:]` — upload a yaml per world (slot); repeat to add more worlds. With `multiworld:` you also join that multiworld',
        '2. `/stats`, `/multiworld-stats` — watch progress; `/hints`, `/received` — your hints and items',
        '3. `/block` — get a DM when someone sends you an item; `/unblock` to stop',
      );
    } else {
      lines.push(
        '**Spectating** — `/status`, `/stats`, `/multiworld-stats`, `/players` work for everyone.',
        'To play: `/register multiworld: <name>` — upload a yaml (one per world/slot; repeat for more) and join in one step.',
      );
    }
    lines.push('', '`/commands` lists everything; `/profile` sets private vs public replies.');
    return lines.join('\n');
  },

  async glossary(ctx) {
    return [
      '**Archipelago glossary** (terms as used in this app — see https://archipelago.gg/glossary/en/)',
      '',
      '• **Multiworld** — one generated seed: all slots together with their items, locations and access rules. In this app a multiworld is what `/setup-multiworld` creates and `/start` hosts (option `multiworld:`).',
      '• **Server / room** — a running instance of a multiworld. `/start` spawns one per multiworld; you connect to it at `host:port`.',
      '• **World** — one player\'s randomized copy of a game. You bring one per slot via a yaml: `/register` (repeat to add more worlds).',
      '• **Slot** — a single world within a multiworld, identified by its **slot name** (the `name:` in your yaml). Items and checks belong to slots.',
      '• **Seed** — the random seed of a multiworld (unique item placement). Set in `/setup-multiworld` or random.',
      '• **Yaml** — a player config file; one yaml creates one world/slot. Upload via `/register`.',
      '• **APWorld (.apworld)** — a custom game package; upload via `/upload-apworld`, usable in every multiworld.',
      '• **Item** — something shuffled between worlds; sent when a **check** is done.',
      '• **Check / location** — a place to look; checking it sends the item found there to its owner. `/stats` shows found/total per slot.',
      '• **Hint** — a pointer to where an item is (see `/hints`; costs hint points).',
      '• **Release** — send out all remaining items of a slot (`/release`, like AP `!release`).',
      '• **Blocked** — `/block` makes the bridge DM you when someone sends you an item.',
      '',
      'Roles in this app: **owner** (`DISCORD_OWNER_ID`), **host** (`/role add host @user`), **player** (registered), **spectator** (everyone).',
    ].join('\n');
  },

  async register(ctx) {
    const targetMultiworld = ctx.options.multiworld ? resolveMultiworld(ctx, ctx.options.multiworld) : null;
    const att = ctx.attachments.yaml || ctx.modal?.files?.yaml?.[0];
    if (!att) throw new UserError('Attach a .yaml file in the form.');
    if (!/\.ya?ml$/i.test(att.filename)) throw new UserError(`"${att.filename}" is not a .yaml file.`);
    if (att.size > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const buffer = Buffer.from(await ctx.download(att.url));
    if (buffer.length > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const { slot, game } = parsePlayerYaml(buffer, ctx.options.name || ctx.modal?.fields?.name);
    const playersDir = path.join(ctx.config.dataDir, 'players', ctx.userId);
    fs.mkdirSync(playersDir, { recursive: true });
    fs.writeFileSync(path.join(playersDir, `${slot}.yaml`), buffer);
    ctx.db.setPlayer(ctx.userId, { slot, game });
    const mySlots = ctx.db.getWorlds(ctx.userId).map((w) => w.slot).join(', ');
    let target = targetMultiworld;
    const active = ctx.db.listMultiworlds().filter((m) => ACTIVE_STATUSES.has(m.status));
    if (!target && active.length === 1) target = active[0];
    if (!target) {
      return `Registered world **${slot}** (${game}). Your worlds: ${mySlots}.`
        + (active.length > 1 ? ` ${active.length} active multiworlds (${active.map((m) => m.name).join(', ')}) — re-run /register with multiworld: <name> to join one.` : '');
    }
    joinMultiworld(ctx, target);
    let fileNote = '';
    if (target.multidata && fs.existsSync(target.multidata)) {
      try {
        const notes = await sendPlayerFiles(ctx, target, ctx.userId);
        if (notes.length) fileNote = ` ${notes.join('; ')}.`;
      } catch (err) {
        console.error(`[files] ${err.message}`);
      }
    }
    return `Registered world **${slot}** (${game}) and joined multiworld **${target.name}** (your worlds there: ${mySlots}).${fileNote}`;
  },

  async unregister(ctx) {
    const worlds = ctx.db.getWorlds(ctx.userId);
    if (!worlds.length) throw new UserError('You are not registered.');
    const opt = ctx.options.world;
    let targets;
    if (opt) {
      if (!worlds.some((w) => w.slot === opt)) {
        throw new UserError(`You have no world named "${opt}". Your worlds: ${worlds.map((w) => w.slot).join(', ')}.`);
      }
      targets = [opt];
    } else if (worlds.length > 1) {
      throw new UserError(`You have several worlds (${worlds.map((w) => w.slot).join(', ')}) — specify one with world: <slot>.`);
    } else {
      targets = [worlds[0].slot];
    }
    for (const slot of targets) {
      ctx.db.removeWorld(ctx.userId, slot);
      try { fs.unlinkSync(path.join(ctx.config.dataDir, 'players', ctx.userId, `${slot}.yaml`)); } catch { /* ignore */ }
    }
    // drop the per-user dir if empty
    try {
      const dir = path.join(ctx.config.dataDir, 'players', ctx.userId);
      if (fs.existsSync(dir) && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch { /* ignore */ }
    const remaining = ctx.db.getWorlds(ctx.userId).map((w) => w.slot);
    const notes = [];
    // release the removed slots in running multiworlds the user is in
    for (const mw of ctx.db.listMultiworlds()) {
      if (mw.status !== 'running' || !(mw.userIds || []).includes(ctx.userId)) continue;
      for (const slot of targets) {
        try {
          await ctx.ap.say(ctx.config, mw, slot, '!release');
          notes.push(`released **${slot}** in running multiworld **${mw.name}**`);
        } catch (err) {
          notes.push(`could not release **${slot}** in **${mw.name}** (${err.message})`);
        }
      }
    }
    // with no worlds left, leave every multiworld
    if (!remaining.length) {
      for (const mw of ctx.db.listMultiworlds()) {
        if ((mw.userIds || []).includes(ctx.userId)) {
          mw.userIds = mw.userIds.filter((id) => id !== ctx.userId);
          ctx.db.setMultiworld(mw.name, mw);
          notes.push(`left multiworld **${mw.name}**`);
        }
      }
    }
    const base = `Removed world **${targets.join(', ')}**.${remaining.length ? ` Remaining worlds: ${remaining.join(', ')}.` : ' You are no longer registered.'}`;
    return notes.length ? `${base} ${notes.join('; ')}.` : base;
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
      player ? `Registered worlds: ${ctx.db.getWorlds(ctx.userId).map((w) => `**${w.slot}** (${w.game})`).join(', ')}` : 'Not registered — use /register (you can register several worlds, each with its own yaml)',
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
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status !== 'running') throw new UserError(`Multiworld **${mw.name}** is not running (status: ${mw.status}).`);
    // Log-based: the MultiServer log records every item send with a
    // timestamp, so no websocket connection (and no join/leave notice).
    const logFile = path.join(ctx.ap.multiworldDir(ctx.config, mw), 'server.log');
    const mySlots = ctx.db.getWorlds(ctx.userId).map((w) => w.slot);
    const mine = ctx.ap.parseItemSends(logFile).filter((s) => mySlots.includes(s.receiver));
    const prefs = ctx.db.getPreference(ctx.userId);
    const seen = prefs.lastReceivedIndex?.[mw.name] || 0;
    const scope = ctx.options.scope || 'new';
    const items = scope === 'all' ? mine : mine.slice(seen);
    ctx.db.setPreference(ctx.userId, 'lastReceivedIndex', { ...(prefs.lastReceivedIndex || {}), [mw.name]: mine.length });
    if (!items.length) {
      return scope === 'all'
        ? `You have not received any items yet in **${mw.name}**.`
        : `Nothing new since your last /received in **${mw.name}** (${mine.length} received in total — /received scope: all for the full list).`;
    }
    const header = scope === 'all'
      ? `**Items received by your slots (${mySlots.join(', ')})** (multiworld ${mw.name}) — full list (${mine.length}):`
      : `**Items received by your slots (${mySlots.join(', ')})** (multiworld ${mw.name}) — new since last check:`;
    const lines = [header];
    items.forEach((s, i) => {
      const idx = (scope === 'all' ? i : seen + i) + 1;
      lines.push(`• #${idx} **${s.item}** from **${s.sender}** (found at ${s.location})${s.at ? ` — ${s.at}` : ''}`);
    });
    return lines.join('\n');
  },

  async release(ctx) {
    // Host-only is enforced by PERMISSIONS before this handler runs.
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status !== 'running') throw new UserError(`Multiworld **${mw.name}** is not running (status: ${mw.status}).`);
    const opt = ctx.options.player;
    const mention = opt.match(/^<@!?(\d+)>$/);
    const slots = mention
      ? ctx.db.getWorlds(mention[1]).map((w) => w.slot)
      : [opt];
    if (!slots.length || !slots[0]) throw new UserError(`No registered player matches "${opt}".`);
    const replies = [];
    for (const slot of slots) {
      const res = await ctx.ap.say(ctx.config, mw, slot, '!release');
      if (res.replies?.length) replies.push(...res.replies);
    }
    const reply = replies.length ? `\nServer: ${replies.join(' ')}` : '';
    return `✅ Released ${slots.map((s2) => `**${s2}**`).join(', ')} in multiworld **${mw.name}** — all their remaining items are sent out.${reply}`;
  },

  async players(ctx) {
    const blockedTag = (userId) => (ctx.db.getPreference(userId).blocked ? ' 🔒 blocked' : '');
    if (ctx.options.multiworld) {
      const mw = resolveMultiworld(ctx, ctx.options.multiworld);
      const lines = [`**Players in "${mw.name}" (${userIdsOf(mw).length}):**`];
      // live connection status from one overview probe (single connection)
      let live = null;
      if (mw.status === 'running') {
        try {
          const ov = await ctx.ap.probe(ctx.config, mw, 'overview', null, 15000, multiworldSlots(ctx.db, mw));
          live = new Map(ov.players.map((p) => [p.name, p.status]));
        } catch { live = null; } // server unreachable — just omit statuses
      }
      for (const userId of userIdsOf(mw)) {
        for (const world of ctx.db.getWorlds(userId)) {
          const online = live && live.has(world.slot) ? ` — ${statusName(live.get(world.slot))}` : '';
          lines.push(`• <@${userId}> — slot **${world.slot}** (${world.game})${blockedTag(userId)}${online}`);
        }
      }
      if (!lines[1]) lines.push(`(none yet — players use /register multiworld: ${mw.name})`);
      return lines.join('\n');
    }
    const lines = ['**Registered players:**'];
    const entries = Object.entries(ctx.db.data.players);
    if (!entries.length) lines.push('(none yet — anyone can /register)');
    for (const userId of Object.keys(ctx.db.data.players)) {
      for (const world of ctx.db.getWorlds(userId)) {
        lines.push(`• <@${userId}> — **${world.slot}** (${world.game})${blockedTag(userId)}`);
      }
    }
    return lines.join('\n');
  },

  async 'setup-multiworld'(ctx) {
    const name = String(ctx.options.name || ctx.modal?.fields?.name || '').trim();
    if (!name) throw new UserError('Provide a multiworld name.');
    const password = ctx.options.password || ctx.modal?.fields?.password || null;
    const seedRaw = String(ctx.options.seed ?? ctx.modal?.fields?.seed ?? '').trim();
    if (seedRaw !== '' && !Number.isInteger(Number(seedRaw))) throw new UserError('Seed must be an integer.');
    const slug = ctx.ap.slugify(name);
    if (ctx.db.getMultiworld(slug)) throw new UserError(`A game named "${name}" already exists.`);
    // A new multiworld resets player registrations and their uploaded
    // yamls; everyone has to /register again for the new mw.
    ctx.db.clearPlayers();
    for (const existing of ctx.db.listMultiworlds()) {
      existing.userIds = [];
      ctx.db.setMultiworld(existing.name, existing);
    }
    fs.rmSync(path.join(ctx.config.dataDir, 'players'), { recursive: true, force: true });
    const mw = {
      name: slug,
      displayName: name,
      password: password || null,
      createdBy: ctx.userId,
      status: 'setup',
      userIds: [],
      requestedSeed: seedRaw || null,
      multidata: null,
      seed: null,
      seedNumber: null,
      port: null,
      pid: null,
      createdAt: new Date().toISOString(),
    };
    ctx.db.setMultiworld(slug, mw);
    return `Created multiworld **${slug}** (player registrations and yamls are reset — everyone must /register again). Next: players /register multiworld: ${slug} to join, hosts /upload-apworld, then /start — it generates the multiworld (seed ${seedRaw || 'random'}) and starts the server.`;
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
    return `Uploaded **${saved}** — apworlds are global and used by every multiworld (${all.length} stored: ${all.join(', ')}).`;
  },

  async start(ctx) {
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status === 'running' && ctx.ap.isServerProcessAlive(mw)) throw new UserError('This multiworld is already running.');
    const gen = await ensureGenerated(ctx, mw);
    let port = ctx.options.port;
    if (!port) {
      const used = new Set(ctx.db.listMultiworlds().map((g) => g.port).filter(Boolean));
      port = ctx.config.basePort;
      while (used.has(port)) port += 1;
    }
    const { pid, logFile } = ctx.ap.startMultiworld(ctx.config, ctx.db, mw, port);
    const up = await ctx.ap.waitForPort(port);
    if (!up) {
      ctx.ap.stopMultiworld(ctx.config, mw);
      throw new UserError(`Server did not start listening on port ${port}. See log: ${logFile}`);
    }
    mw.status = 'running';
    mw.port = port;
    mw.pid = pid;
    mw.startedAt = new Date().toISOString();
    ctx.db.setMultiworld(mw.name, mw);
    let fileNotes = [];
    try {
      fileNotes = await sendPlayerFiles(ctx, mw);
    } catch (err) {
      console.error(`[files] ${err.message}`);
    }
    return [
      gen ? `Generated multiworld for **${mw.name}** (seed ${mw.seedNumber}, id ${mw.seed}; players: ${gen.players.join(', ')}; spoiler: \`${mw.spoiler}\`).` : null,
      `Server for **${mw.name}** is running: \`${ctx.config.publicHost}:${port}\`${mw.password ? ' (password required)' : ' (no password)'}.`,
      `Seed: ${mw.seedNumber ?? mw.seed ?? '?'}, log: \`${logFile}\``,
      fileNotes.length ? `Player files posted in this channel:\n${fileNotes.map((n) => `• ${n}`).join('\n')}` : null,
    ].filter(Boolean).join('\n');
  },

  async stop(ctx) {
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    const stopped = ctx.ap.stopMultiworld(ctx.config, mw);
    mw.status = 'stopped';
    mw.stoppedAt = new Date().toISOString();
    ctx.db.setMultiworld(mw.name, mw);
    return stopped ? `Stopped multiworld **${mw.name}**.` : `Multiworld **${mw.name}** was not running.`;
  },

  async 'delete-multiworld'(ctx) {
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status === 'running') ctx.ap.stopMultiworld(ctx.config, mw);
    ctx.db.removeMultiworld(mw.name);
    fs.rmSync(ctx.ap.multiworldDir(ctx.config, mw), { recursive: true, force: true });
    return `Deleted multiworld **${mw.name}** (server stopped if it was running, multiworld and files removed).`;
  },

  async status(ctx) {
    if (ctx.options.multiworld) return formatMultiworldLine(ctx, resolveMultiworld(ctx, ctx.options.multiworld));
    const scope = ctx.options.scope || 'active';
    const all = ctx.db.listMultiworlds();
    const mws = all.filter((g) => (scope === 'all' ? true : scope === 'finished' ? g.status === 'stopped' : ACTIVE_STATUSES.has(g.status)));
    if (!all.length) return 'No multiworlds yet. A host can create one with /setup-multiworld.';
    if (!mws.length) {
      if (scope === 'finished') return 'No finished multiworlds. /status lists active multiworlds by default; /status scope: all lists everything.';
      return 'No active multiworlds (started or waiting to be started). Finished: /status scope: finished — everything: /status scope: all.';
    }
    const apworlds = ctx.ap.listApworlds(ctx.config);
    const header = scope === 'all' ? '**All multiworlds**' : scope === 'finished' ? '**Finished multiworlds**' : '**Active multiworlds** (started or waiting to be started)';
    const lines = [
      header,
      `Archipelago version: ${ctx.config.apVersion || 'unknown'} (players need clients/mods built for this version)`,
      `Available .apworld files (used by every multiworld): ${apworlds.length ? apworlds.join(', ') : 'none'}`,
    ];
    for (const g of mws) lines.push(formatMultiworldLine(ctx, g));
    return lines.join('\n');
  },

  async stats(ctx) {
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status !== 'running') throw new UserError(`Multiworld **${mw.name}** is not running (status: ${mw.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, mw, 'stats', null, 30000, multiworldSlots(ctx.db, mw));
    return formatStats(ctx.config, mw, probeResult);
  },

  async 'multiworld-stats'(ctx) {
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status !== 'running') throw new UserError(`Multiworld **${mw.name}** is not running (status: ${mw.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, mw, 'stats', null, 30000, multiworldSlots(ctx.db, mw));
    return formatGameStats(mw, probeResult);
  },

  async hints(ctx) {
    if (!ctx.config.hintsEnabled) throw new UserError('Hints are disabled on this bridge (HINTS_ENABLED=false).');
    const player = ctx.db.getPlayer(ctx.userId);
    if (!player) throw new UserError('You must /register first.');
    const mw = resolveMultiworld(ctx, ctx.options.multiworld);
    if (mw.status !== 'running') throw new UserError(`Multiworld **${mw.name}** is not running (status: ${mw.status}).`);
    const slots = multiworldSlots(ctx.db, mw);
    const stats = await ctx.ap.probe(ctx.config, mw, 'stats', null, 30000, slots);
    const me = stats.players.find((p) => p.name === player.slot);
    if (!me) throw new UserError(`Your slot "${player.slot}" was not found in the running multiworld.`);
    const probeResult = await ctx.ap.probe(ctx.config, mw, 'hints', me.slot, 30000, slots);
    const hints = probeResult.hints?.[me.slot] || [];
    if (!hints.length) return `No hints for **${player.slot}** in multiworld **${mw.name}** yet.`;
    const lines = [`**Hints for ${player.slot}** (multiworld ${mw.name}):`];
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
  if (customId === MODAL_SETUP_MULTIWORLD) return handlers['setup-multiworld'](ctx);
  throw new UserError('Unknown form.');
}
