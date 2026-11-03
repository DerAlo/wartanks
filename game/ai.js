// game/ai.js — bots (pure sim). One BotAI per bot tank, created by the World.
//
//   new BotAI(world, tank); ai.update(dt)  -> writes tank.input (throttle/steer/brake/fire) and tank.aimPoint
// Roles: 'flank' (rush a flank lane toward the enemy base), 'ridge' (hold high ground mid-map),
//   'snipe' (hold a bush on the own half), 'defend' (own base), 'push' (heavy: centre lane),
//   'target' / 'targetMoving' (training dummies: never fire; moving ones patrol slowly).
// Navigation: shared coarse grid (16 m) with A* avoiding houses/rocks, deep water and steep cells;
//   waypoint following with stuck recovery (reverse + turn). Combat: picks a spotted enemy with LOS,
//   aims at the weakest of several plates (rayArmor from its muzzle) with shell drop + lead and a
//   difficulty-scaled error, waits for aim, picks AP/APCR/HE by the expected effective armour,
//   angles the hull ~35° when stationary under fire, retreats when low on HP, caps / resets bases.
import { WORLD } from './config.js';
import { rayArmor } from './armor.js';
import { penAt } from './ballistics.js';
import { clamp, angleDelta, yawTo, makeRng, hashSeed, mulMat3, poseMatrix } from './utils.js';

const CELL = 16;
const DIFF = {                 // aim error (m at 100 m, 1σ), reaction (s), patience for aim (s), smart plate pick
   leicht: { err: 1.1, react: 1.4, aimWait: 1.2, convK: 2.2, smart: 0.25, angle: false },
   normal: { err: 0.55, react: 0.8, aimWait: 2.0, convK: 1.5, smart: 0.6, angle: true },
   schwer: { err: 0.25, react: 0.45, aimWait: 3.0, convK: 1.2, smart: 1, angle: true },
};

