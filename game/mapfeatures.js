// Mission features on the minimap / big map (client): dragon's teeth, hedgehogs, wire, trenches,
// bridges. Drawn into a cached overlay canvas (map metres -> 512 px) that is rebuilt only when the
// terrain's `version` / `heightVersion` changes (teeth blasted, wire flattened, bridge blown).
const N = 512;

export class MapFeatures {
   constructor(T) { this.T = T; this.cv = null; this.key = ''; this.any = false; }
   /** The overlay canvas, or null when the map has no features. */
   layer() {
      const T = this.T; if (!T) return null;
      const key = (T.version | 0) + ':' + (T.heightVersion | 0);
      if (key !== this.key) { this.key = key; this._build(); }
      return this.any ? this.cv : null;
   }
   _build() {
      const T = this.T, half = T.half ?? 500, k = N / (2 * half), m = (v) => (v + half) * k;
      const cv = this.cv || (this.cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(N, N) : Object.assign(document.createElement('canvas'), { width: N, height: N }));
      const g = cv.getContext('2d'); g.clearRect(0, 0, N, N); this.any = false;
      g.lineCap = 'round'; g.lineJoin = 'round';
      // trenches: dark earth band with a light rim, drawn at least 2 px wide so they read at 4 m/px
      for (const tr of T.trenches || []) {
         this.any = true;
         const path = () => { g.beginPath(); tr.pts.forEach(([x, z], i) => (i ? g.lineTo(m(x), m(z)) : g.moveTo(m(x), m(z)))); };
         path(); g.strokeStyle = 'rgba(210,190,140,.55)'; g.lineWidth = Math.max(3.5, (tr.w + 2) * k); g.stroke();
         path(); g.strokeStyle = '#2b2116'; g.lineWidth = Math.max(2, tr.w * k); g.stroke();
      }
      // bridges: deck as a light bar; a blown gap is cut out and marked with a red cross
      for (const b of T.bridges || []) {
         this.any = true;
         const ax = m(b.x0), az = m(b.z0), bx = m(b.x1), bz = m(b.z1), w = Math.max(3, (b.w || 7) * k);
         const seg = (t0, t1) => { g.beginPath(); g.moveTo(ax + (bx - ax) * t0, az + (bz - az) * t0); g.lineTo(ax + (bx - ax) * t1, az + (bz - az) * t1); g.stroke(); };
         g.lineCap = 'butt';
         g.strokeStyle = '#1d1a14'; g.lineWidth = w + 2;
         if (b.blown) { seg(0, b.gap[0]); seg(b.gap[1], 1); } else seg(0, 1);
         g.strokeStyle = '#cdbf9c'; g.lineWidth = w;
         if (b.blown) { seg(0, b.gap[0]); seg(b.gap[1], 1); } else seg(0, 1);
         g.lineCap = 'round';
         if (b.blown) {
            const t = (b.gap[0] + b.gap[1]) / 2, cx = ax + (bx - ax) * t, cz = az + (bz - az) * t, r = 4;
            g.strokeStyle = '#d23a2a'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - r, cz - r); g.lineTo(cx + r, cz + r); g.moveTo(cx + r, cz - r); g.lineTo(cx - r, cz + r); g.stroke();
         }
      }
      // wire: thin dashed rust line along each segment (flattened wire is gone)
      g.setLineDash([2, 1.2]); g.strokeStyle = '#b5774a'; g.lineWidth = 1.5;   // rust, reads on grass and sand
      for (const o of T.wires || []) {
         if (o.alive === false) continue; this.any = true;
         const L = (o.w || 6) / 2, c = Math.cos(o.yaw || 0), s = -Math.sin(o.yaw || 0);
         g.beginPath(); g.moveTo(m(o.x - c * L), m(o.z - s * L)); g.lineTo(m(o.x + c * L), m(o.z + s * L)); g.stroke();
      }
      g.setLineDash([]);
      // teeth (light concrete dots) and hedgehogs (steel crosses with a dark outline)
      for (const o of T.objects || []) {
         if (o.alive === false) continue;
         if (o.kind === 'teeth') { this.any = true; g.fillStyle = '#d6cdb6'; g.fillRect(m(o.x) - 0.8, m(o.z) - 0.8, 1.6, 1.6); }
         else if (o.kind === 'hedgehog') {
            this.any = true; const x = m(o.x), z = m(o.z);
            const X = () => { g.beginPath(); g.moveTo(x - 1.8, z - 1.8); g.lineTo(x + 1.8, z + 1.8); g.moveTo(x + 1.8, z - 1.8); g.lineTo(x - 1.8, z + 1.8); g.stroke(); };
            g.strokeStyle = '#111'; g.lineWidth = 2.2; X(); g.strokeStyle = '#a9b2bb'; g.lineWidth = 1; X();
         }
      }
   }
}
