// Driving, collision and gunnery tests for game/tank.js on synthetic terrain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Tank, collideTanks } from '../game/tank.js';
import { updateShells } from '../game/ballistics.js';
import { makeRng } from '../game/utils.js';

function flatTerrain(hf = () => 0) {
   return {
      half: 500, water: null, version: 0, lastHit: { type: 'ground', obj: null },
      heightAt: hf, groundIdxAt: () => 1, waterDepth: () => 0, objectsNear: () => [], destroyObject() {},
      raycast(ox, oy, oz, dx, dy, dz, max) {
         for (let d = 0; d < max; d += 0.25) if (oy + dy * d < hf(ox + dx * d, oz + dz * d)) { this.lastHit.type = 'ground'; return d; }
         return null;
      },
   };
}
const mkWorld = (T, tanks = []) => ({ terrain: T, time: 0, rng: makeRng(5), shells: [], tanks, hits: [],
   onShellHit(s, tank, res, p, what) { this.hits.push({ tank, kind: res?.kind, what }); } });
const run = (w, secs, f) => { for (let i = 0; i < secs * 60; i++) { w.time += 1 / 60; f?.(); for (const t of w.tanks) t.update(1 / 60, w); collideTanks(w.tanks, w); updateShells(w, 1 / 60); } };

const ramp = (deg) => (x, z) => Math.max(0, -z - 20) * Math.tan(deg * Math.PI / 180);

test('tank accelerates on flat ground to a plausible top speed', () => {
   const T = flatTerrain(), t = new Tank('t34_76', { x: 0, z: 400, terrain: T }), w = mkWorld(T, [t]);
   t.input.throttle = 1;
   run(w, 4); const v4 = t.speedKmh;
   run(w, 26);
   assert.ok(v4 > 12 && v4 < 45, 'speed after 4 s ' + v4);
   assert.ok(t.speedKmh > 40 && t.speedKmh <= 54 * 1.01, 'top speed ' + t.speedKmh);
});

test('climbs a moderate slope, stalls at a cliff', () => {
   for (const [deg, ok] of [[18, true], [60, false]]) {
      const T = flatTerrain(ramp(deg)), t = new Tank('pz4h', { x: 0, z: 0, terrain: T }), w = mkWorld(T, [t]);
      t.input.throttle = 1;
      run(w, 40);
      const climbed = t.pos.y;
      if (ok) assert.ok(climbed > 15, `${deg}° slope: reached h=${climbed.toFixed(1)}`);
      else assert.ok(climbed < 3, `${deg}° cliff: reached h=${climbed.toFixed(1)}`);
   }
});

test('heavy tank pushes a light tank', () => {
   const T = flatTerrain();
   const heavy = new Tank('tiger2', { x: 0, z: 0, team: 1, terrain: T });
   const light = new Tank('luchs', { x: 0, z: -9, team: 1, terrain: T });
   const w = mkWorld(T, [heavy, light]);
   heavy.input.throttle = 1;
   run(w, 8);
   assert.ok(light.pos.z < -15, 'light pushed to ' + light.pos.z.toFixed(1));
   assert.ok(heavy.pos.z < -5, 'heavy kept going ' + heavy.pos.z.toFixed(1));
   // light ramming the heavy one barely moves it
   const T2 = flatTerrain();
   const h2 = new Tank('tiger2', { x: 0, z: -9, team: 1, terrain: T2 }), l2 = new Tank('luchs', { x: 0, z: 0, team: 1, terrain: T2 });
   const w2 = mkWorld(T2, [h2, l2]);
   l2.input.throttle = 1; run(w2, 8);
   assert.ok(h2.pos.z > -14, 'heavy only nudged to ' + h2.pos.z.toFixed(1));
});

test('converged shot hits a target at 200 m', () => {
   const T = flatTerrain();
   let hitsTotal = 0;
   for (let k = 0; k < 6; k++) {
      const shooter = new Tank('panther', { x: 0, z: 0, terrain: T, team: 1 });
      const target = new Tank('t34_85', { x: 0, z: -200, yaw: Math.PI / 2, terrain: T, team: 2 });
      const w = mkWorld(T, [shooter, target]); w.rng = makeRng(100 + k);
      shooter.aimPoint.x = 0; shooter.aimPoint.y = target.pos.y + 1.2; shooter.aimPoint.z = -200;
      run(w, 8);
      assert.ok(shooter.aimDisp < shooter.baseDisp * 1.1, 'converged ' + shooter.aimDisp);
      const s = shooter.fire(w);
      assert.ok(s, 'fired');
      run(w, 1.5);
      if (w.hits.some((h) => h.tank === target)) hitsTotal++;
      assert.equal(shooter.reload > 0, true);
   }
   assert.ok(hitsTotal >= 5, 'hits ' + hitsTotal + '/6');
});

test('modules, consumables and ammo switching', () => {
   const T = flatTerrain(), t = new Tank('tiger1', { terrain: T }), w = mkWorld(T, [t]);
   assert.equal(t.damageModule('trackL', 999), 'destroyed');
   t.input.throttle = 1; run(w, 2);
   assert.ok(Math.abs(t.speed) < 0.01, 'immobile with a broken track');
   assert.ok(t.useConsumable('repair'));
   assert.equal(t.mod('trackL'), 'ok');
   assert.equal(t.useConsumable('repair'), false, 'cooldown/used');
   t.ignite(null); assert.ok(t.burning); t.useConsumable('extinguisher'); assert.equal(t.burning, false);
   t.reload = 0;
   assert.ok(t.setAmmo('APCR')); assert.equal(t.ammoSel, 'APCR'); assert.ok(t.reload > 0);
});
