// game/utils.js — math, seeded RNG, 3D vector helpers. Pure, no dependencies (node + browser).
// Units: metres, seconds, radians. Hot paths use the in-place (`*To`) variants with scratch
// vectors; the allocating helpers are for setup code only.

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

// ---------- scalars ----------
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };
export const approach = (cur, target, step) =>
   cur < target ? Math.min(cur + step, target) : cur > target ? Math.max(cur - step, target) : cur;
/** Shortest signed angle from a to b, in (-PI, PI]. */
export const angleDelta = (a, b) => {
   let d = (b - a) % TAU;
   if (d <= -Math.PI) d += TAU;
   if (d > Math.PI) d -= TAU;
   return d;
};
export const wrapAngle = (a) => angleDelta(0, a);
export const approachAngle = (cur, target, step) => {
   const d = angleDelta(cur, target);
   if (Math.abs(d) <= step) return target;
   return wrapAngle(cur + Math.sign(d) * step);
};

// ---------- seeded RNG (mulberry32) ----------
export function makeRng(seed = 1) {
   let s = (seed >>> 0) || 0x9e3779b9;
   const rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
   };
   rng.range = (a, b) => a + (b - a) * rng();
   rng.int = (a, b) => a + Math.floor(rng() * (b - a + 1));
   rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
   rng.chance = (p) => rng() < p;
   /** Symmetric triangular in [-1, 1] (sum of two uniforms). */
   rng.tri = () => rng() + rng() - 1;
   rng.state = () => s;
   rng.setState = (v) => { s = v >>> 0; };
   return rng;
}
/** Hash of integers/strings to a 32-bit seed. */
export function hashSeed(...parts) {
   let h = 2166136261 >>> 0;
   for (const p of parts) {
      const str = String(p);
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      h ^= 0x2c; h = Math.imul(h, 16777619);
   }
   return h >>> 0;
}

// ---------- value noise (deterministic, seeded) ----------
function hash2(ix, iz, seed) {
   let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 2246822519);
   h = Math.imul(h ^ (h >>> 13), 1274126177);
   return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Smooth value noise in [0,1]. */
export function noise2(x, z, seed = 0) {
   const ix = Math.floor(x), iz = Math.floor(z);
   const fx = x - ix, fz = z - iz;
   const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
   const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
   const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
   return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
/** Fractal noise in roughly [-1,1]. */
export function fbm(x, z, seed = 0, oct = 4, lac = 2, gain = 0.5) {
   let amp = 1, f = 1, sum = 0, norm = 0;
   for (let i = 0; i < oct; i++) {
      sum += amp * (noise2(x * f, z * f, seed + i * 131) * 2 - 1);
      norm += amp; amp *= gain; f *= lac;
   }
   return sum / norm;
}
/** Ridged noise in [0,1] (sharp crests) — ridgelines for hull-down positions. */
export function ridged(x, z, seed = 0, oct = 3) {
   let amp = 1, f = 1, sum = 0, norm = 0;
   for (let i = 0; i < oct; i++) {
      const n = 1 - Math.abs(noise2(x * f, z * f, seed + i * 977) * 2 - 1);
      sum += amp * n * n; norm += amp; amp *= 0.5; f *= 2;
   }
   return sum / norm;
}

// ---------- 3D vectors {x,y,z} ----------
export const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const copy3 = (o, a) => { o.x = a.x; o.y = a.y; o.z = a.z; return o; };
export const set3 = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
export const add3 = (o, a, b) => { o.x = a.x + b.x; o.y = a.y + b.y; o.z = a.z + b.z; return o; };
export const sub3 = (o, a, b) => { o.x = a.x - b.x; o.y = a.y - b.y; o.z = a.z - b.z; return o; };
export const scale3 = (o, a, s) => { o.x = a.x * s; o.y = a.y * s; o.z = a.z * s; return o; };
export const addScaled3 = (o, a, b, s) => { o.x = a.x + b.x * s; o.y = a.y + b.y * s; o.z = a.z + b.z * s; return o; };
export const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross3 = (o, a, b) => {
   const x = a.y * b.z - a.z * b.y, y = a.z * b.x - a.x * b.z, z = a.x * b.y - a.y * b.x;
   o.x = x; o.y = y; o.z = z; return o;
};
export const len3 = (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
export const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const norm3 = (o, a) => {
   const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z) || 1;
   o.x = a.x / l; o.y = a.y / l; o.z = a.z / l; return o;
};
/** Reflect direction d about unit normal n. */
export const reflect3 = (o, d, n) => {
   const k = 2 * (d.x * n.x + d.y * n.y + d.z * n.z);
   o.x = d.x - k * n.x; o.y = d.y - k * n.y; o.z = d.z - k * n.z; return o;
};
/** Forward unit vector of a heading (0 = -z north, + = turn left). */
export const fwdX = (yaw) => -Math.sin(yaw);
export const fwdZ = (yaw) => -Math.cos(yaw);
/** Heading that faces from (x0,z0) towards (x1,z1). */
export const yawTo = (x0, z0, x1, z1) => Math.atan2(-(x1 - x0), -(z1 - z0));

// ---------- rotation matrix for a hull pose ----------
// Rotation R = Ry(yaw) * Rx(pitch) * Rz(roll) (three.js Euler order 'YXZ'): local -> world.
// pitch > 0 = nose up; roll > 0 rotates +x toward +y (right side up, left side down), the
// three.js rotation.z convention. Stored row-major in a Float64Array(9).
export function poseMatrix(m, yaw, pitch, roll) {
   const cy = Math.cos(yaw), sy = Math.sin(yaw);
   const cp = Math.cos(pitch), sp = Math.sin(pitch);
   const cr = Math.cos(roll), sr = Math.sin(roll);
   // Ry * Rx * Rz
   m[0] = cy * cr + sy * sp * sr; m[1] = -cy * sr + sy * sp * cr; m[2] = sy * cp;
   m[3] = cp * sr;                m[4] = cp * cr;                 m[5] = -sp;
   m[6] = -sy * cr + cy * sp * sr; m[7] = sy * sr + cy * sp * cr; m[8] = cy * cp;
   return m;
}
/** o = M * v (local -> world rotation). */
export const mulMat3 = (o, m, v) => {
   const x = m[0] * v.x + m[1] * v.y + m[2] * v.z;
   const y = m[3] * v.x + m[4] * v.y + m[5] * v.z;
   const z = m[6] * v.x + m[7] * v.y + m[8] * v.z;
   o.x = x; o.y = y; o.z = z; return o;
};
/** o = M^T * v (world -> local rotation). */
export const mulMat3T = (o, m, v) => {
   const x = m[0] * v.x + m[3] * v.y + m[6] * v.z;
   const y = m[1] * v.x + m[4] * v.y + m[7] * v.z;
   const z = m[2] * v.x + m[5] * v.y + m[8] * v.z;
   o.x = x; o.y = y; o.z = z; return o;
};

// ---------- 2D polygon helpers ([x,y] pairs) ----------
export function polyArea(pts) {
   let a = 0;
   for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p[0] * q[1] - q[0] * p[1];
   }
   return a / 2;
}
/** Intersection of lines (p1 + t*d1) and (p2 + s*d2); returns [x,y] or null if parallel. */
export function lineIntersect(p1x, p1y, d1x, d1y, p2x, p2y, d2x, d2y) {
   const den = d1x * d2y - d1y * d2x;
   if (Math.abs(den) < 1e-12) return null;
   const t = ((p2x - p1x) * d2y - (p2y - p1y) * d2x) / den;
   return [p1x + d1x * t, p1y + d1y * t];
}
