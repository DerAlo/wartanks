// game/tank.js — the Tank (pure sim): drivetrain, terrain-following pose, water, collisions,
// turret / gun laying, dispersion, reload, ammo, modules / crew, fires, consumables, wreck.
//
//   new Tank(cfg | clsId, { id, team, name, isPlayer, x, z, yaw, terrain })
//   tank.update(dt, world)          one sim step (world: terrain, time, rng, optional hooks below)
//   tank.fire(world) -> shell|null  uses gunWorld + dispersion + fireShell
//   tank.setAmmo(type), tank.useConsumable(id), tank.pose()
//   tank.damageModule(id, dmg) / damageCrew(id, dmg) -> 'damaged'|'destroyed'|'killed'|null
//   collideTanks(tanks, world)      tank vs tank (mass-based push + ram damage), call once per step
//
// World hooks the tank calls when present (all optional):
//   world.onFire(tank, round, muzzlePos, dir)      after a shot left the barrel
//   world.onRam(a, b, dmgA, dmgB, point)           ram damage (World applies hp + events)
//   world.onTankEffect(kind, tank, obj)            'treeFall' | 'objectBreak' | 'splash' | 'drown'
//   world.onBurn(tank, dmg)                        fire damage tick (World applies + attributes)
//   world.infiniteAmmo                             training ground
import { TANKS, MODULES, CONSUMABLES, CLASS_DEFAULTS, GROUND, WORLD } from './config.js';
import { armorInstance, gunWorld } from './armor.js';
import { fireShell, solveElevation } from './ballistics.js';
import { clamp, approach, approachAngle, angleDelta, poseMatrix, mulMat3T, DEG } from './utils.js';

const KMH = 1 / 3.6;
const HP_W = 735.5;            // W per metric hp
const DRIVE_EFF = 0.95;        // engine -> track power (generous: WoT-like pace, terrain still tells)
const MU = [0.85, 0.78, 0.7, 0.55, 0.5];   // traction by ground idx (road, hard, medium, soft, water)
const RES = [GROUND.road.res, GROUND.hard.res, GROUND.medium.res, GROUND.soft.res, GROUND.water.res];
const CFG_GROUND_IDX = [0, 0, 1, 2, 2];     // ground idx -> cfg.ground [hard, medium, soft] slot
const BRAKE = 6.5;             // m/s² service brake
const COAST = 2.8;             // m/s² engine braking with the throttle released (WoT-like: stops in ~4 s)
const DROWN_TIME = 10;
const REPAIR_TIME = { trackL: 9, trackR: 9, engine: 14, gun: 12, turretRing: 12, optics: 10, radio: 10, fuel: 12, ammo: 12 };
const ELEV_SPEED = 14 * DEG;   // gun elevation drive, rad/s
const PAK_SLEW = 0.07;         // rad/s: a PaK crew shifting the split trails (~25 s for 90°)
const CLIFF = 1.25;            // m of height step per m ahead that counts as a wall (~51°)
// object break thresholds: momentum in t·m/s
const BREAK = { tree: 40, fence: 8, wall: 110, bush: 0 };

let _nextId = 1;
const _p = { x: 0, y: 0, z: 0 }, _dir = { x: 0, y: 0, z: 0 }, _v = { x: 0, y: 0, z: 0 }, _l = { x: 0, y: 0, z: 0 };

const roleOf = (crew, role) => { for (const k in crew) { const c = crew[k]; if (c.alive && c.roles.includes(role)) return true; } return false; };

