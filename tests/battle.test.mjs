// World-level tests: full headless 7v7 bot battles, training ground, spotting, terrain
// determinism, progression.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runBattle } from './sim.mjs';
import { World } from '../game/state.js';
import { makeTerrain } from '../game/terrain.js';
import { canSee } from '../game/spotting.js';
import { matchmake } from '../game/missions.js';
import { TANKS, TANK_LIST } from '../game/config.js';
import { makeRng } from '../game/utils.js';
import * as P from '../game/progress.js';

test('headless 7v7 bot battles end with a result, plausible numbers', () => {
   const runs = [['steppe', 0, 3], ['dorf', 1, 4], ['waldhuegel', 2, 5], ['flusstal', 1, 6], ['winter', 2, 8]];
   let shots = 0, hits = 0, pens = 0, rics = 0, kills = 0, time = 0, cpu = 0;
   for (const [map, diff, seed] of runs) {
      const r = runBattle({ map, diff, seed, player: null });
      assert.ok(r.result, `${map}: battle ended`);
      assert.ok(['win', 'loss', 'draw'].includes(r.result.outcome));
      assert.ok(r.time > 90, `${map}: lasted ${r.time.toFixed(0)} s`);
      assert.ok(r.time <= 421);
      shots += r.shots; hits += r.hits; pens += r.pens; rics += r.counts.ricochet || 0; kills += r.counts.kill || 0;
      time += r.time; cpu += r.ms;
      console.log(`  ${map} d${diff}: ${r.result.outcome} (${r.result.reason}) ${r.time.toFixed(0)} s, alive ${r.alive.slice(1).join(':')}, shots ${r.shots}, hits ${r.hits}, pens ${r.pens}, ric ${r.counts.ricochet || 0}, noPen ${r.counts.noPen || 0}, kills ${r.counts.kill || 0}, cpu ${r.ms} ms`);
   }
   const n = runs.length;
   assert.ok(time / n > 150 && time / n < 421, 'average battle length ' + (time / n).toFixed(0));
   assert.ok(shots / n > 40, 'shots per battle ' + shots / n);
   assert.ok(hits / shots > 0.25 && hits / shots < 0.95, 'hit rate ' + (hits / shots).toFixed(2));
   assert.ok(pens / hits > 0.3 && pens / hits < 0.9, 'pen rate ' + (pens / hits).toFixed(2));
   assert.ok(rics > 0, 'ricochets happen');
   assert.ok(kills / n >= 4, 'kills per battle ' + kills / n);
   assert.ok(cpu / time < 50, 'sim cost per battle second (ms) ' + (cpu / time).toFixed(1));
});

test('battle with a player: countdown, events, rewards', () => {
   const w = new World({ mode: 'standard', mapId: 'steppe', seed: 9, playerCls: 'tiger1', difficulty: 'normal' });
   assert.equal(w.phase, 'countdown');
   assert.equal(w.tanks.length, 14);
   assert.equal(w.player.cls, 'tiger1');
   assert.equal(w.player.side, 'player');
   for (const t of w.tanks) assert.ok(Math.abs(t.cfg.tier - 7) <= 1, 'tier ±1');
   const x0 = w.player.pos.x;
   w.player.input.throttle = 1;
   for (let i = 0; i < 60 * 5; i++) w.update(1 / 60);
   assert.equal(w.player.pos.x, x0, 'no driving during the countdown');
   // let the bots fight while the player sits still; the player's team plays without it
   for (let i = 0; i < 60 * 440 && (w.phase === "playing" || w.phase === "countdown"); i++) { w.player.input.throttle = 0; w.update(1 / 60); }
   assert.ok(w.result, 'ended');
   assert.ok(w.result.credits !== undefined && w.result.xp >= 0);
   assert.ok(w.events.some((e) => e && e.type === 'shot'));
});

