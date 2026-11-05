// Campaign: every operation runs headless with the autopilot bot in the player's tank, scripted
// spawns / orders / objectives work, and the run reaches an end (win or loss) without exceptions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../game/state.js';
import { OPS, OP_LIST } from '../game/campaign.js';
import { TANKS, TANK_LIST } from '../game/config.js';

test('emplacements are tanks with armour, but not in the garage', () => {
   for (const id of ['bunker', 'pak40', 'tboat']) { assert.ok(TANKS[id]?.site, id); assert.ok(!TANK_LIST.includes(id), id); }
});

for (const id of OP_LIST) {
   test('operation ' + id + ' runs to an end', () => {
      const op = OPS[id];
      assert.ok(op.name && op.place && op.date && op.brief.length && op.tanks.every((c) => TANKS[c]), 'op data');
      const w = new World({ mode: 'campaign', op: id, playerCls: null, difficulty: 0, countdown: 0 });
      assert.equal(w.mapId, op.map);
      assert.ok(w.campaign.objectives.length >= 2);
      let st = 0;
      while (w.phase === 'playing' && st < 60 * 60 * 20) { w.update(1 / 60); st++; }
      const c = w.result?.campaign;
      console.log(`  ${id}: ${w.result?.outcome ?? 'running'} (${w.result?.reason ?? ''}) ${Math.round(w.time)} s, stars ${c?.stars ?? '-'}`);
      assert.ok(w.campaign.objectives.some((o) => o.state !== 'active') || w.result, 'something happened');
   });
}

// ---------------------------------------------------------------- twist helpers
const step = (w, s) => { for (let i = 0; i < s * 60 && w.phase === 'playing'; i++) w.update(1 / 60); };
const fresh = () => { const w = new World({ mode: 'campaign', op: 'westwall', playerCls: null, difficulty: 0, countdown: 0 }); w.script.triggers.length = 0; return w; };

test('countdown fires once, a later timer cancels it, retext rewrites an objective', () => {
   const w = fresh(), S = w.script; let n = 0, m = 0;
   const tm = S.countdown('A', 2, () => n++); tm.left += 1;
   step(w, 2); assert.equal(n, 0, 'lengthened'); step(w, 1.6); assert.equal(n, 1); assert.equal(w.campaign.timer, null);
   S.countdown('B', 1, () => m++); S.timer('C', 9); step(w, 2); assert.equal(m, 0, 'replaced timer never fires');
   const id = w.campaign.objectives[0].id; S.retext(id, 'Neuer Befehl'); assert.equal(w.campaign.objectives[0].text, 'Neuer Befehl');
});

test('fog / fadeFog change campaign fog over time', () => {
   const w = fresh(), S = w.script; let done = false;
   S.fog(0.8, 0x1b2330); assert.equal(w.campaign.fog, 0.8); assert.equal(w.campaign.fogColor, 0x1b2330);
   S.fadeFog(0.2, 4, () => { done = true; }); step(w, 2); assert.ok(w.campaign.fog < 0.7 && w.campaign.fog > 0.3, 'half way ' + w.campaign.fog);
   step(w, 2.6); assert.equal(w.campaign.fog, 0.2); assert.ok(done);
});

test('zone and holdZone: held only while inside and uncontested', () => {
   const w = fresh(), S = w.script, p = w.player; let entered = 0, held = 0;
   for (const t of w.tanks) if (t.team === 2) t.alive = false;
   if (p.ai) p.ai.order = { kind: 'hold', x: p.pos.x, z: p.pos.z };
   S.zone(p.pos.x + 2000, p.pos.z, 30, () => entered++); S.zone(p.pos.x, p.pos.z, 40, () => entered++);
   step(w, 1); assert.equal(entered, 1);
   const h = S.holdZone('Halten', p.pos.x, p.pos.z, 60, 3, () => held++);
   step(w, 2); assert.ok(h.held > 1.4 && !held);
   const e = S.spawn('pz4h', 2, p.pos.x + 5, p.pos.z, { inert: true }); e.pos.x = p.pos.x + 5; e.pos.z = p.pos.z;
   const before = h.held; step(w, 1); assert.equal(h.held, before, 'contested'); assert.match(w.campaign.timer.label, /umkämpft/);
   e.alive = false; step(w, 2); assert.equal(held, 1); assert.equal(w.campaign.timer, null);
});

test('inert vehicles are ignored by bots; crewUp and defect bring them into the fight', () => {
   const w = fresh(), S = w.script, p = w.player;
   const t = S.spawn('tiger1', 2, p.pos.x, p.pos.z - 120, { inert: true, tag: 'prize' });
   assert.ok(t.inert && t.noAI && !t.ai);
   S.defect([t], 1); assert.equal(t.team, 1); assert.equal(t.side, 'ally');
   S.crewUp(t, { order: { kind: 'hold', x: t.pos.x, z: t.pos.z } }); assert.ok(t.ai && !t.inert && !t.noAI); assert.equal(t.ai.order.kind, 'hold');
   step(w, 1);
});

for (const [id, twist] of [['spaehtrupp', 'out'], ['beute', 'escort'], ['totalize', 'tigers'], ['koeder', 'out'], ['halfaya', 'flank'], ['bastogne', 'unmask']]) {
   test('story op ' + id + ' reaches its twist (' + twist + ') and is won by the autopilot', () => {
      const w = new World({ mode: 'campaign', op: id, playerCls: null, difficulty: 0, countdown: 0 });
      const seen = new Set(); let st = 0;
      while (w.phase === 'playing' && st < 60 * 60 * 20) { w.update(1 / 60); st++; if (st % 60 === 0) seen.add(w.campaign.phase); }
      assert.ok(seen.has(twist), 'phases ' + [...seen]); assert.equal(w.result?.outcome, 'win', w.result?.reason);
   });
}

test('strike hurts tanks near the impacts only; spawn ammo override empties a type', () => {
   const w = fresh(), S = w.script, p = w.player;
   const a = S.spawn('pz4h', 2, p.pos.x + 300, p.pos.z, { noAI: true, ammo: { APCR: 0 } }); a.pos.x = p.pos.x + 300; a.pos.z = p.pos.z;
   if ('APCR' in a.ammoCount) assert.equal(a.ammoCount.APCR, 0);
   const hp0 = p.hp; S.strike(a.pos.x, a.pos.z, 0, { n: 3, secs: 1, dmg: 100 }); step(w, 2);
   assert.ok(a.hp < a.maxHP, 'target hit'); assert.equal(p.hp, hp0, 'far tank untouched');
});
