// game/armor.js — armour geometry: convex polyhedra built from the tank data in config.js,
// ray tests against them (in the frames of hull, turret and gun), effective thickness and
// internal module/crew boxes. The renderer may use the same face loops for the visual model.
//
// buildArmor(cfg) -> model { cfg, parts:[part], boundR, boundY, modules, crew }
//   part = { name:'hull'|'turret'|'mantlet'|'track'|'skirt'|'gun', frame:'hull'|'turret'|'gun',
//            side:'L'|'R'|null, planes: Float64Array(4n) (nx,ny,nz,d; inside: n·p <= d),
//            faces:[{ plate, name, t, loop:[[x,y,z]...], normal:[x,y,z], internal, innerHalfW }] }
// rayArmor(model, pose, origin, dir, maxDist?) -> hits (REUSED array, valid until the next call)
//   hit = { dist, part, side, plateId, plateName, t, normal{x,y,z} (world, outward), angleDeg, effT,
//           point{x,y,z} }   — one entry per part the ray enters (internal faces dropped).
// rayModules(model, pose, origin, dir, t0, t1) -> hits on module/crew boxes (REUSED array)
//   { dist, kind:'module'|'crew', id }
// gunWorld(cfg, pose, outPos, outDir) — muzzle position and barrel direction in world space.
// pose = { pos{x,y,z}, yaw, pitch, roll, turretYaw, gunPitch, m? (Float64Array(9) hull matrix) }
import { PLATE_NAMES } from './config.js';
import { poseMatrix, mulMat3, mulMat3T } from './utils.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

export const effective = (t, angleDeg) => t / Math.max(0.02, Math.cos(angleDeg * D2R));

// ------------------------------------------------------------------ polyhedron builders
function planeFrom(n, p) { return [n[0], n[1], n[2], n[0] * p[0] + n[1] * p[1] + n[2] * p[2]]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function centroid(pts) { const c = [0, 0, 0]; for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; } return c.map((v) => v / pts.length); }

/** Face from a vertex loop: outward normal chosen away from the solid's centre. */
function makeFace(loop, center, plate, t, extra = {}) {
   let n = [0, 0, 0];
   // Newell normal
   for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      n[0] += (a[1] - b[1]) * (a[2] + b[2]);
      n[1] += (a[2] - b[2]) * (a[0] + b[0]);
      n[2] += (a[0] - b[0]) * (a[1] + b[1]);
   }
   n = norm(n);
   const c = centroid(loop);
   const out = sub(c, center);
   if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) { n = [-n[0], -n[1], -n[2]]; loop = loop.slice().reverse(); }
   return { plate, name: PLATE_NAMES[plate] || plate, t, loop: loop.map((p) => p.map((v) => +v.toFixed(4))), normal: n, internal: false, innerHalfW: 0, ...extra };
}
function finishPart(name, frame, side, faces, center) {
   const planes = new Float64Array(faces.length * 4);
   faces.forEach((f, i) => {
      const pl = planeFrom(f.normal, f.loop[0]);
      planes.set(pl, i * 4);
   });
   let r = 0;
   for (const f of faces) for (const p of f.loop) r = Math.max(r, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
   return { name, frame, side, faces, planes, center, r };
}

/** Cut a convex part by the plane n·p = d (keeps n·p <= d). The cut faces shrink, the cap is a new
 *  plate whose id/thickness capPlate(capLoop, faces) picks. Returns the part unchanged if the plane
 *  misses it. Used for plan-view tapers (hull.pike: the IS-3 / IS-7 pike nose). */
export function clipLoop(loop, n, d) {
   const out = [], cut = [], f = (p) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d;
   for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length], fa = f(a), fb = f(b);
      if (fa <= 1e-9) out.push(a);
      if ((fa <= 1e-9) !== (fb <= 1e-9)) { const t = fa / (fa - fb), q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; out.push(q); cut.push(q); }
   }
   return { out, cut };
}
export function capLoop(pts, n) {   // order points on a plane around their centroid
   const uniq = [];
   for (const p of pts) if (!uniq.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-5)) uniq.push(p);
   if (uniq.length < 3) return null;
   const c = centroid(uniq), u = norm(Math.abs(n[1]) < 0.9 ? cross(n, [0, 1, 0]) : cross(n, [1, 0, 0])), v = cross(n, u);
   return uniq.map((p) => { const w = sub(p, c); return [Math.atan2(w[0] * v[0] + w[1] * v[1] + w[2] * v[2], w[0] * u[0] + w[1] * u[1] + w[2] * u[2]), p]; }).sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}
