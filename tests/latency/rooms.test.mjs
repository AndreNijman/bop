// Room placement against a real relay (wrangler dev), end to end.
//
// Starts the relay on 8831 (inspector 9331) with TRUST_GEO_HEADERS so each
// fake client can say which country it is in, and a stand-in games-guard on
// 8832 (inspector 9332) that keeps every lag record it is sent. Clients are
// plain websockets that report fake region probes and pings, the way
// netprobe.js and netping.js would from three places at once.
//
//   node --test tests/latency/rooms.test.mjs
//   RELAY_URL=http://127.0.0.1:8831 NETLOG_URL=http://127.0.0.1:8832 node --test tests/latency/rooms.test.mjs
//
// (the second form reuses servers already running, started with
// WRANGLER_REGISTRY_PATH=.wrangler/registry as below.)

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { regionOfColo, REGIONS } from '../../netplace.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wrangler = `${root}node_modules/.bin/wrangler`;
const relay = process.env.RELAY_URL || 'http://127.0.0.1:8831';
const netlog = process.env.NETLOG_URL || 'http://127.0.0.1:8832';
const children = [];

async function ready(url) {
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${url} never became ready`);
}

// A private dev registry: the user-wide one is shared with every other local
// relay, and another project's games-guard stub would take our records.
const registry = `${root}.wrangler/registry`;

function start(args) {
  const env = { ...process.env, WRANGLER_REGISTRY_PATH: registry };
  const child = spawn(wrangler, ['dev', '--ip', '127.0.0.1', ...args], { cwd: root, env, stdio: 'ignore', detached: true });
  children.push(child);
}

before(async () => {
  if (!process.env.NETLOG_URL) start(['-c', 'tests/latency/netlog-stub/wrangler.jsonc', '--port', '8832', '--inspector-port', '9332']);
  if (!process.env.RELAY_URL) start(['--port', '8831', '--inspector-port', '9331', '--var', 'TRUST_GEO_HEADERS:1']);
  await ready(netlog);
  await ready(`${relay}/health`);
});

after(() => {
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const roomName = label => `lat ${label} ${Math.random().toString(36).slice(2, 7)}`;

// One fake player: a websocket plus everything it has been sent.
class Client {
  constructor(name, country) { this.name = name; this.country = country; this.messages = []; }

  connect(room, { shard = '', ticket = '' } = {}) {
    const url = new URL(`${relay.replace(/^http/, 'ws')}/ws`);
    url.searchParams.set('room', room);
    if (shard) url.searchParams.set('shard', shard);
    if (ticket) url.searchParams.set('ticket', ticket);
    this.messages = [];
    this.closed = new Promise(resolve => {
      this.socket = new WebSocket(url, { headers: { Origin: 'http://localhost', 'X-Games-Country': this.country, 'X-Games-Edge': 'TST' } });
      this.socket.onmessage = event => this.messages.push(JSON.parse(event.data));
      this.socket.onclose = event => resolve({ code: event.code, reason: event.reason });
    });
    return new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error(`${this.name} could not connect`));
    });
  }

  send(message) { this.socket.send(JSON.stringify(message)); }

  async waitFor(predicate, label, ms = 8000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(20)) {
      const found = this.messages.find(predicate);
      if (found) return found;
    }
    throw new Error(`${this.name} never got ${label}; saw ${this.messages.map(m => m.t).join(', ')}`);
  }

  async enter(action, room, options) {
    await this.connect(room, options);
    this.send({ t: action, room, name: this.name });
    return this.waitFor(m => m.t === 'welcome' || m.t === 'move' || m.t === 'err', 'a welcome');
  }

  // What netprobe.js and netping.js would report from this player's location.
  report(probes, rtt) {
    this.send({ t: 'regions', ms: probes });
    for (let c = 1; c <= 5; c++) this.send({ t: 'ping', c, rtt });
  }

  close() { try { this.socket.close(); } catch {} return this.closed; }
}

async function records() {
  return (await fetch(netlog)).json();
}

test('/ping answers where a room runs, with CORS and no caching', async () => {
  const response = await fetch(`${relay}/ping?room=${encodeURIComponent(roomName('ping'))}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(typeof body.colo, 'string');
  assert.equal(body.region, regionOfColo(body.colo));
  if (body.colo) assert.ok(REGIONS.includes(body.region), `colo ${body.colo} has no region`);
  assert.equal((await fetch(`${relay}/ping?room=ab`)).status, 400, 'short room names are refused');
  assert.equal((await fetch(`${relay}/ping?room=abcd&shard=nowhere`)).status, 400, 'unknown shards are refused');
  assert.equal((await fetch(`${relay}/_adopt`, { method: 'POST', body: '{}' })).status, 404, 'internal routes are not reachable');
});

