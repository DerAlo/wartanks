// game/hitmarks.js — shell hit marks on the tank models: a dark hole with a scorched rim for a
// penetration (and a direct HE hit), a bright scrape for a ricochet / non-penetration. Each mark
// sticks to the part it hit (hull body or turret group), so it pitches, rolls and traverses with
// it. Fed by tanks3d.js from world.events (pen / noPen / ricochet / he: dstId, pos, normal, cal,
// from — all already on the net event whitelist, so MP clients get them too). The point is
// snapped to the rendered model by a short ray along the plate normal (corrects replica lag).
// Budget: two InstancedMeshes for all tanks (= 2 draw calls), at most CAP marks per tank.
import * as THREE from '../vendor/three/three.module.min.js';

const CAP = 24, MAX = 1024;
const HIT_KINDS = { pen: 1, he: 1, noPen: 2, ricochet: 2 };
export const isHitEvent = (type) => !!HIT_KINDS[type];

function canvasTex(draw) {
   const c = document.createElement('canvas'); c.width = c.height = 128;
   draw(c.getContext('2d'), 128);
   const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
   return t;
}
const rnd = (i, k) => { const s = Math.sin(i * 91.3 + k * 47.7) * 43758.5453; return s - Math.floor(s); };
// hole: soot halo, torn bright rim, black core
function holeTex() {
   return canvasTex((g, N) => {
      const c = N / 2;
      let gr = g.createRadialGradient(c, c, N * 0.1, c, c, N * 0.5);
      gr.addColorStop(0, 'rgba(18,14,10,0.95)'); gr.addColorStop(0.45, 'rgba(30,22,16,0.8)'); gr.addColorStop(1, 'rgba(30,22,16,0)');
      g.fillStyle = gr; g.fillRect(0, 0, N, N);
      for (let i = 0; i < 14; i++) {   // soot streaks
         const a = rnd(i, 1) * Math.PI * 2, l = N * (0.3 + rnd(i, 2) * 0.18);
         g.strokeStyle = `rgba(20,16,12,${0.25 + rnd(i, 3) * 0.3})`; g.lineWidth = 2 + rnd(i, 4) * 4;
         g.beginPath(); g.moveTo(c, c); g.lineTo(c + Math.cos(a) * l, c + Math.sin(a) * l); g.stroke();
      }
      g.beginPath();   // ragged hole outline
      for (let i = 0; i <= 20; i++) { const a = i / 20 * Math.PI * 2, r = N * (0.15 + rnd(i % 20, 5) * 0.05); g.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r); }
      g.closePath(); g.lineWidth = 5; g.strokeStyle = 'rgba(150,132,110,0.95)'; g.stroke();   // torn metal lip
      g.fillStyle = 'rgba(4,3,2,1)'; g.fill();
   });
}
// scrape: bright gouged metal streak with a dark dent edge
function scrapeTex() {
   return canvasTex((g, N) => {
      const c = N / 2;
      g.save(); g.translate(c, c); g.scale(1, 0.42);
      let gr = g.createRadialGradient(0, 0, 2, 0, 0, N * 0.48);
      gr.addColorStop(0, 'rgba(70,64,56,0.75)'); gr.addColorStop(0.7, 'rgba(60,54,48,0.4)'); gr.addColorStop(1, 'rgba(60,54,48,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, N * 0.48, 0, Math.PI * 2); g.fill();
      gr = g.createRadialGradient(0, 0, 1, 0, 0, N * 0.4);
      gr.addColorStop(0, 'rgba(255,250,236,1)'); gr.addColorStop(0.55, 'rgba(225,218,200,0.95)'); gr.addColorStop(1, 'rgba(200,192,175,0)');
      g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, N * 0.42, N * 0.3, 0, 0, Math.PI * 2); g.fill();
      g.restore();
      for (let i = 0; i < 7; i++) {   // gouge lines along the streak
         const y = c + (rnd(i, 7) - 0.5) * N * 0.16, x0 = N * (0.12 + rnd(i, 8) * 0.15), x1 = N * (0.72 + rnd(i, 9) * 0.16);
         g.strokeStyle = `rgba(${i & 1 ? '255,255,248' : '120,112,100'},0.7)`; g.lineWidth = 1 + rnd(i, 6) * 1.5;
         g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y + (rnd(i, 10) - 0.5) * 6); g.stroke();
      }
   });
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), Z = new THREE.Vector3(0, 0, 1);
const _ray = new THREE.Raycaster(), _o = new THREE.Vector3(), _d = new THREE.Vector3(), _hits = [];

