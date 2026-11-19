import path from 'node:path';

export function loadConfig(env = process.env) {
  const required = ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_OWNER_ID'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    discordToken: env.DISCORD_TOKEN,
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordOwnerId: env.DISCORD_OWNER_ID,
    discordGuildId: env.DISCORD_GUILD_ID || null,
    port: Number(env.PORT || 3000),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    apDir: path.resolve(env.AP_DIR || '/opt/Archipelago'),
    apPython: env.AP_PYTHON || '/opt/ap-venv/bin/python',
    apProbeScript: path.resolve(env.AP_PROBE_SCRIPT || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'ap_probe.py')),
    apVersion: env.AP_VERSION || '0.6.9',
    hintsEnabled: (env.HINTS_ENABLED ?? 'true').toLowerCase() !== 'false',
    basePort: Number(env.BASE_PORT || 38281),
    publicHost: env.AP_SERVER_HOST || 'localhost',
    maxAttachmentBytes: Number(env.MAX_ATTACHMENT_MB || 25) * 1024 * 1024,
    watchIntervalMs: Number(env.WATCH_INTERVAL_MS || 30000),
  };
}
