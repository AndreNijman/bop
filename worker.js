// The BOP relay.
//
// Server authoritative on purpose. A physics brawler where players shove each
// other into the void cannot let clients own their own position - one liar and
// the round is meaningless. So the Durable Object runs sim.js at a fixed 60 Hz,
// clients send nothing but intent, and the relay broadcasts state at 15 Hz.
// The client runs the same sim.js forward between snapshots for smoothness.
//
//   GET /health   - liveness
//   GET /lobbies  - public lobby directory
//   GET /ws?room= - websocket, first message must be create or join

import { TUNE, ABILITIES, ABILITY_BY_ID, MAPS, COLORS, BOT_NAMES } from './data.js';
import { createWorld, step, applyInput, snapshot } from './sim.js';
import { createBrain, driveBot } from './bots.js';

const TICK_MS = 1000 / 60;
const SNAPSHOT_EVERY = 4;                 // 15 Hz
const ROOM_TTL = 45 * 60_000;
const HANDSHAKE_MS = 12_000;
const MAX_MESSAGE = 4096;
const PRODUCTION_ORIGIN = 'https://bop.andrenijman.com';
const encoder = new TextEncoder();

function clamp(v, min, max) { return v < min ? min : v > max ? max : v; }

function cleanName(value, fallback = 'bopl', max = 14) {
  const name = String(value || '').replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  return name || fallback;
}

function roomKey(value) {
  return String(value || '').replace(/[^a-z0-9 _-]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 24).toLowerCase();
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}

async function hash(value) {
  const text = String(value || '').slice(0, 64);
  if (!text) return '';
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function originAllowed(origin) {
  if (!origin || origin === 'null' || origin === PRODUCTION_ORIGIN) return true;
  try {
    const url = new URL(origin);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
    return url.hostname.endsWith('.andrenijman.com') || url.hostname.endsWith('.workers.dev');
  } catch { return false; }
}

// A tiny non-crypto PRNG for map and draft choices. Seeded per room so a replay
// of the same seed produces the same match.
function rng(seed) {
  let s = (seed | 0) || 1;
  return () => { s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0; return ((s >>> 0) % 1000000) / 1000000; };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      } });
    }
    if (url.pathname === '/health') return json({ ok: true, service: 'bop-relay', abilities: ABILITIES.length, maps: MAPS.length });
    if (url.pathname === '/lobbies') return env.REGISTRY.getByName('global').fetch(new Request('https://registry/list'));
    if (url.pathname !== '/ws') return new Response('bop relay. connect over websocket at /ws\n', { status: 404 });
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 });
    if (!originAllowed(request.headers.get('Origin'))) return new Response('origin not allowed', { status: 403 });
    const key = roomKey(url.searchParams.get('room'));
    if (key.length < 3) return new Response('lobby names need at least 3 characters', { status: 400 });
    return env.ROOMS.getByName(key).fetch(request);
  },
};

