// Headless balance harness.
//
// Two modes, both driven by the bots in bots.js:
//
//   duel  - every ability against every other ability, one ability each, so a
//           win rate is a clean statement about that ability alone.
//   melee - four bots with three random abilities each, which is closer to how
//           the game is actually played and catches combo blow-ups.
//
//   node tools/balance.mjs                       # duel, 6 rounds per pairing
//   node tools/balance.mjs --mode melee -n 400
//   node tools/balance.mjs --only grenade,bow
//
// A note on what this does and does not prove: the bot is the same for every
// ability, but it is not equally good at all of them. Treat the table as a way
// to find outliers, not as a ladder.

import { TUNE, ABILITIES, MAPS } from '../data.js';
import { createWorld, step, applyInput } from '../sim.js';
import { createBrain, driveBot } from '../bots.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const mode = flag('--mode', 'duel');
const rounds = Number(flag('-n', mode === 'duel' ? 6 : 600));
const only = (flag('--only', '') || '').split(',').filter(Boolean);
const maxSeconds = Number(flag('--cap', 45));
const suddenAt = Number(flag('--sudden', 25));
const quiet = args.includes('--quiet');

const pool = ABILITIES.map(a => a.id).filter(id => !only.length || only.includes(id));
const stat = new Map(pool.map(id => [id, { id, rounds: 0, wins: 0, kills: 0, deaths: 0, draws: 0, timeouts: 0 }]));
const durations = [];
const firstDeaths = [];

function playRound(seed, mapIndex, loadouts) {
  const w = createWorld({
    seed, mapIndex,
    players: loadouts.map((abilities, i) => ({ pid: i + 1, name: `B${i + 1}`, color: i, abilities, bot: true })),
  });
  const brains = new Map(w.players.map((p, i) => [p.pid, createBrain(seed + i * 17 + 1)]));
  // Bring sudden death forward so every sampled round resolves. Without this a
  // third of duels time out and the win rates stop meaning anything.
  w.t = Math.max(0, TUNE.roundTime - suddenAt);
  const limit = Math.round(maxSeconds / TUNE.step);
  const startingPids = new Set(w.players.map(player => player.pid));
  let firstDeath = null;
  let activeSteps = 0;
  let steps = 0;
  while (w.phase !== 'over' && steps < limit) {
    const shared = new Map();
    for (const player of w.players) {
      if (!player.alive) continue;
      const input = shared.get(player.pid);
      if (input) {
        applyInput(player, input);
        continue;
      }
      let brain = brains.get(player.pid);
      if (!brain) { brain = createBrain(seed + player.pid * 17 + 1); brains.set(player.pid, brain); }
      driveBot(w, player, brain, TUNE.step);
      shared.set(player.pid, { ...player.input, ab: [...player.input.ab] });
    }
    step(w, TUNE.step);
    steps++;
    if (w.phase === 'play') activeSteps++;
    if (firstDeath === null && w.phase === 'play') {
      const alivePids = new Set(w.players.filter(player => player.alive).map(player => player.pid));
      if (alivePids.size < startingPids.size) firstDeath = activeSteps * TUNE.step;
    }
  }
  return {
    winner: w.phase === 'over' ? w.winner : -1,
    timeout: w.phase !== 'over',
    seconds: activeSteps * TUNE.step,
    firstDeath: firstDeath ?? activeSteps * TUNE.step,
    players: w.players.map(p => ({ pid: p.pid, kills: p.kills, alive: p.alive })),
  };
}

function record(loadouts, result) {
  durations.push(result.seconds);
  firstDeaths.push(result.firstDeath);
  loadouts.forEach((abilities, index) => {
    const pid = index + 1;
    const player = result.players[index];
    for (const id of new Set(abilities)) {
      const s = stat.get(id);
      if (!s) continue;
      s.rounds++;
      if (result.winner === pid) s.wins++;
      if (result.winner === -1) s.draws++;
      if (result.timeout) s.timeouts++;
      s.kills += player.kills;
      if (!player.alive) s.deaths++;
    }
  });
}

const started = Date.now();
let played = 0;

