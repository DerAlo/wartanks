// game/tanks3d.js — procedural tank models from the SAME armour geometry the sim uses (config.js):
// hull = side profile extruded across the hull width (sides lean in by the side slope), turret =
// top-view polygon whose faces lean in by their slope, + mantlet, barrel, running gear, tracks with
// scrolling treads, fenders, hatches, cupola, exhausts, tools, nation camouflage and insignia.
// Draw calls per tank: hull, turret, gun, 2 tracks, decals (shared materials per nation); shell hit
// marks for all tanks together: 2 (hitmarks.js).
import * as THREE from '../vendor/three/three.module.min.js';
import { HitMarks, isHitEvent } from './hitmarks.js';

const DEG = Math.PI / 180;
const hash = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

// ---------------- textures / materials (shared) ----------------
const CAMO = {
   de: { base: '#a8935e', spots: ['#737149', '#7d6044'], style: 'streak' },
   su: { base: '#4a5034', spots: ['#41472e', '#555b3c'], style: 'plain' },
   us: { base: '#585a39', spots: ['#4e5133', '#62643f'], style: 'plain' },
   uk: { base: '#6b6847', spots: ['#4d4a34', '#7a7452'], style: 'blotch' },
};
function camoTexture(n) {
   const c = CAMO[n] || CAMO.de, cv = document.createElement('canvas'); cv.width = cv.height = 256;
   const g = cv.getContext('2d'); g.fillStyle = c.base; g.fillRect(0, 0, 256, 256);
   for (let i = 0; i < (c.style === 'plain' ? 26 : 34); i++) {
      g.fillStyle = c.spots[i % 2]; g.globalAlpha = c.style === 'plain' ? 0.35 : c.style === 'streak' ? 0.62 : 0.8;
      const x = hash(i, 1) * 256, y = hash(i, 2) * 256, r = 10 + hash(i, 3) * 26;
      g.beginPath();
      for (let k = 0; k < 9; k++) {
         const a = k / 9 * Math.PI * 2, rr = r * (0.6 + hash(i, k) * 0.7) * (c.style === 'streak' ? (k % 2 ? 0.35 : 1.4) : 1);
         g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * (c.style === 'streak' ? 0.5 : 1));
      }
      g.fill();
      for (const dx of [-256, 256]) { g.save(); g.translate(dx, 0); g.fill(); g.restore(); }
   }
   g.globalAlpha = 1;
   const img = g.getImageData(0, 0, 256, 256);   // grime + wear
   for (let i = 0; i < img.data.length; i += 4) { const k = 1 + (Math.random() - 0.5) * 0.12 - (i / 4 / 256 / 256) * 0.1; img.data[i] *= k; img.data[i + 1] *= k; img.data[i + 2] *= k; }
   g.putImageData(img, 0, 0);
   const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
   return t;
}
function treadTexture() {
   const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const g = cv.getContext('2d');
   g.fillStyle = '#2c2a26'; g.fillRect(0, 0, 64, 64);
   for (let i = 0; i < 4; i++) { g.fillStyle = '#4a4740'; g.fillRect(0, i * 16 + 2, 64, 9); g.fillStyle = '#5e5a50'; g.fillRect(4, i * 16 + 4, 56, 3); g.fillStyle = '#1a1917'; g.fillRect(30, i * 16, 4, 16); }
   const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
   return t;
}
function insigniaTexture() {   // atlas 4×1: de cross, su star, us star, uk roundel
   const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const g = cv.getContext('2d');
   const cx = (i) => i * 128 + 64;
   // Balkenkreuz: white outline, black cross
   g.fillStyle = '#eee'; g.fillRect(cx(0) - 40, 24, 80, 80); g.clearRect(cx(0) - 40, 24, 26, 26); g.clearRect(cx(0) + 14, 24, 26, 26); g.clearRect(cx(0) - 40, 78, 26, 26); g.clearRect(cx(0) + 14, 78, 26, 26);
   g.fillStyle = '#111'; g.fillRect(cx(0) - 34, 56, 68, 16); g.fillRect(cx(0) - 8, 30, 16, 68);
   const star = (x, y, r, col) => { g.fillStyle = col; g.beginPath(); for (let k = 0; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.4 : r; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.fill(); };
   star(cx(1), 66, 44, '#b02a22');
   g.strokeStyle = '#ddd'; g.lineWidth = 6; g.beginPath(); g.arc(cx(2), 64, 50, 0, 7); g.stroke(); star(cx(2), 66, 44, '#e8e6dc');
   for (const [r, c] of [[50, '#ddd'], [44, '#24356e'], [30, '#ddd'], [16, '#a82222']]) { g.fillStyle = c; g.beginPath(); g.arc(cx(3), 64, r, 0, 7); g.fill(); }
   const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
   return t;
}
let SHARED = null;
function shared() {
   if (SHARED) return SHARED;
   const camo = {}, tread = treadTexture();
   for (const n in CAMO) camo[n] = new THREE.MeshStandardMaterial({ map: camoTexture(n), vertexColors: true, roughness: 0.78, metalness: 0.15, flatShading: true });
   SHARED = {
      camo, tread,
      wreck: new THREE.MeshStandardMaterial({ color: 0x2b2724, vertexColors: true, roughness: 1, metalness: 0.05, flatShading: true }),
      decal: new THREE.MeshStandardMaterial({ map: insigniaTexture(), transparent: true, alphaTest: 0.3, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }),
      trackWreck: new THREE.MeshStandardMaterial({ color: 0x1d1b19, roughness: 1 }),
   };
   return SHARED;
}

// ---------------- geometry accumulator ----------------
class Acc {
   constructor() { this.p = []; this.c = []; this.uv = []; }
   tri(a, b, c, col, center) {
      // face normal outward from `center` (convex pieces): flip winding if needed
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (center && nx * (a[0] - center[0]) + ny * (a[1] - center[1]) + nz * (a[2] - center[2]) < 0) { const t = b; b = c; c = t; }
      for (const v of [a, b, c]) {
         this.p.push(v[0], v[1], v[2]); this.c.push(col[0], col[1], col[2]);
         // planar camo mapping: blends side and top projections
         this.uv.push((v[0] * 0.7 + v[2]) * 0.4, (v[1] + v[0] * 0.3) * 0.4);
      }
   }
   quad(a, b, c, d, col, ctr) { this.tri(a, b, c, col, ctr); this.tri(a, c, d, col, ctr); }
   // generic three.js geometry with a transform
   geo(g, m, col) {
      const ng = g.index ? g.toNonIndexed() : g.clone(); ng.applyMatrix4(m);
      const p = ng.attributes.position.array;
      for (let i = 0; i < p.length; i += 3) { this.p.push(p[i], p[i + 1], p[i + 2]); this.c.push(col[0], col[1], col[2]); this.uv.push((p[i] * 0.7 + p[i + 2]) * 0.4, (p[i + 1] + p[i] * 0.3) * 0.4); }
   }
   box(x, y, z, w, h, d, col, rx = 0, ry = 0, rz = 0) { this.geo(BOX, mat(x, y, z, rx, ry, rz, w, h, d), col); }
   cyl(x, y, z, r0, r1, len, col, axis = 'x', seg = 10, rx = 0) {
      const g = new THREE.CylinderGeometry(r1, r0, len, seg);
      const e = axis === 'x' ? [0, 0, Math.PI / 2] : axis === 'z' ? [Math.PI / 2 + rx, 0, 0] : [0, 0, 0];
      this.geo(g, mat(x, y, z, e[0], e[1], e[2]), col);
   }
   build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.computeVertexNormals(); g.computeBoundingSphere();
      return g;
   }
}
const BOX = new THREE.BoxGeometry(1, 1, 1);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const mat = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => _m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
const PAINT = [1, 1, 1], DARK = [0.42, 0.42, 0.4], STEEL = [0.3, 0.3, 0.3], WOOD = [0.75, 0.55, 0.38], BLACK = [0.12, 0.12, 0.12];

