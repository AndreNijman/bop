// Multiplayer smoke test.
//
// Starts the real relay (wrangler dev, or a live one via LIVE_RELAY), opens
// independent browser pages, and drives the public UI and protocol from lobby
// creation through a synchronised round. No relay internals are imported or
// patched, so this catches protocol drift between game.js and worker.js.
//
//   node tools/mp-smoke.mjs
//   BASE_URL=https://bop.andrenijman.com LIVE_RELAY=https://... node tools/mp-smoke.mjs

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { TUNE } from '../data.js';

const liveRelay = process.env.LIVE_RELAY;
const relay = liveRelay || 'http://127.0.0.1:8787';
const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173';
const CLIENTS = Number(process.env.CLIENTS || 4);

const processes = [];
if (!process.env.BASE_URL) processes.push(spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore' }));
if (!liveRelay) processes.push(spawn('npx', ['wrangler', 'dev', '--port', '8787'], { stdio: 'ignore' }));
const stop = () => processes.forEach(p => { try { p.kill('SIGTERM'); } catch {} });
process.on('exit', stop);

async function ready(url, label) {
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`${label} (${url}) never became ready`);
}

const problems = [];
await ready(`${relay}/health`, 'relay');
await ready(baseUrl, 'static server');

const health = await (await fetch(`${relay}/health`)).json();
if (health.abilities !== 29) problems.push(`relay reports ${health.abilities} abilities`);

