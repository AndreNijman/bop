// Shared tuning, ability catalogue and arena definitions for SQUISH.
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
  airAccel: 26,
  groundFriction: 12,
  iceFriction: 1.1,
  jumpSpeed: 8.6,
  spaceJumpSpeed: 6.6,
  coyote: 0.09,
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
  suddenShrink: 0.62,           // world units per second the death barrier closes
  suddenPlatform: 0.055,        // fraction of platform size lost per second
  roundIntro: 1.6,              // frozen countdown at the start of a round
  roundOutro: 2.2,              // celebration before the next draft
  draftTime: 22,
  winsToTake: 5,
  maxPlayers: 8,
  slots: 3,
  respawnLock: 0.7,             // revive invulnerability
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
// `weight` is the draft frequency. The balance harness tunes `power` numbers,
// never the draft weights, so every ability stays equally likely to appear.
export const ABILITIES = [
  {
    id: 'grenade', name: 'Grenade', kind: 'hold', family: 'offensive', tag: 'explosive',
    cd: 3.0, charge: 1.1, fuse: 1.85, blast: 2.3, impulse: 16.5, throw: [9, 19], weight: 1,
    blurb: 'Lob a fused bomb. It cooks from the moment you press, so short-fuse throws are the scary ones.',
  },
  {
    id: 'missile', name: 'Missile', kind: 'hold', family: 'offensive', tag: 'explosive',
    cd: 4.0, charge: 2.2, blast: 2.3, impulse: 17, cruise: 6.4, boost: 20, turn: 4.4, weight: 1,
    blurb: 'A rocket you steer by aiming. Let go to send it screaming off at full speed.',
  },
  {
    id: 'rock', name: 'Rock', kind: 'toggle', family: 'offensive', tag: 'morph',
    cd: 5.8, duration: 2.2, massScale: 0.3, weight: 1,
    blurb: 'Become a nearly weightless boulder. Lethal on contact, immune to almost everything, no steering at all.',
  },
  {
    id: 'bow', name: 'Bow', kind: 'hold', family: 'offensive', tag: 'morph',
    cd: 3.4, charge: 1.15, speed: [11, 28], weight: 1,
    blurb: 'Morph into a bow and charge an arrow. Anything the arrow touches pops.',
  },
  {
    id: 'beam', name: 'Beam', kind: 'channel', family: 'offensive', tag: 'fire',
    cd: 10.5, fuel: 0.85, range: 7.4, push: 12, weight: 1,
    blurb: 'A sweeping laser that incinerates bopls, shoves objects and sets off anything explosive.',
  },
  {
    id: 'grapple', name: 'Grappling Hook', kind: 'channel', family: 'mobility', tag: 'rope',
    cd: 1.5, fuel: 8, speed: 32, range: 11.5, reel: 10, weight: 1,
    blurb: 'Hook onto anything at all, then hold to reel yourself in. Jump to let go.',
  },
  {
    id: 'dash', name: 'Dash', kind: 'tap', family: 'mobility', tag: 'mobility',
    cd: 2.1, speed: 15.5, iframes: 0.22, weight: 1,
    blurb: 'A snappy launch toward the cursor with a sliver of invulnerability on startup.',
  },
  {
    id: 'drill', name: 'Drill', kind: 'channel', family: 'offensive', tag: 'morph',
    cd: 7.0, fuel: 1.8, accel: 14, top: 12.5, turn: 4.2, weight: 1,
    blurb: 'Bore straight through the terrain. The bit kills, the tail end very much does not.',
  },
  {
    id: 'blink', name: 'Blink Gun', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 4.6, charge: 0.35, speed: 26, objectTime: 3.6, boplTime: 1.25, weight: 1,
    blurb: 'Erase whatever you shoot for a moment. Platforms vanish, bopls blip somewhere else nearby.',
  },
  {
    id: 'duplicator', name: 'Duplicator', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 7.5, charge: 0.4, speed: 24, weight: 1,
    blurb: 'Copy anything you hit. The twin appears on the far side of the target.',
  },
  {
    id: 'engine', name: 'Engine', kind: 'tap', family: 'utility', tag: 'fire',
    cd: 2.8, duration: 6.5, thrust: 29, weight: 1,
    blurb: 'Bolt a thruster to the platform under you and cut it loose from its moorings.',
  },
  {
    id: 'growray', name: 'Growth Ray', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 3.2, charge: 0.3, speed: 27, revert: 10, weight: 1,
    blurb: 'Gun form. Everything the beam touches gets one size bigger, including you.',
  },
  {
    id: 'shrinkray', name: 'Shrink Ray', kind: 'hold', family: 'utility', tag: 'morph',
    cd: 3.2, charge: 0.3, speed: 27, revert: 10, weight: 1,
    blurb: 'Gun form. Everything the beam touches gets one size smaller. Two sizes down and you are food.',
  },
  {
    id: 'gust', name: 'Gust', kind: 'tap', family: 'utility', tag: 'push',
    cd: 3.8, radius: 3.9, impulse: 16, weight: 1,
    blurb: 'Blow every platform, bopl and projectile near you straight away from your face.',
  },
  {
    id: 'invis', name: 'Invisibility', kind: 'tap', family: 'utility', tag: 'stealth',
    cd: 9.0, duration: 4.6, weight: 1,
    blurb: 'Fade out for a few seconds. Mines lose interest, but your footprints still show.',
  },
  {
    id: 'magnet', name: 'Magnet Gun', kind: 'channel', family: 'utility', tag: 'morph',
    cd: 5.4, fuel: 2.6, range: 8, pull: 20, fling: 21, weight: 1,
    blurb: 'Haul an object into your grip and hold it there, then hurl it wherever you are aiming.',
  },
  {
    id: 'meteor', name: 'Meteor', kind: 'hold', family: 'offensive', tag: 'slam',
    cd: 4.4, charge: 1.0, speed: 28, radius: [2.3, 4.6], impulse: 25, weight: 1,
    blurb: 'Hop, then hammer straight down. Anything underneath is paste and the landing blasts the rest away.',
  },
  {
    id: 'mine', name: 'Mine', kind: 'tap', family: 'offensive', tag: 'explosive',
    cd: 4.4, prime: 1.3, hunt: 3.4, seek: 5.2, chase: 8.5, blast: 1.95, impulse: 14, weight: 1,
    blurb: 'Drop a mine. It arms itself, then chases the nearest enemy until it runs out of patience.',
  },
  {
    id: 'platform', name: 'Platform', kind: 'channel', family: 'utility', tag: 'morph',
    cd: 6.0, fuel: 4.5, weight: 1,
    blurb: 'Turn into a chunk of terrain you can fly around. Almost nothing can hurt you in there.',
  },
  {
    id: 'push', name: 'Push', kind: 'channel', family: 'utility', tag: 'push',
    cd: 2.8, fuel: 3.2, force: 40, weight: 1,
    blurb: 'Grab the platform you are standing on and drive it with your movement keys.',
  },
  {
    id: 'revival', name: 'Revival', kind: 'tap', family: 'utility', tag: 'support',
    cd: 17, arm: 2.5, weight: 1,
    blurb: 'Plant a glowing orb. Once it warms up, dying sends you back to it a size smaller with every cooldown reset.',
  },
  {
    id: 'roll', name: 'Roll', kind: 'hold', family: 'offensive', tag: 'mobility',
    cd: 4.4, charge: 0.8, speed: 15, duration: 2.4, weight: 1,
    blurb: 'Wind up, then rip around the surface of the terrain. You kill on contact and die just as easily.',
  },
  {
    id: 'smoke', name: 'Smoke', kind: 'hold', family: 'utility', tag: 'explosive',
    cd: 4.6, charge: 0.7, throw: [10, 17], puffs: 4, blast: 2.1, impulse: 13, life: 7, weight: 1,
    blurb: 'Throw a canister that bursts into clouds. Any flame sets the whole cluster off in a chain.',
  },
  {
    id: 'spike', name: 'Spike', kind: 'tap', family: 'offensive', tag: 'trap',
    cd: 4.8, length: 1.5, weight: 1,
    blurb: 'Grow a huge spike out of the far side of your platform. Touch it and you are done.',
  },
  {
    id: 'teleport', name: 'Teleport', kind: 'tap', family: 'utility', tag: 'warp',
    cd: 7.0, radius: 1.15, life: 10, weight: 1,
    blurb: 'Leave a bubble behind. Press again to swap places with everything inside it.',
  },
  {
    id: 'tesla', name: 'Tesla Coil', kind: 'tap', family: 'offensive', tag: 'trap',
    cd: 2.0, life: 26, weight: 1,
    blurb: 'Place a coil. Two of yours on the map string a lethal arc of electricity between them.',
  },
  {
    id: 'throw', name: 'Throw', kind: 'hold', family: 'offensive', tag: 'morph',
    cd: 3.6, charge: 0.65, speed: [10, 20], weight: 1,
    blurb: 'Tear a boulder out of the platform beneath you and pitch it. The platform gets smaller.',
  },
  {
    id: 'timestop', name: 'Time Stop', kind: 'hold', family: 'utility', tag: 'warp',
    cd: 11.5, charge: 1.0, duration: 5.0, weight: 1,
    blurb: 'Charge it up and everyone else freezes. Everything you set in motion waits for the thaw.',
  },
  {
    id: 'blackhole', name: 'Black Hole', kind: 'tap', family: 'offensive', tag: 'gravity',
    cd: 15, radius: 5.4, pull: 23, life: 6.5, growth: 0.04, weight: 1,
    blurb: 'Open a singularity that drags everything in and swells as it feeds. Shrink it and it spits instead.',
  },
];

