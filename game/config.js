// game/config.js — world constants, ammo rules and the vehicle table (historical WW2 tanks).
//
// ============================== DATA FORMAT ==============================
// Every tank entry in RAW below is written compactly and expanded by finalize() at load time.
// Consumers (sim + renderer) read the FINALISED objects in TANKS[id]. Units: m, mm (armour),
// t (mass), hp, km/h, deg (data) / rad (sim), s.
//
// Hull-local frame: +x right, +y up, -z forward; origin = ground point under the hull centre
// (tank.pos is this point). All hull z values are relative to the hull's z-centre.
//
// cfg.hull (finalised):
//   profile: [{ z, y, plate }]  side-profile polygon (y/z), from the front floor corner going
//                               forward/up over the nose, along the roof, down the rear, back
//                               along the floor. Edge i runs profile[i] -> profile[i+1]; its
//                               armour plate id is profile[i].plate.
//   plates:  { id: { name, t } } thickness (mm) per plate id (incl. 'side', 'sideLow', 'spon').
//   floorY, roofY, len, w       floor/roof height, overall hull length, width at the bottom
//                               of the upper hull (at sponsonY, or the floor if no sponsons).
//   sideSlope (deg)             inward lean of the (upper) side plates; half width at height y
//                               = w/2 - (y - y0) * tan(sideSlope), y0 = sponsonY ?? floorY.
//   sponsonY, lowerW            optional: below sponsonY the hull is only lowerW wide (tracks sit
//                               under the sponsons). The hull is then two convex pieces.
// cfg.turret (null for casemate TDs):
//   x, z, y                     ring centre in hull-local (y = hull roof).
//   ringR                       turret ring radius.
//   h                           height of the turret box above its base.
//   base: [[x,z], ...]          top-view polygon at the base, turret-local (ring centre origin),
//                               counter-clockwise seen from above (x right, z back).
//   faces: [{ id, t, slope }]   per base edge i (base[i] -> base[i+1]): plate, mm, inward lean
//                               in deg (the top polygon = base polygon offset inwards).
//   top: [[x,z], ...]           derived roof polygon at y = h.
//   roofT, plates               roof thickness; plates map { id: { name, t } }.
//   openTop                     no roof armour (shells enter freely).
// cfg.mantlet: { w, h, d, t, x, y, z, mount }  box (centre x/y/z, size w/h/d) in turret-local
//                               (mount 'turret') or hull-local (mount 'hull'); fixed, not pitched.
// cfg.gun:
//   name, cal (mm), len (m, barrel from the trunnion), brake (muzzle brake), mount 'turret'|'hull',
//   pivot { x, y, z }           trunnion in turret-local (or hull-local for casemates).
//   reload (s), disp (m at 100 m), aim (s, e-fold time of the bloom), dispMove (per m/s),
//   dispHull (per rad/s of hull rotation), dispTurret (per rad/s), dispShot (added after a shot),
//   elev, depr (deg, relative to the hull; depr negative), arc [l, r] deg (null = 360 turret),
//   cap (rounds), load { AP: n, ... }, ammo: [{ type, name, pen (mm @ 100 m), pen500, dmg, vel }]
// cfg.run (running gear, for the renderer and track armour):
//   wheels (per side), wheelR, interleave (0 none, 2 overlapping, 3 triple), bogies (HVSS etc.),
//   rollers (return rollers per side), sprocket 'front'|'rear', sprocketR, idlerR,
//   trackW, len (track length front-to-rear), z (track centre z), h (track top height),
//   x (track centre |x|), t (mm, spaced armour), style ('allround' for Churchill).
// cfg.skirts: { t, h, y0 } optional Schürzen outside the tracks (full track length).
// cfg.modules: { id: { part:'hull'|'turret', c:[x,y,z], s:[hx,hy,hz] (half extents), hp } }
//   ids: engine, fuel, ammo, gun, turretRing, radio, optics. Tracks are cfg.run boxes (trackL/R).
// cfg.crew: [{ id, roles:[...], part, c, s }]  roles: commander, gunner, driver, radio, loader.
// Mobility: mass (t), engine { hp, fuel:'petrol'|'diesel' }, vMax, vRev (km/h), traverse (deg/s
//   hull), turretTraverse (deg/s), ground [hard, medium, soft] resistance multipliers.
// Other: id, name, short, nation, cls ('LT'|'MT'|'HT'|'TD'), tier, hp, view (m), camo
//   { still, move } (fraction 0..1), dims { len, width, height }.
// ========================================================================

export const WORLD = {
   SIM_DT: 1 / 60,
   G: 9.81,
   HALF: 500,               // map half extent (m)
   SHELL_RANGE: 720,        // shells self-destruct after this flight distance
   DRAW_RANGE: 445,         // tanks beyond this are not shown even when spotted
   PROXIMITY: 50,           // always spotted within this
   SPOT_MEMORY: 2,          // s a lost contact stays visible
   SPOT_DT: 0.25,
};

// Ammo type rules (Ballistik). falloff = pen fraction lost between 100 m and 500 m (linear,
// unless the round gives pen500). norm = normalisation (deg), ric = auto-ricochet angle (deg).
export const AMMO = {
   AP:   { name: 'Panzergranate', short: 'PzGr', falloff: 0.14, norm: 5, ric: 70, postPen: 3.0, color: '#d9c27a' },
   APCR: { name: 'Hartkerngranate', short: 'HK', falloff: 0.32, norm: 2, ric: 70, postPen: 2.5, color: '#9ad0ff' },
   HEAT: { name: 'Hohlladung', short: 'HL', falloff: 0, norm: 0, ric: 85, postPen: 1.0, color: '#ffb36b' },
   HE:   { name: 'Sprenggranate', short: 'Spr', falloff: 0, norm: 0, ric: null, postPen: 0, color: '#ff7a5c' },
};
export const BALLISTICS = {
   PEN_RANDOM: 0.25,        // ±25 % (triangular) on penetration
   DMG_RANDOM: 0.25,        // ±25 % on damage
   DISP_MUL: 0.82,          // global accuracy: all guns 18 % tighter (playtest: 'manchmal echt zäh', then 'noch eine Nuance genauer')
   AIM_MUL: 0.85,           // global aim time scale (faster convergence)
   DMG_MUL: 1.3,            // global damage scale: hits must hurt (playtest: 'treffer machen wenig schaden')
   TRACK_K: 1.0,            // share of the shell's damage a track hit deals to the track (ricochet: half)
   FALL_START: 100, FALL_END: 500,
   OVERMATCH: 3,            // caliber > 3 × t: no ricochet
   OVERMATCH_NORM: 2,       // caliber > 2 × t: normalisation scaled by 1.4 × cal/t (WoT style)
   RIC_PEN_LOSS: 0.25,      // pen lost on a ricochet
   HEAT_AIR_LOSS: 0.5,      // HEAT pen fraction lost per metre of air after the first plate
   HE_MIN: 0.1,             // a direct non-penetrating HE hit deals at least 10 % of its damage
   HE_SPLASH_K: 1.1,        // HE splash: dmg = alpha/2 * falloff − effT × k
   HE_RADIUS: (cal) => 0.6 + cal * 0.012,   // m
   MAX_PLATES: 8,
};

export const NATIONS = {
   DE: { name: 'Deutschland', adj: 'deutsch', color: 0x6b6a52 },
   SU: { name: 'Sowjetunion', adj: 'sowjetisch', color: 0x4f5b38 },
   US: { name: 'USA', adj: 'amerikanisch', color: 0x5a5e3c },
   UK: { name: 'Großbritannien', adj: 'britisch', color: 0x6a6c4e },
};
export const NATION_ORDER = ['DE', 'SU', 'US', 'UK'];
export const CLASSES = {
   LT: { name: 'Leichter Panzer', short: 'LT' },
   MT: { name: 'Mittlerer Panzer', short: 'MT' },
   HT: { name: 'Schwerer Panzer', short: 'ST' },
   TD: { name: 'Jagdpanzer', short: 'JgPz' },
};
export const TIER_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Ground resistance classes (base rolling resistance coefficient; tanks scale it by cfg.ground).
export const GROUND = {
   road:   { name: 'Straße', res: 0.02, idx: 0 },
   hard:   { name: 'Fester Boden', res: 0.025, idx: 0 },
   medium: { name: 'Wiese', res: 0.05, idx: 1 },
   soft:   { name: 'Weicher Boden', res: 0.06, idx: 2 },
   water:  { name: 'Furt', res: 0.12, idx: 2 },
};

export const CONSUMABLES = {
   repair: { name: 'Reparaturkasten', short: 'Rep', cd: 90, desc: 'Repariert alle Module' },
   medkit: { name: 'Verbandskasten', short: 'San', cd: 90, desc: 'Heilt verwundete Besatzung' },
   extinguisher: { name: 'Feuerlöscher', short: 'Lösch', cd: 60, desc: 'Löscht einen Brand' },
};

// Crew skills ('Fertigkeiten', WoT perks). Each tank's crew learns them with skill points from crew
// XP (progress.js). The effects are modest multipliers on mechanics the sim really has; perkMods()
// folds a list into one set the Tank applies (tank.setPerks). Keys of `fx` and what they scale:
//   disp   base dispersion when fully aimed     bloom  dispersion added by driving / hull / turret turning
//   reload reload time   aim  aim time          camo   camouflage values   view  view range
//   repair field repair speed of modules       fire   chance of catching fire   burnOut  chance per second a fire dies
export const PERKS = {
   feinabstimmung: { name: 'Feinabstimmung', role: 'Richtschütze', desc: 'Voll eingezielt streut die Kanone 8 % weniger.', fx: { disp: 0.92 } },
   ruhigeHand:     { name: 'Ruhige Hand', role: 'Richtschütze', desc: 'Fahren, Wannen- und Turmdrehen vergrößern die Streuung 15 % weniger.', fx: { bloom: 0.85 } },
   schnellladen:   { name: 'Schnellladen', role: 'Ladeschütze', desc: 'Nachladezeit −5 %.', fx: { reload: 0.95 } },
   reparatur:      { name: 'Reparatur', role: 'Fahrer', desc: 'Zerstörte Module (Ketten, Motor …) werden im Feld 25 % schneller instand gesetzt.', fx: { repair: 1.25 } },
   tarnung:        { name: 'Tarnung', role: 'alle', desc: 'Tarnwert +10 % (stehend und fahrend): später entdeckt.', fx: { camo: 1.1 } },
   adlerauge:      { name: 'Adlerauge', role: 'Kommandant', desc: 'Sichtweite +5 %.', fx: { view: 1.05 } },
   waffenbrueder:  { name: 'Waffenbrüder', role: 'alle', desc: 'Eingespielte Besatzung: Nachladen und Zielzeit −2,5 %, Sichtweite und Tarnung +2,5 %.', fx: { reload: 0.975, aim: 0.975, view: 1.025, camo: 1.025 } },
   feuerwehr:      { name: 'Feuerwehr', role: 'alle', desc: 'Motor- und Tanktreffer setzen den Panzer 25 % seltener in Brand, Brände erlöschen schneller.', fx: { fire: 0.75, burnOut: 1.5 } },
};
export const PERK_LIST = Object.keys(PERKS);
export const MAX_PERKS = PERK_LIST.length;
const PERK_KEYS = ['disp', 'bloom', 'reload', 'aim', 'camo', 'view', 'repair', 'fire', 'burnOut'];
/** Legal perk list from anything (net input, old profiles): known ids, no doubles, at most MAX_PERKS. */
export function cleanPerks(list) {
   if (!Array.isArray(list)) return [];
   const out = [];
   for (const id of list) if (typeof id === 'string' && Object.prototype.hasOwnProperty.call(PERKS, id) && !out.includes(id) && out.length < MAX_PERKS) out.push(id);
   return out;
}
/** One multiplier per mechanic from a perk list (unknown / double entries ignored). */
export function perkMods(list) {
   const m = {}; for (const k of PERK_KEYS) m[k] = 1;
   for (const id of cleanPerks(list)) for (const k in PERKS[id].fx) m[k] *= PERKS[id].fx[k];
   return m;
}

export const PLATE_NAMES = {
   belly: 'Bugunterseite', lfp: 'Untere Bugplatte', nose: 'Bugnase', glac: 'Glacis', ufp: 'Obere Bugplatte',
   roof: 'Wannendach', eng: 'Motordeck', urp: 'Obere Heckplatte', lrp: 'Untere Heckplatte', floor: 'Wannenboden',
   emb: 'Schießscharte', conc: 'Betondecke', shield: 'Schutzschild', deck: 'Deck', belt: 'Bordwand',
   side: 'Seite', sideLow: 'Untere Seite', spon: 'Kettenabdeckung',
   tf: 'Turmfront', tcl: 'Turmwange links', tcr: 'Turmwange rechts', tsl: 'Turmseite links', tsr: 'Turmseite rechts',
   trl: 'Turmheck links', trr: 'Turmheck rechts', tr: 'Turmheck', troof: 'Turmdach', tbase: 'Turmboden',
   mantlet: 'Blende', track: 'Kette', skirt: 'Schürze', gun: 'Kanone', cup: 'Kommandantenkuppel',
};

// Module catalogue (German names, base HP at tier V; scaled by tier in finalize()).
export const MODULES = {
   engine: { name: 'Motor', hp: 190 },
   fuel: { name: 'Kraftstofftank', hp: 200 },
   ammo: { name: 'Munitionslager', hp: 170 },
   gun: { name: 'Kanone', hp: 150 },
   turretRing: { name: 'Turmdrehkranz', hp: 150 },
   radio: { name: 'Funkgerät', hp: 90 },
   optics: { name: 'Optik', hp: 90 },
   trackL: { name: 'Kette links', hp: 140 },
   trackR: { name: 'Kette rechts', hp: 140 },
};
export const CREW_NAMES = { commander: 'Kommandant', gunner: 'Richtschütze', driver: 'Fahrer', radio: 'Funker', loader: 'Ladeschütze' };

// Per-class defaults (camo when firing etc.).
export const CLASS_DEFAULTS = {
   LT: { fireCamo: 0.25, dispMove: 0.11, dispHull: 0.10, dispTurret: 0.06, dispShot: 2.5 },
   MT: { fireCamo: 0.2, dispMove: 0.16, dispHull: 0.14, dispTurret: 0.08, dispShot: 3.0 },
   HT: { fireCamo: 0.15, dispMove: 0.2, dispHull: 0.18, dispTurret: 0.1, dispShot: 3.5 },
   TD: { fireCamo: 0.3, dispMove: 0.22, dispHull: 0.2, dispTurret: 0.06, dispShot: 3.5 },
};

