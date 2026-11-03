// game/audiosynth.js — synthesised sound primitives (no audio files). Every function takes the
// AudioContext, a destination node and a start time; one-shots build short node graphs that are
// garbage-collected after they stop. Shared noise buffers and the reverb impulse are made once.
let NOISE = null, BROWN = null, CLATTER = null;

export function noise(ctx) {
   if (NOISE) return NOISE;
   const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
   for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
   return (NOISE = b);
}
export function brown(ctx) {
   if (BROWN) return BROWN;
   const n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
   let last = 0; for (let i = 0; i < n; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
   return (BROWN = b);
}
// one second of track links hitting sprockets: 14 clicks with jitter, looped with playbackRate
export function clatter(ctx) {
   if (CLATTER) return CLATTER;
   const sr = ctx.sampleRate, b = ctx.createBuffer(1, sr, sr), d = b.getChannelData(0);
   for (let k = 0; k < 14; k++) {
      const s = Math.floor((k + Math.random() * 0.3) / 14 * sr), f = 900 + Math.random() * 1400, amp = 0.5 + Math.random() * 0.5;
      for (let i = 0; i < sr * 0.03 && s + i < sr; i++) d[s + i] += Math.sin(i / sr * f * 6.283) * Math.exp(-i / (sr * 0.006)) * amp + (Math.random() - 0.5) * Math.exp(-i / (sr * 0.003)) * amp;
   }
   return (CLATTER = b);
}
export function reverbIR(ctx, secs = 2.6) {
   const sr = ctx.sampleRate, n = Math.floor(sr * secs), b = ctx.createBuffer(2, n, sr);
   for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) { const t = i / sr; d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.2) * (t < 0.12 ? t / 0.12 : 1) * (1 + (Math.abs(t - 0.35) < 0.02 ? 2 : 0)); }
   }
   return b;
}

const env = (g, t, a, peak, dec) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); };
function src(ctx, buf, t, dur, rate = 1) { const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; s.start(t, Math.random() * 1.2); s.stop(t + dur); return s; }
function filt(ctx, type, f, q = 0.7) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
function osc(ctx, type, f, t, dur) { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur); return o; }

