// Bot brains.
//
// Shared by the relay (so an online lobby can be filled out), by the offline
// practice mode and by tools/balance.mjs. The balance numbers are only worth
// anything if the bot uses every ability roughly as well as it uses the others,
// so each ability gets an explicit trigger rather than a generic "press when
// ready" rule.

import { TUNE, ABILITY_BY_ID, clamp } from './data.js';
import { surfacePoint } from './sim.js';

const TAU = Math.PI * 2;

function len(x, y) { return Math.sqrt(x * x + y * y); }

function random(brain) {
  brain.rng = (Math.imul(brain.rng, 1664525) + 1013904223) >>> 0;
  return brain.rng / 4294967296;
}

function between(brain, min, max) { return min + (max - min) * random(brain); }

// Launch direction for a projectile of a given speed under gravity, picking the
// flatter of the two arcs. Falls back to a straight line when out of range.
function ballistic(x, y, tx, ty, speed, grav) {
  const dx = tx - x;
  const up = -(ty - y);
  const span = Math.abs(dx);
  const v2 = speed * speed;
  const disc = v2 * v2 - grav * (grav * span * span + 2 * up * v2);
  if (disc < 0 || span < 1e-3) {
    const l = len(dx, ty - y) || 1;
    return [dx / l, (ty - y) / l];
  }
  const ang = Math.atan((v2 - Math.sqrt(disc)) / (grav * span));
  return [Math.cos(ang) * (dx >= 0 ? 1 : -1), -Math.sin(ang)];
}

function aim(p, tx, ty) {
  const dx = tx - p.x, dy = ty - p.y;
  const l = len(dx, dy) || 1;
  p.input.ax = dx / l;
  p.input.ay = dy / l;
}

function isTerrain(b) {
  if (b.dead || b.hidden > 0) return false;
  return b.kind === 'plat' || (b.kind === 'bopl' && b.form === 'platform');
}

// Is there terrain under this point? Used for edge safety and for deciding
// whether a jump lands anywhere.
function groundNear(w, x, y, reach = 1.5) {
  for (const b of w.bodies) {
    if (!isTerrain(b)) continue;
    const s = surfacePoint(b, x, y);
    if (s.sy > y - 0.4 && len(s.sx - x, s.sy - y) < reach) return b;
  }
  return null;
}

// Drop a plumb line: is there anything to land on below this column, within a
// survivable distance and inside the arena? This is the test that keeps a bot
// from strolling into the water, and the old proximity check was far too weak.
function footingBelow(w, x, y, maxDrop = 7) {
  if (Math.abs(x) > w.bounds.x - 0.5) return null;
  const floor = w.water != null ? Math.min(w.water, w.bounds.y) : w.bounds.y;
  let best = null;
  for (const b of w.bodies) {
    if (!isTerrain(b)) continue;
    const half = Math.abs(Math.cos(b.ang)) * b.hx + b.r;
    if (x < b.x - half || x > b.x + half) continue;
    const top = b.y - Math.abs(Math.sin(b.ang)) * b.hx - b.r;
    if (top < y - 0.35) continue;                     // above us, cannot land on it
    if (top > floor) continue;                        // under the water line
    if (top - y > maxDrop) continue;
    if (!best || top < best.top) best = { body: b, top };
  }
  return best;
}

// Where should a falling bopl aim for? Nearest column with something under it.
function nearestLanding(w, p) {
  let best = null;
  for (let step = 0; step <= 16; step++) {
    for (const side of step === 0 ? [0] : [-1, 1]) {
      const x = p.x + side * step * 0.7;
      const spot = footingBelow(w, x, p.y - 0.2, 14);
      if (!spot) continue;
      const cost = Math.abs(x - p.x);
      if (!best || cost < best.cost) best = { x, cost, top: spot.top };
    }
    if (best) break;
  }
  return best;
}

