// game/terrain.js — deterministic battlefield (pure sim): heightfield, ground classes, objects,
// raycasts, spawns and base positions. Built from a map theme in maps.js + a seed.
//
// makeTerrain(seed, themeId) -> Terrain (see ARCHITECTURE.md "Terrain").
// Heightfield: 2 m grid covering ±(half + 100) m; outside the playable square the ground rises.
import { MAPS } from './maps.js';
import { makeRng, hashSeed, fbm, ridged, clamp, clamp01, smoothstep } from './utils.js';

export const GROUND_NAMES = ['road', 'hard', 'medium', 'soft', 'water'];
const G_ROAD = 0, G_HARD = 1, G_MED = 2, G_SOFT = 3, G_WATER = 4;

const RES = 2;            // m per height sample
const MARGIN = 100;       // m of terrain beyond the playable edge
const CELL = 20;          // object grid cell (m)

// Object kind defaults: solid = blocks tanks, shots = blocks shells/LOS, destructible + hp
// (impulse in t·m/s needed to break it).
export const OBJECT_KINDS = {
   house: { solid: true, shots: true, destructible: false, hp: Infinity },
   church: { solid: true, shots: true, destructible: false, hp: Infinity },
   rock: { solid: true, shots: true, destructible: false, hp: Infinity },
   wall: { solid: true, shots: true, destructible: true, hp: 260 },
   fence: { solid: true, shots: false, destructible: true, hp: 40 },
   tree: { solid: true, shots: false, destructible: true, hp: 120 },
   bush: { solid: false, shots: false, destructible: false, hp: Infinity },
   wreck: { solid: true, shots: true, destructible: false, hp: Infinity },
};

function segDist(px, pz, ax, az, bx, bz) {
   const abx = bx - ax, abz = bz - az;
   const l2 = abx * abx + abz * abz || 1e-9;
   const t = clamp(((px - ax) * abx + (pz - az) * abz) / l2, 0, 1);
   const cx = ax + abx * t, cz = az + abz * t;
   return [Math.hypot(px - cx, pz - cz), t];
}
/** Distance from a point to a polyline; returns [dist, param 0..1 along the polyline]. */
function polyDist(px, pz, pts, lens, total) {
   let best = Infinity, bestS = 0, acc = 0;
   for (let i = 0; i < pts.length - 1; i++) {
      const [d, t] = segDist(px, pz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
      if (d < best) { best = d; bestS = (acc + t * lens[i]) / total; }
      acc += lens[i];
   }
   return [best, bestS];
}
function prepPoly(f) {
   f.lens = []; f.total = 0;
   for (let i = 0; i < f.pts.length - 1; i++) {
      const l = Math.hypot(f.pts[i + 1][0] - f.pts[i][0], f.pts[i + 1][1] - f.pts[i][1]);
      f.lens.push(l); f.total += l;
   }
   return f;
}
function pointOnPoly(f, s) {
   let target = s * f.total;
   for (let i = 0; i < f.lens.length; i++) {
      if (target <= f.lens[i] || i === f.lens.length - 1) {
         const t = clamp(target / f.lens[i], 0, 1);
         const a = f.pts[i], b = f.pts[i + 1];
         return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: (b[0] - a[0]) / f.lens[i], dz: (b[1] - a[1]) / f.lens[i] };
      }
      target -= f.lens[i];
   }
   return { x: 0, z: 0, dx: 1, dz: 0 };
}

function mirrorFeature(f) {
   const m = { ...f, sym: false };
   if ('x' in f) { m.x = -f.x; m.z = -f.z; }
   if ('x0' in f) { m.x0 = -f.x0; m.z0 = -f.z0; m.x1 = -f.x1; m.z1 = -f.z1; }
   if (f.pts) m.pts = f.pts.map(([x, z]) => [-x, -z]);
   if ('yaw' in f) m.yaw = f.yaw + Math.PI;
   return m;
}