export class Tank {
   constructor(cfg, o = {}) {
      if (typeof cfg === 'string') cfg = TANKS[cfg];
      if (!cfg) throw new Error('unknown tank type');
      const g = cfg.gun, cd = CLASS_DEFAULTS[cfg.cls] || CLASS_DEFAULTS.MT;
      this.id = o.id ?? _nextId++;
      this.cls = cfg.id; this.cfg = cfg; this.name = o.name || cfg.name;
      this.team = o.team ?? 1; this.isPlayer = !!o.isPlayer; this.side = o.side || (this.isPlayer ? 'player' : 'enemy');
      this.bot = !this.isPlayer;
      this.armor = armorInstance(cfg);
      this.pos = { x: o.x || 0, y: 0, z: o.z || 0 };
      this.vel = { x: 0, y: 0, z: 0 };
      this.push = { x: 0, z: 0 };                 // collision impulse velocity (decays)
      this.yaw = o.yaw || 0; this.pitch = 0; this.roll = 0;
      this.pitchV = 0; this.rollV = 0; this.yV = 0; this.yawRate = 0; this.accel = 0;
      this.speed = 0; this.speedKmh = 0;
      this.turretYaw = 0; this.gunPitch = 0; this.turretRate = 0;
      this.gunBlocked = false;                    // aim point outside elevation / arc limits
      this.hp = this.maxHP = cfg.hp; this.alive = true; this.burning = false; this.burnT = 0; this.fireSrc = null;
      this.wreckT = 0; this.turretOff = false; this.drownT = 0; this.inWater = 0;
      this.mass = cfg.mass; this.massKg = cfg.mass * 1000;
      this.hpPerT = cfg.engine.hp / cfg.mass;
      this.halfLen = (cfg.run?.len || cfg.dims.len * 0.9) / 2; this.halfW = (cfg.dims.width || 3) / 2;
      this.trackX = cfg.run?.x || this.halfW * 0.8;
      this.radius = Math.hypot(cfg.dims.len / 2, this.halfW);   // bounding circle
      this.height = cfg.dims.height;
      // modules / crew
      this.modules = {};
      const tierK = 0.6 + 0.08 * cfg.tier;
      for (const id of ['engine', 'ammo', 'fuel', 'gun', 'turretRing', 'radio', 'optics', 'trackL', 'trackR']) {
         if (id === 'turretRing' && !cfg.turret) continue;
         const max = cfg.modules?.[id]?.hp ?? Math.round(MODULES[id].hp * tierK);
         this.modules[id] = { hp: max, max, state: 'ok', repairT: 0 };
      }
      this.crew = {};
      for (const c of cfg.crew) this.crew[c.id] = { alive: true, hp: c.hp ?? 100, wounded: false, roles: c.roles };
      // gun / ammo
      this.ammoSel = g.ammo[0].type;
      this.ammoCount = {};
      for (const a of g.ammo) this.ammoCount[a.type] = g.load?.[a.type] ?? 0;
      this.reloadMax = g.reload; this.reload = 2;
      this.baseDisp = g.disp; this.aimDisp = g.disp * 3;
      this.dispMove = g.dispMove ?? cd.dispMove; this.dispHull = g.dispHull ?? cd.dispHull;
      this.dispTurret = g.dispTurret ?? cd.dispTurret; this.dispShot = g.dispShot ?? cd.dispShot;
      this.arc = g.arc ? [g.arc[0] * DEG, g.arc[1] * DEG] : null;
      this.elev = g.elev * DEG; this.depr = g.depr * DEG;
      this.turretSpeed = (cfg.turret ? cfg.turretTraverse : (g.traverse ?? cfg.turretTraverse ?? 12)) * DEG;
      this.aimPoint = { x: this.pos.x - Math.sin(this.yaw) * 100, y: 0, z: this.pos.z - Math.cos(this.yaw) * 100 };
      this.gunDir = { x: 0, y: 0, z: -1 }; this.muzzle = { x: 0, y: 0, z: 0 };
      this.lastFire = -99; this.lastDamaged = -99; this.lastMoved = -99;
      // spotting (spotting.js writes these)
      this.viewRange = cfg.view; this.spotted = false; this.detected = false; this.spotT = 0; this.seenBy = 0;
      this.camo = cfg.camo;
      this.consumables = {};
      for (const id in CONSUMABLES) this.consumables[id] = { count: 1, cd: 0 };
      this.input = { throttle: 0, steer: 0, brake: false, cruise: 0, fire: false, lockId: null };
      this.stats = { dmg: 0, kills: 0, shots: 0, hits: 0, pens: 0, bounces: 0, blocked: 0, spotted: 0, assist: 0, crits: 0, received: 0, ram: 0 };
      // pose object (shared, updated in place) for armor.js / renderer
      this._m = new Float64Array(9);
      this._pose = { pos: this.pos, yaw: 0, pitch: 0, roll: 0, turretYaw: 0, gunPitch: 0, m: this._m };
      if (o.terrain) this.placeOn(o.terrain);
   }

   // ---------------------------------------------------------------- derived
   roleAlive(role) { return roleOf(this.crew, role); }
   mod(id) { return this.modules[id]?.state ?? 'ok'; }
   get immobile() { return this.mod('trackL') === 'destroyed' || this.mod('trackR') === 'destroyed' || this.mod('engine') === 'destroyed'; }
   /** Engine power multiplier from engine module + driver. */
   powerK() {
      const e = this.mod('engine');
      return (e === 'destroyed' ? 0 : e === 'damaged' ? 0.55 : 1) * (this.roleAlive('driver') ? 1 : 0.7);
   }
   round() { return this.cfg.gun.ammoByType[this.ammoSel]; }
   viewRangeNow() {
      let v = this.cfg.view * (this.viewMul ?? 1);
      if (!this.roleAlive('commander')) v *= 0.85;
      const o = this.mod('optics'); if (o === 'damaged') v *= 0.8; else if (o === 'destroyed') v *= 0.6;
      return v;
   }
   radioRange() { const r = this.mod('radio'); return (r === 'destroyed' ? 0.3 : r === 'damaged' ? 0.65 : 1) * (this.roleAlive('radio') || this.roleAlive('commander') ? 1 : 0.6); }