function cutPart(part, n, d, capPlate) {
   const faces = [], cuts = [];
   let hit = false;
   for (const f of part.faces) {
      const { out, cut } = clipLoop(f.loop, n, d);
      if (out.length !== f.loop.length || cut.length) hit = true;
      cuts.push(...cut);
      if (out.length >= 3) faces.push({ ...f, loop: out.map((p) => p.map((v) => +v.toFixed(4))) });
   }
   if (!hit) return part;
   const cap = capLoop(cuts, n);
   if (cap) { const { plate, t } = capPlate(cap, part.faces); faces.push(makeFace(cap, part.center, plate, t)); }
   return finishPart(part.name, part.frame, part.side, faces, part.center);
}
/** The pike planes of hull.pike = { len, tip }: the nose narrows in plan view from the full upper hull
 *  width len metres behind the front to ±tip at the very front. [[n, d], [n, d]] (right, left). */
export function pikePlanes(H) {
   if (!H.pike) return [];
   const { len, tip } = H.pike, W = H.w / 2, z0 = H.zMin;
   return [1, -1].map((s) => { const nn = norm([s * len, 0, -(W - tip)]); return [nn, nn[0] * s * tip + nn[2] * z0]; });
}
// the front plate a pike cap belongs to: the frontal face of the cut piece spanning the cap's height
function pikePlate(cap, faces) {
   const cy = cap.reduce((s, p) => s + p[1], 0) / cap.length;
   let best = null, bs = Infinity;
   for (const f of faces) {
      if (f.internal || f.normal[2] > -0.15) continue;
      const ys = f.loop.map((p) => p[1]), lo = Math.min(...ys), hi = Math.max(...ys);
      const score = cy < lo ? lo - cy : cy > hi ? cy - hi : 0;
      if (score < bs) { bs = score; best = f; }
   }
   return best ? { plate: best.plate, t: best.t } : { plate: 'ufp', t: 20 };
}

/** Clip a convex (z,y) polygon by y >= lo and y <= hi. Points: [{z,y,plate}] (plate on edge i->i+1). */
function clipProfile(pts, lo, hi) {
   let poly = pts.map((p) => ({ ...p }));
   const clip = (keep, yc, plateCut) => {
      const out = [];
      for (let i = 0; i < poly.length; i++) {
         const a = poly[i], b = poly[(i + 1) % poly.length];
         const ka = keep(a.y), kb = keep(b.y);
         if (ka) out.push({ ...a });
         if (ka !== kb) {
            const t = (yc - a.y) / (b.y - a.y);
            // the new point starts either the remainder of edge a->b (entering) or the cut edge
            out.push({ z: a.z + (b.z - a.z) * t, y: yc, plate: ka ? plateCut : a.plate });
         }
      }
      poly = out;
   };
   if (lo != null) clip((y) => y >= lo - 1e-9, lo, '__cutLo');
   if (hi != null) clip((y) => y <= hi + 1e-9, hi, '__cutHi');
   return poly;
}