// ------------------------------------------------------------------ navigation grid (shared per terrain)
function navGrid(T) {
   if (T._nav) return T._nav;
   const half = T.half, n = Math.ceil(2 * half / CELL), cost = new Float32Array(n * n);
   for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * CELL, z = -half + (j + 0.5) * CELL;
      let hmin = Infinity, hmax = -Infinity;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) { const h = T.heightAt(x + a * CELL * 0.45, z + b * CELL * 0.45); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
      const slope = (hmax - hmin) / (CELL * 0.9);
      let c = 1 + slope * 4;
      if (slope > 0.75) c = Infinity;
      const wd = T.waterDepth ? T.waterDepth(x, z) : 0;
      if (wd > 1.1) c = Infinity; else if (wd > 0.2) c += 3;
      if (Math.abs(x) > half - 12 || Math.abs(z) > half - 12) c = Infinity;
      if (c < Infinity) for (const o of T.objectsNear(x, z, 4)) {
         if (!o.destructible) { c = Infinity; break; }
         c += o.kind === 'tree' ? 0.6 : 1.5;
      }
      cost[j * n + i] = c;
   }
   T._nav = { n, cost, g: new Float32Array(n * n), from: new Int32Array(n * n), stamp: new Int32Array(n * n), st: 0, heap: new Int32Array(n * n * 4), hf: new Float32Array(n * n * 4) };
   return T._nav;
}
const cellOf = (N, T, x, z) => [clamp(Math.floor((x + T.half) / CELL), 0, N.n - 1), clamp(Math.floor((z + T.half) / CELL), 0, N.n - 1)];
function nearestFree(N, i, j) {
   if (N.cost[j * N.n + i] < Infinity) return j * N.n + i;
   for (let r = 1; r < 6; r++) for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < N.n && jj < N.n && N.cost[jj * N.n + ii] < Infinity) return jj * N.n + ii;
   }
   return j * N.n + i;
}
/** A* on the grid; returns world waypoints [{x,z}] (start excluded) or null. */
export function findPath(T, x0, z0, x1, z1) {
   const N = navGrid(T), n = N.n;
   const [si, sj] = cellOf(N, T, x0, z0), [gi, gj] = cellOf(N, T, x1, z1);
   const s = nearestFree(N, si, sj), goal = nearestFree(N, gi, gj);
   const st = ++N.st, g = N.g, from = N.from, stamp = N.stamp, H = N.heap, HF = N.hf;
   let hn = 0;
   const push = (k, f) => { let i = hn++; while (i > 0) { const p = (i - 1) >> 1; if (HF[p] <= f) break; H[i] = H[p]; HF[i] = HF[p]; i = p; } H[i] = k; HF[i] = f; };
   const pop = () => { const top = H[0], lk = H[--hn], lf = HF[hn]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && HF[c + 1] < HF[c]) c++; if (HF[c] >= lf) break; H[i] = H[c]; HF[i] = HF[c]; i = c; } H[i] = lk; HF[i] = lf; return top; };
   const gx = goal % n, gz = (goal / n) | 0;
   const h = (k) => { const dx = Math.abs(k % n - gx), dz = Math.abs(((k / n) | 0) - gz); return (dx + dz - 0.59 * Math.min(dx, dz)); };
   stamp[s] = st; g[s] = 0; from[s] = -1; push(s, h(s));
   let found = false, iter = 0;
   while (hn > 0 && iter++ < 20000) {
      const k = pop();
      if (k === goal) { found = true; break; }
      const ki = k % n, kj = (k / n) | 0, gk = g[k];
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
         if (!a && !b) continue;
         const ii = ki + a, jj = kj + b;
         if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
         const m = jj * n + ii, c = N.cost[m];
         if (c === Infinity) continue;
         if (a && b && (N.cost[kj * n + ii] === Infinity || N.cost[jj * n + ki] === Infinity)) continue;
         const ng = gk + c * (a && b ? 1.414 : 1);
         if (stamp[m] === st && g[m] <= ng) continue;
         stamp[m] = st; g[m] = ng; from[m] = k;
         if (hn < H.length - 1) push(m, ng + h(m));
      }
   }
   if (!found) return null;
   const out = [];
   for (let k = goal; k !== s && k >= 0; k = from[k]) out.push({ x: -T.half + (k % n + 0.5) * CELL, z: -T.half + (((k / n) | 0) + 0.5) * CELL });
   out.reverse();
   // drop collinear points
   const res = [];
   for (let i = 0; i < out.length; i++) {
      if (i > 0 && i < out.length - 1) {
         const a = out[i - 1], b = out[i], c = out[i + 1];
         if (Math.abs((b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x)) < 1) continue;
      }
      res.push(out[i]);
   }
   if (res.length) { res[res.length - 1].x = x1; res[res.length - 1].z = z1; }
   return res;
}

// ------------------------------------------------------------------ bot
const _o = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 0 }, _lp = { x: 0, y: 0, z: 0 }, _wp = { x: 0, y: 0, z: 0 };
const _m = new Float64Array(9);

export class BotAI {
   constructor(world, tank) {
      this.w = world; this.tank = tank;
      this.rng = makeRng(hashSeed(world.seed, 'ai', tank.id));
      this.D = DIFF[world.diffKey] || DIFF.normal;
      this.role = tank.role || this.pickRole();
      tank.role = this.role;
      this.path = null; this.pi = 0; this.dest = null; this.stage = 0;
      this.repath = 0; this.think = this.rng() * 0.5; this.stuckT = 0; this.unstickT = 0; this.unstickDir = 1;
      this.target = null; this.targetT = 0; this.aimT = 0; this.aimLocal = { x: 0, y: 1, z: 0 }; this.errX = 0; this.errY = 0;
      this.holdT = 0; this.lastEnemySeen = 0; this.angleSide = this.rng() < 0.5 ? 1 : -1;
      this.patrol = 0;
   }
   reset() { this.target = null; this.path = null; this.patrol = 0; }

