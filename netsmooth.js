// Client-side delay hiding, kept free of the DOM so the latency harness
// (tests/latency/harness.mjs) runs the same code as the browser.
//
// Two halves, matching the relay's authority model (it runs the sim, clients
// render it):
//
// - A render clock for remote bodies. Snapshots arrive 15 times a second with
//   network jitter. The clock follows the fastest recent arrival path and stays
//   behind it by the 95th-percentile arrival gap, so there is nearly always a
//   newer snapshot to interpolate toward, and it slews rather than jumps when
//   that target moves. `adaptive: false` is the clock this game shipped with
//   (a fixed 100 ms behind the newest arrival), kept for comparison.
// - A trail of this player's own predicted poses, so a snapshot can be
//   compared with what this client predicted for the moment the relay
//   simulated, not with where the blob is now (see applySnapshot in sim.js).

import { TUNE, clamp } from './data.js?v=20261027-2';

const MIN_DELAY = 0.1;        // one snapshot gap plus tick and frame slack
const MAX_DELAY = 0.25;
const WINDOW = 45;            // arrivals considered, 3 s at 15 Hz
const SLEW = 0.1;             // the clock runs at most 10% fast or slow
const SNAP_AFTER = 0.25;      // further off than this, jump instead of slewing

function quantile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * The time (server seconds) at which remote bodies are drawn.
 * `snapshot(serverTime, receivedAt)` on every snapshot (serverTime = tick ×
 * step, receivedAt in performance.now() ms); `time(now)` once per frame.
 */
export function createSnapshotClock({ adaptive = true } = {}) {
  return adaptive ? adaptiveClock() : fixedClock();
}

// The original clock: 100 ms behind the server time of the newest arrival,
// never moving backwards. A late packet stops it, an early one makes it jump.
function fixedClock() {
  let clock = null;
  const time = now => {
    if (!clock) return NaN;
    const target = clock.serverTime + Math.max(0, now - clock.receivedAt) / 1000 - 0.1;
    clock.renderTime = Math.max(clock.renderTime ?? target, target);
    return clock.renderTime;
  };
  return {
    delay: () => 0.1,
    arrivalOf: serverTime => clock ? (serverTime - clock.serverTime) * 1000 + clock.receivedAt : NaN,
    reset() { clock = null; },
    snapshot(serverTime, receivedAt) {
      const renderTime = time(receivedAt);
      clock = { serverTime, receivedAt, renderTime: Number.isFinite(renderTime) ? renderTime : serverTime - 0.1 };
    },
    time,
  };
}

function adaptiveClock() {
  let arrivals = [];          // { offset, at }: arrival (s) minus server time, arrival (s)
  let needs = [];             // how stale the newest snapshot was just before each arrival
  let delay = 0.1;
  let renderTime = NaN;
  let lastNow = NaN;
  let newest = -Infinity;

  const fastest = () => Math.min(...arrivals.map(a => a.offset));

  return {
    delay: () => delay,
    /** When a snapshot of `serverTime` typically arrives (ms), without this packet's own jitter. */
    arrivalOf(serverTime) {
      if (!arrivals.length) return NaN;
      return (serverTime + arrivals.reduce((sum, a) => sum + a.offset, 0) / arrivals.length) * 1000;
    },
    reset() {
      arrivals = []; needs = []; delay = 0.1;
      renderTime = NaN; lastNow = NaN; newest = -Infinity;
    },
    snapshot(serverTime, receivedAt) {
      const at = receivedAt / 1000;
      // A new round restarts the tick count; start over rather than wait for it.
      if (serverTime < newest - 1) this.reset();
      newest = Math.max(newest, serverTime);
      const previous = arrivals[arrivals.length - 1];
      arrivals.push({ offset: at - serverTime, at });
      if (arrivals.length > WINDOW) arrivals.shift();
      if (previous) {
        // Just before this arrival the newest snapshot was the previous one:
        // its age measured against the fastest path is the delay that would
        // still have had a newer snapshot to interpolate toward.
        needs.push(at - previous.at + previous.offset - fastest());
        if (needs.length > WINDOW) needs.shift();
        delay = clamp(quantile(needs, 0.95), MIN_DELAY, MAX_DELAY);
      }
    },
    time(now) {
      if (!arrivals.length) return NaN;
      const target = now / 1000 - fastest() - delay;
      if (!Number.isFinite(renderTime) || Math.abs(target - renderTime) > SNAP_AFTER) {
        renderTime = target;
      } else if (now > lastNow) {
        const rate = 1 + clamp((target - renderTime) * 4, -SLEW, SLEW);
        renderTime += ((now - lastNow) / 1000) * rate;
      }
      lastNow = now;
      return renderTime;
    },
  };
}

/**
 * How long ago (s) the relay's view of this player was predicted locally:
 * the round trip (median of recent pongs) plus the average wait for the next
 * input packet and the next relay tick.
 */
export function createLagEstimate() {
  let samples = [];
  return {
    add(rttMs) {
      if (!(rttMs >= 0)) return;
      samples.push(rttMs);
      if (samples.length > 5) samples.shift();
    },
    known: () => samples.length > 0,
    seconds() {
      if (!samples.length) return NaN;
      return quantile(samples, 0.5) / 1000 + 0.5 / TUNE.inputHz + 0.5 * TUNE.step;
    },
    reset() { samples = []; },
  };
}

/** The last `seconds` of this player's predicted poses, by performance.now() ms. */
export function createSelfTrail(seconds = 1.5) {
  let samples = [];
  return {
    record(now, body) {
      if (!body?.alive || (samples.length && samples[0].id !== body.id)) samples = [];
      if (!body?.alive) return;
      samples.push({ t: now, id: body.id, x: body.x, y: body.y, vx: body.vx, vy: body.vy });
      while (samples.length && samples[0].t < now - seconds * 1000) samples.shift();
    },
    /** The predicted pose at `time` (ms), or null outside what is kept. */
    at(time) {
      if (samples.length < 2 || time < samples[0].t || time > samples[samples.length - 1].t) return null;
      let i = 1;
      while (samples[i].t < time) i++;
      const a = samples[i - 1], b = samples[i];
      const k = b.t > a.t ? (time - a.t) / (b.t - a.t) : 1;
      return {
        id: b.id,
        x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k,
        vx: a.vx + (b.vx - a.vx) * k, vy: a.vy + (b.vy - a.vy) * k,
      };
    },
    /** A correction applied to the blob applies to everything it predicted. */
    shift({ dx = 0, dy = 0, dvx = 0, dvy = 0 }) {
      for (const s of samples) { s.x += dx; s.y += dy; s.vx += dvx; s.vy += dvy; }
    },
    clear() { samples = []; },
  };
}