function threatNear(w, p) {
  let worst = null, score = 0;
  // A live tesla arc is lethal to whoever placed it, so treat the line between
  // any matched pair of coils as something to stay away from.
  const coils = w.bodies.filter(b => b.kind === 'coil' && !b.dead && (b.arcOff || 0) <= 0);
  for (let i = 0; i < coils.length; i++) {
    for (let j = i + 1; j < coils.length; j++) {
      const a = coils[i], c = coils[j];
      if (a.owner !== c.owner || a.slot !== c.slot) continue;
      const dx = c.x - a.x, dy = c.y - a.y;
      const span = dx * dx + dy * dy;
      const t = span > 1e-6 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / span)) : 0;
      const cx = a.x + dx * t, cy = a.y + dy * t;
      const d = len(p.x - cx, p.y - cy);
      if (d > 2.4) continue;
      const s = (2.4 - d) + 1.2;
      if (s > score) { score = s; worst = { x: cx, y: cy, vx: 0, vy: 0, kind: 'arc' }; }
    }
  }
  for (const b of w.bodies) {
    if (b === p || b.dead || b.hidden > 0) continue;
    const dangerous = b.lethal || b.kind === 'grenade' || b.kind === 'missile' || b.kind === 'mine' || b.kind === 'hole'
      || (b.kind === 'bopl' && (b.form === 'rock' || b.form === 'roll' || b.form === 'drill' || b.form === 'meteor'));
    if (!dangerous) continue;
    if (b.kind === 'bopl' && b.pid === p.pid) continue;
    if (b.owner === p.pid && b.kind !== 'hole') continue;
    const dx = b.x - p.x, dy = b.y - p.y;
    const d = len(dx, dy);
    const reach = b.kind === 'hole' ? 4.2 : 2.9;
    if (d > reach) continue;
    const closing = ((b.vx - p.vx) * -dx + (b.vy - p.vy) * -dy) / (d || 1);
    const s = (reach - d) + Math.max(0, closing) * 0.5;
    if (s > score) { score = s; worst = b; }
  }
  return worst;
}

// Should a running channel keep running? Evaluated every frame, which is what
// makes the difference between a bot that taps grapple and one that swings on it.
function sustain(w, p, ab, index, target, gap, threat, falling, brain, dt) {
  switch (ab.id) {
    case 'grapple': {
      if (p.grappleId === -2) return true;                 // hook still in flight
      if (p.grappleId < 0) return false;
      const anchor = w.bodies.find(b => b.id === p.grappleId);
      if (!anchor || anchor.dead) return false;
      const d = len(anchor.x - p.x, anchor.y - p.y);
      if (falling) return d > 1.4;
      // Let go once we are level with the anchor, otherwise we just hang there.
      return d > 1.8 && anchor.y < p.y + 0.8;
    }
    case 'beam': {
      if (!target) return false;
      if (gap > ab.range) return false;
      const [ax, ay] = [target.x - p.x, target.y - p.y];
      const l = len(ax, ay) || 1;
      // Only worth holding if we are actually pointed at them.
      return (ax / l) * p.input.ax + (ay / l) * p.input.ay > 0.55;
    }
    case 'drill': return !!target && gap > 0.9 && gap < 12;
    case 'magnet': {
      if (p.heldId >= 0) {
        // Grabbed something: aim it at the enemy for a beat, then let go, which
        // is what actually throws it.
        brain.magnetT = (brain.magnetT || 0) + dt;
        if (target) aim(p, target.x, target.y);
        return brain.magnetT < 0.32;
      }
      brain.magnetT = 0;
      return !!target && gap < 8.5;
    }
    case 'platform': return !!threat || falling;
    case 'push': return !!target && gap < 9 && p.grounded;
    default: return true;
  }
}

