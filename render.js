// Canvas renderer, in the house pixel style shared with FART TOGETHER, Scoop
// Trouble and Stinkwater.
//
// The arena is drawn into a small offscreen buffer at a fixed PPU pixels per
// world unit and blown up by a whole number with smoothing off, so every pixel
// on screen is a real art pixel. Terrain and bopls are rasterised by hand, pixel
// by pixel, because canvas paths antialias and half-ink edge pixels are what
// make low-res vector art look smeared. Props are still drawn as paths, then
// snapped to hard alpha and given an ink outline. Text is the only thing drawn
// at screen resolution.
//
// Conventions from the other games: light from the upper left, shadows lean
// cool (#2a2050), lights lean warm (#fff0c0), 3-5 tones per material,
// characters and props outlined in ink #26181e, terrain shaded but not inked.

import { THEMES, COLORS, ABILITY_BY_ID, clamp } from './data.js?v=20261027-2';

const TAU = Math.PI * 2;
export const PPU = 24;
export const INK = '#26181e';
const COOL = '#2a2050';
const WARM = '#fff0c0';
const FONT = '"Pixelify Sans", "Silkscreen", ui-monospace, monospace';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

const rgbCache = new Map();
function rgb(hex) {
  let v = rgbCache.get(hex);
  if (!v) {
    let s = hex.replace('#', '');
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    const n = parseInt(s, 16);
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, v);
  }
  return v;
}
function hexOf(r, g, b) {
  const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
const mixCache = new Map();
export function mix(a, b, t) {
  const key = a + b + t;
  let v = mixCache.get(key);
  if (!v) {
    const A = rgb(a), B = rgb(b);
    v = hexOf(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
    mixCache.set(key, v);
  }
  return v;
}
export const shade = (c, t) => mix(c, COOL, t);
export const lite = (c, t) => mix(c, WARM, t);

// Little-endian RGBA packed for a Uint32Array view over ImageData.
const packCache = new Map();
function pack(hex) {
  let v = packCache.get(hex);
  if (v === undefined) {
    const [r, g, b] = rgb(hex);
    v = ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
    packCache.set(hex, v);
  }
  return v;
}
const INK32 = pack(INK);

// Five-tone ramp, dark to light, around a mid colour.
function ramp5(mid) {
  return [shade(mid, 0.55), shade(mid, 0.28), mid, lite(mid, 0.3), lite(mid, 0.62)];
}
const boplRamps = new Map();
function boplRamp(color) {
  let r = boplRamps.get(color.body);
  if (!r) {
    r = {
      tones: [shade(color.body, 0.42), shade(color.body, 0.2), color.body, lite(color.body, 0.32)].map(pack),
      spec: pack(lite(color.body, 0.75)),
    };
    boplRamps.set(color.body, r);
  }
  return r;
}

// Integer hash and value noise for texture that sticks to a platform.
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// ---------------------------------------------------------------------------
// Theme art. Pigments are lifted from the sibling games so they sit together:
// grass from Stinkwater's fen and shore, ice from Scoop Trouble's Vanilla
// Valley, space from its Crystal Caverns.
// ---------------------------------------------------------------------------

const ART = {
  grass: {
    sky: ['#74b8e0', '#88c6e6', '#9ed2ec', '#b6e0f2'],
    far: ['#9cc6b0', '#86b694'],
    cloud: ['#fbf3e4', '#dde9ee'],
    water: ['#1a5e8c', '#2a8ab8', '#3a9ac8', '#5ab0d8', '#bfe6f4'],
    cap: ['#3e5a24', '#5a7a32', '#6a8a3a', '#7a9a44', '#9ab456'],
    body: ['#3a2214', '#4a2e1a', '#6a4428', '#8a5a30', '#a0683a'],
    fleck: ['#6a6a6a', '#8a8a86', '#a4a49e'],
    capPx: 6, tufts: true, roots: true,
  },
  ice: {
    sky: ['#8cb6d2', '#9fc4dc', '#b4d2e4', '#c8e0ee'],
    far: ['#b8cede', '#a4bed2'],
    cloud: ['#f4f8fc', '#d6e4ee'],
    water: ['#1a3458', '#24466e', '#335e88', '#4f7ea6', '#d4ecf8'],
    cap: ['#9aaec6', '#c8d8e8', '#dce6f0', '#eef4f8', '#ffffff'],
    body: ['#34405e', '#4a5a7a', '#5e7090', '#7a8eac', '#a4b6cc'],
    fleck: ['#3e4c6a', '#8ea2bc', '#c4d4e4'],
    capPx: 6, icicles: true,
  },
  space: {
    sky: ['#14142c', '#1a1a38', '#211f44', '#2a2752'],
    far: ['#3a3466', '#4a4280'],
    cloud: ['#3a3468', '#2e2a58'],
    water: null,
    cap: ['#4a475e', '#6e6a88', '#8a87a4', '#a8a5c2', '#cac6e2'],
    body: ['#1e1d34', '#2e2c48', '#423f5e', '#57546f', '#6e6a88'],
    fleck: ['#1e1d34', '#2a2844', '#7a7793'],
    capPx: 3, craters: true,
  },
};
const ICE_PLATE = {
  cap: ['#6aa6d6', '#9ad0f0', '#c4e6f8', '#e2f4fc', '#ffffff'],
  body: ['#2e6aa8', '#3a7ab8', '#4a8ac8', '#6aaee0', '#9ad0f0'],
  capPx: 3, shine: true,
};

const packedArt = new Map();
function paletteFor(theme, ptype, override) {
  const key = theme + '|' + ptype + '|' + (override || '');
  let p = packedArt.get(key);
  if (p) return p;
  const art = ART[theme] || ART.grass;
  const base = ptype === 'ice' ? { ...art, ...ICE_PLATE, tufts: false, roots: false, icicles: theme === 'ice', craters: false } : art;
  const cap = override ? ramp5(override) : base.cap;
  p = {
    cap: cap.map(pack), body: base.body.map(pack), fleck: base.fleck.map(pack),
    capPx: base.capPx, tufts: base.tufts, roots: base.roots, icicles: base.icicles,
    craters: base.craters, shine: base.shine,
    icicle: [pack(ICE_PLATE.cap[1]), pack(ICE_PLATE.cap[3])],
    root: pack(base.body[1]),
    dot: pack(theme === 'space' ? '#cac6e2' : '#fbf3e4'),
  };
  packedArt.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Pixel surfaces
// ---------------------------------------------------------------------------

function makeSurface(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(w, h);
  return { canvas, ctx, image, u32: new Uint32Array(image.data.buffer), w, h, x0: w, y0: h, x1: -1, y1: -1 };
}
function touch(S, x0, y0, x1, y1) {
  if (x0 < S.x0) S.x0 = x0;
  if (y0 < S.y0) S.y0 = y0;
  if (x1 > S.x1) S.x1 = x1;
  if (y1 > S.y1) S.y1 = y1;
}
function clearSurface(S) {
  if (S.x1 < S.x0) return;
  const x0 = Math.max(0, S.x0), x1 = Math.min(S.w - 1, S.x1);
  for (let y = Math.max(0, S.y0); y <= Math.min(S.h - 1, S.y1); y++) S.u32.fill(0, y * S.w + x0, y * S.w + x1 + 1);
  S.x0 = S.w; S.y0 = S.h; S.x1 = -1; S.y1 = -1;
}
function flushSurface(S, target) {
  if (S.x1 < S.x0) return;
  const x0 = Math.max(0, S.x0), y0 = Math.max(0, S.y0);
  const w = Math.min(S.w - 1, S.x1) - x0 + 1, h = Math.min(S.h - 1, S.y1) - y0 + 1;
  if (w <= 0 || h <= 0) return;
  S.ctx.putImageData(S.image, 0, 0, x0, y0, w, h);
  target.drawImage(S.canvas, x0, y0, w, h, x0, y0, w, h);
}

// Ordered dither for things that used to be translucent.
function ditherKeep(alpha, x, y) {
  if (alpha >= 0.8) return true;
  if (alpha >= 0.45) return ((x + y) & 1) === 0;
  if (alpha >= 0.2) return (x & 1) === 0 && (y & 1) === 0;
  return false;
}

// ---------------------------------------------------------------------------
// Terrain raster
// ---------------------------------------------------------------------------

// Draws one capsule platform into surface S. (ox, oy) is the pixel of world
// origin. Texture is sampled in the platform's own frame so it rides along
// when the platform moves or tips.
function rasterPlatform(S, b, pal, ox, oy, ppu, t, opts = {}) {
  const c = Math.cos(b.ang), s = Math.sin(b.ang);
  const hx = b.hx, r = b.r, inv = 1 / ppu;
  const bx = b.x, by = b.y;
  const seed = (b.id | 0) * 131 + 7;
  const pad = 5;
  const ex = Math.abs(c) * hx + r, ey = Math.abs(s) * hx + r;
  const X0 = Math.max(0, Math.floor(ox + (bx - ex) * ppu) - pad);
  const X1 = Math.min(S.w - 1, Math.ceil(ox + (bx + ex) * ppu) + pad);
  const Y0 = Math.max(0, Math.floor(oy + (by - ey) * ppu) - pad);
  const Y1 = Math.min(S.h - 1, Math.ceil(oy + (by + ey) * ppu) + pad + 3);
  if (X1 < X0 || Y1 < Y0) return;
  touch(S, X0, Y0, X1, Y1);
  const u32 = S.u32, W = S.w;
  const capBase = Math.min(pal.capPx, Math.max(2, r * ppu * 0.45));
  const rpx = r * ppu;
  const dist = (wx, wy) => {
    const dx = wx - bx, dy = wy - by;
    const u = dx * c + dy * s, v = -dx * s + dy * c;
    const cu = u < -hx ? -hx : u > hx ? hx : u;
    const du = u - cu;
    return Math.sqrt(du * du + v * v) - r;
  };
  const cap = pal.cap, body = pal.body;
  // Craters live in platform space.
  const craters = [];
  if (pal.craters) {
    const n = 2 + Math.floor(hash(seed, 1, 3) * 3);
    for (let i = 0; i < n; i++) {
      craters.push({
        u: (hash(seed, i, 5) * 2 - 1) * (hx + r * 0.4) * ppu,
        v: (hash(seed, i, 6) * 0.9 - 0.15) * rpx,
        r: 2 + hash(seed, i, 7) * Math.min(5, rpx * 0.35),
      });
    }
  }

  for (let py = Y0; py <= Y1; py++) {
    const wy = (py + 0.5 - oy) * inv;
    const row = py * W;
    for (let px = X0; px <= X1; px++) {
      const wx = (px + 0.5 - ox) * inv;
      const dx = wx - bx, dy = wy - by;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      const cu = u < -hx ? -hx : u > hx ? hx : u;
      const du = u - cu;
      const dd = Math.sqrt(du * du + v * v);
      const d = (dd - r) * ppu;
      const lu = Math.floor(u * ppu);
      const i = row + px;

      if (d >= 0) {
        if (u32[i] !== 0 || d >= 4) continue;
        if (opts.dotted && d < 1.6 && ((px + py) >> 1 & 1) === 0) { u32[i] = pal.dot; continue; }
        if (pal.tufts && d < 3 && dist(wx, wy + (d + 1.5) * inv) < 0) {
          const h = hash(lu, 0, seed);
          const blade = h < 0.38 ? 0 : h < 0.7 ? 1 : h < 0.9 ? 2 : 3;
          if (d < blade) u32[i] = cap[(lu & 1) ? 3 : 4];
          continue;
        }
        if ((pal.icicles || pal.roots) && dist(wx, wy - (d + 1.5) * inv) < 0) {
          const cell = Math.floor(lu / 3);
          const h = hash(cell, 1, seed);
          if (pal.icicles && h > 0.62) {
            const len = 1 + Math.floor((h - 0.62) * 12);
            const mid = lu - cell * 3 === 1;
            if (d < (mid ? len : len * 0.4)) u32[i] = pal.icicle[mid ? 1 : 0];
          } else if (pal.roots && h > 0.84 && lu - cell * 3 === 1) {
            if (d < 1 + (h - 0.84) * 18) u32[i] = pal.root;
          }
        }
        continue;
      }

      // Inside the platform.
      const top1 = dist(wx, wy - inv) >= 0;
      const drip = hash(lu >> 1, 2, seed);
      const capPx = capBase + (drip > 0.7 ? 2 : drip > 0.45 ? 1 : 0);
      const inCap = capPx > 0 && dist(wx, wy - capPx * inv) >= 0;
      const lv = Math.floor(v * ppu);
      let tone;
      let ramp = body;
      if (inCap) {
        ramp = cap;
        if (top1) tone = 4;
        else {
          const n = vnoise(lu / 7, lv / 4, seed);
          tone = n > 0.62 ? 3 : 2;
          // A darker lip where the cap meets the soil.
          if (dist(wx, wy - (capPx + 1) * inv) < 0) tone = 1;
        }
      } else {
        const n = vnoise(lu / 12, lv / 7, seed + 3);
        tone = n > 0.72 ? 3 : n < 0.26 ? 1 : 2;
        // The underside sits in shade.
        if (v * ppu > rpx * 0.42) tone = Math.max(1, tone - 1);
        // A row of shadow just under the cap.
        if (capPx > 0 && dist(wx, wy - (capPx + 1) * inv) >= 0) tone = 1;
        if (pal.shine) {
          const k = ((lu + lv) % 13 + 13) % 13;
          if (k < 2) tone = 4; else if (k === 2) tone = 3;
        }
        if (craters.length) {
          for (const cr of craters) {
            const cx = lu - cr.u, cy = lv - cr.v;
            const q = cx * cx + cy * cy;
            if (q < cr.r * cr.r) {
              const lit = (cx * 0.55 + cy * 0.83) / cr.r;
              tone = lit > 0.35 ? 3 : lit < -0.2 ? 0 : 1;
            } else if (q < (cr.r + 1) * (cr.r + 1)) {
              const lit = (cx * 0.55 + cy * 0.83) / cr.r;
              if (lit < -0.2) tone = 3;
            }
          }
        } else if (ramp === body) {
          // Pebbles in 7px cells, two or three pixels each, never single-pixel speckle.
          const cxl = Math.floor(lu / 7), cyl = Math.floor(lv / 7);
          const h = hash(cxl, cyl, seed + 11);
          if (h < 0.07) {
            const pxl = cxl * 7 + 2 + Math.floor(hash(cxl, cyl, seed + 12) * 3);
            const pyl = cyl * 7 + 2 + Math.floor(hash(cxl, cyl, seed + 13) * 3);
            const ax = lu - pxl, ay = lv - pyl;
            if (ax >= 0 && ax < 3 && ay >= 0 && ay < 2 && !(ax === 2 && ay === 1)) {
              u32[i] = ay === 0 ? pal.fleck[ax === 0 ? 2 : 1] : body[1];
              continue;
            }
          }
        }
      }
      // Bevel: the outer few pixels pick up light from the upper left.
      if (d > -3 && dd > 1e-6 && !(inCap && top1)) {
        const nu = du / dd, nv = v / dd;
        const nx = nu * c - nv * s, ny = nu * s + nv * c;
        const lit = -(nx * 0.55 + ny * 0.83);
        if (d > -1) tone = lit > 0.5 ? Math.max(tone, 3) : 0;
        else if (lit > 0.45) tone = Math.min(4, tone + 1);
        else if (lit < -0.4) tone = Math.max(0, tone - 1);
      }
      u32[i] = ramp[tone];
    }
  }

  if (opts.studs) {
    // Lamps are the tell that a platform travels.
    const on = Math.sin(t * 4) > -0.2;
    for (const side of [-0.55, 0.55]) {
      const wx = bx + c * hx * side - s * r * 0.15;
      const wy = by + s * hx * side + c * r * 0.15;
      const cx = Math.round(ox + wx * ppu), cy = Math.round(oy + wy * ppu);
      for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
        const px = cx + x, py = cy + y;
        if (px < 0 || py < 0 || px >= S.w || py >= S.h) continue;
        const edge = Math.abs(x) === 2 || Math.abs(y) === 2;
        if (edge && Math.abs(x) === 2 && Math.abs(y) === 2) continue;
        u32[py * W + px] = edge ? INK32 : pack(on ? (x < 1 && y < 0 ? '#fff4b8' : '#f0c040') : '#8a6a2a');
      }
    }
  }
  if (opts.eyes) {
    for (const side of [-1, 1]) {
      const wx = bx + c * hx * 0.3 * side - s * r * 0.1;
      const wy = by + s * hx * 0.3 * side + c * r * 0.1;
      rasterEye(S, ox + wx * ppu, oy + wy * ppu, Math.max(2, r * ppu * 0.32), opts.eyes.ax, opts.eyes.ay, false);
    }
  }
}

// ---------------------------------------------------------------------------
// Bopl raster
// ---------------------------------------------------------------------------

const EYE_WHITE = pack('#fbf6ec');
const EYE_SHADE = pack('#cfc6d6');
let boplGrid = new Uint32Array(64 * 64);

function rasterEye(S, cx, cy, er, ax, ay, blink) {
  const u32 = S.u32, W = S.w;
  const X0 = Math.floor(cx - er - 1), X1 = Math.ceil(cx + er + 1);
  const Y0 = Math.floor(cy - er - 1), Y1 = Math.ceil(cy + er + 1);
  if (blink) {
    const y = Math.round(cy);
    for (let x = Math.round(cx - er + 0.5); x < Math.round(cx + er - 0.5); x++) {
      if (x >= 0 && y >= 0 && x < S.w && y < S.h) u32[y * W + x] = INK32;
    }
    return;
  }
  const pr = Math.max(1, er * 0.5);
  const pcx = cx + ax * er * 0.42, pcy = cy + ay * er * 0.42;
  for (let y = Y0; y <= Y1; y++) {
    for (let x = X0; x <= X1; x++) {
      if (x < 0 || y < 0 || x >= S.w || y >= S.h) continue;
      const fx = x + 0.5 - cx, fy = y + 0.5 - cy;
      if (fx * fx + fy * fy > er * er) continue;
      const qx = x + 0.5 - pcx, qy = y + 0.5 - pcy;
      let col = EYE_WHITE;
      if (qx * qx + qy * qy <= pr * pr + 0.25) col = INK32;
      else if (fx * 0.6 + fy * 0.8 > er * 0.55) col = EYE_SHADE;
      u32[y * W + x] = col;
    }
  }
}

// A bopl is a slime, like the ones in Bopl Battle: a gumdrop with a flat base
// that sits on whatever it is stuck to, a round lit top, an ink outline and
// two eyes that look where it is aiming. (upx, upy) points away from the
// surface; w and h squash the body across and along it. cx, cy and rad are in
// surface pixels; the base sits about one radius below the centre.
function slimeInside(x, y) {
  // x across, y down, both in radii. Round dome on top, squircle below.
  if (y <= 0) return x * x + y * y <= 1;
  const yy = y / 0.82;
  return x * x * x * x + yy * yy * yy * yy <= 1;
}

function rasterBopl(S, cx, cy, rad, color, o = {}) {
  const { upx = 0, upy = -1, w = 1, h = 1, aimx = 1, aimy = 0, blink = false, alpha = 1, eyes = true } = o;
  const ramp = boplRamp(color);
  // Local frame: R across, D toward the surface.
  const rx = -upy, ry = upx, dx = -upx, dy = -upy;
  // Shift down so the flat base lands on the surface.
  const ox = cx + dx * rad * 0.16 * h, oy = cy + dy * rad * 0.16 * h;
  const ext = rad * Math.max(w, h) * 1.05 + 3;
  const X0 = Math.floor(ox - ext), Y0 = Math.floor(oy - ext);
  const gw = Math.ceil(ox + ext) - X0 + 1, gh = Math.ceil(oy + ext) - Y0 + 1;
  if (gw * gh > boplGrid.length) boplGrid = new Uint32Array(gw * gh * 2);
  const G = boplGrid;
  G.fill(0, 0, gw * gh);
  const iw = 1 / (rad * w), ih = 1 / (rad * h);
  const specR = Math.max(1.1, rad * 0.16) / rad;
  for (let gy = 1; gy < gh - 1; gy++) {
    for (let gx = 1; gx < gw - 1; gx++) {
      const px = X0 + gx + 0.5 - ox, py = Y0 + gy + 0.5 - oy;
      const lx = (px * rx + py * ry) * iw, ly = (px * dx + py * dy) * ih;
      if (!slimeInside(lx, ly)) continue;
      // Pseudo-normal: a dome over the top, flattening toward the base.
      const nly = ly < 0 ? ly : ly * 0.55;
      const q = Math.min(1, lx * lx + nly * nly);
      const nz = Math.sqrt(1 - q);
      const wx = lx * rx + nly * dx, wy = lx * ry + nly * dy;
      const l = -wx * 0.5 - wy * 0.62 + nz * 0.6;
      let col = l > 0.62 ? ramp.tones[3] : l > 0.2 ? ramp.tones[2] : l > -0.12 ? ramp.tones[1] : ramp.tones[0];
      // A darker band where the slime presses on the ground.
      if (ly > 0.62) col = ramp.tones[Math.min(1, ly > 0.72 ? 0 : 1)];
      const sxp = lx + 0.42, syp = ly + 0.5;
      if (sxp * sxp + syp * syp < specR * specR * 1.6) col = ramp.spec;
      G[gy * gw + gx] = col;
    }
  }
  // Ink outline on the 4-neighbourhood.
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const k = gy * gw + gx;
      if (G[k] !== 0) continue;
      if ((gx > 0 && G[k - 1] > 1) || (gx < gw - 1 && G[k + 1] > 1) ||
          (gy > 0 && G[k - gw] > 1) || (gy < gh - 1 && G[k + gw] > 1)) {
        G[k] = 1; // mark, resolved below so the outline doesn't grow into itself
      }
    }
  }
  const u32 = S.u32, W = S.w;
  touch(S, X0, Y0, X0 + gw, Y0 + gh);
  for (let gy = 0; gy < gh; gy++) {
    const y = Y0 + gy;
    if (y < 0 || y >= S.h) continue;
    for (let gx = 0; gx < gw; gx++) {
      const x = X0 + gx;
      if (x < 0 || x >= S.w) continue;
      let v = G[gy * gw + gx];
      if (v === 0) continue;
      if (v === 1) v = INK32;
      if (!ditherKeep(alpha, x, y)) continue;
      u32[y * W + x] = v;
    }
  }
  if (!eyes || alpha < 0.45) return;
  // Eyes sit high on the dome and drift a little toward the aim.
  const er = Math.max(1.8, rad * 0.3);
  const ex = ox - dx * rad * h * 0.3 + aimx * rad * 0.14, ey = oy - dy * rad * h * 0.3 + aimy * rad * 0.14;
  for (const side of [-1, 1]) {
    rasterEye(S, ex + rx * rad * w * 0.36 * side, ey + ry * rad * w * 0.36 * side, er, aimx, aimy, blink);
  }
}

