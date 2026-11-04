# Multiplayer contract (PANZER)

Serverless multiplayer, modelled on the warships game (`D:/warships/game3d/net/CONTRACT.md`). No
own server, no accounts: players find each other over public MQTT brokers (topic root `wt3d/1`);
game data goes over a WebRTC data channel where one comes up ("direkt") and otherwise through the
brokers, AES-GCM encrypted with a key from the room password ("über Relay").
Modes: **co-op against bots** (up to 5 humans) and **PvP** (up to 5 v 5; free places are bots).
Battle types: `standard`, `encounter` (training stays single-player).

## Model: host-authoritative

- The host's browser runs the one real `World` (state.js), bots included. Captains take the first
  places of their team in slot order; the host applies their commands to their tanks.
- A client builds the same `World` from the host's `start` message (same seed, roster, map, so
  terrain, objects, tank classes, names and ids match), but **never simulates it**:
  `world.update` is replaced by `Replica.update` (replica.js). `world.player` is the client's own
  tank, so renderer, HUD, FX, audio and camera read the world exactly as in single player.
- World team 1 is always the host's team. Sides (`player` / `ally` / `enemy`) are recomputed
  from the own tank's team (`setup.setOwn`); all consumers compare teams with `world.player.team`,
  so a PvP client of World team 2 needs no flipping of positions, bases or events.
- Pause never stops the simulation in a net game (`main.js`: `G.paused && !G.net`).

## Transport (`transport.js`, `relay.js`, `transport_rtc.js`, `mqtt.js`)

Unchanged copies of the warships transport (see the file headers there), topic root `wt3d/1`,
WebRTC app id `panzer-wt3d-net`. `makeMemoryHub()` for node tests, `makeLocalTransport()`
(BroadcastChannel, `?net=local`) for browser tests and two tabs; `?net=relay` = brokers only.
`snap`, `cmd`, `mig` are "latest wins" over the relay; everything else is reliable and ordered.

relay.js differs from the warships copy in two places (warships has the same bug):
- A peer timed out after `DEAD_MS` (11 s) and heard again with the same epoch is **revived** with
  its stream counters (`txSeq`, `latestTx`, `rxNext`, `latestRx`) instead of starting fresh. Before,
  the side that dropped the other restarted its sequence numbers at 1 while the other side (which
  had never dropped anybody) threw everything away as duplicates: the link was dead for good, the
  host never saw the client's commands again. This is what broke `playwright.mp.mjs relay`: the
  client page froze for ~4 s compiling shaders and the host timed it out.
- A tick that comes more than 1 s late (the own page was frozen) moves every peer's last-heard
  times by the delay: an own stall drops nobody. mqtt.js likewise counts any PUBLISH as a pong and
  forgives a ping interval that fired late.
- `globalThis.__netDebug` logs every drop (`[net] relay drop <id> dead|bye|epoch <ms>`) and the
  migration steps.

Shader warm-up (render.js `warm()`, called by main.js `startBattle`): every material is compiled
before the first frame (KHR_parallel_shader_compile, polled), and `checkShaderErrors` is off unless
`?debug`. Its synchronous `getProgramInfoLog` calls had frozen SwiftShader pages for 40 s.

## Session: lobby -> game

The lobby (`lobby.js`, UI `mpui.js`) calls `window.__game.startNetGame(session)` (main.js) on
every peer when the host starts:

```js
session = {
   transport,                    // session transport of the room (lobby.js sessionTransport)
   mode: 'coop' | 'pvp',
   mission: 'standard' | 'encounter',
   mapId,                        // maps.js id (the lobby resolves 'random' before the start)
   difficulty: 'leicht' | 'normal' | 'schwer',   // PvP: bots always 'normal'
   seed,                         // uint32 from the host
   players: [{ id, name, tank, perks, team? }],  // host first = slot order; team 1|2 in PvP; perks = crew skills (cleanPerks)
   onEnd(result),                // once: { aborted, reason, victory, outcome, xp, credits, stats, pvp? }
   onSuccessor?(id),             // host: the successor it named (the lobby sends it the seats)
   onHost?(id)                   // after a migration: the new host (may be this peer)
}
```

`result.pvp = { win: 1|2|0, my: 1|2, pl: [[name, lobbyTeam, dmg, kills, alive]] }` (lobby teams).
A host that leaves while a successor carries on gets `result.handover = true` (aborted for him).
The game owns the channels `cmd`, `snap`, `evt`, `sync`, `mig`; the lobby owns `room`, `chat`.

