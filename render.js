// Canvas renderer.
//
// Every pixel here is drawn from code: no image files, no sprite sheets, no
// fonts beyond the system stack. Terrain is a capsule outline, a bopl is a
// squashed circle with two eyes that track whatever it is about to do, and the
// particles are all short-lived circles. That keeps the whole game a few text
// files and makes it look the same on every device.

import { THEMES, COLORS, ABILITY_BY_ID, clamp } from './data.js?v=20260821-3';

const TAU = Math.PI * 2;
const pickupIcons = new Map();

function pickupIcon(id) {
  let canvas = pickupIcons.get(id);
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = 72;
  paintAbilityIcon(canvas, id, '#fff4bd');
  pickupIcons.set(id, canvas);
  return canvas;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const particles = [];
  const stars = [];
  let shake = 0;
  let flash = 0;
  let flashColor = '#fff';
  const api = { lastScale: 1 };

  for (let i = 0; i < 90; i++) {
    stars.push({ x: (i * 97 % 1000) / 1000, y: (i * 61 % 1000) / 1000, r: 0.4 + (i % 3) * 0.35, tw: (i % 7) / 7 });
  }

  function spawn(x, y, count, spec) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = spec.speed * (0.35 + Math.random() * 0.9);
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: spec.life * (0.6 + Math.random() * 0.7), max: spec.life,
        r: spec.r * (0.5 + Math.random()), color: spec.color, grav: spec.grav ?? 6,
        kind: spec.kind || 'dot',
      });
    }
  }

  // Sim events drive every bit of feedback on screen.
  function feed(events, world) {
    for (const e of events) {
      switch (e.e) {
        case 'blast': spawn(e.x, e.y, 26, { speed: 9, life: 0.5, r: 0.17, color: '#ffd267', grav: 2 });
          spawn(e.x, e.y, 14, { speed: 5, life: 0.7, r: 0.26, color: '#ff7a3d', grav: -1 });
          shake = Math.max(shake, 0.5); flash = 0.22; flashColor = '#ffcf7a'; break;
        case 'flame': spawn(e.x, e.y, 22, { speed: 8, life: 0.45, r: 0.2, color: '#ff9a3c', grav: -3 });
          shake = Math.max(shake, 0.35); break;
        case 'slam': spawn(e.x, e.y, 22, { speed: 8, life: 0.4, r: 0.16, color: '#cfd8ff', grav: 3 });
          shake = Math.max(shake, 0.55); break;
        case 'pop': {
          const color = COLORS[e.c % COLORS.length];
          spawn(e.x, e.y, 30, { speed: 8, life: 0.75, r: 0.2, color: color.body, grav: 7 });
          spawn(e.x, e.y, 10, { speed: 4, life: 0.5, r: 0.3, color: color.dark, grav: 5 });
          shake = Math.max(shake, 0.4); flash = 0.16; flashColor = color.body; break;
        }
        case 'gust': spawn(e.x, e.y, 20, { speed: 7, life: 0.3, r: 0.14, color: '#ffffff', grav: 0 }); break;
        case 'jump': spawn(e.x, e.y + 0.3, 4, { speed: 2, life: 0.2, r: 0.09, color: '#ffffff', grav: 4 }); break;
        case 'dash': spawn(e.x, e.y, 10, { speed: 5, life: 0.25, r: 0.12, color: '#bfe9ff', grav: 0 }); break;
        case 'eat': spawn(e.x, e.y, 16, { speed: 5, life: 0.5, r: 0.16, color: '#ffe37a', grav: 3 }); break;
        case 'revive': spawn(e.x, e.y, 18, { speed: 4, life: 0.6, r: 0.15, color: '#8bffc0', grav: -2 }); break;
        case 'feed': spawn(e.x, e.y, 6, { speed: 3, life: 0.3, r: 0.1, color: '#c69cff', grav: 0 }); break;
        case 'freeze': flash = 0.3; flashColor = '#9fd8ff'; break;
        case 'hole': shake = Math.max(shake, 0.3); break;
        case 'smoke': spawn(e.x, e.y, 12, { speed: 3, life: 0.9, r: 0.3, color: '#b9b9c8', grav: -1 }); break;
        case 'resize': spawn(e.x, e.y, 8, { speed: 3, life: 0.3, r: 0.12, color: e.d > 0 ? '#9dff9d' : '#ff9dd6', grav: 0 }); break;
        case 'round': flash = 0.25; flashColor = '#ffffff'; break;
        case 'dust': spawn(e.x, e.y, 2, { speed: 1.2, life: 0.5, r: 0.07, color: 'rgba(255,255,255,0.75)', grav: -0.6 }); break;
      }
    }
    if (world && world.freeze) flash = Math.max(flash, 0.05);
  }

  function stepParticles(dt) {
    shake = Math.max(0, shake - dt * 2.2);
    flash = Math.max(0, flash - dt * 2.6);
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.vy += p.grav * dt;
      p.vx *= 1 - 1.4 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  function capsulePath(ctx, x, y, hx, r, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    const x0 = x - c * hx, y0 = y - s * hx;
    const x1 = x + c * hx, y1 = y + s * hx;
    const nx = -s * r, ny = c * r;
    // Both caps sweep anticlockwise so they bulge away from the segment. Sweeping
    // the other way turns the capsule into an hourglass.
    const a1 = Math.atan2(ny, nx);
    ctx.beginPath();
    ctx.moveTo(x0 + nx, y0 + ny);
    ctx.lineTo(x1 + nx, y1 + ny);
    ctx.arc(x1, y1, r, a1, a1 + Math.PI, true);
    ctx.lineTo(x0 - nx, y0 - ny);
    ctx.arc(x0, y0, r, a1 + Math.PI, a1, true);
    ctx.closePath();
  }

  // A bopl: squashed ball, dark rim, two eyes aimed at the action. Exposed so
  // the menus can draw the same creature in a preview.
  function drawBopl(ctx, opts) {
    const { x, y, r, color, stretch = 0, vx = 0, vy = 0, aimx = 1, aimy = 0, alpha = 1, blink = 0, dead = false } = opts;
    const speed = Math.hypot(vx, vy);
    const dir = speed > 0.4 ? Math.atan2(vy, vx) : 0;
    const squash = clamp(stretch, 0, 1);
    const stretchAmt = clamp(speed / 40, 0, 0.19);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(dir);
    ctx.scale(1 + stretchAmt - squash * 0.55, 1 - stretchAmt + squash * 0.55);
    ctx.rotate(-dir);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fillStyle = color.body;
    ctx.fill();
    ctx.lineWidth = r * 0.2;
    ctx.strokeStyle = color.dark;
    ctx.stroke();
    // Highlight
    ctx.beginPath();
    ctx.arc(-r * 0.3, -r * 0.35, r * 0.3, 0, TAU);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();
    ctx.restore();

    if (dead) return;
    // Eyes sit on the aim side and the pupils lead the aim a little further.
    ctx.save();
    ctx.globalAlpha = alpha;
    const ex = aimx * r * 0.3, ey = aimy * r * 0.3;
    const perp = [-aimy, aimx];
    const eyeR = r * 0.32;
    const open = blink > 0.92 ? 0.18 : 1;
    for (const side of [-1, 1]) {
      const cx = x + ex + perp[0] * r * 0.38 * side;
      const cy = y + ey + perp[1] * r * 0.38 * side;
      ctx.beginPath();
      ctx.ellipse(cx, cy, eyeR, eyeR * open, 0, 0, TAU);
      ctx.fillStyle = '#fff';
      ctx.fill();
      if (open > 0.5) {
        ctx.beginPath();
        ctx.arc(cx + aimx * eyeR * 0.4, cy + aimy * eyeR * 0.4, eyeR * 0.48, 0, TAU);
        ctx.fillStyle = '#1b1725';
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // Terrain: body fill, then a cap band along the top edge, then the outline.
  // The band is made by filling the capsule with the cap colour and stamping the
  // body colour over a copy shifted downward, all inside a clip.
  function drawTerrain(ctx, b, theme, t, world) {
    const ice = b.ptype === 'ice';
    const capThickness = Math.min(theme.capThickness, b.r * 0.85);
    ctx.save();
    capsulePath(ctx, b.x, b.y, b.hx, b.r, b.ang);
    ctx.clip();
    capsulePath(ctx, b.x, b.y, b.hx, b.r, b.ang);
    ctx.fillStyle = ice ? '#eaf6ff' : theme.cap;
    ctx.fill();
    ctx.save();
    ctx.translate(0, capThickness);
    capsulePath(ctx, b.x, b.y, b.hx, b.r, b.ang);
    ctx.fillStyle = ice ? '#a9cbe6' : theme.land;
    ctx.fill();
    ctx.restore();

    // Texture inside the body.
    if (world.theme === 'space') {
      for (let i = 0; i < 4; i++) {
        const seed = (b.id * 37 + i * 61) % 100 / 100;
        const cx = b.x + (seed - 0.5) * (b.hx * 1.6 + b.r);
        const cy = b.y + ((seed * 7 % 1) - 0.35) * b.r * 1.1;
        ctx.beginPath();
        ctx.arc(cx, cy, b.r * (0.12 + seed * 0.16), 0, TAU);
        ctx.fillStyle = theme.capDeep;
        ctx.fill();
      }
    } else if (ice) {
      ctx.strokeStyle = 'rgba(255,255,255,0.65)';
      ctx.lineWidth = 0.05;
      for (let i = -4; i <= 4; i++) {
        ctx.beginPath();
        ctx.moveTo(b.x + i * 0.55 - 0.3, b.y - b.r);
        ctx.lineTo(b.x + i * 0.55 + 0.35, b.y + b.r);
        ctx.stroke();
      }
    } else if (world.theme === 'grass') {
      // A few tufts hanging off the grass line, and some grit in the soil.
      ctx.fillStyle = theme.capDeep;
      for (let i = 0; i < 7; i++) {
        const seed = (b.id * 53 + i * 29) % 100 / 100;
        const cx = b.x + (seed - 0.5) * (b.hx * 1.9 + b.r * 1.2);
        ctx.beginPath();
        ctx.arc(cx, b.y - b.r + capThickness * (0.85 + seed * 0.5), 0.07 + seed * 0.05, 0, TAU);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (let i = 0; i < 5; i++) {
        const seed = (b.id * 91 + i * 47) % 100 / 100;
        ctx.beginPath();
        ctx.arc(b.x + (seed - 0.5) * (b.hx * 1.7 + b.r), b.y + seed * b.r * 0.7, 0.06 + seed * 0.05, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    capsulePath(ctx, b.x, b.y, b.hx, b.r, b.ang);
    ctx.lineWidth = Math.max(0.05, b.r * 0.14);
    ctx.strokeStyle = theme.edge;
    ctx.stroke();

    if (b.ptype === 'moving') {
      // Glowing studs are the tell that a platform travels.
      const pulse = 0.55 + 0.45 * Math.sin(t * 4);
      const c = Math.cos(b.ang), sn = Math.sin(b.ang);
      for (const side of [-0.55, 0.55]) {
        ctx.beginPath();
        ctx.arc(b.x + c * b.hx * side, b.y + sn * b.hx * side + b.r * 0.3, b.r * 0.19, 0, TAU);
        ctx.fillStyle = `rgba(255,214,92,${pulse})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255,180,40,${pulse})`;
        ctx.lineWidth = 0.04;
        ctx.stroke();
      }
    }
    if (b.ptype === 'free') {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([0.14, 0.14]);
      ctx.lineWidth = 0.04;
      capsulePath(ctx, b.x, b.y, b.hx + 0.1, b.r + 0.1, b.ang);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawBackground(ctx, world, view, w, h) {
    const theme = THEMES[world.theme];
    const grad = ctx.createLinearGradient(0, -world.baseBounds.y - 2, 0, world.baseBounds.y + 2);
    grad.addColorStop(0, theme.sky);
    grad.addColorStop(1, theme.deep);
    ctx.fillStyle = grad;
    ctx.fillRect(-60, -40, 120, 80);

    if (world.theme === 'space') {
      for (const s of stars) {
        const x = -world.baseBounds.x + s.x * world.baseBounds.x * 2;
        const y = -world.baseBounds.y + s.y * world.baseBounds.y * 2;
        ctx.globalAlpha = 0.35 + 0.5 * Math.abs(Math.sin(view.time * 0.8 + s.tw * 9));
        ctx.beginPath();
        ctx.arc(x, y, s.r * 0.06, 0, TAU);
        ctx.fillStyle = '#fff';
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    } else if (world.theme === 'grass') {
      ctx.globalAlpha = 0.24;
      ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 5; i++) {
        const cx = -9 + ((i * 5.4 + view.time * 0.22) % 24);
        const cy = -world.baseBounds.y + 1.1 + (i % 3) * 1.15;
        for (const o of [[0, 0, 1.1], [1.0, 0.2, 0.8], [-1.0, 0.25, 0.7]]) {
          ctx.beginPath();
          ctx.arc(cx + o[0], cy + o[1], o[2], 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = '#cfe6ff';
      for (let i = 0; i < 4; i++) {
        const cx = -10 + i * 6.6;
        const base = world.baseBounds.y;
        ctx.beginPath();
        ctx.moveTo(cx - 2.4, base);
        ctx.lineTo(cx, base - 3.2 - (i % 2) * 1.1);
        ctx.lineTo(cx + 2.4, base);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  function drawWater(ctx, world, view) {
    if (world.water == null) return;
    const y = world.water;
    ctx.save();
    const theme = THEMES[world.theme];
    const grad = ctx.createLinearGradient(0, y, 0, y + 4);
    grad.addColorStop(0, theme.waterFill);
    grad.addColorStop(1, theme.waterDeep);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(-40, y);
    for (let x = -40; x <= 40; x += 0.5) {
      ctx.lineTo(x, y + Math.sin(x * 1.1 + view.time * 2.2) * 0.09 + Math.sin(x * 0.4 - view.time * 1.3) * 0.06);
    }
    ctx.lineTo(40, 40);
    ctx.lineTo(-40, 40);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 0.06;
    ctx.beginPath();
    for (let x = -40; x <= 40; x += 0.5) {
      const wy = y + Math.sin(x * 1.1 + view.time * 2.2) * 0.09 + Math.sin(x * 0.4 - view.time * 1.3) * 0.06;
      if (x === -40) ctx.moveTo(x, wy); else ctx.lineTo(x, wy);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawObject(ctx, b, world, view) {
    const t = view.time;
    switch (b.kind) {
      case 'grenade': {
        const danger = clamp(1 - b.fuse / 1.8, 0, 1);
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = `rgb(${60 + danger * 190},${58 - danger * 20},${64 - danger * 30})`;
        ctx.fill();
        ctx.strokeStyle = '#201c28'; ctx.lineWidth = b.r * 0.24; ctx.stroke();
        if (Math.sin(t * (8 + danger * 40)) > 0) {
          ctx.beginPath();
          ctx.arc(b.x, b.y - b.r * 0.9, b.r * 0.3, 0, TAU);
          ctx.fillStyle = '#ffe066'; ctx.fill();
        }
        break;
      }
      case 'ability': {
        const pulse = 1 + Math.sin(t * 5 + b.id) * 0.06;
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.scale(pulse, pulse);
        ctx.beginPath();
        ctx.arc(0, 0, b.r * 1.18, 0, TAU);
        ctx.fillStyle = 'rgba(35,30,49,0.9)';
        ctx.fill();
        ctx.strokeStyle = '#fff4bd';
        ctx.lineWidth = 0.06;
        ctx.stroke();
        ctx.drawImage(pickupIcon(b.abilityId), -b.r * 0.78, -b.r * 0.78, b.r * 1.56, b.r * 1.56);
        ctx.restore();
        break;
      }
      case 'missile': {
        capsulePath(ctx, b.x, b.y, b.hx, b.r, b.ang);
        ctx.fillStyle = '#e8e8f2'; ctx.fill();
        ctx.strokeStyle = '#c2434b'; ctx.lineWidth = b.r * 0.3; ctx.stroke();
        const c = Math.cos(b.ang), s = Math.sin(b.ang);
        ctx.beginPath();
        ctx.arc(b.x - c * (b.hx + b.r * 0.6), b.y - s * (b.hx + b.r * 0.6), b.r * (0.6 + 0.3 * Math.random()), 0, TAU);
        ctx.fillStyle = 'rgba(255,160,60,0.85)'; ctx.fill();
        break;
      }
      case 'arrow': {
        capsulePath(ctx, b.x, b.y, b.hx, b.r, b.ang);
        ctx.fillStyle = '#f4e6c8'; ctx.fill();
        ctx.strokeStyle = '#6b4a2a'; ctx.lineWidth = b.r * 0.5; ctx.stroke();
        break;
      }
      case 'ray': {
        const glow = { grow: '#7dff9b', shrink: '#ff8fd6', blink: '#9fd8ff', dup: '#ffd86b' }[b.mode] || '#fff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = glow; ctx.fill();
        ctx.globalAlpha = 0.35;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 2.1, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case 'hook': {
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = '#cfd4e0'; ctx.fill();
        ctx.strokeStyle = '#4a4a58'; ctx.lineWidth = 0.05; ctx.stroke();
        break;
      }
      case 'boulder': {
        ctx.save();
        ctx.translate(b.x, b.y); ctx.rotate(b.ang);
        ctx.beginPath();
        for (let i = 0; i < 7; i++) {
          const a = TAU * i / 7;
          const rr = b.r * (0.86 + ((i * 37) % 5) / 22);
          if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fillStyle = '#6d6478'; ctx.fill();
        ctx.strokeStyle = '#403a4c'; ctx.lineWidth = b.r * 0.16; ctx.stroke();
        ctx.restore();
        break;
      }
      case 'mine': {
        const armed = b.state > 0;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = armed ? '#3b2b38' : '#4a4a52'; ctx.fill();
        ctx.strokeStyle = armed ? '#ff5a5a' : '#7a7a86'; ctx.lineWidth = b.r * 0.28; ctx.stroke();
        for (let i = 0; i < 6; i++) {
          const a = TAU * i / 6 + b.ang;
          ctx.beginPath();
          ctx.moveTo(b.x + Math.cos(a) * b.r, b.y + Math.sin(a) * b.r);
          ctx.lineTo(b.x + Math.cos(a) * b.r * 1.45, b.y + Math.sin(a) * b.r * 1.45);
          ctx.strokeStyle = armed ? '#ff5a5a' : '#7a7a86';
          ctx.lineWidth = b.r * 0.2;
          ctx.stroke();
        }
        if (armed && Math.sin(t * 14) > 0) {
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.35, 0, TAU);
          ctx.fillStyle = '#ff2e2e'; ctx.fill();
        }
        break;
      }
      case 'spike': {
        const c = Math.cos(b.ang), s = Math.sin(b.ang);
        ctx.beginPath();
        ctx.moveTo(b.x + c * b.hx, b.y + s * b.hx);
        ctx.lineTo(b.x - c * b.hx - s * b.r, b.y - s * b.hx + c * b.r);
        ctx.lineTo(b.x - c * b.hx + s * b.r, b.y - s * b.hx - c * b.r);
        ctx.closePath();
        ctx.fillStyle = '#d8d2e4'; ctx.fill();
        ctx.strokeStyle = '#8a819c'; ctx.lineWidth = 0.06; ctx.stroke();
        break;
      }
      case 'coil': {
        capsulePath(ctx, b.x, b.y, b.hx, b.r * 0.5, b.ang);
        ctx.fillStyle = '#4b4757'; ctx.fill();
        ctx.beginPath();
        ctx.arc(b.x - Math.cos(b.ang) * b.hx, b.y - Math.sin(b.ang) * b.hx, b.r * 0.8, 0, TAU);
        ctx.fillStyle = '#9fe8ff'; ctx.fill();
        ctx.strokeStyle = '#2f6f8a'; ctx.lineWidth = 0.05; ctx.stroke();
        break;
      }
      case 'engine': {
        ctx.save();
        ctx.translate(b.x, b.y);
        ctx.beginPath(); ctx.arc(0, 0, b.r, 0, TAU);
        ctx.fillStyle = '#5a5464'; ctx.fill();
        ctx.strokeStyle = '#312c3a'; ctx.lineWidth = b.r * 0.3; ctx.stroke();
        const f = b.r * (1.2 + Math.random() * 0.9);
        ctx.beginPath(); ctx.arc(0, 0, f, 0, TAU);
        ctx.fillStyle = 'rgba(255,150,50,0.55)'; ctx.fill();
        ctx.restore();
        break;
      }
      case 'smoke': {
        const a = b.lit ? 0.9 : 0.62;
        ctx.globalAlpha = a * clamp(b.ttl / 2, 0.2, 1);
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = b.lit ? '#ff9440' : '#b6b4c4'; ctx.fill();
        ctx.globalAlpha = 1;
        break;
      }
      case 'canister': {
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = '#7f8a76'; ctx.fill();
        ctx.strokeStyle = '#37402f'; ctx.lineWidth = b.r * 0.3; ctx.stroke();
        break;
      }
      case 'hole': {
        const g = ctx.createRadialGradient(b.x, b.y, b.core * 0.2, b.x, b.y, b.core * 4.2);
        if (b.white) { g.addColorStop(0, '#ffffff'); g.addColorStop(0.4, 'rgba(190,225,255,0.55)'); g.addColorStop(1, 'rgba(190,225,255,0)'); }
        else { g.addColorStop(0, '#000000'); g.addColorStop(0.35, 'rgba(80,30,120,0.75)'); g.addColorStop(1, 'rgba(80,30,120,0)'); }
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.core * 4.2, 0, TAU); ctx.fill();
        ctx.beginPath(); ctx.arc(b.x, b.y, b.core, 0, TAU);
        ctx.fillStyle = b.white ? '#ffffff' : '#0a0510'; ctx.fill();
        ctx.strokeStyle = b.white ? '#8fd4ff' : '#b476ff';
        ctx.lineWidth = b.core * 0.16; ctx.stroke();
        break;
      }
      case 'bubble': {
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU);
        ctx.fillStyle = 'rgba(150,220,255,0.18)'; ctx.fill();
        ctx.strokeStyle = 'rgba(190,240,255,0.85)'; ctx.lineWidth = 0.06; ctx.stroke();
        break;
      }
      case 'orb': {
        const armed = (b.arm || 0) <= 0;
        const pulse = armed ? 0.7 + 0.3 * Math.sin(t * 3.4) : 0.3 + 0.2 * Math.sin(t * 9);
        const color = COLORS[(view.colorOf?.(b.owner) ?? 0) % COLORS.length];
        ctx.globalAlpha = pulse;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 1.5, 0, TAU);
        ctx.fillStyle = 'rgba(140,255,190,0.22)'; ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r * 0.7, 0, TAU);
        ctx.fillStyle = armed ? '#8bffc0' : '#5f7f6c'; ctx.fill();
        ctx.strokeStyle = color.dark; ctx.lineWidth = 0.05; ctx.stroke();
        break;
      }
    }
  }

  function drawPlayer(ctx, p, world, view) {
    const color = COLORS[p.color % COLORS.length];
    if (!p.alive) return;
    if (p.hidden > 0) {
      ctx.globalAlpha = 0.25;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.strokeStyle = color.body; ctx.setLineDash([0.1, 0.1]); ctx.lineWidth = 0.05; ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      return;
    }
    const mine = p.pid === view.localPid;
    let alpha = 1;
    if (p.invis > 0) alpha = mine ? 0.34 : 0.06;
    if (p.iframes > 0) alpha *= 0.6 + 0.4 * Math.abs(Math.sin(view.time * 22));

    if (p.form === 'platform') {
      ctx.globalAlpha = alpha;
      capsulePath(ctx, p.x, p.y, p.hx, p.r, p.ang);
      ctx.fillStyle = THEMES[world.theme].land; ctx.fill();
      ctx.strokeStyle = color.body; ctx.lineWidth = p.r * 0.22; ctx.stroke();
      const c = Math.cos(p.ang), s = Math.sin(p.ang);
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(p.x + (-s * p.r * 0.4) + c * p.hx * 0.3 * side, p.y + (c * p.r * 0.4) + s * p.hx * 0.3 * side, p.r * 0.2, 0, TAU);
        ctx.fillStyle = '#fff'; ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }

    if (p.form === 'rock') {
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = TAU * i / 8;
        const rr = p.r * (0.9 + ((i * 53) % 6) / 30);
        if (i === 0) ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath();
      ctx.fillStyle = '#7a7086'; ctx.fill();
      ctx.strokeStyle = color.dark; ctx.lineWidth = p.r * 0.2; ctx.stroke();
      ctx.restore();
      ctx.globalAlpha = 1;
      return;
    }

    if (p.form === 'drill') {
      const ang = Math.atan2(p.input.ay, p.input.ax);
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.translate(p.x, p.y); ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(p.r * 1.9, 0);
      ctx.lineTo(-p.r * 0.2, -p.r * 0.85);
      ctx.lineTo(-p.r * 0.2, p.r * 0.85);
      ctx.closePath();
      ctx.fillStyle = '#d5d0de'; ctx.fill();
      ctx.strokeStyle = '#6b6478'; ctx.lineWidth = p.r * 0.16; ctx.stroke();
      ctx.restore();
      drawBopl(ctx, { x: p.x - Math.cos(ang) * p.r * 0.4, y: p.y - Math.sin(ang) * p.r * 0.4, r: p.r * 0.85, color, alpha, aimx: -Math.cos(ang), aimy: -Math.sin(ang) });
      ctx.globalAlpha = 1;
      return;
    }

    drawBopl(ctx, {
      x: p.x, y: p.y, r: p.r, color, stretch: p.stretch, vx: p.vx, vy: p.vy,
      aimx: p.input.ax, aimy: p.input.ay, alpha,
      blink: Math.sin(view.time * 1.3 + p.idx * 2.1) > 0.985 ? 1 : 0,
    });

    // Form-specific attachments.
    const c = p.input.ax, s = p.input.ay;
    if (p.form === 'bow') {
      const pull = 0.3 + p.charge * 0.5;
      ctx.save(); ctx.translate(p.x + c * p.r, p.y + s * p.r); ctx.rotate(Math.atan2(s, c));
      ctx.beginPath(); ctx.arc(0, 0, p.r * 1.15, -1.1, 1.1);
      ctx.strokeStyle = '#a9743f'; ctx.lineWidth = p.r * 0.16; ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(Math.cos(-1.1) * p.r * 1.15, Math.sin(-1.1) * p.r * 1.15);
      ctx.lineTo(-pull * p.r, 0);
      ctx.lineTo(Math.cos(1.1) * p.r * 1.15, Math.sin(1.1) * p.r * 1.15);
      ctx.strokeStyle = '#e8e2d2'; ctx.lineWidth = p.r * 0.07; ctx.stroke();
      ctx.restore();
    }
    if (p.form === 'gun') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(s, c));
      ctx.fillStyle = '#3d3947';
      ctx.fillRect(p.r * 0.5, -p.r * 0.28, p.r * 1.25, p.r * 0.56);
      ctx.fillStyle = '#9fd8ff';
      ctx.fillRect(p.r * 1.5, -p.r * 0.18, p.r * 0.3, p.r * 0.36);
      ctx.restore();
    }
    if (p.form === 'beam') {
      const reach = p.beamLen || 8;
      const grd = ctx.createLinearGradient(p.x, p.y, p.x + c * reach, p.y + s * reach);
      grd.addColorStop(0, 'rgba(255,255,255,0.95)');
      grd.addColorStop(0.5, `${color.body}cc`);
      grd.addColorStop(1, 'rgba(255,255,255,0.1)');
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = grd;
      ctx.lineWidth = 0.34 + Math.random() * 0.08;
      ctx.beginPath();
      ctx.moveTo(p.x + c * p.r, p.y + s * p.r);
      ctx.lineTo(p.x + c * reach, p.y + s * reach);
      ctx.stroke();
      ctx.restore();
    }
    if (p.form === 'roll') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * 1.3, view.time * 18, view.time * 18 + 4.4);
      ctx.strokeStyle = `${color.body}aa`; ctx.lineWidth = p.r * 0.3; ctx.stroke();
    }
    if (p.form === 'meteor') {
      ctx.beginPath();
      ctx.moveTo(p.x - p.r, p.y - p.r * 2.4);
      ctx.lineTo(p.x + p.r, p.y - p.r * 2.4);
      ctx.lineTo(p.x, p.y - p.r * 0.4);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,180,90,0.6)'; ctx.fill();
    }
    if (p.form === 'timestop') {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (1.6 + p.charge * 1.6), 0, TAU);
      ctx.strokeStyle = `rgba(160,220,255,${0.3 + p.charge * 0.6})`;
      ctx.lineWidth = 0.07; ctx.stroke();
    }
    if (p.charge > 0 && (p.form === 'normal' || p.form === 'throw')) {
      ctx.beginPath();
      ctx.arc(p.x, p.y - p.r - 0.3, 0.16, -Math.PI / 2, -Math.PI / 2 + TAU * p.charge);
      ctx.strokeStyle = '#ffd267'; ctx.lineWidth = 0.09; ctx.stroke();
    }
  }

  function drawFrame(world, view) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!world) return;

    const pad = 0.7;
    const scale = Math.min(w / (world.baseBounds.x * 2 + pad), h / (world.baseBounds.y * 2 + pad));
    const shakeX = shake ? (Math.random() - 0.5) * shake * 0.5 : 0;
    const shakeY = shake ? (Math.random() - 0.5) * shake * 0.5 : 0;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    ctx.translate(shakeX, shakeY);
    view.scale = scale;
    api.lastScale = scale;

    drawBackground(ctx, world, view, w, h);

    // Play area: everything outside is death.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-world.bounds.x, -world.bounds.y, world.bounds.x * 2, world.bounds.y * 2);
    ctx.clip();
    drawWater(ctx, world, view);

    for (const b of world.bodies) {
      if (b.kind !== 'plat' || b.hidden > 0) continue;
      drawTerrain(ctx, b, THEMES[world.theme], view.time, world);
    }
    for (const b of world.bodies) {
      if (b.kind === 'plat' || b.kind === 'bopl' || b.hidden > 0) continue;
      drawObject(ctx, b, world, view);
    }
    // Tesla arcs.
    const coils = world.bodies.filter(b => b.kind === 'coil');
    for (let i = 0; i < coils.length; i++) {
      for (let j = i + 1; j < coils.length; j++) {
        const a = coils[i], b = coils[j];
        if (a.owner !== b.owner || a.slot !== b.slot) continue;
        if ((a.arcOff || 0) > 0 || (b.arcOff || 0) > 0) continue;
        ctx.beginPath();
        const steps = 10;
        for (let k = 0; k <= steps; k++) {
          const f = k / steps;
          const jitter = k === 0 || k === steps ? 0 : (Math.random() - 0.5) * 0.3;
          const x = a.x + (b.x - a.x) * f - (b.y - a.y) * jitter * 0.1;
          const y = a.y + (b.y - a.y) * f + (b.x - a.x) * jitter * 0.1;
          if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#bff0ff';
        ctx.lineWidth = 0.09;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(160,230,255,0.35)';
        ctx.lineWidth = 0.24;
        ctx.stroke();
      }
    }
    // Grapple ropes.
    for (const p of world.players) {
      if (!p.alive || p.grappleId < 0) continue;
      const host = world.bodies.find(b => b.id === p.grappleId);
      if (!host) continue;
      const c = Math.cos(host.ang), s = Math.sin(host.ang);
      const ax = host.x + (p.grappleLx * c - p.grappleLy * s);
      const ay = host.y + (p.grappleLx * s + p.grappleLy * c);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(ax, ay);
      ctx.strokeStyle = '#e6e2d6';
      ctx.lineWidth = 0.06;
      ctx.stroke();
    }
    for (const p of world.players) drawPlayer(ctx, p, world, view);

    // Bopl Battle exposes every loadout above its owner. Besides being useful
    // counterplay, the shared background color makes teams readable at a glance.
    for (const p of world.players) {
      if (!p.alive || !p.slots.length || (p.invis > 0 && p.pid !== view.localPid) || p.hidden > 0) continue;
      const color = COLORS[p.color % COLORS.length];
      const size = 0.38;
      const gap = 0.05;
      const width = p.slots.length * size + (p.slots.length - 1) * gap;
      const y = p.y - p.r - 0.72;
      const busy = p.slots.some(slot => slot.state === 1);
      for (let i = 0; i < p.slots.length; i++) {
        const slot = p.slots[i];
        const x = p.x - width / 2 + i * (size + gap);
        ctx.fillStyle = color.body;
        ctx.strokeStyle = color.dark;
        ctx.lineWidth = 0.045;
        ctx.beginPath();
        ctx.roundRect(x, y, size, size, 0.07);
        ctx.fill();
        ctx.stroke();
        if (slot.id) ctx.drawImage(pickupIcon(slot.id), x + 0.055, y + 0.055, size - 0.11, size - 0.11);
        if (slot.cd > 0 || slot.used || (busy && slot.state !== 1)) {
          const fraction = slot.used ? 1 : clamp(slot.cd / (ABILITY_BY_ID.get(slot.id)?.cd || 1), 0, 1);
          ctx.fillStyle = 'rgba(22,20,30,0.68)';
          ctx.fillRect(x, y + size * (1 - fraction), size, size * fraction);
        }
      }
    }

    // Held object line for the magnet.
    for (const p of world.players) {
      if (!p.alive || p.heldId < 0) continue;
      const held = world.bodies.find(b => b.id === p.heldId);
      if (!held) continue;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(held.x, held.y);
      ctx.strokeStyle = 'rgba(160,220,255,0.6)';
      ctx.lineWidth = 0.08;
      ctx.stroke();
    }

    for (const p of particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fillStyle = p.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Name tags and the local marker.
    ctx.textAlign = 'center';
    ctx.font = `600 ${0.42}px system-ui, sans-serif`;
    for (const p of world.players) {
      if (!p.alive || (p.invis > 0 && p.pid !== view.localPid) || p.hidden > 0) continue;
      const color = COLORS[p.color % COLORS.length];
      const labelY = p.y - p.r - (p.slots.length ? 1.02 : 0.44);
      if (p.pid === view.localPid) {
        ctx.beginPath();
        ctx.moveTo(p.x, labelY + 0.1);
        ctx.lineTo(p.x - 0.17, labelY - 0.2);
        ctx.lineTo(p.x + 0.17, labelY - 0.2);
        ctx.closePath();
        ctx.fillStyle = color.body;
        ctx.fill();
      } else if (view.showNames) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillText(p.name, p.x, labelY + 0.04);
        ctx.fillStyle = color.body;
        ctx.fillText(p.name, p.x, labelY);
      }
    }

    // Death barrier and sudden death.
    ctx.strokeStyle = world.sudden > 0 ? `rgba(255,90,90,${0.5 + 0.4 * Math.sin(view.time * 6)})` : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = world.sudden > 0 ? 0.14 : 0.07;
    ctx.strokeRect(-world.bounds.x, -world.bounds.y, world.bounds.x * 2, world.bounds.y * 2);
    ctx.restore();

    if (flash > 0) {
      ctx.globalAlpha = flash * 0.5;
      ctx.fillStyle = flashColor;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
  }

  function draw(world, view) {
    const adjusted = [];
    if (world) {
      for (const body of world.bodies) {
        const pose = view.poseOf?.(body);
        if (!pose) continue;
        adjusted.push(body, body.x, body.y, body.ang);
        body.x = pose.x;
        body.y = pose.y;
        body.ang = pose.ang;
      }
    }
    try {
      drawFrame(world, view);
    } finally {
      for (let i = 0; i < adjusted.length; i += 4) {
        adjusted[i].x = adjusted[i + 1];
        adjusted[i].y = adjusted[i + 2];
        adjusted[i].ang = adjusted[i + 3];
      }
    }
  }

  return Object.assign(api, { draw, feed, stepParticles, drawBopl, capsulePath, particleCount: () => particles.length });
}

// Standalone preview used by the lobby and the draft cards.
export function paintAbilityIcon(canvas, abilityId, accent = '#ffd267') {
  const ctx = canvas.getContext('2d');
  const size = canvas.width;
  const ability = ABILITY_BY_ID.get(abilityId);
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  const u = size / 100;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = accent;
  ctx.fillStyle = accent;
  ctx.lineWidth = 7 * u;

  const ring = (r, from = 0, to = TAU) => { ctx.beginPath(); ctx.arc(0, 0, r * u, from, to); ctx.stroke(); };
  const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x * u, y * u, r * u, 0, TAU); ctx.fill(); };
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1 * u, y1 * u); ctx.lineTo(x2 * u, y2 * u); ctx.stroke(); };
  const tri = (pts) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] * u, p[1] * u) : ctx.moveTo(p[0] * u, p[1] * u)); ctx.closePath(); ctx.fill(); };

  switch (abilityId) {
    case 'grenade': dot(0, 6, 22); line(0, -16, 0, -26); line(0, -26, 12, -32); break;
    case 'missile': tri([[26, 0], [-10, -16], [-10, 16]]); line(-14, -10, -28, -18); line(-14, 10, -28, 18); break;
    case 'rock': tri([[0, -26], [26, -4], [16, 24], [-16, 24], [-26, -4]]); break;
    case 'bow': ring(26, -1.1, 1.1); line(18, -22, -8, 0); line(18, 22, -8, 0); line(-14, 0, 26, 0); break;
    case 'beam': line(-28, 14, 28, -14); ctx.lineWidth = 14 * u; ctx.globalAlpha = 0.35; line(-28, 14, 28, -14); ctx.globalAlpha = 1; break;
    case 'grapple': line(-22, 22, 8, -8); ring(14, -2.6, 0.6); break;
    case 'dash': tri([[28, 0], [0, -18], [0, 18]]); line(-26, 0, -6, 0); line(-20, -12, -6, -12); line(-20, 12, -6, 12); break;
    case 'drill': tri([[28, 0], [-4, -14], [-4, 14]]); line(-8, -14, -8, 14); line(-18, -10, -18, 10); break;
    case 'blink': dot(-16, 0, 12); ctx.globalAlpha = 0.4; dot(16, 0, 12); ctx.globalAlpha = 1; break;
    case 'duplicator': ring(15); ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(16 * u, 10 * u, 15 * u, 0, TAU); ctx.stroke(); ctx.globalAlpha = 1; break;
    case 'engine': tri([[-10, -18], [-10, 18], [-26, 0]]); dot(10, 0, 14); break;
    case 'growray': line(0, -24, 0, 24); line(-24, 0, 24, 0); ring(28); break;
    case 'shrinkray': line(-20, 0, 20, 0); ring(28); break;
    case 'gust': for (const y of [-14, 0, 14]) line(-26, y, 18, y); tri([[28, 0], [14, -10], [14, 10]]); break;
    case 'invis': ring(22, 0.6, 2.6); dot(-9, -4, 4); dot(9, -4, 4); break;
    case 'magnet': ctx.lineWidth = 12 * u; ring(20, Math.PI, TAU); line(-20, 0, -20, 18); line(20, 0, 20, 18); break;
    case 'meteor': dot(0, 10, 16); line(-14, -14, -24, -26); line(2, -18, 2, -30); line(16, -14, 26, -26); break;
    case 'mine': ring(14); for (let i = 0; i < 8; i++) { const a = TAU * i / 8; line(Math.cos(a) * 16, Math.sin(a) * 16, Math.cos(a) * 27, Math.sin(a) * 27); } break;
    case 'platform': ctx.fillRect(-28 * u, -8 * u, 56 * u, 16 * u); break;
    case 'push': ctx.fillRect(-4 * u, -26 * u, 8 * u, 52 * u); line(-26, 0, -12, 0); tri([[-26, 0], [-14, -10], [-14, 10]]); break;
    case 'revival': line(0, -22, 0, 22); line(-16, -6, 16, -6); break;
    case 'roll': ring(20); line(0, -20, 0, 20); line(-20, 0, 20, 0); break;
    case 'smoke': dot(-12, 6, 13); dot(10, 2, 15); dot(0, -14, 11); break;
    case 'spike': tri([[0, -28], [12, 24], [-12, 24]]); break;
    case 'teleport': ring(24, 0.5, 5.9); tri([[24, -6], [14, 4], [30, 8]]); break;
    case 'tesla': line(-6, -26, 8, -4); line(8, -4, -8, 2); line(-8, 2, 6, 26); break;
    case 'throw': dot(12, -10, 13); ring(24, 1.8, 4.2); break;
    case 'timestop': ring(24); line(0, -14, 0, 0); line(0, 0, 12, 6); break;
    case 'blackhole': ctx.globalAlpha = 0.4; ring(26); ctx.globalAlpha = 1; dot(0, 0, 13); break;
    default: ring(20); break;
  }
  ctx.restore();
  return ability;
}
