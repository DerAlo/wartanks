# PANZER (wartanks) — architecture & module contract

Browser tank battle game, WW2-era armour (Tier I–VIII style), loosely modelled on World of Tanks
(gameplay reference only; all vehicles, models, maps, sounds and UI are our own). Focus:
**armour thickness and angle, ammunition and gun, ballistics, driving skill** (hull-down, angling,
side-scraping, terrain use).

Same engine family as `D:/warships` (3D mode, `game3d/`): plain ES modules, no build step,
`vendor/three/three.module.min.js`, Canvas/DOM HUD, WebAudio-synthesised sound (no audio files),
procedural models (no model files), host-authoritative serverless multiplayer (`game/net/`,
transport layer copied from warships). UI language **German**. `node server.js` serves on :5173.

## Module ownership

| Area | Files (all in `game/`) | Owner |
|---|---|---|
| Data | `config.js` (tanks, guns, ammo, armour geometry, tiers), `maps.js` (map themes) | sim |
| Simulation | `utils.js` (seeded RNG, math), `terrain.js` (heightfield + objects, pure sim), `armor.js` (hull/turret polyhedra, ray tests, effective thickness), `ballistics.js` (shell flight, penetration, damage, modules, crew), `tank.js` (Tank class: drivetrain, physics, turret/gun, aim, reload, modules), `spotting.js`, `ai.js` (bots), `state.js` (World), `missions.js` (modes), `progress.js` (garage, XP, credits, unlocks) | sim |
| Graphics | `render.js` (scene, renderer, lights, shadows, post), `terrain3d.js` (ground mesh from `terrain.js`, splat shading, grass, trees, houses, rocks), `tanks3d.js` (procedural tank models built from the SAME armour geometry in `config.js` + details), `fx.js` (muzzle flash, dust, tracers, impacts, ricochet sparks, explosions, fire, smoke, track marks, wrecks), `sky.js`, `gfxquality.js` | client |
| Controls / UI / audio | `main.js` (boot, loop), `input.js`, `camera.js` (third-person orbit + sniper zoom ladder), `hud.js` (reticle, pen indicator, damage panel, minimap, kill feed, damage log), `menu.js` (main menu, garage, armour viewer, tech tree, results), `audio.js` (+ `audiosynth.js`), `index.html` (page, design tokens) | client |
| Multiplayer | `net/*` | net |

Graphics/controls only **read** sim state and call the documented methods below. Consumers
degrade gracefully (optional chaining) when a field is missing. Changing an interface means
updating this file in the same commit.

## Coordinates & scale

* **1 unit = 1 metre, 1 s = 1 s** (no time compression). Sim runs at fixed `SIM_DT = 1/60`.
* Sim works in **3D**: `x` east, `z` south, `y` up — identical to three.js world space, so
  `THREE.Vector3(x, y, z)` needs no conversion. Heading `yaw` in radians,
  **0 = facing −z (north)**, positive = turning left (counter-clockwise seen from above), i.e.
  the three.js `rotation.y` convention. Forward vector = `(-sin yaw, 0, -cos yaw)`.
* Tank-local frame (hull): `+x` right, `+y` up, `−z` forward (three.js object convention).
  Turret yaw relative to hull, gun pitch positive = up.
* Maps are 1000 × 1000 m (`world.half = 500`), playable square with soft boundary (red line,
  tanks cannot leave). Heightfield resolution 2 m (501² samples... sim may choose; expose API).

## Terrain (`terrain.js`, pure sim, deterministic from `seed` + map theme)

```
makeTerrain(seed, themeId) -> terrain
terrain.half                          // 500
terrain.heightAt(x, z)                // m, bilinear
terrain.normalAt(x, z)                // {x,y,z} unit
terrain.groundAt(x, z)                // 'hard'|'medium'|'soft'|'water'|'road' (resistance class)
terrain.raycast(ox,oy,oz, dx,dy,dz, maxDist) -> dist|null   // heightfield + solid objects (LOS, shells)
terrain.objects   // [{ id, kind:'house'|'rock'|'tree'|'bush'|'wall'|'fence'|'wreck', x, z, yaw, w, d, h, solid:bool, destructible:bool, alive:bool, hp, seed }]
terrain.bushes    // subset/fast lookup for camouflage (vision blocking foliage, not solid)
terrain.water     // level or null (shallow fords; deep water kills by drowning after 10 s)
terrain.caps      // base circles per mode, chosen by missions.js
terrain.spawns    // { team1:[{x,z,yaw}], team2:[...] }
terrain.version   // bump when destructible state changes (renderer rebuilds instances)
```

Implemented extras: `terrain.groundIdxAt(x,z)` (0 road,1 hard,2 medium,3 soft,4 water),
`terrain.waterDepth(x,z)`, `terrain.objectsNear(x,z,r)` (reused array, alive solid objects),
`terrain.raycastGround/raycastObjects(...)`, `terrain.lastHit` `{type:'ground'|'object', obj}`
after `raycast`, `terrain.destroyObject(o, dirX, dirZ)` (sets `alive=false`, `fallYaw`, bumps
`version`), `terrain.bases` `{team1, team2, neutral}`, `terrain.inBush(x,z)`,
`terrain.bushesOnLine(ax,az,bx,bz)`. Objects carry `y` (ground height at their centre), `r`
(collision radius; trees: trunk), `shots` (blocks shells/LOS: house, church, rock, wall, wreck),
and houses `roof`/`style`. Extra kind `church`. Trees and bushes do not stop shells. Frozen lakes
(Winterwald) are hard ground at level 0 with `terrain.water = null`.
`maps.js` exports `MAPS` (id → theme: `name`, `desc`, `palette`, `render` {fog, sun, sky...},
generation recipe) and `MAP_LIST`.

