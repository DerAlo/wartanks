// Host migration in the browser: node tests/playwright.migrate.mjs
// Three pages over ?net=local (BroadcastChannel): A creates a co-op game, B and C join, A starts.
// Mid-match A's page is closed without a word (no leave); after the silence B (A's named successor)
// carries the match on, C follows B, the battle clock runs on, C's shots reach B, and the old host's
// tank drives as a bot.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const PORT = 5700 + Math.floor(Math.random() * 300);
const base = `http://localhost:${PORT}/`;
fs.mkdirSync('tests/out', { recursive: true });
const srv = spawn(process.execPath, ['server.js', String(PORT)], { stdio: 'ignore' });
const done = (code) => { try { srv.kill(); } catch { /* gone */ } process.exit(code); };
for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let code = 0;
try {
   const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
   const errs = { A: [], B: [], C: [] };
   const mk = async (tag) => {
      const p = await ctx.newPage();
      await p.addInitScript(() => { window.__netDebug = true; });
      p.on('console', (m) => { if (m.type() === 'error') errs[tag].push(m.text()); if (/\[net\]|Gastgeber/.test(m.text())) console.log(tag, m.text()); });
      p.on('pageerror', (e) => errs[tag].push('pageerror: ' + e.message));
      await p.goto(base + '?q=low&net=local');
      await p.waitForFunction(() => window.__game?.menu, null, { timeout: 30000 });
      return p;
   };
   const A = await mk('A'), B = await mk('B'), C = await mk('C');
   for (const [p, n] of [[A, 'Anna'], [B, 'Bert'], [C, 'Carl']]) {
      await p.click('#pz-mp'); await p.waitForSelector('#mp:not(.hidden) #mp-list');
      await p.fill('#mp-name', n); await p.dispatchEvent('#mp-name', 'change');
   }
   await A.click('#mp-create'); await A.waitForSelector('#mp-create-go');
   await A.fill('#mp-c-name', 'Migtest ' + PORT);
   await A.click('#mp-c-mode button[data-v=coop]');
   await A.selectOption('#mp-c-mission', 'standard'); await A.selectOption('#mp-c-map', 'steppe');
   await A.click('#mp-create-go');
   await A.waitForSelector('#mp-room[data-host="1"]');
   for (const p of [B, C]) {
      await p.waitForFunction((n) => [...document.querySelectorAll('#mp-list li[data-id]')].some((li) => li.textContent.includes(n)), 'Migtest ' + PORT, { timeout: 15000 });
      await p.click(`#mp-list li[data-id]:has-text("Migtest ${PORT}")`); await p.click('#mp-join');
      await p.waitForSelector('#mp-room[data-host="0"]', { timeout: 30000 });
      await p.click('#mp-ready');
   }
   await A.waitForFunction(() => [...document.querySelectorAll('#mp-players .mp-row:not(.me)')].filter((r) => r.dataset.ready === '1').length === 2, null, { timeout: 30000 });
   await A.click('#mp-start');
   for (const p of [A, B, C]) await p.waitForFunction(() => window.__game?.world && window.__game.net, null, { timeout: 120000 });
   await A.evaluate(() => { const w = __game.world; if (w.phase === 'countdown') w.countdown = Math.min(w.countdown, 0.05); });
   for (const p of [A, B, C]) await p.waitForFunction(() => __game.world.phase === 'playing', null, { timeout: 120000 });
   for (const p of [B, C]) await p.evaluate(() => { const i = __game.input; i.enabled = true; i.keys.add('KeyW'); });
   // three pages on one software GL starve each other's message queues (BroadcastChannel messages
   // arrive seconds late): this test is about the netcode, so the pages stop drawing
   for (const p of [A, B, C]) await p.evaluate(() => { if (__game.R) __game.R.warming = true; });
   // the host names a successor and sends it full states
   await A.waitForFunction(() => __game.net.host?.succ && __game.net.host.migs > 2, null, { timeout: 60000 });
   const succ = await A.evaluate(() => __game.net.host.succ);
   const ids = { B: await B.evaluate(() => __game.net.transport.selfId), C: await C.evaluate(() => __game.net.transport.selfId) };
   assert.equal(succ, ids.B, 'B (first client) is the successor');
   const hostTid = await A.evaluate(() => __game.world.player.id);
   const before = await A.evaluate(() => ({ time: __game.world.time, tl: __game.world.timeLeft, alive: __game.world.tanks.filter((t) => t.alive).length }));
   console.log('host state before closing', JSON.stringify(before));
   await A.close();                                      // no leave, no bye: the page is just gone
   const t0 = Date.now();
   await B.waitForFunction(() => __game.net.isHost && __game.net.migrated, null, { timeout: 60000 });
   console.log('B took over after', Date.now() - t0, 'ms', JSON.stringify(await B.evaluate(() => __game.net.migrated)));
   await C.waitForFunction((b) => __game.net.transport.hostId === b && __game.net.replica?.synced, ids.B, { timeout: 30000 });
   console.log('C follows B after', Date.now() - t0, 'ms');
   const mid = await B.evaluate((tid) => { const w = __game.world, t = w.tankById(tid); return { time: w.time, tl: w.timeLeft, ph: w.phase, alive: w.tanks.filter((x) => x.alive).length, oldHost: { alive: t.alive, bot: !!t.ai, x: t.pos.x, z: t.pos.z } }; }, hostTid);
   console.log('B after takeover', JSON.stringify(mid));
   assert.equal(mid.ph, 'playing');
   assert.ok(mid.oldHost.bot || !mid.oldHost.alive, "the old host's tank is a bot");
   assert.ok(Math.abs(mid.tl - before.tl) < 30, 'battle timer carried over');
   // C fires; B (the new host) must count C's shots
   const cTid = await C.evaluate(() => __game.world.player.id);
   const s0 = await B.evaluate((id) => __game.world.tankById(id).stats.shots, cTid);
   for (let k = 0; k < 4; k++) { await C.evaluate(() => { const w = __game.world, me = w.player; if (me.alive && me.reload <= 0) me.fire(w); }); await B.waitForTimeout(3000); }
   const after = await B.evaluate(({ c, h }) => { const w = __game.world; return { shots: w.tankById(c).stats.shots, cAlive: w.tankById(c).alive, cHuman: !w.tankById(c).ai, time: w.time, old: [w.tankById(h).pos.x, w.tankById(h).pos.z, w.tankById(h).alive] }; }, { c: cTid, h: hostTid });
   console.log('B later', JSON.stringify(after), 'C shots before', s0);
   assert.ok(after.time > mid.time + 0.5, 'the battle clock runs on B');   // the pages run at a few frames a second here
   if (after.cAlive) { assert.ok(after.shots > s0, "C's shots reach the new host"); assert.ok(after.cHuman, "C's tank is C's"); }
   const cView = await C.evaluate(() => ({ t: __game.net.replica.latest, ph: __game.world.phase, ended: !!__game.net.ended }));
   assert.ok(!cView.ended && cView.ph === 'playing', 'C is still in the match');
   await B.screenshot({ path: 'tests/out/mp-migrate-b.png' }); await C.screenshot({ path: 'tests/out/mp-migrate-c.png' });
   const bad = [...errs.B, ...errs.C].filter((e) => !/favicon|404/.test(e));
   console.log('console errors', bad.length, bad.slice(0, 5));
   assert.equal(bad.length, 0);
   console.log('OK');
} catch (e) { console.error('FAIL', e); code = 1; }
await browser.close();
done(code);