function prismPiece(name, prof, halfW, plates, cutPlates) {
   // prof: clipped (z,y) polygon with plate per edge; halfW(y) -> half width at height y
   const verts = prof.map((p) => ({ z: p.z, y: p.y, hw: halfW(p.y) }));
   const cy = verts.reduce((s, v) => s + v.y, 0) / verts.length;
   const cz = verts.reduce((s, v) => s + v.z, 0) / verts.length;
   const center = [0, cy, cz];
   const faces = [];
   for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      if (Math.hypot(a.z - b.z, a.y - b.y) < 1e-6) continue;
      const plateId = prof[i].plate;
      const loop = [[a.hw, a.y, a.z], [-a.hw, a.y, a.z], [-b.hw, b.y, b.z], [b.hw, b.y, b.z]];
      if (plateId === '__cutHi') faces.push(makeFace(loop, center, 'roof', 0, { internal: true }));
      else if (plateId === '__cutLo') {
         if (cutPlates.lo) faces.push(makeFace(loop, center, cutPlates.lo, plates[cutPlates.lo]?.t ?? 20, { innerHalfW: cutPlates.innerHalfW }));
         else faces.push(makeFace(loop, center, 'floor', 0, { internal: true }));
      }
      else faces.push(makeFace(loop, center, plateId, plates[plateId]?.t ?? 20));
   }
   const sidePlate = cutPlates.side;
   faces.push(makeFace(verts.map((v) => [v.hw, v.y, v.z]), center, sidePlate, plates[sidePlate].t));
   faces.push(makeFace(verts.map((v) => [-v.hw, v.y, v.z]), center, sidePlate, plates[sidePlate].t));
   return finishPart(name, 'hull', null, faces, center);
}

/** Ship hull as convex slices along z, following the plan the renderer draws (tanks3d
 *  shipSection: the bow tapers to a stem over its first quarter, the stern narrows a little,
 *  the forecastle deck rises). Sides lean in from the bilge (75 % width) to the deck edge. */
export function shipSection(H, z) {
   const L0 = H.zMin + 2.4, L1 = H.zMax - 2.4, hw0 = H.w / 2;
   const fb = Math.max(0, Math.min(1, (z - L0) / (L1 - L0)));                    // 0 bow … 1 stern
   const bowK = Math.min(1, fb / 0.24), sternK = Math.min(1, (1 - fb) / 0.1);
   const hw = hw0 * Math.sqrt(bowK) * (0.7 + 0.3 * Math.sqrt(sternK));
   const deck = H.roofY + (fb < 0.32 ? 1.1 * (1 - fb / 0.32) ** 1.6 : 0);
   return { hw: Math.max(0.05, hw), deck };
}
function shipHullParts(H, plates) {
   const L0 = H.zMin + 2.4, L1 = H.zMax - 2.4, out = [], y0 = H.floorY + 0.2;
   const zs = [0, 0.01, 0.03, 0.06, 0.1, 0.15, 0.2, 0.25, 0.32, 0.5, 0.7, 0.85, 0.92, 1].map((f) => L0 + (L1 - L0) * f);
   const tS = plates.side?.t ?? 15, tR = plates.roof?.t ?? 12, tF = plates.floor?.t ?? 12;
   for (let i = 0; i + 1 < zs.length; i++) {
      const za = zs[i], zb = zs[i + 1], A = shipSection(H, za), B = shipSection(H, zb);
      const d = Math.min(A.deck, B.deck);                // flat top per slice keeps every face planar
      const ab = A.hw * 0.75, bb = B.hw * 0.75;
      const v = { aLB: [-ab, y0, za], aRB: [ab, y0, za], aLT: [-A.hw, d, za], aRT: [A.hw, d, za], bLB: [-bb, y0, zb], bRB: [bb, y0, zb], bLT: [-B.hw, d, zb], bRT: [B.hw, d, zb] };
      const center = [0, (y0 + d) / 2, (za + zb) / 2];
      out.push(finishPart('hull', 'hull', null, [
         makeFace([v.aRB, v.bRB, v.bRT, v.aRT], center, 'side', tS),
         makeFace([v.aLB, v.aLT, v.bLT, v.bLB], center, 'side', tS),
         makeFace([v.aLT, v.aRT, v.bRT, v.bLT], center, 'roof', tR),
         makeFace([v.aLB, v.bLB, v.bRB, v.aRB], center, 'floor', tF),
         makeFace([v.aLB, v.aRB, v.aRT, v.aLT], center, i === 0 ? 'nose' : 'side', i === 0 ? (plates.nose?.t ?? tS) : 0, { internal: i > 0 }),
         makeFace([v.bLB, v.bLT, v.bRT, v.bRB], center, i === zs.length - 2 ? 'urp' : 'side', i === zs.length - 2 ? (plates.urp?.t ?? tS) : 0, { internal: i < zs.length - 2 }),
      ], center));
   }
   return out;
}

