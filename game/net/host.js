// game/net/host.js — the host side of a match: runs the one real World, applies the captains'
// commands, sends snapshots (20 Hz), event batches, sync (4 Hz), per-player stats (1 Hz) and the end.
// See CONTRACT.md "Wire protocol".
//
//   host = new NetHost(world, transport, start, { onLog })
//   host.step(dt)          after every world.update(SIM_DT) (game.js wraps world.update)
//   host.dispose()
import { encodeSnap } from './codec.js';
import { applyCmd, tickFire } from './command.js';
import { setHuman } from './setup.js';

const SNAP_DT = 1 / 20, SYNC_DT = 1 / 4, ME_DT = 1;
const R2 = (v) => Math.round(v * 100) / 100;
// event fields worth the wire (consumers: hud kill feed / hit markers, fx, audio)
const EV_KEYS = ['srcId', 'dstId', 'dmg', 'dmgSelf', 'pos', 'dir', 'normal', 'ammo', 'cal', 'module', 'crew', 'state', 'side', 'cause', 'what',
   'plateName', 'part', 'effT', 'pen', 'angleDeg', 'overmatch', 'from', 'team', 'capId', 'progress', 'objId', 'phase', 'outcome', 'reason'];
function slimEvent(e) {
   const o = {};
   for (const k of EV_KEYS) {
      const v = e[k];
      if (v == null) continue;
      o[k] = typeof v === 'number' ? R2(v) : typeof v === 'object' ? { x: R2(v.x), y: R2(v.y), z: R2(v.z) } : v;
   }
   return o;
}
export const outcomeFor = (winner, team) => (winner === 0 ? 'draw' : winner === team ? 'win' : 'loss');
const MIRROR = { 'Alle Gegner zerstört': 'Eigenes Team vernichtet', 'Eigenes Team vernichtet': 'Alle Gegner zerstört',
   'Basis erobert': 'Basis verloren', 'Eigene Basis verloren': 'Basis erobert', 'Gegner hat die Basis erobert': 'Basis erobert' };

export class NetHost {
   constructor(world, transport, start, opts = {}) {
      this.w = world; this.T = transport; this.start = start; this.opts = opts;
      // remote captains (slot 0 is the host itself)
      this.cl = start.slots.map((s, i) => ({ i, peer: s.peer, tid: s.tid, wteam: s.wteam, team: s.team, name: s.name, joined: false, st: { seq: 0, done: 0, fireT: 0 }, rejoin: false })).slice(1);
      this.items = []; this.batch = 0; this.lastSeq = world.seq;
      this.shells = new Map();               // shell id -> ricochet count sent
      this.objAlive = world.terrain.objects.map((o) => o.alive !== false); this.objVer = world.terrain.version;
      this.snapT = 0; this.syncT = 0; this.meT = 0; this.ended = false;
      transport.on('cmd', (d, from) => {
         const c = this.byPeer(from); if (!c) return;
         if (!c.joined && c.lost && !this.ended) this.back(c);       // the route came back after a timeout
         if (c.joined) applyCmd(world, this.tank(c), c.st, d);
      });
      transport.on('sync', (d, from) => this.onSync(d, from));
      transport.onRejoin?.((oldId, newId) => { const c = this.byPeer(oldId); if (c) { c.peer = newId; c.joined = false; c.rejoin = true; c.st = { seq: 0, done: 0, fireT: 0 }; } });
   }
   byPeer(id) { return this.cl.find((c) => c.peer === id) || null; }
   tank(c) { return this.w.tankById(c.tid); }
   peers() { return this.cl.filter((c) => c.joined).map((c) => c.peer); }

   onSync(d, from) {
      if (!d || typeof d !== 'object') return;
      const c = this.byPeer(from);
      if (d.k === 'hello') {
         if (!c) { this.T.send('sync', { k: 'refuse', why: 'unknown' }, from); return; }
         if (d.v !== this.start.v) { this.T.send('sync', { k: 'refuse', why: 'version' }, from); return; }
         if (this.ended) return;
         const late = c.rejoin || this.w.time > 1;
         const deadObj = [];
         this.w.terrain.objects.forEach((o, i) => { if (o.alive === false) deadObj.push([i, R2(o.fallYaw || 0)]); });
         this.T.send('sync', { ...this.start, k: 'start', self: c.i, rejoin: late ? 1 : 0, deadObj, slots: this.start.slots.map(({ peer, ...s }) => s) }, from);
         if (!c.joined) { c.joined = true; c.rejoin = false; c.lost = false; setHuman(this.w, this.tank(c), true); this.opts.onLog?.(`${c.name} ist im Gefecht.`); }
      } else if (d.k === 'bye' && c) this.drop(c, 'hat das Gefecht verlassen');
   }
   /** Peer gone (bye or transport): its tank goes back to the AI. */
   drop(c, why) {
      if (!c.joined) return;
      c.joined = false;
      const t = this.tank(c);
      if (t) { setHuman(this.w, t, false); }
      this.opts.onLog?.(`${c.name} ${why}.`);
   }
   peerLeft(id) { const c = this.byPeer(id); if (c?.joined) { this.drop(c, 'hat die Verbindung verloren'); c.lost = true; } }
   /** A captain the transport had given up is heard again: the tank is his again (no new start needed). */
   back(c) {
      const t = this.tank(c);
      c.joined = true; c.lost = false;
      if (t?.alive) setHuman(this.w, t, true);
      this.opts.onLog?.(`${c.name} ist wieder verbunden.`);
   }

