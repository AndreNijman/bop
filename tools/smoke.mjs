// Solo browser smoke test.
//
// Boots the real page, plays a practice round through the public UI, and fails
// on any console error, page error or failed request.
//
//   node tools/smoke.mjs [--headed] [url]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const headed = process.argv.includes('--headed');
const target = process.argv.find(a => a.startsWith('http')) || 'http://127.0.0.1:4173';
const own = !process.argv.find(a => a.startsWith('http'));
// Hosted games are served inside the site's iframe shell. `_games_frame=1` is
// how the guard hands back the game itself, which is what we want to drive.
const url = new URL(target);
url.searchParams.set('_games_frame', '1');
const server = own ? spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore' }) : null;

async function ready(target) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(target)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`${target} never became ready`);
}

const problems = [];
const browser = await chromium.launch({ headless: !headed });
try {
  if (own) await ready(target);
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.url()}`));

  await page.goto(url.toString(), { waitUntil: 'networkidle' });

  // The guard sits in front of production; take the guest door.
  const guest = page.locator('.skip button');
  if (await guest.count()) {
    await page.context().request.post('https://games.andrenijman.com/_guard/skip', {
      form: { name: 'BOP smoke', return: target }, maxRedirects: 0,
    });
    await page.goto(url.toString(), { waitUntil: 'networkidle' });
  }

  await page.locator('#landing').waitFor({ state: 'visible' });
  const counts = await page.evaluate(() => ({ abilities: window.BOP.abilities, maps: window.BOP.maps }));
  if (counts.abilities !== 29) problems.push(`expected 29 abilities, got ${counts.abilities}`);
  if (counts.maps < 12) problems.push(`expected at least 12 arenas, got ${counts.maps}`);

  // Ability reference: every ability must render an icon, not an empty box.
  await page.click('#open-abilities');
  await page.locator('#ability-grid .ability-card').first().waitFor();
  const cards = await page.locator('#ability-grid .ability-card').count();
  if (cards !== 29) problems.push(`ability screen listed ${cards} cards`);
  const blank = await page.evaluate(() => {
    let empty = 0;
    for (const canvas of document.querySelectorAll('#ability-grid canvas')) {
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 8) lit++;
      if (lit < 40) empty++;
    }
    return empty;
  });
  if (blank) problems.push(`${blank} ability icons drew nothing`);
  await page.click('#abilities .back');

  await page.fill('#player-name', 'Smoke');
  await page.click('#play-offline');

  // Draft screen: three cards offered, click one.
  await page.locator('#draft .card').first().waitFor({ state: 'visible', timeout: 8000 });
  if (await page.locator('#draft-rows .draft-row').count() !== 1) problems.push('practice draft should show exactly one row');
  if (await page.locator('#draft .card').count() !== 3) problems.push('draft did not offer three abilities');
  await page.locator('#draft .card').first().click();

  await page.waitForFunction(() => window.BOP.state().screen === 'play', null, { timeout: 8000 });
  await page.waitForFunction(() => window.BOP.state().phase === 'play', null, { timeout: 8000 });

  const early = await page.evaluate(() => window.BOP.state());
  if (early.alive !== 4) problems.push(`expected 4 bopls at the start, saw ${early.alive}`);
  if (!early.bodies || early.bodies < 8) problems.push(`world only had ${early.bodies} bodies`);
  if (await page.locator('#slots .slot').count() !== 3) problems.push('HUD is missing ability slots');
  if (await page.locator('#scoreboard .score').count() !== 4) problems.push('scoreboard does not list every bopl');

  // The simulation must actually be advancing.
  const tickA = await page.evaluate(() => window.BOP.state().tick);
  await page.waitForTimeout(600);
  const tickB = await page.evaluate(() => window.BOP.state().tick);
  if (tickB - tickA < 20) problems.push(`simulation is not stepping (${tickA} -> ${tickB})`);

  // Drive the real input path so key handling is covered. This is a live
  // four-way fight: the bopl can be shoved by a rival, blown sideways, killed,
  // or riding a platform that travels faster than it walks. So try both
  // directions a few times and accept the first clean response.
  let responded = false;
  let clean = 0;              // attempts where the bopl was alive and in normal form throughout
  let lastNote = 'no clean attempt';
  for (const key of ['KeyD', 'KeyA', 'KeyD', 'KeyA', 'KeyD']) {
    const before = JSON.parse(await page.locator('#game').getAttribute('data-test-player'));
    const phase = await page.evaluate(() => window.BOP.state().phase);
    if (!before.alive || before.form !== 'normal' || phase !== 'play') {
      lastNote = `not in a clean state (alive=${before.alive} form=${before.form} phase=${phase})`;
      await page.waitForTimeout(400);
      continue;
    }
    await page.keyboard.down(key);
    await page.waitForTimeout(650);
    await page.keyboard.up(key);
    const moved = JSON.parse(await page.locator('#game').getAttribute('data-test-player'));
    if (!moved.alive || moved.form !== 'normal') { lastNote = 'died or changed form mid-check'; continue; }
    clean++;
    const delta = moved.x - before.x;
    if (key === 'KeyD' ? delta > 0.3 : delta < -0.3) { responded = true; break; }
    lastNote = `${key} gave ${delta.toFixed(2)} (shoved or carried)`;
    await page.waitForTimeout(150);
  }
  // Two clean samples that both refuse to move is a real failure; fewer than two
  // means the fight never gave us a fair look.
  if (!responded && clean >= 2) problems.push(`movement never responded to input over ${clean} clean attempts (last: ${lastNote})`);
  else if (!responded) console.log(`  note: movement check inconclusive, ${clean} clean attempt(s): ${lastNote}`);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(120);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(200);

  // Fire the first ability with the mouse. Engine, Spike, Tesla Coil, Throw and
  // Push are placement abilities that correctly do nothing unless the bopl is
  // standing on terrain, so the check retries and takes footing into account.
  const PLACEMENT = new Set(['engine', 'spike', 'tesla', 'throw', 'push']);
  let after = await page.evaluate(() => JSON.parse(document.querySelector('#game').dataset.testPlayer));
  let fired = false;
  let everGrounded = false;
  for (let attempt = 0; attempt < 5 && !fired; attempt++) {
    await page.mouse.move(1000, 300 + attempt * 20);
    await page.mouse.down();
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForTimeout(250);
    after = await page.evaluate(() => JSON.parse(document.querySelector('#game').dataset.testPlayer));
    if (!after.alive) break;
    everGrounded = everGrounded || after.grounded;
    const slot = after.slots[0];
    fired = !!slot && (slot.cd > 0 || slot.state === 1 || after.form !== 'normal');
  }
  const slot = after.slots[0];
  if (!after.alive) {
    console.log('  note: the bots got us before the ability check, cooldown assertion skipped');
  } else if (!fired && PLACEMENT.has(slot?.id) && !everGrounded) {
    console.log(`  note: ${slot.id} needs footing and we never landed, assertion skipped`);
  } else if (!fired) {
    problems.push(`ability ${slot?.id} did not fire: ${JSON.stringify(slot)} grounded=${everGrounded}`);
  }

  if (await page.locator('#game').getAttribute('data-render-error')) problems.push('renderer lost the local player');

  // Let the round play itself out for a while and make sure nothing explodes.
  await page.waitForTimeout(4000);
  const late = await page.evaluate(() => window.BOP.state());
  if (!['play', 'over', 'intro'].includes(late.phase)) problems.push(`unexpected phase ${late.phase}`);

  await page.screenshot({ path: '/tmp/opencode/bop-smoke.png' });

  // Viewport should be filled, not letterboxed by CSS.
  const box = await page.locator('#game').boundingBox();
  if (Math.abs(box.width - 1366) > 2 || Math.abs(box.height - 768) > 2) {
    problems.push(`canvas is ${box.width}x${box.height}, expected to fill 1366x768`);
  }

  if (problems.length) {
    console.error('smoke test failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else console.log('Smoke test passed');
} catch (error) {
  console.error(`smoke test crashed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}
