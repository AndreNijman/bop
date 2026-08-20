// Solo browser smoke test.
//
// Boots the real page, plays a practice round through the public UI, and fails
// on any console error, page error or failed request.
//
//   node tools/smoke.mjs [--headed] [url]

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const headed = process.argv.includes('--headed');
const url = process.argv.find(a => a.startsWith('http')) || 'http://127.0.0.1:4173';
const own = !process.argv.find(a => a.startsWith('http'));
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
  if (own) await ready(url);
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', e => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', r => problems.push(`request failed: ${r.url()}`));

  await page.goto(url, { waitUntil: 'networkidle' });

  // The guard sits in front of production; take the guest door.
  const guest = page.locator('.skip button');
  if (await guest.isVisible().catch(() => false)) {
    await page.context().request.post('https://games.andrenijman.com/_guard/skip', {
      form: { name: 'BOP smoke', return: url }, maxRedirects: 0,
    });
    await page.goto(url, { waitUntil: 'networkidle' });
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

  // Drive the real input path so key handling is covered.
  const before = JSON.parse(await page.locator('#game').getAttribute('data-test-player'));
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(700);
  await page.keyboard.up('KeyD');
  const after = JSON.parse(await page.locator('#game').getAttribute('data-test-player'));
  if (!(after.x > before.x + 0.3)) problems.push(`holding D did not move the bopl (${before.x} -> ${after.x})`);

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(120);
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(200);

  // Fire the first ability with the mouse and confirm it goes on cooldown.
  await page.mouse.move(1000, 300);
  await page.mouse.down();
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const used = await page.evaluate(() => {
    const player = JSON.parse(document.querySelector('#game').dataset.testPlayer);
    return player.slots[0];
  });
  if (!used || used.cd <= 0) problems.push(`ability ${used?.id} never went on cooldown after use`);

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
