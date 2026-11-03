// Multiplayer lobby smoke test (no internet): node tests/playwright.mplobby.mjs
// Starts server.js on a free port, opens two pages of one browser context with ?net=local
// (BroadcastChannel). A names itself and creates a co-op game, B finds it in the list, joins, both
// ready, A starts. window.__game.startNetGame is replaced by a recorder on both pages; the test
// asserts both got a matching session, then ends the match with a fake result (results panel).
// Also checks that a normal page load (no ?net) logs no console errors. Screenshots: tests/out/mp-lobby-*.png
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const PORT = 5300 + Math.floor(Math.random() * 400);
const base = `http://localhost:${PORT}/`;
fs.mkdirSync('tests/out', { recursive: true });
const srv = spawn(process.execPath, ['server.js', String(PORT)], { stdio: 'ignore' });
const done = (code) => { try { srv.kill(); } catch { /* gone */ } process.exit(code); };
for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch { await new Promise(r => setTimeout(r, 100)); } }

const browser = await chromium.launch();
let fail = 0;
try {
   const ctx = await browser.newContext({ viewport: { width: 1500, height: 860 } });
   const errs = { A: [], B: [], plain: [] };
   const mk = async (tag, url) => {
      const p = await ctx.newPage();
      p.on('console', (m) => { if (m.type() === 'error') errs[tag].push(m.text()); });
      p.on('pageerror', (e) => errs[tag].push('pageerror: ' + e.message));
      await p.goto(url);
      await p.waitForFunction(() => window.__game?.menu, null, { timeout: 20000 });
      return p;
   };
   // normal load: no network module, no errors
   const plain = await mk('plain', base);
   await plain.waitForTimeout(1500);
   assert.equal(await plain.evaluate(() => !!window.__mp), false, 'mpui must not load without the button');
   await plain.close();

   const A = await mk('A', base + '?net=local'), B = await mk('B', base + '?net=local');
   const stub = (p) => p.evaluate(() => {
      window.__started = null;
      window.__game.startNetGame = (s) => { window.__started = { mode: s.mode, mission: s.mission, mapId: s.mapId, difficulty: s.difficulty, seed: s.seed, players: s.players, self: s.transport.selfId, isHost: s.transport.isHost }; window.__session = s; };
   });
   await stub(A); await stub(B);

   await A.click('#pz-mp'); await B.click('#pz-mp');
   await A.waitForSelector('#mp:not(.hidden) #mp-list'); await B.waitForSelector('#mp:not(.hidden) #mp-list');
   await A.fill('#mp-name', 'Anna'); await A.press('#mp-name', 'Enter'); await A.dispatchEvent('#mp-name', 'change');
   await B.fill('#mp-name', 'Bert'); await B.dispatchEvent('#mp-name', 'change');

   await A.click('#mp-create'); await A.waitForSelector('#mp-create-go');
   await A.fill('#mp-c-name', 'Testgefecht');
   await A.click('#mp-c-mode button[data-v=coop]');
   await A.selectOption('#mp-c-mission', 'encounter'); await A.selectOption('#mp-c-map', 'dorf'); await A.selectOption('#mp-c-diff', 'schwer');
   await A.click('#mp-create-go');
   await A.waitForSelector('#mp-room[data-host="1"]');

   await B.waitForSelector('#mp-list li[data-id]', { timeout: 10000 });
   await B.screenshot({ path: 'tests/out/mp-lobby-list.png' });
   const entry = await B.evaluate(() => window.__mp.lobby.list()[0]);
   assert.equal(entry.name, 'Testgefecht'); assert.equal(entry.host, 'Anna'); assert.equal(entry.mode, 'coop');
   assert.equal(entry.mission, 'encounter'); assert.equal(entry.mapId, 'dorf'); assert.equal(entry.difficulty, 'schwer');
   await B.click('#mp-list li[data-id]'); await B.click('#mp-join');
   await B.waitForSelector('#mp-room[data-host="0"]');
   await A.waitForFunction(() => document.querySelectorAll('#mp-players .mp-row').length === 2);

   // B picks another of its own tanks, chats and gets ready
   await B.click('#mp-tanks [data-tank]:not(.sel)');
   const bTank = await B.evaluate(() => window.__mp.lobby.me.tank);
   await B.fill('#mp-chat-in', 'Hallo Anna'); await B.click('#mp-chat-send');
   await A.waitForFunction(() => document.querySelector('#mp-chat-log')?.textContent.includes('Hallo Anna'));
   assert.equal(await A.isDisabled('#mp-start'), true, 'start must wait for ready');
   await B.click('#mp-ready');
   await A.waitForFunction(() => document.querySelector('#mp-players .mp-row:not(.me)')?.dataset.ready === '1');
   await A.screenshot({ path: 'tests/out/mp-lobby-room-a.png' });
   await B.screenshot({ path: 'tests/out/mp-lobby-room-b.png' });
   await A.click('#mp-start');

   await A.waitForFunction(() => window.__started, null, { timeout: 10000 });
   await B.waitForFunction(() => window.__started, null, { timeout: 10000 });
   const sa = await A.evaluate(() => window.__started), sb = await B.evaluate(() => window.__started);
   console.log('session A', JSON.stringify(sa)); console.log('session B', JSON.stringify(sb));
   for (const s of [sa, sb]) {
      assert.equal(s.mode, 'coop'); assert.equal(s.mission, 'encounter'); assert.equal(s.mapId, 'dorf'); assert.equal(s.difficulty, 'schwer');
      assert.equal(s.players.length, 2); assert.equal(s.players[0].name, 'Anna'); assert.equal(s.players[1].name, 'Bert');
      assert.ok(Number.isInteger(s.seed) && s.seed >= 0);
   }
   assert.equal(sa.seed, sb.seed); assert.deepEqual(sa.players, sb.players);
   assert.equal(sa.isHost, true); assert.equal(sb.isHost, false);
   assert.equal(sb.players[1].tank, bTank);
   assert.equal(await A.evaluate(() => document.getElementById('mp').classList.contains('hidden')), true, 'overlay hidden in match');

   // end of match -> results panel -> back in the room
   await A.evaluate(() => window.__session.onEnd({ aborted: false, reason: 'Alle Gegner zerstört', victory: true, outcome: 'win', xp: 812, credits: 23400,
      stats: { dmg: 1450, kills: 2, shots: 9, hits: 7, pens: 5, spotted: 3, assist: 240 } }));
   await A.waitForSelector('#mp-result[data-outcome=win]');
   await A.screenshot({ path: 'tests/out/mp-lobby-result.png' });
   await A.click('#mp-result-ok');
   await A.waitForSelector('#mp-room');
   // PvP results table rendering (fake data)
   await B.evaluate(() => window.__session.onEnd({ aborted: false, reason: 'Team 1 hat gewonnen', victory: false, outcome: 'loss', xp: 300, credits: 9000,
      stats: { dmg: 600, kills: 1, shots: 6, hits: 3, pens: 2, spotted: 1, assist: 0 }, pvp: { win: 1, my: 2, pl: [['Anna', 1, 1450, 2, 1], ['Bot 1', 1, 300, 0, 0], ['Bert', 2, 600, 1, 0]] } }));
   await B.waitForSelector('#mp-result[data-outcome=loss] table[data-team="2"]');
   await B.screenshot({ path: 'tests/out/mp-lobby-result-pvp.png' });

   // leave -> back to the main menu
   await B.click('#mp-result-ok'); await B.click('#mp-back');
   await B.waitForSelector('#mp-list'); await B.click('#mp-back');
   await B.waitForFunction(() => document.getElementById('mp').classList.contains('hidden'));

   for (const k of ['plain', 'A', 'B']) if (errs[k].length) { console.log('console errors', k, errs[k]); fail = 1; }
   console.log(fail ? 'FAIL' : 'PASS: mp lobby create/list/join/ready/start/end');
} catch (e) {
   console.error('FAIL', e); fail = 1;
} finally {
   await browser.close();
   done(fail);
}
