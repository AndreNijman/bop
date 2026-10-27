// Dev join in real browsers (headless Chromium), against a local relay.
//
// A host and a guest start a match from the public UI on a local static
// server. A third page then opens the admin page's link,
// https://bop.andrenijman.com/?join=<lobby>, mid-round: Playwright serves that
// origin from the local files and answers games-guard's /_guard/dev with a
// pass signed by a key made here, and the relay (wrangler dev on 8837,
// inspector 9337) trusts that key through DEV_TEST_PUBLIC_KEY. The dev watches
// the round, every page shows "DEV TESTER HAS JOINED", and once the guest
// falls off the dev drafts and plays round two in their own color.
//
//   node tests/dev/smoke.mjs          (screenshots in shots/dev-*.png)

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signDevPass } from '../../netdev.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const relay = 'http://127.0.0.1:8837';
const site = 'http://127.0.0.1:8838';
const HOST = 'bop.andrenijman.com';
const shots = `${root}shots`;
mkdirSync(shots, { recursive: true });

const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
const privateKey = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64url');

const children = [];
function start(command, args, env = {}) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: true });
  children.push(child);
}
const stop = () => { for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } };
process.on('exit', stop);

start(`${root}node_modules/.bin/wrangler`, ['dev', '--ip', '127.0.0.1', '--port', '8837', '--inspector-port', '9337', '--var', `DEV_TEST_PUBLIC_KEY:${publicKey}`],
  { WRANGLER_REGISTRY_PATH: mkdtempSync(join(tmpdir(), 'bop-dev-smoke-')) });
start(`${root}node_modules/.bin/serve`, ['.', '-l', '8838']);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function ready(url) {
  for (let i = 0; i < 240; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await wait(250);
  }
  throw new Error(`${url} never became ready`);
}

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); };
const room = `devsmoke ${Math.random().toString(36).slice(2, 7)}`;
let browser;

