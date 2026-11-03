// game/net/replica.js — a client's World. It never simulates tanks: positions come from host
// snapshots and are interpolated ~1.5 snapshot intervals in the past; the own turret / gun are
// predicted locally from the own aim point (Tank._aim) so aiming feels instant; shells are flown
// locally from their spawn data (tracers, sounds) and end where the host says they hit.
// Renderer, HUD, FX and audio keep reading world.tanks / events / effects / shells as in single player.
//
//   rep = new Replica(world, transport, ownTankId)    game.js replaces world.update with rep.update
//   rep.onSnap(u8), rep.onEvt([batch, tick, items]), rep.onSt(st), rep.onMe(stats)
import { decodeSnap, applyBits, applyOwn } from './codec.js';
import { Commander } from './command.js';
import { gunWorld } from '../armor.js';
import { WORLD } from '../config.js';

const CMD_DT = 1 / 30, KEEP = 10;
const lerp = (a, b, k) => a + (b - a) * k;
const lerpA = (a, b, k) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

export class Replica {
   constructor(world, transport, ownId) {
      this.w = world; this.T = transport; this.ownId = ownId; this.own = world.tankById(ownId);
      this.cmd = new Commander();
      this.buf = new Map();                  // tank id -> [{ t, x, y, z, yaw, pitch, roll, speed, turretYaw, gunPitch }]
      this.latest = -1; this.clock = 0; this.synced = false; this.delay = 0.1; this.lastArr = 0; this.ivl = 0.05;
      this.cmdT = 0; this.snaps = 0; this.shots = new Map();
      this.objAlive = null;
      // own tank: the gun's actions go to the host instead of the local sim
      const me = this.own, C = this.cmd;
      me.fire = () => { if (me.alive && me.reload <= 0) C.action(['F']); return null; };
      me.setAmmo = (type) => { if (type !== me.ammoSel && me.ammoCount[type] > 0) { C.action(['A', type]); return true; } return false; };
      me.useConsumable = (id) => { const c = me.consumables[id]; if (c && c.count > 0 && !(c.cd > 0)) { C.action(['C', id]); return true; } return false; };
   }

   onSnap(u8) {
      const s = decodeSnap(u8 instanceof Uint8Array ? u8 : new Uint8Array(u8));
      if (!s) return;
      const t = s.tick / 60;
      if (t <= this.latest) return;
      const now = performance.now() / 1000;
      if (this.lastArr) this.ivl = this.ivl * 0.9 + Math.min(0.5, now - this.lastArr) * 0.1;
      this.lastArr = now; this.latest = t; this.snaps++;
      this.delay = Math.max(0.08, Math.min(0.4, this.ivl * 1.6));
      if (!this.synced) { this.clock = t - this.delay; this.synced = true; }
      const w = this.w, seen = new Set();
      for (const r of s.tanks) {
         const tk = w.tankById(r.id); if (!tk) continue;
         seen.add(tk);
         let b = this.buf.get(r.id); if (!b) this.buf.set(r.id, b = []);
         b.push({ t, x: r.x, y: r.y, z: r.z, yaw: r.yaw, pitch: r.pitch, roll: r.roll, speed: r.speed, turretYaw: r.turretYaw, gunPitch: r.gunPitch });
         if (b.length > KEEP) b.shift();
         const wasAlive = tk.alive;
         tk.alive = !!(r.flags & 1); tk.burning = !!(r.flags & 2); tk.spotted = !!(r.flags & 4); tk.turretOff = !!(r.flags & 8);
         tk.detected = !!(r.flags & 16); tk.gunBlocked = tk === this.own ? tk.gunBlocked : !!(r.flags & 32);
         if (wasAlive && !tk.alive) { tk.wreckT = 0; tk.hp = 0; tk.speed = 0; }
         tk.hp = r.hp; tk.visible = true;
         applyBits(tk, r.bits);
         const last = this.shots.get(r.id);
         if (last != null && last !== r.shots) tk.lastFire = w.time;
         this.shots.set(r.id, r.shots);
      }
      for (const tk of w.tanks) if (!seen.has(tk) && tk.team !== this.own.team) { tk.spotted = false; tk.visible = false; this.buf.delete(tk.id); }
      if (s.own) applyOwn(this.own, s.own);
      this.cmd.ack(s.ack);
   }