Themes in `maps.js` (at least 5): e.g. *Steppe* (open rolling, ridges for hull-down),
*Dorf* (village, stone houses, walls, church, narrow streets), *Waldhügel* (forest, hills,
bushes), *Flusstal* (river with fords and a bridge, valley), *Winter* (snowy, frozen lake,
pine forest). Each gives height-noise params, object densities, ground palette, sky/lighting.
Map layout should create real tactical choices: ridgelines, cover, flanking corridors.
*Küste* (`kueste`, palette `coast`): Baltic coast. North of the shore line (z ≈ -165 ± 18) is
open sea (`water = 0`, seabed 8–14 m below at z < -240), beach, dune belt, pines, a red-brick town
with church (380, -20), warehouses on a quay (z ≈ -110) and a harbour mole (x = 300 from the quay to
z = -345, then a short arm to the NE). Team 1 spawns south (z 395), team 2 north on the shore (z -30).
Suggested 90 m ship berth (3.2 m draft): (275, -290), lying along z beside the mole's west side
(water ≥ 8 m there). Theme extras: feature kinds `coast`, `mole`, `house`; `bases` and `spawnZ`
override the default base/spawn positions. Existing maps generate unchanged.

### Mission features (added after generation, deterministic, no rng)
```
terrain.addObject({kind, x, z, yaw?, w?, d?, h?, hp?}) -> obj   // also bridges ({x0,z0,x1,z1} or x,z,yaw,d)
terrain.addTeethLine(x0,z0,x1,z1, {rows:3|4, spacing:1.6}) -> [obj]   // Höcker, rows offset to the left
terrain.addWireLine(x0,z0,x1,z1, {seg:6}) -> [obj]
terrain.carveTrench([[x,z],...], {w:2.5, d:1.8, enemy?:[x,z], parapet:0.6}) -> trench
terrain.addBridge(x0,z0,x1,z1, {w:7}) -> obj;  terrain.blowBridge(obj, {gap?:[0.35,0.65]})
terrain.blast(x,y,z, cal, dmg, hitObj?) -> destroyed   // HE vs teeth / hedgehog / wire
terrain.driveOver(x,z,r) -> flattened wire count
terrain.hullHeightAt(x,z,hullLen)   // height a hull of that length feels (trench bridging)
terrain.groundHeightAt(x,z)         // ground incl. trenches, without bridge decks (renderer)
terrain.trenchDist(x,z)             // to the nearest trench wall (< 0 inside), Infinity if none
terrain.trenches, terrain.bridges, terrain.wires, terrain.bridgeSites (river causeways)
terrain.heightVersion, terrain.heightEdits [{v,x0,z0,x1,z1}]   // height changes -> renderer rebuild
```
Kinds: `teeth` (1.2 × 1.2 × ~1.1 m concrete, solid, stops shells, never rammed, hp 400, HE only),
`hedgehog` (solid, shells pass, `breakMomentum` 150 t·m/s, HE), `wire` (not solid, kept out of
`objectsNear`, flattened by `driveOver`, HE), `bridge` (deck height via the overlay; not in the
collision grid, shells fly through; blown gap = water below). Trenches and decks are an analytic
height overlay on top of the 2 m heightfield (steep walls; zero cost on maps without features).
A trench is bridged (only 0.5 m deep for the hull) when `hullLen ≥ 2.2 × w`: with w = 2.5 m the
Luchs / M18 nose-dive and stick, Pz IV and longer cross. `heightAt` is the deepest (short-hull)
view; tank.js should query `hullHeightAt(x, z, cfg.dims.len)`. Blown bridges replicate via
`alive=false` (terrain3d finishes the blow on clients). Dev flag: `?demofeatures` (or
`?demofeatures=blown`) adds one of each feature in front of team 1's spawn.

## Armour geometry (`config.js` + `armor.js`) — the core of the game

Hull and turret are **convex polyhedra** built from the tank's data; ray tests and the visual
model use the same geometry, so what the player sees is what the shell hits.

* **Hull**: a side-profile polygon (in local y/z, points from front-bottom around) extruded
  across the hull width; each profile edge is a plate: `{ id, name, t: mm }`
  (e.g. `lfp` lower front plate, `ufp` upper glacis, `roof`, `urp`, `lrp`, `floor`). Sides
  are `side` (upper/lower split by height `sideSplitY` optional) with thickness, optional
  inward slope. Fenders/sponsons may be extra boxes.
* **Turret**: a top-view polygon (local x/z around the turret ring) extruded up with a per-face
  inward slope (deg) and thickness per face, + `roof` thickness; plus a **mantlet** box (extra
  thickness over the front face, spaced/additive) and the gun barrel (not armour, but a hit on
  the gun damages the gun module).
* **Tracks / road wheels**: spaced armour boxes each side (`track: { t: 20 }`), absorb HE and
  HEAT, take track damage (immobilised until repaired).
* **Spaced armour / skirts** (Schürzen) optional boxes with thickness.
* **Modules** (internal boxes, hull or turret local): `engine`, `fuel`, `ammo` (ammo rack),
  `gun` (breech), `turretRing`, `radio`, `optics`, tracks left/right; **crew** boxes: commander,
  gunner, driver, radio operator, loader(s). Module HP; damaged = penalty, destroyed = effect
  (ammo rack destroyed → detonation chance → tank destroyed; engine → immobile + fire chance;
  fuel → fire; gun → no fire/aim; tracks → immobile; crew: commander → view range, gunner →
  aim/dispersion, driver → mobility, loader → reload, radio → minimap range).