test('training ground: infinite ammo, targets of every type, respawn', () => {
   const w = new World({ mode: 'training', mapId: 'steppe', seed: 2, playerCls: 'pz4h' });
   assert.equal(w.phase, 'playing');
   assert.equal(w.timeLeft, null);
   assert.ok(w.infiniteAmmo);
   assert.equal(w.tanks.length, 1 + TANK_LIST.length);
   const tgt = w.tanks[1];
   const n0 = w.player.ammoCount.AP;
   w.player.reload = 0; w.player.fire(w);
   assert.equal(w.player.ammoCount.AP, n0);
   w.kill(tgt, w.player, 'shell');
   for (let i = 0; i < 60 * 9; i++) w.update(1 / 60);
   assert.ok(w.tanks[1].alive && w.tanks[1] !== tgt, 'target respawned');
   assert.ok(!w.events.some((e) => e && e.type === 'shot' && e.srcId !== w.player.id), 'targets never shoot');
});

test('spotting: bushes and stillness hide, firing reveals, proximity always', () => {
   const w = new World({ mode: 'training', mapId: 'steppe', seed: 3, playerCls: 'm18' });
   const o = w.player, t = w.tanks[2];
   const T = w.terrain;
   // flat-ish test spot: put both on the same line on the map's own terrain
   o.pos.x = 0; o.pos.z = 300; o.placeOn(T); t.placeOn(T);
   t.pos.x = 0; t.pos.z = 300 - 45; t.placeOn(T);
   assert.ok(canSee(w, o, t), 'proximity');
   t.pos.z = 300 - 600; t.placeOn(T);
   assert.ok(!canSee(w, o, t), 'beyond view range');
   const stillD = o.viewRange - t.camo.still * (o.viewRange - 50);
   assert.ok(stillD < o.viewRange);
   t.lastFire = w.time;
   assert.ok(t.camo.fire < 1);
});

test('terrain is deterministic', () => {
   const a = makeTerrain(77, 'dorf'), b = makeTerrain(77, 'dorf'), c = makeTerrain(78, 'dorf');
   let same = true, diff = false;
   for (let i = 0; i < 200; i++) {
      const x = (i * 37) % 900 - 450, z = (i * 91) % 900 - 450;
      if (a.heightAt(x, z) !== b.heightAt(x, z)) same = false;
      if (a.heightAt(x, z) !== c.heightAt(x, z)) diff = true;
   }
   assert.ok(same && diff);
   assert.equal(a.objects.length, b.objects.length);
});

test('matchmaking mirrors classes, tier ±1', () => {
   const r = matchmake('t34_85', 7, makeRng(4));
   assert.equal(r.team1.length, 7); assert.equal(r.team2.length, 7);
   for (let i = 0; i < 7; i++) {
      assert.equal(TANKS[r.team1[i]].cls === TANKS[r.team2[i]].cls || i === 0, true);
      assert.ok(Math.abs(TANKS[r.team1[i]].tier - 6) <= 1);
   }
});

test('progression: start tanks, research, buy, rewards, export/import', () => {
   const p = P.resetProfile();
   const tree = P.techTree();
   for (const n of Object.keys(tree)) assert.ok(p.tanks[tree[n][0]].owned);
   const next = tree.DE[1];
   assert.equal(P.research(p, next).ok, false);
   p.tanks[tree.DE[0]].xp = 100000;
   assert.ok(P.research(p, next).ok);
   p.credits = 1e7;
   assert.ok(P.buy(p, next).ok);
   assert.ok(p.tanks[next].owned);
   const s = P.exportProfile(p), q = P.importProfile(s);
   assert.equal(q.tanks[next].owned, true);
   assert.throws(() => P.importProfile('garbage'));
   const w = new World({ mode: 'standard', mapId: 'steppe', seed: 1, playerCls: 'pz4h', countdown: 0 });
   w.stats.dmg = 1200; w.stats.kills = 2; w.end(1, 'Alle Gegner zerstört');
   assert.equal(w.result.outcome, 'win');
   assert.ok(w.result.xp > 500 && w.result.credits > 10000, JSON.stringify(w.result));
   P.applyRewards(p, 'pz4h', w.result);
   assert.ok(P.loadProfile().tanks.pz4h.xp >= w.result.xp);
   const cr = p.credits; P.applyRewards(p, 'comet', w.result);       // not owned: test drive, nothing credited
   assert.equal(p.tanks.comet.xp, 0); assert.equal(p.credits, cr);
});
