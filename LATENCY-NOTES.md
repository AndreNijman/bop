# BOP latency notes

Step 0 of the latency pass, written before any simulation or rendering change.
Line numbers refer to origin/main d2a66c4.

## Authority model: (b), server runs the sim

The `GameRoom` Durable Object runs `sim.js` at a fixed 60 Hz and is the only
authority (worker.js:1-7, tick loop worker.js:681-742). Clients send intent
only (`input`, net.js:89) and render. The client also runs the same `sim.js`
forward between snapshots (game.js:1269-1296), so the local blob and locally
fired abilities respond the frame a key lands; the relay's version always wins.

## What already hides delay

- **Local prediction.** The local blob steps on local input every frame
  (game.js:1257-1264). Locally created bodies get ids from 1e6
  (`markSpeculative`, sim.js:2163) and are kept until the authoritative spawn
  adopts them or 0.75 s passes (sim.js:2383-2393).
- **Local reconciliation.** `applySnapshot` (sim.js:2341) blends the local
  blob 6% per snapshot toward the authoritative position and 15% toward its
  velocity, snapping when the error exceeds `maxSpeed / snapshotHz * 1.25`
  (3.8 units) (sim.js:2397-2427). Predicted ability state survives unless the
  relay contradicts it six snapshots in a row (sim.js:2419-2421).
  Problem: the authoritative position is about one round trip old, but it is
  compared with the local blob's *current* position. While running, the blend
  settles with the local blob about `runSpeed × RTT` behind where the relay will
  put it (1.2 units, more than one blob, at 200 ms), and the velocity blend
  drags starts and overshoots stops.
- **Remote interpolation.** Each body keeps its last 6 snapshot poses
  (`recordSnapshotPose`, sim.js:2260); `interpolatedPose` (sim.js:2275)
  interpolates them with a Hermite spline, extrapolates at most 100 ms past the
  newest, and holds on discontinuities (teleports, death, Blink).
- **Render clock.** `interpolationTime` (game.js:1055-1062) renders remote
  bodies a fixed 100 ms behind the server time of the *newest arrival*, never
  moving backwards. A late packet makes the clock stand still until it catches
  up; an early one makes it jump. Under jitter that is visible stutter.
- Fixed-step interpolation of the local blob between sim steps
  (`fixedStepPose`, game.js:1064).

## Rates and messages

- Sim 60 Hz (`TUNE.step`), snapshots every 4 ticks = 15 Hz (worker.js:19),
  client input 30 Hz (`TUNE.inputHz`, net.js:84-89), one ping per second.
- Server to client, in a round: `snap` 15/s, plus `begin`, `over`, `match`,
  `draft` (1/s during the draft), `lobby`, `chat`, `pong` 1/s, `err`.
- Client to server: `input` 30/s during a round, `ping` 1/s, `loadout`, `start`,
  `again`, `lobby`, `name`, `settings`, `color`, `chat`, and `create`/`join` as
  the first message.
- Pings only flow during a round today: `pump()` (net.js:82) sends them and is
  only called while a world exists (game.js:1266).

## Room lifecycle

- One Durable Object per lobby name: the Worker derives `roomKey(name)` and
  uses `env.ROOMS.getByName(key)` (worker.js:88-90). The DO holds everything in
  memory; nothing is stored.
- Create / join: the first websocket message (`handshake`, worker.js:328).
  Joining is refused once the match has started (worker.js:350).
- **Match start: `case 'start'` (worker.js:235-247), the host's request in the
  lobby phase, then `beginMatch()` → `startDraft()` → `startRound()`.**
  `again` (worker.js:267) restarts a finished match in the same room.
- End: `finishRound` sets `done` (worker.js:668); `returnToLobby`; `reset()`
  when the last human leaves or after 45 idle minutes (worker.js:683-688).
- Lobby directory: `LobbyRegistry` DO, upserted every 10 s while a room lives.

## Item 1 plan

The model is (b), so both halves apply. No wire change is needed.

1. **Remote: adaptive render clock** (new `netsmooth.js`). The render clock
   follows the fastest recent arrival path (windowed minimum of arrival time
   minus server time), stays behind it by the 95th-percentile snapshot arrival
   gap (clamped to 70-250 ms), and slews toward its target rather than
   jumping (it only snaps after a large jump, such as a new round). The 6-sample
   Hermite buffer and the 100 ms extrapolation cap stay as they are, with
   discontinuities still snapping. The old clock stays in the module as the
   legacy mode, so the harness can print the before number.
2. **Local: delay-matched reconciliation.** The client keeps its own blob's
   predicted poses for the last 1.5 s. A snapshot is compared with the
   prediction from one estimated input-to-snapshot lag ago (median of recent
   pings, plus input and tick pacing), not with the current position. The
   difference is blended into the current state and the stored history is
   shifted by the same amount. Large errors still correct in one go. This is
   an optional argument to `applySnapshot`, so calling it without the argument
   behaves exactly as before (sim-test and the harness's before path).
3. Measure first with `tests/latency/harness.mjs` (200 ms RTT, ±40 ms jitter,
   virtual time, seeded) and keep a change only if its number improves.

Correctness is unaffected: the relay stays the only authority over deaths,
scores and winners. These changes only move what each client draws and how
it corrects its own prediction.

## Items 2-4

- Country: the Worker's `fetch` forwards `withWhere(request, playerWhere(request))`
  on `/ws`, and the DO keeps `whereOf(request)` per session for `stats.seat`.
- Ping display: `/ping?room=&shard=` forwarded to the room DO; the room list
  and the lobby screen show `regionLabel`; the HUD shows `pinger.rtt`.
- Placement: decide in `case 'start'` before `beginMatch()`. All of a room's
  state (name, password hash, settings, roster, host) lives in the DO and can be
  handed over, so a move is possible. `moved` is persisted in DO storage,
  because the old DO is evicted once its sockets close.