export class HitMarks {
   constructor(parent) {
      const geo = new THREE.PlaneGeometry(1, 1);
      const common = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
      const holeM = new THREE.MeshStandardMaterial({ ...common, map: holeTex(), roughness: 1, metalness: 0 });
      const t = scrapeTex();
      const scrM = new THREE.MeshStandardMaterial({ ...common, map: t, roughness: 0.5, metalness: 0.15, emissive: 0x8a857a, emissiveMap: t });
      this.meshes = [holeM, scrM].map((mat) => {
         const im = new THREE.InstancedMesh(geo, mat, MAX);
         im.count = 0; im.frustumCulled = false; im.receiveShadow = true; im.renderOrder = 2;
         im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); parent.add(im); return im;
      });
      this.geo = geo;
   }
   /** model: tanks3d model of the hit tank; ev: pen / he / noPen / ricochet event. */
   add(model, ev) {
      const kind = HIT_KINDS[ev.type ?? ev.kind];
      if (!kind || !ev.pos || ev.what === 'splash') return;
      model.root.updateMatrixWorld(true);
      const targets = model._markTargets ??= [model.hull, model.tmesh, ...(model.tracks || []), ...(model.extra || [])].filter(Boolean);
      // ray along -normal from just outside the plate; fallback: along the shell's path
      const P = ev.pos; let hit = null;
      const tries = [];
      if (ev.normal) tries.push([ev.normal.x, ev.normal.y, ev.normal.z]);
      if (ev.from) tries.push([ev.from.x - P.x, ev.from.y - P.y, ev.from.z - P.z]);
      for (const [x, y, z] of tries) {
         _n.set(x, y, z); if (_n.lengthSq() < 1e-6) continue; _n.normalize();
         _o.set(P.x, P.y, P.z).addScaledVector(_n, 0.7); _d.copy(_n).negate();
         _ray.set(_o, _d); _ray.far = 1.6; _hits.length = 0;
         _ray.intersectObjects(targets, false, _hits);
         if (_hits.length) { hit = _hits[0]; break; }
      }
      if (!hit || !hit.face) return;
      let frame = model.body;
      for (let o = hit.object; o; o = o.parent) if (o === model.turret) { frame = model.turret; break; }
      _n.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      if (_n.dot(_d) > 0) _n.negate();   // face toward the shooter
      _p.copy(hit.point).addScaledVector(_n, 0.01);
      const cal = (ev.cal || 75) / 1000, hole = kind === 1;
      const spin = hole ? Math.random() * 6.283 : 0;
      _q.setFromUnitVectors(Z, _n);
      if (!hole) {   // streak along the shell's path projected on the plate
         const f = ev.from ? _s.set(P.x - ev.from.x, P.y - ev.from.y, P.z - ev.from.z) : _s.set(1, 0, 0);
         f.addScaledVector(_n, -f.dot(_n)); _q2.copy(_q).invert(); f.applyQuaternion(_q2);
         _q.multiply(_q2.setFromAxisAngle(Z, Math.atan2(f.y, f.x)));
      } else _q.multiply(_q2.setFromAxisAngle(Z, spin));
      const ric = (ev.type ?? ev.kind) === 'ricochet';
      if (hole) _s.setScalar(Math.min(1.1, Math.max(0.3, cal * (ev.type === 'he' ? 9 : 6))));
      else _s.set(Math.min(1.4, Math.max(0.5, cal * (ric ? 11 : 7))), Math.min(0.6, Math.max(0.24, cal * (ric ? 4 : 5))), 1);
      _m.compose(_p, _q, _s);
      _inv.copy(frame.matrixWorld).invert();
      const marks = model.marks ??= [];
      if (marks.length >= CAP) marks.shift();
      marks.push({ frame, hole, m: new THREE.Matrix4().multiplyMatrices(_inv, _m) });
   }
   /** per frame after the model poses are set: world matrices for every visible mark */
   update(models) {
      let nh = 0, ns = 0; const [H, S] = this.meshes;
      for (const m of models) {
         if (!m.marks?.length || !m.root.visible || m.scopeHide) continue;
         m.root.updateMatrixWorld(true);
         for (const k of m.marks) {
            _m.multiplyMatrices(k.frame.matrixWorld, k.m);
            if (k.hole) { if (nh < MAX) H.setMatrixAt(nh++, _m); }
            else if (ns < MAX) S.setMatrixAt(ns++, _m);
         }
      }
      if (H.count || nh) { H.count = nh; H.instanceMatrix.needsUpdate = true; }
      if (S.count || ns) { S.count = ns; S.instanceMatrix.needsUpdate = true; }
      H.visible = nh > 0; S.visible = ns > 0;
   }
   dispose() { for (const im of this.meshes) { im.parent?.remove(im); im.material.map.dispose(); im.material.dispose(); } this.geo.dispose(); }
}
