// Tank model line-up (stub world while state.js is missing): node tests/playwright.models.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('tests/out', { recursive: true });
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto('http://localhost:5173/?autostart&q=high');
await page.waitForFunction(() => window.__game?.world);
const views = [0, 1, 2, 3, 4, 5];
for (let i = 0; i < views.length; i++) {
   await page.evaluate((i) => { const g = window.__game, w = g.world, a = w.tanks[1 + i * 3], b = w.tanks[Math.min(w.tanks.length - 1, 3 + i * 3)];
      const cx = (a.pos.x + b.pos.x) / 2, cz = a.pos.z, h = w.terrain.heightAt(cx, cz + 17);
      g.camOverride = [cx - 3, Math.max(h + 2.5, a.pos.y + 3.5), cz + 15, cx, a.pos.y + 1.2, cz]; }, i);
   await page.waitForTimeout(900);
   await page.screenshot({ path: `tests/out/m${i}.png` });
}
console.log('errors', errors.slice(0, 5));
await browser.close();
