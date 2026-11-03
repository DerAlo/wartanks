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
      h.off = best === h.cur ? Math.max(6, (h.off ?? 35) - 14) : 35;
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

   // ------------------------------------------------------------ triggers
   /** fn(S) runs once when cond(S) becomes true (or every time with { repeat: true }) */
   when(cond, fn, o = {}) { this.triggers.push({ cond, fn, repeat: !!o.repeat, dead: false }); }
   at(t, fn) { this.when(() => this.w.time >= t, fn); }
   after(dt, fn) { const t0 = this.w.time; this.when(() => this.w.time >= t0 + dt, fn); }
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
            if (Math.hypot(t.pos.x - (p.x ?? p[0]), t.pos.z - (p.z ?? p[1])) < 22) { o.i = (o.i || 0) + 1; t.ai.setDest(t.ai.chooseDest()); }
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
            S.goal(0, 80, 'Pak-Riegel'); S.order(S.group('allies'), { kind: 'advance', x: 0, z: 60 });
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
};
export const OP_LIST = ['westwall', 'arracourt', 'lasttiger', 'danzig', 'seelow'];
