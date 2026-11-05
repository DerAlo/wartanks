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
   // the flicker modulates a separate stage: added straight onto g.gain it kept the crackle audible at
   // "gain 0" -- a constant hiss from the first countdown second, whether anything burned or not
   const mod = ctx.createGain(); mod.gain.value = 0.6;
   const lg = ctx.createGain(); lg.gain.value = 0.4; lfo.connect(lg).connect(mod.gain);
   s.connect(hp).connect(mod).connect(g).connect(out); s.start(); lfo.start();
   return { gain: g, stop: () => { s.stop(); lfo.stop(); } };
}
// engine voice: two detuned oscillators + rough noise through a low-pass, plus a clatter loop
// ---- engine: combustion-pulse synthesis -------------------------------------------------------
// A real engine is a train of exhaust pops (one per cylinder firing, two crank turns per cycle) ringing
// through the exhaust pipe. Each loop is a few cycles of such pops with per-cylinder unevenness, rendered
// at a fixed rpm; three loops (idle / mid / high) are pitched by playbackRate and crossfaded, as
// sample-based car games do, so the pipe resonance never shifts far. Loops are cached per engine type.
const ENGINE_LOOPS = new Map();
function rng(seed) { let x = seed >>> 0 || 1; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296); }
// type: { cyl, diesel, res (pipe resonance Hz), seed }
function engineLoop(ctx, type, rpm) {
   const key = type.key + '@' + rpm; let buf = ENGINE_LOOPS.get(key); if (buf) return buf;
   const sr = ctx.sampleRate, cycle = 120 / rpm, nCyc = Math.max(4, Math.round(1.6 / cycle)), N = Math.round(nCyc * cycle * sr);
   const d = new Float32Array(N), R = rng(type.seed + rpm), cyl = type.cyl;
   // fixed per-cylinder character: V engines fire unevenly between banks, cylinders differ a little
   const off = [], amp = []; for (let k = 0; k < cyl; k++) { off.push((R() - 0.5) * 0.06 + (k % 2 ? 0.025 : -0.025) * (type.vee ? 1 : 0)); amp.push(0.8 + R() * 0.4); }
   const fr = type.res * (0.92 + rpm / 9000), tauR = type.diesel ? 0.009 : 0.012, fb = type.diesel ? 480 : 300, tauB = type.diesel ? 0.006 : 0.005;
   const knock = type.diesel ? 0.9 : 0.35, L = Math.round(0.09 * sr);
   // 4 pulse templates (the crack noise differs), then every firing is a scaled copy: cheap enough to
   // build at battle start without a hitch
   const tpl = [];
   for (let v = 0; v < 4; v++) {
      const P = new Float32Array(L), ph = R() * 0.6; let lp = 0;
      for (let i = 0; i < L; i++) {
         const t = i / sr, n = R() * 2 - 1; lp += (n - lp) * 0.35;
         P[i] = Math.exp(-t / tauR) * Math.sin(6.2832 * fr * t + ph)          // pipe boom
            + Math.exp(-t / tauB) * Math.sin(6.2832 * fb * t) * 0.9           // body bark
            + Math.exp(-t / 0.003) * lp * knock * 1.6;                       // combustion crack
      }
      tpl.push(P);
   }
   for (let c = 0; c < nCyc; c++) for (let k = 0; k < cyl; k++) {
      const t0 = (c + (k + off[k]) / cyl) * cycle + (R() - 0.5) * 0.012 * cycle / cyl, A = amp[k] * (0.85 + R() * 0.3);
      const i0 = Math.round(t0 * sr), P = tpl[(R() * 4) | 0];
      for (let i = 0; i < L; i++) d[(i0 + i) % N] += A * P[i];
   }
   // DC removal + gentle lowpass, normalise
   let m = 0; for (let i = 0; i < N; i++) m += d[i]; m /= N;
   let y = 0, pk = 1e-6; const k = 1 - Math.exp(-6.2832 * 2600 / sr);
   for (let p = 0; p < 2; p++) for (let i = 0; i < N; i++) { y += (d[i] - m * (p ? 0 : 1) - y) * k; if (p) { d[i] = y; pk = Math.max(pk, Math.abs(y)); } }
   for (let i = 0; i < N; i++) d[i] /= pk;
   buf = ctx.createBuffer(1, N, sr); buf.copyToChannel(d, 0); ENGINE_LOOPS.set(key, buf);
   return buf;
}
/** engine type from a tank config: cylinder count / fuel / pipe resonance (bigger engine -> deeper) */
export function engineType(cfg) {
   const e = cfg?.engine || {}, diesel = e.diesel ?? (e.fuel ? e.fuel === 'diesel' : cfg?.nation === 'SU');
   const hp = e.hp || 400, cyl = e.cyl ?? (hp < 250 ? 6 : cfg?.nation === 'US' && hp <= 500 ? 8 : 12);
   const res = e.res ?? Math.max(85, Math.min(150, 175 - hp * 0.12));
   return { key: (diesel ? 'd' : 'p') + cyl + ':' + Math.round(res), cyl, diesel, vee: cyl >= 8, res, seed: cyl * 7919 + Math.round(res) };
}
const LOOP_RPM = [650, 1300, 2300];
export function engineVoice(ctx, out, typeOrDiesel) {
   const type = typeof typeOrDiesel === 'object' ? typeOrDiesel : engineType({ engine: { fuel: typeOrDiesel ? 'diesel' : 'petrol', hp: 500 } });
   const g = ctx.createGain(); g.gain.value = 0; g.connect(out);
   const lp = filt(ctx, 'lowpass', 900, 0.6); lp.connect(g);
   // load drives a soft clipper: under throttle the pops get rough and loud, off throttle they burble
   const drive = ctx.createGain(); drive.gain.value = 1;
   const sh = ctx.createWaveShaper(); const cv = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; cv[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); } sh.curve = cv;
   const low = filt(ctx, 'lowshelf', 110, 0.7); low.gain.value = 1.5;
   drive.connect(sh).connect(low).connect(lp);
   const srcs = LOOP_RPM.map((r) => { const s = ctx.createBufferSource(); s.buffer = engineLoop(ctx, type, r); s.loop = true; const sg = ctx.createGain(); sg.gain.value = 0; s.connect(sg).connect(drive); s.start(ctx.currentTime + Math.random() * 0.05); return { s, sg, r }; });
   // transmission whine (spur gears / final drive), tied to road speed
   const wo = ctx.createOscillator(); wo.type = 'triangle'; const wg = ctx.createGain(); wg.gain.value = 0; const wf = filt(ctx, 'bandpass', 700, 3); wo.connect(wf).connect(wg).connect(g); wo.start();
   const cl = ctx.createBufferSource(); cl.buffer = clatter(ctx); cl.loop = true; const cg = ctx.createGain(); cg.gain.value = 0; const cf = filt(ctx, 'bandpass', 1300, 0.7); cl.connect(cf).connect(cg).connect(out); cl.start();
   const idle = LOOP_RPM[0], max = 2600;
   return {
      g, cl, cg, type,
      set(rpm, load, speed, vol, now) {   // rpm 0..1
         const R = idle + (max - idle) * rpm;
         for (let i = 0; i < srcs.length; i++) {
            const S = srcs[i], lo = LOOP_RPM[i - 1], hi = LOOP_RPM[i + 1];
            let w = 1;
            if (lo != null && R < S.r) w = Math.max(0, (R - lo) / (S.r - lo));
            if (hi != null && R > S.r) w = Math.max(0, (hi - R) / (hi - S.r));
            if (lo == null && R < S.r) w = 1; if (hi == null && R > S.r) w = 1;
            S.sg.gain.setTargetAtTime(Math.sqrt(w), now, 0.06);
            S.s.playbackRate.setTargetAtTime(R / S.r, now, 0.06);
         }
         drive.gain.setTargetAtTime(0.55 + load * 1.1, now, 0.08);
         lp.frequency.setTargetAtTime(900 + rpm * 1400 + load * 1300, now, 0.1);
         g.gain.setTargetAtTime(vol * (0.55 + load * 0.35 + rpm * 0.2), now, 0.1);
         wo.frequency.setTargetAtTime(90 + speed * 38, now, 0.1); wf.frequency.setTargetAtTime(180 + speed * 76, now, 0.1);
         wg.gain.setTargetAtTime(Math.min(1, speed / 3) * 0.05, now, 0.15);
         cl.playbackRate.setTargetAtTime(Math.max(0.05, speed * 0.16), now, 0.1);
         cg.gain.setTargetAtTime(vol * Math.min(1, speed / 4) * 0.35, now, 0.1);
      },
      stop() { for (const s of [...srcs.map((x) => x.s), wo, cl]) try { s.stop(); } catch { /* already */ } g.disconnect(); cg.disconnect(); },
   };
}
