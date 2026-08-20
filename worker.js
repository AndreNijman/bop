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

import { TUNE, ABILITIES, ABILITY_BY_ID, SELECTABLE_ABILITIES, resolveLoadout, MAPS, COLORS, BOT_NAMES } from './data.js';
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

// A tiny non-crypto PRNG for maps and Random slots. Seeded per room so a replay
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
        lobbies.push({ ...value, joinable: value.phase === 'lobby' && value.players < value.max });
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
    this.settings = { max: TUNE.maxPlayers, bots: 0, wins: TUNE.winsToTake };
    this.phase = 'lobby';             // lobby | draft | round | done
    this.round = 0;
    this.lastWinner = -1;
    this.lastWinnerTeam = -1;
    this.nextPid = 1;
    this.world = null;
    this.brains = new Map();
    this.sent = new Set();
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
    this.picks.clear();
    this.world = null;
    this.phase = 'lobby';
    this.round = 0;
    this.lastWinner = -1;
    this.lastWinnerTeam = -1;
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
        const players = this.world?.players.filter(p => p.pid === session.pid) || [];
        if (players.length && this.phase === 'round') {
          const input = {
            mx: message.mx, my: message.my, jump: message.jump, ax: message.ax, ay: message.ay,
            ab: Array.isArray(message.ab) ? message.ab.slice(0, TUNE.slots) : [],
          };
          for (const player of players) applyInput(player, input);
        }
        return;
      }
      case 'start': {
        if (session.pid !== this.host || this.phase !== 'lobby') return;
        const humans = [...this.roster.values()].filter(player => !player.bot);
        if (humans.length < 2) {
          this.send(session.socket, { t: 'err', m: 'at least two players are required' });
          return;
        }
        if (new Set(humans.map(player => player.color)).size < 2) {
          this.send(session.socket, { t: 'err', m: 'pick at least two colors before starting' });
          return;
        }
        this.beginMatch();
        return;
      }
      case 'loadout': {
        const allowed = new Set(['', ...SELECTABLE_ABILITIES.map(ability => ability.id)]);
        const abilities = Array.isArray(message.abilities)
          ? message.abilities.slice(0, TUNE.slots).map(id => String(id))
          : [];
        if (abilities.length !== TUNE.slots || abilities.some(id => !allowed.has(id))) return;
        if (this.phase === 'round') {
          if (this.world?.players.some(player => player.pid === session.pid && player.alive)) return;
          record.pendingLoadout = abilities;
          return;
        }
        if (this.phase !== 'draft') return;
        if (this.round > 0 && record.team === this.lastWinnerTeam) return;
        this.picks.set(session.pid, abilities);
        this.broadcastDraft();
        if ([...this.roster.keys()].every(pid => this.picks.has(pid))) this.startRound();
        return;
      }
      case 'again': {
        if (session.pid !== this.host || this.phase !== 'done') return;
        const humans = [...this.roster.values()].filter(player => !player.bot);
        if (humans.length < 2 || new Set(humans.map(player => player.color)).size < 2) {
          this.send(session.socket, { t: 'err', m: 'return to the lobby and wait for another team' });
          return;
        }
        for (const record of this.roster.values()) { record.wins = 0; record.abilities = []; delete record.pendingLoadout; }
        this.round = 0;
        this.lastWinner = -1;
        this.lastWinnerTeam = -1;
        this.beginMatch();
        return;
      }
      case 'lobby': {
        if (session.pid !== this.host || this.phase === 'round') return;
        this.returnToLobby();
        return;
      }
      case 'name': {
        record.name = cleanName(message.name, record.name);
        this.sendLobby();
        return;
      }
      case 'settings': {
        if (session.pid !== this.host || this.phase !== 'lobby') return;
        const humans = [...this.roster.values()].filter(player => !player.bot).length;
        this.settings.max = Math.max(humans, clamp(Math.round(Number(message.max) || this.settings.max), 2, TUNE.maxPlayers));
        this.settings.bots = 0;
        this.settings.wins = clamp(Math.round(Number(message.wins) || this.settings.wins), 1, 15);
        this.syncBots();
        this.sendLobby();
        this.syncRegistry();
        return;
      }
      case 'color': {
        if (this.phase !== 'lobby') return;
        const color = Math.floor(Number(message.color));
        if (!Number.isFinite(color) || color < 0 || color >= COLORS.length) return;
        record.color = color;
        record.team = color;
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
      this.settings.max = clamp(Math.round(Number(message.settings?.max) || TUNE.maxPlayers), 2, TUNE.maxPlayers);
      this.settings.bots = 0;
      this.settings.wins = clamp(Math.round(Number(message.settings?.wins) || TUNE.winsToTake), 1, 15);
    } else {
      if (!this.roster.size || !this.key) { this.reject(session, 'no lobby has that name'); return; }
      if (this.phase !== 'lobby') { this.reject(session, 'that match has already started'); return; }
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
      team: color, abilities: [], joinedRound: this.round,
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
    this.picks.delete(session.pid);
    if (this.world) {
      for (const player of this.world.players) {
        if (player.pid !== session.pid) continue;
        player.alive = false;
        player.leftover = true;
      }
    }
    const humans = [...this.roster.values()].filter(r => !r.bot);
    if (!humans.length) { this.reset(); return; }
    if (session.pid === this.host) this.host = humans[0].pid;
    if (this.phase !== 'lobby' && humans.length < 2) { this.returnToLobby(); return; }
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
        team: color, abilities: [], joinedRound: this.round,
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
        pid: r.pid, name: r.name, color: r.color, team: r.team, bot: r.bot, wins: r.wins, abilities: r.abilities,
      })),
    });
  }

  async syncRegistry() {
    if (!this.key) return;
    const humans = [...this.roster.values()].filter(r => !r.bot).length;
    const colors = [...this.roster.values()].filter(record => !record.bot).map(record => record.color);
    const lobby = {
      name: this.room, key: this.key, players: humans, bots: 0, teams: new Set(colors).size < colors.length,
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

  returnToLobby() {
    this.phase = 'lobby';
    this.world = null;
    this.round = 0;
    this.lastWinner = -1;
    this.lastWinnerTeam = -1;
    this.picks.clear();
    for (const record of this.roster.values()) {
      record.wins = 0;
      record.abilities = [];
      record.team = record.color;
      delete record.pendingLoadout;
    }
    this.syncBots();
    this.sendLobby();
    this.syncRegistry();
  }

  beginMatch() {
    this.round = 0;
    this.lastWinner = -1;
    this.lastWinnerTeam = -1;
    this.mapHistory = [];
    for (const record of this.roster.values()) {
      record.team = record.color;
      delete record.pendingLoadout;
    }
    for (const record of this.roster.values()) { record.wins = 0; record.abilities = []; }
    this.startDraft();
  }

  startDraft() {
    this.phase = 'draft';
    this.world = null;
    this.picks.clear();
    for (const record of this.roster.values()) {
      // The round winner keeps their build. Bots are a browser-only practice
      // extension, so they also keep theirs rather than stalling selection.
      if (record.pendingLoadout && record.team !== this.lastWinnerTeam) {
        record.abilities = [...record.pendingLoadout];
        this.picks.set(record.pid, [...record.pendingLoadout]);
      } else if (record.bot || (this.round > 0 && record.team === this.lastWinnerTeam)) {
        this.picks.set(record.pid, record.abilities.length
          ? [...record.abilities]
          : Array(TUNE.slots).fill('random'));
      }
      delete record.pendingLoadout;
    }
    this.deadline = Date.now() + TUNE.draftTime * 1000;
    this.broadcastDraft();
    this.syncRegistry();
    if ([...this.roster.keys()].every(pid => this.picks.has(pid))) this.startRound();
  }

  broadcastDraft() {
    for (const session of this.sessions.values()) {
      if (!session.ready) continue;
      const record = this.roster.get(session.pid);
      this.send(session.socket, {
        t: 'draft', round: this.round + 1,
        left: Math.max(0, Math.round((this.deadline - Date.now()) / 1000)),
        held: this.picks.get(session.pid) || record?.abilities || Array(TUNE.slots).fill('random'),
        editable: this.round === 0 || record?.team !== this.lastWinnerTeam,
        ready: this.picks.has(session.pid),
        winner: this.lastWinner,
        winnerTeam: this.lastWinnerTeam,
        readyPlayers: [...this.picks.keys()],
        players: [...this.roster.values()].map(r => ({ pid: r.pid, name: r.name, color: r.color, team: r.team, wins: r.wins, bot: r.bot })),
      });
    }
  }

  startRound() {
    const humans = [...this.roster.values()].filter(record => !record.bot);
    if (humans.length < 2 || new Set(humans.map(record => record.team)).size < 2) {
      this.returnToLobby();
      return;
    }
    for (const [pid, loadout] of this.picks) {
      const record = this.roster.get(pid);
      if (!record) continue;
      record.abilities = [...loadout].slice(0, TUNE.slots);
    }
    // Anyone who never readied keeps their current loadout. On the first round,
    // that means Random in every slot.
    for (const record of this.roster.values()) {
      if (!record.abilities.length) record.abilities = Array(TUNE.slots).fill('random');
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
      players: roster.map(r => ({
        pid: r.pid, name: r.name, color: r.color, team: r.team, bot: r.bot,
        loadout: [...r.abilities], abilities: resolveLoadout(r.abilities, this.rand),
      })),
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
        pid: p.pid, name: p.name, color: p.color, team: p.team, abilities: p.slots.map(s => s.id), idx: p.idx,
        loadout: this.roster.get(p.pid)?.abilities || [],
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
    const winningPlayer = this.world.players.find(player => player.pid === winner);
    const winningTeam = winningPlayer?.team ?? -1;
    for (const player of this.world.players) {
      const roster = this.roster.get(player.pid);
      if (roster && !player.clone && player.loadout) roster.abilities = [...player.loadout];
    }
    const winningRoster = [...this.roster.values()].filter(record => record.team === winningTeam);
    const representative = winningRoster[0] || null;
    const resultWinner = representative?.pid ?? winner;
    this.lastWinner = resultWinner;
    this.lastWinnerTeam = winningTeam;
    if (winningTeam >= 0) for (const teammate of winningRoster) teammate.wins++;
    const standings = [...this.roster.values()].map(r => ({ pid: r.pid, name: r.name, color: r.color, team: r.team, wins: r.wins, bot: r.bot }));
    this.broadcast({ t: 'over', winner: resultWinner, standings, round: this.round });
    if (representative && representative.wins >= this.settings.wins) {
      this.phase = 'done';
      this.world = null;
      this.broadcast({ t: 'match', winner: resultWinner, standings });
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
          this.picks.set(record.pid, record.abilities.length
            ? [...record.abilities]
            : Array(TUNE.slots).fill('random'));
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
      const shared = new Map();
      for (const player of this.world.players) {
        if (!player.bot || !player.alive) continue;
        const input = shared.get(player.pid);
        if (input) {
          applyInput(player, input);
          continue;
        }
        let brain = this.brains.get(player.pid);
        if (!brain) { brain = createBrain(player.pid * 31 + this.round); this.brains.set(player.pid, brain); }
        driveBot(this.world, player, brain, TUNE.step);
        shared.set(player.pid, { ...player.input, ab: [...player.input.ab] });
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
