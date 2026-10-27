// Dev join against a real relay (wrangler dev), end to end.
//
// The test makes its own Ed25519 key pair, signs dev passes with netdev.js's
// signDevPass, and starts the relay on 8835 (inspector 9335) with
// DEV_TEST_PUBLIC_KEY set to the public half, so the relay trusts the test's
// passes instead of games-guard's. TRUST_GEO_HEADERS lets the moved-room case
// fake its players' countries, and a stand-in games-guard on 8836 (inspector
// 9336) keeps the lag records the relay sends. Clients are plain websockets.
//
//   node --test tests/dev/join.test.mjs

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signDevPass } from '../../netdev.js';
import { COLORS, TUNE } from '../../data.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const wrangler = `${root}node_modules/.bin/wrangler`;
const relay = 'http://127.0.0.1:8835';
const netlog = 'http://127.0.0.1:8836';
const HOST = 'bop.andrenijman.com';
const children = [];

const b64url = bytes => Buffer.from(bytes).toString('base64url');

async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return {
    publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: b64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))),
  };
}

const keys = await keyPair();
const otherKeys = await keyPair();
const pass = async (name = 'Andre', options = {}) => (await signDevPass(options.key || keys.privateKey, { name, host: HOST, ...options })).pass;

async function ready(url) {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${url} never became ready`);
}

// A private dev registry, so another agent's relay or games-guard stub never takes our traffic.
const registry = mkdtempSync(join(tmpdir(), 'bop-dev-registry-'));

function start(args) {
  const env = { ...process.env, WRANGLER_REGISTRY_PATH: registry };
  const child = spawn(wrangler, ['dev', '--ip', '127.0.0.1', ...args], { cwd: root, env, stdio: 'ignore', detached: true });
  children.push(child);
}

before(async () => {
  start(['-c', 'tests/latency/netlog-stub/wrangler.jsonc', '--port', '8836', '--inspector-port', '9336']);
  start(['--port', '8835', '--inspector-port', '9335', '--var', `DEV_TEST_PUBLIC_KEY:${keys.publicKey}`, '--var', 'TRUST_GEO_HEADERS:1']);
  await ready(netlog);
  await ready(`${relay}/health`);
});

after(() => {
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const roomName = label => `dev ${label} ${Math.random().toString(36).slice(2, 7)}`;
const EMPTY = Array(TUNE.slots).fill('');

class Client {
  constructor(name, country = 'AU') { this.name = name; this.country = country; this.messages = []; }

  connect(room, { shard = '', ticket = '' } = {}) {
    const url = new URL(`${relay.replace(/^http/, 'ws')}/ws`);
    url.searchParams.set('room', room);
    if (shard) url.searchParams.set('shard', shard);
    if (ticket) url.searchParams.set('ticket', ticket);
    this.messages = [];
    this.closed = new Promise(resolve => {
      this.socket = new WebSocket(url, { headers: { Origin: 'https://bop.andrenijman.com', 'X-Games-Country': this.country, 'X-Games-Edge': 'TST' } });
      this.socket.onmessage = event => this.messages.push(JSON.parse(event.data));
      this.socket.onclose = event => resolve({ code: event.code, reason: event.reason });
    });
    return new Promise((resolve, reject) => {
      this.socket.onopen = resolve;
      this.socket.onerror = () => reject(new Error(`${this.name} could not connect`));
    });
  }

  send(message) { if (this.socket.readyState === 1) this.socket.send(JSON.stringify(message)); }

  async waitFor(predicate, label, ms = 10000) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(20)) {
      const found = this.messages.find(predicate);
      if (found) return found;
    }
    throw new Error(`${this.name} never got ${label}; saw ${this.messages.map(m => m.t).join(', ')}`);
  }

  last(type) { return this.messages.filter(m => m.t === type).at(-1); }

  // `extra` is the rest of the create/join message: password, settings, dev.
  async enter(action, room, extra = {}, options) {
    await this.connect(room, options);
    this.send({ t: action, room, name: this.name, ...extra });
    const answer = await this.waitFor(m => m.t === 'welcome' || m.t === 'move' || m.t === 'err', 'a welcome');
    if (answer.t === 'welcome') this.you = answer.you;
    return answer;
  }

  close() { try { this.socket.close(); } catch {} return this.closed; }
}

// Host and guest in a lobby, optionally locked or capped, on two colors.
async function lobby(label, { password = '', max = 4 } = {}) {
  const room = roomName(label);
  const host = new Client('Host');
  const guest = new Client('Guest');
  assert.equal((await host.enter('create', room, { password, settings: { max, wins: 3 } })).t, 'welcome');
  assert.equal((await guest.enter('join', room, { password })).t, 'welcome');
  guest.send({ t: 'color', color: 1 });
  await host.waitFor(m => m.t === 'lobby' && m.players.length === 2 && m.players[1].color === 1, 'the guest on a second color');
  return { room, host, guest };
}

// Start the match and get everyone through the first draft into round one.
async function startRound(host, guest) {
  host.send({ t: 'start' });
  for (const client of [host, guest]) await client.waitFor(m => m.t === 'draft', 'the draft');
  for (const client of [host, guest]) client.send({ t: 'loadout', abilities: EMPTY });
  return Promise.all([host, guest].map(client => client.waitFor(m => m.t === 'begin', 'round one')));
}

test('a dev joins a locked lobby without its password, and everyone is told', async () => {
  const { room, host, guest } = await lobby('locked', { password: 'hunter2' });
  const dev = new Client('Andre');
  const welcome = await dev.enter('join', room, { dev: await pass('Andre') });
  assert.equal(welcome.t, 'welcome');
  for (const client of [host, guest, dev]) {
    const told = await client.waitFor(m => m.t === 'dev-joined', 'dev-joined');
    assert.deepEqual(told, { t: 'dev-joined', name: 'ANDRE' }, 'the standard shape, no wrapper');
  }
  const roster = (await host.waitFor(m => m.t === 'lobby' && m.players.length === 3, 'a lobby of three')).players;
  const seat = roster.find(p => p.pid === dev.you);
  assert.ok(seat, 'the dev has a seat');
  assert.equal(new Set(roster.map(p => p.color)).size, 3, 'the dev has their own color');
  // The dev counts as a player before the start, like anyone else.
  host.send({ t: 'start' });
  const draft = await dev.waitFor(m => m.t === 'draft', 'the draft');
  assert.ok(draft.players.some(p => p.pid === dev.you));
  await Promise.all([host, guest, dev].map(c => c.close()));
});

test('a dev joins a full lobby past its max', async () => {
  const { room, host, guest } = await lobby('full', { max: 2 });
  const normal = new Client('Normal');
  const refused = await normal.enter('join', room);
  assert.equal(refused.t, 'err');
  assert.equal(refused.m, 'that lobby is full');
  const dev = new Client('Andre');
  assert.equal((await dev.enter('join', room, { dev: await pass() })).t, 'welcome');
  await host.waitFor(m => m.t === 'lobby' && m.players.length === 3, 'a lobby of three');
  await host.waitFor(m => m.t === 'dev-joined', 'dev-joined');
  await Promise.all([host, guest, dev].map(c => c.close()));
});

test('a dev joining mid-round watches it, then drafts and plays the next round in their own color', async () => {
  const { room, host, guest } = await lobby('running');
  const startedAt = Date.now();
  const [first] = await startRound(host, guest);
  assert.equal(first.players.length, 2);
  const late = new Client('Late');
  const refused = await late.enter('join', room);
  assert.equal(refused.m, 'that match has already started', 'normal late joiners are still refused');

  const dev = new Client('Andre');
  assert.equal((await dev.enter('join', room, { dev: await pass('Andre') })).t, 'welcome');
  // The dev watches the round: begin, a full snapshot, then the lobby with their seat.
  const watching = await dev.waitFor(m => m.t === 'begin', 'the running round');
  assert.equal(watching.round, 1);
  assert.ok(!watching.players.some(p => p.pid === dev.you), 'the dev is not dropped into the running round');
  // Snapshots are typed by `type`; their `t` is the world clock.
  await dev.waitFor(m => m.type === 'full', 'a full snapshot');
  await dev.waitFor(m => m.type === 'snap', 'live snapshots');
  const order = dev.messages.map(m => m.t);
  assert.ok(order.indexOf('lobby') > order.indexOf('begin'), 'the lobby (with the dev) comes after begin');
  for (const client of [host, guest, dev]) {
    assert.deepEqual(await client.waitFor(m => m.t === 'dev-joined', 'dev-joined'), { t: 'dev-joined', name: 'ANDRE' });
  }
  // The game adjusted: everyone's roster has the dev, in a color nobody else has.
  const roster = (await host.waitFor(m => m.t === 'lobby' && m.players.some(p => p.pid === dev.you), 'the dev in the roster')).players;
  assert.equal(roster.length, 3);
  const devColor = roster.find(p => p.pid === dev.you).color;
  assert.equal(roster.filter(p => p.color === devColor).length, 1, 'the dev has their own color');

  // End round one: the guest hops off the right edge.
  let n = 0;
  const walking = setInterval(() => guest.send({ t: 'input', mx: 1, my: 0, jump: n++ % 15 < 3, ax: 1, ay: 0, ab: [] }), 33);
  try {
    await host.waitFor(m => m.t === 'over', 'the end of round one', 25000);
  } finally { clearInterval(walking); }
  const draft = await dev.waitFor(m => m.t === 'draft' && m.round === 2, 'the round-two draft', 10000);
  assert.equal(draft.editable, true, 'the dev picks their own loadout');
  assert.ok(draft.players.some(p => p.pid === dev.you));
  for (const client of [host, guest, dev]) client.send({ t: 'loadout', abilities: EMPTY });
  const second = await dev.waitFor(m => m.t === 'begin' && m.round === 2, 'round two', 30000);
  const seat = second.players.find(p => p.pid === dev.you);
  assert.ok(seat, 'the dev plays round two');
  assert.equal(second.players.length, 3);
  assert.equal(seat.color, devColor);
  assert.equal(second.players.filter(p => p.team === seat.team).length, 1, 'the dev is their own team');

  // The dev is an ordinary seat in the match's lag log (records under 10 s are not kept).
  await wait(Math.max(0, 10_500 - (Date.now() - startedAt)));
  await Promise.all([host, guest, dev].map(c => c.close()));
  let record = null;
  for (let i = 0; i < 60 && !record; i++) {
    record = (await (await fetch(netlog)).json()).map(r => r.record).find(r => r.code === room);
    if (!record) await wait(250);
  }
  assert.ok(record, 'the match sent its lag record');
  assert.deepEqual(record.seats.map(s => s.name).sort(), ['Andre', 'Guest', 'Host']);
});

test('a dev joining a room that moved is sent to its shard and joins mid-match there', async () => {
  const room = roomName('moved');
  const near = { oc: 20, apac: 90, weur: 150 };
  const far = { oc: 300, apac: 200, weur: 40 };
  const host = new Client('Host', 'AU');
  const mate = new Client('Mate', 'AU');
  const away = new Client('Away', 'DE');
  const seats = [[host, near, 20], [mate, near, 20], [away, far, 300]];
  assert.equal((await host.enter('create', room)).t, 'welcome');
  assert.equal((await mate.enter('join', room)).t, 'welcome');
  assert.equal((await away.enter('join', room)).t, 'welcome');
  mate.send({ t: 'color', color: 1 });
  away.send({ t: 'color', color: 2 });
  for (const [client, probes, rtt] of seats) {
    client.send({ t: 'regions', ms: probes });
    for (let c = 1; c <= 5; c++) client.send({ t: 'ping', c, rtt });
  }
  await wait(300);
  host.send({ t: 'start' });
  const moves = await Promise.all([host, mate, away].map(c => c.waitFor(m => m.t === 'move', 'a move')));
  const shard = moves[0].shard;
  await Promise.all([host.closed, mate.closed, away.closed]);
  for (const [i, client] of [host, mate, away].entries()) {
    assert.equal((await client.enter('join', room, {}, { shard, ticket: moves[i].ticket })).t, 'welcome');
  }
  for (const client of [host, mate, away]) await client.waitFor(m => m.t === 'draft', 'the draft on the shard');

  // The dev follows the admin page's link to the room's own name, and is sent on.
  const dev = new Client('Andre', 'US');
  const devPass = await pass();
  const redirect = await dev.enter('join', room, { dev: devPass });
  assert.equal(redirect.t, 'move');
  assert.equal(redirect.shard, shard);
  assert.equal(redirect.ticket, undefined);
  await dev.closed;
  // net.js reconnects with the same join, pass included.
  const landed = await dev.enter('join', room, { dev: devPass }, { shard });
  assert.equal(landed.t, 'welcome', 'the shard let the dev into the running match');
  for (const client of [host, mate, away, dev]) await client.waitFor(m => m.t === 'dev-joined', 'dev-joined on the shard');
  const draft = await dev.waitFor(m => m.t === 'draft', 'the draft on the shard');
  assert.ok(draft.players.some(p => p.pid === dev.you));
  assert.equal(draft.editable, true);
  assert.ok(!dev.messages.some(m => m.t === 'move'), 'the dev did not trigger another move');
  await Promise.all([host, mate, away, dev].map(c => c.close()));
});

test('a forged, expired or other-game pass is an ordinary join', async () => {
  const bad = {
    forged: await pass('Andre', { key: otherKeys.privateKey }),
    expired: await pass('Andre', { now: Date.now() - 20 * 60_000 }),
    'other host': (await signDevPass(keys.privateKey, { name: 'Andre', host: 'fart.andrenijman.com' })).pass,
    tampered: (await pass('Andre')).replace(/\.([^.]+)\./, (_, body) => `.${body.slice(0, -2)}AA.`),
    'bare flag': true,
    'admin flag': 'admin:1',
  };
  const locked = await lobby('bad-locked', { password: 'hunter2' });
  const full = await lobby('bad-full', { max: 2 });
  const running = await lobby('bad-running');
  await startRound(running.host, running.guest);
  const cases = [
    [locked.room, 'wrong lobby password'],
    [full.room, 'that lobby is full'],
    [running.room, 'that match has already started'],
  ];
  for (const [label, dev] of Object.entries(bad)) {
    for (const [room, error] of cases) {
      const client = new Client('Andre');
      const answer = await client.enter('join', room, { dev });
      assert.equal(answer.t, 'err', `${label} pass got into ${room}`);
      assert.equal(answer.m, error, `${label} pass gets the normal refusal`);
      await client.close();
    }
  }
  for (const { host } of [locked, full, running]) {
    assert.ok(!host.messages.some(m => m.t === 'dev-joined'), 'nobody was told a dev joined');
  }
  await Promise.all([locked, full, running].flatMap(({ host, guest }) => [host.close(), guest.close()]));
});

test('a dev pass still needs a lobby that exists, and stops at one color each', async () => {
  const missing = new Client('Andre');
  const answer = await missing.enter('join', roomName('nowhere'), { dev: await pass() });
  assert.equal(answer.m, 'no lobby has that name');
  await missing.close();

  const { room, host, guest } = await lobby('cap', { max: 2 });
  const devs = [];
  for (let i = 0; i < COLORS.length - 2; i++) {
    const dev = new Client(`Dev${i}`);
    assert.equal((await dev.enter('join', room, { dev: await pass(`Dev ${i}`) })).t, 'welcome');
    devs.push(dev);
  }
  const roster = (await host.waitFor(m => m.t === 'lobby' && m.players.length === COLORS.length, 'every color seated')).players;
  assert.equal(new Set(roster.map(p => p.color)).size, COLORS.length, 'every seat has its own color');
  const extra = new Client('Extra');
  const refused = await extra.enter('join', room, { dev: await pass('Extra') });
  assert.equal(refused.m, 'that lobby is full');
  await Promise.all([host, guest, ...devs].map(c => c.close()));
});

test('bop has no kick: nothing the host sends removes a dev', async () => {
  const { room, host, guest } = await lobby('kick');
  const dev = new Client('Andre');
  assert.equal((await dev.enter('join', room, { dev: await pass() })).t, 'welcome');
  await host.waitFor(m => m.t === 'dev-joined', 'dev-joined');
  for (const t of ['kick', 'votekick', 'vote-kick', 'remove', 'ban']) host.send({ t, pid: dev.you, target: dev.you });
  host.send({ t: 'chat', m: 'still here?' });
  await dev.waitFor(m => m.t === 'chat' && m.m === 'still here?', 'the chat after the kick attempts');
  assert.equal(dev.socket.readyState, 1, 'the dev is still connected');
  assert.ok(host.last('lobby').players.some(p => p.pid === dev.you), 'the dev is still seated');
  await Promise.all([host, guest, dev].map(c => c.close()));
});
