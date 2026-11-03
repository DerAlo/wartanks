// game/terrain3d.js — the visible battlefield built from terrain.js: ground mesh (4×4 chunks,
// vertex colours by ground class / slope / height + a tiled detail texture), a low-res outer ring
// to the horizon, water, instanced trees / bushes / rocks, merged houses and walls, and a field of
// grass clumps that wraps around the camera. Destructible objects follow terrain.version.
// Mission features (terrain.addObject & co.): dragon's teeth, hedgehogs and wire are merged with the
// houses; trenches are a fine ribbon mesh (the ground chunks leave a hole there) with revetment and
// sandbags; bridges a merged deck/girder/pier mesh. terrain.heightVersion / heightEdits trigger a
// rebuild of the trench mesh and of the ground chunks the edit touched.
import * as THREE from '../vendor/three/three.module.min.js';

const C = (h) => new THREE.Color(h);
const PALETTES = {
   summer: { grass: C(0x6b7a3a), grass2: C(0x857f45), dirt: C(0x7a6544), rock: C(0x7c776c), road: C(0x9a8a66), sand: C(0xb3a273), soft: C(0x5b5a34), snow: C(0xe8ecef), tree: C(0x3f5a26), tree2: C(0x56682c), pine: C(0x2c4422), bush: C(0x4c6229) },
   winter: { grass: C(0xdfe5ea), grass2: C(0xc9d2d8), dirt: C(0x8d8578), rock: C(0x6f6e6a), road: C(0xa59e8d), sand: C(0xcfcfc8), soft: C(0xb8c0c4), snow: C(0xf2f5f7), tree: C(0x3a4a2c), tree2: C(0x4a5a34), pine: C(0x24361f), bush: C(0x5a6648) },
   // Baltic coast: dune grass, pale sand, pines, red-brick towns with dark tile roofs
   coast: { grass: C(0x76814a), grass2: C(0x928c5c), dirt: C(0x7c6a4c), rock: C(0x7d7a72), road: C(0x9d927a), sand: C(0xcfbe90), soft: C(0x958a5e), snow: C(0xe8ecef), tree: C(0x3d5628), tree2: C(0x52632e), pine: C(0x2a4224), bush: C(0x4f6230),
      walls: [0x8e4a36, 0x7c3e2e, 0x9b5a44, 0xa89e8a], roofs: [0x5a2a20, 0x4a3a34, 0x3f4448], pines: 0.8 },
   steppe: { grass: C(0x8a8a48), grass2: C(0xa49a58), dirt: C(0x86704a), rock: C(0x8a8274), road: C(0xa8956a), sand: C(0xbfae7a), soft: C(0x6d6a3a), snow: C(0xe8ecef), tree: C(0x4d6229), tree2: C(0x657236), pine: C(0x33482a), bush: C(0x5f6b30) },
};

// one wind clock for grass and tree crowns (Terrain3D.update advances it)
const WIND = { uWind: { value: 0 } };
const NOISE_GLSL = `
float tHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
   return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), f.x), mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), f.x), f.y); }`;
/** Ground shading on top of the baked vertex colours: two detail-texture scales (no visible tiling),
 *  macro patches (lush / dry / dark soil) that break the uniform field at distance, rock strata on
 *  steep slopes, detail fading with distance (no moire), and the detail map doubles as bump map. */
function patchGround(mat, opt) {
   mat.onBeforeCompile = (sh) => {
      sh.uniforms.uDry = { value: opt.dry }; sh.uniforms.uRock = { value: opt.rock };
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
varying vec3 vTWP;
varying float vTUp;`)
         .replace('#include <fog_vertex>', `#include <fog_vertex>
vTWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vTUp = normal.y;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vTWP;
varying float vTUp;
uniform float uDry;
uniform vec3 uRock;` + NOISE_GLSL)
         .replace('#include <map_fragment>', `
            float tDist = length(vTWP - cameraPosition);
            float tNear = 1.0 - smoothstep(40.0, 420.0, tDist);
            float d1 = texture2D(map, vMapUv).r, d2 = texture2D(map, vTWP.zx * 0.0241 + 0.37).r, d3 = texture2D(map, vTWP.xz * 0.0063 + 0.11).r;
            float det = mix(mix(d1, d2, 0.4), d3, 0.25 + 0.35 * (1.0 - tNear)) / 0.56;
            diffuseColor.rgb *= mix(1.0, det, 0.45 + 0.55 * tNear);
            vec2 q = vTWP.xz;
            float m1 = tNoise(q / 190.0) * 0.6 + tNoise(q / 63.0) * 0.4, m2 = tNoise(q / 47.0 + 17.0) * 0.65 + tNoise(q / 13.0) * 0.35;
            diffuseColor.rgb *= 0.84 + 0.32 * m1;
            float dry = smoothstep(0.52, 0.78, m2) * uDry;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.03, 0.86), dry);
            diffuseColor.rgb *= 1.0 - 0.18 * smoothstep(0.6, 0.85, 1.0 - m2) * uDry;
            float slope = 1.0 - vTUp;
            float strata = tNoise(vec2(vTWP.x * 0.21 + vTWP.z * 0.13, vTWP.y * 2.1)) * 0.6 + tNoise(vTWP.xz * 0.9) * 0.4;
            diffuseColor.rgb = mix(diffuseColor.rgb, uRock * (0.62 + 0.6 * strata), smoothstep(0.32, 0.55, slope) * 0.85);`);
   };
   mat.customProgramCacheKey = () => 'pz-ground';
}
function patchWind(mat, amp, key) {
   mat.onBeforeCompile = (sh) => {
      sh.uniforms.uWind = WIND.uWind;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
uniform float uWind;`)
         .replace('#include <begin_vertex>', `#include <begin_vertex>
            #ifdef USE_INSTANCING
               vec2 wOrg = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xz;
               float wk = max(position.y - ${amp[1].toFixed(2)}, 0.0) * ${amp[0].toFixed(4)};
               float wph = uWind * 1.7 + dot(wOrg, vec2(0.071, 0.053));
               transformed.x += (sin(wph) * 0.7 + sin(wph * 2.3 + 1.1) * 0.3) * wk;
               transformed.z += sin(wph * 0.8 + 2.0) * 0.5 * wk;
            #endif`);
   };
   mat.customProgramCacheKey = () => key;
}

