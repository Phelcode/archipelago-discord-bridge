import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ hosts: [], players: {}, games: {} });

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

  getGame(name) {
    return this.data.games[name] || null;
  }

  setGame(name, game) {
    this.data.games[name] = game;
    this.save();
  }

  removeGame(name) {
    delete this.data.games[name];
    this.save();
  }

  listGames() {
    return Object.values(this.data.games);
  }
}