export class Terrain {
   constructor(seed, themeId) {
      const theme = MAPS[themeId] || MAPS.steppe;
      this.themeId = theme.id;
      this.theme = theme;
      this.seed = seed >>> 0;
      this.half = 500;
      this.res = RES;
      this.ext = this.half + MARGIN;
      this.n = Math.round((2 * this.ext) / RES) + 1;
      this.version = 0;
      this.water = theme.water ?? null;
      this.objects = [];
      this.bushes = [];
      this.caps = [];
      this.lastHit = { type: null, obj: null };
      const rng = this.rng = makeRng(hashSeed(seed, theme.id, theme.seed));
      this.nseed = hashSeed(seed, theme.id) & 0xffff;
      // features (+ mirrored copies)
      const feats = [];
      for (const f of theme.features) {
         feats.push({ ...f });
         if (f.sym) feats.push(mirrorFeature(f));
      }
      for (const f of feats) if (f.pts) prepPoly(f);
      this.features = feats;
      this.rivers = feats.filter((f) => f.kind === 'river');
      this.roads = feats.filter((f) => f.kind === 'road');
      this.lakes = feats.filter((f) => f.kind === 'lake');
      // bases & spawns (mirrored): team 1 south, team 2 north
      this.bases = { team1: { x: -170, z: 385 }, team2: { x: 170, z: -385 }, neutral: { x: 0, z: 0 } };
      this.spawns = { team1: [], team2: [] };
      this._genHeights();
      this._genGround();
      this._genObjects();
      this._genSpawns();
      this._buildGrid();
   }

