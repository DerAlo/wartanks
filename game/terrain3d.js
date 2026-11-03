// game/terrain3d.js — the visible battlefield built from terrain.js: ground mesh (4×4 chunks,
// vertex colours by ground class / slope / height + a tiled detail texture), a low-res outer ring
// to the horizon, water, instanced trees / bushes / rocks, merged houses and walls, and a field of
// grass clumps that wraps around the camera. Destructible objects follow terrain.version.
import * as THREE from '../vendor/three/three.module.min.js';

const C = (h) => new THREE.Color(h);
const PALETTES = {
   summer: { grass: C(0x6b7a3a), grass2: C(0x857f45), dirt: C(0x7a6544), rock: C(0x7c776c), road: C(0x9a8a66), sand: C(0xb3a273), soft: C(0x5b5a34), snow: C(0xe8ecef), tree: C(0x3f5a26), tree2: C(0x56682c), pine: C(0x2c4422), bush: C(0x4c6229) },
   winter: { grass: C(0xdfe5ea), grass2: C(0xc9d2d8), dirt: C(0x8d8578), rock: C(0x6f6e6a), road: C(0xa59e8d), sand: C(0xcfcfc8), soft: C(0xb8c0c4), snow: C(0xf2f5f7), tree: C(0x3a4a2c), tree2: C(0x4a5a34), pine: C(0x24361f), bush: C(0x5a6648) },
   steppe: { grass: C(0x8a8a48), grass2: C(0xa49a58), dirt: C(0x86704a), rock: C(0x8a8274), road: C(0xa8956a), sand: C(0xbfae7a), soft: C(0x6d6a3a), snow: C(0xe8ecef), tree: C(0x4d6229), tree2: C(0x657236), pine: C(0x33482a), bush: C(0x5f6b30) },
};

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
   const g = geo.index ? geo.toNonIndexed() : geo;
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

function treeGeo(kind, pal) {
   const acc = newAcc(), trunk = C(0x4a3826);
   if (kind === 'pine') {
      addGeo(acc, new THREE.CylinderGeometry(0.18, 0.3, 4, 5), mat(0, 2, 0), trunk);
      for (let i = 0; i < 3; i++) addGeo(acc, new THREE.ConeGeometry(2.6 - i * 0.65, 4.2 - i * 0.6, 7), mat(0, 3.6 + i * 2.4, 0, i), C(0xffffff), 0.25);
   } else {
      addGeo(acc, new THREE.CylinderGeometry(0.2, 0.35, 4.5, 5), mat(0, 2.2, 0), trunk);
      const ico = new THREE.IcosahedronGeometry(2.6, 1), pa = ico.attributes.position;
      for (let i = 0; i < pa.count; i++) { const k = 0.8 + hash(pa.getX(i) * 5, pa.getZ(i) * 5 + pa.getY(i)) * 0.4; pa.setXYZ(i, pa.getX(i) * k, pa.getY(i) * k, pa.getZ(i) * k); }
      ico.computeVertexNormals();
      addGeo(acc, ico, mat(0, 6, 0, 0, 1.15, 1, 1.15), C(0xffffff), 0.3);
      addGeo(acc, ico.clone(), mat(1.3, 4.9, 0.6, 1, 0.75, 0.7, 0.75), C(0xffffff), 0.3);
      addGeo(acc, ico.clone(), mat(-1.1, 5.1, -0.8, 2, 0.7, 0.7, 0.7), C(0xffffff), 0.3);
   }
   // trunk stays brown: mark trunk vertices by colour (instance colour multiplies all, so pre-divide)
   return mergeAcc(acc);
}

export class Terrain3D {
   constructor(scene, terrain, theme = {}, q = {}) {
      this.scene = scene; this.t = terrain; this.q = q;
      this.group = new THREE.Group(); scene.add(this.group);
      const pid = theme.palette && PALETTES[theme.palette] ? theme.palette : (/winter|schnee/i.test(theme.id || '') ? 'winter' : /steppe/i.test(theme.id || '') ? 'steppe' : 'summer');
      this.pal = { ...PALETTES[pid], ...(theme.colors ? Object.fromEntries(Object.entries(theme.colors).map(([k, v]) => [k, C(v)])) : {}) };
      this.detail = detailTexture();
      this.groundMat = new THREE.MeshStandardMaterial({ vertexColors: true, map: this.detail, roughness: 0.97, metalness: 0 });
      this.vegMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
      this.buildGround();
      this.buildWater();
      this.buildObjects();
      this.buildGrass(q.grass ?? 6000);
      this.version = terrain.version ?? 0;
   }