const room = `smoke ${Math.random().toString(36).slice(2, 7)}`;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  const pages = [];
  for (let i = 0; i < CLIENTS; i++) {
    const page = await context.newPage();
    page.on('pageerror', e => problems.push(`p${i} page error: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') problems.push(`p${i} console: ${m.text()}`); });
    const gameUrl = `${baseUrl}/?_games_frame=1&relay=${encodeURIComponent(relay)}`;
    await page.goto(gameUrl);
    if (await page.locator('.skip button').count()) {
      await context.request.post('https://games.andrenijman.com/_guard/skip', {
        form: { name: 'BOP multiplayer smoke', return: `${baseUrl}/` }, maxRedirects: 0,
      });
      await page.goto(gameUrl);
    }
    await page.locator('#landing').waitFor({ state: 'visible' });
    pages.push(page);
  }
  const [host, ...guests] = pages;

  // Host creates a locked lobby with one bot.
  await host.fill('#player-name', 'Host');
  await host.click('#play-online');
  await host.fill('#room-name', room);
  await host.fill('#room-password', 'hunter2');
  await host.selectOption('#room-max', String(CLIENTS));
  await host.selectOption('#room-bots', '1');
  await host.selectOption('#room-wins', '3');
  await host.click('#create-form button[type=submit]');
  try {
    await host.locator('#lobby').waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    const why = (await host.locator('#online-error').textContent()) || '(no message)';
    throw new Error(`host could not create the lobby: ${why.trim()}`);
  }

  // A wrong password must be refused.
  const intruder = guests[0];
  await intruder.fill('#player-name', 'Wrong');
  await intruder.click('#play-online');
  await intruder.fill('#join-name', room);
  await intruder.fill('#join-password', 'nope');
  await intruder.click('#join-form button[type=submit]');
  await intruder.waitForTimeout(1500);
  if (await intruder.locator('#lobby').isVisible()) problems.push('a wrong password still got into the lobby');
  const refusal = (await intruder.locator('#online-error').textContent()) || '';
  if (!/password/i.test(refusal)) problems.push(`unhelpful refusal message: "${refusal}"`);

  // The lobby should be discoverable and flagged as locked.
  const listed = await host.evaluate(async relayBase => {
    const response = await fetch(`${relayBase}/lobbies`, { cache: 'no-store' });
    return (await response.json()).lobbies || [];
  }, relay);
  const entry = listed.find(l => l.name === room);
  if (!entry) problems.push('lobby never appeared in the public directory');
  else if (!entry.locked) problems.push('password protected lobby was not marked locked');

  // Everyone else joins with the right password.
  for (let i = 0; i < guests.length; i++) {
    const page = guests[i];
    // The intruder is already on the online screen from the password check.
    if (await page.locator('#landing').isVisible()) {
      await page.fill('#player-name', `Guest${i + 1}`);
      await page.click('#play-online');
    }
    await page.fill('#join-name', room);
    await page.fill('#join-password', 'hunter2');
    await page.click('#join-form button[type=submit]');
    try {
      await page.locator('#lobby').waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      const why = (await page.locator('#online-error').textContent()) || '(no message)';
      problems.push(`guest ${i + 1} could not join: ${why.trim()}`);
    }
  }

  // Roster must agree across every client: humans plus the bot, except the bot
  // gets dropped when the humans already fill the eight player cap.
  const expected = Math.min(CLIENTS + 1, TUNE.maxPlayers);
  for (const page of pages) {
    await page.waitForFunction(n => document.querySelectorAll('#roster .roster-row').length === n, expected, { timeout: 15000 })
      .catch(() => problems.push('roster never reached the expected size on every client'));
  }

  // Only the host can start.
  if (!(await guests[0].locator('#start-match').isDisabled())) problems.push('a non-host could start the match');
  await host.click('#start-match');

  // Draft appears for everyone, offering three abilities each.
  for (const page of pages) {
    await page.locator('#draft .card').first().waitFor({ state: 'visible', timeout: 15000 });
    if (await page.locator('#draft .card').count() !== 3) problems.push('a client was not offered three abilities');
    if (await page.locator('#draft-rows .draft-row').count() !== 1) problems.push('online draft showed more than one row');
  }
  for (const page of pages) await page.locator('#draft .card').first().click();

  // Round begins on every client with the same seed and arena.
  for (const page of pages) {
    await page.waitForFunction(() => window.BOP.state().screen === 'play', null, { timeout: 15000 });
    await page.waitForFunction(() => window.BOP.state().phase === 'play', null, { timeout: 15000 });
  }
  const states = await Promise.all(pages.map(p => p.evaluate(() => window.BOP.state())));
  const alive = states.map(s => s.alive);
  if (new Set(alive).size !== 1) problems.push(`clients disagree on who is alive: ${alive.join(', ')}`);
  if (alive[0] !== expected) problems.push(`expected ${expected} bopls in the round, saw ${alive[0]}`);
  const rounds = states.map(s => s.round);
  if (new Set(rounds).size !== 1) problems.push(`clients disagree on the round number: ${rounds.join(', ')}`);
  for (const state of states) {
    if (!state.bodies || state.bodies < 8) problems.push(`a client rendered only ${state.bodies} bodies`);
  }
  const pids = states.map(s => s.you);
  if (new Set(pids).size !== pids.length) problems.push(`the relay handed out duplicate player ids: ${pids.join(', ')}`);

  // Movement made on one client must be visible to the others: this is the real
  // test of the snapshot pipeline.
  const startX = await host.evaluate(() => JSON.parse(document.querySelector('#game').dataset.testPlayer).x);
  await host.keyboard.down('KeyD');
  await host.waitForTimeout(1100);
  await host.keyboard.up('KeyD');
  await host.waitForTimeout(500);
  const hostX = await host.evaluate(() => JSON.parse(document.querySelector('#game').dataset.testPlayer).x);
  if (!(hostX > startX + 0.3)) problems.push(`host did not move online (${startX} -> ${hostX})`);
  const guestAlive = await guests[1].evaluate(() => window.BOP.state().alive);
  if (guestAlive !== alive[0]) problems.push('guest and host disagree on the survivor count after movement');

  // Latency should be reported, which proves the ping round trip works.
  await host.waitForTimeout(500);
  const netText = (await host.locator('#net-info').textContent()) || '';
  if (!/ms/.test(netText)) problems.push(`net readout missing latency: "${netText}"`);

  // Chat round trips through the relay.
  await host.click('#game');
  await guests[0].evaluate(() => window.BOP.state());
  await host.evaluate(() => {
    document.querySelector('#chat-input').value = 'hello from the smoke test';
    document.querySelector('#chat-form').dispatchEvent(new Event('submit', { cancelable: true }));
  });
  await guests[0].waitForFunction(() => (document.querySelector('#chat-log')?.textContent || '').includes('smoke test'), null, { timeout: 8000 })
    .catch(() => problems.push('chat did not reach the other clients'));

  // Let the round run and confirm the simulation keeps advancing everywhere.
  const ticksBefore = await Promise.all(pages.map(p => p.evaluate(() => window.BOP.state().tick)));
  await host.waitForTimeout(2500);
  const ticksAfter = await Promise.all(pages.map(p => p.evaluate(() => window.BOP.state().tick)));
  for (let i = 0; i < pages.length; i++) {
    if (ticksAfter[i] - ticksBefore[i] < 40) problems.push(`client ${i} stopped simulating`);
  }
  const spread = Math.max(...ticksAfter) - Math.min(...ticksAfter);
  if (spread > 240) problems.push(`clients drifted ${spread} ticks apart`);

  // A client leaving must not take the room down.
  await guests[guests.length - 1].close();
  await host.waitForTimeout(1200);
  const survived = await host.evaluate(() => window.BOP.state());
  if (survived.screen !== 'play') problems.push('the round ended when one client left');

  await host.screenshot({ path: '/tmp/opencode/bop-mp-smoke.png' });

  // Repository plumbing should not be reachable through the static host.
  if (!process.env.BASE_URL) {
    const leak = await fetch(`${baseUrl}/.git/config`);
    if (leak.ok) problems.push('.git/config is being served');
  }

  if (problems.length) {
    console.error('multiplayer smoke test failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else console.log(`Multiplayer smoke test passed (${CLIENTS} clients)`);
} catch (error) {
  console.error(`multiplayer smoke test crashed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  stop();
}
