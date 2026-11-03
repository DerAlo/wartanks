// game/spotting.js — WoT-like detection (pure sim). Run every WORLD.SPOT_DT.
//
//   updateSpotting(world, dt)
//     per enemy pair: proximity 50 m always; else view range vs camouflage
//       spotDist = view − camo × (view − 50)
//       camo = still | move (by speed), × fire factor for 3 s after a shot,
//              + bushes on the line (0.25 each up to 0.5, bushes < 15 m from the observer ignored,
//              the target's own bush is lost when it fired)
//     and a terrain/object LOS from the commander (hull top + 0.3 m) to any of 4 target points.
//   Results (team-shared, 2 s memory):
//     tank.spotted   — visible to the opposing team (render/minimap/AI knowledge)
//     tank.detected  — seen directly this cycle (the "sixth sense" lamp for the player)
//     tank.spotterId — id of the tank credited with spotting it (assist damage)
//     tank.visible   — for the local player's enemies: spotted and within WORLD.DRAW_RANGE
import { WORLD, CLASS_DEFAULTS } from './config.js';

const BUSH = 0.25, BUSH_MAX = 0.5, FIRE_WINDOW = 3, MOVE_V = 0.6;

function camoOf(t, time) {
   const c = t.camo || { still: 0.1, move: 0.05 };
   let k = Math.abs(t.speed) > MOVE_V || Math.abs(t.yawRate) > 0.1 ? c.move : c.still;
   const fired = time - t.lastFire < FIRE_WINDOW;
   if (fired) k *= c.fire ?? CLASS_DEFAULTS[t.cfg.cls]?.fireCamo ?? 0.2;
   return { k, fired };
}

function los(T, o, t) {
   const oy = o.pos.y + (o.cfg.eye ?? o.height + 0.3);      // cfg.eye: emplacements (crew standing / on the bridge)
   const fx = -Math.sin(t.yaw), fz = -Math.cos(t.yaw), L = t.halfLen * 0.8;
   for (let i = 0; i < 4; i++) {
      let x = t.pos.x, z = t.pos.z, y = t.pos.y;
      if (i === 0) y += t.height * 0.92;
      else if (i === 1) y += t.height * 0.55;
      else { const s = i === 2 ? 1 : -1; x += fx * L * s; z += fz * L * s; y += t.height * 0.5; }
      const dx = x - o.pos.x, dy = y - oy, dz = z - o.pos.z, d = Math.hypot(dx, dy, dz);
      if (d < 1) return true;
      const hit = T.raycast(o.pos.x, oy, o.pos.z, dx / d, dy / d, dz / d, d - 0.5);
      if (hit == null) return true;
   }
   return false;
}

/** Can `o` see `t` now? */
export function canSee(world, o, t) {
   const dx = t.pos.x - o.pos.x, dz = t.pos.z - o.pos.z, d = Math.hypot(dx, dz);
   if (d <= WORLD.PROXIMITY) return true;
   const view = Math.min(o.viewRange, WORLD.DRAW_RANGE) * (1 - 0.62 * (world.campaign?.fog || 0));   // campaign fog (Arracourt)
   if (d > view) return false;
   const T = world.terrain;
   const { k, fired } = camoOf(t, world.time);
   let bushes = T.bushesOnLine ? T.bushesOnLine(t.pos.x, t.pos.z, o.pos.x, o.pos.z, 15) : 0;
   if (fired && bushes > 0 && T.inBush?.(t.pos.x, t.pos.z, 1)) bushes--;      // own bush lost when firing
   const camo = Math.min(0.95, k + Math.min(BUSH_MAX, bushes * BUSH) * (1 - k));
   const spotDist = view - camo * (view - WORLD.PROXIMITY);
   if (d > spotDist) return false;
   return los(T, o, t);
}

export function updateSpotting(world, dt) {
   const tanks = world.tanks, time = world.time;
   for (const t of tanks) { t._seenNow = false; t._seer = null; }
   for (const t of tanks) {
      if (!t.alive) continue;
      for (const o of tanks) {
         if (!o.alive || o.team === t.team) continue;
         if (t._seenNow && t._seer && t._seer.id === t.spotterId) break;   // credited spotter still sees it
         if (canSee(world, o, t)) {
            if (!t._seenNow || o.id === t.spotterId) t._seer = o;
            t._seenNow = true;
         }
      }
   }
   const P = world.player;
   for (const t of tanks) {
      t.detected = t._seenNow;
      if (!t.alive) { t.spotted = true; t.spotT = 0; t.visible = true; continue; }      // wrecks are terrain
      if (t._seenNow) {
         if (!t.spotted && t._seer) {
            t._seer.stats.spotted += t._everSpotted ? 0 : 1;
            world.onSpotted?.(t, t._seer);
         }
         t._everSpotted = true;
         t.spotT = WORLD.SPOT_MEMORY;
         t.spotted = true;
         if (t._seer) t.spotterId = t._seer.id;
      } else {
         t.spotT -= dt;
         if (t.spotT <= 0) { t.spotT = 0; t.spotted = false; }
      }
      if (P && t.team !== P.team) {
         const d = Math.hypot(t.pos.x - P.pos.x, t.pos.z - P.pos.z);
         t.visible = t.spotted && (d <= WORLD.DRAW_RANGE || !P.alive);
      } else t.visible = true;
   }
}