function boxPart(name, frame, side, c, s, plate, t, internalFace = null) {
   // c centre [x,y,z], s full size [w,h,d]
   const [x, y, z] = c, hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
   const P = (sx, sy, sz) => [x + sx * hx, y + sy * hy, z + sz * hz];
   const center = [x, y, z];
   const quads = {
      front: [P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1)],
      back: [P(-1, -1, 1), P(-1, 1, 1), P(1, 1, 1), P(1, -1, 1)],
      left: [P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1)],
      right: [P(1, -1, -1), P(1, -1, 1), P(1, 1, 1), P(1, 1, -1)],
      top: [P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1)],
      bottom: [P(-1, -1, -1), P(-1, -1, 1), P(1, -1, 1), P(1, -1, -1)],
   };
   const faces = Object.entries(quads).map(([k, loop]) => makeFace(loop, center, plate, t, { internal: k === internalFace, dir: k }));
   return finishPart(name, frame, side, faces, center);
}

// ------------------------------------------------------------------ buildArmor
export function buildArmor(cfg) {
   const H = cfg.hull, parts = [];
   const plates = H.plates;
   const y0 = H.sponsonY ?? H.floorY;
   const tanS = Math.tan((H.sideSlope || 0) * D2R);
   const upperHW = (y) => Math.max(0.05, H.w / 2 - Math.max(0, y - y0) * tanS);
   // The side profile may be non-convex (stepped fronts like the Pz IV's driver plate set back
   // behind the glacis): split it horizontally at every concave vertex (and at sponsonY) into
   // convex slabs. Cut faces between slabs are internal, except the sponson floor.
   const prof = H.profile, np = prof.length;
   let area = 0;
   for (let i = 0; i < np; i++) { const a = prof[i], b = prof[(i + 1) % np]; area += a.z * b.y - b.z * a.y; }
   const cuts = new Set();
   if (H.sponsonY != null) cuts.add(+H.sponsonY.toFixed(4));
   for (let i = 0; i < np; i++) {
      const a = prof[(i + np - 1) % np], b = prof[i], c = prof[(i + 1) % np];
      const cr = (b.z - a.z) * (c.y - b.y) - (b.y - a.y) * (c.z - b.z);
      if (cr * area < -1e-9) cuts.add(+b.y.toFixed(4));
   }
   const ys = [...cuts].sort((p, q) => p - q);
   const bounds = cfg.site === 'ship' ? [] : [null, ...ys, null];
   if (cfg.site === 'ship') parts.push(...shipHullParts(H, plates));
   for (let k = 0; k + 1 < bounds.length; k++) {
      const lo = bounds[k], hi = bounds[k + 1];
      const piece = clipProfile(prof, lo, hi);
      if (piece.length < 3) continue;
      const below = H.sponsonY != null && (hi != null && hi <= H.sponsonY + 1e-6);
      const atSpon = H.sponsonY != null && lo != null && Math.abs(lo - H.sponsonY) < 1e-4;
      parts.push(prismPiece('hull', piece, below ? () => H.lowerW / 2 : upperHW, plates,
         { side: below ? 'sideLow' : 'side', lo: atSpon ? 'spon' : null, innerHalfW: atSpon ? H.lowerW / 2 : 0 }));
   }
   for (const [n, d] of pikePlanes(H)) for (let i = 0; i < parts.length; i++) parts[i] = cutPart(parts[i], n, d, pikePlate);
   // turret
   const T = cfg.turret;
   if (T) {
      const faces = [];
      const n = T.base.length;
      const center = [0, T.h / 2, (T.lenR - T.lenF) / 2];
      const R = T.rings || [[0, T.base], [T.h, T.top]];   // domed turrets: one band of faces per ring pair
      for (let k = 0; k + 1 < R.length; k++) for (let i = 0; i < n; i++) {
         const [y0, P0] = R[k], [y1, P1] = R[k + 1], a = P0[i], b = P0[(i + 1) % n], at = P1[i], bt = P1[(i + 1) % n];
         const loop = [[a[0], y0, a[1]], [b[0], y0, b[1]], [bt[0], y1, bt[1]], [at[0], y1, at[1]]];
         faces.push(makeFace(loop, center, T.faces[i].id, T.faces[i].t));
      }
      faces.push(makeFace(T.top.map((p) => [p[0], T.h, p[1]]), center, 'troof', T.openTop ? 0 : T.roofT));
      faces.push(makeFace(T.base.map((p) => [p[0], 0, p[1]]), center, 'tbase', T.plates.tbase.t, { internal: true }));
      for (const f of faces) f.plateT = f.t;
      const part = finishPart('turret', 'turret', null, faces, center);
      // turret plate names/thickness from the turret's own plate table
      for (const f of part.faces) if (T.plates[f.plate]) f.name = T.plates[f.plate].name;
      parts.push(part);
      // commander's cupola: weak spot on the roof (its floor sits on the roof plate -> internal)
      const C = T.cupola;
      if (C) parts.push(boxPart('cupola', 'turret', null, [C.x, C.y, C.z], [C.s, C.h, C.s], 'cup', C.t, 'bottom'));
   }
   // mantlet (back face sits inside the turret front / casemate)
   const M = cfg.mantlet;
   parts.push(boxPart('mantlet', M.mount === 'turret' ? 'turret' : 'hull', null, [M.x, M.y, M.z], [M.w, M.h, M.d], 'mantlet', M.t, 'back'));
   // gun barrel (gun frame: origin at the trunnion, -z along the barrel)
   const g = cfg.gun;
   const br = Math.max(0.06, g.cal / 1000 * 0.9 + 0.03);
   parts.push(boxPart('gun', 'gun', null, [0, 0, -(g.len / 2) - 0.15], [br * 2, br * 2, g.len], 'gun', 30));
   // tracks
   const run = cfg.run;
   for (const sd of ['L', 'R']) {
      const sx = sd === 'L' ? -run.x : run.x;
      parts.push(boxPart('track', 'hull', sd, [sx, run.h / 2, run.z], [run.trackW, run.h, run.len], 'track', run.t));
   }
   if (cfg.skirts) {
      const S = cfg.skirts;
      for (const sd of ['L', 'R']) {
         const sx = sd === 'L' ? -S.x : S.x;
         parts.push(boxPart('skirt', 'hull', sd, [sx, S.y0 + S.h / 2, run.z], [0.04, S.h, S.len], 'skirt', S.t));
      }
   }
   // bounding sphere around (0, boundY, 0) in hull frame (turret + gun included generously)
   const boundY = (H.roofY + H.floorY) / 2;
   let boundR = 0;
   for (const p of parts) if (p.frame === 'hull') {
      for (const f of p.faces) for (const v of f.loop) boundR = Math.max(boundR, Math.hypot(v[0], v[1] - boundY, v[2]));
   }
   if (T) boundR = Math.max(boundR, Math.hypot(T.lenR + Math.abs(T.z), H.roofY + T.h - boundY, T.w / 2) + 0.1);
   const gunReach = Math.hypot(Math.abs(g.pivot.z) + (T ? Math.abs(T.z) : 0) + g.len + 0.3, 0.6);
   boundR = Math.max(boundR, gunReach);
   // modules + crew boxes (half extents)
   const boxes = [];
   for (const [id, m] of Object.entries(cfg.modules)) boxes.push({ kind: 'module', id, frame: m.part, c: m.c, s: m.s });
   for (const c of cfg.crew) boxes.push({ kind: 'crew', id: c.id, frame: c.part, c: c.c, s: c.s });
   const model = { cfg, parts, boundR, boundY, boxes, _hits: [], _hitPool: [], _mhits: [], _mpool: [] };
   return model;
}

