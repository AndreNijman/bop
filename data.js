// Shared tuning, ability catalogue and arena definitions for BOP.
//
// This module is imported by the browser client, by the Cloudflare relay and by
// the headless balance tools. Everything that both sides of the wire have to
// agree on lives here so the numbers can never drift apart. Nothing in this
// file touches the DOM, the network or Math.random.

export const VERSION = '1.0.0';

// One world unit is one bopl diameter. The arena is authored in world units and
// scaled to whatever canvas we are handed, so a phone and a desktop see exactly
// the same fight.
export const TUNE = {
  step: 1 / 60,                 // fixed simulation step, never varies
  snapshotHz: 15,               // authoritative state broadcasts per second
  inputHz: 30,                  // client input packets per second
  gravity: 21,
  spaceGravity: 9,
  drag: 0.02,
  boplRadius: 0.42,
  boplDensity: 1.35,
  runSpeed: 6.1,
  runAccel: 62,
  airAccel: 36,
  stickSpeed: 1.8,
  stickSnap: 0.18,
  groundFriction: 12,
  iceFriction: 1.1,
  jumpSpeed: 9.2,
  spaceJumpSpeed: 6.6,
  coyote: 0.12,
  jumpBuffer: 0.11,
  maxSpeed: 46,
  squishRatio: 0.62,            // fraction of a bopl's radius of two-sided crush that kills
  squishGrace: 0.16,            // seconds of sustained crush before the pop
  eatSizeGap: 2,                // size levels of advantage needed to eat someone
  eatGrowth: 0.5,               // size levels gained per meal
  sizeStep: 1.17,               // radius multiplier per growth/shrink hit
  sizeMin: -5,
  sizeMax: 8,
  roundTime: 120,               // seconds before sudden death starts
  suddenWave: 4,                // down, slight rebound, then a short rest
  roundIntro: 1.6,              // frozen countdown at the start of a round
  roundOutro: 2.2,              // celebration before the next draft
  draftTime: 22,
  winsToTake: 5,
  maxPlayers: 4,
  slots: 3,
  respawnLock: 0,               // revival is vulnerable as soon as it starts
  contactIterations: 8,
  restitution: 0.16,
  platformRestitution: 0.05,
};

export const COLORS = [
  { id: 'coral', body: '#ff6b5e', dark: '#c93f36', name: 'Coral' },
  { id: 'sky', body: '#4fb8ff', dark: '#2077b8', name: 'Sky' },
  { id: 'lime', body: '#8fdc4a', dark: '#529c22', name: 'Lime' },
  { id: 'plum', body: '#c07bf0', dark: '#8241b4', name: 'Plum' },
  { id: 'sun', body: '#ffce3d', dark: '#c99000', name: 'Sun' },
  { id: 'mint', body: '#4fe0bb', dark: '#1f9d80', name: 'Mint' },
  { id: 'rose', body: '#ff8fc4', dark: '#c94f89', name: 'Rose' },
  { id: 'slate', body: '#9aa6c4', dark: '#5c688a', name: 'Slate' },
];

export const BOT_NAMES = [
  'Blip', 'Wobble', 'Gronk', 'Pip', 'Squelch', 'Noodle', 'Tumble', 'Bonk',
  'Jelly', 'Marble', 'Splat', 'Doink', 'Wiggle', 'Custard', 'Pebble', 'Bloop',
];

