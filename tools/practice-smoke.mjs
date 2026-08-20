// Practice lifecycle smoke test.
//
// Runs real rounds through the browser, confirms that loser editing returns to
// the current fight, scores once, starts round two, and resets cleanly after
// repeated rematches.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const target = 'http://127.0.0.1:4174';
const server = spawn('npx', ['serve', '.', '-l', '4174'], { stdio: 'ignore' });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(target)).ok) return; } catch {}
    await wait(200);
  }
  throw new Error('practice server never became ready');
}

const browser = await chromium.launch({ headless: true });
const problems = [];

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
  page.on('pageerror', error => problems.push(`page error: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('requestfailed', request => problems.push(`request failed: ${request.url()}`));
  return page;
}

async function driveKeyboardOutOfBounds(page) {
  await page.keyboard.down('KeyD');
  let alive = true;
  for (let i = 0; i < 12 && alive; i++) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(120);
    await page.keyboard.up('Space');
    await page.waitForTimeout(580);
    alive = await page.evaluate(() => JSON.parse(document.querySelector('#game').dataset.testPlayer).alive);
  }
  await page.keyboard.up('KeyD');
  return !alive;
}

try {
  await ready();

  // Calm bots isolate the eliminated-player editor. Repeated rightward jumps
  // deliberately carry the local bopl out of bounds.
  const editorPage = await newPage();
  await editorPage.goto(`${target}/?_games_frame=1&calm=1&kit=dash,dash,dash&map=meadow`);
  await editorPage.fill('#player-name', 'Editor');
  await editorPage.click('#play-offline');
  await editorPage.waitForFunction(() => window.BOP.state().round === 1 && window.BOP.state().phase === 'play');
  await driveKeyboardOutOfBounds(editorPage);
  await editorPage.waitForFunction(() => window.BOP.state().screen === 'draft', null, { timeout: 5000 }).catch(() => {});
  const editorState = await editorPage.evaluate(() => window.BOP.state());
  if (editorState.screen !== 'draft' || (await editorPage.locator('#draft-timer').textContent()) !== 'eliminated') {
    problems.push('local elimination did not open the next-round loadout editor');
  } else {
    await editorPage.locator('#draft .ready-loadout').click();
    await editorPage.waitForTimeout(700);
    const resumed = await editorPage.evaluate(() => window.BOP.state());
    if (resumed.round !== 1 || resumed.screen !== 'play' || resumed.phase !== 'play') {
      problems.push(`eliminated-player Ready started round ${resumed.round} instead of resuming round one`);
    }
  }
  await editorPage.close();

  const page = await newPage();
  await page.goto(`${target}/?_games_frame=1&kit=grapple,dash,blink&map=meadow`);
  await page.fill('#player-name', 'Lifecycle');
  await page.click('#play-offline');
  await page.waitForFunction(() => window.BOP.state().round === 1 && window.BOP.state().phase === 'play');

  let handledElimination = false;
  let scored = false;
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.BOP.state());
    const wins = state.roster.map(record => record.wins);
    const totalWins = wins.reduce((sum, value) => sum + value, 0);

    if (state.screen === 'results') {
      problems.push(`practice reached match results after round one (${wins.join(',')})`);
      break;
    }
    if (state.round > 1 && totalWins === 0) {
      problems.push(`eliminated-player Ready skipped to round ${state.round} before scoring round one`);
      break;
    }
    if (state.screen === 'draft' && !handledElimination && (await page.locator('#draft-timer').textContent()) === 'eliminated') {
      const round = state.round;
      await page.locator('#draft .ready-loadout').click();
      handledElimination = true;
      await page.waitForTimeout(700);
      const resumed = await page.evaluate(() => window.BOP.state());
      if (resumed.round !== round || resumed.screen !== 'play') {
        problems.push(`eliminated-player Ready started round ${resumed.round} instead of resuming round ${round}`);
        break;
      }
    }
    if (totalWins > 0) {
      if (state.round !== 1) problems.push(`first score was recorded in round ${state.round}`);
      if (totalWins !== 1 || Math.max(...wins) !== 1) problems.push(`round one awarded ${totalWins} wins (${wins.join(',')})`);
      scored = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!scored && !problems.length) problems.push('round one did not finish within 75 seconds');

  if (scored) {
    const nextDeadline = Date.now() + 8_000;
    let advanced = false;
    while (Date.now() < nextDeadline) {
      const state = await page.evaluate(() => window.BOP.state());
      if (state.round > 2) {
        problems.push(`round one advanced directly to round ${state.round}`);
        break;
      }
      if (state.round === 2) { advanced = true; break; }
      if (state.screen === 'draft') {
        const readyButton = page.locator('#draft .ready-loadout:not([disabled])');
        if (await readyButton.count()) await readyButton.click();
      }
      await page.waitForTimeout(100);
    }
    if (!advanced && !problems.length) problems.push('round two never started');
  }
  await page.close();

  // The couch settings do not normally offer one-win matches or a second
  // keyboard player. Supplying those values through the existing form gives us
  // a deterministic match-over path without adding production-only test hooks.
  const rematchPage = await newPage();
  await rematchPage.goto(`${target}/?_games_frame=1&calm=1&kit=dash,dash,dash&map=meadow`);
  await rematchPage.click('#open-couch');
  await rematchPage.evaluate(() => {
    const humans = document.querySelector('#couch-humans');
    humans.append(new Option('2', '2'));
    humans.value = '2';
    const wins = document.querySelector('#couch-wins');
    wins.append(new Option('1', '1'));
    wins.value = '1';
    document.querySelector('#couch-start').disabled = false;
  });
  await rematchPage.click('#couch-start');

  for (let match = 1; match <= 2; match++) {
    await rematchPage.waitForFunction(() => {
      const state = window.BOP.state();
      return state.screen === 'play' && state.round === 1 && state.phase === 'play';
    });
    const reset = await rematchPage.evaluate(() => window.BOP.state().roster.every(record => record.wins === 0));
    if (!reset) {
      problems.push(`Play again did not reset scores before match ${match}`);
      break;
    }
    if (!(await driveKeyboardOutOfBounds(rematchPage))) {
      problems.push(`keyboard player did not leave the arena in rematch ${match}`);
      break;
    }
    await rematchPage.waitForFunction(() => window.BOP.state().screen === 'results', null, { timeout: 8000 }).catch(() => {});
    const result = await rematchPage.evaluate(() => window.BOP.state());
    const totalWins = result.roster.reduce((sum, record) => sum + record.wins, 0);
    if (result.screen !== 'results' || result.round !== 1 || totalWins !== 1) {
      problems.push(`match ${match} ended incorrectly on ${result.screen}, round ${result.round}, with ${totalWins} wins`);
      break;
    }
    await rematchPage.click('#again');
  }
  if (!problems.length) {
    await rematchPage.waitForFunction(() => {
      const state = window.BOP.state();
      return state.screen === 'play' && state.round === 1 && state.phase === 'play'
        && state.roster.every(record => record.wins === 0);
    });
  }
  await rematchPage.close();

  if (problems.length) {
    console.error('practice smoke failed:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  } else console.log('Practice lifecycle smoke passed (elimination editor, sequential rounds, repeated rematches)');
} catch (error) {
  console.error(`practice smoke crashed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