// ------------------------------------------------------------------ frames & ray tests
const _m = new Float64Array(9);
const _o = { x: 0, y: 0, z: 0 }, _d = { x: 0, y: 0, z: 0 };
const _ho = { x: 0, y: 0, z: 0 }, _hd = { x: 0, y: 0, z: 0 };     // hull frame ray
const _to = { x: 0, y: 0, z: 0 }, _td = { x: 0, y: 0, z: 0 };     // turret frame ray
const _go = { x: 0, y: 0, z: 0 }, _gd = { x: 0, y: 0, z: 0 };     // gun frame ray
const _n = { x: 0, y: 0, z: 0 }, _nw = { x: 0, y: 0, z: 0 };

function hullMatrix(pose) {
   if (pose.m) return pose.m;
   return poseMatrix(_m, pose.yaw || 0, pose.pitch || 0, pose.roll || 0);
}
/** World ray -> hull, turret and gun frames (module scratch vectors). */
function toFrames(cfg, pose, origin, dir) {
   const m = hullMatrix(pose);
   _o.x = origin.x - pose.pos.x; _o.y = origin.y - pose.pos.y; _o.z = origin.z - pose.pos.z;
   mulMat3T(_ho, m, _o); mulMat3T(_hd, m, dir);
   const T = cfg.turret, g = cfg.gun;
   const ty = pose.turretYaw || 0, c = Math.cos(ty), s = Math.sin(ty);
   if (T) {
      const px = _ho.x - T.x, py = _ho.y - T.y, pz = _ho.z - T.z;
      _to.x = c * px - s * pz; _to.y = py; _to.z = s * px + c * pz;
      _td.x = c * _hd.x - s * _hd.z; _td.y = _hd.y; _td.z = s * _hd.x + c * _hd.z;
      // gun frame: turret -> pivot -> pitch
      toGun(_to, _td, g.pivot, 0, pose.gunPitch || 0);
   } else {
      // casemate: gun traverses about its pivot in the hull frame
      toGun(_ho, _hd, g.pivot, ty, pose.gunPitch || 0);
   }
   return m;
}
function toGun(o, d, piv, yaw, pitch) {
   let px = o.x - piv.x, py = o.y - piv.y, pz = o.z - piv.z;
   let dx = d.x, dy = d.y, dz = d.z;
   if (yaw) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const x1 = c * px - s * pz, z1 = s * px + c * pz; px = x1; pz = z1;
      const x2 = c * dx - s * dz, z2 = s * dx + c * dz; dx = x2; dz = z2;
   }
   const c = Math.cos(pitch), s = Math.sin(pitch);
   _go.x = px; _go.y = c * py + s * pz; _go.z = -s * py + c * pz;
   _gd.x = dx; _gd.y = c * dy + s * dz; _gd.z = -s * dy + c * dz;
}
/** Normal from a part frame to world (into _nw). */
function normalToWorld(cfg, pose, m, frame, n) {
   let x = n[0], y = n[1], z = n[2];
   const ty = pose.turretYaw || 0;
   if (frame === 'gun') {
      const p = pose.gunPitch || 0, c = Math.cos(p), s = Math.sin(p);
      const y1 = c * y - s * z, z1 = s * y + c * z; y = y1; z = z1;
      if (!cfg.turret && ty) { const cy = Math.cos(ty), sy = Math.sin(ty); const x2 = cy * x + sy * z, z2 = -sy * x + cy * z; x = x2; z = z2; }
   }
   if ((frame === 'turret' || frame === 'gun') && cfg.turret) {
      const c = Math.cos(ty), s = Math.sin(ty);
      const x1 = c * x + s * z, z1 = -s * x + c * z; x = x1; z = z1;
   }
   _n.x = x; _n.y = y; _n.z = z;
   return mulMat3(_nw, m, _n);
}

