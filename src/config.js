import path from 'node:path';

export function loadConfig(env = process.env) {
  const useGateway = (env.DISCORD_GATEWAY ?? 'true').toLowerCase() !== 'false';
  // The public key is only needed to verify HTTP interactions endpoint
  // signatures; in gateway mode interactions arrive over the websocket.
  const required = useGateway
    ? ['DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_OWNER_ID']
    : ['DISCORD_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID', 'DISCORD_OWNER_ID'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    discordToken: env.DISCORD_TOKEN,
    discordPublicKey: env.DISCORD_PUBLIC_KEY || null,
    useGateway,
    gatewayIntents: Number(env.DISCORD_INTENTS ?? 0),
    gatewayUrl: env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json',
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordOwnerId: env.DISCORD_OWNER_ID,
    discordGuildId: env.DISCORD_GUILD_ID || null,
    discordApiBase: env.DISCORD_API_BASE || 'https://discord.com/api/v10',
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
  };
}
