// Browser smoke + screenshots: node tests/playwright.shots.mjs [baseUrl]
// Menu -> garage (armour viewer) -> standard battle via the GEFECHT button -> drives, aims, zooms
// into the scope, fires -> pause menu -> results -> garage -> second battle (leak check). Screenshots
// go to tests/out/. QS env = extra query (e.g. &q=low). Prints console errors, fps and draw calls. Needs `node server.js` running.
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:5173/';
const only = process.argv[3] || '';
fs.mkdirSync('tests/out', { recursive: true });
let browser;
const GPU = process.env.NO_GPU ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
try { browser = await chromium.launch({ args: GPU, ...(process.env.CHROME ? { channel: 'chrome' } : {}) }); }
catch { browser = await chromium.launch(); }
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
const wait = (ms) => page.waitForTimeout(ms);
const stats = async (tag) => {
   const s = await page.evaluate(() => { const g = window.__game; const i = g?.R.renderer.info; return g && { fps: g.fps.toFixed(0), calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures, phase: g.world?.phase, pos: g.world?.player && [g.world.player.pos.x.toFixed(1), g.world.player.pos.z.toFixed(1)], aim: g.world?.player?.aimPoint && Object.values(g.world.player.aimPoint).map((v) => v.toFixed(1)) }; });
   console.log(tag, JSON.stringify(s));
};
const shot = async (name) => { await page.screenshot({ path: `tests/out/${name}.png` }); console.log('shot', name); };

const mem = () => page.evaluate(() => { const i = window.__game.R.renderer.info.memory; return { geos: i.geometries, tex: i.textures }; });
await page.addInitScript(() => addEventListener('DOMContentLoaded', () => document.getElementById('gl').addEventListener('webglcontextlost', () => console.error('CTXLOST at frame', window.__game?.frame))));
await page.goto(base + '?' + (process.env.QS || ''));
await page.waitForFunction(() => window.__game?.menu, null, { timeout: 20000 });
await wait(2000); await shot('00-menu');
await page.click('[data-a=garage]'); await wait(1200); await shot('00b-garage');
await page.click('[data-tank=tiger1]'); await page.click('[data-a=armor]'); await wait(300);
await page.mouse.move(800, 330); await wait(700); await shot('00c-armor');
await page.click('[data-a=eff]'); await page.mouse.move(700, 470); await wait(700); await shot('00d-armor-eff');
console.log('armor tip:', await page.textContent('#pz-tip'));
await page.click('[data-a=armor]'); await page.click('.pz-row:not(.lock)');
await page.click('[data-set=mode][data-v=standard]'); await page.selectOption('#pz-map', 'steppe');
const mem0 = await mem(); console.log('mem garage', JSON.stringify(mem0));
await page.click('[data-a=go]');
await page.waitForFunction(() => window.__game?.world, null, { timeout: 20000 });
await page.evaluate(() => { window.__game.input.noLock = true; window.__game.input.forceAim = true; });
await wait(3000);
await stats('start'); await shot('01-start');
await page.waitForFunction(() => window.__game.world.phase !== 'countdown', null, { timeout: 30000 }).catch(() => console.log('still countdown'));
await page.mouse.move(800, 450);
await page.keyboard.down('KeyW'); await wait(2500);
await page.keyboard.down('KeyA'); await wait(1200); await page.keyboard.up('KeyA');
await page.keyboard.up('KeyW'); await wait(400);
await stats('drive'); await shot('02-drive');
// look around: right side and down a bit
for (let i = 0; i < 10; i++) { await page.mouse.move(800 + i * 30, 450 + i * 3); await wait(30); }
await wait(800); await shot('03-look');
// face the nearest enemy and zoom
await page.evaluate(() => {
   const g = window.__game, p = g.world.player, e = g.world.tanks.find((t) => t.team !== p.team);
   if (e) { g.tcam.yaw = Math.atan2(-(e.pos.x - p.pos.x), -(e.pos.z - p.pos.z)); g.tcam.pitch = Math.atan2(e.pos.y + 1.2 - p.pos.y - 2.6, Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z)); }
});
await wait(1500); await shot('04-target');
await page.mouse.wheel(0, -300); await wait(200); await page.mouse.wheel(0, -300); await wait(200); await page.mouse.wheel(0, -300); await wait(1500);
await stats('scope'); await shot('05-scope');
await page.mouse.down(); await wait(60); await page.mouse.up(); await wait(120); await shot('06-fire');
await wait(1500); await shot('07-after');
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 300); await wait(80); }
await wait(1000);
await page.evaluate(() => { const g = window.__game; g.tcam.yaw = g.world.player.yaw + 2.2; g.tcam.pitch = -0.25; g.tcam.level = 4; });
await wait(1200); await shot('08-close');
await page.evaluate(() => { const g = window.__game; g.tcam.yaw = g.world.player.yaw - 0.7; g.tcam.pitch = -0.3; });
await wait(800); await shot('09-front'); await stats('end');
// pause menu
await page.keyboard.press('Escape'); await wait(500); await shot('10-pause');
console.log('paused:', await page.evaluate(() => window.__game.paused));
await page.click('[data-a=resume]'); await wait(400);
// end: wait for a real end of battle briefly, else force the results path
const ended = await page.waitForFunction(() => /won|lost|draw/.test(window.__game.world?.phase || ''), null, { timeout: 3000 }).then(() => true).catch(() => false);
if (!ended) await page.evaluate(() => window.__game.finishBattle());
await page.waitForSelector('#pz-results.on', { timeout: 15000 }); await wait(600); await shot('11-results');
await page.click('[data-a=toGarage]'); await wait(800);
const mem1 = await mem(); console.log('mem after battle 1', JSON.stringify(mem1));
await page.click('[data-a=go]'); await page.waitForFunction(() => window.__game?.world, null, { timeout: 20000 }); await wait(2500);
await page.evaluate(() => window.__game.finishBattle()); await page.waitForSelector('#pz-results.on'); await page.click('[data-a=toGarage]'); await wait(800);
const mem2 = await mem(); console.log('mem after battle 2', JSON.stringify(mem2), mem2.geos - mem1.geos > 20 || mem2.tex - mem1.tex > 4 ? 'LEAK?' : 'stable');
console.log('errors:', errors.length ? errors.slice(0, 15).join('\n') : 'none');
await browser.close();
