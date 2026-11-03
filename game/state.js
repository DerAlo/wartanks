// game/state.js — the World (pure sim; no DOM). See ARCHITECTURE.md "World".
//
//   new World({ mode:'standard'|'encounter'|'training', mapId, seed, playerCls, difficulty, teamSize?, roster?, countdown? })
//   world.update(dt)   fixed step (SIM_DT); main.js writes player.input / player.aimPoint before
//
// Events (world.events: ring of 256, each { type, seq, t, ... }; consumers keep their last seq):
//   shot     { srcId, pos, dir, ammo, cal }
//   pen      { srcId, dstId, dmg, pos, normal, plateId, plateName, part, effT, pen, angleDeg, ammo, cal, from }
//   ricochet / noPen  same fields (dmg 0)
//   he       same fields, dmg may be 0 (splash: what:'splash')
//   crit     { srcId, dstId, module | crew, state: 'damaged'|'destroyed'|'wounded'|'killed', pos }
//   track    { srcId, dstId, side:'L'|'R', pos }            (track destroyed)
//   fire     { srcId, dstId, pos }                          (target set on fire)
//   ammoRack { srcId, dstId, pos }                          (detonation, tank destroyed, turretOff)
//   kill     { srcId, dstId, pos, cause:'shell'|'ammoRack'|'fire'|'ram'|'drown' }
//   ram      { srcId, dstId, dmg, dmgSelf, pos }
//   spotted  { srcId, dstId }                               (first time a tank is lit)
//   cap      { team, capId, progress }                      (capture started / reset / finished)
//   treeFall / objectBreak { srcId, objId, pos }
//   phase    { phase }
// Effects (world.effects, transient, { kind, pos, dir?, t, life, size, cal }): 'ground' (dirt),
//   'splash' (water), 'explosion' (HE burst off-tank), 'sparks' (object hit), 'treeFall', 'objectBreak'.
import { WORLD, DIFFICULTY, TANKS } from './config.js';
import { makeRng, hashSeed } from './utils.js';
import { makeTerrain } from './terrain.js';
import { Tank, collideTanks } from './tank.js';
import { updateShells } from './ballistics.js';
import { updateSpotting } from './spotting.js';
import { MISSIONS } from './missions.js';
import { BotAI } from './ai.js';
import { calcRewards } from './progress.js';

const EV_N = 256;
const DIFF_KEYS = ['leicht', 'normal', 'schwer'];
const DIFF_ALIAS = { easy: 'leicht', medium: 'normal', hard: 'schwer' };
export function difficultyKey(d) {
   if (typeof d === 'number') return DIFF_KEYS[Math.max(0, Math.min(2, d | 0))];
   return DIFFICULTY[d] ? d : DIFF_ALIAS[d] || 'normal';
}

export class World {
   constructor(opts = {}) {
      this.opts = opts;
      this.mode = MISSIONS[opts.mode] ? opts.mode : 'standard';
      this.mission = MISSIONS[this.mode];
      this.mapId = this.mission.mapFor?.(opts) || opts.mapId || 'steppe';     // campaign ops fix map + seed
      this.seed = this.mission.seedFor?.(opts) ?? opts.seed ?? 1234;
      this.rng = makeRng(hashSeed(this.seed, 'world', this.mode));
      this.diffKey = difficultyKey(opts.difficulty ?? 1);
      this.diff = DIFFICULTY[this.diffKey];
      this.terrain = makeTerrain(this.seed, this.mapId);
      this.time = 0; this.phase = 'countdown';
      this.countdown = opts.countdown ?? this.mission.countdown ?? 10;
      this.timeLeft = this.mission.timeLimit ?? null;
      this.tanks = []; this.bots = []; this.player = null; this.ais = [];
      this.shells = []; this.effects = [];
      this.events = new Array(EV_N).fill(null); this.seq = 0;
      this.caps = []; this.result = null; this.infiniteAmmo = false;
      this._spotAcc = 0; this._byId = new Map();
      this.mission.setup(this, opts);
      this.stats = this.player?.stats ?? null;
      for (const t of this.tanks) {
         t.side = t === this.player ? 'player' : this.player && t.team === this.player.team ? 'ally' : 'enemy';
         if (t.bot && !t.noAI) { const ai = new BotAI(this, t); this.ais.push(ai); t.ai = ai; }
      }
      if (this.countdown <= 0) this.phase = 'playing';
      updateSpotting(this, 0);
   }

