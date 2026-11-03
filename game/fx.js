// game/fx.js — battle effects. Everything is pooled: two GPU point-particle systems (alpha-blended
// smoke/dust/dirt and additive fire/flash/sparks/tracers) with ring-buffer allocation, one
// LineSegments for shell tracers, one InstancedMesh for debris, one ring-buffer mesh for track
// marks. No per-frame allocations. Driven by sim state (lastFire, speed, burning, alive, shells,
// terrain.version) plus world.events (pen/ricochet/noPen/he/ammoRack/kill) and world.effects.
import * as THREE from '../vendor/three/three.module.min.js';

const PVS = `
attribute vec4 pcol; attribute float psize; uniform float uScale; varying vec4 vCol; varying float vFog;
void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
   gl_PointSize = psize * uScale / max(0.5, -mv.z); vCol = pcol; vFog = -mv.z; }`;
const PFS = `
uniform vec3 uFogColor; uniform float uFogNear, uFogFar, uAdd; varying vec4 vCol; varying float vFog;
void main() { vec2 c = gl_PointCoord - 0.5; float d = length(c) * 2.0; if (d > 1.0 || vCol.a <= 0.003) discard;
   float a = vCol.a * (uAdd > 0.5 ? pow(1.0 - d, 1.6) : (1.0 - d * d) * (0.75 + 0.25 * sin(c.x * 11.0 + c.y * 7.0)));
   float f = smoothstep(uFogNear, uFogFar, vFog);
   vec3 col = uAdd > 0.5 ? vCol.rgb : mix(vCol.rgb, uFogColor, f);
   gl_FragColor = vec4(col * (uAdd > 0.5 ? (1.0 - f) : 1.0), a); }`;

class Particles {
   constructor(n, additive, fog) {
      this.n = n; this.i = 0;
      this.pos = new Float32Array(n * 3); this.col = new Float32Array(n * 4); this.size = new Float32Array(n);
      this.vel = new Float32Array(n * 3); this.life = new Float32Array(n); this.max = new Float32Array(n);
      this.s0 = new Float32Array(n); this.s1 = new Float32Array(n); this.c0 = new Float32Array(n * 4); this.c1 = new Float32Array(n * 3);
      this.grav = new Float32Array(n); this.drag = new Float32Array(n);
      const g = this.geo = new THREE.BufferGeometry();
      this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
      this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
      this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', this.aPos); g.setAttribute('pcol', this.aCol); g.setAttribute('psize', this.aSize);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      this.mat = new THREE.ShaderMaterial({
         vertexShader: PVS, fragmentShader: PFS, transparent: true, depthWrite: false,
         blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
         uniforms: { uScale: { value: 500 }, uFogColor: { value: fog.color }, uFogNear: { value: fog.near }, uFogFar: { value: fog.far }, uAdd: { value: additive ? 1 : 0 } },
      });
      this.pts = new THREE.Points(g, this.mat); this.pts.frustumCulled = false; this.pts.renderOrder = additive ? 3 : 2;
   }
   // colour ramps from (r,g,b,a) to (r1,g1,b1, alpha→0)
   spawn(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, a, r1, g1, b1, grav = 0, drag = 0.5) {
      const i = this.i; this.i = (i + 1) % this.n;
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
      this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
      this.life[i] = life; this.max[i] = life; this.s0[i] = s0; this.s1[i] = s1;
      this.c0[i * 4] = r; this.c0[i * 4 + 1] = g; this.c0[i * 4 + 2] = b; this.c0[i * 4 + 3] = a;
      this.c1[i * 3] = r1; this.c1[i * 3 + 1] = g1; this.c1[i * 3 + 2] = b1;
      this.grav[i] = grav; this.drag[i] = drag;
   }
   update(dt) {
      const { pos, vel, life, max, col, size, c0, c1 } = this;
      for (let i = 0; i < this.n; i++) {
         if (life[i] <= 0) { if (size[i] !== 0) { size[i] = 0; col[i * 4 + 3] = 0; } continue; }
         life[i] -= dt;
         const k = 1 - Math.max(0, life[i]) / max[i], dr = Math.max(0, 1 - this.drag[i] * dt);
         vel[i * 3] *= dr; vel[i * 3 + 2] *= dr; vel[i * 3 + 1] = vel[i * 3 + 1] * dr - this.grav[i] * dt;
         pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
         size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(k);
         col[i * 4] = c0[i * 4] + (c1[i * 3] - c0[i * 4]) * k; col[i * 4 + 1] = c0[i * 4 + 1] + (c1[i * 3 + 1] - c0[i * 4 + 1]) * k;
         col[i * 4 + 2] = c0[i * 4 + 2] + (c1[i * 3 + 2] - c0[i * 4 + 2]) * k;
         col[i * 4 + 3] = c0[i * 4 + 3] * (k < 0.08 ? k / 0.08 : 1 - (k - 0.08) / 0.92);
      }
      this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
   }
}

