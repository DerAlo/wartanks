// Armour geometry + ballistics rules. Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { TANKS } from '../game/config.js';
import { buildArmor, rayArmor, effective } from '../game/armor.js';
import { penAt, rollPen, ricochets, normalisation, resolveImpact, heSplash, solveElevation } from '../game/ballistics.js';
import { makeRng, poseMatrix, mulMat3 } from '../game/utils.js';

const pose = (yaw = 0, extra = {}) => ({ pos: { x: 0, y: 0, z: 0 }, yaw, pitch: 0, roll: 0, turretYaw: 0, gunPitch: 0, ...extra });
const round = (cfg, type) => cfg.gun.ammo.find((a) => a.type === type);

/** World ray that hits hull-local point `p` coming from 60 m away along world dir `d`. */
function rayAt(ps, p, d) {
   const m = poseMatrix(new Float64Array(9), ps.yaw, ps.pitch, ps.roll);
   const w = mulMat3({ x: 0, y: 0, z: 0 }, m, { x: p[0], y: p[1], z: p[2] });
   return { o: { x: w.x - d.x * 60, y: w.y - d.y * 60, z: w.z - d.z * 60 }, d };
}
/** Midpoint of the profile edge carrying `plate` (hull-local, x = 0). */
function plateMid(cfg, plate) {
   const P = cfg.hull.profile, i = P.findIndex((p) => p.plate === plate), a = P[i], b = P[(i + 1) % P.length];
   return [0, (a.y + b.y) / 2, (a.z + b.z) / 2];
}
const fromFront = { x: 0, y: 0, z: 1 };   // shell flying south, hits a tank facing north

test('effective thickness = t / cos(angle)', () => {
   assert.equal(effective(100, 0), 100);
   assert.ok(Math.abs(effective(100, 60) - 200) < 1e-9);
});

test('every tank builds closed armour and front shots hit the front', () => {
   for (const cfg of Object.values(TANKS)) {
      if (cfg.site) continue;                  // campaign emplacements: covered in campaign.test.mjs
      const A = buildArmor(cfg);
      assert.ok(A.boundR > 2 && A.boundR < 10, cfg.id + ' boundR ' + A.boundR);   // < 10: the Leopard's 6 m L/55 reaches past 9
      for (const part of A.parts) for (let k = 0; k < part.planes.length; k += 4) {
         const c = part.center, P = part.planes;   // the centre is inside every plane
         assert.ok(P[k] * c[0] + P[k + 1] * c[1] + P[k + 2] * c[2] <= P[k + 3] + 1e-6, cfg.id + ' ' + part.name);
      }
      const pm = plateMid(cfg, 'ufp'); pm[0] = cfg.gun.mount === 'hull' && cfg.gun.pivot.x > 0.4 ? -0.7 : 0.7;   // beside a casemate / sponson gun
      const { o, d } = rayAt(pose(), pm, fromFront);
      const h = rayArmor(A, pose(), o, d);
      assert.ok(h.length > 0, cfg.id + ' no hit');
      assert.equal(h[0].part, 'hull', cfg.id);
      assert.equal(h[0].plateId, 'ufp', cfg.id);
      for (let i = 1; i < h.length; i++) assert.ok(h[i].dist >= h[i - 1].dist);
   }
});

test('Tiger front: ~100 mm at 0 deg, ~200 mm when angled 60 deg', () => {
   const cfg = TANKS.tiger1, A = buildArmor(cfg);
   const p0 = pose(0), r0 = rayAt(p0, plateMid(cfg, 'ufp'), fromFront);
   const h0 = rayArmor(A, p0, r0.o, r0.d)[0];
   assert.equal(h0.plateId, 'ufp');
   assert.equal(h0.t, 100);
   assert.ok(h0.effT >= 100 && h0.effT < 108, 'effT ' + h0.effT);
   const p60 = pose(60 * Math.PI / 180), r60 = rayAt(p60, plateMid(cfg, 'ufp'), fromFront);
   const h60 = rayArmor(A, p60, r60.o, r60.d)[0];
   assert.equal(h60.plateId, 'ufp');
   assert.ok(h60.angleDeg > 58 && h60.angleDeg < 64, 'angle ' + h60.angleDeg);
   assert.ok(h60.effT > 195 && h60.effT < 235, 'effT ' + h60.effT);
   // a Tiger AP round (145 mm) goes through at 0 deg and fails at 60 deg (no ricochet below 70)
   const rng = makeRng(1), ap = round(cfg, 'AP');
   const shell = { type: 'AP', cal: ap.cal, dmg: ap.dmg, pen: ap.pen };
   assert.equal(resolveImpact({ armor: A, pose: p0 }, r0.o, r0.d, shell, rng).kind, 'pen');
   const r = resolveImpact({ armor: A, pose: p60 }, r60.o, r60.d, shell, rng);
   assert.equal(r.kind, 'noPen');
   assert.equal(r.dmg, 0);
   assert.ok(r.effT < h60.effT, 'normalisation lowers effT');
});

