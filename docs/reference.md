# Bopl Battle behavior reference

Research date: 2026-08-20. Current published gameplay build: 2.5.1 (2025-07-07).

This document records the behavior BOP is recreating. It is a mechanical reference,
not a source for code, text, art, or audio. BOP's implementation and assets remain
original.

## Source policy

1. Official Steam announcements and store material establish current behavior and
   patch values.
2. Unedited current-build gameplay establishes visible behavior when official notes
   do not specify it.
3. The community wiki is secondary evidence for contracts and measured timings.
4. An unsupported number remains an estimate. It must not be described as a vanilla
   value.

Primary sources:

- [Official Steam store](https://store.steampowered.com/app/1686940/Bopl_Battle/)
- [Official Steam news API](https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=1686940&count=100&maxlength=0&format=json)
- [Patch 2.2.3](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5759616966669005894)
- [Patch 2.2.4](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5741605105611388946)
- [Patch 2.3.0](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5963414363409221122)
- [Patch 2.4.0](https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1790848102627394)

Detailed secondary sources:

- [Abilities](https://bopl-battle.fandom.com/api.php?action=parse&page=Abilities&prop=wikitext&format=json)
- [Cooldown table](https://bopl-battle.fandom.com/api.php?action=parse&page=Template:AbilityCooldown&prop=wikitext&format=json)
- [Maps](https://bopl-battle.fandom.com/api.php?action=parse&page=Maps&prop=wikitext&format=json)
- [Clones](https://bopl-battle.fandom.com/api.php?action=parse&page=Clones&prop=wikitext&format=json)
- [Eating](https://bopl-battle.fandom.com/api.php?action=parse&page=Eating&prop=wikitext&format=json)
- [One-time use](https://bopl-battle.fandom.com/api.php?action=parse&page=One-time_Use&prop=wikitext&format=json)
- [Beginner movement guide](https://www.youtube.com/watch?v=pVm0KWU6Dos&t=109s)
- [Four-direction surface controls](https://steamcommunity.com/app/1686940/discussions/0/4029095737387664628/)
- [Alternate relative-control request](https://steamcommunity.com/app/1686940/discussions/0/4428814058381804743/)

Every named ability below also has a specific page at
`https://bopl-battle.fandom.com/api.php?action=parse&page=<name>&prop=wikitext&format=json`.

## Match and movement

| Area | Current behavior | Confidence |
| --- | --- | --- |
| Players | Two to four local or online players. The official game has no bots or single-player mode. | Official |
| Loadout | Up to three independently cooling slots are selected before play. Duplicate abilities are legal. | Official plus achievements |
| Between rounds | Loadouts persist. Eliminated/losing players may edit; the winner keeps playing. There is no one-of-three round draft. | Wiki plus gameplay |
| Random | Resolves independently each round. With three Random slots and no offensive result, only the final slot rerolls once. | Official 2.3.0 |
| Elimination pickup | The eliminated bopl drops its current middle ability. A collector replaces only its own middle slot. | Wiki plus gameplay |
| Arena pickup | A natural ability pickup spawns every 40 seconds. | Official 2.2.3 |
| Objective | Last surviving bopl or team wins the round. Matches accumulate round wins. | Official store |
| Teams | Free-for-all and team-vs-team are supported. Time Stop leaves the caster's team active; mines do not acquire teammates. | Official store/2.2.4 plus wiki |
| Team formation | Players choose colors before the match. Bopls with the same color are teammates; unique colors produce free-for-all and matching colors permit uneven teams. | Current-build gameplay |
| Surface movement | Bopls adhere to every side of terrain. WASD/left-stick input stays screen-relative and is projected onto the surface: traversing clockwise over a top, right end, and underside requires right, down, then left. Jumping blends upward and outward motion on sides; an underside jump only detaches and drops. | Tutorial footage plus two independent control reports |
| Grass | Water, stationary terrain, and moving terrain. Round one always uses the same Grass arena. | Maps wiki/gameplay |
| Ice | Water, ordinary snow and slippery ice. Ice arenas do not use moving terrain. | Maps wiki/gameplay |
| Space | No water, low gravity, anchored spherical moons, and freely moving satellite-like platforms. | Maps wiki/gameplay |
| Spawns | Each map has predetermined spawn points per player slot. Later maps are random. | Maps wiki |
| Sudden death | At two minutes, all natural and player-made platforms move down, rebound slightly, rest, then repeat more violently until dragged into the void. The screen and terrain do not shrink. | Maps wiki video/description |
| Eating | Contact automatically eats an enemy two Growth/Shrink levels smaller. Eating grants slight growth. Clone size is shared. | Wiki plus official 2.3.0 |

## Cross-cutting ability rules

- Using an ability normally takes a shared action lock even though cooldowns are
  per slot. Morphs, charge states, Throw carrying, and channels block starting most
  other abilities. A deployed grapple remains compatible with combo abilities.
- The current one-use category contains only Black Hole. A slot cannot cast another
  in that life even after its 4.5-second cooldown display completes. Revival resets it.
- Same-slot identity matters: repeated Spike and Revival replace their prior object;
  Tesla Coils connect only to a coil from the same slot.
- Multiple Revival slots create one bopl at every marker. Revival clones retain the
  loadout; Duplicator player clones start empty. Both share input and size, but a
  pickup changes only the collecting clone. The shared cap is 16.
- Since 2.3.0, same-player clones can hurt each other with Beam, Rock, Drill, and
  Meteor.
- Ability icons and cooldowns are visible above every bopl with a team-colored
  background.

## Ability matrix

`Estimated` means BOP still needs a current-build measurement before its exact tuning
number can be called faithful.

| Ability | Contract | Cooldown | Current key behavior |
| --- | --- | ---: | --- |
| Random | Passive round start | Result-dependent | Rerolls its slot every round; all-Random has the one-time offensive reroll above. |
| Dash | Tap | 4 s | Instant aimed launch, brief startup invulnerability, preserves momentum, does not detach grapple. |
| Grenade | Hold/cook, release | 2 s | Fuse starts on press and is 3.5 s; contact, heat, electricity, or explosions detonate it. Size follows user. |
| Bow | Hold morph/charge, release | 2.5 s | Charge controls arrow range. Bow limits movement and exit resets velocity. Charge time is estimated. |
| Engine | Tap on terrain | 3.5 s | Roughly 0.45 s startup and 6 s thrust; placement frees the platform spring. Enlarged engines push harder. |
| Blink Gun | Hold gun, release | 2.5 s; 5 s on player hit | Objects disappear about 4 s; bopls about 1.3 s and return near valid terrain. Repeated hits shorten disappearance. |
| Gust | Tap | 5 s | Radial impulse affects players, terrain, projectiles, Rock, and Drill. Grounded players receive half strength. |
| Growth Ray | Hold gun, release | 2.5 s | Player/object growth lasts the round. Enlarged platforms alone revert after 10 s. |
| Rock | Tap fixed morph | 2 s | Non-cancelable, unsteerable, very light, lethal. Water, bounds, and black holes remain lethal. Duration is estimated. |
| Missile | Hold to steer, release | 4.5 s | Contact explosion; release launches at high speed; ignites smoke. The older 4 s wiki template is stale. |
| Spike | Tap on terrain | 3 s | Appears opposite the user. Reusing the same slot removes its previous spike. |
| Time Stop | Hold uninterrupted | 3 s | Approximately 9 s charge; early release cancels. Only caster team acts; other cooldowns accelerate while its own pauses. Freeze length is estimated. |
| Smoke | Hold/aim, release | 3 s | Contact creates four clouds. Fire/electric/explosive effects ignite chain explosions. |
| Platform | Hold morph, release | 6 s | Aim moves/resizes form; exits on eye-facing side. Black holes remain lethal. Maximum duration is unresolved. |
| Revival | Tap marker | 10 s | Same-slot marker replacement; all markers are consumed on death; respawn is vulnerable and restarts cooldowns. |
| Roll | Hold charge, release | 3.5 s | Traverses around touching terrain, remains vulnerable, jump cancels/exits and preserves released momentum. Timings are estimated. |
| Shrink Ray | Hold gun, release | 2.5 s | Shrink lasts the round, including platforms. Two levels create the eating threshold. |
| Black Hole | Tap, once per life/slot | 4.5 s | Pulls, consumes, and grows. Shrink converts it to a repelling white hole. Lifespan is estimated. |
| Invisibility | Tap | 6 s | Lasts 5 s. Trails remain visible; ability use briefly reveals; mines do not acquire invisible targets. |
| Meteor | Hold charge, release | 4 s | Auto-hop then vertical dive; impact kill/blast scales with charge. Protected attack forms resist. |
| Throw | Hold extract/carry, release | 1 s | About 0.8 s pickup; shrinks/consumes source terrain and can carry one attached object or grapple point. |
| Push | Hold on terrain | 1 s | Movement drives current terrain; smaller platforms move faster. No sourced fuel limit. |
| Tesla Coil | Tap on terrain | 1 s | Same-slot pair makes a line lethal to vulnerable players, including its owner; third removes oldest. Duplicate Tesla slots do not cross-link. |
| Mine | Tap deploy | 4.5 s | Arms after 2 s, acquires opponents only, ignores invisibility, and contact including owner detonates it. |
| Teleport | Two taps | 3 s after placement | First tap places bubble and starts cooldown. Second swaps everything at both ends and adds no cooldown. |
| Drill | Hold/steer, release | 4 s | Accelerating turn-limited drill; only tip kills. Release inside terrain continues until exit. No sourced fuel limit. |
| Grappling Hook | Tap fire; hold to reel | 3 s after detach/miss | Rope survives button release; jump detaches; can attach to terrain, players, projectiles, and holes. |
| Beam | Hold startup/channel | 5.7 s | Roughly 1.2 s grounded startup and 4.9 s active duration. Kills ordinary bopls, pushes resistant forms, ignites hazards. |
| Duplicator | Hold gun, release | 4 s | Copies target; player copy has no abilities. Output count varies by object and platform copies have replacement rules. |
| Magnet Gun | Hold pull/grip, release | 5 s | Moves players, projectiles, markers, pickups, free terrain, and small holes; anchored terrain is not grabbable. |

## Open measurements

The following exact values are not published and should be measured from current-build
60 fps capture before further numeric claims: Bow charge, Rock duration, Missile steer
limit, ray startup, Time Stop freeze duration, Smoke cloud lifetime, Platform maximum,
Roll charge/duration, Black Hole lifetime, Meteor threshold, Tesla duty cycle/lifetime,
Mine pursuit duration, Teleport marker lifetime, grapple range/reel rate, Duplicator
startup, Magnet overcharge, the exact side-jump up/out force blend, and the exact
sudden-death wave curve.

The current Beam page and official 2.2.2 note conflict on whether Beam moves the
platform supporting the caster. Do not resolve this by assumption.
