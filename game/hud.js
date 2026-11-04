// game/hud.js — battle HUD on one 2D canvas over the 3D view: reticle (dispersion circle centred
// on the crosshair, small barrel marker while the gun is still laying, reload ring, penetration-chance colour, gun-limit and lock-on markers),
// vehicle markers, damage panel, hit log, received-hit arrows, kill feed, team panels, minimap,
// timer / bases, countdown and the Tab score table. Reads sim state only (optional chaining
// everywhere) and consumes world.events by `seq`. hud.msg(text, colour) is public (audio/callouts).
import * as THREE from '../vendor/three/three.module.min.js';
import { AMMO, BALLISTICS, MODULES, CREW_NAMES, CONSUMABLES, PLATE_NAMES } from './config.js';
import { solveElevation } from './ballistics.js';
import { MapFeatures } from './mapfeatures.js';

const css = getComputedStyle(document.documentElement), tok = (n, d) => (css.getPropertyValue(n).trim() || d);
const COL = {
   hud: tok('--hud', '#ece4c6'), dim: tok('--hud-dim', '#a9a385'), panel: tok('--panel', 'rgba(20,23,22,.74)'), edge: tok('--panel-edge', 'rgba(216,207,168,.28)'),
   ally: tok('--ally', '#6fe0b0'), enemy: tok('--enemy', '#ff4b3a'), self: tok('--self', '#fff6d8'),
   ok: tok('--ok', '#8fd65a'), warn: tok('--warn', '#f1c83c'), bad: tok('--bad', '#ee4b36'), dead: tok('--dead', '#5a5850'),
   penYes: tok('--pen-yes', '#57e04a'), penMaybe: tok('--pen-maybe', '#ffd23a'), penNo: tok('--pen-no', '#ff3a2a'),
   ret: tok('--reticle', '#f4eed6'), signal: tok('--signal', '#e07a1f'),
   mapGround: tok('--map-ground', '#6f7448'), mapForest: tok('--map-forest', '#3f4a2a'), mapWater: tok('--map-water', '#3d5f6b'), mapRoad: tok('--map-road', '#b9ad80'), mapInk: tok('--map-ink', '#1c1f12'),
};
const FONT = tok('--font', 'Bahnschrift, sans-serif'), FCOND = tok('--font-cond', 'Arial Narrow, sans-serif'), FST = tok('--font-stencil', 'Impact, sans-serif');
const MOD_SHORT = { engine: 'MOT', fuel: 'KRS', ammo: 'MUN', gun: 'KAN', turretRing: 'TDK', radio: 'FUNK', optics: 'OPT', trackL: 'K-L', trackR: 'K-R' };
const CREW_SHORT = { commander: 'KDT', gunner: 'RS', driver: 'FA', radio: 'FU', loader: 'LS', loader2: 'LS2' };
const SPACED_PART = { track: true, skirt: true, mantlet: true };
const D2R = Math.PI / 180;
const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const mmss = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const tankName = (t) => t?.name || (t?.cfg?.site ? t.cfg.name : t?.cfg?.short) || t?.cfg?.name || t?.cls || '?';   // emplacements by their full name

// probability that pen × (1 + u) > effT, u triangular on [-r, r]
function penChance(pen, effT, r = BALLISTICS.PEN_RANDOM) {
   if (!(effT > 0)) return 1;
   const x = effT / pen - 1;   // need u > x
   if (x <= -r) return 1; if (x >= r) return 0;
   const cdf = x < 0 ? (x + r) * (x + r) / (2 * r * r) : 1 - (r - x) * (r - x) / (2 * r * r);
   return 1 - cdf;
}
export function penAt(a, dist) {
   if (!a) return 0;
   const rule = AMMO[a.type] || {}, p500 = a.pen500 ?? a.pen * (1 - (rule.falloff ?? 0));
   const f = clamp((dist - BALLISTICS.FALL_START) / (BALLISTICS.FALL_END - BALLISTICS.FALL_START), 0, 1);
   return a.pen + (p500 - a.pen) * f;
}

export class HUD {
   constructor(canvas, world, ctx = {}) {
      this.cv = canvas; this.g = canvas.getContext('2d'); this.world = world; this.ctx = ctx;
      this.armor = ctx.armor || {}; this.tcam = ctx.cam; this.R = ctx.R; this.G = window.__game;
      this.v = new THREE.Vector3(); this.v2 = new THREE.Vector3(); this.dir = new THREE.Vector3();
      this.lastSeq = -1; this.log = []; this.feed = []; this.hitsIn = []; this.msgs = [];
      this.radio = []; this.radioN = null; this.objFlash = {}; this.seen = new Set();   // campaign
      this.bigMap = false; this.score = false; this.pen = null; this.t = 0;
      this._armCache = new Map();
      this.onKey = (e) => {
         if (e.code === 'Tab') { this.score = e.type === 'keydown'; e.preventDefault(); }
         if (e.code === 'KeyM' && e.type === 'keydown' && !e.repeat) this.bigMap = !this.bigMap;
      };
      addEventListener('keydown', this.onKey); addEventListener('keyup', this.onKey);
      this.resize(); this.onResize = () => this.resize(); addEventListener('resize', this.onResize);
      this.buildMap(); this.mapFx = new MapFeatures(world.terrain);
      canvas.style.display = '';
   }
   dispose() {
      removeEventListener('keydown', this.onKey); removeEventListener('keyup', this.onKey); removeEventListener('resize', this.onResize);
      this.g.clearRect(0, 0, this.cv.width, this.cv.height);
   }
   resize() {
      const dpr = Math.min(2, devicePixelRatio || 1);
      this.W = innerWidth; this.H = innerHeight; this.dpr = dpr;
      this.cv.width = this.W * dpr; this.cv.height = this.H * dpr;
   }
   msg(text, color = COL.hud, life = 3) { this.msgs.push({ text, color, t: 0, life }); if (this.msgs.length > 4) this.msgs.shift(); }
   addLog(text, color) { this.log.unshift({ text, color, t: 0 }); if (this.log.length > 6) this.log.pop(); }

