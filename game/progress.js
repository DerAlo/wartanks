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
//   isElite(p, id)                                   every successor in the line researched (or none)
//   convertXP(p, id, n) -> { ok, reason }             elite tank XP -> free XP, CONVERT_CREDITS Kr per EP
//   crewState(p, id) -> { xp, points, used, free, perks, need, into, elite }
//   learnPerk(p, id, perk) / resetPerks(p, id) / trainCrew(p, id, n) (tank XP -> crew XP 1:1)
//   perksOf(p, id) -> [perk ids]                     what the tank takes into battle (single + net)
//
// XP model (WoT, simplified): battle XP goes to the tank (its own line: researches the next tank of
// the same nation), 5 % extra as free XP (anything), and the same amount (×1.5 on an elite tank) to
// the tank's crew, whose crew XP buys skill points for perks (config.PERKS).
//   recordCampaign(p, opId, result) / campaignUnlocked(p, opId, order)   campaign ('Feldzug') records:
//   p.campaign[opId] = { done, stars, bestTime, tries }
import { TANKS, TANK_LIST, NATION_ORDER, PERKS, MAX_PERKS, cleanPerks } from './config.js';

const KEY = 'wartanks.profile.v1';
export const RESEARCH_XP = { 4: 0, 5: 2500, 6: 6000, 7: 12000, 8: 22000 };
export const PRICE = { 4: 30000, 5: 90000, 6: 200000, 7: 450000, 8: 900000 };
export const CONVERT_CREDITS = 25;       // Kr per converted EP (a tier V–VI battle earns ~15–25k Kr, ~800–1200 EP)
export const ELITE_CREW_K = 1.5;         // crew XP bonus on an elite tank
/** Crew XP for skill point n (0-based): 1000, 1450, 2100, … (WoT: 210k for the first; here a few battles). */
export const crewPointXP = (n) => Math.round(1000 * 1.45 ** n / 50) * 50;
let memStore = null;
const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };

export function techTree() {
   const tree = {};
   for (const n of NATION_ORDER) tree[n] = TANK_LIST.filter((id) => TANKS[id].nation === n).sort((a, b) => TANKS[a].tier - TANKS[b].tier || a.localeCompare(b));
   return tree;
}
const prevOf = (id) => { const ch = techTree()[TANKS[id].nation]; const i = ch.indexOf(id); return i > 0 ? ch[i - 1] : null; };
const nextOf = (id) => { const ch = techTree()[TANKS[id].nation]; const i = ch.indexOf(id); return i >= 0 && i < ch.length - 1 ? ch[i + 1] : null; };
const newCrew = () => ({ xp: 0, perks: [] });

