// game/ballistics.js — shell flight, penetration, damage to HP / modules / crew (pure sim).
//
// Pure rules (unit-tested):
//   penAt(round, dist)                     nominal pen (mm) at a distance (linear 100 m -> 500 m)
//   rollPen(round, dist, rng)              ±25 % triangular
//   resolveImpact(target, origin, dir, shell, rng) -> result   (armour walk along one ray)
//   heSplash(target, point, round, rng) -> result               (HE burst near / on a tank)
//   solveElevation(v, dx, dy, g)           low-angle pitch to hit a point dx ahead, dy up
// Flight (World glue):
//   fireShell(world, tank, round, pos, dir)   -> shell from world.shells pool
//   updateShells(world, dt)                     sub-stepped ray march; calls world.onHit(...)
//
// target = { armor (armor.js model), pose (pose object, see armor.js), id }
// result = { kind:'pen'|'ricochet'|'noPen'|'he'|'miss', dmg, plateId, part, side, t, effT,
//            angleDeg, pen, point{x,y,z}, normal{x,y,z}, crits:[{ kind:'module'|'crew', id, dmg }],
//            ricDir{x,y,z}|null, ricPen, overmatch }
import { AMMO, BALLISTICS as B, WORLD } from './config.js';
import { rayArmor, rayModules, modulesNear, effective } from './armor.js';

const D2R = Math.PI / 180;
const SPACED = { track: true, skirt: true, mantlet: true };

export function penAt(round, dist) {
   const rule = AMMO[round.type];
   const p500 = round.pen500 ?? round.pen * (1 - (rule?.falloff ?? 0));
   if (dist <= B.FALL_START) return round.pen;
   if (dist >= B.FALL_END) return p500;
   return round.pen + (p500 - round.pen) * (dist - B.FALL_START) / (B.FALL_END - B.FALL_START);
}
export const rollPen = (round, dist, rng) => penAt(round, dist) * (1 + B.PEN_RANDOM * rng.tri());
export const rollDmg = (dmg, rng) => dmg * (1 + B.DMG_RANDOM * (rng() * 2 - 1));

/** Normalisation in degrees for a round against plate t (overmatch-aware). */
export function normalisation(type, cal, t) {
   const n = AMMO[type]?.norm ?? 0;
   if (n && cal > B.OVERMATCH_NORM * t) return n * 1.4 * cal / (2 * t);
   return n;
}
/** Would this impact ricochet? (before the pen roll) */
export function ricochets(type, cal, t, angleDeg) {
   const ric = AMMO[type]?.ric;
   if (ric == null || t <= 0) return false;
   if (cal > B.OVERMATCH * t) return false;
   return angleDeg > ric;
}

function newResult() {
   return { kind: 'miss', dmg: 0, plateId: null, part: null, side: null, t: 0, effT: 0, angleDeg: 0, pen: 0,
      point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, crits: [], ricDir: null, ricPen: 0, overmatch: false };
}
function setPlate(r, h, effT) {
   r.plateId = h.plateId; r.part = h.part; r.side = h.side; r.t = h.t; r.effT = effT; r.angleDeg = h.angleDeg;
   r.point.x = h.point.x; r.point.y = h.point.y; r.point.z = h.point.z;
   r.normal.x = h.normal.x; r.normal.y = h.normal.y; r.normal.z = h.normal.z;
}
const trackId = (h) => (h.side === 'L' ? 'trackL' : 'trackR');

/** Post-penetration damage to module/crew boxes along the shell path. */
function postPen(target, origin, dir, t0, len, dmg, rng, crits) {
   if (len <= 0) return;
   const hits = rayModules(target.armor, target.pose, origin, dir, t0, t0 + len);
   let k = 1;
   for (const m of hits) {
      if (m.kind === 'crew' && rng() > 0.75) continue;
      crits.push({ kind: m.kind, id: m.id, dmg: Math.round(rollDmg(dmg, rng) * k) });
      k *= 0.75;
   }
}

/**
 * Walk the armour along one ray. `shell` = { type, cal, dmg, pen (current, already rolled),
 * heatAir? } — not modified. Returns a fresh result.
 */