   pose() {
      const P = this._pose;
      P.yaw = this.yaw; P.pitch = this.pitch; P.roll = this.roll; P.turretYaw = this.turretYaw; P.gunPitch = this.gunPitch;
      poseMatrix(this._m, this.yaw, this.pitch, this.roll);
      return P;
   }

   _siteTick(dt, world) {
      this.speed = 0; this.vel.x = this.vel.y = this.vel.z = 0; this.yawRate = 0; this.input.throttle = 0; this.input.steer = 0;
      if (this.cfg.draft != null) {                  // a ship rides at the water line and rolls gently
         this.pos.y = (world.terrain.water ?? 0) - this.cfg.draft;
         this.pitch = Math.sin(world.time * 0.37 + this.id) * 0.004; this.roll = Math.sin(world.time * 0.53 + this.id * 2) * 0.012;
      }
      // a PaK crew re-lays the trails (slowly) when its target is outside the shield's arc
      const e = this.cfg.site === 'pak' && this.ai?.target;
      if (e && e.alive && this.arc) {
         const want = Math.atan2(-(e.pos.x - this.pos.x), -(e.pos.z - this.pos.z));
         let d = want - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d));
         if (Math.abs(d) > this.arc[1] * 0.8) { this.yaw += Math.sign(d) * Math.min(Math.abs(d), PAK_SLEW * dt); this.pose(); }
      }
   }

   /** Snap onto the ground (spawn). */
   placeOn(T) {
      this.pos.y = this.cfg.draft != null ? (T.water ?? 0) - this.cfg.draft : T.heightAt(this.pos.x, this.pos.z);
      if (this.cfg.draft == null) this._terrainPose(T, 1);
      this.pose(); gunWorld(this.cfg, this._pose, this.muzzle, this.gunDir);
   }

   // ---------------------------------------------------------------- per step
   update(dt, world) {
      const T = world.terrain;
      if (!this.alive) { this._wreck(dt, T); return; }
      this._modulesTick(dt);
      if (this.cfg.site) this._siteTick(dt, world);       // emplacements / ships never drive
      else {
         this._drive(dt, world);
         this._terrainPose(T, dt);
         this._water(dt, world);
         this._objects(world);
         this._boundary(T);
      }
      this.pose();
      this._aim(dt);
      this._fireTick(dt, world);
      for (const k in this.consumables) { const c = this.consumables[k]; if (c.cd > 0) c.cd = Math.max(0, c.cd - dt); }
      if (this.reload > 0) {
         let rate = 1;
         if (!this.roleAlive('loader')) rate /= 1.35;
         if (this.mod('gun') === 'damaged') rate /= 1.1;
         if (this.mod('gun') !== 'destroyed') this.reload = Math.max(0, this.reload - dt * rate);
      }
      this.reloadMax = this.cfg.gun.reload * (this.roleAlive('loader') ? 1 : 1.35);
      this.viewRange = this.viewRangeNow();
      if (this.input.fire && this.bot && this.reload <= 0) this.fire(world);
   }

   _drive(dt, world) {
      const T = world.terrain, cfg = this.cfg, inp = this.input;
      const gi = T.groundIdxAt(this.pos.x, this.pos.z);
      const gmul = cfg.ground[CFG_GROUND_IDX[gi]] ?? 1;
      const res = RES[gi] * gmul;
      const mu = MU[gi];
      const pk = this.powerK();
      const immobile = this.mod('trackL') === 'destroyed' || this.mod('trackR') === 'destroyed';
      let thr = clamp(inp.throttle || 0, -1, 1);
      const steer = clamp(inp.steer || 0, -1, 1);
      if (immobile || pk === 0) thr = 0;
      const v = this.speed, av = Math.abs(v);
      const g = WORLD.G, cosP = Math.cos(this.pitch);
      const N = g * cosP;                                   // normal accel
      const slopeA = -g * Math.sin(this.pitch);             // along hull forward (nose up = decel going forward)
      const vMax = cfg.vMax * KMH * (this.roleAlive('driver') ? 1 : 0.9), vRev = cfg.vRev * KMH;
      // hull traverse (neutral steer on the spot, slower at speed and on soft ground)
      let yawRate = 0;
      if (!immobile && pk > 0 && steer) {
         const trav = cfg.traverse * DEG * (0.6 + 0.4 * Math.sqrt(pk)) / Math.max(1, gmul * 0.9);
         yawRate = steer * trav * (1 - 0.35 * clamp(av / vMax, 0, 1));
      }
      this.yawRate = approach(this.yawRate, yawRate, dt * 4);
      this.yaw += this.yawRate * dt;
      // longitudinal
      let a = slopeA;
      const P = cfg.engine.hp * HP_W * DRIVE_EFF * pk;
      const dirWanted = thr > 0 ? 1 : thr < 0 ? -1 : 0;
      if (inp.brake || (dirWanted && Math.sign(v) === -dirWanted && av > 0.3)) {
         a += -Math.sign(v) * Math.min(BRAKE, mu * N + 1);
      } else if (dirWanted) {
         const lim = dirWanted > 0 ? vMax : vRev;
         const over = av > lim * Math.abs(thr);
         if (!over) {
            const F = Math.min(P * Math.abs(thr) / Math.max(av, 1.2), mu * N * this.massKg);
            a += dirWanted * F / this.massKg;
         } else a -= Math.sign(v) * 1.5;
      }
      // rolling resistance + engine braking; turning bleeds speed
      const rr = res * N + (dirWanted ? 0 : COAST) + Math.abs(this.yawRate) * av * 0.35;
      let v1 = v + a * dt;
      if (Math.abs(v1) > 1e-4) { const dv = rr * dt; v1 = Math.abs(v1) <= dv ? 0 : v1 - Math.sign(v1) * dv; }
      const slides = Math.abs(slopeA) > mu * N * 0.95;               // steeper than traction: slide
      if (v !== 0 && Math.sign(v1) !== Math.sign(v) && dirWanted !== Math.sign(v1) && !slides) v1 = 0;   // stop, don't reverse
      if (v === 0 && dirWanted && Math.sign(v1) === -dirWanted && !slides) v1 = 0;                       // stall on a climb
      if (!dirWanted && Math.abs(v) < 0.05 && !slides) v1 = 0;                                           // parked: holds
      this.speed = v1;
      this.speed = clamp(this.speed, -vRev * 1.6, vMax * 1.3);
      this.accel = (this.speed - v) / dt;
      // move
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      let dx = (fx * this.speed + this.push.x) * dt, dz = (fz * this.speed + this.push.z) * dt;
      const pd = Math.exp(-dt * 6); this.push.x *= pd; this.push.z *= pd;
      // cliff check ahead of the leading track end
      if (Math.abs(this.speed) > 0.05) {
         const sg = Math.sign(this.speed), ex = this.pos.x + fx * sg * this.halfLen, ez = this.pos.z + fz * sg * this.halfLen;
         const hl = this.cfg.dims?.len ?? this.halfLen * 2, H = T.hullHeightAt ? (a, b) => T.hullHeightAt(a, b, hl) : (a, b) => T.heightAt(a, b);
         const h0 = H(ex, ez), h1 = H(ex + fx * sg, ez + fz * sg);
         if (h1 - h0 > CLIFF) { this.speed = 0; dx = this.push.x * dt; dz = this.push.z * dt; }
      }
      this.pos.x += dx; this.pos.z += dz;
      this.vel.x = dx / dt; this.vel.z = dz / dt;
      this.speedKmh = this.speed * 3.6;
      if (av > 0.5 || Math.abs(this.yawRate) > 0.05) this.lastMoved = world.time ?? 0;
   }

   /** Pitch / roll / height from four track contact samples, with a little suspension. */
   _terrainPose(T, dt) {
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw), L = this.halfLen * 0.9, W = this.trackX;
      const x = this.pos.x, z = this.pos.z;
      const hl = this.cfg.dims?.len ?? this.halfLen * 2, hAt = T.hullHeightAt ? (a, b) => T.hullHeightAt(a, b, hl) : (a, b) => T.heightAt(a, b);
      // local (lx, lz) -> world: x + c*lx + s*lz, z - s*lx + c*lz ; front = -z local
      const hFL = hAt(x - c * W - s * L, z + s * W - c * L), hFR = hAt(x + c * W - s * L, z - s * W - c * L);
      const hRL = hAt(x - c * W + s * L, z + s * W + c * L), hRR = hAt(x + c * W + s * L, z - s * W + c * L);
      const hC = hAt(x, z);
      const front = Math.max(hFL, hFR) * 0.5 + (hFL + hFR) * 0.25, rear = Math.max(hRL, hRR) * 0.5 + (hRL + hRR) * 0.25;
      const left = (hFL + hRL) / 2, right = (hFR + hRR) / 2;
      let tp = Math.atan2(front - rear, 2 * L) - clamp(this.accel, -8, 8) * 0.004;
      const tr = Math.atan2(right - left, 2 * W);
      const ty = Math.max((front + rear) / 2, hC - 0.15);
      if (dt >= 1) { this.pitch = tp; this.roll = tr; this.pos.y = ty; return; }
      // critically-damped-ish springs
      const k = 90, d = 2 * Math.sqrt(k) * 0.75;
      this.pitchV += ((tp - this.pitch) * k - this.pitchV * d) * dt; this.pitch += this.pitchV * dt;
      this.rollV += ((tr - this.roll) * k - this.rollV * d) * dt; this.roll += this.rollV * dt;
      const ky = 160, dy = 2 * Math.sqrt(ky);
      this.yV += ((ty - this.pos.y) * ky - this.yV * dy) * dt; this.pos.y += this.yV * dt;
      if (this.pos.y < ty - 0.25) { this.pos.y = ty - 0.25; this.yV = Math.max(0, this.yV); }
      this.vel.y = this.yV;
   }

   _water(dt, world) {
      const T = world.terrain;
      const depth = T.waterDepth ? T.waterDepth(this.pos.x, this.pos.z) : 0;
      this.inWater = depth;
      const deep = this.height * 0.62;
      if (depth > deep) {
         if (this.drownT === 0) world.onTankEffect?.('drown', this, null);
         this.drownT += dt;
         this.speed *= Math.exp(-dt * 0.8);
         if (this.drownT >= DROWN_TIME) { this.hp = 0; world.onDrown ? world.onDrown(this) : this.destroy(); }
      } else {
         this.drownT = Math.max(0, this.drownT - dt * 2);
         if (depth > 0.2) this.speed *= Math.exp(-dt * depth * 0.35);
      }
   }

   _objects(world) {
      const T = world.terrain;
      T.driveOver?.(this.pos.x, this.pos.z, Math.max(this.halfLen, this.halfW ?? this.trackX));
      const near = T.objectsNear(this.pos.x, this.pos.z, this.radius + 1);
      if (!near.length) return;
      const c = Math.cos(this.yaw), s = Math.sin(this.yaw);
      const fx = -s, fz = -c;
      const momentum = this.mass * Math.abs(this.speed);
      // two circles along the hull
      const r = this.halfW * 1.02, off = Math.max(0, this.halfLen - this.halfW);
      for (let i = near.length - 1; i >= 0; i--) {
         const o = near[i];
         if (!o.alive || o.kind === 'bush') continue;
         for (let k = -1; k <= 1; k += 2) {
            const cx = this.pos.x + fx * off * k, cz = this.pos.z + fz * off * k;
            let nx, nz, pen;
            if (o.kind === 'tree') {
               const ddx = cx - o.x, ddz = cz - o.z, dd = Math.hypot(ddx, ddz), rr = r + (o.r || 0.4);
               if (dd >= rr) continue;
               nx = dd > 1e-6 ? ddx / dd : -fx; nz = dd > 1e-6 ? ddz / dd : -fz; pen = rr - dd;
            } else {
               const oc = Math.cos(o.yaw || 0), os = Math.sin(o.yaw || 0);
               const rx = cx - o.x, rz = cz - o.z;
               const lx = oc * rx - os * rz, lz = os * rx + oc * rz;
               const hw = o.w / 2, hd = o.d / 2;
               const qx = clamp(lx, -hw, hw), qz = clamp(lz, -hd, hd);
               let ex = lx - qx, ez = lz - qz, dd = Math.hypot(ex, ez);
               if (dd >= r) continue;
               if (dd < 1e-6) {           // centre inside the box: push out along the shallow axis
                  const px = hw - Math.abs(lx), pz = hd - Math.abs(lz);
                  if (px < pz) { ex = Math.sign(lx) || 1; ez = 0; pen = px + r; } else { ex = 0; ez = Math.sign(lz) || 1; pen = pz + r; }
                  dd = 1;
               } else pen = r - dd;
               ex /= dd; ez /= dd;
               nx = oc * ex + os * ez; nz = -os * ex + oc * ez;
            }
            // destructible and enough momentum toward it?
            const towards = -(nx * fx + nz * fz) * Math.sign(this.speed);
            const thr = BREAK[o.kind] ?? o.breakMomentum;
            if (o.destructible && thr != null && momentum > thr && towards > 0.2) {
               T.destroyObject(o, fx * Math.sign(this.speed), fz * Math.sign(this.speed));
               world.onTankEffect?.(o.kind === 'tree' ? 'treeFall' : 'objectBreak', this, o);
               this.speed *= o.kind === 'wall' ? 0.6 : o.kind === 'tree' ? 0.85 : 0.95;
               break;
            }
            this.pos.x += nx * pen; this.pos.z += nz * pen;
            const vn = (fx * nx + fz * nz) * this.speed;
            if (vn < 0) {           // moving into it: kill the normal component (slide along)
               const keep = Math.abs(fx * nz - fz * nx);
               this.speed *= keep * 0.9;
            }
         }
      }
   }

   _boundary(T) {
      const H = (T.half ?? WORLD.HALF) - 4;
      if (Math.abs(this.pos.x) > H) { this.pos.x = clamp(this.pos.x, -H, H); this.speed *= 0.5; this.push.x = 0; }
      if (Math.abs(this.pos.z) > H) { this.pos.z = clamp(this.pos.z, -H, H); this.speed *= 0.5; this.push.z = 0; }
   }

   // ---------------------------------------------------------------- turret, gun, dispersion
   _aim(dt) {
      const cfg = this.cfg, g = cfg.gun, a = this.aimPoint;
      // desired world direction from the trunnion area toward the aim point, with shell drop
      const px = this.muzzle.x, py = this.muzzle.y, pz = this.muzzle.z;      // last step's muzzle (close enough)
      const dx = a.x - px, dy = a.y - py, dz = a.z - pz, hd = Math.hypot(dx, dz) || 1e-3;
      const v = this.round().vel;
      let el = solveElevation(v, hd, dy);
      if (!(el === el)) el = Math.atan2(dy, hd);
      _dir.x = dx / hd * Math.cos(el); _dir.z = dz / hd * Math.cos(el); _dir.y = Math.sin(el);
      // to hull frame (current hull pose)
      poseMatrix(this._m, this.yaw, this.pitch, this.roll);
      mulMat3T(_l, this._m, _dir);
      let wantYaw = Math.atan2(-_l.x, -_l.z);
      let wantPitch = Math.asin(clamp(_l.y, -1, 1));
      this.gunBlocked = false;
      if (this.arc) {
         const cy = clamp(wantYaw, this.arc[0], this.arc[1]);
         if (cy !== wantYaw) this.gunBlocked = true;
         wantYaw = cy;
      }
      const ring = this.mod('turretRing');
      let tspd = this.turretSpeed * (ring === 'damaged' ? 0.5 : ring === 'destroyed' ? 0 : 1) * (this.roleAlive('gunner') ? 1 : 0.8);
      // the turret holds its world bearing while the hull turns under it (WoT feel): the counter-
      // rotation for the hull's own yaw is free, only the remaining laying uses the traverse drive
      if (ring !== 'destroyed' && this.yawRate) {
         this.turretYaw -= this.yawRate * dt;
         if (this.arc) this.turretYaw = clamp(this.turretYaw, this.arc[0], this.arc[1]);
      }
      const old = this.turretYaw;
      if (this.arc) this.turretYaw = approach(this.turretYaw, wantYaw, tspd * dt);
      else this.turretYaw = approachAngle(this.turretYaw, wantYaw, tspd * dt);
      this.turretRate = angleDelta(old, this.turretYaw) / dt;
      const cp = clamp(wantPitch, this.depr, this.elev);
      if (cp !== wantPitch) this.gunBlocked = true;
      this.gunLow = wantPitch < this.depr;          // blocked by depression (hull pitched up / target below)
      this.gunPitch = approach(this.gunPitch, cp, ELEV_SPEED * (this.mod('gun') === 'destroyed' ? 0 : 1) * dt);
      this._pose.turretYaw = this.turretYaw; this._pose.gunPitch = this.gunPitch;
      gunWorld(cfg, this._pose, this.muzzle, this.gunDir);
      // dispersion bloom + convergence
      let base = this.baseDisp;
      if (!this.roleAlive('gunner')) base *= 1.25;
      if (this.mod('gun') === 'damaged') base *= 1.3;
      const bloom = 1 + this.dispMove * Math.abs(this.speed) * 1.5 + this.dispHull * Math.abs(this.yawRate) / DEG * 0.1
         + this.dispTurret * Math.abs(this.turretRate) / DEG * 0.1;
      const target = base * bloom;
      const aimT = g.aim * (this.roleAlive('gunner') ? 1 : 1.25);
      if (target >= this.aimDisp) this.aimDisp = target;
      else this.aimDisp = target + (this.aimDisp - target) * Math.exp(-dt / aimT);
   }

   /** Fire the selected round. Returns the shell or null. */
   fire(world) {
      if (!this.alive || this.reload > 0 || this.mod('gun') === 'destroyed') return null;
      const type = this.ammoSel;
      if (!world.infiniteAmmo && !(this.ammoCount[type] > 0)) {
         // auto-switch to any round left
         for (const k in this.ammoCount) if (this.ammoCount[k] > 0) { this.setAmmo(k); break; }
         return null;
      }
      const round = this.round(), rng = world.rng || Math.random;
      // direction inside the dispersion circle: gaussian radius truncated at 2 sigma (= circle)
      const R = this.aimDisp / 100;
      let u = 0; do { u = Math.abs((rng() + rng() + rng() - 1.5) * 1.414); } while (u > 1);
      const ang = rng() * Math.PI * 2, off = u * R;
      const d = this.gunDir;
      // basis: right = normalize(d x up), up' = right x d
      let rx = -d.z, rz = d.x; const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      const ux = -rz * d.y, uy = rz * d.x - rx * d.z, uz = rx * d.y;
      const ca = Math.cos(ang) * off, sa = Math.sin(ang) * off;
      _v.x = d.x + rx * ca + ux * sa; _v.y = d.y + uy * sa; _v.z = d.z + rz * ca + uz * sa;
      const L = Math.hypot(_v.x, _v.y, _v.z); _v.x /= L; _v.y /= L; _v.z /= L;
      const s = fireShell(world, this, round, this.muzzle, _v);
      if (!world.infiniteAmmo) this.ammoCount[type]--;
      this.reload = this.reloadMax;
      this.aimDisp = Math.max(this.aimDisp, this.baseDisp * this.dispShot);
      this.lastFire = world.time ?? 0;
      this.stats.shots++;
      world.onFire?.(this, round, this.muzzle, _v, s);
      if (!world.infiniteAmmo && this.ammoCount[type] <= 0) for (const k in this.ammoCount) if (this.ammoCount[k] > 0) { this.ammoSel = k; break; }
      return s;
   }

   setAmmo(type) {
      if (!this.cfg.gun.ammoByType[type] || type === this.ammoSel) return false;
      if (!(this.ammoCount[type] > 0)) return false;
      this.ammoSel = type;
      this.reload = this.reloadMax;          // unload + load the new round
      return true;
   }

   // ---------------------------------------------------------------- damage model
   /** Apply module damage; returns the new state if it changed. */
   damageModule(id, dmg) {
      const m = this.modules[id]; if (!m || dmg <= 0) return null;
      const before = m.state;
      m.hp = Math.max(0, m.hp - dmg);
      m.state = m.hp <= 0 ? 'destroyed' : m.hp < m.max * 0.6 ? 'damaged' : m.state;
      if (m.state === 'destroyed' && before !== 'destroyed') m.repairT = REPAIR_TIME[id] ?? 12;
      return m.state !== before ? m.state : null;
   }
   damageCrew(id, dmg) {
      const c = this.crew[id]; if (!c || !c.alive || dmg <= 0) return null;
      c.hp -= dmg; c.wounded = true;
      if (c.hp <= 0) { c.hp = 0; c.alive = false; return 'killed'; }
      return 'wounded';
   }
   ignite(src) { if (!this.burning && this.alive) { this.burning = true; this.burnT = 0; this.fireSrc = src ?? null; return true; } return false; }

   _modulesTick(dt) {
      for (const id in this.modules) {
         const m = this.modules[id];
         if (m.state === 'destroyed') {          // field repair to 'damaged'
            m.repairT -= dt * (this.roleAlive('driver') ? 1 : 0.8);
            if (m.repairT <= 0) { m.state = 'damaged'; m.hp = Math.round(m.max * 0.5); }
         }
      }
   }
   _fireTick(dt, world) {
      if (!this.burning) return;
      this.burnT += dt;
      const dmg = this.maxHP * 0.022 * dt;
      if (world.onBurn) world.onBurn(this, dmg); else { this.hp -= dmg; if (this.hp <= 0) this.destroy(); }
      const rng = world.rng || Math.random;
      if (rng() < dt * 0.11 * (this.burnT > 4 ? 1 : 0.3)) this.burning = false;
      if (this.bot && this.burnT > 1.2 && this.consumables.extinguisher?.count > 0) this.useConsumable('extinguisher');
   }

   useConsumable(id) {
      const c = this.consumables[id];
      if (!c || c.count <= 0 || c.cd > 0 || !this.alive) return false;
      if (id === 'repair') {
         let any = false;
         for (const k in this.modules) { const m = this.modules[k]; if (m.state !== 'ok') { any = true; m.state = 'ok'; m.hp = m.max; m.repairT = 0; } }
         if (!any) return false;
      } else if (id === 'medkit') {
         let any = false;
         for (const k in this.crew) { const cr = this.crew[k]; if (!cr.alive || cr.wounded) { any = true; cr.alive = true; cr.hp = 100; cr.wounded = false; } }
         if (!any) return false;
      } else if (id === 'extinguisher') {
         if (!this.burning) return false;
         this.burning = false;
      }
      c.count--; c.cd = CONSUMABLES[id].cd;
      return true;
   }

   destroy() {
      if (!this.alive) return false;
      this.alive = false; this.hp = 0; this.speed = 0; this.wreckT = 0;
      this.input.throttle = 0; this.input.steer = 0; this.input.fire = false;
      return true;
   }
   _wreck(dt, T) {
      this.wreckT += dt;
      this.speed = approach(this.speed, 0, dt * 6);
      this.burning = this.wreckT < 25 && this.burning;
      if (Math.abs(this.speed) > 0.01) {
         this.pos.x -= Math.sin(this.yaw) * this.speed * dt; this.pos.z -= Math.cos(this.yaw) * this.speed * dt;
      }
      this.pos.x += this.push.x * dt; this.pos.z += this.push.z * dt;
      const pd = Math.exp(-dt * 6); this.push.x *= pd; this.push.z *= pd;
      this._terrainPose(T, dt);
      this._boundary(T);
      this.pose();
   }
}

