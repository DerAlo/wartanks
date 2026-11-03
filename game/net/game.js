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
// Host migration (CONTRACT.md): the host names a successor (`st.hs`) and sends it the full state
// once a second (`mig`). When the host is gone (`left`, transport leave, silence) the successor
// turns its replica World into the authoritative one (promote) and announces itself to everybody
// with `{ k: 'host', id }`; the others follow it (adopt). A host leaving with a successor says
// `left` instead of `abort`.
import { NET_VERSION } from './transport.js';
import { makeRoster, buildWorld, setOwn, setHuman } from './setup.js';
import { restoreWorld } from './migrate.js';
import { NetHost } from './host.js';
import { Replica } from './replica.js';
import { calcRewards } from '../progress.js';

const HELLO_DT = 300, START_TIMEOUT = 15000, HOST_SILENT = 12000;
const MIGRATE_WAIT = 15000, PROMOTE_GRACE = 250;     // ms: others wait for the successor; it waits for a last full state
const sizeOf = (d) => (d instanceof Uint8Array ? d.byteLength : d instanceof ArrayBuffer ? d.byteLength : JSON.stringify(d)?.length ?? 0);

/** Transport wrapper with byte counters per channel. */
function counted(T) {
   const st = { up: 0, down: 0, byCh: {} };
   const add = (ch, k, n) => { st[k] += n; const c = st.byCh[ch] ??= { up: 0, down: 0, n: 0 }; c[k] += n; if (k === 'down') c.n++; };
   return {
      st,
      get selfId() { return T.selfId; }, get hostId() { return T.hostId; }, get isHost() { return T.isHost; },
      setHost(id) { if (T._setHost) T._setHost(id); else T.hostId = id; },
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
   const abort = (reason) => { if (globalThis.__netDebug) console.log(`[net] abort ${reason} at ${Date.now() % 100000}`); api.stopBattle?.(); end({ aborted: true, reason, victory: null, outcome: null }); };
   net.leave = () => {
      if (net.ended) return;
      if (net.isHost && net.host?.abort()) {         // the match goes on under the successor
         api.stopBattle?.();
         end({ aborted: true, reason: 'Gefecht verlassen', victory: null, outcome: null, handover: true });
         return;
      }
      if (!net.isHost) T.send('sync', { k: 'bye' }, T.hostId);
      abort('Gefecht verlassen');
   };
   /** Battle over and shown: main.js has applied the rewards (menu.applyResult); hand back to the lobby. */
   net.finish = (snap) => {
      const r = snap?.result || {}, s = snap?.stats || {};
      end({ aborted: false, reason: r.reason || '', victory: r.outcome === 'win' ? true : r.outcome === 'loss' ? false : null, outcome: r.outcome || null,
         xp: r.xp || 0, credits: r.credits || 0, stats: { dmg: s.dmg | 0, kills: s.kills | 0, shots: s.shots | 0, hits: s.hits | 0, pens: s.pens | 0, spotted: s.spotted | 0, assist: s.assist | 0 },
         pvp: net.pvp || net.host?.result?.pvp });
   };
   let started = false;
   session.transport.onPeerLeave?.((id) => {
      if (net.isHost) net.host?.peerLeft(id);
      else if (id === T.hostId && !net.ended) { if (!started) abort('Der Gastgeber hat das Spiel verlassen.'); else hostGone('left'); }
   });

   if (net.isHost) {
      const { roster, slots } = makeRoster(session);
      slots.forEach((s, i) => { s.peer = session.players[i].id; });
      const start = { v: NET_VERSION, mode: session.mode, mission: session.mission, mapId: session.mapId, difficulty: session.difficulty, seed: session.seed >>> 0, roster, slots };
      const world = net.world = buildWorld(start);
      start.slots = world.net.slots.map((s, i) => ({ ...s, peer: slots[i].peer }));
      setOwn(world, start.slots[0].tid);
      const host = net.host = new NetHost(world, T, start, { onLog: api.log, onSuccessor: (id) => session.onSuccessor?.(id) });
      const upd = world.update.bind(world);
      world.update = (dt) => { upd(dt); host.step(dt); };
      api.startBattle({ world, mode: session.mission, mapId: session.mapId, playerCls: world.player.cls });
      return net;
   }

   // ---- client
   const t0 = Date.now();
   let lastHost = Date.now();
   const hello = () => {
      if (started) return;
      if (Date.now() - t0 > START_TIMEOUT) { abort('Keine Antwort vom Gastgeber.'); return; }
      T.send('sync', { k: 'hello', v: NET_VERSION }, T.hostId);
   };
   // ---- host migration (client side)
   let startIn = null, succ = null, mig = null, orphan = 0;
   function hostGone(why) {
      if (net.ended || net.isHost || orphan || !net.replica || net.world?.result) return;
      if (why === 'abort' || !succ || (succ === T.selfId && !mig)) { abort(why === 'timeout' ? 'Verbindung zum Gastgeber verloren.' : 'Der Gastgeber hat das Spiel verlassen.'); return; }
      orphan = Date.now();
      if (globalThis.__netDebug) console.log(`[net] host gone (${why}) at ${orphan % 100000}, succ ${succ}`);
      api.log?.(succ === T.selfId ? 'Gastgeber weg: du führst das Gefecht weiter.' : 'Gastgeber weg: warte auf den Nachfolger ...');
   }
   // this client carries on as the host: the replica World becomes the authoritative one
   function promote() {
      const world = net.world, rep = net.replica, m = mig, old = T.hostId;
      try {
         const fresh = new Map();
         for (const [id, b] of rep.buf) { const e = b[b.length - 1]; if (e && e.t * 60 > m.t) fresh.set(id, e); }
         for (const k of ['fire', 'setAmmo', 'useConsumable']) delete rep.own[k];
         restoreWorld(world, m, { fresh, setHuman });
         world.time = Math.max(world.time, rep.latest);
         delete world.update;                            // the World's own update again
         const me = setOwn(world, rep.ownId);
         const slots = startIn.slots.map((x, i) => ({ ...x, peer: m.pl?.[i]?.[0] ?? null }));
         const start = { v: startIn.v, mode: startIn.mode, mission: startIn.mission, mapId: startIn.mapId, difficulty: startIn.difficulty, seed: startIn.seed, roster: startIn.roster, slots };
         T.setHost(T.selfId);
         net.replica = null; net.isHost = true;
         const host = net.host = new NetHost(world, T, start, { onLog: api.log, self: startIn.self, onSuccessor: (id) => session.onSuccessor?.(id) });
         const here = new Set(T.peers());
         for (const c of host.cl) {
            const t = host.tank(c), on = !!c.peer && c.peer !== old && here.has(c.peer) && !!m.pl?.[c.i]?.[1];
            c.joined = on; c.lost = !on && !!c.peer && c.peer !== old;   // a client heard later comes back via its cmd
            if (t?.alive) setHuman(world, t, on);
         }
         const upd = world.update.bind(world);
         world.update = (dt) => { upd(dt); host.step(dt); };
         timers.forEach(clearInterval); timers.length = 0;
         T.send('sync', { k: 'host', id: T.selfId, t: Math.round(world.time * 60) });
         if (globalThis.__netDebug) console.log(`[net] promoted at ${Date.now() % 100000}, told ${JSON.stringify(T.peers())}`);
         api.log?.(`Gastgeber gewechselt: ${me.name} führt das Gefecht weiter.`);
         net.migrated = { stateTick: m.t, tick: Math.round(world.time * 60), waited: Date.now() - orphan };
      } catch (e) {
         console.error('[net] host migration failed', e);
         abort('Verbindung zum Gastgeber verloren.');
         return;
      }
      session.onHost?.(T.selfId);
   }
   // another client took over: the replica listens to it from now on
   function adopt(id) {
      if (net.ended) return;
      T.setHost(id); orphan = 0; succ = null; mig = null; lastHost = Date.now();
      const rep = net.replica;
      if (rep) { rep.latest = -1; rep.synced = false; rep.buf.clear(); }
      api.log?.('Neuer Gastgeber führt das Gefecht weiter.');
      session.onHost?.(id);
   }
   net.tickMigration = () => {
      if (!started || net.ended || net.isHost || net.world?.result) return;
      const t = Date.now();
      if (!orphan) { if (t - lastHost > HOST_SILENT) hostGone('timeout'); }
      else if (succ === T.selfId) { if (t - orphan >= PROMOTE_GRACE) promote(); }
      else if (t - orphan > MIGRATE_WAIT) abort('Verbindung zum Gastgeber verloren.');
   };
   timers.push(setInterval(net.tickMigration, 250));
   T.on('snap', (d, from) => { if (from !== T.hostId || net.isHost) return; lastHost = Date.now(); net.replica?.onSnap(d); });
   T.on('evt', (d, from) => { if (from !== T.hostId || net.isHost) return; lastHost = Date.now(); net.replica?.onEvt(d); });
   T.on('mig', (d, from) => { if (net.isHost || from !== T.hostId || d?.k !== 'mig' || !Array.isArray(d.tk)) return; if (!mig || !(d.t < mig.t)) mig = d; });
   T.on('sync', (d, from) => {
      if (!d) return;
      if (globalThis.__netDebug && d.k === 'host') console.log(`[net] host msg from ${from} host ${T.hostId} orphan ${orphan} succ ${succ} ended ${!!net.ended} ${Date.now() % 100000}`);
      // (the lobby may have switched the room's host to the new one already: from === T.hostId then)
      if (d.k === 'host' && !net.isHost && started && from !== T.selfId && (orphan || from === succ || from === T.hostId)) { adopt(from); return; }
      if (from !== T.hostId) return;
      lastHost = Date.now();
      const rep = net.replica, w = net.world;
      switch (d.k) {
         case 'start': {
            if (started) return;
            started = true; startIn = d;
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
         case 'left': hostGone('left'); break;
         case 'st': succ = d.hs || null; rep?.onSt(d); break;
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