// ---------------------------------------------------------------------------
// Path layers: props drawn with canvas paths, then snapped to hard alpha and
// optionally inked.
// ---------------------------------------------------------------------------

function hardenLayer(ctx, w, h, outline) {
  const image = ctx.getImageData(0, 0, w, h);
  const u32 = new Uint32Array(image.data.buffer);
  const n = w * h;
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = u32[i];
    if (v === 0) continue;
    if ((v >>> 24) < 110) u32[i] = 0;
    else { u32[i] = v | 0xff000000; any = true; }
  }
  if (!any) return null;
  if (outline) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (u32[i] !== 0) continue;
        const l = x > 0 ? u32[i - 1] : 0, r = x < w - 1 ? u32[i + 1] : 0;
        const t = y > 0 ? u32[i - w] : 0, b = y < h - 1 ? u32[i + w] : 0;
        if ((l && l !== 1) || (r && r !== 1) || (t && t !== 1) || (b && b !== 1)) u32[i] = 1;
      }
    }
    for (let i = 0; i < n; i++) if (u32[i] === 1) u32[i] = INK32;
  }
  ctx.putImageData(image, 0, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Ability glyphs: drawn as vector strokes into a 16px cell, then hardened
// into pixels and inked, so the menu, HUD and pickups share one icon set.
// ---------------------------------------------------------------------------

function drawGlyph(ctx, abilityId, u) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8 * u;
  const ring = (r, from = 0, to = TAU) => { ctx.beginPath(); ctx.arc(0, 0, r * u, from, to); ctx.stroke(); };
  const dot = (x, y, r) => { ctx.beginPath(); ctx.arc(x * u, y * u, r * u, 0, TAU); ctx.fill(); };
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1 * u, y1 * u); ctx.lineTo(x2 * u, y2 * u); ctx.stroke(); };
  const tri = (pts) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] * u, p[1] * u) : ctx.moveTo(p[0] * u, p[1] * u)); ctx.closePath(); ctx.fill(); };
  switch (abilityId) {
    case 'grenade': dot(0, 6, 22); line(0, -16, 0, -26); line(0, -26, 12, -32); break;
    case 'missile': tri([[28, 0], [-10, -16], [-10, 16]]); line(-14, -10, -28, -18); line(-14, 10, -28, 18); break;
    case 'rock': tri([[0, -26], [26, -4], [16, 24], [-16, 24], [-26, -4]]); break;
    case 'bow': ring(26, -1.1, 1.1); line(12, -22, -8, 0); line(12, 22, -8, 0); line(-16, 0, 28, 0); break;
    case 'beam': ctx.lineWidth = 16 * u; line(-26, 14, 26, -14); break;
    case 'grapple': line(-22, 22, 8, -8); ring(15, -2.6, 0.6); break;
    case 'dash': tri([[30, 0], [2, -20], [2, 20]]); line(-28, 0, -6, 0); line(-22, -13, -6, -13); line(-22, 13, -6, 13); break;
    case 'drill': tri([[30, 0], [-4, -16], [-4, 16]]); line(-10, -14, -10, 14); line(-22, -10, -22, 10); break;
    case 'blink': dot(-14, 0, 13); ctx.lineWidth = 6 * u; ring(0); ctx.beginPath(); ctx.arc(16 * u, 0, 11 * u, 0, TAU); ctx.stroke(); break;
    case 'duplicator': ring(14); ctx.beginPath(); ctx.arc(14 * u, 12 * u, 14 * u, 0, TAU); ctx.stroke(); break;
    case 'engine': tri([[-8, -18], [-8, 18], [-28, 0]]); dot(12, 0, 15); break;
    case 'growray': line(0, -22, 0, 22); line(-22, 0, 22, 0); ring(30); break;
    case 'shrinkray': line(-18, 0, 18, 0); ring(30); break;
    case 'gust': for (const y of [-15, 0, 15]) line(-28, y, 16, y); tri([[30, 0], [14, -11], [14, 11]]); break;
    case 'invis': ring(24, 0.6, 2.6); dot(-10, -6, 6); dot(10, -6, 6); break;
    case 'magnet': ctx.lineWidth = 14 * u; ring(20, Math.PI, TAU); line(-20, 0, -20, 20); line(20, 0, 20, 20); break;
    case 'meteor': dot(4, 8, 18); line(-12, -14, -26, -28); line(4, -16, 0, -32); line(18, -14, 26, -28); break;
    case 'mine': dot(0, 0, 14); for (let i = 0; i < 8; i++) { const a = TAU * i / 8; line(Math.cos(a) * 16, Math.sin(a) * 16, Math.cos(a) * 28, Math.sin(a) * 28); } break;
    case 'platform': ctx.fillRect(-30 * u, -10 * u, 60 * u, 20 * u); break;
    case 'push': ctx.fillRect(4 * u, -28 * u, 10 * u, 56 * u); line(-28, 0, -8, 0); tri([[-6, 0], [-18, -12], [-18, 12]]); break;
    case 'revival': ctx.lineWidth = 12 * u; line(0, -24, 0, 24); line(-18, -6, 18, -6); break;
    case 'roll': ring(22); line(0, -22, 0, 22); line(-22, 0, 22, 0); break;
    case 'smoke': dot(-13, 8, 14); dot(12, 4, 16); dot(-1, -14, 13); break;
    case 'spike': tri([[0, -30], [14, 26], [-14, 26]]); break;
    case 'teleport': ring(24, 0.5, 5.9); tri([[24, -8], [12, 6], [32, 10]]); break;
    case 'tesla': ctx.lineWidth = 9 * u; line(-6, -28, 10, -4); line(10, -4, -10, 4); line(-10, 4, 6, 28); break;
    case 'throw': dot(12, -10, 14); ring(26, 1.8, 4.2); break;
    case 'timestop': ring(26); line(0, -16, 0, 0); line(0, 0, 12, 8); break;
    case 'blackhole': ctx.lineWidth = 5 * u; ring(28); dot(0, 0, 15); break;
    default: ring(20); line(0, -6, 0, 6); break;
  }
}

