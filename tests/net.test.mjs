// Multiplayer netcode, headless: host + clients over the in-memory hub (game/net/transport.js).
// Co-op (host + 2 clients vs bots) and PvP 2v2 (host + 3 clients), 90 s of simulated play each.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMemoryHub } from '../game/net/transport.js';
import { startNetGame } from '../game/net/game.js';
import { decodeSnap } from '../game/net/codec.js';

const DT = 1 / 60;

function runMatch({ mode, players, seconds = 90, seed = 4242, mission = 'standard', mapId = 'steppe', latency = 0 }) {
   const hub = makeMemoryHub(latency ? { latency, schedule: (fn, ms) => queue.push([now + ms, fn]), now: () => now } : {});
   let now = 0; const queue = [];
   const peers = players.map((p) => ({ ...p, T: hub.join(p.id) }));
   const nets = [], ends = [];
   for (const p of peers) {
      const session = { transport: p.T, mode, mission, mapId, difficulty: 'normal', seed, players: players.map(({ id, name, tank, team }) => ({ id, name, tank, team })),
         onEnd: (r) => ends.push([p.id, r]) };
      const api = { startBattle: (o) => { p.world = o.world; }, stopBattle: () => {} };
      p.net = startNetGame(session, api);
      nets.push(p.net);
   }
   const host = peers[0], hw = host.world;
   assert.ok(hw, 'host world built');
   for (const p of peers.slice(1)) assert.ok(p.world || latency, p.id + ' got start');
   // host positions by tick for the replica comparison
   const hist = new Map();
   const errs = [];
   const leaks = [];
   // PvP: every snapshot a client receives must hold only own team, spotted enemies, wrecks
   const hook = (p) => {
      const rep = p.net.replica, on = rep.onSnap.bind(rep);
      rep.onSnap = (u8) => {
         const s = decodeSnap(u8);
         for (const r of s.tanks) { const t = hw.tankById(r.id); if (t.alive && t.team !== rep.own.team && !t.spotted) leaks.push([p.id, r.id]); }
         on(u8);
      };
      // PvP: no shell of an unspotted enemy, no event about one (spotted: only to the spotting team)
      const onE = rep.onEvt.bind(rep);
      rep.onEvt = (d) => {
         if (mode === 'pvp') for (const it of d[2]) {
            const enemyHidden = (id) => { const t = id == null ? null : hw.tankById(id); return !!t && t.alive && t.team !== rep.own.team && !t.spotted; };
            if (it[0] === 's' && enemyHidden(it[2]) && !rep._seenShell?.has(it[1])) leaks.push([p.id, 'shell', it[2]]);
            if (it[0] === 's') (rep._seenShell ??= new Set()).add(it[1]);
            if (it[0] === 'e' && it[1] !== 'spotted' && (enemyHidden(it[2].dstId) || (it[2].dstId == null && enemyHidden(it[2].srcId)))) leaks.push([p.id, 'event', it[1]]);
            if (it[0] === 'e' && it[1] === 'spotted' && hw.tankById(it[2].srcId)?.team !== rep.own.team) leaks.push([p.id, 'spotted']);
         }
         onE(d);
      };
      p.hooked = true;
   };
   const steps = Math.round(seconds / DT);
   let clientShots = 0;
   for (let i = 0; i < steps && !hw.result; i++) {
      now += DT * 1000;
      queue.sort((a, b) => a[0] - b[0]);
      while (queue.length && queue[0][0] <= now) queue.shift()[1]();
      // clients drive: forward toward the enemy, aim at the nearest visible enemy, fire when loaded
      for (const p of peers.slice(1)) {
         if (!p.world) continue;
         if (!p.hooked) hook(p);
         const w = p.world, me = w.player;
         if (!me.alive) continue;
         let best = null, bd = 1e9;
         for (const t of w.tanks) if (t.team !== me.team && t.alive && t.visible !== false && t.spotted) { const d = Math.hypot(t.pos.x - me.pos.x, t.pos.z - me.pos.z); if (d < bd) { bd = d; best = t; } }
         me.input.throttle = bd < 250 ? 0 : 1; me.input.steer = Math.sin(i / 200) * 0.3;
         if (best) { me.aimPoint = { x: best.pos.x, y: best.pos.y + 1.2, z: best.pos.z }; if (me.reload <= 0 && w.phase === 'playing' && i % 30 === 0) { me.fire(w); clientShots++; } }
         else me.aimPoint = { x: me.pos.x, y: me.pos.y, z: me.pos.z + (me.team === 1 ? -200 : 200) };
      }
      hw.update(DT);
      const tick = Math.round(hw.time * 60);
      hist.set(tick, hw.tanks.map((t) => [t.pos.x, t.pos.z, t.alive]));
      hist.delete(tick - 240);
      for (const p of peers.slice(1)) {
         if (!p.world) continue;
         p.world.update(DT);
         if (i % 60 === 59) {
            const rep = p.net.replica, h = hist.get(Math.round(rep.clock * 60));
            if (h) for (const t of p.world.tanks) { const [x, z, alive] = h[t.id - 1]; if (t.visible !== false && alive && t.alive) errs.push(Math.hypot(t.pos.x - x, t.pos.z - z)); }
         }
      }
   }
   now += 2000; queue.sort((a, b) => a[0] - b[0]); while (queue.length) queue.shift()[1]();
   for (const n of nets) n.dispose();
   errs.sort((a, b) => a - b);
   return { peers, hw, nets, ends, errs, leaks, clientShots, time: hw.time };
}

