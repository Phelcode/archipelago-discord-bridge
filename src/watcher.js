import fs from 'node:fs';
import path from 'node:path';
import { userIdsOf } from './store.js';

// Watches running games by tailing each game's MultiServer log — every item
// send is logged as "[MultiServer at <time>]: (Team #N) <sender> sent <item>
// to <receiver> (<location>)". No websocket connections, so no join/leave
// notices in mw. DMs blocked players when new items are sent to them and
// advances only the recipient's last-received index (keeps /received
// scope:new accurate).
export async function pollRunningMultiworlds(config, db, apImpl, notify) {
  for (const mw of db.listMultiworlds()) {
    if (mw.status !== 'running' || !apImpl.isServerProcessAlive(mw)) continue;
    const blocked = userIdsOf(mw)
      .filter((id) => db.getPlayer(id) && db.getPreference(id).blocked)
      .map((id) => ({ id, slots: db.getWorlds(id).map((w2) => w2.slot) }));
    if (!blocked.length) continue; // nobody blocked -> don't even read the log

    const logFile = path.join(apImpl.multiworldDir(config, mw), 'server.log');
    let text;
    try {
      text = fs.readFileSync(logFile, 'utf8');
    } catch {
      continue;
    }
    let offset = mw.logOffset || 0;
    if (offset > text.length) offset = 0; // log truncated (server restarted)
    const chunk = text.slice(offset);
    const lastNl = chunk.lastIndexOf('\n');
    if (lastNl < 0) continue;
    const complete = chunk.slice(0, lastNl + 1);
    mw.logOffset = offset + lastNl + 1;
    db.setMultiworld(mw.name, mw);

    const bySlot = new Map(blocked.flatMap((x) => x.slots.map((slot) => [slot, x.id])));
    for (const s of apImpl.parseItemSendsText(complete)) {
      const userId = bySlot.get(s.receiver);
      if (!userId) continue;
      const prefs = db.getPreference(userId);
      const seen = prefs.lastReceivedIndex?.[mw.name] || 0;
      db.setPreference(userId, 'lastReceivedIndex', { ...(prefs.lastReceivedIndex || {}), [mw.name]: seen + 1 });
      await notify(userId, `🔔 You are marked blocked — **${s.sender}** sent you **${s.item}** (found at ${s.location}) in multiworld **${mw.name}**${s.at ? ` — ${s.at}` : ''}.`).catch((err) => {
        console.error(`[watch] could not DM ${userId}: ${err.message}`);
      });
    }
  }
}

export function startWatcher(config, db, apImpl, notify, intervalMs = config.watchIntervalMs || 30000) {
  const timer = setInterval(() => {
    pollRunningMultiworlds(config, db, apImpl, notify).catch((err) => console.error('[watch] tick failed:', err.message));
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}
