// game/tanks3d.js — procedural tank models from the SAME armour geometry the sim uses (config.js):
// hull = side profile extruded across the hull width (sides lean in by the side slope), turret =
// top-view polygon whose faces lean in by their slope, + mantlet, barrel, running gear, tracks with
// scrolling treads, fenders, hatches, cupola, exhausts, tools, nation camouflage and insignia.
// Draw calls per tank: hull, turret, gun, 2 tracks, decals (shared materials per nation).
import * as THREE from '../vendor/three/three.module.min.js';

const DEG = Math.PI / 180;
const hash = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

// ---------------- textures / materials (shared) ----------------
const CAMO = {
   de: { base: '#b39a5c', spots: ['#5c6236', '#6e4a2c'], style: 'streak' },
   su: { base: '#4a5034', spots: ['#41472e', '#555b3c'], style: 'plain' },
   us: { base: '#585a39', spots: ['#4e5133', '#62643f'], style: 'plain' },
   uk: { base: '#6b6847', spots: ['#4d4a34', '#7a7452'], style: 'blotch' },
};
function camoTexture(n) {
   const c = CAMO[n] || CAMO.de, cv = document.createElement('canvas'); cv.width = cv.height = 256;
   const g = cv.getContext('2d'); g.fillStyle = c.base; g.fillRect(0, 0, 256, 256);
   for (let i = 0; i < (c.style === 'plain' ? 26 : 34); i++) {
      g.fillStyle = c.spots[i % 2]; g.globalAlpha = c.style === 'plain' ? 0.35 : 0.95;
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
function buildTurret(S) {
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
function buildGun(S) {
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

// ---------------- model ----------------
export function buildTankModel(cfg, key = cfg?.id || 'x') {
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
   const gunPivot = new THREE.Group(); gunPivot.position.set(gp.x, gp.y, gp.z); turret.add(gunPivot);
   const gun = new THREE.Mesh(g.gun, mat0); gunPivot.add(gun);
   root.traverse((o) => { if (o.isMesh) { o.castShadow = o.material !== sh.decal; o.receiveShadow = true; } });
   return { root, body, hull, turret, tmesh, gunPivot, gun, tracks, S, mat0, treadL: 0, treadR: 0, recoil: 0 };
}

export class Tanks3D {
   constructor(scene, world) {
      this.scene = scene; this.world = world; this.models = new Map(); this.lastSeq = 0;
      this.group = new THREE.Group(); scene.add(this.group);
   }
   _model(t) {
      let m = this.models.get(t.id);
      if (!m) { m = buildTankModel(t.cfg, t.cls || t.cfg?.id); m.lastYaw = t.yaw; m.lastFire = t.lastFire; this.group.add(m.root); this.models.set(t.id, m); }
      return m;
   }
   sightPos(t, out) {
      const m = this._model(t); m.gunPivot.getWorldPosition(out); out.y += 0.35; return out;
   }
   setHidden(t, scoped) { const m = this.models.get(t?.id); if (m) { m.gun.visible = !scoped; if (m.tmesh) m.tmesh.visible = !scoped; } }
   update(dt, camera) {
      const w = this.world, sh = shared();
      for (const ev of w.events?.list ?? w.events ?? []) {   // turret blow-off on ammo rack
         if (!ev || (ev.seq ?? 0) <= this.lastSeq) continue; this.lastSeq = ev.seq ?? this.lastSeq;
         if ((ev.type ?? ev.kind) === 'ammoRack') { const m = this.models.get(ev.dstId); if (m && !m.blow) m.blow = { vy: 9 + Math.random() * 4, vx: (Math.random() - 0.5) * 4, vz: (Math.random() - 0.5) * 4, spin: (Math.random() - 0.5) * 6, t: 0 }; }
      }
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
            m.tracks[0].material.map.offset.x = m.treadL / 0.6; m.tracks[1].material.map.offset.x = m.treadR / 0.6;
         }
         // recoil
         if (t.lastFire !== m.lastFire) { m.lastFire = t.lastFire; if (t.lastFire != null) m.recoil = 1; }
         if (m.recoil > 0) { m.recoil = Math.max(0, m.recoil - dt * 2.2); const k = m.recoil > 0.85 ? (1 - m.recoil) / 0.15 : m.recoil / 0.85; m.gun.position.z = k * Math.min(0.6, m.S.gun.cal / 160); }
         // wreck
         const dead = t.alive === false;
         if (dead !== !!m.dead) {
            m.dead = dead; const mm = dead ? sh.wreck : m.mat0;
            m.hull.material = m.gun.material = mm; if (m.tmesh) m.tmesh.material = mm;
            for (const tr of m.tracks) tr.material.color.setScalar(dead ? 0.35 : 1);
         }
         if (m.blow && m.blow.t < 6) {
            const B = m.blow; B.t += dt; B.vy -= 9.81 * dt;
            const tp = m.turret.position;
            if (m.S.turret && tp.y + B.vy * dt > m.S.turret.y - 0.3 || B.vy > 0) { tp.x += B.vx * dt; tp.y += B.vy * dt; tp.z += B.vz * dt; m.turret.rotation.x += B.spin * dt; m.turret.rotation.z += B.spin * 0.6 * dt; }
            else { B.vx = B.vz = B.spin = 0; B.vy = 0; }
         }
      }
   }
   dispose() { this.scene.remove(this.group); for (const m of this.models.values()) for (const tr of m.tracks) { tr.material.map.dispose(); tr.material.dispose(); } }
}
