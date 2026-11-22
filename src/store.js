import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ hosts: [], players: {}, worlds: {}, multiworlds: {}, preferences: {} });

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

  // A registered user can hold several worlds (slots), each from its own
  // yaml: players[userId] = { userId, slots: [slotName, ...] } and
  // worlds["<userId>:<slot>"] = { userId, slot, game }.
  getPlayer(userId) {
    const p = this.data.players[userId];
    if (!p) return null;
    const firstKey = `${userId}:${p.slots[0]}`;
    const first = this.data.worlds[firstKey] || {};
    return { userId, slots: [...p.slots], slot: p.slots[0], game: first.game };
  }

  setPlayer(userId, { slot, game }) {
    const key = `${userId}:${slot}`;
    this.data.worlds[key] = { userId, slot, game };
    const p = this.data.players[userId] || { userId, slots: [] };
    if (!p.slots.includes(slot)) p.slots.push(slot);
    this.data.players[userId] = p;
    this.save();
  }

  getWorlds(userId) {
    const p = this.data.players[userId];
    if (!p) return [];
    return p.slots.map((slot) => this.data.worlds[`${userId}:${slot}`]).filter(Boolean);
  }

  findWorldBySlot(slot) {
    return Object.values(this.data.worlds).find((w) => w.slot === slot) || null;
  }

  removePlayer(userId) {
    for (const slot of this.data.players[userId]?.slots || []) delete this.data.worlds[`${userId}:${slot}`];
    delete this.data.players[userId];
    this.save();
  }

  clearPlayers() {
    this.data.players = {};
    this.data.worlds = {};
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
