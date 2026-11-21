import fs from 'node:fs';
import path from 'node:path';
import { playerIdsOf } from './store.js';

// Watches running games by tailing each game's MultiServer log — every item
// send is logged as "[MultiServer at <time>]: (Team #N) <sender> sent <item>
// to <receiver> (<location>)". No websocket connections, so no join/leave
// notices in game. DMs blocked players when new items are sent to them and
// advances only the recipient's last-received index (keeps /received
// scope:new accurate).
export async function pollRunningGames(config, db, apImpl, notify) {
  for (const game of db.listGames()) {
    if (game.status !== 'running' || !apImpl.isServerProcessAlive(game)) continue;
    const blocked = playerIdsOf(game)
      .map((id) => ({ id, player: db.getPlayer(id) }))
      .filter((x) => x.player && db.getPreference(x.id).blocked);
    if (!blocked.length) continue; // nobody blocked -> don't even read the log

    const logFile = path.join(apImpl.gameDir(config, game), 'server.log');
    let text;
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch {
      continue;
    }
    let offset = game.logOffset || 0;
    if (offset > text.length) offset = 0; // log truncated (server restarted)
    const chunk = text.slice(offset);
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) continue;
    const complete = chunk.slice(0, lastNl + 1);
    game.logOffset = offset + lastNl + 1;
    db.setGame(game.name, game);

    const bySlot = new Map(blocked.map((x) => [x.player.slot, x.id]));
    for (const s of apImpl.parseItemSendsText(complete)) {
      const userId = bySlot.get(s.receiver);
      if (!userId) continue;
      const prefs = db.getPreference(userId);
      const seen = prefs.lastReceivedIndex?.[game.name] || 0;
      db.setPreference(userId, 'lastReceivedIndex', { ...(prefs.lastReceivedIndex || {}), [game.name]: seen + 1 });
      await notify(userId, `🔔 You are marked blocked — **${s.sender}** sent you **${s.item}** (found at ${s.location}) in game **${game.name}** — ${s.at}.`).catch((err) => {
        console.error(`[watch] could not DM ${userId}: ${err.message}`);
      });
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