function hash(x, z) { const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, z) {
   const xi = Math.floor(x), zi = Math.floor(z); let fx = x - xi, fz = z - zi;
   fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
   const a = hash(xi, zi), b = hash(xi + 1, zi), c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
   return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
const fbm = (x, z) => vnoise(x, z) * 0.55 + vnoise(x * 2.1, z * 2.1) * 0.3 + vnoise(x * 4.3, z * 4.3) * 0.15;

function detailTexture() {
   const n = 256, cv = document.createElement('canvas'); cv.width = cv.height = n;
   const g = cv.getContext('2d'), img = g.createImageData(n, n);
   for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      // tileable: noise on a torus via 4-corner blend
      const u = x / n, v = y / n, f = (px, pz) => fbm(px * 0.125 * 32, pz * 0.125 * 32);
      const val = f(u, v) * (1 - u) * (1 - v) + f(u - 1, v) * u * (1 - v) + f(u, v - 1) * (1 - u) * v + f(u - 1, v - 1) * u * v;
      const k = 200 + (val - 0.5) * 120 + (hash(x, y) - 0.5) * 34, i = (y * n + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, k)); img.data[i + 3] = 255;
   }
   g.putImageData(img, 0, 0);
   const t = new THREE.CanvasTexture(cv);
   t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
   return t;
}

// --- tiny geometry merger: non-indexed, position/normal/color ---
function addGeo(acc, geo, matrix, color, jitter = 0) {
   const g = geo.index ? geo.toNonIndexed() : geo.clone();   // never transform the shared source (roof prism) in place
   g.applyMatrix4(matrix);
   const p = g.attributes.position.array, nn = g.attributes.normal.array;
   for (let i = 0; i < p.length; i += 3) {
      acc.p.push(p[i], p[i + 1], p[i + 2]); acc.n.push(nn[i], nn[i + 1], nn[i + 2]);
      const j = 1 + (jitter ? (hash(p[i] * 3.1, p[i + 2] * 1.7 + p[i + 1]) - 0.5) * jitter : 0);
      acc.c.push(color.r * j, color.g * j, color.b * j);
   }
}
export function mergeAcc(acc) {
   const g = new THREE.BufferGeometry();
   g.setAttribute('position', new THREE.Float32BufferAttribute(acc.p, 3));
   g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.n, 3));
   g.setAttribute('color', new THREE.Float32BufferAttribute(acc.c, 3));
   g.computeBoundingSphere();
   return g;
}
const newAcc = () => ({ p: [], n: [], c: [] });
const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), E = new THREE.Euler();
const mat = (x, y, z, ry = 0, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => M.compose(V.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz)).clone();
const E2 = new THREE.Euler(0, 0, 0, 'YXZ');      // yaw, then pitch / roll in the yawed frame
const matYXZ = (x, y, z, ry, rx, rz, sx = 1, sy = 1, sz = 1) => M.compose(V.set(x, y, z), Q.setFromEuler(E2.set(rx, ry, rz, 'YXZ')), S.set(sx, sy, sz)).clone();
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const SEABED = C(0x34443e), EARTH = C(0x3d3022), EARTH2 = C(0x55432d), CONC = C(0xa9a69c), STEEL = C(0x4a4640), WIREC = C(0x57524b),
   WOOD = C(0x6b5236), BAG = C(0x9a8a62), DECK = C(0x77736a), GIRDER = C(0x5d5b56);
const FEATURE_KINDS = { teeth: 1, hedgehog: 1, wire: 1, bridge: 1 };

// Trees: crown and trunk are separate instanced meshes (instance colour tints only the crown).
// Crown = several jittered lumps with baked light/dark vertex shading; vertex colours ~1 so the
// instance colour sets the hue.
function lump(acc, r, x, y, z, sx, sy, sz, seed, shade) {
   const ico = new THREE.IcosahedronGeometry(r, 1), pa = ico.attributes.position;
   for (let i = 0; i < pa.count; i++) { const k = 0.82 + hash(pa.getX(i) * 5 + seed, pa.getZ(i) * 5 + pa.getY(i)) * 0.36; pa.setXYZ(i, pa.getX(i) * k, pa.getY(i) * k, pa.getZ(i) * k); }
   ico.computeVertexNormals();
   const g = ico.index ? ico.toNonIndexed() : ico; g.applyMatrix4(mat(x, y, z, seed, sx, sy, sz));
   const p = g.attributes.position.array, nn = g.attributes.normal.array;
   for (let i = 0; i < p.length; i += 3) {
      acc.p.push(p[i], p[i + 1], p[i + 2]); acc.n.push(nn[i], nn[i + 1], nn[i + 2]);
      // underside darker, sun-ish top lighter, per-face speckle
      const k = shade * (0.78 + (p[i + 1] - y) / (r * sy) * 0.16 + (hash(p[i] * 2.3, p[i + 2] * 1.9 + seed) - 0.5) * 0.22);
      acc.c.push(k, k * 1.02, k * 0.94);
   }
}
export function treeGeo(kind) {
   const crown = newAcc(), trunk = newAcc(), white = C(0xffffff);
   if (kind === 'pine') {
      addGeo(trunk, new THREE.CylinderGeometry(0.14, 0.32, 6, 6), mat(0, 3, 0), white, 0.15);
      for (let i = 0; i < 5; i++) {
         const cone = new THREE.ConeGeometry(2.7 - i * 0.48, 2.9 - i * 0.2, 9, 1, true), pa = cone.attributes.position;
         for (let v = 0; v < pa.count; v++) if (pa.getY(v) < 0) { const k = 0.85 + hash(v, i) * 0.3; pa.setXYZ(v, pa.getX(v) * k, pa.getY(v) - hash(i, v) * 0.35, pa.getZ(v) * k); }
         cone.computeVertexNormals();
         addGeo(crown, cone, mat(0, 2.6 + i * 1.45, 0, i * 0.7), white.clone().multiplyScalar(0.8 + i * 0.06), 0.18);
      }
   } else {
      addGeo(trunk, new THREE.CylinderGeometry(0.18, 0.36, 4.6, 6), mat(0, 2.3, 0), white, 0.15);
      addGeo(trunk, new THREE.CylinderGeometry(0.07, 0.13, 2.4, 4), mat(0.6, 4.2, 0.2, 0, 1, 1, 1, 0, -0.7), white);
      addGeo(trunk, new THREE.CylinderGeometry(0.07, 0.12, 2.2, 4), mat(-0.5, 4.3, -0.3, 0, 1, 1, 1, 0.3, 0.7), white);
      const L = [[0, 6.3, 0, 2.2, 1.05], [1.4, 5.3, 0.5, 1.6, 0.9], [-1.3, 5.5, -0.6, 1.65, 0.92], [0.3, 5.1, -1.4, 1.5, 0.85],
         [-0.4, 5.0, 1.4, 1.5, 0.88], [0.7, 7.3, 0.3, 1.4, 1.08], [-0.8, 6.9, 0.2, 1.3, 1.02]];
      L.forEach(([x, y, z, r, sh], i) => lump(crown, r, x, y, z, 1.1, 0.85, 1.1, i * 1.7, sh));
   }
   return [mergeAcc(crown), mergeAcc(trunk)];
}