const iconCache = new Map();
// 18x18 hard-pixel icon: a 16px glyph plus a one pixel ink outline.
export function pixelIcon(abilityId, color = '#f0c040') {
  const key = abilityId + color;
  let canvas = iconCache.get(key);
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.width = canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.translate(9, 9);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  drawGlyph(ctx, abilityId, 16 / 68);
  ctx.restore();
  // Light from the upper left: lighten the top-left edge of the glyph.
  hardenLayer(ctx, 18, 18, true);
  const image = ctx.getImageData(0, 0, 18, 18);
  const u32 = new Uint32Array(image.data.buffer);
  const base = pack(color), hi = pack(lite(color, 0.45)), lo = pack(shade(color, 0.3));
  for (let y = 0; y < 18; y++) for (let x = 0; x < 18; x++) {
    const i = y * 18 + x;
    if (u32[i] !== base) continue;
    const up = y > 0 ? u32[i - 18] : 0, left = x > 0 ? u32[i - 1] : 0;
    const down = y < 17 ? u32[i + 18] : 0, right = x < 17 ? u32[i + 1] : 0;
    if (up === INK32 || left === INK32) u32[i] = hi;
    else if (down === INK32 && right === INK32) u32[i] = lo;
  }
  ctx.putImageData(image, 0, 0);
  iconCache.set(key, canvas);
  return canvas;
}