   // ---------------------------------------------------------------- setup helpers (missions.js)
   addTank(cls, team, o = {}) {
      const t = new Tank(TANKS[cls] || cls, { id: this.tanks.length + 1, ...o, team, terrain: this.terrain });
      this.tanks.push(t); this._byId.set(t.id, t);
      if (o.isPlayer) this.player = t; else this.bots.push(t);
      return t;
   }
   tankById(id) { return this._byId.get(id) || null; }
   enemiesOf(t) { return this.tanks.filter((o) => o.team !== t.team); }
   alliesOf(t) { return this.tanks.filter((o) => o.team === t.team && o !== t); }

   emit(type, fields) {
      const e = Object.assign({ type, seq: ++this.seq, t: this.time }, fields);
      this.events[this.seq % EV_N] = e;
      return e;
   }
   effect(kind, pos, extra) {
      const e = Object.assign({ kind, pos: { x: pos.x, y: pos.y, z: pos.z }, t: 0, life: 1.5, size: 1 }, extra);
      this.effects.push(e);
      return e;
   }

   // ---------------------------------------------------------------- step
   update(dt) {
      this.time += dt;
      const playing = this.phase === 'playing';
      if (this.phase === 'countdown') {
         this.countdown -= dt;
         if (this.countdown <= 0) { this.countdown = 0; this.phase = 'playing'; this.emit('phase', { phase: 'playing' }); }
      } else if (playing && this.timeLeft != null) {
         this.timeLeft = Math.max(0, this.timeLeft - dt);
         if (this.timeLeft <= 0) this.end(0, 'Zeit abgelaufen');
      }
      for (const ai of this.ais) ai.update(dt);
      if (this.phase === 'countdown') for (const t of this.tanks) { t.input.throttle = 0; t.input.steer = 0; t.input.fire = false; t.reload = Math.max(t.reload, 0.5); }
      for (const t of this.tanks) t.update(dt, this);
      collideTanks(this.tanks, this);
      updateShells(this, dt);
      this._spotAcc += dt;
      if (this._spotAcc >= WORLD.SPOT_DT) { updateSpotting(this, this._spotAcc); this._spotAcc = 0; }
      if (this.phase === 'playing') { this._caps(dt); this._checkEnd(); }
      this.mission.tick?.(this, dt);
      for (let i = this.effects.length - 1; i >= 0; i--) {
         const e = this.effects[i]; e.t += dt;
         if (e.t > e.life) { this.effects[i] = this.effects[this.effects.length - 1]; this.effects.pop(); }
      }
   }

   // ---------------------------------------------------------------- damage glue
   onFire(tank, round, pos, dir) {
      this.emit('shot', { srcId: tank.id, pos: { x: pos.x, y: pos.y, z: pos.z }, dir: { x: dir.x, y: dir.y, z: dir.z }, ammo: round.type, cal: round.cal });
   }

   onShellHit(shell, tank, res, point, what) {
      const src = this.tankById(shell.ownerId);
      if (!tank) {
         if (what === 'expire') return;
         const cal = shell.caliber;
         if (shell.ammo === 'HE') this.effect('explosion', point, { cal, size: cal / 75, life: 2 });
         else this.effect(what === 'water' ? 'splash' : what === 'object' ? 'sparks' : 'ground', point, { cal, size: cal / 75 });
         return;
      }
      if (!res || res.kind === 'miss') return;
      const kind = what === 'splash' ? 'he' : res.kind;
      const friendly = src && src.team === tank.team;
      let dmg = res.dmg || 0;
      if (src?.bot && tank.team === this.player?.team) dmg *= this.diff.botDmg ?? 1;
      if (friendly) dmg *= 0.5;
      if (!tank.alive) { this._ev(kind, src, tank, res, point, shell, 0, what, true); return; }   // wreck: effects only
      if (src && what !== 'splash') { src.stats.hits++; if (kind === 'pen') src.stats.pens++; if (kind === 'ricochet' || kind === 'noPen') src.stats.bounces++; }
      if (kind === 'ricochet' || kind === 'noPen' || (kind === 'he' && dmg <= 0)) tank.stats.blocked += shell.dmg;
      dmg = Math.round(Math.min(dmg, tank.hp));
      this._ev(kind, src, tank, res, point, shell, dmg, what);
      if (dmg > 0) this.damage(tank, dmg, src, 'shell');
      if (tank.alive && res.crits?.length && (kind === 'pen' || kind === 'he' || kind === 'noPen' || kind === 'ricochet')) this._crits(tank, src, res.crits, point, kind);
   }
   _ev(kind, src, tank, res, point, shell, dmg, what, wreck = false) {
      this.emit(kind, { srcId: src?.id ?? shell.ownerId, dstId: tank.id, dmg, pos: { x: point.x, y: point.y, z: point.z },
         normal: res.normal ? { x: res.normal.x, y: res.normal.y, z: res.normal.z } : null, plateId: res.plateId, plateName: res.plateName,
         part: res.part, side: res.side, t: res.t, effT: res.effT, pen: res.pen, angleDeg: res.angleDeg, overmatch: res.overmatch,
         ammo: shell.ammo, cal: shell.caliber, what, wreck, from: src ? { x: src.pos.x, y: src.pos.y, z: src.pos.z } : null });
   }

