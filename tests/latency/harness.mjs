// Item-1 latency harness: the real sim.js on both ends of a simulated link.
//
// One relay world and one client world, in virtual time with a seeded random
// network: every packet takes 100 ms ± 40 ms one way (200 ms round trip),
// delivered in order as a websocket would. The relay ticks at 60 Hz and sends
// a snapshot every 4 ticks; the client draws at 60 fps, sends input at 30 Hz
// and pings once a second, exactly as game.js does. Two blobs patrol with
// scripted input: the local player (pid 1) on the ground platform, a remote
// player (pid 2) on the upper one.
//
// "before" is the code this game shipped with: the fixed 100 ms render clock
// and applySnapshot's undelayed 6% blend. "after" is netsmooth.js's adaptive
// clock and the delay-matched reference passed to applySnapshot.
//
//   node tests/latency/harness.mjs [--seeds 5] [--rtt 200] [--jitter 40] [--json]

import { TUNE } from '../../data.js';
import { createWorld, step, applyInput, applySnapshot, interpolatedPose, markSpeculative, snapshot } from '../../sim.js';
import { createSnapshotClock, createLagEstimate, createSelfTrail } from '../../netsmooth.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const RTT = arg('rtt', 200);
const JITTER = arg('jitter', 40);
const SEEDS = arg('seeds', 5);
const DURATION = 45_000;
const MEASURE_FROM = 3_000;          // after the 1.6 s round intro and a little settling
const STEP_MS = TUNE.step * 1000;
const FRAME_MS = 1000 / 60;
const LOCAL = 1;
const REMOTE = 2;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// An in-order link: each packet is delayed RTT/2 ± JITTER, never overtaking.
function link(random) {
  const queue = [];
  let last = 0;
  return {
    send(now, payload) {
      const at = Math.max(last, now + RTT / 2 + (random() * 2 - 1) * JITTER);
      last = at;
      queue.push({ at, payload });
    },
    take(now) {
      const out = [];
      while (queue.length && queue[0].at <= now) out.push(queue.shift());
      return out;
    },
  };
}

// Patrol between two x limits, with stops, turns and jumps at random.
function patrol(random, min, max) {
  let dir = 1;
  let until = 0;
  let stopped = false;
  let jumpAt = 1500;
  return (now, x) => {
    if (now >= until) {
      stopped = random() < 0.25;
      if (random() < 0.4) dir = -dir;
      until = now + 300 + random() * 1200;
    }
    if (x > max) dir = -1;
    if (x < min) dir = 1;
    const jump = now >= jumpAt && now < jumpAt + 120;
    if (now >= jumpAt + 120) jumpAt = now + 900 + random() * 2500;
    return { mx: stopped ? 0 : dir, my: 0, jump, ax: dir, ay: 0, ab: [false, false, false] };
  };
}

// game.js's pose for the local blob between two fixed steps.
function fixedStepPose(body, alpha) {
  if (!Number.isFinite(body.previousX)) return body;
  return { x: body.previousX + (body.x - body.previousX) * alpha, y: body.previousY + (body.y - body.previousY) * alpha };
}

// A pose history sampled at known times, read back by linear interpolation.
function track() {
  const samples = [];
  return {
    add(t, x, y) { samples.push({ t, x, y }); },
    at(t) {
      if (!samples.length || t < samples[0].t) return null;
      let lo = 0, hi = samples.length - 1;
      if (t >= samples[hi].t) return samples[hi];
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid].t <= t) lo = mid; else hi = mid; }
      const a = samples[lo], b = samples[hi];
      const k = (t - a.t) / (b.t - a.t);
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    },
  };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mean = values => values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length);
const quantile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};

