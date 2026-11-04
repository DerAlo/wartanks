// Leopard 2A6: the cheat-only tank (config.CHEAT_TANKS). Never in the tree, matchmaking or bots; drivable
// everywhere once cheated; armour far above the tree's guns; a battle with it runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TANKS, TANK_LIST, CHEAT_TANKS, isDrivable } from '../game/config.js';
import { buildArmor, rayArmor } from '../game/armor.js';
import { matchmake } from '../game/missions.js';
import { World } from '../game/state.js';
import { validTank, ownTanks } from '../game/net/lobby.js';
import { makeRng } from '../game/utils.js';
import * as P from '../game/progress.js';

const pose = () => ({ pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, gunPitch: 0 });
const L = TANKS.leo2a6;

test('leo2a6 is a cheat tank: in TANKS, not in the tree; drivable and accepted by an MP host, emplacements not', () => {
   assert.ok(L && L.cheat);
   assert.ok(CHEAT_TANKS.includes('leo2a6'));
   assert.ok(!TANK_LIST.includes('leo2a6'));
   assert.equal(isDrivable('leo2a6'), true); assert.equal(validTank('leo2a6'), true);
   assert.equal(validTank('bunker'), false); assert.equal(isDrivable('bunker'), false); assert.equal(validTank('__proto__'), false);
   const p = P.newProfile();
   assert.ok(!ownTanks(p).includes('leo2a6'));
   P.maxOutProfile(p, []);
   assert.ok(ownTanks(p).includes('leo2a6'));
   // the top of the tree is far below it
   const top = Math.max(...TANK_LIST.map((id) => TANKS[id].tier));
   assert.ok(L.tier > top);
   assert.ok(L.engine.hp / L.mass > Math.max(...TANK_LIST.map((id) => TANKS[id].engine.hp / TANKS[id].mass)));
   const apcr = L.gun.ammoByType.APCR;
   assert.ok(apcr.pen500 >= 600 && apcr.vel > 1500);
   assert.ok(L.gun.ammoByType.HEAT && L.gun.ammoByType.HE && !L.gun.ammoByType.AP);
});

test('leo2a6 front shrugs off every tree gun: turret front and hull nose', () => {
   const A = buildArmor(L), maxPen = Math.max(...TANK_LIST.flatMap((id) => TANKS[id].gun.ammo.map((a) => a.pen)));
   const T = L.turret, H = L.hull, d = { x: 0, y: 0, z: 1 };
   for (const x of [-1.2, -0.9, -0.6, -0.3, 0.3, 0.6, 0.9, 1.2]) {           // beside the barrel
      // the front armour a shell meets in the first metre (mantlet + turret front behind it)
      const y = H.roofY + T.h * 0.45, hits = rayArmor(A, pose(), { x, y, z: -60 }, d);
      assert.ok(hits.length, 'turret hit at x ' + x.toFixed(1));
      const eff = hits.filter((h) => h.dist < hits[0].dist + 1).reduce((s, h) => s + h.effT, 0);
      assert.ok(eff > 2 * maxPen, `turret x ${x.toFixed(1)}: ${hits[0].plateId} ${eff.toFixed(0)} mm`);
   }
   const nose = rayArmor(A, pose(), { x: 0, y: H.floorY + 0.6, z: -60 }, d)[0];
   assert.equal(nose.plateId, 'nose'); assert.ok(nose.effT > 2 * maxPen, 'nose ' + nose.effT);
   const side = rayArmor(A, pose(), { x: -60, y: H.floorY + 0.8, z: 0 }, { x: 1, y: 0, z: 0 })[0];
   assert.ok(side.effT < maxPen, 'flanks stay vulnerable: ' + side.plateId + ' ' + side.effT);
});

test('bots never get it; matchmaking puts it against the top tiers', () => {
   for (let seed = 1; seed <= 30; seed++) {
      const mm = matchmake('leo2a6', 7, makeRng(seed));
      const all = [...mm.team1, ...mm.team2];
      assert.ok(!all.slice(1).includes('leo2a6'), 'no bot Leopard, seed ' + seed);
      for (const id of all.slice(1)) assert.ok(TANKS[id].tier >= 7 && TANK_LIST.includes(id), id);
      const bots = matchmake('pz4h', 7, makeRng(seed));
      assert.ok(![...bots.team1, ...bots.team2].includes('leo2a6'));
   }
});

test('a random battle with the Leopard runs and ends', () => {
   const w = new World({ mode: 'standard', mapId: 'steppe', seed: 5, playerCls: 'leo2a6', difficulty: 'normal' });
   assert.equal(w.player.cls, 'leo2a6');
   assert.equal(w.tanks.filter((t) => t.cls === 'leo2a6').length, 1);
   assert.equal(w.player.ammoSel, 'APCR');
   for (let i = 0; i < 60 * 480 && (w.phase === 'playing' || w.phase === 'countdown'); i++) { w.player.input.throttle = 0; w.update(1 / 60); }
   assert.ok(w.result, 'ended');
});

test('every campaign operation accepts the Leopard as the player tank', async () => {
   const { OP_LIST } = await import('../game/campaign.js');
   for (const id of OP_LIST) {
      const w = new World({ mode: 'campaign', op: id, playerCls: 'leo2a6', difficulty: 0, countdown: 0 });
      assert.equal(w.player.cls, 'leo2a6', id);
      for (let i = 0; i < 60 * 20; i++) w.update(1 / 60);
      assert.ok(!w.tanks.some((t) => t !== w.player && t.cls === 'leo2a6'), id);
   }
});