   _color(x, z, out) {
      const t = this.t, P = this.pal, h = t.heightAt(x, z), nrm = t.normalAt ? t.normalAt(x, z) : { y: 1 };
      const slope = 1 - nrm.y, cls = t.groundAt ? t.groundAt(x, z) : 'medium';
      const n1 = fbm(x * 0.012, z * 0.012), n2 = fbm(x * 0.06 + 7, z * 0.06);
      out.copy(P.grass).lerp(P.grass2, Math.min(1, n1 * 1.3));
      if (cls === 'soft') out.lerp(P.soft, 0.7);
      else if (cls === 'hard') out.lerp(P.dirt, 0.35);
      out.lerp(P.dirt, Math.max(0, Math.min(1, (slope - 0.12) * 4)) * 0.8);
      out.lerp(P.rock, Math.max(0, Math.min(1, (slope - 0.3) * 4)));
      if (cls === 'road') out.lerp(P.road, 0.85);
      if (t.water != null) { const d = h - t.water; if (d < 1.6) out.lerp(P.sand, Math.max(0, Math.min(1, 1 - d / 1.6)) * 0.8); }
      out.multiplyScalar(0.88 + n2 * 0.24);
      return out;
   }

   buildGround() {
      const t = this.t, half = t.half ?? 500, step = this.q.veg < 0.5 ? 4 : 2, CH = 4;
      const cells = Math.round(2 * half / step), per = cells / CH, col = new THREE.Color();
      for (let cz = 0; cz < CH; cz++) for (let cx = 0; cx < CH; cx++) {
         const n = per + 1, pos = new Float32Array(n * n * 3), clr = new Float32Array(n * n * 3), uv = new Float32Array(n * n * 2), nor = new Float32Array(n * n * 3);
         for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
            const x = -half + (cx * per + i) * step, z = -half + (cz * per + j) * step, k = j * n + i;
            pos[k * 3] = x; pos[k * 3 + 1] = t.heightAt(x, z); pos[k * 3 + 2] = z;
            const nm = t.normalAt ? t.normalAt(x, z) : { x: 0, y: 1, z: 0 };
            nor[k * 3] = nm.x; nor[k * 3 + 1] = nm.y; nor[k * 3 + 2] = nm.z;
            this._color(x, z, col); clr[k * 3] = col.r; clr[k * 3 + 1] = col.g; clr[k * 3 + 2] = col.b;
            uv[k * 2] = x / 9; uv[k * 2 + 1] = z / 9;
         }
         const idx = new Uint32Array(per * per * 6); let w = 0;
         for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
            const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
            idx[w++] = a; idx[w++] = c; idx[w++] = b; idx[w++] = b; idx[w++] = c; idx[w++] = d;
         }
         const g = new THREE.BufferGeometry();
         g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
         g.setAttribute('color', new THREE.BufferAttribute(clr, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
         g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeBoundingSphere();
         const m = new THREE.Mesh(g, this.groundMat); m.receiveShadow = true; this.group.add(m);
      }
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
         pos.push(px, h0 * (1 - Math.min(1, f * 2)) + hill + (f === 0 ? -0.05 : 0), pz);
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
         if (o.kind === 'tree') ((o.seed ?? hash(o.x, o.z) * 1e4) % 3 < 1.2 || this.pal === PALETTES.winter ? kinds.pine : kinds.tree).push(o);
         else if (o.kind === 'bush') kinds.bush.push(o);
         else if (o.kind === 'rock') kinds.rock.push(o);
      }
      const bushGeo = new THREE.IcosahedronGeometry(1, 1); bushGeo.scale(1, 0.62, 1); bushGeo.translate(0, 0.35, 0);
      const rockGeo = new THREE.DodecahedronGeometry(1, 0); rockGeo.translate(0, 0.25, 0);
      for (const g of [bushGeo, rockGeo]) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
      const defs = {
         tree: [treeGeo('tree'), P.tree, 6.5, true], pine: [treeGeo('pine'), P.pine, 9, true],
         bush: [bushGeo, P.bush, 1.6, false], rock: [rockGeo, P.rock, 1.4, true],
      };
      this.inst = {};
      for (const k in kinds) {
         const list = kinds[k].filter((o, i) => o.solid || k !== 'bush' || hash(i, 3) < Math.max(0.6, veg));
         if (!list.length) continue;
         const [geo, color, nominal, shadow] = defs[k];
         const im = new THREE.InstancedMesh(geo, this.vegMat, list.length);
         im.castShadow = shadow; im.receiveShadow = true;
         const cc = new THREE.Color();
         list.forEach((o, i) => {
            const sz = (o.h || nominal) / nominal;
            cc.copy(color).multiplyScalar(0.8 + hash(o.x, o.z) * 0.4); if (k === 'tree' && hash(o.z, o.x) > 0.5) cc.lerp(P.tree2, 0.6);
            im.setColorAt(i, cc);
         });
         this.inst[k] = { im, list };
         this._placeInstances(k);
         this.group.add(im);
      }
      this.buildStructures();
   }

   _placeInstances(k) {
      const { im, list } = this.inst[k], nominal = k === 'tree' ? 6.5 : k === 'pine' ? 9 : k === 'bush' ? 1.6 : 1.4;
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
         im.setMatrixAt(i, M);
      });
      im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere?.();
   }

   buildStructures() {
      if (this.struct) { this.group.remove(this.struct); this.struct.geometry.dispose(); }
      const t = this.t, acc = newAcc(), box = new THREE.BoxGeometry(1, 1, 1);
      const wallC = [C(0xb9ae94), C(0xa79b80), C(0xcfc6ad), C(0x9a8f7a)], roofC = [C(0x8a3f2a), C(0x6e3b2c), C(0x5b5148)];
      const roof = new THREE.BufferGeometry();
      // unit gable prism: ridge along x, width z -0.5..0.5, height 0..1
      roof.setAttribute('position', new THREE.Float32BufferAttribute([
         -0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, 0, -0.5, 0, -0.5, 0.5, 1, 0, -0.5, 1, 0,
         0.5, 0, 0.5, -0.5, 0, 0.5, -0.5, 1, 0, 0.5, 0, 0.5, -0.5, 1, 0, 0.5, 1, 0,
         -0.5, 0, 0.5, -0.5, 0, -0.5, -0.5, 1, 0, 0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 1, 0], 3));
      roof.computeVertexNormals();
      for (const o of t.objects || []) {
         if (o.kind !== 'house' && o.kind !== 'wall' && o.kind !== 'fence') continue;
         o.d ??= 0.6; o.w ??= 2;
         const y = Math.min(t.heightAt(o.x - o.w / 2, o.z), t.heightAt(o.x + o.w / 2, o.z), t.heightAt(o.x, o.z - o.d / 2), t.heightAt(o.x, o.z + o.d / 2)) - 0.3;
         const r = hash(o.x, o.z), yaw = o.yaw || 0, cos = Math.cos(yaw), sin = Math.sin(yaw);
         const at = (lx, ly, lz) => [o.x + lx * cos + lz * sin, y + ly, o.z - lx * sin + lz * cos];
         if (o.kind === 'house') {
            const h = o.h || 6, wc = wallC[Math.floor(r * 4)], rc = roofC[Math.floor(hash(o.z, o.x) * 3)];
            if (o.alive === false) {
               addGeo(acc, box, mat(...at(0, h * 0.12, 0), yaw, o.w, h * 0.3, o.d), wc.clone().multiplyScalar(0.6), 0.4);
               addGeo(acc, box, mat(...at(o.w * 0.3, h * 0.25, 0), yaw, 0.6, h * 0.5, o.d * 0.9, 0, 0.1), wc.clone().multiplyScalar(0.7), 0.3);
               continue;
            }
            const wallH = h * 0.62;
            addGeo(acc, box, mat(...at(0, wallH / 2 + 0.3, 0), yaw, o.w, wallH + 0.6, o.d), wc, 0.08);
            addGeo(acc, box, mat(...at(0, 0.35, 0), yaw, o.w + 0.15, 0.7, o.d + 0.15), C(0x6c6558));
            addGeo(acc, roof, mat(...at(0, wallH + 0.6, 0), yaw, o.w + 0.6, h - wallH, o.d + 0.6), rc, 0.15);
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

   buildGrass(n) {
      if (!n || this.pal === PALETTES.winter) return;
      const g = new THREE.BufferGeometry(), p = [], c = [];
      for (let b = 0; b < 5; b++) {
         const a = b * 2.4, ox = Math.cos(a) * 0.18, oz = Math.sin(a) * 0.18, w = 0.045, h = 0.22 + hash(b, 1) * 0.22;
         const dx = Math.cos(a + 1.57) * w, dz = Math.sin(a + 1.57) * w, lean = 0.15;
         const A = [ox - dx, 0, oz - dz], B = [ox + dx, 0, oz + dz], T = [ox + Math.cos(a) * lean, h, oz + Math.sin(a) * lean];
         p.push(...A, ...B, ...T, ...B, ...A, ...T);   // both windings: no back-face normal flip
         for (let k = 0; k < 2; k++) c.push(0.62, 0.66, 0.58, 0.62, 0.66, 0.58, 0.98, 1.02, 0.9);
      }
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(p.length).map((_, i) => i % 3 === 1 ? 1 : 0), 3)); // up-facing: lit like the ground
      const m = new THREE.MeshLambertMaterial({ vertexColors: true });
      const im = this.grass = new THREE.InstancedMesh(g, m, n);
      im.frustumCulled = false;
      this.grassSpan = 110; this.grassBase = new Float32Array(n * 2); this.grassCell = new Int32Array(n * 2).fill(-99999);
      const col = new THREE.Color();
      for (let i = 0; i < n; i++) {
         this.grassBase[i * 2] = hash(i, 0.31) * this.grassSpan; this.grassBase[i * 2 + 1] = hash(0.71, i) * this.grassSpan;
         col.copy(this.pal.grass).lerp(this.pal.grass2, hash(i, 9)).multiplyScalar(1.05); im.setColorAt(i, col);
      }
      this.group.add(im);
   }

   update(cam) {
      const t = this.t;
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
         else { const gc = t.groundAt ? t.groundAt(x, z) : 'medium'; if (gc === 'road' || gc === 'water' || gc === 'hard' || (t.normalAt && t.normalAt(x, z).y < 0.85)) s = 0; }
         M.compose(V.set(x, t.heightAt(x, z) - 0.05, z), Q.setFromEuler(E.set(0, hash(z, x) * 6.28, 0)), S.set(s, s, s));
         im.setMatrixAt(i, M);
      }
      if (dirty) im.instanceMatrix.needsUpdate = true;
   }
}