The room keeps a player whose connection is lost during the match (`lost: 1` in the room state,
mpui shows "GETRENNT"): his seat and admission stay, so a relay route that comes back, or a reload
plus "ZURÜCK INS GEFECHT", puts him back on his tank (`rejoin`). Lost players still gone when the
match ends are removed then.

`game/net/game.js` `startNetGame(session, api)` (api = `{ startBattle, stopBattle, log }`) returns
`net` = `{ world, isHost, host | replica, stats(), finish(snap), leave(), dispose() }`. main.js
keeps it in `G.net`; at the end of the battle it applies the rewards as in single player
(`menu.applyResult`, i.e. `progress.applyRewards` for the own tank on every peer) and calls
`net.finish(snap)` instead of the results screen; mpui shows the result (and the PvP table) and
the room.

## Setup (`setup.js`)

- `makeRoster(session)` (host): `missions.matchmake(slot 0's tank, teamSize)` for the bot classes,
  then each captain's tank is written over the first free place of his World team.
- `buildWorld(start)` (all): `new World({ mode, mapId, seed, difficulty, roster })`, tank ids
  renumbered 1..n in roster order (team 1 then team 2), captains' names, `tank.human = true`,
  terrain objects already destroyed (`deadObj`, for a late join) applied, captains' crew skills
  (`tank.setPerks(slot.perks)`, cleaned again; bots get none).
- Crew skills: the lobby `hello` / `set {tank}` carry `perks` (the own profile's list for that
  tank, `lobby.ownPerks`); the host keeps them per player only through `config.cleanPerks` (known
  ids, no doubles, at most `MAX_PERKS`), so a forged list cannot buff beyond the modest legal set.
- `setOwn(world, tankId)`, `setHuman(world, tank, on)`: a captain's tank has no BotAI on the host
  while he is connected; it gets one back when he leaves or his connection is lost (and loses it
  again when he is heard from).

## Wire protocol (`NET_VERSION` from transport.js)

`sync` (JSON, `k` = kind):

| k | direction | content |
|---|---|---|
| `hello` | client -> host, every 0.3 s until `start` | `v` |
| `start` | host -> one client | `v, mode, mission, mapId, difficulty, seed, roster {team1, team2}, slots [{name, tank, perks, team?, wteam, idx, tid}], self` (slot), `rejoin` 0/1, `deadObj [[objId, fallYaw]]` |
| `refuse` | host -> client | not in the match / `why: 'version'` |
| `st` | host -> all, 4 Hz | `t` tick, `ph` phase, `cd` countdown, `tl` time left, `caps [[progress, capper, n]]`, `hs` successor's peer id |
| `me` | host -> each client, 1 Hz | `s` = the captain's `tank.stats` |
| `end` | host -> each client | `outcome` for the receiver's team, `reason` (mirrored for the losing side), `winner` (World team), `time`, `s` stats, `alive`, PvP: `pvp` table |
| `abort` | host -> all | the host left before the end and nobody carries on |
| `left` | host -> all | the host left; the successor (`hs`) carries on (sent after a last `mig`) |
| `host` | new host -> all | `id`, `t` tick: this peer runs the match now |
| `bye` | client -> host | the captain left; his tank goes back to the AI |

A client gives up after 15 s without `start`. While the match runs, the host counts as gone on
`left`, on the transport's peer-leave of the host, or after 12 s without anything from it; then
the match goes on under the successor (Host migration), or ends ("Verbindung zum Gastgeber
verloren") if there is none.

`cmd` (client -> host, JSON, 30 Hz, latest wins): `[seq, throttle*100, steer*100, brake,
aimX*10, aimY*10, aimZ*10, lockId, actBase, actions]`. Actions are numbered from `actBase` and
repeated until the snapshot acknowledges their count: `['F']` fire (the host fires as soon as the
gun is loaded, within 0.35 s), `['A', type]` ammo, `['C', id]` consumable. On the client the own
tank's `fire / setAmmo / useConsumable` are replaced by these actions, so main.js controls are
unchanged.

`snap` (host -> one client, binary, 20 Hz; layout in the header of `codec.js`): tick, action ack,
cmd echo, then 27 bytes per tank the receiver may see — own team, enemies spotted by the
receiver's team (`tank.spotted`), wrecks — in co-op as in PvP; then the own-tank detail (reload,
reload max, aim dispersion, ammo selection and counts, consumables). Tanks missing from a snapshot
are hidden on the client (`spotted = visible = false`).

