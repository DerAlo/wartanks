// game/progress.js — garage profile: credits, XP, research and purchases (localStorage
// 'wartanks.profile.v1'; works without localStorage, e.g. in node).
//
//   loadProfile() / saveProfile(p) / resetProfile()
//   techTree() -> { DE:[id...], SU:[...], US:[...], UK:[...] }   chain per nation by tier
//   tankState(p, id) -> { owned, researched, xp, canResearch, canBuy, researchXP, price, prev }
//   research(p, id) / buy(p, id) -> { ok, reason }
//   calcRewards(world) -> { xp, credits, freeXP, breakdown }     (player, from world.stats + result)
//   applyRewards(p, tankId, rewards)
//   exportProfile(p) -> string, importProfile(str) -> profile (throws on garbage)
//   recordCampaign(p, opId, result) / campaignUnlocked(p, opId, order)   campaign ('Feldzug') records:
//   p.campaign[opId] = { done, stars, bestTime, tries }
import { TANKS, TANK_LIST, NATION_ORDER } from './config.js';

const KEY = 'wartanks.profile.v1';
export const RESEARCH_XP = { 4: 0, 5: 2500, 6: 6000, 7: 12000, 8: 22000 };
export const PRICE = { 4: 30000, 5: 90000, 6: 200000, 7: 450000, 8: 900000 };
let memStore = null;
const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function techTree() {
   const tree = {};
   for (const n of NATION_ORDER) tree[n] = TANK_LIST.filter((id) => TANKS[id].nation === n).sort((a, b) => TANKS[a].tier - TANKS[b].tier || a.localeCompare(b));
   return tree;
}
const prevOf = (id) => { const ch = techTree()[TANKS[id].nation]; const i = ch.indexOf(id); return i > 0 ? ch[i - 1] : null; };

export function newProfile() {
   const p = { v: 1, credits: 150000, freeXP: 0, tanks: {}, selected: null, battles: 0, wins: 0, campaign: {} };
   for (const id of TANK_LIST) p.tanks[id] = { xp: 0, owned: false, researched: false, battles: 0, wins: 0, dmg: 0, kills: 0 };
   for (const ch of Object.values(techTree())) if (ch.length) { p.tanks[ch[0]].owned = p.tanks[ch[0]].researched = true; p.selected ??= ch[0]; }
   return p;
}
function sanitize(p) {
   const base = newProfile();
   if (!p || typeof p !== 'object' || p.v !== 1) return base;
   const out = { ...base, ...p, tanks: { ...base.tanks } };
   for (const id of TANK_LIST) if (p.tanks?.[id]) out.tanks[id] = { ...base.tanks[id], ...p.tanks[id] };
   if (!TANKS[out.selected] || !out.tanks[out.selected].owned) out.selected = base.selected;
   out.credits = Math.max(0, +out.credits || 0); out.freeXP = Math.max(0, +out.freeXP || 0);
   out.campaign = {};                                   // old profiles have none
   if (p.campaign && typeof p.campaign === 'object') for (const [id, r] of Object.entries(p.campaign)) if (r && typeof r === 'object')
      out.campaign[id] = { done: !!r.done, stars: Math.max(0, Math.min(3, r.stars | 0)), bestTime: Number.isFinite(r.bestTime) ? r.bestTime : null, tries: r.tries | 0 };
   return out;
}
export function loadProfile() {
   const s = store();
   try { const raw = s ? s.getItem(KEY) : memStore; return sanitize(raw ? JSON.parse(raw) : null); } catch { return newProfile(); }
}
export function saveProfile(p) {
   const raw = JSON.stringify(p), s = store();
   try { if (s) s.setItem(KEY, raw); else memStore = raw; } catch { memStore = raw; }
   return p;
}
export function resetProfile() { const p = newProfile(); saveProfile(p); return p; }