// ---------------- geometry from config.js (finalised TANKS[id]) ----------------
const NAT = { DE: 'de', SU: 'su', US: 'us', UK: 'uk' };
// clip a convex (z,y) polygon to y >= yc (above) or y <= yc
function clipY(poly, yc, above) {
   const out = [], inside = (p) => above ? p[1] >= yc - 1e-6 : p[1] <= yc + 1e-6;
   for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) { const t = (yc - a[1]) / (b[1] - a[1]); out.push([a[0] + (b[0] - a[0]) * t, yc]); }
   }
   return out;
}
function hull2D(pts) {   // monotone chain convex hull
   pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
   const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
   const lo = [], up = [];
   for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
   for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
   up.pop(); lo.pop(); return lo.concat(up);
}
export function shapeOf(cfg = {}) {
   const h = cfg.hull || {}, run = cfg.run || {}, d = cfg.dims || { len: 6, width: 3.2, height: 2.6 };
   const profile = (h.profile || [{ z: -3, y: 0.45 }, { z: -3, y: 1.6 }, { z: 3, y: 1.6 }, { z: 3, y: 0.45 }]).map((p) => [p.z, p.y]);
   const rz = run.z ?? 0, rl = run.len ?? d.len * 0.9;
   return {
      cfg, nation: NAT[cfg.nation] || 'de', L: d.len, W: d.width, H: d.height,
      hull: { profile, w: h.w ?? 2.6, lowerW: h.lowerW, sponsonY: h.sponsonY, floorY: h.floorY ?? 0.45, roofY: h.roofY ?? 1.6, slope: (h.sideSlope ?? 0) * DEG, zMin: h.zMin ?? -3, zMax: h.zMax ?? 3 },
      turret: cfg.turret, mantlet: cfg.mantlet, gun: cfg.gun || { cal: 75, len: 3, pivot: { x: 0, y: 0.3, z: -0.6 }, mount: 'turret' },
      track: { x: run.x ?? d.width / 2 - 0.3, w: run.trackW ?? 0.5, z0: rz - rl / 2, z1: rz + rl / 2, top: run.h ?? 1.0, wheels: run.wheels ?? 6, r: run.wheelR ?? 0.35,
         inter: run.interleave ?? 0, bogies: run.bogies ?? 0, rollers: run.rollers ?? 0, sprF: run.sprocket !== 'rear', sprR: run.sprocketR ?? 0.3, idlR: run.idlerR ?? 0.28, allround: run.style === 'allround' },
      skirts: cfg.skirts, cls: cfg.cls,
   };
}

