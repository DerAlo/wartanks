// Garage crew / XP flow: node tests/playwright.crew.mjs [baseUrl]  (needs `node server.js`)
// Injects a profile with XP (luchs elite: pz4h researched), converts 1000 + the rest the credits allow to free XP, trains the crew,
// learns 'Feinabstimmung', checks that the shown dispersion drops 8 %, then starts a training battle
// and checks that the player's tank carries the perk. Screenshots: tests/out/crew-*.png.
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5173/';
fs.mkdirSync('tests/out', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const fail = (msg) => { console.error('FAIL', msg); process.exitCode = 1; };

await page.goto(base);
await page.waitForFunction(() => window.__game?.menu, null, { timeout: 20000 });
// profile injection: luchs owned + 6000 tank XP, pz4h researched (luchs is elite)
await page.evaluate(async () => {
   const P = window.__game.mods.progressM, p = P.newProfile();
   p.tanks.luchs.xp = 6000; p.tanks.pz4h.researched = true; p.credits = 200000;
   P.saveProfile(p); window.__game.menu._prof = null;
   window.__game.menu.sel.cls = 'luchs';
});
await page.click('[data-a=garage]'); await page.waitForTimeout(1200);
await page.click('[data-tank=luchs]'); await page.waitForTimeout(300);
const disp = () => page.evaluate(() => [...document.querySelectorAll('#pz-stats .pz-kv')].find((e) => e.textContent.includes('Streuung auf 100 m'))?.lastElementChild.textContent);
const d0 = await disp();
if (!(await page.isVisible('[data-a=convert]'))) fail('no convert button on an elite tank');
await page.screenshot({ path: 'tests/out/crew-1-garage.png' });
// convert part: limit credits so not everything goes
await page.evaluate(() => { const m = window.__game.menu; m.prof().credits = 3000 * 25; m.renderStats(); });
await page.click('[data-a=convert][data-v="1000"]'); await page.waitForTimeout(100);
await page.click('[data-a=convert][data-v=all]'); await page.waitForTimeout(200);
const afterConv = await page.evaluate(() => { const p = window.__game.menu.prof(); return { xp: p.tanks.luchs.xp, free: p.freeXP, cr: p.credits }; });
console.log('after convert', afterConv);
if (afterConv.xp !== 3000 || afterConv.free !== 3000 || afterConv.cr !== 0) fail('conversion ' + JSON.stringify(afterConv));
await page.click('[data-a=help]'); await page.waitForTimeout(200);
await page.screenshot({ path: 'tests/out/crew-2-help.png' });
await page.click('[data-a=closeHelp]');
await page.click('[data-a=crew]'); await page.waitForTimeout(200);
await page.click('[data-a=trainCrew]'); await page.waitForTimeout(200);
const cs = await page.evaluate(() => window.__game.mods.progressM.crewState(window.__game.menu.prof(), 'luchs'));
console.log('crew', cs.xp, cs.points, cs.free);
if (cs.xp !== 3000 || cs.points !== 2) fail('crew training');
await page.click('[data-a=perk][data-v=feinabstimmung]'); await page.waitForTimeout(200);
await page.click('[data-a=perk][data-v=adlerauge]'); await page.waitForTimeout(200);
await page.screenshot({ path: 'tests/out/crew-3-perks.png' });
await page.click('[data-a=closeCrew]'); await page.waitForTimeout(200);
const d1 = await disp();
console.log('dispersion shown', d0, '->', d1);
const num = (s) => parseFloat(String(s).replace(',', '.'));
if (!(Math.abs(num(d1) - num(d0) * 0.92) < 0.002)) fail('shown dispersion did not drop 8 %');
await page.screenshot({ path: 'tests/out/crew-4-stats.png' });
// a training battle: the tank carries the perks
await page.click('[data-set=mode][data-v=training]');
await page.click('[data-a=go]');
await page.waitForFunction(() => window.__game?.world?.player, null, { timeout: 20000 });
await page.waitForTimeout(1500);
const pl = await page.evaluate(() => { const t = window.__game.world.player; return { perks: t.perks, base: t.baseDisp, disp: t.cfg.gun.disp }; });
console.log('player', pl);
if (pl.perks.join() !== 'feinabstimmung,adlerauge' || Math.abs(pl.base - pl.disp * 0.92) > 1e-9) fail('perks not in battle');
console.log(errors.length ? 'console errors:\n' + errors.join('\n') : 'no console errors');
if (errors.length) process.exitCode = 1;
await browser.close();
