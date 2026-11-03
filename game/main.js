// game/main.js — boot and frame loop. Owns no game rules: it builds the World (state.js), turns
// input into tank.input / tank.aimPoint, steps the sim at SIM_DT and draws. Exposes window.__game
// for the playwright scripts.
import * as THREE from '../vendor/three/three.module.min.js';
import { loadQuality } from './gfxquality.js';
import { Renderer } from './render.js';
import { Sky } from './sky.js';
import { Terrain3D } from './terrain3d.js';
import { Input } from './input.js';
import { TankCamera } from './camera.js';

const SIM_DT = 1 / 60;
const q = loadQuality();
const canvas = document.getElementById('gl');
const R = new Renderer(canvas, q);
const sky = new Sky(R.scene);
const input = new Input(canvas);
const tcam = new TankCamera(R.camera);
const params = new URLSearchParams(location.search);

// optional modules: graceful while other parts are still being written
async function opt(path) { try { return await import(path); } catch (e) { console.warn('[main] optional module missing', path, e.message); return {}; } }
const [stateM, mapsM, tanks3dM, hudM, fxM, audioM, menuM, armorM] = await Promise.all(
   ['./state.js', './maps.js', './tanks3d.js', './hud.js', './fx.js', './audio.js', './menu.js', './armor.js'].map(opt));

const G = window.__game = { R, q, tcam, input, world: null, fps: 0, frame: 0, mods: { stateM, mapsM, tanks3dM, hudM, fxM, audioM, menuM, armorM } };
let terrain3d = null, tanks3d = null, hud = null, fx = null, audio = null, menu = null;
const tmpO = new THREE.Vector3(), tmpD = new THREE.Vector3(), pivot = new THREE.Vector3(), sight = new THREE.Vector3();

function themeOf(mapId) {
   const T = mapsM.MAPS || mapsM.THEMES || mapsM.default;
   const th = (Array.isArray(T) ? T.find((m) => m.id === mapId) : T?.[mapId]) || {};
   return { id: mapId, ...th, ...(th.render || th.gfx || {}) };
}


// TEMPORARY stub until state.js / terrain.js land: noise terrain + one drivable tank.
function StubWorld(opts) {
   const h = (x, z) => 18 * Math.sin(x * 0.011) * Math.cos(z * 0.009) + 6 * Math.sin(x * 0.043 + z * 0.031);
   const terrain = { half: 500, version: 0, water: null, heightAt: h,
      normalAt(x, z) { const e = 1, nx = h(x - e, z) - h(x + e, z), nz = h(x, z - e) - h(x, z + e), l = Math.hypot(nx, 2 * e, nz); return { x: nx / l, y: 2 * e / l, z: nz / l }; },
      groundAt: (x, z) => Math.abs(z - 40 * Math.sin(x * 0.01)) < 4 ? 'road' : 'medium',
      raycast(ox, oy, oz, dx, dy, dz, max) { for (let d = 0; d < max; d += 0.5) if (oy + dy * d < h(ox + dx * d, oz + dz * d)) return d; return null; },
      objects: [] };
   for (let i = 0; i < 600; i++) { const x = Math.sin(i * 12.9898) * 480, z = Math.sin(i * 78.233) * 480; terrain.objects.push({ id: i, kind: i % 5 === 0 ? 'bush' : i % 13 === 0 ? 'rock' : i % 29 === 0 ? 'house' : 'tree', x, z, yaw: i, w: i % 29 === 0 ? 10 : 3, d: i % 29 === 0 ? 7 : 3, h: i % 29 === 0 ? 7 : undefined, solid: true, alive: true, seed: i }); }
   const mk = (id, team, x, z) => ({ id, team, cls: 'stub', cfg: { height: 2.4 }, pos: { x, y: h(x, z), z }, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, gunPitch: 0, speed: 0, hp: 1000, maxHP: 1000, alive: true, reload: 0, reloadMax: 6, input: {}, pose() { return this; } });
   const player = mk(1, 1, 0, 100), enemy = mk(2, 2, 0, -60);
   return { terrain, tanks: [player, enemy], player, shells: [], events: [], time: 0, phase: 'playing', mapId: opts.mapId,
      update(dt) { this.time += dt; const p = player, i = p.input; p.speed += ((i.throttle || 0) * 12 - p.speed) * dt * 0.8; p.yaw += (i.steer || 0) * dt * 0.7;
         p.pos.x -= Math.sin(p.yaw) * p.speed * dt; p.pos.z -= Math.cos(p.yaw) * p.speed * dt; p.pos.y = h(p.pos.x, p.pos.z); } };
}