// ---------------- builders ----------------
function hullPiece(A, poly, halfW, y0, slope, col) {
   const ys = poly.map((p) => p[1]), zs = poly.map((p) => p[0]);
   const ctr = [0, (Math.min(...ys) + Math.max(...ys)) / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
   const xAt = (y) => Math.max(0.2, halfW - Math.max(0, y - y0) * Math.tan(slope));
   const L = poly.map(([z, y]) => [-xAt(y), y, z]), R = poly.map(([z, y]) => [xAt(y), y, z]);
   for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; A.quad(L[i], L[j], R[j], R[i], col, ctr); }
   for (let i = 1; i < poly.length - 1; i++) { A.tri(L[0], L[i], L[i + 1], col, ctr); A.tri(R[0], R[i], R[i + 1], col, ctr); }
}
function roofYAt(profile, z) { let best = -1; for (let i = 0; i < profile.length; i++) { const a = profile[i], b = profile[(i + 1) % profile.length]; if ((a[0] - z) * (b[0] - z) <= 0 && a[0] !== b[0]) { const y = a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0]); if (y > best) best = y; } } return best; }
function wheelZs(T) {
   const end = Math.max(T.sprR, T.idlR) * 1.05 + T.r * 0.9, a = T.z0 + end, b = T.z1 - end, n = T.wheels, out = [];
   if (T.bogies) { const per = n / T.bogies; for (let k = 0; k < T.bogies; k++) { const c = a + (b - a) * (T.bogies === 1 ? 0.5 : k / (T.bogies - 1)); for (let j = 0; j < per; j++) out.push(c + (j - (per - 1) / 2) * T.r * 2.05); } }
   else for (let i = 0; i < n; i++) out.push(a + (b - a) * (n === 1 ? 0.5 : i / (n - 1)));
   return out;
}
function sprocketIdler(T) {
   return { sz: T.sprF ? T.z0 + T.sprR : T.z1 - T.sprR, sy: T.top - T.sprR - 0.03,
      iz: T.sprF ? T.z1 - T.idlR : T.z0 + T.idlR, iy: T.allround ? T.top - T.idlR - 0.03 : Math.max(T.idlR + 0.1, T.top - T.idlR - 0.15) };
}
function buildHull(S) {
   const A = new Acc(), H = S.hull, T = S.track, P = H.profile;
   if (H.sponsonY != null && H.lowerW) {
      hullPiece(A, clipY(P, H.sponsonY, false), H.lowerW / 2, H.floorY, 0, PAINT);
      hullPiece(A, clipY(P, H.sponsonY, true), H.w / 2, H.sponsonY, H.slope, PAINT);
   } else hullPiece(A, P, H.w / 2, H.floorY, H.slope, PAINT);
   const front = H.zMin, back = H.zMax, tz = (T.z0 + T.z1) / 2, tl = T.z1 - T.z0;
   const covered = H.w / 2 >= T.x + T.w / 2 - 0.05;
   for (const s of [-1, 1]) {
      const fy = T.top + 0.04;
      if (!covered && !T.allround) A.box(s * T.x, fy, tz, T.w + 0.1, 0.04, tl + 0.1, PAINT);
      const toolX = covered ? s * (H.w / 2 - 0.25) : s * T.x, ty = covered ? roofYAt(P, tz) : fy;
      A.box(toolX, ty + 0.06, tz - 0.7, 0.14, 0.05, 1.25, WOOD);
      A.cyl(toolX + s * 0.12, ty + 0.06, tz + 0.7, 0.035, 0.035, 1.9, DARK, 'z', 6);
   }
   if (S.skirts) for (const s of [-1, 1]) { const sk = S.skirts, y0 = sk.y0 ?? 0.6, hh = sk.h ?? 0.6; for (let k = 0; k < 6; k++) A.box(s * (T.x + T.w / 2 + 0.06), y0 + hh / 2, T.z0 + tl * (k + 0.5) / 6, 0.025, hh, tl / 6 - 0.04, PAINT, 0, 0, s * 0.03); }
   const zs = wheelZs(T), r = T.r, { sz, sy, iz, iy } = sprocketIdler(T);
   for (const s of [-1, 1]) {
      const x = s * T.x;
      zs.forEach((z, i) => {
         const off = T.inter === 3 ? ((i % 3) - 1) * T.w * 0.28 : T.inter === 2 ? (i % 2 ? 0.5 : -0.5) * T.w * 0.36 : 0;
         const ww = T.inter ? T.w * 0.3 : T.w * 0.62;
         A.cyl(x + off * s, r + 0.02, z, r, r, ww, DARK, 'x', 14);
         A.cyl(x + off * s + s * ww * 0.5, r + 0.02, z, r * 0.4, r * 0.4, 0.04, STEEL, 'x', 8);
      });
      if (T.bogies) for (let k = 0; k < T.bogies; k++) { const per = zs.length / T.bogies, z = (zs[k * per] + zs[k * per + per - 1]) / 2; A.box(x - s * T.w * 0.35, r + 0.25, z, 0.2, 0.45, r * 2.2, STEEL); }
      A.cyl(x, sy, sz, T.sprR, T.sprR, T.w * 0.75, STEEL, 'x', 12);
      for (let k = 0; k < 8; k++) A.box(x, sy + Math.cos(k * 0.785) * T.sprR, sz + Math.sin(k * 0.785) * T.sprR, T.w * 0.5, 0.07, 0.07, STEEL, k * 0.785);
      A.cyl(x, iy, iz, T.idlR, T.idlR, T.w * 0.6, DARK, 'x', 12);
      for (let k = 0; k < T.rollers; k++) A.cyl(x, T.top - 0.12, T.z0 + (k + 1) * tl / (T.rollers + 1), 0.09, 0.09, T.w * 0.4, STEEL, 'x', 8);
   }
   const hz = front + (back - front) * 0.18, hy = roofYAt(P, hz);
   for (const s of [-1, 1]) A.cyl(s * H.w * 0.2, hy + 0.035, hz, 0.28, 0.28, 0.07, PAINT, 'y', 10);
   A.cyl(-H.w * 0.33, roofYAt(P, front + 0.3) + 0.12, front + 0.3, 0.09, 0.11, 0.18, DARK, 'z', 8);
   const ry = roofYAt(P, back - 0.2);
   for (const s of [-1, 1]) A.cyl(s * H.w * 0.27, ry - 0.25, back + 0.07, 0.09, 0.09, 0.55, BLACK, 'y', 8);
   A.box(0, roofYAt(P, back - 0.9) + 0.02, back - 0.9, H.w * 0.55, 0.05, 0.9, DARK);
   if (S.nation === 'su' || S.nation === 'us') for (let k = 0; k < 3; k++) { const z = front + 0.55; A.box(0.36 * (k - 1), roofYAt(P, z) - 0.25, z, 0.3, 0.06, 0.2, DARK, -0.9); }
   if (S.mantlet && S.mantlet.mount === 'hull') { const m = S.mantlet; A.box(m.x, m.y, m.z, m.w, m.h, m.d, PAINT); }
   return A.build();
}
function buildTurret(S, PAINT = [1, 1, 1], DARK = [0.42, 0.42, 0.4]) {
   const A = new Acc(), T = S.turret, base = T.base, top = T.top, n = base.length;
   const ctr = [base.reduce((s, p) => s + p[0], 0) / n, T.h / 2, base.reduce((s, p) => s + p[1], 0) / n];
   const B = base.map(([x, z]) => [x, 0, z]), U = top.map(([x, z]) => [x, T.h, z]);
   for (let i = 0; i < n; i++) { const j = (i + 1) % n; A.quad(B[i], B[j], U[j], U[i], PAINT, ctr); }
   for (let i = 1; i < n - 1; i++) { A.tri(U[0], U[i], U[i + 1], PAINT, ctr); A.tri(B[0], B[i], B[i + 1], PAINT, ctr); }
   const zs = top.map((p) => p[1]), zBack = Math.max(...zs), zFront = Math.min(...zs), xMax = Math.max(...top.map((p) => p[0]));
   if (!T.openTop) {
      const cz = zFront + (zBack - zFront) * 0.68, cx = -Math.min(0.42, xMax * 0.55);
      A.cyl(cx, T.h + 0.14, cz, 0.34, 0.31, 0.28, PAINT, 'y', 12);
      for (let k = 0; k < 7; k++) A.box(cx + Math.cos(k * 0.9) * 0.32, T.h + 0.17, cz + Math.sin(k * 0.9) * 0.32, 0.06, 0.08, 0.12, BLACK, 0, -k * 0.9);
      A.cyl(cx, T.h + 0.3, cz, 0.31, 0.28, 0.05, PAINT, 'y', 12);
      A.cyl(-cx * 0.9, T.h + 0.03, cz - 0.1, 0.26, 0.26, 0.06, PAINT, 'y', 10);
   }
   const bBack = Math.max(...base.map((p) => p[1]));
   if (S.nation === 'de') A.box(0, T.h * 0.5, bBack + 0.18, Math.min(1.3, xMax * 1.3), T.h * 0.6, 0.36, PAINT);
   else if (S.nation === 'us' || S.nation === 'uk') A.box(0, T.h * 0.55, bBack + 0.1, xMax * 0.9, T.h * 0.35, 0.2, DARK);
   A.box(xMax * 0.3, T.h + 0.1, zFront + 0.35, 0.12, 0.18, 0.12, DARK);
   if (S.mantlet && S.mantlet.mount !== 'hull') { const m = S.mantlet; A.box(m.x, m.y, m.z, m.w, m.h, m.d, PAINT); }
   return A.build();
}
function buildGun(S, PAINT = [1, 1, 1], DARK = [0.42, 0.42, 0.4]) {
   const A = new Acc(), G = S.gun, r = Math.max(0.04, G.cal / 1000 * 0.72);
   const m = S.mantlet, start = m ? -(Math.abs(m.z - G.pivot.z) + m.d / 2) : 0;   // barrel leaves the mantlet face
   A.cyl(0, 0, start + 0.1, r * 2.3, r * 2.5, 0.45, PAINT, 'z', 12);
   const len = G.len + start;
   A.cyl(0, 0, start - len / 2, r * 1.4, r, len, DARK, 'z', 12);
   A.cyl(0, 0, start - len * 0.35, r * 1.6, r * 1.6, 0.22, DARK, 'z', 10);
   if (G.brake) { A.cyl(0, 0, -G.len + 0.15, r * 2, r * 2, 0.3, DARK, 'z', 10); A.box(0, 0, -G.len + 0.15, r * 4.4, r * 2.6, 0.13, DARK); }
   return A.build();
}
function buildTrack(S) {
   const T = S.track, zs = wheelZs(T), pts = [], { sz, sy, iz, iy } = sprocketIdler(T);
   const circ = (z, y, rr) => { for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2; pts.push([z + Math.cos(a) * rr, y + Math.sin(a) * rr]); } };
   circ(sz, sy, T.sprR + 0.05); circ(iz, iy, T.idlR + 0.05);
   for (const z of [zs[0], zs[zs.length - 1]]) circ(z, T.r + 0.02, T.r + 0.05);
   if (T.rollers || T.allround) circ((T.z0 + T.z1) / 2, T.top - 0.12, 0.14);
   const loop = hull2D(pts), hw = T.w / 2, pos = [], uv = [], idx = [];
   let u = 0;
   for (let i = 0; i <= loop.length; i++) {
      const p = loop[i % loop.length]; if (i) { const q = loop[i - 1]; u += Math.hypot(p[0] - q[0], p[1] - q[1]); }
      for (const x of [-hw, hw]) { pos.push(x, p[1], p[0]); uv.push(u / 0.6, x > 0 ? 1 : 0); }
   }
   for (let i = 0; i < loop.length; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
   const g = new THREE.BufferGeometry();
   g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
   g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
   return g;
}
function buildDecals(S, onTurret) {
   const idx = { de: 0, su: 1, us: 2, uk: 3 }[S.nation] ?? 0, pos = [], uv = [];
   const quad = (cx, cy, cz, sz, side) => {
      const h = sz / 2, u0 = idx / 4, u1 = (idx + 1) / 4;
      const P = side ? [[cx, cy - h, cz + h * side], [cx, cy - h, cz - h * side], [cx, cy + h, cz - h * side], [cx, cy + h, cz + h * side]] : [[cx - h, cy, cz + h], [cx + h, cy, cz + h], [cx + h, cy, cz - h], [cx - h, cy, cz - h]];
      for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(...P[k]); uv.push([u0, u1, u1, u0][k], [0, 0, 1, 1][k]); }
   };
   const T = S.turret, H = S.hull;
   if (onTurret && T) {
      for (const s of [-1, 1]) { const xb = Math.max(...T.base.map((p) => p[0])), xt = Math.max(...T.top.map((p) => p[0])); quad(s * ((xb + xt) / 2 + 0.012), T.h * 0.5, 0.15, Math.min(0.5, T.h * 0.62), s); }
   } else if (!onTurret) {
      if (S.nation === 'us') quad(0, roofYAt(H.profile, H.zMax * 0.5) + 0.012, H.zMax * 0.5, 0.85, 0);
      else for (const s of [-1, 1]) { const y0 = H.sponsonY ?? H.floorY, y = (y0 + H.roofY) / 2 + 0.1, hw = H.w / 2 - Math.max(0, y - y0) * Math.tan(H.slope); quad(s * (hw + 0.012), y, H.zMax * 0.35, Math.min(0.5, (H.roofY - y) * 1.4), s); }
   }
   const g = new THREE.BufferGeometry();
   g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
   g.computeVertexNormals(); return g;
}