   pickRole() {
      const t = this.tank, r = this.rng(), mates = this.w.bots.filter((b) => b.team === t.team && b !== t && b.role);
      if (t.team && !mates.some((b) => b.role === 'defend') && this.w.mode === 'standard' && r < 0.5 && t.cfg.cls !== 'LT') return 'defend';
      switch (t.cfg.cls) {
         case 'LT': return 'flank';
         case 'TD': return r < 0.7 ? 'snipe' : 'ridge';
         case 'HT': return r < 0.65 ? 'push' : 'flank';
         default: return r < 0.45 ? 'flank' : r < 0.8 ? 'ridge' : 'push';
      }
   }

   // ---------------------------------------------------------------- destinations
   _sideSign() { return this.tank.team === 1 ? 1 : -1; }      // team 1 starts south (+z)
   chooseDest() {
      const T = this.w.terrain, t = this.tank, s = this._sideSign(), r = this.rng;
      const own = T.bases['team' + t.team], enemy = T.bases['team' + (3 - t.team)];
      const lateGame = this.w.timeLeft != null && this.w.timeLeft < 200;
      const neutral = this.w.mode === 'encounter' ? T.bases.neutral : null;
      if (t.hp < t.maxHP * 0.3 && this.stage > 0) return this.coverNear(own.x * 0.5 + t.pos.x * 0.5, own.z * 0.6 + t.pos.z * 0.4);
      if (neutral && (lateGame || this.stage >= 2)) return { x: neutral.x + (r() - 0.5) * 30, z: neutral.z + (r() - 0.5) * 30 };
      if (this.role === 'defend') return { x: own.x + (r() - 0.5) * 30, z: own.z + (r() - 0.5) * 30 };
      if (lateGame || this.stage >= 2) return neutral ? { x: neutral.x, z: neutral.z } : { x: enemy.x + (r() - 0.5) * 30, z: enemy.z + (r() - 0.5) * 30 };
      if (this.role === 'flank') {
         const side = this._flank ??= (r() < 0.5 ? -1 : 1);
         return this.stage === 0 ? { x: side * (260 + r() * 120), z: s * (60 - r() * 80) } : { x: enemy.x * 0.5 + side * 200, z: enemy.z * 0.6 };
      }
      if (this.role === 'push') return this.stage === 0 ? { x: (r() - 0.5) * 200, z: s * (40 + r() * 60) } : { x: (r() - 0.5) * 200, z: -s * 120 };
      if (this.role === 'snipe') return this.bushNear((r() - 0.5) * 500, s * (180 + r() * 80)) || this.highNear((r() - 0.5) * 500, s * 200);
      return this.highNear((r() - 0.5) * 500, s * (110 + r() * 60));            // ridge
   }
   highNear(x, z) {
      const T = this.w.terrain, N = navGrid(T);
      let best = null, bh = -Infinity;
      for (let k = 0; k < 24; k++) {
         const px = clamp(x + (this.rng() - 0.5) * 160, -T.half + 30, T.half - 30), pz = clamp(z + (this.rng() - 0.5) * 100, -T.half + 30, T.half - 30);
         const [i, j] = cellOf(N, T, px, pz);
         if (N.cost[j * N.n + i] === Infinity) continue;
         const h = T.heightAt(px, pz);
         if (h > bh) { bh = h; best = { x: px, z: pz }; }
      }
      return best || { x, z };
   }
   bushNear(x, z) {
      const T = this.w.terrain;
      let best = null, bd = Infinity;
      for (const b of T.bushes || []) {
         if (!b.alive) continue;
         const d = Math.hypot(b.x - x, b.z - z) + this.rng() * 40;
         if (d < bd && d < 200 && Math.abs(b.z) < T.half - 40) { bd = d; best = b; }
      }
      return best ? { x: best.x, z: best.z } : null;
   }
   coverNear(x, z) {         // a point lower than its surroundings toward the enemy (behind a crest), cheap sample
      const T = this.w.terrain, s = this._sideSign();
      let best = { x, z }, bs = -Infinity;
      for (let k = 0; k < 12; k++) {
         const px = clamp(x + (this.rng() - 0.5) * 120, -T.half + 30, T.half - 30), pz = clamp(z + (this.rng() - 0.5) * 80, -T.half + 30, T.half - 30);
         const score = T.heightAt(px, pz - s * 25) - T.heightAt(px, pz);       // crest in front (toward the enemy)
         if (score > bs) { bs = score; best = { x: px, z: pz }; }
      }
      return best;
   }
   setDest(d) {
      this.dest = d;
      const t = this.tank;
      this.path = findPath(this.w.terrain, t.pos.x, t.pos.z, d.x, d.z) || [{ x: d.x, z: d.z }];
      this.pi = 0;
   }

