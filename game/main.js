// game/main.js — boot and frame loop. Owns no game rules: it builds the World (state.js), turns
// input into tank.input / tank.aimPoint, steps the sim at SIM_DT and draws. Exposes window.__game
// for the playwright scripts.
import * as THREE from '../vendor/three/three.module.min.js';
import * as gfxM from './gfxquality.js';
const { loadQuality } = gfxM;
import { Renderer, fogTheme } from './render.js';
import { Sky } from './sky.js';
import { Terrain3D } from './terrain3d.js';
import { Input } from './input.js';
import { TankCamera } from './camera.js';

const SIM_DT = 1 / 60;
const q = loadQuality();
const canvas = document.getElementById('gl');
const R = new Renderer(canvas, q);
const sky = R.sky = new Sky(R.scene);
const input = new Input(canvas);
const tcam = new TankCamera(R.camera);
const params = new URLSearchParams(location.search);

// optional modules: graceful while other parts are still being written
async function opt(path) { try { return await import(path); } catch (e) { console.warn('[main] optional module missing', path, e.message); return {}; } }
const [stateM, mapsM, tanks3dM, hudM, fxM, audioM, menuM, armorM, configM, terrainM, progressM] = await Promise.all(
   ['./state.js', './maps.js', './tanks3d.js', './hud.js', './fx.js', './audio.js', './menu.js', './armor.js', './config.js', './terrain.js', './progress.js'].map(opt));

const G = window.__game = { R, q, tcam, input, world: null, fps: 0, frame: 0, mods: { stateM, mapsM, tanks3dM, hudM, fxM, audioM, menuM, armorM, configM, progressM, gfxM } };
let terrain3d = null, tanks3d = null, hud = null, fx = null, audio = null, menu = null;
const tmpO = new THREE.Vector3(), tmpD = new THREE.Vector3(), pivot = new THREE.Vector3(), sight = new THREE.Vector3();

function themeOf(mapId) {
   const T = mapsM.MAPS || mapsM.THEMES || mapsM.default;
   const th = (Array.isArray(T) ? T.find((m) => m.id === mapId) : T?.[mapId]) || {};
   return { id: mapId, ...th, ...(th.render || th.gfx || {}) };
}


export function startBattle(opts = {}) {
   stopBattle(); G.lock = null; G.rmbT = null;
   for (const k in opts) if (opts[k] === undefined) delete opts[k];
   if (!stateM.World) { console.error('[main] state.js missing: no battle possible'); menu?.show('garage'); return; }
   const world = G.world = opts.world || new stateM.World({ mode: 'standard', mapId: 'steppe', seed: 1234, playerCls: undefined, difficulty: 'normal', ...opts });
   G.battleOpts = { ...opts }; delete G.battleOpts.world; G.endT = 0; G.paused = false;
   const th = fogTheme(themeOf(world.mapId ?? opts.mapId), world.campaign?.fog || 0);   // misty ops (Arracourt)
   R.setTheme(th); sky.setTheme(th, R.sunDir);
   terrain3d = new Terrain3D(R.scene, world.terrain, th, q);
   if (tanks3dM.Tanks3D) tanks3d = G.tanks3d = new tanks3dM.Tanks3D(R.scene, world);
   if (fxM.FX) fx = new fxM.FX(R.scene, world, q);
   if (hudM.HUD) hud = new hudM.HUD(document.getElementById('hudc'), world, { armor: armorM, cam: tcam, R });
   getAudio();
   audio?.start?.(world);
   G.fx = fx; G.hud = hud; G.audio = audio;
   tcam.reset(world.player?.yaw ?? 0);
   R.warm?.();
   input.enabled = true; menu?.hide?.();
   G.acc = 0;
}
export function stopBattle() {
   input.enabled = false; input.unlock();
   terrain3d?.dispose(); tanks3d?.dispose?.(); fx?.dispose?.(); hud?.dispose?.(); audio?.stop?.();
   terrain3d = tanks3d = G.tanks3d = fx = hud = null; G.world = null; G.paused = false; G.aimTarget = null; G.fireReq = null;
   document.getElementById('scope').classList.remove('on');
   const hc = document.getElementById('hudc'); hc.getContext('2d')?.clearRect(0, 0, hc.width, hc.height);
}
function getAudio() { if (audioM.Audio && !audio) audio = G.audio = new audioM.Audio(); return audio; }
// battle over (world.phase won/lost/draw): short pause on the battlefield, then the results screen
function finishBattle() {
   const w = G.world; if (!w) return;
   const snap = { ...G.battleOpts, mode: w.mode ?? G.battleOpts.mode ?? 'standard', mapId: w.mapId ?? G.battleOpts.mapId, playerCls: w.player?.cls ?? G.battleOpts.playerCls, phase: w.phase,
      result: w.result ? { ...w.result } : null, stats: w.stats ? { ...w.stats } : null };
   menu?.applyResult?.(snap);
   G.lastResult = snap;
   stopBattle(); G.lock = null; G.rmbT = null;
   if (G.net) G.net.finish(snap);                   // net game: the lobby shows the result and the room
   else if (menu) menu.showResults(snap);
}
function setPaused(on) {
   if (!G.world || !menu) return;
   G.paused = on; G.pauseT = performance.now();
   input.enabled = !on; if (on) { input.unlock(); input.keys.clear(); input.lmb = input.rmb = false; }
   menu.pause(on);
}
function leaveBattle() { G.net?.leave(); stopBattle(); menu?.show('garage'); }
G.finishBattle = finishBattle; G.setPaused = setPaused; G.leaveBattle = leaveBattle;
addEventListener('keydown', (e) => {
   if (e.code !== 'Escape' || !G.world || !menu) return;
   if (performance.now() - (G.pauseT || 0) < 300) return;
   if (document.getElementById('pz-settings')?.classList.contains('on')) { document.getElementById('pz-settings').classList.remove('on'); return; }
   setPaused(!G.paused);
});
document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && G.world && !G.paused && input.enabled && G.world.phase !== 'won' && G.world.phase !== 'lost' && G.world.phase !== 'draw') setPaused(true); });
G.startBattle = startBattle; G.stopBattle = stopBattle;
// ---- multiplayer (game/net/game.js): the lobby (mpui.js) hands over its session here
G.startNetGame = async (session) => {
   const { startNetGame } = await import('./net/game.js');
   const onEnd = session.onEnd;
   const s = { ...session, onEnd: (r) => { console.log('[net] end:', r.aborted ? 'aborted' : r.outcome, r.reason); G.net = null; if (G.world) stopBattle(); onEnd?.(r); } };
   G.net = startNetGame(s, { startBattle, stopBattle, log: (t) => console.log('[net]', t) });
   return G.net;
};

