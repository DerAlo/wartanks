// Mission terrain features (game/terrain.js): trenches vs. tank length, dragon's teeth, hedgehogs,
// wire, bridges, determinism of the existing maps, and the Baltic coast map (kueste).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeTerrain, OBJECT_KINDS } from '../game/terrain.js';
import { Tank } from '../game/tank.js';
import { TANKS } from '../game/config.js';
import { makeRng } from '../game/utils.js';
import MAPS from '../game/maps.js';

// tank.js reads the trench through terrain.hullHeightAt(x, z, hullLen) once the lead wires that hook
// in; until then the terrain is wrapped so heightAt already answers for this hull length.
const HOOKED = /hullHeightAt/.test(readFileSync(new URL('../game/tank.js', import.meta.url), 'utf8'));
const forHull = (T, len) => (HOOKED ? T : Object.assign(Object.create(T), { heightAt: (x, z) => T.hullHeightAt(x, z, len) }));

const mkWorld = (T, tanks) => ({ terrain: T, time: 0, rng: makeRng(5), shells: [], tanks, hits: [], onShellHit() {} });
const flatSteppe = () => makeTerrain(1, 'steppe');

/** Drive `cls` north across a 2.5 m × 1.8 m trench at z = 360 for `secs`; returns the tank. */
function trenchRun(cls, secs = 30) {
   const T = flatSteppe();
   T.carveTrench([[-40, 360], [40, 360]], { w: 2.5, d: 1.8, enemy: [0, 0] });
   const len = TANKS[cls].dims.len, TT = forHull(T, len);
   const t = new Tank(cls, { terrain: TT, x: 0, z: 378, yaw: 0 }), w = mkWorld(TT, [t]);
   t.input.throttle = 1;
   let minPitch = 0, maxPitch = 0;
   for (let i = 0; i < secs * 60; i++) {
      w.time += 1 / 60; t.update(1 / 60, w);
      minPitch = Math.min(minPitch, t.pitch); maxPitch = Math.max(maxPitch, t.pitch);
   }
   return { t, T, minPitch, maxPitch };
}

test('trench: Tiger I and IS-2 cross a 2.5 m trench, the short Luchs gets stuck nose-down', () => {
   for (const cls of ['tiger1', 'is2']) {
      const { t } = trenchRun(cls);
      assert.ok(t.pos.z < 340, `${cls} should cross, z=${t.pos.z.toFixed(1)}`);
   }
   const { t, T } = trenchRun('luchs');
   assert.ok(t.pos.z > 356 && t.pos.z < 364, `Luchs should be stuck at the trench, z=${t.pos.z.toFixed(1)}`);
   const nose = { x: t.pos.x - Math.sin(t.yaw) * 1.5, z: t.pos.z - Math.cos(t.yaw) * 1.5 };
   const tail = { x: t.pos.x + Math.sin(t.yaw) * 1.5, z: t.pos.z + Math.cos(t.yaw) * 1.5 };
   assert.ok(T.groundHeightAt(nose.x, nose.z) < T.groundHeightAt(tail.x, tail.z) - 0.5 || Math.abs(t.pitch) > 0.15,
      `Luchs nose-down: pitch=${t.pitch.toFixed(3)}`);
});

test('trench geometry: depth, bridging rule, parapet on the enemy side, trenchDist', () => {
   const T = flatSteppe(), g0 = T.heightAt(0, 360);
   const v0 = T.heightVersion;
   T.carveTrench([[-40, 360], [40, 360]], { w: 2.5, d: 1.8, enemy: [0, 0] });
   assert.ok(T.heightVersion > v0 && T.heightEdits.length === 1);
   assert.ok(Math.abs(T.heightAt(0, 360) - (g0 - 1.8)) < 0.05, 'full depth on the centre line');
   assert.ok(Math.abs(T.hullHeightAt(0, 360, 4.3) - (g0 - 1.8)) < 0.05, 'short hull falls in');
   assert.ok(T.hullHeightAt(0, 360, 6.3) > g0 - 0.6, 'long hull bridges it');
   assert.ok(T.heightAt(0, 357.5) > T.heightAt(0, 362.5) + 0.2, 'spoil parapet on the enemy (north) side');
   assert.ok(T.trenchDist(0, 360) < 0 && T.trenchDist(0, 370) > 5 && T.trenchDist(300, 0) === Infinity);
   assert.equal(T.groundAt(0, 360), 'soft');
});

