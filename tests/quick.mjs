// quick shot: node quick.mjs "<query>" outname [evalJS]
import { chromium } from 'playwright';
const [qs, name, js] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message + e.stack));
await page.goto('http://localhost:5173/' + qs);
await page.waitForFunction(() => window.__game?.world, null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(2500);
if (js) { console.log('eval:', JSON.stringify(await page.evaluate(js)).slice(0, 1500)); await page.waitForTimeout(1500); }
const info = await page.evaluate(() => { const g = window.__game, i = g?.R.renderer.info; return g && { fps: g.fps.toFixed(0), calls: i.render.calls, tris: i.render.triangles }; });
console.log(JSON.stringify(info));
await page.screenshot({ path: `D:/wartanks/tests/out/${name}.png` });
console.log('errors:', errs.filter((e) => !/404|optional module/.test(e)).slice(0, 8).join('\n') || 'none');
await browser.close();