// ---- render interpolation: the sim runs at a fixed 60 Hz, the display at anything (75/120/144 Hz),
// so a frame sees 0, 1 or 2 steps. Tanks are drawn at prev + alpha*(cur - prev) and put back afterwards. ----
const POSE_K = ['yaw', 'pitch', 'roll', 'turretYaw', 'gunPitch'];
function snapPrev(world) {
   for (const t of world.tanks) {
      const q = t._prev ??= {};
      q.x = t.pos.x; q.y = t.pos.y; q.z = t.pos.z; for (const k of POSE_K) q[k] = t[k];
      q.ok = true;
   }
}
const lerpA = (a, b, f) => { let d = (b - a) % (2 * Math.PI); if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI; return b - d * (1 - f); };
function lerpPoses(world, f) {
   f = Math.min(1, Math.max(0, f));
   for (const t of world.tanks) {
      const q = t._prev; if (!q?.ok) continue;
      const c = t._cur ??= {};
      c.x = t.pos.x; c.y = t.pos.y; c.z = t.pos.z; for (const k of POSE_K) c[k] = t[k];
      c.on = Math.hypot(c.x - q.x, c.z - q.z) < 4;   // a respawn / teleport is not smeared
      if (!c.on) continue;
      t.pos.x = q.x + (c.x - q.x) * f; t.pos.y = q.y + (c.y - q.y) * f; t.pos.z = q.z + (c.z - q.z) * f;
      for (const k of POSE_K) if (typeof c[k] === 'number' && typeof q[k] === 'number') t[k] = lerpA(q[k], c[k], f);
      t.pose?.();
   }
}
function restorePoses(world) {
   for (const t of world.tanks) {
      const c = t._cur; if (!c?.on) continue;
      t.pos.x = c.x; t.pos.y = c.y; t.pos.z = c.z; for (const k of POSE_K) t[k] = c[k];
      c.on = false; t.pose?.();
   }
}