   // ---------- minimap background (once per battle) ----------
   buildMap() {
      const T = this.world.terrain, N = 256, cv = this.mapCv = document.createElement('canvas'); cv.width = cv.height = N;
      if (!T) return;
      const g = cv.getContext('2d'), img = g.createImageData(N, N), half = T.half ?? 500, s = 2 * half / N;
      const cG = new THREE.Color(COL.mapGround), cF = new THREE.Color(COL.mapForest), cW = new THREE.Color(COL.mapWater), cR = new THREE.Color(COL.mapRoad), c = new THREE.Color();
      let hmin = Infinity, hmax = -Infinity; const H = new Float32Array(N * N);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const h = T.heightAt(-half + (i + 0.5) * s, -half + (j + 0.5) * s); H[j * N + i] = h; hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); }
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
         const x = -half + (i + 0.5) * s, z = -half + (j + 0.5) * s, h = H[j * N + i];
         const gi = T.groundIdxAt ? T.groundIdxAt(x, z) : 2;
         c.copy(gi === 4 || (T.water != null && h < T.water) ? cW : gi === 0 ? cR : cG);
         const hx = H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)], hz = H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i];
         const shade = clamp(1 + (-hx - hz) * 0.06, 0.6, 1.35) * (0.85 + 0.3 * (h - hmin) / Math.max(1, hmax - hmin));
         c.multiplyScalar(shade);
         // contour lines every 5 m
         if (Math.floor(h / 5) !== Math.floor(H[j * N + Math.min(N - 1, i + 1)] / 5)) c.multiplyScalar(0.82);
         const k = (j * N + i) * 4; img.data[k] = c.r * 255; img.data[k + 1] = c.g * 255; img.data[k + 2] = c.b * 255; img.data[k + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const toM = (v) => (v + half) / s;
      for (const o of T.objects || []) {
         if (o.kind === 'tree' || o.kind === 'bush') { g.fillStyle = o.kind === 'tree' ? 'rgba(40,52,26,.75)' : 'rgba(60,76,36,.6)'; g.fillRect(toM(o.x) - 1, toM(o.z) - 1, 2, 2); }
         else if (o.kind === 'house' || o.kind === 'church') {
            g.save(); g.translate(toM(o.x), toM(o.z)); g.rotate(-(o.yaw || 0)); g.fillStyle = '#3a3428'; g.fillRect(-o.w / s / 2, -o.d / s / 2, o.w / s, o.d / s); g.restore();
         } else if (o.kind === 'rock') { g.fillStyle = '#6b665c'; g.fillRect(toM(o.x) - 1, toM(o.z) - 1, 2, 2); }
      }
      // grid A-K / 1-10 like a field map
      g.strokeStyle = 'rgba(20,22,12,.35)'; g.lineWidth = 1;
      for (let k = 1; k < 10; k++) { g.beginPath(); g.moveTo(k * N / 10, 0); g.lineTo(k * N / 10, N); g.moveTo(0, k * N / 10); g.lineTo(N, k * N / 10); g.stroke(); }
   }

   proj(x, y, z, out) {
      const v = this.v.set(x, y, z).project(this.R.camera);
      out.x = (v.x * 0.5 + 0.5) * this.W; out.y = (-v.y * 0.5 + 0.5) * this.H; out.ok = v.z < 1 && v.z > -1;
      return out;
   }

   // ---------- events ----------
   events(w, p) {
      const ev = w.events; if (!ev) return;
      const list = Array.isArray(ev) ? ev : ev.list || ev.items || ev.buf || [];
      let maxSeq = this.lastSeq;
      for (let i = 0; i < list.length; i++) {
         const e = list[i]; if (!e) continue;
         const seq = e.seq ?? i; if (seq <= this.lastSeq) continue;
         if (seq > maxSeq) maxSeq = seq;
         this.onEvent(e, w, p);
      }
      this.lastSeq = maxSeq;
   }
   onEvent(e, w, p) {
      const type = e.type ?? e.kind, mine = p && e.srcId === p.id, onMe = p && e.dstId === p.id;
      const dst = w.tanks?.find((t) => t.id === e.dstId), src = w.tanks?.find((t) => t.id === e.srcId);
      const effT = e.effT != null ? Math.round(e.effT) + ' mm' : '';
      const modName = MODULES[e.module ?? e.mod]?.name || CREW_NAMES[e.crew ?? e.module] || e.module || '';
      if (e.wreck) { if (mine && ['pen', 'ricochet', 'noPen', 'he'].includes(type)) this.addLog('Wrack getroffen', COL.hud); return; }
      if (mine) {
         if (type === 'pen') this.addLog(`Durchschlag ${effT ? effT + ' effektiv' : ''} · ${Math.round(e.dmg || 0)} Schaden`, COL.penYes);
         else if (type === 'ricochet') this.addLog('Abpraller' + (e.angleDeg ? ` (${Math.round(e.angleDeg)}°)` : ''), COL.penMaybe);
         else if (type === 'noPen') this.addLog('Kein Durchschlag' + (effT ? ` (${effT})` : ''), COL.penNo);
         else if (type === 'he' && e.dmg > 0) this.addLog(`Sprengwirkung · ${Math.round(e.dmg)} Schaden`, COL.warn);
         else if (type === 'crit' && modName) this.addLog('Modul beschädigt: ' + modName, COL.warn);
         else if (type === 'ammoRack') this.addLog('Munitionslager zerstört!', COL.bad);
         else if (type === 'fire' && dst) this.addLog('Ziel brennt!', COL.signal);
      }
      if (onMe) {
         if (type === 'pen' || type === 'he') { if (e.dmg > 0) this.addLog(`Treffer erhalten: −${Math.round(e.dmg)}` + (src ? ` (${tankName(src)})` : ''), COL.bad); }
         else if (type === 'ricochet') this.msg('Abgeprallt!', COL.ok, 1.6);
         else if (type === 'noPen') this.msg('Nicht durchschlagen!', COL.ok, 1.6);
         else if (type === 'crit' && modName) this.msg((CREW_NAMES[e.crew] ? 'Besatzung verwundet: ' : 'Modul beschädigt: ') + modName, COL.warn, 2.5);
         else if (type === 'ammoRack') this.msg('Munitionslager zerstört!', COL.bad, 3);
         else if (type === 'fire') this.msg('Feuer!', COL.signal, 2.5);
         else if (type === 'track') this.msg('Kette beschädigt!', COL.warn, 2);
         const sp = e.from || src?.pos;
         if (sp && ['pen', 'ricochet', 'noPen', 'he'].includes(type)) this.hitsIn.push({ x: sp.x, z: sp.z, t: 0, pen: type === 'pen' || (type === 'he' && e.dmg > 0) });
         if (this.hitsIn.length > 6) this.hitsIn.shift();
      }
      if (type === 'objective' && w.campaign) {
         this.objFlash[e.id] = 1.2;
         if (e.state === 'done') this.msg('Ziel erfüllt: ' + (e.text || ''), COL.ok, 3.2);
         else if (e.state === 'failed') this.msg('Ziel verfehlt: ' + (e.text || ''), COL.bad, 3.2);
         else if (e.state === 'active' && e.text) { this.objT ??= this.t; if (this.t - this.objT > 0.5) this.msg('Neues Ziel: ' + e.text, COL.warn, 3.2); }   // the opening batch only flashes
      }
      if (type === 'kill' && dst) {
         this.feed.unshift({ a: src ? tankName(src) : '', at: src?.team, b: tankName(dst), bt: dst.team, t: 0 });
         if (this.feed.length > 6) this.feed.pop();
         if (mine) this.msg('Gegner zerstört!', COL.penYes, 2.5);
      }
   }

   // ---------- per-frame pen indicator ----------
   aimInfo(w, p) {
      const at = this.G?.aimTarget, A = this.armor;
      this.pen = null;
      if (!at?.tank || !at.tank.alive) return;
      let hit = at.hit, hits = at.hits;
      if (!hit && A.rayArmor && A.armorFor && at.tank.cfg?.hull) {
         const cam = this.R.camera.position; this.tcam.aimDir(this.dir);
         hits = A.rayArmor(A.armorFor(at.tank.cfg), at.tank.pose(), cam, this.dir);
         hit = hits?.find((h) => h.t > 0) || null;
      }
      const ammo = (p.cfg?.gun?.ammo || []).find((a) => a.type === (p.ammoSel || 'AP')) || p.cfg?.gun?.ammo?.[0];
      if (!hit || !ammo) { this.pen = { tank: at.tank, chance: -1 }; return; }
      const dist = Math.hypot(at.tank.pos.x - p.pos.x, at.tank.pos.z - p.pos.z), rule = AMMO[ammo.type] || {};
      const pen = penAt(ammo, dist), cal = ammo.cal ?? p.cfg.gun.cal ?? 75;
      let ang = hit.angleDeg ?? 0, norm = rule.norm ?? 0;
      if (hit.t > 0 && cal > BALLISTICS.OVERMATCH_NORM * hit.t) norm *= 1.4 * cal / hit.t;
      const overmatch = hit.t > 0 && cal > BALLISTICS.OVERMATCH * hit.t;
      const ric = rule.ric != null && !overmatch && ang > rule.ric;
      ang = Math.max(0, ang - norm);
      let effT = hit.t / Math.max(0.02, Math.cos(ang * D2R)), plate = PLATE_NAMES[hit.plateId] || hit.plateName || '', heatDead = false;
      // spaced armour (track / skirt / mantlet) only eats into the pen: add the real plate behind it
      if (SPACED_PART[hit.part] && hits && !ric) {
         if (ammo.type === 'HEAT' && hit.part !== 'mantlet') heatDead = true;
         const i0 = hits.indexOf(hit), next = i0 >= 0 ? hits.slice(i0 + 1).find((h) => h.t > 0 && (h.part === 'hull' || h.part === 'turret' || h.part === 'cupola')) : null;
         if (next) {
            let a2 = next.angleDeg ?? 0, n2 = rule.norm ?? 0;
            if (cal > BALLISTICS.OVERMATCH_NORM * next.t) n2 *= 1.4 * cal / next.t;
            effT += next.t / Math.max(0.02, Math.cos(Math.max(0, a2 - n2) * D2R));
            plate = (PLATE_NAMES[next.plateId] || next.plateName || '') + ' + ' + plate;
         }
      }
      this.pen = { tank: at.tank, chance: ric || heatDead || hit.part === 'gun' ? 0 : penChance(pen, effT), effT, pen, ric, plate, t: hit.t, dist };
   }

   // ---------- draw ----------
   draw(dt) {
      const w = this.world, g = this.g, p = w.player; this.t += dt;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.W, this.H);
      if (!p || !this.R) return;
      this.events(w, p);
      for (const a of [this.log, this.feed, this.hitsIn, this.msgs]) for (const e of a) e.t += dt;
      while (this.log.length && this.log[this.log.length - 1].t > 7) this.log.pop();
      while (this.feed.length && this.feed[this.feed.length - 1].t > 9) this.feed.pop();
      while (this.hitsIn.length && this.hitsIn[0].t > 3) this.hitsIn.shift();
      while (this.msgs.length && this.msgs[0].t > this.msgs[0].life) this.msgs.shift();
      this.aimInfo(w, p);
      const C = w.campaign;
      if (C) { this.campTick(C, dt); for (const k in this.objFlash) this.objFlash[k] -= dt; }
      this.drawMarkers(g, w, p);
      if (C) this.drawWaypoints(g, w, p, C);
      if (p.alive !== false) this.drawReticle(g, w, p);
      this.drawHitsIn(g, p);
      this.drawDamagePanel(g, p);
      this.drawSpotLamp(g, p, dt);
      this.drawLog(g);
      this.drawTop(g, w);
      if (C) this.drawRadio(g, w, C);
      this.drawTeams(g, w, p, C ? this.drawObjectives(g, w, C) : 50);
      this.drawFeed(g);
      this.drawMinimap(g, w, p);
      this.drawMsgs(g);
      if (w.phase === 'countdown') this.big(g, Math.ceil(w.countdown ?? 0) || 'LOS!', 'Gefecht beginnt in');
      else if (w.phase && w.phase !== 'playing') this.big(g, w.phase === 'won' ? (C ? 'AUFTRAG ERFÜLLT' : 'SIEG') : w.phase === 'lost' ? (C ? 'GESCHEITERT' : 'NIEDERLAGE') : 'UNENTSCHIEDEN', w.result?.reason || '');
      else if (p.alive === false) this.big(g, 'ZERSTÖRT', 'Ihr Panzer wurde vernichtet');
      if (this.score) this.drawScore(g, w, p);
   }

   panel(g, x, y, w, h) { g.fillStyle = COL.panel; g.fillRect(x, y, w, h); g.strokeStyle = COL.edge; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); }
   text(g, s, x, y, color = COL.hud, size = 13, align = 'left', font = FONT, weight = '') {
      g.font = `${weight} ${size}px ${font}`; g.textAlign = align; g.textBaseline = 'middle';
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillText(s, x + 1, y + 1); g.fillStyle = color; g.fillText(s, x, y);
   }

   drawReticle(g, w, p) {
      const cam = this.R.camera, scoped = this.tcam?.scoped, cx = this.W / 2, cy = this.H / 2, s = this._s ??= {};
      // The circle sits on the crosshair: the aim point is on the camera ray, and the sim lays the
      // gun (with superelevation for drop) at exactly that point. While the turret still traverses
      // or the gun is at an elevation stop, a small diamond shows where the shot would land now.
      const gx = cx, gy = cy, dist = this.G?.aimDist ?? 300;
      const b = this.barrelMark(p, s);
      this.ret = { gx, gy, cx, cy, bx: b ? s.x : cx, by: b ? s.y : cy, laid: !b };
      const fovT = Math.tan(cam.fov * D2R / 2), disp = p.aimDisp ?? p.cfg?.gun?.disp ?? 0.4;
      const r = clamp(disp / 100 / fovT * (this.H / 2), 6, this.H * 0.45);
      const pc = this.pen, col = !pc ? COL.ret : pc.chance < 0 ? '#9a9a90' : pc.chance > 0.66 ? COL.penYes : pc.chance > 0.25 ? COL.penMaybe : COL.penNo;
      g.lineWidth = 2; g.strokeStyle = 'rgba(0,0,0,.45)';
      g.beginPath(); g.arc(gx, gy, r + 1.5, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = col; g.lineWidth = 1.6; g.beginPath(); g.arc(gx, gy, r, 0, Math.PI * 2); g.stroke();
      // ticks on the circle
      for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; g.beginPath(); g.moveTo(gx + Math.cos(a) * r, gy + Math.sin(a) * r); g.lineTo(gx + Math.cos(a) * (r + 7), gy + Math.sin(a) * (r + 7)); g.stroke(); }
      g.fillStyle = col; g.fillRect(gx - 1.5, gy - 1.5, 3, 3);
      if (b) {   // barrel marker: hollow diamond + dot, clearly not a second reticle
         const k = 5, bx = s.x, by = s.y;
         g.lineWidth = 2.6; g.strokeStyle = 'rgba(0,0,0,.5)'; g.beginPath(); g.moveTo(bx, by - k); g.lineTo(bx + k, by); g.lineTo(bx, by + k); g.lineTo(bx - k, by); g.closePath(); g.stroke();
         g.lineWidth = 1.3; g.strokeStyle = COL.warn; g.stroke(); g.fillStyle = COL.warn; g.fillRect(bx - 0.75, by - 0.75, 1.5, 1.5);
      }
      // camera aim (centre): small chevrons
      g.strokeStyle = 'rgba(244,238,214,.75)'; g.lineWidth = 1.2; g.beginPath();
      g.moveTo(cx - 14, cy); g.lineTo(cx - 6, cy); g.moveTo(cx + 6, cy); g.lineTo(cx + 14, cy); g.moveTo(cx, cy + 6); g.lineTo(cx, cy + 14); g.stroke();
      // reload ring
      const rmax = p.reloadMax || p.cfg?.gun?.reload || 1, rel = clamp(p.reload ?? 0, 0, rmax), R2 = Math.max(r + 14, 34);
      g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.4)'; g.beginPath(); g.arc(gx, gy, R2, -Math.PI / 2 - 0.9, -Math.PI / 2 + 0.9); g.stroke();
      g.strokeStyle = rel > 0 ? COL.warn : COL.ok; g.beginPath(); g.arc(gx, gy, R2, -Math.PI / 2 - 0.9, -Math.PI / 2 - 0.9 + 1.8 * (1 - rel / rmax)); g.stroke();
      this.text(g, rel > 0 ? rel.toFixed(1) + ' s' : 'BEREIT', gx + R2 + 8, gy - R2 * 0.6, rel > 0 ? COL.warn : COL.ok, 12, 'left', FCOND);
      // ammo + distance under the reticle
      this.text(g, `${AMMO[p.ammoSel || 'AP']?.short || p.ammoSel || ''}  ${Math.round(dist)} m`, gx, gy + R2 + 12, COL.dim, 12, 'center', FCOND);
      if (pc && pc.chance >= 0) this.text(g, `${pc.ric ? 'Abpraller' : Math.round(pc.effT) + ' mm'}  /  ${Math.round(pc.pen)} mm Dg.`, gx, gy + R2 + 27, col, 12, 'center', FCOND);
      // gun cannot reach the aim point: elevation outside limits (relative to hull)
      const gun = p.cfg?.gun;
      if (p.gunLimited || p.aimLimited || (gun && p.aimPoint && !scoped && this.elevLimited(p, gun))) {
         g.strokeStyle = COL.bad; g.lineWidth = 2; const k = 9;
         g.beginPath(); g.moveTo(cx - k, cy - k); g.lineTo(cx + k, cy + k); g.moveTo(cx + k, cy - k); g.lineTo(cx - k, cy + k); g.stroke();
      }
      // lock-on brackets
      const lid = p.input?.lockId ?? p.lockId;
      if (lid != null) { const t = w.tanks.find((q) => q.id === lid); if (t?.alive) this.brackets(g, t, COL.signal); }
   }
   // where the shot lands with the gun as it points now: the aim vector from the muzzle turned by
   // the barrel's yaw/pitch error against the solution the sim lays toward. Returns false once the
   // barrel is on the crosshair (within 3 px), else true with the screen point in s.
   barrelMark(p, s) {
      const a = p.aimPoint, m = p.muzzle, d = p.gunDir;
      if (!a || !m || !d || !(m.x || m.z)) return false;
      const ax = a.x - m.x, ay = a.y - m.y, az = a.z - m.z, hd = Math.hypot(ax, az);
      if (hd < 3) return false;
      let el = solveElevation(p.round?.()?.vel ?? 800, hd, ay);
      if (!(el === el)) el = Math.atan2(ay, hd);
      let dy = Math.atan2(d.x, d.z) - Math.atan2(ax, az);
      dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
      const dp = Math.asin(clamp(d.y, -1, 1)) - el;
      if (Math.abs(dy) < 1e-4 && Math.abs(dp) < 1e-4) { this.bres = 0; return false; }
      const yaw = Math.atan2(ax, az) + dy, pit = Math.atan2(ay, hd) + dp, L = Math.hypot(hd, ay);
      const px = m.x + Math.cos(pit) * Math.sin(yaw) * L, py = m.y + Math.sin(pit) * L, pz = m.z + Math.cos(pit) * Math.cos(yaw) * L;
      this.proj(px, py, pz, s);
      const e = this.R.camera.matrixWorld.elements, c = this.R.camera.position;
      if ((px - c.x) * e[8] + (py - c.y) * e[9] + (pz - c.z) * e[10] > 0) {   // behind the camera: to the side it lies on
         s.x = (px - c.x) * e[0] + (py - c.y) * e[1] + (pz - c.z) * e[2] > 0 ? this.W : 0; s.y = this.H / 2;
      }
      s.x = clamp(s.x, 14, this.W - 14); s.y = clamp(s.y, 14, this.H - 14);   // off screen: pinned to the edge
      return (this.bres = Math.hypot(s.x - this.W / 2, s.y - this.H / 2)) > 3;
   }
   elevLimited(p, gun) {
      const a = p.aimPoint, dx = a.x - p.pos.x, dz = a.z - p.pos.z, h = Math.hypot(dx, dz);
      if (h < 5) return false;
      const need = Math.atan2(a.y - (p.pos.y + 2), h) / D2R;
      // hull pitch along the aim direction (positive pitch = nose up)
      const fx = -Math.sin(p.yaw || 0), fz = -Math.cos(p.yaw || 0), along = (dx * fx + dz * fz) / h;
      const rel = need - (p.pitch || 0) / D2R * along;
      return rel > (gun.elev ?? 20) + 0.5 || rel < (gun.depr ?? -8) - 0.5;
   }
   brackets(g, t, col) {
      const s = this._b ??= {}; this.proj(t.pos.x, t.pos.y + 1.4, t.pos.z, s); if (!s.ok) return;
      const d = Math.max(1, this.R.camera.position.distanceTo(this.v2.set(t.pos.x, t.pos.y, t.pos.z)));
      const k = clamp(4 / d / Math.tan(this.R.camera.fov * D2R / 2) * this.H / 2, 14, 160);
      g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const cx = s.x + sx * k, cy = s.y + sy * k * 0.6; g.moveTo(cx, cy - sy * 9); g.lineTo(cx, cy); g.lineTo(cx - sx * 9, cy); }
      g.stroke();
   }

   drawMarkers(g, w, p) {
      const s = this._m ??= {}, cam = this.R.camera.position;
      for (const t of w.tanks || []) {
         if (t === p || !t.alive) continue;
         const enemy = t.team !== p.team;
         if (enemy && t.spotted === false) continue;
         const d = Math.hypot(t.pos.x - cam.x, t.pos.z - cam.z); if (d > 445) continue;
         this.proj(t.pos.x, t.pos.y + (t.cfg?.dims?.h ?? 2.4) + 2.2, t.pos.z, s); if (!s.ok) continue;
         const col = enemy ? COL.enemy : COL.ally, bw = 46;
         g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(s.x - bw / 2 - 1, s.y - 1, bw + 2, 6);
         g.fillStyle = col; g.fillRect(s.x - bw / 2, s.y, bw * clamp(t.hp / (t.maxHP || 1), 0, 1), 4);
         this.text(g, tankName(t), s.x, s.y - 9, col, 12, 'center', FCOND);
         if (d < 300) this.text(g, String(Math.round(t.hp)), s.x, s.y + 13, COL.hud, 11, 'center', FCOND);
      }
   }

   drawHitsIn(g, p) {
      const cx = this.W / 2, cy = this.H / 2, camYaw = this.tcam?.yaw ?? 0;
      for (const h of this.hitsIn) {
         const ang = Math.atan2(-(h.x - p.pos.x), -(h.z - p.pos.z)) - camYaw;  // world yaw toward source, relative to the view
         const a = -Math.PI / 2 - ang, R = Math.min(this.W, this.H) * 0.22, al = clamp(1 - h.t / 3, 0, 1);
         g.strokeStyle = h.pen ? `rgba(238,75,54,${al})` : `rgba(241,200,60,${al})`; g.lineWidth = 7;
         g.beginPath(); g.arc(cx, cy, R, a - 0.22, a + 0.22); g.stroke();
         g.fillStyle = g.strokeStyle; g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 16), cy + Math.sin(a) * (R + 16));
         g.lineTo(cx + Math.cos(a - 0.08) * (R + 5), cy + Math.sin(a - 0.08) * (R + 5)); g.lineTo(cx + Math.cos(a + 0.08) * (R + 5), cy + Math.sin(a + 0.08) * (R + 5)); g.fill();
      }
   }

   icon(g, x, y, w, label, state) {
      const c = state === 'destroyed' || state === 'dead' ? COL.bad : state === 'damaged' || state === 'wounded' ? COL.warn : 'rgba(236,228,198,.55)';
      g.fillStyle = state === 'destroyed' || state === 'dead' ? 'rgba(238,75,54,.25)' : state === 'damaged' || state === 'wounded' ? 'rgba(241,200,60,.18)' : 'rgba(255,255,255,.05)';
      g.fillRect(x, y, w, 18); g.strokeStyle = c; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, w - 1, 17);
      this.text(g, label, x + w / 2, y + 9.5, c, 10.5, 'center', FCOND, '600');
   }

   // "you have been spotted" lamp (WoT's sixth sense): lights while the enemy team sees us,
   // pulses and beeps when it comes on
   drawSpotLamp(g, p, dt) {
      const on = p.alive !== false && !!p.spotted && this.world.phase === 'playing';
      if (on && !this.spotOn) { this.spotT = 0; this.G?.audio?.ui?.('spotted'); }
      this.spotOn = on; if (!on) return;
      this.spotT = (this.spotT ?? 0) + dt;
      const x = 14 + 165, y = this.H - 150 - 14 - 44, pulse = this.spotT < 2 ? 0.5 + 0.5 * Math.cos(this.spotT * 9) : 1;
      g.save();
      g.shadowColor = 'rgba(255,120,30,0.9)'; g.shadowBlur = 18 * pulse;
      g.fillStyle = `rgba(255,${130 + 50 * pulse | 0},40,${0.75 + 0.25 * pulse})`;
      g.beginPath(); g.arc(x, y, 17, 0, Math.PI * 2); g.fill();
      g.shadowBlur = 0; g.strokeStyle = 'rgba(40,20,0,0.8)'; g.lineWidth = 2; g.stroke();
      g.fillStyle = '#2a1200'; g.font = `900 24px ${FST}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', x, y + 1);
      g.restore();
      this.text(g, 'AUFGEKLÄRT', x + 26, y + 5, '#ffb050', 15, 'left', FST, '700');
   }

   drawDamagePanel(g, p) {
      const x = 14, W = 330, H = 150, y = this.H - H - 14;
      this.panel(g, x, y, W, H);
      // HP bar
      const f = clamp(p.hp / (p.maxHP || 1), 0, 1);
      this.text(g, tankName(p), x + 10, y + 14, COL.self, 14, 'left', FST, '700');
      this.text(g, `${Math.max(0, Math.round(p.hp))} / ${p.maxHP}`, x + W - 10, y + 14, COL.hud, 13, 'right', FCOND);
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x + 10, y + 26, W - 20, 8);
      g.fillStyle = f > 0.5 ? COL.ok : f > 0.25 ? COL.warn : COL.bad; g.fillRect(x + 10, y + 26, (W - 20) * f, 8);
      // modules
      const mods = p.modules || {}; let i = 0;
      for (const k of Object.keys(MOD_SHORT)) { this.icon(g, x + 10 + i * 34.5, y + 42, 32, MOD_SHORT[k], mods[k]?.state ?? 'ok'); i++; }
      i = 0;
      const crew = p.crew || {};
      for (const k of Object.keys(crew).length ? Object.keys(crew) : ['commander', 'gunner', 'driver', 'radio', 'loader']) {
         const c = crew[k]; this.icon(g, x + 10 + i * 38, y + 66, 35, CREW_SHORT[k] || k.slice(0, 3).toUpperCase(), c?.alive === false ? 'dead' : c?.wounded ? 'wounded' : 'ok'); i++;
      }
      if (p.burning) this.text(g, 'BRAND', x + W - 12, y + 75, COL.signal, 13, 'right', FST, '700');
      // speed
      const kmh = Math.round(Math.abs(p.speedKmh ?? (p.speed || 0) * 3.6));
      this.text(g, String(kmh), x + W - 46, y + 106, COL.hud, 26, 'right', FCOND, '700');
      this.text(g, 'km/h', x + W - 42, y + 110, COL.dim, 11, 'left', FCOND);
      const cr = p.input?.cruise; if (cr) this.text(g, cr > 0 ? '▲'.repeat(cr) : '▼', x + W - 12, y + 130, COL.dim, 11, 'right');
      // ammo slots 1-4
      const ammo = p.cfg?.gun?.ammo || [];
      ammo.slice(0, 4).forEach((a, k) => {
         const sx = x + 10 + k * 52, sy = y + 92, sel = (p.ammoSel || 'AP') === a.type, n = p.ammoCount?.[a.type] ?? p.cfg.gun.load?.[a.type] ?? '–';
         g.fillStyle = sel ? 'rgba(224,122,31,.3)' : 'rgba(255,255,255,.05)'; g.fillRect(sx, sy, 48, 24);
         g.strokeStyle = sel ? COL.signal : COL.edge; g.lineWidth = sel ? 2 : 1; g.strokeRect(sx + 0.5, sy + 0.5, 47, 23);
         g.fillStyle = AMMO[a.type]?.color || '#ccc'; g.fillRect(sx + 4, sy + 5, 4, 14);
         this.text(g, AMMO[a.type]?.short || a.type, sx + 12, sy + 8, sel ? COL.self : COL.hud, 11, 'left', FCOND, '600');
         this.text(g, String(n), sx + 12, sy + 18, COL.dim, 10, 'left', FCOND);
         this.text(g, String(k + 1), sx + 44, sy + 8, COL.dim, 9, 'right', FCOND);
      });
      // consumables 5-7
      const cons = p.consumables || {}; const ids = Object.keys(cons).length ? Object.keys(cons) : Object.keys(CONSUMABLES);
      ids.slice(0, 3).forEach((id, k) => {
         const c = cons[id], sx = x + 10 + k * 70, sy = y + 122, cd = c?.cd > 0, empty = c && c.count <= 0;
         g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(sx, sy, 66, 20);
         g.strokeStyle = empty ? COL.dead : cd ? COL.warn : COL.edge; g.lineWidth = 1; g.strokeRect(sx + 0.5, sy + 0.5, 65, 19);
         this.text(g, `${k + 5} ${CONSUMABLES[id]?.short || id}`, sx + 5, sy + 10.5, empty ? COL.dead : COL.hud, 11, 'left', FCOND);
         this.text(g, cd ? Math.ceil(c.cd) + 's' : c ? '×' + c.count : '', sx + 62, sy + 10.5, cd ? COL.warn : COL.dim, 10, 'right', FCOND);
      });
   }

   drawLog(g) {
      const x = this.W / 2 + 90, y = this.H / 2 + 70;
      this.log.forEach((e, i) => { const a = clamp(1.4 - e.t / 5, 0, 1); g.globalAlpha = a; this.text(g, e.text, x, y + i * 18, e.color, 14, 'left', FCOND, '600'); });
      g.globalAlpha = 1;
   }
   drawMsgs(g) {
      this.msgs.forEach((m, i) => { g.globalAlpha = clamp((m.life - m.t) * 2, 0, 1); this.text(g, m.text, this.W / 2, this.H * 0.28 + i * 26, m.color, 20, 'center', FST, '700'); });
      g.globalAlpha = 1;
   }
   drawTop(g, w) {
      const cx = this.W / 2;
      this.panel(g, cx - 60, 8, 120, 30);
      this.text(g, w.timeLeft != null ? mmss(w.timeLeft) : mmss(w.time || 0), cx, 23, COL.hud, 20, 'center', FCOND, '700');
      const caps = w.caps || [];
      caps.forEach((c, i) => {
         const bx = cx - 100 + (i - (caps.length - 1) / 2) * 210 + 100 - 100, by = 44, bw = 200;
         if (!(c.progress > 0)) return;
         this.panel(g, bx, by, bw, 18);
         // progress is made by the capper (team that is NOT the owner)
         const capTeam = c.capper ?? (c.team === 1 ? 2 : c.team === 2 ? 1 : null), mine = capTeam === w.player?.team;
         g.fillStyle = mine ? COL.ally : COL.enemy; g.fillRect(bx + 2, by + 2, (bw - 4) * clamp(c.progress / 100, 0, 1), 14);
         this.text(g, `Basis ${c.team === w.player?.team ? '(eigene)' : c.team ? '(Gegner)' : ''} ${Math.round(c.progress)}`, bx + bw / 2, by + 9.5, COL.hud, 12, 'center', FCOND, '600');
      });
   }
   drawTeams(g, w, p, allyY = 50) {
      const all = w.tanks || [], al = all.filter((t) => t.team === p.team);
      let en = all.filter((t) => t.team !== p.team);
      if (w.campaign) {   // operations: emplacements live in the objectives; enemies appear once spotted
         for (const t of en) if (t.alive && t.spotted !== false) this.seen.add(t.id);
         en = en.filter((t) => !t.cfg?.site && this.seen.has(t.id)).slice(0, 14);
      }
      this.enRows = en.length;
      const row = (t, x, y, right, col) => {
         const dead = !t.alive, f = clamp(t.hp / (t.maxHP || 1), 0, 1), bw = 54;
         g.fillStyle = 'rgba(20,23,22,.55)'; g.fillRect(x, y, 170, 17);
         this.text(g, (t === p ? '▶ ' : '') + tankName(t), right ? x + 166 : x + 4, y + 9, dead ? COL.dead : t === p ? COL.self : col, 12, right ? 'right' : 'left', FCOND, '600');
         const hx = right ? x + 4 : x + 170 - bw - 4;
         g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(hx, y + 6, bw, 5);
         if (!dead) { g.fillStyle = col; g.fillRect(right ? hx + bw * (1 - f) : hx, y + 6, bw * f, 5); }
         if (dead) { g.strokeStyle = COL.dead; g.beginPath(); g.moveTo(x + 4, y + 9); g.lineTo(x + 166, y + 9); g.stroke(); }
      };
      al.forEach((t, i) => row(t, 10, allyY + i * 19, false, COL.ally));
      en.forEach((t, i) => row(t, this.W - 180, 50 + i * 19, true, COL.enemy));
      // tally
      const na = al.filter((t) => t.alive).length, ne = en.filter((t) => t.alive).length;
      this.text(g, String(na), this.W / 2 - 80, 23, COL.ally, 22, 'right', FCOND, '700');
      this.text(g, String(ne), this.W / 2 + 80, 23, COL.enemy, 22, 'left', FCOND, '700');
   }
   drawFeed(g) {
      const x = this.W - 190, y0 = 60 + 19 * Math.max(0, this.enRows ?? (this.world.tanks || []).filter((t) => t.team !== this.world.player?.team).length);
      this.feed.forEach((f, i) => {
         g.globalAlpha = clamp(9 - f.t, 0, 1);
         const y = y0 + 12 + i * 18, me = this.world.player?.team;
         g.font = `600 12px ${FCOND}`; const wb = g.measureText(f.b).width;
         this.text(g, f.b, x + 176, y, f.bt === me ? COL.ally : COL.enemy, 12, 'right', FCOND, '600');
         this.text(g, '✕', x + 170 - wb - 8, y, COL.dim, 11, 'right');
         if (f.a) this.text(g, f.a, x + 170 - wb - 24, y, f.at === me ? COL.ally : COL.enemy, 12, 'right', FCOND, '600');
      });
      g.globalAlpha = 1;
   }

   drawMinimap(g, w, p) {
      const T = w.terrain, half = T?.half ?? 500, big = this.bigMap;
      const S = big ? Math.min(this.W, this.H) * 0.8 : clamp(Math.min(this.W, this.H) * 0.28, 180, 300);
      const x = big ? (this.W - S) / 2 : this.W - S - 14, y = big ? (this.H - S) / 2 : this.H - S - 14, k = S / (2 * half);
      const mx = (v) => x + (v + half) * k, mz = (v) => y + (v + half) * k;
      g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x - 3, y - 3, S + 6, S + 6);
      g.globalAlpha = big ? 0.95 : 0.88; g.drawImage(this.mapCv, x, y, S, S); g.globalAlpha = 1;
      const fl = this.mapFx?.layer(); if (fl) g.drawImage(fl, x, y, S, S);   // teeth, wire, trenches, bridges
      g.strokeStyle = COL.edge; g.lineWidth = 1; g.strokeRect(x - 0.5, y - 0.5, S + 1, S + 1);
      // bases
      const bases = T?.bases ? Object.entries(T.bases).filter(([, b]) => b) : [];
      for (const c of (w.caps?.length ? w.caps.map((c) => [c.team, { x: c.pos?.x ?? c.x, z: c.pos?.z ?? c.z, r: c.r }]) : bases.map(([k, b]) => [k === 'team1' ? 1 : k === 'team2' ? 2 : null, b]))) {
         const [team, b] = c; if (b?.x == null) continue;
         const col = team == null ? COL.hud : team === p.team ? COL.ally : COL.enemy;
         g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash([4, 3]); g.beginPath(); g.arc(mx(b.x), mz(b.z), Math.max(5, (b.r || 40) * k), 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
         g.fillStyle = col; g.fillRect(mx(b.x) - 3, mz(b.z) - 3, 6, 6);
      }
      if (w.campaign) this.drawMapMarkers(g, w.campaign, mx, mz, k, big);
      // view range + draw range
      g.strokeStyle = 'rgba(255,246,216,.45)'; g.lineWidth = 1;
      g.beginPath(); g.arc(mx(p.pos.x), mz(p.pos.z), (p.viewRange || p.cfg?.view || 350) * k, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,.15)'; g.beginPath(); g.arc(mx(p.pos.x), mz(p.pos.z), 445 * k, 0, Math.PI * 2); g.stroke();
      // camera direction wedge
      const cy = this.tcam?.yaw ?? 0, fov = this.R.camera.fov * D2R * this.R.camera.aspect * 0.5, L = 70 * k * 4;
      g.fillStyle = 'rgba(255,246,216,.13)'; g.beginPath(); g.moveTo(mx(p.pos.x), mz(p.pos.z));
      g.lineTo(mx(p.pos.x - Math.sin(cy - fov) * L / k), mz(p.pos.z - Math.cos(cy - fov) * L / k)); g.lineTo(mx(p.pos.x - Math.sin(cy + fov) * L / k), mz(p.pos.z - Math.cos(cy + fov) * L / k)); g.fill();
      // tanks
      for (const t of w.tanks || []) {
         if (t === p) continue;
         const enemy = t.team !== p.team; if (enemy && t.spotted === false && t.alive) continue;
         const px = mx(t.pos.x), pz = mz(t.pos.z);
         if (!t.alive) { g.strokeStyle = COL.dead; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px - 3, pz - 3); g.lineTo(px + 3, pz + 3); g.moveTo(px + 3, pz - 3); g.lineTo(px - 3, pz + 3); g.stroke(); continue; }
         g.fillStyle = enemy ? COL.enemy : COL.ally; g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 1;
         g.beginPath(); g.moveTo(px, pz - 4.5); g.lineTo(px + 4.5, pz); g.lineTo(px, pz + 4.5); g.lineTo(px - 4.5, pz); g.closePath(); g.fill(); g.stroke();
         if (big) this.text(g, tankName(t), px + 7, pz, enemy ? COL.enemy : COL.ally, 11, 'left', FCOND);
      }
      // player arrow (hull yaw)
      const py = p.yaw || 0, ax = mx(p.pos.x), az = mz(p.pos.z);
      g.save(); g.translate(ax, az); g.rotate(-py); g.fillStyle = COL.self; g.strokeStyle = '#000'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(0, -8); g.lineTo(5, 5); g.lineTo(0, 2.5); g.lineTo(-5, 5); g.closePath(); g.fill(); g.stroke(); g.restore();
      if (!big) this.text(g, 'M – Karte', x + S - 4, y - 10, COL.dim, 10, 'right', FCOND);
   }

   // ---------- campaign (world.campaign): objectives, radio, mission timer, waypoints ----------
   wrap(g, s, maxW, font) {
      g.font = font; const words = String(s).split(' '), out = []; let line = '';
      for (const wd of words) { const t = line ? line + ' ' + wd : wd; if (line && g.measureText(t).width > maxW) { out.push(line); line = wd; } else line = t; }
      if (line) out.push(line); return out;
   }
   campTick(C, dt) {
      const L = C.log || [];
      if (this.radioN == null) this.radioN = Math.max(0, L.length - 2);   // joining late: only the latest lines
      while (this.radioN < L.length) { const e = L[this.radioN++]; this.radio.push({ text: e.text, kind: e.kind || 'radio', t: 0 }); }
      for (const r of this.radio) r.t += dt;
      while (this.radio.length && (this.radio[0].t > 8 || this.radio.length > 3)) this.radio.shift();
   }
   drawObjectives(g, w, C) {
      const x = 10, y = 50, W = 300, F = `600 13px ${FCOND}`, list = (C.objectives || []).filter((o) => !o.hidden || o.state !== 'active');
      const rows = list.map((o) => ({ o, lines: this.wrap(g, o.text + (o.need > 1 ? `  ${o.count ?? 0}/${o.need}` : ''), W - (o.bonus ? 78 : 34), F) }));
      const h = 26 + rows.reduce((a, r) => a + r.lines.length * 16 + 4, 0) + 6;
      this.panel(g, x, y, W, h);
      g.fillStyle = COL.signal; g.fillRect(x, y, 3, h);
      this.text(g, 'AUFTRAG', x + 12, y + 13, COL.signal, 12, 'left', FST, '700');
      const nm = (typeof C.op === 'object' ? C.op?.name : null) || w.script?.op?.name; if (nm) this.text(g, nm, x + W - 8, y + 13, COL.dim, 11, 'right', FCOND, '600');
      let yy = y + 30;
      for (const { o, lines } of rows) {
         const col = o.state === 'done' ? COL.ok : o.state === 'failed' ? COL.bad : COL.hud;
         const mark = o.state === 'done' ? '✓' : o.state === 'failed' ? '✗' : '◇';
         const flash = this.objFlash?.[o.id] > 0 ? clamp(this.objFlash[o.id] / 1.2, 0, 1) : 0;
         if (flash) { g.fillStyle = `rgba(224,122,31,${0.35 * flash})`; g.fillRect(x + 4, yy - 9, W - 8, lines.length * 16 + 2); }
         this.text(g, mark, x + 14, yy, col, 14, 'center', FONT, '700');
         lines.forEach((ln, i) => {
            this.text(g, ln, x + 28, yy + i * 16, o.state === 'active' ? COL.hud : col, 13, 'left', FCOND, '600');
            if (o.state !== 'active') { g.font = F; const lw = g.measureText(ln).width; g.strokeStyle = col; g.globalAlpha = 0.8; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x + 28, yy + i * 16 + 1); g.lineTo(x + 28 + lw, yy + i * 16 + 1); g.stroke(); g.globalAlpha = 1; }
         });
         if (o.bonus) {
            const bx = x + W - 50, by = yy - 7; g.fillStyle = o.state === 'active' ? 'rgba(224,122,31,.25)' : 'rgba(0,0,0,.25)'; g.fillRect(bx, by, 42, 14);
            this.text(g, 'BONUS', bx + 21, by + 7, o.state === 'failed' ? COL.dead : COL.signal, 9, 'center', FONT, '700');
         }
         yy += lines.length * 16 + 4;
      }
      return y + h + 8;
   }
   drawRadio(g, w, C) {
      const cx = this.W / 2, timer = C.timer && C.timer.left != null;
      let y = 44 + ((w.caps || []).some((c) => c.progress > 0) ? 24 : 0);
      if (timer) {
         const left = C.timer.left, warn = left < 30, wd = 240;
         this.panel(g, cx - wd / 2, y, wd, 24);
         if (warn && Math.sin(this.t * 8) > 0) { g.fillStyle = 'rgba(238,75,54,.25)'; g.fillRect(cx - wd / 2 + 1, y + 1, wd - 2, 22); }
         this.text(g, C.timer.label || 'Zeit', cx - wd / 2 + 10, y + 12, COL.dim, 12, 'left', FCOND, '600');
         this.text(g, mmss(left), cx + wd / 2 - 10, y + 12, warn ? COL.bad : COL.warn, 17, 'right', FCOND, '700');
         y += 30;
      }
      for (const r of this.radio) {
         const a = clamp(Math.min(r.t * 4, (8 - r.t) * 1.2), 0, 1), F = `600 15px ${FCOND}`;
         const lines = this.wrap(g, r.text, Math.min(620, this.W * 0.5), F), wd = Math.max(...lines.map((l) => (g.font = F, g.measureText(l).width))) + 80, h = lines.length * 19 + 10;
         g.globalAlpha = a;
         this.panel(g, cx - wd / 2, y, wd, h);
         const kc = r.kind === 'warn' ? COL.bad : r.kind === 'info' ? COL.hud : COL.signal;
         g.fillStyle = kc; g.fillRect(cx - wd / 2, y, 3, h);
         this.text(g, r.kind === 'warn' ? 'ACHTUNG' : r.kind === 'info' ? 'LAGE' : 'FUNK', cx - wd / 2 + 10, y + 14, kc, 10, 'left', FST, '700');
         lines.forEach((ln, i) => this.text(g, ln, cx - wd / 2 + 64, y + 14 + i * 19, r.kind === 'warn' ? COL.warn : COL.hud, 15, 'left', FCOND, '600'));
         g.globalAlpha = 1; y += h + 4;
      }
   }
   markerColor(m) { return m.kind === 'danger' ? COL.bad : m.kind === 'area' ? COL.warn : COL.signal; }
   drawWaypoints(g, w, p, C) {
      const T = w.terrain, s = this.v2, cam = this.R.camera, fwd = cam.getWorldDirection(this.dir);
      for (const m of C.markers || []) {
         if (m.x == null) continue;
         const gy = (T?.heightAt?.(m.x, m.z) ?? 0) + 4, col = this.markerColor(m);
         const dx = m.x - cam.position.x, dy = gy - cam.position.y, dz = m.z - cam.position.z;
         const behind = dx * fwd.x + dy * fwd.y + dz * fwd.z < 0;
         this.proj(m.x, gy, m.z, s);
         let sx = s.x, sy = s.y, edge = false;
         if (behind) { sx = this.W - sx; sy = this.H - 40; }
         const pad = 40;
         if (behind || sx < pad || sx > this.W - pad || sy < pad + 40 || sy > this.H - pad) {
            edge = true; sx = clamp(sx, pad, this.W - pad); sy = clamp(sy, pad + 40, this.H - pad);
         }
         const dist = Math.hypot(m.x - p.pos.x, m.z - p.pos.z), inside = m.r && dist < m.r;
         const r = edge ? 7 : 9, pulse = m.kind === 'danger' ? 1 + 0.15 * Math.sin(this.t * 6) : 1;
         g.save(); g.translate(sx, sy); g.scale(pulse, pulse);
         g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.moveTo(1, -r - 1 + 2); g.lineTo(r + 2, 2); g.lineTo(1, r + 3); g.lineTo(-r, 2); g.closePath(); g.fill();
         g.strokeStyle = col; g.lineWidth = 2; g.beginPath(); g.moveTo(0, -r); g.lineTo(r, 0); g.lineTo(0, r); g.lineTo(-r, 0); g.closePath(); g.stroke();
         if (inside) { g.fillStyle = col; g.fill(); } else { g.fillStyle = col; g.fillRect(-2, -2, 4, 4); }
         g.restore();
         if (edge) {   // arrow toward the target
            const a = Math.atan2(sy - this.H / 2, sx - this.W / 2);
            g.save(); g.translate(sx + Math.cos(a) * 15, sy + Math.sin(a) * 15); g.rotate(a); g.fillStyle = col;
            g.beginPath(); g.moveTo(6, 0); g.lineTo(-3, -5); g.lineTo(-3, 5); g.closePath(); g.fill(); g.restore();
         }
         const ty = sy - r - 9;
         if (m.label) this.text(g, m.label, sx, ty - 13, col, 12, 'center', FCOND, '700');
         this.text(g, inside ? 'erreicht' : Math.round(dist) + ' m', sx, ty, COL.hud, 11, 'center', FCOND, '600');
      }
   }
   drawMapMarkers(g, C, mx, mz, k, big) {
      for (const m of C.markers || []) {
         if (m.x == null) continue;
         const col = this.markerColor(m), px = mx(m.x), pz = mz(m.z);
         if (m.r) { g.strokeStyle = col; g.lineWidth = 1.5; g.setLineDash(m.kind === 'goal' ? [] : [4, 3]); g.globalAlpha = 0.85; g.beginPath(); g.arc(px, pz, Math.max(4, m.r * k), 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
            if (m.kind === 'danger') { g.fillStyle = 'rgba(238,75,54,.12)'; g.fill(); } }
         const r = 5 + 0.8 * Math.sin(this.t * 4);
         g.fillStyle = col; g.strokeStyle = '#000'; g.lineWidth = 1;
         g.beginPath(); g.moveTo(px, pz - r); g.lineTo(px + r, pz); g.lineTo(px, pz + r); g.lineTo(px - r, pz); g.closePath(); g.fill(); g.stroke();
         if (m.kind === 'danger') this.text(g, '!', px, pz, '#000', 9, 'center', FONT, '700');
         if (big && m.label) this.text(g, m.label, px + 8, pz - 8, col, 12, 'left', FCOND, '700');
      }
   }

   big(g, title, sub) {
      // soft elliptical shade behind the text (a full-width box sat on the horizon and read as a grey haze wall)
      const cy = this.H * 0.36 + 55, rx = Math.min(this.W * 0.32, 420);
      g.save(); g.translate(this.W / 2, cy); g.scale(rx / 70, 1);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 70);
      gr.addColorStop(0, 'rgba(14,16,10,.42)'); gr.addColorStop(0.6, 'rgba(14,16,10,.22)'); gr.addColorStop(1, 'rgba(14,16,10,0)');
      g.fillStyle = gr; g.fillRect(-70, -70, 140, 140); g.restore();
      if (sub) this.text(g, sub, this.W / 2, this.H * 0.36 + 26, COL.dim, 15, 'center', FCOND);
      this.text(g, String(title), this.W / 2, this.H * 0.36 + 72, COL.self, 54, 'center', FST, '700');
   }

   drawScore(g, w, p) {
      const W = Math.min(980, this.W - 40), x = (this.W - W) / 2, y = 90, all = w.tanks || [];
      const teams = [all.filter((t) => t.team === p.team), all.filter((t) => t.team !== p.team)];
      const H = 60 + Math.max(teams[0].length, teams[1].length) * 22;
      g.fillStyle = 'rgba(20,23,22,.92)'; g.fillRect(x, y, W, H); g.strokeStyle = COL.edge; g.strokeRect(x + 0.5, y + 0.5, W - 1, H - 1);
      this.text(g, 'GEFECHTSÜBERSICHT', this.W / 2, y + 18, COL.hud, 16, 'center', FST, '700');
      teams.forEach((list, ti) => {
         const cx = x + 16 + ti * W / 2, col = ti ? COL.enemy : COL.ally;
         this.text(g, ti ? 'Gegner' : 'Verbündete', cx, y + 42, col, 13, 'left', FCOND, '700');
         this.text(g, 'Schaden', cx + W / 2 - 110, y + 42, COL.dim, 11, 'right', FCOND); this.text(g, 'Absch.', cx + W / 2 - 50, y + 42, COL.dim, 11, 'right', FCOND);
         list.forEach((t, i) => {
            const ry = y + 64 + i * 22, st = t === p ? w.stats : t.stats;
            if (t === p) { g.fillStyle = 'rgba(224,122,31,.18)'; g.fillRect(cx - 6, ry - 10, W / 2 - 20, 20); }
            this.text(g, `${tankName(t)}`, cx, ry, t.alive ? (t === p ? COL.self : col) : COL.dead, 13, 'left', FCOND, '600');
            this.text(g, t.cfg?.tier ? 'Stufe ' + t.cfg.tier : '', cx + 160, ry, COL.dim, 11, 'left', FCOND);
            this.text(g, String(Math.round(st?.dmg ?? 0)), cx + W / 2 - 110, ry, COL.hud, 13, 'right', FCOND);
            this.text(g, String(st?.kills ?? 0), cx + W / 2 - 50, ry, COL.hud, 13, 'right', FCOND);
         });
      });
   }
}
