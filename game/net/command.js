// game/net/command.js — client controls on the wire (`cmd` channel, latest wins). See CONTRACT.md.
//
//   cmd = [seq, throttle*100, steer*100, brake 0|1, aimX*10, aimY*10, aimZ*10, lockId|0, actBase, actions]
//   continuous controls are a full state (a lost cmd costs nothing); one-shot actions are numbered
//   from actBase and repeated in every cmd until the host acknowledges their count in a snapshot.
//   actions: ['F'] fire, ['A', ammoType] ammo switch, ['C', consumableId] consumable.
const r = (v, k) => Math.round((+v || 0) * k);

export class Commander {
   constructor() { this.seq = 0; this.base = 0; this.actions = []; }
   action(a) { if (this.actions.length < 32) this.actions.push(a); }
   /** Host acknowledged `n` actions in total. */
   ack(n) {
      const drop = n - this.base;
      if (drop > 0) { this.actions.splice(0, drop); this.base = n; }
   }
   build(tank) {
      const i = tank.input || {}, a = tank.aimPoint || tank.pos;
      return [++this.seq, r(Math.max(-1, Math.min(1, i.throttle)), 100), r(Math.max(-1, Math.min(1, i.steer)), 100), i.brake ? 1 : 0,
         r(a.x, 10), r(a.y, 10), r(a.z, 10), i.lockId | 0, this.base, this.actions.slice()];
   }
}

/** Host side, one per remote captain: st = { seq, done, fireT }. Returns false for a stale / bad cmd. */
export function applyCmd(world, tank, st, c) {
   if (!Array.isArray(c) || c.length < 10 || !(c[0] > st.seq)) return false;
   st.seq = c[0];
   const num = (v, lo, hi) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, +v)) : 0);
   const inp = tank.input;
   inp.throttle = num(c[1], -100, 100) / 100; inp.steer = num(c[2], -100, 100) / 100; inp.brake = !!c[3];
   inp.lockId = c[7] | 0 || null;
   tank.aimPoint ??= { x: 0, y: 0, z: 0 };
   tank.aimPoint.x = num(c[4], -1e5, 1e5) / 10; tank.aimPoint.y = num(c[5], -1e5, 1e5) / 10; tank.aimPoint.z = num(c[6], -1e5, 1e5) / 10;
   const base = c[8] | 0, acts = Array.isArray(c[9]) ? c[9] : [];
   for (let k = Math.max(0, st.done - base); k < acts.length; k++) {
      const a = acts[k];
      st.done = base + k + 1;
      if (!Array.isArray(a)) continue;
      if (a[0] === 'F') st.fireT = 0.35;                       // fire as soon as loaded, within 0.35 s
      else if (a[0] === 'A' && typeof a[1] === 'string') tank.setAmmo(a[1]);
      else if (a[0] === 'C' && typeof a[1] === 'string' && tank.consumables[a[1]]) tank.useConsumable(a[1]);
   }
   return true;
}

/** Host, every step: a pending fire order goes off when the gun is loaded. */
export function tickFire(world, tank, st, dt) {
   if (!(st.fireT > 0)) return;
   if (world.phase === 'playing' && tank.alive && tank.reload <= 0 && tank.fire(world)) st.fireT = 0;
   else st.fireT -= dt;
}
