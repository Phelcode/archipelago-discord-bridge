import { playerIdsOf } from './store.js';

// Watches running games and DMs players who marked themselves "blocked"
// when new items are sent to them. Only the recipient's stored last-received
// index advances, which keeps /received (scope: new) accurate.
//
// Connecting as a slot makes the AP server broadcast join/leave notices, so
// games with no blocked players are not probed at all, and when probing we
// only connect as the blocked players' slots.
export async function pollRunningGames(config, db, apImpl, notify) {
  for (const game of db.listGames()) {
    if (game.status !== 'running' || !apImpl.isServerProcessAlive(game)) continue;
    const blocked = playerIdsOf(game)
      .map((id) => ({ id, player: db.getPlayer(id) }))
      .filter((x) => x.player && db.getPreference(x.id).blocked);
    if (!blocked.length) continue;
    const slots = blocked.map((x) => x.player.slot);
    let probeResult;
    try {
      probeResult = await apImpl.probe(config, game, 'received', null, 15000, slots, slots);
    } catch (err) {
      console.error(`[watch] probe failed for game "${game.name}": ${err.message}`);
      continue;
    }
    for (const { id, player } of blocked) {
      const me = probeResult.players.find((p) => p.name === player.slot);
      if (!me) continue;
      const all = probeResult.received?.[me.slot] || [];
      const prefs = db.getPreference(id);
      const seen = prefs.lastReceivedIndex?.[game.name] || 0;
      const fresh = all.slice(seen);
      if (!fresh.length) continue;
      db.setPreference(id, 'lastReceivedIndex', { ...(prefs.lastReceivedIndex || {}), [game.name]: all.length });
      for (const it of fresh) {
        await notify(id, `🔔 You are marked blocked — **${it.sender_name}** sent you **${it.item}** (found at ${it.location}) in game **${game.name}**.`).catch((err) => {
          console.error(`[watch] could not DM ${id}: ${err.message}`);
        });
      }
    }
  }
}

export function startWatcher(config, db, apImpl, notify, intervalMs = config.watchIntervalMs || 30000) {
  const timer = setInterval(() => {
    pollRunningGames(config, db, apImpl, notify).catch((err) => console.error('[watch] tick failed:', err.message));
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