   onEvt(d) {
      if (!Array.isArray(d) || !Array.isArray(d[2])) return;
      const w = this.w;
      for (const it of d[2]) {
         switch (it[0]) {
            case 'e': w.emit(it[1], it[2]); break;
            case 's': this.spawnShell(it); break;
            case 'x': { const s = w.shells.find((x) => x.alive && x.id === it[1]);
               if (s) { if (it.length > 2) s.endTravel = Math.hypot(it[2] - s.start.x, it[3] - s.start.y, it[4] - s.start.z) + (s.legTravel || 0); else s.alive = false; }
               break; }
            case 'f': w.effect(it[1], { x: it[2], y: it[3], z: it[4] }, { size: it[5], life: it[6], cal: it[7], ...(it[8] >= 0 ? { objId: it[8] } : {}) }); break;
            case 'o': { const T = w.terrain, o = T.objects[it[1]]; if (o && o.alive !== false) { o.alive = false; o.fallYaw = it[2]; T.version++; } break; }
         }
      }
   }
   spawnShell(it) {
      const w = this.w;
      let s = w.shells.find((x) => x.alive && x.id === it[1]);
      if (!s) {
         s = w.shells.find((x) => !x.alive);
         if (!s) { s = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, start: { x: 0, y: 0, z: 0 } }; w.shells.push(s); }
         s.id = it[1]; s.travel = 0; s.age = 0; s.legTravel = 0;
      } else s.legTravel = s.travel;            // ricochet: a new leg from the hit point
      const own = w.tankById(it[2]);
      s.alive = true; s.ownerId = it[2]; s.team = own?.team ?? 0; s.tracer = true; s.endTravel = Infinity;
      s.pos.x = s.start.x = it[3]; s.pos.y = s.start.y = it[4]; s.pos.z = s.start.z = it[5];
      s.vel.x = it[6]; s.vel.y = it[7]; s.vel.z = it[8];
      s.ammo = it[9]; s.caliber = it[10]; s.round = own?.cfg.gun.ammo.find((a) => a.type === it[9]) || { type: it[9], cal: it[10] };
   }
   onSt(st) {
      const w = this.w;
      if (!/^(won|lost|draw)$/.test(w.phase)) w.phase = st.ph === 'won' || st.ph === 'lost' || st.ph === 'draw' ? w.phase : st.ph;
      w.countdown = st.cd; w.timeLeft = st.tl;
      (st.caps || []).forEach((c, i) => { const cap = w.caps[i]; if (cap) { cap.progress = c[0]; cap.capper = c[1] || null; cap.n = c[2]; } });
   }
   onMe(s) { if (s && typeof s === 'object') Object.assign(this.own.stats, s); }

   update(dt) {
      const w = this.w;
      if (this.synced) {
         this.clock += dt;
         const target = this.latest - this.delay;
         if (Math.abs(target - this.clock) > 0.5) this.clock = target; else this.clock += (target - this.clock) * Math.min(1, dt * 2);
      }
      w.time = Math.max(w.time, this.clock);
      if (w.phase === 'countdown' && w.countdown > 0) w.countdown = Math.max(0, w.countdown - dt);
      if (w.phase === 'playing' && w.timeLeft > 0) w.timeLeft = Math.max(0, w.timeLeft - dt);
      for (const t of w.tanks) this.place(t, dt);
      this.flyShells(dt);
      for (let i = w.effects.length - 1; i >= 0; i--) {
         const e = w.effects[i]; e.t += dt;
         if (e.t > e.life) { w.effects[i] = w.effects[w.effects.length - 1]; w.effects.pop(); }
      }
      const me = this.own;
      if (me.reload > 0) me.reload = Math.max(0, me.reload - dt);
      for (const k in me.consumables) { const c = me.consumables[k]; if (c.cd > 0) c.cd = Math.max(0, c.cd - dt); }
      this.cmdT += dt;
      if (this.cmdT >= CMD_DT && this.T.hostId) { this.cmdT = 0; this.T.send('cmd', this.cmd.build(me), this.T.hostId); }
   }

   place(t, dt) {
      const b = this.buf.get(t.id);
      if (!t.alive) t.wreckT = (t.wreckT || 0) + dt;
      if (!b || !b.length) return;
      const ct = this.clock;
      let a = b[0], c = b[b.length - 1], k = 1;
      if (ct <= a.t) { c = a; k = 1; }
      else if (ct < c.t) {
         for (let i = 1; i < b.length; i++) if (b[i].t >= ct) { a = b[i - 1]; c = b[i]; break; }
         k = (ct - a.t) / Math.max(1e-6, c.t - a.t);
      } else a = c;                            // behind on data: hold the newest
      const old = { x: t.pos.x, z: t.pos.z };
      t.pos.x = lerp(a.x, c.x, k); t.pos.y = lerp(a.y, c.y, k); t.pos.z = lerp(a.z, c.z, k);
      t.yaw = lerpA(a.yaw, c.yaw, k); t.pitch = lerp(a.pitch, c.pitch, k); t.roll = lerp(a.roll, c.roll, k);
      t.speed = lerp(a.speed, c.speed, k); t.speedKmh = t.speed * 3.6;
      if (dt > 0) { t.vel.x = (t.pos.x - old.x) / dt; t.vel.z = (t.pos.z - old.z) / dt; }
      if (t === this.own && t.alive) {
         if (!this.aimed) { t.turretYaw = c.turretYaw; t.gunPitch = c.gunPitch; this.aimed = true; }
         t.pose();
         if (dt > 0) t._aim(dt);               // local turret / gun prediction toward the own aim point
         return;
      }
      t.turretYaw = lerpA(a.turretYaw, c.turretYaw, k); t.gunPitch = lerp(a.gunPitch, c.gunPitch, k);
      const P = t.pose(); gunWorld(t.cfg, P, t.muzzle, t.gunDir);
   }

   flyShells(dt) {
      const w = this.w, g = WORLD.G, T = w.terrain;
      for (const s of w.shells) {
         if (!s.alive) continue;
         s.age = (s.age || 0) + dt;
         s.vel.y -= g * dt;
         const dx = s.vel.x * dt, dy = s.vel.y * dt, dz = s.vel.z * dt, L = Math.hypot(dx, dy, dz);
         s.pos.x += dx; s.pos.y += dy; s.pos.z += dz; s.travel += L;
         if (s.travel >= s.endTravel || s.age > 6 || s.pos.y < T.heightAt(s.pos.x, s.pos.z) - 3) s.alive = false;
      }
   }
}