export function createBrain(seed) {
  const brain = {
    commit: null, recovering: 0, t: 0, hold: [0, 0, 0], want: [0, 0, 0],
    jumpT: 0, wander: 0, dir: seed % 2 ? 1 : -1, panic: 0, seed,
    rng: (seed ^ 0x9e3779b9) >>> 0,
    observeT: 0, targetId: -1, targetLock: 0, target: null, threat: null,
    aimX: seed % 2 ? 1 : -1, aimY: 0, actionT: 0, pending: null, pauseT: 0,
  };
  // Stable differences make opponents feel like individuals without difficulty
  // spikes: some react or attack a little sooner, others aim a little less well.
  brain.engage = between(brain, 1.8, 2.8);
  brain.reaction = between(brain, 0.2, 0.34);
  brain.aimError = between(brain, 0.25, 0.7);
  brain.actionDelay = between(brain, 1.2, 2);
  brain.boldness = between(brain, 0.62, 0.88);
  brain.ideal = between(brain, 3.4, 6.3);
  return brain;
}

export function driveBot(w, p, brain, dt) {
  if (!p.alive) return;
  if (w.phase !== 'play') {
    brain.t = 0;
    brain.observeT = 0;
    brain.actionT = 0;
    brain.pending = null;
    brain.pauseT = 0;
    brain.target = null;
    brain.threat = null;
    p.input.mx = 0;
    p.input.my = 0;
    p.input.jump = false;
    p.input.ab.fill(false);
    return;
  }
  brain.t += dt;
  brain.observeT -= dt;
  brain.targetLock -= dt;
  brain.actionT = Math.max(0, brain.actionT - dt);
  brain.pauseT = Math.max(0, brain.pauseT - dt);
  if (brain.pending) brain.pending.t -= dt;

  const observed = brain.observeT <= 0;
  if (observed) {
    brain.observeT = brain.reaction + between(brain, 0, 0.12);
    let target = brain.targetLock > 0
      ? w.players.find(q => q.id === brain.targetId && q.alive && q.pid !== p.pid && q.team !== p.team && q.invis <= 0 && q.hidden <= 0)
      : null;
    let bestD = target ? len(target.x - p.x, target.y - p.y) : Infinity;
    if (!target) {
      const options = [];
      for (const q of w.players) {
        if (!q.alive || q.pid === p.pid || q.team === p.team || q.invis > 0 || q.hidden > 0) continue;
        const d = len(q.x - p.x, q.y - p.y);
        options.push({ q, d });
      }
      options.sort((a, b) => a.d - b.d);
      if (options.length) {
        // Most people focus the nearest threat, but not every person picks the
        // same opponent. An occasional alternate target prevents bot dog-piles.
        const choice = options.length > 1 && random(brain) < 0.24
          ? options[1 + Math.floor(random(brain) * (options.length - 1))]
          : options[0];
        target = choice.q;
        bestD = choice.d;
      }
    }
    if (target) {
      if (brain.targetLock <= 0 || target.id !== brain.targetId) brain.targetLock = between(brain, 0.7, 1.6);
      brain.targetId = target.id;
      const angle = between(brain, 0, TAU);
      const error = brain.aimError * between(brain, 0.35, 1);
      brain.target = {
        id: target.id,
        x: target.x + Math.cos(angle) * error,
        y: target.y + Math.sin(angle) * error,
        vx: target.vx,
        vy: target.vy,
      };
      const lead = between(brain, 0.08, 0.18);
      const dx = brain.target.x + brain.target.vx * lead - p.x;
      const dy = brain.target.y + brain.target.vy * lead - 0.15 - p.y;
      const distance = len(dx, dy) || 1;
      brain.aimX = dx / distance;
      brain.aimY = dy / distance;
    } else {
      brain.targetId = -1;
      brain.target = null;
      brain.aimX = brain.dir;
      brain.aimY = 0;
    }
    const threat = threatNear(w, p);
    brain.threat = threat ? { x: threat.x, y: threat.y, vx: threat.vx || 0, vy: threat.vy || 0, kind: threat.kind } : null;
    if (brain.t >= brain.engage && brain.pauseT <= 0 && random(brain) < 0.09) {
      brain.pauseT = between(brain, 0.18, 0.5);
    }
  }

  const target = brain.target;
  const bestD = target ? len(target.x - p.x, target.y - p.y) : Infinity;
  const threat = brain.threat;
  p.input.ax = brain.aimX;
  p.input.ay = brain.aimY;

  const scale = Math.max(0.4, w.bounds.x / 12.6);
  let moveX = 0;
  let wantJump = false;

  // Piloting a live missile: climb clear of our own footing before turning it
  // on the target, the way a person sweeps it up and over.
  if (observed) {
    for (const b of w.bodies) {
      if (b.kind !== 'missile' || b.dead || b.owner !== p.pid || !b.guided) continue;
      const age = w.t - b.spawn;
      if (age < 0.42) {
        const side = target ? Math.sign(target.x - p.x) || 1 : 1;
        aim(p, p.x + side * 0.35, p.y - 3);
      } else if (target) aim(p, target.x + target.vx * 0.2, target.y + target.vy * 0.2);
      brain.aimX = p.input.ax;
      brain.aimY = p.input.ay;
      break;
    }
  }

  // Recover: if we are below every platform, get back up.
  const under = !footingBelow(w, p.x, p.y, 9);
  const drowning = w.water != null && p.y > w.water - 3.2 && !p.grounded;
  const outward = Math.abs(p.x) > w.bounds.x - 1.6;

  if (brain.t < brain.engage) {
    // People spend the opening beat orienting themselves instead of frame-one
    // focus-firing the nearest spawn. Bots fan out during that same grace.
    moveX = brain.dir;
  } else if (target) {
    const gap = bestD;
    const ideal = brain.ideal || 4.2;
    if (gap > ideal + 1.2) moveX = target.x > p.x ? 1 : -1;
    else if (gap < ideal - 1.4) moveX = target.x > p.x ? -1 : 1;
    else moveX = Math.sin(brain.t * 1.7 + brain.seed) > 0 ? 1 : -1;
    if (target.y < p.y - 1.2 && gap < 5) wantJump = true;
  }

  if (threat) {
    brain.panic = 0.45;
    moveX = threat.x > p.x ? -1 : 1;
    if (threat.y > p.y - 0.3) wantJump = true;
  } else brain.panic = Math.max(0, brain.panic - dt);

  // Survival overrides everything. Falling off is the single biggest killer, so
  // a bot in the air with nothing beneath it stops fighting and steers for land.
  const airborne = !p.grounded;
  const landing = airborne ? nearestLanding(w, p) : null;
  const columnClear = footingBelow(w, p.x, p.y, 20);
  if (airborne && !columnClear) {
    if (landing) moveX = landing.x > p.x + 0.15 ? 1 : landing.x < p.x - 0.15 ? -1 : 0;
    else moveX = p.x > 0 ? -1 : 1;
    brain.recovering = 0.55;
  } else if (brain.recovering > 0) {
    brain.recovering -= dt;
  }

  // A committed contact attack overrides the usual spacing dance, but never the
  // survival steering above it.
  if (brain.commit && brain.commit.t > 0) {
    brain.commit.t -= dt;
    if (!airborne || columnClear) {
      moveX = brain.commit.dir;
      if (brain.commit.jump) wantJump = true;
    }
  } else brain.commit = null;

  if (brain.pauseT > 0 && !threat && brain.recovering <= 0 && !brain.commit && !outward) {
    moveX = 0;
    wantJump = false;
  }
  if (outward) moveX = p.x > 0 ? -1 : 1;

  // Edge safety on the ground: never stroll off unless the far side is real.
  // A committed attack is allowed to leap the gap rather than turn back, which
  // is how Rock and Meteor ever reach someone on the next platform along.
  if (p.grounded && moveX !== 0) {
    // Height is not the danger, emptiness is: dropping onto a lower platform is
    // fine, so the probes look a long way down and only the void counts.
    const ahead = footingBelow(w, p.x + moveX * (p.r + 0.8), p.y, 12);
    if (!ahead) {
      const leap = footingBelow(w, p.x + moveX * 2.6, p.y, 12)
        || footingBelow(w, p.x + moveX * 4.0, p.y, 12)
        || footingBelow(w, p.x + moveX * 5.6, p.y, 12)
        || footingBelow(w, p.x + moveX * 7.4, p.y, 12);
      const committed = brain.commit && brain.commit.t > 0;
      if (leap && (committed || (target && Math.abs(target.x - p.x) > 2.2))) wantJump = true;
      else if (!committed || !leap) moveX = -moveX;
    }
  }

  // Falling with speed and nothing below: hold the direction that reaches land.
  if (airborne && p.vy > 1.5) {
    const drift = footingBelow(w, p.x + p.vx * 0.45, p.y, 20);
    if (!drift) {
      const spot = landing || nearestLanding(w, p);
      if (spot) moveX = spot.x > p.x ? 1 : -1;
      else moveX = p.x > 0 ? -1 : 1;
    }
  }

  p.input.mx = moveX;
  p.input.my = p.grounded ? -Math.abs(p.groundNx) : 0;
  const moveLength = Math.hypot(p.input.mx, p.input.my);
  if (moveLength > 1) { p.input.mx /= moveLength; p.input.my /= moveLength; }
  brain.jumpT = Math.max(0, brain.jumpT - dt);
  if (wantJump && brain.jumpT <= 0 && p.grounded) { brain.jumpT = 0.28; p.input.jump = true; }
  else p.input.jump = wantJump && brain.jumpT > 0.14;

  // Abilities.
  const gap = target ? bestD : 99;
  const canAct = observed && brain.t >= brain.engage && brain.actionT <= 0 && (!brain.pending || brain.pending.t <= 0);
  let acted = false;
  for (let i = 0; i < p.slots.length; i++) {
    const slot = p.slots[i];
    const ab = ABILITY_BY_ID.get(slot.id);
    if (!ab) { p.input.ab[i] = false; continue; }
    // A channel or toggle that is already running gets re-evaluated every frame,
    // otherwise a bot can never hold a beam on a target or reel in a grapple.
    if (slot.state === 1 && (ab.kind === 'channel' || ab.kind === 'toggle')) {
      p.input.ab[i] = ab.kind === 'toggle' ? false : sustain(w, p, ab, i, target, gap, threat, under || drowning, brain, dt);
      continue;
    }
    if (brain.hold[i] > 0) {
      brain.hold[i] -= dt;
      p.input.ab[i] = brain.hold[i] > 0;
      continue;
    }
    if (slot.cd > 0.01 || slot.state === 1) { p.input.ab[i] = false; continue; }
    if (!canAct || acted || (brain.pending && brain.pending.slot !== i)) { p.input.ab[i] = false; continue; }
    let fire = false;
    let hold = 0;
    switch (ab.id) {
      case 'grenade': {
        if (target && gap < 9 * scale && gap > 1.6) {
          const [ax, ay] = ballistic(p.x, p.y, target.x, target.y, 15, w.gravity);
          p.input.ax = ax; p.input.ay = ay;
          fire = true; hold = clamp(gap / 12, 0.25, 1) * ab.charge;
        }
        break;
      }
      case 'bow': {
        if (target && gap < 13 * scale) {
          const [ax, ay] = ballistic(p.x, p.y, target.x, target.y, 26, w.gravity * 0.45);
          p.input.ax = ax; p.input.ay = ay;
          fire = true; hold = ab.charge * clamp(gap / 10, 0.4, 1);
        }
        break;
      }
      case 'missile': {
        if (!target || gap < 3.6 || gap > 15) break;
        // Steering it downward while standing on terrain just detonates it on
        // the platform under our feet.
        if (p.grounded && target.y > p.y + 3.2 && gap < 4.5) break;
        fire = true;
        hold = Math.max(0.75, clamp(gap / 9, 0.5, 1) * ab.charge);
        break;
      }
      case 'smoke': if (target && gap < 7) { fire = true; hold = ab.charge * 0.8; } break;
      case 'throw': if (target && gap < 9 && p.grounded) { fire = true; hold = ab.charge; } break;
      case 'meteor': {
        // Meteor only travels straight down, so get overhead before dropping.
        if (!target || gap > 8) break;
        const dx = target.x - p.x;
        const above = target.y > p.y + 0.25 && Math.abs(dx) < (p.grounded ? 1.4 : 2.4);
        // Release quickly once aligned; a long charge gives a moving target
        // enough time to leave the strictly vertical strike line.
        if (above) { fire = true; hold = ab.charge * 0.18; }
        else if (Math.abs(dx) < 5) brain.commit = { dir: Math.sign(dx), t: 0.4, jump: target.y >= p.y - 0.3 };
        break;
      }
      case 'roll': if (target && gap < 6 && p.grounded) { p.rollHint = target.x > p.x ? 1 : -1; p.input.ax = p.rollHint; p.input.ay = 0; fire = true; hold = ab.charge; } break;
      case 'blink': if (target && gap < 8) { fire = true; hold = ab.charge; } break;
      case 'duplicator': if (target && gap < 9 && brain.t > 3) { fire = true; hold = ab.charge; } break;
      case 'growray': if (p.size < 3 && brain.t > 1.5) { p.input.ax = 0; p.input.ay = -1; fire = true; hold = ab.charge; } break;
      case 'shrinkray': if (target && gap < 9) { fire = true; hold = ab.charge; } break;
      case 'timestop': if (target && gap < 7 && !w.freeze) { fire = true; hold = ab.charge + 0.1; } break;
      case 'rock': {
        // Rock keeps momentum and cannot steer, so build speed at them first.
        if (!target || gap > 9) break;
        const toward = Math.sign(target.x - p.x);
        if (Math.abs(p.vx) > 2.6 && Math.sign(p.vx) === toward) { fire = true; hold = 1.4; }
        else brain.commit = { dir: toward, t: 0.5, jump: gap > 3.5 && !!footingBelow(w, p.x + toward * 3.4, p.y, 12) };
        break;
      }
      case 'drill': if (target && gap < 9 && gap > 1.4) { fire = true; hold = 0.3; } break;
      case 'beam': if (target && gap < ab.range * 0.9) { fire = true; hold = 0.35; } break;
      case 'magnet': {
        if (target && gap < 8 && p.heldId < 0) {
          let pick = null, bestD = 6;
          for (const b of w.bodies) {
            if (b.dead || b.im === 0 || b === p || b.kind === 'orb' || b.kind === 'bubble') continue;
            const d = len(b.x - p.x, b.y - p.y);
            if (d < bestD) { bestD = d; pick = b; }
          }
          if (pick) { aim(p, pick.x, pick.y); fire = true; hold = 0.3; }
        }
        break;
      }
      case 'platform': if (threat || drowning || under) { fire = true; hold = 0.3; } break;
      case 'push': if (p.grounded && target && gap < 8) { fire = true; hold = 0.3; } break;
      case 'dash': {
        if (under || drowning) { aim(p, p.x + (p.x > 0 ? -6 : 6), p.y - 4); fire = true; }
        else if (threat) { aim(p, p.x + (threat.x > p.x ? -5 : 5), p.y - 2); fire = true; }
        else if (target && gap < 5.5 && gap > 1.2) fire = true;
        break;
      }
      case 'grapple': {
        if (under || drowning || (!p.grounded && p.vy > 5)) {
          // Reach for the nearest terrain that is above us.
          let anchor = null, bestUp = 12;
          for (const b of w.bodies) {
            if (b.kind !== 'plat' || b.dead || b.hidden > 0) continue;
            if (b.y > p.y - 0.6) continue;
            const d = len(b.x - p.x, b.y - p.y);
            if (d < bestUp) { bestUp = d; anchor = b; }
          }
          if (anchor) { aim(p, anchor.x, anchor.y); fire = true; hold = 1.8; }
        } else if (target && gap > 3 && gap < ab.range * 0.85) {
          // Swing at the enemy: hooking a player drags you both together.
          aim(p, target.x, target.y);
          fire = true; hold = 1.2;
        }
        break;
      }
      case 'gust': if (threat || (target && gap < ab.radius * 0.85)) fire = true; break;
      case 'invis': if (threat || (target && gap < 5)) fire = true; break;
      case 'mine': {
        if (p.grounded && (!target || gap > 2.2)) {
          fire = true;
          brain.commit = {
            dir: target ? -(Math.sign(target.x - p.x) || 1) : -brain.dir,
            t: 0.55,
            jump: true,
          };
        }
        break;
      }
      case 'spike': if (p.grounded && target && gap < 8) fire = true; break;
      case 'tesla': {
        if (!p.grounded) break;
        const mine = w.bodies.filter(b => b.kind === 'coil' && b.owner === p.pid && b.slot === i && !b.dead);
        // One coil is decoration. The pair is the weapon, so space them out.
        if (mine.length === 0) fire = true;
        else if (mine.length === 1 && len(mine[0].x - p.x, mine[0].y - p.y) > 3.4) fire = true;
        break;
      }
      case 'engine': if (p.grounded && target && gap < 6.5) { aim(p, target.x, target.y); fire = true; } break;
      case 'revival': if (p.grounded && !p.revive) fire = true; break;
      case 'teleport': {
        const bubble = w.bodies.find(b => b.kind === 'bubble' && b.owner === p.pid && b.slot === i && !b.dead);
        if (!bubble && p.grounded) fire = true;
        else if (bubble && (threat || under || drowning)) fire = true;
        break;
      }
      case 'blackhole': if (target && gap < 8 && gap > 2.4) fire = true; break;
    }
    if (fire) {
      if (!brain.pending) {
        brain.pending = { slot: i, t: between(brain, 0.25, 0.6) };
        p.input.ab[i] = false;
        acted = true;
        continue;
      }
      brain.pending = null;
      // A seen opening is not an automatic shot. This occasional hesitation is
      // what keeps four bots from releasing perfect attacks in the same beat.
      if (random(brain) > brain.boldness) {
        brain.actionT = between(brain, 0.25, 0.65);
        p.input.ab[i] = false;
        acted = true;
        continue;
      }
      if (hold > 0) { brain.hold[i] = hold; p.input.ab[i] = true; }
      else p.input.ab[i] = true;
      brain.actionT = brain.actionDelay + between(brain, 0, 0.55);
      acted = true;
    } else {
      if (brain.pending?.slot === i) { brain.pending = null; acted = true; }
      p.input.ab[i] = false;
    }
  }
}

export function pickAbilities(rand, count, exclude = []) {
  const pool = [...ABILITY_BY_ID.keys()].filter(id => !exclude.includes(id));
  const picks = [];
  for (let i = 0; i < count && pool.length; i++) {
    const index = Math.floor(rand() * pool.length) % pool.length;
    picks.push(pool.splice(index, 1)[0]);
  }
  return picks;
}

export function draftOffer(rand, held) {
  const pool = [...ABILITY_BY_ID.keys()].filter(id => !held.includes(id));
  const offer = [];
  while (offer.length < 3 && pool.length) {
    const index = Math.floor(rand() * pool.length) % pool.length;
    offer.push(pool.splice(index, 1)[0]);
  }
  return offer;
}

export const BOT_SLOT_LIMIT = TUNE.slots;