`evt` (host -> all joined clients, JSON `[batch, tick, items]`, with every snapshot when non-empty):
`['e', type, fields]` world event (fields slimmed, numbers rounded to 0.01), `['s', id, owner, x,
y, z, vx, vy, vz, ammo, cal]` shell spawn or new leg after a ricochet, `['x', id, x, y, z]` shell
ended there, `['f', kind, x, y, z, size, life, cal, objId]` effect, `['o', objId, fallYaw]` terrain
object destroyed (trees fall, houses break on every client). Event fields are whitelisted
(host.js `EV_KEYS`, `wreck` included); `null` / `false` fields are left out.

PvP filters the items per World team, as in warships (`visibleTo`: own team, wrecks, spotted):
- `s` goes to a team that was already told of that shell or sees its owner (a ricochet leg of a
  shell it saw stays visible);
- `x` only to the teams told of the shell;
- `e`: `spotted` only to the spotter's team; any other event about a hidden target (`dstId`), or
  without a target from a hidden source (`srcId`), is dropped;
- `f` and `o` go to everybody (effects in the world, terrain).

Co-op sends everything to everybody.

## Host migration (`migrate.js`, `game.js`, `host.js`)

Modelled on warships `migrate.js`.
- The host names the first joined client as successor (`st.hs`, `session.onSuccessor`). Once a
  second (`MIG_DT`) it sends it `mig` (latest wins):
  `{ k: 'mig', t: tick, w: { time, phase, countdown, timeLeft, caps, result, winner, _spotAcc },
  tk: [[id, fields, ai | null]], pl: [[peer, joined 0|1]] by slot, host: slot }`.
  - `fields`: every tank field except configuration, armour, AI and the pose-derived ones
    (`_pose`, `muzzle`, `gunDir`, `input`). That covers hp, reload, ammo, consumables, fires,
    statistics, spotting timers, and tanks out of sight in PvP. Modules and crew list only the
    damaged ones (`$dmg`).
  - `ai`: the bot's BotAI state without its references (path, target, timers).
  - Tanks travel as `{ $t: id }`, Sets as `{ $set }`, infinities as `{ $i }`.
  - About 25 kB/s, to the successor only (7 v 7).
- A host leaving (`net.leave()`) with a joined successor sends a last `mig`, then `left`, and
  ends for itself with `handover`. Without a successor it sends `abort`.
- On host loss (see the sync section), the successor acts 250 ms later:
  - `restoreWorld` turns its replica World into the real one. The newest snapshot's pose, hp and
    alive win over the full state, which can be up to 1 s old.
  - Bots get their AI back, the old host's tank becomes a bot, shells in the air are lost.
  - It starts a `NetHost` from its own slot (`opts.self`) and announces `{ k: 'host' }`.
  - Captains it has not heard from yet are `lost`; their next `cmd` brings them back.
- The other clients accept `host` from the successor (or from whoever the lobby has already made
  host) and follow it: the replica buffers are cleared, the new host's snapshots count. They wait
  15 s for it, then give up.
- Lobby: the successor gets the seats (`_sendSeats`); `onHost` -> `_newHost` moves the room.

## Client replica (`replica.js`)

Tanks are interpolated between snapshots ~1.6 snapshot intervals in the past (0.08..0.4 s); the
own tank's turret and gun are predicted locally every frame from the own aim point (`Tank._aim`),
so aiming feels instant; shells fly locally from their spawn data and end at the host's impact
point; effects age locally; reload / consumable cooldowns count down between snapshots.

## Measured

Node (`tests/net.test.mjs`, memory hub, 7 v 7): co-op host + 2 clients: snapshot 256 B avg at 20/s,
client down 5.6 kB/s, up 1.0 kB/s, host up 11.2 kB/s; PvP 2v2 (host + 3 clients): client down
6.0-6.7 kB/s, host up 18.7 kB/s; replica position error vs the host at the client's clock: median
0.02 m, p95 0.05 m; no unspotted enemy ever on the wire; `mig` 24-26 kB/s to the successor.
- `tests/migrate.test.mjs`: the host leaves or drops mid-match, and the successor carries on to a
  normal end (module and crew damage, bots' AI, timer).
- `tests/relay.test.mjs`: revive after a timeout, no drop after an own stall.
- Browser: `playwright.mp.mjs local|relay` (two pages: drive, fire, reload and rejoin) and
  `playwright.migrate.mjs` (three pages: the host page is closed, B carries on, C follows).

## Not done / open

- Host migration loses the shells in the air and the kill feed. A host that was cut off (rather
  than leaving) and comes back finds its match taken over, and it ends as aborted for him.
- Late join of a captain who never sent `hello` before the countdown ended works (`rejoin`), but the
  events before his join (kill feed) are not replayed.
- No movement prediction for the own hull (interpolated like everybody else).
