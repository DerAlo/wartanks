// XP model (research in the own line, free XP, elite conversion), crew XP / skill points, perk
// effects on the Tank and the perk lists of a net game (host clamps, every peer applies).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../game/progress.js';
import { TANKS, PERKS, PERK_LIST, MAX_PERKS, perkMods, cleanPerks, BALLISTICS } from '../game/config.js';
import { Tank } from '../game/tank.js';
import { makeRoster, buildWorld } from '../game/net/setup.js';

const flat = () => ({ half: 500, water: null, version: 0, lastHit: { type: 'ground', obj: null }, heightAt: () => 0, groundIdxAt: () => 1,
   waterDepth: () => 0, objectsNear: () => [], destroyObject() {}, raycast: () => null });

test('research uses the predecessor of the same line first, then free XP', () => {
   const p = P.newProfile(), tree = P.techTree();
   for (const ch of Object.values(tree)) for (const id of ch) assert.equal(TANKS[id].nation, TANKS[ch[0]].nation);
   const [a, b, c] = tree.DE;
   assert.equal(P.tankState(p, b).prev, a);
   const need = P.tankState(p, b).researchXP;
   p.tanks[a].xp = need - 300; p.freeXP = 200;
   assert.equal(P.tankState(p, b).canResearch, false, 'XP of other lines / not enough');
   p.tanks[tree.SU[0]].xp = 99999;                  // another nation's tank XP does not help
   assert.equal(P.tankState(p, b).canResearch, false);
   p.freeXP = 500;
   assert.equal(P.research(p, b).ok, true);
   assert.equal(p.tanks[a].xp, 0); assert.equal(p.freeXP, 200);
   assert.equal(P.tankState(p, c).canResearch, false, 'c needs b XP; b has none');
   assert.equal(p.tanks[tree.SU[0]].xp, 99999);
});

test('elite and conversion: only elite tank XP, 1:1, credits per XP', () => {
   const p = P.newProfile(), [a, b] = P.techTree().DE;
   p.tanks[a].xp = 1000;
   assert.equal(P.isElite(p, a), false);
   assert.equal(P.convertXP(p, a).ok, false);
   p.tanks[b].researched = true;
   assert.equal(P.isElite(p, a), true);
   const cr = p.credits, fx = p.freeXP;
   const r = P.convertXP(p, a, 400);
   assert.equal(r.ok, true); assert.equal(r.xp, 400);
   assert.equal(p.tanks[a].xp, 600); assert.equal(p.freeXP, fx + 400); assert.equal(p.credits, cr - 400 * P.CONVERT_CREDITS);
   p.credits = 100 * P.CONVERT_CREDITS + 3;         // credits limit the amount
   assert.equal(P.convertXP(p, a).xp, 100); assert.equal(p.credits, 3);
   assert.equal(P.convertXP(p, a).ok, false);
   const last = P.techTree().DE.at(-1);
   p.tanks[last].researched = true;
   assert.equal(P.isElite(p, last), true, 'last tank of a line is elite once researched');
});

test('crew XP from battles (elite bonus), rising point cost, perks, training, reset', () => {
   const p = P.newProfile(), [a, b] = P.techTree().DE;
   assert.deepEqual(P.crewState(p, a).perks, []);
   P.applyRewards(p, a, { xp: 1000, freeXP: 50, credits: 0 });
   assert.equal(p.tanks[a].crew.xp, 1000);
   const c1 = P.crewState(p, a);
   assert.equal(c1.points, 1); assert.equal(c1.free, 1); assert.equal(c1.need, P.crewPointXP(1));
   for (let i = 1; i < 8; i++) assert.ok(P.crewPointXP(i) > P.crewPointXP(i - 1));
   assert.equal(P.learnPerk(p, a, 'feinabstimmung').ok, true);
   assert.equal(P.learnPerk(p, a, 'feinabstimmung').ok, false);
   assert.equal(P.learnPerk(p, a, 'tarnung').ok, false, 'no free point');
   assert.equal(P.learnPerk(p, a, 'nope').ok, false);
   assert.deepEqual(P.perksOf(p, a), ['feinabstimmung']);
   p.tanks[b].researched = true;                     // a is elite now: +50 % crew XP
   P.applyRewards(p, a, { xp: 1000, credits: 0 });
   assert.equal(p.tanks[a].crew.xp, 2500);
   assert.equal(P.crewState(p, a).points, 2);
   // tank XP -> crew XP, 1:1
   p.tanks[a].xp = 3000;
   assert.equal(P.trainCrew(p, a, 1000).ok, true);
   assert.equal(p.tanks[a].xp, 2000); assert.equal(p.tanks[a].crew.xp, 3500);
   assert.equal(P.trainCrew(p, b).ok, false, 'not owned');
   assert.equal(P.resetPerks(p, a).ok, true);
   assert.equal(P.crewState(p, a).free, P.crewState(p, a).points);
   // all points cap at MAX_PERKS
   p.tanks[a].crew.xp = 1e9;
   assert.equal(P.crewState(p, a).points, MAX_PERKS);
   // training mode: no XP at all
   const r = P.calcRewards({ player: { cfg: TANKS[a], alive: true, stats: {} }, stats: {}, mode: 'training' });
   assert.equal(r.xp, 0);
});