   // ---------------------------------------------------------------- per step
   update(dt) {
      const t = this.tank, w = this.w, inp = t.input;
      if (!t.alive) return;
      if (w.phase !== 'playing' && w.phase !== 'countdown') { inp.throttle = 0; inp.steer = 0; inp.fire = false; return; }
      this.think -= dt;
      if (this.think <= 0) { this.think = 0.25; this.decide(); }
      if (this.role === 'target' || this.role === 'targetMoving') { this.dummy(dt); return; }
      this.combat(dt);
      this.drive(dt);
   }

   dummy(dt) {
      const t = this.tank, inp = t.input; inp.fire = false;
      t.aimPoint.x = t.pos.x - Math.sin(t.yaw) * 100; t.aimPoint.y = t.pos.y + 2; t.aimPoint.z = t.pos.z - Math.cos(t.yaw) * 100;
      if (this.role !== 'targetMoving') { inp.throttle = 0; inp.steer = 0; return; }
      this.patrol += dt;
      const ph = Math.floor(this.patrol / 14) % 2;                     // 14 s forth, 14 s back at low speed
      inp.throttle = ph ? -0.35 : 0.35; inp.steer = 0;
      const h = t.home, d = Math.hypot(t.pos.x - h.x, t.pos.z - h.z);
      if (d > 60) inp.throttle = (inp.throttle > 0 ? -0.35 : 0.35);
   }

   decide() {
      const t = this.tank, w = this.w;
      if (this.role === 'target' || this.role === 'targetMoving') return;
      // modules / crew
      if ((t.mod('trackL') === 'destroyed' || t.mod('trackR') === 'destroyed' || t.mod('engine') === 'destroyed') && w.time - t.lastDamaged > this.D.react) t.useConsumable('repair');
      for (const k in t.crew) if (!t.crew[k].alive && w.time - t.lastDamaged > this.D.react * 2) { t.useConsumable('medkit'); break; }
      // own base under capture -> defenders and nearby bots return
      const ownCap = w.caps.find((c) => c.team === t.team && c.progress > 0);
      if (ownCap) {
         const d = Math.hypot(ownCap.pos.x - t.pos.x, ownCap.pos.z - t.pos.z);
         if ((this.role === 'defend' || d < 260 || ownCap.progress > 45) && (!this.dest || Math.hypot(this.dest.x - ownCap.pos.x, this.dest.z - ownCap.pos.z) > 20)) {
            this.setDest({ x: ownCap.pos.x, z: ownCap.pos.z }); this.returning = true;
         }
      } else if (this.returning) { this.returning = false; this.dest = null; }
      // target selection
      this.pickTarget();
      if (this.target) this.lastEnemySeen = w.time;
      // destination / stage progression
      if (!this.dest) this.setDest(this.chooseDest());
      const arrived = Math.hypot(this.dest.x - t.pos.x, this.dest.z - t.pos.z) < 18;
      if (arrived) this.holdT += 0.25; else this.holdT = 0;
      const quiet = w.time - this.lastEnemySeen;
      if (!this.returning && arrived && (quiet > (this.role === 'snipe' || this.role === 'defend' ? 70 : 25) || (this.stage === 0 && this.holdT > 45))) {
         this.stage++; this.setDest(this.chooseDest());
      }
      if (!this.returning && t.hp < t.maxHP * 0.3 && !this.retreating) { this.retreating = true; this.setDest(this.chooseDest()); }
      // re-plan on long paths occasionally
      this.repath -= 0.25;
      if (this.repath <= 0 && !arrived) { this.repath = 20; this.setDest(this.dest); }
   }