export class Terrain3D {
   constructor(scene, terrain, theme = {}, q = {}) {
      this.scene = scene; this.t = terrain; this.q = q;
      this.group = new THREE.Group(); scene.add(this.group);
      const pid = theme.palette && PALETTES[theme.palette] ? theme.palette : (/winter|schnee/i.test(theme.id || '') ? 'winter' : /steppe/i.test(theme.id || '') ? 'steppe' : 'summer');
      this.winter = pid === 'winter';
      this.chunks = [];
      this.pal = { ...PALETTES[pid], ...(theme.colors ? Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [k, C(v)])) : {}) };
      this.detail = detailTexture();
      this.groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.detail, bumpMap: this.detail, bumpScale: 2.2, roughness: 0.97, metalness: 0 });
      patchGround(this.groundMat, { dry: this.winter ? 0.25 : pid === 'steppe' ? 0.8 : 0.6, rock: this.pal.rock.clone().multiplyScalar(this.winter ? 1.15 : 1) });
      this.vegMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
      patchWind(this.vegMat, [0.03, 2.5], 'pz-veg');   // smooth: faceted crowns read as flat planes in the x8/x16 scope
      this.buildGround();
      this.buildWater();
      this.buildObjects();
      this.buildTrenches();
      this.buildGrass(q.grass ?? 6000);
      this.version = terrain.version ?? 0;
      this.hver = terrain.heightVersion ?? 0; this.hedit = terrain.heightEdits?.length ?? 0;
   }

   _color(x, z, out) {
      const t = this.t, P = this.pal, h = t.groundHeightAt ? t.groundHeightAt(x, z) : t.heightAt(x, z), nrm = t.normalAt ? t.normalAt(x, z) : { y: 1 };
      const slope = 1 - nrm.y, cls = t.groundAt ? t.groundAt(x, z) : 'medium';
      const n1 = fbm(x * 0.012, z * 0.012), n2 = fbm(x * 0.06 + 7, z * 0.06);
      out.copy(P.grass).lerp(P.grass2, Math.min(1, n1 * 1.3));
      if (cls === 'soft') out.lerp(P.soft, 0.7);
      else if (cls === 'hard') out.lerp(P.dirt, 0.35);
      out.lerp(P.dirt, Math.max(0, Math.min(1, (slope - 0.12) * 4)) * 0.8);
      out.lerp(P.rock, Math.max(0, Math.min(1, (slope - 0.3) * 4)));
      if (cls === 'road') out.lerp(P.road, 0.85);
      if (t.water != null) { const d = h - t.water; if (d < 1.6) out.lerp(P.sand, Math.max(0, Math.min(1, 1 - d / 1.6)) * 0.8); }
      if (t.coast) {      // beach sand, darker seabed with depth (seen through the water)
         const cs = t.coastS(x, z), b = t.coast.beach;
         if (cls !== 'road') out.lerp(P.sand, clamp01((cs + b * 0.85) / (b * 0.4)) * 0.85);
         if (t.water != null && h < t.water - 0.3) out.lerp(SEABED, clamp01((t.water - h) / 9) * 0.85);
      }
      out.multiplyScalar(0.88 + n2 * 0.24);
      return out;
   }

   buildGround() {
      this.step = this.q.veg < 0.5 ? 4 : 2; this.CH = 4;
      for (let cz = 0; cz < this.CH; cz++) for (let cx = 0; cx < this.CH; cx++) this._buildChunk(cx, cz);
      this._buildRing();
   }
   /** One ground chunk; quads near a trench are left out (the trench ribbon mesh fills the hole). */
   _buildChunk(cx, cz) {
      const t = this.t, half = t.half ?? 500, step = this.step, CH = this.CH, col = new THREE.Color();
      const per = Math.round(2 * half / step) / CH, n = per + 1, k0 = cz * CH + cx;
      const old = this.chunks[k0];
      if (old) { this.group.remove(old); old.geometry.dispose(); }
      const gh = t.groundHeightAt ? (x, z) => t.groundHeightAt(x, z) : (x, z) => t.heightAt(x, z);
      const hole = t.trenches?.length ? 2.8 + 0.75 * step : -Infinity;
      const pos = new Float32Array(n * n * 3), clr = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), nor = new Float32Array(n * n * 3);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
         const x = -half + (cx * per + i) * step, z = -half + (cz * per + j) * step, k = j * n + i;
         pos[k * 3] = x; pos[k * 3 + 1] = gh(x, z); pos[k * 3 + 2] = z;
         const nm = t.normalAt ? t.normalAt(x, z) : { x: 0, y: 1, z: 0 };
         nor[k * 3] = nm.x; nor[k * 3 + 1] = nm.y; nor[k * 3 + 2] = nm.z;
         this._color(x, z, col); clr[k * 3] = col.r; clr[k * 3 + 1] = col.g; clr[k * 3 + 2] = col.b;
         uv[k * 2] = x / 9; uv[k * 2 + 1] = z / 9;
      }
      const idx = new Uint32Array(per * per * 6); let w = 0;
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
         if (hole > 0 && t.trenchDist(-half + (cx * per + i + 0.5) * step, -half + (cz * per + j + 0.5) * step) < hole) continue;
         const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
         idx[w++] = a; idx[w++] = c; idx[w++] = b; idx[w++] = b; idx[w++] = c; idx[w++] = d;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setAttribute('color', new THREE.BufferAttribute(clr, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(new THREE.BufferAttribute(w < idx.length ? idx.slice(0, w) : idx, 1)); g.computeBoundingSphere();
      const m = new THREE.Mesh(g, this.groundMat); m.receiveShadow = true; this.group.add(m);
      this.chunks[k0] = m;
   }
   _buildRing() {
      const t = this.t, half = t.half ?? 500, col = new THREE.Color();
      // outer ring to the horizon: coarse, follows edge heights falling off into gentle hills
      const R = 2200, segR = 24, segA = 64, pos = [], clr = [], idx = [];
      for (let r = 0; r <= segR; r++) for (let a = 0; a <= segA; a++) {
         const ang = a / segA * Math.PI * 2, f = r / segR, rad = half * 1.0 + (R - half) * f * f;
         const x = Math.cos(ang) * rad * (f === 0 ? 1.0 : 1), z = Math.sin(ang) * rad;
         // squared playfield: pull the inner edge to the square so it overlaps the chunks
         const sq = Math.max(Math.abs(Math.cos(ang)), Math.abs(Math.sin(ang)));
         const px = f === 0 ? Math.cos(ang) / sq * half * 0.995 : x, pz = f === 0 ? Math.sin(ang) / sq * half * 0.995 : z;
         const ex = Math.max(-half, Math.min(half, px)), ez = Math.max(-half, Math.min(half, pz));
         const h0 = t.heightAt(ex, ez), hill = (fbm(px * 0.004, pz * 0.004) - 0.4) * 60 * Math.min(1, f * 3);
         let y = h0 * (1 - Math.min(1, f * 2)) + hill + (f === 0 ? -0.05 : 0);
         // coast maps: the ring drops under the sea on the seaward side -> open-water horizon
         if (t.coast && f > 0) y += ((t.water ?? 0) - 12 - y) * clamp01(t.coastS(px, pz) / 80 + 0.25);
         pos.push(px, y, pz);
         this._color(ex, ez, col); col.multiplyScalar(0.92); clr.push(col.r, col.g, col.b);
      }
      for (let r = 0; r < segR; r++) for (let a = 0; a < segA; a++) {
         const i0 = r * (segA + 1) + a, i1 = i0 + 1, i2 = i0 + segA + 1, i3 = i2 + 1;
         idx.push(i0, i1, i2, i1, i3, i2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(clr, 3));
      g.setIndex(idx); g.computeVertexNormals();
      this.ring = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true }));
      this.group.add(this.ring);
   }

   buildWater() {
      if (this.t.water == null) return;
      const g = new THREE.PlaneGeometry(4400, 4400); g.rotateX(-Math.PI / 2);
      this.waterMat = new THREE.MeshStandardMaterial({ color: 0x3d5a58, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.82 });
      const w = new THREE.Mesh(g, this.waterMat); w.position.y = this.t.water; w.receiveShadow = true; this.group.add(w);
   }

   buildObjects() {
      const t = this.t, P = this.pal, objs = t.objects || [], veg = this.q.veg ?? 1;
      const kinds = { tree: [], pine: [], bush: [], rock: [] };
      for (const o of objs) {
         if (o.kind === 'tree') ((o.seed ?? hash(o.x, o.z) * 1e4) % 3 < 3 * (P.pines ?? 0.4) || this.winter ? kinds.pine : kinds.tree).push(o);
         else if (o.kind === 'bush') kinds.bush.push(o);
         else if (o.kind === 'rock') kinds.rock.push(o);
      }
      const bushGeo = new THREE.IcosahedronGeometry(1, 1); bushGeo.scale(1, 0.62, 1); bushGeo.translate(0, 0.35, 0);
      const rockGeo = new THREE.DodecahedronGeometry(1, 0); rockGeo.translate(0, 0.25, 0);
      for (const g of [bushGeo, rockGeo]) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
      const defs = {
         tree: [...treeGeo('tree'), P.tree, 6.5, true], pine: [...treeGeo('pine'), P.pine, 9, true],
         bush: [bushGeo, null, P.bush, 1.6, false], rock: [rockGeo, null, P.rock, 1.4, true],
      };
      this.inst = {};
      for (const k in kinds) {
         const list = kinds[k].filter((o, i) => o.solid || k !== 'bush' || hash(i, 3) < Math.max(0.6, veg));
         if (!list.length) continue;
         const [geo, trunkGeo, color, nominal, shadow] = defs[k];
         const im = new THREE.InstancedMesh(geo, this.vegMat, list.length);
         let tm = null;
         if (trunkGeo) { tm = new THREE.InstancedMesh(trunkGeo, this.trunkMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x4a3a2a, roughness: 0.95, flatShading: true }), list.length); tm.castShadow = true; tm.receiveShadow = true; this.group.add(tm); }
         im.castShadow = shadow; im.receiveShadow = true;
         const cc = new THREE.Color();
         list.forEach((o, i) => {
            const sz = (o.h || nominal) / nominal;
            cc.copy(color).multiplyScalar(0.82 + hash(o.x, o.z) * 0.36); if (k === 'tree') cc.lerp(P.tree2, hash(o.z, o.x)); if (k === 'tree' && hash(o.x * 3, o.z) > 0.85) cc.lerp(C(0x8a7a34), 0.35);
            im.setColorAt(i, cc);
         });
         this.inst[k] = { im, tm, list };
         this._placeInstances(k);
         this.group.add(im);
      }
      this.buildStructures();
   }

   _placeInstances(k) {
      const { im, tm, list } = this.inst[k], nominal = k === 'tree' ? 6.5 : k === 'pine' ? 9 : k === 'bush' ? 1.6 : 1.4;
      list.forEach((o, i) => {
         const y = this.t.heightAt(o.x, o.z), r = hash(o.x * 1.3, o.z);
         let sx, sy, sz;
         if (k === 'bush') { sx = (o.w || 3) * 0.5; sz = (o.d || o.w || 3) * 0.5; sy = (o.h || 1.6) / 1.6 * 1.6; }
         else if (k === 'rock') { sx = (o.w || 2) * 0.55; sz = (o.d || 2) * 0.55; sy = (o.h || 1.4) * 0.6; }
         else { const s = (o.h || nominal) / nominal; sx = sy = sz = s * (0.9 + r * 0.25); }
         if (o.alive === false) {
            if (k === 'tree' || k === 'pine') M.compose(V.set(o.x, y + 0.4, o.z), Q.setFromEuler(E.set(Math.PI / 2 - 0.08, o.fallYaw ?? r * 6.28, 0, 'YXZ')), S.set(sx, sy, sz));
            else M.compose(V.set(o.x, y - 0.3, o.z), Q.identity(), S.set(sx, 0.25 * sy, sz));
         } else M.compose(V.set(o.x, y - (k === 'rock' ? 0.3 : 0.1), o.z), Q.setFromEuler(E.set(0, o.yaw ?? r * 6.28, 0)), S.set(sx, sy, sz));
         im.setMatrixAt(i, M); tm?.setMatrixAt(i, M);
      });
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere?.();
      if (tm) { tm.instanceMatrix.needsUpdate = true; tm.computeBoundingSphere?.(); }
   }

   buildStructures() {
      if (this.struct) { this.group.remove(this.struct); this.struct.geometry.dispose(); }
      const t = this.t, acc = newAcc(), box = new THREE.BoxGeometry(1, 1, 1);
      const wallC = this.pal.walls ? this.pal.walls.map(C) : [C(0xb9ae94), C(0xa79b80), C(0xcfc6ad), C(0x9a8f7a)];
      const roofC = this.pal.roofs ? this.pal.roofs.map(C) : [C(0x8a3f2a), C(0x6e3b2c), C(0x5b5148)];
      const roof = new THREE.BufferGeometry();
      // unit gable prism: ridge along x, width z -0.5..0.5, height 0..1
      roof.setAttribute('position', new THREE.Float32BufferAttribute([
         -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
         0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,
         -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0], 3));
      roof.computeVertexNormals();
      for (const o of t.objects || []) {
         if (FEATURE_KINDS[o.kind]) { this._feature(acc, o, box); continue; }
         if (o.kind !== 'house' && o.kind !== 'church' && o.kind !== 'wall' && o.kind !== 'fence') continue;
         o.d ??= 0.6; o.w ??= 2;
         const y = (o.kind === 'house' || o.kind === 'church') && o.y != null ? o.y - 0.4 : Math.min(t.heightAt(o.x - o.w / 2, o.z), t.heightAt(o.x + o.w / 2, o.z), t.heightAt(o.x, o.z - o.d / 2), t.heightAt(o.x, o.z + o.d / 2)) - 0.3;
         const r = hash(o.x, o.z), yaw = o.yaw || 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
         const at = (lx, ly, lz) => [o.x + lx * cos + lz * sin, y + ly, o.z - lx * sin + lz * cos];
         if (o.kind === 'church' && o.alive !== false) {
            const h = o.h || 11, wc = C(0xcac2ab), rc = C(0x5b5148), tw = Math.min(o.w, o.d) * 0.45;
            // nave along the long side, tower at one end
            const long = o.d >= o.w, L = long ? o.d : o.w, W = long ? o.w : o.d, ry = long ? yaw + Math.PI / 2 : yaw;
            addGeo(acc, box, mat(...at(0, h * 0.3, 0), ry, L, h * 0.6 + 0.4, W), wc, 0.06);
            addGeo(acc, roof, mat(...at(0, h * 0.6 + 0.2, 0), ry, L + 0.6, h * 0.35, W + 0.6), rc, 0.12);
            const tl = long ? [0, 0, L / 2 - tw / 2] : [L / 2 - tw / 2, 0, 0];
            addGeo(acc, box, mat(...at(tl[0], h * 0.75, tl[2]), yaw, tw, h * 1.5, tw), wc, 0.05);
            const spire = new THREE.ConeGeometry(tw * 0.75, h * 0.7, 4); spire.rotateY(Math.PI / 4);
            addGeo(acc, spire, mat(...at(tl[0], h * 1.5 + h * 0.35, tl[2]), yaw), C(0x4c5a52));
            continue;
         }
         if (o.kind === 'house' || o.kind === 'church') {
            const h = o.h || 6, wc = wallC[(o.style ?? Math.floor(r * 4)) % 4], rc = roofC[Math.floor(hash(o.z, o.x) * 3)];
            if (o.alive === false) {
               addGeo(acc, box, mat(...at(0, h * 0.12, 0), yaw, o.w, h * 0.3, o.d), wc.clone().multiplyScalar(0.6), 0.4);
               addGeo(acc, box, mat(...at(o.w * 0.3, h * 0.25, 0), yaw, 0.6, h * 0.5, o.d * 0.9, 0, 0.1), wc.clone().multiplyScalar(0.7), 0.3);
               continue;
            }
            const wallH = h * 0.62;
            addGeo(acc, box, mat(...at(0, wallH / 2 + 0.3, 0), yaw, o.w, wallH + 0.6, o.d), wc, 0.08);
            addGeo(acc, box, mat(...at(0, 0.35, 0), yaw, o.w + 0.15, 0.7, o.d + 0.15), C(0x6c6558));
            if (o.roof === 'hip') {
               const hip = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1); hip.rotateY(Math.PI / 4); hip.translate(0, 0.5, 0);
               addGeo(acc, hip, mat(...at(0, wallH + 0.6, 0), yaw, o.w + 0.7, h - wallH, o.d + 0.7), rc, 0.15);
            } else addGeo(acc, roof, mat(...at(0, wallH + 0.6, 0), yaw, o.w + 0.6, h - wallH, o.d + 0.6), rc, 0.15);
            // windows: dark insets on both long sides
            const nw = Math.max(1, Math.floor(o.w / 3.2));
            for (let i = 0; i < nw; i++) for (const s of [-1, 1]) {
               const lx = (i - (nw - 1) / 2) * (o.w / nw);
               addGeo(acc, box, mat(...at(lx, wallH * 0.6 + 0.3, s * (o.d / 2 + 0.01)), yaw, 1.0, 1.2, 0.06), C(0x23262a));
            }
            addGeo(acc, box, mat(...at(o.w * 0.28, h * 0.92, o.d * 0.15), yaw, 0.7, 1.6, 0.7), C(0x7a5a48)); // chimney
         } else {
            const h = o.alive === false ? (o.h || 1.5) * 0.3 : (o.h || 1.5);
            const c = o.kind === 'wall' ? C(0x9d9483) : C(0x6a5338);
            if (o.kind === 'fence') {
               const n = Math.max(2, Math.round(o.w / 2.5));
               for (let i = 0; i <= n; i++) addGeo(acc, box, mat(...at(-o.w / 2 + i * o.w / n, h / 2, 0), yaw, 0.15, h, 0.15), c);
               if (o.alive !== false) for (const yy of [0.45, 0.85]) addGeo(acc, box, mat(...at(0, h * yy, 0), yaw, o.w, 0.12, 0.06), c);
            } else addGeo(acc, box, mat(...at(0, h / 2, 0), yaw, o.w, h, o.d || 0.6), c, 0.18);
         }
      }
      if (!acc.p.length) return;
      this.struct = new THREE.Mesh(mergeAcc(acc), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
      this.struct.castShadow = this.struct.receiveShadow = true;
      this.group.add(this.struct);
   }

   /** Dragon's teeth, hedgehogs, wire and bridges, merged into the structures mesh. */
   _feature(acc, o, box) {
      const t = this.t, y = t.groundHeightAt ? t.groundHeightAt(o.x, o.z) : t.heightAt(o.x, o.z), r = hash(o.x, o.z);
      if (o.kind === 'teeth') {
         if (!this._teethGeo) { const g = this._teethGeo = new THREE.CylinderGeometry(0.2, 0.707, 1, 4, 1); g.rotateY(Math.PI / 4); g.translate(0, 0.5, 0); }
         if (o.alive !== false) addGeo(acc, this._teethGeo, mat(o.x, y - 0.15, o.z, o.yaw, o.w, o.h + 0.15, o.d), CONC.clone().multiplyScalar(0.9 + r * 0.15), 0.12);
         else for (let i = 0; i < 4; i++) {
            const a = r * 6.28 + i * 1.7, d = 0.25 + hash(i, r) * 0.5;
            addGeo(acc, box, matYXZ(o.x + Math.cos(a) * d, y + 0.08, o.z + Math.sin(a) * d, a, hash(r, i) - 0.5, hash(i, i + r) - 0.5, 0.5, 0.3, 0.4), CONC.clone().multiplyScalar(0.7), 0.3);
         }
      } else if (o.kind === 'hedgehog') {
         // three perpendicular beams with the (1,1,1) diagonal pointing up: stands on three ends
         const up = Q.setFromUnitVectors(V.set(1, 1, 1).normalize(), S.set(0, 1, 0)).clone(), q = new THREE.Quaternion();
         const tilt = o.alive === false ? new THREE.Quaternion().setFromEuler(E2.set(1.1, o.yaw + 0.7, 0.3, 'YXZ')) : new THREE.Quaternion().setFromAxisAngle(V.set(0, 1, 0), o.yaw);
         q.copy(tilt).multiply(up);
         const s = o.h / 1.15, L = 2 * s;
         for (const sc of [[L, 0.13, 0.13], [0.13, L, 0.13], [0.13, 0.13, L]])
            addGeo(acc, box, M.compose(V.set(o.x, y + (o.alive === false ? 0.25 : 0.577 * s), o.z), q, S.set(...sc)).clone(), STEEL, 0.15);
      } else if (o.kind === 'wire') {
         const key = Math.round(o.w * 2) / 2;
         (this._wireGeo ??= {})[key] ??= (() => {
            const coils = Math.max(3, Math.round(key * 1.8)), N = coils * 10, pts = [];
            for (let i = 0; i <= N; i++) { const a = i / N * coils * Math.PI * 2; pts.push(new THREE.Vector3(-key / 2 + key * i / N, 0.45 + Math.sin(a) * 0.42, Math.cos(a) * 0.42)); }
            return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, 0.02, 3, false);
         })();
         const flat = o.alive === false;
         addGeo(acc, this._wireGeo[key], mat(o.x, y + (flat ? -0.05 : 0), o.z, o.yaw, o.w / key, flat ? 0.2 : 1, flat ? 1.4 : 1), WIREC, 0.2);
         const c = Math.cos(o.yaw), sn = Math.sin(o.yaw), n = Math.max(1, Math.round(o.w / 3));
         if (!flat) for (let i = 0; i <= n; i++) {
            const lx = -o.w / 2 + i * o.w / n, lz = (i % 2 ? 0.35 : -0.35);
            addGeo(acc, box, mat(o.x + lx * c + lz * sn, y + 0.55, o.z - lx * sn + lz * c, o.yaw, 0.05, 1.2, 0.05, 0.08 * (i % 2 ? 1 : -1)), WOOD);
         }
      } else if (o.kind === 'bridge') this._bridge(acc, o, box);
   }
   _bridge(acc, o, box) {
      const t = this.t, L = o.d, dx = (o.x1 - o.x0) / L, dz = (o.z1 - o.z0) / L, yaw = o.yaw, w = o.w, blown = o.alive === false;
      const px = -dz, pz = dx;     // local x (across the deck)
      const brk = [];
      const n = Math.max(3, Math.round(L / 3));
      for (let i = 0; i <= n; i++) brk.push(i / n);
      brk.push(o.gap[0], o.gap[1]); brk.sort((a, b) => a - b);
      const at = (s, lx) => [o.x0 + dx * L * s + px * lx, o.z0 + dz * L * s + pz * lx];
      const yAt = (s) => o.y0 + (o.y1 - o.y0) * s;
      for (let i = 0; i < brk.length - 1; i++) {
         const s0 = brk[i], s1 = brk[i + 1], sm = (s0 + s1) / 2, len = (s1 - s0) * L;
         if (len < 0.05) continue;
         if (blown && sm > o.gap[0] && sm < o.gap[1]) continue;
         const y = yAt(sm), [x, z] = at(sm, 0);
         addGeo(acc, box, mat(x, y - 0.3, z, yaw, w, 0.6, len + 0.02), DECK, 0.1);
         for (const sd of [-1, 1]) {
            const [gx, gz] = at(sm, sd * w * 0.3), [rx, rz] = at(sm, sd * (w / 2 - 0.12));
            addGeo(acc, box, mat(gx, y - 1.15, gz, yaw, 0.45, 1.1, len + 0.02), GIRDER, 0.1);
            addGeo(acc, box, mat(rx, y + 1.0, rz, yaw, 0.1, 0.1, len + 0.02), STEEL);
            const [qx, qz] = at(s0, sd * (w / 2 - 0.12));
            addGeo(acc, box, mat(qx, y + 0.5, qz, yaw, 0.12, 1.0, 0.12), STEEL);
         }
      }
      // piers (only for longer spans) and abutments
      const wl = t.water;
      const bottom = (s) => { const [x, z] = at(s, 0); return Math.min(t.groundHeightAt ? t.groundHeightAt(x, z) : t.heightAt(x, z), wl ?? Infinity) - 4; };
      const piers = L > 24 ? [0.25, 0.75] : [];
      for (const s of piers) {
         const [x, z] = at(s, 0), top = yAt(s) - 1.7, bot = bottom(s);
         if (top > bot) addGeo(acc, box, mat(x, (top + bot) / 2, z, yaw, w * 0.85, top - bot, 1.8), CONC.clone().multiplyScalar(0.8), 0.15);
      }
      for (const s of [0, 1]) {
         const [x, z] = at(s, 0), top = yAt(s) - 0.6, bot = bottom(s);
         addGeo(acc, box, mat(x, (top + bot) / 2, z, yaw, w + 1.2, top - bot, 2.2), CONC.clone().multiplyScalar(0.85), 0.15);
      }
      if (blown) {     // the two broken deck ends hang down into the gap, rubble in the water
         const g0 = o.gap[0], g1 = o.gap[1], hang = 0.12 * L;
         for (const [s, d] of [[g0, 1], [g1, -1]]) {      // d: direction into the gap (+ = towards x1)
            const [x, z] = at(s + d * hang * 0.42 / L, 0);
            addGeo(acc, box, matYXZ(x, yAt(s) - 0.3 - hang * 0.27, z, yaw, -d * 0.55, 0.06, w * 0.9, 0.5, hang), DECK.clone().multiplyScalar(0.8), 0.25);
         }
         const [cx, cz] = at((g0 + g1) / 2, 0), ry = (wl ?? yAt(0.5) - 3) - 0.6;
         for (let i = 0; i < 6; i++) {
            const a = hash(i, o.x) * 6.28, d = hash(o.z, i) * w * 0.6;
            addGeo(acc, box, matYXZ(cx + Math.cos(a) * d, ry, cz + Math.sin(a) * d, a, hash(i, 2) - 0.5, hash(3, i) - 0.5, 2 + hash(i, 4) * 3, 0.8, 1.5 + hash(i, 5) * 2), CONC.clone().multiplyScalar(0.65), 0.3);
         }
      }
   }

   /** Trench ribbons: a fine strip mesh along each trench (exact steep walls and spoil parapet),
    *  plank revetment with posts, a duckboard floor and sandbags on the enemy side. */
   buildTrenches() {
      for (const m of [this.trenchGround, this.trenchProps]) if (m) { this.group.remove(m); m.geometry.dispose(); }
      this.trenchGround = this.trenchProps = null;
      const t = this.t;
      if (!t.trenches?.length) return;
      const step = this.step ?? 2, gh = (x, z) => t.groundHeightAt(x, z), col = new THREE.Color();
      const pos = [], clr = [], uv = [], idx = [], acc = newAcc(), box = new THREE.BoxGeometry(1, 1, 1);
      for (const tr of t.trenches) {
         const hw = tr.w / 2, R = hw + 2.8 + 1.5 * step + 0.3, P = tr.pts;
         const outs = [R, hw + 2.9, hw + 2.6, hw + 2.2, hw + 1.8, hw + 1.4, hw + 1.0, hw + 0.6, hw + 0.25, hw + 0.03, hw - 0.17, hw * 0.45];
         const across = [...outs.map((o) => -o), 0, ...outs.slice().reverse()];
         // centre-line samples with mitred normals; ends extended by R
         const smp = [], segN = [];
         for (let i = 0; i < P.length - 1; i++) {
            const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) || 1;
            segN.push([(P[i + 1][0] - P[i][0]) / L, (P[i + 1][1] - P[i][1]) / L, L]);
         }
         const push = (x, z, ux, uz, m = 1) => smp.push([x, z, -uz * m, ux * m]);
         const [u0x, u0z] = segN[0];
         push(P[0][0] - u0x * R, P[0][1] - u0z * R, u0x, u0z);
         push(P[0][0] - u0x * (hw + 0.6), P[0][1] - u0z * (hw + 0.6), u0x, u0z);
         for (let i = 0; i < segN.length; i++) {
            const [ux, uz, L] = segN[i], k = Math.max(1, Math.round(L / 1));
            if (i === 0) push(P[0][0], P[0][1], ux, uz);
            for (let j = 1; j < k; j++) push(P[i][0] + ux * L * j / k, P[i][1] + uz * L * j / k, ux, uz);
            if (i < segN.length - 1) {
               const [vx, vz] = segN[i + 1]; let mx = ux + vx, mz = uz + vz; const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
               push(P[i + 1][0], P[i + 1][1], mx, mz, Math.min(2, 1 / Math.max(0.3, mx * ux + mz * uz)));
            } else push(P[i + 1][0], P[i + 1][1], ux, uz);
         }
         const [ex, ez] = segN[segN.length - 1], Pe = P[P.length - 1];
         push(Pe[0] + ex * (hw + 0.6), Pe[1] + ez * (hw + 0.6), ex, ez);
         push(Pe[0] + ex * R, Pe[1] + ez * R, ex, ez);
         const base = pos.length / 3, A = across.length;
         for (const [cx, cz, nx, nz] of smp) for (const a of across) {
            const x = cx + nx * a, z = cz + nz * a, h = gh(x, z);
            pos.push(x, h, z); uv.push(x / 9, z / 9);
            const dig = t.trenchDist(x, z);
            if (dig < -0.1) col.copy(EARTH).lerp(EARTH2, hash(x * 2, z * 2) * 0.5);
            else { this._color(x, z, col); if (dig < 2.8) col.lerp(EARTH2, clamp01(1 - dig / 2.8) * 0.55); }
            clr.push(col.r, col.g, col.b);
         }
         for (let s = 0; s < smp.length - 1; s++) for (let a = 0; a < A - 1; a++) {
            const i0 = base + s * A + a, i1 = i0 + 1, i2 = i0 + A, i3 = i2 + 1;
            idx.push(i0, i1, i2, i1, i3, i2);
         }
         // revetment, posts, duckboards, sandbags per segment
         for (let i = 0; i < segN.length; i++) {
            const [ux, uz, L] = segN[i], nx = -uz, nz = ux, yaw = Math.atan2(ux, uz), k = Math.max(1, Math.round(L / 2)), pl = L / k;
            const par = tr.segs[i]?.par || 0;
            for (let j = 0; j < k; j++) {
               const sm = (j + 0.5) * pl, cx = P[i][0] + ux * sm, cz = P[i][1] + uz * sm, floor = gh(cx, cz);
               addGeo(acc, box, mat(cx, floor + 0.04, cz, yaw, hw * 0.8, 0.06, pl - 0.15), WOOD.clone().multiplyScalar(1.15), 0.2);
               for (const sd of [-1, 1]) {
                  const top = gh(cx + nx * sd * (hw + 0.35), cz + nz * sd * (hw + 0.35)), hgt = top - floor + 0.05;
                  addGeo(acc, box, mat(cx + nx * sd * (hw - 0.06), floor + hgt / 2, cz + nz * sd * (hw - 0.06), yaw, 0.08, hgt, pl), WOOD, 0.25);
                  const qx = cx - ux * pl / 2 + nx * sd * (hw - 0.12), qz = cz - uz * pl / 2 + nz * sd * (hw - 0.12);
                  addGeo(acc, box, mat(qx, floor + (hgt + 0.25) / 2, qz, yaw, 0.16, hgt + 0.25, 0.16), WOOD.clone().multiplyScalar(0.8));
               }
            }
            if (par !== 0) {
               const nb = Math.max(1, Math.floor(L / 0.62));
               for (let layer = 0; layer < 2; layer++) for (let b = 0; b < nb - layer; b++) {
                  const s = (b + 0.5 + layer * 0.5) * L / nb, off = hw + 0.42;
                  const x = P[i][0] + ux * s + nx * par * off, z = P[i][1] + uz * s + nz * par * off;
                  addGeo(acc, box, mat(x, gh(x, z) + 0.1 + layer * 0.23, z, yaw + (hash(x, z) - 0.5) * 0.15, 0.42, 0.24, 0.58), BAG, 0.22);
               }
            }
         }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(clr, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
      this.trenchMat ??= Object.assign(this.groundMat.clone(), { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
      this.trenchGround = new THREE.Mesh(g, this.trenchMat); this.trenchGround.receiveShadow = true;
      this.trenchProps = new THREE.Mesh(mergeAcc(acc), this.structMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
      this.trenchProps.castShadow = this.trenchProps.receiveShadow = true;
      this.group.add(this.trenchGround, this.trenchProps);
   }

   // Grass: clumps of 9 thin blades, instanced in a field that wraps around the camera. The
   // vertex shader shrinks each clump to nothing between 34 and 54 m so the edge never pops.
   buildGrass(n) {
      const winter = this.winter;
      if (!n) return;
      if (winter) n = Math.round(n * 0.35);
      const g = new THREE.BufferGeometry(), p = [], c = [];
      for (let b = 0; b < 9; b++) {
         const a = b * 2.39996 + hash(b, 7), rr = 0.05 + hash(b, 2) * 0.16, ox = Math.cos(a) * rr, oz = Math.sin(a) * rr;
         const w = 0.018 + hash(b, 5) * 0.01, h = (0.13 + hash(b, 1) * 0.17) * (winter ? 0.8 : 1);
         const fa = a + 1.57 + hash(b, 3), dx = Math.cos(fa) * w, dz = Math.sin(fa) * w, lean = 0.05 + hash(b, 4) * 0.09;
         const A = [ox - dx, 0, oz - dz], B = [ox + dx, 0, oz + dz], T = [ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean];
         p.push(...A, ...B, ...T, ...B, ...A, ...T);   // both windings: no back-face normal flip
         const v = 0.92 + hash(b, 6) * 0.14;
         for (let k = 0; k < 2; k++) c.push(0.7 * v, 0.72 * v, 0.66 * v, 0.7 * v, 0.72 * v, 0.66 * v, 1.0 * v, 1.02 * v, 0.92 * v);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(p.length).map((_, i) => i % 3 === 1 ? 1 : 0), 3)); // up-facing: lit like the ground
      const m = new THREE.MeshLambertMaterial({ vertexColors: true });
      m.onBeforeCompile = (sh) => {
         sh.uniforms.uWind = WIND.uWind;
         sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
uniform float uWind;`).replace('#include <begin_vertex>', `
            vec3 transformed = vec3(position);
            #ifdef USE_INSTANCING
               vec3 gOrg = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
               float gph = uWind * 2.6 + gOrg.x * 0.13 + gOrg.z * 0.09;
               transformed.xz += vec2(sin(gph), sin(gph * 0.7 + 1.3) * 0.6) * position.y * 0.35;
               transformed *= 1.0 - smoothstep(34.0, 54.0, distance(gOrg.xz, cameraPosition.xz));
            #endif`);
      };
      m.customProgramCacheKey = () => 'pz-grass';
      const im = this.grass = new THREE.InstancedMesh(g, m, n);
      im.frustumCulled = false;
      this.grassSpan = 110; this.grassBase = new Float32Array(n * 2); this.grassCell = new Int32Array(n * 2).fill(-99999);
      const col = new THREE.Color(), straw = C(0xb7a77a);
      for (let i = 0; i < n; i++) {
         this.grassBase[i * 2] = hash(i, 0.31) * this.grassSpan; this.grassBase[i * 2 + 1] = hash(0.71, i) * this.grassSpan;
         if (winter) col.copy(straw).multiplyScalar(0.8 + hash(i, 9) * 0.25);
         else col.copy(this.pal.grass).lerp(this.pal.grass2, hash(i, 9) * 0.7).multiplyScalar(0.98 + hash(i, 4) * 0.1);
         im.setColorAt(i, col);
      }
      this.group.add(im);
   }

   dispose() {
      this.scene.remove(this.group);
      const seen = new Set();
      this.group.traverse((o) => { for (const r of [o.geometry, ...(Array.isArray(o.material) ? o.material : [o.material])]) if (r && !seen.has(r)) { seen.add(r); r.map?.dispose?.(); r.dispose?.(); } });
      this.detail?.dispose?.();
   }
   update(cam, dt = 1 / 60) {
      const t = this.t;
      WIND.uWind.value += dt;
      if (t.bridges) for (const b of t.bridges) if (b.alive === false && !b.blown) t.blowBridge(b);   // replicated (net) blow
      if ((t.heightVersion ?? 0) !== this.hver) {
         this.hver = t.heightVersion ?? 0;
         const edits = t.heightEdits || [], size = 2 * (t.half ?? 500) / this.CH, half = t.half ?? 500, m = 2 * this.step;
         const dirty = new Set();
         for (; this.hedit < edits.length; this.hedit++) {
            const e = edits[this.hedit];
            const i0 = Math.max(0, Math.floor((e.x0 - m + half) / size)), i1 = Math.min(this.CH - 1, Math.floor((e.x1 + m + half) / size));
            const j0 = Math.max(0, Math.floor((e.z0 - m + half) / size)), j1 = Math.min(this.CH - 1, Math.floor((e.z1 + m + half) / size));
            for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) dirty.add(j * this.CH + i);
         }
         for (const k of dirty) this._buildChunk(k % this.CH, Math.floor(k / this.CH));
         this.buildTrenches();
         this.version = -1;      // re-place instances and structures on the new heights
      }
      if ((t.version ?? 0) !== this.version) {
         this.version = t.version ?? 0;
         for (const k in this.inst) this._placeInstances(k);
         this.buildStructures();
      }
      const im = this.grass; if (!im) return;
      const span = this.grassSpan, half = t.half ?? 500, n = im.count, base = this.grassBase, cell = this.grassCell;
      let dirty = false;
      for (let i = 0; i < n; i++) {
         const bx = base[i * 2], bz = base[i * 2 + 1];
         const kx = Math.floor((cam.x - bx) / span + 0.5), kz = Math.floor((cam.z - bz) / span + 0.5);
         if (kx === cell[i * 2] && kz === cell[i * 2 + 1]) continue;
         cell[i * 2] = kx; cell[i * 2 + 1] = kz; dirty = true;
         const x = bx + kx * span, z = bz + kz * span;
         let s = 0.8 + hash(x, z) * 0.6;
         if (Math.abs(x) > half || Math.abs(z) > half) s = 0;
         else { const gc = t.groundAt ? t.groundAt(x, z) : 'medium'; if (gc === 'road' || gc === 'water' || gc === 'hard' || (t.normalAt && t.normalAt(x, z).y < 0.85)) s = 0;
            else if ((t.coast && t.coastS(x, z) > -t.coast.beach * 0.75) || (t.trenches?.length && t.trenchDist(x, z) < 0.6)) s = 0; }
         M.compose(V.set(x, t.heightAt(x, z) - 0.05, z), Q.setFromEuler(E.set(0, hash(z, x) * 6.28, 0)), S.set(s, s, s));
         im.setMatrixAt(i, M);
      }
      if (dirty) im.instanceMatrix.needsUpdate = true;
   }
}