export function resolveImpact(target, origin, dir, shell, rng) {
   const r = newResult();
   const hits = rayArmor(target.armor, target.pose, origin, dir);
   const { type, cal } = shell;
   let pen = shell.pen, firstDist = -1, lastDist = 0, lastT = 0, spacedHit = false;
   for (let i = 0; i < hits.length && i < B.MAX_PLATES; i++) {
      const h = hits[i];
      if (h.t <= 0) continue;                       // open top: shell passes
      if (type === 'HEAT' && firstDist >= 0) {
         const air = Math.max(0, h.dist - lastDist - lastT / 1000);
         pen *= Math.max(0, 1 - B.HEAT_AIR_LOSS * air);
      }
      if (firstDist < 0) firstDist = h.dist;
      lastDist = h.dist; lastT = h.t;
      const over = cal > B.OVERMATCH * h.t;
      // ---- HE: explodes on the first plate
      if (type === 'HE') {
         const effT = h.t / Math.max(0.05, Math.cos(h.angleDeg * D2R));
         setPlate(r, h, effT); r.pen = pen; r.overmatch = over;
         if (h.part === 'track') r.crits.push({ kind: 'module', id: trackId(h), dmg: Math.round(rollDmg(shell.dmg, rng) * 0.6) });
         if (pen > effT && !SPACED[h.part] && h.part !== 'gun') {
            r.kind = 'pen'; r.dmg = Math.round(rollDmg(shell.dmg, rng));
            postPen(target, origin, dir, h.dist, 1.0, shell.dmg * 0.8, rng, r.crits);
            return r;
         }
         // splash against the plate that shields the inside (behind spaced armour: next real plate)
         let shieldT = effT;
         if (SPACED[h.part] || h.part === 'gun') {
            for (let j = i + 1; j < hits.length; j++) if (hits[j].part === 'hull' || hits[j].part === 'turret') { shieldT = hits[j].t + effT; break; }
            if (h.part === 'gun') r.crits.push({ kind: 'module', id: 'gun', dmg: Math.round(rollDmg(shell.dmg, rng) * 0.5) });
         }
         r.kind = 'he';
         r.dmg = Math.max(0, Math.round(rollDmg(shell.dmg, rng) / 2 - shieldT * B.HE_SPLASH_K));
         if (r.dmg > 0) heModules(target, h.point, shell, r.crits, rng, 0.5);
         return r;
      }
      // ---- kinetic / HEAT
      if (ricochets(type, cal, h.t, h.angleDeg)) {
         setPlate(r, h, effective(h.t, h.angleDeg)); r.pen = pen;
         r.kind = 'ricochet';
         const k = 2 * (dir.x * h.normal.x + dir.y * h.normal.y + dir.z * h.normal.z);
         r.ricDir = { x: dir.x - k * h.normal.x, y: dir.y - k * h.normal.y, z: dir.z - k * h.normal.z };
         r.ricPen = type === 'HEAT' ? 0 : pen * (1 - B.RIC_PEN_LOSS);
         if (h.part === 'track') r.crits.push({ kind: 'module', id: trackId(h), dmg: Math.round(rollDmg(shell.dmg, rng) * 0.3) });
         return r;
      }
      const ang = Math.max(0, h.angleDeg - normalisation(type, cal, h.t));
      const effT = effective(h.t, ang);
      setPlate(r, h, effT); r.pen = pen; r.overmatch = over;
      if (h.part === 'gun') {
         // the barrel stops the shell; the gun is damaged
         r.kind = 'noPen';
         r.crits.push({ kind: 'module', id: 'gun', dmg: Math.round(rollDmg(shell.dmg, rng)) });
         return r;
      }
      if (SPACED[h.part]) {
         spacedHit = true;
         if (h.part === 'track') r.crits.push({ kind: 'module', id: trackId(h), dmg: Math.round(rollDmg(shell.dmg, rng) * 0.6) });
         if (pen <= effT) { r.kind = 'noPen'; return r; }
         pen -= effT;
         continue;
      }
      if (pen > effT) {
         r.kind = 'pen';
         r.dmg = Math.round(rollDmg(shell.dmg, rng));
         postPen(target, origin, dir, h.dist, AMMO[type].postPen * Math.min(1.3, 0.6 + cal / 200), shell.dmg, rng, r.crits);
         return r;
      }
      r.kind = 'noPen';
      return r;
   }
   // passed only through spaced armour / open top (or missed every plate)
   if (spacedHit) r.kind = 'noPen';
   return r;
}

