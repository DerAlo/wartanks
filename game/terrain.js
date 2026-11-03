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
   // mission obstacles (terrain.addObject). hp = HE damage points (terrain.blast); hedgehogs also
   // break under ramming above `breakMomentum` t·m/s (tank.js hook), teeth never by ramming.
   teeth: { solid: true, shots: true, destructible: false, hp: 400 },
   hedgehog: { solid: true, shots: false, destructible: true, hp: 150, breakMomentum: 150 },
   wire: { solid: false, shots: false, destructible: true, hp: 40 },
   bridge: { solid: false, shots: false, destructible: false, hp: Infinity },
};
const KIND_SIZE = { teeth: [1.2, 1.2, 1.1], hedgehog: [1.6, 1.6, 1.15], wire: [6, 0.9, 0.9], bridge: [7, 20, 0.6] };
const BLAST_KINDS = { teeth: 1, hedgehog: 1, wire: 1 };
export const TRENCH_BRIDGE_K = 2.2;   // hull length >= K × trench width: the tank bridges the trench
const TRENCH_BRIDGED_DEPTH = 0.5;     // m of dip a bridging hull still feels
const TRENCH_WALL = 0.15;             // m: trench walls go from floor to lip over this width
const PARAPET_IN = 0.2, PARAPET_OUT = 2.6;   // spoil parapet band beyond the lip (m)

