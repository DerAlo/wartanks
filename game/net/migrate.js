// game/net/migrate.js — host migration: the full state a successor needs to carry on a running match
// when the host is gone (CONTRACT.md "Host migration"), modelled on warships game3d/net/migrate.js.
// The host sends it to the one client it named as successor once a second (channel `mig`, latest
// wins). When the host is gone, that client turns its replica World into the authoritative one
// (game.js promote()). The message carries what a client never sees: every tank's internals (reload,
// modules, crew, fires, consumables, ammo, statistics, spotting timers, tanks out of sight in PvP)
// and the bots' AI state, plus the World's timers and capture circles.
// Lost on the way: shells in the air. No DOM in here.
//
//   packState(world, { pl }) -> mig          host
//   restoreWorld(world, mig, { fresh })      successor; fresh: Map tank id -> newest replica pose
//                                            (the snapshot is newer than the full state)
export const MIG_DT = 1;             // s between two full states
const MAX_DEPTH = 4, MAX_LIST = 256;
// tank fields that are configuration, geometry, AI (packed apart) or client-only
const TANK_SKIP = new Set(['cfg', 'armor', 'ai', 'visible', 'isPlayer', 'side', 'bot', 'fire', 'setAmmo', 'useConsumable']);
const AI_SKIP = new Set(['w', 'tank', 'rng', 'D']);
const WORLD_KEYS = ['time', 'phase', 'countdown', 'timeLeft', 'caps', 'result', 'winner', '_spotAcc'];
// what the newest snapshot knows better than a full state up to a second old
const FRESH = ['yaw', 'pitch', 'roll', 'speed', 'turretYaw', 'gunPitch'];

const rn = (v) => { const a = Math.abs(v); return a >= 1000 ? Math.round(v * 10) / 10 : a >= 10 ? Math.round(v * 100) / 100 : Math.round(v * 1e4) / 1e4; };

// Plain data for the wire: numbers rounded, tanks as { $t: id }, Sets as { $set }, infinities as
// { $i }; class instances other than tanks, functions and deep or long structures are left out.
function packer(world) {
   const pk = (v, d) => {
      if (typeof v === 'number') return Number.isFinite(v) ? rn(v) : Number.isNaN(v) ? null : { $i: v > 0 ? 1 : -1 };
      if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
      if (typeof v !== 'object') return undefined;
      if (typeof v.id === 'number' && world.tankById(v.id) === v) return { $t: v.id };
      if (d <= 0) return undefined;
      if (v instanceof Set) return v.size <= MAX_LIST ? { $set: [...v].map((x) => pk(x, 0) ?? null) } : undefined;
      if (Array.isArray(v)) return v.length <= MAX_LIST ? v.map((x) => pk(x, d - 1) ?? null) : undefined;
      const p = Object.getPrototypeOf(v);
      if (p !== Object.prototype && p !== null) return undefined;
      const o = {};
      for (const k of Object.keys(v)) { const y = pk(v[k], d - 1); if (y !== undefined) o[k] = y; }
      return o;
   };
   return pk;
}
function unpacker(world) {
   const uk = (v) => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(uk);
      if ('$t' in v) return world.tankById(v.$t) || null;
      if ('$i' in v) return v.$i > 0 ? Infinity : -Infinity;
      if ('$set' in v) return new Set(v.$set.map(uk));
      const o = {};
      for (const k of Object.keys(v)) o[k] = uk(v[k]);
      return o;
   };
   return uk;
}
const packObj = (pk, obj, skip) => { const o = {}; for (const k of Object.keys(obj)) { if (skip.has(k)) continue; const y = pk(obj[k], MAX_DEPTH); if (y !== undefined) o[k] = y; } return o; };

/** Host: the full state. extra (pl: peer ids by slot, gone flags ...) goes along as it is. */
export function packState(world, extra = {}) {
   const pk = packer(world);
   const w = {};
   for (const k of WORLD_KEYS) { const y = pk(world[k], MAX_DEPTH); if (y !== undefined) w[k] = y; }
   const tk = world.tanks.map((t) => [t.id, packObj(pk, t, TANK_SKIP), t.ai ? packObj(pk, t.ai, AI_SKIP) : null]);
   return { k: 'mig', t: Math.round(world.time * 60), w, tk, ...extra };
}

/** Successor: its replica World takes the host's state. Returns { tanks, bots } restored. */
export function restoreWorld(world, m, { fresh = null, setHuman } = {}) {
   const uk = unpacker(world);
   for (const k of WORLD_KEYS) if (k in m.w) world[k] = uk(m.w[k]);
   let tanks = 0, bots = 0;
   for (const [id, f, ai] of m.tk || []) {
      const t = world.tankById(id);
      if (!t) continue;
      const snap = fresh?.get(id);
      for (const k of Object.keys(f)) {
         const v = uk(f[k]);
         // plain sub-objects are merged into the existing ones (other code may hold references)
         if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Set) && t[k] && typeof t[k] === 'object' && Object.getPrototypeOf(t[k]) === Object.prototype && !world.tankById(v.id ?? -1)) Object.assign(t[k], v);
         else t[k] = v;
      }
      if (snap && t.alive) { t.pos.x = snap.x; t.pos.y = snap.y; t.pos.z = snap.z; for (const k of FRESH) if (snap[k] != null) t[k] = snap[k]; }
      tanks++;
      if (ai && t.alive) {
         if (!t.ai) setHuman?.(world, t, false);
         if (t.ai) { for (const k of Object.keys(ai)) t.ai[k] = uk(ai[k]); if (!Array.isArray(t.ai.path)) { t.ai.path = null; t.ai.pi = 0; } bots++; }
      }
   }
   world.shells.length = 0;            // the replica's shells were pictures only
   return { tanks, bots };
}