test("dragon's teeth: solid, stop shells, survive ramming, only HE blasts them to rubble", () => {
   const T = flatSteppe();
   const teeth = T.addTeethLine(-10, 300, 10, 300, { rows: 3 });
   assert.ok(teeth.length >= 36 && teeth.length <= 42, 'three staggered rows at ~1.6 m: ' + teeth.length);
   const o = teeth[5];
   assert.ok(o.solid && o.shots && !o.destructible && o.hp === OBJECT_KINDS.teeth.hp);
   assert.ok(o.h > 0.9 && o.h < 1.4 && Math.abs(o.w - 1.2) < 1e-9);
   assert.ok(T.objectsNear(o.x, o.z, 1).includes(o), 'in the spatial grid');
   assert.equal(T.blast(o.x, o.y + 0.5, o.z, 75, 180, o), 0, 'one 75 mm HE does not crack it');
   assert.ok(o.alive && o.hp < OBJECT_KINDS.teeth.hp);
   T.blast(o.x, o.y + 0.5, o.z, 122, 530, o);
   assert.ok(!o.alive, '122 mm HE destroys it');
});

test('hedgehog breaks above its ramming momentum; wire is flattened by driving over it', () => {
   const T = flatSteppe();
   const h = T.addObject({ kind: 'hedgehog', x: 20, z: 300, yaw: 0.4 });
   assert.ok(h.solid && !h.shots && h.breakMomentum === 150 && T.objectsNear(20, 300, 1).includes(h));
   const wires = T.addWireLine(-30, 280, 30, 280);
   assert.equal(wires.length, 10);
   assert.ok(wires.every((o) => !o.solid && !T.objectsNear(o.x, o.z, 2).includes(o)), 'wire stays out of the collision grid');
   const v = T.version;
   assert.equal(T.driveOver(3, 281, 2), 1);
   assert.ok(T.version > v && wires.filter((o) => !o.alive).length === 1);
   assert.equal(T.driveOver(3, 281, 2), 0, 'already flat');
});

test('bridge over the Flusstal river: drivable deck, blown span drops into the water', () => {
   const T = makeTerrain(41, 'flusstal'), s = T.bridgeSites[0];
   assert.ok(s, 'flusstal has a bridge site');
   const b = T.addBridge(s.x0, s.z0, s.x1, s.z1, { w: 7 });
   assert.ok(T.bridges.includes(b) && b.y0 > T.water + 1);
   assert.ok(T.groundHeightAt(s.x, s.z) < T.water - 1, 'causeway under the span dug out');
   assert.ok(Math.abs(T.heightAt(s.x, s.z) - (b.y0 + b.y1) / 2) < 0.3, 'deck at the centre');
   assert.equal(T.groundAt(s.x, s.z), 'road');
   const hv = T.heightVersion;
   assert.ok(T.blowBridge(b));
   assert.ok(T.heightVersion > hv && !b.alive && b.blown);
   assert.ok(T.heightAt(s.x, s.z) < T.water - 1, 'gap: the water below');
   const q = 0.15, ex = s.x0 + (s.x1 - s.x0) * q, ez = s.z0 + (s.z1 - s.z0) * q;
   assert.ok(T.heightAt(ex, ez) > T.water + 0.5, 'the bank ends of the span still stand');
   assert.ok(!T.objectsNear(s.x, s.z, 3).includes(b), 'bridge never blocks shells');
});

test('existing maps are unaffected by features until a mission adds them', () => {
   for (const id of Object.keys(MAPS)) {
      const T = makeTerrain(7, id);
      assert.equal(T._pg, null, id);
      assert.equal(T.heightVersion, 0, id);
      assert.equal(T.hullHeightAt(10, 10, 6), T.heightAt(10, 10));
   }
});

test('kueste: sea in the north deep enough for a ship, dry spawns, harbour mole', () => {
   const T = makeTerrain(5, 'kueste');
   assert.equal(T.water, 0);
   // suggested destroyer position beside the mole: 90 m long, 3.2 m draft
   for (let dz = -45; dz <= 45; dz += 5) for (const dx of [-5, 0, 5])
      assert.ok(T.waterDepth(275 + dx, -290 + dz) >= 6, `depth at ${275 + dx},${-290 + dz}`);
   for (let x = -480; x <= 480; x += 40) assert.ok(T.waterDepth(x, -330) > 6, 'open sea at z=-330, x=' + x);
   for (const team of ['team1', 'team2']) for (const sp of T.spawns[team]) {
      assert.equal(T.waterDepth(sp.x, sp.z), 0, team);
      assert.ok(T.groundAt(sp.x, sp.z) !== 'water');
   }
   assert.ok(T.spawns.team1[0].z > 300 && T.spawns.team2[0].z < 0 && T.spawns.team2[0].z > -120);
   assert.equal(T.groundAt(300, -250), 'road', 'mole is a drivable road');
   assert.ok(T.heightAt(300, -250) > T.water + 1);
   assert.ok(T.objects.filter((o) => o.kind === 'house').length >= 15, 'brick town + warehouses');
});
