import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { roleOf, canHost, isOwner } from './permissions.js';
import * as ap from '../ap/manager.js';

export class UserError extends Error {}

const STRING = 3;
const INTEGER = 4;
const USER = 6;
const ATTACHMENT = 10;

const gameOption = (required) => ({
  name: 'game', description: 'Game session name', type: STRING, required,
});

export const COMMAND_DEFINITIONS = [
  { name: 'help', description: 'Show the commands available to your role' },
  {
    name: 'register',
    description: 'Register as a player by uploading your Archipelago player yaml',
    options: [
      { name: 'yaml', description: 'Your player .yaml file (or leave empty to get an upload dialog)', type: ATTACHMENT, required: false },
      { name: 'name', description: 'Slot name override (default: name inside the yaml)', type: STRING, required: false },
    ],
  },
  { name: 'unregister', description: 'Remove your player registration' },
  { name: 'me', description: 'Show your role and registration' },
  { name: 'join', description: 'Join a game session with your registered player yaml', options: [gameOption(true)] },
  { name: 'leave', description: 'Leave a game session', options: [gameOption(true)] },
  { name: 'players', description: 'List registered players (and players of a game)', options: [gameOption(false)] },
  {
    name: 'setup-game',
    description: '[host] Create a new game session',
    options: [
      { name: 'name', description: 'Name of the game session', type: STRING, required: true },
      { name: 'password', description: 'Server password for the game (optional)', type: STRING, required: false },
    ],
  },
  {
    name: 'upload-apworld',
    description: '[host] Upload a custom .apworld file to a game',
    options: [
      gameOption(true),
      { name: 'file', description: 'The .apworld file (or leave empty to get an upload dialog)', type: ATTACHMENT, required: false },
    ],
  },
  {
    name: 'generate',
    description: '[host] Generate the multiworld for a game from its players and apworlds',
    options: [gameOption(true), { name: 'seed', description: 'Seed (optional, random if omitted)', type: INTEGER, required: false }],
  },
  {
    name: 'start',
    description: '[host] Start the Archipelago server for a generated game',
    options: [gameOption(true), { name: 'port', description: 'Port to listen on (optional)', type: INTEGER, required: false }],
  },
  { name: 'stop', description: '[host] Stop the Archipelago server for a game', options: [gameOption(true)] },
  { name: 'status', description: 'Show game sessions and server status', options: [gameOption(false)] },
  { name: 'stats', description: 'Per-player stats: checks found / total and completion status', options: [gameOption(false)] },
  { name: 'game-stats', description: 'Gamewide stats: total checks, found, hints, seed', options: [gameOption(false)] },
  { name: 'hints', description: 'Show your hints (if hints are enabled)', options: [gameOption(false)] },
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
export const GUILD_COMMAND_DEF = { integration_types: [0], contexts: [0] };

export function globalCommandPayload(definitions) {
  return definitions.map((def) => ({
    ...def,
    integration_types: INTEGRATION_TYPES_BOTH,
    contexts: CONTEXTS_ALL,
  }));
}

export function guildCommandPayload(definitions) {
  return definitions.map((def) => ({ ...def, ...GUILD_COMMAND_DEF }));
}

export async function registerAllCommands(api, { guildId, definitions }) {
  await api.updateApplication({ integration_types: INTEGRATION_TYPES_BOTH });
  await api.registerCommands(globalCommandPayload(definitions));
  if (guildId) {
    await api.registerGuildCommands(guildId, guildCommandPayload(definitions));
  }
}

export const PERMISSIONS = {
  help: 'all',
  register: 'all',
  unregister: 'all',
  me: 'all',
  join: 'all',
  leave: 'all',
  players: 'all',
  'setup-game': 'host',
  'upload-apworld': 'host',
  generate: 'host',
  start: 'host',
  stop: 'host',
  role: 'owner',
  status: 'all',
  stats: 'all',
  'game-stats': 'all',
  hints: 'all',
};

export const EPHEMERAL_COMMANDS = new Set(['register', 'unregister', 'me', 'hints', 'role']);

// Modal fallback for file uploads: used when the slash command's attachment
// option was left empty. File Upload is component type 19 inside a Label
// (type 18); on submit, MODAL_SUBMIT (type 5) carries the file's attachment
// IDs in component.values, resolved via data.resolved.attachments.
export const MODAL_REGISTER = 'bridge_register';
export const MODAL_UPLOAD_APWORLD = 'bridge_upload_apworld';
export const MODAL_PERMISSIONS = { [MODAL_REGISTER]: 'all', [MODAL_UPLOAD_APWORLD]: 'host' };

const label = (text, description, component) => ({ type: 18, label: text, description, component });
const fileUploadField = (customId, labelText) =>
  label(labelText, 'Upload the file here', { type: 19, custom_id: customId, min_values: 1, max_values: 1, required: true });
const textField = (customId, labelText, { required = true, maxLength = 100 } = {}) =>
  label(labelText, undefined, { type: 4, custom_id: customId, style: 1, required, max_length: maxLength });

export function registerModalResponse() {
  return {
    type: 9,
    data: {
      custom_id: MODAL_REGISTER,
      title: 'Register as player',
      components: [
        fileUploadField('yaml', 'Player yaml file (.yaml)'),
        textField('name', 'Slot name override (optional)', { required: false }),
      ],
    },
  };
}

export function uploadApworldModalResponse() {
  return {
    type: 9,
    data: {
      custom_id: MODAL_UPLOAD_APWORLD,
      title: 'Upload .apworld',
      components: [
        textField('game', 'Game session name'),
        fileUploadField('file', '.apworld file'),
      ],
    },
  };
}

export function parseInteraction(interaction) {
  const data = interaction.data || {};
  if (interaction.type === 3) {
    const resolved = data.resolved || {};
    const parsed = { options: {}, attachments: {}, subcommand: null, subOptions: {}, modalCustomId: data.custom_id, modal: { fields: {}, files: {} } };
    const walk = (comp) => {
      if (!comp || typeof comp !== 'object') return;
      if (comp.type === 18 && comp.component) return walk(comp.component); // Label wrapper
      if (comp.type === 1 && Array.isArray(comp.components)) { comp.components.forEach(walk); return; } // legacy action row
      if (comp.type === 19 || comp.type === 11) { // file upload
        parsed.modal.files[comp.custom_id] = (comp.values || [])
          .map((id) => resolved.attachments?.[id])
          .filter(Boolean);
      } else if (comp.type === 4) { // text input
        parsed.modal.fields[comp.custom_id] = comp.value;
      }
    };
    (data.components || []).forEach(walk);
    return parsed;
  }
  const resolved = data.resolved || {};
  const parsed = { options: {}, attachments: {}, subcommand: null, subOptions: {} };
  const top = data.options || [];
  const sub = top.find((o) => o.type === 1);
  if (sub) {
    parsed.subcommand = sub.name;
    for (const opt of sub.options || []) {
      if (opt.type === USER) parsed.subOptions[opt.name] = resolved.users?.[opt.value]?.id || opt.value;
      else parsed.subOptions[opt.name] = opt.value;
    }
    return parsed;
  }
  for (const opt of top) {
    if (opt.type === ATTACHMENT) {
      const att = resolved.attachments?.[opt.value];
      if (att) parsed.attachments[opt.name] = att;
    } else if (opt.type === USER) {
      parsed.options[opt.name] = resolved.users?.[opt.value]?.id || opt.value;
    } else {
      parsed.options[opt.name] = opt.value;
    }
  }
  return parsed;
}

const STATUS_NAMES = { 0: 'offline', 5: 'connected', 10: 'ready', 20: 'playing', 30: 'goal reached' };

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

function formatStats(config, db, game, probeResult) {
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

function formatGameStats(config, db, game, probeResult) {
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
  async help(ctx) {
    const role = roleOf(ctx.db, ctx.config, ctx.userId);
    const lines = [`**Your role: ${role}**`, '', '**Commands**', '• /help — this list', '• /register — upload your player yaml (anyone)', '• /unregister, /me, /join, /leave, /players', '• /status, /stats, /game-stats — everyone (spectator view)'];
    if (role === 'player' || role === 'host' || role === 'owner') lines.push('• /hints — your hints for the running game');
    if (canHost(ctx.db, ctx.config, ctx.userId)) lines.push('• /setup-game, /upload-apworld, /generate, /start, /stop — host commands');
    if (isOwner(ctx.config, ctx.userId)) lines.push('• /role add|remove|list — owner only');
    return lines.join('\n');
  },

  async register(ctx) {
    const att = ctx.attachments.yaml || ctx.modal?.files?.yaml?.[0];
    if (!att) throw new UserError('Attach a .yaml file with the "yaml" option or via the upload dialog.');
    if (!/\.ya?ml$/i.test(att.filename)) throw new UserError(`"${att.filename}" is not a .yaml file.`);
    if (att.size > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const buffer = await ctx.api.downloadAttachment(att.url);
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

  async me(ctx) {
    const role = roleOf(ctx.db, ctx.config, ctx.userId);
    const player = ctx.db.getPlayer(ctx.userId);
    return [`**Role:** ${role}`, player ? `**Registered as:** ${player.slot} (game: ${player.game})` : '**Not registered as a player** (use /register)'].join('\n');
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
    if (ctx.options.game) {
      const game = resolveGame(ctx, ctx.options.game);
      const lines = [`**Players in "${game.name}" (${(game.playerIds || []).length}):**`];
      for (const userId of game.playerIds || []) {
        const p = ctx.db.getPlayer(userId);
        lines.push(`• <@${userId}> — slot ${p ? `**${p.slot}** (${p.game})` : '(registration missing)'}`);
      }
      if (!lines[1]) lines.push('(none yet — players use /join)');
      return lines.join('\n');
    }
    const lines = ['**Registered players:**'];
    const entries = Object.entries(ctx.db.data.players);
    if (!entries.length) lines.push('(none yet — anyone can /register)');
    for (const [userId, p] of entries) lines.push(`• <@${userId}> — **${p.slot}** (${p.game})`);
    return lines.join('\n');
  },

  async 'setup-game'(ctx) {
    const name = String(ctx.options.name || '').trim();
    if (!name) throw new UserError('Provide a game name.');
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
      password: ctx.options.password || null,
      createdBy: ctx.userId,
      status: 'setup',
      apworlds: [],
      playerIds: [],
      multidata: null,
      seed: null,
      port: null,
      pid: null,
      createdAt: new Date().toISOString(),
    };
    ctx.db.setGame(slug, game);
    return `Created game **${slug}** (previous player registrations and yamls were discarded — everyone must /register again). Next: players /register and /join, hosts /upload-apworld, then /generate.`;
  },

  async 'upload-apworld'(ctx) {
    const game = resolveGame(ctx, ctx.options.game || ctx.modal?.fields?.game);
    const att = ctx.attachments.file || ctx.modal?.files?.file?.[0];
    if (!att) throw new UserError('Attach a .apworld file with the "file" option or via the upload dialog.');
    if (att.size > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    const buffer = await ctx.api.downloadAttachment(att.url);
    if (buffer.length > ctx.config.maxAttachmentBytes) throw new UserError('File is too large.');
    validateApworld(att.filename, buffer);
    const saved = ctx.ap.saveApworld(ctx.config, game, att.filename, buffer);
    ctx.db.setGame(game.name, game);
    return `Uploaded **${saved}** to game **${game.name}** (${game.apworlds.length} apworld(s) total).`;
  },

  async generate(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status === 'running') throw new UserError('This game is running; /stop it first.');
    game.status = 'generating';
    ctx.db.setGame(game.name, game);
    const result = await ctx.ap.generateGame(ctx.config, ctx.db, game, ctx.options.seed);
    game.status = 'generated';
    game.multidata = result.multidata;
    game.spoiler = result.spoiler;
    game.seed = result.seed;
    game.seedNumber = result.seedNumber;
    game.generatedAt = new Date().toISOString();
    ctx.db.setGame(game.name, game);
    return [
      `Generated multiworld for **${game.name}** (seed ${result.seedNumber}, id ${result.seed}).`,
      `Players (${result.players.length}): ${result.players.join(', ')}`,
      `Multidata: \`${result.multidata}\``,
      `Spoiler log: \`${result.spoiler}\``,
      'Start it with /start.',
    ].join('\n');
  },

  async start(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status === 'running' && ctx.ap.isServerProcessAlive(game)) throw new UserError('This game is already running.');
    let port = ctx.options.port;
    if (!port) {
      const used = new Set(db_ports(ctx.db));
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
      `Server for **${game.name}** is running: \`${ctx.config.publicHost}:${port}\`${game.password ? ' (password required)' : ' (no password)'}.`,
      `Seed: ${game.seed ?? '?'}, log: \`${logFile}\``,
    ].join('\n');
  },

  async stop(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    const stopped = ctx.ap.stopGame(ctx.config, game);
    game.status = 'stopped';
    game.stoppedAt = new Date().toISOString();
    ctx.db.setGame(game.name, game);
    return stopped ? `Stopped game **${game.name}**.` : `Game **${game.name}** was not running.`;
  },

  async status(ctx) {
    const game = ctx.options.game ? resolveGame(ctx, ctx.options.game) : null;
    const games = game ? [game] : ctx.db.listGames();
    if (!games.length) return 'No games yet. A host can create one with /setup-game.';
    const lines = [];
    for (const g of games) {
      const alive = g.status === 'running' && ctx.ap.isServerProcessAlive(g);
      const players = (g.playerIds || []).map((id) => ctx.db.getPlayer(id)?.slot || id).join(', ') || 'none';
      lines.push([
        `**${g.name}** — status: ${alive ? 'running' : g.status}${alive && g.port ? ` on ${ctx.config.publicHost}:${g.port}` : ''}`,
        `  players: ${players} | apworlds: ${g.apworlds?.length ? g.apworlds.join(', ') : 'none'} | seed: ${g.seed ?? 'not generated'}`,
      ].join('\n'));
    }
    return lines.join('\n');
  },

  async stats(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status !== 'running') throw new UserError(`Game **${game.name}** is not running (status: ${game.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, game, 'stats', null, 30000, gamePlayerSlots(ctx.db, game));
    return formatStats(ctx.config, ctx.db, game, probeResult);
  },

  async 'game-stats'(ctx) {
    const game = resolveGame(ctx, ctx.options.game);
    if (game.status !== 'running') throw new UserError(`Game **${game.name}** is not running (status: ${game.status}).`);
    const probeResult = await ctx.ap.probe(ctx.config, game, 'stats', null, 30000, gamePlayerSlots(ctx.db, game));
    return formatGameStats(ctx.config, ctx.db, game, probeResult);
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
      const lines = [`**Roles**`, `• owner: <@${ctx.config.discordOwnerId}> (from .env)`];
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

function db_ports(db) {
  return db.listGames().map((g) => g.port).filter(Boolean);
}

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
  throw new UserError('Unknown form.');
}