// ---------------- shared guns ----------------
const G = {
   // ---- tier I–III guns: small calibres, quick reload, low damage per shot
   kwk30_20: { name: '2 cm KwK 30 L/55', cal: 20, len: 1.15, reload: 0.7, disp: 0.46, aim: 1.4, elev: 20, depr: -9, cap: 180,
      load: { AP: 120, APCR: 40, HE: 20 },
      ammo: [{ type: 'AP', name: 'PzGr', pen: 30, dmg: 13, vel: 780 }, { type: 'APCR', name: 'PzGr 40', pen: 46, dmg: 13, vel: 1050 }, { type: 'HE', name: 'SprGr', pen: 10, dmg: 16, vel: 900 }] },
   kwk36_37: { name: '3,7 cm KwK 36 L/45', cal: 37, len: 1.7, reload: 2.2, disp: 0.42, aim: 1.6, elev: 20, depr: -10, cap: 120,
      load: { AP: 80, APCR: 20, HE: 20 },
      ammo: [{ type: 'AP', name: 'PzGr 18', pen: 40, dmg: 40, vel: 745 }, { type: 'APCR', name: 'PzGr 40', pen: 64, dmg: 40, vel: 1020 }, { type: 'HE', name: 'SprGr 18', pen: 18, dmg: 50, vel: 745 }] },
   kwk38_50: { name: '5 cm KwK 38 L/42', cal: 50, len: 2.1, reload: 2.6, disp: 0.40, aim: 1.8, elev: 20, depr: -10, cap: 99,
      load: { AP: 60, APCR: 15, HE: 24 },
      ammo: [{ type: 'AP', name: 'PzGr 39', pen: 65, dmg: 70, vel: 685 }, { type: 'APCR', name: 'PzGr 40', pen: 96, dmg: 70, vel: 1050 }, { type: 'HE', name: 'SprGr 38', pen: 25, dmg: 90, vel: 450 }] },
   // ---- tier IX–X guns
   kwk46_105: { name: '10,5 cm KwK 46 L/68', cal: 105, len: 7.1, brake: true, reload: 10.5, disp: 0.34, aim: 2.4, elev: 15, depr: -7, cap: 50,
      load: { AP: 30, APCR: 8, HE: 12 },
      ammo: [{ type: 'AP', name: 'PzGr 39', pen: 235, dmg: 320, vel: 1000 }, { type: 'APCR', name: 'PzGr 40', pen: 290, dmg: 320, vel: 1150 },
         { type: 'HE', name: 'SprGr', pen: 55, dmg: 420, vel: 900 }] },
   kwk44_128: { name: '12,8 cm KwK 44 L/55', cal: 128, len: 7.0, brake: true, reload: 14, disp: 0.36, aim: 2.7, elev: 23, depr: -7, cap: 32,
      load: { AP: 18, APCR: 6, HE: 8 },
      ammo: [{ type: 'AP', name: 'PzGr 43', pen: 255, dmg: 490, vel: 920 }, { type: 'APCR', name: 'PzGr 40/43', pen: 311, dmg: 490, vel: 1050 },
         { type: 'HE', name: 'SprGr L/5', pen: 65, dmg: 630, vel: 750 }] },
   kwk44_150: { name: '15 cm KwK 44 L/38', cal: 150, len: 5.7, brake: true, reload: 18, disp: 0.38, aim: 2.9, elev: 15, depr: -6, cap: 24,
      load: { AP: 12, HEAT: 6, HE: 6 },
      ammo: [{ type: 'AP', name: 'PzGr 43', pen: 245, dmg: 680, vel: 845 }, { type: 'HEAT', name: 'Gr 39 Hl', pen: 300, dmg: 680, vel: 700 },
         { type: 'HE', name: 'SprGr 39', pen: 85, dmg: 900, vel: 845 }] },
   kwk39_50: { name: '5 cm KwK 39 L/60', cal: 50, len: 3.0, reload: 2.8, disp: 0.38, aim: 1.7, elev: 20, depr: -9, cap: 80,
      load: { AP: 50, APCR: 15, HE: 15 },
      ammo: [{ type: 'AP', name: 'PzGr 39', pen: 85, dmg: 70, vel: 835 }, { type: 'APCR', name: 'PzGr 40', pen: 130, dmg: 70, vel: 1180 }, { type: 'HE', name: 'SprGr', pen: 25, dmg: 90, vel: 550 }] },
   kwk40_75: { name: '7,5 cm KwK 40 L/48', cal: 75, len: 3.6, reload: 6.0, disp: 0.37, aim: 2.3, elev: 20, depr: -10, cap: 87,
      load: { AP: 55, APCR: 12, HEAT: 5, HE: 15 },
      ammo: [{ type: 'AP', name: 'PzGr 39', pen: 110, dmg: 110, vel: 790 }, { type: 'APCR', name: 'PzGr 40', pen: 158, dmg: 110, vel: 990 },
         { type: 'HEAT', name: 'Gr 38 Hl/C', pen: 87, dmg: 110, vel: 450 }, { type: 'HE', name: 'SprGr 34', pen: 38, dmg: 175, vel: 550 }] },
   kwk42_75: { name: '7,5 cm KwK 42 L/70', cal: 75, len: 5.25, brake: true, reload: 4.8, disp: 0.34, aim: 2.3, elev: 20, depr: -8, cap: 79,
      load: { AP: 50, APCR: 12, HE: 17 },
      ammo: [{ type: 'AP', name: 'PzGr 39/42', pen: 150, dmg: 135, vel: 925 }, { type: 'APCR', name: 'PzGr 40/42', pen: 194, dmg: 135, vel: 1120 },
         { type: 'HE', name: 'SprGr 42', pen: 38, dmg: 175, vel: 700 }] },
   kwk36_88: { name: '8,8 cm KwK 36 L/56', cal: 88, len: 4.93, brake: true, reload: 8.0, disp: 0.36, aim: 2.3, elev: 17, depr: -8, cap: 92,
      load: { AP: 55, APCR: 12, HE: 25 },
      ammo: [{ type: 'AP', name: 'PzGr 39', pen: 145, dmg: 220, vel: 773 }, { type: 'APCR', name: 'PzGr 40', pen: 171, dmg: 220, vel: 930 },
         { type: 'HE', name: 'SprGr', pen: 44, dmg: 270, vel: 700 }] },
   kwk43_88: { name: '8,8 cm KwK 43 L/71', cal: 88, len: 6.3, brake: true, reload: 9.0, disp: 0.33, aim: 2.3, elev: 15, depr: -8, cap: 80,
      load: { AP: 50, APCR: 12, HE: 18 },
      ammo: [{ type: 'AP', name: 'PzGr 39/43', pen: 203, dmg: 240, vel: 1000 }, { type: 'APCR', name: 'PzGr 40/43', pen: 237, dmg: 240, vel: 1130 },
         { type: 'HE', name: 'SprGr 43', pen: 44, dmg: 290, vel: 750 }] },
   f34_76: { name: '76 mm F-34', cal: 76, len: 3.15, reload: 5.0, disp: 0.45, aim: 2.3, elev: 25, depr: -5, cap: 100,
      load: { AP: 60, APCR: 12, HE: 28 },
      ammo: [{ type: 'AP', name: 'BR-350A', pen: 86, dmg: 110, vel: 662 }, { type: 'APCR', name: 'BR-350P', pen: 102, dmg: 110, vel: 950 },
         { type: 'HE', name: 'OF-350', pen: 38, dmg: 175, vel: 680 }] },
   zis5_76: { name: '76 mm ZiS-5', cal: 76, len: 3.2, reload: 5.0, disp: 0.43, aim: 2.5, elev: 25, depr: -7, cap: 111,
      load: { AP: 66, APCR: 15, HE: 30 },
      ammo: [{ type: 'AP', name: 'BR-350B', pen: 90, dmg: 110, vel: 680 }, { type: 'APCR', name: 'BR-350P', pen: 105, dmg: 110, vel: 960 },
         { type: 'HE', name: 'OF-350', pen: 38, dmg: 175, vel: 680 }] },
   zis53_85: { name: '85 mm ZiS-S-53', cal: 85, len: 4.6, reload: 7.0, disp: 0.42, aim: 2.5, elev: 22, depr: -5, cap: 60,
      load: { AP: 36, APCR: 8, HE: 16 },
      ammo: [{ type: 'AP', name: 'BR-365', pen: 120, dmg: 180, vel: 792 }, { type: 'APCR', name: 'BR-365P', pen: 161, dmg: 180, vel: 1050 },
         { type: 'HE', name: 'O-365', pen: 44, dmg: 270, vel: 793 }] },
   d25_122: { name: '122 mm D-25T', cal: 122, len: 5.25, brake: true, reload: 12.5, disp: 0.46, aim: 3.1, elev: 20, depr: -3, cap: 28,
      load: { AP: 16, APCR: 4, HE: 8 },
      ammo: [{ type: 'AP', name: 'BR-471', pen: 175, dmg: 390, vel: 781 }, { type: 'APCR', name: 'BR-471B', pen: 217, dmg: 390, vel: 800, pen500: 200 },
         { type: 'HE', name: 'OF-471', pen: 68, dmg: 530, vel: 781 }] },
   // ---- Soviet guns for the I–X tree
   ps1_37: { name: '37 mm Hotchkiss PS-1', cal: 37, len: 0.8, reload: 1.9, disp: 0.48, aim: 1.6, elev: 25, depr: -8, cap: 96,
      load: { AP: 64, APCR: 16, HE: 16 },
      ammo: [{ type: 'AP', name: 'B-160', pen: 36, dmg: 36, vel: 400 }, { type: 'APCR', name: 'BR-160P', pen: 56, dmg: 36, vel: 600 }, { type: 'HE', name: 'O-160', pen: 16, dmg: 45, vel: 400 }] },
   k20_45: { name: '45 mm 20-K', cal: 45, len: 2.1, reload: 2.4, disp: 0.44, aim: 1.7, elev: 25, depr: -6, cap: 120,
      load: { AP: 80, APCR: 20, HE: 20 },
      ammo: [{ type: 'AP', name: 'BR-240', pen: 51, dmg: 47, vel: 760 }, { type: 'APCR', name: 'BR-240P', pen: 88, dmg: 47, vel: 985 }, { type: 'HE', name: 'O-240', pen: 23, dmg: 62, vel: 335 }] },
   l10_76: { name: '76 mm L-10', cal: 76, len: 1.9, reload: 4.6, disp: 0.46, aim: 2.2, elev: 25, depr: -5, cap: 69,
      load: { AP: 40, APCR: 9, HE: 20 },
      ammo: [{ type: 'AP', name: 'BR-350A', pen: 66, dmg: 110, vel: 555 }, { type: 'APCR', name: 'BR-350P', pen: 92, dmg: 110, vel: 800 }, { type: 'HE', name: 'OF-350', pen: 38, dmg: 175, vel: 555 }] },
   d10t_100: { name: '100 mm D-10T', cal: 100, len: 5.35, reload: 8.6, disp: 0.40, aim: 2.4, elev: 18, depr: -5, cap: 34,
      load: { AP: 20, APCR: 5, HE: 9 },
      ammo: [{ type: 'AP', name: 'BR-412B', pen: 185, dmg: 250, vel: 895 }, { type: 'APCR', name: 'BR-412D', pen: 235, dmg: 250, vel: 1120 },
         { type: 'HE', name: 'OF-412', pen: 50, dmg: 330, vel: 900 }] },
   u5ts_115: { name: '115 mm U-5TS', cal: 115, len: 6.0, reload: 7.6, disp: 0.33, aim: 2.2, elev: 16, depr: -6, cap: 40,
      load: { AP: 20, HEAT: 8, HE: 12 },
      ammo: [{ type: 'AP', name: '3BM3', pen: 270, dmg: 320, vel: 1615 }, { type: 'HEAT', name: '3BK4', pen: 330, dmg: 320, vel: 950 },
         { type: 'HE', name: 'OF-18', pen: 58, dmg: 440, vel: 905 }] },
   m62_122: { name: '122 mm M62-T2', cal: 122, len: 6.3, brake: true, reload: 12, disp: 0.40, aim: 2.8, elev: 18, depr: -5, cap: 30,
      load: { AP: 18, APCR: 4, HE: 8 },
      ammo: [{ type: 'AP', name: 'BR-472', pen: 250, dmg: 400, vel: 950 }, { type: 'APCR', name: 'BR-472B', pen: 300, dmg: 400, vel: 1100 },
         { type: 'HE', name: 'OF-472', pen: 68, dmg: 530, vel: 950 }] },
   s70_130: { name: '130 mm S-70', cal: 130, len: 7.6, brake: true, reload: 13.5, disp: 0.38, aim: 2.9, elev: 15, depr: -6, cap: 30,
      load: { AP: 18, APCR: 5, HE: 7 },
      ammo: [{ type: 'AP', name: 'BR-482B', pen: 255, dmg: 490, vel: 900 }, { type: 'APCR', name: 'BR-482P', pen: 303, dmg: 490, vel: 1050 },
         { type: 'HE', name: 'OF-482M', pen: 70, dmg: 640, vel: 900 }] },
   d10_100: { name: '100 mm D-10S', cal: 100, len: 5.35, reload: 9.5, disp: 0.38, aim: 2.4, elev: 15, depr: -3, cap: 33, arc: [-8, 8],
      load: { AP: 20, APCR: 5, HE: 8 },
      ammo: [{ type: 'AP', name: 'BR-412', pen: 175, dmg: 250, vel: 895 }, { type: 'APCR', name: 'BR-412D', pen: 235, dmg: 250, vel: 1120 },
         { type: 'HE', name: 'OF-412', pen: 50, dmg: 330, vel: 900 }] },
   m1_76: { name: '76 mm Gun M1A2', cal: 76, len: 4.2, brake: true, reload: 4.6, disp: 0.37, aim: 2.0, elev: 25, depr: -10, cap: 71,
      load: { AP: 45, APCR: 10, HE: 16 },
      ammo: [{ type: 'AP', name: 'M62 APC', pen: 128, dmg: 115, vel: 792 }, { type: 'APCR', name: 'M93 HVAP', pen: 177, dmg: 115, vel: 1036 },
         { type: 'HE', name: 'M42A1', pen: 38, dmg: 185, vel: 800 }] },
   m3_90: { name: '90 mm Gun M3', cal: 90, len: 4.73, brake: true, reload: 7.5, disp: 0.36, aim: 2.3, elev: 20, depr: -10, cap: 70,
      load: { AP: 42, APCR: 10, HE: 18 },
      ammo: [{ type: 'AP', name: 'M82 APC', pen: 160, dmg: 240, vel: 853 }, { type: 'APCR', name: 'M304 HVAP', pen: 243, dmg: 240, vel: 1021 },
         { type: 'HE', name: 'M71', pen: 45, dmg: 320, vel: 823 }] },
   pdr6: { name: 'QF 6-pdr Mk V', cal: 57, len: 2.95, reload: 3.1, disp: 0.36, aim: 1.7, elev: 20, depr: -12.5, cap: 75,
      load: { AP: 45, APCR: 15, HE: 15 },
      ammo: [{ type: 'AP', name: 'APCBC Mk 8', pen: 105, dmg: 85, vel: 890 }, { type: 'APCR', name: 'APDS Mk 1', pen: 170, dmg: 85, vel: 1150 },
         { type: 'HE', name: 'HE Mk 10', pen: 30, dmg: 110, vel: 820 }] },
   qf75: { name: 'QF 75 mm Mk V', cal: 75, len: 2.8, reload: 4.0, disp: 0.39, aim: 1.9, elev: 20, depr: -12.5, cap: 84,
      load: { AP: 50, APCR: 10, HE: 24 },
      ammo: [{ type: 'AP', name: 'M61 APCBC', pen: 91, dmg: 110, vel: 620 }, { type: 'APCR', name: 'M61 APC-T', pen: 108, dmg: 110, vel: 700 },
         { type: 'HE', name: 'M48 HE', pen: 38, dmg: 175, vel: 600 }] },
   // Churchill VII: the same OQF 75 mm as the Cromwell, but historically it fired only M72 AP-T,
   // M61 APC(BC) and M48 HE (no APDS / HEAT for the 75 mm); the 77 mm HV belonged to the Black Prince.
   qf75c: { name: 'OQF 75 mm Mk V', cal: 75, len: 2.8, reload: 4.2, disp: 0.39, aim: 1.9, elev: 20, depr: -12.5, cap: 84,
      load: { AP: 60, HE: 24 },
      ammo: [{ type: 'AP', name: 'M61 APCBC', pen: 91, dmg: 110, vel: 618 }, { type: 'HE', name: 'M48 HE', pen: 38, dmg: 175, vel: 463 }] },
   hv77: { name: 'OQF 77 mm HV', cal: 76.2, len: 3.85, reload: 5.2, disp: 0.35, aim: 2.0, elev: 20, depr: -12, cap: 61,
      load: { AP: 38, APCR: 8, HE: 15 },
      ammo: [{ type: 'AP', name: 'APCBC Mk 8', pen: 148, dmg: 150, vel: 785 }, { type: 'APCR', name: 'APDS Mk 1', pen: 202, dmg: 150, vel: 1120 },
         { type: 'HE', name: 'HE Mk 1', pen: 38, dmg: 190, vel: 650 }] },
};
const gun = (base, over = {}) => ({ ...base, ...over });

