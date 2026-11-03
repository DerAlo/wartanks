// game/missions.js — battle modes and matchmaking (pure sim).
//
//   MISSIONS[id] = { id, name, desc, teamSize, timeLimit (s|null), countdown, setup(world, opts), tick?(world, dt), noEnd? }
//   MISSION_LIST, matchmake(playerCls, teamSize, rng) -> { team1:[cls...], team2:[cls...] } (team1[0] = player)
//   botName(rng, used)  German crew names for bots
// opts.roster = { team1:[cls...], team2:[cls...] } overrides matchmaking (team1[0] = the player,
// or opts.playerCls = null for a bots-only battle, e.g. headless tests).
import { TANKS, TANK_LIST } from './config.js';
import { makeRng, hashSeed } from './utils.js';
import { OPS, setupCampaign } from './campaign.js';

const RANKS = ['Gefr.', 'Uffz.', 'Fw.', 'Ofw.', 'Lt.', 'Oblt.', 'Hptm.'];
const NAMES = ['Wagner', 'Becker', 'Hoffmann', 'Schulz', 'Krüger', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Hartmann',
   'Lange', 'Werner', 'Krause', 'Lehmann', 'Köhler', 'Maier', 'Fuchs', 'Vogel', 'Kaiser', 'Brandt', 'Seidel', 'Winter',
   'Roth', 'Sommer', 'Haas', 'Graf', 'Kuhn', 'Engel', 'Pohl', 'Franke', 'Ludwig', 'Jäger', 'Otto', 'Busch', 'Albrecht', 'Ziegler'];
export function botName(rng, used = new Set()) {
   for (let i = 0; i < 50; i++) {
      const n = NAMES[Math.floor(rng() * NAMES.length)];
      if (!used.has(n)) { used.add(n); return RANKS[Math.floor(rng() * RANKS.length)] + ' ' + n; }
   }
   return 'Uffz. ' + NAMES[Math.floor(rng() * NAMES.length)];
}

// class composition by slot (slot 0 mirrors the player's class)
const CLASS_PATTERN = ['MT', 'HT', 'TD', 'MT', 'LT', 'HT', 'MT', 'TD', 'MT', 'HT'];
function pickOf(cls, lo, hi, rng, avoid) {
   let pool = TANK_LIST.filter((id) => TANKS[id].cls === cls && TANKS[id].tier >= lo && TANKS[id].tier <= hi);
   if (!pool.length) pool = TANK_LIST.filter((id) => TANKS[id].tier >= lo && TANKS[id].tier <= hi);
   if (!pool.length) pool = TANK_LIST;
   const fresh = pool.filter((id) => id !== avoid);
   const p = fresh.length ? fresh : pool;
   return p[Math.floor(rng() * p.length)];
}
/** Tier ±1 around the player, same class mix on both sides (mirrored slot by slot). */
export function matchmake(playerCls, teamSize, rng) {
   const pc = TANKS[playerCls] || TANKS[TANK_LIST[0]];
   const lo = pc.tier - 1, hi = pc.tier + 1;
   const team1 = [pc.id], team2 = [pickOf(pc.cls, pc.tier, pc.tier, rng, pc.id)];
   for (let i = 1; i < teamSize; i++) {
      const cls = CLASS_PATTERN[(i - 1) % CLASS_PATTERN.length];
      const a = pickOf(cls, lo, hi, rng);
      const tier = TANKS[a].tier;
      team1.push(a);
      team2.push(pickOf(TANKS[a].cls, tier, tier, rng, a));
   }
   return { team1, team2 };
}

function spawnTeams(world, opts, teamSize) {
   const rng = makeRng(hashSeed(world.seed, 'mm'));
   const T = world.terrain;
   const playerCls = opts.playerCls === null ? null : (TANKS[opts.playerCls] ? opts.playerCls : 'pz4h');
   const roster = opts.roster || matchmake(playerCls || 'pz4h', teamSize, rng);
   const used = new Set();
   for (const team of [1, 2]) {
      const list = roster['team' + team], sp = T.spawns['team' + team];
      list.forEach((cls, i) => {
         const s = sp[i % sp.length], extra = Math.floor(i / sp.length) * 12;
         const isPlayer = team === 1 && i === 0 && !!playerCls;
         world.addTank(cls, team, { x: s.x + extra, z: s.z + (team === 1 ? extra : -extra), yaw: s.yaw, isPlayer,
            name: isPlayer ? (opts.playerName || 'Spieler') : botName(rng, used) });
      });
   }
}

const capCircle = (T, id, b, team, r = 30) => ({ id, pos: { x: b.x, y: T.heightAt(b.x, b.z), z: b.z }, r, team, progress: 0, capper: null, rate: 1 });

