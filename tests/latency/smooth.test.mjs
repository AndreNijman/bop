// netsmooth.js (render clock, lag estimate, self trail) and the
// delay-matched path of applySnapshot, in plain Node.

import assert from 'node:assert/strict';
import test from 'node:test';
import { TUNE } from '../../data.js';
import { createWorld, applySnapshot, markSpeculative, snapshot } from '../../sim.js';
import { createSnapshotClock, createLagEstimate, createSelfTrail } from '../../netsmooth.js';

const close = (actual, expected, epsilon, label) =>
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} is not within ${epsilon} of ${expected}`);

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// The clock game.js shipped with before this change, copied as it was.
function shippedClock() {
  let snapshotClock = null;
  const interpolationTime = now => {
    if (!snapshotClock) return NaN;
    const target = snapshotClock.serverTime + Math.max(0, now - snapshotClock.receivedAt) / 1000 - 0.1;
    snapshotClock.renderTime = Math.max(snapshotClock.renderTime ?? target, target);
    return snapshotClock.renderTime;
  };
  return {
    snapshot(packetTime, receivedAt) {
      const renderTime = interpolationTime(receivedAt);
      snapshotClock = { serverTime: packetTime, receivedAt, renderTime: Number.isFinite(renderTime) ? renderTime : packetTime - 0.1 };
    },
    time: interpolationTime,
  };
}

// Snapshots every 4 ticks with a one-way delay of base ± jitter ms, in order.
function arrivals(random, { base = 100, jitter = 0, count = 150 } = {}) {
  const list = [];
  let last = 0;
  for (let i = 0; i < count; i++) {
    const serverTime = i * 4 * TUNE.step;
    last = Math.max(last, serverTime * 1000 + base + (random() * 2 - 1) * jitter);
    list.push({ serverTime, at: last });
  }
  return list;
}

test('the legacy clock is exactly the one the game shipped with', () => {
  const random = rng(5);
  const legacy = createSnapshotClock({ adaptive: false });
  const shipped = shippedClock();
  assert.ok(Number.isNaN(legacy.time(0)));
  let frame = 0;
  for (const { serverTime, at } of arrivals(random, { jitter: 40 })) {
    for (; frame < at; frame += 1000 / 60) assert.equal(legacy.time(frame), shipped.time(frame));
    legacy.snapshot(serverTime, at);
    shipped.snapshot(serverTime, at);
  }
});

test('the adaptive clock sits just behind a steady stream', () => {
  const clock = createSnapshotClock();
  assert.ok(Number.isNaN(clock.time(0)));
  for (const { serverTime, at } of arrivals(rng(1))) clock.snapshot(serverTime, at);
  close(clock.delay(), 0.07, 1e-9, 'a jitter-free stream needs only the minimum delay');
  const now = 150 * 4 * TUNE.step * 1000 + 100;
  close(clock.time(now), now / 1000 - 0.1 - 0.07, 1e-9, 'drawn time');
  close(clock.arrivalOf(1), 1100, 1e-6, 'a snapshot of server time 1 s is expected at 1.1 s');
});

test('the adaptive delay follows jitter and stays clamped', () => {
  const calm = createSnapshotClock();
  const rough = createSnapshotClock();
  const wild = createSnapshotClock();
  for (const { serverTime, at } of arrivals(rng(2), { jitter: 10 })) calm.snapshot(serverTime, at);
  for (const { serverTime, at } of arrivals(rng(2), { jitter: 40 })) rough.snapshot(serverTime, at);
  for (const { serverTime, at } of arrivals(rng(2), { jitter: 400 })) wild.snapshot(serverTime, at);
  assert.ok(rough.delay() > calm.delay(), `${rough.delay()} > ${calm.delay()}`);
  assert.ok(rough.delay() > 0.07 && rough.delay() < 0.25);
  assert.equal(wild.delay(), 0.25);
});

test('the adaptive clock never runs backwards and slews by at most 10%', () => {
  const clock = createSnapshotClock();
  const list = arrivals(rng(3), { jitter: 40, count: 300 });
  let previous = -Infinity;
  let frame = list[0].at;
  let index = 0;
  for (; index < list.length; frame += 1000 / 60) {
    while (index < list.length && list[index].at <= frame) { clock.snapshot(list[index].serverTime, list[index].at); index++; }
    const time = clock.time(frame);
    if (Number.isFinite(previous) && index > 2) {
      const rate = (time - previous) / (1 / 60);
      assert.ok(rate >= 0.9 - 1e-9 && rate <= 1.1 + 1e-9, `clock rate ${rate}`);
    }
    previous = time;
  }
});

test('the adaptive clock jumps on a large change and restarts with the round', () => {
  const clock = createSnapshotClock();
  for (const { serverTime, at } of arrivals(rng(4))) clock.snapshot(serverTime, at);
  const now = 150 * 4 * TUNE.step * 1000;
  clock.time(now);
  // The next round's ticks start from zero again.
  clock.snapshot(0, now + 20);
  close(clock.time(now + 20), -0.1, 1e-9, 'drawn from the new round, 100 ms behind its first snapshot');
});

test('the lag estimate is the median ping plus input and tick pacing', () => {
  const lag = createLagEstimate();
  assert.ok(Number.isNaN(lag.seconds()));
  assert.equal(lag.known(), false);
  for (const rtt of [500, 200, -1, 210, 190, 205, 900]) lag.add(rtt);
  const pacing = 0.5 / TUNE.inputHz + 0.5 * TUNE.step;
  close(lag.seconds(), 0.205 + pacing, 1e-9, 'median of the last five, ignoring a failed ping');
  lag.reset();
  assert.equal(lag.known(), false);
});

test('the self trail interpolates, forgets, follows corrections and one body', () => {
  const trail = createSelfTrail(1);
  const body = { id: 7, alive: true, x: 0, y: 0, vx: 1, vy: 0 };
  for (let t = 0; t <= 2000; t += 100) { body.x = t / 1000; trail.record(t, body); }
  assert.equal(trail.at(900), null, 'older than the window');
  assert.equal(trail.at(2100), null, 'newer than recorded');
  const mid = trail.at(1550);
  close(mid.x, 1.55, 1e-9, 'interpolated x');
  assert.equal(mid.id, 7);
  trail.shift({ dx: 0.5, dvx: 1 });
  close(trail.at(1550).x, 2.05, 1e-9, 'shifted x');
  close(trail.at(1550).vx, 2, 1e-9, 'shifted vx');
  trail.record(2100, { ...body, id: 8, x: 9 });
  trail.record(2200, { ...body, id: 8, x: 9 });
  assert.equal(trail.at(1550), null, 'a new body starts a new trail');
  assert.equal(trail.at(2150).id, 8);
  trail.record(2300, { ...body, alive: false });
  assert.equal(trail.at(2150), null, 'death clears it');
});

// A relay world and a client world of the same round, the client in sync.
function pair() {
  const setup = { seed: 77, mapIndex: 0, players: [
    { pid: 0, name: 'local', color: 0, abilities: [] },
    { pid: 1, name: 'remote', color: 1, abilities: [] },
  ] };
  const server = createWorld(setup);
  const client = createWorld(setup);
  markSpeculative(client);
  const sent = new Set();
  applySnapshot(client, JSON.parse(JSON.stringify(snapshot(server, sent))), 0, false);
  const serverBlob = server.players.find(p => p.pid === 0);
  const blob = () => client.players.find(p => p.pid === 0);
  const next = () => { server.tick += 4; return JSON.parse(JSON.stringify(snapshot(server, sent))); };
  return { server, client, serverBlob, blob, next };
}

test('applySnapshot without a reference blends 6% toward authority, as before', () => {
  const { serverBlob, blob, next, client } = pair();
  serverBlob.x += 1;
  const start = blob().x;
  applySnapshot(client, next(), 0, true);
  close(blob().x, start + 0.06, 1e-9, 'x after the blend');
});

test('applySnapshot with a reference corrects only the delay-matched error', () => {
  const { serverBlob, blob, next, client } = pair();
  serverBlob.x += 1;
  serverBlob.vx = 2;
  const start = { x: blob().x, vx: blob().vx };
  // The client predicted the relay's pose exactly, a lag ago: no correction,
  // however far the blob has moved since.
  const exact = { id: blob().id, x: serverBlob.x, y: serverBlob.y, vx: serverBlob.vx, vy: serverBlob.vy };
  applySnapshot(client, next(), 0, true, exact);
  close(blob().x, start.x, 1e-9, 'x after an exact prediction');
  assert.deepEqual(exact.applied, { dx: 0, dy: 0, dvx: 0, dvy: 0 });

  // A 0.4 unit miss is corrected a quarter at a time, velocity too.
  const miss = { id: blob().id, x: serverBlob.x - 0.4, y: serverBlob.y, vx: serverBlob.vx - 1, vy: serverBlob.vy };
  applySnapshot(client, next(), 0, true, miss);
  close(blob().x, start.x + 0.1, 1e-9, 'x after a small miss');
  close(blob().vx, start.vx + 0.25, 1e-9, 'vx after a small miss');
  close(miss.applied.dx, 0.1, 1e-9, 'reported correction');

  // A miss larger than the snap distance is corrected in one go.
  const far = TUNE.maxSpeed / TUNE.snapshotHz * 1.25 + 1;
  const big = { id: blob().id, x: serverBlob.x - far, y: serverBlob.y, vx: serverBlob.vx, vy: serverBlob.vy };
  const before = blob().x;
  applySnapshot(client, next(), 0, true, big);
  close(blob().x, before + far, 1e-9, 'x after a large miss');
});

test('a reference for another body (a Duplicator clone) is ignored', () => {
  const { serverBlob, blob, next, client } = pair();
  serverBlob.x += 1;
  const start = blob().x;
  const other = { id: blob().id + 1, x: serverBlob.x, y: serverBlob.y, vx: serverBlob.vx, vy: serverBlob.vy };
  applySnapshot(client, next(), 0, true, other);
  close(blob().x, start + 0.06, 1e-9, 'the usual blend applied');
  assert.equal(other.applied, undefined);
});
