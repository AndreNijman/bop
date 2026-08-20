# BOP

A physics platform brawler for the browser. You are a squishy blob on a cluster of
floating rocks. Between every round you draft a new ability from three on offer,
you carry three at a time, and the last blob alive wins the round.

**Play: https://bop.andrenijman.com**

No download, no account, no build step. Online multiplayer for up to eight, couch
multiplayer on gamepads, or practice against bots.

---

## What is in it

- **29 abilities**, every one a distinct mechanic — grenades, a steerable missile,
  a bow, a sweeping laser, a grappling hook, a drill that tunnels through terrain,
  a black hole that grows as it feeds, time stop, growth and shrink rays, tesla
  coil pairs, a duplicator, revive orbs, and more.
- **15 arenas** across three themes. Grass has water at the bottom and platforms
  that travel. Ice is slippery. Space has low gravity, no water, and terrain that
  floats free.
- **Real physics.** Every collider is a capsule solved by an impulse solver.
  Terrain is not scenery: it has mass, it springs back toward where it started,
  and you can shove it, shrink it, tear boulders out of it or bolt a rocket to it.
- **No health bar.** You die by leaving the arena, hitting the water, being
  crushed between two solid things, being eaten by something two sizes bigger, or
  touching something lethal.
- **Sudden death** at two minutes: the death barrier closes and the terrain shrinks.

## Controls

| Input | Does |
| --- | --- |
| `A` `D` or arrows | move |
| `W` / `Space` | jump, and lets go of a grapple |
| mouse | aims everything |
| left click / `J` | ability one |
| right click / `K` | ability two |
| middle click / `L` | ability three |
| `M` | mute |
| gamepad | left stick moves, right stick aims, `A` jumps, `X`/`B`/`Y` are the abilities |

Touch works too: left thumb to move, right thumb to aim, tap the ability tiles.

## How the netcode works

The relay is authoritative. A game whose whole point is shoving people into the
void cannot let clients own their own position — one liar and the round is
meaningless. So a Durable Object runs `sim.js` at a fixed 60 Hz, clients send
nothing but intent at 30 Hz, and state goes out at 15 Hz.

The client runs the same `sim.js` forward between snapshots, which is what makes
it feel immediate: your own blob answers the frame you press the key, and
abilities fire locally straight away. Locally created objects get ids above one
million and are dropped the moment the relay's version of events arrives, so
speculation can never accumulate. Positions are blended toward the authoritative
value, hard-snapped when the error gets large.

Round state is rebuilt from `(seed, mapIndex, players)` on both sides, so
snapshots only carry what actually moves.

## Development

```bash
npm install
npm run serve         # static server on :4173
npm run dev           # wrangler dev, the relay, on :8787
npm run check         # syntax gate plus the headless simulation checks
npm test              # solo browser smoke test
npm run test:mp       # 4 browsers against a real relay
CLIENTS=8 node tools/mp-smoke.mjs
npm run balance       # ability balance harness
npm run deploy        # deploy the relay
```

Open `http://localhost:4173/?relay=http://127.0.0.1:8787` to point the client at
a local relay.

### Layout

| File | Job |
| --- | --- |
| `data.js` | tuning, the 29 abilities, the 15 arenas. Imported by client, relay and tools, so numbers cannot drift |
| `sim.js` | the whole game: capsule physics, abilities, death rules, wire format. No DOM, no network, no `Math.random` |
| `bots.js` | bot brains, shared by the relay, practice mode and the balance harness |
| `render.js` | canvas renderer. Every pixel is drawn in code |
| `audio.js` | WebAudio synthesis. No audio files |
| `net.js` | one websocket |
| `game.js` | input, screens, HUD |
| `worker.js` | the relay: `GameRoom` and `LobbyRegistry` Durable Objects |

There is no bundler and no framework. `sim.js` never touches a browser API, which
is the only reason the relay and the tools can run it too.

## Balance

`npm run balance` plays bot matches and reports a win rate per ability. Two modes:

- `--mode melee` (default for tuning): four bots, three random abilities each,
  expected win rate 25%. This is the metric the numbers in `data.js` are tuned
  against, because it is how the game is actually played.
- `--mode duel`: every ability against every other, one each. A clean signal, but
  structurally unfair to abilities with no kill mechanism — a duel between
  Invisibility and Bow can only end one way.

Current state, 3200 melee rounds: **no ability deviates more than 6 points from
the 25% baseline, mean deviation 3.0.**

Being honest about what that does and does not prove: the bot is identical for
every ability, but it is not equally *good* at all of them. Grappling Hook sits
around 19% because the bot only stays attached about 5% of the time; in human
hands it is a much better ability than that number suggests. The harness is a
tool for finding outliers, not a ladder.

It found real bugs, not just soft numbers — missiles detonating on the player who
fired them, tesla arcs electrocuting their own owner, black holes eating their
caster two thirds of the time, and grapples slingshotting the holder out of the
arena. All four came out of death-cause tallies rather than guesswork.

## Testing

```bash
npm run check        # 14 headless checks: resting contacts, edge falls, crushing,
                     # every ability firing, traps, snapshot round trips, a full match
npm test             # boots the page, plays a practice round through the real UI
npm run test:mp      # lobby creation, password refusal, discovery, draft sync,
                     # movement across clients, chat, drift, a client leaving
```

Both browser tests fail on any console error, page error or failed request.

## Licence and attribution

No licence yet. The repository is public but no rights are granted.

BOP is an original implementation inspired by the physics-brawler genre, and by
*Bopl Battle* in particular. No code, art, audio, text or data from that game or
any other is used here: the physics solver, the ability set, the arenas, every
drawn pixel and every synthesised sound in this repository were written from
scratch for it.
