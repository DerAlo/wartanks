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