export function startBattle(opts = {}) {
   stopBattle();
   for (const k in opts) if (opts[k] === undefined) delete opts[k];
   const world = G.world = new (stateM.World || StubWorld)({ mode: 'standard', mapId: 'steppe', seed: 1234, playerCls: undefined, difficulty: 1, ...opts });
   const th = themeOf(world.mapId ?? opts.mapId);
   R.setTheme(th); sky.setTheme(th, R.sunDir);
   terrain3d = new Terrain3D(R.scene, world.terrain, th, q);
   if (tanks3dM.Tanks3D) tanks3d = new tanks3dM.Tanks3D(R.scene, world);
   if (fxM.FX) fx = new fxM.FX(R.scene, world, q);
   if (hudM.HUD) hud = new hudM.HUD(document.getElementById('hudc'), world, { armor: armorM, cam: tcam, R });
   if (audioM.Audio && !audio) audio = new audioM.Audio();
   audio?.start?.(world);
   tcam.reset(world.player?.yaw ?? 0);
   input.enabled = true; menu?.hide?.();
   G.acc = 0;
}
export function stopBattle() {
   input.enabled = false; input.unlock();
   terrain3d && R.scene.remove(terrain3d.group); tanks3d?.dispose?.(); fx?.dispose?.(); hud?.dispose?.(); audio?.stop?.();
   terrain3d = tanks3d = fx = hud = null; G.world = null;
}
G.startBattle = startBattle; G.stopBattle = stopBattle;

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
      const r = (t.cfg?.radius ?? 4), d2 = cx * cx + cy * cy + cz * cz - along * along;
      if (d2 > r * r) continue;
      let hitD = along - Math.sqrt(r * r - d2) * 0.6;
      if (armorM.rayArmor && t.armor) {
         const hits = armorM.rayArmor(t.armor, t.pose(), tmpO, tmpD);
         if (!hits?.length) continue;
         hitD = hits[0].dist; G.aimTarget = { tank: t, hit: hits[0] };
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
   tcam.setFreeLook(input.rmb);
   tcam.look(input.dx, input.dy, input.sens);
   if (!p?.alive) return;
   const k = (c) => input.down(c);
   const inp = p.input ??= {};
   inp.throttle = (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0);
   inp.steer = (k('KeyA') || k('ArrowLeft') ? 1 : 0) - (k('KeyD') || k('ArrowRight') ? 1 : 0);
   inp.brake = k('Space');
   inp.fire = input.lmb && !G.noFire;
   if (input.lmbPressed && p.reload <= 0) p.fire?.(world);
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
   if (world) {
      const p = world.player;
      controls(world, p, dt);
      if (p) {
         pivot.set(p.pos.x, p.pos.y + (p.cfg?.height ?? 2.4) + 0.4, p.pos.z);
         if (tanks3d?.sightPos) tanks3d.sightPos(p, sight); else sight.set(p.pos.x, p.pos.y + (p.cfg?.height ?? 2.4), p.pos.z);
         tcam.update(dt, pivot, sight, (x, z) => world.terrain.heightAt(x, z));
         aimRay(world, p);
      }
      G.acc += dt; let n = 0;
      while (G.acc >= SIM_DT && n++ < 6) { world.update(SIM_DT); G.acc -= SIM_DT; }
      if (n >= 6) G.acc = 0;
      terrain3d?.update(R.camera.position);
      tanks3d?.update(dt, R.camera);
      fx?.update(dt, R.camera);
      audio?.update?.(dt, world, R.camera, tcam);
      if (p) R.followShadow(p.pos.x, p.pos.z, p.pos.y);
      document.getElementById('scope').classList.toggle('on', tcam.scoped);
      if (tanks3d?.setHidden) tanks3d.setHidden(p, tcam.scoped);
   }
   sky.update(R.camera, now / 1000);
   R.render();
   hud?.draw?.(dt);
   input.endFrame();
   G.frame++;
}

document.getElementById('boot').remove();
if (menuM.Menu) { menu = new menuM.Menu(document.getElementById('menu'), { startBattle, R, sky, mods: G.mods }); }
if (params.has('autostart') || !menu) startBattle({ mapId: params.get('map') || undefined, playerCls: params.get('tank') || undefined, mode: params.get('mode') || undefined });
else menu.show();
requestAnimationFrame(frame);