   step(dt) {
      const w = this.w;
      for (const c of this.cl) if (c.joined) tickFire(w, this.tank(c), c.st, dt);
      this.harvest();
      this.snapT += dt; this.syncT += dt; this.meT += dt;
      if (this.snapT >= SNAP_DT) { this.snapT %= SNAP_DT; this.flush(); this.snaps(); }
      if (this.syncT >= SYNC_DT) { this.syncT %= SYNC_DT; this.sync(); }
      if (this.meT >= ME_DT) { this.meT %= ME_DT; for (const c of this.cl) if (c.joined) this.T.send('sync', { k: 'me', s: this.tank(c).stats }, c.peer); }
      if (!this.ended && /^(won|lost|draw)$/.test(w.phase)) this.finish();
   }

   /** World changes since the last step -> evt items. */
   harvest() {
      const w = this.w, it = this.items;
      // events (ring of 256; never more than that per step)
      for (let s = Math.max(this.lastSeq + 1, w.seq - 255); s <= w.seq; s++) {
         const e = w.events[s % 256];
         if (e && e.seq === s) it.push(['e', e.type, slimEvent(e)]);
      }
      this.lastSeq = w.seq;
      // shells: spawn (and new leg after a ricochet) / removal
      const seen = this.shells;
      for (const s of w.shells) {
         if (!s.alive) continue;
         if (seen.get(s.id) !== s.ricochets) {
            seen.set(s.id, s.ricochets);
            it.push(['s', s.id, s.ownerId, R2(s.pos.x), R2(s.pos.y), R2(s.pos.z), R2(s.vel.x), R2(s.vel.y), R2(s.vel.z), s.ammo, s.caliber]);
         }
      }
      if (seen.size) {
         const live = new Set(); for (const s of w.shells) if (s.alive) live.add(s.id);
         for (const id of seen.keys()) if (!live.has(id)) {
            seen.delete(id);
            const s = w.shells.find((x) => x.id === id);
            it.push(s ? ['x', id, R2(s.pos.x), R2(s.pos.y), R2(s.pos.z)] : ['x', id]);
         }
      }
      // effects
      for (const e of w.effects) {
         if (e._net) continue;
         e._net = 1;
         it.push(['f', e.kind, R2(e.pos.x), R2(e.pos.y), R2(e.pos.z), R2(e.size ?? 1), R2(e.life ?? 1.5), e.cal ?? 0, e.objId ?? -1]);
      }
      // terrain objects (trees / houses) destroyed by tanks or shells
      const T = w.terrain;
      if (T.version !== this.objVer) {
         this.objVer = T.version;
         T.objects.forEach((o, i) => { if (this.objAlive[i] && o.alive === false) { this.objAlive[i] = false; it.push(['o', i, R2(o.fallYaw || 0)]); } });
      }
   }
   flush() {
      if (!this.items.length) return;
      const to = this.peers();
      if (to.length) this.T.send('evt', [++this.batch, this.tick(), this.items], to);
      this.items = [];
   }
   tick() { return Math.round(this.w.time * 60); }
   snaps() {
      const w = this.w, tick = this.tick();
      for (const c of this.cl) {
         if (!c.joined) continue;
         const t = this.tank(c);
         this.T.send('snap', encodeSnap(w, tick, c.st.done, c.st.seq, t, t.team), c.peer);
      }
   }
   sync() {
      const w = this.w, to = this.peers();
      if (!to.length) return;
      this.T.send('sync', { k: 'st', t: this.tick(), ph: w.phase, cd: R2(w.countdown), tl: w.timeLeft == null ? null : R2(w.timeLeft),
         caps: w.caps.map((c) => [R2(c.progress), c.capper ?? 0, c.n ?? 0]) }, to);
   }
   /** Result per player: outcome for its own team, its own stats; PvP: the table of all captains. */
   finish() {
      this.ended = true;
      this.flush();
      const w = this.w, res = w.result || {};
      const pl = this.start.slots.map((s) => { const t = w.tankById(s.tid); return [s.name, s.team ?? s.wteam, Math.round(t.stats.dmg), t.stats.kills, t.alive ? 1 : 0]; });
      const ht = this.start.slots[0].team ?? 1, lobbyTeam = (wt) => (wt === 1 ? ht : 3 - ht);
      for (const c of this.cl) {
         if (!c.joined) continue;
         const t = this.tank(c), outcome = outcomeFor(w.winner ?? res.winner, t.team);
         const reason = outcome === (res.outcome) ? res.reason : MIRROR[res.reason] || res.reason;
         this.T.send('sync', { k: 'end', outcome, reason, winner: w.winner, time: R2(w.time), s: t.stats, alive: t.alive ? 1 : 0,
            pvp: this.start.mode === 'pvp' ? { win: w.winner ? lobbyTeam(w.winner) : 0, my: c.team ?? lobbyTeam(t.team), pl } : undefined }, c.peer);
      }
      this.result = { pvp: this.start.mode === 'pvp' ? { win: w.winner ? lobbyTeam(w.winner) : 0, my: this.start.slots[0].team ?? 1, pl } : undefined };
   }
   /** Host leaves before the end. */
   abort() { if (!this.ended) { this.ended = true; this.T.send('sync', { k: 'abort' }); } }
}
