// game/net/game.js — a net match from the lobby's `session` to `onEnd`. See CONTRACT.md "Session".
//
//   const net = startNetGame(session, api)
//     api = { startBattle({ world }), stopBattle(), log?(text) }   (main.js; node tests pass their own)
//   net.world, net.isHost, net.host | net.replica, net.stats() -> { up, down, byCh }  (bytes)
//   net.finish(snap)  main.js calls it instead of the results screen when the battle is over
//   net.leave()       the local player leaves (host: abort, client: bye)
//
// Handshake on `sync`: client `hello` every 0.3 s -> host `start` (per client, `self` = slot);
// `refuse`, `abort` (host left), `end` (per client result), `st` 4 Hz, `me` 1 Hz.
// Host migration is not implemented: a lost host ends the match for everybody (`abort`).
import { NET_VERSION } from './transport.js';
import { makeRoster, buildWorld, setOwn } from './setup.js';
import { NetHost } from './host.js';
import { Replica } from './replica.js';
import { calcRewards } from '../progress.js';

const HELLO_DT = 300, START_TIMEOUT = 15000, HOST_SILENT = 12000;
const sizeOf = (d) => (d instanceof Uint8Array ? d.byteLength : d instanceof ArrayBuffer ? d.byteLength : JSON.stringify(d)?.length ?? 0);

/** Transport wrapper with byte counters per channel. */
function counted(T) {
   const st = { up: 0, down: 0, byCh: {} };
   const add = (ch, k, n) => { st[k] += n; const c = st.byCh[ch] ??= { up: 0, down: 0, n: 0 }; c[k] += n; if (k === 'down') c.n++; };
   return {
      st,
      get selfId() { return T.selfId; }, get hostId() { return T.hostId; }, get isHost() { return T.isHost; },
      peers: () => T.peers(),
      send(ch, d, to) { const n = sizeOf(d); add(ch, 'up', n * (to == null ? Math.max(1, T.peers().length) : Array.isArray(to) ? to.length : 1)); T.send(ch, d, to); },
      on(ch, fn) { T.on(ch, (d, from) => { add(ch, 'down', sizeOf(d)); fn(d, from); }); },
      onRejoin: T.onRejoin ? (fn) => T.onRejoin(fn) : undefined,
      link: T.link?.bind(T),
   };
}

export function startNetGame(session, api) {
   const T = counted(session.transport);
   const net = { session, isHost: T.isHost, world: null, host: null, replica: null, ended: false, transport: T,
      stats: () => ({ up: T.st.up, down: T.st.down, byCh: T.st.byCh }) };
   const timers = [];
   net.dispose = () => timers.forEach(clearInterval);
   const end = (result) => {
      if (net.ended) return; net.ended = true;
      timers.forEach(clearInterval);
      session.onEnd?.(result);
   };
   const abort = (reason) => { api.stopBattle?.(); end({ aborted: true, reason, victory: null, outcome: null }); };
   net.leave = () => {
      if (net.ended) return;
      if (net.isHost) net.host?.abort(); else T.send('sync', { k: 'bye' }, T.hostId);
      abort('Gefecht verlassen');
   };
   /** Battle over and shown: main.js has applied the rewards (menu.applyResult); hand back to the lobby. */
   net.finish = (snap) => {
      const r = snap?.result || {}, s = snap?.stats || {};
      end({ aborted: false, reason: r.reason || '', victory: r.outcome === 'win' ? true : r.outcome === 'loss' ? false : null, outcome: r.outcome || null,
         xp: r.xp || 0, credits: r.credits || 0, stats: { dmg: s.dmg | 0, kills: s.kills | 0, shots: s.shots | 0, hits: s.hits | 0, pens: s.pens | 0, spotted: s.spotted | 0, assist: s.assist | 0 },
         pvp: net.pvp || net.host?.result?.pvp });
   };
   session.transport.onPeerLeave?.((id) => {
      if (net.isHost) net.host?.peerLeft(id);
      else if (id === T.hostId && !net.ended) abort('Der Gastgeber hat das Spiel verlassen.');
   });

   if (net.isHost) {
      const { roster, slots } = makeRoster(session);
      slots.forEach((s, i) => { s.peer = session.players[i].id; });
      const start = { v: NET_VERSION, mode: session.mode, mission: session.mission, mapId: session.mapId, difficulty: session.difficulty, seed: session.seed >>> 0, roster, slots };
      const world = net.world = buildWorld(start);
      start.slots = world.net.slots.map((s, i) => ({ ...s, peer: slots[i].peer }));
      setOwn(world, start.slots[0].tid);
      const host = net.host = new NetHost(world, T, start, { onLog: api.log });
      const upd = world.update.bind(world);
      world.update = (dt) => { upd(dt); host.step(dt); };
      api.startBattle({ world, mode: session.mission, mapId: session.mapId, playerCls: world.player.cls });
      return net;
   }

   // ---- client
   let started = false;
   const t0 = Date.now();
   let lastHost = Date.now();
   const hello = () => {
      if (started) return;
      if (Date.now() - t0 > START_TIMEOUT) { abort('Keine Antwort vom Gastgeber.'); return; }
      T.send('sync', { k: 'hello', v: NET_VERSION }, T.hostId);
   };
   timers.push(setInterval(() => { if (started && !net.ended && !net.world?.result && Date.now() - lastHost > HOST_SILENT) abort('Verbindung zum Gastgeber verloren.'); }, 1000));
   T.on('snap', (d) => { lastHost = Date.now(); net.replica?.onSnap(d); });
   T.on('evt', (d) => { lastHost = Date.now(); net.replica?.onEvt(d); });
   T.on('sync', (d, from) => {
      if (!d || from !== T.hostId) return;
      lastHost = Date.now();
      const rep = net.replica, w = net.world;
      switch (d.k) {
         case 'start': {
            if (started) return;
            started = true;
            const world = net.world = buildWorld(d);
            const me = setOwn(world, d.slots[d.self]?.tid);
            const rep2 = net.replica = new Replica(world, T, me.id);
            world.update = (dt) => rep2.update(dt);
            if (d.rejoin) world.phase = 'playing';
            api.startBattle({ world, mode: d.mission, mapId: d.mapId, playerCls: me.cls });
            break;
         }
         case 'refuse': abort(d.why === 'version' ? 'Andere Spielversion als der Gastgeber.' : 'Der Gastgeber hat abgelehnt.'); break;
         case 'abort': abort('Der Gastgeber hat das Spiel beendet.'); break;
         case 'st': rep?.onSt(d); break;
         case 'me': rep?.onMe(d.s); break;
         case 'end': {
            if (!w || w.result) return;
            rep.onMe(d.s);
            w.winner = d.winner;
            w.phase = d.outcome === 'win' ? 'won' : d.outcome === 'loss' ? 'lost' : 'draw';
            w.result = { outcome: d.outcome, winner: d.winner, reason: d.reason, time: d.time, xp: 0, credits: 0 };
            if (!d.alive) w.player.alive = false;
            try { Object.assign(w.result, calcRewards(w)); } catch (e) { /* rewards optional */ }
            net.pvp = d.pvp;
            timers.forEach(clearInterval);
            w.emit('phase', { phase: w.phase, outcome: d.outcome, reason: d.reason });
            break;
         }
      }
   });
   hello(); timers.push(setInterval(hello, HELLO_DT));
   return net;
}
