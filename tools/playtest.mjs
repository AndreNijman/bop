// Play the game and report back.
//
// This drives real input through a real browser, rejects sessions that never use
// the requested ability, then dumps telemetry and screenshots for visual review.
//
//   node tools/playtest.mjs                       # a few rounds of everything
//   node tools/playtest.mjs grenade dash beam     # inspect one loadout
//   node tools/playtest.mjs --all                 # one pass per ability
//
// Screenshots land in shots/.

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { ABILITIES } from '../data.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const kit = args.filter(a => !a.startsWith('--'));
mkdirSync('shots', { recursive: true });

const server = spawn('npx', ['serve', '.', '-l', '4173'], { stdio: 'ignore' });
const base = 'http://127.0.0.1:4173';
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server never came up');
}

const browser = await chromium.launch({ headless: true });

// One scripted "session": walk about, jump, aim at the nearest rival, use the
// ability under test repeatedly, and record what the world did.
async function session(page, label, holdMs) {
  const log = { label, events: [], deaths: [], errors: [], forms: new Set(), shots: [] };
  page.on('pageerror', e => log.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') log.errors.push(m.text()); });

  await page.waitForFunction(() => window.BOP.state().phase === 'play', null, { timeout: 15000 });

  // Watch the simulation from inside the page so nothing is missed between polls.
  await page.evaluate(() => {
    window.__watch = { causes: {}, forms: {}, peakBodies: 0, ticks: 0, sizes: [], used: false };
    window.__poll = () => {
      const s = window.BOP.state();
      const canvas = document.querySelector('#game');
      const me = canvas.dataset.testPlayer ? JSON.parse(canvas.dataset.testPlayer) : null;
      window.__watch.peakBodies = Math.max(window.__watch.peakBodies, s.bodies || 0);
      window.__watch.ticks = s.tick || 0;
      if (me) {
        window.__watch.forms[me.form] = (window.__watch.forms[me.form] || 0) + 1;
        window.__watch.sizes.push(me.size);
        const slot = me.slots[0];
        if (slot && (slot.state > 0 || slot.cd > 0)) window.__watch.used = true;
      }
      return { state: s, me, used: window.__watch.used };
    };
  });

  for (let beat = 0; beat < 14; beat++) {
    const dir = beat % 4 < 2 ? 'KeyD' : 'KeyA';
    await page.keyboard.down(dir);
    // Let grounded-only abilities get a clean first attempt before jumping.
    if (beat % 3 === 2) { await page.keyboard.down('Space'); }

    // Aim at whoever is nearest, then use the ability under test.
    const aim = await page.evaluate(() => {
      const s = window.BOP.state();
      if (!s) return null;
      const canvas = document.querySelector('#game');
      const rect = canvas.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    });
    if (aim) {
      const side = beat % 2 ? 0.65 : 0.35;
      await page.mouse.move(aim.w * side, aim.h * (0.42 + (beat % 3) * 0.08));
      await page.mouse.down();
      await page.waitForTimeout(holdMs);
      await page.mouse.up();
    }
    await page.keyboard.up(dir);
    await page.keyboard.up('Space');
    await page.waitForTimeout(220);

    const sample = await page.evaluate(() => window.__poll());
    if (sample?.me) log.forms.add(sample.me.form);
    if (beat === 4) {
      const path = `shots/play-${label}-${beat}.png`;
      await page.screenshot({ path });
      log.shots.push(path);
    }
    if (beat >= 4 && sample?.used) break;
    const phase = sample?.state?.phase;
    if (phase === 'over') break;
    if (sample?.me && !sample.me.alive) {
      // Respawn happens with the next round; keep watching rather than bailing.
      await page.waitForTimeout(400);
    }
  }

  const watch = await page.evaluate(() => window.__watch);
  return { ...log, watch, forms: [...log.forms] };
}

try {
  await ready();
  const loadouts = all
    ? ABILITIES.map(a => [a.id, 'dash', 'grapple'])
    : [kit.length ? kit : ['grenade', 'bow', 'dash']];

  for (const loadout of loadouts) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const url = `${base}/?calm=1&map=meadow&kit=${loadout.join(',')}`;
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.fill('#player-name', 'Playtest');
    await page.click('#play-offline');
    const ability = ABILITIES.find(a => a.id === loadout[0]);
    const hold = ability.kind === 'tap' ? 60 : ability.kind === 'channel' ? 900 : Math.round((ability.charge || 0.6) * 1000 + 120);
    const report = await session(page, loadout[0], hold);
    if (report.errors.length) throw new Error(`${loadout[0]} browser error: ${report.errors[0]}`);
    if (!report.watch.used) throw new Error(`${loadout[0]} never activated`);
    const forms = Object.entries(report.watch.forms).map(([k, v]) => `${k}:${v}`).join(' ');
    const sizes = report.watch.sizes;
    console.log(
      `${loadout[0].padEnd(12)} ticks=${String(report.watch.ticks).padStart(5)} peakBodies=${String(report.watch.peakBodies).padStart(3)}` +
      ` size=${sizes.length ? (Math.min(...sizes) + '..' + Math.max(...sizes)) : '-'} forms=[${forms}]` +
      (report.errors.length ? ` ERRORS=${report.errors.length}: ${report.errors[0].slice(0, 90)}` : '')
    );
    await page.close();
  }
} finally {
  await browser.close();
  stop();
}