// segment distance without allocation: returns distance, parameter in _segT
let _segT = 0;
function segD(px, pz, ax, az, bx, bz) {
   const abx = bx - ax, abz = bz - az, l2 = abx * abx + abz * abz || 1e-9;
   let t = ((px - ax) * abx + (pz - az) * abz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
   _segT = t;
   const cx = ax + abx * t - px, cz = az + abz * t - pz;
   return Math.sqrt(cx * cx + cz * cz);
}
const posHash = (x, z) => { const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return v - Math.floor(v); };

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
      // mission features (trenches, bridges, wire): analytic height overlay on a cell grid, null = none
      this._pg = null; this.trenches = []; this.bridges = []; this.wires = [];
      this.heightVersion = 0; this.heightEdits = [];
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
      this.coast = feats.find((f) => f.kind === 'coast') || null;
      this.moles = feats.filter((f) => f.kind === 'mole');
      // bases & spawns (mirrored): team 1 south, team 2 north
      this.bases = { team1: { x: -170, z: 385 }, team2: { x: 170, z: -385 }, neutral: { x: 0, z: 0 } };
      if (theme.bases) for (const k in theme.bases) this.bases[k] = { ...theme.bases[k] };
      // river bridge sites (the causeways cut into rivers by `bridge:[t]`), for addBridge
      this.bridgeSites = [];
      for (const r of this.rivers) for (const bt of r.bridge || []) {
         const p = pointOnPoly(r, bt), hs = r.w / 2 + 14;
         this.bridgeSites.push({ x0: p.x + p.dz * hs, z0: p.z - p.dx * hs, x1: p.x - p.dz * hs, z1: p.z + p.dx * hs, w: 8, x: p.x, z: p.z });
      }
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
            if (!this._noCauseway) for (const bt of r.bridge || []) {
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
      // sea coast (shore, beach, shelf) and harbour moles
      let rimK = 1;
      if (this.coast) { const cs = this.coastS(x, z); h = this._coastH(cs, h); rimK = clamp01(-cs / 60); }
      for (const m of this.moles) {
         const [d] = polyDist(x, z, m.pts, m.lens, m.total);
         if (d < m.w / 2 + 12) h = Math.max(h, (this.water ?? 0) + m.h - Math.max(0, d - m.w / 2) * 1.6);
      }
      // outside the playable square: rising rim (not out at sea)
      const e = Math.max(Math.abs(x), Math.abs(z)) - this.half;
      if (e > -20 && rimK > 0) h += (Math.max(0, e + 20) ** 1.35 * 0.12 + Math.max(0, e) * fbm(x / 60, z / 60, s + 11, 2) * 0.15) * rimK;
      return h;
   }

   /** Coast maps: signed distance seaward of the shore line (> 0 = sea). */
   coastS(x, z) {
      const c = this.coast;
      return c ? c.z + fbm(x / 170, 0.5, this.nseed + 31, 2) * c.wig - z : -Infinity;
   }
   _coastH(cs, h) {
      const c = this.coast, wl = this.water ?? 0, top = wl + 0.5;
      if (cs < -c.beach) return h;
      if (cs <= 0) return h + (top - h) * smoothstep((cs + c.beach) / c.beach);
      const P = c.shelf;
      let dep = P[P.length - 1][1];
      for (let i = 0; i < P.length - 1; i++) if (cs < P[i + 1][0]) { dep = P[i][1] + (P[i + 1][1] - P[i][1]) * (cs - P[i][0]) / (P[i + 1][0] - P[i][0]); break; }
      return top - dep;
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
      const v = this._baseH(x, z);
      return this._pg === null ? v : this._ov(x, z, v, 0, true);
   }
   /** Height as felt by a tank hull of length `hullLen` (m): trenches narrower than
    *  hullLen / TRENCH_BRIDGE_K are bridged (shallow dip instead of the full drop). */
   hullHeightAt(x, z, hullLen = 0) {
      const v = this._baseH(x, z);
      return this._pg === null ? v : this._ov(x, z, v, hullLen, true);
   }
   /** Height of the ground mesh: trenches included, bridge decks not (they are drawn separately). */
   groundHeightAt(x, z) {
      const v = this._baseH(x, z);
      return this._pg === null ? v : this._ov(x, z, v, 0, false);
   }
   _baseH(x, z) {
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
         if (this.coast && this.coastS(x, z) > -this.coast.beach * 0.7) g = G_SOFT;     // beach sand
         for (const m of this.moles) if (polyDist(x, z, m.pts, m.lens, m.total)[0] < m.w / 2) g = G_ROAD;
         for (const r of this.roads) if (polyDist(x, z, r.pts, r.lens, r.total)[0] < r.w / 2 + 0.5) g = G_ROAD;
         if (this.water != null && this.heightAt(x, z) < this.water - 0.05) g = G_WATER;
         this.g[j * gn + i] = g;
      }
   }
   groundIdxAt(x, z) {
      const gn = this.gn;
      const i = clamp(Math.round((x + this.ext) / 4), 0, gn - 1), j = clamp(Math.round((z + this.ext) / 4), 0, gn - 1);
      if (this._pg !== null) {
         this._ov(x, z, this._baseH(x, z), 0, true);
         if (this._ovDeck) return G_ROAD;
         if (this._ovDig > 0.3) return G_SOFT;
      }
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
         } else if (f.kind === 'house') {          // explicitly placed building (warehouse, ...)
            this._house(f.x, f.z, f.yaw || 0, f.w, f.d, f.h);
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
            const sz = this.theme.spawnZ?.[team];
            const z = sz != null ? sz + sgn * row * 30 : sgn * (395 + row * 30);   // row 1 behind row 0
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

   // ------------------------------------------------------------------ mission features
   // Added by missions after generation (before the renderer is built; later calls work too:
   // `version` / `heightVersion` tell the renderer to rebuild). All deterministic, no rng use.

   _newObj(kind, x, z, yaw, w, d, h, extra) {
      const k = OBJECT_KINDS[kind];
      const o = {
         id: this.objects.length, kind, x, z, y: this.heightAt(x, z), yaw, w, d, h,
         solid: k.solid, shots: k.shots, destructible: k.destructible, alive: true, hp: k.hp,
         seed: (posHash(x, z) * 1e6) | 0, _st: 0, ...extra,
      };
      if (k.breakMomentum) o.breakMomentum ??= k.breakMomentum;
      o.r = Math.hypot(w, d) / 2;
      this.objects.push(o);
      if (kind === 'wire') this.wires.push(o);
      else if (o.solid || o.shots) this._gridAdd(o);
      this.version++;
      return o;
   }
   _gridAdd(o) {
      const r = Math.hypot(o.w, o.d) / 2, gc = this.gc;
      const i0 = this._ci(o.x - r), i1 = this._ci(o.x + r), j0 = this._ci(o.z - r), j1 = this._ci(o.z + r);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * gc + i].push(o);
   }
   /** Register a height-overlay segment record in every grid cell within r of it. */
   _pgAdd(p, r) {
      const gc = this.gc;
      if (this._pg === null) this._pg = new Array(gc * gc).fill(null);
      const i0 = this._ci(Math.min(p.ax, p.bx) - r), i1 = this._ci(Math.max(p.ax, p.bx) + r);
      const j0 = this._ci(Math.min(p.az, p.bz) - r), j1 = this._ci(Math.max(p.az, p.bz) + r);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
         const x = -this.ext + (i + 0.5) * CELL, z = -this.ext + (j + 0.5) * CELL;
         if (segD(x, z, p.ax, p.az, p.bx, p.bz) > r + CELL * 0.75) continue;
         (this._pg[j * gc + i] ??= []).push(p);
      }
   }
   _heightEdit(x0, z0, x1, z1) {
      this.heightVersion++;
      this.heightEdits.push({ v: this.heightVersion, x0, z0, x1, z1 });
   }
   /** Height overlay: trench cuts + parapets, bridge decks (decks=false: ground mesh view).
    *  Leaves this._ovDig (trench depth here) and this._ovDeck (standing on a deck). */
   _ov(x, z, v, hull, decks) {
      this._ovDig = 0; this._ovDeck = false;
      const cell = this._pg[this._ci(z) * this.gc + this._ci(x)];
      if (cell === null) return v;
      let dig = 0, par = 0, deck = -Infinity;
      for (let i = 0; i < cell.length; i++) {
         const p = cell[i], d = segD(x, z, p.ax, p.az, p.bx, p.bz);
         if (p.type === 0) {
            if (d < p.hw) {
               const k = (p.hw - d) / TRENCH_WALL, dep = hull >= p.bl ? Math.min(p.d, TRENCH_BRIDGED_DEPTH) : p.d;
               const dd = dep * (k > 1 ? 1 : k);
               if (dd > dig) dig = dd;
            } else if (p.par !== 0 && d > p.hw + PARAPET_IN && d < p.hw + PARAPET_OUT) {
               if (((p.bx - p.ax) * (z - p.az) - (p.bz - p.az) * (x - p.ax)) * p.par > 0) {
                  const u = (d - p.hw - (PARAPET_IN + PARAPET_OUT) / 2) / ((PARAPET_OUT - PARAPET_IN) / 2), b = 1 - u * u;
                  if (p.ph * b * b > par) par = p.ph * b * b;
               }
            }
         } else if (decks && d < p.hw) {
            const t = _segT, o = p.o;
            if (o.alive === false && t > o.gap[0] && t < o.gap[1]) continue;
            const y = p.y0 + (p.y1 - p.y0) * t;
            if (y > deck) deck = y;
         }
      }
      this._ovDig = dig;
      const h = dig > 0 ? v - dig : v + par;
      if (deck > h) { this._ovDeck = true; return deck; }
      return h;
   }

   /** Add a mission object: { kind:'teeth'|'hedgehog'|'wire'|'bridge'|any OBJECT_KINDS, x, z, yaw?, w?, d?, h?, hp? }.
    *  Bridges also take { x0, z0, x1, z1 } (or x, z, yaw + d = length) and go through addBridge. */
   addObject(spec) {
      const kind = spec.kind;
      if (!OBJECT_KINDS[kind]) throw new Error('unknown object kind ' + kind);
      if (kind === 'bridge') {
         if (spec.x0 != null) return this.addBridge(spec.x0, spec.z0, spec.x1, spec.z1, spec);
         const L = spec.d ?? 20, s = Math.sin(spec.yaw || 0) * L / 2, c = Math.cos(spec.yaw || 0) * L / 2;
         return this.addBridge(spec.x + s, spec.z + c, spec.x - s, spec.z - c, spec);
      }
      const sz = KIND_SIZE[kind] || [2, 2, 2];
      const o = this._newObj(kind, spec.x, spec.z, spec.yaw ?? 0, spec.w ?? sz[0], spec.d ?? sz[1], spec.h ?? sz[2],
         spec.breakMomentum != null ? { breakMomentum: spec.breakMomentum } : undefined);
      if (spec.hp != null) o.hp = spec.hp;
      return o;
   }

   /** Staggered rows of dragon's teeth (Höcker) from (x0,z0) to (x1,z1); rows 3|4, ~1.6 m pitch.
    *  Rows are offset to the left of the direction x0->x1; later rows are taller. Returns the objects. */
   addTeethLine(x0, z0, x1, z1, { rows = 3, spacing = 1.6, rowGap = 1.45 } = {}) {
      const L = Math.hypot(x1 - x0, z1 - z0) || 1, ux = (x1 - x0) / L, uz = (z1 - z0) / L;
      const yaw = Math.atan2(-ux, -uz), out = [];
      for (let r = 0; r < rows; r++) {
         const off = (r % 2) * spacing / 2, ax = -uz * r * rowGap, az = ux * r * rowGap;   // left normal (-uz, ux)
         for (let s = off; s <= L + 1e-6; s += spacing) {
            const x = x0 + ux * s + ax, z = z0 + uz * s + az, k = posHash(x, z);
            out.push(this.addObject({ kind: 'teeth', x, z, yaw: yaw + (k - 0.5) * 0.12, h: 0.95 + r * 0.15 + k * 0.1 }));
         }
      }
      return out;
   }
   /** Concertina wire along a line, ~6 m segments. Returns the objects. */
   addWireLine(x0, z0, x1, z1, { seg = 6 } = {}) {
      const L = Math.hypot(x1 - x0, z1 - z0) || 1, n = Math.max(1, Math.round(L / seg)), ux = (x1 - x0) / L, uz = (z1 - z0) / L;
      const yaw = Math.atan2(-uz, ux), out = [];      // local x (cos yaw, -sin yaw) along the line
      for (let i = 0; i < n; i++) {
         const t = (i + 0.5) / n;
         out.push(this.addObject({ kind: 'wire', x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, yaw, w: L / n }));
      }
      return out;
   }

   /** Carve a trench along a polyline [[x,z],...]: { w = 2.5, d = 1.8, enemy?: [x,z] (spoil parapet on
    *  that side), parapet = 0.6 (m) }. Floor follows the ground, walls near vertical, soft ground inside. */
   carveTrench(points, { w = 2.5, d = 1.8, enemy = null, parapet = 0.6 } = {}) {
      const pts = points.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [p.x, p.z]));
      const ex = enemy && (Array.isArray(enemy) ? enemy[0] : enemy.x), ez = enemy && (Array.isArray(enemy) ? enemy[1] : enemy.z);
      const tr = { id: this.trenches.length, kind: 'trench', pts, w, d, parapet: enemy ? parapet : 0, enemy, segs: [] };
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
         const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
         const par = enemy ? Math.sign((bx - ax) * (ez - az) - (bz - az) * (ex - ax)) : 0;
         const p = { type: 0, ax, az, bx, bz, hw: w / 2, d, bl: TRENCH_BRIDGE_K * w, par, ph: tr.parapet, tr };
         tr.segs.push(p);
         this._pgAdd(p, w / 2 + PARAPET_OUT + 1);
         x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx); z0 = Math.min(z0, az, bz); z1 = Math.max(z1, az, bz);
      }
      const pad = w / 2 + PARAPET_OUT + 2;
      this.trenches.push(tr);
      this._heightEdit(x0 - pad, z0 - pad, x1 + pad, z1 + pad);
      return tr;
   }
   /** Distance from (x,z) to the nearest trench centre line minus its half width (< 0 inside), or Infinity. */
   trenchDist(x, z) {
      if (this._pg === null) return Infinity;
      const cell = this._pg[this._ci(z) * this.gc + this._ci(x)];
      let best = Infinity;
      if (cell) for (const p of cell) if (p.type === 0) best = Math.min(best, segD(x, z, p.ax, p.az, p.bx, p.bz) - p.hw);
      return best;
   }

   /** Road bridge from bank (x0,z0) to bank (x1,z1), { w = 7 }. Deck at the bank heights (at least 1.2 m
    *  above water). A river causeway (`bridgeSites`) under the span is dug out. Returns the object. */
   addBridge(x0, z0, x1, z1, { w = 7 } = {}) {
      for (const site of this.bridgeSites) if (segD(site.x, site.z, x0, z0, x1, z1) < 12) this._removeCauseway(site);
      const L = Math.hypot(x1 - x0, z1 - z0) || 1, wl = this.water;
      const deckAt = (x, z) => { const h = this.groundHeightAt(x, z); return wl != null ? Math.max(h, wl + 1.2) : h; };
      const y0 = deckAt(x0, z0), y1 = deckAt(x1, z1);
      const o = this._newObj('bridge', (x0 + x1) / 2, (z0 + z1) / 2, Math.atan2(-(x1 - x0), -(z1 - z0)), w, L, 0.6,
         { x0, z0, x1, z1, y0, y1, gap: [0.35, 0.65], blown: false });
      o.y = (y0 + y1) / 2;
      this._pgAdd({ type: 1, ax: x0, az: z0, bx: x1, bz: z1, hw: w / 2, y0, y1, o }, w / 2 + 1);
      this.bridges.push(o);
      this.heightVersion++;
      return o;
   }
   /** Blow a bridge: the span between gap[0]..gap[1] (fraction of the length, default the middle
    *  third) drops out. Tanks on it fall into the water; shells fly through. */
   blowBridge(o, { gap } = {}) {
      if (!o || o.kind !== 'bridge' || o.alive === false) return false;
      if (gap) o.gap = gap;
      o.alive = false; o.blown = true;
      this.version++; this.heightVersion++;
      return true;
   }
   _removeCauseway(site) {
      if (site.removed) return;
      site.removed = true;
      const n = this.n, R = Math.hypot(site.x1 - site.x0, site.z1 - site.z0) / 2 + 12;
      const i0 = Math.max(0, Math.floor((site.x - R + this.ext) / RES)), i1 = Math.min(n - 1, Math.ceil((site.x + R + this.ext) / RES));
      const j0 = Math.max(0, Math.floor((site.z - R + this.ext) / RES)), j1 = Math.min(n - 1, Math.ceil((site.z + R + this.ext) / RES));
      this._noCauseway = true;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.h[j * n + i] = this._rawHeight(-this.ext + i * RES, -this.ext + j * RES);
      this._noCauseway = false;
      const gn = this.gn;
      for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) {
         const x = -this.ext + i * 4, z = -this.ext + j * 4;
         if (Math.abs(x - site.x) > R || Math.abs(z - site.z) > R) continue;
         if (this.water != null && this._baseH(x, z) < this.water - 0.05) this.g[j * gn + i] = G_WATER;
      }
      this._heightEdit(site.x - R, site.z - R, site.x + R, site.z + R);
   }

   /** A tank footprint (circle r around x,z) flattens concertina wire. Returns how many broke. */
   driveOver(x, z, r) {
      let n = 0;
      for (const o of this.wires) {
         if (!o.alive || Math.abs(o.x - x) > r + o.w || Math.abs(o.z - z) > r + o.w) continue;
         const hx = Math.cos(o.yaw) * o.w / 2, hz = -Math.sin(o.yaw) * o.w / 2;
         if (segD(x, z, o.x - hx, o.z - hz, o.x + hx, o.z + hz) < r + o.d / 2) {
            o.alive = false; o.fallYaw = o.yaw; this.version++; n++;
         }
      }
      return n;
   }
   /** HE blast at (x,y,z): damages teeth / hedgehogs / wire within ~0.6 + cal·0.025 m (direct hit
    *  `hitObj` takes the full `dmg`, near misses up to 60 %, linear falloff). Returns objects destroyed. */
   blast(x, y, z, cal = 75, dmg = 0, hitObj = null) {
      const R = 0.6 + cal * 0.025, base = dmg || cal * 3;
      const cand = this.objectsNear(x, z, R + 1).slice();
      for (const o of this.wires) if (o.alive && Math.abs(o.x - x) < R + o.w && Math.abs(o.z - z) < R + o.w) cand.push(o);
      if (hitObj && !cand.includes(hitObj)) cand.push(hitObj);
      let n = 0;
      for (const o of cand) {
         if (!BLAST_KINDS[o.kind] || !o.alive) continue;
         let f = 1;
         if (o !== hitObj) {
            const dd = Math.max(0, Math.hypot(o.x - x, o.z - z, Math.max(0, y - (o.y + o.h))) - (o.kind === 'wire' ? o.d : o.r));
            if (dd >= R) continue;
            f = 0.6 * (1 - dd / R);
         }
         o.hp -= base * f;
         if (o.hp <= 0) { o.hp = 0; if (this.destroyObject(o, o.x - x || 0.01, o.z - z)) n++; }
      }
      return n;
   }

   /** Dev/screenshot helper (`?demofeatures` in the page URL): a sample of every feature in front of
    *  team 1's spawn; `?demofeatures=blown` also blows the bridge. */
   addDemoFeatures(blown = false) {
      const sp = this.spawns.team1[2], x = sp.x, z = sp.z - 30;
      this.addTeethLine(x - 70, z - 10, x - 8, z - 10, { rows: 3 });
      this.addTeethLine(x + 8, z - 10, x + 70, z - 10, { rows: 4 });
      for (let i = 0; i < 6; i++) this.addObject({ kind: 'hedgehog', x: x - 6 + (i % 3) * 5, z: z - 6 - ((i / 3) | 0) * 5, yaw: i * 0.9 });
      this.addWireLine(x - 60, z - 22, x + 60, z - 22);
      this.carveTrench([[x - 80, z - 40], [x - 50, z - 48], [x - 20, z - 38], [x + 10, z - 48], [x + 40, z - 38], [x + 80, z - 46]],
         { w: 2.5, d: 1.8, enemy: [x, z - 300] });
      const site = this.bridgeSites[0];
      const b = site ? this.addBridge(site.x0, site.z0, site.x1, site.z1, { w: 7 })
         : this.addBridge(x + 30, z + 12, x + 30, z - 4, { w: 7 });
      if (blown) this.blowBridge(b);
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

export function makeTerrain(seed, themeId) {
   const t = new Terrain(seed, themeId);
   const qs = (typeof location !== 'undefined' && location?.search) || '';
   if (/[?&]demofeatures/.test(qs)) t.addDemoFeatures(/demofeatures=blown/.test(qs));
   return t;
}
