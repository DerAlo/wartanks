// game/maps.js — map themes: German names, terrain generation recipe (height features, ground,
// objects) and the look (palette + lighting/sky read by render.js / sky.js / terrain3d.js).
//
// Layout coordinates are metres on the 1000 × 1000 m map (x east, z south). Team 1 spawns in the
// south (z > 0), team 2 in the north. Features marked `sym` are mirrored through the map centre
// ((x, z) -> (-x, -z)) so both sides get the same tactical options.
//
// Feature kinds (terrain.js):
//   hill   { x, z, r, h }                  smooth bump (h < 0 = hollow)
//   ridge  { x0, z0, x1, z1, w, h, gaps? } elongated crest, hull-down line; gaps = [t, width] cuts
//   plateau{ x, z, r, h }                  flat-topped rise (r = top radius, soft edge 40 m)
//   flat   { x, z, r, y? }                 flatten to the local mean (village ground)
//   river  { pts:[[x,z]...], w, depth, fords:[t...], bridge:[t...] }  water channel
//   lake   { x, z, r, depth, frozen? }
//   road   { pts:[[x,z]...], w }           ground 'road', gently smoothed
//   forest { x, z, r, density, bushes }    trees (+ bushes) in a circle
//   village{ x, z, r, houses, walls, church? }
//   rocks  { x, z, r, n }
//   bushes { x, z, r, n }
//   farm   { x, z, yaw }                   2–3 houses + fences
//   field  { x, z, r }                     soft ground (ploughed field)
//   valley { k, max }                      terrain rises with distance from the river (k m per m)
//   coast  { z, wig, beach, shelf:[[s,depth]...] }  sea north of the wiggly shore line z (+ fbm·wig):
//                                          beach blends to water+0.5 over `beach` m, seabed follows
//                                          the shelf profile (s = m seaward of the shore line)
//   mole   { pts:[[x,z]...], w, h }        harbour mole / quay: road surface h m above the water
//   house  { x, z, yaw, w, d, h }          one explicitly placed building (warehouse, ...)
//
// Theme extras: water (sea / river level), bases { team1, team2, neutral } and spawnZ { team1, team2 }
// override the default base / spawn positions (used by coast maps whose north is sea).

const SUMMER = {
   fog: 0xbccbd8, fogNear: 280, fogFar: 1250, sunDir: [0.55, 0.62, 0.35], sunColor: 0xffecd2, sunIntensity: 3.0,
   skyLight: 0xc4daf2, groundLight: 0x6a6a52, hemiIntensity: 1.05, exposure: 1.32,
   // richer, crisper than the post default (1.06 / 1.02), which read muddy next to the warships look
   grade: { saturation: 1.14, contrast: 1.07 },
   skyTop: 0x3f7ccc, skyHor: 0xbfd5e6, skyLow: 0x8a9488, cloud: 0.45,
};