const GEO_CACHE = new Map();
function geometryFor(cfg, key) {
   if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);
   const S = shapeOf(cfg);
   const g = { S, hull: buildHull(S), turret: S.turret ? buildTurret(S) : null, gun: buildGun(S), track: buildTrack(S), decT: buildDecals(S, true), decH: buildDecals(S, false) };
   GEO_CACHE.set(key, g); return g;
}

// ---------------- campaign emplacements (cfg.site): bunker, PaK 40, Torpedoboot ----------------
// Same frame and armour data as the tanks (cfg.hull profile / mantlet / gun pivot / turret), so the
// visible concrete, shield and hull sit where the shells test; earth, trails and superstructure are
// decoration around that volume. No tracks; vertex colours on one shared material.
const CONC = [0.56, 0.55, 0.51], CONC_D = [0.44, 0.43, 0.4], EARTH = [0.19, 0.16, 0.11], GRASS = [0.22, 0.3, 0.12], GRASS2 = [0.3, 0.36, 0.15];
const FELD = [0.4, 0.42, 0.36], PAKG = [0.5, 0.48, 0.38], RUBBER = [0.1, 0.1, 0.1];
const KM = [0.6, 0.62, 0.63], KM_D = [0.46, 0.48, 0.5], KM_DECK = [0.36, 0.36, 0.35], KM_BOOT = [0.12, 0.12, 0.13], KM_RED = [0.45, 0.16, 0.12], GLASS = [0.1, 0.13, 0.15];
// convex 2D polygon (u,v) extruded between a0 and a1; map(u, v, a) -> [x, y, z]
function extrude(A, poly, a0, a1, map, col) {
   const P0 = poly.map(([u, v]) => map(u, v, a0)), P1 = poly.map(([u, v]) => map(u, v, a1)), n = poly.length;
   const ctr = [0, 0, 0]; for (const p of P0.concat(P1)) { ctr[0] += p[0] / (2 * n); ctr[1] += p[1] / (2 * n); ctr[2] += p[2] / (2 * n); }
   for (let i = 0; i < n; i++) { const j = (i + 1) % n; A.quad(P0[i], P0[j], P1[j], P1[i], col, ctr); }
   for (let i = 1; i < n - 1; i++) { A.tri(P0[0], P0[i], P0[i + 1], col, ctr); A.tri(P1[0], P1[i], P1[i + 1], col, ctr); }
}
const alongX = (z, y, x) => [x, y, z], alongZ = (x, y, z) => [x, y, z];
function tufts(A, n, seed, area, yAt) {   // grass tufts: small cones, deterministic
   for (let i = 0; i < n; i++) {
      const x = area.x0 + (area.x1 - area.x0) * hash(seed, i), z = area.z0 + (area.z1 - area.z0) * hash(seed + 7, i), y = yAt(x, z);
      if (y == null || !Number.isFinite(y)) continue;
      const h = 0.18 + hash(seed + 3, i) * 0.3;
      A.cyl(x, y + h / 2 - 0.03, z, 0.13 + hash(seed + 5, i) * 0.12, 0.01, h, hash(seed + 9, i) > 0.5 ? GRASS : GRASS2, 'y', 5);
   }
}
function spokedWheel(A, x, y, z, r, w) {
   const tyre = new THREE.TorusGeometry(r - 0.06, 0.07, 6, 18), rim = new THREE.TorusGeometry(r - 0.13, 0.025, 4, 18);
   A.geo(tyre, mat(x, y, z, 0, Math.PI / 2, 0, 1, 1, w / 0.14), RUBBER);
   A.geo(rim, mat(x, y, z, 0, Math.PI / 2, 0), STEEL);
   A.cyl(x, y, z, 0.09, 0.09, w + 0.06, STEEL, 'x', 10);
   for (let k = 0; k < 8; k++) A.box(x, y, z, 0.035, (r - 0.15) * 2, 0.05, STEEL, k * Math.PI / 8);
}

