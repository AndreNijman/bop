// The room move state machine in plain Node: GameRoom objects wired to each
// other through a fake Durable Object namespace, no wrangler, no sockets.

import assert from 'node:assert/strict';
import test from 'node:test';
import { GameRoom } from '../../worker.js';

function socket() {
  return {
    readyState: 1,
    sent: [],
    closed: null,
    send(message) { this.sent.push(JSON.parse(message)); },
    close(code, reason) { this.readyState = 3; this.closed = { code, reason }; },
  };
}

// A namespace whose stubs are GameRoom instances made on first use.
function world({ adoptFails = false } = {}) {
  const rooms = new Map();
  const registry = { fetch: async () => new Response(null, { status: 204 }) };
  const env = { REGISTRY: { getByName: () => registry } };
  const make = () => {
    const stored = new Map();
    const ctx = {
      waitUntil() {},
      storage: {
        get: async key => stored.get(key),
        put: async (key, value) => { stored.set(key, structuredClone(value)); },
        delete: async key => { stored.delete(key); },
      },
      stored,
    };
    const room = new GameRoom(ctx, env);
    room.colo = 'PER';
    room.colored = Promise.resolve();
    return room;
  };
  env.ROOMS = {
    idFromName: name => name,
    get: id => ({
      fetch: async request => {
        if (adoptFails && new URL(request.url).pathname === '/_adopt') throw new Error('network down');
        if (!rooms.has(id)) rooms.set(id, make());
        return rooms.get(id).fetch(request);
      },
    }),
  };
  const home = make();
  rooms.set('mixed room', home);
  return { rooms, home, env };
}

function join(room, name, { regions = null, rtt = null } = {}) {
  const session = { socket: socket(), pid: -1, ready: false, chat: [], where: { country: 'AU', edge: 'PER' }, regions, rtts: rtt ? [rtt, rtt, rtt] : [] };
  room.sessions.set(session.socket, session);
  return { session, name };
}

async function seat(room, client, action = 'join') {
  await room.handshake(client.session, { t: action, room: 'Mixed Room', name: client.name });
  return client.session;
}

const near = { oc: 20, apac: 90, weur: 150 };
const far = { oc: 300, apac: 200, weur: 40 };

async function mixedLobby(options) {
  const setup = world(options);
  const { home } = setup;
  const host = await seat(home, join(home, 'Host', { regions: near, rtt: 20 }), 'create');
  const mate = await seat(home, join(home, 'Mate', { regions: near, rtt: 20 }));
  const away = await seat(home, join(home, 'Away', { regions: far, rtt: 300 }));
  return { ...setup, host, mate, away, sessions: [host, mate, away] };
}

const lastOf = (session, t) => session.socket.sent.filter(m => m.t === t).at(-1);

test('a mixed group is handed to a shard with one ticket per seat', async () => {
  const { rooms, home, host, sessions } = await mixedLobby();
  await home.onMessage(host, JSON.stringify({ t: 'start' }));

  assert.equal(home.phase, 'lobby', 'the old room did not start the match');
  assert.match(home.moved.shard, /^weur-/);
  assert.deepEqual(home.ctx.stored.get('moved'), home.moved, 'the forwarding note survives eviction');
  const moves = sessions.map(s => lastOf(s, 'move'));
  assert.ok(moves.every(m => m && m.shard === home.moved.shard && m.region === 'weur' && /^[a-z0-9]{16}$/.test(m.ticket)));
  assert.equal(new Set(moves.map(m => m.ticket)).size, 3);

  const shard = rooms.get(`mixed room~${home.moved.shard}`);
  assert.ok(shard, 'the shard object was created from the same room code');
  assert.equal(shard.shard, home.moved.shard);
  assert.equal(shard.movedFrom, 'PER');
  assert.equal(shard.roster.size, 3);
  assert.ok([...shard.roster.values()].every(r => r.away));

  // Messages to the old room after the move are ignored, pings still answered.
  await home.onMessage(host, JSON.stringify({ t: 'start' }));
  assert.equal(home.phase, 'lobby');
  await home.onMessage(host, JSON.stringify({ t: 'ping', c: 7 }));
  assert.equal(lastOf(host, 'pong').c, 7);

  // Each ticket takes back its seat; the match starts when the last is back.
  for (const [index, old] of sessions.entries()) {
    const back = { socket: socket(), pid: -1, ready: false, chat: [], where: { country: 'DE', edge: 'FRA' }, ticket: moves[index].ticket, regions: null, rtts: [] };
    shard.sessions.set(back.socket, back);
    await shard.handshake(back, { t: 'join', room: 'Mixed Room', name: 'x' });
    assert.equal(lastOf(back, 'welcome').you, old.pid);
    assert.equal(shard.phase, index < 2 ? 'lobby' : 'draft');
  }
  assert.equal(shard.host, host.pid);
  assert.equal(shard.adopting, null);
  assert.deepEqual([...shard.net.seats.values()].map(s => s.country), ['DE', 'DE', 'DE']);

  // A shard never moves again.
  assert.equal(await shard.moveForStart(), false);
  shard.reset();
});

