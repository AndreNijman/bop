// The SQUISH simulation.
//
// Pure logic: no DOM, no audio, no network, no wall clock, no Math.random. The
// browser client, the Cloudflare relay and the headless balance harness all run
// this exact file, which is what lets the relay stay authoritative while the
// client predicts locally from the same code.
//
// Every collider in the game is a capsule - a line segment of half-length `hx`
// inflated by radius `r`. A ball of terrain is a capsule with hx = 0 and a bopl
// is a capsule with hx = 0 that refuses to rotate. One primitive means one
// collision routine, which is the only reason a physics game of this size fits
// in a readable file.

import { TUNE, ABILITY_BY_ID, MAPS, THEMES, sizeScale, clamp, makeRng } from './data.js';

const SOLID = new Set(['bopl', 'plat', 'grenade', 'boulder', 'mine', 'coil', 'smoke']);
const PROJECTILE = new Set(['arrow', 'missile', 'ray', 'hook']);

// ---------------------------------------------------------------------------
// Small maths helpers
// ---------------------------------------------------------------------------

function len(x, y) { return Math.sqrt(x * x + y * y); }

function norm(x, y) {
  const l = Math.sqrt(x * x + y * y);
  return l > 1e-9 ? [x / l, y / l] : [0, 0];
}

// Closest points between two segments. Degenerate (zero length) segments fall
// out of the same code, which is how circle-vs-capsule stays exact.
function closestSeg(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y) {
  const dax = a1x - a0x, day = a1y - a0y;
  const dbx = b1x - b0x, dby = b1y - b0y;
  const rx = a0x - b0x, ry = a0y - b0y;
  const aa = dax * dax + day * day;
  const bb = dbx * dbx + dby * dby;
  const f = dbx * rx + dby * ry;
  let s = 0, t = 0;
  if (aa <= 1e-12 && bb <= 1e-12) return [a0x, a0y, b0x, b0y];
  if (aa <= 1e-12) { t = clamp(f / bb, 0, 1); }
  else {
    const c = dax * rx + day * ry;
    if (bb <= 1e-12) { s = clamp(-c / aa, 0, 1); }
    else {
      const d = dax * dbx + day * dby;
      const denom = aa * bb - d * d;
      s = denom > 1e-12 ? clamp((d * f - c * bb) / denom, 0, 1) : 0;
      t = (d * s + f) / bb;
      if (t < 0) { t = 0; s = clamp(-c / aa, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((d - c) / aa, 0, 1); }
    }
  }
  return [a0x + dax * s, a0y + day * s, b0x + dbx * t, b0y + dby * t];
}

function ends(b) {
  if (b.hx <= 1e-9) return [b.x, b.y, b.x, b.y];
  const c = Math.cos(b.ang), s = Math.sin(b.ang);
  return [b.x - c * b.hx, b.y - s * b.hx, b.x + c * b.hx, b.y + s * b.hx];
}

// Nearest point on a capsule's surface, plus the outward normal there. Used by
// roll, spike placement and engine mounting.
export function surfacePoint(b, px, py) {
  const [a0x, a0y, a1x, a1y] = ends(b);
  const [cx, cy] = closestSeg(a0x, a0y, a1x, a1y, px, py, px, py);
  let [nx, ny] = norm(px - cx, py - cy);
  if (nx === 0 && ny === 0) { nx = 0; ny = -1; }
  return { sx: cx + nx * b.r, sy: cy + ny * b.r, nx, ny, cx, cy };
}

function raycast(w, ox, oy, dx, dy, range, filter) {
  let best = null;
  for (const b of w.bodies) {
    if (!filter(b)) continue;
    // March the ray in steps of a third of the target radius. Cheap, stable and
    // more than accurate enough for a beam that is drawn 20 pixels wide.
    const stride = Math.max(0.12, Math.min(b.r, 0.4) * 0.6);
    for (let d = 0; d <= range; d += stride) {
      const px = ox + dx * d, py = oy + dy * d;
      const [a0x, a0y, a1x, a1y] = ends(b);
      const [cx, cy] = closestSeg(a0x, a0y, a1x, a1y, px, py, px, py);
      if (len(px - cx, py - cy) <= b.r) {
        if (!best || d < best.d) best = { body: b, d, x: px, y: py };
        break;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function area(hx, r) { return Math.PI * r * r + 4 * hx * r; }

function setMass(b, density) {
  if (b.im === 0) return;
  const m = area(b.hx, b.r) * (density || 1);
  b.mass = m;
  b.im = 1 / m;
  b.ii = b.rotates ? 1 / (m * (b.hx * b.hx / 3 + b.r * b.r / 2)) : 0;
}

export function addBody(w, spec) {
  const b = {
    id: w.nextId++, kind: 'obj', x: 0, y: 0, vx: 0, vy: 0, ang: 0, av: 0,
    hx: 0, r: 0.3, im: 1, ii: 0, mass: 1, rest: TUNE.restitution, fric: 0.7,
    owner: -1, slot: -1, ttl: 0, gravity: 1, dead: false, hidden: 0, size: 0,
    rotates: false, lethal: false, density: 1, spawn: w.t, drag: TUNE.drag,
    ...spec,
  };
  setMass(b, b.density);
  w.bodies.push(b);
  return b;
}

function removeDead(w) {
  let write = 0;
  for (let i = 0; i < w.bodies.length; i++) {
    const b = w.bodies[i];
    if (b.dead && b.kind !== 'bopl') { w.gone.push(b.id); continue; }
    w.bodies[write++] = b;
  }
  w.bodies.length = write;
}

export function bodyById(w, id) {
  for (const b of w.bodies) if (b.id === id) return b;
  return null;
}

function playerById(w, pid) {
  for (const p of w.players) if (p.pid === pid) return p;
  return null;
}

// ---------------------------------------------------------------------------
// World construction
// ---------------------------------------------------------------------------

export function createWorld(opts) {
  const mapIndex = clamp(opts.mapIndex | 0, 0, MAPS.length - 1);
  const map = MAPS[mapIndex];
  const theme = THEMES[map.theme];
  const w = {
    seed: opts.seed | 0 || 1,
    rand: makeRng(opts.seed | 0 || 1),
    mapIndex, mapId: map.id, theme: map.theme,
    gravity: theme.gravity,
    water: theme.water,
    bounds: { x: map.bounds.x, y: map.bounds.y },
    baseBounds: { x: map.bounds.x, y: map.bounds.y },
    tick: 0, t: 0, phase: 'intro', phaseT: TUNE.roundIntro,
    sudden: 0, freeze: null, winner: -1,
    nextId: 1, bodies: [], players: [], events: [], gone: [],
  };

  for (const spec of map.platforms) {
    const b = addBody(w, {
      kind: 'plat', x: spec.x, y: spec.y, ang: spec.ang || 0,
      hx: spec.hx, r: spec.r, baseHx: spec.hx, baseR: spec.r,
      ptype: spec.type, rotates: true, density: 9,
      rest: TUNE.platformRestitution,
      fric: spec.type === 'ice' ? 0.06 : 0.95,
      anchorX: spec.x, anchorY: spec.y, anchorAng: spec.ang || 0,
      spring: spec.type === 'free' ? 0 : (spec.spring != null ? spec.spring : 1),
      torqueSpring: spec.torqueSpring != null ? spec.torqueSpring : 1,
      path: spec.path || null, period: spec.period || 6, phase: spec.phase || 0,
      anchorOff: 0, revert: 0, gravity: 0, drag: 0.5,
    });
    b.homeX = spec.x; b.homeY = spec.y;
  }

  const spawns = map.spawns;
  opts.players.forEach((def, index) => {
    const spot = spawns[index % spawns.length];
    const p = addBody(w, {
      kind: 'bopl', x: spot[0], y: spot[1], r: TUNE.boplRadius,
      density: TUNE.boplDensity, rest: 0.02, fric: 0.9, rotates: false,
      pid: def.pid, idx: index, name: def.name, color: def.color, bot: !!def.bot,
      alive: true, form: 'normal', formT: 0, fuel: 0, charge: 0, size: 0,
      aimx: spot[0] < 0 ? 1 : -1, aimy: 0, face: spot[0] < 0 ? 1 : -1,
      grounded: false, groundId: -1, groundNx: 0, groundNy: -1,
      coyote: 0, jumpBuffer: 0, jumpHeld: false, iframes: TUNE.respawnLock,
      invis: 0, squish: 0, stretch: 0, kills: 0, blink: 0, eaten: 0,
      grappleId: -1, grappleLen: 0, grappleLx: 0, grappleLy: 0,
      heldId: -1, reviveX: 0, reviveY: 0, revive: false, reviveSlot: -1,
      input: { mx: 0, jump: false, ax: 1, ay: 0, ab: [false, false, false] },
      slots: (def.abilities || []).slice(0, TUNE.slots).map(id => ({ id, cd: 0, down: false, t: 0, state: 0, data: 0 })),
      spawnX: spot[0], spawnY: spot[1],
    });
    w.players.push(p);
  });

  return w;
}

export function applyInput(p, input) {
  if (!p) return;
  const i = p.input;
  i.mx = clamp(Number(input.mx) || 0, -1, 1);
  i.jump = !!input.jump;
  const [ax, ay] = norm(Number(input.ax) || 0, Number(input.ay) || 0);
  if (ax !== 0 || ay !== 0) { i.ax = ax; i.ay = ay; }
  const buttons = input.ab || [];
  for (let s = 0; s < TUNE.slots; s++) i.ab[s] = !!buttons[s];
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

function collides(a, b) {
  if (a.hidden > 0 || b.hidden > 0) return false;
  if (!SOLID.has(a.kind) || !SOLID.has(b.kind)) return false;
  if (a.kind === 'smoke' || b.kind === 'smoke') return false;
  if (a.kind === 'bopl' && (a.form === 'drill' || a.form === 'roll') && b.kind === 'plat') return false;
  if (b.kind === 'bopl' && (b.form === 'drill' || b.form === 'roll') && a.kind === 'plat') return false;
  if (a.kind === 'bopl' && b.kind === 'bopl' && (a.form === 'platform') !== (b.form === 'platform')) {
    // A bopl in platform form is terrain, so it still collides. Kept explicit
    // because the eat check below relies on plain bopl pairs touching.
    return true;
  }
  if (a.kind === 'mine' && b.kind === 'mine') return false;
  // A coil rests on terrain and blocks objects, but bopls walk straight through
  // it - you cannot stand on one or be shoved by one.
  if ((a.kind === 'coil' && b.kind === 'bopl') || (b.kind === 'coil' && a.kind === 'bopl')) return false;
  return true;
}

function makeContacts(w) {
  const contacts = [];
  const list = w.bodies;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.dead || (a.im === 0 && !a.rotates)) { /* still generate against it */ }
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (a.dead || b.dead) continue;
      if (a.im === 0 && b.im === 0) continue;
      const reach = a.r + b.r + a.hx + b.hx;
      const dx = b.x - a.x, dy = b.y - a.y;
      if (dx * dx + dy * dy > reach * reach) continue;
      if (!collides(a, b)) continue;
      const [a0x, a0y, a1x, a1y] = ends(a);
      const [b0x, b0y, b1x, b1y] = ends(b);
      const [cax, cay, cbx, cby] = closestSeg(a0x, a0y, a1x, a1y, b0x, b0y, b1x, b1y);
      let ddx = cbx - cax, ddy = cby - cay;
      let dist = len(ddx, ddy);
      const rad = a.r + b.r;
      if (dist >= rad) continue;
      let nx, ny;
      if (dist > 1e-6) { nx = ddx / dist; ny = ddy / dist; }
      else { const f = norm(b.x - a.x, b.y - a.y); nx = f[0] || 0; ny = f[1] || -1; }
      const pen = rad - dist;
      contacts.push({ a, b, nx, ny, pen, px: cax + nx * a.r, py: cay + ny * a.r });
      // Two nearly parallel capsules need a second contact or they see-saw. Add
      // one at each end of the overlapping span.
      if (a.hx > 0.2 && b.hx > 0.2) {
        const da = Math.cos(a.ang) * Math.cos(b.ang) + Math.sin(a.ang) * Math.sin(b.ang);
        if (Math.abs(da) > 0.9) {
          const off = Math.min(a.hx, b.hx) * 0.65;
          const tx = -ny, ty = nx;
          for (const sign of [-1, 1]) {
            contacts.push({
              a, b, nx, ny, pen: pen * 0.55,
              px: cax + nx * a.r + tx * off * sign, py: cay + ny * a.r + ty * off * sign,
            });
          }
        }
      }
    }
  }
  return contacts;
}

function solve(w, contacts, dt) {
  const slop = 0.004, bias = 0.22;
  for (let iter = 0; iter < TUNE.contactIterations; iter++) {
    for (const c of contacts) {
      const { a, b, nx, ny } = c;
      const rax = c.px - a.x, ray = c.py - a.y;
      const rbx = c.px - b.x, rby = c.py - b.y;
      const vax = a.vx - a.av * ray, vay = a.vy + a.av * rax;
      const vbx = b.vx - b.av * rby, vby = b.vy + b.av * rbx;
      const rvn = (vbx - vax) * nx + (vby - vay) * ny;
      const push = Math.max(0, c.pen - slop) * bias / dt;
      const rest = iter === 0 ? Math.min(a.rest, b.rest) : 0;
      const target = -push - (rvn < -1.4 ? rvn * rest : 0);
      if (rvn > target) continue;
      const rna = rax * ny - ray * nx;
      const rnb = rbx * ny - rby * nx;
      const inv = a.im + b.im + a.ii * rna * rna + b.ii * rnb * rnb;
      if (inv <= 1e-9) continue;
      const jn = (target - rvn) / inv;
      a.vx -= jn * nx * a.im; a.vy -= jn * ny * a.im;
      b.vx += jn * nx * b.im; b.vy += jn * ny * b.im;
      a.av -= jn * rna * a.ii; b.av += jn * rnb * b.ii;

      // Friction, clamped by Coulomb against the normal impulse we just used.
      const tx = -ny, ty = nx;
      const vax2 = a.vx - a.av * ray, vay2 = a.vy + a.av * rax;
      const vbx2 = b.vx - b.av * rby, vby2 = b.vy + b.av * rbx;
      const rvt = (vbx2 - vax2) * tx + (vby2 - vay2) * ty;
      const rta = rax * ty - ray * tx;
      const rtb = rbx * ty - rby * tx;
      const invT = a.im + b.im + a.ii * rta * rta + b.ii * rtb * rtb;
      if (invT <= 1e-9) continue;
      const mu = Math.sqrt(Math.max(0.02, a.fric) * Math.max(0.02, b.fric));
      let jt = -rvt / invT;
      const cap = Math.abs(jn) * mu + 0.0001;
      jt = clamp(jt, -cap, cap);
      a.vx -= jt * tx * a.im; a.vy -= jt * ty * a.im;
      b.vx += jt * tx * b.im; b.vy += jt * ty * b.im;
      a.av -= jt * rta * a.ii; b.av += jt * rtb * b.ii;
    }
  }
  // Positional relaxation. Keeps stacks from sinking without adding energy.
  for (let iter = 0; iter < 3; iter++) {
    for (const c of contacts) {
      const { a, b, nx, ny } = c;
      const inv = a.im + b.im;
      if (inv <= 1e-9) continue;
      const corr = Math.max(0, c.pen - slop) * 0.35 / inv;
      a.x -= nx * corr * a.im; a.y -= ny * corr * a.im;
      b.x += nx * corr * b.im; b.y += ny * corr * b.im;
    }
  }
}

// ---------------------------------------------------------------------------
// Death
// ---------------------------------------------------------------------------

function vulnerable(p) {
  if (!p.alive || p.hidden > 0 || p.iframes > 0) return false;
  if (p.form === 'rock' || p.form === 'platform') return false;
  return true;
}

export function kill(w, p, cause, killerPid = -1) {
  if (!p.alive) return;
  const orb = w.bodies.find(b => b.kind === 'orb' && b.owner === p.pid && !b.dead && b.arm <= 0);
  if (p.revive && orb && cause !== 'bounds' && cause !== 'water') {
    p.revive = false;
    orb.dead = true;
    p.x = orb.x; p.y = orb.y;
    p.vx = 0; p.vy = 0;
    p.iframes = TUNE.respawnLock;
    // Coming back is not free: you return one size down, which is one step from
    // being edible.
    p.size = clamp(p.size - 1, TUNE.sizeMin, TUNE.sizeMax);
    refreshSize(p);
    leaveForm(w, p);
    for (const s of p.slots) s.cd = Math.max(s.cd, ABILITY_BY_ID.get(s.id)?.cd || 0);
    w.events.push({ e: 'revive', x: p.x, y: p.y, c: p.idx });
    return;
  }
  p.alive = false;
  p.dead = false;             // stays in the array so the client keeps its slot
  p.hidden = 0;
  p.form = 'normal';
  p.vx = 0; p.vy = 0;
  p.grappleId = -1;
  p.heldId = -1;
  w.events.push({ e: 'pop', x: p.x, y: p.y, c: p.idx, cause });
  const killer = killerPid >= 0 ? playerById(w, killerPid) : null;
  if (killer && killer !== p) killer.kills++;
}

function explode(w, x, y, radius, impulse, ownerPid, kind = 'blast') {
  w.events.push({ e: kind, x, y, r: radius });
  for (const b of w.bodies) {
    if (b.dead) continue;
    const dx = b.x - x, dy = b.y - y;
    const d = len(dx, dy);
    if (d > radius + b.r + b.hx) continue;
    const [nx, ny] = d > 1e-6 ? [dx / d, dy / d] : [0, -1];
    const falloff = 1 - clamp((d - b.r) / radius, 0, 1);
    if (b.kind === 'bopl') {
      if (d - b.r < radius * 0.86 && vulnerable(b)) { kill(w, b, 'blast', ownerPid); continue; }
      b.vx += nx * impulse * falloff * 0.9; b.vy += ny * impulse * falloff * 0.9;
    } else {
      const scale = b.kind === 'plat' ? 0.55 : 1.2;
      b.vx += nx * impulse * falloff * scale * Math.min(1, b.im * 2);
      b.vy += ny * impulse * falloff * scale * Math.min(1, b.im * 2);
      if (b.kind === 'plat') b.anchorOff = Math.max(b.anchorOff, 0.8);
      if (b.kind === 'grenade' && b.fuse > 0.12) b.fuse = 0.06;
      if (b.kind === 'smoke') igniteSmoke(w, b);
      if (b.kind === 'mine' && b.state > 0) b.boom = true;
    }
  }
}

function igniteSmoke(w, cloud) {
  if (cloud.lit) return;
  cloud.lit = true;
  cloud.fuse = 0.08;
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

function leaveForm(w, p) {
  if (p.form === 'platform') { p.hx = 0; p.rotates = false; p.ang = 0; p.av = 0; refreshSize(p); }
  if (p.form === 'gun' || p.form === 'bow') { p.vx *= 0.15; }
  p.form = 'normal';
  p.formT = 0;
  p.fuel = 0;
  p.lethal = false;
}

function refreshSize(p) {
  p.r = TUNE.boplRadius * sizeScale(p.size);
  setMass(p, TUNE.boplDensity);
}

function resize(w, b, delta) {
  if (b.kind === 'bopl') {
    if (b.form === 'platform') return;
    b.size = clamp(b.size + delta, TUNE.sizeMin, TUNE.sizeMax);
    refreshSize(b);
    w.events.push({ e: 'resize', x: b.x, y: b.y, d: delta });
    return;
  }
  if (b.kind === 'plat') {
    b.size = clamp(b.size + delta, -4, 6);
    const scale = sizeScale(b.size);
    b.hx = b.baseHx * scale;
    b.r = b.baseR * scale;
    setMass(b, b.density);
    b.revert = ABILITY_BY_ID.get('growray').revert;
    return;
  }
  if (b.kind === 'hole') {
    b.core += delta * 0.28;
    if (b.core <= 0.12) { b.white = !b.white; b.core = 0.3; }
    b.r = b.core;
    return;
  }
  b.size = clamp(b.size + delta, -4, 5);
  const scale = sizeScale(b.size);
  b.r = (b.baseR || b.r) * scale;
  setMass(b, b.density);
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

function stepPlatform(w, b, dt) {
  if (b.revert > 0) {
    b.revert -= dt;
    if (b.revert <= 0 && b.size !== 0) { b.size = 0; b.hx = b.baseHx; b.r = b.baseR; setMass(b, b.density); }
  }
  if (b.anchorOff > 0) { b.anchorOff -= dt; return; }
  if (b.ptype === 'free' || b.spring <= 0) return;
  let ax = b.homeX, ay = b.homeY;
  if (b.path) {
    const s = 0.5 - 0.5 * Math.cos(TAU * (w.t / b.period + b.phase));
    ax += b.path[0] * s;
    ay += b.path[1] * s;
  }
  b.anchorX = ax; b.anchorY = ay;
  const k = 70 * b.spring, damp = 13 * b.spring;
  b.vx += ((ax - b.x) * k - b.vx * damp) * dt;
  b.vy += ((ay - b.y) * k - b.vy * damp) * dt;
  if (b.torqueSpring > 0) {
    let da = b.anchorAng - b.ang;
    while (da > Math.PI) da -= TAU;
    while (da < -Math.PI) da += TAU;
    b.av += (da * 55 * b.torqueSpring - b.av * 11 * b.torqueSpring) * dt;
  }
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

function nearestSolidHit(w, b, skipOwner) {
  for (const other of w.bodies) {
    if (other === b || other.dead || other.hidden > 0) continue;
    if (!SOLID.has(other.kind)) continue;
    // A missile is born above its owner's head and steered from there, so it
    // must not detonate on them while it is still under guidance.
    if (skipOwner && other.kind === 'bopl' && other.pid === b.owner && (w.t - b.spawn < 0.16 || b.guided)) continue;
    const [a0x, a0y, a1x, a1y] = ends(other);
    const [cx, cy] = closestSeg(a0x, a0y, a1x, a1y, b.x, b.y, b.x, b.y);
    if (len(b.x - cx, b.y - cy) <= other.r + b.r) return other;
  }
  return null;
}

function stepObject(w, b, dt) {
  switch (b.kind) {
    case 'grenade': {
      b.fuse -= dt;
      if (b.held) {
        const p = playerById(w, b.owner);
        if (!p || !p.alive) { b.held = false; }
        else { b.x = p.x + p.input.ax * (p.r + b.r + 0.06); b.y = p.y + p.input.ay * (p.r + b.r + 0.06); b.vx = p.vx; b.vy = p.vy; }
      }
      if (b.fuse <= 0) { explode(w, b.x, b.y, b.blast, b.impulse, b.owner); b.dead = true; }
      break;
    }
    case 'missile': {
      const ab = ABILITY_BY_ID.get('missile');
      const p = playerById(w, b.owner);
      if (b.guided && p && p.alive && p.slots[b.slot] && p.slots[b.slot].state === 1) {
        const want = Math.atan2(p.input.ay, p.input.ax);
        let da = want - b.ang;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        b.ang += clamp(da, -ab.turn * dt, ab.turn * dt);
        b.speed = ab.cruise;
      } else b.guided = false;
      b.speed = Math.min(b.guided ? ab.cruise : ab.boost, b.speed + 24 * dt);
      b.vx = Math.cos(b.ang) * b.speed;
      b.vy = Math.sin(b.ang) * b.speed;
      b.ttl -= dt;
      const hit = nearestSolidHit(w, b, true);
      if (hit || b.ttl <= 0) { explode(w, b.x, b.y, b.blast, b.impulse, b.owner); b.dead = true; }
      break;
    }
    case 'arrow': {
      b.ang = Math.atan2(b.vy, b.vx);
      b.ttl -= dt;
      const hit = nearestSolidHit(w, b, true);
      if (hit && hit.kind !== 'bopl') { w.events.push({ e: 'thud', x: b.x, y: b.y }); b.dead = true; }
      if (b.ttl <= 0) b.dead = true;
      break;
    }
    case 'ray': {
      b.ttl -= dt;
      if (b.ttl <= 0) { b.dead = true; break; }
      for (const other of w.bodies) {
        if (other.dead || other === b) continue;
        if (other.kind === 'ray' || other.kind === 'hook' || other.kind === 'engine') continue;
        if (other.kind === 'bopl' && other.pid === b.owner && w.t - b.spawn < 0.12) continue;
        if (other.kind === 'bopl' && !other.alive) continue;
        if (b.mode === 'dup' && other.kind === 'bopl') continue;
        const [a0x, a0y, a1x, a1y] = ends(other);
        const [cx, cy] = closestSeg(a0x, a0y, a1x, a1y, b.x, b.y, b.x, b.y);
        if (len(b.x - cx, b.y - cy) > other.r + b.r) continue;
        applyRay(w, b, other);
        b.dead = true;
        break;
      }
      break;
    }
    case 'hook': {
      b.ttl -= dt;
      const p = playerById(w, b.owner);
      if (!p || !p.alive || p.grappleId !== -2) { b.dead = true; break; }
      if (len(b.x - p.x, b.y - p.y) > ABILITY_BY_ID.get('grapple').range || b.ttl <= 0) { p.grappleId = -1; b.dead = true; break; }
      const hit = nearestSolidHit(w, b, true);
      if (hit) {
        const c = Math.cos(-hit.ang), s = Math.sin(-hit.ang);
        const dx = b.x - hit.x, dy = b.y - hit.y;
        p.grappleId = hit.id;
        p.grappleLx = dx * c - dy * s;
        p.grappleLy = dx * s + dy * c;
        p.grappleLen = Math.max(0.8, len(b.x - p.x, b.y - p.y));
        w.events.push({ e: 'hook', x: b.x, y: b.y });
        b.dead = true;
      }
      break;
    }
    case 'boulder': {
      b.lethal = len(b.vx, b.vy) > 5.5;
      b.ttl -= dt;
      if (b.ttl <= 0) b.dead = true;
      break;
    }
    case 'mine': {
      const ab = ABILITY_BY_ID.get('mine');
      if (b.state === 0) { b.prime -= dt; if (b.prime <= 0) { b.state = 1; w.events.push({ e: 'prime', x: b.x, y: b.y }); } }
      else {
        let target = null, best = ab.seek;
        for (const p of w.players) {
          if (!p.alive || p.pid === b.owner || p.invis > 0 || p.hidden > 0) continue;
          const d = len(p.x - b.x, p.y - b.y);
          if (d < best) { best = d; target = p; }
        }
        if (target) {
          b.state = 2;
          const [nx, ny] = norm(target.x - b.x, target.y - b.y);
          b.vx += nx * ab.chase * dt * 4;
          b.vy += ny * ab.chase * dt * 4;
          b.gravity = 0.15;
        }
        if (b.state === 2) { b.hunt -= dt; if (b.hunt <= 0) b.boom = true; }
      }
      for (const p of w.players) {
        if (!p.alive) continue;
        if (len(p.x - b.x, p.y - b.y) < p.r + b.r + 0.05 && (b.state > 0 || p.pid !== b.owner)) b.boom = true;
      }
      if (b.boom) { explode(w, b.x, b.y, ab.blast, ab.impulse, b.owner); b.dead = true; }
      break;
    }
    case 'smoke': {
      b.ttl -= dt;
      if (b.lit) {
        b.fuse -= dt;
        if (b.fuse <= 0) {
          const ab = ABILITY_BY_ID.get('smoke');
          explode(w, b.x, b.y, ab.blast * (b.r / 0.62), ab.impulse, b.owner, 'flame');
          b.dead = true;
        }
      }
      if (b.ttl <= 0) b.dead = true;
      break;
    }
    case 'canister': {
      b.ttl -= dt;
      const hit = nearestSolidHit(w, b, true);
      if (hit || b.ttl <= 0) {
        const ab = ABILITY_BY_ID.get('smoke');
        for (let i = 0; i < ab.puffs; i++) {
          const a = TAU * i / ab.puffs + w.rand() * 0.6;
          addBody(w, {
            kind: 'smoke', x: b.x + Math.cos(a) * 0.55, y: b.y + Math.sin(a) * 0.55,
            vx: Math.cos(a) * 1.6, vy: Math.sin(a) * 1.6 - 0.6,
            r: 0.62 * b.scaleUp, baseR: 0.62 * b.scaleUp, density: 0.25, gravity: 0.12,
            owner: b.owner, slot: b.slot, ttl: ab.life, lit: false, fuse: 0, rest: 0.1, fric: 0.4,
          });
        }
        w.events.push({ e: 'smoke', x: b.x, y: b.y });
        b.dead = true;
      }
      break;
    }
    case 'coil': {
      b.ttl -= dt;
      if (b.ttl <= 0) b.dead = true;
      break;
    }
    case 'spike': {
      const host = bodyById(w, b.host);
      if (!host || host.dead) { b.dead = true; break; }
      const c = Math.cos(host.ang), s = Math.sin(host.ang);
      b.x = host.x + (b.lx * c - b.ly * s);
      b.y = host.y + (b.lx * s + b.ly * c);
      b.ang = host.ang + b.la;
      b.vx = host.vx; b.vy = host.vy;
      break;
    }
    case 'engine': {
      const host = bodyById(w, b.host);
      b.ttl -= dt;
      if (!host || host.dead || b.ttl <= 0) { b.dead = true; break; }
      const c = Math.cos(host.ang), s = Math.sin(host.ang);
      b.x = host.x + (b.lx * c - b.ly * s);
      b.y = host.y + (b.lx * s + b.ly * c);
      const [nx, ny] = norm(host.x - b.x, host.y - b.y);
      host.anchorOff = 0.2;
      host.vx += nx * b.thrust * host.im * host.mass * dt * 0.14;
      host.vy += ny * b.thrust * host.im * host.mass * dt * 0.14;
      if (w.water != null && b.y > w.water) b.dead = true;
      break;
    }
    case 'hole': {
      const ab = ABILITY_BY_ID.get('blackhole');
      b.ttl -= dt;
      if (b.ttl <= 0) { w.events.push({ e: 'collapse', x: b.x, y: b.y }); b.dead = true; break; }
      const sign = b.white ? -1 : 1;
      for (const other of w.bodies) {
        if (other === b || other.dead || other.kind === 'hole' || other.kind === 'engine' || other.kind === 'spike') continue;
        const dx = b.x - other.x, dy = b.y - other.y;
        const d = len(dx, dy);
        const reach = ab.radius * (0.6 + b.core);
        if (d > reach || d < 1e-4) continue;
        const pull = ab.pull * (b.core * 1.5) / Math.max(0.8, d * d) * sign;
        other.vx += (dx / d) * pull * dt;
        other.vy += (dy / d) * pull * dt;
        const grace = other.kind === 'bopl' && other.pid === b.owner && w.t - b.spawn < 1.6;
        if (grace) continue;
        if (!b.white && d < b.core + other.r * 0.35) {
          if (other.kind === 'bopl') { if (other.alive) kill(w, other, 'hole', b.owner); }
          else { other.dead = true; }
          b.core = Math.min(2.6, b.core + ab.growth * (other.kind === 'plat' ? 3 : 1));
          b.r = b.core;
          w.events.push({ e: 'feed', x: b.x, y: b.y });
        }
      }
      break;
    }
    case 'bubble': {
      b.ttl -= dt;
      if (b.ttl <= 0) b.dead = true;
      break;
    }
    case 'orb': {
      if (b.arm > 0) b.arm -= dt;
      const p = playerById(w, b.owner);
      if (!p || !p.revive || p.reviveSlot !== b.slot) b.dead = true;
      break;
    }
  }
}

function applyRay(w, ray, target) {
  switch (ray.mode) {
    case 'grow': resize(w, target, 1); break;
    case 'shrink': resize(w, target, -1); break;
    case 'blink': {
      const ab = ABILITY_BY_ID.get('blink');
      target.blinks = (target.blinks || 0) + 1;
      const scale = Math.pow(0.72, target.blinks - 1);
      if (target.kind === 'bopl') {
        target.hidden = ab.boplTime * scale;
        target.warp = true;
      } else target.hidden = ab.objectTime * scale;
      w.events.push({ e: 'blink', x: target.x, y: target.y });
      break;
    }
    case 'dup': {
      if (target.kind === 'bopl') break;
      const [nx, ny] = norm(target.x - ray.ox, target.y - ray.oy);
      const off = (target.r + target.hx) * 2 + 0.3;
      const copy = { ...target, id: w.nextId++, x: target.x + nx * off, y: target.y + ny * off, spawn: w.t };
      copy.homeX = copy.x; copy.homeY = copy.y;
      copy.anchorX = copy.x; copy.anchorY = copy.y;
      copy.ptype = target.kind === 'plat' ? 'free' : target.ptype;
      copy.spring = 0;
      copy.host = -1;
      if (copy.kind === 'spike' || copy.kind === 'engine' || copy.kind === 'orb') break;
      w.bodies.push(copy);
      w.events.push({ e: 'dup', x: copy.x, y: copy.y });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------

function hand(p, reach) {
  const r = p.r + (reach || 0.22);
  return [p.x + p.input.ax * r, p.y + p.input.ay * r];
}

function groundPlatform(w, p) {
  if (!p.grounded || p.groundId < 0) return null;
  const b = bodyById(w, p.groundId);
  return b && (b.kind === 'plat' || (b.kind === 'bopl' && b.form === 'platform')) ? b : null;
}

function fireAbility(w, p, slot, index, ab, charge) {
  const scale = sizeScale(p.size);
  const [hx, hy] = hand(p);
  const ax = p.input.ax, ay = p.input.ay;
  switch (ab.id) {
    case 'grenade': {
      const g = bodyById(w, slot.data);
      if (!g) break;
      g.held = false;
      const speed = ab.throw[0] + (ab.throw[1] - ab.throw[0]) * charge;
      g.vx = p.vx * 0.4 + ax * speed;
      g.vy = p.vy * 0.4 + ay * speed;
      w.events.push({ e: 'throw', x: g.x, y: g.y });
      break;
    }
    case 'bow': {
      const speed = ab.speed[0] + (ab.speed[1] - ab.speed[0]) * charge;
      addBody(w, {
        kind: 'arrow', x: hx, y: hy, vx: ax * speed + p.vx * 0.3, vy: ay * speed + p.vy * 0.3,
        r: 0.11 * scale, hx: 0.26 * scale, ang: Math.atan2(ay, ax), owner: p.pid, slot: index,
        lethal: true, gravity: 0.45, density: 0.4, ttl: 4, drag: 0.01,
      });
      w.events.push({ e: 'bow', x: hx, y: hy });
      break;
    }
    case 'blink': case 'duplicator': case 'growray': case 'shrinkray': {
      const mode = ab.id === 'blink' ? 'blink' : ab.id === 'duplicator' ? 'dup' : ab.id === 'growray' ? 'grow' : 'shrink';
      addBody(w, {
        kind: 'ray', mode, x: hx, y: hy, vx: ax * ab.speed, vy: ay * ab.speed,
        r: 0.16, owner: p.pid, slot: index, gravity: 0, ttl: 1.1, im: 1, density: 0.05,
        ox: p.x, oy: p.y, drag: 0,
      });
      w.events.push({ e: 'ray', x: hx, y: hy, m: mode });
      break;
    }
    case 'meteor': {
      p.form = 'meteor';
      p.formT = 1.4;
      p.charge = charge;
      p.vy = -3.2;
      p.slamDelay = 0.16;
      w.events.push({ e: 'meteor', x: p.x, y: p.y });
      break;
    }
    case 'roll': {
      p.form = 'roll';
      p.formT = ab.duration;
      p.rollDir = ax >= 0 ? 1 : -1;
      p.lethal = true;
      w.events.push({ e: 'roll', x: p.x, y: p.y });
      break;
    }
    case 'smoke': {
      const speed = ab.throw[0] + (ab.throw[1] - ab.throw[0]) * charge;
      addBody(w, {
        kind: 'canister', x: hx, y: hy, vx: ax * speed + p.vx * 0.4, vy: ay * speed + p.vy * 0.4,
        r: 0.2 * scale, owner: p.pid, slot: index, gravity: 1, density: 0.7, ttl: 3, scaleUp: scale,
      });
      break;
    }
    case 'throw': {
      const host = bodyById(w, slot.data);
      if (!host || host.dead) break;
      const grab = Math.min(host.r * 0.75, 0.62 * scale);
      const speed = ab.speed[0] + (ab.speed[1] - ab.speed[0]) * charge;
      addBody(w, {
        kind: 'boulder', x: hx + ax * 0.3, y: hy + ay * 0.3,
        vx: ax * speed + p.vx * 0.4, vy: ay * speed + p.vy * 0.4,
        r: grab, baseR: grab, owner: p.pid, slot: index, density: 3.4, gravity: 1,
        rest: 0.15, fric: 0.8, ttl: 14, rotates: true, lethal: true,
      });
      host.size = Math.max(-4, host.size - 0.7);
      const hostScale = sizeScale(host.size);
      host.hx = host.baseHx * hostScale;
      host.r = host.baseR * hostScale;
      setMass(host, host.density);
      host.revert = ABILITY_BY_ID.get('growray').revert;
      w.events.push({ e: 'quarry', x: hx, y: hy });
      break;
    }
    case 'timestop': {
      w.freeze = { owner: p.pid, t: ab.duration };
      w.events.push({ e: 'freeze', x: p.x, y: p.y, c: p.idx });
      break;
    }
  }
}

function tapAbility(w, p, slot, index, ab) {
  const scale = sizeScale(p.size);
  const [hx, hy] = hand(p);
  switch (ab.id) {
    case 'dash': {
      p.vx = p.input.ax * ab.speed;
      p.vy = p.input.ay * ab.speed;
      p.iframes = Math.max(p.iframes, ab.iframes);
      w.events.push({ e: 'dash', x: p.x, y: p.y });
      return true;
    }
    case 'gust': {
      w.events.push({ e: 'gust', x: p.x, y: p.y, r: ab.radius * scale });
      for (const b of w.bodies) {
        if (b === p || b.dead) continue;
        const dx = b.x - p.x, dy = b.y - p.y;
        const d = len(dx, dy);
        if (d > ab.radius * scale + b.r) continue;
        const [nx, ny] = d > 1e-4 ? [dx / d, dy / d] : [0, -1];
        const f = ab.impulse * (1 - clamp(d / (ab.radius * scale), 0, 1));
        b.vx += nx * f * Math.min(1.1, b.im * 2.2);
        b.vy += ny * f * Math.min(1.1, b.im * 2.2);
        if (b.kind === 'plat') b.anchorOff = Math.max(b.anchorOff, 0.45);
      }
      return true;
    }
    case 'invis': p.invis = ab.duration; w.events.push({ e: 'fade', x: p.x, y: p.y }); return true;
    case 'mine': {
      addBody(w, {
        kind: 'mine', x: hx, y: hy, vx: p.vx * 0.4, vy: p.vy * 0.4, r: 0.24 * scale,
        owner: p.pid, slot: index, density: 1.6, state: 0, prime: ab.prime, hunt: ab.hunt,
        boom: false, rest: 0.05, fric: 0.9, gravity: 1,
      });
      return true;
    }
    case 'revival': {
      for (const b of w.bodies) if (b.kind === 'orb' && b.owner === p.pid && b.slot === index) b.dead = true;
      p.revive = true; p.reviveSlot = index; p.reviveX = p.x; p.reviveY = p.y;
      addBody(w, { kind: 'orb', x: p.x, y: p.y, r: 0.3, owner: p.pid, slot: index, im: 0, gravity: 0, arm: ab.arm });
      w.events.push({ e: 'orb', x: p.x, y: p.y });
      return true;
    }
    case 'blackhole': {
      addBody(w, {
        kind: 'hole', x: hx + p.input.ax * 2.1, y: hy + p.input.ay * 2.1, vx: p.input.ax * 6.5, vy: p.input.ay * 6.5,
        r: 0.34, core: 0.34, white: false, owner: p.pid, slot: index, im: 0, gravity: 0, ttl: ab.life,
      });
      w.events.push({ e: 'hole', x: hx, y: hy });
      return true;
    }
    case 'teleport': {
      const existing = w.bodies.find(b => b.kind === 'bubble' && b.owner === p.pid && b.slot === index && !b.dead);
      if (!existing) {
        addBody(w, { kind: 'bubble', x: p.x, y: p.y, r: ab.radius * scale, owner: p.pid, slot: index, im: 0, gravity: 0, ttl: ab.life });
        w.events.push({ e: 'bubble', x: p.x, y: p.y });
        return false;               // placing does not burn the cooldown
      }
      const dx = existing.x - p.x, dy = existing.y - p.y;
      const riders = w.bodies.filter(b => b !== p && !b.dead && b.kind !== 'bubble' && b.kind !== 'plat' && b.kind !== 'orb'
        && len(b.x - existing.x, b.y - existing.y) < existing.r + b.r);
      for (const b of riders) { b.x -= dx; b.y -= dy; }
      p.x += dx; p.y += dy;
      existing.dead = true;
      w.events.push({ e: 'warp', x: p.x, y: p.y });
      return true;
    }
    case 'engine': {
      const host = groundPlatform(w, p);
      if (!host) return false;
      const s = surfacePoint(host, p.x, p.y);
      const c = Math.cos(-host.ang), sn = Math.sin(-host.ang);
      const dx = s.sx - host.x, dy = s.sy - host.y;
      addBody(w, {
        kind: 'engine', x: s.sx, y: s.sy, r: 0.22 * scale, owner: p.pid, slot: index,
        host: host.id, lx: dx * c - dy * sn, ly: dx * sn + dy * c, im: 0, gravity: 0,
        ttl: ab.duration, thrust: ab.thrust,
      });
      w.events.push({ e: 'engine', x: s.sx, y: s.sy });
      return true;
    }
    case 'spike': {
      const host = groundPlatform(w, p);
      if (!host) return false;
      for (const b of w.bodies) if (b.kind === 'spike' && b.owner === p.pid && b.slot === index) b.dead = true;
      const s = surfacePoint(host, p.x, p.y);
      const ox = -s.nx, oy = -s.ny;                       // opposite side of the platform
      const far = surfacePoint(host, host.x + ox * (host.r + host.hx + 4), host.y + oy * (host.r + host.hx + 4));
      const half = ABILITY_BY_ID.get('spike').length * scale;
      const bx = far.sx + far.nx * half, by = far.sy + far.ny * half;
      const c = Math.cos(-host.ang), sn = Math.sin(-host.ang);
      const dx = bx - host.x, dy = by - host.y;
      addBody(w, {
        kind: 'spike', x: bx, y: by, r: 0.16 * scale, hx: half, ang: Math.atan2(far.ny, far.nx),
        owner: p.pid, slot: index, host: host.id, lethal: true, im: 0, gravity: 0,
        lx: dx * c - dy * sn, ly: dx * sn + dy * c, la: Math.atan2(far.ny, far.nx) - host.ang,
      });
      w.events.push({ e: 'spike', x: bx, y: by });
      return true;
    }
    case 'tesla': {
      const host = groundPlatform(w, p);
      if (!host) return false;
      const mine = w.bodies.filter(b => b.kind === 'coil' && b.owner === p.pid && b.slot === index && !b.dead);
      if (mine.length >= 2) mine[0].dead = true;
      addBody(w, {
        kind: 'coil', x: p.x, y: p.y - p.r * 0.2, r: 0.26 * scale, hx: 0.3 * scale, ang: Math.PI / 2,
        owner: p.pid, slot: index, density: 4, gravity: 1, ttl: ABILITY_BY_ID.get('tesla').life,
        rest: 0.05, fric: 0.9,
      });
      w.events.push({ e: 'coil', x: p.x, y: p.y });
      return true;
    }
  }
  return true;
}

function channelAbility(w, p, slot, index, ab, dt) {
  switch (ab.id) {
    case 'beam': {
      p.form = 'beam';
      const [hx, hy] = hand(p, 0.1);
      const dirx = p.input.ax, diry = p.input.ay;
      let reach = ab.range;
      const blocker = raycast(w, hx, hy, dirx, diry, ab.range, b => b.kind === 'plat' && b.hidden <= 0);
      if (blocker) reach = blocker.d;
      p.beamLen = reach;
      for (const b of w.bodies) {
        if (b === p || b.dead || b.kind === 'engine' || b.kind === 'orb' || b.kind === 'bubble') continue;
        const [a0x, a0y, a1x, a1y] = ends(b);
        const [cax, cay, cbx, cby] = closestSeg(hx, hy, hx + dirx * reach, hy + diry * reach, a0x, a0y, a1x, a1y);
        if (len(cbx - cax, cby - cay) > b.r + 0.16) continue;
        if (b.kind === 'bopl') { if (vulnerable(b)) kill(w, b, 'beam', p.pid); continue; }
        if (b.kind === 'smoke') { igniteSmoke(w, b); continue; }
        if (b.kind === 'grenade') { b.fuse = Math.min(b.fuse, 0.05); continue; }
        if (b.kind === 'mine') { b.boom = true; continue; }
        if (b.kind === 'missile') { explode(w, b.x, b.y, b.blast, b.impulse, b.owner); b.dead = true; continue; }
        b.vx += dirx * ab.push * dt * Math.min(1.4, b.im * 2.4);
        b.vy += diry * ab.push * dt * Math.min(1.4, b.im * 2.4);
        if (b.kind === 'plat') b.anchorOff = Math.max(b.anchorOff, 0.25);
      }
      break;
    }
    case 'drill': {
      p.form = 'drill';
      const want = Math.atan2(p.input.ay, p.input.ax);
      let da = want - (p.drillAng ?? want);
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      p.drillAng = (p.drillAng ?? want) + clamp(da, -ab.turn * dt, ab.turn * dt);
      p.drillSpeed = Math.min(ab.top, (p.drillSpeed || 3) + ab.accel * dt);
      p.vx = Math.cos(p.drillAng) * p.drillSpeed;
      p.vy = Math.sin(p.drillAng) * p.drillSpeed;
      break;
    }
    case 'grapple': {
      if (p.grappleId === -1 && slot.t < 0.02) {
        const [hx, hy] = hand(p, 0.05);
        p.grappleId = -2;
        addBody(w, {
          kind: 'hook', x: hx, y: hy, vx: p.input.ax * ab.speed, vy: p.input.ay * ab.speed,
          r: 0.14, owner: p.pid, slot: index, im: 0, gravity: 0, ttl: 1.0,
        });
      }
      if (p.grappleId >= 0) {
        const host = bodyById(w, p.grappleId);
        if (!host || host.dead || host.hidden > 0) { p.grappleId = -1; break; }
        const c = Math.cos(host.ang), s = Math.sin(host.ang);
        const ax = host.x + (p.grappleLx * c - p.grappleLy * s);
        const ay = host.y + (p.grappleLx * s + p.grappleLy * c);
        p.grappleLen = Math.max(0.5, p.grappleLen - ab.reel * dt * 0.55);
        const dx = ax - p.x, dy = ay - p.y;
        const d = len(dx, dy);
        if (d > p.grappleLen && d > 1e-4) {
          const nx = dx / d, ny = dy / d;
          const rvn = (p.vx - host.vx) * nx + (p.vy - host.vy) * ny;
          const inv = p.im + host.im;
          const raw = (-rvn - (d - p.grappleLen) * 4.5) / inv;
          const cap = 9 / Math.max(p.im, 1e-6);
          const j = clamp(raw, -cap, cap);
          p.vx += nx * j * p.im; p.vy += ny * j * p.im;
          host.vx -= nx * j * host.im; host.vy -= ny * j * host.im;
          if (host.kind === 'plat') host.anchorOff = Math.max(host.anchorOff, 0.12);
        }
      }
      break;
    }
    case 'magnet': {
      p.form = 'gun';
      const [hx, hy] = hand(p, 0.3);
      if (p.heldId >= 0) {
        const held = bodyById(w, p.heldId);
        if (!held || held.dead) { p.heldId = -1; break; }
        held.vx = (hx - held.x) * 18;
        held.vy = (hy - held.y) * 18;
        held.av *= 0.9;
        if (held.kind === 'plat') held.anchorOff = 0.2;
        break;
      }
      let target = null, best = ab.range;
      for (const b of w.bodies) {
        if (b === p || b.dead || b.im === 0 || b.kind === 'orb' || b.kind === 'bubble') continue;
        const dx = b.x - hx, dy = b.y - hy;
        const d = len(dx, dy);
        if (d > best) continue;
        if ((dx / d) * p.input.ax + (dy / d) * p.input.ay < 0.72) continue;
        best = d; target = b;
      }
      if (target) {
        const [nx, ny] = norm(hx - target.x, hy - target.y);
        target.vx += nx * ab.pull * dt * Math.min(1.2, target.im * 2);
        target.vy += ny * ab.pull * dt * Math.min(1.2, target.im * 2);
        if (target.kind === 'plat') target.anchorOff = Math.max(target.anchorOff, 0.3);
        if (best < p.r + target.r + 0.45) { p.heldId = target.id; w.events.push({ e: 'grab', x: target.x, y: target.y }); }
      }
      break;
    }
    case 'platform': {
      if (p.form !== 'platform') {
        p.form = 'platform';
        p.rotates = true;
        p.hx = 1.35;
        p.r = TUNE.boplRadius * sizeScale(p.size) * 1.5;
        setMass(p, 2.4);
        p.av = 0;
      }
      p.hx = clamp(p.hx + p.input.mx * 1.5 * dt, 0.35, 2.6);
      setMass(p, 2.4);
      const want = Math.atan2(p.input.ay, p.input.ax);
      let da = want - p.ang;
      while (da > Math.PI) da -= TAU;
      while (da < -Math.PI) da += TAU;
      p.av += clamp(da, -1, 1) * 12 * dt;
      p.av *= 0.9;
      p.vx += p.input.ax * 15 * dt;
      p.vy += p.input.ay * 15 * dt;
      break;
    }
    case 'push': {
      const host = groundPlatform(w, p);
      if (!host) break;
      host.anchorOff = 0.12;
      const f = ab.force / Math.max(1, host.mass * 0.09);
      host.vx += p.input.mx * f * dt;
      if (p.input.jump) host.vy -= f * dt * 0.6;
      break;
    }
    case 'rock': {
      if (p.form !== 'rock') {
        p.form = 'rock';
        p.lethal = true;
        p.rest = 0.55;
        setMass(p, TUNE.boplDensity * ABILITY_BY_ID.get('rock').massScale);
        w.events.push({ e: 'rock', x: p.x, y: p.y });
      }
      break;
    }
  }
}

function endChannel(w, p, ab) {
  switch (ab.id) {
    case 'drill': {
      p.vx *= 0.25;
      p.drillSpeed = 0;
      break;
    }
    case 'magnet': {
      if (p.heldId >= 0) {
        const held = bodyById(w, p.heldId);
        if (held) {
          held.vx = p.input.ax * ab.fling;
          held.vy = p.input.ay * ab.fling;
          if (held.kind === 'plat') held.anchorOff = 1.2;
          w.events.push({ e: 'fling', x: held.x, y: held.y });
        }
        p.heldId = -1;
      }
      break;
    }
    case 'grapple': p.grappleId = -1; break;
    case 'rock': { p.rest = 0.02; refreshSize(p); break; }
  }
  leaveForm(w, p);
}

const FORM_ABILITY = new Set(['rock', 'bow', 'beam', 'drill', 'blink', 'duplicator', 'growray', 'shrinkray', 'magnet', 'platform', 'roll', 'meteor', 'throw', 'timestop']);

function stepAbilities(w, p, dt) {
  const locked = p.form === 'rock' || p.form === 'roll' || p.form === 'meteor' || p.form === 'platform' || p.form === 'drill';
  for (let index = 0; index < p.slots.length; index++) {
    const slot = p.slots[index];
    const ab = ABILITY_BY_ID.get(slot.id);
    if (!ab) continue;
    const down = p.input.ab[index];
    const pressed = down && !slot.down;
    const released = !down && slot.down;
    slot.down = down;
    if (slot.cd > 0) slot.cd = Math.max(0, slot.cd - dt * (w.freeze && w.freeze.owner === p.pid ? 2.2 : 1));

    if (ab.kind === 'tap') {
      if (pressed && slot.cd <= 0 && !locked) {
        if (tapAbility(w, p, slot, index, ab)) slot.cd = ab.cd;
      }
      continue;
    }

    if (ab.kind === 'toggle') {
      if (slot.state === 1) {
        slot.t -= dt;
        channelAbility(w, p, slot, index, ab, dt);
        if (pressed || slot.t <= 0) { slot.state = 0; endChannel(w, p, ab); slot.cd = ab.cd; }
      } else if (pressed && slot.cd <= 0 && p.form === 'normal') {
        slot.state = 1; slot.t = ab.duration;
        channelAbility(w, p, slot, index, ab, dt);
      }
      continue;
    }

    if (ab.kind === 'channel') {
      if (slot.state === 1) {
        slot.t += dt;
        slot.fuel -= dt;
        p.fuel = clamp(slot.fuel / ab.fuel, 0, 1);
        channelAbility(w, p, slot, index, ab, dt);
        if (released || slot.fuel <= 0 || !p.alive) { slot.state = 0; endChannel(w, p, ab); slot.cd = ab.cd; p.fuel = 0; }
      } else if (pressed && slot.cd <= 0 && (p.form === 'normal' || ab.id === 'grapple' || ab.id === 'push')) {
        slot.state = 1; slot.t = 0; slot.fuel = ab.fuel;
        channelAbility(w, p, slot, index, ab, dt);
      }
      continue;
    }

    // hold: charge while down, fire on release
    if (slot.state === 1) {
      slot.t = Math.min(ab.charge, slot.t + dt);
      p.charge = slot.t / ab.charge;
      if (ab.id === 'bow' || ab.id === 'blink' || ab.id === 'duplicator' || ab.id === 'growray' || ab.id === 'shrinkray') p.form = ab.id === 'bow' ? 'bow' : 'gun';
      if (ab.id === 'timestop') {
        p.form = 'timestop';
        if (slot.t >= ab.charge) { fireAbility(w, p, slot, index, ab, 1); slot.state = 0; slot.cd = ab.cd; leaveForm(w, p); p.charge = 0; continue; }
      }
      if (ab.id === 'throw') p.form = 'throw';
      if (released) {
        const ready = ab.id === 'timestop' ? slot.t >= ab.charge : true;
        const wasForm = p.form;
        slot.state = 0;
        if (ready) fireAbility(w, p, slot, index, ab, slot.t / ab.charge);
        // Roll and Meteor put the bopl straight into a new form, so only clear
        // the charge-up form if the shot did not replace it.
        if (p.form === wasForm) leaveForm(w, p);
        slot.cd = ab.cd;
        p.charge = 0;
      }
    } else if (pressed && slot.cd <= 0 && !locked && (p.form === 'normal' || !FORM_ABILITY.has(ab.id))) {
      if (ab.id === 'throw') {
        const host = groundPlatform(w, p);
        if (!host) continue;
        slot.data = host.id;
      }
      if (ab.id === 'grenade') {
        const scale = sizeScale(p.size);
        const g = addBody(w, {
          kind: 'grenade', x: p.x, y: p.y, r: 0.22 * scale, owner: p.pid, slot: index,
          density: 1.1, fuse: ab.fuse, blast: ab.blast * scale, impulse: ab.impulse,
          held: true, rest: 0.35, fric: 0.6, gravity: 1,
        });
        slot.data = g.id;
      }
      if (ab.id === 'missile') {
        const scale = sizeScale(p.size);
        addBody(w, {
          kind: 'missile', x: p.x + p.input.ax * 0.2, y: p.y - p.r - 0.35,
          r: 0.16 * scale, hx: 0.28 * scale, ang: -Math.PI / 2, owner: p.pid, slot: index,
          guided: true, speed: 1.4, blast: ab.blast * scale, impulse: ab.impulse,
          im: 0, gravity: 0, ttl: 6,
        });
      }
      slot.state = 1;
      slot.t = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Bopl control
// ---------------------------------------------------------------------------

function stepPlayer(w, p, dt) {
  p.iframes = Math.max(0, p.iframes - dt);
  p.invis = Math.max(0, p.invis - dt);
  if (p.hidden > 0) {
    p.hidden -= dt;
    if (p.hidden <= 0 && p.warp) {
      p.warp = false;
      const a = w.rand() * TAU, d = 1.4 + w.rand() * 2.2;
      p.x += Math.cos(a) * d;
      p.y += Math.sin(a) * d;
      p.vx = 0; p.vy = 0;
      p.iframes = Math.max(p.iframes, 0.2);
      w.events.push({ e: 'blink', x: p.x, y: p.y });
    }
  }
  if (p.formT > 0) {
    p.formT -= dt;
    if (p.formT <= 0 && (p.form === 'roll' || p.form === 'meteor')) { p.lethal = false; leaveForm(w, p); }
  }

  if (p.form === 'rock' || p.form === 'platform' || p.form === 'drill') return;

  if (p.form === 'roll') {
    const ab = ABILITY_BY_ID.get('roll');
    let host = null, bestD = 3.2;
    for (const b of w.bodies) {
      if (b.dead || b.hidden > 0) continue;
      if (b.kind !== 'plat' && !(b.kind === 'bopl' && b !== p && b.form === 'platform')) continue;
      const s = surfacePoint(b, p.x, p.y);
      const d = len(p.x - s.sx, p.y - s.sy);
      if (d < bestD) { bestD = d; host = b; }
    }
    if (!host) { p.lethal = false; leaveForm(w, p); return; }
    const s = surfacePoint(host, p.x, p.y);
    const tx = -s.ny * p.rollDir, ty = s.nx * p.rollDir;
    p.x = s.sx + s.nx * p.r + tx * ab.speed * dt;
    p.y = s.sy + s.ny * p.r + ty * ab.speed * dt;
    p.vx = tx * ab.speed + host.vx;
    p.vy = ty * ab.speed + host.vy;
    if (p.input.jump && !p.jumpHeld) { p.formT = 0; p.lethal = false; leaveForm(w, p); p.vy -= 3; }
    p.jumpHeld = p.input.jump;
    return;
  }

  if (p.form === 'meteor') {
    const ab = ABILITY_BY_ID.get('meteor');
    if (p.slamDelay > 0) { p.slamDelay -= dt; }
    else {
      p.vy = ab.speed;
      p.vx *= 0.86;
      p.lethal = true;
      if (p.grounded) {
        const r = ab.radius[0] + (ab.radius[1] - ab.radius[0]) * (p.charge || 0);
        w.events.push({ e: 'slam', x: p.x, y: p.y, r });
        for (const b of w.bodies) {
          if (b === p || b.dead) continue;
          const dx = b.x - p.x, dy = b.y - p.y;
          const d = len(dx, dy);
          if (d > r + b.r) continue;
          const [nx, ny] = d > 1e-4 ? [dx / d, dy / d] : [0, -1];
          const f = ab.impulse * (1 - clamp(d / r, 0, 1));
          b.vx += nx * f * Math.min(1.1, b.im * 2.2);
          b.vy += ny * f * Math.min(1.1, b.im * 2.2) - (b.kind === 'bopl' ? f * 0.35 : 0);
          if (b.kind === 'plat') b.anchorOff = Math.max(b.anchorOff, 0.5);
        }
        p.lethal = false;
        p.formT = 0;
        leaveForm(w, p);
      }
    }
    return;
  }

  const gunned = p.form === 'gun' || p.form === 'bow' || p.form === 'throw' || p.form === 'timestop';
  const cap = gunned ? 1.7 : TUNE.runSpeed;
  const accel = (p.grounded ? TUNE.runAccel : TUNE.airAccel) * (gunned ? 0.4 : 1);
  const target = p.input.mx * cap;
  const ground = p.groundId >= 0 ? bodyById(w, p.groundId) : null;
  const carry = p.grounded && ground ? ground.vx : 0;
  const rel = p.vx - carry;
  if (p.input.mx !== 0) {
    const want = target - rel;
    p.vx += clamp(want, -accel * dt, accel * dt);
    p.face = p.input.mx > 0 ? 1 : -1;
  } else if (p.grounded) {
    const damp = Math.min(1, TUNE.groundFriction * dt * (ground && ground.fric < 0.2 ? 0.08 : 1));
    p.vx -= rel * damp;
  }

  if (p.input.jump && !p.jumpHeld) p.jumpBuffer = TUNE.jumpBuffer;
  p.jumpHeld = p.input.jump;
  p.jumpBuffer = Math.max(0, p.jumpBuffer - dt);
  p.coyote = p.grounded ? TUNE.coyote : Math.max(0, p.coyote - dt);
  if (p.jumpBuffer > 0 && p.coyote > 0 && p.grappleId < 0) {
    const jump = w.gravity < TUNE.gravity * 0.7 ? TUNE.spaceJumpSpeed : TUNE.jumpSpeed;
    p.vy = -jump * (0.82 + 0.18 * sizeScale(p.size));
    p.jumpBuffer = 0; p.coyote = 0; p.grounded = false;
    w.events.push({ e: 'jump', x: p.x, y: p.y });
  } else if (p.jumpBuffer > 0 && p.grappleId >= 0) {
    p.grappleId = -1;
    for (const s of p.slots) if (ABILITY_BY_ID.get(s.id)?.id === 'grapple' && s.state === 1) { s.state = 0; s.cd = ABILITY_BY_ID.get('grapple').cd; }
    p.jumpBuffer = 0;
  }
}

// ---------------------------------------------------------------------------
// Post-solve: footing, crushing, hazards
// ---------------------------------------------------------------------------

function postSolve(w, contacts, dt) {
  for (const p of w.players) { p.grounded = false; p.groundId = -1; p.touch = null; }
  const hits = new Map();
  for (const c of contacts) {
    for (const side of [0, 1]) {
      const self = side ? c.b : c.a;
      if (self.kind !== 'bopl' || !self.alive) continue;
      const other = side ? c.a : c.b;
      const nx = side ? -c.nx : c.nx;
      const ny = side ? -c.ny : c.ny;
      if (ny > 0.55 && other.kind !== 'bopl') { self.grounded = true; self.groundId = other.id; self.groundNx = nx; self.groundNy = ny; }
      else if (ny > 0.55 && other.form === 'platform') { self.grounded = true; self.groundId = other.id; }
      if (!hits.has(self)) hits.set(self, []);
      hits.get(self).push([nx, ny, c.pen]);
    }
  }
  // Two surfaces closing from opposite sides is the classic Bopl death. We look
  // for sustained opposing penetration rather than a single frame spike so a
  // hard landing does not count as a crushing.
  for (const p of w.players) {
    if (!p.alive) { p.stretch = 0; continue; }
    const list = hits.get(p) || [];
    let worst = 0;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const dot = list[i][0] * list[j][0] + list[i][1] * list[j][1];
        if (dot > -0.45) continue;
        worst = Math.max(worst, list[i][2] + list[j][2]);
      }
    }
    p.stretch = clamp(worst / (p.r * TUNE.squishRatio), 0, 1.4);
    if (worst > p.r * TUNE.squishRatio && p.form !== 'platform') {
      p.squish += dt;
      if (p.squish > TUNE.squishGrace) kill(w, p, 'squish', -1);
    } else p.squish = Math.max(0, p.squish - dt * 2);
  }
}

function overlapsBody(b, px, py, pr) {
  const [a0x, a0y, a1x, a1y] = ends(b);
  const [cx, cy] = closestSeg(a0x, a0y, a1x, a1y, px, py, px, py);
  return len(px - cx, py - cy) <= b.r + pr;
}

function hazards(w, dt) {
  // Lethal touches.
  for (const p of w.players) {
    if (!vulnerable(p)) continue;
    for (const b of w.bodies) {
      if (b === p || b.dead || b.hidden > 0 || !b.lethal) continue;
      if (b.kind === 'bopl' && !b.alive) continue;
      if (b.owner === p.pid && b.kind === 'arrow' && w.t - b.spawn < 0.14) continue;
      if (b.kind === 'bopl' && b.form === 'drill') continue;    // handled below, tip only
      if (!overlapsBody(b, p.x, p.y, p.r)) continue;
      kill(w, p, b.kind === 'bopl' ? b.form : b.kind, b.kind === 'bopl' ? b.pid : b.owner);
      if (b.kind === 'arrow' || b.kind === 'spike') { if (b.kind === 'arrow') b.dead = true; }
      break;
    }
  }
  // Drill bits: only the leading tip bites.
  for (const d of w.players) {
    if (!d.alive || d.form !== 'drill') continue;
    const tx = d.x + d.input.ax * d.r, ty = d.y + d.input.ay * d.r;
    for (const p of w.players) {
      if (p === d || !vulnerable(p)) continue;
      if (len(p.x - tx, p.y - ty) < p.r + d.r * 0.5) kill(w, p, 'drill', d.pid);
    }
  }
  // Tesla arcs between a player's own pair of coils.
  const coils = w.bodies.filter(b => b.kind === 'coil' && !b.dead);
  for (let i = 0; i < coils.length; i++) {
    for (let j = i + 1; j < coils.length; j++) {
      const a = coils[i], b = coils[j];
      if (a.owner !== b.owner || a.slot !== b.slot) continue;
      for (const p of w.players) {
        if (!vulnerable(p)) continue;
        // The coils are yours; the arc between them is not going to bite you.
        if (p.pid === a.owner) continue;
        const [cax, cay, cbx, cby] = closestSeg(a.x, a.y, b.x, b.y, p.x, p.y, p.x, p.y);
        if (len(cbx - cax, cby - cay) < p.r + 0.3) kill(w, p, 'tesla', a.owner);
      }
    }
  }
  // Eating: two full sizes up and touching is a meal.
  for (const a of w.players) {
    if (!a.alive || a.form === 'platform' || a.hidden > 0) continue;
    for (const b of w.players) {
      if (b === a || !vulnerable(b) || b.form === 'platform') continue;
      if (a.size < b.size + TUNE.eatSizeGap) continue;
      if (len(a.x - b.x, a.y - b.y) > a.r + b.r + 0.04) continue;
      kill(w, b, 'eaten', a.pid);
      a.eaten++;
      a.size = clamp(a.size + TUNE.eatGrowth, TUNE.sizeMin, TUNE.sizeMax);
      refreshSize(a);
      w.events.push({ e: 'eat', x: a.x, y: a.y });
    }
  }
}

function boundsCheck(w) {
  const bx = w.bounds.x, by = w.bounds.y;
  for (const b of w.bodies) {
    if (b.dead) continue;
    if (b.kind === 'bopl') {
      if (!b.alive) continue;
      if (w.water != null && b.y - b.r * 0.2 > w.water) { kill(w, b, 'water', -1); continue; }
      if (b.x < -bx || b.x > bx || b.y < -by - 3 || b.y > by) kill(w, b, 'bounds', -1);
      continue;
    }
    if (b.kind === 'plat') {
      if (b.x < -bx - 4 || b.x > bx + 4 || b.y > by + 4 || b.y < -by - 8) b.dead = true;
      continue;
    }
    if (b.kind === 'spike' || b.kind === 'engine' || b.kind === 'orb') continue;
    if (w.water != null && b.y > w.water + 0.3 && b.kind !== 'hole') b.dead = true;
    if (b.x < -bx - 2 || b.x > bx + 2 || b.y > by + 2 || b.y < -by - 6) b.dead = true;
  }
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

export function aliveCount(w) {
  let n = 0;
  for (const p of w.players) if (p.alive) n++;
  return n;
}

function checkRound(w) {
  if (w.phase !== 'play') return;
  const alive = w.players.filter(p => p.alive);
  if (w.players.length > 1 ? alive.length <= 1 : alive.length === 0) {
    w.phase = 'over';
    w.phaseT = TUNE.roundOutro;
    w.winner = alive.length === 1 ? alive[0].pid : -1;
    w.events.push({ e: 'round', pid: w.winner });
  }
}

export function step(w, dt) {
  w.tick++;
  w.events.length = 0;

  if (w.freeze) {
    w.freeze.t -= dt;
    const owner = playerById(w, w.freeze.owner);
    if (w.freeze.t <= 0 || !owner || !owner.alive) { w.events.push({ e: 'thaw' }); w.freeze = null; }
  }

  if (w.phase === 'intro') { w.phaseT -= dt; if (w.phaseT <= 0) { w.phase = 'play'; w.events.push({ e: 'go' }); } }
  else if (w.phase === 'play') {
    w.t += dt;
    if (w.t > TUNE.roundTime) {
      if (w.sudden === 0) w.events.push({ e: 'sudden' });
      w.sudden += dt;
      w.bounds.x = Math.max(4.6, w.baseBounds.x - w.sudden * TUNE.suddenShrink);
      w.bounds.y = Math.max(3.4, w.baseBounds.y - w.sudden * TUNE.suddenShrink * 0.5);
      if (w.water != null) w.water = Math.min(THEMES[w.theme].water, w.bounds.y - 1.1);
      const shrink = Math.max(0.22, 1 - w.sudden * TUNE.suddenPlatform);
      for (const b of w.bodies) {
        if (b.kind !== 'plat') continue;
        b.hx = b.baseHx * shrink * sizeScale(b.size);
        b.r = b.baseR * shrink * sizeScale(b.size);
        setMass(b, b.density);
      }
    }
  } else if (w.phase === 'over') w.phaseT -= dt;

  const frozen = w.freeze;
  const awake = b => !frozen || (b.kind === 'bopl' && b.pid === frozen.owner);

  if (w.phase !== 'intro') {
    for (const p of w.players) {
      if (!p.alive || !awake(p)) continue;
      stepAbilities(w, p, dt);
      stepPlayer(w, p, dt);
    }
  }

  for (const b of w.bodies) {
    if (b.dead || !awake(b)) continue;
    if (b.kind === 'plat') stepPlatform(w, b, dt);
    else if (b.kind !== 'bopl') stepObject(w, b, dt);
  }

  // Integrate. Frozen bodies are temporarily infinite mass so the solver cannot
  // shove them either.
  const held = [];
  for (const b of w.bodies) {
    if (b.dead) continue;
    if (!awake(b)) { held.push([b, b.im, b.ii]); b.im = 0; b.ii = 0; continue; }
    if (b.kind === 'bopl' && !b.alive) continue;
    if (b.im > 0) {
      b.vy += w.gravity * b.gravity * dt;
      if (b.drag > 0) { const f = 1 - b.drag * dt; b.vx *= f; b.vy *= f; }
      const sp = len(b.vx, b.vy);
      if (sp > TUNE.maxSpeed) { const k = TUNE.maxSpeed / sp; b.vx *= k; b.vy *= k; }
    }
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    if (b.rotates) { b.ang += b.av * dt; b.av *= 1 - Math.min(0.9, 1.6 * dt); }
  }

  const contacts = makeContacts(w);
  solve(w, contacts, dt);
  postSolve(w, contacts, dt);
  for (const [b, im, ii] of held) { b.im = im; b.ii = ii; }
  if (w.phase !== 'intro') hazards(w, dt);
  boundsCheck(w);
  removeDead(w);
  checkRound(w);
  return w.events;
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------
// The initial state is rebuilt from (seed, mapIndex, players) on both sides, so
// snapshots only carry what actually moves plus a one-off spec for each body
// that gets created mid-round.

const FORMS = ['normal', 'gun', 'bow', 'rock', 'platform', 'drill', 'roll', 'beam', 'meteor', 'throw', 'timestop'];
const LOCAL_ID_BASE = 1000000;

const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;

export function markSpeculative(w) { w.nextId = LOCAL_ID_BASE; }

function boplDynamic(p) {
  let bits = 0;
  for (let i = 0; i < p.input.ab.length; i++) if (p.input.ab[i]) bits |= 1 << i;
  return [
    p.id, r2(p.x), r2(p.y), r2(p.vx), r2(p.vy), r3(p.r), r2(p.hx), r3(p.ang),
    p.alive ? 1 : 0, FORMS.indexOf(p.form), r2(p.formT), r2(p.fuel), r2(p.charge),
    r3(p.input.ax), r3(p.input.ay), p.grounded ? 1 : 0, r2(p.invis), r2(p.iframes),
    r2(p.size), p.kills, r2(p.hidden), p.grappleId, r2(p.grappleLen), p.heldId,
    p.revive ? 1 : 0, r2(p.reviveX), r2(p.reviveY), p.face, r2(p.stretch),
    r2(p.beamLen || 0), r2(p.input.mx), bits, p.eaten,
  ];
}

function applyBoplDynamic(p, d, isLocal) {
  p.x = d[1]; p.y = d[2]; p.vx = d[3]; p.vy = d[4]; p.r = d[5]; p.hx = d[6]; p.ang = d[7];
  p.alive = !!d[8]; p.form = FORMS[d[9]] || 'normal'; p.formT = d[10]; p.fuel = d[11]; p.charge = d[12];
  p.grounded = !!d[15]; p.invis = d[16]; p.iframes = d[17]; p.size = d[18]; p.kills = d[19];
  p.hidden = d[20]; p.grappleId = d[21]; p.grappleLen = d[22]; p.heldId = d[23];
  p.revive = !!d[24]; p.reviveX = d[25]; p.reviveY = d[26]; p.face = d[27]; p.stretch = d[28];
  p.beamLen = d[29]; p.eaten = d[32];
  p.rotates = p.form === 'platform';
  setMass(p, p.form === 'platform' ? 2.4 : TUNE.boplDensity);
  if (!isLocal) {
    p.input.ax = d[13]; p.input.ay = d[14];
    p.input.mx = d[30];
    const bits = d[31];
    for (let i = 0; i < p.input.ab.length; i++) p.input.ab[i] = !!(bits & (1 << i));
  }
}

function bodyDynamic(b) {
  const base = [b.id, r2(b.x), r2(b.y), r2(b.vx), r2(b.vy), r3(b.ang), r2(b.av), r3(b.r), r3(b.hx), r2(b.hidden), r2(b.size)];
  switch (b.kind) {
    case 'plat': return base.concat([r2(b.anchorOff), r2(b.revert)]);
    case 'grenade': return base.concat([r2(b.fuse), b.held ? 1 : 0]);
    case 'missile': return base.concat([r2(b.speed), b.guided ? 1 : 0]);
    case 'mine': return base.concat([b.state, r2(b.prime), r2(b.hunt)]);
    case 'smoke': return base.concat([r2(b.ttl), b.lit ? 1 : 0, r2(b.fuse)]);
    case 'hole': return base.concat([r3(b.core), b.white ? 1 : 0, r2(b.ttl)]);
    case 'boulder': return base.concat([r2(b.ttl), b.lethal ? 1 : 0]);
    case 'orb': return base.concat([r2(b.arm || 0)]);
    default: return base.concat([r2(b.ttl)]);
  }
}

function applyBodyDynamic(b, d) {
  b.x = d[1]; b.y = d[2]; b.vx = d[3]; b.vy = d[4]; b.ang = d[5]; b.av = d[6];
  b.r = d[7]; b.hx = d[8]; b.hidden = d[9]; b.size = d[10];
  switch (b.kind) {
    case 'plat': b.anchorOff = d[11]; b.revert = d[12]; break;
    case 'grenade': b.fuse = d[11]; b.held = !!d[12]; break;
    case 'missile': b.speed = d[11]; b.guided = !!d[12]; break;
    case 'mine': b.state = d[11]; b.prime = d[12]; b.hunt = d[13]; break;
    case 'smoke': b.ttl = d[11]; b.lit = !!d[12]; b.fuse = d[13]; break;
    case 'hole': b.core = d[11]; b.white = !!d[12]; b.ttl = d[13]; break;
    case 'boulder': b.ttl = d[11]; b.lethal = !!d[12]; break;
    case 'orb': b.arm = d[11]; break;
    default: b.ttl = d[11]; break;
  }
  setMass(b, b.density);
}

export function snapshot(w, sent) {
  const spawns = [];
  const players = [];
  const bodies = [];
  for (const b of w.bodies) {
    if (b.kind === 'bopl') { players.push(boplDynamic(b)); continue; }
    if (sent && !sent.has(b.id)) { sent.add(b.id); spawns.push({ ...b }); }
    bodies.push(bodyDynamic(b));
  }
  return {
    k: w.tick, t: r2(w.t), ph: w.phase, pt: r2(w.phaseT), sd: r2(w.sudden),
    bx: r2(w.bounds.x), by: r2(w.bounds.y), wt: w.water == null ? null : r2(w.water),
    wr: w.winner, fz: w.freeze ? w.freeze.owner : -1, fzt: w.freeze ? r2(w.freeze.t) : 0,
    n: w.nextId, s: spawns, p: players, b: bodies,
  };
}

export function applySnapshot(w, snap, localPid, blend) {
  w.tick = snap.k; w.t = snap.t; w.phase = snap.ph; w.phaseT = snap.pt; w.sudden = snap.sd;
  w.bounds.x = snap.bx; w.bounds.y = snap.by; w.water = snap.wt;
  w.winner = snap.wr;
  w.freeze = snap.fz >= 0 ? { owner: snap.fz, t: snap.fzt } : null;

  const known = new Set();
  for (const spec of snap.s || []) {
    known.add(spec.id);
    if (!bodyById(w, spec.id)) w.bodies.push({ ...spec, dead: false });
  }
  for (const d of snap.b || []) {
    known.add(d[0]);
    const b = bodyById(w, d[0]);
    if (b) applyBodyDynamic(b, d);
  }
  // Anything the client speculated locally is dropped: the relay is the truth.
  let write = 0;
  for (const b of w.bodies) {
    if (b.kind === 'bopl') { w.bodies[write++] = b; continue; }
    if (b.id >= LOCAL_ID_BASE || !known.has(b.id)) continue;
    w.bodies[write++] = b;
  }
  w.bodies.length = write;

  for (const d of snap.p || []) {
    const p = w.bodies.find(b => b.kind === 'bopl' && b.id === d[0]);
    if (!p) continue;
    const isLocal = p.pid === localPid;
    if (blend && isLocal && p.alive && d[8]) {
      const ex = d[1] - p.x, ey = d[2] - p.y;
      const err = len(ex, ey);
      const k = err > 1.5 ? 1 : 0.22;
      const keepX = p.x + ex * k, keepY = p.y + ey * k;
      applyBoplDynamic(p, d, true);
      p.x = keepX; p.y = keepY;
    } else applyBoplDynamic(p, d, isLocal);
  }
  w.nextId = Math.max(w.nextId, LOCAL_ID_BASE);
}