**Vehicle data format** — documented in the header of `game/config.js`. Consumers read the
finalised `TANKS[id]` (built at module load): `hull.profile` (side polygon, z/y, plate per edge,
recentred so the hull's z-extent is centred on 0), `hull.w/lowerW/sponsonY/sideSlope`,
`turret.base/top` (top-view polygons at base and roof height, CCW from above), `turret.faces`
(plate + slope per base edge), `mantlet` box, `gun.pivot/len/cal/brake`, `run` (wheels, radius,
interleave, sprocket, track width/length/height, `x` = track centre offset), `skirts`,
`modules` / `crew` boxes, `dims`. **Hull-local origin = ground point under the hull centre**;
`tank.pos` is that point (so `pos.y` ≈ terrain height). For exact plate geometry the renderer
may also call `buildArmor(cfg)` and use its face loops.

`armor.js` API:
```
buildArmor(tankCfg) -> armorModel   // polyhedra (faces: plane normal, offset, plate id, t, vertex loops for rendering)
rayArmor(armorModel, pose, origin, dir) -> [{ dist, part:'hull'|'turret'|'mantlet'|'track'|'skirt'|'gun', plateId, t, normal(world), angleDeg, effT }] sorted by dist
effective(t, angleDeg) = t / cos(angle)
pose = { pos, yaw, pitch, roll, turretYaw, gunPitch }   // from tank.pose()
```

Implementation notes (`armor.js`): `rayArmor(model, pose, origin, dir, maxDist?)` returns a
**reused** array (copy what you keep); each hit also has `side` ('L'|'R' for tracks/skirts),
`plateName` (German) and `point` (world). Non-convex hull profiles (stepped fronts) are split
horizontally at concave vertices into convex slabs; cut faces are internal. Extra exports:
`armorFor(cfg)` (cached per type), `rayModules`, `modulesNear`, `gunWorld(cfg, pose, outPos,
outDir)` (muzzle + barrel direction), `hullToWorld`. `model.parts[i].faces[j].loop` are the
vertex loops (part frame: hull, turret = around the ring at hull roof, gun = trunnion).

## Ballistics (`ballistics.js`)

* Shells are 3D projectiles with gravity `g = 9.81`, velocities from the ammo (AP ~600–1000
  m/s, APCR higher, HEAT/HE lower), optional drag-free. Sub-stepped ray-march per sim step
  against terrain (`terrain.raycast`), objects, and every tank's bounding sphere then
  `rayArmor`. Max range ~ 700 m (shell self-destructs).
* **Penetration** `pen(distance)`: linear falloff between 100 m and 500 m (AP small falloff,
  APCR large, HEAT/HE none). Random ±25 % (uniform, or triangular).
* **Angle**: impact angle against the plate normal. **Normalisation** reduces the angle before
  `effT` (AP 5°, APCR 2°, HEAT/HE 0°). **Ricochet** if angle > 70° (HEAT 85°, HE never) —
  **unless overmatch**: caliber > 3 × plate thickness (no ricochet, ×2 caliber > 2×t: normalisation
  increased like WoT). After a ricochet the shell continues with reduced pen (−25 %) on the
  reflected direction (can hit something else).
* **Penetration** if `pen > effT`. Then the shell continues inside (post-pen path ~ caliber-
  dependent, AP up to 3 m, HEAT 1 m) hitting module/crew boxes; damage to HP = `alpha` ±25 %.
* **Spaced armour / tracks**: HEAT loses `t * 1` pen per mm... rule: HEAT loses 5 % pen per 10 cm
  of air travelled after the first plate it hits; HE explodes on spaced armour.
* **HE**: explodes on impact. Pen check against the struck plate (no normalisation); if
  penetrates → full damage + module damage; else splash damage = `alpha/2 − effT*k` (≥0),
  module/crew damage in radius. Splash radius per caliber.
* **Overpen / miss**: no damage. **Non-pen** (bounce or absorbed): 0 damage, "Kein Durchschlag".
* API: `penAt(round, dist)`, `rollPen`, `ricochets(type, cal, t, angle)`, `normalisation`,
  `resolveImpact(target{armor,pose}, origin, dir, shell{type,cal,dmg,pen}, rng)` →
  `{ kind:'pen'|'ricochet'|'noPen'|'he'|'miss', dmg, plateId, part, side, t, effT, angleDeg, pen,
  point, normal, crits:[{kind:'module'|'crew', id, dmg}], ricDir, overmatch }`, `heSplash(target,
  point, shell, rng)`, `solveElevation(v, dx, dy)`, `fireShell(world, tank, round, pos, dir)`,
  `updateShells(world, dt)` → calls `world.onShellHit(shell, tank|null, result|null, point,
  what:'tank'|'splash'|'ground'|'object'|'water'|'expire')`; the World applies damage + events.
* Results become events: `pen`, `ricochet`, `noPen`, `he`, `crit`, `ammoRack`, `fire`, `kill`,
  `track`, `crew` with `{ srcId, dstId, dmg, pos, plateId, effT, pen, angleDeg, ammo }`.
* **Dispersion** (WoT-like): `gun.disp` (m at 100 m), multiplied by bloom from moving
  (`dispMove` per m/s), hull rotation, turret rotation, after firing (`dispShot`); converges
  back with `aimTime` (time to reduce bloom by e^-1... define ~2.3 s to ~10 %). Shot direction
  = gaussian-ish within the current circle (bounded at 1 sigma radius like WoT's 2σ-truncation).
* Shell drop: aim point is a 3D point; the gun solves the elevation needed for that point
  (low angle solution), clamped to gun `elev/depr` limits **relative to the hull** (so hull
  pitch matters, hull-down positions matter).

## Tank (`tank.js`)

```
tank.id, tank.cls (key in TANKS), tank.cfg, tank.name, tank.team (1|2), tank.side ('player'|'enemy' relative to local player), tank.isPlayer
tank.pos {x,y,z}, tank.yaw, tank.pitch, tank.roll, tank.vel {x,y,z}, tank.speed (m/s signed, forward +), tank.speedKmh
tank.turretYaw (rad, relative to hull), tank.gunPitch (rad)
tank.hp, tank.maxHP, tank.alive, tank.burning, tank.wreckT
tank.modules  // { engine:{hp,max,state:'ok'|'damaged'|'destroyed'}, ammo, fuel, gun, turretRing, radio, optics, trackL, trackR }
tank.crew     // { commander:{alive}, gunner, driver, radio, loader }
tank.reload, tank.reloadMax, tank.ammoSel ('AP'|'APCR'|'HEAT'|'HE'), tank.ammoCount { AP:n, ... }
tank.aimPoint {x,y,z}        // player: set by controls each frame (ray from camera)
tank.aimDisp                 // current dispersion radius (m at 100 m) — HUD draws the circle at aimPoint distance
tank.gunDir {x,y,z}          // current actual gun direction (lags behind aimPoint)
tank.spotted, tank.detected, tank.viewRange, tank.lastFire
tank.consumables             // repair kit, first aid, extinguisher: { id:{ count, cd } }
tank.input = { throttle:-1..1, steer:-1..1, brake:bool, cruise:0..3?, fire:bool, lockId }
tank.pose()                  // for armor + render
tank.fire(world), tank.setAmmo(type), tank.useConsumable(id)
```

**Drivetrain**: engine `hp`, mass `t`, `vMax`/`vRev` km/h, `traverse` deg/s (hull), terrain
resistance per ground class (hard/medium/soft multipliers per tank), specific power →
acceleration; speed loss on slopes and in turns; neutral steering. Hull pose from 4+ contact
samples of the heightfield under the tracks (smoothed pitch/roll, suspension), can tip over
on very steep slopes (> 45°) → stuck... optional. Collision: tank vs tank (OBB / circles,
mass-based push, ram damage by relative speed and mass), tank vs objects (solid houses
block; trees/fences/walls destructible when mass × speed high enough, felling them).
Water: speed penalty in fords, drowning in deep water.

**Turret**: `turretTraverse` deg/s, optional limited arc (TDs: `arc: [-12, 12]`). Gun
`elev`/`depr` limits (deg), may differ to the rear. Gun lags toward the aim with traverse
speeds.

**As implemented** (`new Tank(cfg|clsId, { id, team, name, isPlayer, x, z, yaw, terrain })`, `collideTanks(tanks, world)`):

* Extra fields: `radius`, `height` (hull+turret height in m — `cfg.height` does not exist, use
  `t.height`), `halfLen`, `halfW`, `mass` (t), `muzzle {x,y,z}`, `gunBlocked` (aim outside arc /
  elevation), `turretOff` (wreck lost its turret), `visible` (within draw range of the player),
  `role` (bot role), `stats` (per tank, same shape as `world.stats`), `lastDamaged`, `lastMoved`,
  `inWater`, `drownT`, `fireSrc`, `camo {still, move, fire}`.
* `modules[k] = { hp, max, state:'ok'|'damaged'|'destroyed', repairT }` (`turretRing` only if the
  tank has a turret). `crew` is keyed by the cfg crew id: `{ alive, hp, wounded, roles:[...] }`;
  `t.roleAlive('gunner')` checks any member with that role.
* Driving: P = hp·735.5·0.95·powerK (generous, WoT-like pace); F = min(P / max(v,1.2), μ·N), μ per ground class;
  rolling resistance from `GROUND.res × cfg.ground`; a step > 1.25 m per metre ahead blocks
  (cliff). Tank-tank: inelastic impulse e = 0.15, parked/dead tanks count ×4 mass; ram damage
  above 2.5 m/s relative speed (energy/1800, split by mass), no ram damage to allies.
* Objects: houses block; trees/fences/walls break above momentum 40/8/110 t·m/s.
* Water: deep at 0.62·height, drowning after 10 s submerged.
* Fire: 2.2 % maxHP/s; bots extinguish automatically.
* Hooks the tank calls on the world (all optional): `onFire(tank, round, pos, dir, shell)`,
  `onRam(a, b, dmgA, dmgB, p)`, `onTankEffect(kind, tank, obj)`, `onBurn(tank, dmg)`,
  `onDrown(tank)`; flag `world.infiniteAmmo`. Bots fire when `input.fire` and loaded.

## Spotting (`spotting.js`)

View range (m, 250–440) vs camo (fraction; stationary / moving / firing penalty) like WoT:
`spotDist = viewRange − camoFactor × (viewRange − 50)`; bushes on the LOS add camo (+
per bush ×), firing from a bush loses its bonus. LOS is a terrain raycast from commander
height to several points on the target (turret top, hull centre). 2 s spot memory, 445 m
draw range, team-shared spotting (radio). Proximity spotting 50 m always.

As implemented: `updateSpotting(world, dt)` (world calls it every 0.25 s) and
`canSee(world, observer, target)`. Bushes add +0.25 camo each (max +0.5), bushes within 15 m
of the observer are ignored; for 3 s after a shot camo is multiplied by `camo.fire`. Sets
`t.spotted` (bool, with 2 s memory), `t.detected`, `t.spotterId`, `t.visible`; first spot calls
`world.onSpotted` and counts `stats.spotted`. tanks3d draws enemies when
`spotted !== false && visible !== false`.

## World (`state.js`)

```
new World({ mode, mapId, seed, playerCls, difficulty, roster? })
world.time, world.phase ('countdown'|'playing'|'won'|'lost'|'draw'), world.countdown, world.timeLeft
world.terrain, world.tanks (all), world.player, world.bots
world.shells   // [{ id, pos{x,y,z}, vel{x,y,z}, ammo, caliber, ownerId, team, alive, tracer:bool }]  (pool, alive flag)
world.effects  // transient visual effects [{ kind, pos, dir?, t, life, size, ... }]
world.events   // ring buffer with monotonic `seq` (consumers keep lastSeq)
world.caps     // [{ id, pos, r, team (base owner or null), progress 0..100, capper }]
world.stats    // player: { dmg, kills, shots, hits, pens, bounces, blocked, spotted, assist, crits, received }
world.result   // { outcome:'win'|'loss'|'draw', reason, xp, credits }
world.update(dt), world.enemiesOf(t), world.alliesOf(t)
```

As implemented:

* Options: `{ mode='standard', mapId, seed, playerCls, difficulty, teamSize?, roster?, countdown?, playerName? }`.
  `difficulty` may be `0|1|2` (main.js passes a number) or `'leicht'|'normal'|'schwer'`;
  `difficultyKey(d)` maps it. `playerCls: null` gives a bots-only battle (headless tests);
  then `world.player` is null.
* `world.phase`: `'countdown' | 'playing' | 'won' | 'lost' | 'draw'` (relative to the player); details in `world.result`.
  Countdown defaults to the mission's (10 s; training 0). Nothing moves in the countdown.
* `world.result = { outcome, winner (1|2|0), reason (relative to the player, e.g. 'Eigenes Team
  vernichtet', 'Basis erobert', 'Zeit abgelaufen'), time, xp, credits, freeXP, ammoCost, breakdown }`.
* `world.stats === world.player.stats`.
* `world.effects` is a list of fresh objects `{ kind, pos, dir?, t, life, size, ... }`
  (kinds: `ground`, `splash`, `explosion`, `sparks`, ...); fx marks consumed ones with `__fx`.
* `world.events` ring buffer of 256, each `{ type, seq, t, ... }`. Types: `shot`, `pen`,
  `ricochet`, `noPen`, `he` (hit events carry `srcId, dstId, dmg, pos, normal, plateId,
  plateName, part, side, t, effT, pen, angleDeg, overmatch, ammo, cal, what, from`), `crit`
  (`module` or `crew`), `track`, `fire`, `ammoRack`, `kill`, `ram`, `spotted`, `cap`,
  `treeFall`, `objectBreak`, `phase`.
* Update order: AI → (countdown freeze) → tanks → collideTanks → shells → spotting (0.25 s)
  → caps and end check → `mission.tick` → effect ageing.
* Damage: bot damage against the player's team × `diff.botDmg`; friendly fire × 0.5.
  Crits: tracks and gun can be hit by any hit, other modules only on pen or HE; a destroyed
  ammo rack detonates with 60 % chance; engine and fuel hits can start fires.
* Caps: per-tank points, rate min(1, 3/n), any damage resets the tank's cap points, neutral
  base blocked while both teams are inside. `world.tankById(id)`, `world.emit(ev)`,
  `world.effect(fx)`, `world.addTank(cls, team, opts)`, `world.end(winner, reason)`.

Bots (`ai.js`): `new BotAI(world, tank)` with `update(dt)`; `findPath(T, a, b)` is A* on a 16 m
grid cached in `T._nav`. Difficulty table `DIFF[key] = { err, react, aimWait, convK, smart, angle }`.
Roles `flank | push | ridge | snipe | defend | target | targetMoving`. Bots aim at the weakest
plate (rayArmor from the muzzle), pick ammo, lead moving targets, angle the hull ~0.6 rad,
retreat below 30 % HP, return to a base being capped, and push the objective when
timeLeft < 200 s or ≤ 2 tanks of their team remain.

## Modes (`missions.js`)

* `standard` — Standardgefecht: 2 bases, 7v7 (configurable up to 10v10), win by destroying all
  enemies or capturing the enemy base (100 points), 10-min timer (draw; was 7 min, too short for heavy mirrors).
* `encounter` — Begegnungsgefecht: one neutral base.
* `assault`? optional later.
* `training` — Übungsplatz: drive any tank, static/moving target tanks of each type, armour
  inspection (shows effective thickness of plate under reticle).
Matchmaking for bots: tier ±1 of the player's tank, balanced classes per team.

As implemented: `MISSIONS[id] = { id, name, desc, hint?, teamSize, timeLimit, countdown, noEnd?,
setup(world, opts), tick?(world, dt) }`, `MISSION_LIST`, `matchmake(playerCls, teamSize, rng)
-> { team1, team2 }` (classes mirrored slot by slot, tier ±1), `botName(rng, used)`.
Training: infinite ammo, no end, one target of every tank type at 100–400 m with varied
yaw, every third one drives (`role 'targetMoving'`), destroyed targets respawn after 8 s.

## Progression (`progress.js`, localStorage `wartanks.profile.v1`)

Tech tree per nation (Deutschland, Sowjetunion, USA, Großbritannien), tiers I/II…VIII,
XP per tank to research the next, credits to buy, start tanks unlocked. Ammo loadout
(premium APCR/HEAT costs credits). Save export/import like warships.

As implemented: `loadProfile()`, `saveProfile(p)`, `resetProfile()`, `newProfile()`,
`techTree() -> { DE:[ids by tier], ... }`, `tankState(p, id) -> { owned, researched, xp, prev,
researchXP, price, canResearch, canBuy }`, `research(p, id)` / `buy(p, id) -> { ok, reason }`,
`calcRewards(world)`, `applyRewards(p, tankId, result)`, `exportProfile(p) -> 'WT1:'+base64`,
`importProfile(str)` (throws on garbage). Research XP by tier 5/6/7/8: 2500/6000/12000/22000;
prices tier 4–8: 30k/90k/200k/450k/900k; start: 150k credits and the first tank of each
nation. Works without localStorage (memory fallback).

## Rendering & controls (client)

* Third-person orbit camera around the turret, mouse = aim (camera direction defines the aim
  ray; aim point = first hit on terrain/tanks/objects), wheel zoom: seamless ladder from far
  third-person into sniper mode (×2, ×4, ×8, ×16), Shift toggles sniper; right mouse held =
  free look (turret stays); keys: WASD drive, Space handbrake/neutral, R/F cruise, 1-4 ammo,
  5-7 consumables, LMB fire, X auto-aim lock-on (snaps on a spotted enemy), C free camera?,
  M map, Tab score.
* Reticle: dispersion circle (shrinks with aim time), **penetration indicator colour**
  (green/yellow/red by chance to penetrate the plate under the reticle, using `armor.js`),
  centred on the crosshair (the aim point lies on the camera ray and the sim lays the gun on it
  with superelevation for drop, so once laid the shot goes there), reload ring. While the turret
  still traverses or the gun sits at an elevation/depression stop, a small amber diamond
  (`hud.barrelMark`) shows where the shot would land now, pinned to the screen edge if off
  screen; gun cannot elevate/depress → red ×, "Zielmarkierung" for locked target.
  `hud.ret = {gx, gy, cx, cy, bx, by, laid}` and `hud.bres` (barrel-to-crosshair px) for tests.
* Damage panel: module/crew icons, HP bar, speed, ammo counts, consumables; damage-received
  directions; hit log ("Durchschlag 142 mm effektiv", "Abpraller", "Kein Durchschlag").
* Armour viewer in garage (colours plates by effective thickness from current view angle).
* Tank models: hull/turret from armour geometry, plus tracks with road wheels and animated
  treads (UV scroll), mantlet, barrel with muzzle brake, hatches, cupola, exhausts, tools,
  camouflage paint per nation, decals (balken cross / star / roundel as simple vector shapes),
  damage: burnt texture on wreck, turret blown off on ammo-rack. Shell hit marks (`hitmarks.js`,
  fed by `tanks3d.js` from pen / he / noPen / ricochet events: `dstId, pos, normal, cal, from`,
  all on the net whitelist): penetration / direct HE = dark hole with scorched rim, noPen /
  ricochet = bright scrape along the shell path. Snapped to the rendered model by a short ray
  along the plate normal, stored in the hull-body or turret frame (so they traverse with the
  turret), up to 24 per tank (oldest dropped), wrecks included; all tanks share two
  InstancedMeshes = 2 draw calls. `G.tanks3d` is exposed for tests.
* Effects: muzzle blast + smoke + dust ring on the ground, shell tracer, impact sparks on armour,
  dirt splash on ground, ricochet sparks with a deflected tracer, penetration flash, fire &
  black smoke, ammo rack explosion, track dust while driving, track marks decals, tree falling,
  houses breaking.
* Audio (synthesised): engine per tank (rpm-following, diesel vs petrol), tracks clank by speed,
  gun shot by caliber (with distance delay and echo), shell whistle near-miss, ricochet ping,
  penetration clang, non-pen "dong", HE explosion, ammo rack, fire crackle, radio/crew voice
  callouts as short synthetic tones + German text callouts in HUD.

## Performance budget

60 fps on a desktop GPU with 14 tanks: instancing for trees/rocks/grass, at most a few hundred
draw calls, no per-frame allocations in hot paths (pools), shadows from one directional light.

## Multiplayer (`net/`, contract: `game/net/CONTRACT.md`)

Same model as warships `game3d/net/`: serverless, host-authoritative. Players meet over public
MQTT brokers (topic root `wt3d/1`); data goes over WebRTC where possible, otherwise encrypted
through the brokers. Co-op vs bots (up to 5 humans, `coop.js`) and PvP up to 5 v 5 (`pvp.js`,
free places are bots), battle types `standard` and `encounter`.

- `lobby.js` + `mpui.js` (menu "Mehrspieler", "Feldkarte" UI): rooms, password, tanks, teams,
  ready, start; calls `window.__game.startNetGame(session)` (main.js) on every peer.
- `game.js`: session -> `net` (`G.net`). Host builds the World (`setup.js`: roster, ids 1..n,
  captains marked `human`, no BotAI on them) and wraps `world.update` with `NetHost.step`
  (`host.js`: commands, 20 Hz per-client snapshots filtered by spotting, event batches, 4 Hz sync,
  per-client end). Clients build the same World from `start` and replace `world.update` with
  `Replica.update` (`replica.js`: interpolation, local turret prediction, local shell flight);
  the own tank's `fire/setAmmo/useConsumable` become command actions (`command.js`). Binary
  snapshot layout in `codec.js`.
- World team 1 is the host's team; sides follow `world.player.team`, so rendering / HUD need
  no change. Pause does not stop a net game. At the end every peer applies its own rewards via
  progress.js (`menu.applyResult`), then `net.finish` hands the result (PvP table) to the lobby.
- Host migration (`migrate.js`): the host names a successor and sends it the full state once a
  second (`mig`: tank internals, modules, crew, fires, reloads, bots' AI, caps, timers). When the
  host leaves or goes silent, the successor turns its replica into the real World and runs
  `NetHost` from its own slot; the others follow its `host` announcement. Shells in the air are
  lost.
- PvP `evt` is filtered per team (shells, events of unspotted enemies). The room keeps captains
  whose connection was lost, for a rejoin. relay.js revives a timed-out peer with its stream
  counters (the reason the relay test failed: a client frozen by shader compiling was timed out and
  never heard again).

## Tests

`npm test` (= `node --test "tests/*.test.mjs"`; node ≥ 22 no longer accepts a bare directory) — sim tests (armour ray tests, effective thickness, ricochet/overmatch,
pen falloff, determinism of terrain, a bot battle runs to an end without errors). Playwright
screenshot scripts in `tests/*.mjs` for the browser (Chrome via playwright).
`tests/net.test.mjs`: co-op 3 humans, PvP 2v2 and a full 1v1 match at 80 ms over `makeMemoryHub`
(ids, replica error, captains' shots, no visibility leaks, end/rewards per client).
`tests/migrate.test.mjs`: host migration over the memory hub; `tests/relay.test.mjs`: relay.js over
a fake broker (revive, own stall).
`tests/playwright.mp.mjs [local|relay]`: two pages, lobby -> match, both drive and fire, the client
reloads and comes back; `tests/playwright.migrate.mjs`: three pages, the host page closes mid-match;
`tests/playwright.mplobby.mjs`: lobby flow.

`tests/sim.mjs` runs a headless battle: `runBattle({ map, diff, seed, mode, player })` →
`{ w, ms, time, result, alive, counts (per event type), shots, hits, pens, dmg }`; CLI
`node tests/sim.mjs <map> <diff> <seed> <mode>`. `tests/battle.test.mjs`: 5 bots-only 7v7
battles over all difficulties and maps, a battle with a player, training ground, spotting,
terrain determinism, matchmaking, progression.

## Campaign (`campaign.js`, sim) — scripted historical operations

All mission logic runs inside the World (deterministic, `world.rng` only, no DOM), so a co-op host
can run an operation unchanged and clients only render `world.campaign`.

* Start: `new World({ mode: 'campaign', op, playerCls, difficulty })`; `MISSIONS.campaign.mapFor/seedFor`
  take map and seed from the op (`World` asks `mission.mapFor?.(opts)` before `makeTerrain`).
  `playerCls: null` = headless run: the player's tank is a bot that follows `S.goal()` (autopilot).
  `MISSION_LIST` excludes `campaign` (it starts from the Feldzug menu).
* `OPS[id] = { id, name, place, date, nation, map, seed, tanks:[cls], start0:[x,z,yaw], brief:[…],
  goals:[…], tip, fog?, playerMayDie?, script(S), start?(S) }`, `OP_LIST` = campaign order.
* `world.campaign = { op, phase, objectives:[{ id, text, state:'active'|'done'|'failed', bonus,
  hidden, count?, need? }], log:[{ t, text, kind:'radio'|'info'|'warn' }], markers:[{ id, x, z, r,
  label, kind:'goal'|'area'|'danger' }], timer:null|{ label, left }, fog (0..1, cuts view range by
  up to 62 % in spotting.js) }`. Events: `objective { id, state, text }`, `radio { text, kind }`.
* `world.result.campaign = { op, stars 0–3, medal 'bronze'|'silber'|'gold'|null, objectives }`;
  stars = 1 + share of bonus objectives done (×2), −1 if the player ends below 25 % HP.
* Script runtime `S` (class `Script`): `obj(id, text, { bonus, hidden, need })`, `done/fail/show/
  progress(id, n)`, `radio(text, kind)`, `phase(p)`, `timer(label, s)`, `mark/unmark`, `goal(x, z,
  label, r)`, `spawn(cls, team, x, z, { yaw, face, name, tag, order })` (wires side + BotAI for
  late spawns; emplacements face `op.start0` by default), `group/alive/dead(tag)`, `countIn(team|
  tag, x, z, r)`, `order(tanks, { kind:'hold'|'advance'|'route'|'ambush', x, z, pts, r })`,
  triggers `when(cond, fn, { repeat })`, `at(t)`, `after(dt)`, `every(dt)`, `win/lose(reason)`.
  Trigger evaluation 4 Hz; the player's death loses unless `op.playerMayDie`.
* Bot orders (`ai.js`): `ai.order` overrides `chooseDest` (route advances waypoint by waypoint in
  `Script.tick`); hold / ambush suppress the no-pen flanking; ambush holds fire until an enemy is
  spotted within `r` or the tank is hit.
* Emplacements (`config.js` `SITE_RAW`, ids in `SITE_LIST`, in `TANKS` but not `TANK_LIST`):
  `cfg.site` = `'bunker'` (Regelbau: 300 mm concrete, 60 mm embrasure band `emb`, 70 mm rear door),
  `'pak'` (`pak40`: 5 mm shield, 260 HP, HE kills it), `'ship'` (`tboat`, Torpedoboot, 10,5 cm gun,
  12–15 mm plating, floats at `terrain.water − cfg.draft`). They never drive (`Tank._siteTick`).
* Script helpers added for the balanced ops:
  * `S.hunt(tag|[tags], label, onDone)`: every ~2 s it puts the goal on the nearest live member of the
    groups and calls `onDone` when all of them are dead (`S._hunt = null` cancels). A bunker target gets
    its goal at the rear quarter (`max(14, off·0.8)` behind and to the side), so the player meets the
    70 mm door and not 300 mm of concrete.
  * `S.refit(frac = 0.4, text)` adds `frac·maxHP` HP, repairs all modules, revives the crew, gives each
    consumable at least 1 charge, refills each ammo type to at least 60 % of `gun.load`, and radios `text`.
  * `S.hullDown(x, z, r, ex, ez)` returns `[x, z]` just behind the highest dry ground within `r`,
    measured against an enemy at `(ex, ez)`. It backs off until the ground is about 1.4 m below the
    crest. Use it with `mark(...)` and `goal(...)` for a marked firing position.
  * `spawn(..., { aiErr, viewMul })`. `aiErr` overrides `cfg.aiErr`, and `_tuneAI` multiplies
    `ai.D.err` by it (green or emplacement crews aim worse). `viewMul` scales `cfg.view` in
    `tank.js` (spotting), e.g. 0.4 under artillery smoke.
  * Route orders can carry `pin: true`. Like hold and ambush, this stops the no-pen flanking
    detour (`ai.js`, `bestRatio < 0.8`), so the bot keeps to its scripted path. Used for
    counter-attack echelons and the Königstiger sortie.
* `cfg.eye` (emplacements) sets the spotting eye height above `pos.y` in place of `height + 0.3`: the
  PaK commander stands behind the shield (2.1 m), the boat sees from its bridge (14 m).
  `cfg.aiErr` is the crew's base aim error (PaK 1.7, boat 2.2).
* The ship armour (`armor.js` `shipHullParts`) is 13 convex slices along z, using the same
  `shipSection` taper as `tanks3d.js`. Bow end face = `nose`, stern end face = `urp`; the faces
  between slices are internal. Hits therefore land on the plating as drawn.
* Bot behaviour that matters in the ops:
  * `ai.js _mateInLine` holds fire while a friendly tank is in the line of fire.
  * `chooseAim` also tries the low rear and the gun port (`gun.pivotY`) on sites.
  * HE is preferred against PaKs (×1.2) and penalised against armour (×0.5).
* `World({ salt })` re-rolls the dice (shots, AI) without changing the terrain. `salt` 0 is the
  classic run. Balance sweep: `tests/out/_robust.mjs [ops|all] [diffs] [nSalt] [countdowns]`
  (scratch, gitignored) prints win rate, mean duration and stars per op and difficulty.
* Maps: `noRandom: true` in `MAPS` (e.g. the sea-half `kueste`) keeps a map out of `RANDOM_MAPS`, the
  pool the menu's "random" map draws from. Such maps are reached only through the campaign or by
  choosing them directly.
* Tests: `tests/campaign.test.mjs` runs every op headless; `tests/out/_camp.mjs` (scratch) prints
  per-op outcome and objective states.

## Campaign UI (client: `menu.js`, `hud.js`, `tanks3d.js`, `progress.js`)

* Menu: title button "Feldzug" → `#pz-camp` (operation index cards from `OP_LIST`: name, place,
  date, nation insignia, stars, "Gesperrt"/"Erfüllt" stamps) → `#pz-brief` (briefing sheet with
  `brief`/`goals`/`tip`, tank choice from `op.tanks` with gun/pen/damage/front armour/speed,
  difficulty, "Einsatz beginnen") → `startBattle({ mode:'campaign', op, playerCls, difficulty })`.
  `campaign.js` is loaded lazily (`import()`) by the menu.
* Results (`mode === 'campaign'`): objectives with ✓/✗, stars, medal SVG (Gold/Silber/Bronze),
  buttons "Zurück zum Feldzug" / "Erneut versuchen" / "Nächste Operation"; no XP/credits.
  `applyResult` calls `recordCampaign` only.
* Progress: `profile.campaign[opId] = { done, stars (best), bestTime, tries }`;
  `recordCampaign(p, opId, result)`, `campaignUnlocked(p, opId, order)` (op n+1 opens once op n
  is won).
* HUD reads `world.campaign` only: objectives panel top-left (flash on change; hidden objectives
  appear once resolved), radio ticker from the append-only `log` (top centre, FUNK/LAGE/ACHTUNG,
  8 s), mission timer, screen waypoint diamonds with label + distance (edge-clamped with arrow,
  "erreicht" inside `r`), marker diamonds/rings on minimap and big map; sites and unseen enemies
  are left out of the team list; end banner "AUFTRAG ERFÜLLT"/"GESCHEITERT".
* Site models (`buildSiteModel` for `cfg.site`): bunker (concrete, steel embrasure band, earth
  cover), PaK 40 (shield, spoked wheels, split trails), Torpedoboot (hull, bridge, funnels, mast,
  ensign). Wrecks: bunker blackens, PaK tips over, ship lists and sinks 5.5 m over 40 s.
* Autostart: `?autostart&mode=campaign&op=<id>&tank=<cls>`. Browser check:
  `tests/out/campaign.flow.mjs` (title → ops → briefing → HUD → results → unlock).
