// Campaign ("Feldzug"): historical operations as scripted missions. Pure sim, deterministic
// (world.rng only), no DOM: all mission logic lives in the World so a co-op host can run it.
//
//   OPS[id] = { id, name, place, date, nation, map, seed, tanks:[cls...], brief:[...], goals:[...],
//               tip, allies?, script(S) }      OP_LIST = ordered ids
//   world.campaign = { op, phase, objectives:[{ id, text, state, bonus, hidden, count, need }],
//                      log:[{ t, text, kind }], markers:[{ id, x, z, r, label, kind }], timer, fog }
//   world.result.campaign = { op, stars, medal, objectives }
//
// Script runtime `S` (passed to op.script, see class Script): objectives (obj/done/fail/add),
// radio, markers/goals, spawns of tanks and emplacements with bot orders, triggers (when / at /
// every), phases, win / lose. Player death loses unless the op says otherwise. With
// playerCls null (headless tests) the player's tank is driven by a bot that follows S.goal().
import { TANKS } from './config.js';
import { BotAI } from './ai.js';

const TICK = 0.25;
const cfgSite = (cls) => !!TANKS[cls]?.site;

export class Script {
   constructor(world, op, opts) {
      this.w = world; this.op = op; this.T = world.terrain;
      this.triggers = []; this.tags = new Map(); this.acc = 0; this.started = false;
      this.c = world.campaign = { op, phase: 'start', objectives: [], log: [], markers: [], timer: null, fog: op.fog || 0 };
      this.autopilot = false;
   }
   get time() { return this.w.time; }
   get player() { return this.w.player; }
   rng() { return this.w.rng(); }

   // ------------------------------------------------------------ objectives / messages
   obj(id, text, o = {}) {
      const ob = { id, text, state: 'active', bonus: !!o.bonus, hidden: !!o.hidden, count: o.need ? 0 : undefined, need: o.need };
      this.c.objectives.push(ob);
      if (!ob.hidden && this.started) this.w.emit('objective', { id, state: 'active', text });
      return ob;
   }
   get(id) { return this.c.objectives.find((o) => o.id === id); }
   show(id) { const o = this.get(id); if (o && o.hidden) { o.hidden = false; this.w.emit('objective', { id, state: o.state, text: o.text }); } }
   set(id, state) {
      const o = this.get(id); if (!o || o.state !== 'active') return false;
      o.state = state; o.hidden = false;
      this.w.emit('objective', { id, state, text: o.text });
      return true;
   }
   done(id) { return this.set(id, 'done'); }
   fail(id) { return this.set(id, 'failed'); }
   isDone(id) { return this.get(id)?.state === 'done'; }
   progress(id, n) { const o = this.get(id); if (o && o.state === 'active') { o.count = Math.min(n, o.need); if (o.count >= o.need) this.done(id); } }
   radio(text, kind = 'radio') { this.c.log.push({ t: this.w.time, text, kind }); this.w.emit('radio', { text, kind }); }
   phase(p) { this.c.phase = p; }
   timer(label, secs) { this.c.timer = label ? { label, left: secs } : null; }
   /** Mission timer that calls fn when it runs out. Another S.timer()/countdown() replaces (cancels) it;
    *  the returned object can be lengthened (`tm.left += 60`) or relabelled (`tm.label = ...`). */
   countdown(label, secs, fn) {
      this.timer(label, secs); const tm = this.c.timer;
      this.when((S) => S.c.timer !== tm || tm.left <= 0, (S) => { if (S.c.timer === tm) { S.timer(null); fn?.(S); } });
      return tm;
   }
   /** Rewrite an objective's text when the plan changes mid-mission (HUD shows it as a new order). */
   retext(id, text) { const o = this.get(id); if (!o) return; o.text = text; if (!o.hidden && this.started) this.w.emit('objective', { id, state: o.state, text }); }
   /** Mission fog / darkness 0..1: spotting range shrinks by up to 62 % (spotting.js), the client
    *  re-fogs the scene whenever it changes; color tints it (night: dark blue-grey). */
   fog(amount, color) { this.c.fog = Math.round(Math.max(0, Math.min(1, amount)) * 100) / 100; if (color != null) this.c.fogColor = color; }
   /** Fade the fog to `amount` over `secs` (dawn, smoke drifting off); fn when done. */
   fadeFog(amount, secs, fn) {
      const f0 = this.c.fog, t0 = this.w.time;
      const tr = this.when(() => true, (S) => { const k = Math.min(1, (S.time - t0) / secs); S.fog(f0 + (amount - f0) * k); if (k >= 1) { tr.dead = true; fn?.(S); } }, { repeat: true });
   }

   // ------------------------------------------------------------ markers / player guidance
   mark(id, x, z, label, kind = 'goal', r = 0) {
      this.unmark(id); this.c.markers.push({ id, x, z, r, label, kind });
   }
   unmark(id) { const i = this.c.markers.findIndex((m) => m.id === id); if (i >= 0) this.c.markers.splice(i, 1); }
   /** Point the player at (x, z): a marker, and the order for the autopilot bot in headless runs. */
   goal(x, z, label, r = 0) {
      this.mark('goal', x, z, label, 'goal', r);
      if (this.autopilot && this.player) this.order([this.player], { kind: 'advance', x, z });
   }

   /** Lead the player to the remaining members of `tag`, nearest first: the goal sits short of
    *  the target (its rough position, as a scout report would give it) until the group is dead. */
   hunt(tag, label, onDone) { this._hunt = { tag, label, onDone, t: -1e9, cur: null }; }
   _huntTick() {
      const h = this._hunt, p = this.player; if (!h || !p) return;
      if (!this.alive(h.tag)) { this._hunt = null; h.onDone?.(this); return; }
      const g = this.c.markers.find((m) => m.id === 'goal');
      const near = g && Math.hypot(p.pos.x - g.x, p.pos.z - g.z) < 25;
      // no headway on this one for 45 s (cliff, wood): try the next and come back later
      const dCur = h.cur?.alive ? Math.hypot(h.cur.pos.x - p.pos.x, h.cur.pos.z - p.pos.z) : 0;
      if (h.cur?.alive && dCur < (h.bestD ?? Infinity) - 8) { h.bestD = dCur; h.prog = this.w.time; }
      if (h.cur?.alive && this.w.time - (h.prog ?? this.w.time) > 45) { (h.skip ??= new Map()).set(h.cur, this.w.time + 90); h.cur = null; }
      if (h.cur?.alive && !near && this.w.time - h.t < 20) return;
      let best = null, bd = Infinity;
      for (const t of this.group(h.tag)) {
         if (!t.alive) continue;
         const d = Math.hypot(t.pos.x - p.pos.x, t.pos.z - p.pos.z) + ((h.skip?.get(t) ?? 0) > this.w.time ? 5000 : 0);
         if (d < bd) { bd = d; best = t; }
      }
      bd = Math.hypot(best.pos.x - p.pos.x, best.pos.z - p.pos.z);
      if (best !== h.cur) { h.bestD = bd; h.prog = this.w.time; }
      if (best === h.cur && h.cur?.alive && this.w.time - h.t < 20 && !near) return;
      // reached the report point and still nothing: close in further (woods, crests block the view)
      // re-picking a target (after a skip, or the only one left) keeps closing in instead of starting at 35 m again
      const offs = (h.offs ??= new Map()); h.off = offs.has(best) ? Math.max(6, offs.get(best) - 14) : 35; offs.set(best, h.off);
      h.cur = best; h.t = this.w.time;
      // a bunker is only open from behind (door) or square through the slit: lead round to its rear
      // quarter, outside the embrasure's arc
      if (best.cfg.site === 'bunker') {
         const fx = -Math.sin(best.yaw), fz = -Math.cos(best.yaw), s = (p.pos.x - best.pos.x) * fz - (p.pos.z - best.pos.z) * fx > 0 ? 1 : -1;
         const o = Math.max(14, h.off * 0.8);
         this.goal(best.pos.x - fx * o * 0.8 + fz * s * o * 0.6, best.pos.z - fz * o * 0.8 - fx * s * o * 0.6, h.label, 12);
         return;
      }
      const k = Math.min(1, h.off / Math.max(1, bd));
      this.goal(best.pos.x + (p.pos.x - best.pos.x) * k, best.pos.z + (p.pos.z - best.pos.z) * k, h.label, 30);
   }