export const ABILITY_BY_ID = new Map(ABILITIES.map(a => [a.id, a]));
export const ABILITY_IDS = ABILITIES.map(a => a.id);

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

export const THEMES = {
  grass: { sky: '#7fd4f5', deep: '#3aa6d8', land: '#3d2f4f', edge: '#6f5a8c', water: 5.5, gravity: TUNE.gravity, friction: 1 },
  ice: { sky: '#1d2b4a', deep: '#0d1730', land: '#dbeeff', edge: '#8fb8dd', water: 5.5, gravity: TUNE.gravity, friction: 1 },
  space: { sky: '#0b0a1c', deep: '#05040f', land: '#4a4763', edge: '#7d79a3', water: null, gravity: TUNE.spaceGravity, friction: 1 },
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
    spawns: [[-3.2, 0.6], [3.2, 0.6], [-6.4, -1.4], [6.4, -1.4], [0, -3.9], [-9.2, 1.1], [9.2, 1.1], [0, 0.6]],
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
    spawns: [[-8.5, 1.8], [8.5, 1.8], [-4.2, 0], [4.2, 0], [0, -1.8], [-2.1, -4.6], [2.1, -4.6], [0, 3]],
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
    spawns: [[-4, 1.1], [4, 1.1], [-8.6, -0.8], [8.6, -0.8], [0, 1.1], [-4.6, -4], [4.6, -4], [0, -3]],
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
    spawns: [[-6.5, -2.5], [6.5, -2.5], [0, -3], [-6.5, -4.1], [6.5, -4.1], [0, 2], [-3.2, -3], [3.2, -3]],
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
    spawns: [[-4, 3.2], [4, 3.2], [-7.4, -0.2], [7.4, -0.2], [0, -1], [-3.6, -4], [3.6, -4], [0, 3.2]],
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
    spawns: [[-5.4, 0.8], [5.4, 0.8], [0, -2.1], [-9.6, -2.6], [9.6, -2.6], [0, 3], [-2.6, 0.8], [2.6, 0.8]],
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
    spawns: [[-6, 1.8], [6, 1.8], [-7, -1.8], [7, -1.8], [0, -3.6], [0, 1.8], [-2.4, 1.8], [2.4, 1.8]],
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
    spawns: [[-6.8, -0.3], [6.8, -0.3], [-2.4, -5], [2.4, -5], [0, -1.8], [0, 3], [-9.4, -0.3], [9.4, -0.3]],
  },
  {
    id: 'bergs', name: 'Bergs', theme: 'ice',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-8.2, 2.2, 0, 1.5, { type: 'ice' }),
      P(-2.8, 0.4, 0, 1.7),
      P(2.8, 0.4, 0, 1.7),
      P(8.2, 2.2, 0, 1.5, { type: 'ice' }),
      P(0, -3.2, 2.2, 0.5),
      P(0, 3.6, 0, 1.0),
    ],
    spawns: [[-8.2, 0.3], [8.2, 0.3], [-2.8, -1.8], [2.8, -1.8], [0, -4.3], [0, 2.2], [-5.5, 1.4], [5.5, 1.4]],
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
    ],
    spawns: [[-2.6, -0.6], [2.6, -0.6], [-7.2, -3.2], [7.2, -3.2], [0, -1.2], [-5, 2.8], [5, 2.8], [0, -5]],
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
    ],
    spawns: [[-8, -1.6], [8, -1.6], [0, -2.9], [-3.8, -4.3], [3.8, -4.3], [0, 2.4], [-4, 2.4], [4, 2.4]],
  },
  {
    id: 'rings', name: 'Rings', theme: 'space',
    bounds: { x: 12.6, y: 6.6 },
    platforms: [
      P(-6.0, 0.0, 0, 2.0),
      P(6.0, 0.0, 0, 2.0),
      P(0, 3.4, 1.4, 0.45, { type: 'moving', path: [0, -6.4], period: 10 }),
      P(0, -3.4, 1.4, 0.45, { type: 'moving', path: [0, 6.4], period: 10 }),
      P(0, 0, 0, 0.9, { type: 'free' }),
    ],
    spawns: [[-6, -2.4], [6, -2.4], [-8.4, -0.2], [8.4, -0.2], [0, 2.4], [0, -4.4], [-6, 2.2], [6, 2.2]],
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
    ],
    spawns: [[-3.4, -1.4], [3.4, -1.4], [0, -2.8], [-8.6, -3.9], [8.6, -3.9], [-6.4, 2.6], [6.4, 2.6], [0, 4.4]],
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
    spawns: [[-9, 1.4], [9, 1.4], [-4.6, -3], [4.6, -3], [0, -5.4], [0, -2], [-6.8, 1.4], [6.8, 1.4]],
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
      P(0, -4.0, 1.2, 0.45, { type: 'free' }),
    ],
    spawns: [[-5.6, 1.4], [5.6, 1.4], [-2.4, -0.9], [2.4, -0.9], [-7.6, -3.4], [7.6, -3.4], [0, -5.2], [0, -0.9]],
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