export class LobbyRegistry {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/list') {
      const entries = await this.ctx.storage.list({ prefix: 'room:' });
      const now = Date.now();
      const lobbies = [];
      for (const [key, value] of entries) {
        if (!value.updated || now - value.updated > 90_000) { await this.ctx.storage.delete(key); continue; }
        lobbies.push({ ...value, joinable: value.players < value.max });
      }
      lobbies.sort((a, b) => (b.joinable - a.joinable) || (b.players - a.players) || (b.updated - a.updated));
      return json({ lobbies: lobbies.slice(0, 40) });
    }
    const body = await request.json();
    const key = `room:${body.key}`;
    if (path === '/upsert') { await this.ctx.storage.put(key, body.lobby); return new Response(null, { status: 204 }); }
    if (path === '/remove') { await this.ctx.storage.delete(key); return new Response(null, { status: 204 }); }
    return new Response('not found', { status: 404 });
  }
}

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sessions = new Map();
    this.roster = new Map();          // pid -> player record (humans and bots)
    this.room = '';
    this.key = '';
    this.host = -1;
    this.password = '';
    this.settings = { max: 6, bots: 3, wins: TUNE.winsToTake };
    this.phase = 'lobby';             // lobby | draft | round | done
    this.round = 0;
    this.nextPid = 1;
    this.world = null;
    this.brains = new Map();
    this.sent = new Set();
    this.offers = new Map();
    this.picks = new Map();
    this.deadline = 0;
    this.timer = null;
    this.accumulator = 0;
    this.lastTick = 0;
    this.tickCount = 0;
    this.touched = Date.now();
    this.seed = (Date.now() ^ 0x5f3759df) | 0;
    this.rand = rng(this.seed);
    this.mapHistory = [];
  }

  // -- plumbing ------------------------------------------------------------

  async fetch(request) {
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept();
    const session = { socket: server, pid: -1, ready: false, chat: [], queue: Promise.resolve() };
    this.sessions.set(server, session);
    this.touched = Date.now();
    const timeout = setTimeout(() => { if (!session.ready) server.close(1008, 'handshake timeout'); }, HANDSHAKE_MS);
    server.addEventListener('message', event => {
      session.queue = session.queue.then(() => this.onMessage(session, event.data)).catch(error => {
        console.error(error);
        this.send(server, { t: 'err', m: 'relay error' });
      });
    });
    server.addEventListener('close', () => { clearTimeout(timeout); this.drop(session); });
    server.addEventListener('error', () => this.drop(session));
    this.ensureTimer();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(socket, message) { if (socket.readyState === 1) socket.send(JSON.stringify(message)); }

  broadcast(message) {
    const encoded = JSON.stringify(message);
    for (const session of this.sessions.values()) {
      if (session.ready && session.socket.readyState === 1) session.socket.send(encoded);
    }
  }

  ensureTimer() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  reset() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.removeRegistry();
    this.roster.clear();
    this.brains.clear();
    this.sent.clear();
    this.offers.clear();
    this.picks.clear();
    this.world = null;
    this.phase = 'lobby';
    this.round = 0;
    this.host = -1;
    this.room = '';
    this.key = '';
    this.password = '';
  }

  // -- membership ----------------------------------------------------------

  async onMessage(session, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE) return;
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    this.touched = Date.now();

    if (!session.ready) { await this.handshake(session, message); return; }
    const record = this.roster.get(session.pid);
    if (!record) return;

    switch (message.t) {
      case 'input': {
        const player = this.world?.players.find(p => p.pid === session.pid);
        if (player && this.phase === 'round') {
          applyInput(player, {
            mx: message.mx, jump: message.jump, ax: message.ax, ay: message.ay,
            ab: Array.isArray(message.ab) ? message.ab.slice(0, TUNE.slots) : [],
          });
        }
        return;
      }
      case 'start': {
        if (session.pid !== this.host || this.phase !== 'lobby') return;
        this.beginMatch();
        return;
      }
      case 'pick': {
        if (this.phase !== 'draft') return;
        const offer = this.offers.get(session.pid);
        const id = String(message.ability || '');
        if (!offer || !offer.includes(id)) return;
        const slot = clamp(Math.floor(Number(message.slot) || 0), 0, TUNE.slots - 1);
        this.picks.set(session.pid, { ability: id, slot });
        this.broadcastDraft();
        if ([...this.roster.keys()].every(pid => this.picks.has(pid))) this.startRound();
        return;
      }
      case 'again': {
        if (session.pid !== this.host || this.phase !== 'done') return;
        for (const record of this.roster.values()) { record.wins = 0; record.abilities = []; }
        this.round = 0;
        this.beginMatch();
        return;
      }
      case 'lobby': {
        if (session.pid !== this.host || this.phase === 'round') return;
        this.phase = 'lobby';
        this.world = null;
        this.round = 0;
        for (const record of this.roster.values()) { record.wins = 0; record.abilities = []; }
        this.syncBots();
        this.sendLobby();
        this.syncRegistry();
        return;
      }
      case 'name': {
        record.name = cleanName(message.name, record.name);
        this.sendLobby();
        return;
      }
      case 'settings': {
        if (session.pid !== this.host || this.phase !== 'lobby') return;
        this.settings.max = clamp(Math.round(Number(message.max) || this.settings.max), 2, TUNE.maxPlayers);
        this.settings.bots = clamp(Math.round(Number(message.bots) ?? this.settings.bots), 0, TUNE.maxPlayers - 1);
        this.settings.wins = clamp(Math.round(Number(message.wins) || this.settings.wins), 1, 15);
        this.syncBots();
        this.sendLobby();
        this.syncRegistry();
        return;
      }
      case 'chat': {
        const now = Date.now();
        session.chat = session.chat.filter(at => now - at < 5000);
        if (session.chat.length >= 5) return;
        session.chat.push(now);
        const text = String(message.m || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 120);
        if (text) this.broadcast({ t: 'chat', name: record.name, m: text });
        return;
      }
      case 'ping': this.send(session.socket, { t: 'pong', c: message.c }); return;
    }
  }

  async handshake(session, message) {
    if (message.t !== 'create' && message.t !== 'join') {
      this.send(session.socket, { t: 'err', m: 'send create or join first' });
      session.socket.close(1008);
      return;
    }
    const requested = cleanName(message.room, '', 24);
    const key = roomKey(requested);
    if (key.length < 3) { this.reject(session, 'lobby names need at least 3 characters'); return; }

    if (message.t === 'create') {
      if (this.roster.size) { this.reject(session, 'a lobby with that name already exists'); return; }
      this.room = requested;
      this.key = key;
      this.password = await hash(message.password || '');
      this.settings.max = clamp(Math.round(Number(message.settings?.max) || 6), 2, TUNE.maxPlayers);
      this.settings.bots = clamp(Math.round(Number(message.settings?.bots) ?? 3), 0, TUNE.maxPlayers - 1);
      this.settings.wins = clamp(Math.round(Number(message.settings?.wins) || TUNE.winsToTake), 1, 15);
    } else {
      if (!this.roster.size || !this.key) { this.reject(session, 'no lobby has that name'); return; }
      const humans = [...this.roster.values()].filter(r => !r.bot).length;
      if (humans >= this.settings.max) { this.reject(session, 'that lobby is full'); return; }
      if (this.password && !constantTimeEqual(this.password, await hash(message.password || ''))) {
        this.reject(session, 'wrong lobby password');
        return;
      }
    }

    const pid = this.nextPid++;
    const used = new Set([...this.roster.values()].map(r => r.color));
    let color = 0;
    while (used.has(color) && color < COLORS.length - 1) color++;
    const record = {
      pid, name: cleanName(message.name), color, bot: false, wins: 0,
      abilities: [], joinedRound: this.round,
    };
    this.roster.set(pid, record);
    session.pid = pid;
    session.ready = true;
    if (this.host < 0) this.host = pid;
    this.syncBots();

    this.send(session.socket, { t: 'welcome', you: pid, room: this.room, host: this.host === pid, tune: { slots: TUNE.slots } });
    this.sendLobby();
    if (this.phase === 'round' && this.world) { this.send(session.socket, this.beginPayload()); this.sendFull(session); }
    if (this.phase === 'draft') this.broadcastDraft();
    await this.syncRegistry();
  }

  reject(session, reason) {
    this.send(session.socket, { t: 'err', m: reason });
    setTimeout(() => session.socket.close(1008, reason), 25);
  }

  drop(session) {
    this.sessions.delete(session.socket);
    if (session.pid < 0) return;
    this.roster.delete(session.pid);
    this.offers.delete(session.pid);
    this.picks.delete(session.pid);
    if (this.world) {
      const player = this.world.players.find(p => p.pid === session.pid);
      if (player) { player.alive = false; player.leftover = true; }
    }
    const humans = [...this.roster.values()].filter(r => !r.bot);
    if (!humans.length) { this.reset(); return; }
    if (session.pid === this.host) this.host = humans[0].pid;
    this.syncBots();
    this.sendLobby();
    this.syncRegistry();
    if (this.phase === 'draft' && [...this.roster.keys()].every(pid => this.picks.has(pid))) this.startRound();
  }

  // Keep the bot count topped up to the requested figure.
  syncBots() {
    const humans = [...this.roster.values()].filter(r => !r.bot);
    const bots = [...this.roster.values()].filter(r => r.bot);
    const want = clamp(this.settings.bots, 0, Math.max(0, TUNE.maxPlayers - humans.length));
    while (bots.length > want) {
      const gone = bots.pop();
      this.roster.delete(gone.pid);
      this.brains.delete(gone.pid);
    }
    while (bots.length < want) {
      const pid = this.nextPid++;
      const used = new Set([...this.roster.values()].map(r => r.color));
      let color = 0;
      while (used.has(color) && color < COLORS.length - 1) color++;
      const record = {
        pid, name: BOT_NAMES[(pid * 5) % BOT_NAMES.length], color, bot: true, wins: 0,
        abilities: [], joinedRound: this.round,
      };
      this.roster.set(pid, record);
      bots.push(record);
    }
  }

  sendLobby() {
    this.broadcast({
      t: 'lobby', room: this.room, host: this.host, phase: this.phase, round: this.round,
      settings: this.settings, max: TUNE.maxPlayers,
      players: [...this.roster.values()].map(r => ({
        pid: r.pid, name: r.name, color: r.color, bot: r.bot, wins: r.wins, abilities: r.abilities,
      })),
    });
  }

  async syncRegistry() {
    if (!this.key) return;
    const humans = [...this.roster.values()].filter(r => !r.bot).length;
    const lobby = {
      name: this.room, key: this.key, players: humans, bots: this.settings.bots,
      max: this.settings.max, locked: !!this.password, phase: this.phase,
      round: this.round, wins: this.settings.wins, updated: Date.now(),
    };
    await this.env.REGISTRY.getByName('global').fetch(new Request('https://registry/upsert', {
      method: 'POST', body: JSON.stringify({ key: this.key, lobby }),
    }));
  }

  async removeRegistry() {
    if (!this.key) return;
    await this.env.REGISTRY.getByName('global').fetch(new Request('https://registry/remove', {
      method: 'POST', body: JSON.stringify({ key: this.key }),
    })).catch(() => {});
  }

  // -- match flow ----------------------------------------------------------

  beginMatch() {
    this.round = 0;
    for (const record of this.roster.values()) { record.wins = 0; record.abilities = []; }
    this.startDraft();
  }

  startDraft() {
    this.phase = 'draft';
    this.world = null;
    this.offers.clear();
    this.picks.clear();
    const replacing = this.round >= TUNE.slots;
    for (const record of this.roster.values()) {
      const pool = ABILITIES.map(a => a.id).filter(id => !record.abilities.includes(id));
      const offer = [];
      while (offer.length < 3 && pool.length) {
        offer.push(pool.splice(Math.floor(this.rand() * pool.length) % pool.length, 1)[0]);
      }
      this.offers.set(record.pid, offer);
      if (record.bot) {
        // Bots take the first offer and overwrite their least useful slot.
        const slot = replacing ? Math.floor(this.rand() * TUNE.slots) % TUNE.slots : record.abilities.length;
        this.picks.set(record.pid, { ability: offer[0], slot });
      }
    }
    this.deadline = Date.now() + TUNE.draftTime * 1000;
    this.broadcastDraft();
    this.syncRegistry();
    if ([...this.roster.keys()].every(pid => this.picks.has(pid))) this.startRound();
  }

  broadcastDraft() {
    const replacing = this.round >= TUNE.slots;
    for (const session of this.sessions.values()) {
      if (!session.ready) continue;
      this.send(session.socket, {
        t: 'draft', round: this.round + 1, replacing,
        left: Math.max(0, Math.round((this.deadline - Date.now()) / 1000)),
        offer: this.offers.get(session.pid) || [],
        held: this.roster.get(session.pid)?.abilities || [],
        picked: this.picks.has(session.pid),
        ready: [...this.picks.keys()],
        players: [...this.roster.values()].map(r => ({ pid: r.pid, name: r.name, color: r.color, wins: r.wins, bot: r.bot })),
      });
    }
  }

  startRound() {
    for (const [pid, pick] of this.picks) {
      const record = this.roster.get(pid);
      if (!record) continue;
      const abilities = record.abilities.slice(0, TUNE.slots);
      const slot = this.round < TUNE.slots ? Math.min(abilities.length, TUNE.slots - 1) : pick.slot;
      abilities[slot] = pick.ability;
      record.abilities = abilities.filter(Boolean).slice(0, TUNE.slots);
    }
    // Anyone who never picked (disconnect, timeout) still gets something.
    for (const record of this.roster.values()) {
      if (record.abilities.length) continue;
      const offer = this.offers.get(record.pid);
      record.abilities = [offer ? offer[0] : 'dash'];
    }

    this.round++;
    this.phase = 'round';
    // The opener is always the same arena so everybody starts on known ground;
    // after that the map is drawn at random without repeating the last two.
    let mapIndex = 0;
    if (this.round > 1) {
      const recent = this.mapHistory.slice(-2);
      const choices = MAPS.map((m, i) => i).filter(i => !recent.includes(i));
      mapIndex = choices[Math.floor(this.rand() * choices.length) % choices.length];
    }
    this.mapHistory.push(mapIndex);

    const roster = [...this.roster.values()];
    this.world = createWorld({
      seed: (this.seed ^ (this.round * 2654435761)) | 0,
      mapIndex,
      players: roster.map(r => ({ pid: r.pid, name: r.name, color: r.color, abilities: r.abilities, bot: r.bot })),
    });
    this.brains.clear();
    for (const record of roster) if (record.bot) this.brains.set(record.pid, createBrain(record.pid * 31 + this.round));
    this.sent.clear();
    this.accumulator = 0;
    this.lastTick = Date.now();
    this.tickCount = 0;
    this.broadcast(this.beginPayload());
    this.syncRegistry();
  }

  beginPayload() {
    return {
      t: 'begin',
      seed: this.world.seed,
      mapIndex: this.world.mapIndex,
      round: this.round,
      wins: this.settings.wins,
      players: this.world.players.map(p => ({
        pid: p.pid, name: p.name, color: p.color, abilities: p.slots.map(s => s.id), idx: p.idx,
        wins: this.roster.get(p.pid)?.wins || 0,
      })),
    };
  }

  sendFull(session) {
    const fresh = new Set();
    this.send(session.socket, { ...snapshot(this.world, fresh), full: true });
  }

  finishRound() {
    const winner = this.world.winner;
    const record = winner >= 0 ? this.roster.get(winner) : null;
    if (record) record.wins++;
    const standings = [...this.roster.values()].map(r => ({ pid: r.pid, name: r.name, color: r.color, wins: r.wins, bot: r.bot }));
    this.broadcast({ t: 'over', winner, standings, round: this.round });
    if (record && record.wins >= this.settings.wins) {
      this.phase = 'done';
      this.world = null;
      this.broadcast({ t: 'match', winner, standings });
      this.syncRegistry();
      return;
    }
    this.startDraft();
  }

  // -- the clock -----------------------------------------------------------

  tick() {
    const now = Date.now();
    if (now - this.touched > ROOM_TTL) {
      for (const session of this.sessions.values()) session.socket.close(1000, 'lobby idle');
      this.reset();
      return;
    }
    if (!this.sessions.size) { this.reset(); return; }

    if (this.phase === 'draft') {
      if (now >= this.deadline) {
        for (const record of this.roster.values()) {
          if (this.picks.has(record.pid)) continue;
          const offer = this.offers.get(record.pid) || ['dash'];
          this.picks.set(record.pid, { ability: offer[0], slot: Math.min(record.abilities.length, TUNE.slots - 1) });
        }
        this.startRound();
      } else if (this.tickCount++ % 60 === 0) this.broadcastDraft();
      return;
    }

    if (this.phase !== 'round' || !this.world) return;

    const elapsed = Math.min(250, now - this.lastTick);
    this.lastTick = now;
    this.accumulator += elapsed / 1000;
    let steps = 0;
    while (this.accumulator >= TUNE.step && steps < 4) {
      for (const player of this.world.players) {
        if (!player.bot || !player.alive) continue;
        let brain = this.brains.get(player.pid);
        if (!brain) { brain = createBrain(player.pid * 31 + this.round); this.brains.set(player.pid, brain); }
        driveBot(this.world, player, brain, TUNE.step);
      }
      step(this.world, TUNE.step);
      this.accumulator -= TUNE.step;
      steps++;
      this.tickCount++;
      if (this.tickCount % SNAPSHOT_EVERY === 0) this.broadcast(snapshot(this.world, this.sent));
    }
    if (steps === 0) return;

    if (this.world.phase === 'over' && this.world.phaseT <= 0) {
      this.broadcast(snapshot(this.world, this.sent));
      this.finishRound();
    }
  }
}