   // ------------------------------------------------------------ units
   /** Spawn a tank or emplacement (cls in TANKS) for team 1|2 at x, z. o: { yaw, name, tag, order } */
   spawn(cls, team, x, z, o = {}) {
      const w = this.w, T = this.T;
      x = Math.max(-T.half + 15, Math.min(T.half - 15, x)); z = Math.max(-T.half + 15, Math.min(T.half - 15, z));
      // emplacements face the attacker's start (or o.face) unless a yaw is given
      const f = o.face || (cfgSite(cls) && this.op.start0);
      const yaw = o.yaw ?? (f ? Math.atan2(-(f[0] - x), -(f[1] - z)) : team === 1 ? 0 : Math.PI);
      const cfg = TANKS[cls];
      if (cfg.site === 'pak' && !o.exact) {
         [x, z] = this._siteSpot(x, z);
         for (const ob of [...T.objectsNear(x, z, 12)]) if (ob.kind === 'tree') T.destroyObject(ob, ob.x - x, ob.z - z);   // the crew cleared its field of fire
      }
      const t = w.addTank(cls, team, { x, z, yaw, name: o.name || cfg.name, isPlayer: !!o.isPlayer });
      t.placeOn?.(T);
      t.tag = o.tag || null; if (o.aiErr) t.aiErr = o.aiErr; if (o.viewMul) t.viewMul = o.viewMul;
      if (o.noAI || o.inert) t.noAI = true;           // inert: abandoned, no crew; AIs of both sides ignore it (ai.js)
      if (o.inert) t.inert = true;
      if (o.ammo) for (const k in o.ammo) if (k in t.ammoCount) t.ammoCount[k] = o.ammo[k];   // e.g. { APCR: 0 }: no tungsten in 1941
      if (o.tag) { if (!this.tags.has(o.tag)) this.tags.set(o.tag, []); this.tags.get(o.tag).push(t); }
      if (w.ais && !o.isPlayer) {                     // after construction World does not wire these
         t.side = w.player && t.team === w.player.team ? 'ally' : 'enemy';
         if (!t.noAI && this.started) { const ai = new BotAI(w, t); w.ais.push(ai); t.ai = ai; }
      }
      if (o.order) (t._order = o.order);
      if (t.ai && t._order) this.order([t], t._order);
      if (t.ai) this._tuneAI(t);
      return t;
   }
   /** A gun crew digs in on high, dry, open ground within 15 m of the planned spot (never in a
    *  hollow it cannot see out of, in water, a trench, a house or deep in a wood). */
   _siteSpot(x, z) {
      const T = this.T; let best = [x, z], bh = -Infinity;
      for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
         const px = x + i * 5, pz = z + j * 5, h = T.heightAt(px, pz);
         if (T.water != null && h < T.water + 0.8) continue;
         if ((T.trenchDist?.(px, pz) ?? Infinity) < 4 || T.objectsNear(px, pz, 4).length) continue;
         let trees = 0; for (const ob of T.objectsNear(px, pz, 14)) if (ob.kind === 'tree') trees++;   // field of fire
         const v = h - Math.hypot(i, j) * 0.15 - trees * 1.2;
         if (v > bh) { bh = v; best = [px, pz]; }
      }
      return best;
   }
   /** Hull-down spot: the highest ground within r of (x, z), then back off it (away from the
    *  enemy direction ex, ez) until the crest stands ~1.4 m above the hull's ground. */
   hullDown(x, z, r, ex, ez) {
      const T = this.T; let cx = x, cz = z, ch = -Infinity;
      for (let i = -r; i <= r; i += 4) for (let j = -r; j <= r; j += 4) {
         if (i * i + j * j > r * r) continue;
         const h = T.heightAt(x + i, z + j); if (T.water != null && h < T.water + 0.5) continue;
         if (h > ch) { ch = h; cx = x + i; cz = z + j; }
      }
      const L = Math.hypot(ex - cx, ez - cz) || 1, dx = (cx - ex) / L, dz = (cz - ez) / L;
      for (let s = 3; s <= 30; s += 1) if (T.heightAt(cx + dx * s, cz + dz * s) < ch - 1.4) return [cx + dx * s, cz + dz * s];
      return [cx + dx * 8, cz + dz * 8];
   }
   /** Field workshop between phases: the player's tank gets `frac` of its HP back, modules and
    *  crew patched, consumables and some ammunition restocked. */
   refit(frac = 0.4, text = 'Instandsetzungstrupp ist bei euch: Schäden notdürftig behoben, Munition aufgefüllt.') {
      const p = this.player; if (!p?.alive) return;
      p.hp = Math.min(p.maxHP, p.hp + p.maxHP * frac);
      for (const k in p.modules) { const m = p.modules[k]; m.state = 'ok'; m.hp = m.max; m.repairT = 0; }
      for (const k in p.crew) { const c = p.crew[k]; c.alive = true; c.hp = 100; c.wounded = false; }
      for (const k in p.consumables) p.consumables[k].count = Math.max(1, p.consumables[k].count);
      const load = p.cfg.gun.load || {};
      for (const k in p.ammoCount) p.ammoCount[k] = Math.max(p.ammoCount[k], Math.ceil((load[k] ?? 0) * 0.6));
      if (text) this.radio(text, 'info');
   }
   _tuneAI(t) {            // emplacement crews / green crews aim worse (cfg.aiErr, spawn o.aiErr)
      const k = t.aiErr ?? t.cfg.aiErr;
      if (t.ai && k && !t.ai._tuned) { t.ai._tuned = true; t.ai.D = { ...t.ai.D, err: t.ai.D.err * k, react: t.ai.D.react * Math.sqrt(k) }; }
   }
   group(tag) { return Array.isArray(tag) ? tag.flatMap((g) => this.group(g)) : this.tags.get(tag) || []; }
   alive(tag) { let n = 0; for (const t of this.group(tag)) if (t.alive) n++; return n; }
   dead(tag) { return this.group(tag).length - this.alive(tag); }
   /** order = { kind:'hold'|'advance'|'route'|'ambush', x, z, pts:[[x,z]...], r (ambush trigger) } */
   order(tanks, order) {
      for (const t of tanks) {
         t._order = order;
         if (!t.ai) continue;
         t.ai.order = { ...order, i: 0, sprung: false };
         t.ai.flankT = 0; t.ai.hunting = false;
         t.ai.setDest(t.ai.chooseDest());
      }
   }
   /** tanks of a team (or a tag) inside the circle */
   countIn(who, x, z, r) {
      const list = typeof who === 'string' ? this.group(who) : this.w.tanks.filter((t) => t.team === who && !t.cfg.site);
      let n = 0; for (const t of list) if (t.alive && Math.hypot(t.pos.x - x, t.pos.z - z) < r) n++;
      return n;
   }
   enemyTanksAlive() { return this.w.tanks.filter((t) => t.team === 2 && t.alive && !t.cfg.site).length; }
   /** How many of `who` ('player' | team number | tag) are alive inside the circle. */
   inZone(who, x, z, r) {
      if (who === 'player') { const p = this.player; return p?.alive && Math.hypot(p.pos.x - x, p.pos.z - z) < r ? 1 : 0; }
      return this.countIn(who, x, z, r);
   }
   /** fn once `o.who` (default the player) has at least `o.n` (1) units inside the circle. */
   zone(x, z, r, fn, o = {}) { return this.when((S) => S.inZone(o.who ?? 'player', x, z, r) >= (o.n ?? 1), fn); }
   /** Hold a circle for `secs`: the mission timer runs while `o.who` (player) is inside and no tank of
    *  `o.contest` (team 2; false = never contested) is; fn when held. Returns { held, stop() }. */
   holdZone(label, x, z, r, secs, fn, o = {}) {
      const h = { held: 0, done: false };
      const tr = this.when(() => true, (S) => {
         const inside = S.inZone(o.who ?? 'player', x, z, r) > 0, contested = o.contest !== false && S.countIn(o.contest ?? 2, x, z, r) > 0;
         if (inside && !contested) h.held += TICK;
         S.timer(label + (contested ? ' – umkämpft' : inside ? '' : ' – Zone verlassen'), Math.max(0, secs - h.held));
         if (h.held >= secs) { h.stop(); fn?.(S); }
      }, { repeat: true });
      h.stop = () => { if (h.done) return; h.done = true; tr.dead = true; this.timer(null); };
      return h;
   }
   /** Artillery / fighter-bomber strike: `o.n` (6) impacts over `o.secs` (6) inside the circle (or round a
    *  random live member of `o.tag` each time, Jabos picking tanks). Each impact hurts tanks within 9 m
    *  (only `o.team` if given; emplacements too) by up to `o.dmg` (180); 'explosion' effects for the client. */
   strike(x, z, r, o = {}) {
      const n = o.n ?? 6, secs = o.secs ?? 6, dmg = o.dmg ?? 180;
      for (let i = 0; i < n; i++) this.after(secs * i / n, (S) => {
         let cx = x, cz = z;
         if (o.tag) { const live = S.group(o.tag).filter((t) => t.alive); if (!live.length) return; const t = live[(S.rng() * live.length) | 0]; cx = t.pos.x; cz = t.pos.z; }
         const a = S.rng() * Math.PI * 2, d = Math.sqrt(S.rng()) * r, px = cx + Math.cos(a) * d, pz = cz + Math.sin(a) * d;
         S.w.effect('explosion', { x: px, y: S.T.heightAt(px, pz), z: pz }, { cal: 250, size: 3, life: 2.5 });
         for (const t of S.w.tanks) {
            if (!t.alive || t.inert || (o.team != null && t.team !== o.team)) continue;
            const dd = Math.hypot(t.pos.x - px, t.pos.z - pz); if (dd < 9) { S.w.damage(t, dmg * (1 - dd / 12), null, 'strike'); t.lastDamaged = S.w.time; }
         }
      });
   }
   /** Hand tanks to another team (a captured vehicle, a unit changing sides); AI targeting follows team. */
   defect(tanks, team) {
      for (const t of tanks) { t.team = team; t.side = this.w.player && t.team === this.w.player.team ? 'ally' : 'enemy'; t.ai?.reset?.(); }
   }
   /** A crew climbs into a vehicle spawned with { noAI } / { inert }: it gets a BotAI (and o.order). */
   crewUp(t, o = {}) {
      t.inert = false; t.noAI = false;
      if (o.aiErr) t.aiErr = o.aiErr;
      if (!t.ai && this.w.ais) { const ai = new BotAI(this.w, t); this.w.ais.push(ai); t.ai = ai; }
      this._tuneAI(t);
      if (o.order) this.order([t], o.order);
   }

   // ------------------------------------------------------------ triggers
   /** fn(S) runs once when cond(S) becomes true (or every time with { repeat: true }) */
   when(cond, fn, o = {}) { const tr = { cond, fn, repeat: !!o.repeat, dead: false }; this.triggers.push(tr); return tr; }   // tr.dead = true cancels
   at(t, fn) { return this.when(() => this.w.time >= t, fn); }
   after(dt, fn) { const t0 = this.w.time; return this.when(() => this.w.time >= t0 + dt, fn); }
   every(dt, fn) { let next = this.w.time + dt; this.when(() => { if (this.w.time < next) return false; next += dt; return true; }, fn, { repeat: true }); }

   win(reason) { this._end(1, reason); }
   lose(reason) { this._end(2, reason); }
   _end(winner, reason) {
      if (this.w.phase !== 'playing') return;
      for (const o of this.c.objectives) if (o.state === 'active' && !o.bonus && winner === 2) o.state = 'failed';
      this.w.end(winner, reason);   // World.end calls _result before it emits 'phase'
   }
   _result(r) {
      if (r.outcome === 'loss') for (const o of this.c.objectives) if (o.state === 'active' && !o.bonus) o.state = 'failed';
      const bonus = this.c.objectives.filter((o) => o.bonus), bDone = bonus.filter((o) => o.state === 'done').length;
      let stars = 0;
      if (r.outcome === 'win') {
         stars = 1 + Math.min(2, bonus.length ? Math.round(2 * bDone / bonus.length) : 2);
         if (this.player && this.player.hp < this.player.maxHP * 0.25 && stars > 1) stars--;
      }
      r.campaign = { op: this.op.id, stars, medal: ['', 'bronze', 'silber', 'gold'][stars] || null, objectives: this.c.objectives.map((o) => ({ ...o })) };
   }

   tick(dt) {
      const w = this.w;
      if (this.c.timer) this.c.timer.left = Math.max(0, this.c.timer.left - (w.phase === 'playing' ? dt : 0));
      if (w.phase !== 'playing') return;
      if (!this.started) this._start();
      // route orders advance waypoint by waypoint; ambushes spring on proximity or damage
      for (const t of w.tanks) {
         const o = t.ai?.order; if (!o || !t.alive) continue;
         if (o.kind === 'route' && (o.i || 0) < o.pts.length - 1) {
            const p = o.pts[o.i || 0];
            const d = Math.hypot(t.pos.x - (p.x ?? p[0]), t.pos.z - (p.z ?? p[1]));
            // reached, or hung up close to it (a crest, a house) for 10 s without getting nearer: next point
            if (!(d > (o._bd ?? Infinity) - 2)) { o._bd = d; o._bt = w.time; }
            if (d < 22 || (d < 50 && w.time - o._bt > 10)) { o.i = (o.i || 0) + 1; o._bd = Infinity; t.ai.setDest(t.ai.chooseDest()); }
         } else if (o.kind === 'ambush' && !o.sprung) {
            const r = o.r ?? 180;
            if (t.lastDamaged > 0 || w.tanks.some((e) => e.alive && e.team !== t.team && e.spotted && Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z) < r)) o.sprung = true;
         }
      }
      this.acc += dt; if (this.acc < TICK) return; this.acc = 0;
      this._huntTick();
      for (const tr of this.triggers) {
         if (tr.dead) continue;
         if (tr.cond(this)) { if (!tr.repeat) tr.dead = true; tr.fn(this); if (w.phase !== 'playing') return; }
      }
      if (this.triggers.length > 64) this.triggers = this.triggers.filter((t) => !t.dead);
      if (w.player && !w.player.alive && !this.op.playerMayDie) this.lose('Eigener Panzer zerstört');
   }
   _start() {
      this.started = true;
      // headless autopilot plays like a careful human: good aim at weak spots, fights from cover
      if (this._pilot && this.player?.ai) { const a = this.player.ai; a.careful = true; a.D = { ...a.D, err: 0.3, react: 0.5, aimWait: 2.5, convK: 1.2, smart: 1, angle: true }; }
      // AIs for everything spawned during setup exist now (World wired them); re-issue orders
      for (const t of this.w.tanks) { if (t.ai && t._order) this.order([t], t._order); if (t.ai) this._tuneAI(t); }
      for (const o of this.c.objectives) if (!o.hidden) this.w.emit('objective', { id: o.id, state: 'active', text: o.text });
      this.op.start?.(this);
   }
}

// ------------------------------------------------------------------ World glue (missions.js)
export function setupCampaign(world, opts) {
   const op = OPS[opts.op] || OPS[OP_LIST[0]];
   const S = world.script = new Script(world, op, opts);
   const cls = opts.playerCls && op.tanks.includes(opts.playerCls) ? opts.playerCls : opts.playerCls === null ? op.tanks[0] : (opts.playerCls || op.tanks[0]);
   const sp = op.start0;
   const p = S.spawn(cls, 1, sp[0], sp[1], { yaw: sp[2] ?? 0, name: opts.playerName || 'Du', isPlayer: opts.playerCls !== null, tag: 'player' });
   if (opts.playerCls === null) { S.autopilot = true; world.player = p; p.isPlayer = false; S._pilot = true; }
   op.script(S);
   return S;
}

const deg = Math.PI / 180;
const line = (S, x0, z0, x1, z1, rows = 3) => S.T.addTeethLine?.(x0, z0, x1, z1, { rows });

