// game/tanks3d.js — procedural tank models from the SAME armour geometry the sim uses (config.js):
// hull = side profile extruded across the hull width (sides lean in by the side slope), turret =
// top-view polygon whose faces lean in by their slope, + mantlet, barrel, running gear, tracks with
// scrolling treads, fenders, hatches, cupola, exhausts, tools, nation camouflage and insignia.
// Draw calls per tank: hull, turret, gun, 2 tracks, decals (shared materials per nation); shell hit
// marks for all tanks together: 2 (hitmarks.js).
import * as THREE from '../vendor/three/three.module.min.js';
import { HitMarks, isHitEvent } from './hitmarks.js';
import { armorFor } from './armor.js';

const DEG = Math.PI / 180;
const hash = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

// ---------------- textures / materials (shared) ----------------
const CAMO = {
   de: { base: '#a8935e', spots: ['#737149', '#7d6044'], style: 'streak' },
   su: { base: '#4a5034', spots: ['#41472e', '#555b3c'], style: 'plain' },
   us: { base: '#585a39', spots: ['#4e5133', '#62643f'], style: 'plain' },
   uk: { base: '#6b6847', spots: ['#4d4a34', '#7a7452'], style: 'blotch' },
   // early-war German Panzergrau (RAL 7021, until 1943; cfg.paint 'grau'), Soviet 1930s 4BO green (cfg.paint 'su30')
   grau: { base: '#4e5253', spots: ['#45494a', '#585c5c'], style: 'plain' },
   su30: { base: '#56603a', spots: ['#4c5533', '#5f6a41'], style: 'plain' },
   // Bundeswehr NATO three-tone (cfg.paint 'nato'): bronze green base, leather brown and tar black blotches
   nato: { base: '#3f4630', spots: ['#5a4632', '#1f1f1b'], style: 'nato' },
   // British deep bronze green, plain (interwar Vickers mediums and the post-war Centurion family; cfg.paint 'ukbg')
   ukbg: { base: '#3d4530', spots: ['#353c2a', '#465037'], style: 'plain' },
   // Caunter scheme, Western Desert 1940-41 (cfg.paint 'caunter'): light stone base, angled bands of silver grey and slate
   caunter: { base: '#c8b88e', spots: ['#8f9590', '#4f5a58'], style: 'caunter' },
};
function camoTexture(n) {
   const c = CAMO[n] || CAMO.de, cv = document.createElement('canvas'); cv.width = cv.height = 256;
   const g = cv.getContext('2d'); g.fillStyle = c.base; g.fillRect(0, 0, 256, 256);
   const nato = c.style === 'nato';
   if (c.style === 'caunter') for (let k = 0; k < 4; k++) {   // parallel bands at ~30°, tiling seamlessly
      g.fillStyle = c.spots[k % 2]; const x0 = k * 64 + 10, w = k % 2 ? 22 : 16;
      for (const dx of [-256, 0, 256]) { g.beginPath(); g.moveTo(x0 + dx, 0); g.lineTo(x0 + dx + w, 0); g.lineTo(x0 + dx + w + 128, 256); g.lineTo(x0 + dx + 128, 256); g.fill(); }
   }
   for (let i = 0; i < (c.style === 'caunter' ? 0 : c.style === 'plain' ? 26 : nato ? 16 : 34); i++) {
      g.fillStyle = c.spots[i % 2]; g.globalAlpha = c.style === 'plain' ? 0.35 : c.style === 'streak' ? 0.62 : nato ? 1 : 0.8;
      const x = hash(i, 1) * 256, y = hash(i, 2) * 256, r = nato ? 22 + hash(i, 3) * 30 : 10 + hash(i, 3) * 26;
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
   // one track link per tile (u along the belt). Canvas rows 0-31 = the belt's side face (row 0 = outer
   // edge with the grouser teeth, v 1..0.5), rows 32-63 = running surface across the width (v 0.5..0).
   const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64; const g = cv.getContext('2d');
   const R = (c, x, y, w, h) => { g.fillStyle = c; g.fillRect(x, y, w, h); };
   R('#46423b', 0, 0, 64, 32);                       // side: link body
   R('#141312', 0, 0, 64, 9); R('#57524a', 6, 0, 40, 9); R('#6c665b', 6, 0, 40, 2);   // grouser teeth on the outer edge
   R('#2a2825', 0, 9, 64, 2);
   R('#121110', 0, 0, 5, 32);                        // joint gap between links
   g.fillStyle = '#625d53'; g.beginPath(); g.arc(34, 20, 5, 0, 7); g.fill(); g.fillStyle = '#26241f'; g.beginPath(); g.arc(34, 20, 2, 0, 7); g.fill();
   R('#38352f', 0, 32, 64, 32);                      // running surface
   R('#121110', 0, 32, 5, 32);
   R('#5d584e', 9, 32, 22, 32); R('#77715f', 9, 32, 22, 3); R('#2c2a26', 9, 61, 22, 3);   // grouser bar across the width
   R('#4b473f', 38, 44, 16, 8);                      // guide horn
   const img = g.getImageData(0, 0, 64, 64);         // grit
   for (let i = 0; i < img.data.length; i += 4) { const k = 1 + (hash(i, 7) - 0.5) * 0.18; img.data[i] *= k; img.data[i + 1] *= k; img.data[i + 2] *= k; }
   g.putImageData(img, 0, 0);
   const t = new THREE.CanvasTexture(cv); t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
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
// weathering, shared by all camo materials: mud thrown up on the running gear and lower hull,
// dust on upward faces, rain streaks, winter whitewash and snow. `wy` = height above the ground
// in the model (geometryFor), so the turret and gun stay clean. Map-dependent via setTankWeather.
const WX = { uMud: { value: new THREE.Color(0x4a3e30) }, uWash: { value: 0 }, uSnow: { value: 0 } };
const WEATHER = {
   default: [0x4a3e30, 0, 0], steppe: [0x7a6a50, 0, 0], flusstal: [0x3a3126, 0, 0], waldhuegel: [0x3e3428, 0, 0], winter: [0x5c5a58, 1, 1],
};
export function setTankWeather(mapId) {
   const w = WEATHER[mapId] || WEATHER.default;
   WX.uMud.value.setHex(w[0]); WX.uWash.value = w[1]; WX.uSnow.value = w[2];
}
const WX_NOISE = `
float wxH(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wxN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
   return mix(mix(wxH(i), wxH(i+vec2(1,0)), f.x), mix(wxH(i+vec2(0,1)), wxH(i+vec2(1,1)), f.x), f.y); }`;
function weathered(m) {
   m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, WX);
      sh.vertexShader = sh.vertexShader
         .replace('#include <common>', `#include <common>
attribute float wy; varying float vWy; varying float vUpN; varying vec3 vObjP;`)
         .replace('#include <begin_vertex>', `#include <begin_vertex>
vWy = wy; vUpN = normal.y; vObjP = position;`);
      sh.fragmentShader = sh.fragmentShader
         .replace('#include <common>', `#include <common>
uniform vec3 uMud; uniform float uWash, uSnow; varying float vWy; varying float vUpN; varying vec3 vObjP;${WX_NOISE}`)
         .replace('#include <map_fragment>', `#include <map_fragment>
float wn = wxN(vObjP.xz*3.1 + vObjP.y*1.7)*0.6 + wxN(vObjP.zx*9.0 - vObjP.y*5.0)*0.4;
float wash = uWash * smoothstep(0.3, 0.5, wxN(vObjP.xz*1.6 + vObjP.y*2.3)*0.7 + wn*0.3 + 0.12);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.72, 0.73, 0.71), wash);`)
         .replace('#include <color_fragment>', `#include <color_fragment>
float upF = smoothstep(0.55, 0.95, vUpN);
float streak = wxN(vec2((vObjP.x + vObjP.z)*6.0, vObjP.y*0.7));
diffuseColor.rgb *= 1.0 - 0.16*smoothstep(0.55, 0.9, streak)*(1.0 - upF);
diffuseColor.rgb = mix(diffuseColor.rgb, uMud*1.15, upF*0.3*wn*(1.0 - uSnow));
float mud = 1.0 - smoothstep(0.2, 0.7 + wn*0.6, vWy);
float vLum = dot(vColor, vec3(0.333));
diffuseColor.rgb = mix(diffuseColor.rgb, uMud * mix(0.4, 1.0, smoothstep(0.1, 0.6, vLum)), clamp(mud, 0.0, 0.85));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.88, 0.92), uSnow*upF*smoothstep(0.4, 0.62, wn)*step(0.3, vWy));
// chipped paint: bare steel in small flakes, more on the lower hull and walked-on top faces, never under mud
float chipN = wxN(vObjP.xz*13.0 + vObjP.y*9.0)*0.62 + wxN(vObjP.zy*29.0 - vObjP.x*17.0)*0.38;
float chip = smoothstep(0.85 - 0.02*upF, 0.87 - 0.02*upF, chipN) * (1.0 - clamp(mud*1.4, 0.0, 1.0)) * (1.0 - wash) * (1.0 - uSnow*upF);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.35, 0.33), chip);
float paintN = wxN(vObjP.xy*2.2 + vObjP.z*1.3);`)
         .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = roughnessFactor + (paintN - 0.5)*0.22 + upF*0.12*wn + wash*0.2;
roughnessFactor = mix(roughnessFactor, 0.55, chip);
roughnessFactor = clamp(roughnessFactor + 0.42*clamp(mud, 0.0, 1.0), 0.18, 1.0);`)
         .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor * (1.0 - clamp(mud, 0.0, 1.0)), 0.55, chip);`)
         .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
// cast / rolled steel: faint bump from object-space noise so the flat panels break up the highlights
{ float bf = 0.02 * (1.0 - smoothstep(18.0, 70.0, length(vViewPosition)));
  float bh = wxN(vObjP.xy*6.0 + vObjP.z*4.0)*0.6 + wxN(vObjP.zy*15.0 - vObjP.x*7.0)*0.4;
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx); float det = dot(sx, r1);
  vec3 grad = sign(det) * (dFdx(bh)*r1 + dFdy(bh)*r2);
  if (bf > 0.0) normal = normalize(abs(det)*normal - grad*bf); }`);
   };
   m.customProgramCacheKey = () => 'pz-tank-wx';
   return m;
}
const withWy = (geo, off) => { if (!geo) return geo; const p = geo.attributes.position.array, a = new Float32Array(p.length / 3); for (let i = 0; i < a.length; i++) a[i] = p[i * 3 + 1] + off; geo.setAttribute('wy', new THREE.BufferAttribute(a, 1)); return geo; };
let SHARED = null;
function shared() {
   if (SHARED) return SHARED;
   const camo = {}, tread = treadTexture();
   for (const n in CAMO) camo[n] = weathered(new THREE.MeshStandardMaterial({ map: camoTexture(n), vertexColors: true, roughness: 0.38, metalness: 0.16, flatShading: true }));
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
      cfg, nation: NAT[cfg.nation] || 'de', look: cfg.look || null, paint: CAMO[cfg.paint] ? cfg.paint : null, L: d.len, W: d.width, H: d.height,
      hull: { profile, pike: h.pike || null, w: h.w ?? 2.6, lowerW: h.lowerW, sponsonY: h.sponsonY, floorY: h.floorY ?? 0.45, roofY: h.roofY ?? 1.6, slope: (h.sideSlope ?? 0) * DEG, zMin: h.zMin ?? -3, zMax: h.zMax ?? 3 },
      turret: cfg.turret, mantlet: cfg.mantlet, gun: cfg.gun || { cal: 75, len: 3, pivot: { x: 0, y: 0.3, z: -0.6 }, mount: 'turret' },
      track: { x: run.x ?? d.width / 2 - 0.3, w: run.trackW ?? 0.5, z0: rz - rl / 2, z1: rz + rl / 2, top: run.h ?? 1.0, wheels: run.wheels ?? 6, r: run.wheelR ?? 0.35,
         inter: run.interleave ?? 0, bogies: run.bogies ?? 0, hvss: !!run.hvss, gap1: run.gap1 ?? 0, rollers: run.rollers ?? 0, sprF: run.sprocket !== 'rear', sprR: run.sprocketR ?? 0.3, idlR: run.idlerR ?? 0.28, allround: run.style === 'allround' },
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
// rearmost z of the side profile at height y
function rearZAt(P, y) { let best = -Infinity; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; if ((a[1] - y) * (b[1] - y) <= 0 && a[1] !== b[1]) best = Math.max(best, a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1])); } return Number.isFinite(best) ? best : Math.max(...P.map((p) => p[0])); }
// half-width of the hull's side wall at height y (mirrors hullPiece's slope)
function roofHalfW(H, y) { const y0 = H.sponsonY != null && H.lowerW ? H.sponsonY : H.floorY; return Math.max(0.2, H.w / 2 - Math.max(0, y - y0) * Math.tan(H.slope || 0)); }
// a flat roof stretch of length len near z (tries shifting along the hull); null if there is none
function flatRoof(P, H, z, len) {
   for (const off of [0, -0.4, 0.4, -0.8, 0.8, -1.2, 1.2]) {
      const zc = z + off, a = zc - len / 2, b = zc + len / 2; if (a < H.zMin + 0.15 || b > H.zMax - 0.15) continue;
      const ys = [a, (a + zc) / 2, zc, (zc + b) / 2, b].map((q) => roofYAt(P, q));
      if (Math.max(...ys) - Math.min(...ys) < 0.05) return { y: Math.max(...ys), z: zc };
   }
   return null;
}
function wheelZs(T) {
   const end = Math.max(T.sprR, T.idlR) * 1.05 + T.r * 0.9, a = T.z0 + end, b = T.z1 - end, n = T.wheels, out = [];
   if (T.bogies) { const per = n / T.bogies; for (let k = 0; k < T.bogies; k++) { const c = a + (b - a) * (T.bogies === 1 ? 0.5 : k / (T.bogies - 1)); for (let j = 0; j < per; j++) out.push(c + (j - (per - 1) / 2) * T.r * 2.05); } }
   else for (let i = 0; i < n; i++) out.push(n === 1 ? (a + b) / 2 : i === 0 ? a : a + T.gap1 + (b - a - T.gap1) * i / (n - 1));   // gap1: wider first gap (T-54)
   return out;
}
// belt thickness (link + grouser). Wheel centres sit at r + th so the belt's outer bottom run is at y = 0.
const beltT = (T) => Math.min(0.1, Math.max(0.065, T.w * 0.14));
const rollerY = (T) => T.top - beltT(T) - 0.09;
function sprocketIdler(T) {
   const th = beltT(T);
   return { sz: T.sprF ? T.z0 + T.sprR : T.z1 - T.sprR, sy: T.top - T.sprR - th,
      iz: T.sprF ? T.z1 - T.idlR : T.z0 + T.idlR, iy: T.allround ? T.top - T.idlR - th : Math.max(T.idlR + th + 0.08, T.top - T.idlR - th - 0.12) };
}
// half width of the hull in plan view at z (hull.pike narrows the nose)
function planHalfW(H, z) { const W = H.w / 2; if (!H.pike) return W; const { len, tip } = H.pike; return Math.min(W, tip + (W - tip) * Math.max(0, z - H.zMin) / len); }
function buildHull(S) {
   const A = new Acc(), H = S.hull, T = S.track, P = H.profile;
   if (H.pike) {   // plan-view taper: draw the armour's own (clipped) face loops, so the pike is exactly what shells hit
      for (const part of armorFor(S.cfg).parts) if (part.name === 'hull') for (const f of part.faces) {
         if (f.internal) continue;
         for (let i = 1; i < f.loop.length - 1; i++) A.tri(f.loop[0], f.loop[i], f.loop[i + 1], PAINT, part.center);
      }
      for (const s of [-1, 1]) {   // track guards beside the pike, where the tracks come out from under the hull
         const zb = H.zMin + H.pike.len; A.box(s * T.x, T.top + 0.02, (T.z0 + zb) / 2, T.w + 0.06, 0.03, zb - T.z0 + 0.1, PAINT);
      }
   } else if (H.sponsonY != null && H.lowerW) {
      hullPiece(A, clipY(P, H.sponsonY, false), H.lowerW / 2, H.floorY, 0, PAINT);
      hullPiece(A, clipY(P, H.sponsonY, true), H.w / 2, H.sponsonY, H.slope, PAINT);
   } else hullPiece(A, P, H.w / 2, H.floorY, H.slope, PAINT);
   const front = H.zMin, back = H.zMax, tz = (T.z0 + T.z1) / 2, tl = T.z1 - T.z0;
   const covered = H.w / 2 >= T.x + T.w / 2 - 0.05, leo = S.look === 'leo2';
   for (const s of [-1, 1]) {
      if (leo) break;                    // modern tank: no tools strapped on the hull
      const fy = T.top + 0.04;
      if (!covered && !T.allround) A.box(s * T.x, fy, tz, T.w + 0.1, 0.04, tl + 0.1, PAINT);
      if (!covered && !T.allround) {   // on the track fender
         A.box(s * T.x, fy + 0.06, tz - 0.7, 0.14, 0.05, 1.25, WOOD);
         A.cyl(s * T.x + s * 0.12, fy + 0.06, tz + 0.7, 0.035, 0.035, 1.9, DARK, 'z', 6);
         continue;
      }
      // on the hull roof: only on a flat stretch, and inside the roof edge (sloped side walls make the
      // roof narrower than H.w, so H.w/2 put the tools in the air beside casemates like the Jagdpanther)
      for (const [dz, len, plank] of [[-0.7, 1.25, true], [0.7, 1.9, false]]) {
         const at = flatRoof(P, H, tz + dz, len); if (!at) continue;
         const x = s * (roofHalfW(H, at.y) - (plank ? 0.16 : 0.1));
         if (plank) A.box(x, at.y + 0.025, at.z, 0.14, 0.05, len, WOOD);
         else A.cyl(x, at.y + 0.035, at.z, 0.035, 0.035, len, DARK, 'z', 6);
      }
   }
   if (S.skirts && leo) for (const s of [-1, 1]) {   // Leopard 2: three heavy armoured skirt plates in front, thin rubber-edged ones behind
      const sk = S.skirts, y0 = sk.y0 ?? 0.6, hh = sk.h ?? 0.6, x = s * (T.x + T.w / 2 + 0.06), top = y0 + hh;
      const zF = Math.min(T.z0, H.zMin + 0.55), heavy = 1.95, rest = T.z1 - 0.1 - (zF + heavy);
      for (let k = 0; k < 3; k++) A.box(x + s * 0.03, y0 + hh / 2, zF + heavy * (k + 0.5) / 3, 0.09, hh, heavy / 3 - 0.03, PAINT);
      for (let k = 0; k < 4; k++) A.box(x, y0 + hh / 2 + 0.03, zF + heavy + rest * (k + 0.5) / 4, 0.03, hh - 0.06, rest / 4 - 0.03, PAINT);
      A.box(x, y0 + 0.02, zF + heavy + rest / 2, 0.035, 0.05, rest, BLACK);                  // rubber lower edge
      A.box(x - s * 0.04, top + 0.015, (zF + T.z1) / 2, 0.16, 0.03, T.z1 - zF, PAINT);      // fender edge above the plates
   }
   else if (S.skirts) for (const s of [-1, 1]) { const sk = S.skirts, y0 = sk.y0 ?? 0.6, hh = sk.h ?? 0.6; for (let k = 0; k < 6; k++) A.box(s * (T.x + T.w / 2 + 0.06), y0 + hh / 2, T.z0 + tl * (k + 0.5) / 6, 0.025, hh, tl / 6 - 0.04, PAINT, 0, 0, s * 0.03); }
   const zs = wheelZs(T), r = T.r, { sz, sy, iz, iy } = sprocketIdler(T), wy0 = r + beltT(T);
   const TYRE = [0.13, 0.13, 0.12];
   for (const s of [-1, 1]) {
      const x = s * T.x;
      zs.forEach((z, i) => {
         const off = T.inter === 3 ? ((i % 3) - 1) * T.w * 0.28 : T.inter === 2 ? (i % 2 ? 0.5 : -0.5) * T.w * 0.36 : 0;
         const ww = T.inter ? T.w * 0.3 : T.w * 0.62;
         if (T.hvss) for (const d of [-1, 1]) {   // HVSS: dual road wheels on each axle
            A.cyl(x + d * ww * 0.27, wy0, z, r, r, ww * 0.42, TYRE, 'x', 14);
            A.cyl(x + d * ww * 0.27, wy0, z, r * 0.72, r * 0.72, ww * 0.46, PAINT, 'x', 10);
         } else {
         A.cyl(x + off * s, wy0, z, r, r, ww, TYRE, 'x', 16);                                  // rubber tyre
         A.cyl(x + off * s + s * ww * 0.08, wy0, z, r * 0.8, r * 0.8, ww * 0.9, PAINT, 'x', 14);  // painted disc
         }
         A.cyl(x + off * s + s * ww * 0.5, wy0, z, r * 0.36, r * 0.3, 0.06, STEEL, 'x', 8);      // hub cap
      });
      if (T.bogies && T.hvss) for (let k = 0; k < T.bogies; k++) {   // HVSS bogie: frame between the wheel pairs, horizontal volute spring + shock on top
         const per = zs.length / T.bogies, z0 = zs[k * per], z1 = zs[k * per + per - 1], z = (z0 + z1) / 2;
         A.box(x, wy0, z, T.w * 0.2, r * 0.9, z1 - z0 + r * 0.6, STEEL);
         A.cyl(x, wy0 + r * 0.75, z, 0.07, 0.07, (z1 - z0) * 0.8, STEEL, 'z', 8);
      }
      else if (T.bogies) for (let k = 0; k < T.bogies; k++) { const per = zs.length / T.bogies, z = (zs[k * per] + zs[k * per + per - 1]) / 2; A.box(x - s * T.w * 0.35, wy0 + 0.23, z, 0.2, 0.45, r * 2.2, STEEL); }
      A.cyl(x, sy, sz, T.sprR, T.sprR, T.w * 0.75, STEEL, 'x', 12);
      for (let k = 0; k < 8; k++) A.box(x, sy + Math.cos(k * 0.785) * T.sprR, sz + Math.sin(k * 0.785) * T.sprR, T.w * 0.5, 0.07, 0.07, STEEL, k * 0.785);
      A.cyl(x, iy, iz, T.idlR, T.idlR, T.w * 0.6, DARK, 'x', 12);
      for (let k = 0; k < T.rollers; k++) A.cyl(x, rollerY(T), T.z0 + (k + 1) * tl / (T.rollers + 1), 0.09, 0.09, T.w * 0.4, STEEL, 'x', 8);
   }
   if (leo) {
      // driver's hatch front right with three periscopes, low engine deck with grilles, rear exhaust grilles
      const dz = front + 1.95, dy = roofYAt(P, dz);
      A.box(H.w * 0.17, dy + 0.03, dz + 0.1, 0.6, 0.06, 0.55, PAINT);
      for (let k = 0; k < 3; k++) A.box(H.w * 0.17 + (k - 1) * 0.17, dy + 0.07, dz - 0.22, 0.12, 0.08, 0.06, BLACK);
      for (const s of [-1, 1]) A.box(s * 0.98, roofYAt(P, front + 1.6) + 0.04, front + 1.6, 0.18, 0.08, 0.12, DARK);   // headlight guards
      const gz = back - 1.25;
      for (const s of [-1, 1]) A.box(s * 0.75, roofYAt(P, gz) + 0.02, gz, 0.9, 0.04, 1.9, DARK);
      for (let k = 0; k < 6; k++) A.box(0, roofYAt(P, gz) + 0.045, gz - 0.85 + k * 0.34, 2.4, 0.02, 0.05, BLACK);
      const ey = H.roofY - 0.28;
      for (const s of [-1, 1]) A.box(s * 0.95, ey, rearZAt(P, ey) + 0.025, 0.9, 0.32, 0.05, BLACK);
      for (const s of [-1, 1]) A.box(s * 0.45, ey - 0.45, rearZAt(P, ey - 0.45) + 0.06, 0.3, 0.12, 0.12, DARK);    // tow eyes
      return A.build();
   }
   const hz = front + (back - front) * 0.18, hy = roofYAt(P, hz);
   for (const s of [-1, 1]) A.cyl(s * H.w * 0.2, hy + 0.035, hz, 0.28, 0.28, 0.07, PAINT, 'y', 10);
   A.cyl(-Math.min(H.w * 0.33, planHalfW(H, front + 0.3) - 0.12), roofYAt(P, front + 0.3) + 0.12, front + 0.3, 0.09, 0.11, 0.18, DARK, 'z', 8);
   const ry = roofYAt(P, back - 0.2);
   // exhausts hug the rear plate at their height (a sloped rear put them in the air behind the hull)
   for (const s of [-1, 1]) { const ey = ry - 0.25, ex = Math.min(s * H.w * 0.27 * s, roofHalfW(H, ey) - 0.12) * s; A.cyl(ex, ey, rearZAt(P, ey) + 0.08, 0.09, 0.09, 0.55, BLACK, 'y', 8); }
   A.box(0, roofYAt(P, back - 0.9) + 0.02, back - 0.9, H.w * 0.55, 0.05, 0.9, DARK);
   if (S.nation === 'su' || S.nation === 'us') for (let k = 0; k < 3; k++) { const z = front + 0.55; A.box(0.36 * (k - 1), roofYAt(P, z) - 0.25, z, 0.3, 0.06, 0.2, DARK, -0.9); }
   if (S.look === 't28') for (const s of [-1, 1]) {   // the two small MG turrets flanking the driver on the front hull
      const z = front + 0.8, y0 = Math.min(roofYAt(P, z - 0.34), roofYAt(P, z + 0.34)) - 0.02;
      A.cyl(s * H.w * 0.28, y0 + 0.21, z, 0.34, 0.34, 0.42, PAINT, 'y', 12);
      A.cyl(s * H.w * 0.28, y0 + 0.24, z - 0.55, 0.035, 0.035, 0.5, DARK, 'z', 6);
   }
   if (S.look === 'lee') {   // M3 Lee: the 37 mm turret sits off-centre left on the roof with the MG cupola on top (the 75 mm is in the sponson)
      const z = front + (back - front) * 0.4, y = roofYAt(P, z), x = -0.22;
      A.cyl(x, y + 0.3, z, 0.6, 0.66, 0.6, PAINT, 'y', 14);
      A.cyl(x, y + 0.72, z + 0.12, 0.3, 0.32, 0.26, PAINT, 'y', 10);
      A.box(x, y + 0.3, z - 0.66, 0.3, 0.24, 0.16, PAINT);
      A.cyl(x, y + 0.3, z - 0.74 - 0.95, 0.032, 0.04, 1.9, DARK, 'z', 8);
   }
   if (S.mantlet && S.mantlet.mount === 'hull') mantletGeo(A, S.mantlet, PAINT);
   return A.build();
}
// mantlet shapes (visual, inside/at the armour box): 'box' (default, rolled plate), 'bell' (cast rounded
// front: Panther A, T-34-85, IS), 'saukopf' (conical 'pig's head': Tiger II, Jagdpanther)
function mantletGeo(A, m, PAINT) {
   if (m.type === 'saukopf') {
      const R = Math.min(m.w, m.h) / 2;
      A.box(m.x, m.y, m.z + m.d * 0.3, m.w, m.h, m.d * 0.4, PAINT);                              // collar on the turret face
      A.cyl(m.x, m.y, m.z - m.d * 0.2, R * 0.6, R * 1.02, m.d * 0.6, PAINT, 'z', 14);           // the cone narrowing to the barrel
   } else if (m.type === 'bell') {
      const R = m.h / 2;
      A.box(m.x, m.y, m.z + m.d * 0.25, m.w, m.h, m.d * 0.5, PAINT);
      A.cyl(m.x, m.y, m.z + m.d / 2 - R * 0.55, R, R, m.w * 0.96, PAINT, 'x', 14);              // rounded cast front
   } else A.box(m.x, m.y, m.z, m.w, m.h, m.d, PAINT);
}
function buildTurret(S, PAINT = [1, 1, 1], DARK = [0.42, 0.42, 0.4]) {
   const A = new Acc(), T = S.turret, base = T.base, top = T.top, n = base.length;
   const ctr = [base.reduce((s, p) => s + p[0], 0) / n, T.h / 2, base.reduce((s, p) => s + p[1], 0) / n];
   const B = base.map(([x, z]) => [x, 0, z]), U = top.map(([x, z]) => [x, T.h, z]);
   for (let i = 0; i < n; i++) { const j = (i + 1) % n; A.quad(B[i], B[j], U[j], U[i], PAINT, ctr); }
   for (let i = 1; i < n - 1; i++) { A.tri(U[0], U[i], U[i + 1], PAINT, ctr); A.tri(B[0], B[i], B[i + 1], PAINT, ctr); }
   const zs = top.map((p) => p[1]), zBack = Math.max(...zs), zFront = Math.min(...zs), xMax = Math.max(...top.map((p) => p[0]));
   if (S.look === 'leo2') { leoTurret(A, S, PAINT, DARK); return A.build(); }
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
   if (T.skirt) {   // turret Schürzen (Pz IV H): spaced plates around the sides and rear on brackets
      const zb = Math.max(...base.map((p) => p[1])), hw = Math.max(...base.map((p) => p[0])) + 0.22, zf = zFront + 0.45, hh = T.h * 0.95;
      for (const s of [-1, 1]) {
         A.box(s * hw, hh / 2, (zf + zb + 0.42) / 2, 0.025, hh, zb + 0.42 - zf, PAINT);
         A.box(s * (hw - 0.11), hh * 0.8, zf + 0.15, 0.22, 0.04, 0.04, DARK);
      }
      A.box(0, hh / 2, zb + 0.42, hw * 2, hh, 0.025, PAINT);
   }
   if (S.mantlet && S.mantlet.mount !== 'hull') mantletGeo(A, S.mantlet, PAINT);
   return A.build();
}
function buildGun(S, PAINT = [1, 1, 1], DARK = [0.42, 0.42, 0.4]) {
   const A = new Acc(), G = S.gun, r = Math.max(0.04, G.cal / 1000 * 0.72);
   const m = S.mantlet, start = m ? -(Math.abs(m.z - G.pivot.z) + m.d / 2) : 0;   // barrel leaves the mantlet face
   if (S.look === 'leo2') {
      // Rh 120 L/55: slim smoothbore in a segmented thermal sleeve, bore evacuator, muzzle reference sensor on top
      const len = G.len + start, rb = 0.075;
      A.box(0, 0, start + 0.12, m ? m.w * 0.55 : 0.4, m ? m.h * 0.7 : 0.35, 0.3, PAINT);        // gun shield collar
      const segs = 6, sl = len / segs;
      for (let k = 0; k < segs; k++) {
         const z = start - sl * (k + 0.5), rr = rb * (1.12 - k * 0.025);
         A.cyl(0, 0, z, rr, rr, sl - 0.05, PAINT, 'z', 12);
         A.cyl(0, 0, z - sl / 2 + 0.01, rr + 0.012, rr + 0.012, 0.05, DARK, 'z', 12);          // sleeve clamp
      }
      A.cyl(0, 0, start - len * 0.42, rb * 1.75, rb * 1.75, 0.55, PAINT, 'z', 12);             // bore evacuator
      A.cyl(0, 0, -G.len + 0.08, rb * 0.95, rb * 0.95, 0.16, DARK, 'z', 12);                   // bare muzzle
      A.box(0, rb + 0.05, -G.len + 0.28, 0.07, 0.07, 0.12, DARK);                              // muzzle reference sensor
      A.box(0, rb + 0.02, -G.len + 0.36, 0.02, 0.05, 0.04, DARK);
      return A.build();
   }
   A.cyl(0, 0, start + 0.1, r * 2.3, r * 2.5, 0.45, PAINT, 'z', 12);
   const len = G.len + start;
   A.cyl(0, 0, start - len / 2, r * 1.4, r, len, DARK, 'z', 12);
   A.cyl(0, 0, start - len * 0.35, r * 1.6, r * 1.6, 0.22, DARK, 'z', 10);
   if (G.evac) A.cyl(0, 0, -G.len * G.evac, r * 1.9, r * 1.9, 0.5, PAINT, 'z', 12);   // fume extractor (bore evacuator), G.evac = fraction of the barrel from the breech
   if (G.brake) {
      const bt = G.brakeT || (S.nation === 'de' ? 'de' : S.nation === 'su' ? 'su' : 'us'), z = -G.len;
      if (bt === 'de') {   // German double baffle: bulbous body with two chambers
         A.cyl(0, 0, z + 0.24, r * 1.55, r * 1.55, 0.46, DARK, 'z', 12);
         for (const dz of [0.06, 0.3]) A.cyl(0, 0, z + dz, r * 2.15, r * 2.15, 0.12, DARK, 'z', 12);
      } else if (bt === 'su') {   // Soviet two-chamber brake: flat block with big side windows (D-25T, S-70)
         for (const dz of [0.07, 0.36]) A.box(0, 0, z + dz, r * 4.2, r * 2.3, 0.14, DARK);
         A.box(0, r * 0.95, z + 0.21, r * 4.2, r * 0.4, 0.44, DARK); A.box(0, -r * 0.95, z + 0.21, r * 4.2, r * 0.4, 0.44, DARK);
      } else {   // single baffle (US 76/90 mm, 17-pdr)
         A.cyl(0, 0, z + 0.17, r * 1.6, r * 1.6, 0.34, DARK, 'z', 12);
         A.box(0, 0, z + 0.12, r * 3.4, r * 2.1, 0.16, DARK);
      }
   }
   if (S.look === 'maus') {   // coaxial 7.5 cm KwK 44 L/36.5 beside the 12.8 cm, in the same mantlet
      const cl = 2.75, cr = 0.055, cx = -(m ? m.w * 0.3 : 0.35);
      A.cyl(cx, 0.02, start - cl / 2, cr * 1.3, cr, cl, DARK, 'z', 10);
   }
   return A.build();
}
// Track belt: the inner contact loop (z, y) wraps sprocket, idler, the end road wheels and the return
// rollers; the belt is that loop offset outward by its thickness, closed into a solid band (running
// surface, inner face, two side faces) so it reads as a track from the side, with the bottom run's
// outer face exactly at y = 0. u = arc length / link pitch (integer links per loop, so the scrolling
// texture has no seam). `broken` = 'F' | 'R': the belt is torn at that end, the wrap there is gone
// and the torn run lies flat on the ground beyond the last road wheel (detracked).
function beltLoop(T) {
   const zs = wheelZs(T), th = beltT(T), pts = [], { sz, sy, iz, iy } = sprocketIdler(T);
   const circ = (z, y, rr) => { for (let k = 0; k < 28; k++) { const a = k / 28 * Math.PI * 2; pts.push([z + Math.cos(a) * rr, y + Math.sin(a) * rr]); } };
   circ(sz, sy, T.sprR); circ(iz, iy, T.idlR);
   for (const z of [zs[0], zs[zs.length - 1]]) circ(z, T.r + th, T.r);
   if (T.rollers) { const tl = T.z1 - T.z0; for (const k of [0, T.rollers - 1]) circ(T.z0 + (k + 1) * tl / (T.rollers + 1), rollerY(T), 0.09); }
   return hull2D(pts);   // CCW in (z, y): bottom run runs +z (to the rear), top run -z
}
function beltPitch(loop) {
   let L = 0; for (let i = 0; i < loop.length; i++) { const a = loop[i], b = loop[(i + 1) % loop.length]; L += Math.hypot(b[0] - a[0], b[1] - a[1]); }
   return L / Math.max(8, Math.round(L / 0.17));
}
function brokenPath(T, loop, end) {
   const zs = wheelZs(T), th = beltT(T), front = end === 'F';
   const zc = front ? zs[0] - 0.02 : zs[zs.length - 1] + 0.02, keep = (p) => front ? p[0] >= zc : p[0] <= zc;
   // rotate so the loop starts with a kept point that follows a dropped one, then clip at z = zc
   const n = loop.length; let s0 = 0; for (let i = 0; i < n; i++) if (keep(loop[i]) && !keep(loop[(i + n - 1) % n])) { s0 = i; break; }
   const out = [];
   { const a = loop[(s0 + n - 1) % n], b = loop[s0], t = (zc - a[0]) / (b[0] - a[0]); out.push([zc, a[1] + (b[1] - a[1]) * t, 0]); }
   for (let k = 0; k < n; k++) {
      const a = loop[(s0 + k) % n], b = loop[(s0 + k + 1) % n];
      if (!keep(a)) break;
      out.push([a[0], a[1], 0]);
      if (!keep(b)) { const t = (zc - a[0]) / (b[0] - a[0]); out.push([zc, a[1] + (b[1] - a[1]) * t, 0]); }
   }
   // the low end gets the torn run lying on the ground (drifting a little outward), the high end droops
   const lowFirst = out[0][1] < out[out.length - 1][1], dz = front ? -1 : 1;
   const run = [], len = 1.6 + T.w * 1.2;
   for (const f of [0.3, 0.6, 1]) run.push([zc + dz * len * f, th, 0.12 * f * f]);
   const top = lowFirst ? out[out.length - 1] : out[0], droop = [[top[0] + dz * 0.12, top[1] - 0.22, 0.02], [top[0] + dz * 0.16, top[1] - 0.5, 0.05]];
   return lowFirst ? [...run.reverse(), ...out, ...droop] : [...droop.reverse(), ...out, ...run];
}
function buildTrack(S, broken) {
   const T = S.track, th = beltT(T), loop = beltLoop(T), pitch = beltPitch(loop), hw = T.w / 2;
   const closed = !broken, P = closed ? loop.map((p) => [p[0], p[1], 0]) : brokenPath(T, loop, broken), n = P.length;
   // outward normals (CCW: edge (dz, dy) -> (dy, -dz)), mitred offsets
   const en = []; for (let i = 0; i < (closed ? n : n - 1); i++) { const a = P[i], b = P[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; en.push([(b[1] - a[1]) / l, -(b[0] - a[0]) / l]); }
   const O = [], N = [], U = [];
   let u = 0;
   for (let i = 0; i < n; i++) {
      if (i) u += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]);
      const e0 = en[closed ? (i + n - 1) % n : Math.max(0, i - 1)], e1 = en[closed ? i : Math.min(en.length - 1, i)];
      let nz = e0[0] + e1[0], ny = e0[1] + e1[1]; const l = Math.hypot(nz, ny) || 1; nz /= l; ny /= l;
      const k = th / Math.max(0.5, nz * e1[0] + ny * e1[1]);
      O.push([P[i][0] + nz * k, P[i][1] + ny * k]); N.push([nz, ny]); U.push(u / pitch);
   }
   if (closed) { O.push(O[0]); N.push(N[0]); P.push(P[0]); U.push(u / pitch + Math.hypot(P[0][0] - P[n - 1][0], P[0][1] - P[n - 1][1]) / pitch); }
   const m = P.length, pos = [], nrm = [], uv = [], idx = [];
   const vert = (x, y, z, nx, ny, nz, s, t) => { pos.push(x, y, z); nrm.push(nx, ny, nz); uv.push(s, t); return pos.length / 3 - 1; };
   // quad a-b-c-d with the triangle winding facing the given normal
   const quad = (a, b, c, d, nx, ny, nz) => {
      const p = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], A = p(a), B = p(b), C = p(c);
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
      const f = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
      if (f >= 0) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c);
   };
   for (let i = 0; i < m - 1; i++) {
      const j = i + 1, xi = P[i][2], xj = P[j][2];
      const fn = [0, (N[i][1] + N[j][1]) / 2, (N[i][0] + N[j][0]) / 2];
      // running surface (outer), inner face
      let a = vert(xi - hw, O[i][1], O[i][0], 0, N[i][1], N[i][0], U[i], 0.02), b = vert(xi + hw, O[i][1], O[i][0], 0, N[i][1], N[i][0], U[i], 0.48);
      let c = vert(xj + hw, O[j][1], O[j][0], 0, N[j][1], N[j][0], U[j], 0.48), d = vert(xj - hw, O[j][1], O[j][0], 0, N[j][1], N[j][0], U[j], 0.02);
      quad(a, b, c, d, fn[0], fn[1], fn[2]);
      a = vert(xi - hw, P[i][1], P[i][0], 0, -N[i][1], -N[i][0], U[i], 0.02); b = vert(xi + hw, P[i][1], P[i][0], 0, -N[i][1], -N[i][0], U[i], 0.48);
      c = vert(xj + hw, P[j][1], P[j][0], 0, -N[j][1], -N[j][0], U[j], 0.48); d = vert(xj - hw, P[j][1], P[j][0], 0, -N[j][1], -N[j][0], U[j], 0.02);
      quad(a, b, c, d, 0, -fn[1], -fn[2]);
      for (const sx of [-1, 1]) {   // side faces with the link profile
         a = vert(xi + sx * hw, P[i][1], P[i][0], sx, 0, 0, U[i], 0.52); b = vert(xi + sx * hw, O[i][1], O[i][0], sx, 0, 0, U[i], 0.99);
         c = vert(xj + sx * hw, O[j][1], O[j][0], sx, 0, 0, U[j], 0.99); d = vert(xj + sx * hw, P[j][1], P[j][0], sx, 0, 0, U[j], 0.52);
         quad(a, b, c, d, sx, 0, 0);
      }
   }
   if (!closed) for (const i of [0, m - 1]) {   // torn ends
      const s = i ? 1 : -1, tz = i ? P[i][0] - P[i - 1][0] : P[0][0] - P[1][0], ty = i ? P[i][1] - P[i - 1][1] : P[0][1] - P[1][1], x = P[i][2];
      const a = vert(x - hw, P[i][1], P[i][0], 0, ty, tz, U[i], 0.3), b = vert(x + hw, P[i][1], P[i][0], 0, ty, tz, U[i], 0.3);
      const c = vert(x + hw, O[i][1], O[i][0], 0, ty, tz, U[i], 0.45), d = vert(x - hw, O[i][1], O[i][0], 0, ty, tz, U[i], 0.45);
      quad(a, b, c, d, 0, ty * s * s, tz);
   }
   const g = new THREE.BufferGeometry();
   g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
   g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
   g.setIndex(idx); g.computeBoundingSphere();
   g.userData.pitch = pitch;
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

// Leopard 2A6 turret dressing (cfg.look 'leo2'): the octagon from config.js already is the arrowhead (big
// front chamfer = the add-on wedges as the cheeks); here: spaced wedge plates standing proud of the cheeks and
// reaching past the recessed mantlet, EMES gunner's sight, PERI R17, hatches, bustle racks, smoke dischargers.
function leoTurret(A, S, PAINT, DARK) {
   const T = S.turret, base = T.base, top = T.top, h = T.h;
   const zs = top.map((p) => p[1]), zFront = Math.min(...zs), xMax = Math.max(...top.map((p) => p[0]));
   const bBack = Math.max(...base.map((p) => p[1]));
   // wedges: cheek faces are base[1]->base[2] (left) and base[7]->base[0] (right); each a solid prism (plan
   // triangle) whose top slopes down to its tip, the tip 0.3 m ahead of the turret front beside the mantlet
   for (const s of [-1, 1]) {
      const fc = base[s < 0 ? 1 : 0], sc = base[s < 0 ? 2 : 7];       // front corner (beside the mantlet), side corner
      const tf = top[s < 0 ? 1 : 0], ts = top[s < 0 ? 2 : 7];
      const out = 0.07, nx = s * 0.7071 * out, nz = -0.7071 * out;      // stand-off of the wedge from the cheek
      const tip = [fc[0] + nx - s * 0.02, fc[1] - 0.5];
      const rear = [sc[0] + nx, sc[1] + nz + 0.05], inner = [fc[0] - s * 0.03, fc[1] + 0.02];
      const yb = 0.06, yR = h + 0.03, yT = h * 0.42;
      const rearT = [ts[0] + nx, ts[1] + nz + 0.05], innerT = [tf[0] - s * 0.03, tf[1] + 0.02];
      const P = [[tip[0], yb, tip[1]], [rear[0], yb, rear[1]], [inner[0], yb, inner[1]], [tip[0], yT, tip[1] + 0.06], [rearT[0], yR, rearT[1]], [innerT[0], yR - 0.06, innerT[1]]];
      const c = P.reduce((a, p) => [a[0] + p[0] / 6, a[1] + p[1] / 6, a[2] + p[2] / 6], [0, 0, 0]);
      A.tri(P[0], P[1], P[2], PAINT, c); A.tri(P[3], P[4], P[5], PAINT, c);
      for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) A.quad(P[i], P[j], P[j + 3], P[i + 3], PAINT, c);
      A.box(s * (xMax + 0.01), h * 0.5, rear[1] + 0.03, 0.04, h * 0.85, 0.05, DARK);     // seam where the wedge meets the side
      A.box(inner[0] - s * 0.02, h * 0.45, (tip[1] + inner[1]) / 2, 0.05, h * 0.8, inner[1] - tip[1], BLACK);   // shadow gap beside the mantlet
   }
   // roof: EMES 15 gunner's sight front right, PERI R17 on its pedestal behind it, commander's hatch right, loader's left
   const ez = zFront + 0.75;
   A.box(0.62, h + 0.16, ez, 0.42, 0.32, 0.62, PAINT);
   A.box(0.62, h + 0.17, ez - 0.32, 0.36, 0.2, 0.03, BLACK);
   A.box(0.62, h + 0.35, ez + 0.05, 0.3, 0.06, 0.4, PAINT);                                   // armoured flap
   const pz = zFront + 1.35, px = 0.95;
   A.cyl(px, h + 0.14, pz, 0.17, 0.17, 0.28, PAINT, 'y', 10);
   A.box(px, h + 0.42, pz, 0.36, 0.3, 0.36, PAINT);
   A.box(px, h + 0.42, pz - 0.185, 0.24, 0.12, 0.02, BLACK);
   A.box(px, h + 0.6, pz, 0.38, 0.05, 0.38, DARK);
   A.cyl(0.45, h + 0.04, pz + 0.55, 0.36, 0.36, 0.08, PAINT, 'y', 12);
   for (let k = 0; k < 8; k++) A.box(0.45 + Math.cos(k * 0.785) * 0.4, h + 0.09, pz + 0.55 + Math.sin(k * 0.785) * 0.4, 0.06, 0.07, 0.1, BLACK, 0, -k * 0.785);
   A.cyl(-0.6, h + 0.035, pz + 0.45, 0.34, 0.34, 0.07, PAINT, 'y', 12);
   A.box(-0.6, h + 0.28, pz + 0.05, 0.05, 0.05, 0.9, BLACK);                                  // loader's MG3
   A.box(-0.6, h + 0.16, pz + 0.3, 0.04, 0.22, 0.04, DARK);
   A.box(-0.85, h + 0.08, zFront + 0.9, 0.22, 0.14, 0.16, DARK);                              // loader's periscope
   // bustle: stowage rack on the back plate and the rear sides
   A.box(0, h * 0.5, bBack + 0.2, xMax * 1.5, h * 0.62, 0.38, DARK);
   for (const s of [-1, 1]) A.box(s * (xMax + 0.1), h * 0.62, bBack - 0.55, 0.2, h * 0.4, 1.0, DARK);
   // smoke dischargers: 2 x 4 tubes on each side
   for (const s of [-1, 1]) for (let k = 0; k < 4; k++) for (let j = 0; j < 2; j++)
      A.cyl(s * (xMax + 0.09), h * 0.38 + j * 0.15, bBack - 1.35 + k * 0.17, 0.05, 0.05, 0.24, STEEL, 'x', 8);
   // crosswind sensor mast on the rear roof
   A.cyl(0, h + 0.25, bBack - 0.25, 0.02, 0.02, 0.5, DARK, 'y', 6);
   A.box(0, h + 0.5, bBack - 0.25, 0.12, 0.04, 0.04, DARK);
   if (S.mantlet) { const m = S.mantlet; A.box(m.x, m.y, m.z, m.w, m.h, m.d, PAINT); A.box(m.x, m.y + m.h * 0.18, m.z - m.d / 2 - 0.01, m.w * 0.25, m.h * 0.22, 0.02, BLACK); }
}

const GEO_CACHE = new Map();
function geometryFor(cfg, key) {
   if (GEO_CACHE.has(key)) return GEO_CACHE.get(key);
   const S = shapeOf(cfg);
   const g = { S, hull: withWy(buildHull(S), 0), turret: S.turret ? withWy(buildTurret(S), S.turret.y) : null, gun: withWy(buildGun(S), 3), track: buildTrack(S), decT: buildDecals(S, true), decH: buildDecals(S, false) };
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
   const sh = shared(), g = geometryFor(cfg, key), S = g.S, mat0 = sh.camo[S.paint || S.nation] || sh.camo.de;
   const root = new THREE.Group();
   const body = new THREE.Group(); root.add(body);              // pitch/roll
   const hull = new THREE.Mesh(g.hull, mat0); body.add(hull);
   const decH = new THREE.Mesh(g.decH, sh.decal); body.add(decH);
   const tracks = [];
   for (const s of [-1, 1]) {
      const tex = sh.tread.clone(); tex.needsUpdate = true;
      const m = new THREE.MeshStandardMaterial({ map: tex, color: 0xd8cfc0, bumpMap: tex, bumpScale: 2.5, roughness: 0.7, metalness: 0.35 });
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
   return { root, body, hull, turret, tmesh, gunPivot, gun, tracks, S, g, mat0, treadL: 0, treadR: 0, recoil: 0, broken: [null, null], lift: 0 };
}
// belt geometry for one side: intact, or torn at the front / rear end (cached per tank type)
function trackGeo(g, end) {
   if (!end) return g.track;
   const k = 'track' + end; return g[k] ??= buildTrack(g.S, end);
}

export class Tanks3D {
   constructor(scene, world) {
      this.scene = scene; this.world = world; this.models = new Map(); this.lastSeq = 0;
      setTankWeather(world?.mapId);
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
         else if (type === 'track') { const m = this.models.get(ev.dstId), t = m && (w.tankById?.(ev.dstId) ?? w.tanks.find((q) => q.id === ev.dstId));
            if (t && ev.pos) { const lz = -(ev.pos.x - t.pos.x) * Math.sin(t.yaw) - (ev.pos.z - t.pos.z) * Math.cos(t.yaw); (m.tearEnd ??= [null, null])[ev.side === 'R' ? 1 : 0] = lz > 0 ? 'F' : 'R'; } }
         else if (isHitEvent(type)) this.hitQ.push(ev);
      }
      this.lastSeq = maxSeq;
      for (const t of w.tanks) {
         const m = this._model(t), r = m.root, b = m.body;
         r.visible = t.visible !== false && (t.spotted !== false || t.team === w.player?.team || !t.alive);
         if (!r.visible) continue;
         // the sim lets the hull sag up to 15 cm into a crest (pos.y = max(mean of the ends, centre - 0.15));
         // the model rides on the ground there instead, so the belt never sinks into the terrain
         const T = w.terrain, gh = T?.groundHeightAt ? T.groundHeightAt(t.pos.x, t.pos.z) : T?.heightAt?.(t.pos.x, t.pos.z);
         if (gh != null && t.alive !== false && !m.site) m.lift += (Math.min(0.2, Math.max(0, gh - t.pos.y)) - m.lift) * Math.min(1, dt * 12);
         r.position.set(t.pos.x, t.pos.y + m.lift, t.pos.z); r.rotation.y = t.yaw;
         b.rotation.set(t.pitch || 0, 0, t.roll || 0, 'YXZ');
         if (!m.blow) { m.turret.rotation.y = t.turretYaw || 0; m.gunPivot.rotation.x = t.gunPitch || 0; }
         // treads: left/right belt speed from forward speed and yaw rate
         let dy = t.yaw - m.lastYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); m.lastYaw = t.yaw;
         const yr = dt > 0 ? dy / dt : 0, hw = m.S.W / 2 - m.S.track.w / 2, v = t.speed || 0;
         if (m.tracks.length) {
            // detracked side: belt torn open at the end nearest the hit, the torn run lies on the ground
            for (let i = 0; i < 2; i++) {
               const st = t.modules?.[i ? 'trackR' : 'trackL']?.state, end = st === 'destroyed' ? (m.broken[i] || m.tearEnd?.[i] || 'F') : null;
               if (end !== m.broken[i]) { m.broken[i] = end; m.tracks[i].geometry = trackGeo(m.g, end); if (!end && m.tearEnd) m.tearEnd[i] = null; }
            }
            if (t.alive !== false) {
               const pitch = m.g.track.userData.pitch || 0.17;
               if (!m.broken[0]) m.treadL += (v - yr * hw) * dt;
               if (!m.broken[1]) m.treadR += (v + yr * hw) * dt;
               m.tracks[0].material.map.offset.x = -m.treadL / pitch; m.tracks[1].material.map.offset.x = -m.treadR / pitch;
            }
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