function buildBunker(S) {
   const A = new Acc(), H = S.hull, P = H.profile, hw = H.w / 2, zF = H.zMin, zB = H.zMax, top = H.roofY;
   hullPiece(A, P, hw, 0, 0, CONC);                                                   // the concrete block = the armour volume
   // steel embrasure band (plate 'emb' of the profile), with the slit and the gun ball in it
   const bandY0 = 0.9, bandY1 = 1.45, by = (bandY0 + bandY1) / 2, bz = zF - 0.025;
   A.box(0, by, bz, H.w + 0.02, bandY1 - bandY0, 0.05, STEEL);
   for (let k = 0; k < 12; k++) for (const yy of [bandY0 + 0.06, bandY1 - 0.06]) A.cyl(-hw + 0.2 + k * (H.w - 0.4) / 11, yy, bz - 0.03, 0.025, 0.025, 0.03, DARK, 'z', 5);
   A.box(0, by, bz - 0.02, 1.4, 0.32, 0.03, BLACK);                                  // the slit
   for (const s of [-1, 1]) A.box(s * 0.75, by, bz - 0.05, 0.08, 0.4, 0.08, DARK);
   A.box(0, top + 0.02, zF + 0.6, H.w * 0.98, 0.04, 0.6, CONC_D);                    // weathered lip over the chamfer
   // earth cover: roof cap, side berms, a low slope in front of the lower plate; the rear stays open (door)
   hullPiece(A, [[zF + 0.45, top - 0.02], [zB - 0.15, top - 0.02], [zB - 0.55, top + 0.42], [zF + 0.9, top + 0.42]], hw + 0.25, top, 50 * DEG, EARTH);
   for (const s of [-1, 1]) extrude(A, [[hw - 0.02, 0], [hw + 2.1, 0], [hw + 0.25, top + 0.05], [hw - 0.02, top + 0.05]].map(([x, y]) => [s * x, y]), zF + 0.15, zB - 0.25, alongZ, EARTH);
   extrude(A, [[zF + 0.01, 0], [zF - 1.3, 0], [zF + 0.01, 0.62]], -hw - 0.6, hw + 0.6, alongX, EARTH);
   tufts(A, 52, 11, { x0: -hw - 1.6, x1: hw + 1.6, z0: zF - 1, z1: zB - 0.4 }, (x, z) => {
      const ax = Math.abs(x);
      if (ax < hw + 0.1 && z > zF + 0.95 && z < zB - 0.6) return top + 0.42;
      if (ax > hw + 0.3 && ax < hw + 1.9 && z > zF + 0.3 && z < zB - 0.4) return (top + 0.05) * (1 - (ax - hw - 0.25) / 1.85);
      if (z < zF - 0.1 && z > zF - 1.2 && ax < hw) return 0.62 * (1 - (zF - z) / 1.3);
      return null;
   });
   // rear: steel door (plate 'urp' is the whole rear face), vent, observation cupola, periscope
   A.box(0.9, 0.95, zB + 0.03, 0.95, 1.85, 0.06, STEEL);
   A.box(0.9 + 0.32, 1.0, zB + 0.07, 0.06, 0.06, 0.12, DARK);
   A.box(-1.3, 1.7, zB + 0.03, 0.5, 0.3, 0.05, BLACK);
   A.cyl(-1.2, top + 0.52, 0.6, 0.48, 0.55, 0.25, STEEL, 'y', 12);
   A.cyl(-1.2, top + 0.7, 0.6, 0.38, 0.46, 0.14, DARK, 'y', 12);
   A.cyl(1.3, top + 0.62, 1.2, 0.05, 0.05, 0.5, DARK, 'y', 6);
   return A.build();
}
function buildPakBase(S) {   // static carriage: wheels, axle, split trails with spades, lower shield flap
   const A = new Acc(), T = S.track, r = S.cfg.run?.wheelR ?? 0.4, wx = T.x, az = S.cfg.run?.z ?? 0;
   for (const s of [-1, 1]) spokedWheel(A, s * wx, r, az, r, T.w);
   A.cyl(0, r, az, 0.06, 0.06, wx * 2, DARK, 'x', 8);
   for (const s of [-1, 1]) {
      const x0 = s * 0.22, x1 = s * 0.95, z0 = az + 0.15, z1 = az + 2.7, y0 = r + 0.02, y1 = 0.12, L = Math.hypot(x1 - x0, z1 - z0, y1 - y0);
      const ry = Math.atan2(x1 - x0, z1 - z0), rx = Math.atan2(y0 - y1, Math.hypot(x1 - x0, z1 - z0));
      A.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 0.12, 0.16, L, PAKG, rx, ry, 0);
      A.box(x1, 0.14, z1, 0.4, 0.3, 0.06, DARK, -0.5, ry, 0);                   // spade
      A.cyl(x1 + s * 0.05, 0.28, z1 - 0.25, 0.03, 0.03, 0.3, DARK, 'x', 6);
   }
   A.box(0, 0.22, az - 0.2, 1.5, 0.24, 0.03, PAKG);                                // lower shield flap
   return A.build();
}
function buildPakUpper(S) {   // traversing part about the gun pivot: double shield, cradle, recuperator, breech, crew
   const A = new Acc(), H = S.hull, P = H.profile, M = S.mantlet, gp = S.gun.pivot, hw = H.w / 2;
   const o = (x, y, z) => [x - gp.x, y - gp.y, z - gp.z];                            // hull frame -> pivot frame
   // main shield = the sloped front plate of the armour profile, with the gun gap at the top
   const f0 = P[0], f1 = P[1], tz = 0.02;
   const plate = (xa, xb, ya, yb) => {
      const za = f0[0] + (f1[0] - f0[0]) * (ya - f0[1]) / (f1[1] - f0[1]), zb = f0[0] + (f1[0] - f0[0]) * (yb - f0[1]) / (f1[1] - f0[1]);
      extrude(A, [[za, ya], [zb, yb], [zb + tz, yb], [za + tz, ya]], xa, xb, (z, y, x) => o(x, y, z), PAKG);
   };
   plate(-hw, -0.2, f0[1], f1[1]); plate(0.2, hw, f0[1], f1[1]); plate(-0.2, 0.2, f0[1], gp.y - 0.12);
   // second (spaced) plate = the mantlet box, its top edge stepped like the real shield
   if (M) {
      A.box(...o(-M.w / 4 - 0.12, M.y, M.z), M.w / 2 - 0.24, M.h, M.d, PAKG);
      A.box(...o(M.w / 4 + 0.12, M.y, M.z), M.w / 2 - 0.24, M.h, M.d, PAKG);
      A.box(...o(0, M.y - M.h / 2 + 0.17, M.z), 0.24, 0.34, M.d, PAKG);
      for (const s of [-1, 1]) A.box(...o(s * (M.w / 2 - 0.1), M.y + M.h / 2 + 0.04, M.z), 0.2, 0.08, M.d, PAKG);
      A.box(...o(0.6, M.y + 0.15, M.z - 0.03), 0.1, 0.1, 0.02, BLACK);              // sight port
   }
   A.box(0, -0.14, 0.35, 0.24, 0.2, 1.7, PAKG);                                          // cradle
   A.cyl(0, -0.08, -0.35, 0.07, 0.07, 1.4, DARK, 'z', 8);                              // recuperator
   A.box(0, 0, 0.55, 0.3, 0.3, 0.45, DARK);                                            // breech block
   A.box(0.24, -0.02, 0.15, 0.08, 0.16, 0.22, DARK);                                   // sight
   A.box(0, -0.33, 0.2, 0.36, 0.25, 0.5, PAKG);                                        // upper carriage
   // crew: gunner and loader crouched behind the shield
   for (const [x, z, h] of [[-0.45, 0.25, 0.85], [0.55, 0.5, 1.0]]) {
      A.box(...o(x, h * 0.45, z), 0.36, h * 0.55, 0.3, FELD);
      A.box(...o(x, h * 0.18, z + 0.15), 0.32, 0.3, 0.45, FELD);
      A.cyl(...o(x, h * 0.85, z), 0.13, 0.13, 0.2, [0.75, 0.6, 0.48], 'y', 8);
      A.cyl(...o(x, h * 0.93, z), 0.19, 0.16, 0.12, FELD, 'y', 10);
   }
   return A.build();
}