// Menu-side icon painter. Draws the pixel icon at the biggest whole-number
// scale that fits the canvas.
export function paintAbilityIcon(canvas, abilityId, accent = '#f0c040') {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!abilityId) return null;
  const icon = pixelIcon(abilityId, accent);
  const k = Math.max(1, Math.floor(Math.min(canvas.width, canvas.height) / 18));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(icon, Math.floor((canvas.width - 18 * k) / 2), Math.floor((canvas.height - 18 * k) / 2), 18 * k, 18 * k);
  return ABILITY_BY_ID.get(abilityId);
}

// ---------------------------------------------------------------------------
// Backgrounds: cached per theme and buffer size, clouds drift on top.
// ---------------------------------------------------------------------------

function paintSkyBands(ctx, w, h, bands, top, bottom) {
  const n = bands.length;
  const span = (bottom - top) / n;
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = bands[i];
    const y0 = Math.floor(top + i * span);
    const y1 = Math.floor(top + (i + 1) * span);
    ctx.fillRect(0, i === 0 ? 0 : y0, w, i === n - 1 ? h - y0 : y1 - (i === 0 ? 0 : y0) + 1);
  }
  // Two rows of checker dither at each seam.
  for (let i = 1; i < n; i++) {
    const y0 = Math.floor(top + i * span);
    ctx.fillStyle = bands[i];
    for (let x = 0; x < w; x += 2) ctx.fillRect(x, y0 - 2, 1, 1);
    for (let x = 1; x < w; x += 2) ctx.fillRect(x, y0 - 1, 1, 1);
    ctx.fillStyle = bands[i - 1];
    for (let x = 0; x < w; x += 2) ctx.fillRect(x + 1, y0, 1, 1);
  }
}

function buildBackground(theme, w, h, ox, oy, ppu, world) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const art = ART[theme] || ART.grass;
  const horizon = world.water != null ? oy + world.water * ppu : oy + world.baseBounds.y * ppu;
  if (theme === 'space') {
    paintSkyBands(ctx, w, h, [...art.sky].reverse(), 0, h);
    // Nebula: broad soft blotches, dithered.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const n = vnoise(x / 46, y / 30, 17) * 0.7 + vnoise(x / 13, y / 11, 23) * 0.3;
      if (n > 0.7 && ((x + y) & 1) === 0) { ctx.fillStyle = art.far[0]; ctx.fillRect(x, y, 1, 1); }
      else if (n > 0.78) { ctx.fillStyle = art.far[0]; ctx.fillRect(x, y, 1, 1); }
    }
    // Stars.
    for (let i = 0; i < (w * h) / 260; i++) {
      const x = Math.floor(hash(i, 1, 99) * w), y = Math.floor(hash(i, 2, 99) * h);
      const b = hash(i, 3, 99);
      ctx.fillStyle = b > 0.85 ? '#fff0c0' : b > 0.5 ? '#a8a5c2' : '#6e6a88';
      ctx.fillRect(x, y, 1, 1);
    }
    // A banded planet, upper right, lit from the upper left.
    const pr = Math.round(Math.min(w, h) * 0.2);
    const pcx = Math.round(ox + world.baseBounds.x * ppu * 0.62), pcy = Math.round(oy - world.baseBounds.y * ppu * 0.5);
    const tones = ['#2a2246', '#3e3266', '#5a4688', '#7a62a8', '#a088c8'];
    for (let y = -pr; y <= pr; y++) for (let x = -pr; x <= pr; x++) {
      const q = (x * x + y * y) / (pr * pr);
      if (q > 1) continue;
      const nz = Math.sqrt(1 - q);
      const l = (-x * 0.6 - y * 0.5) / pr + nz * 0.5;
      const band = Math.sin((y + x * 0.25) / pr * 7.5) > 0.55 ? -1 : 0;
      let t = l > 0.75 ? 4 : l > 0.42 ? 3 : l > 0.1 ? 2 : l > -0.2 ? 1 : 0;
      if (l > -0.05 && l < 0.1 && ((x + y) & 1)) t = 1;
      t = Math.max(0, t + band);
      ctx.fillStyle = tones[t];
      ctx.fillRect(pcx + x, pcy + y, 1, 1);
    }
    // Ring: the far half hides behind the planet.
    const tilt = -0.22, ct = Math.cos(tilt), st = Math.sin(tilt);
    for (let a = 0; a < TAU; a += 0.5 / pr) {
      const ex = Math.cos(a) * pr * 1.65, ey = Math.sin(a) * pr * 0.32;
      const x = Math.round(ex * ct - ey * st), y = Math.round(ex * st + ey * ct);
      if (Math.sin(a) < 0 && x * x + y * y < pr * pr) continue;
      ctx.fillStyle = Math.sin(a) < 0 ? '#8a78b8' : '#c8b8e8';
      ctx.fillRect(pcx + x, pcy + y, 1, 1);
      ctx.fillStyle = '#5a4688';
      ctx.fillRect(pcx + x, pcy + y + 1, 1, 1);
    }
    return canvas;
  }
  paintSkyBands(ctx, w, h, art.sky, Math.max(0, oy - world.baseBounds.y * ppu - 10), horizon);
  if (theme === 'grass') {
    // Two hazy ridges of rolling hills.
    for (let layer = 0; layer < 2; layer++) {
      ctx.fillStyle = art.far[layer];
      for (let x = 0; x < w; x++) {
        const hgt = 22 + layer * -8 + Math.sin(x / (38 - layer * 9) + layer * 2) * (9 - layer * 2) + Math.sin(x / 13 + layer) * 2.5;
        const y = Math.round(horizon - 30 + layer * 14 - hgt);
        ctx.fillRect(x, y, 1, h - y);
      }
    }
    // Tree clumps on the near ridge.
    ctx.fillStyle = mix(art.far[1], '#5a7a32', 0.3);
    for (let i = 0; i < w / 26; i++) {
      const x = Math.floor(hash(i, 4, 5) * w);
      const hgt = 22 - 8 + Math.sin(x / 29 + 2) * 7 + Math.sin(x / 13 + 1) * 2.5;
      const y = Math.round(horizon - 16 - hgt);
      const r = 3 + Math.floor(hash(i, 6, 5) * 3);
      for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) {
        if (xx * xx + yy * yy <= r * r) ctx.fillRect(x + xx, y + yy, 1, 1);
      }
    }
  } else {
    // Ice: far glacier peaks with snow caps.
    for (let layer = 0; layer < 2; layer++) {
      for (let x = 0; x < w; x++) {
        const k = x / (50 - layer * 14) + layer * 3;
        const tri = Math.abs((k % 2) - 1);
        const hgt = 16 + tri * (36 - layer * 12) + Math.sin(x / 7 + layer) * 1.5;
        const y = Math.round(horizon - 22 + layer * 12 - hgt);
        ctx.fillStyle = art.far[layer];
        ctx.fillRect(x, y, 1, h - y);
        ctx.fillStyle = layer ? '#dce8f2' : '#e8f0f6';
        if (tri > 0.6) ctx.fillRect(x, y, 1, Math.round((tri - 0.6) * 14));
      }
    }
  }
  return canvas;
}

