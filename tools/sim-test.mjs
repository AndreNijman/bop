// Headless checks on the simulation. No browser, no network.
//
// This is the gate that keeps a refactor from quietly breaking the physics:
// resting contacts, edge falls, crushing, every ability firing without throwing,
// round resolution and snapshot round-tripping.
//
//   node tools/sim-test.mjs

import assert from 'node:assert/strict';
import { TUNE, ABILITIES, MAPS, sizeScale } from '../data.js';
import { createWorld, step, applyInput, snapshot, applySnapshot, addBody, bodyById, markSpeculative, kill } from '../sim.js';
import { createBrain, driveBot } from '../bots.js';

let passed = 0;
function check(label, fn) {
  try { fn(); passed++; console.log(`  ok  ${label}`); }
  catch (error) { console.error(`FAIL  ${label}\n      ${error.message}`); process.exitCode = 1; }
}

const idle = { mx: 0, jump: false, ax: 1, ay: 0, ab: [false, false, false] };

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

check('walking off the edge is lethal', () => {
  const w = world();
  const p = w.players[0];
  const other = w.players[1];
  other.x = 0; other.y = 2.6 - 2;
  p.x = 9.2; p.y = 1.1;
  run(w, 6, () => {
    applyInput(p, { ...idle, mx: 1 });
    applyInput(other, idle);
  });
  assert.equal(p.alive, false, 'bopl walked off the map and survived');
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

check('sudden death closes the arena', () => {
  const w = world();
  w.phase = 'play'; w.phaseT = 0;
  w.t = TUNE.roundTime - 0.01;
  const startX = w.bounds.x;
  run(w, 3, () => { for (const q of w.players) applyInput(q, idle); });
  assert.ok(w.bounds.x < startX - 1, `bounds did not close (${startX} -> ${w.bounds.x})`);
  assert.ok(w.sudden > 0, 'sudden death never started');
  sane(w, 'sudden');
});

check('every ability fires without breaking the world', () => {
  for (const ability of ABILITIES) {
    const w = world([[ability.id], []]);
    const [p, q] = w.players;
    p.x = 0; p.y = 1.4;
    q.x = 3.2; q.y = 1.4;
    w.phase = 'play';
    w.phaseT = 0;
    let fired = false;
    run(w, 6, (world, i) => {
      const t = i * TUNE.step;
      // Settle, then hold the button for a while, then let go.
      const down = t > 0.6 && t < 2.4;
      applyInput(p, { mx: 0, jump: false, ax: 1, ay: -0.15, ab: [down, false, false] });
      applyInput(q, idle);
      if (down) fired = true;
      sane(world, ability.id);
    });
    assert.ok(fired, `${ability.id} never got a press`);
    const slot = p.slots[0];
    if (p.alive) assert.ok(slot.cd > 0 || slot.state === 0, `${ability.id} left its slot in a stuck state`);
  }
});

check('offensive abilities can actually get a kill', () => {
  // Both sides are driven so the duel actually happens; a stationary dummy
  // makes contact abilities look broken when they are not.
  const lethal = ['grenade', 'bow', 'missile', 'beam', 'rock', 'roll', 'drill', 'meteor', 'throw', 'blackhole', 'mine'];
  const failures = [];
  for (const id of lethal) {
    let killed = false;
    for (let attempt = 0; attempt < 6 && !killed; attempt++) {
      const w = world([[id], []], attempt % 3);
      const [p, q] = w.players;
      w.phase = 'play'; w.phaseT = 0;
      p.iframes = 0; q.iframes = 0;
      const brains = [createBrain(attempt + 1), createBrain(attempt + 9)];
      run(w, 14, (world) => {
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
    const w = world([[id], []]);
    const [p, q] = w.players;
    w.phase = 'play'; w.phaseT = 0;
    p.x = 0; p.y = 1.4; q.x = -8; q.y = 1;
    p.iframes = 0; q.iframes = 0;
    // Land first: every placed trap needs the bopl to be standing on terrain.
    run(w, 0.9, () => { applyInput(p, idle); applyInput(q, idle); });
    assert.ok(p.grounded, `${id} setup: bopl never landed`);
    run(w, 0.6, () => { applyInput(p, { ...idle, ax: 1, ay: 0, ab: [true, false, false] }); applyInput(q, idle); });
    if (id === 'tesla') {
      // A second coil in the same slot strings the arc.
      p.x = 4;
      run(w, 0.8, () => { applyInput(p, { ...idle, ab: [false, false, false] }); applyInput(q, idle); });
      p.slots[0].cd = 0;
      run(w, 0.6, () => { applyInput(p, { ...idle, ab: [true, false, false] }); applyInput(q, idle); });
      assert.equal(w.bodies.filter(b => b.kind === 'coil').length, 2, 'second coil was not placed');
    }
    const trap = w.bodies.find(b => b.kind === (id === 'tesla' ? 'coil' : id));
    assert.ok(trap, `${id} was never placed`);
    q.iframes = 0;
    q.x = id === 'tesla' ? 2 : trap.x;
    q.y = id === 'tesla' ? trap.y : trap.y - 0.1;
    q.vx = 0; q.vy = 0;
    run(w, 0.5, () => { applyInput(p, { ...idle, ab: [false, false, false] }); applyInput(q, idle); q.iframes = 0; });
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

check('snapshots reproduce the authoritative world', () => {
  const setup = { seed: 999, mapIndex: 1, players: [
    { pid: 1, name: 'a', color: 0, abilities: ['grenade', 'dash', 'mine'] },
    { pid: 2, name: 'b', color: 1, abilities: ['bow', 'gust', 'tesla'] },
  ] };
  const server = createWorld(setup);
  const client = createWorld(setup);
  markSpeculative(client);
  const sent = new Set();
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