// Running gear presets.
const R = {
   christie: (o) => ({ wheels: 5, wheelR: 0.41, interleave: 0, rollers: 0, sprocket: 'rear', sprocketR: 0.32, idlerR: 0.3, trackW: 0.5, t: 20, ...o }),
   leaf: (o) => ({ wheels: 8, wheelR: 0.235, interleave: 0, bogies: 4, rollers: 4, sprocket: 'front', sprocketR: 0.3, idlerR: 0.28, trackW: 0.4, t: 20, ...o }),
   interleaved: (o) => ({ wheels: 8, wheelR: 0.43, interleave: 2, rollers: 0, sprocket: 'front', sprocketR: 0.38, idlerR: 0.33, trackW: 0.66, t: 25, ...o }),
   torsion: (o) => ({ wheels: 6, wheelR: 0.3, interleave: 0, rollers: 3, sprocket: 'rear', sprocketR: 0.32, idlerR: 0.3, trackW: 0.6, t: 20, ...o }),
};

// Octagonal turret helper: base width w, front/rear extents from the ring centre, chamfers,
// per-face [t, slope]. Returns { base, faces } (counter-clockwise seen from above).
function octTurret(w, lenF, lenR, cF, cR, f, cheek, s, rr, r) {
   const hw = w / 2;
   // CCW seen from above with x right and z towards the viewer's "down" (south) means:
   // front edge right->left, left side front->rear, rear left->right, right side rear->front.
   const base = [
      [hw - cF, -lenF], [-(hw - cF), -lenF], [-hw, -lenF + cF], [-hw, lenR - cR],
      [-(hw - cR), lenR], [hw - cR, lenR], [hw, lenR - cR], [hw, -lenF + cF],
   ];
   const F = (id, a) => ({ id, t: a[0], slope: a[1] });
   const faces = [F('tf', f), F('tcl', cheek), F('tsl', s), F('trl', rr), F('tr', r), F('trr', rr), F('tsr', s), F('tcr', cheek)];
   return { base, faces };
}

