// Headless checks on the simulation. No browser, no network.
//
// This is the gate that keeps a refactor from quietly breaking the physics:
// resting contacts, edge falls, crushing, every ability firing without throwing,
// round resolution and snapshot round-tripping.
//
//   node tools/sim-test.mjs

import assert from 'node:assert/strict';
import { TUNE, ABILITIES, MAPS, resolveLoadout, sizeScale } from '../data.js';
import { createWorld, step, applyInput, snapshot, applySnapshot, interpolatedPose, addBody, bodyById, markSpeculative, kill } from '../sim.js';
import { createBrain, driveBot } from '../bots.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (error) { console.error(`FAIL  ${label}\n      ${error.message}`); process.exitCode = 1; }
}

const idle = { mx: 0, my: 0, jump: false, ax: 1, ay: 0, ab: [false, false, false] };

function world(abilities = [[], []], mapIndex = 0, count = 2) {
  const players = [];
  for (let i = 0; i < count; i++) {
    players.push({ pid: i + 1, name: `P${i + 1}`, color: i, abilities: abilities[i] || [], bot: false });
  }
  return createWorld({ seed: 12345, mapIndex, players });
}

function run(w, seconds, before) {
  const steps = Math.round(seconds / TUNE.step);
  for (let i = 0; i < steps; i++) {
    if (before) before(w, i);
    step(w, TUNE.step);
  }
}

function sane(w, label) {
  for (const b of w.bodies) {
    for (const key of ['x', 'y', 'vx', 'vy', 'ang', 'av', 'r', 'hx']) {
      assert.ok(Number.isFinite(b[key]), `${label}: ${b.kind}.${key} became ${b[key]}`);
    }
    assert.ok(b.r > 0 && b.r < 40, `${label}: ${b.kind} radius ${b.r}`);
  }
}

// ---------------------------------------------------------------------------

check('every map has spawn points for a full lobby', () => {
  for (const map of MAPS) {
    assert.ok(map.spawns.length >= TUNE.maxPlayers, `${map.id} only has ${map.spawns.length} spawns`);
    assert.ok(map.platforms.length >= 4, `${map.id} is too empty`);
    for (const spawn of map.spawns) {
      assert.ok(Math.abs(spawn[0]) < map.bounds.x, `${map.id} spawn outside bounds`);
      assert.ok(Math.abs(spawn[1]) < map.bounds.y, `${map.id} spawn outside bounds`);
    }
  }
});

check('loadouts preserve duplicates and intentional empty slots', () => {
  const resolved = resolveLoadout(['dash', '', 'dash'], () => 0.5);
  assert.deepEqual(resolved, ['dash', '', 'dash']);
  assert.equal(resolveLoadout([], () => 0.5).length, TUNE.slots, 'missing slots did not default to Random');
});

check('bots wait through the countdown and opening beat before attacking', () => {
  const w = world([['dash'], []]);
  const [bot, target] = w.players;
  const brain = createBrain(32);
  bot.x = 0; bot.y = 1;
  target.x = 3; target.y = 1;
  for (let i = 0; i < 180; i++) {
    driveBot(w, bot, brain, TUNE.step);
    assert.equal(bot.input.ab.some(Boolean), false, 'bot preloaded an ability during the countdown');
  }
  w.phase = 'play'; w.phaseT = 0;
  for (let i = 0; i < Math.floor(1.7 / TUNE.step); i++) {
    driveBot(w, bot, brain, TUNE.step);
    assert.equal(bot.input.ab.some(Boolean), false, 'bot attacked in the opening grace period');
  }
});

check('bots react to remembered positions instead of tracking every frame', () => {
  const w = world([[], []]);
  const [bot, target] = w.players;
  const brain = createBrain(7);
  w.phase = 'play'; w.phaseT = 0;
  bot.x = 0; bot.y = 0;
  target.x = 4; target.y = 0;
  driveBot(w, bot, brain, TUNE.step);
  assert.ok(bot.input.ax > 0.8, 'bot did not initially observe the target to its right');
  target.x = -4;
  driveBot(w, bot, brain, TUNE.step);
  assert.ok(bot.input.ax > 0.8, 'bot reacted with frame-perfect aim');
  for (let i = 0; i < Math.ceil(0.4 / TUNE.step); i++) driveBot(w, bot, brain, TUNE.step);
  assert.ok(bot.input.ax < -0.8, 'bot never reacted to the target changing sides');
});

check('a bopl falls, lands and comes to rest on terrain', () => {
  const w = world();
  const p = w.players[0];
  p.x = 0; p.y = -1; p.vx = 0; p.vy = 0;
  run(w, 3, () => { for (const q of w.players) applyInput(q, idle); });
  sane(w, 'rest');
  assert.ok(p.alive, 'bopl died just standing there');
  assert.ok(p.grounded, 'bopl never found the ground');
  assert.ok(Math.abs(p.vy) < 1.2, `resting bopl still moving at ${p.vy.toFixed(2)}`);
  const restY = p.y;
  run(w, 2, () => { for (const q of w.players) applyInput(q, idle); });
  assert.ok(Math.abs(p.y - restY) < 0.2, 'bopl sank through the platform');
});

