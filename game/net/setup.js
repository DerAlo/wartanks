// game/net/setup.js — the same World on every peer of a net game. See CONTRACT.md "Setup".
//
//   makeRoster(session) -> { roster, slots }        host only: bot classes by matchmake, humans in slot order
//   buildWorld(start)   -> World                     every peer, from the host's `start` message
//   setOwn(world, tankId)                            this peer's own tank becomes world.player (sides recomputed)
//   setHuman(world, tank, on)                        a remote captain takes a tank (AI off) or leaves it (AI on)
//
// World team 1 is always the host's team (co-op: all humans; PvP: the host's lobby team). Humans take
// the first places of their World team in slot order, the rest are bots. Tank ids are renumbered
// 1..n in roster order on every peer, so they match on the wire.
import { World } from '../state.js';
import { MISSIONS, matchmake } from '../missions.js';
import { TANKS } from '../config.js';
import { BotAI } from '../ai.js';
import { makeRng, hashSeed } from '../utils.js';

const validTank = (cls) => (TANKS[cls] ? cls : 'pz4h');

/** Host: roster and slots from the lobby session. slots[i] = { name, tank, wteam, idx } (idx in its World team). */
export function makeRoster(session) {
   const mission = MISSIONS[session.mission] ? session.mission : 'standard';
   const size = MISSIONS[mission].teamSize || 7;
   const P = session.players;
   const rng = makeRng(hashSeed(session.seed >>> 0, 'netmm'));
   const hostTeam = P[0]?.team ?? 1;
   const slots = P.map((p) => ({ name: String(p.name || 'Spieler').slice(0, 24), tank: validTank(p.tank), team: session.mode === 'pvp' ? (p.team ?? 1) : undefined, wteam: session.mode === 'pvp' && (p.team ?? 1) !== hostTeam ? 2 : 1 }));
   const n1 = slots.filter((s) => s.wteam === 1).length, n2 = slots.length - n1;
   const roster = matchmake(slots[0]?.tank || 'pz4h', Math.max(size, n1, n2), rng);
   const k = { 1: 0, 2: 0 };
   for (const s of slots) { s.idx = k[s.wteam]++; roster['team' + s.wteam][s.idx] = s.tank; }
   return { roster, slots };
}

/** Every peer: start = { mission, mapId, difficulty, seed, roster, slots, mode, deadObj? } */
export function buildWorld(start) {
   const difficulty = start.mode === 'pvp' ? 'normal' : start.difficulty;
   const world = new World({ mode: start.mission, mapId: start.mapId, seed: start.seed, difficulty, roster: start.roster,
      playerCls: start.roster.team1[0], playerName: start.slots[0]?.name });
   // stable ids: roster order (team1 then team2, as missions.spawnTeams adds them)
   world._byId = new Map();
   world.tanks.forEach((t, i) => { t.id = i + 1; world._byId.set(t.id, t); });
   world.net = { slots: start.slots.map((s) => ({ ...s })) };
   const n1 = start.roster.team1.length;
   for (const s of world.net.slots) {
      s.tid = s.wteam === 1 ? s.idx + 1 : n1 + s.idx + 1;
      const t = world.tankById(s.tid);
      if (t) { t.name = s.name; t.human = true; }
   }
   for (const [id, yaw] of start.deadObj || []) {
      const o = world.terrain.objects[id];
      if (o && o.alive) { o.alive = false; o.fallYaw = yaw; world.terrain.version++; }
   }
   return world;
}

/** This peer's own tank becomes world.player; sides follow its team. */
export function setOwn(world, tankId) {
   const me = world.tankById(tankId) || world.player;
   for (const t of world.tanks) {
      t.isPlayer = t === me;
      t.side = t === me ? 'player' : t.team === me.team ? 'ally' : 'enemy';
   }
   world.player = me; world.stats = me.stats;
   if (me.ai) setHuman(world, me, true);
   return me;
}

/** on: a captain drives the tank (no AI, no auto-fire); off: the bot AI takes over again. */
export function setHuman(world, t, on) {
   if (on) {
      if (t.ai) { world.ais = world.ais.filter((a) => a !== t.ai); t.ai = null; }
      t.bot = false;
      Object.assign(t.input, { throttle: 0, steer: 0, brake: false, fire: false, cruise: 0 });
   } else if (!t.ai && t.alive && t !== world.player) {
      t.bot = true;
      const ai = new BotAI(world, t); world.ais.push(ai); t.ai = ai;
   }
}
