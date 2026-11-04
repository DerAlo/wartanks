// Tech tree I–X: continuity per nation, research reachability from tier I, armour and stat sanity
// along the tier curve, and full bot battles at tier I and tier X.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TANKS, TANK_LIST } from '../game/config.js';
import { buildArmor, rayArmor } from '../game/armor.js';
import * as P from '../game/progress.js';
import { matchmake } from '../game/missions.js';
import { makeRng } from '../game/utils.js';
import { runBattle } from './sim.mjs';

const FULL = ['DE', 'SU'];                       // nations with a complete I–X tree (US / UK follow later)
const tree = P.techTree();

test('every tier I–X is filled for the full nations, one root at tier I', () => {
   for (const n of FULL) {
      const tiers = new Set(tree[n].map((id) => TANKS[id].tier));
      for (let t = 1; t <= 10; t++) assert.ok(tiers.has(t), `${n} tier ${t}`);
      const roots = tree[n].filter((id) => !P.prevOf(id));
      assert.deepEqual(roots, [tree[n][0]], `${n}: one root`);
      assert.equal(TANKS[roots[0]].tier, 1);
   }
});

test('research: every tank is reachable from the tier I root, parents one tier lower, same nation', () => {
   for (const n of FULL) for (const id of tree[n]) {
      const seen = new Set(); let x = id;
      while (P.prevOf(x)) {
         const p = P.prevOf(x);
         assert.equal(TANKS[p].nation, n, `${x} parent ${p}`);
         assert.equal(TANKS[p].tier, TANKS[x].tier - 1, `${x} (${TANKS[x].tier}) from ${p} (${TANKS[p].tier})`);
         assert.ok(!seen.has(p), 'no cycle'); seen.add(p); x = p;
      }
      assert.equal(x, tree[n][0], `${id} reaches the root`);
   }
   // a fresh profile walks a whole line to tier X with enough XP and credits
   const p = P.newProfile(); p.freeXP = 1e7; p.credits = 1e9;
   for (const n of FULL) for (const id of tree[n]) if (!p.tanks[id].researched) {
      assert.ok(P.research(p, id).ok, 'research ' + id); assert.ok(P.buy(p, id).ok, 'buy ' + id);
   }
   for (const n of FULL) for (const id of tree[n]) assert.ok(P.isElite(p, id), id);
});

test('costs and prices rise with tier; start tanks are the tier I roots', () => {
   for (let t = 2; t <= 10; t++) { assert.ok(P.RESEARCH_XP[t] > P.RESEARCH_XP[t - 1], 'xp ' + t); assert.ok(P.PRICE[t] > P.PRICE[t - 1], 'price ' + t); }
   const p = P.newProfile();
   for (const n of FULL) assert.ok(p.tanks[tree[n][0]].owned);
   // an old profile (tier IV start) keeps what it had and gets the new tier I tanks on top
   const old = { v: 1, credits: 5000, freeXP: 0, selected: 'luchs', tanks: { luchs: { owned: true, researched: true, xp: 900 }, pz4h: { researched: true, owned: false, xp: 0 } } };
   const q = P.importProfile('WT1:' + Buffer.from(JSON.stringify(old)).toString('base64'));
   assert.equal(q.selected, 'luchs'); assert.ok(q.tanks.luchs.owned && q.tanks.pz4h.researched && !q.tanks.pz4h.owned);
   for (const n of FULL) assert.ok(q.tanks[tree[n][0]].owned);
   for (const id of TANK_LIST) assert.ok(q.tanks[id], 'record for ' + id);
});

test('stat curve: HP, penetration and damage grow with tier; tier X below the cheat Leopard', () => {
   for (const n of FULL) {
      const byTier = (t, f) => tree[n].filter((id) => TANKS[id].tier === t).map((id) => f(TANKS[id]));
      for (let t = 2; t <= 10; t++) {
         const mx = (f) => Math.max(...byTier(t, f)), pmx = (f) => Math.max(...byTier(t - 1, f));
         assert.ok(mx((c) => c.hp) > pmx((c) => c.hp), `${n} HP tier ${t}`);
         // penetration may dip a little where a quick-firing autocannon takes over (Pz II), damage per minute may not
         assert.ok(mx((c) => c.gun.ammo[0].pen) >= 0.7 * pmx((c) => c.gun.ammo[0].pen), `${n} pen tier ${t}`);
         const dpm = (c) => c.gun.ammo[0].dmg * 60 / c.gun.reload;
         assert.ok(mx(dpm) >= 0.85 * pmx(dpm), `${n} DPM tier ${t}`);
      }
   }
   const leo = TANKS.leo2a6;
   for (const id of TANK_LIST) {
      const c = TANKS[id];
      assert.ok(c.hp < leo.hp && Math.max(...c.gun.ammo.map((a) => a.pen)) < leo.gun.ammoByType.APCR.pen, id);
      assert.ok(c.view >= 280 && c.view <= 420, id + ' view');
   }
});

test('armour sanity: every tree tank builds, the front is never thinner than the rear', () => {
   const pose = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, gunPitch: 0 };
   for (const id of TANK_LIST) {
      const c = TANKS[id], A = buildArmor(c), H = c.hull;
      for (const pl of Object.values(H.plates)) assert.ok(pl.t > 0, id);
      const y = H.floorY + (H.roofY - H.floorY) * 0.55;
      const f = rayArmor(A, pose, { x: 0.3, y, z: -40 }, { x: 0, y: 0, z: 1 }).find((h) => h.part === 'hull');
      const r = rayArmor(A, pose, { x: 0.3, y, z: 40 }, { x: 0, y: 0, z: -1 }).find((h) => h.part === 'hull');
      assert.ok(f && r, id + ' hull hit');
      assert.ok(f.effT >= r.effT, `${id}: front ${f.effT} rear ${r.effT}`);
   }
});

test('matchmaking keeps tier I and tier X battles within ±1', () => {
   for (const n of FULL) for (const id of [tree[n][0], tree[n].at(-1)]) {
      const { team1, team2 } = matchmake(id, 7, makeRng(3));
      for (const x of [...team1, ...team2]) assert.ok(Math.abs(TANKS[x].tier - TANKS[id].tier) <= 1, `${id} vs ${x}`);
   }
});

test('bot battles at tier I and at tier X end with a result', () => {
   for (const [player, seed] of [[tree.DE[0], 4], [tree.DE.at(-1), 6], [tree.SU[0], 4], [tree.SU.at(-1), 6]]) {
      const r = runBattle({ map: 'steppe', diff: 1, seed, player });
      assert.ok(r.result, player + ' battle ended');
      assert.ok(['win', 'loss', 'draw'].includes(r.result.outcome));
      assert.ok(r.shots > 20 && r.pens > 5, `${player}: shots ${r.shots}, pens ${r.pens}`);
      console.log(`  ${player}: ${r.result.outcome} (${r.result.reason}) ${r.time.toFixed(0)} s, shots ${r.shots}, pens ${r.pens}, kills ${r.counts.kill || 0}`);
   }
});