// ship hull: plan half-width and sheer along z (−z = bow); the deck rises toward the forecastle
function shipSection(S, z) {
   const H = S.hull, L0 = H.zMin + 2.4, L1 = H.zMax - 2.4, hw0 = H.w / 2;
   const fb = Math.max(0, Math.min(1, (z - L0) / (L1 - L0)));                    // 0 bow … 1 stern
   const bowK = Math.min(1, fb / 0.24), sternK = Math.min(1, (1 - fb) / 0.1);
   const hw = hw0 * Math.sqrt(bowK) * (0.7 + 0.3 * Math.sqrt(sternK));
   const deck = H.roofY + (fb < 0.32 ? 1.1 * (1 - fb / 0.32) ** 1.6 : 0);
   return { hw: Math.max(0.05, hw), deck };
}
function buildShipHull(S) {
   const A = new Acc(), H = S.hull, cfg = S.cfg, wl = cfg.draft ?? 3, N = 44, z0 = H.zMin + 2.4, z1 = H.zMax - 2.4;
   const slope = Math.tan((H.slope || 4 * DEG)), st = [];
   for (let i = 0; i <= N; i++) {
      const z = z0 + (z1 - z0) * i / N, { hw, deck } = shipSection(S, z);
      // section: keel, bilge, waterline, deck edge (sides lean in by the armour side slope)
      st.push({ z, deck, pts: [[0, 0.2], [hw * 0.55, 0.35], [hw * 0.92, wl * 0.6], [hw, wl], [Math.max(0.04, hw - (deck - wl) * slope), deck]] });
   }
   const colAt = (y) => y < wl - 0.3 ? KM_RED : y < wl + 0.3 ? KM_BOOT : KM_D;
   for (let i = 0; i < N; i++) {
      const a = st[i], b = st[i + 1], ctr = [0, (a.deck + 0.2) / 2, (a.z + b.z) / 2];
      for (let k = 0; k < a.pts.length - 1; k++) for (const s of [-1, 1]) {
         const p = (S2, j) => [s * S2.pts[j][0], S2.pts[j][1], S2.z];
         A.quad(p(a, k), p(a, k + 1), p(b, k + 1), p(b, k), colAt((a.pts[k][1] + a.pts[k + 1][1]) / 2), ctr);
      }
      const dk = (S2, s) => [s * S2.pts[4][0], S2.deck, S2.z];
      A.quad(dk(a, -1), dk(a, 1), dk(b, 1), dk(b, -1), KM_DECK, [0, -10, (a.z + b.z) / 2]);
   }
   // raked stem (bow) and transom stern
   const bow = st[0], sb = st[N], rake = 2.0, stem = (y) => [0, y, bow.z - rake * (y / bow.deck) ** 2];
   for (const s of [-1, 1]) for (let k = 0; k < 4; k++) {
      const a = bow.pts[k], b = bow.pts[k + 1];
      A.quad([s * a[0], a[1], bow.z], [s * b[0], b[1], bow.z], stem(b[1]), stem(a[1]), colAt((a[1] + b[1]) / 2), [0, 3, bow.z + 3]);
   }
   for (const s of [-1, 1]) A.tri([s * bow.pts[4][0], bow.deck, bow.z], stem(bow.deck), [0, bow.deck, bow.z], KM_DECK, [0, -10, bow.z]);
   for (let k = 0; k < 4; k++) { const a = sb.pts[k], b = sb.pts[k + 1]; A.quad([-a[0], a[1], sb.z], [a[0], a[1], sb.z], [b[0], b[1], sb.z], [-b[0], b[1], sb.z], colAt((a[1] + b[1]) / 2), [0, 3, sb.z - 3]); }
   // bulwark strake along the deck edge, hawse pipes
   for (const s of [-1, 1]) for (let i = 0; i < N; i++) {
      const a = st[i], b = st[i + 1], x = s * (a.pts[4][0] + b.pts[4][0]) / 2;
      A.box(x, (a.deck + b.deck) / 2 + 0.3, (a.z + b.z) / 2, 0.06, 0.6, Math.hypot(b.z - a.z, b.pts[4][0] - a.pts[4][0]) + 0.03, KM, 0, -s * Math.atan2(b.pts[4][0] - a.pts[4][0], b.z - a.z), 0);
   }
   for (const s of [-1, 1]) A.box(s * (shipSection(S, z0 + 5).hw - 0.02), st[0].deck - 0.9, z0 + 5, 0.12, 0.6, 0.5, BLACK);
   return A.build();
}
function buildShipTop(S) {
   const A = new Acc(), H = S.hull, T = S.turret;
   const D = (z) => shipSection(S, z).deck;
   // bridge superstructure behind the forward turret
   const zb = T ? T.z + 5.5 : -20;
   A.box(0, D(zb + 3) + 1.4, zb + 3, 6.6, 2.8, 7, KM);
   A.box(0, D(zb + 3) + 3.6, zb + 2.2, 5.4, 1.8, 4.6, KM);
   A.box(0, D(zb + 3) + 4.0, zb - 0.12, 5.0, 0.55, 0.1, GLASS);
   for (const s of [-1, 1]) A.box(s * 2.72, D(zb + 3) + 4.0, zb + 2.2, 0.1, 0.55, 4.2, GLASS);
   A.box(0, D(zb + 3) + 4.75, zb + 2.0, 7.2, 0.15, 5.2, KM_D);                          // bridge roof with wings
   A.cyl(0, D(zb + 3) + 5.3, zb + 2.6, 0.9, 0.9, 0.9, KM_D, 'y', 12);                   // rangefinder
   A.box(0, D(zb + 3) + 5.5, zb + 2.6, 4.2, 0.35, 0.4, KM_D);
   // tripod mast with yard and radar
   const zm = zb + 7.5, dm = D(zm);
   A.cyl(0, dm + 9, zm, 0.2, 0.3, 18, KM_D, 'y', 8);
   for (const s of [-1, 1]) A.geo(new THREE.CylinderGeometry(0.13, 0.17, 10, 6), mat(s * 1.3, dm + 4.8, zm + 1.0, 0.1, 0, s * 0.14), KM_D);
   A.box(0, dm + 13.5, zm, 7, 0.14, 0.14, KM_D);
   A.box(0, dm + 10.5, zm - 0.35, 2.2, 1.1, 0.2, KM_D);
   // two raked funnels with black caps
   for (const [z, h] of [[zb + 13, 5.4], [zb + 23.5, 4.8]]) {
      A.box(0, D(z) + 0.5, z, 3.6, 1.0, 5, KM);
      A.geo(new THREE.CylinderGeometry(1.2, 1.35, h, 14), mat(0, D(z) + 1 + h / 2, z + 0.35, 0.12, 0, 0, 1, 1, 1.5), KM);
      A.geo(new THREE.CylinderGeometry(1.24, 1.24, 0.5, 14), mat(0, D(z) + 0.9 + h, z + 0.35 + h * 0.06, 0.12, 0, 0, 1, 1, 1.5), BLACK);
   }
   // torpedo tube triples, searchlight platform, boats, 3,7 / 2 cm AA, depth charges
   for (const z of [zb + 18.3, zb + 29]) {
      A.cyl(0, D(z) + 0.4, z, 1.0, 1.1, 0.4, KM_D, 'y', 10);
      for (let k = -1; k <= 1; k++) A.cyl(k * 0.62, D(z) + 0.9, z, 0.28, 0.28, 7, KM, 'z', 8);
   }
   A.box(0, D(zb + 34) + 1.2, zb + 34, 3.5, 2.4, 4, KM);
   A.cyl(0, D(zb + 34) + 2.85, zb + 34, 0.8, 0.8, 0.9, KM_D, 'y', 10);
   for (const s of [-1, 1]) {
      A.box(s * 3.2, D(zb + 9) + 1.55, zb + 9, 1.3, 0.8, 6, [0.72, 0.72, 0.68]);
      for (const z of [zb + 11, zb + 27, zb + 37]) {
         A.cyl(s * 3.0, D(z) + 0.45, z, 0.45, 0.45, 0.9, KM_D, 'y', 8);
         A.box(s * 3.0, D(z) + 1.1, z, 0.9, 0.6, 0.05, KM);
         A.cyl(s * 3.0, D(z) + 1.25, z - 0.8, 0.045, 0.045, 1.6, BLACK, 'z', 5);
      }
   }
   const zs = H.zMax - 4.5;
   for (const s of [-1, 1]) for (let k = 0; k < 4; k++) A.cyl(s * 2.4, D(zs) + 0.45, zs - k * 0.8, 0.32, 0.32, 0.55, BLACK, 'x', 8);
   // aft 10,5 cm mounts (decoration, trained aft) + flag staff and jack staff
   for (const z of [zb + 41, zb + 50]) {
      A.cyl(0, D(z) + 0.2, z, 1.6, 1.7, 0.4, KM_D, 'y', 12);
      A.box(0, D(z) + 1.4, z, 3.0, 2.0, 3.6, KM);
      A.box(0, D(z) + 1.8, z + 2.0, 2.4, 1.2, 0.8, KM);
      A.cyl(0, D(z) + 1.4, z + 4.2, 0.1, 0.08, 4.4, KM_D, 'z', 8);
   }
   A.cyl(0, D(H.zMax - 2.6) + 2.5, H.zMax - 2.6, 0.05, 0.05, 5, KM_D, 'y', 5);
   A.cyl(0, D(H.zMin + 3) + 1.8, H.zMin + 3, 0.04, 0.04, 3.6, KM_D, 'y', 5);
   return A.build();
}
// the war ensign on the stern staff (our own simple design: cross and canton, no emblems)
function ensignTexture() {
   const cv = document.createElement('canvas'); cv.width = 128; cv.height = 80; const g = cv.getContext('2d');
   g.fillStyle = '#ece8de'; g.fillRect(0, 0, 128, 80); g.fillStyle = '#111'; g.fillRect(0, 34, 128, 12); g.fillRect(38, 0, 12, 80);
   g.fillStyle = '#9c2a22'; g.fillRect(0, 0, 34, 30);
   const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
let SITE_SHARED = null;
function siteShared() {
   return (SITE_SHARED ??= {
      mat: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.9, metalness: 0.06, flatShading: true }),
      ship: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0.22, flatShading: true }),
      wreck: new THREE.MeshStandardMaterial({ color: 0x3a3532, vertexColors: true, roughness: 1, metalness: 0.05, flatShading: true }),
      flag: new THREE.MeshStandardMaterial({ map: ensignTexture(), side: THREE.DoubleSide, roughness: 0.9 }),
   });
}
function siteGeometry(cfg, key) {
   const ck = 'site:' + cfg.site + ':' + (cfg.id || '') + ':' + key; if (GEO_CACHE.has(ck)) return GEO_CACHE.get(ck);
   const S = shapeOf(cfg), k = cfg.site, g = { S };
   if (k === 'bunker') { g.hull = buildBunker(S); g.gun = buildGun(S, CONC_D, STEEL); }
   else if (k === 'pak') { g.hull = buildPakBase(S); g.upper = buildPakUpper(S); g.gun = buildGun(S, PAKG, PAKG.map((v) => v * 0.8)); }
   else { g.hull = buildShipHull(S); g.top = buildShipTop(S); g.turret = S.turret ? buildTurret(S, KM, KM_D) : null; g.gun = buildGun(S, KM, KM_D); }
   GEO_CACHE.set(ck, g); return g;
}
export function buildSiteModel(cfg, key = cfg?.id || 'site') {
   const sh = siteShared(), g = siteGeometry(cfg, key), S = g.S, m0 = cfg.site === 'ship' ? sh.ship : sh.mat;
   const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
   const hull = new THREE.Mesh(g.hull, m0); body.add(hull);
   const extra = [];
   if (g.top) { const t = new THREE.Mesh(g.top, m0); body.add(t); extra.push(t); }
   const turret = new THREE.Group(); body.add(turret);
   let tmesh = null;
   const gp = S.gun.pivot || { x: 0, y: 1, z: -1 };
   const gunPivot = new THREE.Group(); turret.add(gunPivot);
   if (S.turret) { turret.position.set(S.turret.x, S.turret.y, S.turret.z); tmesh = new THREE.Mesh(g.turret, m0); turret.add(tmesh); gunPivot.position.set(gp.x, gp.y, gp.z); }
   else turret.position.set(gp.x, gp.y, gp.z);
   if (g.upper) { const u = new THREE.Mesh(g.upper, m0); turret.add(u); extra.push(u); }
   const gun = new THREE.Mesh(g.gun, m0); gunPivot.add(gun);
   if (cfg.site === 'ship') {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.5), sh.flag), z = S.hull.zMax - 2.6;
      f.position.set(0, shipSection(S, z).deck + 4.2, z + 1.25); f.rotation.y = Math.PI / 2; body.add(f);
   }
   root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
   return { root, body, hull, turret, tmesh, gunPivot, gun, tracks: [], extra, S, mat0: m0, site: cfg.site, treadL: 0, treadR: 0, recoil: 0, deadT: 0 };
}

