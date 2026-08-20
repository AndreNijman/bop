// Produces the 1000x525 hub card and the 1200x630 social image.
//
// Both are screenshots of a real practice round, so the marketing image cannot
// drift away from what the game actually looks like.
//
//   node tools/card-shot.mjs

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const server = spawn('npx', ['serve', '.', '-l', '4174'], { stdio: 'ignore' });
const url = 'http://127.0.0.1:4174';

async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('static server never became ready');
}

const browser = await chromium.launch({ headless: true });
try {
  await ready();
  for (const shot of [{ w: 1000, h: 525, path: 'card.png' }, { w: 1200, h: 630, path: 'og-image.png' }]) {
    const page = await browser.newPage({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.fill('#player-name', 'Andre');
    await page.click('#play-offline');
    await page.locator('#draft .card').first().waitFor({ timeout: 10000 });
    await page.locator('#draft .card').first().click();
    await page.waitForFunction(() => window.BOP.state().phase === 'play', null, { timeout: 10000 });
    // Let the bots spread out and start throwing things around.
    await page.waitForTimeout(5200);
    await page.screenshot({ path: shot.path });
    console.log(`wrote ${shot.path} (${shot.w}x${shot.h})`);
    await page.close();
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
