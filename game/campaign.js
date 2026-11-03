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

   // ------------------------------------------------------------ units
   /** Spawn a tank or emplacement (cls in TANKS) for team 1|2 at x, z. o: { yaw, name, tag, order } */
   spawn(cls, team, x, z, o = {}) {
      const w = this.w, T = this.T;
      x = Math.max(-T.half + 15, Math.min(T.half - 15, x)); z = Math.max(-T.half + 15, Math.min(T.half - 15, z));
      // emplacements face the attacker's start (or o.face) unless a yaw is given
      const f = o.face || (cfgSite(cls) && this.op.start0);
      const yaw = o.yaw ?? (f ? Math.atan2(-(f[0] - x), -(f[1] - z)) : team === 1 ? 0 : Math.PI);
      const cfg = TANKS[cls];
      const t = w.addTank(cls, team, { x, z, yaw, name: o.name || cfg.name, isPlayer: !!o.isPlayer });
      t.placeOn?.(T);
      t.tag = o.tag || null;
      if (o.tag) { if (!this.tags.has(o.tag)) this.tags.set(o.tag, []); this.tags.get(o.tag).push(t); }
      if (w.ais && !o.isPlayer) {                     // after construction World does not wire these
         t.side = w.player && t.team === w.player.team ? 'ally' : 'enemy';
         if (!t.noAI && this.started) { const ai = new BotAI(w, t); w.ais.push(ai); t.ai = ai; }
      }
      if (o.order) (t._order = o.order);
      if (t.ai && t._order) this.order([t], t._order);
      return t;
   }
   group(tag) { return this.tags.get(tag) || []; }
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
      for (const tr of this.triggers) {
         if (tr.dead) continue;
         if (tr.cond(this)) { if (!tr.repeat) tr.dead = true; tr.fn(this); if (w.phase !== 'playing') return; }
      }
      if (this.triggers.length > 64) this.triggers = this.triggers.filter((t) => !t.dead);
      if (w.player && !w.player.alive && !this.op.playerMayDie) this.lose('Eigener Panzer zerstört');
   }
   _start() {
      this.started = true;
      // AIs for everything spawned during setup exist now (World wired them); re-issue orders
      for (const t of this.w.tanks) if (t.ai && t._order) this.order([t], t._order);
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
   if (opts.playerCls === null) { S.autopilot = true; world.player = p; p.isPlayer = false; }
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
         for (const [x, z] of [[-200, 10], [190, 0], [10, -60]]) S.spawn('pak40', 2, x, z, { tag: 'pak', order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-60, 420], [60, 420], [120, 430]]) S.spawn('m4a3e8', 1, x, z, { tag: 'allies', name: 'Sherman', order: { kind: 'advance', x: x * 0.3, z: zL + 40 } });
         S.obj('gap', 'Durch die Lücke in der Höckerlinie vorstoßen');
         S.obj('bunker', 'Bunker ausschalten', { need: 2 });
         S.obj('pak', 'PaK-Stellungen zerstören', { need: 3 });
         S.obj('counter', 'Gegenangriff abwehren', { hidden: true });
         S.obj('b_allies', 'Mindestens zwei Shermans überleben', { bonus: true });
         S.obj('b_time', 'Westwall in 9 Minuten durchbrechen', { bonus: true });
         S.goal(0, zL, 'Lücke');
         this.start = (S) => S.radio('Hier Kampfgruppe B: Die Pioniere haben eine Lücke in die Höcker gesprengt. Vorwärts, Marsch!');
         S.when((S) => S.w.tanks.some((t) => t.team === 1 && t.alive && t.pos.z < zL - 12), (S) => {
            S.done('gap'); S.radio('Wir sind durch die Höcker. Bunker vor uns – auf die Scharten zielen!');
            S.goal(0, 35, 'Bunkerlinie'); S.order(S.group('allies'), { kind: 'advance', x: 0, z: 40 });
         });
         S.when((S) => true, (S) => { S.progress('bunker', S.dead('bunker')); S.progress('pak', S.dead('pak')); }, { repeat: true });
         S.when((S) => S.isDone('bunker') && S.isDone('pak'), (S) => {
            if (S.time < 540) S.done('b_time'); else S.fail('b_time');
            S.show('counter'); S.phase('counter');
            S.radio('Achtung! Deutsche Panzer im Anmarsch aus Nordost – Gegenstoß!', 'warn');
            for (const [x, z] of [[160, -420], [200, -440], [-150, -430]]) S.spawn('pz4h', 2, x, z, { tag: 'counter', name: 'Panzer IV', order: { kind: 'advance', x: 0, z: 40 } });
            S.goal(0, 0, 'Stellung halten');
         });
         S.when((S) => S.c.phase === 'counter' && S.group('counter').length && S.alive('counter') === 0, (S) => {
            S.done('counter');
            if (S.alive('allies') >= 2) S.done('b_allies'); else S.fail('b_allies');
            S.radio('Gegenangriff abgeschlagen. Die Bresche ist offen – gut gemacht!');
            S.win('Westwall durchbrochen');
         });
         S.when((S) => S.alive('allies') < 2, (S) => S.fail('b_allies'));
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
         const zig = (z) => { const pts = []; for (let x = -420; x <= 420; x += 40) pts.push([x, z + ((x / 40) % 2 ? 8 : -8)]); return pts; };
         S.T.carveTrench?.(zig(250), { w: 2.5, d: 1.8 }); S.T.carveTrench?.(zig(60), { w: 3, d: 2 });
         for (let x = -300; x <= 300; x += 120) S.T.addObject?.({ kind: 'wire', x, z: 280, yaw: 0 });
         for (const [x, z] of [[-220, 150], [-60, 120], [90, 135], [240, 150], [-130, 20], [140, 10]]) S.spawn('pak40', 2, x, z, { tag: 'pak', order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-80, -160], [90, -170]]) S.spawn('pz4h', 2, x, z, { tag: 'def', name: 'Panzer IV', order: { kind: 'hold', x, z } });
         S.spawn('tiger2', 2, 0, -260, { tag: 'tiger', name: 'Königstiger (s.SS-Pz.Abt. 502)', order: { kind: 'ambush', x: 0, z: -260, r: 260 } });
         for (const [x, z, c] of [[-70, 440, 'is2'], [70, 440, 't34_85'], [140, 450, 't34_85']]) S.spawn(c, 1, x, z, { tag: 'allies', name: c === 'is2' ? 'IS-2' : 'T-34-85', order: { kind: 'advance', x: x * 0.5, z: 200 } });
         S.obj('trench1', 'Erste Grabenlinie überwinden');
         S.obj('pak', 'PaK-Stellungen zerstören', { need: 6 });
         S.obj('hill', 'Die Höhe einnehmen (30 s halten)');
         S.obj('b_tiger', 'Den Königstiger vernichten', { bonus: true, hidden: true });
         S.obj('b_allies', 'Kein eigener Panzer verloren', { bonus: true });
         S.goal(0, 205, 'Grabenlinie');
         this.start = (S) => S.radio('Alle Einheiten: Vorwärts über den Graben! Die Artillerie hält den Höhenrand nieder.');
         S.when((S) => S.player && S.player.pos.z < 238, (S) => {
            S.done('trench1'); S.radio('Erster Graben genommen. Pak-Nester am Hang – mit Sprenggranaten ausräuchern!');
            S.goal(0, 80, 'Pak-Riegel'); S.order(S.group('allies'), { kind: 'advance', x: 0, z: 60 });
         });
         S.when(() => true, (S) => S.progress('pak', S.dead('pak')), { repeat: true });
         let held = 0;
         S.when((S) => S.isDone('pak'), (S) => { S.goal(0, -200, 'Höhe', 60); S.radio('Der Weg auf die Höhe ist frei. Nehmt den Kamm!'); S.order(S.group('allies'), { kind: 'advance', x: 0, z: -190 }); });
         S.when((S) => S.group('tiger')[0]?.spotted, (S) => { S.show('b_tiger'); S.radio('Königstiger auf dem Kamm! Flanke angreifen!', 'warn'); });
         S.when((S) => S.alive('tiger') === 0, (S) => { S.show('b_tiger'); S.done('b_tiger'); });
         S.when((S) => S.dead('allies') > 0, (S) => S.fail('b_allies'));
         S.when((S) => S.isDone('pak') && S.countIn(1, 0, -200, 70) > 0 && S.enemyTanksAlive() <= 1, (S) => {
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
         const br = S.T.bridges?.[0] || { x: 0, z: 0 }, bx = br.x ?? 0, bz = br.z ?? 0;
         S.player.pos.x = bx; S.player.pos.z = bz + 90; S.player.placeOn?.(S.T);
         S.obj('hold', 'Den Brückenkopf halten, bis die Nachhut drüben ist');
         S.obj('back', 'Über die Brücke ans Nordufer zurückziehen', { hidden: true });
         S.obj('b_kills', '10 Feindpanzer vernichten', { bonus: true, need: 10 });
         S.obj('b_pershing', 'Den M26 Pershing vernichten', { bonus: true, hidden: true });
         S.goal(bx, bz + 70, 'Brückenkopf', 50); S.timer('Nachhut über den Fluss', 480);
         this.start = (S) => S.radio('Nachhut an Tiger: Noch acht Minuten, dann sind alle drüben. Haltet sie uns vom Leib!');
         let wave = 0, killed = 0;
         const waves = [
            [['m4a3e8', -120], ['m4a3e8', 0], ['m4a3e8', 120]],
            [['m18', -220], ['m4a3e8', -60], ['m4a3e8', 80], ['m18', 220]],
            [['m26', 0], ['m4a3e8', -150], ['m4a3e8', 150], ['m18', 260]],
         ];
         const send = (S) => {
            const list = waves[wave++]; if (!list) return;
            for (const [c, dx] of list) S.spawn(c, 2, bx + dx, 470, { yaw: 0, tag: c === 'm26' ? 'pershing' : 'wave', name: TANKS[c].short || TANKS[c].name, order: { kind: 'advance', x: bx + dx * 0.25, z: bz + 70 } });
            S.radio(['Feindpanzer im Süden – Shermans!', 'Zweite Welle, Jagdpanzer an den Flanken!', 'Schwerer Panzer dabei – ein Pershing!'][wave - 1], 'warn');
            if (wave === 3) S.show('b_pershing');
         };
         S.at(15, send); S.at(150, send); S.at(300, send);
         S.when(() => true, (S) => { killed = S.dead('wave') + S.dead('pershing'); S.progress('b_kills', killed); if (S.group('pershing').length && !S.alive('pershing')) S.done('b_pershing'); }, { repeat: true });
         S.when((S) => S.c.timer && S.c.timer.left <= 0, (S) => {
            S.done('hold'); S.show('back'); S.phase('retreat'); S.timer('Brücke wird gesprengt', 90);
            S.radio('Alle sind drüben! Tiger, zurück über die Brücke – die Pioniere warten auf euch!');
            S.goal(bx, bz - 70, 'Nordufer', 30);
         });
         S.when((S) => S.c.phase === 'retreat' && S.player && S.player.pos.z < bz - 45, (S) => {
            S.done('back'); S.T.blowBridge?.(br); S.radio('Brücke gesprengt. Für euch ist der Krieg hier zu Ende – ihr habt sie alle rübergebracht.');
            S.win('Nachhut gerettet');
         });
         S.when((S) => S.c.phase === 'retreat' && S.c.timer && S.c.timer.left <= 0, (S) => S.lose('Die Brücke flog ohne euch in die Luft'));
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
         const sea = S.T.shipSpot || { x: 60, z: -300, yaw: Math.PI / 2 };
         S.spawn('tboat', 2, sea.x, sea.z, { yaw: sea.yaw, tag: 'ship', name: 'Torpedoboot T 36', order: { kind: 'hold', x: sea.x, z: sea.z } });
         for (const [x, z] of [[-160, -60], [-20, -80], [130, -70], [250, -40]]) S.spawn('pak40', 2, x, z, { tag: 'pak', order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-60, -110], [80, -120]]) S.spawn('pz4h', 2, x, z, { tag: 'def', name: 'Panzer IV', order: { kind: 'hold', x, z } });
         for (const [x, z] of [[-80, 430], [80, 430]]) S.spawn('t34_85', 1, x, z, { tag: 'allies', name: 'T-34-85', order: { kind: 'advance', x: x * 0.5, z: -50 } });
         S.obj('coast', 'Küstenstellung ausheben (PaK und Panzer)', { need: 6 });
         S.obj('ship', 'Das Torpedoboot versenken');
         S.obj('b_fast', 'Das Boot innerhalb von 10 Minuten versenken', { bonus: true });
         S.obj('b_allies', 'Beide T-34 überleben', { bonus: true });
         S.goal(0, -60, 'Küstenstellung');
         this.start = (S) => S.radio('Genossen, das Boot schießt schon! Rein in die Dünen, nicht stehen bleiben!');
         S.every(20, (S) => { const sh = S.group('ship')[0]; if (sh?.alive && S.rng() < 0.4) S.radio('Einschläge vom Torpedoboot – Volltreffer in der Nähe!', 'warn'); });
         S.when(() => true, (S) => S.progress('coast', S.dead('pak') + S.dead('def')), { repeat: true });
         S.when((S) => S.isDone('coast'), (S) => { const sh = S.group('ship')[0]; S.goal(sh.pos.x, sh.pos.z + 120, 'Mole'); S.radio('Die Küste ist frei. Jetzt das Boot – an die Mole und Feuer frei!'); });
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
      map: 'dorf', seed: 919, tanks: ['m18', 'm4a3e8'], start0: [0, 200, 0], fog: 0.65,
      brief: [
         'Lothringen, Morgennebel. Die 4. Panzerdivision hält einen Bogen um Arracourt; die deutsche Panzer-Brigade 113 greift mit neuen Panthern an.',
         'Im Nebel zählt nicht die Panzerung, sondern wer zuerst schießt. Die M18 Hellcats der 704. Panzerjägerabteilung liegen in Hinterhalten am Hang.',
         'Lasst die Panther nah heran, trefft die Seiten und wechselt nach jedem Schuss die Stellung. Der Gefechtsstand im Dorf darf nicht fallen.',
      ],
      goals: ['Panzerangriff abwehren', 'Gefechtsstand halten'],
      tip: 'Im Nebel sieht man kaum 150 m weit. Aus dem Busch feuern und dann umsetzen.',
      script(S) {
         const cp = { x: 0, z: 260 };
         S.obj('kill', 'Angreifende Panzer vernichten', { need: 10 });
         S.obj('cp', 'Gefechtsstand halten (kein Feind im Dorf)');
         S.obj('b_ally', 'Kein Hellcat verloren', { bonus: true });
         S.obj('b_ace', '5 Abschüsse selbst erzielen', { bonus: true, need: 5 });
         for (const [x, z] of [[-160, 120], [170, 110]]) S.spawn('m18', 1, x, z, { tag: 'allies', name: 'M18 Hellcat', order: { kind: 'ambush', x, z, r: 160 } });
         S.goal(0, 120, 'Hinterhalt', 40); S.mark('cp', cp.x, cp.z, 'Gefechtsstand', 'area', 60);
         this.start = (S) => S.radio('Hier Gefechtsstand: Motorengeräusche im Nebel, Richtung Nord. Feuer erst auf kurze Distanz!');
         const W = [[['panther', -100], ['panther', 60]], [['pz4h', -200], ['panther', 0], ['pz4h', 200]], [['panther', -120], ['panther', 120], ['pz4h', 0], ['panther', 240]]];
         let wave = 0;
         const send = (S) => {
            const list = W[wave++]; if (!list) return;
            for (const [c, dx] of list) S.spawn(c, 2, dx, -440, { yaw: Math.PI, tag: 'att', name: TANKS[c].short || TANKS[c].name, order: { kind: 'route', pts: [[dx * 0.7, -150], [dx * 0.3, 80], [cp.x, cp.z]] } });
            S.radio(wave === 1 ? 'Panther im Nebel – zwei Stück!' : wave === 2 ? 'Neue Welle, Panzer IV und Panther!' : 'Starke Kräfte, die ganze Brigade kommt!', 'warn');
         };
         S.at(10, send); S.at(150, send); S.at(300, send);
         S.when(() => true, (S) => { S.progress('kill', S.dead('att')); S.progress('b_ace', S.player?.stats?.kills || 0); }, { repeat: true });
         S.when((S) => S.alive('allies') < 2, (S) => S.fail('b_ally'));
         let lost = 0;                    // the CP falls after 20 s with an enemy tank inside
         S.when((S) => S.countIn('att', cp.x, cp.z, 60) > 0, (S) => {
            lost += 0.25; S.timer('Gefechtsstand fällt', Math.max(0, 20 - lost));
            if (lost === 0.25) S.radio('Feindpanzer am Gefechtsstand!', 'warn');
            if (lost >= 20) { S.fail('cp'); S.lose('Gefechtsstand überrannt'); }
         }, { repeat: true });
         S.when((S) => S.isDone('kill'), (S) => { S.done('cp'); if (S.alive('allies') >= 2) S.done('b_ally'); S.win('Angriff abgewehrt'); });
      },
   },
};
export const OP_LIST = ['westwall', 'arracourt', 'lasttiger', 'danzig', 'seelow'];