// ------------------------------------------------------------------ operations
export const OPS = {
   westwall: {
      id: 'westwall', name: 'Durchbruch am Westwall', place: 'Übach-Palenberg bei Aachen', date: '2. Oktober 1944', nation: 'US',
      map: 'steppe', seed: 1944, tanks: ['m4a3e8', 'm26'], start0: [0, 400, 0],
      brief: [
         'Seit Mitte September stehen die Amerikaner vor dem Westwall. Nördlich von Aachen soll das XIX. Korps über die Wurm setzen und die Bunkerlinie aufbrechen.',
         'Vor uns: eine Höckerlinie, dahinter Regelbau-Bunker mit Pak in der Scharte. Beton schluckt jede Granate – zielt auf die Schießscharten oder umgeht sie und trefft die Rückseite.',
         'Die 2. Panzerdivision rollt mit ihren Shermans durch die Bresche, sobald die Pioniere die Höcker gesprengt haben. Rechnet mit einem Gegenstoß deutscher Panzer.',
      ],
      goals: ['Durch die Lücke in der Höckerlinie vorstoßen', 'Beide Bunker ausschalten', 'PaK-Stellungen zerstören', 'Gegenangriff abwehren'],
      tip: 'Sprenggranaten (HE) gegen PaK-Bedienungen, panzerbrechend durch die Schießscharte.',
      script(S) {
         const zL = 120;                                    // teeth line
         line(S, -330, zL, -25, zL, 4); line(S, 25, zL, 330, zL, 4);
         S.T.addObject?.({ kind: 'wire', x: -60, z: zL + 25, yaw: 0 }); S.T.addObject?.({ kind: 'wire', x: 60, z: zL + 25, yaw: 0 });
         S.spawn('bunker', 2, -90, 40, { tag: 'bunker', name: 'Bunker 1' });
         S.spawn('bunker', 2, 95, 30, { tag: 'bunker', name: 'Bunker 2' });
         // Westwall garrisons in autumn 1944 were fortress battalions of older reservists: slow, poor gunnery
         for (const [x, z] of [[-200, 10], [190, 0], [10, -60]]) S.spawn('pak40', 2, x, z, { tag: 'pak', aiErr: 2.5, order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-60, 420], [60, 420], [120, 430]]) S.spawn('m4a3e8', 1, x, z, { tag: 'allies', name: 'Sherman', order: { kind: 'advance', x: x * 0.3, z: zL + 40 } });
         S.obj('gap', 'Durch die Lücke in der Höckerlinie vorstoßen');
         S.obj('bunker', 'Bunker ausschalten', { need: 2 });
         S.obj('pak', 'PaK-Stellungen zerstören', { need: 3 });
         S.obj('counter', 'Gegenangriff abwehren', { hidden: true });
         S.obj('b_allies', 'Mindestens drei Shermans überleben', { bonus: true });
         S.obj('b_time', 'Westwall in 9 Minuten durchbrechen', { bonus: true });
         S.goal(0, zL, 'Lücke');
         this.start = (S) => S.radio('Hier Kampfgruppe B: Die Pioniere haben eine Lücke in die Höcker gesprengt. Vorwärts, Marsch!');
         S.when((S) => S.w.tanks.some((t) => t.team === 1 && t.alive && t.pos.z < zL - 12), (S) => {
            S.done('gap'); S.radio('Wir sind durch die Höcker. Bunker vor uns – auf die Scharten zielen!');
            S.goal(0, 35, 'Bunkerlinie');
            S.after(20, (S) => S.hunt(['pak', 'bunker'], 'Feindstellung'));
            // the Shermans fan out, one against each flank gun, so the PaKs' fire is split
            S.group('allies').forEach((t, i) => S.order([t], { kind: 'route', pts: [[[-120, 120, 0][i], 60], [[-190, 180, 10][i], [10, 0, -50][i]]] }));
         });
         S.when((S) => true, (S) => { S.progress('bunker', S.dead('bunker')); S.progress('pak', S.dead('pak')); }, { repeat: true });
         S.when((S) => S.isDone('bunker') && S.isDone('pak'), (S) => {
            if (S.time < 540) S.done('b_time'); else S.fail('b_time');
            S.show('counter'); S.phase('counter'); S.refit(0.5);
            // a breather: the workshop patches the tank, the player takes a marked hull-down spot on
            // the bunker hill and two more Shermans of the 2nd Armored come up through the gap
            const [hx, hz] = S.hullDown(0, 0, 30, 0, -400);
            S.mark('hd', hx, hz, 'Stellung (hull-down)', 'area', 10); S.goal(hx, hz, 'Stellung hinter der Kuppe', 8);
            S.radio('Aufklärung meldet Panzer IV aus Nord. Geht hinter der Kuppe in Stellung – nur der Turm schaut drüber!', 'warn');
            for (const [x, z] of [[-20, 300], [25, 310]]) S.spawn('m4a3e8', 1, x, z, { tag: 'allies', name: 'Sherman (2. PD)', order: { kind: 'route', pts: [[0, zL + 30], [x * 2, 25]] } });
            S.order(S.group('allies').filter((t) => t.alive), { kind: 'advance', x: 0, z: 30 });
            // the counter-attack comes in three echelons, not as one fist
            [[160, -420, 40], [-150, -430, 70], [200, -440, 100]].forEach(([x, z, dt], i) => S.after(dt, (S) => {
               S.spawn('pz4h', 2, x, z, { tag: 'counter', name: 'Panzer IV', order: { kind: 'route', pts: [[x * 0.6, -200], [x * 0.3, -40], [0, 40]] } });
               S.radio(['Erster Panzer IV über dem Kamm im Nordosten!', 'Zweiter Panzer IV von links!', 'Noch einer aus Nordost – haltet die Stellung!'][i], 'warn');
            }));
         });
         S.when((S) => S.c.phase === 'counter' && S.group('counter').length === 3 && S.alive('counter') === 0, (S) => {
            S.done('counter');
            if (S.alive('allies') >= 3) S.done('b_allies'); else S.fail('b_allies');
            S.radio('Gegenangriff abgeschlagen. Die Bresche ist offen – gut gemacht!');
            S.win('Westwall durchbrochen');
         });
      },
   },

   seelow: {
      id: 'seelow', name: 'Die Seelower Höhen', place: 'Oderbruch, Seelower Höhen', date: '17. April 1945', nation: 'SU',
      map: 'waldhuegel', seed: 4517, tanks: ['is2', 't34_85'], start0: [0, 420, 0],
      brief: [
         'Am 16. April hat die 1. Belorussische Front den Angriff auf Berlin eröffnet. Die Scheinwerfer haben den Rauch nur erhellt, der Angriff im Oderbruch ist im Feuer von den Höhen liegen geblieben.',
         'Heute schickt Marschall Schukow die Panzerarmeen nach vorn. Zwischen uns und dem Höhenrand liegen Grabenlinien und gut getarnte Pak-Stellungen.',
         'Die schweren Panzerregimenter mit dem IS-2 führen. Überquert die Gräben, wo das Gelände es erlaubt, und nehmt die Höhe.',
      ],
      goals: ['Erste Grabenlinie überwinden', 'PaK-Stellungen zerstören', 'Die Höhe einnehmen und halten'],
      tip: 'Leichte Fahrzeuge bleiben in Gräben stecken – quert sie langsam und gerade.',
      script(S) {
         const H = [90, -195];                    // the plateau east of the knoll (the knoll itself is too steep)
         const zig = (z) => { const pts = []; for (let x = -420; x <= 420; x += 40) pts.push([x, z + ((x / 40) % 2 ? 8 : -8)]); return pts; };
         S.T.carveTrench?.(zig(250), { w: 2.5, d: 1.8 }); S.T.carveTrench?.(zig(60), { w: 3, d: 2 });
         for (let x = -300; x <= 300; x += 120) S.T.addObject?.({ kind: 'wire', x, z: 280, yaw: 0 });
         for (const [x, z] of [[-220, 150], [-60, 120], [90, 135], [240, 150], [-130, 20], [140, 10]]) S.spawn('pak40', 2, x, z, { tag: 'pak', order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-80, -160], [90, -170]]) S.spawn('pz4h', 2, x, z, { tag: 'def', name: 'Panzer IV', order: { kind: 'hold', x, z } });
         S.spawn('tiger2', 2, 20, -265, { tag: 'tiger', name: 'Königstiger (s.SS-Pz.Abt. 502)', order: { kind: 'ambush', x: 20, z: -265, r: 200 } });
         for (const [x, z, c] of [[-70, 440, 'is2'], [70, 440, 't34_85'], [140, 450, 't34_85']]) S.spawn(c, 1, x, z, { tag: 'allies', name: c === 'is2' ? 'IS-2' : 'T-34-85', order: { kind: 'advance', x: x * 0.5, z: 200 } });
         S.obj('trench1', 'Erste Grabenlinie überwinden');
         S.obj('pak', 'Den Pak-Riegel brechen (5 von 6 Geschützen)', { need: 5 });
         S.obj('hill', 'Die Höhe einnehmen (30 s halten)');
         S.obj('b_tiger', 'Den Königstiger vernichten', { bonus: true, hidden: true });
         S.obj('b_allies', 'Kein eigener Panzer verloren', { bonus: true });
         S.goal(0, 205, 'Grabenlinie');
         this.start = (S) => S.radio('Alle Einheiten: Vorwärts über den Graben! Die Artillerie hält den Höhenrand nieder.');
         S.when((S) => S.player && S.player.pos.z < 238, (S) => {
            S.done('trench1'); S.radio('Erster Graben genommen. Pak-Nester am Hang – mit Sprenggranaten ausräuchern!');
            S.goal(0, 80, 'Pak-Riegel'); S.order(S.group('allies'), { kind: 'advance', x: 0, z: 110 });
            S.hunt('pak', 'PaK-Nest (gemeldet)');
         });
         S.when(() => true, (S) => S.progress('pak', S.dead('pak')), { repeat: true });
         S.when((S) => S.isDone('pak'), (S) => { S._hunt = null; S.goal(H[0], H[1], 'Höhe', 50); S.radio('Der Weg auf die Höhe ist frei. Nehmt das Plateau östlich der Kuppe!'); S.order(S.group('allies'), { kind: 'advance', x: H[0] - 20, z: H[1] + 30 }); });
         S.when((S) => S.group('tiger')[0]?.spotted, (S) => { S.show('b_tiger'); S.radio('Königstiger auf dem Kamm! Flanke angreifen!', 'warn'); });
         S.when((S) => S.alive('tiger') === 0, (S) => { S.show('b_tiger'); S.done('b_tiger'); });
         S.when((S) => S.dead('allies') > 0, (S) => S.fail('b_allies'));
         S.obj('counter', 'Den Gegenstoß auf die Höhe abwehren', { hidden: true });
         // on the crest the defence springs its trap: the Königstiger leaves its reverse-slope
         // hide and a counter-attack of the Müncheberg division comes out of the wood behind
         S.when((S) => S.isDone('pak') && S.player && Math.hypot(S.player.pos.x - H[0], S.player.pos.z - H[1]) < 75, (S) => {
            S.phase('hill'); S.show('counter'); S.refit(0.5, 'Die Tankisten der Nachhut werfen Granaten auf euer Heck – schnell nachladen!');
            const [hx, hz] = S.hullDown(H[0], H[1], 25, H[0], -460);
            S.mark('hd', hx, hz, 'Stellung am Kamm', 'area', 10); S.goal(hx, hz, 'Kamm halten', 8);
            S.radio('Gegenstoß aus dem Wald! Panzer IV im Anmarsch – haltet den Kamm!', 'warn');
            S.after(60, (S) => {          // the Königstiger leaves its hide once the counter-attack is under way
               const tg = S.group('tiger').filter((t) => t.alive); if (!tg.length) return;
               S.radio('Der Königstiger rollt aus seiner Deckung – er qualmt schon, die Artillerie hat ihn erwischt. Flanke suchen!', 'warn');
               // three days of battle: shell-struck, the crew worn out (it still kills a careless IS-2)
               for (const t of tg) { t.hp = Math.min(t.hp, t.maxHP * 0.6); t.aiErr = 1.6; if (t.ai) t.ai._tuned = false; S._tuneAI(t); }
               // it swings east across the front to cut the plateau off from behind: a side shot for whoever waits
               S.order(tg, { kind: 'route', pin: true, pts: [[-20, -300], [hx + 40, -300], [hx + 130, hz - 110]] });
            });
            S.order(S.group('allies').filter((t) => t.alive), { kind: 'advance', x: hx, z: hz + 25 });
            [[200, 'pz4h', 20], [-20, 'pz4h', 45], [120, 'panther', 80], [260, 'pz4h', 140]].forEach(([x, c, dt], i) => S.after(dt, (S) => {
               S.spawn(c, 2, x, -460, { tag: 'counter', name: TANKS[c].short || TANKS[c].name, order: { kind: 'route', pts: [[x * 0.6 + 40, -330], [x * 0.4 + 60, -250], [hx, hz]] } });
               if (i === 2) S.radio('Ein Panther führt die zweite Welle!', 'warn');
            }));
         });
         // the counter-attack is broken but the Königstiger still lurks: go and find it
         S.when((S) => S.c.phase === 'hill' && S.group('counter').length === 4 && S.alive('counter') === 0 && S.alive('tiger') > 0,
            (S) => { S.radio('Die Panzer IV brennen. Bleibt der Königstiger – sucht ihn, von der Seite!', 'warn'); S.hunt('tiger', 'Königstiger', (S) => S.goal(...S.c.markers.find((m) => m.id === 'hd') ? [S.c.markers.find((m) => m.id === 'hd').x, S.c.markers.find((m) => m.id === 'hd').z] : H, 'Kamm halten', 8)); });
         let held = 0;
         S.when((S) => S.c.phase === 'hill' && S.group('counter').length === 4 && S.alive('counter') === 0 && S.alive('tiger') === 0 && S.countIn(1, H[0], H[1], 80) > 0, (S) => {
            if (held === 0) { S.done('counter'); S.radio('Der Gegenstoß ist zerschlagen. Haltet den Kamm, bis die Infanterie oben ist!'); }
            held += 0.25; S.timer('Höhe halten', Math.max(0, 30 - held));
            if (held >= 30) { S.done('hill'); if (S.get('b_allies').state === 'active') S.done('b_allies'); S.timer(null); S.win('Seelower Höhen genommen'); }
         }, { repeat: true });
      },
   },

   lasttiger: {
      id: 'lasttiger', name: 'Der letzte Tiger', place: 'Brücke an der Weser (inspiriert)', date: 'April 1945', nation: 'DE',
      map: 'flusstal', seed: 1945, tanks: ['tiger2'], start0: [0, -60, Math.PI], playerMayDie: false,
      brief: [
         'Frühjahr 1945. Die Front zerfällt; was von der schweren Panzer-Abteilung übrig ist, passt auf eine einzige Brücke: ein Königstiger, kaum Sprit, eine halbe Munitionsladung.',
         'Hinter euch ziehen Verwundete, Nachzügler und Flüchtlingswagen über den Fluss. Haltet das Südufer, bis der letzte Wagen drüben ist – dann über die Brücke zurück, bevor die Pioniere sie sprengen.',
         'Die Geschichte ist frei erfunden, aber solche Nachhutgefechte einzelner Tiger gab es an vielen Flüssen.',
      ],
      goals: ['Brückenkopf 8 Minuten halten', 'Über die Brücke zurückziehen', 'Brücke sprengen lassen'],
      tip: 'Nutze den Panzer schräg (Winkel) und lass dich nicht flankieren. Munition ist knapp.',
      script(S) {
         // the river causeway becomes a real bridge (deck over water) that can be blown
         const site = S.T.bridgeSites?.[0], T = S.T;
         let br = null;
         if (site && T.addBridge) {
            const ex = (site.x0 - site.x1) * 0.12, ez = (site.z0 - site.z1) * 0.12;
            br = T.addBridge(site.x0 + ex, site.z0 + ez, site.x1 - ex, site.z1 - ez, { w: 8 });
         }
         const bx = br?.x ?? 0, bz = br?.z ?? 0, south = Math.max(br?.z0 ?? 0, br?.z1 ?? 0), north = Math.min(br?.z0 ?? 0, br?.z1 ?? 0);
         const hz = south + 75;                                   // bridgehead line on the south bank
         // the deck's south and north ends and the unit vector from south to north along it
         const sEnd = br ? (br.z0 > br.z1 ? [br.x0, br.z0] : [br.x1, br.z1]) : [bx, south], nEnd = br ? (br.z0 > br.z1 ? [br.x1, br.z1] : [br.x0, br.z0]) : [bx, north];
         const bl = Math.hypot(nEnd[0] - sEnd[0], nEnd[1] - sEnd[1]) || 1, ux = (nEnd[0] - sEnd[0]) / bl, uz = (nEnd[1] - sEnd[1]) / bl;
         S.player.pos.x = bx; S.player.pos.z = hz + 15; S.player.placeOn?.(S.T);
         // roadblock in front of the bridgehead: hedgehogs and wire with a gap on the road, so the
         // attackers come at the Tiger's front instead of swarming round it
         for (let x = -200; x <= 200; x += 9) if (Math.abs(x) > 18) T.addObject?.({ kind: x % 2 ? 'hedgehog' : 'wire', x: bx + x, z: hz + 110, yaw: 0 });
         S.spawn('pak40', 1, bx - 70, hz + 10, { tag: 'rear', name: 'PaK 40 (Nachhut)', face: [bx - 70, hz + 400], order: { kind: 'hold', x: bx - 70, z: hz + 10 } });
         S.spawn('pz4h', 1, bx + 60, hz + 5, { tag: 'rear', name: 'Panzer IV (Nachhut)', yaw: Math.PI, order: { kind: 'hold', x: bx + 60, z: hz + 5 } });
         S.obj('hold', 'Den Brückenkopf halten, bis die Nachhut drüben ist');
         S.obj('back', 'Über die Brücke ans Nordufer zurückziehen', { hidden: true });
         S.obj('b_kills', '7 Feindpanzer vernichten', { bonus: true, need: 7 });
         S.obj('b_pershing', 'Den M26 Pershing vernichten', { bonus: true, hidden: true });
         S.goal(bx, hz, 'Brückenkopf', 40); S.timer('Nachhut über den Fluss', 480);
         this.start = (S) => S.radio('Nachhut an Tiger: Noch acht Minuten, dann sind alle drüben. Haltet sie uns vom Leib – die Sperre zwingt sie auf die Straße!');
         let wave = 0;
         // waves trickle in one tank at a time; each first halts at the edge of the wood and only
         // then pushes (route), so the opening is a long-range duel, not a swarm
         const waves = [
            [['m4a3e8', -60], ['m4a3e8', 70]],
            [['m18', -230], ['m4a3e8', -40], ['m4a3e8', 60]],
            [['m4a3e8', -120], ['m18', 200], ['m26', 0]],
         ];
         const send = (S) => {
            const list = waves[wave++]; if (!list) return;
            // the Pershing crew came off Shermans a few weeks ago and does not know the new gun yet
            list.forEach(([c, dx], i) => S.after(i * 14, (S) => S.spawn(c, 2, bx + dx, 470, { yaw: 0, tag: c === 'm26' ? 'pershing' : 'wave', name: TANKS[c].short || TANKS[c].name, aiErr: c === 'm26' ? 1.6 : undefined,
               order: c === 'm26' ? { kind: 'route', pin: true, pts: [[bx + dx, hz + 300], [bx + 30, hz + 170]] }      // the heavy duels from range
                  : { kind: 'route', pin: true, pts: [[bx + dx, hz + 300], [bx + dx * 0.4, hz + 200], [bx + dx * 0.1, hz + 120], [bx + dx * 0.3, hz + 70]] } })));
            S.radio(['Feindpanzer im Süden – Shermans!', 'Zweite Welle, Jagdpanzer an den Flanken!', 'Schwerer Panzer dabei – ein Pershing!'][wave - 1], 'warn');
            if (wave === 3) S.show('b_pershing');
         };
         S.at(40, send); S.at(190, send); S.at(330, send);
         S.at(320, (S) => S.refit(0.55, 'Ein Kübelwagen bringt Granaten und zwei Schlosser – schnell, die nächste Welle kommt!'));
         S.when(() => true, (S) => { S.progress('b_kills', S.dead('wave') + S.dead('pershing')); if (S.group('pershing').length && !S.alive('pershing')) S.done('b_pershing'); }, { repeat: true });
         S.when((S) => S.c.timer && S.c.timer.left <= 0, (S) => {
            S.done('hold'); S.show('back'); S.phase('retreat'); S.timer('Brücke wird gesprengt', 120);
            S.radio('Alle sind drüben! Tiger, zurück über die Brücke – die Pioniere warten auf euch! Die Artillerie schießt Sperrfeuer.');
            // the last battery on the north bank lays a barrage: the attackers pull back into the wood
            // and smoke: the attackers lose sight of the Tiger while it backs over the river
            const att = [...S.group('wave'), ...S.group('pershing')].filter((t) => t.alive);
            S.order(att, { kind: 'advance', x: bx, z: hz + 380 }); for (const t of att) t.viewMul = 0.35;
            // the bridge runs askew: first line up on its south ramp, then straight across
            const ax = sEnd[0] - ux * 14, az = sEnd[1] - uz * 14;
            S.goal(ax, az, 'Brückenauffahrt', 6);
            S.when((S) => S.player && Math.hypot(S.player.pos.x - ax, S.player.pos.z - az) < 9, (S) => S.goal(nEnd[0] + ux * 35, nEnd[1] + uz * 35, 'Nordufer', 25));
            S.order(S.group('rear').filter((t) => !t.cfg.site), { kind: 'advance', x: bx + 10, z: north - 60 });
         });
         S.when((S) => S.c.phase === 'retreat' && S.player && S.player.pos.z < north - 25, (S) => {
            S.done('back'); S.phase('blown');
            S.radio('Tiger ist drüben – Zündung!', 'warn');
            S.after(2, (S) => { if (br) S.T.blowBridge?.(br); S.radio('Die Brücke ist gesprengt. Für euch ist der Krieg hier zu Ende – ihr habt sie alle rübergebracht.'); });
            S.after(7, (S) => S.win('Nachhut gerettet, Brücke gesprengt'));
         });
         S.when((S) => S.c.phase === 'retreat' && S.c.timer && S.c.timer.left <= 0, (S) => { if (br) S.T.blowBridge?.(br); S.lose('Die Brücke flog ohne euch in die Luft'); });
      },
   },

   danzig: {
      id: 'danzig', name: 'Feuer von See', place: 'Danziger Bucht bei Gotenhafen', date: 'März 1945', nation: 'SU',
      map: 'kueste', seed: 3145, tanks: ['t34_85', 'is2'], start0: [0, 400, 0],
      brief: [
         'März 1945. Die 2. Belorussische Front stößt zur Ostsee vor. In der Danziger Bucht liegen deutsche Kriegsschiffe und schießen mit ihren Geschützen auf jede Panzerspitze, die sich der Küste nähert.',
         'Unser Auftrag: die Küstenstellung mit ihren Pak-Geschützen ausheben und das Torpedoboot vor der Mole unter Feuer nehmen. Seine 10,5-cm-Geschütze reichen weit – bleibt in Bewegung.',
         'Ein Panzer gegen ein Schiff: Die Bordwand ist dünn, aber das Boot ist groß. Zielt auf Aufbauten und Geschütz.',
      ],
      goals: ['Küstenstellung ausheben', 'Torpedoboot versenken oder vertreiben'],
      tip: 'Das Boot sieht weit. Deckung hinter Dünen und Häusern suchen, dann schießen.',
      script(S) {
         // berth: alongside the mole's west face (deep water, 10 m off the stones), bow to the sea
         const sea = S.T.shipSpot || { x: 279, z: -290, yaw: 0 };
         S.spawn('tboat', 2, sea.x, sea.z, { yaw: sea.yaw, tag: 'ship', name: 'Torpedoboot T 36', order: { kind: 'hold', x: sea.x, z: sea.z } });
         // Kriegsmarine gun crews put ashore as infantry: brave, but no trained anti-tank gunners
         for (const [x, z] of [[-160, -60], [-20, -80], [130, -70], [250, -40]]) S.spawn('pak40', 2, x, z, { tag: 'pak', aiErr: 2.3, order: { kind: 'hold', x, z } });
         // the two Panzer IV wait behind the warehouses as a local reserve and only open up at close range
         for (const [x, z] of [[-60, -110], [80, -120]]) S.spawn('pz4h', 2, x, z, { tag: 'def', name: 'Panzer IV', order: { kind: 'ambush', x, z, r: 150 } });
         for (const [x, z] of [[-80, 430], [80, 430]]) S.spawn('t34_85', 1, x, z, { tag: 'allies', name: 'T-34-85', order: { kind: 'advance', x: x * 1.6, z: 160 } });
         S.obj('coast', 'Küstenstellung ausheben (PaK und Panzer)', { need: 6 });
         S.obj('ship', 'Das Torpedoboot versenken');
         S.obj('b_fast', 'Das Boot innerhalb von 10 Minuten versenken', { bonus: true });
         S.obj('b_allies', 'Beide T-34 überleben', { bonus: true });
         // the open sand table in front of the position has one piece of cover: the wooded dune hill
         // on the west flank; the artillery smokes the coast while the tanks get there
         const [dx, dz] = S.hullDown(-175, 70, 25, -20, -80);
         S.goal(dx, dz, 'Dünenhügel (Deckung)', 15);
         for (const t of [...S.group('pak'), ...S.group('def')]) t.viewMul = 0.4;
         S.at(75, (S) => { for (const t of [...S.group('pak'), ...S.group('def')]) t.viewMul = 1; S.radio('Der Nebel verweht – jetzt sehen sie uns!', 'warn'); });
         this.start = (S) => S.radio('Die Artillerie schießt Nebel vor die Küste. Über den Waldrand auf den Dünenhügel im Westen – nicht über die freie Fläche!');
         S.every(20, (S) => { const sh = S.group('ship')[0]; if (sh?.alive && S.rng() < 0.4) S.radio('Einschläge vom Torpedoboot – Volltreffer in der Nähe!', 'warn'); });
         // from the dunes the PaKs are taken one by one, nearest first; the T-34s work the flanks
         S.when((S) => S.player && (Math.hypot(S.player.pos.x - dx, S.player.pos.z - dz) < 30 || S.time > 110), (S) => {
            S.radio('Die Pak-Stellungen sind erkannt. Eine nach der anderen – Sprenggranaten!');
            S.hunt(['pak', 'def'], 'Feindstellung');
            S.group('allies').forEach((t, i) => S.order([t], { kind: 'route', pts: [[[-130, 110][i], [80, 130][i]], [[-140, 150][i], [0, 20][i]]] }));
         });
         S.when(() => true, (S) => S.progress('coast', S.dead('pak') + S.dead('def')), { repeat: true });
         S.when((S) => S.isDone('coast'), (S) => {
            S._hunt = null; S.refit(0.45, 'Die Küste ist frei. Ein Werkstattzug flickt euch, dann ab zum Hafen!');
            // fire from the corner of the quay warehouses, not from the open mole
            const sh = S.group('ship')[0]; if (!sh?.alive) return;
            S.goal(sh.pos.x - 45, sh.pos.z + 175, 'Hafen (Deckung der Lagerhäuser)', 15);
            S.radio('Jetzt das Boot! Aus der Deckung der Lagerhäuser schießen – zielt auf Brücke und Geschütz!');
         });
         S.when((S) => S.alive('allies') < 2, (S) => S.fail('b_allies'));
         S.when((S) => S.alive('ship') === 0, (S) => {
            S.done('ship'); if (S.time < 600) S.done('b_fast'); else S.fail('b_fast');
            if (S.alive('allies') >= 2) S.done('b_allies');
            if (!S.isDone('coast')) S.radio('Das Boot sinkt! Räumt den Rest der Stellung.'); else S.win('Torpedoboot versenkt');
         });
         S.when((S) => S.isDone('ship') && S.isDone('coast'), (S) => S.win('Küste und Bucht frei'));
      },
   },

   arracourt: {
      id: 'arracourt', name: 'Nebel über Arracourt', place: 'Arracourt, Lothringen', date: '19. September 1944', nation: 'US',
      map: 'dorf', seed: 919, tanks: ['m18', 'm4a3e8'], start0: [0, 250, 0], fog: 0.65,
      brief: [
         'Lothringen, Morgennebel. Die 4. Panzerdivision hält einen Bogen um Arracourt; die deutsche Panzer-Brigade 113 greift mit neuen Panthern an.',
         'Im Nebel zählt nicht die Panzerung, sondern wer zuerst schießt. Die M18 Hellcats der 704. Panzerjägerabteilung liegen in Hinterhalten am Hang.',
         'Lasst die Panther nah heran, trefft die Seiten und wechselt nach jedem Schuss die Stellung. Der Gefechtsstand im Dorf darf nicht fallen.',
      ],
      goals: ['Panzerangriff abwehren', 'Gefechtsstand halten'],
      tip: 'Im Nebel sieht man kaum 150 m weit. Aus dem Busch feuern und dann umsetzen.',
      script(S) {
         const cp = { x: 0, z: 260 }, T = S.T;
         // the ambush line: the bushiest spot near each planned position (cover the player can use)
         const bushAt = (x, z) => { let b = null, bd = 60; for (const o of T.bushes || []) { const d = Math.hypot(o.x - x, o.z - z); if (o.alive !== false && d < bd) { bd = d; b = o; } } return b ? [b.x, b.z] : [x, z]; };
         // the Hellcats lie on both flanks of the road into the village, so the Panthers drive past
         // them and show their 40 mm sides instead of the 80 mm glacis the 76 mm gun cannot pierce
         const amb = bushAt(-110, 150);
         S.obj('kill', 'Angreifende Panzer vernichten', { need: 9 });
         S.obj('cp', 'Gefechtsstand halten (kein Feind im Dorf)');
         S.obj('b_ally', 'Kein Hellcat verloren', { bonus: true });
         S.obj('b_ace', '4 Abschüsse selbst erzielen', { bonus: true, need: 4 });
         for (const [x, z] of [[125, 115], [70, 170]]) { const [bx, bz] = bushAt(x, z); S.spawn('m18', 1, bx, bz, { tag: 'allies', name: 'M18 Hellcat', order: { kind: 'ambush', x: bx, z: bz, r: 140 } }); }
         for (const x of [-35, 35]) S.spawn('m4a3e8', 1, cp.x + x, cp.z - 25, { tag: 'cpguard', name: 'Sherman (Gefechtsstand)', order: { kind: 'hold', x: cp.x + x, z: cp.z - 25 } });
         S.goal(amb[0], amb[1], 'Hinterhalt', 20); S.mark('cp', cp.x, cp.z, 'Gefechtsstand', 'area', 60);
         this.start = (S) => S.radio('Hier Gefechtsstand: Motorengeräusche im Nebel, Richtung Nord. Geht in den Büschen in Stellung – Feuer erst auf kurze Distanz!');
         // waves come one tank at a time down three lanes; Panzer-Brigade 113 was freshly raised:
         // green crews, buttoned up in the fog, see little (view −25 %) and shoot worse
         const W = [[['panther', -90], ['panther', 70]], [['pz4h', -200], ['panther', 0], ['pz4h', 190]], [['panther', -120], ['pz4h', 0], ['panther', 130], ['panther', 240]]];
         let wave = 0;
         const send = (S) => {
            const list = W[wave++]; if (!list) return;
            list.forEach(([c, dx], i) => S.after(i * 18, (S) => {
               S.spawn(c, 2, dx, -440, { yaw: Math.PI, tag: 'att', name: TANKS[c].short || TANKS[c].name, viewMul: 0.5, aiErr: 1.5,
                  order: { kind: 'route', pin: true, pts: [[dx * 0.8, -200], [dx * 0.6, -60], [dx * 0.3, 90], [cp.x, cp.z]] } });
            }));
            S.radio(wave === 1 ? 'Panther im Nebel – zwei Stück!' : wave === 2 ? 'Neue Welle, Panzer IV und Panther!' : 'Starke Kräfte, die ganze Brigade kommt!', 'warn');
         };
         S.at(45, send); S.at(220, send); S.at(400, send);
         S.at(200, (S) => S.refit(0.3, 'Kurze Pause im Nebel. Die Instandsetzung flickt, was sie kann.'));
         S.at(380, (S) => S.refit(0.35, 'Munitionswagen ist durch: auffüllen und Schäden flicken, schnell!'));
         S.when(() => true, (S) => { S.progress('kill', S.dead('att')); S.progress('b_ace', S.player?.stats?.kills || 0); }, { repeat: true });
         S.when((S) => S.alive('allies') < 2, (S) => S.fail('b_ally'));
         let lost = 0;                    // the CP falls after 20 s with an enemy tank inside
         S.when((S) => S.countIn('att', cp.x, cp.z, 60) > 0, (S) => {
            lost += 0.25; S.timer('Gefechtsstand fällt', Math.max(0, 20 - lost));
            if (lost === 0.25) S.radio('Feindpanzer am Gefechtsstand!', 'warn');
            if (lost >= 20) { S.fail('cp'); S.lose('Gefechtsstand überrannt'); }
         }, { repeat: true });
         S.when((S) => S.isDone('kill'), (S) => { S.done('cp'); if (S.alive('allies') >= 2) S.done('b_ally'); S.timer(null); S.win('Angriff abgewehrt'); });
      },
   },
   spaehtrupp: {
      id: 'spaehtrupp', name: 'Spähtrupp an der Beresina', place: 'Südlich von Bobruisk, Weißrussland', date: '24. Juni 1944', nation: 'DE',
      map: 'steppe', seed: 6244, tanks: ['luchs', 'pz4h'], start0: [0, 430, 0],
      brief: [
         'Juni 1944. Die Führung erwartet den sowjetischen Hauptangriff weiter südlich. Der Divisionsstab will Gewissheit: Was steht wirklich vor unserem Abschnitt?',
         'Ein Spähtrupp aus zwei Luchs fährt vor. Drei Bereitstellungsräume sind gemeldet. Beobachten, melden, nicht kämpfen – ein Spähpanzer gewinnt kein Duell mit einem T-34.',
         'Kommt ihr zurück, weiß der Stab, was ihn erwartet. Ob er es glauben will, ist eine andere Frage.',
      ],
      goals: ['Bereitstellungsräume aufklären', 'Unentdeckt bleiben', 'Mit dem Bericht zurückkehren'],
      tip: 'Von den markierten Beobachtungspunkten aus stillhalten: Wer sich bewegt oder schießt, wird gesehen.',
      script(S) {
         // three Soviet assembly areas: tanks under nets, crews resting (poor view, slow reaction)
         const A = [[-330, -190, 'West'], [40, -340, 'Nord'], [330, -205, 'Ost']];
         // observation points with a line of sight into each area (found with tests/out/_obs.mjs)
         const obs = [[-128, -67], [198, -116], [454, -30]];
         A.forEach(([x, z], i) => {
            const set = [['t34_76', -25, 0], ['t34_76', 25, 10], [i === 1 ? 'kv1' : 't34_76', 0, -30]];
            for (const [c, dx, dz] of set) S.spawn(c, 2, x + dx, z + dz, { tag: 'area' + i, name: TANKS[c].short, viewMul: 0.45, aiErr: 1.5, order: { kind: 'ambush', x: x + dx, z: z + dz, r: 120 } });
         });
         S.spawn('luchs', 1, 30, 445, { tag: 'mate', name: 'Luchs (Uffz. Brandt)' });
         S.obj('scout', 'Bereitstellungsräume aufklären', { need: 2 });
         S.obj('out', 'Ausbruch: den Sammelpunkt der Kampfgruppe erreichen', { hidden: true });
         S.obj('b_all', 'Alle drei Bereitstellungen aufklären', { bonus: true, need: 3 });
         S.obj('b_quiet', 'Kein Schuss vor dem Durchbruch', { bonus: true });
         S.obj('b_mate', 'Der zweite Luchs kommt durch', { bonus: true });
         const seen = new Set();
         const next = (S) => {
            if (S.c.phase !== 'scout' || !S.player) return;
            const p = S.player; let bi = -1, bd = Infinity;
            obs.forEach(([x, z], i) => { if (seen.has(i)) return; const d = Math.hypot(x - p.pos.x, z - p.pos.z); if (d < bd) { bd = d; bi = i; } });
            obs.forEach(([x, z], i) => { if (!seen.has(i)) S.mark('obs' + i, x, z, 'Beobachtung ' + A[i][2], 'area', 12); });
            if (bi >= 0) S.goal(obs[bi][0], obs[bi][1], 'Beobachtungspunkt ' + A[bi][2], 12);
         };
         S.phase('scout');
         this.start = (S) => { S.radio('Spähtrupp, hier Stab: Drei Räume sind gemeldet. Wir brauchen Stärke und Art – keine Abschüsse.'); next(S); };
         // a report needs eyes on the tanks themselves from up close (≤ 320 m)
         S.when((S) => S.c.phase === 'scout', (S) => {
            A.forEach(([x, z], i) => {
               if (seen.has(i) || !S.player?.alive) return;
               if (Math.hypot(S.player.pos.x - x, S.player.pos.z - z) > 320 || !S.group('area' + i).some((t) => t.spotted)) return;
               seen.add(i); S.unmark('obs' + i);
               S.progress('scout', seen.size); S.progress('b_all', seen.size);
               S.radio(['Raum West: Panzer unter Netzen, mindestens ein Bataillon. Gemeldet.', 'Raum Nord: schwere KW dabei! Gemeldet.', 'Raum Ost: T-34 in Bereitstellung, Infanterie sitzt auf. Gemeldet.'][i]);
               next(S);
            });
            if (S.player?.stats.shots > 0 && S.get('b_quiet').state === 'active') S.fail('b_quiet');
         }, { repeat: true });
         S.every(12, (S) => { if (S.c.phase === 'scout' && S.player) S.order(S.group('mate').filter((t) => t.alive), { kind: 'advance', x: S.player.pos.x + 25, z: S.player.pos.z + 30 }); });
         // the twist: the offensive starts while the patrol is still out; the way home is gone
         const exits = [[-450, 255], [440, 330]]; let exit = exits[0];
         S.when((S) => S.c.phase === 'scout' && ((S.isDone('scout') && (seen.size === 3 || S.time > 420)) || S.time > 600), (S) => {
            // the rally point is whichever end of the front is nearer: west road or the farm in the south-east
            const p = S.player; exit = exits[Math.hypot(p.pos.x - exits[0][0], p.pos.z - exits[0][1]) < Math.hypot(p.pos.x - exits[1][0], p.pos.z - exits[1][1]) ? 0 : 1];
            S.phase('out'); if (S.get('b_quiet').state === 'active') S.done('b_quiet');
            if (!S.isDone('scout')) S.fail('scout');
            for (let i = 0; i < 3; i++) S.unmark('obs' + i);
            S.radio('Hier Stab – Trommelfeuer auf der ganzen Front! Der Iwan greift beiderseits an euch vorbei an. Der Rückweg nach Süden ist abgeschnitten!', 'warn');
            S.after(6, (S) => S.radio('Sammelpunkt der Kampfgruppe ist markiert. Durch den Rauch, nicht stehen bleiben!', 'warn'));
            S.show('out'); S.mark('exit', exit[0], exit[1], 'Sammelpunkt', 'area', 60); S.goal(exit[0], exit[1], 'Sammelpunkt Kampfgruppe', 50);
            S.fog(0.4, 0x9a9890);                                      // smoke of the barrage over the steppe
            // the assembled tanks roll south past the patrol: they are after the front, not after one Luchs
            for (let i = 0; i < 3; i++) S.order(S.group('area' + i).filter((t) => t.alive), { kind: 'route', pin: true, pts: [[-300 + i * 300, 150], [-300 + i * 300, 470]] });
            // a blocking group on the road and a pursuit from the north-east
            // a T-34 platoon has already crossed the road: it lies on the flank of the way to the rally point
            const mx = (p.pos.x + exit[0]) / 2, mz = (p.pos.z + exit[1]) / 2, L = Math.hypot(exit[0] - p.pos.x, exit[1] - p.pos.z) || 1, nx = -(exit[1] - p.pos.z) / L, nz = (exit[0] - p.pos.x) / L, sd = mx * nx + mz * nz > 0 ? -1 : 1;
            for (const k of [-30, 30]) S.spawn('t34_76', 2, mx + nx * sd * 190 + k, mz + nz * sd * 190 - k, { tag: 'block', name: 'T-34/76', aiErr: 1.8, viewMul: 0.7, order: { kind: 'ambush', x: mx + nx * sd * 190 + k, z: mz + nz * sd * 190 - k, r: 220 } });
            S.after(25, (S) => {
               for (const x of [200, 280]) S.spawn('t34_85', 2, x, -470, { tag: 'chase', name: 'T-34-85', aiErr: 1.3, order: { kind: 'route', pin: true, pts: [[x * 0.3, -150], [exit[0] * 0.5, exit[1] * 0.5], [exit[0], exit[1]]] } });
               S.radio('Zwei T-34 hinter euch!', 'warn');
            });
            S.order(S.group('mate').filter((t) => t.alive), { kind: 'advance', x: exit[0], z: exit[1] });
         });
         S.when((S) => S.c.phase === 'out' && S.inZone('player', exit[0], exit[1], 60), (S) => {
            S.done('out'); if (S.alive('mate')) S.done('b_mate'); else S.fail('b_mate');
            S.radio('Ihr seid durch. Der Bericht kommt zu spät, um noch etwas zu ändern – aber die Kampfgruppe weiß jetzt, wohin sie ausweichen kann.');
            S.win('Mit dem Bericht durchgekommen');
         });
         S.when((S) => S.dead('mate') > 0, (S) => { S.fail('b_mate'); S.radio('Brandt ist getroffen – der zweite Luchs brennt!', 'warn'); });
      },
   },

   beute: {
      id: 'beute', name: 'Beute im Schnee', place: 'Arbeitersiedlung Nr. 5 bei Leningrad', date: '17. Januar 1943', nation: 'SU',
      map: 'winter', seed: 1743, tanks: ['t34_76', 'kv1'], start0: [0, 430, 0],
      brief: [
         'Operation Iskra: Seit Tagen kämpfen die Wolchow- und die Leningrader Front um einen Landweg in die belagerte Stadt.',
         'Die Aufklärung meldet einen neuen schweren deutschen Panzer, im Moor nördlich des Sees festgefahren und von der Besatzung verlassen. Niemand bei uns hat so etwas je gesehen.',
         'Die Wache ausschalten, den Panzer bergen und in die eigenen Linien bringen. Er darf nicht zerstört werden – die Deutschen werden genau das versuchen.',
      ],
      goals: ['Die Wache am Moor ausschalten', 'Den Panzer bergen', 'Ihn in die eigenen Linien geleiten'],
      tip: 'Der erbeutete Panzer ist als eigener markiert – nicht darauf schießen. Stell dich zwischen ihn und den Gegenstoß.',
      script(S) {
         const P = [60, -175];
         const tiger = S.spawn('tiger1', 1, P[0], P[1], { yaw: 0.6, inert: true, tag: 'prize', name: 'Tiger (verlassen)' });
         for (const [x, z] of [[-60, -105], [150, -95]]) S.spawn('pak40', 2, x, z, { tag: 'guard', aiErr: 2.4, order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-10, -215]]) S.spawn('pz4h', 2, x, z, { tag: 'guard', name: 'Panzer IV', aiErr: 1.6, order: { kind: 'ambush', x, z, r: 170 } });
         for (const [x, c] of [[-60, 't34_76'], [60, 'kv1']]) S.spawn(c, 1, x, 440, { tag: 'allies', name: TANKS[c].short, order: { kind: 'route', pts: [[-200 + x, 180], [-150 + x, -30]] } });
         S.obj('guard', 'Die Wache am Moor ausschalten', { need: 3 });
         S.obj('tow', 'Den Panzer freischleppen lassen', { hidden: true });
         S.obj('escort', 'Den Beutepanzer in die eigenen Linien geleiten', { hidden: true });
         S.obj('b_tiger', 'Den zweiten Tiger vernichten', { bonus: true, hidden: true });
         S.obj('b_hp', 'Die Beute kommt mit mehr als halber Panzerung an', { bonus: true });
         S.goal(-210, 170, 'Waldrand West', 30);
         S.zone(-210, 170, 50, (S) => S.goal(-160, -40, 'Westufer des Sees', 30));
         for (const t of S.group('guard')) t.viewMul = 0.55;           // freezing in their dugouts, watching the ice
         S.fog(0.45, 0xe6eaee);                     // driving snow: the guard sees no farther than we do
         this.start = (S) => S.radio('Hier Regiment: Schneetreiben – nutzt es. Das Eis trägt, aber auf dem See gibt es keine Deckung. Am Westufer entlang zum Moor!');
         S.zone(-160, -40, 60, (S) => { for (const t of S.group('guard')) t.viewMul = 1; S.radio('Wache am Moor erkannt. Pak und Panzer – aber trefft den Koloss nicht!'); S.hunt('guard', 'Wache'); });
         S.after(150, (S) => { if (!S._hunt && S.alive('guard')) S.hunt('guard', 'Wache'); });
         S.when(() => true, (S) => S.progress('guard', S.dead('guard')), { repeat: true });
         S.when(() => !tiger.alive, (S) => { S.fail('escort'); S.lose('Der Beutepanzer ist zerstört'); });
         S.when((S) => S.isDone('guard'), (S) => {
            S._hunt = null; S.show('tow'); S.phase('tow'); S.fadeFog(0.1, 40); S.refit(0.35, 'Ein Bergeschlepper und Pioniere kommen über das Eis. Haltet ihnen den Rücken frei!');
            S.goal(P[0], P[1] - 25, 'Beutepanzer', 20);
            S.order(S.group('allies').filter((t) => t.alive), { kind: 'advance', x: P[0] - 30, z: P[1] - 30 });
            S.holdZone('Bergetrupp schleppt frei', P[0], P[1], 70, 50, (S) => {
               S.done('tow'); S.phase('escort'); S.show('escort');
               S.radio('Er läuft! Unsere Fahrer bringen ihn in Gang – mit der Kanone können sie nicht umgehen. Begleitet ihn über das Eis nach Süden!');
               S.crewUp(tiger, { aiErr: 2.5, order: { kind: 'route', pin: true, pts: [[60, -90], [20, 0], [0, 200], [0, 400]] } });
               tiger.name = 'Tiger (erbeutet)';
               S.goal(0, 400, 'Eigene Linien', 60);
               S.order(S.group('allies').filter((t) => t.alive), { kind: 'advance', x: 160, z: 100 });
               // the twist: a second Tiger of the same company comes after its lost comrade
               S.after(25, (S) => {
                  S.show('b_tiger'); S.radio('Noch so ein Koloss hinter euch, aus Nordwest! Er jagt die Beute – stellt euch dazwischen, trefft ihn seitlich!', 'warn');
                  S.spawn('tiger1', 2, -300, -460, { tag: 'tiger', name: 'Tiger', aiErr: 1.7, viewMul: 0.75, order: { kind: 'route', pin: true, pts: [[-150, -250], [60, -60], [150, 120]] } });
               });
            });
            // the twist: the Germans counter-attack to recover or destroy it, led by a second Tiger
            S.after(20, (S) => {
               tiger.inert = false;                    // from now on they want it destroyed
               S.radio('Gegenstoß aus Norden! Panzer IV – sie wollen ihn zurückholen oder sprengen!', 'warn');
               for (const [x, dt] of [[220, 0], [-60, 35]]) S.after(dt, (S) => S.spawn('pz4h', 2, x, -470, { tag: 'counter', name: 'Panzer IV', aiErr: 1.8, order: { kind: 'route', pts: [[x * 0.6, -300], [P[0], P[1] - 40]] } }));
            });
         });
         S.when((S) => S.group('tiger').length && !S.alive('tiger'), (S) => { S.done('b_tiger'); S.radio('Der zweite Tiger brennt!'); });
         S.when((S) => S.c.phase === 'escort' && Math.hypot(tiger.pos.x, tiger.pos.z - 400) < 70, (S) => {
            S.done('escort'); if (tiger.hp > tiger.maxHP * 0.5) S.done('b_hp'); else S.fail('b_hp');
            S.radio('Der Beutepanzer ist in unseren Linien. Bald wissen unsere Panzerjäger, wo er verwundbar ist.');
            S.win('Beutepanzer geborgen');
         });
      },
   },
   totalize: {
      id: 'totalize', name: 'Mondlicht über Caen', place: 'Straße Caen–Falaise bei Saint-Aignan', date: '7./8. August 1944', nation: 'UK',
      map: 'dorf', seed: 7844, tanks: ['cromwell', 'churchill7'], start0: [0, 430, 0], fog: 0.7,
      brief: [
         'Operation Totalize. Zum ersten Mal greifen alliierte Panzer bei Nacht an: Scheinwerfer werfen „künstliches Mondlicht“ gegen die Wolken, Leuchtspur der Bofors zeigt die Richtung.',
         'Eure Kolonne fährt im Dunkeln dicht aufgeschlossen auf das Dorf zu. Haltet Anschluss und räumt mit der Infanterie die Pak-Stellungen im Ort.',
         'Bei Tagesanbruch muss das Dorf gehalten sein. Der Gegner hat schwere Reserven. Wo sie stehen, weiß niemand.',
      ],
      goals: ['Der Kolonne zum Dorf folgen', 'Pak-Stellungen im Dorf ausschalten', 'Das Dorf halten'],
      tip: 'Nachts sieht man kaum 100 m weit. Hinter der Kolonne bleiben. Bei Tag nie frontal gegen schwere Panzer kämpfen.',
      script(S) {
         S.fog(0.7, 0x1b2330);                                      // night: dark blue-grey, little sight
         const col = [['cromwell', -14, 300], ['churchill7', 14, 330], ['cromwell', -14, 360]];
         for (const [c, x, z] of col) S.spawn(c, 1, x, z, { tag: 'col', name: TANKS[c].short || TANKS[c].name, order: { kind: 'route', pin: true, pts: [[x, 200], [x * 2, 150]] } });
         // the defenders of the village: PaK nests and dug-in Panzer IV, half asleep, blind in the dark
         for (const [x, z] of [[-60, 70], [55, 95], [-20, -40]]) S.spawn('pak40', 2, x, z, { tag: 'vil', aiErr: 2.4, viewMul: 0.5, order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-90, -10], [40, 30]]) S.spawn('pz4h', 2, x, z, { tag: 'vil', name: 'Panzer IV', aiErr: 2, viewMul: 0.5, order: { kind: 'ambush', x, z, r: 110 } });
         S.obj('follow', 'Der Kolonne zum Dorfrand folgen');
         S.obj('vil', 'Pak-Stellungen und Panzer im Dorf ausschalten', { need: 5 });
         S.obj('tiger', 'Den Gegenangriff abwehren', { hidden: true, need: 3 });
         S.obj('b_col', 'Kein Panzer der Kolonne verloren', { bonus: true });
         S.obj('b_ace', 'Einen Tiger selbst vernichten', { bonus: true, hidden: true });
         S.phase('night'); S.goal(0, 200, 'Bereitstellung Dorfrand', 30);
         this.start = (S) => {
            S.radio('Hier Kolonnenführer: Aufschließen, Abstand fünf Meter. Haltet euch an die Leuchtspur der Bofors – sie zeigt genau auf das Dorf.');
            S.after(10, (S) => S.radio('Die Scheinwerfer gehen an. Wer stehen bleibt, verliert die Kolonne.'));
         };
         S.zone(0, 200, 60, (S) => {
            S.done('follow'); S.phase('village'); S.radio('Dorfrand erreicht. Infanterie sitzt ab. Pak im Ort! Mit Sprenggranaten ausräuchern, wir decken euch.');
            S.order(S.group('col').filter((t) => t.alive), { kind: 'advance', x: 0, z: 110 });
            S.hunt('vil', 'Stellung (Mündungsfeuer)');
         });
         S.when((S) => S.c.phase === 'night' && S.time > 150, (S) => { S.done('follow'); S.phase('village'); S.hunt('vil', 'Stellung (Mündungsfeuer)'); S.order(S.group('col').filter((t) => t.alive), { kind: 'advance', x: 0, z: 110 }); });   // lost in the dark: the hunt starts anyway
         S.when(() => true, (S) => S.progress('vil', S.dead('vil')), { repeat: true });
         S.when((S) => S.dead('col') > 0, (S) => S.fail('b_col'));
         // the twist: dawn shows the village held, and a group of Tigers coming down the road to retake it
         let k0 = 0;
         S.when((S) => S.isDone('vil'), (S) => {
            S._hunt = null; S.phase('dawn'); S.timer(null);
            S.refit(0.35, 'Dorf genommen! Der Munitionsträger ist durch. Auffüllen, gleich wird es hell.');
            S.fadeFog(0.3, 50, (S) => S.fog(0.3, 0xb8c0c6));                 // dawn mist over the fields
            const [hx, hz] = S.hullDown(95, -95, 30, 0, -400);
            S.mark('orch', hx, hz, 'Obstgarten (Flanke)', 'area', 25); S.goal(hx, hz, 'Obstgarten – Flankenstellung', 18);
            S.order(S.group('col').filter((t) => t.alive), { kind: 'ambush', x: -130, z: -60, r: 200 });
            for (const x of [-170, -100]) S.spawn('m4a3e8', 1, x, 160, { tag: 'pol', name: 'Sherman (1. Poln. Pz.-Div.)', order: { kind: 'route', pts: [[x, -40]] } });
            S.after(20, (S) => S.radio('Polnische Shermans schließen links auf. Sie halten die Westseite der Straße.'));
            S.after(40, (S) => {
               S.radio('Hier Beobachter: Schwere Panzer auf der Straße von Falaise her, Tiger und Panzer IV! Sie wollen das Dorf zurück.', 'warn');
               S.after(5, (S) => S.radio('Nicht frontal! Lasst sie an euch vorbei auf das Dorf zufahren und schießt in die Seite.'));
               S.show('tiger'); S.show('b_ace'); S.phase('tigers'); S._t0 = S.time; k0 = S.player?.stats.kills || 0;
               for (const [c, dx, dt] of [['tiger1', -8, 0], ['pz4h', 8, 16], ['tiger1', -8, 32]]) S.after(dt, (S) => S.spawn(c, 2, dx, -470, { yaw: Math.PI, tag: 'tiger', name: c === 'pz4h' ? 'Panzer IV' : 'Tiger', aiErr: 2.4, viewMul: 0.55,
                  order: { kind: 'route', pin: true, pts: [[dx, -250], [dx, -110], [dx * 3, -20]] } }));
               // stay in the orchard until they are level with it (their sides show), then go after them
               S.when((S) => S.time > S._t0 + 90 || (S.alive('tiger') > 0 && S.group('tiger').every((t) => !t.alive || t.pos.z > -110)), (S) => S.hunt('tiger', 'Tiger (Flanke)'));
            });
         });
         S.when((S) => S.c.phase === 'tigers', (S) => {
            S.progress('tiger', S.dead('tiger'));
            if ((S.player?.stats.kills || 0) > k0 && S.get('b_ace').state === 'active') S.done('b_ace');   // only Tigers are left to kill now
         }, { repeat: true });
         S.when((S) => S.c.phase === 'tigers' && S.isDone('tiger'), (S) => {
            if (S.dead('col') === 0) S.done('b_col');
            if (S.get('b_ace').state === 'active') S.fail('b_ace');
            S.radio('Der Gegenangriff ist zerschlagen. Das Dorf ist unser – um einen Preis, den man bei Tag erst sieht.');
            S.win('Dorf gehalten');
         });
         // a Tiger in the village square for 45 s (in all) retakes it
         let lost = 0;
         S.when((S) => S.c.phase === 'tigers' && S.group('tiger').some((t) => t.alive && t.cls === 'tiger1' && Math.hypot(t.pos.x, t.pos.z) < 55), (S) => {
            lost += 0.25; S.timer('Dorf fällt', Math.max(0, 45 - lost)); if (lost >= 45) S.lose('Das Dorf ist verloren');
         }, { repeat: true });
      },
   },
   koeder: {
      id: 'koeder', name: 'Der Köder', place: 'Waldgebiet bei Brody, Westukraine', date: '15. Juli 1944', nation: 'SU',
      map: 'waldhuegel', seed: 7144, tanks: ['t34_85', 'su100'], start0: [-40, 420, 0],
      brief: [
         'Juli 1944, Lwiw-Sandomierz-Operation. Die Aufklärung meldet eine deutsche Versorgungskolonne auf der Waldstraße, nur schwach geschützt.',
         'Euer Zug soll sie aus dem Hinterhalt am Waldrand vernichten und dann sofort zurück in den Wald. Ein leichter Auftrag, sagt der Stab.',
         'Der Zugführer fragt sich, warum eine Kolonne bei Tag über offenes Gelände fährt.',
      ],
      goals: ['Hinterhalt an der Waldstraße beziehen', 'Die Kolonne vernichten', 'Zurück zum Sammelpunkt'],
      tip: 'Aus dem Busch schießen, dann die Stellung wechseln. Wird es eng: nicht kämpfen, fahren.',
      script(S) {
         const amb = S.hullDown(-120, 70, 35, -120, -40), rally = [40, 330];
         S.spawn('t34_85', 1, 10, 430, { tag: 'mate', name: 'T-34-85 (Lt. Orlowa)' });
         S.obj('pos', 'Hinterhalt am Waldrand beziehen');
         S.obj('col', 'Die Kolonne zerschlagen', { need: 2 });
         S.obj('out', 'Ausbruch: zum Sammelpunkt im Wald', { hidden: true });
         S.obj('b_mate', 'Lt. Orlowa kommt durch', { bonus: true });
         S.obj('b_panther', 'Einen Panther vernichten', { bonus: true, hidden: true });
         S.phase('move'); S.mark('amb', amb[0], amb[1], 'Hinterhalt', 'area', 25); S.goal(amb[0], amb[1], 'Hinterhalt', 18);
         this.start = (S) => S.radio('Zug, hier Kompanie: Die Kolonne ist in zehn Minuten an euch. Stellung am Waldrand, Feuer erst auf mein Kommando.');
         S.every(10, (S) => { if (S.c.phase !== 'out' && S.player) S.order(S.group('mate').filter((t) => t.alive), { kind: 'ambush', x: S.player.pos.x + 40, z: S.player.pos.z + 15, r: 250 }); });
         const go = (S) => {
            if (S.c.phase !== 'move') return;
            S.done('pos'); S.phase('wait'); S.radio('In Stellung. Motorengeräusche von Westen. Wartet, bis sie auf der Straße sind.');
            // the bait: three Panzer IV, slow along the road, not looking about much
            for (let i = 0; i < 3; i++) S.after(10 + i * 7, (S) => S.spawn('pz4h', 2, -480, -96, { yaw: Math.PI / 2, tag: 'col', name: 'Panzer IV (Kolonne)', aiErr: 1.6, viewMul: 0.5,
               order: { kind: 'route', pin: true, pts: [[-200, -40], [0, 0], [200, 40], [480, 96]] } }));
         };
         S.zone(amb[0], amb[1], 30, go);
         S.when((S) => S.time > 120, go);
         // "Feuer!" when the head of the column is in the killing zone below the ambush
         S.when((S) => S.c.phase === 'wait' && S.group('col').some((t) => t.alive && t.pos.x > amb[0] - 120), (S) => {
            S.phase('fire'); S.radio('Feuer frei!'); S.goal(amb[0], amb[1], 'Hinterhalt – Feuer auf die Kolonne', 18);
            if (S.autopilot && S.player) S.order([S.player], { kind: 'ambush', x: amb[0], z: amb[1], r: 320 });   // fire from the ambush, do not charge
         });
         S.when(() => true, (S) => S.progress('col', S.dead('col')), { repeat: true });
         S.when((S) => S.dead('mate') > 0, (S) => S.fail('b_mate'));
         // the twist: the column was the bait. Panthers from the east, a Tiger from the west close the road.
         S.when((S) => (S.c.phase === 'fire' && S.dead('col') >= 2) || (S.c.phase === 'fire' && S.time > 330), (S) => {
            S.phase('trap'); S.radio('Kompanie an Zug: Panther auf der Straße von Osten, ein Tiger von Westen! Das war ein Köder – die warten seit Tagen auf uns!', 'warn');
            S.show('b_panther');
            // the rest of the "column" breaks off at full speed: it was only there to draw the ambush out
            S.order(S.group('col').filter((t) => t.alive), { kind: 'route', pin: true, pts: [[200, 40], [480, 96]] });
            S.after(4, (S) => S.radio('Die Kolonne dreht ab und gibt Gas. Sie sollte uns nur herauslocken.'));
            for (const [dt, x] of [[0, 480], [8, 500]]) S.after(dt, (S) => S.spawn('panther', 2, x, 96, { yaw: -Math.PI / 2, tag: 'trap', name: 'Panther', aiErr: 1.9, viewMul: 0.6, order: { kind: 'route', pts: [[200, 60], [40, 120]] } }));
            S.after(20, (S) => S.spawn('tiger1', 2, -490, -100, { yaw: Math.PI / 2, tag: 'trap', name: 'Tiger', aiErr: 2, viewMul: 0.6, order: { kind: 'route', pts: [[-200, -40], [-120, 60]] } }));
            S.after(8, (S) => {
               S._hunt = null; S.phase('out'); S.show('out'); if (!S.isDone('col')) S.fail('col');
               S.radio('Abbrechen! Alles zurück zum Sammelpunkt im Wald, die Brigade schießt Nebel vor euch!', 'warn');
               S.fog(0.55, 0xa0a49c);                                  // smoke shells between the trap and the forest
               S.after(70, (S) => S.fadeFog(0.1, 40));
               if (S.autopilot && S.player) S.order([S.player], { kind: 'route', pin: true, pts: [[amb[0] - 10, amb[1] + 140], rally] });
               S.mark('rally', rally[0], rally[1], 'Sammelpunkt', 'area', 45); S.goal(rally[0], rally[1], 'Sammelpunkt', 40);
               S.order(S.group('mate').filter((t) => t.alive), { kind: 'route', pin: true, pts: [[rally[0] - 20, 300], [rally[0] - 20, rally[1]]] });
               for (const x of [-60, 140]) S.spawn('su100', 1, x, 470, { tag: 'cover', name: 'SU-100 (Brigade)', order: { kind: 'ambush', x, z: 470, r: 450 } });
            });
         });
         S.when((S) => S.group('trap').some((t) => t.cls === 'panther' && !t.alive), (S) => S.done('b_panther'));
         S.when((S) => S.c.phase === 'out' && S.inZone('player', rally[0], rally[1], 45), (S) => {
            if (S.alive('mate') > 0) S.done('b_mate'); else S.fail('b_mate');
            if (S.get('b_panther').state === 'active') S.fail('b_panther');
            S.done('out'); S.radio('Am Sammelpunkt. Der Köder hat seinen Preis gekostet – aber nicht den ganzen Zug.');
            S.win('Aus der Falle entkommen');
         });
      },
   },
   halfaya: {
      id: 'halfaya', name: 'Höllenfeuerpass', place: 'Halfaya-Pass, ägyptisch-libysche Grenze', date: '15. Juni 1941', nation: 'UK',
      map: 'wueste', seed: 1541, tanks: ['matilda', 'crusader'], start0: [0, 430, 0], fog: 0.55,
      brief: [
         'Operation Battleaxe: Tobruk ist eingeschlossen, die 8. Armee soll die Grenze freikämpfen. Am Halfaya-Pass führt die Straße den Steilhang hinauf nach Libyen.',
         'Ein Sandsturm liegt über der Ebene. Vor uns weicht eine Gruppe Panzer III zurück. Die Matildas sollen nachstoßen und den Pass nehmen, bevor sich der Sturm legt.',
         'Die Panzerung der Matilda hält fast alles aus, was der Gegner hat. Fast alles.',
      ],
      goals: ['Die Panzer III zurückwerfen', 'Zum Pass nachstoßen', '???'],
      tip: 'Im Sturm sieht keiner weit. Wer offen auf einen Steilhang zufährt, wenn der Sturm sich legt, ist ein Ziel. Wadis geben Deckung.',
      script(S) {
         S.fog(0.55, 0xc6a676);                                   // ghibli: dust-brown, short sight
         const G = [[-40, -108], [45, -106]];
         for (const [x, dx] of [[-30, -18], [30, 18]]) S.spawn('matilda', 1, x, 440, { tag: 'mate', name: 'Matilda (4th RTR)', order: { kind: 'route', pts: [[x + dx, 250], [x + dx, 120]] } });
         for (const [x, z] of [[-90, 40], [10, 10], [110, 30]]) S.spawn('pz3e', 2, x, z, { tag: 'pz', name: 'Panzer III', aiErr: 2, viewMul: 0.8, ammo: { APCR: 0 }, order: { kind: 'hold', x, z } });
         S.obj('screen', 'Die Panzer III zurückwerfen');
         S.obj('pass', 'Zum Pass nachstoßen');
         S.obj('flak', 'Die 8,8-cm-Batterie am Pass ausschalten', { hidden: true, need: 2 });
         S.obj('b_mate', 'Mindestens eine weitere Matilda kommt durch', { bonus: true });
         S.obj('b_pz', 'Zwei Panzer III vernichten', { bonus: true, need: 2 });
         S.phase('advance'); S.goal(0, 140, 'Panzer III im Sturm', 40);
         this.start = (S) => S.radio('Hier Schwadron: Fritz zieht sich vor uns zurück. Dranbleiben, solange der Sturm uns deckt!');
         S.when(() => true, (S) => S.progress('b_pz', S.dead('pz')), { repeat: true });
         S.when((S) => S.alive('mate') === 0, (S) => S.fail('b_mate'));
         // the Panzer III fall back towards the pass as soon as the Matildas press: the bait
         S.when((S) => S.c.phase === 'advance' && (S.dead('pz') > 0 || S.time > 100 || S.inZone('player', 0, 30, 170)), (S) => {
            S.phase('pursue'); S.done('screen');
            S.radio('Sie weichen! Ihre Granaten prallen an uns ab. Nach, bis an den Pass!');
            S.order(S.group('pz').filter((t) => t.alive), { kind: 'route', pin: true, pts: [[0, -110], [0, -230], [-40, -330]] });
            S.order(S.group('mate').filter((t) => t.alive), { kind: 'route', pin: true, pts: [[-40, 20], [-20, -60]] });
            S.goal(0, -40, 'Passeingang', 40);
         });
         // the twist: the storm drops and shows the guns dug in on the slope: 8,8-cm-Flak in the ground role
         S.when((S) => S.c.phase === 'pursue' && (S.inZone('player', 0, -40, 270) || S.time > 220), (S) => {
            S.phase('guns'); S.fadeFog(0.12, 14, (S) => S.fog(0.1, 0xdccdb0));
            for (const [x, z] of G) S.spawn('pak40', 2, x, z, { tag: 'flak', name: '8,8-cm-Flak', exact: true, noAI: true, viewMul: 0.35, face: [0, 200] });
            S.after(10, (S) => { for (const t of S.group('flak')) if (t.alive) S.crewUp(t, { aiErr: 4 }); });   // crews still laying the guns
            // the crews still lay their guns on the Matildas in front and the dust settles: aim improves after a while
            S.after(30, (S) => { for (const t of S.group('flak')) { t.viewMul = 0.7; if (t.ai) t.ai.D = { ...t.ai.D, err: t.ai.D.err * 0.8 }; } });
            S.radio('Der Sturm legt sich … Geschütze am Hang! Lange Rohre – das ist Flak, 8,8!', 'warn');
            S.after(5, (S) => S.radio('Die gehen durch Matildas wie durch Pappe! Raus aus ihrem Schussfeld, ins Wadi nach Osten!', 'warn'));
            S.show('flak'); S.retext('pass', 'Ins Wadi Ost ausweichen');
            S.order(S.group('mate').filter((t) => t.alive), { kind: 'route', pin: true, pts: [[170, 170], [330, 80], [310, -10]] });
            S.mark('wadi', 310, -10, 'Wadi', 'area', 60); S.goal(310, -10, 'Wadi Ost', 35);
            if (S.autopilot && S.player) S.order([S.player], { kind: 'route', pin: true, pts: [[150, 190], [330, 90], [310, -10]] });
         });
         // from the wadi up the goat track in the east, then along the crest into the battery's flank
         S.when((S) => S.c.phase === 'guns' && (S.inZone('player', 310, -10, 60) || S.time > S._tg + 100), (S) => {
            S.done('pass'); S.phase('flank'); S.unmark('wadi'); S.refit(0.8, null);
            S.radio('Im Wadi, außer Sicht. Notdürftig geflickt. Der Hang hat im Osten einen Ziegenpfad. Hoch damit und von der Flanke rein – mit Sprenggranaten, wenn ihr habt.');
            S.mark('path', 385, -175, 'Ziegenpfad', 'area', 30);
            S.goal(385, -175, 'Ziegenpfad', 25);
            const swing = (S) => { for (const t of S.group('flak')) if (t.ai) t.ai.D = { ...t.ai.D, err: t.ai.D.err * 2.2, react: t.ai.D.react * 2.5 }; };   // they must manhandle 5 t of gun round
            // over the top and along the back of the escarpment: come down on the battery from behind
            S.zone(385, -175, 65, (S) => {
               S.unmark('path'); S.goal(170, -235, 'Hinter dem Hang', 30);
               S.radio('Oben. Jetzt hinter dem Kamm nach Westen – sie schauen alle nach Süden.');
               S.zone(170, -235, 45, (S) => { swing(S); S.hunt('flak', '8,8-cm-Flak'); });
            });
            S.after(160, (S) => { if (!S._hunt && S.alive('flak')) { S.unmark('path'); swing(S); S.hunt('flak', '8,8-cm-Flak'); } });
            S.order(S.group('mate').filter((t) => t.alive), { kind: 'route', pts: [[385, -175], [200, -200], [80, -150]] });
         });
         S.when((S) => S.c.phase === 'guns', (S) => { S._tg = S.time; });
         // a gun hit from behind, its trails pointing the wrong way and a Matilda closing in: the crew runs for it
         S.when((S) => S.c.phase === 'flank', (S) => {
            const p = S.player; if (!p?.alive) return;
            for (const t of S.group('flak')) {
               if (!t.alive || t.lastHitBy !== p.id) continue;
               const d = Math.hypot(p.pos.x - t.pos.x, p.pos.z - t.pos.z); if (d > 150) continue;
               const off = Math.abs(((Math.atan2(-(p.pos.x - t.pos.x), -(p.pos.z - t.pos.z)) - t.yaw + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
               if (off > 1.2) { S.w.damage(t, t.hp, p, 'shell'); S.radio('Die Bedienung lässt das Geschütz im Stich – sie rennen!'); }
            }
         }, { repeat: true });
         S.when((S) => S.c.phase !== 'advance', (S) => S.progress('flak', S.dead('flak')), { repeat: true });
         // last: the panzers come back through the pass to save their guns
         S.when((S) => S.isDone('flak'), (S) => {
            S._hunt = null; S.phase('counter'); S.refit(0.3, 'Batterie ausgeschaltet. Munitionsnachschub aus dem Wadi – schnell, die Panzer kommen zurück.');
            S.radio('Panzer III von Norden durch den Pass!', 'warn');
            for (const [x, dt] of [[-20, 0], [20, 10]]) S.after(dt, (S) => S.spawn('pz3e', 2, x, -420, { tag: 'pz2', name: 'Panzer III', aiErr: 1.7, ammo: { APCR: 0 }, order: { kind: 'route', pts: [[x, -250], [0, -150], [60, -150]] } }));
            S.after(12, (S) => S.hunt('pz2', 'Panzer III'));
         });
         // a Panzer III that will not come down off the escarpment for minutes gives up on the guns and turns back north
         S.when((S) => S.c.phase === 'counter' && S.time > S._tc + 200 && S.alive('pz2') > 0, (S) => {
            S.radio('Die restlichen Panzer III drehen ab, zurück nach Sollum. Sie lassen die Batterie liegen.');
            S._gone = true;
         });
         S.when((S) => S.c.phase === 'counter', (S) => { S._tc = S.time; });
         S.when((S) => S.c.phase === 'counter' && ((S.group('pz2').length === 2 && !S.alive('pz2')) || S._gone), (S) => {
            if (S.alive('mate') > 0) S.done('b_mate'); else S.fail('b_mate');
            if (S.get('b_pz').state === 'active') S.fail('b_pz');
            S.radio('Der Pass ist für heute unser. Die 8,8 im Erdkampf – das wird die ganze Armee lernen müssen.');
            S.win('Halfaya-Pass genommen');
         });
      },
   },
   bastogne: {
      id: 'bastogne', name: 'Die Kreuzung im Nebel', place: 'Noville bei Bastogne, Ardennen', date: '19.–23. Dezember 1944', nation: 'US',
      map: 'winter', seed: 1219, tanks: ['m4', 'm18'], start0: [-150, 330, 0], fog: 0.55,
      brief: [
         'Die deutsche Ardennenoffensive hat die Front aufgerissen. Bastogne mit seinen sieben Straßen muss gehalten werden, bis die 101. Luftlandedivision eingegraben ist.',
         'Ein Panzertrupp hält die Kreuzung nördlich der Stadt. Nebel und Schnee, kein Flugwetter. Was aus dem Weiß auftaucht, ist meistens deutsch.',
         'Die Militärpolizei warnt vor deutschen Soldaten in amerikanischen Uniformen hinter den Linien. Traut niemandem, den ihr nicht kennt.',
      ],
      goals: ['Die Kreuzung gegen den Angriff halten', '???', 'Bei klarem Wetter zum Gegenstoß antreten'],
      tip: 'Im Nebel zuerst schießen, wer zuerst sieht. Achte auf die Silhouette: Nicht jeder „Freund“ ist einer.',
      script(S) {
         S.fog(0.55, 0xdde2e6);                                   // freezing fog over the snow
         const X = [-190, 70];                                    // the crossroads on the road north
         S.spawn('m18', 1, -235, 95, { tag: 'mate', name: 'M18 (705th TD)', order: { kind: 'ambush', x: -235, z: 95, r: 260 } });
         S.spawn('m4', 1, -140, 105, { tag: 'mate', name: 'Sherman (Team Desobry)', order: { kind: 'ambush', x: -140, z: 105, r: 260 } });
         S.obj('hold', 'Die Kreuzung halten', { need: 4 });
         S.obj('greif', 'Die falschen Amerikaner stellen', { hidden: true, need: 2 });
         S.obj('ctr', 'Gegenstoß: die Bereitstellung am Gehöft zerschlagen', { hidden: true, need: 3 });
         S.obj('b_spy', 'Den Schwindel erkennen, bevor sie schießen', { bonus: true, hidden: true });
         S.obj('b_mate', 'Kein Fahrzeug des Trupps verloren', { bonus: true });
         S.phase('hold');
         const [hx, hz] = S.hullDown(X[0], X[1], 25, -150, -300);
         S.mark('x', X[0], X[1], 'Kreuzung', 'area', 60); S.goal(hx, hz, 'Kreuzung – Stellung', 18);
         this.start = (S) => S.radio('Hier Desobry: Haltet die Kreuzung. Wir hören Motoren im Nebel, Richtung Norden. Lasst sie nah rankommen.');
         const wave = (S, list) => list.forEach(([c, dx, dt]) => S.after(dt, (S) => S.spawn(c, 2, -80 + dx, -470, { tag: 'w', name: c === 'panther' ? 'Panther' : 'Panzer IV', aiErr: 1.7, viewMul: 0.8,
            order: { kind: 'route', pts: [[-90 + dx, -300], [-200 + dx, -100], [X[0] + dx * 0.4, X[1] - 20]] } })));
         S.after(15, (S) => { wave(S, [['pz4h', 0, 0], ['pz4h', 30, 12]]); S.radio('Panzer auf der Straße, aus dem Nebel – Feuer frei auf Sicht!', 'warn'); });
         S.when((S) => S.c.phase === 'hold' && (S.dead('w') >= 2 || S.time > 160), (S) => { wave(S, [['panther', -20, 0], ['pz4h', 25, 14]]); S.radio('Zweite Welle! Ein Panther dabei – auf die Seite zielen, frontal ist er zu stark.', 'warn'); });
         S.when(() => true, (S) => S.progress('hold', S.dead('w')), { repeat: true });
         S.when((S) => S.dead('mate') > 0, (S) => S.fail('b_mate'));
         // the twist: "M10s" from the rear, cut off at Foy, ask to be let through. They are Panthers in disguise (Operation Greif).
         let fake = [], hitFirst = false;
         S.when((S) => S.isDone('hold'), (S) => {
            S.phase('greif'); S.refit(0.35, 'Jeep mit Munition durchgekommen. Auffüllen – und Augen offen.');
            S.radio('Ein M10 und ein Sherman von Süden, versprengt aus Foy. Sie wollen durch zur Kreuzung. Nicht schießen.');
            fake = [[160, 470, 'panther', 'M10 (versprengt)'], [195, 490, 'm4', 'Sherman (versprengt)']].map(([x, z, c, n]) => S.spawn(c, 1, x, z, { tag: 'fake', name: n, aiErr: 2.6, viewMul: 0.7,
               order: { kind: 'route', pin: true, pts: [[40, 320], [X[0] + 40, X[1] + 60], [X[0], X[1]]] } }));
            for (const t of fake) t.hp = t.maxHP * (t.cls === 'panther' ? 0.35 : 0.8);          // hard-used, short of fuel and spares
            S.after(14, (S) => S.radio('MP an alle: Fragt nach der Hauptstadt von Illinois. Wer nicht Springfield sagt, ist kein Ami.'));
            S.show('b_spy');
         });
         const unmask = (S, early) => {
            if (S.c.phase !== 'greif') return; S.phase('unmask');
            hitFirst = early; S.defect(fake.filter((t) => t.alive), 2);
            for (const t of fake) { t.name = t.cls === 'panther' ? 'Panther (getarnt)' : 'Beute-Sherman'; if (t.alive) S.order([t], { kind: 'advance', x: S.player?.pos.x ?? X[0], z: S.player?.pos.z ?? X[1] }); }
            S.show('greif'); S.hunt('fake', 'Falsche M10');
            S.radio(early ? 'Gut aufgepasst! Ein Panther mit aufgeschweißten Blechen und ein Beute-Sherman – deutsche Besatzungen!' : 'Die schießen auf uns! Ein getarnter Panther und ein Beute-Sherman – das sind Deutsche!', 'warn');
         };
         S.when((S) => S.c.phase === 'greif' && fake.some((t) => t.lastDamaged > 0 && t.lastHitBy === S.player?.id), (S) => unmask(S, true));
         S.when((S) => S.c.phase === 'greif' && fake.some((t) => t.alive && (S.inZone('player', t.pos.x, t.pos.z, 170) || S.countIn('mate', t.pos.x, t.pos.z, 120) > 0)), (S) => unmask(S, false));
         S.when((S) => S.c.phase === 'unmask', (S) => S.progress('greif', fake.filter((t) => !t.alive).length), { repeat: true });
         // last: the fog lifts (23 Dec), the fighter-bombers come and the troop turns to the counter-attack
         S.when((S) => S.c.phase === 'unmask' && S.isDone('greif'), (S) => {
            S._hunt = null; S.phase('clear'); if (hitFirst) S.done('b_spy'); else S.fail('b_spy');
            S.refit(0.4, 'Ein paar Tage später: Der Himmel reißt auf. Kälte, Sonne – Flugwetter!');
            S.fadeFog(0.04, 25);
            for (const [c, x, z] of [['pz4h', 100, -250], ['stug3g', 150, -215], ['panther', 60, -210]]) { const t = S.spawn(c, 2, x, z, { tag: 'ctr', name: TANKS[c].short, aiErr: 2, viewMul: 0.7, order: { kind: 'hold', x, z } }); if (c === 'panther') t.hp = t.maxHP * 0.6; }   // the Panther limped back from the night's fighting
            S.after(10, (S) => { S.radio('Thunderbolts über der Bereitstellung am Gehöft! Jetzt nach, solange sie die Köpfe einziehen!', 'warn'); S.strike(0, 0, 9, { tag: 'ctr', n: 10, secs: 16, dmg: 340, team: 2 }); });
            S.after(14, (S) => { S.show('ctr'); S.hunt('ctr', 'Bereitstellung'); S.order(S.group('mate').filter((t) => t.alive), { kind: 'advance', x: 100, z: -200 }); });
         });
         S.when((S) => S.c.phase === 'clear', (S) => S.progress('ctr', S.dead('ctr')), { repeat: true });
         S.every(70, (S) => { if (S.c.phase === 'clear' && S.alive('ctr')) { S.radio('Die Thunderbolts kommen noch einmal herum.'); S.strike(0, 0, 14, { tag: 'ctr', n: 4, secs: 8, dmg: 320, team: 2 }); } });
         S.when((S) => S.c.phase === 'clear' && S.isDone('ctr'), (S) => {
            if (S.get('b_mate').state === 'active') S.done('b_mate');
            S.radio('Die Bereitstellung brennt. Bastogne hält – und die Straßen gehören wieder uns.');
            S.win('Kreuzung gehalten, Gegenstoß gelungen');
         });
      },
   },
   raseiniai: {
      id: 'raseiniai', name: 'Der Koloss von Raseiniai', place: 'Brückenkopf an der Dubysa bei Raseiniai, Litauen', date: '24. Juni 1941', nation: 'DE',
      map: 'waldhuegel', seed: 2461, tanks: ['pz3e', 'pz2'], start0: [440, 95, Math.PI / 2],
      brief: [
         'Dritter Tag des Unternehmens Barbarossa. Die Kampfgruppe Raus hält einen Brückenkopf über die Dubysa. Ihre einzige Nachschubstraße führt durch den Wald nach Osten.',
         'Seit dem Morgen kommt nichts mehr durch. Zwölf Lastwagen brennen auf der Straße, die Verwundeten können nicht zurück. Irgendetwas steht da vorne und schießt alles zusammen.',
         'Fahrt vor und seht nach, was die Straße sperrt. Unsere Pak hat bisher alles geknackt, was ihr vor das Rohr kam. Bisher.',
      ],
      goals: ['Die Straßensperre aufklären', '???', 'Die Straße wieder freikämpfen'],
      tip: 'Nicht alles, was man trifft, kann man auch durchschlagen. Manchmal ist die beste Waffe eines Panzers, dass der Gegner auf ihn schießt.',
      script(S) {
         const K = [-70, -18];                                     // the KV on the road, a little west of the hollow
         const kv = S.spawn('kv1', 2, K[0], K[1], { tag: 'kv', name: 'KW-1 (Straßensperre)', aiErr: 2.6, viewMul: 0.75, face: [440, 95], order: { kind: 'hold', x: K[0], z: K[1] } });
         S.spawn('pz2', 1, 455, 120, { tag: 'mate', name: 'Panzer II (Lt. Wenk)', order: { kind: 'hold', x: 380, z: 115 } });
         S.obj('scout', 'Die Straßensperre aufklären');
         S.obj('decoy', 'Den KW ablenken: am Waldrand sein Feuer auf euch ziehen', { hidden: true });
         S.obj('relief', 'Den sowjetischen Entsatz abwehren', { hidden: true, need: 3 });
         S.obj('b_clean', 'Beim Aufklären keinen Treffer einstecken', { bonus: true });
         S.obj('b_flak', 'Die zweite Flak übersteht den Gegenangriff', { bonus: true, hidden: true });
         S.obj('b_dodge', 'Beim Ablenken höchstens einen schweren Treffer', { bonus: true });
         S.phase('scout');
         const [ox, oz] = S.hullDown(170, 15, 24, K[0], K[1]);
         S.goal(ox, oz, 'Beobachtungspunkt', 14);
         this.start = (S) => S.radio('Hier Raus: Fahrt vor bis an den Waldrand und meldet, was die Straße sperrt. Nicht angreifen, nur sehen.');
         let hp0 = 0, flak2 = null;
         S.when((S) => S.c.phase === 'scout' && S.player && S.player.hp < S.player.maxHP - 1, (S) => S.fail('b_clean'));
         // spotted: a KV-1, 45 t, armour no gun of ours goes through. The 8,8 is brought up and knocked out before it fires twice
         S.when((S) => S.c.phase === 'scout' && (kv.spotted || S.time > 150), (S) => {
            S.phase('flak'); S.done('scout'); if (S.get('b_clean').state === 'active') S.done('b_clean');
            S.radio('Ein Ungetüm auf der Straße – ein russischer Schwerer, ein KW! Unsere Granaten springen ab wie Erbsen!', 'warn');
            S.after(6, (S) => S.radio('Raus an alle: Wir ziehen eine 8,8 nach vorn. Haltet still, bis sie steht.'));
            const flak = S.spawn('pak40', 1, 300, 60, { tag: 'flak', name: '8,8-cm-Flak', exact: true, noAI: true, face: K });
            S.mark('flak', 300, 60, '8,8-cm-Flak', 'area', 20);
            S.after(14, (S) => S.radio('Die Flak geht in Stellung … sie richtet …'));
            S.after(22, (S) => {
               S.w.effect('explosion', { x: K[0] + 25, y: S.T.heightAt(K[0] + 25, K[1] + 10), z: K[1] + 10 }, { cal: 88, size: 2, life: 2 });
               S.radio('Daneben! Der KW dreht den Turm –', 'warn');
            });
            S.after(27, (S) => {
               if (flak.alive) { S.w.effect('explosion', { x: flak.pos.x, y: flak.pos.y + 1, z: flak.pos.z }, { cal: 76, size: 2, life: 2 }); S.w.damage(flak, flak.hp, kv, 'shell'); }
               S.unmark('flak');
               S.radio('Volltreffer auf die Flak! Die Bedienung … keiner rührt sich mehr.', 'warn');
            });
            // the twist: a second gun goes round through the wood behind the KV; it needs the KV looking the other way
            S.after(33, (S) => {
               S.phase('decoy'); S.show('decoy'); if (kv.ai) kv.ai.D = { ...kv.ai.D, err: kv.ai.D.err * 2 };   // a fast target weaving between the trees
               S.refit(1, null); hp0 = S.player?.hp ?? 0;
               S.radio('Raus: Wir bringen die zweite 8,8 durch den Wald in seinen Rücken. Dafür muss er nach vorn schauen – auf euch. Zeigt euch am Waldrand und bleibt in Bewegung!', 'warn');
               const [dx, dz] = [130, -45];
               S.mark('edge', dx, dz, 'Waldrand', 'area', 55); S.goal(dx, dz, 'Waldrand – Feuer auf euch ziehen', 30);
               // a moving target: the autopilot weaves along the wood edge
               if (S.autopilot && S.player?.ai) S.player.ai.careful = false;   // no stopping to trade shots it cannot win
               if (S.autopilot && S.player) S.order([S.player], { kind: 'route', pin: true, pts: [[dx + 20, dz + 35], [dx - 15, dz - 25], [dx + 25, dz - 30], [dx - 10, dz + 30], [dx + 10, dz]] });
               S.holdZone('KW ablenken', dx, dz, 60, 35, (S) => {
                  S.done('decoy'); S.unmark('edge'); if (S.autopilot && S.player?.ai) S.player.ai.careful = true;
                  if (S.get('b_dodge').state === 'active') S.done('b_dodge');
                  S.phase('kill'); kv.viewMul = 0;   // the turret swings round to the gun behind it
                  S.radio('Die zweite Flak steht – 200 Meter hinter ihm. Feuer!');
                  flak2 = S.spawn('pak40', 1, K[0] - 190, K[1] - 45, { tag: 'flak2', name: '8,8-cm-Flak (2)', exact: true, noAI: true, face: K });
                  for (let i = 0; i < 4; i++) S.after(2 + i * 3, (S) => {
                     if (!kv.alive) return;
                     S.w.effect('explosion', { x: kv.pos.x, y: kv.pos.y + 1.5, z: kv.pos.z }, { cal: 88, size: 2.5, life: 2 });
                     S.w.damage(kv, kv.maxHP * 0.22, null, 'shell');
                     if (i === 0) for (const m of ['trackL', 'engine']) if (kv.modules[m]) kv.modules[m].state = 'destroyed';
                  });
                  S.after(8, (S) => S.radio('Treffer, Treffer! Er rührt sich nicht mehr … der Turm dreht noch!', 'warn'));
                  S.after(16, (S) => {
                     if (kv.alive) S.w.damage(kv, kv.hp, null, 'shell');
                     S.radio('Pioniere sind dran: geballte Ladungen auf den Motor. Er brennt!');
                     S.after(6, (S) => relief(S));
                  });
               }, { contest: false });
            });
         });
         S.every(0.5, (S) => { if (S.c.phase === 'decoy' && S.autopilot && S.player?.ai) S.player.ai.flankT = 3; });   // manoeuvring: no stopping to trade shots
         S.when((S) => S.c.phase === 'decoy' && S.player && S.player.hp < hp0 - S.player.maxHP * 0.45, (S) => S.fail('b_dodge'));
         // last: from the bridgehead's far side a Soviet tank company comes up the road to its KV
         const relief = (S) => {
            S.phase('relief'); S.show('relief'); S.show('b_flak');
            if (flak2?.alive) { flak2.yaw = Math.atan2(470 + flak2.pos.x, 95 + flak2.pos.z); flak2.pose?.(); }   // swung round to the west road
            if (flak2?.alive) S.crewUp(flak2, { aiErr: 1.6, order: { kind: 'hold', x: flak2.pos.x, z: flak2.pos.z } });
            S.refit(0.85, 'Die Straße ist frei. Munition kommt nach vorn – und von Westen hört man Ketten.');
            for (const [c, dz, dt] of [['t26', -20, 0], ['bt7', 20, 18], ['t26', 0, 36]]) S.after(dt, (S) => S.spawn(c, 2, -470, -95 + dz, { tag: 'rel', name: TANKS[c].short, aiErr: 2.8, viewMul: 0.75,
               order: { kind: 'route', pts: [[-260, -50 + dz], [-120, -20 + dz], [40, 10]] } }));
            S.after(4, (S) => { S.radio('Leichte russische Panzer, T-26 und BT, auf der Straße von Westen! Die wollen zu ihrem KW – haltet sie auf!', 'warn'); S.hunt('rel', 'Entsatz'); });
            S.order(S.group('mate').filter((t) => t.alive), { kind: 'advance', x: 120, z: 30 });
         };
         S.when((S) => S.c.phase === 'relief', (S) => S.progress('relief', S.dead('rel')), { repeat: true });
         S.when((S) => S.c.phase === 'relief' && S.isDone('relief'), (S) => {
            if (flak2?.alive) S.done('b_flak'); else S.fail('b_flak');
            S.radio('Die Straße ist frei. Ein einziger Panzer hat eine ganze Kampfgruppe einen Tag lang aufgehalten. Das wird man sich merken.');
            S.win('Nachschubstraße frei');
         });
      },
   },
};
export const OP_LIST = ['westwall', 'arracourt', 'lasttiger', 'danzig', 'seelow', 'spaehtrupp', 'beute', 'totalize', 'koeder', 'halfaya', 'bastogne', 'raseiniai'];