function cloudSprite(seed, art) {
  const w = 30 + Math.floor(hash(seed, 1, 8) * 26), h = 14;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const puffs = [];
  for (let i = 0; i < 4; i++) {
    puffs.push({ x: 7 + (w - 14) * (i / 3), y: h - 6 - hash(seed, i, 9) * 4, r: 4 + hash(seed, i, 10) * 3 });
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let inside = y >= h - 5;
    for (const p of puffs) if ((x - p.x) ** 2 + (y - p.y) ** 2 <= p.r * p.r) inside = true;
    if (!inside || x === 0 || x === w - 1) continue;
    ctx.fillStyle = y >= h - 3 ? art.cloud[1] : art.cloud[0];
    ctx.fillRect(x, y, 1, 1);
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const particles = [];
  let shake = 0;
  let flash = 0;
  let flashColor = '#fff';
  const api = { lastScale: 1 };

  // Buffers sized to the screen in art pixels.
  const buf = document.createElement('canvas');
  const bctx = buf.getContext('2d');
  let rasterS = null;
  const paths = document.createElement('canvas');
  const pctx = paths.getContext('2d', { willReadFrequently: true });
  let bgCache = null, bgKey = '';
  const ups = new Map();
  const clouds = [];

  function spawn(x, y, count, spec) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const s = spec.speed * (0.35 + Math.random() * 0.9);
      particles.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: spec.life * (0.6 + Math.random() * 0.7), max: spec.life,
        r: spec.r * (0.5 + Math.random()), color: spec.color, grav: spec.grav ?? 6,
      });
    }
  }

  // Sim events drive every bit of feedback on screen.
  function feed(events, world) {
    for (const e of events) {
      switch (e.e) {
        case 'blast': spawn(e.x, e.y, 26, { speed: 9, life: 0.5, r: 0.17, color: '#f0d060', grav: 2 });
          spawn(e.x, e.y, 14, { speed: 5, life: 0.7, r: 0.26, color: '#e8743a', grav: -1 });
          shake = Math.max(shake, 0.5); flash = 0.22; flashColor = '#ffcf7a'; break;
        case 'flame': spawn(e.x, e.y, 22, { speed: 8, life: 0.45, r: 0.2, color: '#f09a3c', grav: -3 });
          shake = Math.max(shake, 0.35); break;
        case 'slam': spawn(e.x, e.y, 22, { speed: 8, life: 0.4, r: 0.16, color: '#dce6f0', grav: 3 });
          shake = Math.max(shake, 0.55); break;
        case 'pop': {
          const color = COLORS[e.c % COLORS.length];
          spawn(e.x, e.y, 30, { speed: 8, life: 0.75, r: 0.2, color: color.body, grav: 7 });
          spawn(e.x, e.y, 10, { speed: 4, life: 0.5, r: 0.3, color: color.dark, grav: 5 });
          shake = Math.max(shake, 0.4); flash = 0.16; flashColor = color.body; break;
        }
        case 'gust': spawn(e.x, e.y, 20, { speed: 7, life: 0.3, r: 0.14, color: '#fbf3e4', grav: 0 }); break;
        case 'jump': spawn(e.x, e.y + 0.3, 4, { speed: 2, life: 0.2, r: 0.09, color: '#fbf3e4', grav: 4 }); break;
        case 'dash': spawn(e.x, e.y, 10, { speed: 5, life: 0.25, r: 0.12, color: '#bfe6f4', grav: 0 }); break;
        case 'eat': spawn(e.x, e.y, 16, { speed: 5, life: 0.5, r: 0.16, color: '#f0d060', grav: 3 }); break;
        case 'revive': spawn(e.x, e.y, 18, { speed: 4, life: 0.6, r: 0.15, color: '#84d4ae', grav: -2 }); break;
        case 'feed': spawn(e.x, e.y, 6, { speed: 3, life: 0.3, r: 0.1, color: '#b48ae0', grav: 0 }); break;
        case 'freeze': flash = 0.3; flashColor = '#9ad0f0'; break;
        case 'hole': shake = Math.max(shake, 0.3); break;
        case 'smoke': spawn(e.x, e.y, 12, { speed: 3, life: 0.9, r: 0.3, color: '#b6b4c4', grav: -1 }); break;
        case 'resize': spawn(e.x, e.y, 8, { speed: 3, life: 0.3, r: 0.12, color: e.d > 0 ? '#84d4ae' : '#ec96ae', grav: 0 }); break;
        case 'round': flash = 0.25; flashColor = '#ffffff'; break;
        case 'dust': spawn(e.x, e.y, 2, { speed: 1.2, life: 0.5, r: 0.07, color: '#fbf3e4', grav: -0.6 }); break;
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

  function capsulePath(c, x, y, hx, r, ang) {
    const cs = Math.cos(ang), s = Math.sin(ang);
    const x0 = x - cs * hx, y0 = y - s * hx;
    const x1 = x + cs * hx, y1 = y + s * hx;
    const nx = -s * r, ny = cs * r;
    // Both caps sweep anticlockwise so they bulge away from the segment.
    const a1 = Math.atan2(ny, nx);
    c.beginPath();
    c.moveTo(x0 + nx, y0 + ny);
    c.lineTo(x1 + nx, y1 + ny);
    c.arc(x1, y1, r, a1, a1 + Math.PI, true);
    c.lineTo(x0 - nx, y0 - ny);
    c.arc(x0, y0, r, a1 + Math.PI, a1, true);
    c.closePath();
  }

  // ---- props --------------------------------------------------------------

  function drawObject(c, b, view) {
    const t = view.time;
    switch (b.kind) {
      case 'grenade': {
        const danger = clamp(1 - b.fuse / 1.8, 0, 1);
        c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU);
        c.fillStyle = mix('#4a5a3a', '#d8484a', danger); c.fill();
        c.beginPath(); c.arc(b.x - b.r * 0.35, b.y - b.r * 0.35, b.r * 0.32, 0, TAU);
        c.fillStyle = mix('#7a8a5a', '#f0a090', danger); c.fill();
        c.fillStyle = '#8a8a86';
        c.fillRect(b.x - b.r * 0.3, b.y - b.r * 1.25, b.r * 0.6, b.r * 0.45);
        break;
      }
      case 'ability': {
        const bob = Math.sin(t * 5 + b.id) * 0.04;
        c.beginPath(); c.arc(b.x, b.y + bob, b.r * 1.2, 0, TAU);
        c.fillStyle = '#fbf3e4'; c.fill();
        c.beginPath(); c.arc(b.x, b.y + bob, b.r * 1.2, 0.2, Math.PI - 0.2);
        c.lineWidth = 0.08; c.strokeStyle = '#e6d8b0'; c.stroke();
        const s = 16 / PPU;
        c.drawImage(pixelIcon(b.abilityId, '#d8484a'), b.x - 9 / PPU, b.y + bob - 9 / PPU, s * 18 / 16, s * 18 / 16);
        break;
      }
      case 'missile': {
        capsulePath(c, b.x, b.y, b.hx, b.r, b.ang);
        c.fillStyle = '#e8e4ee'; c.fill();
        const cs = Math.cos(b.ang), s = Math.sin(b.ang);
        c.beginPath(); c.arc(b.x + cs * b.hx, b.y + s * b.hx, b.r * 0.95, 0, TAU);
        c.fillStyle = '#d8484a'; c.fill();
        c.fillStyle = '#d8484a';
        c.beginPath();
        c.moveTo(b.x - cs * b.hx, b.y - s * b.hx);
        c.lineTo(b.x - cs * (b.hx + b.r * 1.4) - s * b.r * 1.5, b.y - s * (b.hx + b.r * 1.4) + cs * b.r * 1.5);
        c.lineTo(b.x - cs * (b.hx + b.r * 1.4) + s * b.r * 1.5, b.y - s * (b.hx + b.r * 1.4) - cs * b.r * 1.5);
        c.closePath(); c.fill();
        break;
      }
      case 'arrow': {
        const cs = Math.cos(b.ang), s = Math.sin(b.ang);
        c.strokeStyle = '#a8703e'; c.lineWidth = Math.max(1.6 / PPU, b.r * 1.2);
        c.beginPath(); c.moveTo(b.x - cs * b.hx, b.y - s * b.hx); c.lineTo(b.x + cs * b.hx, b.y + s * b.hx); c.stroke();
        c.fillStyle = '#c8ccd4';
        c.beginPath();
        c.moveTo(b.x + cs * (b.hx + 0.14), b.y + s * (b.hx + 0.14));
        c.lineTo(b.x + cs * (b.hx - 0.06) - s * 0.09, b.y + s * (b.hx - 0.06) + cs * 0.09);
        c.lineTo(b.x + cs * (b.hx - 0.06) + s * 0.09, b.y + s * (b.hx - 0.06) - cs * 0.09);
        c.closePath(); c.fill();
        c.fillStyle = '#fbf3e4';
        c.fillRect(b.x - cs * b.hx - 0.06, b.y - s * b.hx - 0.06, 0.12, 0.12);
        break;
      }
      case 'hook': {
        c.beginPath(); c.arc(b.x, b.y, Math.max(b.r, 2.5 / PPU), 0, TAU);
        c.fillStyle = '#c8ccd4'; c.fill();
        break;
      }
      case 'boulder': {
        c.save();
        c.translate(b.x, b.y); c.rotate(b.ang);
        c.beginPath();
        for (let i = 0; i < 7; i++) {
          const a = TAU * i / 7;
          const rr = b.r * (0.86 + ((i * 37) % 5) / 22);
          if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
          else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        c.closePath();
        c.fillStyle = '#6a6a6a'; c.fill();
        c.restore();
        c.beginPath(); c.arc(b.x - b.r * 0.25, b.y - b.r * 0.3, b.r * 0.45, 0, TAU);
        c.fillStyle = '#8a8a86'; c.fill();
        break;
      }
      case 'mine': {
        const armed = b.state > 0;
        c.strokeStyle = armed ? '#3a2a34' : '#4a4a52'; c.lineWidth = b.r * 0.34;
        for (let i = 0; i < 6; i++) {
          const a = TAU * i / 6 + b.ang;
          c.beginPath();
          c.moveTo(b.x + Math.cos(a) * b.r * 0.8, b.y + Math.sin(a) * b.r * 0.8);
          c.lineTo(b.x + Math.cos(a) * b.r * 1.45, b.y + Math.sin(a) * b.r * 1.45);
          c.stroke();
        }
        c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU);
        c.fillStyle = armed ? '#4a3646' : '#5a5a64'; c.fill();
        if (!armed || Math.sin(t * 14) > 0) {
          c.beginPath(); c.arc(b.x, b.y, Math.max(b.r * 0.38, 1.5 / PPU), 0, TAU);
          c.fillStyle = armed ? '#ff4a3a' : '#8a8a96'; c.fill();
        }
        break;
      }
      case 'spike': {
        const cs = Math.cos(b.ang), s = Math.sin(b.ang);
        c.beginPath();
        c.moveTo(b.x + cs * b.hx, b.y + s * b.hx);
        c.lineTo(b.x - cs * b.hx - s * b.r, b.y - s * b.hx + cs * b.r);
        c.lineTo(b.x - cs * b.hx + s * b.r, b.y - s * b.hx - cs * b.r);
        c.closePath();
        c.fillStyle = '#c8ccd8'; c.fill();
        c.beginPath();
        c.moveTo(b.x + cs * b.hx, b.y + s * b.hx);
        c.lineTo(b.x - cs * b.hx - s * b.r, b.y - s * b.hx + cs * b.r);
        c.lineTo(b.x - cs * b.hx, b.y - s * b.hx);
        c.closePath();
        c.fillStyle = '#8a8ea0'; c.fill();
        break;
      }
      case 'coil': {
        capsulePath(c, b.x, b.y, b.hx, b.r * 0.5, b.ang);
        c.fillStyle = '#4a4658'; c.fill();
        c.beginPath();
        c.arc(b.x - Math.cos(b.ang) * b.hx, b.y - Math.sin(b.ang) * b.hx, b.r * 0.8, 0, TAU);
        c.fillStyle = '#9ad0f0'; c.fill();
        break;
      }
      case 'engine': {
        c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU);
        c.fillStyle = '#5a5464'; c.fill();
        c.beginPath(); c.arc(b.x - b.r * 0.25, b.y - b.r * 0.25, b.r * 0.45, 0, TAU);
        c.fillStyle = '#7a7486'; c.fill();
        break;
      }
      case 'canister': {
        c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU);
        c.fillStyle = '#7f8a76'; c.fill();
        c.fillStyle = '#a4ae96';
        c.fillRect(b.x - b.r * 0.6, b.y - b.r * 0.2, b.r * 1.2, b.r * 0.35);
        break;
      }
    }
  }

  // Glows: hard-edged but never inked.
  function drawGlow(c, b, view) {
    const t = view.time;
    switch (b.kind) {
      case 'ray': {
        const glow = { grow: '#84d4ae', shrink: '#ec96ae', blink: '#9ad0f0', dup: '#f0d060' }[b.mode] || '#fbf3e4';
        c.beginPath(); c.arc(b.x, b.y, b.r * 1.6, 0, TAU);
        c.fillStyle = glow; c.fill();
        c.beginPath(); c.arc(b.x, b.y, b.r * 0.8, 0, TAU);
        c.fillStyle = '#fffaf0'; c.fill();
        break;
      }
      case 'missile': {
        const cs = Math.cos(b.ang), s = Math.sin(b.ang);
        const f = b.r * (0.7 + 0.35 * Math.sin(t * 40 + b.id));
        c.beginPath(); c.arc(b.x - cs * (b.hx + b.r * 1.6), b.y - s * (b.hx + b.r * 1.6), f, 0, TAU);
        c.fillStyle = '#f09a3c'; c.fill();
        c.beginPath(); c.arc(b.x - cs * (b.hx + b.r * 1.3), b.y - s * (b.hx + b.r * 1.3), f * 0.55, 0, TAU);
        c.fillStyle = '#fff0a0'; c.fill();
        break;
      }
      case 'engine': {
        const f = b.r * (1.25 + 0.3 * Math.sin(t * 37 + b.id));
        c.beginPath(); c.arc(b.x, b.y, f, 0, TAU);
        c.fillStyle = '#f09a3c'; c.fill();
        break;
      }
      case 'orb': {
        const armed = (b.arm || 0) <= 0;
        const on = armed ? Math.sin(t * 3.4) > -0.5 : Math.sin(t * 9) > 0;
        c.beginPath(); c.arc(b.x, b.y, b.r * (on ? 1 : 0.8), 0, TAU);
        c.fillStyle = armed ? '#84d4ae' : '#5f7f6c'; c.fill();
        c.beginPath(); c.arc(b.x - b.r * 0.2, b.y - b.r * 0.2, b.r * 0.4, 0, TAU);
        c.fillStyle = armed ? '#d8f8e4' : '#84a08c'; c.fill();
        break;
      }
    }
  }

  // Translucent effects drawn straight onto the buffer.
  function drawFx(c, b, view) {
    switch (b.kind) {
      case 'smoke': {
        c.globalAlpha = (b.lit ? 0.9 : 0.7) * clamp(b.ttl / 2, 0.25, 1);
        c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU);
        c.fillStyle = b.lit ? '#f09a3c' : '#b6b4c4'; c.fill();
        c.beginPath(); c.arc(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.55, 0, TAU);
        c.fillStyle = b.lit ? '#f0d060' : '#d4d2de'; c.fill();
        c.globalAlpha = 1;
        break;
      }
      case 'hole': {
        const rings = b.white ? ['#dceefa', '#b4d8f4', '#ffffff'] : ['#4a2a6a', '#2a1440', '#0a0510'];
        c.globalAlpha = 0.28;
        c.fillStyle = rings[0];
        c.beginPath(); c.arc(b.x, b.y, b.core * 4.2, 0, TAU); c.fill();
        c.globalAlpha = 0.45;
        c.beginPath(); c.arc(b.x, b.y, b.core * 2.4, 0, TAU); c.fill();
        c.globalAlpha = 1;
        c.fillStyle = rings[1];
        c.beginPath(); c.arc(b.x, b.y, b.core * 1.35, 0, TAU); c.fill();
        c.fillStyle = rings[2];
        c.beginPath(); c.arc(b.x, b.y, b.core, 0, TAU); c.fill();
        break;
      }
      case 'bubble': {
        c.globalAlpha = 0.22;
        c.beginPath(); c.arc(b.x, b.y, b.r, 0, TAU);
        c.fillStyle = '#9ad0f0'; c.fill();
        c.globalAlpha = 1;
        c.lineWidth = 1 / PPU; c.strokeStyle = '#d4f0fc';
        c.beginPath(); c.arc(b.x, b.y, b.r - 0.5 / PPU, 0, TAU); c.stroke();
        c.fillStyle = '#ffffff';
        c.fillRect(b.x - b.r * 0.55, b.y - b.r * 0.55, 2 / PPU, 2 / PPU);
        break;
      }
    }
  }

  // ---- players ------------------------------------------------------------

  function playerAlpha(p, view) {
    const mine = p.pid === view.localPid;
    let alpha = 1;
    if (p.invis > 0) alpha = mine ? 0.34 : 0.06;
    if (p.iframes > 0) alpha *= Math.sin(view.time * 22) > 0 ? 1 : 0.5;
    return alpha;
  }

  // Bodies drawn in the outlined prop layer, under the bopl.
  function drawPlayerProps(c, p, world, view) {
    if (!p.alive || p.hidden > 0) return;
    const color = COLORS[p.color % COLORS.length];
    if (p.form === 'rock') {
      c.save();
      c.translate(p.x, p.y);
      c.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = TAU * i / 8;
        const rr = p.r * (0.9 + ((i * 53) % 6) / 30);
        if (i === 0) c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
        else c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath();
      c.fillStyle = '#7a7086'; c.fill();
      c.restore();
      c.beginPath(); c.arc(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.4, 0, TAU);
      c.fillStyle = '#9a90a6'; c.fill();
      c.beginPath(); c.arc(p.x + p.r * 0.35, p.y + p.r * 0.35, p.r * 0.25, 0, TAU);
      c.fillStyle = color.body; c.fill();
      return;
    }
    if (p.form === 'drill') {
      const ang = Math.atan2(p.input.ay, p.input.ax);
      c.save();
      c.translate(p.x, p.y); c.rotate(ang);
      c.beginPath();
      c.moveTo(p.r * 1.9, 0); c.lineTo(-p.r * 0.2, -p.r * 0.85); c.lineTo(-p.r * 0.2, p.r * 0.85);
      c.closePath();
      c.fillStyle = '#c8ccd8'; c.fill();
      c.beginPath();
      c.moveTo(p.r * 1.9, 0); c.lineTo(-p.r * 0.2, p.r * 0.85); c.lineTo(-p.r * 0.2, 0);
      c.closePath();
      c.fillStyle = '#8a8ea0'; c.fill();
      c.restore();
    }
  }

  // Held items, drawn after the bopl so they sit in front.
  function drawPlayerGear(c, p, view) {
    if (!p.alive || p.hidden > 0 || p.invis > 0 && p.pid !== view.localPid) return;
    const cx = p.input.ax, sy = p.input.ay;
    if (p.form === 'bow') {
      const pull = 0.3 + p.charge * 0.5;
      c.save(); c.translate(p.x + cx * p.r, p.y + sy * p.r); c.rotate(Math.atan2(sy, cx));
      c.beginPath(); c.arc(0, 0, p.r * 1.15, -1.1, 1.1);
      c.strokeStyle = '#a8703e'; c.lineWidth = 2.2 / PPU; c.stroke();
      c.beginPath();
      c.moveTo(Math.cos(-1.1) * p.r * 1.15, Math.sin(-1.1) * p.r * 1.15);
      c.lineTo(-pull * p.r, 0);
      c.lineTo(Math.cos(1.1) * p.r * 1.15, Math.sin(1.1) * p.r * 1.15);
      c.strokeStyle = '#fbf3e4'; c.lineWidth = 1.1 / PPU; c.stroke();
      c.restore();
    }
    if (p.form === 'gun') {
      c.save(); c.translate(p.x, p.y); c.rotate(Math.atan2(sy, cx));
      c.fillStyle = '#4a4658';
      c.fillRect(p.r * 0.55, -p.r * 0.3, p.r * 1.25, p.r * 0.6);
      c.fillStyle = '#9ad0f0';
      c.fillRect(p.r * 1.5, -p.r * 0.2, p.r * 0.32, p.r * 0.4);
      c.restore();
    }
  }

  function drawPlayerGlow(c, p, view) {
    if (!p.alive || p.hidden > 0) return;
    if (p.invis > 0 && p.pid !== view.localPid) return;
    const color = COLORS[p.color % COLORS.length];
    const cx = p.input.ax, sy = p.input.ay;
    if (p.form === 'beam') {
      const reach = p.beamLen || 8;
      const wob = Math.sin(view.time * 50) > 0 ? 1 : 0;
      c.lineCap = 'butt';
      c.strokeStyle = color.body;
      c.lineWidth = (7 + wob) / PPU;
      c.beginPath(); c.moveTo(p.x + cx * p.r, p.y + sy * p.r); c.lineTo(p.x + cx * reach, p.y + sy * reach); c.stroke();
      c.strokeStyle = lite(color.body, 0.55);
      c.lineWidth = 4 / PPU;
      c.beginPath(); c.moveTo(p.x + cx * p.r, p.y + sy * p.r); c.lineTo(p.x + cx * reach, p.y + sy * reach); c.stroke();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 2 / PPU;
      c.beginPath(); c.moveTo(p.x + cx * p.r, p.y + sy * p.r); c.lineTo(p.x + cx * reach, p.y + sy * reach); c.stroke();
    }
    if (p.form === 'roll') {
      c.beginPath();
      c.arc(p.x, p.y, p.r * 1.35, view.time * 18, view.time * 18 + 4.4);
      c.strokeStyle = lite(color.body, 0.4); c.lineWidth = 2 / PPU; c.stroke();
    }
    if (p.form === 'meteor') {
      c.fillStyle = '#f09a3c';
      c.beginPath();
      c.moveTo(p.x - p.r * 0.9, p.y - p.r * 2.4); c.lineTo(p.x + p.r * 0.9, p.y - p.r * 2.4); c.lineTo(p.x, p.y - p.r * 0.5);
      c.closePath(); c.fill();
      c.fillStyle = '#f0d060';
      c.beginPath();
      c.moveTo(p.x - p.r * 0.45, p.y - p.r * 2.0); c.lineTo(p.x + p.r * 0.45, p.y - p.r * 2.0); c.lineTo(p.x, p.y - p.r * 0.8);
      c.closePath(); c.fill();
    }
    if (p.form === 'timestop') {
      c.beginPath();
      c.arc(p.x, p.y, p.r * (1.6 + p.charge * 1.6), 0, TAU);
      c.strokeStyle = '#9ad0f0'; c.lineWidth = 1.5 / PPU; c.stroke();
    }
    if (p.charge > 0 && (p.form === 'normal' || p.form === 'throw')) {
      c.beginPath();
      c.arc(p.x, p.y - p.r - 0.32, 3.5 / PPU, -Math.PI / 2, -Math.PI / 2 + TAU * p.charge);
      c.strokeStyle = '#f0d060'; c.lineWidth = 2 / PPU; c.stroke();
    }
  }

  function rasterPlayer(S, p, world, view, ox, oy) {
    if (!p.alive) return;
    const color = COLORS[p.color % COLORS.length];
    if (p.hidden > 0) return;
    const alpha = playerAlpha(p, view);
    if (p.form === 'platform') {
      const pal = paletteFor(world.theme, 'ground', color.body);
      rasterPlatform(S, { x: p.x, y: p.y, hx: p.hx, r: p.r, ang: p.ang, id: p.id }, pal, ox, oy, PPU, view.time,
        { eyes: { ax: p.input.ax, ay: p.input.ay } });
      return;
    }
    if (p.form === 'rock') return;
    let x = p.x, y = p.y, r = p.r, ax = p.input.ax, ay = p.input.ay;
    if (p.form === 'drill') {
      const ang = Math.atan2(p.input.ay, p.input.ax);
      x -= Math.cos(ang) * p.r * 0.4; y -= Math.sin(ang) * p.r * 0.4; r *= 0.85;
      ax = -Math.cos(ang); ay = -Math.sin(ang);
    }
    // Ease the slime's base toward the surface it clings to; upright in the air.
    let up = ups.get(p.id);
    if (!up) { up = { a: -Math.PI / 2, t: view.time }; ups.set(p.id, up); }
    const dt = clamp(view.time - up.t, 0, 0.1);
    up.t = view.time;
    const grounded = p.grounded && Number.isFinite(p.groundNx) && (p.groundNx || p.groundNy);
    const target = grounded ? Math.atan2(p.groundNy, p.groundNx) : -Math.PI / 2;
    let da = target - up.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    up.a += da * (1 - Math.exp(-dt * (grounded ? 22 : 7)));
    const upx = Math.cos(up.a), upy = Math.sin(up.a);
    // Stretch along the up axis when flying fast along it, squash on landing,
    // and a constant soft jiggle.
    const speed = Math.hypot(p.vx, p.vy);
    const along = speed > 0.4 ? Math.abs(p.vx * upx + p.vy * upy) / speed : 0;
    const st = clamp(speed / 40, 0, 0.2) * along;
    const squash = clamp(p.stretch || 0, 0, 1);
    const jig = Math.sin(view.time * 7 + p.idx * 1.9) * (grounded ? 0.035 : 0.05);
    rasterBopl(S, ox + x * PPU, oy + y * PPU, r * PPU, color, {
      upx, upy,
      h: 1 + st - squash * 0.5 + jig, w: 1 - st * 0.6 + squash * 0.45 - jig * 0.7,
      aimx: ax, aimy: ay, alpha,
      blink: Math.sin(view.time * 1.3 + p.idx * 2.1) > 0.985,
    });
  }

  // ---- frame --------------------------------------------------------------

  function ensureBuffers(W, H) {
    if (buf.width !== W || buf.height !== H) {
      buf.width = W; buf.height = H;
      paths.width = W; paths.height = H;
      rasterS = makeSurface(W, H);
      bgKey = '';
    }
  }

  function pathLayer(ox, oy) {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.clearRect(0, 0, paths.width, paths.height);
    pctx.setTransform(PPU, 0, 0, PPU, ox, oy);
    return pctx;
  }
  function flushPaths(outline) {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    if (hardenLayer(pctx, paths.width, paths.height, outline)) bctx.drawImage(paths, 0, 0);
  }

  function drawWater(c, world, view, ox, oy, W, H) {
    const art = ART[world.theme];
    if (world.water == null || !art?.water) return;
    const [deep, mid, top, light, crest] = art.water;
    const base = Math.round(oy + world.water * PPU);
    const t = view.time;
    c.fillStyle = top; c.fillRect(0, base + 3, W, 8);
    c.fillStyle = mid; c.fillRect(0, base + 11, W, 14);
    c.fillStyle = deep; c.fillRect(0, base + 25, W, Math.max(0, H - base - 25));
    // Dither seams between bands.
    for (const [y, col] of [[base + 10, mid], [base + 24, deep]]) {
      c.fillStyle = col;
      for (let x = (y & 1); x < W; x += 2) c.fillRect(x, y, 1, 1);
    }
    for (let x = 0; x < W; x++) {
      const wx = x - ox;
      const wave = Math.round(Math.sin(wx * 0.09 + t * 2.2) * 1.3 + Math.sin(wx * 0.031 - t * 1.3) * 1.1);
      const y = base + wave;
      c.fillStyle = light; c.fillRect(x, y + 1, 1, base + 3 - y);
      c.fillStyle = crest; c.fillRect(x, y, 1, 1);
    }
    // Drifting glints.
    c.fillStyle = light;
    for (let i = 0; i < 14; i++) {
      const x = Math.floor(((hash(i, 1, 41) * W + t * (6 + i % 3 * 3)) % W));
      const y = base + 6 + Math.floor(hash(i, 2, 41) * 16);
      if (Math.sin(t * 2 + i) > -0.3) c.fillRect(x, y, 3 + (i % 3), 1);
    }
  }

  function drawWeather(c, world, view, W, H) {
    const t = view.time;
    if (world.theme === 'ice') {
      c.fillStyle = '#ffffff';
      for (let i = 0; i < 70; i++) {
        const speed = 8 + hash(i, 1, 51) * 10;
        const x = Math.floor((hash(i, 2, 51) * W + Math.sin(t * 0.8 + i) * 6 + W) % W);
        const y = Math.floor((hash(i, 3, 51) * H + t * speed) % H);
        c.fillRect(x, y, i % 5 === 0 ? 2 : 1, i % 5 === 0 ? 2 : 1);
      }
    } else if (world.theme === 'space') {
      for (let i = 0; i < 10; i++) {
        const tw = Math.sin(t * (1.1 + i * 0.13) + i * 2.4);
        if (tw < 0.3) continue;
        const x = Math.floor(hash(i, 7, 61) * W), y = Math.floor(hash(i, 8, 61) * H);
        c.fillStyle = '#fff0c0';
        c.fillRect(x, y - 1, 1, 3); c.fillRect(x - 1, y, 3, 1);
        if (tw > 0.85) { c.fillRect(x, y - 2, 1, 5); c.fillRect(x - 2, y, 5, 1); }
      }
    }
  }

  function drawClouds(c, world, view, W, oy) {
    if (world.theme === 'space') return;
    const art = ART[world.theme];
    if (!clouds.length || clouds.theme !== world.theme) {
      clouds.length = 0;
      clouds.theme = world.theme;
      for (let i = 0; i < 6; i++) clouds.push({ img: cloudSprite(i + 3, art), x: hash(i, 1, 71), y: hash(i, 2, 71), v: 2 + hash(i, 3, 71) * 3 });
    }
    const top = oy - world.baseBounds.y * PPU;
    for (const cl of clouds) {
      const span = W + cl.img.width;
      const x = Math.floor(((cl.x * span + view.time * cl.v) % span) - cl.img.width);
      const y = Math.floor(top + 4 + cl.y * world.baseBounds.y * PPU * 0.8);
      c.drawImage(cl.img, x, y);
    }
  }

  function drawFrame(world, view) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    const DW = Math.round(cw * dpr), DH = Math.round(ch * dpr);
    if (canvas.width !== DW || canvas.height !== DH) { canvas.width = DW; canvas.height = DH; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, DW, DH);
    if (!world) return;

    // Device pixels per art pixel: a whole number whenever that costs little.
    const pad = 0.7;
    const fit = Math.min(DW / ((world.baseBounds.x * 2 + pad) * PPU), DH / ((world.baseBounds.y * 2 + pad) * PPU));
    let k = fit;
    if (fit >= 1 && Math.floor(fit) / fit >= 0.8) k = Math.floor(fit);
    const W = Math.ceil(DW / k) + 2, H = Math.ceil(DH / k) + 2;
    ensureBuffers(W, H);
    const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
    const sx = shake ? Math.round((Math.random() - 0.5) * shake * 0.5 * PPU) : 0;
    const sy = shake ? Math.round((Math.random() - 0.5) * shake * 0.5 * PPU) : 0;
    const ox = cx + sx, oy = cy + sy;
    const dx = DW / 2 - cx * k, dy = DH / 2 - cy * k;
    api.lastScale = PPU * k / dpr;
    view.scale = api.lastScale;

    // Background.
    const key = world.theme + W + 'x' + H + ':' + world.water + ':' + world.baseBounds.x;
    if (bgKey !== key) { bgCache = buildBackground(world.theme, W, H, cx, cy, PPU, world); bgKey = key; }
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.imageSmoothingEnabled = false;
    bctx.drawImage(bgCache, 0, 0);
    drawClouds(bctx, world, view, W, cy);
    drawWeather(bctx, world, view, W, H);

    // Terrain.
    const S = rasterS;
    clearSurface(S);
    for (const b of world.bodies) {
      if (b.kind !== 'plat' || b.hidden > 0) continue;
      rasterPlatform(S, b, paletteFor(world.theme, b.ptype), ox, oy, PPU, view.time,
        { studs: b.ptype === 'moving', dotted: b.ptype === 'free' });
    }
    flushSurface(S, bctx);
    drawWater(bctx, world, view, ox, oy, W, H);

    // Translucent effects under the props.
    bctx.setTransform(PPU, 0, 0, PPU, ox, oy);
    for (const b of world.bodies) {
      if (b.hidden > 0) continue;
      if (b.kind === 'hole' || b.kind === 'bubble') drawFx(bctx, b, view);
    }
    bctx.setTransform(1, 0, 0, 1, 0, 0);

    // Inked props.
    let c = pathLayer(ox, oy);
    for (const b of world.bodies) {
      if (b.kind === 'plat' || b.kind === 'bopl' || b.hidden > 0) continue;
      drawObject(c, b, view);
    }
    for (const p of world.players) drawPlayerProps(c, p, world, view);
    flushPaths(true);

    // Glows under the bopls: tesla arcs, ropes, flames, orbs.
    c = pathLayer(ox, oy);
    for (const b of world.bodies) {
      if (b.hidden > 0) continue;
      drawGlow(c, b, view);
    }
    const coils = world.bodies.filter(b => b.kind === 'coil');
    for (let i = 0; i < coils.length; i++) {
      for (let j = i + 1; j < coils.length; j++) {
        const a = coils[i], b = coils[j];
        if (a.owner !== b.owner || a.slot !== b.slot) continue;
        if ((a.arcOff || 0) > 0 || (b.arcOff || 0) > 0) continue;
        c.beginPath();
        const steps = 10;
        for (let n = 0; n <= steps; n++) {
          const f = n / steps;
          const jitter = n === 0 || n === steps ? 0 : (Math.random() - 0.5) * 0.3;
          const x = a.x + (b.x - a.x) * f - (b.y - a.y) * jitter * 0.1;
          const y = a.y + (b.y - a.y) * f + (b.x - a.x) * jitter * 0.1;
          if (n === 0) c.moveTo(x, y); else c.lineTo(x, y);
        }
        c.strokeStyle = '#6aaee0'; c.lineWidth = 4 / PPU; c.stroke();
        c.strokeStyle = '#e2f4fc'; c.lineWidth = 1.6 / PPU; c.stroke();
      }
    }
    for (const p of world.players) {
      if (!p.alive || p.grappleId < 0) continue;
      const host = world.bodies.find(b => b.id === p.grappleId);
      if (!host) continue;
      const cs = Math.cos(host.ang), s = Math.sin(host.ang);
      const ax = host.x + (p.grappleLx * cs - p.grappleLy * s);
      const ay = host.y + (p.grappleLx * s + p.grappleLy * cs);
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(ax, ay);
      c.strokeStyle = INK; c.lineWidth = 3 / PPU; c.stroke();
      c.strokeStyle = '#e6d8b0'; c.lineWidth = 1.2 / PPU; c.stroke();
    }
    for (const p of world.players) {
      if (!p.alive || p.heldId < 0) continue;
      const held = world.bodies.find(b => b.id === p.heldId);
      if (!held) continue;
      c.setLineDash([3 / PPU, 3 / PPU]);
      c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(held.x, held.y);
      c.strokeStyle = '#9ad0f0'; c.lineWidth = 1.5 / PPU; c.stroke();
      c.setLineDash([]);
    }
    flushPaths(false);

    // Bopls.
    if (ups.size > 64) for (const id of ups.keys()) if (!world.players.some(p => p.id === id)) ups.delete(id);
    clearSurface(S);
    for (const p of world.players) rasterPlayer(S, p, world, view, ox, oy);
    flushSurface(S, bctx);

    // Beams and held gear on top.
    c = pathLayer(ox, oy);
    for (const p of world.players) drawPlayerGlow(c, p, view);
    flushPaths(false);
    c = pathLayer(ox, oy);
    for (const p of world.players) drawPlayerGear(c, p, view);
    flushPaths(true);

    // Smoke over everything it hides.
    bctx.setTransform(PPU, 0, 0, PPU, ox, oy);
    for (const b of world.bodies) if (b.kind === 'smoke' && !(b.hidden > 0)) drawFx(bctx, b, view);
    bctx.setTransform(1, 0, 0, 1, 0, 0);

    // Particles: square pixels that step darker instead of fading.
    for (const p of particles) {
      const f = p.life / p.max;
      const size = clamp(Math.round(p.r * PPU * 0.55 * (0.5 + f * 0.6)), 1, 4);
      bctx.fillStyle = f > 0.45 ? p.color : shade(p.color, 0.35);
      bctx.fillRect(Math.round(ox + p.x * PPU - size / 2), Math.round(oy + p.y * PPU - size / 2), size, size);
    }

    // Death barrier: a dotted pixel line, solid and pulsing in sudden death.
    if (world.players.length) {
      const x0 = Math.round(ox - world.bounds.x * PPU), x1 = Math.round(ox + world.bounds.x * PPU);
      const y0 = Math.round(oy - world.bounds.y * PPU), y1 = Math.round(oy + world.bounds.y * PPU);
      if (world.sudden > 0) {
        bctx.fillStyle = Math.sin(view.time * 6) > 0 ? '#d8484a' : '#f0a090';
        bctx.fillRect(x0, y0, x1 - x0, 2); bctx.fillRect(x0, y1 - 2, x1 - x0, 2);
        bctx.fillRect(x0, y0, 2, y1 - y0); bctx.fillRect(x1 - 2, y0, 2, y1 - y0);
      } else {
        bctx.globalAlpha = 0.35;
        bctx.fillStyle = '#fbf3e4';
        for (let x = x0; x < x1; x += 4) { bctx.fillRect(x, y0, 2, 1); bctx.fillRect(x, y1 - 1, 2, 1); }
        for (let y = y0; y < y1; y += 4) { bctx.fillRect(x0, y, 1, 2); bctx.fillRect(x1 - 1, y, 1, 2); }
        bctx.globalAlpha = 1;
      }
    }

    // Blit, whole pixels.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(buf, 0, 0, W, H, dx, dy, W * k, H * k);

    // Loadout tiles and names at screen resolution, snapped to the art grid.
    const toX = wx => dx + (ox + wx * PPU) * k;
    const toY = wy => dy + (oy + wy * PPU) * k;
    const unit = Math.max(1, Math.round(k));
    for (const p of world.players) {
      if (!p.alive || !p.slots.length || (p.invis > 0 && p.pid !== view.localPid) || p.hidden > 0) continue;
      const color = COLORS[p.color % COLORS.length];
      const iz = Math.max(1, Math.round(k / 2));
      const tile = 16 * iz;
      const gap = 3 * iz;
      const width = p.slots.length * tile + (p.slots.length - 1) * gap;
      const left = Math.round(toX(p.x) - width / 2);
      const top = Math.round(toY(p.y - p.r) - 7 * unit - 16 * Math.max(1, Math.round(k / 2)));
      const busy = p.slots.some(slot => slot.state === 1);
      for (let i = 0; i < p.slots.length; i++) {
        const slot = p.slots[i];
        const x = left + i * (tile + gap);
        ctx.fillStyle = INK;
        ctx.fillRect(x - iz, top - iz, tile + 2 * iz, tile + 2 * iz);
        ctx.fillStyle = color.body;
        ctx.fillRect(x, top, tile, tile);
        ctx.fillStyle = color.dark;
        ctx.fillRect(x, top + tile - iz, tile, iz);
        if (slot.id) ctx.drawImage(pixelIcon(slot.id, '#fbf3e4'), x - iz, top - iz, 18 * iz, 18 * iz);
        if (slot.cd > 0 || slot.used || (busy && slot.state !== 1)) {
          const fraction = slot.used ? 1 : clamp(slot.cd / (ABILITY_BY_ID.get(slot.id)?.cd || 1), 0, 1);
          const hgt = Math.round(tile * fraction / iz) * iz;
          ctx.globalAlpha = 0.72;
          ctx.fillStyle = INK;
          ctx.fillRect(x, top + tile - hgt, tile, hgt);
          ctx.globalAlpha = 1;
        }
      }
    }
    const fontPx = Math.max(10, Math.round(8 * unit));
    ctx.font = `600 ${fontPx}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    for (const p of world.players) {
      if (!p.alive || (p.invis > 0 && p.pid !== view.localPid) || p.hidden > 0) continue;
      const color = COLORS[p.color % COLORS.length];
      const x = Math.round(toX(p.x));
      const y = Math.round(toY(p.y - p.r) - (p.slots.length ? 11 * unit + 16 * Math.max(1, Math.round(k / 2)) : 6 * unit));
      if (p.pid === view.localPid) {
        // Pixel arrow over your own bopl.
        const rows = [[-3, 3], [-2, 2], [-1, 1], [0, 0]];
        rows.forEach(([a, b], j) => {
          ctx.fillStyle = INK;
          ctx.fillRect(x + (a - 1) * unit, y + (j - 1) * unit, (b - a + 3) * unit, unit * 2);
        });
        rows.forEach(([a, b], j) => {
          ctx.fillStyle = color.body;
          ctx.fillRect(x + a * unit, y + (j - 1) * unit, (b - a + 1) * unit, unit);
        });
      } else if (view.showNames) {
        ctx.fillStyle = INK;
        for (const [ax, ay] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) ctx.fillText(p.name, x + ax * unit, y + ay * unit);
        ctx.fillStyle = color.body;
        ctx.fillText(p.name, x, y);
      }
    }

    if (flash > 0) {
      ctx.globalAlpha = flash * 0.5;
      ctx.fillStyle = flashColor;
      ctx.fillRect(0, 0, DW, DH);
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

  return Object.assign(api, { draw, feed, stepParticles, particleCount: () => particles.length });
}

// ---------------------------------------------------------------------------
// Title-screen bopl on its rock, drawn with the same rasterisers.
// ---------------------------------------------------------------------------

let brandS = null;
export function paintBrand(target, t, still = false, colorIndex = 0) {
  const ART_W = 44, ART_H = 44;
  if (!brandS) brandS = makeSurface(ART_W, ART_H);
  const S = brandS;
  S.u32.fill(0);
  S.x0 = 0; S.y0 = 0; S.x1 = ART_W - 1; S.y1 = ART_H - 1;
  const pal = paletteFor('grass', 'ground');
  rasterPlatform(S, { x: 0, y: 1.05, hx: 0.55, r: 0.3, ang: 0, id: 3 }, pal, ART_W / 2, ART_H / 2, 24, t);
  const jig = still ? 0 : Math.sin(t * 3.4) * 0.07;
  const h = 1 + jig, rad = 14;
  // Base on the grass: the platform top is at art row 40.
  rasterBopl(S, ART_W / 2, 40 - rad * 0.98 * h, rad, COLORS[colorIndex % COLORS.length], {
    h, w: 1 - jig * 0.7,
    aimx: Math.cos(t * 0.6), aimy: Math.sin(t * 0.9) * 0.4,
    blink: !still && Math.sin(t * 1.1) > 0.986,
  });
  S.ctx.putImageData(S.image, 0, 0);
  const c = target.getContext('2d');
  c.clearRect(0, 0, target.width, target.height);
  c.imageSmoothingEnabled = false;
  const k = Math.max(1, Math.floor(Math.min(target.width / ART_W, target.height / ART_H)));
  c.drawImage(S.canvas, Math.floor((target.width - ART_W * k) / 2), Math.floor((target.height - ART_H * k) / 2), ART_W * k, ART_H * k);
}