   // ------------------------------------------------------------------ heights
   _rawHeight(x, z) {
      const th = this.theme, nz = th.noise, s = this.nseed;
      let h = fbm(x / nz.scale, z / nz.scale, s, 4) * nz.amp
         + fbm(x / 40, z / 40, s + 7, 2) * nz.detail
         + (ridged(x / (nz.scale * 1.3), z / (nz.scale * 1.3), s + 3) - 0.35) * nz.ridgedAmp;
      if (this.water != null) h += nz.amp + 2.5;
      let flatW = 0, flatY = 0, roadW = 0;
      for (const f of this.features) {
         switch (f.kind) {
            case 'hill': {
               const d = Math.hypot(x - f.x, z - f.z) / f.r;
               if (d < 1) { const k = 1 - d * d; h += f.h * k * k; }
               break;
            }
            case 'plateau': {
               const d = Math.hypot(x - f.x, z - f.z);
               h += f.h * (1 - smoothstep((d - f.r) / 40));
               break;
            }
            case 'ridge': {
               const [d, t] = segDist(x, z, f.x0, f.z0, f.x1, f.z1);
               const hw = f.w / 2;
               if (d < hw * 2) {
                  let k = Math.exp(-((d / hw) ** 2) * 1.6);
                  // taper the ends and cut gaps (passages through the ridge)
                  k *= smoothstep(Math.min(t, 1 - t) * 6 + 0.15);
                  if (f.gaps) for (const [gt, gw] of f.gaps) {
                     const len = Math.hypot(f.x1 - f.x0, f.z1 - f.z0);
                     k *= smoothstep(Math.abs(t - gt) * len / gw - 0.3);
                  }
                  h += f.h * k;
               }
               break;
            }
            case 'valley': {
               let dmin = Infinity;
               for (const r of this.rivers) dmin = Math.min(dmin, polyDist(x, z, r.pts, r.lens, r.total)[0]);
               h += Math.min(dmin, f.max) * f.k;
               break;
            }
            case 'flat': {
               const d = Math.hypot(x - f.x, z - f.z);
               const k = 1 - smoothstep((d - f.r) / 50);
               if (k > flatW) { flatW = k; flatY = f.y ?? null; }
               break;
            }
            case 'road': {
               const [d] = polyDist(x, z, f.pts, f.lens, f.total);
               roadW = Math.max(roadW, 1 - smoothstep((d - f.w / 2) / 6));
               break;
            }
         }
      }
      // smooth flats: pull towards a low-frequency version of the field
      if (flatW > 0) {
         const base = fbm(x / 900, z / 900, s, 1) * nz.amp * 0.3 + (this.water != null ? nz.amp + 2.5 : 0);
         h += ((flatY ?? base) - h) * flatW * 0.85;
      }
      if (roadW > 0) h -= fbm(x / 40, z / 40, s + 7, 2) * nz.detail * roadW;
      // water carving
      for (const r of this.rivers) {
         const [d, sP] = polyDist(x, z, r.pts, r.lens, r.total);
         const hw = r.w / 2;
         if (d < hw + 25) {
            let depth = r.depth;
            for (const ft of r.fords || []) depth = Math.min(depth, lerpDepth(sP, ft, r.total, 1.0, r.depth));
            const wl = this.water ?? 0, bed = wl - depth;
            if (d < hw) h = bed + (Math.min(h, wl + 0.3) - bed) * (d / hw) ** 4;
            else h += (Math.min(h, wl + 0.6 + (d - hw) * 0.25) - h) * smoothstep(1 - (d - hw) / 25);
            for (const bt of r.bridge || []) {
               const along = Math.abs(sP - bt) * r.total;
               if (along < 5) h = Math.max(h, (this.water ?? 0) + 0.7);
            }
         }
      }
      for (const L of this.lakes) {
         const d = Math.hypot(x - L.x, z - L.z);
         if (d < L.r + 30) {
            const wl = this.water ?? 0;
            const bed = wl - L.depth;
            if (d < L.r) h = Math.min(h, bed + (wl + 0.2 - bed) * (d / L.r) ** 6);
            else h += (Math.min(h, wl + 0.5 + (d - L.r) * 0.2) - h) * smoothstep(1 - (d - L.r) / 30);
         }
      }
      // bases / spawn areas: gentle
      for (const b of [this.bases.team1, this.bases.team2]) {
         const d = Math.hypot(x - b.x, z - b.z);
         if (d < 110) h += ((this.water != null ? nz.amp + 2.5 : 0) + 1 - h) * (1 - smoothstep((d - 60) / 50)) * 0.7;
      }
      // outside the playable square: rising rim
      const e = Math.max(Math.abs(x), Math.abs(z)) - this.half;
      if (e > -20) h += Math.max(0, e + 20) ** 1.35 * 0.12 + Math.max(0, e) * fbm(x / 60, z / 60, s + 11, 2) * 0.15;
      return h;
   }