test('T-34 glacis: no ricochet head-on, ricochets when the hull is angled', () => {
   const cfg = TANKS.t34_76, A = buildArmor(cfg), ap = round(TANKS.pz4h, 'AP');   // 7.5 cm KwK 40
   const shell = { type: 'AP', cal: ap.cal, dmg: ap.dmg, pen: ap.pen };
   const at = (deg, seed = 3) => {
      const ps = pose(deg * Math.PI / 180), r = rayAt(ps, plateMid(cfg, 'ufp'), fromFront);
      return resolveImpact({ armor: A, pose: ps }, r.o, r.d, shell, makeRng(seed));
   };
   const head = at(0);
   assert.notEqual(head.kind, 'ricochet');
   assert.ok(head.angleDeg > 55 && head.angleDeg < 65, 'glacis angle ' + head.angleDeg);
   assert.equal(at(50).kind, 'ricochet');
   assert.ok(at(50).ricDir, 'ricochet direction');
   // ricochet chance over random hull angles: some but not all bounce
   const rng = makeRng(7);
   let ric = 0;
   for (let i = 0; i < 200; i++) if (at(rng.range(-60, 60), i).kind === 'ricochet') ric++;
   assert.ok(ric > 30 && ric < 170, 'ricochets ' + ric);
   assert.equal(ricochets('AP', 122, 45, 72), true);   // 122 < 3 x 45: no overmatch
});

test('Overmatch: 122 mm vs 40 mm roof never ricochets, 100 mm does', () => {
   assert.equal(ricochets('AP', 122, 40, 85), false);
   assert.equal(ricochets('AP', 100, 40, 85), true);
   assert.equal(ricochets('HE', 50, 40, 89), false);
   assert.ok(normalisation('AP', 122, 40) > normalisation('AP', 122, 100));
   // geometric: a grazing hit on the Tiger's 25 mm hull roof
   const cfg = TANKS.tiger1, A = buildArmor(cfg), ps = pose();
   // across the hull from the left, 8 deg down, onto the roof ahead of the turret
   const d = { x: Math.cos(8 * Math.PI / 180), y: -Math.sin(8 * Math.PI / 180), z: 0 };
   const front = cfg.hull.profile.find((q) => q.plate === 'roof');
   const r = rayAt(ps, [0, cfg.hull.roofY, front.z + 0.25], d);
   const big = resolveImpact({ armor: A, pose: ps }, r.o, r.d, { type: 'AP', cal: 88, dmg: 220, pen: 145 }, makeRng(1));
   assert.equal(big.plateId, 'roof');
   assert.ok(big.angleDeg > 80, 'grazing ' + big.angleDeg);
   assert.equal(big.overmatch, true);
   assert.notEqual(big.kind, 'ricochet');
   const small = resolveImpact({ armor: A, pose: ps }, r.o, r.d, { type: 'AP', cal: 75, dmg: 135, pen: 150 }, makeRng(1));
   assert.equal(small.kind, 'ricochet');
});

test('APCR loses more pen with distance than AP; +-25 % roll', () => {
   const g = TANKS.panther.gun, ap = g.ammoByType.AP, apcr = g.ammoByType.APCR;
   assert.equal(penAt(apcr, 50), apcr.pen);
   assert.equal(penAt(apcr, 100), apcr.pen);
   assert.ok(Math.abs(penAt(apcr, 300) - (apcr.pen + apcr.pen500) / 2) < 1e-9);
   assert.equal(penAt(apcr, 650), apcr.pen500);
   const lossApcr = 1 - penAt(apcr, 500) / apcr.pen, lossAp = 1 - penAt(ap, 500) / ap.pen;
   assert.ok(lossApcr > lossAp * 1.5, `APCR ${lossApcr} vs AP ${lossAp}`);
   assert.equal(penAt({ type: 'HEAT', pen: 100 }, 500), 100);
   const rng = makeRng(5);
   let lo = Infinity, hi = 0;
   for (let i = 0; i < 2000; i++) { const p = rollPen(ap, 100, rng); lo = Math.min(lo, p); hi = Math.max(hi, p); }
   assert.ok(lo >= ap.pen * 0.75 - 1e-9 && hi <= ap.pen * 1.25 + 1e-9);
   assert.ok(lo < ap.pen * 0.85 && hi > ap.pen * 1.15);
});