// ---------------------------------------------------------------------------
// Abilities
// ---------------------------------------------------------------------------
// `kind` drives the input contract:
//   tap   - fires the moment the button goes down
//   hold  - charges while held, fires on release
//   toggle- press to enter a form, press again (or run out of fuel) to leave
//   channel-active for as long as the button is held down
//
// `weight` is retained for the simulation harness. Random selects uniformly.
export const ABILITIES = [
  {
    id: 'grenade', name: 'Grenade', kind: 'hold', family: 'offensive', tag: 'explosive',
    cd: 2, charge: 1.1, fuse: 3.5, blast: 2.45, impulse: 17.5, throw: [9, 19], weight: 1,
    blurb: 'Lob a fused bomb. It cooks from the moment you press, so short-fuse throws are the scary ones.',
  },
  {
    id: 'missile', name: 'Missile', kind: 'hold', family: 'offensive', tag: 'explosive',
    cd: 4.5, charge: 2.2, blast: 2.45, impulse: 18, cruise: 6.8, boost: 21, turn: 4.8, weight: 1,
    blurb: 'A rocket you steer by aiming. Let go to send it screaming off at full speed.',
  },
  {
    id: 'rock', name: 'Rock', kind: 'tap', family: 'offensive', tag: 'morph',
    cd: 2, duration: 2.2, massScale: 0.3, weight: 1,
    blurb: 'Become a nearly weightless boulder. Lethal on contact, immune to almost everything, no steering at all.',
  },
  {
    id: 'bow', name: 'Bow', kind: 'hold', family: 'offensive', tag: 'morph',
    cd: 2.5, charge: 1.15, speed: [11, 28], weight: 1,
    blurb: 'Morph into a bow and charge an arrow. Anything the arrow touches pops.',
  },
  {
    id: 'beam', name: 'Beam', kind: 'channel', family: 'offensive', tag: 'fire',
    cd: 5.7, fuel: 6.1, startup: 1.2, active: 4.9, range: 7.0, push: 12, weight: 1,
    blurb: 'A sweeping laser that incinerates bopls, shoves objects and sets off anything explosive.',
  },
  {
    id: 'grapple', name: 'Grappling Hook', kind: 'grapple', family: 'mobility', tag: 'rope',
    cd: 3, speed: 32, range: 11.5, reel: 10, weight: 1,
    blurb: 'Hook onto anything at all, then hold to reel yourself in. Jump to let go.',
  },
  {
    id: 'dash', name: 'Dash', kind: 'tap', family: 'mobility', tag: 'mobility',
    cd: 4, speed: 15.5, iframes: 0.22, weight: 1,
    blurb: 'A snappy launch toward the cursor with a sliver of invulnerability on startup.',
  },
  {
    id: 'drill', name: 'Drill', kind: 'channel', family: 'offensive', tag: 'morph',
    cd: 4, fuel: 10, unlimited: true, accel: 14, top: 12.5, turn: 4.2, weight: 1,
    blurb: 'Bore straight through the terrain. The bit kills, the tail end very much does not.',
  },
  {
    id: 'blink', name: 'Blink Gun', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 2.5, hitCd: 5, charge: 0.35, speed: 26, objectTime: 4, boplTime: 1.3, weight: 1,
    blurb: 'Erase whatever you shoot for a moment. Platforms vanish, bopls blip somewhere else nearby.',
  },
  {
    id: 'duplicator', name: 'Duplicator', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 4, charge: 0.4, speed: 24, weight: 1,
    blurb: 'Copy anything you hit. The twin appears on the far side of the target.',
  },
  {
    id: 'engine', name: 'Engine', kind: 'tap', family: 'utility', tag: 'fire',
    cd: 3.5, startup: 0.45, duration: 6, thrust: 29, weight: 1,
    blurb: 'Bolt a thruster to the platform under you and cut it loose from its moorings.',
  },
  {
    id: 'growray', name: 'Growth Ray', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 2.5, charge: 0.3, speed: 27, revert: 10, weight: 1,
    blurb: 'Gun form. Everything the beam touches gets one size bigger, including you.',
  },
  {
    id: 'shrinkray', name: 'Shrink Ray', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 2.5, charge: 0.3, speed: 27, revert: 10, weight: 1,
    blurb: 'Gun form. Everything the beam touches gets one size smaller. Two sizes down and you are food.',
  },
  {
    id: 'gust', name: 'Gust', kind: 'tap', family: 'utility', tag: 'push',
    cd: 5, radius: 3.9, impulse: 16, weight: 1,
    blurb: 'Blow every platform, bopl and projectile near you straight away from your face.',
  },
  {
    id: 'invis', name: 'Invisibility', kind: 'tap', family: 'utility', tag: 'stealth',
    cd: 6, duration: 5, weight: 1,
    blurb: 'Fade out for a few seconds. Mines lose interest, but your footprints still show.',
  },
  {
    id: 'magnet', name: 'Magnet Gun', kind: 'channel', family: 'utility', tag: 'morph',
    cd: 5, fuel: 2.6, range: 9, pull: 24, fling: 25, weight: 1,
    blurb: 'Haul an object into your grip and hold it there, then hurl it wherever you are aiming.',
  },
  {
    id: 'meteor', name: 'Meteor', kind: 'hold', family: 'offensive', tag: 'slam',
    cd: 4, charge: 1.0, speed: 28, radius: [2.3, 4.6], impulse: 25, weight: 1,
    blurb: 'Hop, then hammer straight down. Anything underneath is paste and the landing blasts the rest away.',
  },
  {
    id: 'mine', name: 'Mine', kind: 'tap', family: 'offensive', tag: 'explosive',
    cd: 4.5, prime: 2.0, hunt: 3.4, seek: 5.2, chase: 8.5, blast: 1.95, impulse: 14, weight: 1,
    blurb: 'Drop a mine. It arms itself, then chases the nearest enemy until it runs out of patience.',
  },
  {
    id: 'platform', name: 'Platform', kind: 'channel', family: 'utility', tag: 'morph',
    cd: 6.0, fuel: 1, unlimited: true, weight: 1,
    blurb: 'Turn into a chunk of terrain you can fly around. Almost nothing can hurt you in there.',
  },
  {
    id: 'push', name: 'Push', kind: 'channel', family: 'utility', tag: 'push',
    cd: 1, fuel: 1, unlimited: true, force: 40, weight: 1,
    blurb: 'Grab the platform you are standing on and drive it with your movement keys.',
  },
  {
    id: 'revival', name: 'Revival', kind: 'tap', family: 'utility', tag: 'support',
    cd: 10, weight: 1,
    blurb: 'Plant a glowing orb. Die and you come back at it with every cooldown reset. Multiple Revival slots create clones.',
  },
  {
    id: 'roll', name: 'Roll', kind: 'hold', family: 'offensive', tag: 'mobility',
    cd: 3.5, charge: 0.8, speed: 15, duration: 2.4, weight: 1,
    blurb: 'Wind up, then rip around the surface of the terrain. You kill on contact and die just as easily.',
  },
  {
    id: 'smoke', name: 'Smoke', kind: 'hold', family: 'utility', tag: 'explosive',
    cd: 3, charge: 0.7, throw: [10, 17], puffs: 4, blast: 2.1, impulse: 13, life: 7, weight: 1,
    blurb: 'Throw a canister that bursts into clouds. Any flame sets the whole cluster off in a chain.',
  },
  {
    id: 'spike', name: 'Spike', kind: 'tap', family: 'offensive', tag: 'trap',
    cd: 3, length: 1.5, weight: 1,
    blurb: 'Grow a huge spike out of the far side of your platform. Touch it and you are done.',
  },
  {
    id: 'teleport', name: 'Teleport', kind: 'tap', family: 'utility', tag: 'warp',
    cd: 3, radius: 1.15, life: 10, weight: 1,
    blurb: 'Leave a bubble behind. Press again to swap places with everything inside it.',
  },
  {
    id: 'tesla', name: 'Tesla Coil', kind: 'tap', family: 'offensive', tag: 'trap',
    cd: 1, life: 26, weight: 1,
    blurb: 'Place a coil. Two of yours on the map string a lethal arc of electricity between them.',
  },
  {
    id: 'throw', name: 'Throw', kind: 'hold', family: 'offensive', tag: 'morph',
    cd: 1, charge: 0.8, speed: [10, 20], weight: 1,
    blurb: 'Tear a boulder out of the platform beneath you and pitch it. The platform gets smaller.',
  },
  {
    id: 'timestop', name: 'Time Stop', kind: 'hold', family: 'utility', tag: 'warp',
    cd: 3, charge: 9.0, duration: 5.0, weight: 1,
    blurb: 'Charge it up and everyone else freezes. Everything you set in motion waits for the thaw.',
  },
  {
    id: 'blackhole', name: 'Black Hole', kind: 'tap', family: 'offensive', tag: 'gravity',
    cd: 4.5, radius: 3.6, pull: 13, life: 4.2, growth: 0.02, once: true, weight: 1,
    blurb: 'Open a singularity that drags everything in and swells as it feeds. Shrink it and it spits instead.',
  },
];