test('a mixed group moves to the fairest region, reconnects with tickets and starts there', async () => {
  const room = roomName('mixed');
  const near = { oc: 20, apac: 90, weur: 150 };
  const far = { oc: 300, apac: 200, weur: 40 };
  const host = new Client('Host', 'AU');
  const mate = new Client('Mate', 'AU');
  const away = new Client('Away', 'DE');
  const seats = {};
  seats.host = await host.enter('create', room);
  seats.mate = await mate.enter('join', room);
  seats.away = await away.enter('join', room);
  for (const welcome of Object.values(seats)) assert.equal(welcome.t, 'welcome');
  host.report(near, 20);
  mate.report(near, 20);
  away.report(far, 300);
  await wait(300);
  host.send({ t: 'start' });

  const moves = await Promise.all([host, mate, away].map(c => c.waitFor(m => m.t === 'move', 'a move')));
  const shard = moves[0].shard;
  assert.match(shard, /^weur-[a-z0-9]{6}$/);
  for (const move of moves) {
    assert.equal(move.shard, shard);
    assert.equal(move.region, 'weur');
    assert.match(move.ticket, /^[a-z0-9]{16}$/);
  }
  assert.equal(new Set(moves.map(m => m.ticket)).size, 3, 'every player gets their own ticket');
  assert.ok(![host, mate, away].some(c => c.messages.some(m => m.t === 'draft')), 'the old room did not start the match');
  const closed = await host.closed;
  assert.equal(closed.code, 4000);
  assert.equal(closed.reason, 'moved');
  await Promise.all([mate.closed, away.closed]);

  // Everyone reconnects to the shard with their ticket and keeps their seat.
  const players = [[host, seats.host, moves[0]], [mate, seats.mate, moves[1]], [away, seats.away, moves[2]]];
  for (const [client, welcome, move] of players) {
    const again = await client.enter('join', room, { shard, ticket: move.ticket });
    assert.equal(again.t, 'welcome');
    assert.equal(again.you, welcome.you, `${client.name} kept their seat`);
    assert.equal(again.host, welcome.host);
  }
  for (const client of [host, mate, away]) await client.waitFor(m => m.t === 'draft', 'the draft on the shard');
  const startedAt = Date.now();

  // A late arrival at the old room is sent on, without a ticket, and lands on the shard.
  const late = new Client('Late', 'US');
  const redirect = await late.enter('join', room);
  assert.equal(redirect.t, 'move');
  assert.equal(redirect.shard, shard);
  assert.equal(redirect.region, 'weur');
  assert.equal(redirect.ticket, undefined);
  await late.closed;
  const landed = await late.enter('join', room, { shard });
  assert.equal(landed.t, 'err');
  assert.equal(landed.m, 'that match has already started', 'the shard itself answered');
  await late.close();
  const shardPing = await (await fetch(`${relay}/ping?room=${encodeURIComponent(room)}&shard=${shard}`)).json();
  assert.equal(typeof shardPing.region, 'string');

  // Lag records shorter than 10 s are not kept, so let the match run.
  await wait(Math.max(0, 10_500 - (Date.now() - startedAt)));
  await Promise.all([host, mate, away].map(c => c.close()));
  let record = null;
  for (let i = 0; i < 60 && !record; i++) {
    record = (await records()).map(r => r.record).find(r => r.code === room);
    if (!record) await wait(250);
  }
  assert.ok(record, 'the shard sent its lag record');
  assert.equal(record.region, 'weur');
  assert.equal(record.moved.to, 'weur');
  assert.equal(typeof record.moved.from, 'string');
  assert.deepEqual(record.seats.map(s => s.country).sort(), ['AU', 'AU', 'DE']);
  assert.ok(record.seats.every(s => s.edge === 'TST'));

  // The empty shard released the name: it can be hosted at home again.
  let fresh = null;
  for (let i = 0; i < 20; i++) {
    const client = new Client('Again', 'AU');
    fresh = await client.enter('create', room);
    await client.close();
    if (fresh.t === 'welcome') break;
    await wait(250);
  }
  assert.equal(fresh.t, 'welcome', 'the room code is usable after the shard emptied');
});

test('a group from one region stays put and starts at once', async () => {
  const room = roomName('local');
  const near = { oc: 20, apac: 90, weur: 150 };
  const host = new Client('Host', 'AU');
  const mate = new Client('Mate', 'NZ');
  assert.equal((await host.enter('create', room)).t, 'welcome');
  assert.equal((await mate.enter('join', room)).t, 'welcome');
  host.report(near, 20);
  mate.report({ ...near, oc: 35 }, 35);
  await wait(300);
  host.send({ t: 'start' });
  for (const client of [host, mate]) await client.waitFor(m => m.t === 'draft', 'the draft');
  assert.ok(![host, mate].some(c => c.messages.some(m => m.t === 'move')), 'nobody was moved');
  await Promise.all([host.close(), mate.close()]);
});

test('an unmoved match logs its region and moved: null', async () => {
  const room = roomName('home');
  const host = new Client('Host', 'AU');
  const mate = new Client('Mate', 'SG');
  await host.enter('create', room);
  await mate.enter('join', room);
  host.send({ t: 'start' });
  await host.waitFor(m => m.t === 'draft', 'the draft');
  await wait(10_500);
  await Promise.all([host.close(), mate.close()]);
  let record = null;
  for (let i = 0; i < 60 && !record; i++) {
    record = (await records()).map(r => r.record).find(r => r.code === room);
    if (!record) await wait(250);
  }
  assert.ok(record, 'the room sent its lag record');
  assert.equal(record.moved, null);
  assert.equal(record.region, regionOfColo(record.colo));
  assert.deepEqual(record.seats.map(s => s.country).sort(), ['AU', 'SG']);
});