/** Ray vs convex part: returns entering face index (or -1) and writes tEnter into out[0]. */
const _tt = [0];
function rayPart(part, o, d, maxT) {
   const P = part.planes;
   let tE = -Infinity, tX = Infinity, fi = -1;
   for (let i = 0, k = 0; k < P.length; i++, k += 4) {
      const den = P[k] * d.x + P[k + 1] * d.y + P[k + 2] * d.z;
      const num = P[k + 3] - (P[k] * o.x + P[k + 1] * o.y + P[k + 2] * o.z);
      if (Math.abs(den) < 1e-12) { if (num < 0) return -1; continue; }
      const t = num / den;
      if (den < 0) { if (t > tE) { tE = t; fi = i; } } else if (t < tX) tX = t;
      if (tE > tX) return -1;
   }
   if (fi < 0 || tE < 0 || tE > maxT) return -1;   // origin inside, or beyond the segment
   _tt[0] = tE;
   return fi;
}

function frameRay(frame) {
   if (frame === 'hull') return [_ho, _hd];
   if (frame === 'turret') return [_to, _td];
   return [_go, _gd];
}

export function rayArmor(model, pose, origin, dir, maxDist = Infinity) {
   const cfg = model.cfg;
   const out = model._hits; out.length = 0;
   const m = toFrames(cfg, pose, origin, dir);
   let used = 0;
   for (const part of model.parts) {
      const [o, d] = frameRay(part.frame);
      const fi = rayPart(part, o, d, maxDist);
      if (fi < 0) continue;
      const t = _tt[0];
      const face = part.faces[fi];
      if (face.internal) continue;
      if (face.innerHalfW && Math.abs(o.x + d.x * t) < face.innerHalfW) continue;
      const nw = normalToWorld(cfg, pose, m, part.frame, face.normal);
      const cosA = Math.abs(nw.x * dir.x + nw.y * dir.y + nw.z * dir.z);
      const angleDeg = Math.acos(Math.min(1, cosA)) * R2D;
      let h = model._hitPool[used];
      if (!h) { h = model._hitPool[used] = { normal: { x: 0, y: 0, z: 0 }, point: { x: 0, y: 0, z: 0 } }; }
      used++;
      h.dist = t; h.part = part.name; h.side = part.side; h.plateId = face.plate; h.plateName = face.name;
      h.t = face.t; h.normal.x = nw.x; h.normal.y = nw.y; h.normal.z = nw.z;
      h.angleDeg = angleDeg; h.effT = face.t > 0 ? effective(face.t, angleDeg) : 0;
      h.point.x = origin.x + dir.x * t; h.point.y = origin.y + dir.y * t; h.point.z = origin.z + dir.z * t;
      out.push(h);
   }
   out.sort((a, b) => a.dist - b.dist);
   return out;
}

