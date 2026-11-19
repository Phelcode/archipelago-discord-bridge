// Watches running games and DMs players who marked themselves "blocked"
// when new items are sent to them. Also advances each player's stored
// last-received index so /received (scope: new) only shows fresh items.
export async function pollRunningGames(config, db, apImpl, notify) {
  for (const game of db.listGames()) {
    if (game.status !== 'running' || !apImpl.isServerProcessAlive(game)) continue;
    const slots = (game.playerIds || []).map((id) => db.getPlayer(id)?.slot).filter(Boolean);
    let probeResult;
    try {
      probeResult = await apImpl.probe(config, game, 'received', null, 15000, slots);
    } catch (err) {
      console.error(`[watch] probe failed for game "${game.name}": ${err.message}`);
      continue;
    }
    for (const userId of game.playerIds || []) {
      const player = db.getPlayer(userId);
      if (!player) continue;
      const me = probeResult.players.find((p) => p.name === player.slot);
      if (!me) continue;
      const all = probeResult.received?.[me.slot] || [];
      const prefs = db.getPreference(userId);
      const seen = prefs.lastReceivedIndex?.[game.name] || 0;
      const fresh = all.slice(seen);
      db.setPreference(userId, 'lastReceivedIndex', { ...(prefs.lastReceivedIndex || {}), [game.name]: all.length });
      if (!fresh.length || !prefs.blocked) continue;
      for (const it of fresh) {
        await notify(userId, `🔔 You are marked blocked — **${it.sender_name}** sent you **${it.item}** (found at ${it.location}) in game **${game.name}**.`).catch((err) => {
          console.error(`[watch] could not DM ${userId}: ${err.message}`);
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