check('screen-relative movement hands off around sides and undersides', () => {
  const w = world([[], []], MAPS.findIndex(map => map.theme === 'space'));
  for (const body of w.bodies) if (body.kind === 'plat') body.dead = true;
  const ball = addBody(w, {
    kind: 'plat', x: 0, y: 0, hx: 0, r: 1.55, baseHx: 0, baseR: 1.55,
    ptype: 'ground', rotates: true, density: 80, gravity: 0, drag: 0,
    spring: 1, torqueSpring: 1, anchorX: 0, anchorY: 0, anchorAng: 0,
    homeX: 0, homeY: 0, fric: 0.95, rest: 0,
  });
  const [p, q] = w.players;
  p.x = 0; p.y = -ball.r - p.r - 0.04; p.vx = 0; p.vy = 0;
  w.phase = 'play'; w.phaseT = 0;
  const drive = (seconds, input) => run(w, seconds, () => {
    q.x = -8; q.y = -4; q.vx = 0; q.vy = 0; q.alive = true;
    applyInput(p, { ...idle, ...input });
    applyInput(q, idle);
  });
  drive(0.25, {});
  assert.ok(p.grounded, 'bopl did not adhere to the top of the ball');
  drive(0.4, { mx: 1 });
  assert.ok(p.x > 1.2 && p.y < 0, `D did not move right over the top (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  drive(0.5, { my: 1 });
  assert.ok(p.x > 1.5 && p.y > 0, `S did not move down the right side (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  drive(1, { mx: -1 });
  assert.ok(p.x < 0 && p.y > 1, `A did not move left across the underside (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  drive(0.8, { my: -1 });
  assert.ok(p.x < -1.5 && p.y < 0.3, `W did not move up the left side (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  assert.ok(p.grounded, 'bopl detached during a cardinal direction hand-off');
});

check('side jumps rise diagonally and underside jumps only detach', () => {
  const w = world([[], []], MAPS.findIndex(map => map.theme === 'space'));
  for (const body of w.bodies) if (body.kind === 'plat') body.dead = true;
  const ball = addBody(w, {
    kind: 'plat', x: 0, y: 0, hx: 0, r: 1.55, baseHx: 0, baseR: 1.55,
    ptype: 'ground', rotates: true, density: 80, gravity: 0, drag: 0,
    spring: 1, torqueSpring: 1, anchorX: 0, anchorY: 0, anchorAng: 0,
    homeX: 0, homeY: 0, fric: 0.95, rest: 0,
  });
  const [p, q] = w.players;
  w.phase = 'play'; w.phaseT = 0;
  const tick = input => {
    q.x = -8; q.y = -4; q.vx = 0; q.vy = 0; q.alive = true;
    applyInput(p, { ...idle, ...input });
    applyInput(q, idle);
    step(w, TUNE.step);
  };
  const place = (x, y, nx, ny) => {
    p.x = x; p.y = y; p.vx = 0; p.vy = 0;
    p.grounded = true; p.groundId = ball.id; p.groundNx = nx; p.groundNy = ny;
    p.detachT = 0; p.jumpHeld = false; p.jumpBuffer = 0; p.coyote = TUNE.coyote;
  };

  place(-ball.r - p.r - 0.01, 0, -1, 0);
  tick({});
  tick({ jump: true });
  assert.ok(!p.grounded, 'side jump did not detach');
  assert.ok(p.vx < -2, `side jump lacked outward motion (${p.vx.toFixed(2)})`);
  assert.ok(p.vy < -2, `side jump launched sideways instead of up (${p.vy.toFixed(2)})`);

  place(0, ball.r + p.r + 0.01, 0, 1);
  tick({});
  const undersideY = p.y;
  tick({ jump: true });
  assert.ok(!p.grounded, 'underside jump did not detach');
  assert.ok(Math.abs(p.vx) < 0.5 && p.vy < 0.8, `underside jump added a launch impulse (${p.vx.toFixed(2)}, ${p.vy.toFixed(2)})`);
  for (let i = 0; i < 6; i++) tick({});
  assert.ok(p.y > undersideY, 'detached underside bopl did not fall');
});

check('walking around a platform edge stays attached', () => {
  const w = world();
  const p = w.players[0];
  const other = w.players[1];
  other.x = 0; other.y = 2.6 - 2;
  p.x = 9.2; p.y = 1.1;
  run(w, 6, () => {
    const tx = -p.groundNy, ty = p.groundNx;
    const move = Math.abs(tx) >= Math.abs(ty)
      ? { mx: Math.sign(tx) || 1 }
      : { my: Math.sign(ty) || 1 };
    applyInput(p, { ...idle, ...move });
    applyInput(other, idle);
  });
  assert.equal(p.alive, true, 'sticky bopl fell off a walkable platform edge');
  assert.ok(p.grounded, 'sticky bopl lost the platform while rounding its edge');
});

check('being crushed pops a bopl', () => {
  const w = world();
  const p = w.players[0];
  const other = w.players[1];
  other.x = -9; other.y = 2;
  p.x = 0; p.y = 1.5;
  run(w, 1.2, () => { applyInput(p, idle); applyInput(other, idle); });
  assert.ok(p.alive && p.grounded, 'setup failed: bopl not standing on the big platform');
  const press = addBody(w, {
    kind: 'plat', x: p.x, y: p.y - 2.4, hx: 3, r: 0.8, baseHx: 3, baseR: 0.8,
    ptype: 'free', rotates: true, density: 40, spring: 0, torqueSpring: 0,
    gravity: 0, drag: 0, anchorX: 0, anchorY: 0, homeX: 0, homeY: 0, fric: 0.9, rest: 0,
  });
  run(w, 1.5, () => {
    applyInput(p, idle); applyInput(other, idle);
    press.vy = 3.5;
    press.av = 0;
  });
  assert.equal(p.alive, false, 'bopl survived a platform pressing it into the floor');
});

check('water kills and space has none', () => {
  const w = world([[], []], 0);
  const p = w.players[0];
  p.x = 0; p.y = w.water - 0.5; p.vy = 4;
  run(w, 0.6, () => { for (const q of w.players) applyInput(q, idle); });
  assert.equal(p.alive, false, 'bopl swam');
  const space = createWorld({ seed: 7, mapIndex: MAPS.findIndex(m => m.theme === 'space'), players: [{ pid: 1, name: 'a', color: 0, abilities: [] }] });
  assert.equal(space.water, null, 'space map has water');
  assert.ok(space.gravity < TUNE.gravity, 'space map is not low gravity');
});

check('a round resolves to the last bopl standing', () => {
  const w = world();
  w.phase = 'play'; w.phaseT = 0;
  run(w, 0.1, () => { for (const q of w.players) applyInput(q, idle); });
  kill(w, w.players[1], 'test');
  run(w, 0.1, () => { for (const q of w.players) applyInput(q, idle); });
  assert.equal(w.phase, 'over');
  assert.equal(w.winner, w.players[0].pid);
});

check('the settled round freezes physics and ability input during its outro', () => {
  const w = world([['dash'], []]);
  w.phase = 'play'; w.phaseT = 0; w.gravity = 0;
  w.bodies = w.bodies.filter(body => body.kind === 'bopl');
  const [winner, loser] = w.players;
  winner.x = -2; winner.y = -3; loser.x = 5; loser.y = -3;
  kill(w, loser, 'test');
  step(w, TUNE.step);
  assert.equal(w.phase, 'over');
  const x = winner.x;
  winner.vx = 8;
  applyInput(winner, { ...idle, ab: [true, false, false] });
  run(w, 0.4);
  assert.equal(winner.x, x, 'winner kept moving after the round settled');
  assert.equal(w.bodies.some(body => body.kind === 'bopl' && body !== winner && body.alive), false);
  assert.equal(winner.slots[0].cd, 0, 'winner cast an ability during the outro');
});

check('eliminated bopls no longer act as invisible solid obstacles', () => {
  const w = world([[], [], []], 0, 3);
  w.phase = 'play'; w.phaseT = 0; w.gravity = 0;
  w.bodies = w.bodies.filter(body => body.kind === 'bopl');
  const [gone, mover, third] = w.players;
  gone.x = 0; gone.y = -3;
  mover.x = -1.2; mover.y = -3; mover.vx = 6;
  third.x = 8; third.y = -3;
  kill(w, gone, 'test');
  run(w, 0.35, () => { applyInput(mover, idle); applyInput(third, idle); });
  assert.ok(mover.x > 0.3, `eliminated bopl blocked movement at ${mover.x.toFixed(2)}`);
});

check('elimination drops the middle ability and pickup replaces the middle slot', () => {
  const w = world([
    ['dash', 'grenade', 'bow'],
    ['rock', 'gust', 'mine'],
    [],
  ], 0, 3);
  w.phase = 'play'; w.phaseT = 0;
  const [fallen, collector, third] = w.players;
  fallen.iframes = 0;
  collector.iframes = 0;
  third.x = -8;
  kill(w, fallen, 'test');
  const drop = w.bodies.find(body => body.kind === 'ability');
  assert.ok(drop, 'eliminated bopl did not drop an ability');
  assert.equal(drop.abilityId, 'grenade', 'the dropped ability was not the middle slot');
  collector.x = drop.x;
  collector.y = drop.y;
  run(w, 0.7, () => { applyInput(collector, idle); applyInput(third, idle); });
  assert.equal(collector.slots[1].id, 'grenade', 'pickup did not replace the collector middle slot');
  assert.equal(collector.loadout[1], 'grenade', 'pickup was not persisted into the selected loadout');
});

check('black hole is once per round but Revival restores it', () => {
  const w = world([['blackhole', 'revival'], []]);
  const [p] = w.players;
  p.iframes = 0;
  w.phase = 'play'; w.phaseT = 0;
  applyInput(p, { ...idle, ab: [true, false, false] });
  step(w, TUNE.step);
  applyInput(p, idle);
  run(w, 5);
  assert.equal(w.bodies.filter(body => body.kind === 'hole').length, 0, 'first black hole did not expire');
  applyInput(p, { ...idle, ab: [true, false, false] });
  step(w, TUNE.step);
  assert.equal(w.bodies.filter(body => body.kind === 'hole').length, 0, 'black hole fired twice in one life');
  applyInput(p, { ...idle, ab: [false, true, false] });
  step(w, TUNE.step);
  applyInput(p, idle);
  p.slots[1].state = 1;
  p.slots[1].t = 4;
  kill(w, p, 'test');
  assert.equal(p.slots[0].used, false, 'Revival did not restore the one-use ability');
  assert.equal(p.slots[1].state, 0, 'Revival left an ability active');
  assert.equal(p.iframes, 0, 'Revival incorrectly granted invulnerability');
});

check('multiple Revival slots create controllable same-player clones', () => {
  const w = world([['revival', 'revival', 'dash'], [], []], 0, 3);
  const [p] = w.players;
  p.iframes = 0;
  w.phase = 'play'; w.phaseT = 0;
  addBody(w, { kind: 'orb', x: -2, y: -2, r: 0.3, owner: p.pid, slot: 0, im: 0, gravity: 0 });
  addBody(w, { kind: 'orb', x: 2, y: -2, r: 0.3, owner: p.pid, slot: 1, im: 0, gravity: 0 });
  p.slots[2].used = true;
  kill(w, p, 'test');
  const clones = w.players.filter(player => player.pid === p.pid && player.alive);
  assert.equal(clones.length, 2, 'two revive points did not produce two bopls');
  assert.ok(clones.every(player => player.slots.length === 3), 'Revival clone lost its abilities');
  assert.ok(clones.every(player => player.slots[2].used === false), 'Revival clone did not reset one-use state');
  const before = clones.map(player => ({ x: player.x, y: player.y }));
  for (const player of clones) applyInput(player, { ...idle, mx: 1 });
  run(w, 0.2);
  assert.ok(clones.every((player, index) => Math.hypot(player.x - before[index].x, player.y - before[index].y) > 0.08), 'same input did not move every clone');
});

check('Duplicator clones bopls without abilities and a clone keeps its player alive', () => {
  const w = world([['duplicator'], ['dash', 'bow'], []], 0, 3);
  w.phase = 'play'; w.phaseT = 0;
  w.bodies = w.bodies.filter(body => body.kind === 'bopl');
  const [shooter, target, third] = w.players;
  shooter.x = -5; shooter.y = -4;
  target.x = 0; target.y = -4;
  third.x = 6; third.y = -4;
  addBody(w, { kind: 'ray', mode: 'dup', x: target.x, y: target.y, r: 0.16, owner: shooter.pid, gravity: 0, ttl: 1, ox: shooter.x, oy: shooter.y });
  step(w, TUNE.step);
  const copies = w.players.filter(player => player.pid === target.pid);
  assert.equal(copies.length, 2, 'Duplicator did not clone the target bopl');
  const clone = copies.find(player => player !== target);
  assert.ok(clone.slots.every(slot => !slot.id), 'Duplicator clone incorrectly copied abilities');
  const pickup = addBody(w, { kind: 'ability', abilityId: 'mine', x: clone.x, y: clone.y, r: 0.3, pickupDelay: 0, gravity: 0 });
  step(w, TUNE.step);
  assert.equal(clone.slots[1].id, 'mine', 'ability pickup did not fill the empty clone middle slot');
  assert.equal(target.slots[1].id, 'bow', 'clone pickup changed the original bopl');
  pickup.dead = true;
  const client = world([['duplicator'], ['dash', 'bow'], []], 0, 3);
  applySnapshot(client, snapshot(w, new Set()), shooter.pid, false);
  assert.equal(client.players.filter(player => player.pid === target.pid).length, 2, 'new clone was not created from a network snapshot');
  kill(w, shooter, 'test');
  kill(w, target, 'test');
  kill(w, third, 'test');
  step(w, TUNE.step);
  assert.equal(w.winner, target.pid, 'round ended despite a same-player clone surviving');
});

check('Duplicator uses object copy counts and replaces its prior platform copy', () => {
  const objectWorld = world([['duplicator'], []]);
  objectWorld.phase = 'play'; objectWorld.phaseT = 0; objectWorld.gravity = 0;
  objectWorld.bodies = objectWorld.bodies.filter(body => body.kind === 'bopl');
  objectWorld.players[0].x = -6; objectWorld.players[1].x = 6;
  const grenade = addBody(objectWorld, { kind: 'grenade', x: 0, y: -3, r: 0.22, fuse: 20, density: 1, gravity: 0 });
  addBody(objectWorld, { kind: 'ray', mode: 'dup', x: grenade.x, y: grenade.y, r: 0.16, owner: 1, slot: 0, gravity: 0, ttl: 1, ox: -2, oy: -3 });
  step(objectWorld, TUNE.step);
  assert.equal(objectWorld.bodies.filter(body => body.kind === 'grenade').length, 4, 'Duplicator did not add three grenade copies');

  const platformWorld = world([['duplicator'], []]);
  platformWorld.phase = 'play'; platformWorld.phaseT = 0;
  const platform = platformWorld.bodies.find(body => body.kind === 'plat');
  for (let cast = 0; cast < 2; cast++) {
    addBody(platformWorld, { kind: 'ray', mode: 'dup', x: platform.x, y: platform.y, r: 0.16, owner: 1, slot: 0, gravity: 0, ttl: 1, ox: platform.x - 2, oy: platform.y });
    step(platformWorld, TUNE.step);
  }
  assert.equal(platformWorld.bodies.filter(body => body.kind === 'plat' && body.duplicatorSource === platform.id).length, 1, 'new platform duplicate did not replace the old one');

  const spike = addBody(platformWorld, {
    kind: 'spike', x: platform.x, y: platform.y - 2, r: 0.16, hx: 0.7,
    ang: -Math.PI / 2, owner: 2, slot: 0, host: platform.id,
    lx: 0, ly: -2, la: -Math.PI / 2 - platform.ang, lethal: true, im: 0, gravity: 0,
  });
  addBody(platformWorld, { kind: 'ray', mode: 'dup', x: spike.x, y: spike.y, r: 0.16, owner: 1, slot: 0, gravity: 0, ttl: 1, ox: spike.x - 2, oy: spike.y });
  step(platformWorld, TUNE.step);
  assert.equal(platformWorld.bodies.filter(body => body.kind === 'spike').length, 2, 'Duplicator did not copy a spike');
});

check('Engine observes startup and can be grown or ignite smoke', () => {
  const w = world();
  w.phase = 'play'; w.phaseT = 0; w.gravity = 0;
  w.bodies = w.bodies.filter(body => body.kind === 'bopl');
  w.players.forEach((player, index) => { player.x = index ? 9 : -9; player.y = -5; });
  const host = addBody(w, {
    kind: 'plat', x: 0, y: 0, hx: 1, r: 0.5, baseHx: 1, baseR: 0.5,
    ptype: 'free', spring: 0, density: 9, rotates: true, gravity: 0,
  });
  const engine = addBody(w, {
    kind: 'engine', x: 0, y: -0.8, r: 0.22, baseR: 0.22,
    host: host.id, lx: 0, ly: -0.8, im: 0, gravity: 0,
    startup: 0.45, ttl: 6, thrust: 29,
  });
  run(w, 0.4);
  assert.ok(Math.abs(host.vy) < 0.01, 'Engine thrust before startup completed');
  run(w, 0.2);
  assert.ok(host.vy > 0.05, 'Engine never started thrusting');
  addBody(w, { kind: 'ray', mode: 'grow', x: engine.x, y: engine.y, r: 0.16, owner: 1, gravity: 0, ttl: 1, ox: -2, oy: engine.y });
  step(w, TUNE.step);
  assert.equal(engine.size, 1, 'Growth Ray did not resize Engine');
  const smoke = addBody(w, { kind: 'smoke', x: engine.x, y: engine.y, r: 0.62, ttl: 5, lit: false, fuse: 0, gravity: 0 });
  step(w, TUNE.step);
  assert.equal(smoke.lit, true, 'Engine did not ignite touching smoke');
});

check('team rounds, Time Stop and mine targeting respect team membership', () => {
  const setup = { seed: 77, mapIndex: 0, players: [
    { pid: 1, name: 'a', color: 0, team: 0, abilities: ['timestop'] },
    { pid: 2, name: 'b', color: 1, team: 1, abilities: [] },
    { pid: 3, name: 'c', color: 0, team: 0, abilities: [] },
    { pid: 4, name: 'd', color: 1, team: 1, abilities: [] },
  ] };
  const w = createWorld(setup);
  w.phase = 'play'; w.phaseT = 0; w.gravity = 0;
  w.bodies = w.bodies.filter(body => body.kind === 'bopl');
  w.players.forEach((player, index) => { player.x = -8 + index * 5; player.y = -4; player.iframes = 0; });
  w.freeze = { owner: 1, t: 1 };
  applyInput(w.players[0], { ...idle, mx: 1 });
  applyInput(w.players[1], { ...idle, mx: 1 });
  applyInput(w.players[2], { ...idle, mx: 1 });
  const frozenX = w.players[1].x;
  const teammateX = w.players[2].x;
  run(w, 0.2);
  assert.equal(w.players[1].x, frozenX, 'opponent moved during Time Stop');
  assert.ok(w.players[2].x > teammateX, 'teammate did not move during Time Stop');
  w.freeze = null;
  const mine = addBody(w, {
    kind: 'mine', x: 0, y: -4, r: 0.24, owner: 1, density: 1.6,
    state: 1, prime: 0, hunt: 3, gravity: 0, vx: 0, vy: 0,
  });
  w.players[2].x = -1;
  w.players[1].x = 3;
  step(w, TUNE.step);
  assert.ok(mine.vx > 0, 'mine chased a nearby teammate instead of an opponent');
  kill(w, w.players[1], 'test');
  kill(w, w.players[3], 'test');
  step(w, TUNE.step);
  assert.equal(w.winner, 1, 'team round did not resolve to a surviving team member');
});

check('audited activation contracts lock, persist and cool down correctly', () => {
  const rockWorld = world([['rock'], []]);
  rockWorld.phase = 'play'; rockWorld.phaseT = 0; rockWorld.gravity = 0;
  rockWorld.bodies = rockWorld.bodies.filter(body => body.kind === 'bopl');
  const rock = rockWorld.players[0];
  applyInput(rock, { ...idle, ab: [true, false, false] });
  step(rockWorld, TUNE.step);
  assert.equal(rock.form, 'rock', 'Rock did not activate on tap');
  applyInput(rock, idle);
  step(rockWorld, TUNE.step);
  applyInput(rock, { ...idle, ab: [true, false, false] });
  step(rockWorld, TUNE.step);
  assert.equal(rock.form, 'rock', 'second tap canceled non-cancelable Rock');
  run(rockWorld, 2.3, () => applyInput(rock, idle));
  assert.equal(rock.form, 'normal', 'Rock did not end after its fixed duration');

  const bowWorld = world([['bow'], []]);
  bowWorld.phase = 'play'; bowWorld.phaseT = 0; bowWorld.gravity = 0;
  bowWorld.bodies = bowWorld.bodies.filter(body => body.kind === 'bopl');
  const bow = bowWorld.players[0];
  bow.x = -5; bow.y = -4; bow.vx = 5; bow.vy = 4;
  applyInput(bow, { ...idle, ab: [true, false, false] });
  step(bowWorld, TUNE.step);
  applyInput(bow, idle);
  step(bowWorld, TUNE.step);
  assert.ok(Math.abs(bow.vx) < 0.1 && Math.abs(bow.vy) < 0.1, 'leaving Bow did not reset velocity');

  const rollWorld = world([['roll'], []]);
  rollWorld.phase = 'play'; rollWorld.phaseT = 0;
  rollWorld.bodies = rollWorld.bodies.filter(body => body.kind === 'bopl');
  const roller = rollWorld.players[0];
  roller.x = -5; roller.y = -3; roller.grounded = false; roller.coyote = 0;
  applyInput(roller, { ...idle, ab: [true, false, false] });
  step(rollWorld, TUNE.step);
  applyInput(roller, { ...idle, jump: true, ab: [true, false, false] });
  step(rollWorld, TUNE.step);
  assert.equal(roller.slots[0].state, 0, 'jump did not cancel Roll charge');
  assert.ok(roller.vy < -5, 'airborne Roll cancel did not jump');

  const lockedWorld = world([['grenade', 'dash'], []]);
  lockedWorld.phase = 'play'; lockedWorld.phaseT = 0; lockedWorld.gravity = 0;
  lockedWorld.bodies = lockedWorld.bodies.filter(body => body.kind === 'bopl');
  const locked = lockedWorld.players[0];
  applyInput(locked, { ...idle, ab: [true, true, false] });
  step(lockedWorld, TUNE.step);
  assert.equal(locked.slots[0].state, 1, 'held Grenade did not start');
  assert.equal(locked.slots[1].cd, 0, 'Dash bypassed the shared ability action lock');

  const teleportWorld = world([['teleport'], []]);
  teleportWorld.phase = 'play'; teleportWorld.phaseT = 0; teleportWorld.gravity = 0;
  teleportWorld.bodies = teleportWorld.bodies.filter(body => body.kind === 'bopl');
  const teleporter = teleportWorld.players[0];
  teleportWorld.players[1].x = 10; teleportWorld.players[1].y = -5;
  teleporter.x = 0; teleporter.y = -3;
  applyInput(teleporter, { ...idle, ab: [true, false, false] });
  step(teleportWorld, TUNE.step);
  assert.ok(teleporter.slots[0].cd > 2.9, 'Teleport placement did not start its cooldown');
  const bubble = teleportWorld.bodies.find(body => body.kind === 'bubble');
  const atBubble = addBody(teleportWorld, { kind: 'boulder', x: 0.2, y: -3, r: 0.2, ttl: 20, gravity: 0 });
  teleporter.x = 4; teleporter.y = -3; teleporter.vx = 0; teleporter.vy = 0;
  const atPlayer = addBody(teleportWorld, { kind: 'boulder', x: 4.2, y: -3, r: 0.2, ttl: 20, gravity: 0 });
  applyInput(teleporter, idle);
  run(teleportWorld, 3.1);
  teleporter.vx = 7; teleporter.vy = -2;
  applyInput(teleporter, { ...idle, ab: [true, false, false] });
  step(teleportWorld, TUNE.step);
  assert.equal(teleporter.slots[0].cd, 0, 'Teleport swap incorrectly added a second cooldown');
  assert.equal(teleportWorld.bodies.some(body => body.kind === 'bubble'), false, 'Teleport swap left its bubble behind');
  assert.ok(Math.abs(teleporter.x - bubble.x) < 0.2, 'Teleport did not move the caster to its bubble');
  assert.ok(atPlayer.x < 1, 'object beside caster did not move to the bubble');
  assert.ok(atBubble.x > 3, 'object inside bubble did not move to the caster origin');
  assert.equal(teleporter.vx, 0, 'Teleport preserved player momentum');
});

check('Blink temporarily removes objects and disables hidden players', () => {
  const w = world([['blink'], ['dash']]);
  w.phase = 'play'; w.phaseT = 0; w.gravity = 0;
  w.bodies = w.bodies.filter(body => body.kind === 'bopl');
  const [shooter, target] = w.players;
  shooter.x = -6; shooter.y = -4;
  target.x = 6; target.y = -4;
  const object = addBody(w, { kind: 'boulder', x: 0, y: -4, vx: 5, r: 0.3, ttl: 20, gravity: 0 });
  addBody(w, { kind: 'ray', mode: 'blink', x: object.x, y: object.y, r: 0.16, owner: shooter.pid, slot: 0, caster: shooter.id, gravity: 0, ttl: 1, ox: shooter.x, oy: shooter.y });
  step(w, TUNE.step);
  assert.ok(object.hidden > 3.9, 'Blink did not hide the object');
  const hiddenX = object.x;
  run(w, 1);
  assert.equal(object.x, hiddenX, 'hidden object kept simulating');
  run(w, 3.1);
  assert.equal(object.hidden, 0, 'Blinked object never returned');

  target.hidden = 1;
  target.iframes = 0;
  applyInput(target, { ...idle, ab: [true, false, false] });
  step(w, TUNE.step);
  assert.equal(target.slots[0].cd, 0, 'hidden player activated an ability');
});

check('Beam has startup, grapple pulls and survives release, and only growth reverts platforms', () => {
  const beamWorld = world([['beam'], []]);
  beamWorld.phase = 'play'; beamWorld.phaseT = 0; beamWorld.gravity = 0;
  beamWorld.bodies = beamWorld.bodies.filter(body => body.kind === 'bopl');
  const [beamer, target] = beamWorld.players;
  beamer.x = 0; beamer.y = -3; target.x = 3; target.y = -3;
  beamer.iframes = 0; target.iframes = 0;
  run(beamWorld, 0.8, () => applyInput(beamer, { ...idle, ax: 1, ay: 0, ab: [true, false, false] }));
  assert.equal(target.alive, true, 'Beam killed during startup');
  run(beamWorld, 0.6, () => applyInput(beamer, { ...idle, ax: 1, ay: 0, ab: [true, false, false] }));
  assert.equal(target.alive, false, 'Beam never became active after startup');

  const grappleWorld = world([['grapple'], []]);
  grappleWorld.phase = 'play'; grappleWorld.phaseT = 0; grappleWorld.gravity = 0;
  const grappler = grappleWorld.players[0];
  const host = grappleWorld.bodies.find(body => body.kind === 'plat');
  for (const body of grappleWorld.bodies) if (body.kind === 'plat' && body !== host) body.dead = true;
  host.x = 0; host.y = -3; host.vx = 0; host.vy = 0; host.im = 0;
  grappler.x = -5; grappler.y = -3; grappler.vx = 0; grappler.vy = 0; grappler.grounded = false;
  grappler.grappleId = host.id;
  grappler.grappleLx = 0; grappler.grappleLy = 0; grappler.grappleLen = 3;
  grappler.slots[0].state = 1;
  applyInput(grappler, idle);
  step(grappleWorld, TUNE.step);
  assert.ok(grappler.vx > 0, `Grappling Hook pushed away from its anchor (${grappler.vx.toFixed(2)})`);
  assert.equal(grappler.grappleId, host.id, 'releasing Grappling Hook detached the rope');
  const ropeLength = grappler.grappleLen;
  applyInput(grappler, { ...idle, ab: [true, false, false] });
  step(grappleWorld, TUNE.step);
  assert.ok(grappler.grappleLen < ropeLength, 'holding Grappling Hook did not reel the rope in');
  applyInput(grappler, { ...idle, jump: true });
  step(grappleWorld, TUNE.step);
  assert.equal(grappler.grappleId, -1, 'jump did not release Grappling Hook');
  assert.ok(grappler.slots[0].cd > 2.9, 'grapple cooldown did not start on release');

  for (const mode of ['grow', 'shrink']) {
    const rayWorld = world([[], []]);
    rayWorld.phase = 'play'; rayWorld.phaseT = 0;
    const platform = rayWorld.bodies.find(body => body.kind === 'plat');
    addBody(rayWorld, {
      kind: 'ray', mode, x: platform.x, y: platform.y, r: 0.16,
      owner: 1, gravity: 0, ttl: 1, ox: platform.x - 2, oy: platform.y,
    });
    step(rayWorld, TUNE.step);
    assert.equal(platform.size, mode === 'grow' ? 1 : -1, `${mode} ray did not resize platform`);
    run(rayWorld, 10.2);
    assert.equal(platform.size, mode === 'grow' ? 0 : -1, `${mode} platform used the wrong reversion rule`);
  }
});

check('growth and shrink change mass and enable eating', () => {
  const w = world();
  w.phase = 'play'; w.phaseT = 0;
  const [a, b] = w.players;
  a.iframes = 0; b.iframes = 0;
  const base = a.r;
  a.size = 3;
  b.size = 0;
  a.r = TUNE.boplRadius * sizeScale(3);
  assert.ok(a.r > base * 1.4, 'growth did not change the radius');
  a.x = 0; a.y = 1.2; b.x = 0.4; b.y = 1.2;
  run(w, 1.0, () => { applyInput(a, idle); applyInput(b, idle); a.iframes = 0; b.iframes = 0; });
  assert.equal(b.alive, false, 'a much bigger bopl did not eat a much smaller one');
  assert.ok(a.eaten === 1, 'meal was not recorded');
});

check('sudden death drives platforms in strengthening waves', () => {
  const w = world();
  w.phase = 'play'; w.phaseT = 0; w.gravity = 0;
  w.t = TUNE.roundTime - 0.01;
  const startX = w.bounds.x;
  const platform = w.bodies.find(body => body.kind === 'plat');
  const startY = platform.y;
  const startWidth = platform.hx;
  w.players.forEach((player, index) => { player.x = index ? 10 : -10; player.y = -5; });
  run(w, 3, () => { for (const q of w.players) applyInput(q, idle); });
  assert.equal(w.bounds.x, startX, 'sudden death incorrectly closed the death barrier');
  assert.equal(platform.hx, startWidth, 'sudden death incorrectly shrank terrain');
  assert.ok(platform.y > startY + 0.3, `platform was not pulled downward (${startY} -> ${platform.y})`);
  assert.ok(w.sudden > 0, 'sudden death never started');
  sane(w, 'sudden');
});

check('a collectible ability spawns on terrain every 40 seconds', () => {
  const w = world();
  w.phase = 'play'; w.phaseT = 0; w.t = 39.99;
  w.players.forEach((player, index) => { player.x = index ? 10 : -10; player.y = -5; });
  step(w, TUNE.step);
  const pickup = w.bodies.find(body => body.kind === 'ability');
  assert.ok(pickup, '40-second ability pickup did not spawn');
  assert.ok(ABILITIES.some(ability => ability.id === pickup.abilityId), 'pickup selected an unknown ability');
  assert.equal(w.nextAbilitySpawn, 80, 'next pickup was not scheduled 40 seconds later');
});

check('every ability fires without breaking the world', () => {
  for (const ability of ABILITIES) {
    const w = world([[ability.id], [], []], 0, 3);
    const [p, q, third] = w.players;
    p.x = 0; p.y = 1.4;
    q.x = 3.2; q.y = 1.4;
    third.x = -8; third.y = 1.4;
    w.phase = 'play';
    w.phaseT = 0;
    let fired = false;
    run(w, 6, (world, i) => {
      const t = i * TUNE.step;
      // Settle, then hold the button for a while, then let go.
      const down = t > 0.6 && t < 2.4;
      applyInput(p, { mx: 0, jump: false, ax: 1, ay: -0.15, ab: [down, false, false] });
      applyInput(q, idle);
      applyInput(third, idle);
      if (down) fired = true;
      sane(world, ability.id);
    });
    assert.ok(fired, `${ability.id} never got a press`);
    const slot = p.slots[0];
    if (p.alive) {
      const activeGrapple = ability.id === 'grapple' && p.grappleId !== -1;
      assert.ok(slot.cd > 0 || slot.state === 0 || activeGrapple, `${ability.id} left its slot in a stuck state`);
    }
  }
});

check('offensive abilities can actually get a kill', () => {
  // Both sides are driven so the duel actually happens; a stationary dummy
  // makes contact abilities look broken when they are not.
  const lethal = ['grenade', 'bow', 'missile', 'beam', 'rock', 'roll', 'drill', 'meteor', 'throw', 'blackhole', 'mine'];
  const failures = [];
  for (const id of lethal) {
    let killed = false;
    for (let attempt = 0; attempt < 10 && !killed; attempt++) {
      const w = world([[id], []], attempt % 3);
      const [p, q] = w.players;
      w.phase = 'play'; w.phaseT = 0;
      p.iframes = 0; q.iframes = 0;
      const brains = [createBrain(attempt + 1), createBrain(attempt + 9)];
      run(w, 18, (world) => {
        driveBot(world, p, brains[0], TUNE.step);
        driveBot(world, q, brains[1], TUNE.step);
        if (!q.alive) killed = true;
      });
    }
    if (!killed) failures.push(id);
  }
  assert.equal(failures.length, 0, `these abilities never landed a kill: ${failures.join(', ')}`);
});

check('placed traps are lethal on contact', () => {
  for (const id of ['spike', 'tesla', 'mine']) {
    const w = world([[id], [], []], 0, 3);
    const [p, q, third] = w.players;
    w.phase = 'play'; w.phaseT = 0;
    p.x = 0; p.y = 1.4; q.x = -8; q.y = 1; third.x = 8; third.y = 1;
    p.iframes = 0; q.iframes = 0; third.iframes = 0;
    // Land first: every placed trap needs the bopl to be standing on terrain.
    run(w, 0.9, () => { applyInput(p, idle); applyInput(q, idle); applyInput(third, idle); });
    assert.ok(p.grounded, `${id} setup: bopl never landed`);
    run(w, id === 'mine' ? 0.05 : 0.6, () => { applyInput(p, { ...idle, ax: 1, ay: 0, ab: [true, false, false] }); applyInput(q, idle); applyInput(third, idle); });
    if (id === 'mine') {
      p.x = 8;
      run(w, 0.3, () => { applyInput(p, idle); applyInput(q, idle); applyInput(third, idle); });
    }
    if (id === 'tesla') {
      // A second coil in the same slot strings the arc.
      p.x = 4;
      run(w, 0.8, () => { applyInput(p, { ...idle, ab: [false, false, false] }); applyInput(q, idle); applyInput(third, idle); });
      p.slots[0].cd = 0;
      run(w, 0.6, () => { applyInput(p, { ...idle, ab: [true, false, false] }); applyInput(q, idle); applyInput(third, idle); });
      assert.equal(w.bodies.filter(b => b.kind === 'coil').length, 2, 'second coil was not placed');
    }
    const trap = w.bodies.find(b => b.kind === (id === 'tesla' ? 'coil' : id));
    assert.ok(trap, `${id} was never placed`);
    q.iframes = 0;
    q.x = id === 'tesla' ? 2 : trap.x;
    q.y = id === 'tesla' ? trap.y : trap.y - 0.1;
    q.vx = 0; q.vy = 0;
    run(w, 0.5, () => { applyInput(p, { ...idle, ab: [false, false, false] }); applyInput(q, idle); applyInput(third, idle); q.iframes = 0; });
    assert.equal(q.alive, false, `walking into a ${id} was survivable`);
  }
});

check('bots survive a full match on every map without NaN', () => {
  for (let mapIndex = 0; mapIndex < MAPS.length; mapIndex++) {
    const kit = [
      ['grenade', 'dash', 'grapple'],
      ['bow', 'platform', 'gust'],
      ['rock', 'invis', 'blackhole'],
      ['beam', 'push', 'teleport'],
    ];
    const w = world(kit, mapIndex, 4);
    const brains = w.players.map((p, i) => createBrain(i + 1));
    run(w, 30, (world) => {
      world.players.forEach((p, i) => driveBot(world, p, brains[i], TUNE.step));
      sane(world, MAPS[mapIndex].id);
    });
    assert.ok(w.tick > 0);
  }
});

check('snapshot poses interpolate remote motion and preserve teleports', () => {
  const setup = { seed: 998, mapIndex: 0, players: [
    { pid: 1, name: 'local', color: 0, abilities: [] },
    { pid: 2, name: 'remote', color: 1, abilities: [] },
  ] };
  const server = createWorld(setup);
  const client = createWorld(setup);
  const sent = new Set();
  server.t = 1;
  server.players[1].vx = 10;
  applySnapshot(client, snapshot(server, sent), 1, false);
  const start = server.players[1].x;
  server.players[1].x += 1;
  server.players[1].vx = 10;
  server.t = 1.1;
  applySnapshot(client, snapshot(server, sent), 1, true);
  const remote = client.players.find(player => player.pid === 2);
  const halfway = interpolatedPose(remote, 1.05);
  assert.ok(Math.abs(halfway.x - (start + 0.5)) < 0.01, `remote midpoint was ${halfway.x}`);

  server.players[1].x += 4;
  server.t = 1.2;
  applySnapshot(client, snapshot(server, sent), 1, true);
  const beforeTeleport = interpolatedPose(remote, 1.15);
  assert.ok(Math.abs(beforeTeleport.x - (start + 1)) < 0.01, 'teleport was rendered as a sweep across the arena');
});

check('snapshots reproduce the authoritative world', () => {
  const setup = { seed: 999, mapIndex: 1, players: [
    { pid: 1, name: 'a', color: 0, abilities: ['grenade', 'dash', 'mine'] },
    { pid: 2, name: 'b', color: 1, abilities: ['bow', 'gust', 'tesla'] },
  ] };
  const server = createWorld(setup);
  const client = createWorld(setup);
  markSpeculative(client);
  const sent = new Set();
  const firstPacket = snapshot(server, sent);
  assert.equal(firstPacket.type, 'snap', 'snapshot packet has no protocol discriminator');
  assert.equal(typeof firstPacket.t, 'number', 'snapshot simulation time is not numeric');
  sent.clear();
  const brains = server.players.map((p, i) => createBrain(i + 5));
  for (let i = 0; i < 600; i++) {
    server.players.forEach((p, index) => driveBot(server, p, brains[index], TUNE.step));
    step(server, TUNE.step);
    if (i % 4 === 0) {
      applySnapshot(client, JSON.parse(JSON.stringify(snapshot(server, sent))), 1, false);
    } else {
      step(client, TUNE.step);
    }
  }
  assert.equal(client.players.length, server.players.length);
  for (let i = 0; i < server.players.length; i++) {
    const a = server.players[i], b = client.players[i];
    assert.equal(b.alive, a.alive, 'alive flag diverged');
    if (a.alive) {
      const drift = Math.hypot(a.x - b.x, a.y - b.y);
      assert.ok(drift < 1.0, `player ${i} drifted ${drift.toFixed(2)} units`);
    }
  }
  const serverObjects = server.bodies.filter(b => b.kind !== 'bopl' && b.kind !== 'plat').length;
  const clientObjects = client.bodies.filter(b => b.kind !== 'bopl' && b.kind !== 'plat').length;
  assert.ok(Math.abs(serverObjects - clientObjects) <= 1, `object count diverged: ${serverObjects} vs ${clientObjects}`);
  sane(client, 'client');
});

check('a full match runs to five round wins', () => {
  let wins = [0, 0];
  let rounds = 0;
  let seed = 4242;
  while (Math.max(...wins) < TUNE.winsToTake && rounds < 40) {
    const w = createWorld({
      seed: seed++, mapIndex: rounds % MAPS.length,
      players: [
        { pid: 1, name: 'a', color: 0, abilities: ['grenade', 'dash', 'grapple'] },
        { pid: 2, name: 'b', color: 1, abilities: ['bow', 'dash', 'platform'] },
      ],
    });
    const brains = w.players.map((p, i) => createBrain(seed + i));
    let guard = 0;
    while (w.phase !== 'over' && guard < 60 / TUNE.step) {
      w.players.forEach((p, i) => driveBot(w, p, brains[i], TUNE.step));
      step(w, TUNE.step);
      guard++;
    }
    if (w.winner === 1) wins[0]++;
    else if (w.winner === 2) wins[1]++;
    rounds++;
  }
  assert.ok(Math.max(...wins) >= TUNE.winsToTake, `no one reached ${TUNE.winsToTake} wins in ${rounds} rounds (${wins})`);
});

console.log(`\n${passed} checks passed`);
if (process.exitCode) console.error('sim-test failed');
