// Campaign operations in the browser: node tests/playwright.campaign.mjs [ops,comma|all] [baseUrl]  (needs `node server.js`)
// Per op: autostart it, render a few seconds, then hand the player's tank to a bot (the headless autopilot)
// and fast-forward the sim inside the page until the op ends, logging every radio line and objective change:
// the scripted twists must fire and the op must be winnable. A second start checks the loss path (the
// player's tank is destroyed -> GESCHEITERT -> results). Fails on any console error (except 404s).
// Screenshots: tests/out/op-<id>-*.png.
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[3] || 'http://localhost:5173/';
fs.mkdirSync('tests/out', { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/404|Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const fail = (msg) => { console.error('FAIL', msg); process.exitCode = 1; };

await page.goto(base);
await page.waitForFunction(() => window.__game?.menu, null, { timeout: 20000 });
const all = await page.evaluate(async () => (await import('/game/campaign.js')).OP_LIST);
const ops = !process.argv[2] || process.argv[2] === 'all' ? all : process.argv[2].split(',');

for (const op of ops) {
   const e0 = errors.length;
   const tank = await page.evaluate(async (op) => (await import('/game/campaign.js')).OPS[op].tanks[0], op);
   await page.goto(`${base}?autostart&mode=campaign&op=${op}&tank=${tank}`);
   await page.waitForFunction(() => window.__game?.world?.campaign && window.__game.world.phase === 'playing', null, { timeout: 30000 });
   await page.waitForTimeout(2500);
   await page.screenshot({ path: `tests/out/op-${op}-start.png` });
   // win path: the autopilot plays the op, the sim is stepped inside the page in slices
   const run = await page.evaluate(async () => {
      const G = window.__game, w = G.world, S = w.script, { BotAI } = await import('/game/ai.js');
      const p = w.player, ai = new BotAI(w, p); w.ais.push(ai); p.ai = ai; S.autopilot = true; S._pilot = true;
      ai.careful = true; ai.D = { ...ai.D, err: 0.3, react: 0.5, aimWait: 2.5, convK: 1.2, smart: 1, angle: true };
      const g = S.c.markers.find((m) => m.id === 'goal'); if (g) S.order([p], { kind: 'advance', x: g.x, z: g.z });
      G.paused = true;                                   // the frame loop only renders while we step
      const log = [], phases = new Set([S.c.phase]); let last = w.seq;
      for (let k = 0; k < 1500 && w.phase === 'playing'; k++) {
         for (let i = 0; i < 60 && w.phase === 'playing'; i++) w.update(1 / 60);
         for (let q = last + 1; q <= w.seq; q++) { const e = w.events[q % 256]; if (e?.seq === q && (e.type === 'radio' || e.type === 'objective')) log.push(Math.round(e.t) + (e.type === 'objective' ? ` [${e.id}:${e.state}] ` : ' » ') + e.text); }
         last = w.seq; phases.add(S.c.phase);
         if (k % 20 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      G.paused = false;
      return { outcome: w.result?.outcome, reason: w.result?.reason, t: Math.round(w.time), stars: w.result?.campaign?.stars, phases: [...phases], log };
   });
   console.log(`${op}: ${run.outcome} (${run.reason}) ${run.t} s, stars ${run.stars}, phases ${run.phases.join(' > ')}`);
   if (process.env.V) for (const l of run.log) console.log('   ', l);
   if (run.outcome !== 'win') fail(op + ': autopilot did not win (' + run.reason + ')');
   await page.waitForSelector('#pz-results.on', { timeout: 20000 }).catch(() => fail(op + ': no results screen after the win'));
   await page.screenshot({ path: `tests/out/op-${op}-won.png` });
   // loss path: start again, destroy the player's tank
   await page.goto(`${base}?autostart&mode=campaign&op=${op}&tank=${tank}`);
   await page.waitForFunction(() => window.__game?.world?.campaign && window.__game.world.phase === 'playing', null, { timeout: 30000 });
   await page.waitForTimeout(1500);
   const lost = await page.evaluate(() => {
      const w = window.__game.world, p = w.player; p.hp = 1;
      p.takeDamage ? p.takeDamage(50, null) : (p.hp = 0, p.alive = false);
      if (p.alive) { p.hp = 0; p.alive = false; }
      for (let i = 0; i < 120 && w.phase === 'playing'; i++) w.update(1 / 60);
      return { outcome: w.result?.outcome, reason: w.result?.reason };
   });
   if (lost.outcome !== 'loss') fail(op + ': destroying the player did not lose (' + JSON.stringify(lost) + ')');
   await page.waitForTimeout(1200);
   await page.screenshot({ path: `tests/out/op-${op}-lost.png` });
   await page.waitForSelector('#pz-results.on', { timeout: 20000 }).catch(() => fail(op + ': no results screen after the loss'));
   if (errors.length > e0) fail(op + ': console errors:\n  ' + errors.slice(e0).join('\n  '));
}
await browser.close();
console.log(process.exitCode ? 'FAILED' : 'OK', errors.length ? errors.length + ' console errors' : 'no console errors');
