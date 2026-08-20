// Client entry.
//
// Three responsibilities and nothing else: read input, keep a local copy of the
// world moving between relay snapshots, and drive the DOM screens. All the rules
// live in sim.js, all the numbers live in data.js, so this file never decides
// anything about the game itself.

import { TUNE, ABILITIES, ABILITY_BY_ID, SELECTABLE_ABILITIES, resolveLoadout, COLORS, MAPS, BOT_NAMES, clamp } from './data.js?v=20260820-5';
import { createWorld, step, applyInput, applySnapshot, markSpeculative, snapshot } from './sim.js?v=20260820-5';
import { createBrain, driveBot } from './bots.js?v=20260820-5';
import { createRenderer, paintAbilityIcon } from './render.js?v=20260820-5';
import { createAudio } from './audio.js?v=20260820-5';
import { createNet, fetchLobbies, relayBase } from './net.js?v=20260820-5';

const $ = id => document.getElementById(id);
const canvas = $('game');
const renderer = createRenderer(canvas);
const audio = createAudio();

const SLOT_KEYS = ['KeyJ', 'KeyK', 'KeyL'];
const SLOT_LABELS = ['LMB / J', 'RMB / K', 'MMB / L'];
const PAD_SLOT_BUTTONS = [2, 1, 3];          // X, B, Y on a standard layout