// gun shot: noise crack + low thump, caliber scales weight; `far` 0..1 dulls it
export function gunShot(ctx, out, t, cal = 75, vol = 1, far = 0) {
   const k = Math.min(2, cal / 75);
   const n = src(ctx, noise(ctx), t, 1.6), lp = filt(ctx, 'lowpass', 5200 - far * 4200 - k * 600), g = ctx.createGain();
   env(g, t, 0.003, 0.9 * vol, 0.35 + k * 0.35); n.connect(lp).connect(g).connect(out);
   const b = src(ctx, brown(ctx), t, 2.2), bl = filt(ctx, 'lowpass', 380), bg = ctx.createGain();
   env(bg, t, 0.006, 1.4 * vol, 0.9 + k * 0.7); b.connect(bl).connect(bg).connect(out);
   const o = osc(ctx, 'sine', 70 / Math.sqrt(k), t, 0.8), og = ctx.createGain();
   o.frequency.exponentialRampToValueAtTime(28, t + 0.5); env(og, t, 0.004, 1.1 * vol * (1 - far * 0.6), 0.45); o.connect(og).connect(out);
}
export function explosion(ctx, out, t, size = 1, vol = 1) {
   const b = src(ctx, brown(ctx), t, 3.5), bl = filt(ctx, 'lowpass', 600 + size * 200), g = ctx.createGain();
   env(g, t, 0.01, 1.6 * vol, 1.2 + size * 1.2); b.connect(bl).connect(g).connect(out);
   const n = src(ctx, noise(ctx), t, 1.2), nl = filt(ctx, 'lowpass', 2600), ng = ctx.createGain();
   env(ng, t, 0.004, 0.7 * vol, 0.4 + size * 0.3); n.connect(nl).connect(ng).connect(out);
   const o = osc(ctx, 'sine', 55, t, 1.5), og = ctx.createGain(); o.frequency.exponentialRampToValueAtTime(22, t + 1.2);
   env(og, t, 0.005, 1.3 * vol, 0.9 + size * 0.4); o.connect(og).connect(out);
}
// metallic partials (inharmonic): ping (ricochet), clang (penetration), dong (absorbed)
function metal(ctx, out, t, base, ratios, dec, vol) {
   for (let i = 0; i < ratios.length; i++) { const o = osc(ctx, 'sine', base * ratios[i], t, dec + 0.1), g = ctx.createGain(); env(g, t, 0.002, vol / (1 + i * 0.6), dec / (1 + i * 0.4)); o.connect(g).connect(out); }
}
export function ricochet(ctx, out, t, vol = 1) {
   metal(ctx, out, t, 2200 + Math.random() * 900, [1, 1.52, 2.31], 0.35, 0.35 * vol);
   const o = osc(ctx, 'sine', 3800, t, 0.6), g = ctx.createGain(); o.frequency.exponentialRampToValueAtTime(900, t + 0.55); env(g, t + 0.02, 0.01, 0.18 * vol, 0.5); o.connect(g).connect(out);
}
export function clang(ctx, out, t, vol = 1) {
   metal(ctx, out, t, 340 + Math.random() * 60, [1, 2.76, 5.4, 8.9], 0.9, 0.5 * vol);
   const n = src(ctx, noise(ctx), t, 0.3), bp = filt(ctx, 'bandpass', 1800, 1.2), g = ctx.createGain(); env(g, t, 0.002, 0.8 * vol, 0.18); n.connect(bp).connect(g).connect(out);
}
export function dong(ctx, out, t, vol = 1) {
   metal(ctx, out, t, 150 + Math.random() * 30, [1, 2.4, 3.9], 1.1, 0.55 * vol);
   const n = src(ctx, noise(ctx), t, 0.2), lp = filt(ctx, 'lowpass', 900), g = ctx.createGain(); env(g, t, 0.002, 0.5 * vol, 0.12); n.connect(lp).connect(g).connect(out);
}
export function whistle(ctx, out, t, vol = 1) {
   const o = osc(ctx, 'sine', 1900, t, 0.7), g = ctx.createGain(); o.frequency.exponentialRampToValueAtTime(700, t + 0.6);
   g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 * vol, t + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65); o.connect(g).connect(out);
   const n = src(ctx, noise(ctx), t, 0.7), bp = filt(ctx, 'bandpass', 2400, 3), ng = ctx.createGain(); env(ng, t, 0.25, 0.2 * vol, 0.4); n.connect(bp).connect(ng).connect(out);
}
export function click(ctx, out, t, vol = 1) {
   for (const [dt, f] of [[0, 2600], [0.07, 1700]]) { const n = src(ctx, noise(ctx), t + dt, 0.05), bp = filt(ctx, 'bandpass', f, 4), g = ctx.createGain(); env(g, t + dt, 0.001, 0.6 * vol, 0.03); n.connect(bp).connect(g).connect(out); }
}
export function blip(ctx, out, t, vol = 1, hi = 1) {
   for (let i = 0; i < 2; i++) { const o = osc(ctx, 'square', (1200 + i * 400) * hi, t + i * 0.09, 0.07), bp = filt(ctx, 'bandpass', 1500, 2), g = ctx.createGain(); env(g, t + i * 0.09, 0.004, 0.12 * vol, 0.05); o.connect(bp).connect(g).connect(out); }
   const n = src(ctx, noise(ctx), t, 0.25), bp = filt(ctx, 'bandpass', 2000, 0.8), g = ctx.createGain(); env(g, t, 0.01, 0.05 * vol, 0.2); n.connect(bp).connect(g).connect(out);
}
// continuous fire crackle: returns { gain } (caller ramps gain)
export function crackleLoop(ctx, out) {
   const s = ctx.createBufferSource(); s.buffer = noise(ctx); s.loop = true;
   const hp = filt(ctx, 'highpass', 1400), g = ctx.createGain(); g.gain.value = 0;
   const lfo = ctx.createBufferSource(); lfo.buffer = noise(ctx); lfo.loop = true; lfo.playbackRate.value = 0.02;
   const lg = ctx.createGain(); lg.gain.value = 0.5; lfo.connect(lg).connect(g.gain);
   s.connect(hp).connect(g).connect(out); s.start(); lfo.start();
   return { gain: g, stop: () => { s.stop(); lfo.stop(); } };
}
// engine voice: two detuned oscillators + rough noise through a low-pass, plus a clatter loop
export function engineVoice(ctx, out, diesel) {
   const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
   const lp = filt(ctx, 'lowpass', 500, 1.5); lp.connect(g);
   const o1 = ctx.createOscillator(); o1.type = diesel ? 'square' : 'sawtooth';
   const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = diesel ? -1200 : 7;
   const og = ctx.createGain(); og.gain.value = diesel ? 0.18 : 0.22; o1.connect(og); o2.connect(og); og.connect(lp);
   // firing pulses: amplitude modulation for the diesel knock
   const am = ctx.createOscillator(); am.type = 'square'; const amg = ctx.createGain(); amg.gain.value = diesel ? 0.09 : 0.03; am.connect(amg).connect(og.gain);
   const n = ctx.createBufferSource(); n.buffer = brown(ctx); n.loop = true; const ng = ctx.createGain(); ng.gain.value = 0.35; n.connect(ng).connect(lp);
   const cl = ctx.createBufferSource(); cl.buffer = clatter(ctx); cl.loop = true; const cg = ctx.createGain(); cg.gain.value = 0; const cf = filt(ctx, 'bandpass', 1300, 0.7); cl.connect(cf).connect(cg).connect(out);
   for (const s of [o1, o2, am, n, cl]) s.start();
   return {
      g, lp, o1, o2, am, cl, cg, diesel,
      set(rpm, load, speed, vol, now) {   // rpm 0..1
         const f = diesel ? 28 + rpm * 46 : 38 + rpm * 70;
         o1.frequency.setTargetAtTime(f, now, 0.08); o2.frequency.setTargetAtTime(f * (diesel ? 1 : 1.005), now, 0.08); am.frequency.setTargetAtTime(f * (diesel ? 0.5 : 1), now, 0.08);
         lp.frequency.setTargetAtTime(240 + rpm * 700 + load * 500, now, 0.1);
         g.gain.setTargetAtTime(vol * (0.35 + load * 0.4 + rpm * 0.25), now, 0.1);
         cl.playbackRate.setTargetAtTime(Math.max(0.05, speed * 0.16), now, 0.1);
         cg.gain.setTargetAtTime(vol * Math.min(1, speed / 4) * 0.35, now, 0.1);
      },
      stop() { for (const s of [o1, o2, am, n, cl]) try { s.stop(); } catch { /* already */ } g.disconnect(); cg.disconnect(); },
   };
}
