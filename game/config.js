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
   FALL_START: 100, FALL_END: 500,
   OVERMATCH: 3,            // caliber > 3 × t: no ricochet
   OVERMATCH_NORM: 2,       // caliber > 2 × t: normalisation scaled by 1.4 × cal/t (WoT style)
   RIC_PEN_LOSS: 0.25,      // pen lost on a ricochet
   HEAT_AIR_LOSS: 0.5,      // HEAT pen fraction lost per metre of air after the first plate
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

export const PLATE_NAMES = {
   belly: 'Bugunterseite', lfp: 'Untere Bugplatte', nose: 'Bugnase', glac: 'Glacis', ufp: 'Obere Bugplatte',
   roof: 'Wannendach', eng: 'Motordeck', urp: 'Obere Heckplatte', lrp: 'Untere Heckplatte', floor: 'Wannenboden',
   side: 'Seite', sideLow: 'Untere Seite', spon: 'Kettenabdeckung',
   tf: 'Turmfront', tcl: 'Turmwange links', tcr: 'Turmwange rechts', tsl: 'Turmseite links', tsr: 'Turmseite rechts',
   trl: 'Turmheck links', trr: 'Turmheck rechts', tr: 'Turmheck', troof: 'Turmdach', tbase: 'Turmboden',
   mantlet: 'Blende', track: 'Kette', skirt: 'Schürze', gun: 'Kanone',
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
   trackL: { name: 'Kette links', hp: 160 },
   trackR: { name: 'Kette rechts', hp: 160 },
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
   {
      id: 'luchs', name: 'Pz.Kpfw. II Luchs', short: 'Luchs', nation: 'DE', cls: 'LT', tier: 4,
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
      id: 'pz4h', name: 'Pz.Kpfw. IV Ausf. H', short: 'Pz IV H', nation: 'DE', cls: 'MT', tier: 5,
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
      id: 'panther', name: 'Panther Ausf. A', short: 'Panther', nation: 'DE', cls: 'MT', tier: 7,
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
      id: 'tiger1', name: 'Tiger I', short: 'Tiger', nation: 'DE', cls: 'HT', tier: 7,
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
      id: 'tiger2', name: 'Tiger II', short: 'Tiger II', nation: 'DE', cls: 'HT', tier: 8,
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
      id: 'jagdpanther', name: 'Jagdpanther', short: 'Jagdpanther', nation: 'DE', cls: 'TD', tier: 7,
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
   {
      id: 't34_76', name: 'T-34/76 (1943)', short: 'T-34/76', nation: 'SU', cls: 'MT', tier: 5,
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
      id: 't34_85', name: 'T-34-85', short: 'T-34-85', nation: 'SU', cls: 'MT', tier: 6,
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
      id: 'kv1', name: 'KV-1 (1941)', short: 'KV-1', nation: 'SU', cls: 'HT', tier: 5,
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
      id: 'is2', name: 'IS-2 (1944)', short: 'IS-2', nation: 'SU', cls: 'HT', tier: 7,
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
      id: 'su100', name: 'SU-100', short: 'SU-100', nation: 'SU', cls: 'TD', tier: 6,
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
   return {
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
export const tanksByNation = (nation) => TANK_LIST.filter((id) => TANKS[id].nation === nation);
export const tanksInTier = (lo, hi) => TANK_LIST.filter((id) => TANKS[id].tier >= lo && TANKS[id].tier <= hi);

export const DIFFICULTY = {
   leicht: { name: 'Leicht', aimErr: 1.8, react: 1.2, botDmg: 0.85 },
   normal: { name: 'Normal', aimErr: 1.0, react: 0.7, botDmg: 1.0 },
   schwer: { name: 'Schwer', aimErr: 0.6, react: 0.4, botDmg: 1.0 },
};
