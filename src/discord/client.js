import { Client, Events } from 'discord.js';
import { createDispatcher } from './dispatch.js';

// The whole Discord transport is discord.js: gateway connection (heartbeat,
// resume, sharding all handled by the library), command registration, and
// interaction dispatch. We request no intents — INTERACTION_CREATE needs none.
export function createDiscordClient({ config, db, download }) {
  const client = new Client({ intents: [] });
  const dispatch = createDispatcher({ config, db, download });
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[gateway] ready as ${readyClient.user.tag} (${readyClient.user.id})`);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    dispatch(interaction).catch((err) => console.error('Interaction handling failed:', err));
  });
  client.on(Events.Error, (err) => console.error('[gateway] client error:', err.message));
  client.on(Events.ShardError, (err) => console.error('[gateway] shard error:', err.message));
  client.on(Events.ShardDisconnect, (event) => console.warn(`[gateway] shard disconnected (${event.code}), discord.js will reconnect`));
  client.on(Events.ShardReconnecting, () => console.warn('[gateway] shard reconnecting'));
  return client;
}
