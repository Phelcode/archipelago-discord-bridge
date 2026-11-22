import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ hosts: [], players: {}, multiworlds: {}, preferences: {} });

// (player, mw) memberships are unique: a Discord user appears at most once
// per mw, but may be in several games. Dedupe on read as well as on write.
export function userIdsOf(mw) {
  return [...new Set(mw.userIds || [])];
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...EMPTY(), ...parsed };
      this.data.preferences = this.data.preferences || {};
    } catch {
      this.data = EMPTY();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  isHost(userId) {
    return this.data.hosts.includes(userId);
  }

  addHost(userId) {
    if (!this.data.hosts.includes(userId)) {
      this.data.hosts.push(userId);
      this.save();
    }
  }

  removeHost(userId) {
    this.data.hosts = this.data.hosts.filter((id) => id !== userId);
    this.save();
  }

  getPlayer(userId) {
    return this.data.players[userId] || null;
  }

  setPlayer(userId, player) {
    this.data.players[userId] = player;
    this.save();
  }

  removePlayer(userId) {
    delete this.data.players[userId];
    this.save();
  }

  clearPlayers() {
    this.data.players = {};
    this.save();
  }

  getPreference(userId) {
    return this.data.preferences[userId] || {};
  }

  setPreference(userId, key, value) {
    this.data.preferences[userId] = { ...(this.data.preferences[userId] || {}), [key]: value };
    this.save();
  }

  getMultiworld(name) {
    return this.data.multiworlds[name] || null;
  }

  setMultiworld(name, mw) {
    this.data.multiworlds[name] = mw;
    this.save();
  }

  removeMultiworld(name) {
    delete this.data.multiworlds[name];
    this.save();
  }

  listMultiworlds() {
    return Object.values(this.data.multiworlds);
  }
}