function report(tag, r) {
   const host = r.nets[0].stats(), sec = r.time;
   console.log(`  ${tag}: ${sec.toFixed(0)} s, phase ${r.hw.phase}${r.hw.result ? ' (' + r.hw.result.reason + ')' : ''}; host up ${(host.up / sec / 1024).toFixed(1)} kB/s ` +
      Object.entries(host.byCh).map(([k, v]) => `${k} ${(v.up / sec / 1024).toFixed(1)}`).join(', '));
   for (const [i, n] of r.nets.entries()) if (i) {
      const s = n.stats(), snap = s.byCh.snap;
      console.log(`   client ${i}: down ${(s.down / sec / 1024).toFixed(1)} kB/s (snap ${(snap.down / sec / 1024).toFixed(1)}, ${(snap.down / snap.n).toFixed(0)} B avg x ${(snap.n / sec).toFixed(1)}/s; evt ${((s.byCh.evt?.down || 0) / sec / 1024).toFixed(1)}), up ${(s.up / sec / 1024).toFixed(2)} kB/s`);
   }
   const med = r.errs[r.errs.length >> 1] ?? 0, p95 = r.errs[Math.floor(r.errs.length * 0.95)] ?? 0;
   console.log(`   replica position error vs host at the client's clock: median ${med.toFixed(2)} m, p95 ${p95.toFixed(2)} m (${r.errs.length} samples)`);
   return { med, p95 };
}

test('co-op: host + 2 clients vs bots', () => {
   const r = runMatch({ mode: 'coop', players: [{ id: 'H', name: 'Host', tank: 'pz4h' }, { id: 'A', name: 'Anna', tank: 't34_76' }, { id: 'B', name: 'Bert', tank: 'm4a3e8' }] });
   const { med, p95 } = report('co-op 3 humans', r);
   const [, a, b] = r.peers;
   // same roster and ids everywhere, humans on team 1
   for (const p of [a, b]) {
      assert.equal(p.world.tanks.length, r.hw.tanks.length);
      p.world.tanks.forEach((t, i) => { assert.equal(t.cls, r.hw.tanks[i].cls); assert.equal(t.id, r.hw.tanks[i].id); });
      assert.equal(p.world.player.team, 1);
      assert.ok(!r.hw.tankById(p.world.player.id).ai, 'the host has no AI on a captain\'s tank');
   }
   assert.ok(med < 0.3 && p95 < 1.5, `replica positions match (median ${med}, p95 ${p95})`);
   // the clients' fire orders became shells and hits on the host
   const ids = new Set([a.world.player.id, b.world.player.id]);
   const hostShots = [a, b].reduce((n, p) => n + r.hw.tankById(p.world.player.id).stats.shots, 0);
   const hits = [a, b].reduce((n, p) => n + r.hw.tankById(p.world.player.id).stats.hits, 0);
   console.log(`   client fire orders ${r.clientShots}, host shots by captains ${hostShots}, hits ${hits}`);
   assert.ok(hostShots > 3, 'captains fired on the host');
   assert.ok(hits > 0, 'captains hit something');
   // the client saw tracers of its own shells (shell spawn items) and hit events with its id
   const evs = a.world.events.filter((e) => e && ids.has(e.srcId));
   assert.ok(evs.some((e) => e.type === 'shot'), 'client got shot events');
   assert.equal(r.leaks.length, 0, 'no unspotted enemies on the wire');
});

test('PvP 2v2: host + 3 clients, visibility filter', () => {
   const r = runMatch({ mode: 'pvp', seed: 99, mission: 'encounter', mapId: 'dorf', players: [
      { id: 'H', name: 'Host', tank: 'pz4h', team: 1 }, { id: 'A', name: 'Anna', tank: 't34_76', team: 2 },
      { id: 'B', name: 'Bert', tank: 'm4a3e8', team: 1 }, { id: 'C', name: 'Cora', tank: 'cromwell', team: 2 }] });
   const { med, p95 } = report('PvP 2v2', r);
   const [, a, b, c] = r.peers;
   assert.equal(a.world.player.team, 2); assert.equal(c.world.player.team, 2); assert.equal(b.world.player.team, 1);
   assert.equal(a.world.player.side, 'player');
   assert.ok(a.world.tanks.filter((t) => t.team === 2).every((t) => t === a.world.player || t.side === 'ally'));
   assert.equal(r.leaks.length, 0, 'clients never receive unspotted enemies: ' + JSON.stringify(r.leaks.slice(0, 5)));
   assert.ok(med < 0.3 && p95 < 1.5, `replica positions match (median ${med}, p95 ${p95})`);
});

test('latency 80 ms + a full match: every client gets an end with its own outcome', () => {
   const r = runMatch({ mode: 'pvp', seconds: 445, seed: 7, latency: 80, players: [
      { id: 'H', name: 'Host', tank: 'pz4h', team: 1 }, { id: 'A', name: 'Anna', tank: 't34_76', team: 2 }] });
   report('PvP 1v1 80 ms', r);
   const a = r.peers[1];
   assert.ok(r.hw.result, 'battle ended');
   // let the last messages arrive
   assert.ok(a.world.result, 'client got the end');
   const exp = r.hw.winner === 0 ? 'draw' : r.hw.winner === 2 ? 'win' : 'loss';
   assert.equal(a.world.result.outcome, exp);
   assert.ok(a.world.result.xp > 0, 'client rewards from progress.js');
   assert.equal(a.net.pvp?.pl.length, 2);
});