export function tankState(p, id) {
   const T = TANKS[id], st = p.tanks[id], prev = prevOf(id);
   const need = RESEARCH_XP[T.tier] ?? 0, price = PRICE[T.tier] ?? 0;
   const avail = (prev ? p.tanks[prev].xp : 0) + p.freeXP;
   return { owned: st.owned, researched: st.researched, xp: st.xp, prev, researchXP: need, price,
      canResearch: !st.researched && (!prev || p.tanks[prev].researched) && avail >= need,
      canBuy: st.researched && !st.owned && p.credits >= price };
}
export function research(p, id) {
   const s = tankState(p, id);
   if (s.researched) return { ok: false, reason: 'Bereits erforscht' };
   if (!s.canResearch) return { ok: false, reason: 'Nicht genug Erfahrung' };
   let need = s.researchXP;
   if (s.prev) { const use = Math.min(need, p.tanks[s.prev].xp); p.tanks[s.prev].xp -= use; need -= use; }
   p.freeXP -= need;
   p.tanks[id].researched = true;
   saveProfile(p);
   return { ok: true };
}
export function buy(p, id) {
   const s = tankState(p, id);
   if (s.owned) return { ok: false, reason: 'Bereits gekauft' };
   if (!s.researched) return { ok: false, reason: 'Noch nicht erforscht' };
   if (!s.canBuy) return { ok: false, reason: 'Nicht genug Kreditpunkte' };
   p.credits -= s.price; p.tanks[id].owned = true;
   saveProfile(p);
   return { ok: true };
}

const AMMO_COST = { AP: 1, APCR: 6, HEAT: 5, HE: 0.8 };
/** Rewards for the local player from world.stats and world.result. */
export function calcRewards(world) {
   const P = world.player, st = world.stats || P?.stats, res = world.result;
   if (!P || !st || world.mode === 'training') return { xp: 0, credits: 0, freeXP: 0, breakdown: {} };
   const tier = P.cfg.tier, k = 0.6 + 0.1 * tier;
   const win = res?.outcome === 'win', draw = res?.outcome === 'draw';
   const b = {
      damage: st.dmg * 0.55, assist: st.assist * 0.25, kills: st.kills * 70, spotted: st.spotted * 25,
      crits: st.crits * 6, blocked: st.blocked * 0.04, base: 120, survived: P.alive ? 60 : 0,
   };
   let xp = 0; for (const x in b) xp += b[x];
   xp *= (win ? 1.5 : draw ? 1.1 : 1) * k;
   const ammoCost = Math.round(st.shots * (P.cfg.gun.cal / 75) ** 2 * 120 * (AMMO_COST[P.ammoSel] ?? 1));
   const credits = Math.round((st.dmg * 11 + st.assist * 5 + st.kills * 700 + st.spotted * 150 + (win ? 9000 : draw ? 6000 : 4500)) * k - ammoCost);
   xp = Math.round(xp);
   return { xp, credits, freeXP: Math.round(xp * 0.05), ammoCost, breakdown: b };
}
export function applyRewards(p, tankId, r) {
   const t = p.tanks[tankId]; if (!t || !r || !t.owned) return p;   // test drive (?tank= not owned): nothing credited
   t.xp += r.xp || 0; p.freeXP += r.freeXP || 0; p.credits = Math.max(0, p.credits + (r.credits || 0));
   t.battles++; p.battles++;
   if (r.outcome === 'win') { t.wins++; p.wins++; }
   if (r.dmg) t.dmg += r.dmg; if (r.kills) t.kills += r.kills;
   saveProfile(p);
   return p;
}

// ---------- campaign ('Feldzug'): one record per operation ----------
/** Store the outcome of a campaign battle (world.result with .campaign); keeps the best stars / time. */
export function recordCampaign(p, opId, result) {
   if (!opId) return p;
   p.campaign ??= {};
   const r = p.campaign[opId] ??= { done: false, stars: 0, bestTime: null, tries: 0 };
   r.tries++;
   if (result?.outcome === 'win') {
      r.done = true;
      r.stars = Math.max(r.stars, Math.max(0, Math.min(3, result.campaign?.stars | 0)));
      const t = result.time;
      if (Number.isFinite(t) && (r.bestTime == null || t < r.bestTime)) r.bestTime = Math.round(t);
   }
   saveProfile(p);
   return p;
}
/** First operation is always open; op n+1 opens once op n has been won. `order` = OP_LIST. */
export function campaignUnlocked(p, opId, order = []) {
   const i = order.indexOf(opId);
   if (i <= 0) return true;
   return !!p.campaign?.[order[i - 1]]?.done;
}

const b64e = (s) => (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, 'utf8').toString('base64'));
const b64d = (s) => (typeof atob === 'function' ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, 'base64').toString('utf8'));
export function exportProfile(p) { return 'WT1:' + b64e(JSON.stringify(p)); }
export function importProfile(str) {
   const s = String(str || '').trim();
   if (!s.startsWith('WT1:')) throw new Error('Ungültiger Spielstand');
   const p = sanitize(JSON.parse(b64d(s.slice(4))));
   saveProfile(p);
   return p;
}