function heModules(target, p, shell, crits, rng, k) {
   const R = B.HE_RADIUS(shell.cal);
   modulesNear(target.armor, target.pose, p, R, (kind, id, d) => {
      if (kind === 'crew' && rng() > 0.5) return;
      crits.push({ kind, id, dmg: Math.round(rollDmg(shell.dmg, rng) * k * (1 - d / R)) });
   });
}

const _c = { x: 0, y: 0, z: 0 }, _dir = { x: 0, y: 0, z: 0 };
/**
 * HE burst at `point` (ground / object / near miss) against a tank: splash through the plate
 * facing the burst, scaled by distance. Result kind 'he' (dmg may be 0) or 'miss' if out of range.
 */
export function heSplash(target, point, shell, rng) {
   const r = newResult();
   const A = target.armor, P = target.pose;
   const R = B.HE_RADIUS(shell.cal) * 2.2;
   _c.x = P.pos.x; _c.y = P.pos.y + A.boundY; _c.z = P.pos.z;
   _dir.x = _c.x - point.x; _dir.y = _c.y - point.y; _dir.z = _c.z - point.z;
   const L = Math.hypot(_dir.x, _dir.y, _dir.z) || 1;
   _dir.x /= L; _dir.y /= L; _dir.z /= L;
   const hits = rayArmor(A, P, point, _dir);
   let h = null, spacedT = 0;
   for (const x of hits) {
      if (x.part === 'hull' || x.part === 'turret') { if (x.t > 0) { h = x; break; } continue; }
      if (x.part === 'track' || x.part === 'skirt') spacedT += x.t;
   }
   if (!h) { r.kind = 'miss'; return r; }
   const d = h.dist;
   if (d > R) { r.kind = 'miss'; return r; }
   const fall = 1 - d / R;
   setPlate(r, h, h.t);
   r.kind = 'he'; r.pen = shell.pen;
   r.dmg = Math.max(0, Math.round(rollDmg(shell.dmg, rng) / 2 * fall - (h.t + spacedT) * B.HE_SPLASH_K));
   if (r.dmg > 0) heModules(target, point, shell, r.crits, rng, 0.4 * fall);
   return r;
}

/**
 * Elevation (rad) to hit a point `dx` metres away horizontally and `dy` higher, muzzle speed v.
 * Low-angle solution; returns NaN when out of range.
 */
export function solveElevation(v, dx, dy, g = WORLD.G) {
   const v2 = v * v, disc = v2 * v2 - g * (g * dx * dx + 2 * dy * v2);
   if (disc < 0) return NaN;
   return Math.atan2(v2 - Math.sqrt(disc), g * dx);
}

// ------------------------------------------------------------------ flight
let _shellId = 1;
/** Take a shell from the pool and launch it. round = cfg.gun.ammo entry. */
export function fireShell(world, tank, round, pos, dir) {
   let s = null;
   for (const x of world.shells) if (!x.alive) { s = x; break; }
   if (!s) { s = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, start: { x: 0, y: 0, z: 0 } }; world.shells.push(s); }
   s.id = _shellId++; s.alive = true;
   s.pos.x = pos.x; s.pos.y = pos.y; s.pos.z = pos.z;
   s.start.x = pos.x; s.start.y = pos.y; s.start.z = pos.z;
   s.vel.x = dir.x * round.vel; s.vel.y = dir.y * round.vel; s.vel.z = dir.z * round.vel;
   s.ammo = round.type; s.round = round; s.caliber = round.cal; s.dmg = round.dmg;
   s.ownerId = tank.id; s.team = tank.team; s.tracer = true;
   s.travel = 0; s.ricochets = 0; s.penMul = 1; s.ignoreId = tank.id; s.ignoreT = 0.3;
   return s;
}

const _p0 = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 0 }, _pt = { x: 0, y: 0, z: 0 };
/**
 * Advance all shells. For impacts the world receives:
 *   world.onShellHit(shell, target|null, result|null, point, what)  what: 'tank'|'ground'|'object'|'water'|'expire'
 * plus, for HE bursts off-tank, world.onShellHit(shell, tank, splashResult, point, 'splash') per tank in range.
 */
