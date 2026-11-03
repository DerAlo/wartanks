// game/gfxquality.js — graphics presets. One place that decides how expensive a frame is:
// pixel ratio, shadow map, vegetation density, grass. Stored in localStorage; ?q=low|mid|high
// overrides for tests.
const KEY = 'wartanks.gfx.v1';
export const PRESETS = {
   low:  { name: 'Niedrig', pixelRatio: 1,    shadow: 1024, shadowDist: 110, veg: 0.45, grass: 0,    fxScale: 0.6, antialias: false },
   mid:  { name: 'Mittel',  pixelRatio: 1.25, shadow: 2048, shadowDist: 150, veg: 0.75, grass: 6000, fxScale: 0.85, antialias: true },
   high: { name: 'Hoch',    pixelRatio: 2,    shadow: 4096, shadowDist: 190, veg: 1,    grass: 14000, fxScale: 1, antialias: true },
};
export function loadQuality() {
   const q = new URLSearchParams(location.search).get('q');
   let id = q && PRESETS[q] ? q : null;
   if (!id) try { id = localStorage.getItem(KEY); } catch { /* private mode */ }
   if (!PRESETS[id]) id = 'mid';
   return { id, ...PRESETS[id], pixelRatio: Math.min(PRESETS[id].pixelRatio, window.devicePixelRatio || 1) };
}
export function saveQuality(id) { try { localStorage.setItem(KEY, id); } catch { /* ignore */ } }