// ================================ VEHICLES ================================
// hull: { floorY, front:[[plate, t, deg, dy]...], roof:[t, len], rear:[[plate, t, deg, dy|null]...],
//         floorT, side:{ t, slope, tLow, tSpon }, w, lowerW?, sponsonY? }
//   front segments climb from the floor: deg = angle from vertical, + = top leans back (glacis),
//   − = top leans forward (lower nose). Rear segments descend from the roof: + = top leans
//   forward. The last rear segment's dy (null) is filled to reach the floor.
// turret: { z, ringR, h, roofT, oct:[w, lenF, lenR, cF, cR], f:[t,slope], cheek, s, rr, r, traverse, openTop }
const RAW = [
   // ---------------------------------------------------------------- Deutschland
   // parent: the tank whose XP researches this one (progress.js); the root of a nation has parent null.
   // DE: Leichttraktor -> Pz II -> Pz III E -> { Luchs (LT), Pz III J -> { Pz IV H -> VK 36.01 H -> { Panther, Tiger -> Tiger II -> E 75 -> { Maus, E 100 } },
   //     StuG III G -> Pz IV/70 -> Jagdpanther -> Ferdinand -> Jagdtiger } }
   {  // Rheinmetall Leichttraktor (1930): the turret sits at the rear, engine in front
      id: 'ltraktor', paint: 'grau', name: 'Leichttraktor', short: 'Leichttraktor', nation: 'DE', cls: 'LT', tier: 1, parent: null,
      hp: 130, mass: 9.5, engine: { hp: 100, fuel: 'petrol' }, vMax: 34, vRev: 12, traverse: 40, ground: [0.9, 1.0, 1.7],
      view: 300, camo: { still: 0.18, move: 0.14 }, crew: ['commander', 'gunner', 'driver'],
      hull: { floorY: 0.45, w: 1.75, front: [['lfp', 14, -40, 0.3], ['ufp', 14, 62, 0.55]], roof: [8, 3.0],
         rear: [['urp', 10, 8, 0.55], ['lrp', 10, -25, null]], floorT: 8, side: { t: 14 } },
      turret: { z: 0.75, ringR: 0.6, h: 0.62, roofT: 8, oct: [1.35, 0.75, 0.75, 0.22, 0.22], f: [14, 8], cheek: [14, 12], s: [14, 8], rr: [14, 8], r: [14, 8], traverse: 36 },
      mantlet: { w: 0.42, h: 0.3, d: 0.12, t: 14 },
      gun: gun(G.kwk36_37),
      run: R.leaf({ wheels: 12, wheelR: 0.17, bogies: 3, rollers: 4, trackW: 0.32, sprocketR: 0.26, idlerR: 0.24, len: 4.1, h: 0.82, t: 8 }),
      layout: { ammo: 'floor', fuel: 'rear' },
   },
   {  // Pz.Kpfw. II Ausf. C: five leaf-sprung road wheels, 2 cm autocannon in a small offset turret
      id: 'pz2', paint: 'grau', name: 'Pz.Kpfw. II Ausf. C', short: 'Pz II', nation: 'DE', cls: 'LT', tier: 2, parent: 'ltraktor',
      hp: 180, mass: 8.9, engine: { hp: 140, fuel: 'petrol' }, vMax: 40, vRev: 14, traverse: 48, ground: [0.9, 1.0, 1.6],
      view: 320, camo: { still: 0.20, move: 0.16 }, crew: ['commander', 'driver', 'radio'],
      hull: { floorY: 0.4, w: 1.75, front: [['lfp', 15, -50, 0.28], ['nose', 15, 30, 0.3], ['ufp', 15, 10, 0.42]], roof: [10, 3.55],
         rear: [['urp', 15, 12, 0.5], ['lrp', 10, -20, null]], floorT: 5, side: { t: 15 } },
      turret: { z: -0.2, ringR: 0.55, h: 0.6, roofT: 10, oct: [1.3, 0.65, 0.75, 0.2, 0.25], f: [30, 5], cheek: [15, 22], s: [15, 22], rr: [15, 22], r: [15, 22], traverse: 44 },
      mantlet: { w: 0.42, h: 0.28, d: 0.12, t: 15 },
      gun: gun(G.kwk30_20),
      run: R.leaf({ wheels: 5, wheelR: 0.28, bogies: 0, rollers: 4, trackW: 0.3, sprocketR: 0.26, idlerR: 0.25, len: 4.5, h: 0.85, t: 10 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Pz.Kpfw. III Ausf. E (rearmed with the 5 cm KwK 38): six torsion-bar road wheels, five-man crew
      id: 'pz3e', paint: 'grau', name: 'Pz.Kpfw. III Ausf. E', short: 'Pz III E', nation: 'DE', cls: 'MT', tier: 3, parent: 'pz2',
      hp: 280, mass: 19.5, engine: { hp: 300, fuel: 'petrol' }, vMax: 40, vRev: 14, traverse: 38, ground: [0.9, 1.05, 1.8],
      view: 330, camo: { still: 0.14, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.45, w: 2.85, lowerW: 1.85, sponsonY: 1.0, front: [['lfp', 30, -65, 0.25], ['nose', 30, 20, 0.3], ['glac', 25, 76, 0.13], ['ufp', 30, 9, 0.6]],
         roof: [16, 4.0], rear: [['urp', 20, 10, 0.55], ['lrp', 20, -25, null]], floorT: 16, side: { t: 30, tLow: 30, tSpon: 15 } },
      turret: { z: -0.25, ringR: 0.76, h: 0.72, roofT: 12, oct: [1.8, 0.85, 1.05, 0.3, 0.3], f: [30, 15], cheek: [30, 25], s: [30, 25], rr: [30, 15], r: [30, 15], traverse: 32 },
      mantlet: { w: 0.62, h: 0.4, d: 0.12, t: 30 },
      gun: gun(G.kwk38_50, { reload: 3.0 }),
      run: R.torsion({ wheels: 6, wheelR: 0.27, rollers: 3, trackW: 0.38, sprocketR: 0.3, idlerR: 0.28, len: 5.0, h: 0.92, t: 15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Pz.Kpfw. III Ausf. J: 50 mm face-hardened front and the long 5 cm L/60
      id: 'pz3j', name: 'Pz.Kpfw. III Ausf. J', short: 'Pz III J', nation: 'DE', cls: 'MT', tier: 4, parent: 'pz3e',
      hp: 400, mass: 21.5, engine: { hp: 300, fuel: 'petrol' }, vMax: 40, vRev: 14, traverse: 36, ground: [0.95, 1.05, 1.85],
      view: 340, camo: { still: 0.14, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.45, w: 2.9, lowerW: 1.85, sponsonY: 1.0, front: [['lfp', 50, -65, 0.25], ['nose', 50, 20, 0.3], ['glac', 25, 76, 0.13], ['ufp', 50, 9, 0.6]],
         roof: [16, 4.1], rear: [['urp', 50, 10, 0.55], ['lrp', 50, -25, null]], floorT: 16, side: { t: 30, tLow: 30, tSpon: 15 } },
      turret: { z: -0.25, ringR: 0.76, h: 0.74, roofT: 12, oct: [1.85, 0.85, 1.1, 0.3, 0.3], f: [50, 15], cheek: [30, 25], s: [30, 25], rr: [30, 15], r: [30, 15], traverse: 30 },
      mantlet: { w: 0.62, h: 0.42, d: 0.14, t: 50 },
      skirts: { t: 5, h: 0.6, y0: 0.5 },
      gun: gun(G.kwk39_50, { reload: 3.0 }),
      run: R.torsion({ wheels: 6, wheelR: 0.27, rollers: 3, trackW: 0.4, sprocketR: 0.3, idlerR: 0.28, len: 5.1, h: 0.92, t: 15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Sturmgeschütz III Ausf. G: low casemate on the Pz III chassis, 7.5 cm StuK 40 L/48
      id: 'stug3g', name: 'StuG III Ausf. G', short: 'StuG III', nation: 'DE', cls: 'TD', tier: 5, parent: 'pz3j',
      hp: 520, mass: 23.9, engine: { hp: 300, fuel: 'petrol' }, vMax: 40, vRev: 14, traverse: 34, ground: [0.95, 1.05, 1.85],
      view: 340, camo: { still: 0.22, move: 0.13 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.45, w: 2.95, lowerW: 1.85, sponsonY: 1.0, front: [['lfp', 50, -65, 0.25], ['nose', 80, 20, 0.3], ['glac', 25, 76, 0.13], ['ufp', 80, 12, 0.72]],
         roof: [10, 2.2], rear: [['eng', 16, 76, 0.42], ['urp', 50, 10, 0.55], ['lrp', 50, -25, null]], floorT: 16, side: { t: 30, slope: 10, tLow: 30, tSpon: 15 } },
      turret: null,
      mantlet: { w: 0.62, h: 0.45, d: 0.3, t: 80 },
      skirts: { t: 5, h: 0.6, y0: 0.5 },
      gun: gun(G.kwk40_75, { name: '7,5 cm StuK 40 L/48', reload: 5.0, disp: 0.34, aim: 2.0, elev: 20, depr: -6, arc: [-10, 10], mount: 'hull', pivotY: 1.55, pivotX: 0.12, traverse: 10 }),
      run: R.torsion({ wheels: 6, wheelR: 0.27, rollers: 3, trackW: 0.4, sprocketR: 0.3, idlerR: 0.28, len: 5.1, h: 0.92, t: 15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Panzer IV/70 (V): Vomag's sloped casemate on the Pz IV hull with the Panther's 7.5 cm L/70
      id: 'pz4_70', name: 'Panzer IV/70 (V)', short: 'Pz IV/70', nation: 'DE', cls: 'TD', tier: 6, parent: 'stug3g',
      hp: 820, mass: 25.8, engine: { hp: 265, fuel: 'petrol' }, vMax: 35, vRev: 12, traverse: 32, ground: [1.0, 1.1, 1.9],
      view: 350, camo: { still: 0.24, move: 0.14 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.4, w: 2.9, lowerW: 2.05, sponsonY: 0.95, front: [['lfp', 50, -45, 0.35], ['ufp', 80, 45, 0.88]], roof: [20, 2.6],
         rear: [['eng', 20, 78, 0.25], ['urp', 20, 10, 0.55], ['lrp', 20, -25, null]], floorT: 10, side: { t: 40, slope: 30, tLow: 30, tSpon: 20 } },
      turret: null,
      mantlet: { w: 0.55, h: 0.45, d: 0.3, t: 80 },
      skirts: { t: 5, h: 0.65, y0: 0.5 },
      gun: gun(G.kwk42_75, { name: '7,5 cm PaK 42 L/70', reload: 4.6, disp: 0.32, aim: 1.9, elev: 15, depr: -6, arc: [-10, 10], mount: 'hull', pivotY: 1.4, pivotX: 0.15, traverse: 10 }),
      run: R.leaf({ len: 5.3, h: 0.95 }),
      layout: { ammo: 'sponson', fuel: 'floor' },
   },
   {  // VK 36.01 (H): Henschel's Tiger forerunner, interleaved wheels, the 8.8 cm in a smaller turret
      id: 'vk3601', name: 'VK 36.01 (H)', short: 'VK 36.01', nation: 'DE', cls: 'HT', tier: 6, parent: 'pz4h',
      hp: 1050, mass: 40, engine: { hp: 650, fuel: 'petrol' }, vMax: 40, vRev: 13, traverse: 26, ground: [1.05, 1.25, 2.1],
      view: 360, camo: { still: 0.06, move: 0.03 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.47, w: 3.15, lowerW: 1.8, sponsonY: 1.08,
         front: [['lfp', 80, -30, 0.3], ['glac', 50, 78, 0.12], ['ufp', 100, 10, 0.68]], roof: [25, 4.75],
         rear: [['urp', 60, 8, 0.8], ['lrp', 25, -45, null]], floorT: 20, side: { t: 60, tLow: 60, tSpon: 20 } },
      turret: { z: -0.15, ringR: 0.88, h: 0.82, roofT: 25, oct: [2.0, 0.9, 1.2, 0.25, 0.45], f: [100, 8], cheek: [80, 0], s: [60, 0], rr: [60, 0], r: [60, 0], traverse: 22 },
      mantlet: { w: 1.45, h: 0.58, d: 0.18, t: 100 },
      gun: gun(G.kwk36_88, { reload: 8.4, disp: 0.38, aim: 2.4 }),
      run: R.interleaved({ wheels: 7, wheelR: 0.4, interleave: 2, trackW: 0.6, len: 5.2, h: 1.05 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Ferdinand: Porsche's Tiger hull with the fighting compartment at the rear, 200 mm front, PaK 43/2
      id: 'ferdinand', name: 'Ferdinand', short: 'Ferdinand', nation: 'DE', cls: 'TD', tier: 8, parent: 'jagdpanther',
      hp: 1600, mass: 65, engine: { hp: 600, fuel: 'petrol' }, vMax: 30, vRev: 10, traverse: 20, ground: [1.15, 1.35, 2.4],
      view: 360, camo: { still: 0.10, move: 0.05 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.5, w: 3.38, lowerW: 2.1, sponsonY: 1.2,
         front: [['lfp', 200, -35, 0.38], ['ufp', 200, 10, 0.55], ['deck', 30, 87, 0.1], ['cas', 200, 30, 0.95]], roof: [30, 3.4],
         rear: [['urp', 80, 0, 1.3], ['lrp', 80, -15, null]], floorT: 20, side: { t: 80, tLow: 80, tSpon: 30 } },
      turret: null,
      mantlet: { w: 0.7, h: 0.6, d: 0.35, t: 120 },
      gun: gun(G.kwk43_88, { name: '8,8 cm PaK 43/2 L/71', reload: 7.6, disp: 0.30, aim: 1.9, elev: 14, depr: -8, arc: [-14, 14], mount: 'hull', pivotY: 2.15, pivotX: 0, traverse: 10 }),
      run: R.torsion({ wheels: 6, wheelR: 0.4, rollers: 0, sprocket: 'rear', trackW: 0.64, sprocketR: 0.38, idlerR: 0.36, len: 6.8, h: 1.2, t: 25 }),
      layout: { ammo: 'sponson', fuel: 'sides' },
   },
   {  // E 75: the E-series successor of the Tiger II, thicker plates, 10.5 cm L/68 in a Tiger II-style turret
      id: 'e75', name: 'E 75', short: 'E 75', nation: 'DE', cls: 'HT', tier: 9, parent: 'tiger2',
      hp: 1950, mass: 80, engine: { hp: 1100, fuel: 'petrol' }, vMax: 40, vRev: 12, traverse: 26, ground: [1.1, 1.3, 2.2],
      view: 390, camo: { still: 0.03, move: 0.01 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.5, w: 3.7, lowerW: 2.0, sponsonY: 1.18, front: [['lfp', 120, -50, 0.55], ['ufp', 160, 52, 0.97]], roof: [40, 5.9],
         rear: [['urp', 80, 30, 0.97], ['lrp', 40, -45, null]], floorT: 30, side: { t: 120, slope: 25, tLow: 80, tSpon: 30 } },
      turret: { z: -0.3, ringR: 0.96, h: 0.88, roofT: 40, oct: [2.6, 1.05, 1.8, 0.32, 0.15], f: [250, 9], cheek: [150, 21], s: [120, 21], rr: [120, 21], r: [120, 21], traverse: 24 },
      mantlet: { w: 0.8, h: 0.72, d: 0.38, t: 120 },
      skirts: { t: 10, h: 0.7, y0: 0.55 },
      gun: gun(G.kwk46_105),
      run: R.interleaved({ wheels: 9, wheelR: 0.42, interleave: 2, trackW: 0.82, len: 6.8, h: 1.18 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Jagdtiger: Tiger II hull with a 250 mm casemate and the 12.8 cm PaK 44
      id: 'jagdtiger', name: 'Jagdtiger', short: 'Jagdtiger', nation: 'DE', cls: 'TD', tier: 9, parent: 'ferdinand',
      hp: 1850, mass: 71.7, engine: { hp: 700, fuel: 'petrol' }, vMax: 34, vRev: 12, traverse: 22, ground: [1.15, 1.35, 2.4],
      view: 370, camo: { still: 0.08, move: 0.04 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.49, w: 3.63, lowerW: 1.95, sponsonY: 1.15, front: [['lfp', 100, -50, 0.55], ['ufp', 150, 50, 0.95], ['cas', 250, 15, 0.92]], roof: [40, 3.6],
         rear: [['crp', 80, 5, 0.9], ['eng', 40, 88, 0.05], ['urp', 80, 30, 0.5], ['lrp', 40, -45, null]], floorT: 25, side: { t: 80, slope: 25, tLow: 80, tSpon: 25 } },
      turret: null,
      mantlet: { w: 0.85, h: 0.75, d: 0.4, t: 160 },
      gun: gun(G.kwk44_128, { name: '12,8 cm PaK 44 L/55', reload: 12.5, disp: 0.32, aim: 2.3, elev: 15, depr: -7, arc: [-10, 10], mount: 'hull', pivotY: 1.98, pivotX: 0, traverse: 9 }),
      run: R.interleaved({ wheels: 9, wheelR: 0.4, interleave: 2, trackW: 0.8, len: 6.9, h: 1.15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {  // Maus: 188 t super-heavy, box hull with skirts over the tracks, 12.8 cm and a coaxial 7.5 cm in a round-fronted turret
      id: 'maus', name: 'Pz.Kpfw. VIII Maus', short: 'Maus', nation: 'DE', cls: 'HT', tier: 10, parent: 'e75', look: 'maus',
      hp: 2250, mass: 188, engine: { hp: 1200, fuel: 'petrol' }, vMax: 20, vRev: 8, traverse: 16, ground: [1.2, 1.4, 2.6],
      view: 390, camo: { still: 0.02, move: 0.01 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.55, w: 3.67, lowerW: 2.0, sponsonY: 1.25, front: [['lfp', 200, -35, 0.65], ['ufp', 200, 55, 0.95]], roof: [60, 6.9],
         rear: [['urp', 160, 30, 0.95], ['lrp', 160, -30, null]], floorT: 50, side: { t: 180, tLow: 100, tSpon: 50 } },
      turret: { z: 0.75, ringR: 1.15, h: 1.1, roofT: 60, oct: [3.4, 1.45, 2.1, 0.75, 0.45], f: [240, 0], cheek: [220, 15], s: [200, 30], rr: [200, 15], r: [200, 15], traverse: 14 },
      mantlet: { w: 1.2, h: 0.9, d: 0.35, t: 220 },
      skirts: { t: 100, h: 0.85, y0: 0.42 },
      gun: gun(G.kwk44_128, { reload: 14.5 }),
      run: R.interleaved({ wheels: 12, wheelR: 0.3, interleave: 2, trackW: 1.1, len: 7.7, h: 1.25, t: 40 }),
      layout: { ammo: 'sponson', fuel: 'sides' },
   },
   {  // E 100: the long E-series hull with heavy side skirts and a Tiger II-style turret holding the 15 cm KwK 44
      id: 'e100', name: 'E 100', short: 'E 100', nation: 'DE', cls: 'HT', tier: 10, parent: 'e75',
      hp: 2300, mass: 140, engine: { hp: 1200, fuel: 'petrol' }, vMax: 30, vRev: 10, traverse: 20, ground: [1.15, 1.35, 2.5],
      view: 390, camo: { still: 0.02, move: 0.01 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.55, w: 3.75, lowerW: 2.15, sponsonY: 1.25, front: [['lfp', 150, -50, 0.6], ['ufp', 200, 60, 1.0]], roof: [40, 6.5],
         rear: [['urp', 150, 30, 1.0], ['lrp', 80, -30, null]], floorT: 40, side: { t: 120, tLow: 120, tSpon: 40 } },
      turret: { z: -0.35, ringR: 1.15, h: 1.0, roofT: 50, oct: [3.15, 1.2, 2.15, 0.42, 0.2], f: [250, 9], cheek: [200, 21], s: [150, 25], rr: [150, 25], r: [150, 25], traverse: 18 },
      mantlet: { w: 0.95, h: 0.8, d: 0.45, t: 150 },
      skirts: { t: 60, h: 0.9, y0: 0.45 },
      gun: gun(G.kwk44_150),
      run: R.interleaved({ wheels: 10, wheelR: 0.45, interleave: 2, trackW: 1.0, len: 7.9, h: 1.25, t: 40 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'luchs', name: 'Pz.Kpfw. II Luchs', short: 'Luchs', nation: 'DE', cls: 'LT', tier: 4, parent: 'pz3e',
      hp: 380, mass: 13.0, engine: { hp: 180, fuel: 'petrol' }, vMax: 60, vRev: 20, traverse: 45, ground: [0.9, 1.0, 1.6],
      view: 360, camo: { still: 0.19, move: 0.19 }, crew: ['commander', 'gunner', 'driver', 'radio'],
      hull: { floorY: 0.42, w: 1.75, front: [['lfp', 30, -45, 0.3], ['ufp', 30, 12, 0.5]], roof: [10, 3.85],
         rear: [['urp', 20, 15, 0.4], ['lrp', 20, -30, null]], floorT: 10, side: { t: 20 } },
      turret: { z: -0.1, ringR: 0.62, h: 0.62, roofT: 10, oct: [1.5, 0.8, 0.75, 0.25, 0.2], f: [30, 10], cheek: [30, 20], s: [20, 22], rr: [20, 22], r: [20, 22], traverse: 40 },
      mantlet: { w: 0.5, h: 0.32, d: 0.14, t: 30 },
      gun: gun(G.kwk39_50),
      run: R.interleaved({ wheels: 5, wheelR: 0.36, interleave: 2, trackW: 0.36, sprocketR: 0.3, idlerR: 0.28, len: 4.3, h: 0.85, t: 15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'pz4h', name: 'Pz.Kpfw. IV Ausf. H', short: 'Pz IV H', nation: 'DE', cls: 'MT', tier: 5, parent: 'pz3j',
      hp: 520, mass: 25.7, engine: { hp: 300, fuel: 'petrol' }, vMax: 40, vRev: 12, traverse: 36, ground: [1.0, 1.1, 1.9],
      view: 350, camo: { still: 0.14, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.4, w: 2.05, front: [['lfp', 30, -55, 0.25], ['nose', 80, 14, 0.4], ['glac', 25, 72, 0.15], ['ufp', 80, 10, 0.55]],
         roof: [16, 5.1], rear: [['urp', 20, 10, 0.6], ['lrp', 20, -25, null]], floorT: 10, side: { t: 30 } },
      turret: { z: -0.3, ringR: 0.8, h: 0.7, roofT: 18, oct: [1.75, 0.85, 1.05, 0.35, 0.3], f: [50, 10], cheek: [30, 25], s: [30, 25], rr: [30, 20], r: [30, 15], traverse: 26 },
      mantlet: { w: 0.7, h: 0.42, d: 0.12, t: 50 },
      skirts: { t: 5, h: 0.75, y0: 0.55 },
      gun: gun(G.kwk40_75),
      run: R.leaf({ len: 5.3, h: 0.95 }),
      layout: { ammo: 'sponson', fuel: 'floor' },
   },
   {
      id: 'panther', name: 'Panther Ausf. A', short: 'Panther', nation: 'DE', cls: 'MT', tier: 7, parent: 'vk3601',
      hp: 1300, mass: 44.8, engine: { hp: 700, fuel: 'petrol' }, vMax: 46, vRev: 15, traverse: 30, ground: [1.0, 1.1, 1.8],
      view: 380, camo: { still: 0.10, move: 0.07 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.56, w: 3.3, lowerW: 1.95, sponsonY: 1.15, front: [['lfp', 60, -55, 0.5], ['ufp', 80, 55, 0.85]], roof: [16, 5.14],
         rear: [['urp', 40, 30, 0.9], ['lrp', 16, -55, null]], floorT: 16, side: { t: 40, slope: 40, tLow: 40, tSpon: 16 } },
      turret: { z: -0.1, ringR: 0.83, h: 0.92, roofT: 16, oct: [2.1, 1.05, 1.25, 0.35, 0.2], f: [100, 12], cheek: [45, 25], s: [45, 25], rr: [45, 25], r: [45, 25], traverse: 30 },
      mantlet: { w: 1.05, h: 0.55, d: 0.2, t: 100 },
      skirts: { t: 5, h: 0.6, y0: 0.6 },
      gun: gun(G.kwk42_75),
      run: R.interleaved({ wheels: 8, len: 6.2, h: 1.15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'tiger1', name: 'Tiger I', short: 'Tiger', nation: 'DE', cls: 'HT', tier: 7, parent: 'vk3601',
      hp: 1500, mass: 57, engine: { hp: 700, fuel: 'petrol' }, vMax: 40, vRev: 12, traverse: 23, ground: [1.1, 1.3, 2.2],
      view: 370, camo: { still: 0.04, move: 0.02 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.47, w: 3.4, lowerW: 1.85, sponsonY: 1.1,
         front: [['belly', 25, -60, 0.15], ['lfp', 100, 24, 0.35], ['glac', 60, 80, 0.1], ['ufp', 100, 9, 0.78]], roof: [25, 5.35],
         rear: [['urp', 80, 8, 0.9], ['lrp', 25, -50, null]], floorT: 25, side: { t: 80, tLow: 60, tSpon: 25 } },
      turret: { z: -0.1, ringR: 0.93, h: 0.85, roofT: 25, oct: [2.15, 0.95, 1.35, 0.25, 0.55], f: [100, 8], cheek: [80, 0], s: [80, 0], rr: [80, 0], r: [80, 0], traverse: 20 },
      mantlet: { w: 1.7, h: 0.62, d: 0.2, t: 110 },
      gun: gun(G.kwk36_88),
      run: R.interleaved({ wheels: 8, wheelR: 0.4, interleave: 3, trackW: 0.725, len: 5.6, h: 1.1 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'tiger2', name: 'Tiger II', short: 'Tiger II', nation: 'DE', cls: 'HT', tier: 8, parent: 'tiger1',
      hp: 1750, mass: 68.5, engine: { hp: 700, fuel: 'petrol' }, vMax: 38, vRev: 12, traverse: 26, ground: [1.1, 1.3, 2.3],
      view: 380, camo: { still: 0.03, move: 0.01 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.49, w: 3.6, lowerW: 1.95, sponsonY: 1.15, front: [['lfp', 100, -50, 0.55], ['ufp', 150, 50, 0.95]], roof: [40, 5.7],
         rear: [['urp', 80, 30, 0.95], ['lrp', 40, -45, null]], floorT: 25, side: { t: 80, slope: 25, tLow: 80, tSpon: 25 } },
      turret: { z: -0.3, ringR: 0.93, h: 0.85, roofT: 40, oct: [2.5, 1.0, 1.75, 0.3, 0.15], f: [180, 9], cheek: [80, 21], s: [80, 21], rr: [80, 21], r: [80, 21], traverse: 24 },
      mantlet: { w: 0.75, h: 0.7, d: 0.35, t: 100 },
      gun: gun(G.kwk43_88),
      run: R.interleaved({ wheels: 9, wheelR: 0.4, interleave: 2, trackW: 0.8, len: 6.6, h: 1.15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'jagdpanther', name: 'Jagdpanther', short: 'Jagdpanther', nation: 'DE', cls: 'TD', tier: 7, parent: 'pz4_70',
      hp: 1200, mass: 46, engine: { hp: 700, fuel: 'petrol' }, vMax: 46, vRev: 15, traverse: 28, ground: [1.0, 1.1, 1.8],
      view: 360, camo: { still: 0.17, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.56, w: 3.3, lowerW: 1.95, sponsonY: 1.15, front: [['lfp', 60, -55, 0.5], ['ufp', 80, 55, 1.15]], roof: [25, 3.44],
         rear: [['eng', 25, 72, 0.45], ['urp', 40, 30, 0.7], ['lrp', 16, -55, null]], floorT: 16, side: { t: 50, slope: 30, tLow: 40, tSpon: 16 } },
      turret: null,
      mantlet: { w: 0.8, h: 0.7, d: 0.35, t: 120 },
      gun: gun(G.kwk43_88, { name: '8,8 cm PaK 43/3 L/71', reload: 7.5, disp: 0.30, aim: 1.9, elev: 14, depr: -8, arc: [-11, 11], mount: 'hull', pivotY: 1.72, pivotX: 0.1, traverse: 12 }),
      run: R.interleaved({ wheels: 8, len: 6.2, h: 1.15 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   // ---------------------------------------------------------------- Sowjetunion
   // SU: MS-1 -> T-26 -> BT-7 -> T-28 -> { T-34/76 -> { T-34-85 -> T-44 -> T-44-100 -> T-54 -> T-62A, SU-100 (TD) },
   //     KV-1 -> KV-85 -> IS-2 -> IS-3 -> IS-4 -> IS-7 }
   {
      id: 'ms1', paint: 'su30', name: 'MS-1', short: 'MS-1', nation: 'SU', cls: 'LT', tier: 1, parent: null,
      hp: 120, mass: 5.5, engine: { hp: 60, fuel: 'petrol' }, vMax: 28, vRev: 10, traverse: 44, ground: [0.9, 1.0, 1.7],
      view: 290, camo: { still: 0.22, move: 0.18 }, crew: ['commander', 'driver'],
      hull: { floorY: 0.4, w: 1.45, front: [['lfp', 16, -35, 0.32], ['ufp', 16, 35, 0.5]], roof: [8, 2.35],
         rear: [['urp', 16, 0, 0.5], ['lrp', 8, -25, null]], floorT: 8, side: { t: 16 } },
      turret: { z: -0.15, ringR: 0.48, h: 0.62, roofT: 8, oct: [1.05, 0.52, 0.55, 0.26, 0.26], f: [16, 4], cheek: [16, 4], s: [16, 4], rr: [16, 4], r: [16, 4], traverse: 40 },
      mantlet: { w: 0.32, h: 0.26, d: 0.1, t: 16 },
      gun: gun(G.ps1_37),
      run: R.leaf({ wheels: 6, wheelR: 0.17, bogies: 3, rollers: 3, trackW: 0.3, sprocket: 'rear', sprocketR: 0.24, idlerR: 0.24, len: 3.4, h: 0.8, t: 8 }),
      layout: { ammo: 'floor', fuel: 'rear' },
   },
   {
      id: 't26', paint: 'su30', name: 'T-26 (1933)', short: 'T-26', nation: 'SU', cls: 'LT', tier: 2, parent: 'ms1',
      hp: 190, mass: 9.4, engine: { hp: 90, fuel: 'petrol' }, vMax: 31, vRev: 12, traverse: 42, ground: [0.95, 1.05, 1.8],
      view: 310, camo: { still: 0.19, move: 0.15 }, crew: ['commander', 'loader', 'driver'],
      hull: { floorY: 0.38, w: 1.95, front: [['lfp', 15, -50, 0.3], ['ufp', 15, 22, 0.58]], roof: [10, 3.2],
         rear: [['urp', 15, 0, 0.55], ['lrp', 10, -25, null]], floorT: 6, side: { t: 15 } },
      turret: { z: -0.05, ringR: 0.65, h: 0.62, roofT: 10, oct: [1.6, 0.75, 0.95, 0.32, 0.32], f: [15, 0], cheek: [15, 0], s: [15, 0], rr: [15, 0], r: [15, 0], traverse: 38 },
      mantlet: { w: 0.4, h: 0.3, d: 0.12, t: 15 },
      gun: gun(G.k20_45),
      run: R.leaf({ wheels: 8, wheelR: 0.18, bogies: 4, rollers: 4, trackW: 0.26, len: 4.0, h: 0.82, t: 8 }),
      layout: { ammo: 'floor', fuel: 'rear' },
   },
   {
      id: 'bt7', paint: 'su30', name: 'BT-7', short: 'BT-7', nation: 'SU', cls: 'LT', tier: 3, parent: 't26',
      hp: 300, mass: 13.8, engine: { hp: 320, fuel: 'petrol' }, vMax: 52, vRev: 16, traverse: 46, ground: [0.85, 1.0, 1.6],
      view: 330, camo: { still: 0.18, move: 0.15 }, crew: ['commander', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 1.9, front: [['lfp', 13, -55, 0.32], ['ufp', 20, 18, 0.48]], roof: [10, 4.0],
         rear: [['urp', 13, 40, 0.5], ['lrp', 10, -20, null]], floorT: 6, side: { t: 13 } },
      turret: { z: -0.45, ringR: 0.66, h: 0.66, roofT: 10, oct: [1.75, 0.85, 1.15, 0.35, 0.35], f: [15, 10], cheek: [15, 20], s: [15, 20], rr: [15, 20], r: [15, 20], traverse: 40 },
      mantlet: { w: 0.42, h: 0.3, d: 0.12, t: 15 },
      gun: gun(G.k20_45, { reload: 2.2 }),
      run: R.christie({ wheels: 4, wheelR: 0.41, trackW: 0.26, len: 5.0, h: 0.95, t: 12 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't28', paint: 'su30', look: 't28', name: 'T-28', short: 'T-28', nation: 'SU', cls: 'MT', tier: 4, parent: 'bt7',
      hp: 420, mass: 25.4, engine: { hp: 500, fuel: 'petrol' }, vMax: 37, vRev: 12, traverse: 34, ground: [0.95, 1.1, 1.9],
      view: 340, camo: { still: 0.09, move: 0.07 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.45, w: 2.8, front: [['lfp', 20, -35, 0.42], ['ufp', 30, 12, 0.72]], roof: [15, 5.6],
         rear: [['urp', 20, 10, 0.6], ['lrp', 20, -25, null]], floorT: 15, side: { t: 20 } },
      turret: { z: 0.1, ringR: 0.8, h: 0.75, roofT: 15, oct: [2.0, 0.95, 1.35, 0.4, 0.35], f: [30, 8], cheek: [20, 15], s: [20, 15], rr: [20, 15], r: [20, 15], traverse: 30 },
      mantlet: { w: 0.55, h: 0.38, d: 0.14, t: 30 },
      skirts: { t: 10, h: 0.55, y0: 0.5 },
      gun: gun(G.l10_76),
      run: R.leaf({ wheels: 12, wheelR: 0.2, bogies: 6, rollers: 4, trackW: 0.38, sprocket: 'rear', len: 6.4, h: 0.95, t: 15 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'kv85', name: 'KV-85', short: 'KV-85', nation: 'SU', cls: 'HT', tier: 6, parent: 'kv1',
      hp: 1150, mass: 46, engine: { hp: 600, fuel: 'diesel' }, vMax: 42, vRev: 13, traverse: 26, ground: [1.05, 1.2, 2.0],
      view: 350, camo: { still: 0.05, move: 0.03 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.43, w: 3.25, lowerW: 1.9, sponsonY: 1.15, front: [['lfp', 75, -30, 0.4], ['glac', 60, 65, 0.25], ['ufp', 75, 25, 0.8]],
         roof: [30, 5.0], rear: [['urp', 60, 30, 0.85], ['lrp', 60, -40, null]], floorT: 30, side: { t: 60, tLow: 60, tSpon: 30 } },
      turret: { z: -0.3, ringR: 0.9, h: 0.8, roofT: 30, oct: [2.25, 1.0, 1.35, 0.45, 0.5], f: [100, 20], cheek: [100, 30], s: [90, 20], rr: [90, 25], r: [90, 25], traverse: 22 },
      mantlet: { w: 0.85, h: 0.5, d: 0.22, t: 100 },
      gun: gun(G.zis53_85, { name: '85 mm D-5T', reload: 7.0 }),
      run: R.torsion({ wheels: 6, wheelR: 0.3, trackW: 0.7, len: 5.8, h: 1.1 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't44', name: 'T-44', short: 'T-44', nation: 'SU', cls: 'MT', tier: 7, parent: 't34_85',
      hp: 1250, mass: 31.8, engine: { hp: 520, fuel: 'diesel' }, vMax: 51, vRev: 18, traverse: 42, ground: [0.9, 1.0, 1.5],
      view: 370, camo: { still: 0.13, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 3.0, front: [['lfp', 90, -30, 0.3], ['ufp', 120, 60, 0.72]], roof: [20, 4.1],
         rear: [['urp', 45, 45, 0.5], ['lrp', 45, -30, null]], floorT: 15, side: { t: 75 } },
      turret: { z: -0.55, ringR: 0.85, h: 0.72, roofT: 20, oct: [2.3, 0.95, 1.4, 0.35, 0.3], f: [120, 15], cheek: [90, 25], s: [75, 20], rr: [60, 15], r: [60, 10], traverse: 38 },
      mantlet: { w: 0.75, h: 0.45, d: 0.2, t: 120 },
      gun: gun(G.zis53_85, { reload: 6.4, disp: 0.38 }),
      run: R.torsion({ wheels: 5, wheelR: 0.415, rollers: 0, trackW: 0.5, len: 5.5, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't44_100', name: 'T-44-100', short: 'T-44-100', nation: 'SU', cls: 'MT', tier: 8, parent: 't44',
      hp: 1500, mass: 34, engine: { hp: 520, fuel: 'diesel' }, vMax: 50, vRev: 18, traverse: 40, ground: [0.9, 1.0, 1.5],
      view: 380, camo: { still: 0.12, move: 0.09 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 3.0, front: [['lfp', 90, -30, 0.3], ['ufp', 120, 60, 0.72]], roof: [20, 4.1],
         rear: [['urp', 45, 45, 0.5], ['lrp', 45, -30, null]], floorT: 15, side: { t: 75 } },
      turret: { z: -0.5, ringR: 0.9, h: 0.75, roofT: 25, oct: [2.4, 1.05, 1.4, 0.45, 0.4], f: [160, 20], cheek: [130, 30], s: [90, 25], rr: [75, 20], r: [60, 15], traverse: 34 },
      mantlet: { w: 0.8, h: 0.5, d: 0.22, t: 160 },
      gun: gun(G.d10t_100),
      run: R.torsion({ wheels: 5, wheelR: 0.415, rollers: 0, trackW: 0.55, len: 5.5, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't54', name: 'T-54 (1949)', short: 'T-54', nation: 'SU', cls: 'MT', tier: 9, parent: 't44_100',
      hp: 1800, mass: 36, engine: { hp: 520, fuel: 'diesel' }, vMax: 50, vRev: 18, traverse: 44, ground: [0.85, 1.0, 1.45],
      view: 390, camo: { still: 0.14, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 3.27, front: [['lfp', 100, -55, 0.42], ['ufp', 100, 60, 0.78]], roof: [30, 4.6],
         rear: [['urp', 45, 20, 0.6], ['lrp', 20, -20, null]], floorT: 20, side: { t: 80 } },
      turret: { z: -0.45, ringR: 0.92, h: 0.78, roofT: 30, oct: [2.55, 1.2, 1.25, 0.62, 0.58], f: [200, 30], cheek: [200, 38], s: [160, 42], rr: [130, 42], r: [65, 42], traverse: 40 },
      mantlet: { w: 0.7, h: 0.48, d: 0.18, t: 200 },
      gun: gun(G.d10t_100, { reload: 8.0, disp: 0.35, aim: 2.2, ammo: [{ type: 'AP', name: 'BR-412D', pen: 210, dmg: 300, vel: 895 },
         { type: 'APCR', name: 'BR-412P', pen: 270, dmg: 300, vel: 1120 }, { type: 'HE', name: 'OF-412', pen: 50, dmg: 400, vel: 900 }] }),
      run: R.torsion({ wheels: 5, wheelR: 0.41, rollers: 0, trackW: 0.58, len: 5.8, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't62a', name: 'T-62A', short: 'T-62A', nation: 'SU', cls: 'MT', tier: 10, parent: 't54',
      hp: 2000, mass: 37.5, engine: { hp: 580, fuel: 'diesel' }, vMax: 50, vRev: 20, traverse: 46, ground: [0.85, 1.0, 1.45],
      view: 400, camo: { still: 0.14, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 3.3, front: [['lfp', 100, -55, 0.42], ['ufp', 100, 60, 0.78]], roof: [30, 5.0],
         rear: [['urp', 45, 20, 0.6], ['lrp', 20, -20, null]], floorT: 20, side: { t: 80 } },
      turret: { z: -0.35, ringR: 1.0, h: 0.78, roofT: 30, oct: [2.65, 1.3, 1.3, 0.72, 0.72], f: [240, 34], cheek: [220, 40], s: [150, 45], rr: [100, 45], r: [60, 45], traverse: 40 },
      mantlet: { w: 0.62, h: 0.45, d: 0.18, t: 240 },
      gun: gun(G.u5ts_115),
      run: R.torsion({ wheels: 5, wheelR: 0.41, rollers: 0, trackW: 0.58, len: 6.1, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'is3', name: 'IS-3', short: 'IS-3', nation: 'SU', cls: 'HT', tier: 8, parent: 'is2',
      hp: 1750, mass: 46.5, engine: { hp: 520, fuel: 'diesel' }, vMax: 40, vRev: 13, traverse: 26, ground: [1.0, 1.2, 2.0],
      view: 370, camo: { still: 0.07, move: 0.04 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 3.15, lowerW: 1.8, sponsonY: 1.05, front: [['lfp', 110, -50, 0.45], ['ufp', 110, 62, 0.72]], roof: [25, 4.6],
         rear: [['urp', 60, 45, 0.45], ['lrp', 60, -40, null]], floorT: 20, side: { t: 90, slope: 35, tLow: 90, tSpon: 30 } },
      turret: { z: -0.2, ringR: 0.95, h: 0.68, roofT: 30, oct: [2.5, 1.2, 1.3, 0.65, 0.6], f: [220, 40], cheek: [200, 45], s: [175, 45], rr: [100, 45], r: [60, 45], traverse: 22 },
      mantlet: { w: 0.85, h: 0.45, d: 0.22, t: 220 },
      gun: gun(G.d25_122, { reload: 12 }),
      run: R.torsion({ wheels: 6, wheelR: 0.3, trackW: 0.65, len: 5.9, h: 1.05 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'is4', name: 'IS-4', short: 'IS-4', nation: 'SU', cls: 'HT', tier: 9, parent: 'is3',
      hp: 2000, mass: 60, engine: { hp: 750, fuel: 'diesel' }, vMax: 43, vRev: 13, traverse: 24, ground: [1.05, 1.25, 2.1],
      view: 380, camo: { still: 0.05, move: 0.03 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.45, w: 3.26, lowerW: 1.9, sponsonY: 1.1, front: [['lfp', 140, -50, 0.5], ['ufp', 140, 58, 0.82]], roof: [30, 5.3],
         rear: [['urp', 100, 30, 0.8], ['lrp', 60, -40, null]], floorT: 20, side: { t: 160, tLow: 160, tSpon: 40 } },
      turret: { z: -0.3, ringR: 0.98, h: 0.82, roofT: 30, oct: [2.45, 1.05, 1.45, 0.5, 0.55], f: [250, 20], cheek: [200, 30], s: [170, 20], rr: [150, 25], r: [150, 25], traverse: 20 },
      mantlet: { w: 0.9, h: 0.55, d: 0.25, t: 250 },
      gun: gun(G.m62_122),
      run: R.torsion({ wheels: 7, wheelR: 0.33, trackW: 0.7, len: 6.4, h: 1.1 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'is7', name: 'IS-7', short: 'IS-7', nation: 'SU', cls: 'HT', tier: 10, parent: 'is4',
      hp: 2200, mass: 68, engine: { hp: 1050, fuel: 'diesel' }, vMax: 55, vRev: 15, traverse: 28, ground: [1.0, 1.2, 2.0],
      view: 390, camo: { still: 0.05, move: 0.03 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.45, w: 3.4, lowerW: 2.0, sponsonY: 1.05, front: [['lfp', 150, -50, 0.5], ['ufp', 150, 62, 0.75]], roof: [30, 5.9],
         rear: [['urp', 70, 45, 0.5], ['lrp', 60, -40, null]], floorT: 25, side: { t: 150, slope: 50, tLow: 100, tSpon: 60 } },
      turret: { z: -0.1, ringR: 1.05, h: 0.72, roofT: 40, oct: [2.65, 1.6, 1.45, 0.75, 0.6], f: [240, 45], cheek: [210, 45], s: [185, 42], rr: [94, 30], r: [94, 30], traverse: 22 },
      mantlet: { w: 0.8, h: 0.45, d: 0.25, t: 240 },
      gun: gun(G.s70_130),
      run: R.torsion({ wheels: 7, wheelR: 0.37, trackW: 0.72, len: 7.0, h: 1.1 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't34_76', name: 'T-34/76 (1943)', short: 'T-34/76', nation: 'SU', cls: 'MT', tier: 5, parent: 't28',
      hp: 560, mass: 30.9, engine: { hp: 500, fuel: 'diesel' }, vMax: 54, vRev: 20, traverse: 42, ground: [0.9, 1.0, 1.4],
      view: 330, camo: { still: 0.13, move: 0.10 }, crew: ['commander+gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.4, w: 3.0, lowerW: 1.95, sponsonY: 1.1, front: [['lfp', 45, -53, 0.5], ['ufp', 45, 60, 0.9]], roof: [20, 3.72],
         rear: [['urp', 40, 47, 0.6], ['lrp', 40, -45, null]], floorT: 16, side: { t: 40, slope: 40, tLow: 45, tSpon: 16 } },
      turret: { z: -0.75, ringR: 0.71, h: 0.65, roofT: 20, oct: [1.95, 0.9, 0.9, 0.55, 0.4], f: [52, 15], cheek: [52, 20], s: [52, 20], rr: [52, 10], r: [52, 10], traverse: 42 },
      mantlet: { w: 0.55, h: 0.4, d: 0.15, t: 52 },
      gun: gun(G.f34_76),
      run: R.christie({ wheels: 5, wheelR: 0.415, trackW: 0.5, len: 5.5, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 't34_85', name: 'T-34-85', short: 'T-34-85', nation: 'SU', cls: 'MT', tier: 6, parent: 't34_76',
      hp: 860, mass: 32, engine: { hp: 500, fuel: 'diesel' }, vMax: 54, vRev: 20, traverse: 40, ground: [0.9, 1.0, 1.4],
      view: 350, camo: { still: 0.12, move: 0.09 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.4, w: 3.0, lowerW: 1.95, sponsonY: 1.1, front: [['lfp', 45, -53, 0.5], ['ufp', 45, 60, 0.9]], roof: [20, 3.72],
         rear: [['urp', 40, 47, 0.6], ['lrp', 40, -45, null]], floorT: 16, side: { t: 40, slope: 40, tLow: 45, tSpon: 16 } },
      turret: { z: -0.55, ringR: 0.8, h: 0.72, roofT: 20, oct: [2.25, 0.95, 1.4, 0.35, 0.3], f: [90, 20], cheek: [75, 25], s: [75, 20], rr: [52, 15], r: [52, 10], traverse: 38 },
      mantlet: { w: 0.75, h: 0.45, d: 0.2, t: 40 },
      gun: gun(G.zis53_85),
      run: R.christie({ wheels: 5, wheelR: 0.415, trackW: 0.5, len: 5.5, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'kv1', name: 'KV-1 (1941)', short: 'KV-1', nation: 'SU', cls: 'HT', tier: 5, parent: 't28',
      hp: 900, mass: 47, engine: { hp: 600, fuel: 'diesel' }, vMax: 35, vRev: 12, traverse: 24, ground: [1.1, 1.2, 2.0],
      view: 340, camo: { still: 0.05, move: 0.03 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.43, w: 3.32, lowerW: 1.9, sponsonY: 1.15, front: [['lfp', 75, -30, 0.4], ['glac', 75, 65, 0.25], ['ufp', 75, 25, 0.8]],
         roof: [40, 5.19], rear: [['urp', 60, 10, 0.85], ['lrp', 60, -40, null]], floorT: 30, side: { t: 75, tLow: 75, tSpon: 30 } },
      turret: { z: -0.15, ringR: 0.79, h: 0.78, roofT: 40, oct: [1.95, 1.0, 1.2, 0.3, 0.3], f: [75, 15], cheek: [75, 15], s: [75, 15], rr: [75, 15], r: [75, 15], traverse: 24 },
      mantlet: { w: 0.85, h: 0.45, d: 0.15, t: 90 },
      gun: gun(G.zis5_76),
      run: R.torsion({ wheels: 6, wheelR: 0.3, trackW: 0.7, len: 5.8, h: 1.1 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'is2', name: 'IS-2 (1944)', short: 'IS-2', nation: 'SU', cls: 'HT', tier: 7, parent: 'kv85',
      hp: 1450, mass: 46, engine: { hp: 520, fuel: 'diesel' }, vMax: 37, vRev: 12, traverse: 25, ground: [1.0, 1.2, 2.0],
      view: 330, camo: { still: 0.06, move: 0.04 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.42, w: 3.07, lowerW: 1.75, sponsonY: 1.1, front: [['lfp', 100, -30, 0.5], ['ufp', 120, 60, 0.9]], roof: [30, 4.64],
         rear: [['urp', 60, 49, 0.5], ['lrp', 60, -41, null]], floorT: 20, side: { t: 90, slope: 15, tLow: 90, tSpon: 30 } },
      turret: { z: -0.35, ringR: 0.92, h: 0.8, roofT: 30, oct: [2.3, 1.0, 1.4, 0.45, 0.55], f: [100, 25], cheek: [100, 30], s: [90, 20], rr: [90, 30], r: [90, 30], traverse: 20 },
      mantlet: { w: 0.9, h: 0.55, d: 0.25, t: 100 },
      gun: gun(G.d25_122),
      run: R.torsion({ wheels: 6, wheelR: 0.275, trackW: 0.65, len: 5.9, h: 1.05 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   {
      id: 'su100', name: 'SU-100', short: 'SU-100', nation: 'SU', cls: 'TD', tier: 6, parent: 't34_76',
      hp: 860, mass: 31.6, engine: { hp: 500, fuel: 'diesel' }, vMax: 50, vRev: 16, traverse: 36, ground: [0.9, 1.0, 1.5],
      view: 340, camo: { still: 0.15, move: 0.09 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      hull: { floorY: 0.4, w: 3.0, lowerW: 1.95, sponsonY: 1.1, front: [['lfp', 45, -53, 0.5], ['ufp', 75, 50, 1.25]], roof: [20, 2.98],
         rear: [['eng', 20, 70, 0.35], ['urp', 45, 48, 0.6], ['lrp', 40, -45, null]], floorT: 16, side: { t: 45, slope: 20, tLow: 45, tSpon: 16 } },
      turret: null,
      mantlet: { w: 0.62, h: 0.5, d: 0.3, t: 110 },
      gun: gun(G.d10_100, { mount: 'hull', pivotY: 1.62, pivotX: 0.25, traverse: 10 }),
      run: R.christie({ wheels: 5, wheelR: 0.415, trackW: 0.5, len: 5.5, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'sides' },
   },
   // ---------------------------------------------------------------- USA
   {
      id: 'm4a3e8', name: 'M4A3E8 Sherman', short: 'M4A3E8', nation: 'US', cls: 'MT', tier: 6,
      hp: 860, mass: 33.7, engine: { hp: 500, fuel: 'petrol' }, vMax: 48, vRev: 20, traverse: 40, ground: [0.9, 1.0, 1.5],
      view: 350, camo: { still: 0.10, move: 0.07 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.43, w: 2.62, lowerW: 1.8, sponsonY: 1.25, front: [['lfp', 63, -50, 0.3], ['nose', 108, 20, 0.3], ['ufp', 64, 47, 0.95]],
         roof: [19, 4.63], rear: [['urp', 38, 10, 0.8], ['lrp', 38, -30, null]], floorT: 13, side: { t: 38, tLow: 38, tSpon: 13 } },
      turret: { z: -0.25, ringR: 0.88, h: 0.75, roofT: 25, oct: [2.0, 0.9, 1.3, 0.4, 0.35], f: [76, 30], cheek: [64, 25], s: [64, 5], rr: [64, 5], r: [64, 0], traverse: 38 },
      mantlet: { w: 0.85, h: 0.5, d: 0.2, t: 89 },
      gun: gun(G.m1_76),
      run: R.leaf({ wheels: 12, bogies: 6, wheelR: 0.265, trackW: 0.584, rollers: 3, len: 5.6, h: 1.0 }),
      layout: { ammo: 'floor', fuel: 'rear' },
   },
   {
      id: 'm26', name: 'M26 Pershing', short: 'Pershing', nation: 'US', cls: 'MT', tier: 7,
      hp: 1350, mass: 41.9, engine: { hp: 500, fuel: 'petrol' }, vMax: 40, vRev: 15, traverse: 32, ground: [1.0, 1.1, 1.7],
      view: 370, camo: { still: 0.09, move: 0.06 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.43, w: 3.0, lowerW: 2.05, sponsonY: 1.1, front: [['lfp', 76, -53, 0.55], ['ufp', 102, 46, 0.95]], roof: [22, 5.2],
         rear: [['urp', 51, 10, 0.8], ['lrp', 25, -35, null]], floorT: 25, side: { t: 63, tLow: 51, tSpon: 19 } },
      turret: { z: -0.35, ringR: 0.88, h: 0.8, roofT: 25, oct: [2.3, 1.0, 1.5, 0.4, 0.35], f: [102, 5], cheek: [76, 15], s: [76, 0], rr: [76, 0], r: [76, 0], traverse: 30 },
      mantlet: { w: 1.0, h: 0.55, d: 0.2, t: 114 },
      gun: gun(G.m3_90),
      run: R.torsion({ wheels: 6, wheelR: 0.33, trackW: 0.61, rollers: 5, len: 5.9, h: 1.05 }),
      layout: { ammo: 'floor', fuel: 'rear' },
   },
   {
      id: 'm18', name: 'M18 Hellcat', short: 'Hellcat', nation: 'US', cls: 'TD', tier: 6,
      hp: 700, mass: 17.7, engine: { hp: 400, fuel: 'petrol' }, vMax: 72, vRev: 20, traverse: 40, ground: [0.9, 1.0, 1.4],
      view: 360, camo: { still: 0.15, move: 0.12 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.36, w: 2.87, lowerW: 2.0, sponsonY: 0.95, front: [['lfp', 13, -55, 0.4], ['ufp', 13, 64, 0.79]], roof: [7, 3.6],
         rear: [['urp', 13, 5, 0.6], ['lrp', 13, -35, null]], floorT: 7, side: { t: 13, slope: 20, tLow: 13, tSpon: 7 } },
      turret: { z: 0.0, ringR: 0.86, h: 0.7, roofT: 0, openTop: true, oct: [2.15, 0.95, 1.2, 0.45, 0.25], f: [25, 23], cheek: [19, 23], s: [13, 20], rr: [13, 10], r: [13, 10], traverse: 24 },
      mantlet: { w: 0.6, h: 0.4, d: 0.15, t: 19 },
      gun: gun(G.m1_76, { name: '76 mm Gun M1A1', reload: 4.0, disp: 0.35, aim: 1.9, elev: 19.5, cap: 45, load: { AP: 28, APCR: 7, HE: 10 } }),
      run: R.torsion({ wheels: 5, wheelR: 0.32, trackW: 0.366, rollers: 4, sprocket: 'front', len: 4.9, h: 0.95 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   // ---------------------------------------------------------------- Großbritannien
   {
      id: 'cromwell', name: 'Cromwell', short: 'Cromwell', nation: 'UK', cls: 'MT', tier: 6,
      hp: 820, mass: 27.9, engine: { hp: 600, fuel: 'petrol' }, vMax: 64, vRev: 22, traverse: 48, ground: [0.85, 0.95, 1.5],
      view: 350, camo: { still: 0.14, move: 0.12 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.4, w: 2.15, front: [['belly', 25, -60, 0.15], ['lfp', 57, 20, 0.3], ['glac', 30, 72, 0.15], ['ufp', 64, 0, 0.7]],
         roof: [20, 5.67], rear: [['urp', 32, 10, 0.6], ['lrp', 32, -30, null]], floorT: 8, side: { t: 32 } },
      turret: { z: -0.5, ringR: 0.76, h: 0.72, roofT: 20, oct: [1.85, 0.85, 1.1, 0.15, 0.15], f: [76, 0], cheek: [64, 0], s: [64, 0], rr: [57, 0], r: [57, 0], traverse: 42 },
      mantlet: { w: 0.6, h: 0.4, d: 0.12, t: 64 },
      gun: gun(G.pdr6),
      run: R.christie({ wheels: 5, wheelR: 0.41, trackW: 0.36, len: 5.8, h: 1.0 }),
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'churchill7', name: 'Churchill VII', short: 'Churchill', nation: 'UK', cls: 'HT', tier: 6,
      hp: 1150, mass: 40.6, engine: { hp: 350, fuel: 'petrol' }, vMax: 24, vRev: 12, traverse: 22, ground: [1.0, 1.1, 1.6],
      view: 340, camo: { still: 0.05, move: 0.03 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.45, w: 2.1, front: [['lfp', 140, -30, 0.3], ['ufp', 152, 0, 0.95]], roof: [20, 6.3],
         rear: [['urp', 50, 0, 0.9], ['lrp', 50, -30, null]], floorT: 20, side: { t: 95 } },
      turret: { z: -0.6, ringR: 0.74, h: 0.78, roofT: 20, oct: [1.95, 0.85, 1.1, 0.35, 0.35], f: [152, 0], cheek: [152, 10], s: [95, 5], rr: [95, 5], r: [95, 0], traverse: 22 },
      mantlet: { w: 0.5, h: 0.35, d: 0.1, t: 50 },
      gun: gun(G.qf75c),
      run: { wheels: 11, wheelR: 0.18, interleave: 0, rollers: 0, sprocket: 'rear', sprocketR: 0.4, idlerR: 0.4, trackW: 0.56, len: 7.4, h: 1.6, t: 20, style: 'allround' },
      layout: { ammo: 'sponson', fuel: 'rear' },
   },
   {
      id: 'comet', name: 'Comet I', short: 'Comet', nation: 'UK', cls: 'MT', tier: 7,
      hp: 1250, mass: 33.5, engine: { hp: 600, fuel: 'petrol' }, vMax: 51, vRev: 20, traverse: 44, ground: [0.9, 1.0, 1.5],
      view: 360, camo: { still: 0.12, move: 0.10 }, crew: ['commander', 'gunner', 'loader', 'driver', 'radio'],
      hull: { floorY: 0.42, w: 2.2, front: [['belly', 32, -60, 0.15], ['lfp', 63, 20, 0.3], ['glac', 32, 72, 0.15], ['ufp', 76, 0, 0.7]],
         roof: [25, 5.87], rear: [['urp', 32, 10, 0.6], ['lrp', 32, -30, null]], floorT: 14, side: { t: 43 } },
      turret: { z: -0.35, ringR: 0.8, h: 0.78, roofT: 25, oct: [2.05, 0.9, 1.4, 0.3, 0.2], f: [102, 0], cheek: [76, 10], s: [64, 0], rr: [57, 0], r: [57, 0], traverse: 38 },
      mantlet: { w: 0.8, h: 0.45, d: 0.15, t: 102 },
      gun: gun(G.hv77),
      run: R.christie({ wheels: 5, wheelR: 0.41, trackW: 0.46, rollers: 4, len: 6.1, h: 1.05 }),
      layout: { ammo: 'bustle', fuel: 'rear' },
   },
];

// ================================ FINALISE ================================
const D2R = Math.PI / 180;
const tierScale = (tier) => 0.6 + 0.08 * tier;

function buildHull(spec) {
   const pts = [];
   let z = 0, y = spec.floorY;
   pts.push({ z, y, plate: null });
   const plates = {};
   const addPlate = (id, t) => { plates[id] = { name: PLATE_NAMES[id] || id, t }; };
   for (const [id, t, deg, dy] of spec.front) {
      pts[pts.length - 1].plate = id; addPlate(id, t);
      z += dy * Math.tan(deg * D2R); y += dy;
      pts.push({ z, y, plate: null });
   }
   const roofY = y;
   pts[pts.length - 1].plate = 'roof'; addPlate('roof', spec.roof[0]);
   z += spec.roof[1];
   pts.push({ z, y, plate: null });
   for (let i = 0; i < spec.rear.length; i++) {
      let [id, t, deg, dy] = spec.rear[i];
      if (dy == null || i === spec.rear.length - 1) dy = y - spec.floorY;
      pts[pts.length - 1].plate = id; addPlate(id, t);
      z += dy * Math.tan(deg * D2R); y -= dy;
      pts.push({ z, y, plate: null });
   }
   // last point is on the floor; the floor edge closes back to pts[0]
   pts[pts.length - 1].plate = 'floor'; addPlate('floor', spec.floorT);
   let zMin = Infinity, zMax = -Infinity;
   for (const p of pts) { zMin = Math.min(zMin, p.z); zMax = Math.max(zMax, p.z); }
   const zc = (zMin + zMax) / 2;
   for (const p of pts) { p.z = +(p.z - zc).toFixed(4); p.y = +p.y.toFixed(4); }
   const side = spec.side || {};
   addPlate('side', side.t ?? 20);
   if (spec.sponsonY != null) { addPlate('sideLow', side.tLow ?? side.t ?? 20); addPlate('spon', side.tSpon ?? spec.floorT); }
   return {
      profile: pts, plates, floorY: spec.floorY, roofY, len: zMax - zMin, zMin: zMin - zc, zMax: zMax - zc,
      w: spec.w, lowerW: spec.lowerW ?? null, sponsonY: spec.sponsonY ?? null, sideSlope: side.slope ?? 0,
   };
}

/** Profile front z at height y (min z over the profile polygon slice). */
function profileFrontZ(profile, y) {
   let best = Infinity;
   for (let i = 0; i < profile.length; i++) {
      const a = profile[i], b = profile[(i + 1) % profile.length];
      if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue;
      const t = (y - a.y) / (b.y - a.y);
      best = Math.min(best, a.z + (b.z - a.z) * t);
   }
   return best;
}

function buildTurret(spec, hull) {
   const [w, lenF, lenR, cF, cR] = spec.oct;
   const { base, faces } = octTurret(w, lenF, lenR, cF, cR, spec.f, spec.cheek, spec.s, spec.rr, spec.r);
   const n = base.length;
   // Offset each edge inwards by h*tan(slope) and intersect neighbours -> top polygon.
   // Base is CCW in (x, z) seen from above with z pointing "down" on screen, i.e. CW in a
   // right-handed (x, -z) sense; compute the inward normal from the signed area.
   const area = (() => { let a = 0; for (let i = 0; i < n; i++) { const p = base[i], q = base[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a; })();
   const sgn = area > 0 ? 1 : -1;
   const lines = [];
   for (let i = 0; i < n; i++) {
      const p = base[i], q = base[(i + 1) % n];
      const dx = q[0] - p[0], dz = q[1] - p[1], l = Math.hypot(dx, dz);
      // inward normal: rotate edge direction by +90° for positive area (x,z), -90° otherwise
      const nx = -dz / l * sgn, nz = dx / l * sgn;
      const off = spec.h * Math.tan(faces[i].slope * D2R);
      lines.push({ px: p[0] + nx * off, pz: p[1] + nz * off, dx, dz });
   }
   const top = [];
   for (let i = 0; i < n; i++) {
      const L0 = lines[(i + n - 1) % n], L1 = lines[i];
      const den = L0.dx * L1.dz - L0.dz * L1.dx;
      const t = ((L1.px - L0.px) * L1.dz - (L1.pz - L0.pz) * L1.dx) / den;
      top.push([+(L0.px + L0.dx * t).toFixed(4), +(L0.pz + L0.dz * t).toFixed(4)]);
   }
   const plates = {};
   for (const f of faces) plates[f.id] = { name: PLATE_NAMES[f.id], t: f.t };
   plates.troof = { name: PLATE_NAMES.troof, t: spec.roofT };
   plates.tbase = { name: PLATE_NAMES.tbase, t: Math.max(10, Math.round(spec.roofT)) };
   // commander's cupola (same spot tanks3d draws it): a thin-walled ring of vision blocks on the roof,
   // the classic weak spot that almost any gun gets through (WoT style). spec.cupT overrides.
   let cupola = null;
   if (!spec.openTop) {
      const zs = top.map((p) => p[1]), zB = Math.max(...zs), zF = Math.min(...zs), xMax = Math.max(...top.map((p) => p[0]));
      const t = spec.cupT ?? Math.round(Math.min(50, Math.max(25, spec.roofT * 1.5 + 10)));
      cupola = { x: -Math.min(0.42, xMax * 0.55), y: spec.h + 0.16, z: zF + (zB - zF) * 0.68, s: 0.6, h: 0.32, t };
      plates.cup = { name: PLATE_NAMES.cup, t };
   }
   return {
      cupola,
      x: 0, z: spec.z, y: hull.roofY, ringR: spec.ringR, h: spec.h, base, top, faces, roofT: spec.roofT, plates,
      openTop: !!spec.openTop, traverse: spec.traverse, lenF, lenR, w,
   };
}

function finalize(raw) {
   const cfg = { ...raw };
   const cd = CLASS_DEFAULTS[raw.cls];
   cfg.hull = buildHull(raw.hull);
   const hull = cfg.hull;
   cfg.turret = raw.turret ? buildTurret(raw.turret, hull) : null;
   cfg.turretTraverse = raw.turret ? raw.turret.traverse : (raw.gun.traverse ?? 10);
   cfg.camo = { ...raw.camo, fire: cd.fireCamo };
   const g = cfg.gun = { dispMove: cd.dispMove, dispHull: cd.dispHull, dispTurret: cd.dispTurret, dispShot: cd.dispShot, ...raw.gun };
   g.mount = cfg.turret ? 'turret' : 'hull';
   g.disp = +(g.disp * (BALLISTICS.DISP_MUL ?? 1)).toFixed(3); g.aim = +(g.aim * (BALLISTICS.AIM_MUL ?? 1)).toFixed(2);   // global accuracy knobs
   g.arc = g.arc || null;
   g.ammoByType = {};
   for (const a of g.ammo) {
      a.cal = g.cal;
      if (a.pen500 == null) a.pen500 = Math.round(a.pen * (1 - AMMO[a.type].falloff));
      g.ammoByType[a.type] = a;
   }
   // Gun pivot + mantlet placement.
   const m = { ...raw.mantlet };
   if (cfg.turret) {
      const T = cfg.turret, f = T.faces[0];
      const py = T.h * 0.5;
      const zFront = -T.lenF + py * Math.tan(f.slope * D2R);   // front face z at pivot height
      m.mount = 'turret'; m.x = 0; m.y = py; m.z = zFront - m.d / 2 + 0.03;
      g.pivot = { x: 0, y: py, z: zFront + 0.15 };
   } else {
      const py = raw.gun.pivotY;
      const zFront = profileFrontZ(hull.profile, py);
      m.mount = 'hull'; m.x = raw.gun.pivotX || 0; m.y = py; m.z = zFront - m.d / 2 + 0.03;
      g.pivot = { x: m.x, y: py, z: zFront + 0.2 };
   }
   cfg.mantlet = m;
   // Running gear placement.
   const run = cfg.run = { ...raw.run };
   const innerW = hull.lowerW ?? hull.w;
   run.x = run.x ?? +(innerW / 2 + run.trackW / 2 + 0.02).toFixed(3);
   run.z = run.z ?? 0;
   if (raw.skirts) cfg.skirts = { ...raw.skirts, x: run.x + run.trackW / 2 + 0.06, len: run.len * 0.92 };
   // Overall dims.
   const width = Math.max(hull.w, 2 * (run.x + run.trackW / 2)) + (cfg.skirts ? 0.14 : 0);
   const height = cfg.turret ? hull.roofY + cfg.turret.h + 0.2 : hull.roofY + 0.15;
   cfg.dims = { len: Math.max(hull.len, run.len), width: +width.toFixed(2), height: +height.toFixed(2) };
   buildInternals(cfg, raw.layout || {});
   return cfg;
}

// Module and crew boxes from the hull/turret dimensions and a coarse layout description.
function buildInternals(cfg, layout) {
   const H = cfg.hull, T = cfg.turret, ts = tierScale(cfg.tier);
   const fy = H.floorY, ry = H.roofY, hh = ry - fy;
   const iw = (H.lowerW ?? H.w) / 2 - 0.12;         // inner half width
   const zF = H.zMin, zR = H.zMax;
   const L = H.len;
   const mods = {};
   const box = (part, c, s, id) => ({ part, c: c.map((v) => +v.toFixed(3)), s: s.map((v) => +v.toFixed(3)), hp: Math.round(MODULES[id].hp * ts) });
   // engine compartment: rear ~22 % of the hull
   mods.engine = box('hull', [0, fy + hh * 0.45, zR - L * 0.13], [iw * 0.6, hh * 0.3, L * 0.09], 'engine');
   if (layout.fuel === 'sides') mods.fuel = box('hull', [iw * 0.75, fy + hh * 0.55, zR - L * 0.32], [iw * 0.2, hh * 0.25, L * 0.08], 'fuel');
   else if (layout.fuel === 'floor') mods.fuel = box('hull', [0, fy + hh * 0.15, zR - L * 0.3], [iw * 0.5, hh * 0.1, L * 0.06], 'fuel');
   else mods.fuel = box('hull', [-iw * 0.7, fy + hh * 0.5, zR - L * 0.12], [iw * 0.22, hh * 0.25, L * 0.08], 'fuel');
   const tz = T ? T.z : zF + L * 0.35;
   if (layout.ammo === 'bustle' && T) mods.ammo = box('turret', [0, T.h * 0.45, T.lenR - 0.35], [T.w * 0.3, T.h * 0.2, 0.2], 'ammo');
   else if (layout.ammo === 'floor') mods.ammo = box('hull', [0, fy + hh * 0.12, tz + 0.1], [iw * 0.6, hh * 0.09, 0.45], 'ammo');
   else {
      // sponsons / hull sides beside the fighting compartment
      const sx = H.sponsonY != null ? H.lowerW / 2 + 0.25 : iw * 0.75;
      const sy = H.sponsonY != null ? (H.sponsonY + ry) / 2 : fy + hh * 0.5;
      mods.ammo = box('hull', [0, sy, tz + 0.1], [sx + 0.12, Math.min(0.22, hh * 0.2), 0.5], 'ammo');
   }
   if (T) {
      mods.gun = box('turret', [0, T.h * 0.5, -T.lenF + 0.55], [0.18, 0.15, 0.4], 'gun');
      mods.turretRing = box('turret', [0, 0.06, 0], [T.ringR, 0.07, T.ringR], 'turretRing');
      mods.optics = box('turret', [-0.3, T.h * 0.62, -T.lenF + 0.25], [0.12, 0.1, 0.12], 'optics');
      mods.radio = cfg.crew.some((c) => c.includes('radio'))
         ? box('hull', [iw * 0.55, ry - 0.25, zF + L * 0.2], [0.2, 0.15, 0.2], 'radio')
         : box('turret', [0.3, T.h * 0.55, T.lenR - 0.2], [0.18, 0.15, 0.15], 'radio');
   } else {
      const p = cfg.gun.pivot;
      mods.gun = box('hull', [p.x, p.y, p.z + 0.45], [0.18, 0.15, 0.45], 'gun');
      mods.optics = box('hull', [p.x - 0.45, p.y + 0.2, p.z + 0.35], [0.12, 0.1, 0.12], 'optics');
      mods.radio = box('hull', [-iw * 0.55, ry - 0.3, p.z + 1.0], [0.2, 0.15, 0.2], 'radio');
   }
   cfg.modules = mods;
   // Crew: driver front-left, radio front-right, turret crew in the turret (casemate: hull).
   const crew = [];
   const cs = [0.24, 0.38, 0.24];
   // every gun needs a loader: without one listed, the commander loads (else the tank would
   // reload at the 'loader dead' penalty from the start, e.g. the 4-man Luchs)
   const noLoader = !cfg.crew.some((e) => e.split('+').includes('loader'));
   for (const entry of cfg.crew) {
      const roles = entry.split('+');
      if (noLoader && roles[0] === 'commander') roles.push('loader');
      const id = roles[0];
      let part = 'hull', c;
      const main = roles[0];
      if (main === 'driver') c = [-iw * 0.5, fy + hh * 0.5, zF + L * 0.2];
      else if (main === 'radio') c = [iw * 0.5, fy + hh * 0.5, zF + L * 0.2];
      else if (T) {
         part = 'turret';
         const k = { commander: [-0.35, T.lenR * 0.45], gunner: [-0.4, -T.lenF * 0.25], loader: [0.42, 0.05] }[main] || [0, 0];
         c = [k[0], T.h * 0.4, k[1]];
      } else {
         const p = cfg.gun.pivot;
         const k = { commander: [-0.5, 1.4], gunner: [-0.45, 0.6], loader: [0.5, 1.1] }[main] || [0, 1];
         c = [p.x + k[0], fy + hh * 0.55, p.z + k[1]];
         if (main === 'driver') c = [-iw * 0.5, fy + hh * 0.4, zF + L * 0.22];
      }
      crew.push({ id, roles, name: CREW_NAMES[id], part, c: c.map((v) => +v.toFixed(3)), s: cs, hp: 100 });
   }
   cfg.crew = crew;
}

export const TANKS = {};
export const TANK_LIST = [];
for (const raw of RAW) {
   const cfg = finalize(raw);
   TANKS[cfg.id] = cfg;
   TANK_LIST.push(cfg.id);
}
// ---- campaign emplacements ("sites"): Tank-shaped static targets, finalised like tanks so armour,
// ballistics, spotting, bot gunnery and rendering all work unchanged. Not in TANK_LIST (no garage).
// cfg.site = 'bunker'|'pak'|'ship'; they never drive (vMax 0); ships float at terrain.water - draft.
const SITE_RAW = [
   {  // Westwall pillbox (Regelbau style): ~1.5-2 m concrete is beyond any tank gun; the steel
      // embrasure band and the rear door are the weak spots, HE through the slit kills the crew
      id: 'bunker', site: 'bunker', name: 'Bunker (Regelbau)', short: 'Bunker', nation: 'DE', cls: 'TD', tier: 6,
      hp: 1600, mass: 400, engine: { hp: 1, fuel: 'diesel' }, vMax: 0, vRev: 0, traverse: 0, ground: [1, 1, 1],
      view: 330, camo: { still: 0.3, move: 0.3 }, crew: ['commander', 'gunner', 'loader'],
      hull: { floorY: 0.0, w: 5.4, front: [['lfp', 300, 0, 0.9], ['emb', 60, 0, 0.55], ['ufp', 300, 25, 0.75]], roof: [250, 4.2],
         rear: [['urp', 70, 0, null]], floorT: 300, side: { t: 300 } },   // rear: steel door
      turret: null,
      mantlet: { w: 0.7, h: 0.45, d: 0.25, t: 80 },
      gun: gun(G.kwk40_75, { name: '7,5 cm PaK 40 (Kasematte)', pivotY: 1.17, arc: [-32, 32], traverse: 18, reload: 6.5, elev: 12, depr: -6, load: { AP: 60, HE: 40 } }),
      run: { wheels: 2, wheelR: 0.05, interleave: 0, rollers: 0, sprocket: 'rear', sprocketR: 0.05, idlerR: 0.05, trackW: 0.1, len: 1, h: 0.1, t: 300 },
      layout: { ammo: 'floor', fuel: 'floor' },
   },
   {  // 7,5 cm PaK 40 with its crew behind a thin shield: an AP hit rarely stops it, HE does
      id: 'pak40', site: 'pak', name: '7,5 cm PaK 40', short: 'PaK 40', nation: 'DE', cls: 'TD', tier: 5,
      hp: 260, mass: 1.5, engine: { hp: 1, fuel: 'diesel' }, vMax: 0, vRev: 0, traverse: 0, ground: [1, 1, 1],
      view: 320, camo: { still: 0.45, move: 0.3 }, eye: 2.1, aiErr: 1.7, crew: ['commander', 'gunner', 'loader'],   // eye: crew leader standing behind the shield
      hull: { floorY: 0.3, w: 1.9, front: [['shield', 5, 20, 0.9]], roof: [5, 2.6], rear: [['urp', 5, 0, null]], floorT: 5, side: { t: 5 } },
      turret: null,
      mantlet: { w: 1.9, h: 0.9, d: 0.05, t: 5 },
      gun: gun(G.kwk40_75, { name: '7,5 cm PaK 40 L/46', pivotY: 0.75, arc: [-30, 30], traverse: 14, reload: 5.5, elev: 22, depr: -5, load: { AP: 40, HE: 20 } }),
      run: { wheels: 1, wheelR: 0.4, interleave: 0, rollers: 0, sprocket: 'rear', sprocketR: 0.05, idlerR: 0.05, trackW: 0.15, len: 0.9, h: 0.8, t: 5 },
      layout: { ammo: 'floor', fuel: 'floor' },
   },
   {  // Torpedoboot (Flottentorpedoboot 1939 class, 10,5 cm guns): thin plating, big hull
      id: 'tboat', site: 'ship', name: 'Torpedoboot', short: 'T-Boot', nation: 'DE', cls: 'TD', tier: 7, draft: 3.2,
      hp: 3200, mass: 1700, engine: { hp: 1, fuel: 'diesel' }, vMax: 0, vRev: 0, traverse: 0, ground: [1, 1, 1],
      view: 520, camo: { still: 0, move: 0 }, eye: 14, aiErr: 2.2, crew: ['commander', 'gunner', 'loader', 'radio'],
      hull: { floorY: 0.0, w: 10, front: [['nose', 15, 40, 7.0]], roof: [12, 82], rear: [['urp', 12, 20, null]], floorT: 12, side: { t: 15, slope: 4 } },
      turret: { z: -26, ringR: 1.5, h: 2.2, roofT: 8, oct: [3.6, 1.6, 2.6, 0.5, 0.5], f: [12, 20], cheek: [12, 30], s: [10, 10], rr: [8, 10], r: [8, 0], traverse: 10 },
      mantlet: { w: 0.8, h: 0.6, d: 0.3, t: 12 },
      gun: { name: '10,5 cm SK C/32', cal: 105, len: 4.8, reload: 7.5, disp: 0.42, aim: 2.5, elev: 30, depr: -10, cap: 200,
         load: { AP: 100, HE: 100 },
         ammo: [{ type: 'AP', name: 'Pzsprgr', pen: 120, dmg: 260, vel: 785 }, { type: 'HE', name: 'Sprgr L/4,4', pen: 45, dmg: 300, vel: 785 }] },
      run: { wheels: 2, wheelR: 0.05, interleave: 0, rollers: 0, sprocket: 'rear', sprocketR: 0.05, idlerR: 0.05, trackW: 0.1, len: 1, h: 0.1, t: 15 },
      layout: { ammo: 'floor', fuel: 'floor' },
   },
];
export const SITE_LIST = [];
for (const raw of SITE_RAW) { const cfg = finalize(raw); TANKS[cfg.id] = cfg; SITE_LIST.push(cfg.id); }

// ---- cheat-only tanks (the logo cheat, profile.cheat): in TANKS but not in TANK_LIST, so they never
// appear in the tech tree, the shop, matchmaking, training targets or bot rosters. The garage, the
// campaign briefing and the MP lobby offer them once the profile has the cheat.
// Cheat-only vehicles (logo cheat, see progress.maxOutProfile): in TANKS but never in TANK_LIST, so no tech
// tree, shop, matchmaking pool, training target or bot. `look` / `paint` pick their own tanks3d details.
const CHEAT_RAW = [
   {
      id: 'leo2a6', name: 'Leopard 2A6', short: 'Leopard 2', nation: 'DE', cls: 'MT', tier: 10, look: 'leo2', paint: 'nato',
      hp: 2400, mass: 62.3, engine: { hp: 1500, fuel: 'diesel' }, vMax: 72, vRev: 31, traverse: 52, ground: [0.85, 0.95, 1.4],
      view: 440, camo: { still: 0.12, move: 0.08 }, crew: ['commander', 'gunner', 'loader', 'driver'],
      // composite armour as equivalent steel: nose ~700 mm effective, wedge cheeks ~800, glacis bounces almost anything
      hull: { floorY: 0.52, w: 3.56, lowerW: 2.3, sponsonY: 1.12, front: [['lfp', 250, 52, 0.35], ['nose', 600, 30, 0.45], ['ufp', 60, 82, 0.22]], roof: [40, 5.15],
         rear: [['urp', 40, 8, 0.6], ['lrp', 30, -20, null]], floorT: 30, side: { t: 70, tLow: 40, tSpon: 30 } },
      // arrowhead turret: the big front chamfer makes the 2A6's add-on wedges the cheeks, the narrow front is the mantlet
      turret: { z: 0.45, ringR: 1.1, h: 0.8, roofT: 60, oct: [3.3, 2.25, 1.95, 1.2, 0.3], f: [650, 4], cheek: [560, 22], s: [200, 3], rr: [80, 3], r: [60, 3], traverse: 48, cupT: 60 },
      mantlet: { w: 0.72, h: 0.62, d: 0.3, t: 450 },
      skirts: { t: 40, h: 0.62, y0: 0.5 },
      gun: { name: '120 mm Rh L/55', cal: 120, len: 6.2, reload: 6.0, disp: 0.22, aim: 1.5, elev: 20, depr: -9, cap: 42,
         load: { APCR: 24, HEAT: 13, HE: 5 },
         ammo: [{ type: 'APCR', name: 'DM53 APFSDS', pen: 650, pen500: 630, dmg: 540, vel: 1670 },
            { type: 'HEAT', name: 'DM12 HEAT-MP', pen: 480, dmg: 540, vel: 1140 },
            { type: 'HE', name: 'DM11 HE', pen: 70, dmg: 720, vel: 1000 }] },
      run: R.torsion({ wheels: 7, wheelR: 0.35, rollers: 4, trackW: 0.635, sprocketR: 0.34, idlerR: 0.33, len: 6.95, h: 1.06 }),
      layout: { ammo: 'bustle', fuel: 'sides' },
   },
];
export const CHEAT_TANKS = [];
for (const raw of CHEAT_RAW) { const cfg = finalize(raw); cfg.cheat = true; TANKS[cfg.id] = cfg; CHEAT_TANKS.push(cfg.id); }
/** Tanks a player may drive (garage / net games): the tech tree plus the cheat-only ones; never sites. */
export const isDrivable = (id) => typeof id === 'string' && (TANK_LIST.includes(id) || CHEAT_TANKS.includes(id));

export const tanksByNation = (nation) => TANK_LIST.filter((id) => TANKS[id].nation === nation);
export const tanksInTier = (lo, hi) => TANK_LIST.filter((id) => TANKS[id].tier >= lo && TANKS[id].tier <= hi);

export const DIFFICULTY = {
   leicht: { name: 'Leicht', aimErr: 1.8, react: 1.2, botDmg: 0.85 },
   normal: { name: 'Normal', aimErr: 1.0, react: 0.7, botDmg: 1.0 },
   schwer: { name: 'Schwer', aimErr: 0.6, react: 0.4, botDmg: 1.0 },
};