// ---- right mouse (WoT style): a short click locks the aim onto a spotted enemy (auto-aim; the
// crosshair sticks to it until the next click or the target is lost), holding it is free look ----
const RMB_HOLD = 0.25;
function lockValid(world, p, t) { return t && t.alive && t.team !== p.team && t.spotted !== false && world.tanks.includes(t); }
function pickLock(world, p) {
   const a = G.aimTarget?.tank;
   if (lockValid(world, p, a)) return a;
   // nearest spotted enemy within ~7° of the view direction
   tmpO.copy(R.camera.position); tcam.aimDir(tmpD);
   let best = null, bestA = 7 * Math.PI / 180;
   for (const t of world.tanks) {
      if (!lockValid(world, p, t)) continue;
      const dx = t.pos.x - tmpO.x, dy = t.pos.y + 1.2 - tmpO.y, dz = t.pos.z - tmpO.z, L = Math.hypot(dx, dy, dz) || 1;
      const ang = Math.acos(Math.min(1, (dx * tmpD.x + dy * tmpD.y + dz * tmpD.z) / L));
      if (ang < bestA) { bestA = ang; best = t; }
   }
   return best;
}
function setLock(p, t) {
   G.lock = t || null;
   if (p.input) p.input.lockId = t ? t.id : null;
}
function rightMouse(world, p) {
   const now = performance.now() / 1000;
   if (input.rmb && G.rmbT == null) G.rmbT = now;
   const held = G.rmbT != null ? now - G.rmbT : 0;
   tcam.setFreeLook(input.rmb && held >= RMB_HOLD);
   if (!input.rmb && G.rmbT != null) {
      if (held < RMB_HOLD && p?.alive) {
         if (G.lock) { setLock(p, null); hud?.msg?.('Zielautomatik aus', undefined, 0.8); }
         else { const t = pickLock(world, p); if (t) { setLock(p, t); hud?.msg?.('Zielautomatik: ' + (t.name || t.cfg?.short || 'Ziel'), undefined, 1); audio?.ui?.('scope'); } }
      }
      G.rmbT = null;
   }
   if (G.lock && (!p?.alive || !lockValid(world, p, G.lock))) { setLock(p, null); hud?.msg?.('Ziel verloren', '#ff6a4d', 1); }
   if (G.lock) {   // keep the camera (and so the crosshair) on the target's centre
      const t = G.lock, c = R.camera.position;
      const dx = t.pos.x - c.x, dy = t.pos.y + (t.height ?? 2.2) * 0.55 - c.y, dz = t.pos.z - c.z;
      tcam.yaw = Math.atan2(-dx, -dz); tcam.pitch = Math.atan2(dy, Math.hypot(dx, dz));
   }
}

// ---- aim: camera ray → first hit on terrain / objects / other tanks ----
function aimRay(world, p) {
   tmpO.copy(R.camera.position); tcam.aimDir(tmpD);
   if (tcam.freeLook && p.aimPoint) return;               // aim stays where it was
   let best = world.terrain.raycast?.(tmpO.x, tmpO.y, tmpO.z, tmpD.x, tmpD.y, tmpD.z, 900) ?? 900;
   G.aimTarget = null;
   for (const t of world.tanks) {
      if (t === p) continue;
      const cx = t.pos.x - tmpO.x, cy = t.pos.y + 1.3 - tmpO.y, cz = t.pos.z - tmpO.z;
      const along = cx * tmpD.x + cy * tmpD.y + cz * tmpD.z;
      if (along < 0 || along > best) continue;
      const r = (t.radius ?? t.cfg?.radius ?? 4), d2 = cx * cx + cy * cy + cz * cz - along * along;
      if (d2 > r * r) continue;
      let hitD = along - Math.sqrt(r * r - d2) * 0.6;
      if (armorM.rayArmor && t.armor) {
         const hits = armorM.rayArmor(t.armor, t.pose(), tmpO, tmpD);
         if (!hits?.length) continue;
         hitD = hits[0].dist; G.aimTarget = { tank: t, hit: hits[0], hits };
      } else G.aimTarget = { tank: t, hit: null };
      best = hitD;
   }
   p.aimPoint ??= { x: 0, y: 0, z: 0 };
   p.aimPoint.x = tmpO.x + tmpD.x * best; p.aimPoint.y = tmpO.y + tmpD.y * best; p.aimPoint.z = tmpO.z + tmpD.z * best;
   G.aimDist = best;
}