   _crits(tank, src, crits, point, kind) {
      const pos = { x: point.x, y: point.y, z: point.z }, srcId = src?.id ?? null;
      for (const c of crits) {
         if (!tank.alive) return;
         if (c.kind === 'crew') {
            const st = tank.damageCrew(c.id, c.dmg * (kind === 'pen' || kind === 'he' ? 1 : 0));
            if (st) { this.emit('crit', { srcId, dstId: tank.id, crew: c.id, state: st, pos }); if (src) src.stats.crits++; }
            continue;
         }
         // tracks take damage from any hit; internal modules only when the shell got inside / HE
         if (!(c.id === 'trackL' || c.id === 'trackR' || c.id === 'gun') && kind !== 'pen' && kind !== 'he') continue;
         const st = tank.damageModule(c.id, c.dmg);
         if (!st) continue;
         if (src) src.stats.crits++;
         if (c.id === 'trackL' || c.id === 'trackR') {
            if (st === 'destroyed') { tank.trackedBy = srcId; tank.trackedT = this.time; this.emit('track', { srcId, dstId: tank.id, side: c.id === 'trackL' ? 'L' : 'R', pos }); }
            else this.emit('crit', { srcId, dstId: tank.id, module: c.id, state: st, pos });
            continue;
         }
         this.emit('crit', { srcId, dstId: tank.id, module: c.id, state: st, pos });
         const r = this.rng();
         if (c.id === 'ammo' && st === 'destroyed' && r < 0.6) {
            this.emit('ammoRack', { srcId, dstId: tank.id, pos: { x: tank.pos.x, y: tank.pos.y + 1, z: tank.pos.z } });
            tank.turretOff = !!tank.cfg.turret;
            this.damage(tank, tank.hp, src, 'ammoRack');
            return;
         }
         if ((c.id === 'engine' && r < (st === 'destroyed' ? 0.25 : 0.1)) || (c.id === 'fuel' && r < (st === 'destroyed' ? 0.5 : 0.2))) {
            if (tank.ignite(srcId)) this.emit('fire', { srcId, dstId: tank.id, pos });
         }
      }
   }

   /** Apply hp damage with stats, assists, cap reset and kill. */
   damage(tank, dmg, src, cause) {
      if (!tank.alive || dmg <= 0) return;
      dmg = Math.min(dmg, tank.hp);
      tank.hp -= dmg; tank.lastDamaged = this.time; tank.lastHitBy = src?.id ?? null;
      tank.stats.received += dmg;
      tank.capPts = 0;                                     // damage resets capture points
      if (src && src.team !== tank.team) {
         src.stats.dmg += dmg;
         const sp = this.tankById(tank.spotterId);
         if (sp && sp !== src && sp.team === src.team) sp.stats.assist += dmg;
         const tr = this.tankById(tank.trackedBy);
         if (tr && tr !== src && tr !== sp && tr.team === src.team && tank.immobile) tr.stats.assist += dmg;
      }
      if (tank.hp <= 0.5) this.kill(tank, src, cause);
   }
   kill(tank, src, cause) {
      if (!tank.destroy()) return;
      if (src && src.team !== tank.team) src.stats.kills++;
      this.emit('kill', { srcId: src?.id ?? null, dstId: tank.id, pos: { x: tank.pos.x, y: tank.pos.y, z: tank.pos.z }, cause });
      if (cause === 'ammoRack' || this.rng() < 0.4) tank.burning = true;
   }
   onBurn(tank, dmg) { this.damage(tank, dmg, this.tankById(tank.fireSrc), 'fire'); }
   onDrown(tank) { this.kill(tank, this.tankById(tank.lastHitBy), 'drown'); }
   onRam(a, b, dmgA, dmgB, p) {
      const pos = { x: p.x, y: p.y, z: p.z };
      this.emit('ram', { srcId: a.id, dstId: b.id, dmg: dmgB, dmgSelf: dmgA, pos });
      if (dmgB > 0) { a.stats.ram += Math.min(dmgB, b.hp); this.damage(b, dmgB, a, 'ram'); }
      if (dmgA > 0) this.damage(a, dmgA, b, 'ram');
   }
   onTankEffect(kind, tank, obj) {
      if (kind !== 'treeFall' && kind !== 'objectBreak') return;
      this.effect(kind, obj, { objId: obj.id, life: 2 });
      this.emit(kind, { srcId: tank.id, objId: obj.id, pos: { x: obj.x, y: obj.y ?? tank.pos.y, z: obj.z } });
   }
   onSpotted(t, by) { this.emit('spotted', { srcId: by.id, dstId: t.id }); }