export function updateShells(world, dt) {
   const g = WORLD.G, T = world.terrain, rng = world.rng;
   for (const s of world.shells) {
      if (!s.alive) continue;
      _p0.x = s.pos.x; _p0.y = s.pos.y; _p0.z = s.pos.z;
      s.vel.y -= g * dt;
      _d.x = s.vel.x * dt; _d.y = s.vel.y * dt; _d.z = s.vel.z * dt;
      const segLen = Math.hypot(_d.x, _d.y, _d.z);
      _d.x /= segLen; _d.y /= segLen; _d.z /= segLen;
      if (s.ignoreT > 0) s.ignoreT -= dt;
      // nearest tank along the segment (sphere then armour)
      let bestT = segLen, bestTank = null;
      for (const tk of world.tanks) {
         if (!tk.armor || (s.ignoreT > 0 && tk.id === s.ignoreId)) continue;
         const A = tk.armor;
         const cx = tk.pos.x - _p0.x, cy = tk.pos.y + A.boundY - _p0.y, cz = tk.pos.z - _p0.z;
         const tc = cx * _d.x + cy * _d.y + cz * _d.z;
         const d2 = cx * cx + cy * cy + cz * cz - tc * tc;
         if (d2 > A.boundR * A.boundR || tc < -A.boundR || tc - A.boundR > bestT) continue;
         const hits = rayArmor(A, tk.pose(), _p0, _d, bestT);
         if (hits.length && hits[0].dist < bestT) { bestT = hits[0].dist; bestTank = tk; }
      }
      // terrain + objects
      const tg = T.raycast(_p0.x, _p0.y, _p0.z, _d.x, _d.y, _d.z, bestT);
      if (tg != null && tg < bestT) {
         const what = T.lastHit.type === 'object' ? 'object' : 'ground';
         const obj = T.lastHit.obj;
         _pt.x = _p0.x + _d.x * tg; _pt.y = _p0.y + _d.y * tg; _pt.z = _p0.z + _d.z * tg;
         const w = T.water != null && _pt.y < T.water + 0.05 && what === 'ground' ? 'water' : what;
         s.alive = false;
         if (obj && obj.destructible && obj.kind !== 'house' && s.caliber >= 75) T.destroyObject(obj, _d.x, _d.z);
         world.onShellHit(s, null, null, _pt, w);
         if (s.ammo === 'HE') splashAll(world, s, _pt);
         continue;
      }
      if (bestTank) {
         const pen = rollPen(s.round, s.travel + bestT, rng) * s.penMul;
         const res = resolveImpact({ armor: bestTank.armor, pose: bestTank.pose(), id: bestTank.id }, _p0, _d,
            { type: s.ammo, cal: s.caliber, dmg: s.dmg, pen }, rng);
         _pt.x = res.point.x; _pt.y = res.point.y; _pt.z = res.point.z;
         world.onShellHit(s, bestTank, res, _pt, 'tank');
         if (res.kind === 'ricochet' && res.ricPen > 0 && s.ricochets < 2) {
            const sp = Math.hypot(s.vel.x, s.vel.y, s.vel.z) * 0.8;
            s.ricochets++; s.penMul *= 1 - B.RIC_PEN_LOSS;
            s.pos.x = _pt.x + res.normal.x * 0.05; s.pos.y = _pt.y + res.normal.y * 0.05; s.pos.z = _pt.z + res.normal.z * 0.05;
            s.vel.x = res.ricDir.x * sp; s.vel.y = res.ricDir.y * sp; s.vel.z = res.ricDir.z * sp;
            s.ignoreId = bestTank.id; s.ignoreT = 0.05;
            s.travel += bestT;
         } else s.alive = false;
         continue;
      }
      s.pos.x += _d.x * segLen; s.pos.y += _d.y * segLen; s.pos.z += _d.z * segLen;
      s.travel += segLen;
      if (s.travel > WORLD.SHELL_RANGE || s.pos.y < -50 || Math.abs(s.pos.x) > 700 || Math.abs(s.pos.z) > 700) {
         s.alive = false;
         world.onShellHit(s, null, null, s.pos, 'expire');
      }
   }
}

function splashAll(world, s, p) {
   const R = B.HE_RADIUS(s.caliber) * 2.2;
   const shell = { type: 'HE', cal: s.caliber, dmg: s.dmg, pen: 0 };
   for (const tk of world.tanks) {
      if (!tk.armor || !tk.alive) continue;
      const dx = tk.pos.x - p.x, dz = tk.pos.z - p.z;
      if (dx * dx + dz * dz > (R + tk.armor.boundR) ** 2) continue;
      const res = heSplash({ armor: tk.armor, pose: tk.pose(), id: tk.id }, p, shell, world.rng);
      if (res.kind === 'he') world.onShellHit(s, tk, res, p, 'splash');
   }
}