export const MISSIONS = {
   // scripted historical operations (campaign.js): opts.op picks the operation, which fixes map + seed
   campaign: {
      id: 'campaign', name: 'Feldzug', teamSize: 1, timeLimit: null, countdown: 5, noEnd: true,
      mapFor: (opts) => OPS[opts.op]?.map, seedFor: (opts) => OPS[opts.op]?.seed,
      setup(world, opts) { setupCampaign(world, opts); },
      tick(world, dt) { world.script?.tick(dt); },
   },
   standard: {
      id: 'standard', name: 'Standardgefecht', teamSize: 7, timeLimit: 600, countdown: 10,
      desc: 'Zwei Basen. Vernichte alle Gegner oder erobere die gegnerische Basis.',
      setup(world, opts) {
         spawnTeams(world, opts, opts.teamSize || this.teamSize);
         const T = world.terrain;
         world.caps.push(capCircle(T, 'team1', T.bases.team1, 1), capCircle(T, 'team2', T.bases.team2, 2));
      },
   },
   encounter: {
      id: 'encounter', name: 'Begegnungsgefecht', teamSize: 7, timeLimit: 600, countdown: 10,
      desc: 'Eine neutrale Basis in der Kartenmitte. Wer sie hält oder alle Gegner vernichtet, gewinnt.',
      setup(world, opts) {
         spawnTeams(world, opts, opts.teamSize || this.teamSize);
         const T = world.terrain;
         world.caps.push(capCircle(T, 'neutral', T.bases.neutral, null, 35));
         world.caps[0].rate = 0.75;
      },
   },
   training: {
      id: 'training', name: 'Übungsplatz', teamSize: 1, timeLimit: null, countdown: 0, noEnd: true,
      desc: 'Freies Fahren und Schießen auf stehende und fahrende Zielpanzer. Unbegrenzte Munition. ' +
         'Tipp: Das Fadenkreuz zeigt die effektive Panzerung der anvisierten Platte – probiere verschiedene Winkel und Entfernungen.',
      hint: 'Panzerung prüfen: Grün = Durchschlag wahrscheinlich, Gelb = unsicher, Rot = kaum möglich. Achte auf Winkel und Abpraller (> 70°).',
      setup(world, opts) {
         world.infiniteAmmo = true;
         const T = world.terrain, rng = makeRng(hashSeed(world.seed, 'training'));
         const sp = T.spawns.team1[2];
         const cls = TANKS[opts.playerCls] ? opts.playerCls : 'pz4h';
         world.addTank(cls, 1, { x: sp.x, z: sp.z, yaw: Math.PI * 0, isPlayer: true, name: opts.playerName || 'Spieler' });
         // targets: a fan north of the player at 100..400 m, every type, varied angles; every 3rd moves
         world.targets = [];
         const n = TANK_LIST.length;
         for (let i = 0; i < n; i++) {
            const dist = 100 + (i % 4) * 90 + rng() * 20;
            const a = (i / (n - 1) - 0.5) * 1.6;
            const x = sp.x - Math.sin(a) * dist, z = sp.z - Math.cos(a) * dist;
            const yaw = [0, Math.PI / 2, Math.PI / 4, -Math.PI / 6, Math.PI][i % 5] + a;
            const t = world.addTank(TANK_LIST[i], 2, { x, z, yaw, name: 'Ziel ' + (i + 1) });
            t.role = i % 3 === 2 ? 'targetMoving' : 'target';
            t.home = { x, z, yaw };
            for (const k in t.consumables) t.consumables[k].count = 0;
            world.targets.push({ cls: TANK_LIST[i], home: t.home, role: t.role, tank: t, respawn: 0 });
         }
      },
      // destroyed targets come back after 8 s
      tick(world, dt) {
         for (const g of world.targets || []) {
            if (g.tank.alive) continue;
            g.respawn += dt;
            if (g.respawn < 8) continue;
            g.respawn = 0;
            const old = g.tank, i = world.tanks.indexOf(old);
            const t = world.addTank(g.cls, 2, { x: g.home.x, z: g.home.z, yaw: g.home.yaw, name: old.name });
            world.tanks.splice(world.tanks.length - 1, 1); world.tanks[i] = t;
            world.bots.splice(world.bots.indexOf(old), 1);
            t.role = g.role; t.home = g.home; t.side = 'enemy';
            for (const k in t.consumables) t.consumables[k].count = 0;
            if (old.ai) { old.ai.tank = t; t.ai = old.ai; old.ai.reset?.(); }
            g.tank = t;
         }
      },
   },
};
export const MISSION_LIST = Object.keys(MISSIONS).filter((k) => k !== 'campaign');   // campaign starts from its own menu
