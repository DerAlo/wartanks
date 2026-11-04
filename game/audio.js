// game/audio.js — battle sound. The AudioContext starts on the first user input (browser policy).
// Graph: voices → master (volume/mute) → compressor → speakers, plus a convolver reverb send for
// distant/echoing sounds. Per-tank engine voices for the player and the 3 nearest tanks, turret
// whine, fire crackle; one-shots from tank state (lastFire, reload) and world.events. Volume and
// mute persist in localStorage (wartanks.audio.v1); menu.js calls setVolume / setMuted.
import * as S from './audiosynth.js';

const KEY = 'wartanks.audio.v1', SOUND = 343, NEAR = 3;

export class Audio {
   constructor() {
      let st = {}; try { st = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* ignore */ }
      this.volume = st.volume ?? 0.7; this.muted = !!st.muted;
      this.ctx = null; this.world = null; this.voices = []; this.ts = new Map(); this.lastSeq = -1;
      const unlock = () => { this.init(); if (this.ctx?.state === 'suspended') this.ctx.resume(); };
      addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
   }
   init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const c = this.ctx = new AC();
      this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : this.volume;
      const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.25;
      this.master.connect(comp).connect(c.destination);
      this.rev = c.createConvolver(); this.rev.buffer = S.reverbIR(c); this.revIn = c.createGain(); this.revIn.gain.value = 0.55;
      this.revIn.connect(this.rev).connect(this.master);
      this.sfx = c.createGain(); this.sfx.connect(this.master);
      if (this.world) this.start(this.world);
   }
   save() { try { localStorage.setItem(KEY, JSON.stringify({ volume: this.volume, muted: this.muted })); } catch { /* ignore */ } }
   setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this.save(); if (this.master && !this.muted) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.05); }
   setMuted(m) { this.muted = !!m; this.save(); if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05); }

   start(world) {
      this.stop(); this.world = world; this.lastSeq = -1; this.ts.clear();
      const c = this.ctx; if (!c) return;
      this.voices = [];
      for (let i = 0; i < NEAR + 1; i++) {
         const pan = c.createStereoPanner(); pan.connect(this.sfx);
         this.voices.push({ pan, v: null, tank: null });
      }
      // turret whine
      const o = c.createOscillator(); o.type = 'triangle'; o.frequency.value = 700;
      const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 3;
      this.whine = c.createGain(); this.whine.gain.value = 0; o.connect(bp).connect(this.whine).connect(this.sfx); o.start(); this.whineOsc = o;
      this.fire = S.crackleLoop(c, this.sfx);
   }
   stop() {
      for (const v of this.voices) { v.v?.stop(); v.pan.disconnect(); }
      this.voices = [];
      try { this.whineOsc?.stop(); this.fire?.stop(); } catch { /* ignore */ }
      this.whineOsc = this.fire = null; this.world = null;
   }
   ui(name) {
      const c = this.ctx; if (!c) return;
      if (name === 'scope') S.click(c, this.sfx, c.currentTime, 0.25);
      else if (name === 'click') S.click(c, this.sfx, c.currentTime, 0.5);
      else if (name === 'blip') S.blip(c, this.sfx, c.currentTime, 1);
      else if (name === 'spotted') { S.blip(c, this.sfx, c.currentTime, 1.3, 0.55); S.blip(c, this.sfx, c.currentTime + 0.22, 1.3, 0.55); }
   }
   // distance attenuation + stereo pan for a one-shot at world position p
   spatial(p, cam, yaw) {
      const c = this.ctx, dx = p.x - cam.x, dz = p.z - cam.z, d = Math.hypot(dx, dz, (p.y ?? cam.y) - cam.y);
      const g = c.createGain(), pan = c.createStereoPanner();
      g.gain.value = 1 / (1 + d / 60); const rel = Math.atan2(-dx, -dz) - yaw;
      pan.pan.value = Math.max(-1, Math.min(1, -Math.sin(rel) * Math.min(1, d / 20)));
      g.connect(pan).connect(this.sfx);
      const sendG = c.createGain(); sendG.gain.value = Math.min(1, 0.15 + d / 400); g.connect(sendG).connect(this.revIn);
      return { node: g, d, delay: d / SOUND };
   }

   update(dt, w, cam, tcam) {
      const c = this.ctx; if (!c || !w || !this.voices.length) return;
      const now = c.currentTime, p = w.player, cp = cam.position, yaw = tcam?.yaw ?? 0;
      // --- engines: player + nearest moving tanks
      const near = this._near ??= [];
      near.length = 0;
      for (const t of w.tanks || []) if (t !== p && t.alive !== false && !t.cfg?.site) near.push(t);   // sites have no engine (vMax 0 -> NaN rpm)
      near.sort((a, b) => ((a.pos.x - cp.x) ** 2 + (a.pos.z - cp.z) ** 2) - ((b.pos.x - cp.x) ** 2 + (b.pos.z - cp.z) ** 2));
      for (let i = 0; i < this.voices.length; i++) {
         const V = this.voices[i], t = i === 0 ? (p?.alive !== false ? p : null) : near[i - 1];
         if (V.tank !== t) {
            V.v?.stop(); V.v = null; V.tank = t;
            if (t) { const diesel = t.cfg?.engine?.diesel ?? (t.cfg?.engine?.fuel ? t.cfg.engine.fuel === 'diesel' : t.cfg?.nation === 'SU'); V.v = S.engineVoice(c, V.pan, diesel); }
         }
         if (!t || !V.v) continue;
         const spd = Math.abs(t.speed || 0), vmax = (t.cfg?.vMax ?? 40) / 3.6, thr = Math.abs(t.input?.throttle || 0);
         const rpm = Math.min(1, 0.15 + thr * 0.35 + spd / vmax * 0.6), d = Math.hypot(t.pos.x - cp.x, t.pos.z - cp.z);
         const vol = i === 0 ? 0.5 : 0.55 / (1 + d / 35);
         V.v.set(rpm, thr, spd, vol, now);
         const rel = Math.atan2(-(t.pos.x - cp.x), -(t.pos.z - cp.z)) - yaw;
         V.pan.pan.setTargetAtTime(i === 0 ? 0 : Math.max(-1, Math.min(1, -Math.sin(rel))), now, 0.1);
      }
      // --- player: turret whine, reload click, fire crackle
      if (p) {
         const s = this.pst ??= { ty: p.turretYaw || 0, reload: p.reload || 0 };
         const rate = Math.abs(((p.turretYaw || 0) - s.ty) / Math.max(dt, 1e-3)); s.ty = p.turretYaw || 0;
         this.whine.gain.setTargetAtTime(Math.min(0.08, rate * 0.12), now, 0.05); this.whineOsc.frequency.setTargetAtTime(600 + rate * 400, now, 0.05);
         if (s.reload > 0 && (p.reload ?? 0) <= 0 && p.alive !== false) { S.click(c, this.sfx, now, 0.7); }
         s.reload = p.reload ?? 0;
         this.fire.gain.gain.setTargetAtTime(p.burning ? 0.35 : 0, now, 0.2);
      }
      // --- gun shots (state-driven) with distance delay and echo
      for (const t of w.tanks || []) {
         let s = this.ts.get(t.id); if (!s) { this.ts.set(t.id, s = { lastFire: t.lastFire }); continue; }
         if (t.lastFire != null && t.lastFire !== s.lastFire) {
            s.lastFire = t.lastFire;
            const sp = this.spatial(t.pos, cp, yaw), far = Math.min(1, sp.d / 500);
            S.gunShot(c, sp.node, now + (t === p ? 0 : sp.delay), t.cfg?.gun?.cal ?? 75, t === p ? 1.1 : 1.6, far);
         }
      }
      // --- near-miss whistle: enemy shells passing close to the player
      if (p) for (const sh of w.shells || []) {
         if (!sh.alive || sh.__wh || sh.ownerId === p.id) continue;
         const dx = p.pos.x - sh.pos.x, dy = p.pos.y + 1.5 - sh.pos.y, dz = p.pos.z - sh.pos.z;
         const v2 = sh.vel.x ** 2 + sh.vel.y ** 2 + sh.vel.z ** 2, tt = (dx * sh.vel.x + dy * sh.vel.y + dz * sh.vel.z) / Math.max(1, v2);
         if (tt < 0 || tt > 0.6) continue;
         const mx = dx - sh.vel.x * tt, my = dy - sh.vel.y * tt, mz = dz - sh.vel.z * tt;
         if (mx * mx + my * my + mz * mz < 225) { sh.__wh = true; S.whistle(c, this.sfx, now + Math.max(0, tt - 0.35), 0.8); }
      }
      // --- events
      const ev = w.events, list = Array.isArray(ev) ? ev : ev?.list || ev?.items || [];
      let mx = this.lastSeq;
      for (let i = 0; i < list.length; i++) {
         const e = list[i]; if (!e) continue; const seq = e.seq ?? i; if (seq <= this.lastSeq) continue; if (seq > mx) mx = seq;
         this.onEvent(e, w, p, cp, yaw, now);
      }
      this.lastSeq = mx;
   }
   onEvent(e, w, p, cp, yaw, now) {
      const c = this.ctx, type = e.type ?? e.kind, pos = e.pos || e.point || w.tanks?.find((t) => t.id === e.dstId)?.pos;
      const mine = p && e.srcId === p.id, onMe = p && e.dstId === p.id;
      if (!pos) return;
      const sp = this.spatial(pos, cp, yaw), at = now + (onMe ? 0 : sp.delay * 0.5), loud = onMe ? 1.6 : mine ? 1.3 : 1;
      if (type === 'ricochet') S.ricochet(c, sp.node, at, loud);
      else if (type === 'pen') S.clang(c, sp.node, at, loud);
      else if (type === 'noPen') S.dong(c, sp.node, at, loud);
      else if (type === 'he') S.explosion(c, sp.node, at, 0.6, loud);
      else if (type === 'ammoRack') S.explosion(c, sp.node, at, 2.2, 1.8);
      else if (type === 'kill') S.explosion(c, sp.node, at + 0.05, 1.2, 1.2);
      // radio blips for crew callouts (the HUD shows the text)
      if ((onMe && (type === 'crit' || type === 'fire' || type === 'ammoRack' || type === 'track')) || (mine && type === 'kill')) S.blip(c, this.sfx, now + 0.25, 0.9, onMe ? 0.8 : 1.1);
   }
}