   pickTarget() {
      const t = this.tank, w = this.w;
      let best = null, bs = Infinity;
      for (const e of w.tanks) {
         if (!e.alive || e.team === t.team || !e.spotted) continue;
         const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z);
         if (d > WORLD.DRAW_RANGE) continue;
         if (!this.los(e)) continue;
         const score = d * (0.5 + e.hp / e.maxHP) * (e === this.target ? 0.6 : 1);
         if (score < bs) { bs = score; best = e; }
      }
      if (best !== this.target) {
         this.target = best; this.targetT = 0; this.aimT = 0;
         if (best) this.chooseAim(best);
      } else if (best && this.rng() < 0.15) this.chooseAim(best);
   }
   los(e) {
      const t = this.tank, T = this.w.terrain;
      const ox = t.muzzle.x, oy = t.muzzle.y, oz = t.muzzle.z;
      const dx = e.pos.x - ox, dy = e.pos.y + e.height * 0.6 - oy, dz = e.pos.z - oz, d = Math.hypot(dx, dy, dz);
      return T.raycast(ox, oy, oz, dx / d, dy / d, dz / d, d - 3) == null;
   }

   /** Choose a hull-local aim point on the target: the weakest plate among candidates. */
   chooseAim(e) {
      const t = this.tank, cfg = e.cfg, H = cfg.hull, D = this.D;
      const round = t.round(), dist = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z), pen = penAt(round, dist);
      const fy = H.floorY, ry = H.roofY, zF = H.zMin ?? -H.len / 2, zR = H.zMax ?? H.len / 2;
      const tY = cfg.turret ? cfg.turret.y + cfg.turret.h * 0.45 : ry * 0.9;
      const cands = [[0, (fy + ry) / 2, 0], [0, fy + (ry - fy) * 0.3, zF * 0.9], [0, ry * 0.85, zF * 0.7], [0, tY, cfg.turret?.z ?? 0],
         [(cfg.turret?.x ?? 0) + 0.5, tY, cfg.turret?.z ?? 0], [0, (fy + ry) / 2, zR * 0.5], [0, (fy + ry) / 2, zF * 0.4]];
      let best = cands[0], bv = -Infinity;
      const P = e.pose();
      poseMatrix(_m, P.yaw, P.pitch, P.roll);
      const smart = this.rng() < D.smart;
      for (const c of cands) {
         _lp.x = c[0]; _lp.y = c[1]; _lp.z = c[2];
         mulMat3(_wp, _m, _lp); _wp.x += P.pos.x; _wp.y += P.pos.y; _wp.z += P.pos.z;
         _d.x = _wp.x - t.muzzle.x; _d.y = _wp.y - t.muzzle.y; _d.z = _wp.z - t.muzzle.z;
         const L = Math.hypot(_d.x, _d.y, _d.z); _d.x /= L; _d.y /= L; _d.z /= L;
         const hits = rayArmor(e.armor, P, t.muzzle, _d);
         let h = null; for (const x of hits) if (x.t > 0 && (x.part === 'hull' || x.part === 'turret' || x.part === 'mantlet')) { h = x; break; }
         if (!h) continue;
         if (!smart) { best = c; break; }               // dumb bots aim centre mass
         const ric = h.angleDeg > 70 && round.cal < 3 * h.t;
         const v = (ric ? -1e3 : 0) + pen / Math.max(1, h.effT) - (c === cands[0] ? 0 : 0.02);
         if (v > bv) { bv = v; best = c; }
      }
      this.aimLocal.x = best[0]; this.aimLocal.y = best[1]; this.aimLocal.z = best[2];
      this.bestRatio = bv;
      // ammo by expected armour
      const g = t.cfg.gun.ammoByType;
      if (this.rng() < D.smart && bv > -1e3) {
         const effT = pen / Math.max(0.01, bv);
         let want = 'AP';
         if (g.APCR && penAt(g.AP, dist) < effT * 1.05 && penAt(g.APCR, dist) > effT * 0.95 && t.ammoCount.APCR > 2) want = 'APCR';
         else if (g.HEAT && penAt(g.AP, dist) < effT * 1.05 && t.ammoCount.HEAT > 0) want = 'HEAT';
         else if (g.HE && penAt(g.AP, dist) < effT * 0.6 && g.HE.cal >= 85 && t.ammoCount.HE > 0) want = 'HE';
         if (want !== t.ammoSel && t.ammoCount[want] > 0 && (t.reload <= 0.5 || t.reload > t.reloadMax * 0.8)) t.setAmmo(want);
         else if (want === t.ammoSel) { /* keep */ }
      }
      // new random aim error (gaussian-ish), re-rolled each pick
      const err = D.err * dist / 100;
      this.errX = (this.rng() + this.rng() + this.rng() - 1.5) * err * 1.4;
      this.errY = (this.rng() + this.rng() + this.rng() - 1.5) * err * 0.9;
   }

   combat(dt) {
      const t = this.tank, w = this.w, inp = t.input, e = this.target;
      inp.fire = false;
      if (!e || !e.alive) {
         // look ahead along the path / toward the enemy side
         const wp = this.path?.[this.pi] || this.dest;
         const s = this._sideSign();
         if (wp && Math.hypot(wp.x - t.pos.x, wp.z - t.pos.z) > 30) { t.aimPoint.x = wp.x; t.aimPoint.z = wp.z; }
         else { t.aimPoint.x = t.pos.x; t.aimPoint.z = t.pos.z - s * 150; }
         t.aimPoint.y = w.terrain.heightAt(t.aimPoint.x, t.aimPoint.z) + 2;
         return;
      }
      this.targetT += dt;
      // aim point = chosen plate + error + lead
      const P = e.pose();
      poseMatrix(_m, P.yaw, P.pitch, P.roll);
      mulMat3(_wp, _m, this.aimLocal);
      const dist = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z);
      const tof = dist / t.round().vel;
      const rx = -(e.pos.z - t.pos.z) / dist, rz = (e.pos.x - t.pos.x) / dist;
      t.aimPoint.x = P.pos.x + _wp.x + e.vel.x * tof + rx * this.errX;
      t.aimPoint.y = P.pos.y + _wp.y + this.errY;
      t.aimPoint.z = P.pos.z + _wp.z + e.vel.z * tof + rz * this.errX;
      if (this.targetT < this.D.react) return;
      if (t.reload > 0 || t.gunBlocked) { this.aimT = 0; return; }
      this.aimT += dt;
      const conv = t.aimDisp <= t.baseDisp * this.D.convK;
      // gun roughly on target?
      _d.x = t.aimPoint.x - t.muzzle.x; _d.y = t.aimPoint.y - t.muzzle.y; _d.z = t.aimPoint.z - t.muzzle.z;
      const L = Math.hypot(_d.x, _d.z);
      const yawErr = Math.abs(angleDelta(Math.atan2(-t.gunDir.x, -t.gunDir.z), Math.atan2(-_d.x, -_d.z)));
      if (yawErr * L > 1.5 + t.aimDisp * L / 100) return;
      if ((conv || this.aimT > this.D.aimWait + (dist > 250 ? 1.5 : 0)) && this.los(e)) { inp.fire = true; this.aimT = 0; if (this.rng() < 0.5) this.chooseAim(e); }
   }

   drive(dt) {
      const t = this.tank, w = this.w, inp = t.input, e = this.target;
      inp.brake = false;
      if (!this.path) { inp.throttle = 0; inp.steer = 0; return; }
      // advance waypoints
      while (this.pi < this.path.length - 1 && Math.hypot(this.path[this.pi].x - t.pos.x, this.path[this.pi].z - t.pos.z) < 12) this.pi++;
      const wp = this.path[this.pi];
      const dWp = wp ? Math.hypot(wp.x - t.pos.x, wp.z - t.pos.z) : 0;
      const atDest = this.pi >= this.path.length - 1 && dWp < 10;
      // engage stance: stop and fight unless flanking / retreating
      const engaging = e && e.alive && !this.retreating && (this.role !== 'flank' || this.stage > 0 || Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z) < 160)
         && this.role !== 'push' && !this.returning;
      const hold = atDest || (engaging && t.reload < 1.5 + (t.cfg.cls === 'TD' ? 3 : 0));
      // unstick
      if (this.unstickT > 0) {
         this.unstickT -= dt; inp.throttle = -0.8; inp.steer = this.unstickDir; return;
      }
      if (!hold && Math.abs(t.speed) < 0.6 && Math.abs(inp.throttle) > 0.3) {
         this.stuckT += dt;
         if (this.stuckT > 2.5) { this.stuckT = 0; this.unstickT = 1.6; this.unstickDir = this.rng() < 0.5 ? 1 : -1; this.repath = 0.1; return; }
      } else this.stuckT = Math.max(0, this.stuckT - dt);
      let wantYaw;
      if (hold) {
         inp.throttle = 0;
         if (e && e.alive) {
            const ty = yawTo(t.pos.x, t.pos.z, e.pos.x, e.pos.z);
            // casemate TDs face the target; armoured tanks angle ~35° when under fire
            const recently = w.time - t.lastDamaged < 15 || t.cfg.cls === 'HT';
            const ang = t.cfg.cls === 'TD' && !t.cfg.turret ? 0 : this.D.angle && recently && t.cfg.cls !== 'LT' ? 0.6 * this.angleSide : 0;
            wantYaw = ty + ang;
            if (!t.cfg.turret || Math.abs(angleDelta(t.yaw, wantYaw)) > 0.15) {
               const dy = angleDelta(t.yaw, wantYaw);
               inp.steer = Math.abs(dy) > 0.05 ? clamp(dy * 2.5, -1, 1) : 0;
            } else inp.steer = 0;
         } else inp.steer = 0;
         return;
      }
      wantYaw = yawTo(t.pos.x, t.pos.z, wp.x, wp.z);
      let dy = angleDelta(t.yaw, wantYaw);
      // simple ally avoidance: veer away from tanks just ahead
      for (const o of w.tanks) {
         if (o === t) continue;
         const ox = o.pos.x - t.pos.x, oz = o.pos.z - t.pos.z, d = Math.hypot(ox, oz);
         if (d > 16 || d < 0.1) continue;
         const fx = -Math.sin(t.yaw), fz = -Math.cos(t.yaw), ahead = (ox * fx + oz * fz) / d;
         if (ahead > 0.6) dy += (ox * fz - oz * fx > 0 ? 0.5 : -0.5) * (1 - d / 16);
      }
      inp.steer = clamp(dy * 2.2, -1, 1);
      inp.throttle = Math.abs(dy) > 1.3 ? 0.15 : clamp(1.15 - Math.abs(dy) * 0.9, 0.2, 1);
      if (this.pi >= this.path.length - 1 && dWp < 30) inp.throttle = Math.min(inp.throttle, 0.4);
   }
}