test('HE splash hurts a light tank, not a heavy one', () => {
   const he = round(TANKS.is2, 'HE');                 // 122 mm
   const shell = { type: 'HE', cal: he.cal, dmg: he.dmg, pen: he.pen };
   const burst = (id) => {
      const cfg = TANKS[id], A = buildArmor(cfg), ps = pose();
      const p = { x: -(cfg.hull.w / 2 + 1.0), y: 0.4, z: 0 };   // 1 m off the left side
      return heSplash({ armor: A, pose: ps }, p, shell, makeRng(2));
   };
   const light = burst('luchs'), heavy = burst('tiger1');
   assert.equal(light.kind, 'he');
   assert.ok(light.dmg > 40, 'luchs splash ' + light.dmg);
   assert.ok(heavy.dmg < light.dmg / 2, 'tiger splash ' + heavy.dmg);
   // direct HE hit on the Luchs' thin side
   const cfg = TANKS.luchs, A = buildArmor(cfg), ps = pose();
   const r = rayAt(ps, [0, cfg.hull.roofY - 0.15, 0.3], { x: 1, y: 0, z: 0 });
   const res = resolveImpact({ armor: A, pose: ps }, r.o, r.d, shell, makeRng(4));
   assert.ok(res.kind === 'pen' || res.kind === 'he');
   assert.ok(res.dmg > 150, 'direct HE ' + res.kind + ' ' + res.dmg);
});

test('a direct HE hit on thick armour still does a little damage', () => {
   const he = round(TANKS.t34_76, 'HE');
   const shell = { type: 'HE', cal: he.cal, dmg: he.dmg, pen: he.pen };
   const cfg = TANKS.tiger1, A = buildArmor(cfg), ps = pose();
   const r = rayAt(ps, [0, cfg.hull.roofY - 0.3, 0], { x: 1, y: 0, z: 0 });
   const res = resolveImpact({ armor: A, pose: ps }, r.o, r.d, shell, makeRng(4));
   assert.equal(res.kind, 'he');
   assert.ok(res.dmg > 0 && res.dmg < he.dmg / 2, 'tiger side HE ' + res.dmg);
});

test('the commander cupola is a weak spot: a medium gun gets through it on a Tiger and a Tiger II', () => {
   const ap = round(TANKS.t34_76, 'AP');
   for (const id of ['tiger1', 'tiger2', 'kv1', 'pz4h']) {
      const cfg = TANKS[id], T = cfg.turret, C = T.cupola, A = buildArmor(cfg), ps = pose();
      assert.ok(C, id + ' has a cupola');
      const p = [T.x + C.x, T.y + C.y, T.z + C.z];
      const r = rayAt(ps, p, fromFront);
      const hits = rayArmor(A, ps, r.o, r.d);
      assert.equal(hits[0].part, 'cupola', id + ' first plate ' + hits[0].part);
      const res = resolveImpact({ armor: A, pose: ps }, r.o, r.d, { type: 'AP', cal: ap.cal, dmg: ap.dmg, pen: penAt(ap, 300) }, makeRng(2));
      assert.equal(res.kind, 'pen', id + ' cupola ' + res.kind + ' eff ' + res.effT);
      assert.ok(res.dmg > 0);
   }
});

test('HEAT loses pen through spaced armour (skirts)', () => {
   const cfg = TANKS.panther, A = buildArmor(cfg), ps = pose();
   const heat = { type: 'HEAT', cal: 75, dmg: 110, pen: 100 };
   const y = cfg.skirts.y0 + cfg.skirts.h / 2;
   const r = rayAt(ps, [cfg.skirts.x, y, 0.2], { x: -1, y: 0, z: 0 });
   const hits = rayArmor(A, ps, r.o, r.d);
   assert.equal(hits[0].part, 'skirt');
   const res = resolveImpact({ armor: A, pose: ps }, r.o, r.d, heat, makeRng(1));
   assert.ok(res.pen < 100, 'HEAT pen after skirt ' + res.pen);
});

test('post-penetration damages modules / crew', () => {
   const cfg = TANKS.t34_76, A = buildArmor(cfg), ps = pose();
   const shell = { type: 'AP', cal: 128, dmg: 490, pen: 250 };
   let crits = 0;
   for (let i = 0; i < 20; i++) {
      const r = rayAt(ps, [(i % 5 - 2) * 0.3, cfg.hull.roofY - 0.3, (i / 5 | 0) * 0.8 - 1.5], { x: 1, y: 0, z: 0 });
      const res = resolveImpact({ armor: A, pose: ps }, r.o, r.d, shell, makeRng(i));
      assert.equal(res.kind, 'pen');
      crits += res.crits.length;
   }
   assert.ok(crits >= 3, 'crits ' + crits);
});

test('elevation solve lands on the target', () => {
   const v = 800, dx = 400, dy = 3;
   const a = solveElevation(v, dx, dy);
   const t = dx / (v * Math.cos(a));
   const y = v * Math.sin(a) * t - 0.5 * 9.81 * t * t;
   assert.ok(Math.abs(y - dy) < 1e-6);
   assert.ok(Number.isNaN(solveElevation(100, 5000, 0)));
});