test('old profiles (no crew) load and export/import keeps the crew', () => {
   const old = P.newProfile();
   for (const id in old.tanks) delete old.tanks[id].crew;
   old.tanks.pz4h.xp = 'x';
   old.tanks.luchs.crew = { xp: 1500, perks: ['tarnung', 'tarnung', 'bogus', 'adlerauge'] };   // 1 point only
   const p = P.importProfile('WT1:' + Buffer.from(JSON.stringify(old)).toString('base64'));
   assert.equal(p.tanks.pz4h.crew.xp, 0); assert.deepEqual(p.tanks.pz4h.crew.perks, []);
   assert.equal(p.tanks.pz4h.xp, 0);
   assert.deepEqual(p.tanks.luchs.crew.perks, ['tarnung'], 'cleaned and cut to the earned points');
   p.tanks.luchs.crew.xp = 3000; P.learnPerk(p, 'luchs', 'adlerauge');
   const q = P.importProfile(P.exportProfile(p));
   assert.deepEqual(q.tanks.luchs.crew, { xp: 3000, perks: ['tarnung', 'adlerauge'] });
});

test('perk math: multipliers, clean list, tank applies them', () => {
   assert.equal(BALLISTICS.DISP_MUL, 0.82);
   assert.ok(PERK_LIST.length >= 6 && PERK_LIST.length <= 8);
   for (const id of PERK_LIST) { assert.ok(PERKS[id].name && PERKS[id].desc); for (const v of Object.values(PERKS[id].fx)) assert.ok(v > 0.7 && v < 1.6, id); }
   assert.deepEqual(cleanPerks(['tarnung', 'tarnung', 5, 'x', '__proto__', 'adlerauge']), ['tarnung', 'adlerauge']);
   assert.equal(cleanPerks([...PERK_LIST, ...PERK_LIST]).length, MAX_PERKS);
   const m = perkMods(['feinabstimmung', 'schnellladen', 'waffenbrueder']);
   assert.ok(Math.abs(m.disp - 0.92) < 1e-9);
   assert.ok(Math.abs(m.reload - 0.95 * 0.975) < 1e-9);
   assert.equal(m.view, 1.025); assert.equal(perkMods([]).disp, 1);
   // every perk together stays modest
   const all = perkMods(PERK_LIST);
   assert.ok(all.disp >= 0.9 && all.reload >= 0.9 && all.view <= 1.1 && all.camo <= 1.15);

   const T = flat(), plain = new Tank('pz4h', { terrain: T }), pk = new Tank('pz4h', { terrain: T, perks: ['feinabstimmung', 'tarnung', 'adlerauge', 'schnellladen'] });
   assert.ok(Math.abs(pk.baseDisp - plain.baseDisp * 0.92) < 1e-9);
   assert.ok(Math.abs(pk.camo.still - plain.camo.still * 1.1) < 1e-9);
   assert.ok(Math.abs(pk.viewRangeNow() - plain.viewRangeNow() * 1.05) < 1e-6);
   const w = { terrain: T, time: 0, rng: () => 0.5, shells: [], tanks: [plain, pk] };
   for (let i = 0; i < 600; i++) { w.time += 1 / 60; plain.update(1 / 60, w); pk.update(1 / 60, w); }
   assert.ok(Math.abs(pk.reloadMax - plain.reloadMax * 0.95) < 1e-9);
   assert.ok(pk.aimDisp < plain.aimDisp * 0.93, `fully aimed: ${pk.aimDisp} vs ${plain.aimDisp}`);
   // Ruhige Hand: less bloom while the turret turns
   const a = new Tank('pz4h', { terrain: T }), b = new Tank('pz4h', { terrain: T, perks: ['ruhigeHand'] });
   const w2 = { terrain: T, time: 0, rng: () => 0.5, shells: [], tanks: [a, b] };
   for (let i = 0; i < 30; i++) { w2.time += 1 / 60; for (const t of [a, b]) { t.aimPoint = { x: Math.sin(i / 5) * 100, y: 0, z: -100 }; t.update(1 / 60, w2); } }
   assert.ok(b.aimDisp < a.aimDisp, `turning: ${b.aimDisp} vs ${a.aimDisp}`);
});

test('net game: captains carry clean perk lists, bots none, every peer the same', () => {
   const session = { mode: 'coop', mission: 'standard', seed: 7, difficulty: 'normal',
      players: [{ id: 'h', name: 'Host', tank: 'pz4h', perks: ['feinabstimmung', 'feinabstimmung', 'mega-buff'] },
         { id: 'c', name: 'Gast', tank: 't34_76', perks: PERK_LIST.concat(['x']) }] };
   const { roster, slots } = makeRoster(session);
   assert.deepEqual(slots[0].perks, ['feinabstimmung']);
   assert.equal(slots[1].perks.length, MAX_PERKS);
   const start = { mode: 'coop', mission: 'standard', mapId: 'steppe', difficulty: 'normal', seed: 7, roster, slots };
   const w1 = buildWorld(start), w2 = buildWorld(JSON.parse(JSON.stringify(start)));
   for (const w of [w1, w2]) {
      const s0 = w.net.slots[0], s1 = w.net.slots[1];
      assert.deepEqual(w.tankById(s0.tid).perks, ['feinabstimmung']);
      assert.equal(w.tankById(s1.tid).perks.length, MAX_PERKS);
      for (const t of w.tanks) if (!t.human) assert.deepEqual(t.perks, []);
   }
   assert.equal(w1.tankById(1).baseDisp, w2.tankById(1).baseDisp);
});
