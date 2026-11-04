// game/savegame.js — save file export / import (same scheme as warships game3d/savegame.js).
// One JSON file carries the whole career: garage profile (credits, XP, tanks, crews, campaign
// records), menu choices, controls, sound and the multiplayer name. The graphics preset
// (wartanks.gfx.v1) stays on the device: it belongs to the hardware, not to the player.
// Pure functions over a Storage-like object; the menu does the download / file picking.

export const SAVE_APP = 'panzer';
export const SAVE_PREFIX = 'wartanks.';
const LOCAL_KEYS = new Set(['wartanks.gfx.v1', 'wartanks.net.rejoin']);   // device / tab, never in a save file
const RAW_KEYS = new Set(['wartanks.net.name']);                        // stored as plain text, not JSON
const MAX_VALUE = 1 << 20;                     // 1 MB per entry: far above any real profile

const ours = (k) => typeof k === 'string' && k.startsWith(SAVE_PREFIX) && !LOCAL_KEYS.has(k);
function store(storage) {
   try { return storage !== undefined ? storage : globalThis.localStorage || null; } catch (e) { return null; }
}

// The save file as text: { app, v, saved (ISO date), data: { key: stored string } }.
export function exportSave(storage, now = new Date()) {
   const s = store(storage), data = {};
   if (s) {
      try {
         for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (ours(k)) data[k] = s.getItem(k);
         }
      } catch (e) { /* blocked storage: export what we have */ }
   }
   return JSON.stringify({ app: SAVE_APP, v: 1, saved: now.toISOString(), data }, null, 1);
}

// Parses and checks a save file. Returns { ok: true, data } or { ok: false, error: German text }.
export function readSave(text) {
   let j;
   try { j = JSON.parse(String(text)); } catch (e) { return { ok: false, error: 'Die Datei ist kein Speicherstand (kein gültiges JSON).' }; }
   if (!j || typeof j !== 'object' || j.app !== SAVE_APP || !j.data || typeof j.data !== 'object' || Array.isArray(j.data)) {
      return { ok: false, error: 'Die Datei ist kein PANZER-Speicherstand.' };
   }
   const data = {};
   for (const k in j.data) {
      const v = j.data[k];
      if (!ours(k) || typeof v !== 'string' || v.length > MAX_VALUE) continue;
      if (!RAW_KEYS.has(k)) { try { JSON.parse(v); } catch (e) { continue; } }   // every other entry we store is JSON
      data[k] = v;
   }
   if (!Object.keys(data).length) return { ok: false, error: 'Der Speicherstand ist leer.' };
   return { ok: true, data };
}

// Replaces the stored career with the file's. Returns { ok, error?, count }.
export function importSave(text, storage) {
   const r = readSave(text);
   if (!r.ok) return r;
   const s = store(storage);
   if (!s) return { ok: false, error: 'Der Browser erlaubt hier keinen Speicher (privates Fenster?).' };
   try {
      const old = [];
      for (let i = 0; i < s.length; i++) { const k = s.key(i); if (ours(k)) old.push(k); }
      for (const k of old) if (!(k in r.data)) s.removeItem(k);
      for (const k in r.data) s.setItem(k, r.data[k]);
   } catch (e) { return { ok: false, error: 'Der Speicherstand konnte nicht geschrieben werden.' }; }
   return { ok: true, count: Object.keys(r.data).length };
}

// File name for the download, e.g. "panzer-speicherstand-2026-11-04.json".
export function saveFileName(now = new Date()) {
   const d = (n) => String(n).padStart(2, '0');
   return `panzer-speicherstand-${now.getFullYear()}-${d(now.getMonth() + 1)}-${d(now.getDate())}.json`;
}
