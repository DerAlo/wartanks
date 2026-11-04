// PvP "humans only" (lobby: Bots = keine): the roster holds just the captains; with bots on, bots fill
// up to the mission's team size and are matched to the humans' middle tier, not the host's tank.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TANKS } from '../game/config.js';
import { makeRoster, buildWorld } from '../game/net/setup.js';

const pl = (id, tank, team) => ({ id, name: id, tank, perks: [], team });

test('PvP without bots: 1 vs 1, nobody else on the field, the match can end', () => {
   const session = { mode: 'pvp', mission: 'standard', seed: 11, difficulty: 'normal', bots: false,
      players: [pl('a', 'tiger1', 1), pl('b', 'luchs', 2)] };
   const { roster, slots } = makeRoster(session);
   assert.deepEqual(roster, { team1: ['tiger1'], team2: ['luchs'] });
   const w = buildWorld({ mode: 'pvp', mission: 'standard', mapId: 'steppe', difficulty: 'normal', seed: 11, roster, slots });
   assert.equal(w.tanks.length, 2);
   assert.ok(w.tanks.every((t) => t.human));
   w.tanks[1].hp = 0; w.tanks[1].alive = false;
   for (let i = 0; i < 600 && !w.result; i++) w.update(1 / 60);
   assert.ok(w.result, 'last tank of a side gone -> the battle ends');
});

test('PvP with bots: free places filled, bots near the middle tier of the humans', () => {
   const session = { mode: 'pvp', mission: 'standard', seed: 5, difficulty: 'normal',
      players: [pl('a', 'tiger2', 1), pl('b', 'pz4h', 2), pl('c', 't34_76', 2)] };
   const { roster } = makeRoster(session);
   assert.ok(roster.team1.length > 1 && roster.team1.length === roster.team2.length);
   const bots = roster.team1.slice(1).concat(roster.team2.slice(2));
   for (const id of bots) assert.ok(TANKS[id].tier <= 6, `${id} tier ${TANKS[id].tier} matched to tier V, not the host's VIII`);
});
