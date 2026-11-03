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
* Driving: P = hp·735.5·0.8·powerK; F = min(P / max(v,1.2), μ·N), μ per ground class;
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
  enemies or capturing the enemy base (100 points), 7-min timer (draw).
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
  shell-drop aware (the circle sits on the 3D aim point), reload ring, gun cannot elevate/
  depress → marker, "Zielmarkierung" for locked target.
* Damage panel: module/crew icons, HP bar, speed, ammo counts, consumables; damage-received
  directions; hit log ("Durchschlag 142 mm effektiv", "Abpraller", "Kein Durchschlag").
* Armour viewer in garage (colours plates by effective thickness from current view angle).
* Tank models: hull/turret from armour geometry, plus tracks with road wheels and animated
  treads (UV scroll), mantlet, barrel with muzzle brake, hatches, cupola, exhausts, tools,
  camouflage paint per nation, decals (balken cross / star / roundel as simple vector shapes),
  damage: burnt texture on wreck, turret blown off on ammo-rack.
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

## Multiplayer (`net/`)

Same model as warships `game3d/net/CONTRACT.md` (host-authoritative, MQTT brokers + WebRTC,
co-op vs bots and PvP, rejoin, host migration later). Transport files (`mqtt.js`, `relay.js`,
`transport.js`, `transport_rtc.js`) are copied from warships unchanged except the topic root
`wt3d/1`. The game side (`codec.js`, `command.js`, `host.js`, `replica.js`, `setup.js`,
`game.js`, `lobby.js`, `mpui.js`) is written for tanks after the singleplayer game works.

## Tests

`npm test` (= `node --test "tests/*.test.mjs"`; node ≥ 22 no longer accepts a bare directory) — sim tests (armour ray tests, effective thickness, ricochet/overmatch,
pen falloff, determinism of terrain, a bot battle runs to an end without errors). Playwright
screenshot scripts in `tests/*.mjs` for the browser (Chrome via playwright).

`tests/sim.mjs` runs a headless battle: `runBattle({ map, diff, seed, mode, player })` →
`{ w, ms, time, result, alive, counts (per event type), shots, hits, pens, dmg }`; CLI
`node tests/sim.mjs <map> <diff> <seed> <mode>`. `tests/battle.test.mjs`: 5 bots-only 7v7
battles over all difficulties and maps, a battle with a player, training ground, spotting,
terrain determinism, matchmaking, progression.