// ---------------------------------------------------------------- tank vs tank
// Each hull = 2 circles along its axis. Mass-weighted separation, inelastic impulse on the
// closing speed; ram damage above 2.5 m/s, the heavier tank taking less.
const RAM_MIN = 2.5;
// parked / braking / dead tanks resist with their track friction: effectively heavier
const holdK = (t) => (!t.alive ? 4 : t.input.brake || !t.input.throttle ? 4 : 1);
export function collideTanks(tanks, world) {
   const n = tanks.length;
   for (let i = 0; i < n; i++) {
      const A = tanks[i];
      for (let j = i + 1; j < n; j++) {
         const B = tanks[j];
         const dx0 = B.pos.x - A.pos.x, dz0 = B.pos.z - A.pos.z, rr = A.radius + B.radius;
         if (dx0 * dx0 + dz0 * dz0 > rr * rr) continue;
         const fax = -Math.sin(A.yaw), faz = -Math.cos(A.yaw), fbx = -Math.sin(B.yaw), fbz = -Math.cos(B.yaw);
         const ra = A.halfW * 1.02, rb = B.halfW * 1.02;
         const oa = Math.max(0, A.halfLen - A.halfW), ob = Math.max(0, B.halfLen - B.halfW);
         let best = 0, nx = 0, nz = 0;
         for (let ka = -1; ka <= 1; ka += 1) for (let kb = -1; kb <= 1; kb += 1) {
            const ax = A.pos.x + fax * oa * ka, az = A.pos.z + faz * oa * ka;
            const bx = B.pos.x + fbx * ob * kb, bz = B.pos.z + fbz * ob * kb;
            const ddx = bx - ax, ddz = bz - az, d = Math.hypot(ddx, ddz), pen = ra + rb - d;
            if (pen > best) { best = pen; nx = d > 1e-6 ? ddx / d : 1; nz = d > 1e-6 ? ddz / d : 0; }
         }
         if (best <= 0) continue;
         // velocities (world)
         const vax = fax * A.speed + A.push.x, vaz = faz * A.speed + A.push.z;
         const vbx = fbx * B.speed + B.push.x, vbz = fbz * B.speed + B.push.z;
         const vn = (vax - vbx) * nx + (vaz - vbz) * nz;              // closing speed (>0 = approaching)
         const ima = 1 / (A.massKg * holdK(A)), imb = 1 / (B.massKg * holdK(B));
         const wa = ima / (ima + imb), wb = imb / (ima + imb);
         A.pos.x -= nx * best * wa; A.pos.z -= nz * best * wa;
         B.pos.x += nx * best * wb; B.pos.z += nz * best * wb;
         if (vn <= 0) continue;
         const J = 1.15 * vn / (ima + imb);                          // e = 0.15
         // split each impulse into forward (speed) and lateral (push) parts
         const dvA = -J * ima, dvB = J * imb;
         const aF = (nx * fax + nz * faz), bF = (nx * fbx + nz * fbz);
         A.speed += dvA * aF; A.push.x += dvA * (nx - aF * fax) * 0.6; A.push.z += dvA * (nz - aF * faz) * 0.6;
         B.speed += dvB * bF; B.push.x += dvB * (nx - bF * fbx) * 0.6; B.push.z += dvB * (nz - bF * fbz) * 0.6;
         if (vn > RAM_MIN && A.alive && B.alive) {
            const mu = 1 / (ima + imb), E = 0.5 * mu * (vn - RAM_MIN * 0.6) ** 2;   // J
            const base = E / 1800;
            // the faster/heavier "rammer" takes less: damage ∝ the other's mass share
            const ma = A.massKg, mb = B.massKg;
            const aRams = Math.abs(A.speed) >= Math.abs(B.speed);
            let dA = base * mb / (ma + mb), dB = base * ma / (ma + mb);
            if (aRams) dA *= 0.5; else dB *= 0.5;
            if (A.team === B.team) { dA *= 0.0; dB *= 0.0; }
            if (dA + dB >= 1) { _p.x = (A.pos.x + B.pos.x) / 2; _p.y = (A.pos.y + B.pos.y) / 2 + 1; _p.z = (A.pos.z + B.pos.z) / 2; world.onRam?.(A, B, Math.round(dA), Math.round(dB), _p); }
         }
      }
   }
}