try {
  await ready(`${relay}/health`);
  await ready(site);
  // The dev page is https://bop.andrenijman.com talking to a relay on 127.0.0.1;
  // Chromium's Local Network Access check would block that, production never meets it.
  browser = await chromium.launch({ headless: true, args: ['--disable-features=LocalNetworkAccessChecks'] });

  async function open(label, context, url) {
    const page = await context.newPage();
    page.on('pageerror', e => problems.push(`${label} page error: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
    await page.goto(url);
    await page.locator('#landing, #online').first().waitFor({ state: 'visible' });
    return page;
  }

  // Confirm this page's loadout once its draft is up (the round winner keeps
  // theirs and has nothing to confirm). The draft re-renders every second, so
  // the click goes through the DOM rather than a held element handle.
  const readyUp = (page, round) => page.waitForFunction(round => {
    if (window.BOP.state().round >= round && window.BOP.state().screen === 'play') return true;
    const button = document.querySelector('#draft:not([hidden]) .ready-loadout:not(:disabled)');
    button?.click();
    return false;
  }, round, { timeout: 30000, polling: 250 });

  const local = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  const gameUrl = `${site}/?relay=${encodeURIComponent(relay)}`;
  const host = await open('host', local, gameUrl);
  const guest = await open('guest', local, gameUrl);

  await host.fill('#player-name', 'Host');
  await host.click('#play-online');
  await host.fill('#room-name', room);
  await host.fill('#room-password', 'hunter2');
  await host.selectOption('#room-max', '2');
  await host.click('#create-form button[type=submit]');
  await host.locator('#lobby').waitFor({ state: 'visible', timeout: 15000 });
  await guest.fill('#player-name', 'Guest');
  await guest.click('#play-online');
  await guest.fill('#join-name', room);
  await guest.fill('#join-password', 'hunter2');
  await guest.click('#join-form button[type=submit]');
  await guest.locator('#lobby').waitFor({ state: 'visible', timeout: 15000 });
  await guest.locator('.roster-row.you .color-choice[data-color="1"]').click();
  await host.waitForFunction(() => window.BOP.state().roster.length === 2 && new Set(window.BOP.state().roster.map(r => r.color)).size === 2, null, { timeout: 10000 });
  await host.click('#start-match');
  await Promise.all([host, guest].map(page => readyUp(page, 1)));
  for (const page of [host, guest]) await page.waitForFunction(() => window.BOP.state().phase === 'play', null, { timeout: 20000 });
  check((await host.evaluate(() => window.__gamesPlayer))?.room === room, 'the host did not report its lobby to setPlayer');

  // The dev opens the admin page's link mid-round: a locked, full, running lobby.
  const devContext = await browser.newContext({ viewport: { width: 1100, height: 640 } });
  await devContext.route(`https://${HOST}/**`, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_guard/dev') {
      const { pass, exp } = await signDevPass(privateKey, { name: 'Tester', host: HOST });
      return route.fulfill({ json: { dev: true, name: 'TESTER', pass, exp } });
    }
    if (url.pathname === '/_guard/status') return route.fulfill({ json: { signedIn: false } });
    if (url.pathname === '/_guard/bop-lobbies') return route.fulfill({ json: { lobbies: [] } });
    if (url.pathname.startsWith('/_guard/probe/')) return route.fulfill({ status: 204 });
    const response = await fetch(`${site}${url.pathname}${url.search}`);
    return route.fulfill({ status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'text/plain' }, body: Buffer.from(await response.arrayBuffer()) });
  });
  const devUrl = `https://${HOST}/?join=${encodeURIComponent(room)}&relay=${encodeURIComponent(relay)}`;
  const dev = await devContext.newPage();
  dev.on('pageerror', e => problems.push(`dev page error: ${e.message}`));
  dev.on('console', m => { if (m.type() === 'error') problems.push(`dev console: ${m.text()}`); });
  await dev.goto(devUrl);

  // Everyone sees the standard banner.
  const pages = { host, guest, dev };
  await Promise.all(Object.entries(pages).map(([label, page]) => page.waitForFunction(
    () => {
      const banner = document.getElementById('dev-joined-banner');
      return banner && banner.textContent === 'DEV TESTER HAS JOINED' && getComputedStyle(banner).opacity === '1';
    }, null, { timeout: 15000 },
  ).catch(() => problems.push(`${label} never showed "DEV TESTER HAS JOINED"`))));
  await Promise.all(Object.entries(pages).map(([label, page]) => page.screenshot({ path: `${shots}/dev-joined-${label}.png` })));

  // The dev watches round one; everyone's scoreboard now has three players.
  const devState = await dev.evaluate(() => window.BOP.state());
  check(devState.screen === 'play' && devState.round === 1, `the dev is not watching round one (${devState.screen}, round ${devState.round})`);
  check(!devState.players.some(p => p.pid === devState.you), 'the dev was dropped into the running round');
  check(devState.players.length === 2, `the dev sees ${devState.players.length} players in round one`);
  for (const [label, page] of Object.entries(pages)) {
    await page.waitForFunction(() => document.querySelectorAll('#scoreboard .score').length === 3, null, { timeout: 8000 })
      .catch(() => problems.push(`${label}'s scoreboard does not list the dev`));
  }
  const player = await dev.evaluate(() => window.__gamesPlayer);
  check(player?.room === room && player?.name === 'bopl', `window.__gamesPlayer is ${JSON.stringify(player)}`);
  check(!new URL(dev.url()).searchParams.has('join'), 'the ?join= code was not cleared');
  check(new URL(dev.url()).searchParams.get('relay') === relay, 'clearing ?join= dropped the other query parameters');

  // The same link without a pass is an ordinary join: refused, with the lobby
  // name left in the join form for a password.
  const stranger = await local.newPage();
  await stranger.goto(`${site}/?join=${encodeURIComponent(room)}&relay=${encodeURIComponent(relay)}`);
  await stranger.waitForFunction(() => document.getElementById('online-error').textContent.trim(), null, { timeout: 15000 })
    .catch(() => problems.push('a ?join= link without a pass showed no refusal'));
  check(await stranger.locator('#online').isVisible(), 'a refused ?join= link did not land on the online screen');
  check(await stranger.inputValue('#join-name') === room, 'a refused ?join= link did not keep the lobby name in the join form');
  check(/already started/.test(await stranger.locator('#online-error').textContent()), 'a ?join= link without a pass was not refused like any late joiner');
  await stranger.close();

  // The guest hops off the edge; the dev drafts and plays round two in their own color.
  await guest.keyboard.down('KeyD');
  for (let i = 0; i < 40 && (await host.evaluate(() => window.BOP.state().screen)) === 'play'; i++) {
    await guest.keyboard.down('Space');
    await guest.waitForTimeout(100);
    await guest.keyboard.up('Space');
    await guest.waitForTimeout(400);
  }
  await guest.keyboard.up('KeyD');
  await Promise.all(Object.entries(pages).map(([label, page]) => readyUp(page, 2)
    .catch(() => problems.push(`${label} never reached round two`))));
  await dev.waitForFunction(() => {
    const state = window.BOP.state();
    return state.round === 2 && state.phase === 'play' && state.players.some(p => p.pid === state.you && p.alive);
  }, null, { timeout: 30000 }).catch(() => problems.push('the dev did not play round two'));
  const roundTwo = await host.evaluate(() => window.BOP.state());
  const devPid = (await dev.evaluate(() => window.BOP.state())).you;
  check(roundTwo.players.some(p => p.pid === devPid && p.alive), 'the host does not see the dev in round two');
  const colors = roundTwo.roster.map(r => r.color);
  check(roundTwo.roster.length === 3 && new Set(colors).size === 3, `round two colors are not one each: ${colors}`);
  await dev.waitForTimeout(1800);
  await Promise.all(Object.entries(pages).map(([label, page]) => page.screenshot({ path: `${shots}/dev-round-two-${label}.png` })));
} catch (error) {
  problems.push(`crashed: ${error.message}`);
} finally {
  await browser?.close();
  stop();
}

if (problems.length) {
  console.error('dev join smoke failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else console.log(`Dev join smoke passed (screenshots in ${shots}/dev-*.png)`);