// ---------------- model ----------------
export function buildTankModel(cfg, key = cfg?.id || 'x') {
   if (cfg?.site) return buildSiteModel(cfg, key);
   const sh = shared(), g = geometryFor(cfg, key), S = g.S, mat0 = sh.camo[S.nation] || sh.camo.de;
   const root = new THREE.Group();
   const body = new THREE.Group(); root.add(body);              // pitch/roll
   const hull = new THREE.Mesh(g.hull, mat0); body.add(hull);
   const decH = new THREE.Mesh(g.decH, sh.decal); body.add(decH);
   const tracks = [];
   for (const s of [-1, 1]) {
      const tex = sh.tread.clone(); tex.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.25, side: THREE.DoubleSide });
      const tr = new THREE.Mesh(g.track, m); tr.position.x = s * S.track.x; body.add(tr); tracks.push(tr);
   }
   // turret group (casemates: an empty group in the hull so the gun still traverses)
   const turret = new THREE.Group(); body.add(turret);
   let tmesh = null;
   if (S.turret) {
      turret.position.set(S.turret.x, S.turret.y, S.turret.z);
      tmesh = new THREE.Mesh(g.turret, mat0); turret.add(tmesh);
      turret.add(new THREE.Mesh(g.decT, sh.decal));
   }
   const gp = S.gun.pivot || { x: 0, y: 0.3, z: -0.6 };
   const gunPivot = new THREE.Group(); turret.add(gunPivot);
   if (S.turret) gunPivot.position.set(gp.x, gp.y, gp.z);
   else turret.position.set(gp.x, gp.y, gp.z);        // casemate: the gun traverses about its own pivot (armor.gunWorld)
   const gun = new THREE.Mesh(g.gun, mat0); gunPivot.add(gun);
   root.traverse((o) => { if (o.isMesh) { o.castShadow = o.material !== sh.decal; o.receiveShadow = true; } });
   return { root, body, hull, turret, tmesh, gunPivot, gun, tracks, S, mat0, treadL: 0, treadR: 0, recoil: 0 };
}