function run(seed, after) {
  const random = rng(seed * 7919);
  const setup = { seed: 900 + seed, mapIndex: 0, players: [
    { pid: LOCAL, name: 'local', color: 0, abilities: [] },
    { pid: REMOTE, name: 'remote', color: 1, abilities: [] },
  ] };
  const server = createWorld(setup);
  const client = createWorld(setup);
  markSpeculative(client);
  for (const body of client.bodies) { body.previousX = body.x; body.previousY = body.y; body.previousAng = body.ang; }

  const up = link(rng(seed * 104729));
  const down = link(rng(seed * 1299709));
  const localScript = patrol(rng(seed * 31), -3, 3);
  const remoteScript = patrol(rng(seed * 37), -1.6, 1.6);
  const clock = createSnapshotClock({ adaptive: after });
  const lag = createLagEstimate();
  const trail = createSelfTrail();

  // Ground truth: where the relay has each blob, by server tick; and for each
  // tick, the client time whose input the relay was applying.
  const truth = { [LOCAL]: track(), [REMOTE]: track() };
  const inputTimeAt = [];
  let appliedInputAt = 0;
  let appliedInputArrival = 0;

  const serverPhase = 3 + random() * 10;
  const framePhase = 1 + random() * 15;
  let nextTick = serverPhase;
  let nextFrame = framePhase;
  let lastFrame = framePhase;
  let accumulator = 0;
  let sendTimer = 0;
  let pingTimer = 0;
  const sent = new Set();
  const localRendered = track();
  const frames = [];
  let newestServerTime = -Infinity;

  for (let now = 0; now <= DURATION; now += 0.5) {
    // Relay: inputs land whenever they arrive, ticks run on their own clock.
    for (const { payload } of up.take(now)) {
      if (payload.t === 'ping') { down.send(now, { t: 'pong', c: payload.c }); continue; }
      applyInput(server.players.find(p => p.pid === LOCAL), payload.input);
      appliedInputAt = payload.at;
      appliedInputArrival = now;
    }
    while (nextTick <= now) {
      const remote = server.players.find(p => p.pid === REMOTE);
      applyInput(remote, remoteScript(nextTick, remote.x));
      step(server, TUNE.step);
      for (const pid of [LOCAL, REMOTE]) {
        const p = server.players.find(body => body.pid === pid);
        truth[pid].add(server.tick, p.x, p.y);
      }
      // The relay's blob now is the client's from (input lag) ago.
      inputTimeAt[server.tick] = appliedInputAt ? nextTick - (appliedInputArrival - appliedInputAt) : NaN;
      if (server.tick % 4 === 0) down.send(nextTick, JSON.parse(JSON.stringify(snapshot(server, sent))));
      nextTick += STEP_MS;
    }

    if (now < nextFrame) continue;
    nextFrame += FRAME_MS;
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    // Messages are handled between frames, as the browser does.
    for (const { payload, at } of down.take(now)) {
      if (payload.t === 'pong') { lag.add(Math.round(at - payload.c)); continue; }
      clock.snapshot(payload.k * TUNE.step, at);
      const local = client.players.find(p => p.pid === LOCAL);
      let reference = null;
      if (after && local?.alive && lag.known()) {
        reference = trail.at(clock.arrivalOf(payload.k * TUNE.step) - lag.seconds() * 1000);
      }
      applySnapshot(client, payload, LOCAL, true, reference);
      if (reference?.applied) trail.shift(reference.applied);
      newestServerTime = Math.max(newestServerTime, payload.k * TUNE.step);
    }

    const local = client.players.find(p => p.pid === LOCAL);
    const input = localScript(now, local.x);
    applyInput(local, input);
    pingTimer -= dt;
    if (pingTimer <= 0) { pingTimer = 1; up.send(now, { t: 'ping', c: now }); }
    sendTimer -= dt;
    if (sendTimer <= 0) { sendTimer = 1 / TUNE.inputHz; up.send(now, { input, at: now }); }

    accumulator = Math.min(accumulator + dt, TUNE.step * 5);
    let steps = 0;
    while (accumulator >= TUNE.step && steps < 5) {
      for (const body of client.bodies) { body.previousX = body.x; body.previousY = body.y; body.previousAng = body.ang; }
      step(client, TUNE.step);
      accumulator -= TUNE.step;
      steps++;
    }
    if (after) trail.record(now, client.players.find(p => p.pid === LOCAL));

    const poseTime = clock.time(now);
    const localPose = fixedStepPose(client.players.find(p => p.pid === LOCAL), accumulator / TUNE.step);
    localRendered.add(now, localPose.x, localPose.y);
    const remote = client.players.find(p => p.pid === REMOTE);
    const remotePose = interpolatedPose(remote, poseTime);
    const serverTickNow = (now - serverPhase) / STEP_MS + 1;
    frames.push({
      now, local: localPose, remote: { x: remotePose.x, y: remotePose.y },
      remoteTruth: truth[REMOTE].at(serverTickNow),
      remoteShownTruth: truth[REMOTE].at(poseTime / TUNE.step),
      serverTickNow,
      extrapolated: poseTime > newestServerTime,
      shownDelay: serverTickNow * TUNE.step - poseTime,
    });
  }

  const alive = server.players.every(p => p.alive);
  const measured = frames.filter(f => f.now >= MEASURE_FROM && f.remoteTruth && f.remoteShownTruth);

  // Remote: error against where the relay has the blob right now; error
  // against where it had it at the moment being drawn (what interpolation
  // gets wrong, whatever the delay); and stutter: frames where the drawn blob
  // moved under half or over 1.5x what the real one did over the same frame
  // time, a steady delay earlier (only frames where it really moved). A render
  // clock that stalls or leaps shows up here.
  const remoteError = measured.map(f => dist(f.remote, f.remoteTruth));
  const remoteShapeError = measured.map(f => dist(f.remote, f.remoteShownTruth));
  const steadyTicks = mean(measured.map(f => f.shownDelay)) / TUNE.step;
  const steady = measured.map(f => truth[REMOTE].at(f.serverTickNow - steadyTicks));
  let moving = 0, stutter = 0;
  for (let i = 1; i < measured.length; i++) {
    if (!steady[i] || !steady[i - 1]) continue;
    const real = dist(steady[i], steady[i - 1]);
    if (real < 0.03) continue;
    moving++;
    const drawn = dist(measured[i].remote, measured[i - 1].remote);
    if (drawn < real * 0.5 || drawn > real * 1.5) stutter++;
  }

  // Local: every relay tick against what this client showed for the moment
  // whose input that tick was applying.
  const localError = [];
  for (let tick = 1; tick < inputTimeAt.length; tick++) {
    const at = inputTimeAt[tick];
    if (!(at >= MEASURE_FROM)) continue;
    const shown = localRendered.at(at);
    const real = truth[LOCAL].at(tick);
    if (shown && real) localError.push(dist(shown, real));
  }
  const localJumps = [];
  for (let i = 2; i < measured.length; i++) {
    const [a, b, c] = [measured[i - 2], measured[i - 1], measured[i]];
    const v1 = { x: (b.local.x - a.local.x) / (b.now - a.now) * 1000, y: (b.local.y - a.local.y) / (b.now - a.now) * 1000 };
    const v2 = { x: (c.local.x - b.local.x) / (c.now - b.now) * 1000, y: (c.local.y - b.local.y) / (c.now - b.now) * 1000 };
    localJumps.push(dist(v1, v2));
  }

  return {
    alive,
    remoteError: mean(remoteError),
    remoteShapeError: mean(remoteShapeError),
    remoteStutter: (stutter / Math.max(1, moving)) * 100,
    remoteExtrapolated: (measured.filter(f => f.extrapolated).length / measured.length) * 100,
    remoteShownDelay: mean(measured.map(f => f.shownDelay)) * 1000,
    localError: mean(localError),
    localErrorP95: quantile(localError, 0.95),
    localJumpP95: quantile(localJumps, 0.95),
  };
}