export function newProfile() {
   const p = { v: 1, credits: 150000, freeXP: 0, tanks: {}, selected: null, battles: 0, wins: 0, campaign: {} };
   for (const id of TANK_LIST) p.tanks[id] = { xp: 0, owned: false, researched: false, battles: 0, wins: 0, dmg: 0, kills: 0, crew: newCrew() };
   for (const ch of Object.values(techTree())) if (ch.length) { p.tanks[ch[0]].owned = p.tanks[ch[0]].researched = true; p.selected ??= ch[0]; }
   return p;
}
function sanitize(p) {
   const base = newProfile();
   if (!p || typeof p !== 'object' || p.v !== 1) return base;
   const out = { ...base, ...p, tanks: { ...base.tanks } };
   for (const id of TANK_LIST) if (p.tanks?.[id]) {
      const t = out.tanks[id] = { ...base.tanks[id], ...p.tanks[id] };
      t.xp = Math.max(0, +t.xp || 0);
      const c = p.tanks[id].crew;                          // old profiles have no crew: an empty one
      t.crew = { xp: Math.max(0, +c?.xp || 0), perks: cleanPerks(c?.perks) };
      while (t.crew.perks.length > crewLevel(t.crew.xp).points) t.crew.perks.pop();
   }
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
   return { owned: st.owned, researched: st.researched, xp: st.xp, prev, next: nextOf(id), elite: isElite(p, id), researchXP: need, price,
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

// ---------- elite, conversion, crew ----------
/** Elite: every successor in the tank's line is researched (the last tank of a line: once researched). */
export function isElite(p, id) {
   const st = p.tanks[id]; if (!st?.researched) return false;
   const n = nextOf(id);
   return !n || !!p.tanks[n].researched;
}
/** Tank XP of an elite tank -> free XP, 1:1, CONVERT_CREDITS Kr per EP. n = 'all' or a number. */
export function convertXP(p, id, n = 'all') {
   const st = p.tanks[id]; if (!st) return { ok: false, reason: 'Unbekannter Panzer' };
   if (!isElite(p, id)) return { ok: false, reason: 'Nur Elite-Panzer: erst alle Nachfolger erforschen' };
   let amt = Math.floor(n === 'all' ? st.xp : Math.min(+n || 0, st.xp));
   amt = Math.min(amt, Math.floor(p.credits / CONVERT_CREDITS));
   if (amt <= 0) return { ok: false, reason: st.xp <= 0 ? 'Keine Panzer-EP zum Umwandeln' : 'Nicht genug Kreditpunkte' };
   st.xp -= amt; p.freeXP += amt; p.credits -= amt * CONVERT_CREDITS;
   saveProfile(p);
   return { ok: true, xp: amt, credits: amt * CONVERT_CREDITS };
}
/** Skill points from crew XP: points earned, XP into the next point and what it needs. */
export function crewLevel(xp) {
   let points = 0, rest = Math.max(0, xp || 0);
   while (points < MAX_PERKS && rest >= crewPointXP(points)) { rest -= crewPointXP(points); points++; }
   return { points, into: points < MAX_PERKS ? rest : 0, need: points < MAX_PERKS ? crewPointXP(points) : 0 };
}
export function crewState(p, id) {
   const c = p.tanks[id]?.crew || newCrew(), L = crewLevel(c.xp);
   return { xp: c.xp, points: L.points, used: c.perks.length, free: L.points - c.perks.length, perks: [...c.perks], into: L.into, need: L.need, max: MAX_PERKS, elite: isElite(p, id) };
}
export function perksOf(p, id) { return cleanPerks(p?.tanks?.[id]?.crew?.perks); }
export function learnPerk(p, id, perk) {
   const st = p.tanks[id]; if (!st) return { ok: false, reason: 'Unbekannter Panzer' };
   if (!st.owned) return { ok: false, reason: 'Panzer nicht im Besitz' };
   if (!PERKS[perk]) return { ok: false, reason: 'Unbekannte Fertigkeit' };
   if (st.crew.perks.includes(perk)) return { ok: false, reason: 'Bereits gelernt' };
   if (crewState(p, id).free <= 0) return { ok: false, reason: 'Kein freier Fertigkeitspunkt' };
   st.crew.perks.push(perk);
   saveProfile(p);
   return { ok: true };
}
/** Free re-training: all points back (the crew XP stays). */
export function resetPerks(p, id) {
   const st = p.tanks[id]; if (!st || !st.crew.perks.length) return { ok: false, reason: 'Keine Fertigkeiten gelernt' };
   st.crew.perks = [];
   saveProfile(p);
   return { ok: true };
}
/** Tank XP -> crew XP of the same tank, 1:1, free (the XP is then missing for research). */
export function trainCrew(p, id, n = 'all') {
   const st = p.tanks[id]; if (!st?.owned) return { ok: false, reason: 'Panzer nicht im Besitz' };
   const amt = Math.floor(n === 'all' ? st.xp : Math.min(+n || 0, st.xp));
   if (amt <= 0) return { ok: false, reason: 'Keine Panzer-EP vorhanden' };
   st.xp -= amt; st.crew.xp += amt;
   saveProfile(p);
   return { ok: true, xp: amt };
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
   const elite = isElite(p, tankId);
   t.xp += r.xp || 0; p.freeXP += r.freeXP || 0;
   t.crew.xp += Math.round((r.xp || 0) * (elite ? ELITE_CREW_K : 1)); p.credits = Math.max(0, p.credits + (r.credits || 0));
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
