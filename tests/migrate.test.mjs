// Host migration over the in-memory hub: the host names a successor and sends it the full state;
// when the host leaves (politely or by losing its connection) the successor carries the match on
// with the bots' AI, the other client follows it, and the match ends normally for both.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryHub } from '../game/net/transport.js';
import { startNetGame } from '../game/net/game.js';

const DT = 1 / 60;
const realNow = Date.now;
let off = 0;
Date.now = () => realNow() + off;

function setup(mode, players) {
   const hub = makeMemoryHub();
   const peers = players.map((p) => ({ ...p, T: hub.join(p.id), ends: [] }));
   for (const p of peers) {
      const session = { transport: p.T, mode, mission: 'standard', mapId: 'steppe', difficulty: 'normal', seed: 99,
         players: players.map(({ id, name, tank, team }) => ({ id, name, tank, team })), onEnd: (r) => p.ends.push(r),
         onSuccessor: (id) => { p.succ = id; }, onHost: (id) => { p.newHost = id; } };
      const api = { startBattle: (o) => { p.world = o.world; }, stopBattle: () => { p.stopped = true; }, log: () => {} };
      p.net = startNetGame(session, api);
   }
   return { hub, peers };
}

function run(peers, seconds, live) {
   const steps = Math.round(seconds / DT);
   for (let i = 0; i < steps; i++) {
      off += DT * 1000;
      for (const p of peers) {
         if (!live(p) || !p.world) continue;
         const me = p.world.player;
         if (me?.alive && !p.net.isHost) { me.input.throttle = 1; me.input.steer = Math.sin(i / 150) * 0.3; }
         p.world.update(DT);
         if (i % 15 === 0) p.net.tickMigration?.();
      }
      if (peers.some((p) => live(p) && p.world?.result)) break;
   }
}

for (const how of ['leave', 'drop']) test(`host migration (${how}): the successor carries the match on`, () => {
   const { peers } = setup('coop', [
      { id: 'H', name: 'Host', tank: 'pz4h' }, { id: 'A', name: 'Anna', tank: 't34_76' }, { id: 'B', name: 'Bert', tank: 'pz4h' }]);
   const [H, A, B] = peers;
   let alive = new Set(peers);
   run(peers, 30, (p) => alive.has(p));
   assert.equal(H.world.phase, 'playing');
   assert.equal(H.succ, 'A', 'host names the first client as successor');
   const hw = H.world;
   const before = new Map(hw.tanks.map((t) => [t.id, { alive: t.alive, hp: t.hp, reload: t.reload, ai: !!t.ai, x: t.pos.x }]));
   const timeLeft = hw.timeLeft;
   // the host goes
   if (how === 'leave') H.net.leave();
   else { H.T.leave(); }
   alive.delete(H);
   assert.ok(H.ends.length === 1 || how === 'drop');
   if (how === 'leave') assert.equal(H.ends[0].handover, true);
   run(peers, 2, (p) => alive.has(p));
   assert.ok(A.net.isHost, 'A is the host now');
   assert.ok(A.net.migrated, 'A promoted');
   assert.equal(A.newHost, 'A'); assert.equal(B.newHost, 'A', 'B follows A');
   assert.equal(B.T.hostId, 'A');
   assert.ok(A.ends.length === 0 && B.ends.length === 0, 'nobody aborted: ' + JSON.stringify([A.ends, B.ends]));
   const aw = A.world;
   // state carried over: alive / hp / bots' AI, the battle timer
   for (const t of aw.tanks) {
      const b = before.get(t.id);
      if (!b.alive) assert.equal(t.alive, false, 'tank ' + t.id + ' stays dead');
      if (t.alive && !t.human) assert.ok(t.ai, 'bot ' + t.id + ' has its AI');
      if (b.alive && t.alive) assert.ok(t.hp <= b.hp + 1e-6, 'hp of ' + t.id);
   }
   assert.ok(Math.abs(aw.timeLeft - timeLeft) < 4, `timer ${aw.timeLeft} vs ${timeLeft}`);
   const H_tank = aw.tankById(1);
   if (H_tank.alive) assert.ok(H_tank.ai, "the old host's tank is a bot now");
   // the bots still move under the new host, B receives snapshots from it
   const pos = new Map(aw.tanks.map((t) => [t.id, t.pos.x + t.pos.z]));
   const latest = B.net.replica.latest;
   run(peers, 5, (p) => alive.has(p));
   assert.ok(aw.tanks.some((t) => t.alive && !t.human && Math.abs(t.pos.x + t.pos.z - pos.get(t.id)) > 0.5), 'bots move');
   assert.ok(B.net.replica.latest > latest, 'B gets snapshots from A');
   assert.ok(B.world.player.alive === aw.tankById(B.world.player.id).alive);
   // B's tank is still B's on the new host
   assert.ok(aw.tankById(B.world.player.id).human, "B's tank is human on the new host");
   // to the end
   run(peers, 500, (p) => alive.has(p));
   run(peers, 1, (p) => alive.has(p));
   assert.ok(aw.result, 'match ended under the new host');
   assert.ok(B.world.result, 'B got the end from the new host');
   for (const p of [A, B]) p.net.finish({ result: p.world.result, stats: p.world.player.stats });   // what main.js does
   assert.equal(A.ends.length, 1); assert.equal(B.ends.length, 1);
   assert.ok(!A.ends[0].aborted && !B.ends[0].aborted, 'normal end');
   assert.equal(A.ends[0].outcome, B.ends[0].outcome, 'same team, same outcome');
   for (const p of peers) p.net.dispose();
});

test('PvP 1v1: the remaining captain takes the match over; before a successor is named, leaving aborts', () => {
   {
      const { peers } = setup('pvp', [{ id: 'H', name: 'Host', tank: 'pz4h', team: 1 }, { id: 'A', name: 'Anna', tank: 't34_76', team: 2 }]);
      const [H, A] = peers;
      run(peers, 3, () => true);
      H.net.leave();
      run([A], 2, () => true);
      assert.ok(A.net.isHost && A.ends.length === 0, 'A carries on');
      const t = A.world.tankById(1);
      assert.ok(!t.alive || t.ai, "the host's tank is a bot");
      for (const p of peers) p.net.dispose();
   }
   {
      const { peers } = setup('pvp', [{ id: 'H', name: 'Host', tank: 'pz4h', team: 1 }, { id: 'A', name: 'Anna', tank: 't34_76', team: 2 }]);
      const [H, A] = peers;
      run(peers, 0.5, () => true);
      H.net.leave();
      run([A], 1, () => true);
      assert.ok(!A.net.isHost && A.ends.length === 1 && A.ends[0].aborted, 'no successor yet: aborted');
      for (const p of peers) p.net.dispose();
   }
});