const MAX_TR = 64, MAX_DEB = 160, MAX_MARK = 2400;
const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;

export class FX {
   constructor(scene, world, q = {}) {
      this.scene = scene; this.w = world; this.q = q; this.k = q.fxScale ?? 1;
      this.group = new THREE.Group(); scene.add(this.group);
      const fog = scene.fog || { color: new THREE.Color(0xb9c2b8), near: 260, far: 1150 };
      this.smoke = new Particles(Math.round(5000 * this.k), false, fog);
      this.glow = new Particles(Math.round(3000 * this.k), true, fog);
      this.group.add(this.smoke.pts, this.glow.pts);
      this.winter = /winter|schnee/i.test(world.mapId || world.terrain?.theme || '');
      // tracers
      const tg = new THREE.BufferGeometry(); this.trPos = new Float32Array(MAX_TR * 6); this.trCol = new Float32Array(MAX_TR * 6);
      tg.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
      tg.setAttribute('color', new THREE.BufferAttribute(this.trCol, 3).setUsage(THREE.DynamicDrawUsage));
      tg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      this.tracers.frustumCulled = false; this.group.add(this.tracers);
      // debris
      const dg = new THREE.BoxGeometry(0.35, 0.18, 0.28);
      this.deb = new THREE.InstancedMesh(dg, new THREE.MeshStandardMaterial({ color: 0x3a3530, roughness: 1, flatShading: true }), MAX_DEB);
      this.deb.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.deb.frustumCulled = false; this.deb.castShadow = false;
      this.debS = new Float32Array(MAX_DEB * 10); this.debI = 0; this.group.add(this.deb);
      this.M = new THREE.Matrix4(); this.Q = new THREE.Quaternion(); this.E = new THREE.Euler(); this.V = new THREE.Vector3(); this.S = new THREE.Vector3();
      this.M.makeScale(0, 0, 0); for (let i = 0; i < MAX_DEB; i++) this.deb.setMatrixAt(i, this.M);
      // track marks: quads in a ring buffer; alpha fades with age in the shader
      const mg = new THREE.BufferGeometry(); this.mkPos = new Float32Array(MAX_MARK * 12); this.mkBirth = new Float32Array(MAX_MARK * 4).fill(-1e4);
      const idx = new Uint32Array(MAX_MARK * 6);
      for (let i = 0; i < MAX_MARK; i++) { const a = i * 4; idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6); }
      mg.setAttribute('position', new THREE.BufferAttribute(this.mkPos, 3).setUsage(THREE.DynamicDrawUsage));
      mg.setAttribute('birth', new THREE.BufferAttribute(this.mkBirth, 1).setUsage(THREE.DynamicDrawUsage));
      mg.setIndex(new THREE.BufferAttribute(idx, 1)); mg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
      this.mkMat = new THREE.ShaderMaterial({
         transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
         uniforms: { uTime: { value: 0 }, uCol: { value: new THREE.Color(this.winter ? 0x8f969a : 0x2d2618) } },
         vertexShader: 'attribute float birth; uniform float uTime; varying float vA; void main(){ vA = clamp(1.0 - (uTime - birth) / 50.0, 0.0, 1.0) * 0.42; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
         fragmentShader: 'uniform vec3 uCol; varying float vA; void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(uCol, vA); }',
      });
      this.marks = new THREE.Mesh(mg, this.mkMat); this.marks.frustumCulled = false; this.marks.renderOrder = 1; this.group.add(this.marks);
      this.mkI = 0; this.time = 0;
      this.ts = new Map();   // per-tank scratch: { lastFire, lx, lz, acc }
      this.lastSeq = -1;
      this.objAlive = (world.terrain?.objects || []).map((o) => o.alive !== false);
      this.tver = world.terrain?.version ?? 0;
      this.shellSeen = new Map(); this.mp = { x: 0, y: 0, z: 0 }; this.md = { x: 0, y: 0, z: 0 };
   }
   dispose() { this.scene.remove(this.group); this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); }

   // ---------- effect recipes ----------
   muzzle(x, y, z, dx, dy, dz, cal = 75) {
      const k = cal / 75, S = this.smoke, G = this.glow;
      for (let i = 0; i < 6; i++) { const v = 8 + i * 6; G.spawn(x + dx * i * 0.35, y + dy * i * 0.35, z + dz * i * 0.35, dx * v, dy * v, dz * v, 0.09 + Math.random() * 0.05, 2.6 * k, 4 * k, 1, 0.85, 0.5, 1, 1, 0.4, 0.1, 0, 4); }
      for (let i = 0; i < 4; i++) G.spawn(x, y, z, rnd(6), rnd(6), rnd(6), 0.07, 2.2 * k, 3.2 * k, 1, 0.7, 0.35, 0.9, 0.8, 0.2, 0.05);
      for (let i = 0; i < 14 * this.k; i++) { const v = 4 + Math.random() * 14; S.spawn(x + dx, y + dy, z + dz, dx * v + rnd(2.5), dy * v + rnd(1.5) + 0.6, dz * v + rnd(2.5), 2.2 + Math.random() * 2.2, 1.5 * k, 6 * k, 0.78, 0.76, 0.72, 0.45, 0.82, 0.8, 0.78, -0.25, 1.4); }
   }
   groundRing(x, y, z, cal = 75) {
      const k = cal / 75, c = this.dustCol(x, z);
      for (let i = 0; i < 18 * this.k; i++) { const a = i / 18 * 6.283, v = 7 + Math.random() * 5; this.smoke.spawn(x + Math.cos(a), y + 0.3, z + Math.sin(a), Math.cos(a) * v, 0.6 + Math.random(), Math.sin(a) * v, 1.6 + Math.random() * 1.2, 1.4 * k, 4.5 * k, c[0], c[1], c[2], 0.4, c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, -0.1, 2.2); }
   }
   sparks(x, y, z, nx, ny, nz, n = 18, hot = 1) {
      for (let i = 0; i < n * this.k; i++) { const v = 8 + Math.random() * 22; this.glow.spawn(x, y, z, (nx + rnd(0.8)) * v, (ny + rnd(0.8)) * v + 2, (nz + rnd(0.8)) * v, 0.25 + Math.random() * 0.35, 0.35, 0.12, 1, 0.85 * hot + 0.1, 0.45 * hot, 1, 1, 0.4, 0.05, 9.81, 0.8); }
      this.glow.spawn(x, y, z, 0, 0, 0, 0.08, 3, 5, 1, 0.95, 0.75, 1, 1, 0.6, 0.2);
   }
   penFlash(x, y, z) {
      for (let i = 0; i < 6; i++) this.glow.spawn(x + rnd(0.3), y + rnd(0.3), z + rnd(0.3), rnd(3), rnd(3), rnd(3), 0.18 + Math.random() * 0.1, 3, 6, 1, 0.75, 0.35, 1, 1, 0.3, 0.05, 0, 3);
      for (let i = 0; i < 8; i++) this.smoke.spawn(x, y, z, rnd(2), 1 + Math.random() * 2, rnd(2), 1.5 + Math.random(), 1, 3.5, 0.25, 0.23, 0.2, 0.7, 0.4, 0.38, 0.36, -0.4, 1.5);
      this.sparks(x, y, z, 0, 0.5, 0, 12, 1);
   }
   dirt(x, y, z, size = 1) {
      const c = this.dustCol(x, z), mud = this.winter ? [0.92, 0.94, 0.96] : [0.3, 0.25, 0.18];
      for (let i = 0; i < 16 * this.k * size; i++) this.smoke.spawn(x, y, z, rnd(2.5) * size, (5 + Math.random() * 9) * size, rnd(2.5) * size, 0.9 + Math.random() * 0.6, 0.5 * size, 1.2 * size, mud[0], mud[1], mud[2], 0.95, mud[0], mud[1], mud[2], 13, 0.6);
      for (let i = 0; i < 10 * this.k * size; i++) this.smoke.spawn(x + rnd(0.5), y + 0.4, z + rnd(0.5), rnd(3) * size, (1 + Math.random() * 3) * size, rnd(3) * size, 1.8 + Math.random() * 1.5, 1.2 * size, 4.5 * size, c[0], c[1], c[2], 0.55, c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, -0.1, 1.6);
   }
   explosion(x, y, z, size = 1, debris = 6) {
      for (let i = 0; i < 16 * size; i++) { const v = (4 + Math.random() * 10) * size; this.glow.spawn(x, y + 0.5, z, rnd(1) * v, Math.random() * v, rnd(1) * v, 0.25 + Math.random() * 0.3, 2 * size, 5 * size, 1, 0.7, 0.3, 1, 0.9, 0.25, 0.04, -1, 3); }
      this.glow.spawn(x, y + 1, z, 0, 0, 0, 0.12, 8 * size, 14 * size, 1, 0.9, 0.6, 1, 1, 0.5, 0.1);
      for (let i = 0; i < 26 * this.k * size; i++) this.smoke.spawn(x + rnd(size), y + 0.5, z + rnd(size), rnd(4) * size, (2 + Math.random() * 6) * size, rnd(4) * size, 3 + Math.random() * 3, 2 * size, 9 * size, 0.18, 0.16, 0.14, 0.85, 0.45, 0.43, 0.4, -0.6, 1.2);
      this.dirt(x, y, z, size * 0.9);
      for (let i = 0; i < debris; i++) this.debris(x, y + 0.6, z, rnd(7) * size, (6 + Math.random() * 10) * size, rnd(7) * size);
   }
   debris(x, y, z, vx, vy, vz) {
      const s = this.debS, i = this.debI * 10; this.debI = (this.debI + 1) % MAX_DEB;
      s[i] = x; s[i + 1] = y; s[i + 2] = z; s[i + 3] = vx; s[i + 4] = vy; s[i + 5] = vz; s[i + 6] = Math.random() * 6; s[i + 7] = rnd(9); s[i + 8] = 6 + Math.random() * 4; s[i + 9] = 0.6 + Math.random() * 1.2;
   }
   dustCol(x, z) {
      if (this.winter) return [0.9, 0.92, 0.95];
      const gc = this.w.terrain?.groundAt?.(x, z);
      return gc === 'soft' ? [0.36, 0.31, 0.22] : gc === 'road' ? [0.72, 0.65, 0.5] : gc === 'hard' ? [0.62, 0.55, 0.42] : [0.55, 0.5, 0.38];
   }
   mark(x, z, yaw, w, len, y) {
      const i = this.mkI, p = this.mkPos, o = i * 12; this.mkI = (i + 1) % MAX_MARK;
      const fx = -Math.sin(yaw) * len / 2, fz = -Math.cos(yaw) * len / 2, rx = Math.cos(yaw) * w / 2, rz = -Math.sin(yaw) * w / 2, T = this.w.terrain;
      const P = [[x - rx - fx, z - rz - fz], [x + rx - fx, z + rz - fz], [x - rx + fx, z - rz + fz], [x + rx + fx, z + rz + fz]];
      for (let k = 0; k < 4; k++) { p[o + k * 3] = P[k][0]; p[o + k * 3 + 2] = P[k][1]; p[o + k * 3 + 1] = (T?.heightAt?.(P[k][0], P[k][1]) ?? y) + 0.04; this.mkBirth[i * 4 + k] = this.time; }
      this.marks.geometry.attributes.position.needsUpdate = true; this.marks.geometry.attributes.birth.needsUpdate = true;
   }

   // muzzle position/direction of a tank
   gunTip(t, out, dir) {
      const A = window.__game?.mods?.armorM;
      if (A?.gunWorld && t.cfg?.gun?.pivot && t.pose) { try { A.gunWorld(t.cfg, t.pose(), out, dir); if (Number.isFinite(out.x)) return; } catch { /* fall back */ } }
      const yaw = (t.yaw || 0) + (t.turretYaw || 0), gp = (t.gunPitch || 0) + (t.pitch || 0), len = (t.cfg?.gun?.len ?? 4) + 1.2;
      dir.x = -Math.sin(yaw) * Math.cos(gp); dir.y = Math.sin(gp); dir.z = -Math.cos(yaw) * Math.cos(gp);
      out.x = t.pos.x + dir.x * len; out.y = t.pos.y + (t.cfg?.dims?.h ?? 2.3) * 0.82 + dir.y * len; out.z = t.pos.z + dir.z * len;
   }

   onHit(type, e) {
      const p = e.pos || e.point; if (!p) return;
      const n = e.normal || { x: 0, y: 1, z: 0 };
      if (type === 'pen') this.penFlash(p.x, p.y, p.z);
      else if (type === 'ricochet') { this.sparks(p.x, p.y, p.z, n.x, n.y, n.z, 26, 0.6); }
      else if (type === 'noPen') { this.sparks(p.x, p.y, p.z, n.x, n.y, n.z, 14, 0.8); this.smoke.spawn(p.x, p.y, p.z, 0, 1, 0, 1.2, 0.8, 2.5, 0.5, 0.48, 0.45, 0.5, 0.6, 0.58, 0.55); }
      else if (type === 'he' || type === 'explosion') this.explosion(p.x, p.y, p.z, 0.5 + (e.cal ?? e.caliber ?? 75) / 150, 3);
      else if (type === 'ammoRack') this.explosion(p.x, p.y + 1, p.z, 1.7, 22);
      else if (type === 'kill') this.explosion(p.x, p.y + 1, p.z, 1.2, 8);
      else if (type === 'ground' || type === 'dirt' || type === 'splash' || type === 'miss') this.dirt(p.x, p.y, p.z, 0.6 + (e.cal ?? e.caliber ?? 75) / 200);
      else if (type === 'spark' || type === 'sparks') this.sparks(p.x, p.y, p.z, n.x, n.y, n.z, 12);
   }

   update(dt, camera) {
      const w = this.w; this.time += dt; this.mkMat.uniforms.uTime.value = this.time;
      const scale = (innerHeight * Math.min(2, devicePixelRatio || 1)) / (2 * Math.tan(camera.fov * Math.PI / 360));
      this.smoke.mat.uniforms.uScale.value = this.glow.mat.uniforms.uScale.value = scale;
      const tip = this.mp, dir = this.md, T = w.terrain;
      // events
      const ev = w.events, list = Array.isArray(ev) ? ev : ev?.list || ev?.items || [];
      let mx = this.lastSeq;
      for (let i = 0; i < list.length; i++) {
         const e = list[i]; if (!e) continue; const seq = e.seq ?? i; if (seq <= this.lastSeq) continue; if (seq > mx) mx = seq;
         let type = e.type ?? e.kind;
         if (type === 'kill' && !e.pos) { const t = w.tanks.find((q) => q.id === e.dstId); if (t) this.onHit('kill', { pos: t.pos }); continue; }
         this.onHit(type, e);
      }
      this.lastSeq = mx;
      // transient effects from the sim
      if (w.effects) for (const e of w.effects) { if (e.__fx) continue; e.__fx = true; this.onHit(e.kind ?? e.type, e); }
      // tanks
      for (const t of w.tanks || []) {
         let s = this.ts.get(t.id); if (!s) this.ts.set(t.id, s = { lastFire: t.lastFire, lx: t.pos.x, lz: t.pos.z, acc: 0, smk: 0, alive: t.alive });
         const visible = t.alive === false || t.spotted !== false || t.team === w.player?.team;
         if (t.lastFire != null && t.lastFire !== s.lastFire) {
            s.lastFire = t.lastFire; this.gunTip(t, tip, dir);
            const cal = t.cfg?.gun?.cal ?? 75; this.muzzle(tip.x, tip.y, tip.z, dir.x, dir.y, dir.z, cal);
            this.groundRing(t.pos.x + dir.x * 3, t.pos.y, t.pos.z + dir.z * 3, cal);
            if (t === w.player && window.__game?.tcam) window.__game.tcam.shake = Math.min(1.2, 0.4 + cal / 120);
         }
         if (s.alive !== false && t.alive === false) this.onHit('kill', { pos: t.pos });
         s.alive = t.alive;
         if (!visible) continue;
         const yaw = t.yaw || 0, fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
         const L = (t.cfg?.dims?.l ?? 6) / 2, W = (t.cfg?.run?.x ?? 1.4), spd = Math.abs(t.speed || 0);
         if (t.alive !== false) {
            // exhaust: rear deck, more with throttle
            s.acc += dt * (2 + Math.abs(t.input?.throttle || 0) * 10) * this.k;
            while (s.acc > 1) {
               s.acc--; const ex = t.pos.x - fx * L * 0.9 + rx * rnd(0.5), ez = t.pos.z - fz * L * 0.9 + rz * rnd(0.5);
               this.smoke.spawn(ex, t.pos.y + (t.cfg?.dims?.h ?? 2.3) * 0.55, ez, -fx * 1.2 + rnd(0.3), 1.2, -fz * 1.2 + rnd(0.3), 1.6, 0.4, 1.8, 0.22, 0.21, 0.2, 0.32, 0.5, 0.5, 0.5, -0.3, 1);
            }
            // track dust + marks
            if (spd > 1.5) {
               const c = this.dustCol(t.pos.x, t.pos.z), n = spd * dt * 1.6 * this.k;
               for (let k = 0; k < 2; k++) if (Math.random() < n) {
                  const sd = k ? 1 : -1, x = t.pos.x - fx * L + rx * W * sd, z = t.pos.z - fz * L + rz * W * sd;
                  this.smoke.spawn(x, t.pos.y + 0.3, z, rnd(1) - fx * spd * 0.15, 0.6 + Math.random(), rnd(1) - fz * spd * 0.15, 1.6 + Math.random() * 1.6, 1.2, 3.5 + spd * 0.12, c[0], c[1], c[2], 0.32, c[0] * 1.1, c[1] * 1.1, c[2] * 1.1, -0.05, 1.2);
               }
            }
            const md = Math.hypot(t.pos.x - s.lx, t.pos.z - s.lz);
            if (md > 0.9 && T?.groundAt?.(t.pos.x, t.pos.z) !== 'road') {
               const tw = t.cfg?.run?.tw ?? t.cfg?.run?.track?.w ?? 0.55;
               for (const sd of [-1, 1]) this.mark(t.pos.x + rx * W * sd, t.pos.z + rz * W * sd, Math.atan2(-(t.pos.x - s.lx), -(t.pos.z - s.lz)), tw, md + 0.15, t.pos.y);
               s.lx = t.pos.x; s.lz = t.pos.z;
            } else if (md > 0.9) { s.lx = t.pos.x; s.lz = t.pos.z; }
         }
         // fire and smoke columns
         const burning = t.burning || (t.alive === false && (t.wreckT ?? 0) < 25);
         if (burning || t.alive === false) {
            s.smk += dt * (burning ? 9 : 2.5) * this.k;
            while (s.smk > 1) {
               s.smk--; const x = t.pos.x + rnd(0.8), z = t.pos.z + rnd(0.8), y = t.pos.y + 1.6;
               this.smoke.spawn(x, y, z, rnd(0.6) + 0.6, 2.5 + Math.random() * 2, rnd(0.6) + 0.3, 6 + Math.random() * 4, 1.5, 9, 0.1, 0.09, 0.085, burning ? 0.75 : 0.45, 0.32, 0.31, 0.3, -0.25, 0.4);
               if (burning) this.glow.spawn(x, y - 0.3, z, rnd(0.4), 2.5 + Math.random() * 2, rnd(0.4), 0.45 + Math.random() * 0.3, 1.6, 0.6, 1, 0.55, 0.15, 0.9, 0.9, 0.2, 0.02, -1, 1);
            }
         }
      }
      // tracers (interpolated between sim steps)
      const acc = window.__game?.acc ?? 0; let n = 0;
      const trP = this.trPos, trC = this.trCol;
      for (const sh of w.shells || []) {
         if (!sh.alive || n >= MAX_TR) continue;
         const x = sh.pos.x + sh.vel.x * acc, y = sh.pos.y + sh.vel.y * acc, z = sh.pos.z + sh.vel.z * acc, L = 0.028;
         const o = n * 6, hot = sh.ammo === 'HE' ? [1, 0.45, 0.2] : sh.ammo === 'APCR' ? [0.75, 0.85, 1] : [1, 0.75, 0.35];
         trP[o] = x - sh.vel.x * L; trP[o + 1] = y - sh.vel.y * L; trP[o + 2] = z - sh.vel.z * L; trP[o + 3] = x; trP[o + 4] = y; trP[o + 5] = z;
         trC[o] = hot[0] * 0.25; trC[o + 1] = hot[1] * 0.25; trC[o + 2] = hot[2] * 0.25; trC[o + 3] = hot[0]; trC[o + 4] = hot[1]; trC[o + 5] = hot[2];
         if (sh.tracer !== false) this.glow.spawn(x, y, z, 0, 0, 0, 0.05, 0.55, 0.3, hot[0], hot[1], hot[2], 1, hot[0], hot[1] * 0.6, hot[2] * 0.3);
         n++;
         if (!w.effects) this.shellSeen.set(sh, sh.pos);
      }
      for (let i = n * 6; i < trP.length; i++) trP[i] = 0;
      this.tracers.geometry.attributes.position.needsUpdate = this.tracers.geometry.attributes.color.needsUpdate = true;
      this.tracers.geometry.setDrawRange(0, n * 2);
      // fallback ground splashes when the sim has no effects list: shells that died near the ground
      if (!w.effects && this.shellSeen.size) for (const [sh] of this.shellSeen) if (!sh.alive) {
         this.shellSeen.delete(sh); const g = T?.heightAt?.(sh.pos.x, sh.pos.z) ?? -1e9;
         if (sh.pos.y - g < 1.5) sh.ammo === 'HE' ? this.explosion(sh.pos.x, g, sh.pos.z, 0.6, 2) : this.dirt(sh.pos.x, g, sh.pos.z, 0.8);
      }
      // destroyed trees / houses → dust
      if (T && (T.version ?? 0) !== this.tver) {
         this.tver = T.version ?? 0;
         T.objects?.forEach((o, i) => {
            if (this.objAlive[i] && o.alive === false) {
               const big = o.kind === 'house' || o.kind === 'church', c = this.dustCol(o.x, o.z), sz = big ? 3 : 1.2, y = o.y ?? T.heightAt(o.x, o.z);
               for (let k = 0; k < (big ? 50 : 14) * this.k; k++) this.smoke.spawn(o.x + rnd(o.w / 2 || 1), y + Math.random() * (big ? 4 : 2), o.z + rnd(o.d / 2 || 1), rnd(2), 0.5 + Math.random() * 2, rnd(2), 3 + Math.random() * 3, sz, sz * 3.5, c[0] * 1.1, c[1] * 1.1, c[2] * 1.05, 0.6, 0.75, 0.72, 0.66, -0.1, 1);
               if (big) for (let k = 0; k < 10; k++) this.debris(o.x + rnd(3), y + 2, o.z + rnd(3), rnd(5), 3 + Math.random() * 6, rnd(5));
            }
            this.objAlive[i] = o.alive !== false;
         });
      }
      // debris physics
      const s = this.debS, M = this.M;
      let dirty = false;
      for (let i = 0; i < MAX_DEB; i++) {
         const o = i * 10; if (s[o + 9] <= 0) continue;
         dirty = true; s[o + 8] -= dt;
         if (s[o + 8] <= 0) { s[o + 9] = 0; M.makeScale(0, 0, 0); this.deb.setMatrixAt(i, M); continue; }
         s[o + 4] -= 9.81 * dt; s[o] += s[o + 3] * dt; s[o + 1] += s[o + 4] * dt; s[o + 2] += s[o + 5] * dt; s[o + 6] += s[o + 7] * dt;
         const g = T?.heightAt?.(s[o], s[o + 2]) ?? 0;
         if (s[o + 1] < g + 0.08) { s[o + 1] = g + 0.08; s[o + 4] *= -0.3; s[o + 3] *= 0.6; s[o + 5] *= 0.6; s[o + 7] *= 0.6; }
         else if (Math.random() < dt * 20 && s[o + 8] > 4) this.smoke.spawn(s[o], s[o + 1], s[o + 2], 0, 0.5, 0, 1, 0.4, 1.3, 0.2, 0.18, 0.16, 0.5, 0.4, 0.38, 0.36);
         const sc = s[o + 9];
         M.compose(this.V.set(s[o], s[o + 1], s[o + 2]), this.Q.setFromEuler(this.E.set(s[o + 6], s[o + 6] * 0.7, s[o + 6] * 0.3)), this.S.set(sc, sc, sc));
         this.deb.setMatrixAt(i, M);
      }
      if (dirty) this.deb.instanceMatrix.needsUpdate = true;
      this.smoke.update(dt); this.glow.update(dt);
   }
}