test('a used ticket does not seat a second socket', async () => {
  const { rooms, home, host } = await mixedLobby();
  await home.onMessage(host, JSON.stringify({ t: 'start' }));
  const shard = rooms.get(`mixed room~${home.moved.shard}`);
  const ticket = lastOf(host, 'move').ticket;
  const first = { socket: socket(), pid: -1, ready: false, chat: [], where: {}, ticket, regions: null, rtts: [] };
  const second = { socket: socket(), pid: -1, ready: false, chat: [], where: {}, ticket, regions: null, rtts: [] };
  await shard.handshake(first, { t: 'join', room: 'Mixed Room', name: 'x' });
  await shard.handshake(second, { t: 'join', room: 'Mixed Room', name: 'y' });
  assert.equal(first.pid, host.pid);
  assert.notEqual(second.pid, host.pid, 'the second socket joined as a new player instead');
  shard.reset();
});

test('late arrivals at a moved room are sent on without a ticket', async () => {
  const { rooms, home, host } = await mixedLobby();
  await home.onMessage(host, JSON.stringify({ t: 'start' }));
  const late = join(home, 'Late').session;
  await home.handshake(late, { t: 'join', room: 'Mixed Room', name: 'late' });
  const move = lastOf(late, 'move');
  assert.equal(move.shard, home.moved.shard);
  assert.equal(move.ticket, undefined);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(late.socket.closed, { code: 4000, reason: 'moved' });
  rooms.get(`mixed room~${home.moved.shard}`).reset();
});

test('seats that never reconnect are dropped when the wait runs out', async () => {
  const { rooms, home, host, mate } = await mixedLobby();
  await home.onMessage(host, JSON.stringify({ t: 'start' }));
  const shard = rooms.get(`mixed room~${home.moved.shard}`);
  for (const old of [host, mate]) {
    const back = { socket: socket(), pid: -1, ready: false, chat: [], where: {}, ticket: lastOf(old, 'move').ticket, regions: null, rtts: [] };
    await shard.handshake(back, { t: 'join', room: 'Mixed Room', name: 'x' });
  }
  assert.equal(shard.phase, 'lobby');
  shard.startAdopted();
  assert.equal(shard.roster.size, 2);
  assert.equal(shard.phase, 'draft', 'the two who came back play');
  shard.reset();
});

test('an empty shard releases the room code', async () => {
  const { rooms, home, host } = await mixedLobby();
  await home.onMessage(host, JSON.stringify({ t: 'start' }));
  const shard = rooms.get(`mixed room~${home.moved.shard}`);
  shard.startAdopted();
  assert.equal(shard.roster.size, 0);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(home.moved, null);
  assert.equal(home.ctx.stored.has('moved'), false);
});

test('a failed hand-over starts the match where it is', async () => {
  const { home, host, sessions } = await mixedLobby({ adoptFails: true });
  const error = console.error;
  console.error = () => {};
  try { await home.onMessage(host, JSON.stringify({ t: 'start' })); } finally { console.error = error; }
  assert.equal(home.moved, null);
  assert.equal(home.phase, 'draft');
  assert.ok(sessions.every(s => !lastOf(s, 'move')));
  home.reset();
});

test('a group from one region, or one without probes, starts at once', async () => {
  for (const regions of [near, null]) {
    const { home } = world();
    const host = await seat(home, join(home, 'Host', { regions, rtt: 20 }), 'create');
    await seat(home, join(home, 'Mate', { regions, rtt: 25 }));
    await home.onMessage(host, JSON.stringify({ t: 'start' }));
    assert.equal(home.moved, null);
    assert.equal(home.phase, 'draft');
    home.reset();
  }
});

test('region reports and pings are kept per player, cleaned', async () => {
  const { home } = world();
  const host = await seat(home, join(home, 'Host'), 'create');
  await home.onMessage(host, JSON.stringify({ t: 'regions', ms: { weur: 38.4, apac: 'x', mars: 5, oc: -1 } }));
  assert.deepEqual(host.regions, { weur: 38 });
  for (const rtt of [100, 30, 20, 10, 40, 50, 'no']) await home.onMessage(host, JSON.stringify({ t: 'ping', c: 1, rtt }));
  assert.deepEqual(host.rtts, [30, 20, 10, 40, 50], 'the last five pings');
  home.reset();
});