   // ---------------------------------------------------------------- bases & result
   _caps(dt) {
      for (const c of this.caps) {
         let n1 = 0, n2 = 0;
         for (const t of this.tanks) {
            const inside = t.alive && Math.hypot(t.pos.x - c.pos.x, t.pos.z - c.pos.z) < c.r;
            if (!inside) { if (t.capId === c.id) { t.capPts = 0; t.capId = null; } continue; }
            t.capId = c.id;
            if (t.team === 1) n1++; else n2++;
         }
         // who caps: the team that is not the owner; neutral base: the only team present
         let team = null, n = 0;
         if (c.team === 1) { team = 2; n = n2; } else if (c.team === 2) { team = 1; n = n1; }
         else if (n1 && !n2) { team = 1; n = n1; } else if (n2 && !n1) { team = 2; n = n2; }
         const before = c.progress;
         let sum = 0;
         const rate = n ? Math.min(1, 3 / n) * (c.rate ?? 1) : 0;
         for (const t of this.tanks) {
            if (t.capId !== c.id) continue;
            if (t.team === team && !(c.team == null && n1 && n2)) { t.capPts = (t.capPts || 0) + rate * dt; sum += t.capPts; }
            else if (t.team !== team) { /* defender: nothing */ }
         }
         c.progress = Math.min(100, sum);
         c.capper = c.progress > 0 ? team : null;
         c.n = n;
         if (before === 0 && c.progress > 0) this.emit('cap', { team, capId: c.id, progress: c.progress, state: 'start' });
         else if (before > 0 && c.progress === 0) this.emit('cap', { team: c.lastCapper, capId: c.id, progress: 0, state: 'reset' });
         if (c.progress > 0) c.lastCapper = team;
         if (c.progress >= 100) { this.emit('cap', { team, capId: c.id, progress: 100, state: 'done' }); this.end(team, 'Basis erobert'); return; }
      }
   }
   _checkEnd() {
      if (this.mission.noEnd) return;
      let a1 = 0, a2 = 0;
      for (const t of this.tanks) if (t.alive) { if (t.team === 1) a1++; else a2++; }
      if (!a1 && !a2) this.end(0, 'Alle Panzer zerstört');
      else if (!a2) this.end(1, 'Alle Gegner zerstört');
      else if (!a1) this.end(2, 'Alle Gegner zerstört');
   }
   /** winner: 1 | 2 | 0 (draw) */
   end(winner, reason) {
      if (this.phase !== 'playing') return;
      const my = this.player?.team ?? 1;
      const outcome = winner === 0 ? 'draw' : winner === my ? 'win' : 'loss';
      if (reason === 'Alle Gegner zerstört' && outcome === 'loss') reason = 'Eigenes Team vernichtet';
      if (reason === 'Basis erobert' && outcome === 'loss') reason = this.mode === 'encounter' ? 'Gegner hat die Basis erobert' : 'Eigene Basis verloren';
      this.phase = outcome === 'win' ? 'won' : outcome === 'loss' ? 'lost' : 'draw';
      this.winner = winner;
      this.result = { outcome, winner, reason, time: this.time, xp: 0, credits: 0 };
      try { Object.assign(this.result, calcRewards(this)); } catch (e) { /* rewards are optional */ }
      for (const t of this.tanks) t.input.fire = false;
      this.emit('phase', { phase: this.phase, outcome, reason });
   }
}