/** Module/crew boxes hit by the ray between t0 and t1 (world distances). Reused array. */
export function rayModules(model, pose, origin, dir, t0, t1) {
   const cfg = model.cfg;
   const out = model._mhits; out.length = 0;
   toFrames(cfg, pose, origin, dir);
   let used = 0;
   for (const b of model.boxes) {
      const [o, d] = b.frame === 'turret' && cfg.turret ? [_to, _td] : [_ho, _hd];
      let a = t0, z = t1;
      for (let k = 0; k < 3; k++) {
         const oc = k === 0 ? o.x : k === 1 ? o.y : o.z, dc = k === 0 ? d.x : k === 1 ? d.y : d.z;
         const lo = b.c[k] - b.s[k], hi = b.c[k] + b.s[k];
         if (Math.abs(dc) < 1e-12) { if (oc < lo || oc > hi) { a = Infinity; break; } continue; }
         let ta = (lo - oc) / dc, tb = (hi - oc) / dc;
         if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
         if (ta > a) a = ta; if (tb < z) z = tb;
         if (a > z) { a = Infinity; break; }
      }
      if (a === Infinity) continue;
      let h = model._mpool[used];
      if (!h) h = model._mpool[used] = {};
      used++;
      h.dist = a; h.kind = b.kind; h.id = b.id;
      out.push(h);
   }
   out.sort((p, q) => p.dist - q.dist);
   return out;
}