   _genHeights() {
      const n = this.n, ext = this.ext;
      this.h = new Float32Array(n * n);
      for (let j = 0; j < n; j++) {
         const z = -ext + j * RES;
         for (let i = 0; i < n; i++) this.h[j * n + i] = this._rawHeight(-ext + i * RES, z);
      }
      // frozen lakes: water level becomes an ice sheet (drivable, hard)
      this.ice = this.lakes.some((l) => l.frozen);
      if (this.ice && this.water == null) this.water = 0;
      if (this.ice) {
         for (const L of this.lakes) if (L.frozen) {
            for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
               const x = -ext + i * RES, z = -ext + j * RES;
               if (Math.hypot(x - L.x, z - L.z) < L.r + 6) { const k = j * n + i; if (this.h[k] < this.water) this.h[k] = this.water; }
            }
         }
         this.water = null;      // nothing below the ice surface is reachable
         this.iceLevel = 0;
      }
   }

   heightAt(x, z) {
      const n = this.n;
      let fx = (x + this.ext) / RES, fz = (z + this.ext) / RES;
      fx = fx < 0 ? 0 : fx > n - 1.001 ? n - 1.001 : fx;
      fz = fz < 0 ? 0 : fz > n - 1.001 ? n - 1.001 : fz;
      const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
      const k = j * n + i, H = this.h;
      const a = H[k], b = H[k + 1], c = H[k + n], d = H[k + n + 1];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
   }
   /** Unit surface normal; writes into `out` if given. */
   normalAt(x, z, out = { x: 0, y: 1, z: 0 }) {
      const e = RES;
      const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
      const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
      const nx = -hx, ny = 2 * e, nz = -hz;
      const l = Math.hypot(nx, ny, nz);
      out.x = nx / l; out.y = ny / l; out.z = nz / l;
      return out;
   }
   /** Water depth at (x,z) (0 = dry). */
   waterDepth(x, z) {
      if (this.water == null) return 0;
      return Math.max(0, this.water - this.heightAt(x, z));
   }

   // ------------------------------------------------------------------ ground classes
   _genGround() {
      const gn = Math.round((2 * this.ext) / 4) + 1;  // 4 m ground cells
      this.gn = gn;
      this.g = new Uint8Array(gn * gn);
      const th = this.theme, s = this.nseed;
      const fields = this.features.filter((f) => f.kind === 'field');
      const flats = this.features.filter((f) => f.kind === 'flat' || f.kind === 'village');
      for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) {
         const x = -this.ext + i * 4, z = -this.ext + j * 4;
         let g = G_MED;
         const nrm = this.normalAt(x, z);
         const n1 = fbm(x / 70, z / 70, s + 21, 2);
         if (n1 > 0.5 - th.ground.soft) g = G_SOFT;
         if (n1 < -0.42 + th.ground.hard || nrm.y < 0.82) g = G_HARD;
         for (const f of fields) if (Math.hypot(x - f.x, z - f.z) < f.r * (0.8 + 0.2 * n1)) g = G_SOFT;
         for (const f of flats) if (Math.hypot(x - f.x, z - f.z) < f.r * 0.9) g = g === G_SOFT ? G_MED : G_HARD;
         if (this.ice) for (const L of this.lakes) if (Math.hypot(x - L.x, z - L.z) < L.r) g = G_HARD;
         for (const r of this.roads) if (polyDist(x, z, r.pts, r.lens, r.total)[0] < r.w / 2 + 0.5) g = G_ROAD;
         if (this.water != null && this.heightAt(x, z) < this.water - 0.05) g = G_WATER;
         this.g[j * gn + i] = g;
      }
   }
   groundIdxAt(x, z) {
      const gn = this.gn;
      const i = clamp(Math.round((x + this.ext) / 4), 0, gn - 1), j = clamp(Math.round((z + this.ext) / 4), 0, gn - 1);
      return this.g[j * gn + i];
   }
   groundAt(x, z) { return GROUND_NAMES[this.groundIdxAt(x, z)]; }

   // ------------------------------------------------------------------ objects
   _addObj(kind, x, z, yaw, w, d, h, extra) {
      const k = OBJECT_KINDS[kind];
      const o = {
         id: this.objects.length, kind, x, z, y: this.heightAt(x, z), yaw, w, d, h,
         solid: k.solid, shots: k.shots, destructible: k.destructible, alive: true, hp: k.hp,
         seed: (this.rng() * 1e6) | 0, ...extra,
      };
      // collision radius (circle) for trees/bushes; boxes use w/d/yaw
      o.r = kind === 'tree' ? 0.25 + w * 0.06 : kind === 'bush' ? w * 0.45 : Math.hypot(w, d) / 2;
      this.objects.push(o);
      if (kind === 'bush') this.bushes.push(o);
      return o;
   }
   /** True if a box/circle of radius r at (x,z) is free of roads, water, other solid objects and spawn zones. */
   _free(x, z, r, roadPad = 2) {
      if (Math.abs(x) > this.half - 8 || Math.abs(z) > this.half - 8) return false;
      if (this.water != null && this.heightAt(x, z) < this.water + 0.3) return false;
      if (this.ice) for (const L of this.lakes) if (Math.hypot(x - L.x, z - L.z) < L.r + r) return false;
      for (const rd of this.roads) if (polyDist(x, z, rd.pts, rd.lens, rd.total)[0] < rd.w / 2 + r + roadPad) return false;
      for (const rv of this.rivers) if (polyDist(x, z, rv.pts, rv.lens, rv.total)[0] < rv.w / 2 + r + 3) return false;
      for (const b of [this.bases.team1, this.bases.team2]) if (Math.hypot(x - b.x, z - b.z) < 75 + r) return false;
      for (const b of [this.bases.team1, this.bases.team2]) if (Math.abs(z - b.z * 1.07) < 40 && Math.abs(x) < 260) return false;
      const near = this._occ;
      for (let i = 0; i < near.length; i += 3) {
         if (Math.hypot(x - near[i], z - near[i + 1]) < r + near[i + 2]) return false;
      }
      return true;
   }
   _occupy(x, z, r) { this._occ.push(x, z, r); }

   _house(x, z, yaw, w, d, h, kind = 'house') {
      this._addObj(kind, x, z, yaw, w, d, h, { roof: this.rng() < 0.7 ? 'gable' : 'hip', style: this.rng.int(0, 3) });
      this._occupy(x, z, Math.hypot(w, d) / 2 + 1.5);
   }
   _wallLine(x0, z0, x1, z1, kind) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const segs = Math.max(1, Math.round(len / 6));
      const yaw = Math.atan2(-(x1 - x0), -(z1 - z0));
      for (let i = 0; i < segs; i++) {
         const t = (i + 0.5) / segs;
         const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
         const okRoad = this.roads.every((rd) => polyDist(x, z, rd.pts, rd.lens, rd.total)[0] > rd.w / 2 + 1);
         if (!okRoad) continue;
         if (kind === 'wall') this._addObj('wall', x, z, yaw, 0.6, len / segs, 1.8);
         else this._addObj('fence', x, z, yaw, 0.15, len / segs, 1.2);
      }
   }

   _genObjects() {
      const rng = this.rng;
      this._occ = [];
      // villages and farms first (they claim ground)
      for (const f of this.features) {
         if (f.kind === 'village') {
            if (f.church) { this._house(f.x + 18, f.z - 22, 0.05, 12, 24, 11, 'church'); }
            let placed = 0;
            for (let tries = 0; tries < f.houses * 30 && placed < f.houses; tries++) {
               const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * f.r;
               const x = f.x + Math.cos(a) * rr, z = f.z + Math.sin(a) * rr;
               const w = rng.range(7, 12), d = rng.range(6, 10);
               if (!this._free(x, z, Math.hypot(w, d) / 2, 2.5)) continue;
               // orient along the nearest road
               let yaw = Math.round(rng() * 4) * Math.PI / 2;
               let best = Infinity;
               for (const rd of this.roads) {
                  const [dd, sP] = polyDist(x, z, rd.pts, rd.lens, rd.total);
                  if (dd < best && dd < 40) { best = dd; const p = pointOnPoly(rd, sP); yaw = Math.atan2(-p.dx, -p.dz); }
               }
               this._house(x, z, yaw, w, d, rng.range(5, 8));
               placed++;
            }
            for (let k = 0; k < (f.walls || 0); k++) {
               const a = rng() * Math.PI * 2, rr = f.r * rng.range(0.3, 1.0);
               const x = f.x + Math.cos(a) * rr, z = f.z + Math.sin(a) * rr;
               if (!this._free(x, z, 8, 1)) continue;
               const yaw = rng() * Math.PI, L = rng.range(10, 24);
               const dx = -Math.sin(yaw) * L / 2, dz = -Math.cos(yaw) * L / 2;
               this._wallLine(x - dx, z - dz, x + dx, z + dz, 'wall');
               this._occupy(x, z, L / 2);
            }
         } else if (f.kind === 'farm') {
            const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
            const P = (lx, lz) => [f.x + lx * c + lz * s, f.z - lx * s + lz * c];
            const parts = [[0, 0, 10, 8, 6], [16, 4, 14, 9, 7.5], [4, 16, 7, 6, 4.5]];
            for (const [lx, lz, w, d, h] of parts) {
               const [x, z] = P(lx, lz);
               if (this._free(x, z, Math.hypot(w, d) / 2, 2)) this._house(x, z, f.yaw, w, d, h);
            }
            const corners = [P(-12, -12), P(30, -12), P(30, 28), P(-12, 28)];
            for (let i = 0; i < 4; i++) {
               if (rng() < 0.25) continue;
               const a = corners[i], b = corners[(i + 1) % 4];
               this._wallLine(a[0], a[1], b[0], b[1], 'fence');
            }
         }
      }
      const tree = (x, z) => {
         const w = rng.range(3.5, 6.5);
         if (!this._free(x, z, 1.2, 1)) return;
         this._addObj('tree', x, z, rng() * Math.PI * 2, w, w, rng.range(9, 18));
         this._occupy(x, z, 1.2);
      };
      const bush = (x, z) => {
         const w = rng.range(2.2, 4.2);
         if (!this._free(x, z, 0.8, 0.5)) return;
         this._addObj('bush', x, z, rng() * Math.PI * 2, w, w * rng.range(0.7, 1.1), rng.range(1.6, 2.6));
         this._occupy(x, z, 0.6);
      };
      const rock = (x, z, big = 1) => {
         const w = rng.range(1.8, 5) * big, d = w * rng.range(0.6, 1.1);
         if (!this._free(x, z, Math.hypot(w, d) / 2, 1)) return;
         this._addObj('rock', x, z, rng() * Math.PI * 2, w, d, rng.range(1.2, 3.2) * big);
         this._occupy(x, z, Math.hypot(w, d) / 2);
      };
      const disc = (f) => { const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * f.r; return [f.x + Math.cos(a) * rr, f.z + Math.sin(a) * rr]; };
      for (const f of this.features) {
         if (f.kind === 'forest') {
            const nT = Math.round(f.density * Math.PI * f.r * f.r / 60);
            for (let i = 0; i < nT; i++) tree(...disc(f));
            const nB = Math.round((f.bushes || 0) * Math.PI * f.r * f.r / 220);
            for (let i = 0; i < nB; i++) bush(...disc(f));
         } else if (f.kind === 'rocks') for (let i = 0; i < f.n; i++) rock(...disc(f), i === 0 ? 1.5 : 1);
         else if (f.kind === 'bushes') for (let i = 0; i < f.n; i++) bush(...disc(f));
      }
      const sc = this.theme.scatter || {};
      const rnd = () => [rng.range(-this.half, this.half), rng.range(-this.half, this.half)];
      for (let i = 0; i < (sc.trees || 0); i++) tree(...rnd());
      for (let i = 0; i < (sc.bushes || 0); i++) bush(...rnd());
      for (let i = 0; i < (sc.rocks || 0); i++) rock(...rnd());
      delete this._occ;
   }

   _genSpawns() {
      for (const [team, b, face] of [['team1', this.bases.team1, 0], ['team2', this.bases.team2, Math.PI]]) {
         const sgn = team === 'team1' ? 1 : -1;
         const list = this.spawns[team];
         for (let i = 0; i < 10; i++) {
            const col = i % 5, row = (i / 5) | 0;
            const x = sgn * (-190 + col * 95) + (row ? sgn * 45 : 0);
            const z = sgn * (395 + row * 30);
            list.push({ x, z, yaw: face });
         }
         void b;
      }
   }

   // ------------------------------------------------------------------ spatial grid + queries
   _buildGrid() {
      const gc = this.gc = Math.ceil((2 * this.ext) / CELL);
      this.cells = Array.from({ length: gc * gc }, () => []);
      for (const o of this.objects) {
         if (o.kind === 'bush') continue;
         const r = o.kind === 'tree' ? o.r : Math.hypot(o.w, o.d) / 2;
         const i0 = this._ci(o.x - r), i1 = this._ci(o.x + r), j0 = this._ci(o.z - r), j1 = this._ci(o.z + r);
         for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * gc + i].push(o);
      }
      this._stamp = 1;
      for (const o of this.objects) o._st = 0;
      this._near = [];
   }
   _ci(v) { return clamp(Math.floor((v + this.ext) / CELL), 0, this.gc - 1); }

   /** Solid, alive objects whose bounds come within r of (x,z). Returns a reused array. */
   objectsNear(x, z, r) {
      const out = this._near; out.length = 0;
      const st = ++this._stamp, gc = this.gc;
      const i0 = this._ci(x - r), i1 = this._ci(x + r), j0 = this._ci(z - r), j1 = this._ci(z + r);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
         const cell = this.cells[j * gc + i];
         for (let k = 0; k < cell.length; k++) {
            const o = cell[k];
            if (o._st === st || !o.alive) continue;
            o._st = st;
            const br = o.kind === 'tree' ? o.r : Math.hypot(o.w, o.d) / 2;
            if (Math.hypot(o.x - x, o.z - z) < r + br) out.push(o);
         }
      }
      return out;
   }

   /** Mark a destructible object as destroyed (tree felled in direction dir). */
   destroyObject(o, dirX = 0, dirZ = 1) {
      if (!o.alive) return false;
      o.alive = false;
      o.fallYaw = Math.atan2(-dirX, -dirZ);
      this.version++;
      return true;
   }

   /** Ray vs one object (box or trunk cylinder approximated as box). Returns t or Infinity. */
   _rayObj(o, ox, oy, oz, dx, dy, dz, maxT) {
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      // world -> local (inverse yaw rotation about y): local x = c*wx - s*wz ... (three.js Ry)
      const rx = ox - o.x, rz = oz - o.z;
      const lx = c * rx - s * rz, lz = s * rx + c * rz;
      const ldx = c * dx - s * dz, ldz = s * dx + c * dz;
      const hw = o.kind === 'tree' ? o.r : o.w / 2, hd = o.kind === 'tree' ? o.r : o.d / 2;
      const y0 = o.y - 0.5, y1 = o.y + o.h;
      let t0 = 0, t1 = maxT;
      // x slab
      if (Math.abs(ldx) < 1e-9) { if (lx < -hw || lx > hw) return Infinity; }
      else { let a = (-hw - lx) / ldx, b = (hw - lx) / ldx; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity; }
      if (Math.abs(ldz) < 1e-9) { if (lz < -hd || lz > hd) return Infinity; }
      else { let a = (-hd - lz) / ldz, b = (hd - lz) / ldz; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity; }
      if (Math.abs(dy) < 1e-9) { if (oy < y0 || oy > y1) return Infinity; }
      else { let a = (y0 - oy) / dy, b = (y1 - oy) / dy; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) return Infinity; }
      return t0;
   }

   /** Objects only: nearest hit distance of the ray among alive objects that block shots
    *  (or all solid objects if `solidOnly` false → shots flag). Sets this.lastHit.obj. */
   raycastObjects(ox, oy, oz, dx, dy, dz, maxDist, includeSoft = false) {
      // 2D DDA over the object grid
      const gc = this.gc, ext = this.ext;
      let best = Infinity, bestObj = null;
      const st = ++this._stamp;
      let fx = (ox + ext) / CELL, fz = (oz + ext) / CELL;
      let i = Math.floor(fx), j = Math.floor(fz);
      const stepI = dx > 0 ? 1 : -1, stepJ = dz > 0 ? 1 : -1;
      const tdx = Math.abs(dx) > 1e-9 ? CELL / Math.abs(dx) : Infinity;
      const tdz = Math.abs(dz) > 1e-9 ? CELL / Math.abs(dz) : Infinity;
      let tmx = Math.abs(dx) > 1e-9 ? ((dx > 0 ? i + 1 - fx : fx - i) * CELL) / Math.abs(dx) : Infinity;
      let tmz = Math.abs(dz) > 1e-9 ? ((dz > 0 ? j + 1 - fz : fz - j) * CELL) / Math.abs(dz) : Infinity;
      let tCell = 0;
      for (let guard = 0; guard < 400; guard++) {
         if (i >= 0 && j >= 0 && i < gc && j < gc) {
            const cell = this.cells[j * gc + i];
            for (let k = 0; k < cell.length; k++) {
               const o = cell[k];
               if (o._st === st) continue;
               o._st = st;
               if (!o.alive || !(o.shots || (includeSoft && o.solid))) continue;
               const t = this._rayObj(o, ox, oy, oz, dx, dy, dz, Math.min(best, maxDist));
               if (t < best) { best = t; bestObj = o; }
            }
         }
         if (best <= tCell) break;
         if (tmx < tmz) { tCell = tmx; tmx += tdx; i += stepI; } else { tCell = tmz; tmz += tdz; j += stepJ; }
         if (tCell > maxDist || tCell > best) break;
      }
      this.lastHit.obj = bestObj;
      return best <= maxDist ? best : null;
   }

   /** Heightfield only. */
   raycastGround(ox, oy, oz, dx, dy, dz, maxDist) {
      let t = 0, prevT = 0;
      let diff = oy - this.heightAt(ox, oz);
      if (diff < 0) return 0;
      const lim = this.ext;
      while (t < maxDist) {
         prevT = t;
         t += clamp(diff * 0.6, 0.4, 8);
         if (t > maxDist) t = maxDist;
         const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
         if (x < -lim || x > lim || z < -lim || z > lim) return null;
         diff = y - this.heightAt(x, z);
         if (diff < 0) {
            let a = prevT, b = t;
            for (let k = 0; k < 8; k++) {
               const m = (a + b) / 2;
               if (oy + dy * m - this.heightAt(ox + dx * m, oz + dz * m) < 0) b = m; else a = m;
            }
            return b;
         }
         if (t >= maxDist) break;
      }
      return null;
   }

   /** Heightfield + shot-blocking objects. d must be unit length. Returns distance or null.
    *  this.lastHit = { type: 'ground'|'object', obj }. */
   raycast(ox, oy, oz, dx, dy, dz, maxDist) {
      const tg = this.raycastGround(ox, oy, oz, dx, dy, dz, maxDist);
      const to = this.raycastObjects(ox, oy, oz, dx, dy, dz, tg ?? maxDist);
      const obj = this.lastHit.obj;
      if (to != null && (tg == null || to < tg)) { this.lastHit.type = 'object'; this.lastHit.obj = obj; return to; }
      this.lastHit.obj = null;
      this.lastHit.type = tg != null ? 'ground' : null;
      return tg;
   }

   /** Bushes whose canopy the segment a->b passes through (for camouflage). Count only. */
   bushesOnLine(ax, az, bx, bz, skipNearB = 0) {
      let n = 0;
      const L = Math.hypot(bx - ax, bz - az) || 1;
      for (const o of this.bushes) {
         if (!o.alive) continue;
         // quick reject by bounding box
         if (o.x < Math.min(ax, bx) - 4 || o.x > Math.max(ax, bx) + 4 || o.z < Math.min(az, bz) - 4 || o.z > Math.max(az, bz) + 4) continue;
         const [d, t] = segDist(o.x, o.z, ax, az, bx, bz);
         if (d < o.r && (1 - t) * L > skipNearB) n++;
      }
      return n;
   }
   /** Is (x,z) inside the canopy of a bush (or within the edge of a tree crown)? */
   inBush(x, z, pad = 0) {
      for (const o of this.bushes) if (o.alive && Math.abs(o.x - x) < 6 && Math.abs(o.z - z) < 6 && Math.hypot(o.x - x, o.z - z) < o.r + pad) return true;
      return false;
   }
}

function lerpDepth(s, ft, total, shallow, deep) {
   const along = Math.abs(s - ft) * total;
   return shallow + (deep - shallow) * clamp01((along - 10) / 25);
}

export function makeTerrain(seed, themeId) { return new Terrain(seed, themeId); }