export const ABILITY_BY_ID = new Map(ABILITIES.map(a => [a.id, a]));
export const ABILITY_IDS = ABILITIES.map(a => a.id);
export const RANDOM_ABILITY = {
  id: 'random', name: 'Random', family: 'random', tag: 'random', cd: 0,
  blurb: 'Rolls a different ability into this slot at the start of every round.',
};
export const SELECTABLE_ABILITIES = [RANDOM_ABILITY, ...ABILITIES];

export function resolveLoadout(loadout, rand, slots = TUNE.slots) {
  // A missing slot defaults to Random. An explicit empty string is different:
  // it is how a player deliberately takes fewer than three abilities.
  const selected = Array.from({ length: slots }, (_, index) => index < loadout.length ? loadout[index] : 'random');
  const resolved = selected.map(id => id === '' ? '' : id === 'random'
    ? ABILITY_IDS[Math.floor(rand() * ABILITY_IDS.length) % ABILITY_IDS.length]
    : (ABILITY_BY_ID.has(id) ? id : 'dash'));
  // Vanilla gives an all-Random build one extra chance to contain an offensive
  // option. It rerolls the final slot once rather than guaranteeing one.
  if (selected.every(id => id === 'random')
    && !resolved.some(id => ABILITY_BY_ID.get(id)?.family === 'offensive')) {
    resolved[resolved.length - 1] = ABILITY_IDS[Math.floor(rand() * ABILITY_IDS.length) % ABILITY_IDS.length];
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Arenas
// ---------------------------------------------------------------------------
// Platforms are capsules: a segment of half-length `hx` rotated by `ang`,
// inflated by radius `r`. A capsule with hx=0 is a ball of terrain. One
// primitive covers every shape in the game and gives us one collision routine.
//
// type:
//   ground - heavy, springs back to its anchor
//   moving - the anchor itself travels along a path
//   free   - no anchor at all, shove it wherever you like
//   ice    - ground with almost no friction
const P = (x, y, hx, r, extra = {}) => ({ x, y, hx, r, ang: 0, type: 'ground', ...extra });

// Each theme paints terrain as a body with a cap band along its top edge, which
// is what makes a slab read as ground rather than an abstract shape.
export const THEMES = {
  grass: {
    sky: '#86d9f7', deep: '#3f9fd4', water: 6.1, waterFill: '#2f86c9', waterDeep: '#1c5f97',
    land: '#7c4b2a', cap: '#5cc23f', capDeep: '#3f9a2a', edge: '#3f2413', capThickness: 0.34,
    gravity: TUNE.gravity, friction: 1,
  },
  ice: {
    sky: '#1e3055', deep: '#0c1731', water: 6.1, waterFill: '#1f5486', waterDeep: '#122f52',
    land: '#bdd6ee', cap: '#ffffff', capDeep: '#e4f1ff', edge: '#7fa3c6', capThickness: 0.3,
    gravity: TUNE.gravity, friction: 1,
  },
  space: {
    sky: '#0c0a1e', deep: '#04030d', water: null, waterFill: null, waterDeep: null,
    land: '#57546c', cap: '#7a7793', capDeep: '#4a475e', edge: '#312e44', capThickness: 0.26,
    gravity: TUNE.spaceGravity, friction: 1,
  },
};

export const MAPS = [
  {
    id: 'meadow', name: 'Meadow', theme: 'grass',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 2.6, 4.2, 0.85),
      P(-6.4, 0.4, 1.7, 0.7),
      P(6.4, 0.4, 1.7, 0.7),
      P(0, -2.1, 2.4, 0.55),
      P(-9.2, 2.9, 1.3, 0.6),
      P(9.2, 2.9, 1.3, 0.6),
    ],
    spawns: [[0, 1.1], [0.5, -3.3], [-1.6, -3.3], [3.3, 1.1], [-3.3, 1.1], [5.3, -1], [-5.3, -1], [-7.5, -1]],
  },
  {
    id: 'stepping', name: 'Stepping Stones', theme: 'grass',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-8.5, 3.2, 1.5, 0.62),
      P(-4.2, 1.3, 1.2, 0.58),
      P(0, -0.4, 1.6, 0.62),
      P(4.2, 1.3, 1.2, 0.58),
      P(8.5, 3.2, 1.5, 0.62),
      P(-2.1, -3.2, 0.9, 0.5, { type: 'moving', path: [1.9, 0], period: 5.5 }),
      P(2.1, -3.2, 0.9, 0.5, { type: 'moving', path: [-1.9, 0], period: 5.5 }),
    ],
    spawns: [[-0.9, -1.7], [0.9, -1.7], [-2.6, -4.4], [1.6, -4.4], [-4.9, 0], [3.5, 0], [-9.3, 1.9], [7.7, 1.9]],
  },
  {
    id: 'seesaw', name: 'Seesaw', theme: 'grass',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 2.4, 5.6, 0.5, { spring: 0.35, torqueSpring: 0.12 }),
      P(0, 4.2, 0.4, 0.9),
      P(-8.6, 0.6, 1.6, 0.62),
      P(8.6, 0.6, 1.6, 0.62),
      P(-4.6, -2.6, 1.1, 0.5, { type: 'moving', path: [0, 2.1], period: 6.5 }),
      P(4.6, -2.6, 1.1, 0.5, { type: 'moving', path: [0, 2.1], period: 6.5, phase: 0.5 }),
    ],
    spawns: [[0, 1.2], [2.1, 1.2], [-2.1, 1.2], [4.4, 1.2], [-4.4, 1.2], [7.7, -0.7], [-5.2, -3.8], [-9.5, -0.7]],
  },
  {
    id: 'towers', name: 'Twin Towers', theme: 'grass',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-6.5, 1.4, 0.5, 0.55, { ang: Math.PI / 2, hx: 3.4 }),
      P(6.5, 1.4, 0.5, 0.55, { ang: Math.PI / 2, hx: 3.4 }),
      P(0, -1.6, 3.0, 0.6),
      P(-6.5, -2.6, 1.5, 0.5),
      P(6.5, -2.6, 1.5, 0.5),
      P(0, 3.4, 1.2, 0.55, { type: 'moving', path: [3.6, 0], period: 7 }),
    ],
    spawns: [[-0.7, 2.2], [0.7, -2.9], [-0.7, -2.9], [5.7, -3.8], [-2, -2.9], [7.3, -3.8], [-5.7, -3.8], [-7.3, -3.8]],
  },
  {
    id: 'canopy', name: 'Canopy', theme: 'grass',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 4.4, 7.2, 0.7),
      P(-7.4, 1.2, 1.9, 0.55),
      P(7.4, 1.2, 1.9, 0.55),
      P(0, 0.4, 1.4, 0.5, { type: 'moving', path: [0, -3.2], period: 8 }),
      P(-3.6, -2.6, 1.1, 0.5),
      P(3.6, -2.6, 1.1, 0.5),
    ],
    spawns: [[0, 3], [2.7, 3], [-2.7, 3], [5.6, 3], [-5.6, 3], [6.1, 0], [-6.1, 0], [-8.7, 0]],
  },
  {
    id: 'floes', name: 'Floes', theme: 'ice',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-5.4, 2.0, 3.0, 0.7, { type: 'ice' }),
      P(5.4, 2.0, 3.0, 0.7, { type: 'ice' }),
      P(0, -0.8, 2.0, 0.6),
      P(-9.6, -1.4, 1.2, 0.55, { type: 'ice' }),
      P(9.6, -1.4, 1.2, 0.55, { type: 'ice' }),
      P(0, 4.2, 1.6, 0.5),
    ],
    spawns: [[-0.9, 3], [1.3, -2.1], [-1.3, -2.1], [3.4, 0.6], [-4.7, 0.6], [6.1, 0.6], [-7.4, 0.6], [-10.3, -2.6]],
  },
  {
    id: 'shelf', name: 'Ice Shelf', theme: 'ice',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 3.0, 8.4, 0.75, { type: 'ice' }),
      P(-7.0, -0.6, 1.6, 0.55),
      P(7.0, -0.6, 1.6, 0.55),
      P(0, -2.4, 2.6, 0.55, { type: 'ice' }),
      P(-3.4, 0.2, 0.5, 0.45),
      P(3.4, 0.2, 0.5, 0.45),
    ],
    spawns: [[0, 1.6], [3.2, 1.6], [-1.7, -3.6], [6.1, -1.8], [-3.2, 1.6], [6.6, 1.6], [-6.6, 1.6], [-7.9, -1.8]],
  },
  {
    id: 'crevasse', name: 'Crevasse', theme: 'ice',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-6.8, 1.0, 3.6, 0.8),
      P(6.8, 1.0, 3.6, 0.8),
      P(-2.4, -2.4, 0.45, 0.5, { ang: Math.PI / 2, hx: 2.2, type: 'ice' }),
      P(2.4, -2.4, 0.45, 0.5, { ang: Math.PI / 2, hx: 2.2, type: 'ice' }),
      P(0, 4.0, 1.8, 0.5),
      P(0, -0.6, 1.0, 0.45),
    ],
    spawns: [[-1.2, 2.8], [1.2, 2.8], [-4, -0.5], [4, -0.5], [-6.8, -0.5], [6.8, -0.5], [-9.6, -0.5], [9.6, -0.5]],
  },
  {
    id: 'bergs', name: 'Bergs', theme: 'ice',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-8.2, 2.2, 0, 1.5),
      P(-2.8, 0.4, 0, 1.7),
      P(2.8, 0.4, 0, 1.7),
      P(8.2, 2.2, 0, 1.5),
      P(0, -3.2, 2.2, 0.5),
      P(0, 3.6, 0, 1.0),
      P(-5.5, -1.4, 1.3, 0.45, { type: 'ice' }),
      P(5.5, -1.4, 1.3, 0.45, { type: 'ice' }),
      P(-2.8, 2.6, 1.1, 0.45),
      P(2.8, 2.6, 1.1, 0.45),
    ],
    spawns: [[0, 1.9], [0.5, -4.4], [-1.5, -4.4], [2.2, -1.75], [-2.8, -2], [2.8, -2], [-4.7, -2.5], [-6.2, -2.5]],
  },
  {
    id: 'orbit', name: 'Low Orbit', theme: 'space',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 1.6, 0, 2.4),
      P(-7.2, -1.4, 0, 1.5),
      P(7.2, -1.4, 0, 1.5),
      P(-5.0, 3.6, 2.0, 0.35, { type: 'free' }),
      P(5.0, 3.6, 2.0, 0.35, { type: 'free' }),
      P(0, -4.0, 1.6, 0.4, { type: 'moving', path: [4.4, 0], period: 9 }),
      P(-4.2, -3.4, 1.4, 0.4),
      P(4.2, -3.4, 1.4, 0.4),
      P(-10.2, 1.6, 1.2, 0.4),
      P(10.2, 1.6, 1.2, 0.4),
    ],
    spawns: [[-0.9, -5.1], [1, -1.3], [-1, -1.3], [3.4, -4.5], [-5, -4.5], [9.5, 0.5], [-7.2, -3.6], [-10.9, 0.5]],
  },
  {
    id: 'derelict', name: 'Derelict', theme: 'space',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 3.2, 5.0, 0.4, { type: 'free' }),
      P(-8.0, 0.6, 0, 1.8),
      P(8.0, 0.6, 0, 1.8),
      P(0, -1.2, 0, 1.4),
      P(-3.8, -3.6, 1.6, 0.35, { type: 'free' }),
      P(3.8, -3.6, 1.6, 0.35, { type: 'free' }),
      P(-4.6, 0.8, 1.5, 0.45),
      P(4.6, 0.8, 1.5, 0.45),
      P(0, -4.4, 2.0, 0.4),
    ],
    spawns: [[0, 2.1], [1.3, -5.5], [-1.3, -5.5], [1.9, 2.1], [-1.9, 2.1], [3.9, 2.1], [-3.9, 2.1], [-5.4, -0.3]],
  },
  {
    id: 'rings', name: 'Rings', theme: 'space',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-6.0, 0.0, 0, 2.0),
      P(6.0, 0.0, 0, 2.0),
      P(0, 2.6, 1.4, 0.45, { type: 'moving', path: [0, -3.4], period: 15 }),
      P(0, -2.6, 1.4, 0.45, { type: 'moving', path: [0, 3.4], period: 15 }),
      P(0, 0, 0, 0.9, { type: 'free' }),
      P(-9.6, 2.4, 1.4, 0.4),
      P(9.6, 2.4, 1.4, 0.4),
      P(-2.6, -1.6, 1.2, 0.4),
      P(2.6, -1.6, 1.2, 0.4),
    ],
    spawns: [[-8.8, 1.3], [1, -3.5], [-0.8, -4.5], [6, -2.7], [-3.3, -2.7], [8.8, 1.3], [-6, -2.7], [-10.4, 1.3]],
  },
  {
    id: 'moonlet', name: 'Moonlet', theme: 'space',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(0, 0.8, 0, 3.2),
      P(-8.6, -2.4, 0, 1.2),
      P(8.6, -2.4, 0, 1.2),
      P(-6.4, 3.4, 1.8, 0.35, { type: 'free' }),
      P(6.4, 3.4, 1.8, 0.35, { type: 'free' }),
      P(-5.4, -1.8, 1.5, 0.4),
      P(5.4, -1.8, 1.5, 0.4),
      P(0, -4.6, 1.8, 0.4),
      P(-2.4, -3.4, 1.1, 0.4),
      P(2.4, -3.4, 1.1, 0.4),
    ],
    spawns: [[-1.2, -5.7], [1.2, -5.7], [-3, -4.25], [3, -4.25], [-3, -4.5], [3, -4.5], [-6.2, -2.9], [4.6, -2.9]],
  },
  {
    id: 'gantry', name: 'Gantry', theme: 'grass',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-9.0, 2.6, 2.2, 0.6),
      P(9.0, 2.6, 2.2, 0.6),
      P(0, 1.0, 0.45, 0.45, { ang: Math.PI / 2, hx: 2.6 }),
      P(-4.6, -1.8, 1.8, 0.5, { type: 'moving', path: [0, 3.2], period: 7.5 }),
      P(4.6, -1.8, 1.8, 0.5, { type: 'moving', path: [0, 3.2], period: 7.5, phase: 0.5 }),
      P(0, -4.2, 2.6, 0.5),
    ],
    spawns: [[-1.7, -5.4], [0.6, -5.4], [-3.4, -3], [7.5, 1.3], [-5.8, -3], [9.5, 1.3], [-8.5, 1.3], [-10.5, 1.3]],
  },
  {
    id: 'lattice', name: 'Lattice', theme: 'ice',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-5.6, 2.6, 2.6, 0.45, { ang: 0.22, type: 'ice' }),
      P(5.6, 2.6, 2.6, 0.45, { ang: -0.22, type: 'ice' }),
      P(0, 0.2, 3.2, 0.5),
      P(-7.6, -2.2, 1.8, 0.45),
      P(7.6, -2.2, 1.8, 0.45),
      P(0, -4.0, 1.2, 0.45, { type: 'ice' }),
    ],
    spawns: [[0, -1], [2.5, -1], [-2.5, -1], [6.4, -3.3], [-6.4, -3.3], [8.8, -3.3], [-7, 1.1], [-8.8, -3.3]],
  },
];

export const MAP_BY_ID = new Map(MAPS.map(m => [m.id, m]));

export function themeOf(map) { return THEMES[map.theme]; }

export function sizeScale(level) {
  return Math.pow(TUNE.sizeStep, Math.max(TUNE.sizeMin, Math.min(TUNE.sizeMax, level)));
}

export function clamp(value, min, max) { return value < min ? min : value > max ? max : value; }

// A tiny deterministic PRNG. Every random decision inside the simulation goes
// through one of these so a seed reproduces a match exactly.
export function makeRng(seed) {
  let state = (seed | 0) || 1;
  return function next() {
    state ^= state << 13; state |= 0;
    state ^= state >>> 17;
    state ^= state << 5; state |= 0;
    return ((state >>> 0) % 1000000) / 1000000;
  };
}