/** Module/crew boxes within radius r of a world point (HE blast). Returns ids via callback. */
export function modulesNear(model, pose, p, r, cb) {
   const cfg = model.cfg;
   toFrames(cfg, pose, p, { x: 0, y: 1, z: 0 });
   for (const b of model.boxes) {
      const o = b.frame === 'turret' && cfg.turret ? _to : _ho;
      let d2 = 0;
      for (let k = 0; k < 3; k++) {
         const v = k === 0 ? o.x : k === 1 ? o.y : o.z;
         const e = Math.max(b.c[k] - b.s[k] - v, 0, v - b.c[k] - b.s[k]);
         d2 += e * e;
      }
      if (d2 < r * r) cb(b.kind, b.id, Math.sqrt(d2));
   }
}

/** Muzzle position and barrel direction in world space. */
export function gunWorld(cfg, pose, outPos, outDir) {
   const m = hullMatrix(pose);
   const T = cfg.turret, g = cfg.gun;
   const ty = pose.turretYaw || 0, gp = pose.gunPitch || 0;
   // barrel vector in gun frame: (0,0,-len) ; direction (0,0,-1)
   const cp = Math.cos(gp), sp = Math.sin(gp);
   let dx = 0, dy = sp, dz = -cp;                    // pitched direction
   let px = g.pivot.x, py = g.pivot.y, pz = g.pivot.z; // pivot in turret (or hull) frame
   const cy = Math.cos(ty), sy = Math.sin(ty);
   let rx = cy * dx + sy * dz; dz = -sy * dx + cy * dz; dx = rx;     // rotate about y (no allocation)
   if (T) { rx = cy * px + sy * pz; pz = -sy * px + cy * pz; px = rx + T.x; py += T.y; pz += T.z; }
   const L = g.len + 0.15;
   _n.x = px + dx * L; _n.y = py + dy * L; _n.z = pz + dz * L;
   mulMat3(outPos, m, _n);
   outPos.x += pose.pos.x; outPos.y += pose.pos.y; outPos.z += pose.pos.z;
   _n.x = dx; _n.y = dy; _n.z = dz;
   mulMat3(outDir, m, _n);
   return outPos;
}

/** Hull-local point -> world (helper for effects). */
export function hullToWorld(pose, p, out) {
   const m = hullMatrix(pose);
   mulMat3(out, m, p);
   out.x += pose.pos.x; out.y += pose.pos.y; out.z += pose.pos.z;
   return out;
}

// cache per tank type (armour models are immutable)
const CACHE = new Map();
export function armorFor(cfg) {
   let a = CACHE.get(cfg.id);
   if (!a) { a = buildArmor(cfg); CACHE.set(cfg.id, a); }
   return a;
}
/** Fresh model (own scratch buffers) — use one per tank if rays may interleave. */
export function armorInstance(cfg) {
   const base = armorFor(cfg);
   return { ...base, _hits: [], _hitPool: [], _mhits: [], _mpool: [] };
}