const G = {
  screen: 'landing',
  mode: 'menu',
  world: null,
  roster: [],
  you: 1,
  host: false,
  hostPid: -1,
  room: '',
  round: 0,
  lastWinner: -1,
  lastWinnerTeam: -1,
  targetWins: TUNE.winsToTake,
  draft: null,
  locals: [],
  couchColors: [],
  offline: null,
  brains: new Map(),
  banner: null,
  lastFrame: 0,
  lobbyTimer: 0,
  wasAlive: new Map(),
  authoritativeAlive: true,
  stats: { matches: 0, rounds: 0, wins: 0, kills: 0, deaths: 0 },
  cloud: false,
  name: 'bopl',
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
const pointer = { x: 0, y: 0, buttons: [false, false, false], active: false };
const touch = { move: null, aim: null, jump: false, slots: [false, false, false] };
let usingTouch = false;

addEventListener('keydown', event => {
  if (event.target.matches('input, select, textarea')) return;
  keys.add(event.code);
  if (event.code === 'KeyM') { const muted = audio.setMuted(!audio.isMuted()); $('mute').textContent = muted ? 'sound off' : 'sound on'; }
  if (G.screen === 'play' && ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
  audio.resume();
});
addEventListener('keyup', event => keys.delete(event.code));
addEventListener('blur', () => {
  keys.clear();
  pointer.buttons = [false, false, false];
  touch.jump = false;
  touch.slots.fill(false);
});

canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('pointerdown', event => {
  audio.resume();
  if (event.pointerType === 'touch') { usingTouch = true; handleTouchDown(event); return; }
  pointer.active = true;
  pointer.buttons[event.button === 1 ? 2 : event.button === 2 ? 1 : 0] = true;
  updatePointer(event);
  canvas.setPointerCapture?.(event.pointerId);
});
addEventListener('pointerup', event => {
  if (event.pointerType === 'touch') { handleTouchUp(event); return; }
  pointer.buttons[event.button === 1 ? 2 : event.button === 2 ? 1 : 0] = false;
});
addEventListener('pointermove', event => {
  if (event.pointerType === 'touch') { handleTouchMove(event); return; }
  updatePointer(event);
});

function updatePointer(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = event.clientX - rect.left;
  pointer.y = event.clientY - rect.top;
}

function handleTouchDown(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  if (x < rect.width * 0.42) touch.move = { id: event.pointerId, ox: x, oy: y, x, y };
  else touch.aim = { id: event.pointerId, ox: x, oy: y, x, y };
}
function handleTouchMove(event) {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  for (const stick of [touch.move, touch.aim]) if (stick && stick.id === event.pointerId) { stick.x = x; stick.y = y; }
}
function handleTouchUp(event) {
  if (touch.move && touch.move.id === event.pointerId) touch.move = null;
  if (touch.aim && touch.aim.id === event.pointerId) touch.aim = null;
}

const touchJump = $('touch-jump');
touchJump.addEventListener('pointerdown', event => {
  event.preventDefault();
  usingTouch = true;
  touch.jump = true;
  touchJump.setPointerCapture?.(event.pointerId);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  touchJump.addEventListener(type, () => { touch.jump = false; });
}

function worldPoint(sx, sy) {
  const scale = renderer.lastScale || 1;
  return [(sx - canvas.clientWidth / 2) / scale, (sy - canvas.clientHeight / 2) / scale];
}

function pads() { return navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : []; }

function readLocalInput(local, player) {
  const input = { mx: 0, my: 0, jump: false, ax: player ? player.input.ax : 1, ay: player ? player.input.ay : 0, ab: [false, false, false] };
  if (local.source === 'kb') {
    if (keys.has('KeyA') || keys.has('ArrowLeft')) input.mx -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) input.mx += 1;
    if (keys.has('KeyW') || keys.has('ArrowUp')) input.my -= 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) input.my += 1;
    input.jump = keys.has('Space') || touch.jump;
    for (let i = 0; i < TUNE.slots; i++) input.ab[i] = pointer.buttons[i] || keys.has(SLOT_KEYS[i]) || touch.slots[i];
    if (usingTouch) {
      if (touch.move) {
        const dx = touch.move.x - touch.move.ox;
        const dy = touch.move.y - touch.move.oy;
        input.mx = clamp(dx / 42, -1, 1);
        input.my = clamp(dy / 42, -1, 1);
        if (Math.hypot(input.mx, input.my) < 0.22) { input.mx = 0; input.my = 0; }
      }
      if (touch.aim && player) {
        const dx = touch.aim.x - touch.aim.ox, dy = touch.aim.y - touch.aim.oy;
        const l = Math.hypot(dx, dy);
        if (l > 12) { input.ax = dx / l; input.ay = dy / l; }
      }
    } else if (player) {
      const [wx, wy] = worldPoint(pointer.x, pointer.y);
      const dx = wx - player.x, dy = wy - player.y;
      const l = Math.hypot(dx, dy);
      if (l > 0.05) { input.ax = dx / l; input.ay = dy / l; }
    }
    return input;
  }
  const pad = pads().find(p => p.index === local.pad);
  if (!pad) return input;
  const lx = pad.axes[0] || 0, ly = pad.axes[1] || 0;
  const rx = pad.axes[2] || 0, ry = pad.axes[3] || 0;
  input.mx = Math.abs(lx) > 0.24 ? clamp(lx, -1, 1) : 0;
  input.my = Math.abs(ly) > 0.24 ? clamp(ly, -1, 1) : 0;
  input.jump = !!pad.buttons[0]?.pressed;
  if (Math.hypot(rx, ry) > 0.3) { input.ax = rx; input.ay = ry; }
  else if (Math.hypot(lx, ly) > 0.5) { input.ax = lx; input.ay = ly; }
  for (let i = 0; i < TUNE.slots; i++) {
    input.ab[i] = !!pad.buttons[PAD_SLOT_BUTTONS[i]]?.pressed
      || !!pad.buttons[[7, 5, 6][i]]?.pressed;
  }
  return input;
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

const SCREENS = ['landing', 'online', 'couch', 'lobby', 'draft', 'results', 'abilities', 'help'];

function show(name) {
  G.screen = name;
  for (const id of SCREENS) $(id).hidden = id !== name;
  const playing = name === 'play';
  $('menus').classList.toggle('hide', playing);
  $('hud').hidden = !playing;
  if (!playing) { keys.clear(); pointer.buttons = [false, false, false]; }
  if (!playing && name !== 'landing') requestAnimationFrame(() => {
    const target = $(name)?.querySelector('h2, button, input, select');
    if (!target) return;
    if (target.matches('h2')) target.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
}

let toastTimer = 0;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function banner(text, sub, seconds = 1.4) {
  G.banner = { text, sub, until: performance.now() + seconds * 1000 };
}

function colorOf(pid) {
  const record = G.roster.find(r => r.pid === pid);
  return COLORS[(record ? record.color : 0) % COLORS.length];
}

function teamMembers(team) { return G.roster.filter(record => record.team === team); }

function winnerText(pid, match = false) {
  const record = G.roster.find(entry => entry.pid === pid);
  if (!record) return match ? 'Match over' : 'Nobody survived';
  const members = teamMembers(record.team);
  if (members.length > 1) return `${COLORS[record.color % COLORS.length].name} team ${match ? 'wins the match' : 'takes the round'}`;
  return `${record.name} ${match ? 'wins the match' : 'takes the round'}`;
}

function colorPicker(selected, label, onPick) {
  const picker = document.createElement('div');
  picker.className = 'color-picker';
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', label);
  for (let index = 0; index < COLORS.length; index++) {
    const color = COLORS[index];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'color-choice';
    button.dataset.color = String(index);
    button.style.setProperty('--choice', color.body);
    button.style.setProperty('--choice-dark', color.dark);
    button.title = color.name;
    button.setAttribute('aria-label', color.name);
    button.setAttribute('aria-pressed', String(index === selected));
    if (index === selected) button.classList.add('selected');
    button.addEventListener('click', () => onPick(index));
    picker.appendChild(button);
  }
  return picker;
}

function iconCanvas(abilityId, size = 40, accent) {
  const node = document.createElement('canvas');
  node.width = node.height = size * 2;
  node.style.width = node.style.height = `${size}px`;
  if (abilityId) paintAbilityIcon(node, abilityId, accent || '#ffd267');
  return node;
}

// ---------------------------------------------------------------------------
// Menus wiring
// ---------------------------------------------------------------------------

for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => { audio.play.ui(); show(button.dataset.back); });
}

$('player-name').addEventListener('change', () => {
  G.name = ($('player-name').value || 'bopl').slice(0, 14);
  try { localStorage.setItem('bop-name', G.name); } catch {}
});

$('open-abilities').addEventListener('click', () => { audio.play.ui(); buildAbilityGrid(); show('abilities'); });
$('open-help').addEventListener('click', () => { audio.play.ui(); show('help'); });
$('open-couch').addEventListener('click', () => { audio.play.ui(); buildCouch(); show('couch'); });

function buildAbilityGrid() {
  const grid = $('ability-grid');
  if (grid.childElementCount) return;
  for (const ability of ABILITIES) {
    const card = document.createElement('div');
    card.className = 'ability-card';
    card.appendChild(iconCanvas(ability.id, 34));
    const body = document.createElement('div');
    body.innerHTML = `<div class="name"></div><div class="blurb"></div><div class="cd"></div>`;
    body.querySelector('.name').textContent = ability.name;
    body.querySelector('.blurb').textContent = ability.blurb;
    body.querySelector('.cd').textContent = `${ability.family} · ${ability.cd}s cooldown · ${ability.kind}`;
    card.appendChild(body);
    grid.appendChild(card);
  }
}

function buildCouch() {
  const list = $('pad-list');
  const found = pads();
  list.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'pad-row';
  row.innerHTML = '<span class="grow">Player 1 — keyboard and mouse</span>';
  list.appendChild(row);
  found.forEach((pad, index) => {
    const node = document.createElement('div');
    node.className = 'pad-row';
    node.innerHTML = `<span class="grow">Player ${index + 2} — gamepad</span><span class="meta"></span>`;
    node.querySelector('.meta').textContent = pad.id.slice(0, 28);
    list.appendChild(node);
  });
  const select = $('couch-humans');
  const max = Math.min(4, 1 + found.length);
  select.innerHTML = '';
  for (let i = 1; i <= max; i++) {
    const option = document.createElement('option');
    option.value = String(i);
    option.textContent = String(i);
    select.appendChild(option);
  }
  select.value = String(max);
  select.onchange = () => renderCouchColors(Number(select.value));
  renderCouchColors(max);
  if (!found.length) {
    const hint = document.createElement('div');
    hint.className = 'pad-row';
    hint.innerHTML = '<span class="grow meta">No gamepads found. Plug one in and press a button, then come back.</span>';
    list.appendChild(hint);
  }
}

function renderCouchColors(count) {
  while (G.couchColors.length < count) G.couchColors.push(G.couchColors.length % COLORS.length);
  G.couchColors.length = count;
  const wrap = $('couch-colors');
  wrap.innerHTML = '';
  for (let index = 0; index < count; index++) {
    const row = document.createElement('div');
    row.className = 'color-row';
    const name = document.createElement('strong');
    name.textContent = `Player ${index + 1}`;
    row.append(name, colorPicker(G.couchColors[index], `Player ${index + 1} color`, color => {
      G.couchColors[index] = color;
      renderCouchColors(count);
    }));
    wrap.appendChild(row);
  }
  $('couch-start').disabled = count < 2 || new Set(G.couchColors).size < 2;
}

addEventListener('gamepadconnected', () => { if (G.screen === 'couch') buildCouch(); });
addEventListener('gamepaddisconnected', () => { if (G.screen === 'couch') buildCouch(); });

$('play-offline').addEventListener('click', () => {
  audio.resume();
  startOffline({ humans: 1, bots: 3, wins: G.targetWins });
});

$('couch-start').addEventListener('click', () => {
  audio.resume();
  startOffline({
    humans: Number($('couch-humans').value) || 1,
    bots: 0,
    wins: Number($('couch-wins').value) || 5,
    colors: [...G.couchColors],
  });
});

$('mute').addEventListener('click', () => {
  const muted = audio.setMuted(!audio.isMuted());
  $('mute').textContent = muted ? 'sound off' : 'sound on';
});

// ---------------------------------------------------------------------------
// Offline / couch match controller
// ---------------------------------------------------------------------------
// Mirrors the relay's flow so both paths feel identical. The relay is the real
// implementation; this exists so the game works with no network at all.

function startOffline({ humans, bots, wins, colors = [] }) {
  G.mode = 'offline';
  G.targetWins = wins;
  G.round = 0;
  G.lastWinner = -1;
  G.lastWinnerTeam = -1;
  G.roster = [];
  G.locals = [];
  const padList = pads();
  let pid = 1;
  for (let i = 0; i < humans; i++) {
    const color = colors[i] ?? (pid - 1);
    const record = { pid, name: i === 0 ? G.name : `Player ${i + 1}`, color, team: color, bot: false, wins: 0, abilities: [] };
    G.roster.push(record);
    G.locals.push({ pid, source: i === 0 ? 'kb' : 'pad', pad: padList[i - 1]?.index ?? 0 });
    pid++;
  }
  for (let i = 0; i < bots; i++) {
    const color = pid - 1;
    G.roster.push({ pid, name: BOT_NAMES[(pid * 5) % BOT_NAMES.length], color, team: color, bot: true, wins: 0, abilities: [] });
    pid++;
  }
  G.you = G.locals[0].pid;
  G.offline = {
    rand: mulberry(Date.now() & 0xffff),
    mapHistory: [],
    calm: new URLSearchParams(location.search).has('calm'),
  };
  openDraft();
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Practice mode honours ?kit=grenade,dash,beam so a specific loadout can be
// examined without rolling the draft. Offline only; the relay never reads it.
function forcedKit() {
  const raw = new URLSearchParams(location.search).get('kit');
  if (!raw) return null;
  const ids = raw.split(',').map(s => s.trim()).filter(id => ABILITY_BY_ID.has(id)).slice(0, TUNE.slots);
  return ids.length ? ids : null;
}

function editableLoadout(loadout = []) {
  return Array.from({ length: TUNE.slots }, (_, index) => index < loadout.length ? loadout[index] : 'random');
}

function openDraft() {
  const kit = forcedKit();
  if (kit && G.mode === 'offline') {
    for (const record of G.roster) {
      if (G.locals.some(l => l.pid === record.pid)) record.abilities = [...kit];
      else if (!record.abilities.length) record.abilities = ['random', 'random', 'random'];
    }
    offlineStartRound();
    return;
  }
  const rows = [];
  for (const record of G.roster) {
    if (record.bot) {
      if (!record.abilities.length) record.abilities = ['random', 'random', 'random'];
      continue;
    }
    if (!G.locals.some(l => l.pid === record.pid)) continue;
    // The round winner keeps playing. Everyone who lost may reopen selection;
    // pressing Ready without changing anything keeps the current build.
    if (G.round > 0 && record.team === G.lastWinnerTeam) continue;
    const held = editableLoadout(record.abilities);
    rows.push({ pid: record.pid, held, picked: false, slot: 0 });
  }
  if (!rows.length) { offlineStartRound(); return; }
  G.draft = { rows, left: TUNE.draftTime, deadline: performance.now() + TUNE.draftTime * 1000 };
  renderDraft();
  show('draft');
}

function offlineStartRound() {
  G.round++;
  let mapIndex = 0;
  // ?map= pins the arena in practice mode, which is how the theme art gets
  // reviewed without replaying until the right one comes up.
  const pinned = new URLSearchParams(location.search).get('map');
  if (pinned !== null) {
    const byId = MAPS.findIndex(m => m.id === pinned);
    mapIndex = byId >= 0 ? byId : clamp(parseInt(pinned, 10) || 0, 0, MAPS.length - 1);
    G.offline.mapHistory.push(mapIndex);
    buildWorld({
      seed: (Date.now() ^ (G.round * 7919)) | 0, mapIndex,
      players: G.roster.map(r => ({
        pid: r.pid, name: r.name, color: r.color, team: r.team, bot: r.bot, loadout: [...r.abilities],
        abilities: resolveLoadout(r.abilities, G.offline.rand),
      })),
    });
    G.brains.clear();
    for (const record of G.roster) if (record.bot) G.brains.set(record.pid, createBrain(record.pid * 31 + G.round));
    show('play');
    banner(`Round ${G.round}`, mapName(mapIndex), 1.2);
    return;
  }
  if (G.round > 1) {
    const recent = G.offline.mapHistory.slice(-2);
    const choices = MAPS.map((m, i) => i).filter(i => !recent.includes(i));
    mapIndex = choices[Math.floor(G.offline.rand() * choices.length) % choices.length];
  }
  G.offline.mapHistory.push(mapIndex);
  buildWorld({
    seed: (Date.now() ^ (G.round * 7919)) | 0,
    mapIndex,
    players: G.roster.map(r => ({
      pid: r.pid, name: r.name, color: r.color, team: r.team, bot: r.bot, loadout: [...r.abilities],
      abilities: resolveLoadout(r.abilities, G.offline.rand),
    })),
  });
  G.brains.clear();
  for (const record of G.roster) if (record.bot) G.brains.set(record.pid, createBrain(record.pid * 31 + G.round));
  show('play');
  banner(`Round ${G.round}`, mapName(mapIndex), 1.2);
}

function mapName(index) { return MAPS[clamp(index, 0, MAPS.length - 1)].name; }

function offlineFinishRound() {
  const winner = G.world.winner;
  const winningPlayer = G.world.players.find(player => player.pid === winner);
  const winningTeam = winningPlayer?.team ?? -1;
  G.lastWinner = winner;
  G.lastWinnerTeam = winningTeam;
  for (const player of G.world.players) {
    const roster = G.roster.find(record => record.pid === player.pid);
    if (roster && !player.clone && player.loadout) roster.abilities = [...player.loadout];
  }
  const record = G.roster.find(r => r.pid === winner);
  if (record) {
    for (const teammate of G.roster) if (teammate.team === winningTeam) teammate.wins++;
  }
  G.stats.rounds++;
  const mine = G.roster.find(r => r.pid === G.you);
  if (record && mine?.team === winningTeam) G.stats.wins++;
  if (record && record.wins >= G.targetWins) { saveStats(); showResults(winner); return; }
  banner(winnerText(winner), null, 1.4);
  audio.play.round();
  setTimeout(() => { if (G.mode === 'offline') openDraft(); }, 1200);
}

// ---------------------------------------------------------------------------
// Draft UI
// ---------------------------------------------------------------------------

function renderDraft() {
  const wrap = $('draft-rows');
  const pickerScroll = new Map([...wrap.querySelectorAll('.draft-row')].map(node => [node.dataset.pid, node.querySelector('.ability-picker')?.scrollTop || 0]));
  const focused = document.activeElement?.closest?.('.draft-row');
  const focusState = focused ? {
    pid: focused.dataset.pid,
    ability: document.activeElement.dataset.ability,
    slot: document.activeElement.dataset.slot,
  } : null;
  wrap.innerHTML = '';
  if (!G.draft) return;
  $('draft-title').textContent = G.draft.midRound
    ? 'Choose abilities for next round'
    : G.round === 0 ? 'Choose your abilities' : 'Change abilities or keep your build';
  if (G.draft.midRound) $('draft-timer').textContent = 'eliminated';
  else $('draft-timer').textContent = `${Math.max(0, G.draft.left)}s`;
  if (!G.draft.rows.length) {
    const waiting = document.createElement('p');
    waiting.className = 'lede';
    waiting.textContent = 'You won the round. Waiting for the other players to finish choosing.';
    wrap.appendChild(waiting);
  }
  for (const row of G.draft.rows) {
    const record = G.roster.find(r => r.pid === row.pid);
    const color = COLORS[(record?.color ?? 0) % COLORS.length];
    const node = document.createElement('div');
    node.className = 'draft-row';
    node.dataset.pid = String(row.pid);
    node.style.setProperty('--player', color.body);

    const who = document.createElement('div');
    who.className = 'who';
    const blob = document.createElement('span');
    blob.className = 'blob';
    blob.style.background = color.body;
    blob.style.border = `2px solid ${color.dark}`;
    who.append(blob, document.createTextNode(record?.name || 'bopl'));
    node.appendChild(who);

    const held = document.createElement('div');
    held.className = 'held';
    for (let i = 0; i < TUNE.slots; i++) {
      const id = row.held[i];
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'held-slot' + (row.slot === i ? ' target' : '');
      slot.dataset.slot = String(i + 1);
      slot.title = `${id ? SELECTABLE_ABILITIES.find(ability => ability.id === id)?.name || id : 'Empty'} — slot ${i + 1}`;
      slot.setAttribute('aria-pressed', String(row.slot === i));
      slot.appendChild(iconCanvas(id, 30, '#ffd267'));
      slot.addEventListener('click', () => { row.slot = i; renderDraft(); });
      held.appendChild(slot);
    }
    node.appendChild(held);

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'clear-slot';
    clear.disabled = row.picked || !row.held[row.slot];
    clear.textContent = `Clear slot ${row.slot + 1}`;
    clear.addEventListener('click', () => {
      row.held[row.slot] = '';
      audio.play.ui();
      renderDraft();
    });
    node.appendChild(clear);

    const cards = document.createElement('div');
    cards.className = 'cards ability-picker';
    for (const ability of SELECTABLE_ABILITIES) {
      const id = ability.id;
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card' + (row.held[row.slot] === id ? ' chosen' : '');
      card.dataset.ability = id;
      card.dataset.family = ability.family;
      card.disabled = row.picked;
      card.setAttribute('aria-pressed', String(row.held[row.slot] === id));
      card.appendChild(iconCanvas(id, 34, '#ffd267'));
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = ability.name;
      const blurb = document.createElement('div');
      blurb.className = 'blurb';
      blurb.textContent = ability.blurb;
      const tag = document.createElement('span');
      tag.className = 'kindtag';
      tag.textContent = ability.family;
      card.append(name, blurb, tag);
      card.addEventListener('click', () => {
        row.held[row.slot] = id;
        row.slot = (row.slot + 1) % TUNE.slots;
        audio.play.pick();
        renderDraft();
      });
      cards.appendChild(card);
    }
    node.appendChild(cards);
    const ready = document.createElement('button');
    ready.type = 'button';
    ready.className = 'primary ready-loadout';
    ready.disabled = row.picked;
    ready.textContent = row.picked ? 'Ready' : 'Use this loadout';
    ready.addEventListener('click', () => choose(row));
    node.appendChild(ready);
    wrap.appendChild(node);
  }

  for (const node of wrap.querySelectorAll('.draft-row')) {
    const picker = node.querySelector('.ability-picker');
    if (picker) picker.scrollTop = pickerScroll.get(node.dataset.pid) || 0;
  }
  if (focusState) {
    const row = [...wrap.querySelectorAll('.draft-row')].find(node => node.dataset.pid === focusState.pid);
    const controls = row ? [...row.querySelectorAll('button')] : [];
    const target = controls.find(button => focusState.ability !== undefined
      ? button.dataset.ability === focusState.ability
      : button.dataset.slot === focusState.slot);
    target?.focus({ preventScroll: true });
  }

  const standings = $('draft-standings');
  standings.innerHTML = '';
  const lead = Math.max(0, ...G.roster.map(r => r.wins));
  for (const record of [...G.roster].sort((a, b) => b.wins - a.wins)) {
    const color = COLORS[record.color % COLORS.length];
    const chip = document.createElement('div');
    chip.className = 'stand' + (record.wins === lead && lead > 0 ? ' lead' : '');
    const blob = document.createElement('span');
    blob.className = 'blob';
    blob.style.background = color.body;
    chip.append(blob, document.createTextNode(`${record.name} ${record.wins}/${G.targetWins}`));
    standings.appendChild(chip);
  }
}

function choose(row) {
  if (row.picked) return;
  audio.play.pick();
  row.picked = true;
  if (G.mode === 'online') {
    G.net.send({ t: 'loadout', abilities: row.held });
    renderDraft();
    return;
  }
  const record = G.roster.find(r => r.pid === row.pid);
  if (record) record.abilities = [...row.held];
  renderDraft();
  if (G.draft.rows.every(r => r.picked)) setTimeout(() => { if (G.mode === 'offline') offlineStartRound(); }, 260);
}

function tickDraft() {
  if (!G.draft || G.screen !== 'draft') return;
  if (G.draft.midRound) return;
  const left = Math.max(0, Math.ceil((G.draft.deadline - performance.now()) / 1000));
  if (left !== G.draft.left) {
    G.draft.left = left;
    $('draft-timer').textContent = `${left}s`;
  }
  if (left > 0 || G.mode !== 'offline') return;
  for (const row of G.draft.rows) {
    if (row.picked) continue;
    choose(row);
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function showResults(winnerPid) {
  const record = G.roster.find(r => r.pid === winnerPid);
  const mine = record && G.locals.some(local => G.roster.find(entry => entry.pid === local.pid)?.team === record.team);
  $('results-title').textContent = winnerText(winnerPid, true);
  if (mine) audio.play.win(); else audio.play.lose();
  const standings = $('results-standings');
  standings.innerHTML = '';
  for (const entry of [...G.roster].sort((a, b) => b.wins - a.wins)) {
    const color = COLORS[entry.color % COLORS.length];
    const chip = document.createElement('div');
    chip.className = 'stand' + (record && entry.team === record.team ? ' lead' : '');
    const blob = document.createElement('span');
    blob.className = 'blob';
    blob.style.background = color.body;
    chip.append(blob, document.createTextNode(`${entry.name} — ${entry.wins}`));
    standings.appendChild(chip);
  }
  updateResultActions();
  G.stats.matches++;
  saveStats();
  show('results');
}

function updateResultActions() {
  $('again').hidden = G.mode === 'online' && !G.host;
  $('to-lobby').hidden = G.mode !== 'online' || !G.host;
}

$('again').addEventListener('click', () => {
  if (G.mode === 'online') { G.net.send({ t: 'again' }); return; }
  for (const record of G.roster) { record.wins = 0; record.abilities = []; }
  G.round = 0;
  G.lastWinner = -1;
  G.lastWinnerTeam = -1;
  openDraft();
});
$('to-lobby').addEventListener('click', () => G.net.send({ t: 'lobby' }));
$('to-menu').addEventListener('click', () => leave());

function leave() {
  if (G.net) G.net.close();
  G.mode = 'menu';
  G.world = null;
  G.draft = null;
  show('landing');
}

for (const button of document.querySelectorAll('[data-leave]')) button.addEventListener('click', leave);

// ---------------------------------------------------------------------------
// Online
// ---------------------------------------------------------------------------

$('play-online').addEventListener('click', () => {
  audio.resume();
  show('online');
  refreshLobbies();
});

$('refresh-lobbies').addEventListener('click', () => { audio.play.ui(); refreshLobbies(); });

async function refreshLobbies() {
  const list = $('lobby-list');
  const lobbies = await fetchLobbies();
  list.innerHTML = '';
  if (!lobbies.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No lobbies right now. Host one and send the name to a friend.';
    list.appendChild(empty);
    return;
  }
  for (const lobby of lobbies) {
    const row = document.createElement('div');
    row.className = 'lobby-row';
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = lobby.name + (lobby.locked ? ' 🔒' : '');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${lobby.players}/${lobby.max} · ${lobby.teams ? 'color teams' : 'free for all'} · ${lobby.phase === 'lobby' ? 'waiting' : `round ${lobby.round}`}`;
    const join = document.createElement('button');
    join.type = 'button';
    join.textContent = 'join';
    join.disabled = !lobby.joinable;
    join.addEventListener('click', () => {
      $('join-name').value = lobby.name;
      if (lobby.locked) { $('join-password').focus(); toast('That lobby needs a password'); return; }
      connect('join', lobby.name, '');
    });
    row.append(name, meta, join);
    list.appendChild(row);
  }
}

$('create-form').addEventListener('submit', event => {
  event.preventDefault();
  connect('create', $('room-name').value, $('room-password').value, {
    max: Number($('room-max').value),
    bots: 0,
    wins: Number($('room-wins').value),
  });
});

$('join-form').addEventListener('submit', event => {
  event.preventDefault();
  connect('join', $('join-name').value, $('join-password').value);
});

function connect(action, room, password, settings) {
  const clean = String(room || '').trim();
  if (clean.length < 3) { $('online-error').textContent = 'Lobby names need at least three characters.'; return; }
  $('online-error').textContent = '';
  G.mode = 'online';
  G.room = clean;
  G.pendingAction = action;
  G.net = createNet({
    onMessage: handleServer,
    onClose: reason => {
      if (G.mode !== 'online') return;
      G.mode = 'menu';
      G.world = null;
      show('online');
      $('online-error').textContent = reason || 'Disconnected from the relay.';
    },
  });
  G.net.open(action, clean, { name: G.name, password, settings });
}

function handleServer(message) {
  switch (message.t) {
    case 'welcome': {
      G.you = message.you;
      G.host = !!message.host;
      G.hostPid = G.host ? message.you : -1;
      G.locals = [{ pid: message.you, source: 'kb' }];
      show('lobby');
      $('lobby-name').textContent = message.room;
      return;
    }
    case 'lobby': {
      G.roster = message.players;
      G.hostPid = message.host;
      G.host = message.host === G.you;
      G.round = message.round;
      G.targetWins = message.settings.wins;
      $('lobby-name').textContent = message.room;
      $('set-max').value = String(message.settings.max);
      $('set-wins').value = String(message.settings.wins);
      for (const node of $('host-settings').querySelectorAll('select')) node.disabled = !G.host;
      const enoughTeams = new Set(G.roster.map(record => record.color)).size >= 2;
      $('start-match').disabled = !G.host || G.roster.length < 2 || !enoughTeams;
      $('lobby-hint').textContent = G.host
        ? !enoughTeams
          ? 'Pick at least two colors before starting.'
          : 'You are the host. Share the lobby name so others can join.'
        : 'Choose your color, then wait for the host to start.';
      renderRoster();
      if (message.phase === 'lobby') {
        G.world = null;
        G.draft = null;
        if (G.screen !== 'lobby' && G.screen !== 'online') show('lobby');
      }
      if (message.phase === 'done' && G.screen === 'results') updateResultActions();
      return;
    }
    case 'draft': {
      const previousDraft = G.draft;
      const previousRow = previousDraft?.rows.find(row => row.pid === G.you);
      const keepLocalEdit = previousDraft?.round === message.round && previousRow && !previousRow.picked && !message.ready;
      G.round = message.round - 1;
      G.lastWinner = message.winner ?? -1;
      G.lastWinnerTeam = message.winnerTeam ?? -1;
      G.roster = mergeRoster(message.players);
      G.draft = {
        round: message.round,
        rows: message.editable
          ? [{
            pid: G.you,
            held: keepLocalEdit ? [...previousRow.held] : editableLoadout(message.held),
            picked: message.ready,
            slot: keepLocalEdit ? previousRow.slot : 0,
          }]
          : [],
        left: message.left,
        deadline: performance.now() + message.left * 1000,
      };
      if (G.screen !== 'draft') { renderDraft(); show('draft'); }
      else renderDraft();
      return;
    }
    case 'begin': {
      G.round = message.round;
      G.targetWins = message.wins;
      G.roster = mergeRoster(message.players);
      buildWorld({ seed: message.seed, mapIndex: message.mapIndex, players: message.players }, true);
      show('play');
      banner(`Round ${message.round}`, mapName(message.mapIndex), 1.2);
      return;
    }
    case 'full':
    case 'snap': {
      if (!G.world) return;
      applySnapshot(G.world, message, G.you, !message.full);
      const localAlive = G.world.players.some(player => player.pid === G.you && player.alive);
      if (G.authoritativeAlive && !localAlive) {
        const player = G.world.players.find(candidate => candidate.pid === G.you);
        if (player) openEliminatedSelect(player);
      }
      G.authoritativeAlive = localAlive;
      return;
    }
    case 'over': {
      G.roster = mergeRoster(message.standings);
      banner(winnerText(message.winner), null, 1.6);
      audio.play.round();
      return;
    }
    case 'match': {
      G.roster = mergeRoster(message.standings);
      showResults(message.winner);
      return;
    }
    case 'chat': {
      const log = $('chat-log');
      const line = document.createElement('div');
      const who = document.createElement('b');
      who.textContent = `${message.name}: `;
      line.append(who, document.createTextNode(message.m));
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
      return;
    }
    case 'err': {
      $('online-error').textContent = message.m;
      toast(message.m);
      return;
    }
  }
}

function mergeRoster(players) {
  return players.map(entry => {
    const previous = G.roster.find(r => r.pid === entry.pid) || {};
    const merged = { ...previous, ...entry };
    if (entry.loadout) merged.abilities = [...entry.loadout];
    return merged;
  });
}

function renderRoster() {
  const list = $('roster');
  list.innerHTML = '';
  const teamCounts = new Map();
  for (const record of G.roster) teamCounts.set(record.color, (teamCounts.get(record.color) || 0) + 1);
  for (const record of G.roster) {
    const color = COLORS[record.color % COLORS.length];
    const row = document.createElement('div');
    row.className = 'roster-row' + (record.pid === G.you ? ' you' : '') + (record.pid === G.hostPid ? ' host' : '');
    const blob = document.createElement('span');
    blob.className = 'blob';
    blob.style.background = color.body;
    blob.style.borderColor = color.dark;
    const name = document.createElement('span');
    name.className = 'grow';
    name.textContent = record.name + (record.bot ? ' (bot)' : '') + (record.pid === G.you ? ' — you' : '');
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${teamCounts.get(record.color) > 1 ? `${color.name} team · ` : ''}${record.wins || 0} wins`;
    const kit = document.createElement('span');
    kit.className = 'kit';
    for (const id of record.abilities || []) kit.appendChild(iconCanvas(id, 18, color.body));
    row.append(blob, name, kit, meta);
    if (record.pid === G.you) {
      row.appendChild(colorPicker(record.color, 'Your color', selected => G.net?.send({ t: 'color', color: selected })));
    }
    list.appendChild(row);
  }
}

$('start-match').addEventListener('click', () => G.net.send({ t: 'start' }));
for (const id of ['set-max', 'set-wins']) {
  $(id).addEventListener('change', () => G.net?.send({
    t: 'settings', max: Number($('set-max').value), bots: 0,
    wins: Number($('set-wins').value),
  }));
}
$('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('chat-input').value.trim();
  if (!text) return;
  G.net?.send({ t: 'chat', m: text });
  $('chat-input').value = '';
});

// ---------------------------------------------------------------------------
// World lifecycle
// ---------------------------------------------------------------------------

function buildWorld(setup, speculative = false) {
  G.world = createWorld(setup);
  if (speculative) markSpeculative(G.world);
  G.wasAlive.clear();
  for (const player of G.world.players) G.wasAlive.set(player.id, true);
  G.authoritativeAlive = true;
  buildSlots();
}

function openEliminatedSelect(player) {
  const record = G.roster.find(entry => entry.pid === player.pid);
  if (!record || G.screen !== 'play') return;
  const held = editableLoadout(player.loadout.length ? player.loadout : record.abilities);
  G.draft = { rows: [{ pid: player.pid, held, picked: false, slot: 0 }], midRound: true, left: 0, deadline: Infinity };
  renderDraft();
  show('draft');
}

function buildSlots() {
  const wrap = $('slots');
  wrap.innerHTML = '';
  const player = localPlayer();
  const abilities = player ? player.slots.map(s => s.id) : [];
  for (let i = 0; i < TUNE.slots; i++) {
    const slot = document.createElement('div');
    slot.className = 'slot' + (abilities[i] ? '' : ' empty');
    slot.dataset.slot = String(i);
    slot.dataset.ability = abilities[i] || '';
    if (abilities[i]) slot.appendChild(iconCanvas(abilities[i], 44, '#ffd267'));
    const cool = document.createElement('div');
    cool.className = 'cool';
    const charge = document.createElement('div');
    charge.className = 'charge';
    charge.style.width = '0%';
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = SLOT_LABELS[i];
    slot.append(cool, charge, key);
    slot.style.pointerEvents = 'auto';
    slot.addEventListener('pointerdown', event => {
      event.preventDefault();
      if (event.pointerType === 'touch') usingTouch = true;
      touch.slots[i] = true;
    });
    slot.addEventListener('pointerup', () => { touch.slots[i] = false; });
    slot.addEventListener('pointerleave', () => { touch.slots[i] = false; });
    wrap.appendChild(slot);
  }
}

function localPlayer() {
  if (!G.world) return null;
  return G.world.players.find(p => p.pid === G.you && p.alive)
    || G.world.players.find(p => p.pid === G.you)
    || null;
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

function updateHud() {
  const world = G.world;
  if (!world) return;

  const board = $('scoreboard');
  if (board.childElementCount !== G.roster.length) {
    board.innerHTML = '';
    for (const record of G.roster) {
      const color = COLORS[record.color % COLORS.length];
      const chip = document.createElement('div');
      chip.className = 'score';
      chip.dataset.pid = String(record.pid);
      const blob = document.createElement('span');
      blob.className = 'blob';
      blob.style.background = color.body;
      blob.style.borderColor = color.dark;
      const name = document.createElement('span');
      name.textContent = record.name;
      const pips = document.createElement('span');
      pips.className = 'pips';
      for (let i = 0; i < G.targetWins; i++) {
        const pip = document.createElement('i');
        pip.className = 'pip';
        pips.appendChild(pip);
      }
      chip.append(blob, name, pips);
      board.appendChild(chip);
    }
  }
  for (const chip of board.children) {
    const pid = Number(chip.dataset.pid);
    const record = G.roster.find(r => r.pid === pid);
    const player = world.players.find(p => p.pid === pid && p.alive)
      || world.players.find(p => p.pid === pid);
    chip.classList.toggle('out', !player || !player.alive);
    const pips = chip.querySelector('.pips').children;
    for (let i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < (record?.wins || 0));
  }

  const left = Math.max(0, TUNE.roundTime - world.t);
  const clock = $('round-clock');
  clock.classList.toggle('sudden', world.sudden > 0);
  $('clock-value').textContent = world.sudden > 0
    ? 'SUDDEN DEATH'
    : `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`;

  const player = localPlayer();
  const slots = $('slots').children;
  for (let i = 0; i < slots.length; i++) {
    const node = slots[i];
    const slot = player?.slots[i];
    const ability = slot ? ABILITY_BY_ID.get(slot.id) : null;
    const cool = node.querySelector('.cool');
    const charge = node.querySelector('.charge');
    if ((node.dataset.ability || '') !== (slot?.id || '')) {
      node.querySelector('canvas')?.remove();
      if (slot?.id) node.prepend(iconCanvas(slot.id, 44, '#ffd267'));
      node.dataset.ability = slot?.id || '';
      node.classList.toggle('empty', !slot?.id);
    }
    if (!slot || !ability) { cool.style.transform = 'scaleY(0)'; charge.style.width = '0%'; continue; }
    const fraction = clamp(slot.cd / ability.cd, 0, 1);
    cool.style.transform = `scaleY(${fraction})`;
    node.classList.toggle('ready', fraction <= 0 && !slot.used);
    node.classList.toggle('active', slot.state === 1);
    const progress = slot.state === 1
      ? (ability.kind === 'channel' ? clamp((slot.fuel || 0) / (ability.fuel || 1), 0, 1) : clamp(slot.t / (ability.charge || 1), 0, 1))
      : 0;
    charge.style.width = `${progress * 100}%`;
  }

  if (G.banner && performance.now() < G.banner.until) {
    const node = $('banner');
    node.classList.add('show');
    node.innerHTML = '';
    node.append(document.createTextNode(G.banner.text));
    if (G.banner.sub) {
      const sub = document.createElement('small');
      sub.textContent = G.banner.sub;
      node.appendChild(sub);
    }
  } else if (world.phase === 'intro') {
    const node = $('banner');
    node.classList.add('show');
    node.textContent = String(Math.max(1, Math.ceil(world.phaseT)));
  } else {
    $('banner').classList.remove('show');
    G.banner = null;
  }

  $('net-info').textContent = G.mode === 'online'
    ? `${G.net?.latency() ?? 0} ms · ${world.bodies.length} bodies`
    : `${world.bodies.length} bodies`;

  canvas.dataset.entities = String(world.bodies.length);
  canvas.dataset.phase = world.phase;
  canvas.dataset.round = String(G.round);
  canvas.dataset.alive = String(world.players.filter(p => p.alive).length);
  canvas.dataset.localPid = String(G.you);
  canvas.dataset.mode = G.mode;
  if (player) {
    canvas.dataset.testPlayer = JSON.stringify({
      x: Math.round(player.x * 100) / 100, y: Math.round(player.y * 100) / 100,
      alive: player.alive, form: player.form, size: player.size, grounded: player.grounded,
      slots: player.slots.map(s => ({ id: s.id, cd: Math.round(s.cd * 100) / 100, state: s.state })),
    });
    delete canvas.dataset.renderError;
  } else canvas.dataset.renderError = 'no local player';
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

let accumulator = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - (G.lastFrame || now)) / 1000);
  G.lastFrame = now;

  tickDraft();
  if (G.screen === 'landing') paintBrand(now / 1000);

  G.lobbyTimer -= dt;
  if (G.lobbyTimer <= 0 && G.screen === 'online') { G.lobbyTimer = 6; refreshLobbies(); }

  const world = G.world;
  if (world && (G.mode === 'offline' || G.mode === 'online')) {
    // Local input first so the local bopl answers the same frame the key lands.
    for (const local of G.locals) {
      const clones = world.players.filter(p => p.pid === local.pid);
      const reference = clones.find(p => p.alive) || clones[0];
      if (!reference) continue;
      const input = readLocalInput(local, reference);
      for (const player of clones) applyInput(player, input);
    }
    if (G.mode === 'online') {
      G.net.pump(dt, readLocalInput(G.locals[0], localPlayer()) , 1 / TUNE.inputHz);
    }

    accumulator += dt;
    let steps = 0;
    while (accumulator >= TUNE.step && steps < 5) {
      if (G.mode === 'offline' && !G.offline?.calm) {
        const shared = new Map();
        for (const player of world.players) {
          if (!player.bot || !player.alive) continue;
          const input = shared.get(player.pid);
          if (input) {
            applyInput(player, input);
            continue;
          }
          let brain = G.brains.get(player.pid);
          if (!brain) { brain = createBrain(player.pid * 31 + G.round); G.brains.set(player.pid, brain); }
          driveBot(world, player, brain, TUNE.step);
          shared.set(player.pid, { ...player.input, ab: [...player.input.ab] });
        }
      }
      const events = step(world, TUNE.step);
      renderer.feed(events, world);
      audio.feed(events);
      accumulator -= TUNE.step;
      steps++;
    }

    // Deaths that only the relay knows about still need a pop.
    for (const player of world.players) {
      const was = G.wasAlive.get(player.id);
      if (was && !player.alive) {
        renderer.feed([{ e: 'pop', x: player.x, y: player.y, c: player.color, cause: 'relay' }], world);
        audio.play.pop();
      }
      G.wasAlive.set(player.id, player.alive);
    }

    if (G.mode === 'offline' && world.phase === 'over' && world.phaseT <= 0 && G.screen === 'play') {
      offlineFinishRound();
    }
  }

  renderer.stepParticles(dt);
  if (G.screen === 'play' && world) {
    renderer.draw(world, {
      localPid: G.you, time: now / 1000, showNames: true,
      colorOf: pid => G.roster.find(r => r.pid === pid)?.color ?? 0,
    });
    updateHud();
  } else if (world && G.screen === 'draft') {
    renderer.draw(world, { localPid: G.you, time: now / 1000, showNames: false, colorOf: () => 0 });
  }
}

// A little idle bopl on the title screen so the first thing you see is the
// creature you are about to be.
const brandCanvas = $('brand-bopl');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
function paintBrand(t) {
  const ctx = brandCanvas.getContext('2d');
  const size = brandCanvas.width;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);
  const scale = size / 3.1;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#7a4d31';
  ctx.strokeStyle = '#29222f';
  ctx.lineWidth = 0.1;
  renderer.capsulePath(ctx, 0, 1.28, 0.82, 0.22, 0);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#69c74b';
  renderer.capsulePath(ctx, 0, 1.16, 0.82, 0.12, 0);
  ctx.fill();
  ctx.stroke();
  const bob = reduceMotion.matches ? 0 : Math.sin(t * 1.7) * 0.06;
  renderer.drawBopl(ctx, {
    x: 0, y: bob, r: 1, color: COLORS[0],
    stretch: reduceMotion.matches ? 0 : Math.max(0, Math.sin(t * 1.7) * 0.18),
    aimx: Math.cos(t * 0.6), aimy: Math.sin(t * 0.9) * 0.4,
    blink: Math.sin(t * 1.1) > 0.986 ? 1 : 0,
  });
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Identity and stats
// ---------------------------------------------------------------------------

async function boot() {
  let stored = '';
  try { stored = localStorage.getItem('bop-name') || ''; } catch {}
  G.name = stored || 'bopl';
  if (location.hostname === 'bop.andrenijman.com') {
    try {
      const response = await fetch('/_guard/status', { cache: 'no-store' });
      const identity = await response.json();
      if (identity.signedIn && identity.username) {
        G.name = stored || identity.username.slice(0, 14);
        const profile = await fetch('/_guard/profile', { cache: 'no-store' });
        if (profile.ok) {
          const data = await profile.json();
          if (data.profile?.stats) G.stats = { ...G.stats, ...data.profile.stats };
          if (!stored && data.profile?.name) G.name = data.profile.name;
          G.cloud = true;
        }
      }
    } catch { /* the game works with no guard in front of it */ }
  }
  $('player-name').value = G.name;
  $('player-name').placeholder = G.name;
  show('landing');
  requestAnimationFrame(frame);
}

let saveTimer = 0;
function saveStats() {
  try { localStorage.setItem('bop-stats', JSON.stringify(G.stats)); } catch {}
  if (!G.cloud) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/_guard/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: G.name, stats: G.stats }),
    }).catch(() => {});
  }, 200);
}

try {
  const saved = JSON.parse(localStorage.getItem('bop-stats') || 'null');
  if (saved) G.stats = { ...G.stats, ...saved };
} catch {}

boot();

// Exposed for the smoke tests: they drive the public UI, but they need a way to
// confirm the simulation is really running rather than a still frame.
window.BOP = {
  state: () => ({
    screen: G.screen, mode: G.mode, round: G.round, you: G.you,
    phase: G.world?.phase, tick: G.world?.tick, bodies: G.world?.bodies.length,
    alive: G.world?.players.filter(p => p.alive).length,
    roster: G.roster.map(r => ({ pid: r.pid, name: r.name, color: r.color, team: r.team, wins: r.wins, abilities: r.abilities })),
  }),
  relay: relayBase,
  abilities: ABILITIES.length,
  maps: MAPS.length,
};
