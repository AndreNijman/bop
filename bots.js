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

// Is there terrain under this point? Used for edge safety and for deciding
// whether a jump lands anywhere.
function groundNear(w, x, y, reach = 1.5) {
  for (const b of w.bodies) {
    if (b.dead || b.hidden > 0) continue;
    if (b.kind !== 'plat' && !(b.kind === 'bopl' && b.form === 'platform')) continue;
    const s = surfacePoint(b, x, y);
    if (s.sy > y - 0.4 && len(s.sx - x, s.sy - y) < reach) return b;
  }
  return null;
}

function threatNear(w, p) {
  let worst = null, score = 0;
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
  return { t: 0, hold: [0, 0, 0], want: [0, 0, 0], jumpT: 0, wander: 0, dir: seed % 2 ? 1 : -1, panic: 0, seed };
}

export function driveBot(w, p, brain, dt) {
  if (!p.alive) return;
  brain.t += dt;

  let target = null, bestD = Infinity;
  for (const q of w.players) {
    if (q === p || !q.alive) continue;
    if (q.invis > 0 || q.hidden > 0) continue;
    const d = len(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; target = q; }
  }
  if (!target) {
    for (const q of w.players) {
      if (q === p || !q.alive) continue;
      const d = len(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; target = q; }
    }
  }

  const threat = threatNear(w, p);
  const scale = Math.max(0.4, w.bounds.x / 12.6);
  let moveX = 0;
  let wantJump = false;

  if (target) aim(p, target.x + target.vx * 0.16, target.y + target.vy * 0.16 - 0.15);
  else aim(p, p.x + brain.dir, p.y);

  // Recover: if we are below every platform, get back up.
  const under = !groundNear(w, p.x, p.y + 1.4, 2.4);
  const drowning = w.water != null && p.y > w.water - 2.4;
  const outward = Math.abs(p.x) > w.bounds.x - 1.6;

  if (target) {
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

  if (drowning || under) { wantJump = true; moveX = p.x > 0 ? -1 : 1; }
  if (outward) moveX = p.x > 0 ? -1 : 1;

  // Edge safety: never stroll off unless the jump lands on something.
  if (p.grounded && moveX !== 0) {
    const probe = groundNear(w, p.x + moveX * (p.r + 0.75), p.y + 0.55, 1.2);
    if (!probe) {
      const hop = groundNear(w, p.x + moveX * 3.1, p.y + 0.2, 2.0);
      if (hop && target && Math.abs(target.x - p.x) > 2) wantJump = true;
      else moveX = -moveX;
    }
  }
  if (!p.grounded && w.water != null && p.vy > 2 && p.y > w.water - 4) {
    const pad = groundNear(w, p.x + p.vx * 0.5, p.y + 1.6, 2.6);
    if (!pad) moveX = p.x > 0 ? -1 : 1;
  }

  p.input.mx = moveX;
  brain.jumpT = Math.max(0, brain.jumpT - dt);
  if (wantJump && brain.jumpT <= 0 && p.grounded) { brain.jumpT = 0.28; p.input.jump = true; }
  else p.input.jump = wantJump && brain.jumpT > 0.14;

  // Abilities.
  const gap = target ? bestD : 99;
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
      case 'missile': if (target && gap > 3.4 && gap < 15) { fire = true; hold = clamp(gap / 9, 0.5, 1) * ab.charge; } break;
      case 'smoke': if (target && gap < 7) { fire = true; hold = ab.charge * 0.8; } break;
      case 'throw': if (target && gap < 9 && p.grounded) { fire = true; hold = ab.charge; } break;
      case 'meteor': {
        // Straight down only: either directly overhead, or falling onto them.
        const above = target && target.y > p.y + 0.25 && Math.abs(target.x - p.x) < (p.grounded ? 1.3 : 2.2);
        if (above && gap < 7) { fire = true; hold = ab.charge * 0.7; }
        break;
      }
      case 'roll': if (target && gap < 6 && p.grounded) { p.rollHint = target.x > p.x ? 1 : -1; p.input.ax = p.rollHint; p.input.ay = 0; fire = true; hold = ab.charge; } break;
      case 'blink': if (target && gap < 8) { fire = true; hold = ab.charge; } break;
      case 'duplicator': if (target && gap < 9 && brain.t > 3) { fire = true; hold = ab.charge; } break;
      case 'growray': if (p.size < 3 && brain.t > 1.5) { p.input.ax = 0; p.input.ay = -1; fire = true; hold = ab.charge; } break;
      case 'shrinkray': if (target && gap < 9) { fire = true; hold = ab.charge; } break;
      case 'timestop': if (target && gap < 7 && !w.freeze) { fire = true; hold = ab.charge + 0.1; } break;
      case 'rock': if (target && gap < 7 && (Math.abs(p.vx) > 2 || !p.grounded)) { fire = true; hold = 1.4; } break;
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
      case 'mine': if (p.grounded && (!target || gap > 2.2)) fire = true; break;
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
      if (hold > 0) { brain.hold[i] = hold; p.input.ab[i] = true; }
      else p.input.ab[i] = true;
    } else p.input.ab[i] = false;
  }
  brain.ideal = 3.4 + ((brain.seed * 37) % 30) / 10;
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