if (mode === 'duel') {
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let r = 0; r < rounds; r++) {
        const seed = 1000 + i * 9173 + j * 311 + r * 7;
        // Alternate who starts on which side so spawn advantage cancels out.
        const loadouts = r % 2 ? [[pool[j]], [pool[i]]] : [[pool[i]], [pool[j]]];
        record(loadouts, playRound(seed, (i + j + r) % MAPS.length, loadouts));
        played++;
      }
    }
    if (!quiet) process.stderr.write(`\r  duelling ${pool[i]} (${i + 1}/${pool.length}) ${played} rounds  `);
  }
} else {
  const rand = (() => { let s = 20260820; return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff); })();
  for (let r = 0; r < rounds; r++) {
    const loadouts = [];
    for (let p = 0; p < 4; p++) {
      const bag = [...pool];
      const kit = [];
      for (let k = 0; k < TUNE.slots; k++) kit.push(bag.splice(Math.floor(rand() * bag.length), 1)[0]);
      loadouts.push(kit);
    }
    record(loadouts, playRound(9000 + r * 13, r % MAPS.length, loadouts));
    played++;
    if (!quiet && r % 20 === 0) process.stderr.write(`\r  melee ${r}/${rounds}  `);
  }
}

if (!quiet) process.stderr.write('\r' + ' '.repeat(60) + '\r');

const rows = [...stat.values()].filter(s => s.rounds > 0).map(s => ({
  id: s.id,
  rounds: s.rounds,
  win: s.wins / s.rounds,
  kills: s.kills / s.rounds,
  draw: s.draws / s.rounds,
  timeout: s.timeouts / s.rounds,
}));
const expected = mode === 'duel' ? 0.5 : 0.25;
rows.sort((a, b) => b.win - a.win);

const pct = v => (v * 100).toFixed(1).padStart(5);
console.log(`\n${mode} — ${played} rounds, ${rows.length} abilities, expected win rate ${(expected * 100).toFixed(0)}%`);
console.log('  ability            rounds   win%   dev    kills/round  draw%');
for (const row of rows) {
  const dev = row.win - expected;
  const bar = dev > 0.06 ? ' <<<' : dev < -0.06 ? ' >>>' : '';
  console.log(`  ${row.id.padEnd(18)} ${String(row.rounds).padStart(5)}  ${pct(row.win)}  ${(dev >= 0 ? '+' : '') + (dev * 100).toFixed(1).padStart(5)}   ${row.kills.toFixed(2).padStart(6)}      ${pct(row.draw)}${bar}`);
}
const deviations = rows.map(r => Math.abs(r.win - expected));
const spread = Math.max(...deviations);
const mean = deviations.reduce((a, b) => a + b, 0) / deviations.length;
durations.sort((a, b) => a - b);
firstDeaths.sort((a, b) => a - b);
const percentile = fraction => durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))] || 0;
const deathPercentile = fraction => firstDeaths[Math.min(firstDeaths.length - 1, Math.floor(firstDeaths.length * fraction))] || 0;
const shortRound = percentile(0.25);
const earlyFirstDeath = deathPercentile(0.25);
const medianRound = percentile(0.5);
const medianFirstDeath = deathPercentile(0.5);
console.log(`\n  worst deviation ${(spread * 100).toFixed(1)} points, mean ${(mean * 100).toFixed(1)}, ${(Date.now() - started) / 1000}s`);
console.log(`  round length p25 ${shortRound.toFixed(1)}s, median ${medianRound.toFixed(1)}s, p75 ${percentile(0.75).toFixed(1)}s`);
console.log(`  first elimination p25 ${earlyFirstDeath.toFixed(1)}s, median ${medianFirstDeath.toFixed(1)}s, p75 ${deathPercentile(0.75).toFixed(1)}s`);
console.log(`  outliers: ${rows.filter(r => Math.abs(r.win - expected) > 0.06).map(r => r.id).join(', ') || 'none'}`);

if (args.includes('--assert-pacing')) {
  if (mode !== 'melee') throw new Error('--assert-pacing requires --mode melee');
  if (shortRound < 8 || medianRound < 12 || earlyFirstDeath < 2.5 || medianFirstDeath < 3.5) {
    console.error(`bot pacing regressed: rounds ${shortRound.toFixed(1)}/${medianRound.toFixed(1)}s, first eliminations ${earlyFirstDeath.toFixed(1)}/${medianFirstDeath.toFixed(1)}s (p25/median)`);
    process.exitCode = 1;
  }
}