const results = { before: [], after: [] };
for (let seed = 1; seed <= SEEDS; seed++) {
  results.before.push(run(seed, false));
  results.after.push(run(seed, true));
}
const summary = mode => {
  const runs = results[mode];
  const out = {};
  for (const key of Object.keys(runs[0])) out[key] = key === 'alive' ? runs.every(r => r.alive) : mean(runs.map(r => r[key]));
  return out;
};
const before = summary('before');
const after = summary('after');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rtt: RTT, jitter: JITTER, seeds: SEEDS, before, after }, null, 2));
} else {
  const rows = [
    ['remote position error vs relay now (units)', 'remoteError', 3],
    ['remote error vs relay at the drawn time (units)', 'remoteShapeError', 3],
    ['remote stutter frames (%)', 'remoteStutter', 1],
    ['remote frames past the newest snapshot (%)', 'remoteExtrapolated', 1],
    ['remote shown behind the relay (ms)', 'remoteShownDelay', 0],
    ['local error vs relay, delay-matched (units)', 'localError', 3],
    ['local error p95 (units)', 'localErrorP95', 3],
    ['local frame-to-frame velocity jump p95 (u/s)', 'localJumpP95', 2],
  ];
  console.log(`BOP latency harness: ${RTT} ms RTT, ±${JITTER} ms jitter per packet, ${SEEDS} seeds x ${DURATION / 1000} s`);
  console.log(`${'metric'.padEnd(48)}${'before'.padStart(10)}${'after'.padStart(10)}`);
  for (const [label, key, digits] of rows) {
    console.log(`${label.padEnd(48)}${before[key].toFixed(digits).padStart(10)}${after[key].toFixed(digits).padStart(10)}`);
  }
  if (!before.alive || !after.alive) console.log('warning: a scripted blob died during a run; its numbers include the fall');
}
