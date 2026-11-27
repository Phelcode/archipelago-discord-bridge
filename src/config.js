import fs from 'node:fs';
import path from 'node:path';

// The AP version that generated seeds embed; players' clients/mods must be
// built for this version. Auto-detected from the synced AP checkout so the
// probe's protocol version always matches the generator/server in use,
// whatever AP branch/tag was synced. AP_VERSION env wins.
function detectApVersion(apDir) {
  try {
    const match = fs.readFileSync(path.join(apDir, 'Utils.py'), 'utf8').match(/^__version__\s*=\s*"([^"]+)"/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export function loadConfig(env = process.env) {
  const required = ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_OWNER_ID'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const apDir = path.resolve(env.AP_DIR || '/opt/Archipelago');
  return {
    discordToken: env.DISCORD_TOKEN,
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordOwnerId: env.DISCORD_OWNER_ID,
    // Comma-separated guild IDs where commands are additionally registered as
    // guild commands (instant updates there). Does not restrict where the app
    // answers — DMs and other guilds work regardless.
    discordGuildIds: (env.DISCORD_GUILD_ID || '').split(',').map((s) => s.trim()).filter(Boolean),
    port: Number(env.PORT || 3000),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    apDir,
    apPython: env.AP_PYTHON || '/opt/ap-venv/bin/python',
    apProbeScript: path.resolve(env.AP_PROBE_SCRIPT || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'ap_probe.py')),
    apVersion: env.AP_VERSION || detectApVersion(apDir) || '0.6.9',
    hintsEnabled: (env.HINTS_ENABLED ?? 'true').toLowerCase() !== 'false',
    basePort: Number(env.BASE_PORT || 38281),
    publicHost: env.AP_SERVER_HOST || 'localhost',
    maxAttachmentBytes: Number(env.MAX_ATTACHMENT_MB || 25) * 1024 * 1024,
    watchIntervalMs: Number(env.WATCH_INTERVAL_MS || 30000),
  };
}
