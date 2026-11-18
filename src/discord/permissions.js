export function roleOf(db, config, userId) {
  if (userId === config.discordOwnerId) return 'owner';
  if (db.isHost(userId)) return 'host';
  if (db.getPlayer(userId)) return 'player';
  return 'spectator';
}

export function canHost(db, config, userId) {
  return userId === config.discordOwnerId || db.isHost(userId);
}

export function isOwner(config, userId) {
  return userId === config.discordOwnerId;
}
