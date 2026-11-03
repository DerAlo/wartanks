// Headless battle runner: node tests/sim.mjs [map] [difficulty] [seed] [mode]
import { World } from '../game/state.js';
export function runBattle(o) {
   const w = new World({ mode: o.mode || 'standard', mapId: o.map || 'steppe', seed: o.seed ?? 1, playerCls: o.player === undefined ? 'pz4h' : o.player, difficulty: o.diff ?? 1, countdown: 0 });
   if (w.player) { w.player.noAI = false; }
   const t0 = Date.now(); let steps = 0;
   const counts = {};
   let last = 0;
   while (w.phase === 'playing' && steps < 60 * 60 * 8) {
      w.update(1 / 60); steps++;
      if (w.seq !== last) { for (let s = last + 1; s <= w.seq; s++) { const e = w.events[s % 256]; if (e && e.seq === s) counts[e.type] = (counts[e.type] || 0) + 1; } last = w.seq; }
   }
   const alive = [0, 0, 0]; for (const t of w.tanks) if (t.alive) alive[t.team]++;
   const sum = (k) => w.tanks.reduce((a, t) => a + (t.stats[k] || 0), 0);
   return { w, ms: Date.now() - t0, time: w.time, result: w.result, alive, counts, shots: sum('shots'), hits: sum('hits'), pens: sum('pens'), dmg: sum('dmg') };
}
if (process.argv[1].endsWith('sim.mjs')) {
   const [map = 'steppe', diff = '1', seed = '1', mode = 'standard'] = process.argv.slice(2);
   const r = runBattle({ map, diff: +diff, seed: +seed, mode, player: null });
   console.log(map, 'diff', diff, 'seed', seed, mode, '->', r.result?.outcome, r.result?.reason, 'winner', r.result?.winner, 'battle', r.time.toFixed(0) + 's', 'cpu', r.ms + 'ms', 'alive', r.alive.slice(1), JSON.stringify(r.counts), 'shots', r.shots, 'hits', r.hits, 'pens', r.pens, 'dmg', Math.round(r.dmg));
}
