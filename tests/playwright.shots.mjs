// Browser smoke + screenshots: node tests/playwright.shots.mjs [baseUrl]
// Starts a battle (?autostart), drives, aims, zooms into the scope, fires; screenshots go to
// tests/out/. Prints console errors, fps and draw calls. Needs `node server.js` running.
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

if (!only || only === 'menu') {
   await page.goto(base);
   await wait(2500);
   await shot('00-menu');
}
await page.addInitScript(() => addEventListener('DOMContentLoaded', () => document.getElementById('gl').addEventListener('webglcontextlost', () => console.error('CTXLOST at frame', window.__game?.frame))));
await page.goto(base + '?autostart' + (process.env.QS || ''));
await page.waitForFunction(() => window.__game?.world, null, { timeout: 20000 });
await page.evaluate(() => { window.__game.input.noLock = true; window.__game.input.forceAim = true; });
await wait(3000);
await stats('start'); await shot('01-start');
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
console.log('errors:', errors.length ? errors.slice(0, 15).join('\n') : 'none');
await browser.close();
