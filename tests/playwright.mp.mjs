// Multiplayer match in the browser: node tests/playwright.mp.mjs [local|relay]
// Two pages of one browser context: A creates a co-op game, B joins, both ready, A starts; both drive
// and fire for ~25 s, the host checks B's shells; screenshots tests/out/mp-<net>-{a,b}.png.
// `relay` uses the public MQTT brokers (internet); unreachable brokers are reported, not failed.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const NET = process.argv[2] === 'relay' ? 'relay' : 'local';
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
   const errs = { A: [], B: [] };
   const mk = async (tag) => {
      const p = await ctx.newPage();
      await p.addInitScript(() => { window.__netDebug = true; let last = performance.now(); setInterval(() => { const t = performance.now(); if (t - last > 700) console.log('[net] stall ' + Math.round(t - last) + ' ms ' + (window.__game?.world ? 'world' : 'menu') + (window.__stallTag ? ' ' + window.__stallTag : '')); last = t; }, 100); });
      p.on('console', (m) => { if (m.type() === 'error') errs[tag].push(m.text()); if (/\[net\]/.test(m.text())) console.log(tag, m.text()); });
      p.on('pageerror', (e) => errs[tag].push('pageerror: ' + e.message));
      await p.goto(base + '?q=low&net=' + NET);
      await p.waitForFunction(() => window.__game?.menu, null, { timeout: 30000 });
      return p;
   };
   const A = await mk('A'), B = await mk('B');
   for (const [p, n] of [[A, 'Anna'], [B, 'Bert']]) {
      await p.click('#pz-mp'); await p.waitForSelector('#mp:not(.hidden) #mp-list');
      await p.fill('#mp-name', n); await p.dispatchEvent('#mp-name', 'change');
   }
   await A.click('#mp-create'); await A.waitForSelector('#mp-create-go');
   await A.fill('#mp-c-name', 'Browsertest ' + PORT);
   await A.click('#mp-c-mode button[data-v=coop]');
   await A.selectOption('#mp-c-mission', 'standard'); await A.selectOption('#mp-c-map', 'steppe');
   await A.click('#mp-create-go');
   await A.waitForSelector('#mp-room[data-host="1"]');
   try {
      await B.waitForFunction((n) => [...document.querySelectorAll('#mp-list li[data-id]')].some((li) => li.textContent.includes(n)), 'Browsertest ' + PORT, { timeout: NET === 'relay' ? 45000 : 10000 });
   } catch (e) {
      if (NET === 'relay') { console.log('RELAY: game not found over the brokers (unreachable?):', await B.evaluate(() => document.querySelector('#mp-net')?.textContent)); done(0); }
      throw e;
   }
   const t0 = Date.now();
   await B.click(`#mp-list li[data-id]:has-text("Browsertest ${PORT}")`); await B.click('#mp-join');
   await B.waitForSelector('#mp-room[data-host="0"]', { timeout: 30000 });
   console.log(`joined after ${Date.now() - t0} ms`);
   await B.click('#mp-ready');
   await A.waitForFunction(() => document.querySelector('#mp-players .mp-row:not(.me)')?.dataset.ready === '1', null, { timeout: 30000 });
   await A.click('#mp-start');
   for (const p of [A, B]) await p.waitForFunction(() => window.__game?.world && window.__game.net, null, { timeout: 90000 });
   console.log('match running on both pages', await B.evaluate(() => ({ host: __game.net.isHost, via: __game.net.transport.link?.(__game.net.transport.hostId)?.via })));
   // wait for the countdown, then drive and fire
   const diag = () => Promise.all([A, B].map((p) => p.evaluate(() => ({ ph: __game.world?.phase, cd: __game.world?.countdown, t: __game.world?.time, fps: __game.fps, net: !!__game.net, warm: __game.R?.warming, progs: __game.R?.renderer.info.programs?.length, fr: __game.frame }))));
   const dt = setInterval(async () => { try { console.log('diag', JSON.stringify(await diag())); } catch { /* closing */ } }, 10000);
   // software GL renders both pages at a few frames a second here: skip the countdown on the host
   await A.evaluate(() => { const w = __game.world; if (w.phase === 'countdown') w.countdown = Math.min(w.countdown, 0.05); });
   await A.waitForFunction(() => __game.world.phase === 'playing', null, { timeout: 120000 });
   await B.waitForFunction(() => __game.world.phase === 'playing', null, { timeout: 120000 });
   clearInterval(dt);
   for (const p of [A, B]) await p.evaluate(() => { const i = __game.input; i.enabled = true; i.keys.add('KeyW'); i.keys.add('KeyA'); });
   for (let k = 0; k < 8; k++) {
      for (const p of [A, B]) await p.evaluate(() => { const w = __game.world, me = w.player; if (me.reload <= 0) me.fire(w); });
      await A.waitForTimeout(3000);
   }
   const host = await A.evaluate(() => { const w = __game.world, b = w.tanks.find((t) => t.human && t !== w.player);
      return { bShots: b.stats.shots, bPos: [b.pos.x, b.pos.z], aShots: w.player.stats.shots, aPos: [w.player.pos.x, w.player.pos.z], bMoved: b.speed, net: __game.net.stats(), marks: [...__game.tanks3d.models.values()].reduce((n, m) => n + (m.marks?.length || 0), 0) }; });
   const cli = await B.evaluate(() => { const w = __game.world; const a = w.tanks.find((t) => t.human && t !== w.player);
      return { aPos: [a.pos.x, a.pos.z], me: [w.player.pos.x, w.player.pos.z], fps: __game.fps, net: __game.net.stats(), shells: w.shells.length, ev: w.seq, marks: [...__game.tanks3d.models.values()].reduce((n, m) => n + (m.marks?.length || 0), 0) }; });
   console.log('host view', JSON.stringify({ ...host, net: { up: host.net.up } }));
   console.log('client view', JSON.stringify({ ...cli, net: { down: cli.net.down, up: cli.net.up } }));
   const sec = 24;
   console.log(`bandwidth: host up ${(host.net.up / sec / 1024).toFixed(1)} kB/s, client down ${(cli.net.down / sec / 1024).toFixed(1)} kB/s (incl. countdown)`);
   await A.screenshot({ path: `tests/out/mp-${NET}-a.png` }); await B.screenshot({ path: `tests/out/mp-${NET}-b.png` });
   assert.ok(host.bShots > 0, 'client shots reached the host');
   assert.ok(Math.hypot(host.bPos[0] - cli.me[0], host.bPos[1] - cli.me[1]) < 8, 'client tank position matches the host');
   assert.ok(Math.hypot(host.aPos[0] - cli.aPos[0], host.aPos[1] - cli.aPos[1]) < 8, 'host tank position matches on the client');
   const bad = [...errs.A, ...errs.B].filter((e) => !/WebGL|GPU|favicon|ERR_|WebSocket|mqtt|nostr|relay/i.test(e));
   // rejoin: B reloads mid-match, stays in the host's room meanwhile, and comes back by the list
   if (process.argv.includes('rejoin') || NET === 'local' || NET === 'relay') {
      const bTid = await A.evaluate(() => __game.world.tanks.find((t) => t.human && t !== __game.world.player).id);
      await B.reload();
      await B.waitForFunction(() => window.__game?.menu, null, { timeout: 30000 });
      await A.waitForTimeout(NET === 'relay' ? 13000 : 1500);
      const room = await A.evaluate(() => __mp.lobby.room.players.map((p) => [p.name, !!p.lost]));
      console.log('host room while B is away', JSON.stringify(room));
      assert.ok(room.some(([n]) => n === 'Bert'), 'Bert keeps his place in the running room');
      await B.click('#pz-mp'); await B.waitForSelector('#mp:not(.hidden) #mp-list');
      const back = await B.waitForSelector('#mp-list [data-back]', { timeout: NET === 'relay' ? 45000 : 15000 });
      const t1 = Date.now(); await back.click();
      await B.waitForFunction(() => __game?.world && __game.net && __game.world.phase === 'playing', null, { timeout: 90000 });
      console.log(`back in the match after ${Date.now() - t1} ms`);
      const mine = await B.evaluate(() => __game.world.player.id);
      assert.equal(mine, bTid, 'same tank after the rejoin');
      const s0 = await A.evaluate((id) => __game.world.tankById(id).stats.shots, bTid);
      for (let k = 0; k < 4; k++) { await B.evaluate(() => { const w = __game.world, me = w.player; if (me.alive && me.reload <= 0) me.fire(w); }); await A.waitForTimeout(3000); }
      const after = await A.evaluate((id) => { const t = __game.world.tankById(id); return { shots: t.stats.shots, human: !t.ai, alive: t.alive }; }, bTid);
      console.log('host after rejoin', JSON.stringify(after), 'shots before', s0);
      if (after.alive) assert.ok(after.shots > s0, 'shots after the rejoin reach the host');
      assert.ok(after.human || !after.alive, 'the tank belongs to the captain again');
   }
   console.log('console errors', bad.length, bad.slice(0, 5));
   assert.equal(bad.length, 0);
   console.log('OK');
} catch (e) { console.error('FAIL', e); code = 1; }
await browser.close();
done(code);