export const MAPS = {
   steppe: {
      id: 'steppe', name: 'Steppe', desc: 'Offenes, welliges Grasland mit langen Hügelkämmen – Hull-Down-Stellungen und weite Schussbahnen.',
      palette: 'steppe', seed: 11,
      render: { ...SUMMER, fog: 0xc6cfd2, skyHor: 0xd0dbe2, sunColor: 0xfff0d0, cloud: 0.35, fogFar: 1350 },
      noise: { amp: 5, scale: 260, detail: 0.6, ridgedAmp: 4 },
      ground: { soft: 0.18, hard: 0.1 },
      features: [
         { kind: 'ridge', sym: true, x0: -380, z0: 150, x1: 60, z1: 120, w: 70, h: 9, gaps: [[0.45, 40]] },
         { kind: 'ridge', sym: true, x0: 140, z0: 40, x1: 420, z1: 70, w: 60, h: 11 },
         { kind: 'hill', x: 0, z: 0, r: 90, h: 8 },
         { kind: 'hill', sym: true, x: -300, z: -40, r: 110, h: 14 },
         { kind: 'hill', sym: true, x: 330, z: 300, r: 80, h: -4 },
         { kind: 'road', pts: [[-500, 260], [-200, 180], [0, 30], [200, -170], [500, -260]], w: 7 },
         { kind: 'farm', sym: true, x: 230, z: 220, yaw: 0.3 },
         { kind: 'forest', sym: true, x: -150, z: 330, r: 55, density: 0.35, bushes: 0.6 },
         { kind: 'forest', sym: true, x: 420, z: -120, r: 50, density: 0.3, bushes: 0.5 },
         { kind: 'rocks', sym: true, x: -60, z: 70, r: 35, n: 7 },
         { kind: 'rocks', sym: true, x: 300, z: 90, r: 30, n: 5 },
         { kind: 'bushes', sym: true, x: 80, z: 140, r: 60, n: 18 },
         { kind: 'bushes', sym: true, x: -280, z: 120, r: 70, n: 20 },
         { kind: 'field', sym: true, x: 120, z: 330, r: 90 },
      ],
      scatter: { trees: 40, bushes: 140, rocks: 20 },
   },
   dorf: {
      id: 'dorf', name: 'Dorf', desc: 'Ein Dorf mit Kirche, engen Gassen und Steinmauern im Zentrum, Hügel an der Ostflanke.',
      palette: 'summer', seed: 23,
      render: { ...SUMMER },
      noise: { amp: 4, scale: 220, detail: 0.5, ridgedAmp: 2 },
      ground: { soft: 0.12, hard: 0.08 },
      features: [
         { kind: 'flat', x: 0, z: 0, r: 170 },
         { kind: 'village', x: 0, z: 0, r: 150, houses: 34, walls: 14, church: true },
         { kind: 'hill', x: 360, z: 0, r: 150, h: 22 },
         { kind: 'ridge', x0: 300, z0: -260, x1: 300, z1: 260, w: 60, h: 6 },
         { kind: 'hill', x: -380, z: 0, r: 130, h: -5 },
         { kind: 'ridge', sym: true, x0: -420, z0: 200, x1: -150, z1: 230, w: 60, h: 7 },
         { kind: 'road', pts: [[0, 500], [0, -500]], w: 8 },
         { kind: 'road', pts: [[-500, 40], [-150, 20], [150, -20], [500, -40]], w: 7 },
         { kind: 'farm', sym: true, x: -260, z: 330, yaw: -0.2 },
         { kind: 'forest', sym: true, x: 250, z: 380, r: 70, density: 0.45, bushes: 0.5 },
         { kind: 'forest', x: 420, z: 0, r: 70, density: 0.3, bushes: 0.7 },
         { kind: 'field', sym: true, x: -250, z: 150, r: 100 },
         { kind: 'bushes', sym: true, x: -150, z: 260, r: 60, n: 16 },
         { kind: 'rocks', x: 380, z: 60, r: 40, n: 6 },
      ],
      scatter: { trees: 70, bushes: 110, rocks: 10 },
   },
   waldhuegel: {
      id: 'waldhuegel', name: 'Waldhügel', desc: 'Bewaldete Hügel, Lichtungen und Hohlwege – Tarnung, Buschwerk und kurze Gefechte.',
      palette: 'summer', seed: 37,
      render: { ...SUMMER, fog: 0xb2c2c8, fogNear: 220, fogFar: 1050, sunIntensity: 2.6, skyHor: 0xc0d0d8, cloud: 0.7 },
      noise: { amp: 12, scale: 200, detail: 0.7, ridgedAmp: 9 },
      ground: { soft: 0.2, hard: 0.08 },
      features: [
         { kind: 'hill', sym: true, x: -220, z: 60, r: 140, h: 24 },
         { kind: 'hill', sym: true, x: 260, z: 200, r: 120, h: 16 },
         { kind: 'ridge', sym: true, x0: -60, z0: 230, x1: 220, z1: 100, w: 55, h: 10 },
         { kind: 'hill', x: 0, z: 0, r: 80, h: -6 },
         { kind: 'road', pts: [[-500, -100], [-200, -40], [0, 0], [200, 40], [500, 100]], w: 6 },
         { kind: 'forest', sym: true, x: -220, z: 60, r: 120, density: 0.75, bushes: 0.8 },
         { kind: 'forest', sym: true, x: 260, z: 220, r: 90, density: 0.6, bushes: 0.8 },
         { kind: 'forest', sym: true, x: 380, z: -300, r: 90, density: 0.55, bushes: 0.6 },
         { kind: 'forest', sym: true, x: 40, z: 300, r: 60, density: 0.5, bushes: 0.6 },
         { kind: 'farm', sym: true, x: -60, z: 120, yaw: 0.8 },
         { kind: 'bushes', sym: true, x: 100, z: 60, r: 70, n: 25 },
         { kind: 'rocks', sym: true, x: -140, z: -20, r: 40, n: 8 },
      ],
      scatter: { trees: 260, bushes: 220, rocks: 30 },
   },
   flusstal: {
      id: 'flusstal', name: 'Flusstal', desc: 'Ein Fluss teilt das Tal: Furten, eine Brücke und Kämme an beiden Ufern.',
      palette: 'summer', seed: 41,
      render: { ...SUMMER, fog: 0xb8c8d4, skyHor: 0xc4d6e4, cloud: 0.6 },
      noise: { amp: 6, scale: 240, detail: 0.6, ridgedAmp: 4 },
      ground: { soft: 0.15, hard: 0.1 },
      water: 0,
      features: [
         { kind: 'valley', k: 0.045, max: 280 },
         { kind: 'river', pts: [[-520, -40], [-250, 20], [-60, -15], [120, 20], [300, -20], [520, 30]], w: 34, depth: 4.5,
            fords: [0.22, 0.78], bridge: [0.5] },
         { kind: 'ridge', sym: true, x0: -450, z0: 170, x1: -60, z1: 200, w: 70, h: 12 },
         { kind: 'ridge', sym: true, x0: 120, z0: 140, x1: 450, z1: 170, w: 60, h: 9 },
         { kind: 'road', pts: [[-40, 500], [-10, 150], [0, 0], [10, -150], [40, -500]], w: 7 },
         { kind: 'village', sym: true, x: 260, z: 300, r: 70, houses: 9, walls: 5 },
         { kind: 'forest', sym: true, x: -330, z: 330, r: 80, density: 0.5, bushes: 0.6 },
         { kind: 'bushes', sym: true, x: -180, z: 70, r: 80, n: 30 },
         { kind: 'bushes', sym: true, x: 230, z: 60, r: 60, n: 20 },
         { kind: 'rocks', sym: true, x: 420, z: 80, r: 40, n: 7 },
      ],
      scatter: { trees: 80, bushes: 120, rocks: 15 },
   },
   winter: {
      id: 'winter', name: 'Winterwald', desc: 'Verschneite Kiefernwälder um einen zugefrorenen See – das Eis trägt, bietet aber keine Deckung.',
      palette: 'winter', seed: 53,
      render: { ...SUMMER, fog: 0xd6dde3, fogNear: 200, fogFar: 1000, sunDir: [0.4, 0.45, 0.6], sunColor: 0xfff6ea, sunIntensity: 2.2,
         skyLight: 0xdbe6f2, groundLight: 0x8a8f96, skyTop: 0x7e9cc0, skyHor: 0xdfe5ea, skyLow: 0xb8bec4, cloud: 0.8, exposure: 1.2,
         grade: { saturation: 1.05, contrast: 1.06 } },
      noise: { amp: 9, scale: 230, detail: 0.6, ridgedAmp: 6 },
      ground: { soft: 0.25, hard: 0.05 },
      features: [
         { kind: 'lake', x: 0, z: 0, r: 130, depth: 3, frozen: true },
         { kind: 'hill', sym: true, x: -300, z: 120, r: 130, h: 20 },
         { kind: 'ridge', sym: true, x0: 120, z0: 160, x1: 430, z1: 90, w: 60, h: 11 },
         { kind: 'hill', sym: true, x: 260, z: 340, r: 90, h: 10 },
         { kind: 'road', pts: [[-500, 300], [-250, 250], [-180, 120], [-200, -100], [-80, -300], [0, -500]], w: 6 },
         { kind: 'forest', sym: true, x: -300, z: 120, r: 120, density: 0.65, bushes: 0.4 },
         { kind: 'forest', sym: true, x: 330, z: -150, r: 100, density: 0.6, bushes: 0.4 },
         { kind: 'forest', sym: true, x: 100, z: 330, r: 70, density: 0.5, bushes: 0.4 },
         { kind: 'farm', sym: true, x: -120, z: 240, yaw: 1.2 },
         { kind: 'rocks', sym: true, x: 200, z: 40, r: 50, n: 9 },
         { kind: 'bushes', sym: true, x: -100, z: 140, r: 60, n: 14 },
      ],
      scatter: { trees: 200, bushes: 90, rocks: 25 },
   },
   kueste: {
      id: 'kueste', name: 'Küste', desc: 'Ostseeküste an der Danziger Bucht: Strand, Dünen und Kiefern, ein Backsteinhafen mit Mole – im Norden nur offene See.',
      palette: 'coast', seed: 67, noRandom: true,      // half the map is sea: campaign / chosen only, not in the random rotation
      render: { ...SUMMER, fog: 0xb3c0c8, skyHor: 0xc8d4dc, skyTop: 0x5b86b4, skyLow: 0x6f7a78, sunColor: 0xfff4e2,
         sunIntensity: 2.4, groundLight: 0x5e5a48, cloud: 0.65, fogNear: 320, fogFar: 1500 },
      noise: { amp: 2.5, scale: 260, detail: 0.4, ridgedAmp: 1.5 },
      ground: { soft: 0.2, hard: 0.08 },
      water: 0,
      bases: { team1: { x: -170, z: 385 }, team2: { x: 0, z: -45 }, neutral: { x: 0, z: 170 } },
      spawnZ: { team1: 395, team2: -30 },
      features: [
         { kind: 'coast', z: -165, wig: 18, beach: 45, shelf: [[0, 0], [15, 1.5], [35, 4], [60, 7.5], [100, 10], [180, 13], [300, 14]] },
         // dune belt behind the beach, gaps for the beach exits
         { kind: 'ridge', x0: -480, z0: -108, x1: -120, z1: -100, w: 34, h: 4.5, gaps: [[0.3, 26], [0.75, 30]] },
         { kind: 'ridge', x0: -60, z0: -98, x1: 200, z1: -106, w: 30, h: 4, gaps: [[0.45, 34]] },
         // harbour: long mole out into the bay + quay along the shore
         { kind: 'mole', pts: [[300, -150], [300, -345], [335, -372]], w: 14, h: 1.8 },
         { kind: 'mole', pts: [[225, -146], [385, -146]], w: 22, h: 1.6 },
         { kind: 'road', pts: [[300, 500], [320, 260], [345, 60], [320, -60], [300, -130]], w: 7 },
         { kind: 'road', pts: [[-500, 120], [-250, 70], [0, 40], [200, 20], [345, 60]], w: 6 },
         { kind: 'road', pts: [[0, 40], [-10, -60]], w: 5 },
         // brick town and harbour warehouses
         { kind: 'village', x: 380, z: -20, r: 70, houses: 14, walls: 4, church: true },
         { kind: 'house', x: 245, z: -112, yaw: 0, w: 14, d: 24, h: 9 },
         { kind: 'house', x: 270, z: -108, yaw: 0, w: 12, d: 20, h: 8 },
         { kind: 'house', x: 340, z: -112, yaw: 0, w: 14, d: 26, h: 10 },
         { kind: 'house', x: 368, z: -110, yaw: 0, w: 12, d: 22, h: 8 },
         { kind: 'house', x: 395, z: -114, yaw: 0.05, w: 10, d: 18, h: 7 },
         // pines on the dunes and inland, farmland in the south
         { kind: 'forest', x: -330, z: -70, r: 80, density: 0.55, bushes: 0.5 },
         { kind: 'forest', x: 80, z: -60, r: 60, density: 0.5, bushes: 0.5 },
         { kind: 'forest', x: -120, z: 200, r: 90, density: 0.45, bushes: 0.6 },
         { kind: 'forest', x: 230, z: 250, r: 70, density: 0.4, bushes: 0.5 },
         { kind: 'farm', x: -300, z: 290, yaw: 0.2 },
         { kind: 'farm', x: 120, z: 120, yaw: -0.4 },
         { kind: 'field', x: -330, z: 220, r: 90 },
         { kind: 'field', x: 60, z: 330, r: 80 },
         { kind: 'hill', x: -180, z: 60, r: 90, h: 7 },
         { kind: 'hill', x: 180, z: 330, r: 70, h: 5 },
         { kind: 'bushes', x: -60, z: -40, r: 80, n: 26 },
         { kind: 'bushes', x: 150, z: 60, r: 70, n: 18 },
         { kind: 'rocks', x: -250, z: -130, r: 60, n: 5 },
      ],
      scatter: { trees: 90, bushes: 120, rocks: 8 },
   },
   wueste: {
      id: 'wueste', name: 'Wüste', desc: 'Libysch-ägyptische Grenze: Sand und Geröll, flache Wadis und ein Steilhang mit zwei Pässen – Deckung gibt nur das Gelände.',
      palette: 'steppe', seed: 79, noRandom: true,     // North Africa ops (campaign) / chosen only
      colors: { grass: 0xc9ad78, grass2: 0xd8c08c, dirt: 0xa98a5e, rock: 0x9a8268, road: 0xb89e74, sand: 0xdcc898, soft: 0xbfa070, tree: 0x6f6a3c, tree2: 0x7d7646, pine: 0x5a5a34, bush: 0x8a7e4c },
      render: { ...SUMMER, fog: 0xdccdb0, skyHor: 0xe4d8c0, skyTop: 0x5e8cc4, skyLow: 0xb8a68a, sunColor: 0xfff0d6, sunIntensity: 3.2,
         skyLight: 0xd8dce4, groundLight: 0x9a845e, cloud: 0.08, fogNear: 300, fogFar: 1400, grade: { saturation: 1.04, contrast: 1.06 } },
      noise: { amp: 3.5, scale: 300, detail: 0.5, ridgedAmp: 2.5 },
      ground: { soft: 0.22, hard: 0.3 },
      features: [
         // the escarpment (Halfaya): a long steep step across the north, the pass in the middle, a goat track in the east
         { kind: 'ridge', x0: -540, z0: -175, x1: 540, z1: -165, w: 110, h: 24, gaps: [[0.5, 46], [0.86, 40]] },
         { kind: 'road', pts: [[10, 500], [0, 250], [0, 0], [0, -170], [20, -500]], w: 7 },
         { kind: 'road', pts: [[-500, 230], [-200, 160], [0, 140]], w: 5 },
         // wadis: shallow dry valleys, the only cover on the plain
         { kind: 'hill', x: 300, z: -20, r: 95, h: -6 },
         { kind: 'hill', x: -260, z: 110, r: 110, h: -5 },
         { kind: 'hill', x: 150, z: 260, r: 70, h: -3 },
         { kind: 'hill', x: -150, z: -40, r: 70, h: 5 },
         { kind: 'hill', x: 120, z: 60, r: 60, h: 4 },
         { kind: 'house', x: -205, z: 215, yaw: 0.1, w: 9, d: 7, h: 3.5 },
         { kind: 'house', x: -190, z: 228, yaw: 0.1, w: 6, d: 6, h: 3 },
         { kind: 'rocks', sym: true, x: 230, z: 120, r: 70, n: 12 },
         { kind: 'rocks', x: -100, z: -120, r: 90, n: 14 },
         { kind: 'rocks', x: 200, z: -120, r: 90, n: 14 },
         { kind: 'rocks', x: 380, z: -150, r: 60, n: 10 },
         { kind: 'bushes', sym: true, x: -280, z: 100, r: 90, n: 16 },
         { kind: 'bushes', x: 300, z: -20, r: 80, n: 14 },
      ],
      scatter: { trees: 0, bushes: 70, rocks: 70 },
   },
};
export const MAP_LIST = Object.keys(MAPS);
/** Maps the random pick (menu, lobby host) rolls from: no coast map with open sea for 7v7. */
export const RANDOM_MAPS = MAP_LIST.filter((id) => !MAPS[id].noRandom);
export default MAPS;
