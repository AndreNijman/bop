import assert from 'node:assert/strict';
import test from 'node:test';
import { TUNE } from '../data.js';
import { GameRoom } from '../worker.js';

const encoder = new TextEncoder();

function makeRoom() {
  const ctx = { waitUntil() {} };
  const registry = { fetch: async () => new Response(null, { status: 204 }) };
  const env = { REGISTRY: { getByName: () => registry } };
  return new GameRoom(ctx, env);
}

function player(pid, team, wins = 0) {
  return {
    pid,
    name: `Player ${pid}`,
    color: team,
    team,
    bot: false,
    wins,
    abilities: Array(TUNE.slots).fill('random'),
    joinedRound: 0,
  };
}

function socket() {
  return {
    readyState: 1,
    sent: [],
    send(message) { this.sent.push(JSON.parse(message)); },
    close() { this.readyState = 3; },
  };
}

async function passwordHash(value, digest = crypto.subtle.digest.bind(crypto.subtle)) {
  const bytes = await digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

test('password joins revalidate room state after hashing', async t => {
  const cases = [
    {
      name: 'room existence',
      mutate(room) { room.roster.clear(); room.key = ''; },
      error: 'no lobby has that name',
    },
    {
      name: 'phase',
      mutate(room) { room.phase = 'draft'; },
      error: 'that match has already started',
    },
    {
      name: 'capacity',
      mutate(room) { room.roster.set(2, player(2, 1)); },
      error: 'that lobby is full',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const room = makeRoom();
      room.room = 'Locked room';
      room.key = 'locked room';
      room.roster.set(1, player(1, 0));
      room.host = 1;
      room.nextPid = 2;
      room.settings.max = 2;
      room.password = await passwordHash('secret');

      const originalDigest = crypto.subtle.digest;
      const digest = originalDigest.bind(crypto.subtle);
      let hashing;
      let resume;
      const hashingStarted = new Promise(resolve => { hashing = resolve; });
      const hashingResumed = new Promise(resolve => { resume = resolve; });
      crypto.subtle.digest = async (...args) => {
        hashing();
        await hashingResumed;
        return digest(...args);
      };

      const clientSocket = socket();
      const session = { socket: clientSocket, pid: -1, ready: false };
      try {
        const joining = room.handshake(session, {
          t: 'join', room: 'Locked room', name: 'Guest', password: 'secret',
        });
        await hashingStarted;
        scenario.mutate(room);
        resume();
        await joining;
      } finally {
        crypto.subtle.digest = originalDigest;
      }

      assert.equal(session.ready, false);
      assert.equal(clientSocket.sent.at(-1)?.m, scenario.error);
    });
  }
});

test('a draft returns to the lobby when a disconnect leaves one human team', () => {
  const room = makeRoom();
  const leavingSocket = socket();
  room.phase = 'draft';
  room.host = 1;
  room.roster.set(1, player(1, 0));
  room.roster.set(2, player(2, 1));
  room.roster.set(3, player(3, 1));

  room.drop({ socket: leavingSocket, pid: 1 });

  assert.equal(room.phase, 'lobby');
  assert.equal(room.round, 0);
});

test('a departing recorded winner is replaced by a connected teammate', () => {
  const room = makeRoom();
  const leavingSocket = socket();
  room.phase = 'draft';
  room.lastWinner = 1;
  room.lastWinnerTeam = 0;
  room.roster.set(1, player(1, 0, 1));
  room.roster.set(2, player(2, 0, 1));
  room.roster.set(3, player(3, 1));

  room.drop({ socket: leavingSocket, pid: 1 });

  assert.equal(room.phase, 'draft');
  assert.equal(room.lastWinner, 2);
  assert.equal(room.lastWinnerTeam, 0);
});

test('round scoring credits a connected teammate of a departed winner', () => {
  const room = makeRoom();
  room.round = 1;
  room.phase = 'round';
  room.roster.set(2, player(2, 0));
  room.roster.set(3, player(3, 1));
  room.world = {
    winner: 1,
    players: [
      { pid: 1, team: 0, loadout: Array(TUNE.slots).fill('random') },
      { pid: 2, team: 0, loadout: Array(TUNE.slots).fill('random') },
      { pid: 3, team: 1, loadout: Array(TUNE.slots).fill('random') },
    ],
  };

  room.finishRound();

  assert.equal(room.roster.get(2).wins, 1);
  assert.equal(room.lastWinner, 2);
  assert.equal(room.lastWinnerTeam, 0);
});

test('round scoring clears a winner whose whole team departed', () => {
  const room = makeRoom();
  room.round = 1;
  room.phase = 'round';
  room.roster.set(2, player(2, 1));
  room.roster.set(3, player(3, 2));
  room.world = {
    winner: 1,
    players: [
      { pid: 1, team: 0, loadout: Array(TUNE.slots).fill('random') },
      { pid: 2, team: 1, loadout: Array(TUNE.slots).fill('random') },
      { pid: 3, team: 2, loadout: Array(TUNE.slots).fill('random') },
    ],
  };

  room.finishRound();

  assert.equal(room.lastWinner, -1);
  assert.equal(room.lastWinnerTeam, -1);
  assert.equal(room.roster.get(2).wins, 0);
  assert.equal(room.roster.get(3).wins, 0);
});

test('relay simulation debt is bounded to its catch-up budget', () => {
  const room = makeRoom();
  room.roster.set(1, player(1, 0));
  room.roster.set(2, player(2, 1));
  room.startRound();
  room.sessions.set(socket(), { ready: false });
  room.accumulator = 100;
  room.lastTick = Date.now();

  room.tick();

  assert.ok(room.accumulator <= TUNE.step);
});