function controls(world, p, dt) {
   if (input.wheel && tcam.wheel(input.wheel)) audio?.ui?.('scope');
   if (input.hit('ShiftLeft') || input.hit('ShiftRight')) { tcam.toggleScope(); audio?.ui?.('scope'); }
   rightMouse(world, p);
   if (!G.lock) tcam.look(input.dx, input.invert ? -input.dy : input.dy, input.sens);
   if (!p?.alive) return;
   const k = (c) => input.down(c);
   const inp = p.input ??= {};
   inp.throttle = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
   inp.steer = (k('KeyA') || k('ArrowLeft') ? 1 : 0) - (k('KeyD') || k('ArrowRight') ? 1 : 0);
   // reversing steers like a car (as in WoT): S+A backs the tank towards the left, so the hull
   // turns the other way while rolling backwards. Only for the human; bots steer the raw hull yaw.
   if ((p.speed ?? 0) < -0.3 || (inp.throttle < 0 && (p.speed ?? 0) < 0.3)) inp.steer = -inp.steer;
   inp.brake = k('Space');
   inp.fire = input.lmb && !G.noFire;
   // a click is kept for 0.3 s so a click just before the round is loaded still fires (an edge-
   // triggered click was dropped when it landed a frame or two early); say why a click cannot fire
   if (input.lmbPressed) {
      G.fireReq = world.time;
      if (p.mod?.('gun') === 'destroyed') hud?.msg?.('Kanone zerstört', '#ff6a4d', 1.2);
      else if (world.phase === 'countdown') hud?.msg?.('Gefecht beginnt gleich', undefined, 1);
      else if (!world.infiniteAmmo && p.ammoCount && !Object.values(p.ammoCount).some((n) => n > 0)) hud?.msg?.('Keine Munition', '#ff6a4d', 1.2);
   }
   if (G.fireReq != null && world.time - G.fireReq < 0.3 && p.reload <= 0 && world.phase !== 'countdown' && p.fire?.(world)) G.fireReq = null;
   const AM = ['AP', 'APCR', 'HEAT', 'HE'];
   for (let i = 0; i < 4; i++) if (input.hit('Digit' + (i + 1))) { const types = p.cfg?.ammoTypes || p.cfg?.gun?.ammo?.map?.((a) => a.type) || AM; types[i] && p.setAmmo?.(types[i]); }
   for (let i = 0; i < 3; i++) if (input.hit('Digit' + (i + 5))) { const ids = Object.keys(p.consumables || {}); ids[i] && p.useConsumable?.(ids[i]); }
   if (input.hit('KeyR')) inp.cruise = Math.min(3, (inp.cruise || 0) + 1);
   if (input.hit('KeyF')) inp.cruise = Math.max(-1, (inp.cruise || 0) - 1);
   if (inp.throttle) inp.cruise = 0;
   else if (inp.cruise) inp.throttle = inp.cruise > 0 ? inp.cruise / 3 : -0.5;
}

let last = performance.now(), fpsAcc = 0, fpsN = 0;
function frame(now) {
   requestAnimationFrame(frame);
   const dt = Math.min(0.1, (now - last) / 1000); last = now;
   fpsAcc += dt; fpsN++; if (fpsAcc > 0.5) { G.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
   const world = G.world;
   if (world && G.paused && !G.net) { /* frozen: render only */ }
   else if (world) {
      const p = world.player;
      if (/^(won|lost|draw)$/.test(world.phase) || world.result) { G.endT += dt; if (G.endT > 4 && menu) { finishBattle(); return; } }
      controls(world, p, dt);
      G.acc += dt; let n = 0;
      while (G.acc >= SIM_DT && n++ < 6) { snapPrev(world); world.update(SIM_DT); G.acc -= SIM_DT; }
      if (n >= 6) G.acc = 0;
      lerpPoses(world, G.acc / SIM_DT);   // draw tanks between the last two sim steps (no stepping judder)
      if (p) {
         pivot.set(p.pos.x, p.pos.y + (p.height ?? p.cfg?.height ?? 2.4) + 0.4, p.pos.z);
         if (tanks3d?.sightPos) tanks3d.sightPos(p, sight); else sight.set(p.pos.x, p.pos.y + (p.height ?? p.cfg?.height ?? 2.4), p.pos.z);
         if (G.camOverride) { const o = G.camOverride; R.camera.position.set(o[0], o[1], o[2]); R.camera.lookAt(o[3], o[4], o[5]); }
         else tcam.update(dt, pivot, sight, (x, z) => world.terrain.heightAt(x, z));
         aimRay(world, p);
      }
      terrain3d?.update(R.camera.position, dt);
      tanks3d?.update(dt, R.camera);
      fx?.update(dt, R.camera);
      audio?.update?.(dt, world, R.camera, tcam);
      if (p) R.followShadow(p.pos.x, p.pos.z, p.pos.y);
      document.getElementById('scope').classList.toggle('on', tcam.scoped);
      if (tanks3d?.setHidden) tanks3d.setHidden(p, tcam.scoped);
   } else menu?.update?.(dt);
   sky.update(R.camera, now / 1000);
   R.render();
   hud?.draw?.(dt);
   if (G.world) restorePoses(G.world);
   input.endFrame();
   G.frame++;
}

document.getElementById('boot').remove();
if (menuM.Menu) {
   try {
      menu = G.menu = new menuM.Menu(document.getElementById('menu'), { startBattle, R, sky, input, q, mods: G.mods, themeOf, getAudio,
         saveQuality: gfxM.saveQuality, loadQualityId: () => { try { return localStorage.getItem('wartanks.gfx.v1'); } catch { return null; } },
         resume: () => setPaused(false), leave: leaveBattle });
   } catch (e) { console.error('[main] menu failed', e); menu = null; }
}
if (params.has('autostart') || !menu) startBattle({ mapId: params.get('map') || undefined, playerCls: params.get('tank') || undefined, mode: params.get('mode') || undefined, difficulty: params.get('diff') || undefined, op: params.get('op') || undefined });
else menu.show(params.get('screen') || 'title');
requestAnimationFrame(frame);