export class Tanks3D {
   constructor(scene, world) {
      this.scene = scene; this.world = world; this.models = new Map(); this.lastSeq = 0;
      this.group = new THREE.Group(); scene.add(this.group);
      this.marks = new HitMarks(this.group); this.hitQ = [];
   }
   _model(t) {
      let m = this.models.get(t.id);
      if (!m) { m = buildTankModel(t.cfg, t.cls || t.cfg?.id); m.lastYaw = t.yaw; m.lastFire = t.lastFire; this.group.add(m.root); this.models.set(t.id, m); }
      return m;
   }
   sightPos(t, out) {
      const m = this._model(t); m.gunPivot.getWorldPosition(out); out.y += 0.35; return out;
   }
   // scope view: the sight sits inside the own turret, so the whole own model goes (WoT does the same)
   setHidden(t, scoped) { const m = this.models.get(t?.id); if (!m) return; m.scopeHide = scoped; if (scoped) m.root.visible = false; }
   update(dt, camera) {
      const w = this.world, sh = shared();
      let maxSeq = this.lastSeq;   // events is a ring buffer: not in seq order
      for (const ev of w.events?.list ?? w.events ?? []) {   // turret blow-off on ammo rack, hit marks
         if (!ev || (ev.seq ?? 0) <= this.lastSeq) continue; maxSeq = Math.max(maxSeq, ev.seq ?? 0);
         const type = ev.type ?? ev.kind;
         if (type === 'ammoRack') { const m = this.models.get(ev.dstId); if (m && !m.blow) m.blow = { vy: 9 + Math.random() * 4, vx: (Math.random() - 0.5) * 4, vz: (Math.random() - 0.5) * 4, spin: (Math.random() - 0.5) * 6, t: 0 }; }
         else if (isHitEvent(type)) this.hitQ.push(ev);
      }
      this.lastSeq = maxSeq;
      for (const t of w.tanks) {
         const m = this._model(t), r = m.root, b = m.body;
         r.visible = t.visible !== false && (t.spotted !== false || t.team === w.player?.team || !t.alive);
         if (!r.visible) continue;
         r.position.set(t.pos.x, t.pos.y, t.pos.z); r.rotation.y = t.yaw;
         b.rotation.set(t.pitch || 0, 0, t.roll || 0, 'YXZ');
         if (!m.blow) { m.turret.rotation.y = t.turretYaw || 0; m.gunPivot.rotation.x = t.gunPitch || 0; }
         // treads: left/right belt speed from forward speed and yaw rate
         let dy = t.yaw - m.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); m.lastYaw = t.yaw;
         const yr = dt > 0 ? dy / dt : 0, hw = m.S.W / 2 - m.S.track.w / 2, v = t.speed || 0;
         if (t.alive !== false) {
            m.treadL += (v + yr * hw) * dt; m.treadR += (v - yr * hw) * dt;
            if (m.tracks.length) { m.tracks[0].material.map.offset.x = m.treadL / 0.6; m.tracks[1].material.map.offset.x = m.treadR / 0.6; }
         }
         // recoil
         if (t.lastFire !== m.lastFire) { m.lastFire = t.lastFire; if (t.lastFire != null) m.recoil = 1; }
         if (m.recoil > 0) { m.recoil = Math.max(0, m.recoil - dt * 2.2); const k = m.recoil > 0.85 ? (1 - m.recoil) / 0.15 : m.recoil / 0.85; m.gun.position.z = k * Math.min(0.6, m.S.gun.cal / 160); }
         // wreck
         const dead = t.alive === false;
         if (dead !== !!m.dead) {
            m.dead = dead; const mm = dead ? sh.wreck : m.mat0;
            m.hull.material = m.gun.material = mm; if (m.tmesh) m.tmesh.material = mm;
            if (m.extra) for (const e of m.extra) e.material = mm;
            for (const tr of m.tracks) tr.material.color.setScalar(dead ? 0.35 : 1);
         }
         if (m.site) this._siteWreck(m, t, dt);
         if (m.blow && m.blow.t < 6) {
            const B = m.blow; B.t += dt; B.vy -= 9.81 * dt;
            const tp = m.turret.position;
            if (m.S.turret && tp.y + B.vy * dt > m.S.turret.y - 0.3 || B.vy > 0) { tp.x += B.vx * dt; tp.y += B.vy * dt; tp.z += B.vz * dt; m.turret.rotation.x += B.spin * dt; m.turret.rotation.z += B.spin * 0.6 * dt; }
            else { B.vx = B.vz = B.spin = 0; B.vy = 0; }
         }
      }
      // hit marks: placed on the model as posed this frame, then all drawn as two instanced batches
      for (const ev of this.hitQ) { const t = w.tankById?.(ev.dstId) ?? w.tanks.find((q) => q.id === ev.dstId); if (!t) continue;
         const m = this._model(t);
         if (!m.root.visible) { m.root.position.set(t.pos.x, t.pos.y, t.pos.z); m.root.rotation.y = t.yaw; m.body.rotation.set(t.pitch || 0, 0, t.roll || 0, 'YXZ'); if (!m.blow) m.turret.rotation.y = t.turretYaw || 0; }
         this.marks.add(m, ev);
      }
      this.hitQ.length = 0;
      this.marks.update(this.models.values());
   }
   // emplacement wrecks: the bunker just goes black; the PaK tips over; the boat lists and sinks
   _siteWreck(m, t, dt) {
      if (t.alive !== false) { m.deadT = 0; m.root.position.y = t.pos.y; return; }
      m.deadT = Math.min(60, m.deadT + dt); const k = Math.min(1, m.deadT / 2.5);
      if (m.site === 'pak') { m.body.rotation.z = 0.55 * k; m.body.position.y = -0.15 * k; m.turret.rotation.x = -0.12 * k; }
      else if (m.site === 'ship') {
         const s = Math.min(1, m.deadT / 40), e = s * s * (3 - 2 * s);
         m.root.position.y = t.pos.y - 5.5 * e; m.body.rotation.z = (t.roll || 0) + 0.35 * e; m.body.rotation.x = (t.pitch || 0) - 0.04 * e;
      }
   }
   dispose() { this.marks.dispose(); this.scene.remove(this.group); for (const m of this.models.values()) for (const tr of m.tracks) { tr.material.map.dispose(); tr.material.dispose(); } }
}
