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
   players: [{ id, name, tank, team? }],         // host first = slot order; team 1|2 in PvP
   onEnd(result),                // once: { aborted, reason, victory, outcome, xp, credits, stats, pvp? }
   onSuccessor?, onHost?         // host migration (lobby side exists, game side not implemented)
}
```

`result.pvp = { win: 1|2|0, my: 1|2, pl: [[name, lobbyTeam, dmg, kills, alive]] }` (lobby teams).
The game owns the channels `cmd`, `snap`, `evt`, `sync`; the lobby owns `room`, `chat`.

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
  terrain objects already destroyed (`deadObj`, for a late join) applied.
- `setOwn(world, tankId)`, `setHuman(world, tank, on)`: a captain's tank has no BotAI on the host
  while he is connected; it gets one back when he leaves or his connection is lost (and loses it
  again when he is heard from).

## Wire protocol (`NET_VERSION` from transport.js)

`sync` (JSON, `k` = kind):

| k | direction | content |
|---|---|---|
| `hello` | client -> host, every 0.3 s until `start` | `v` |
| `start` | host -> one client | `v, mode, mission, mapId, difficulty, seed, roster {team1, team2}, slots [{name, tank, team?, wteam, idx, tid}], self` (slot), `rejoin` 0/1, `deadObj [[objId, fallYaw]]` |
| `refuse` | host -> client | not in the match / `why: 'version'` |
| `st` | host -> all, 4 Hz | `t` tick, `ph` phase, `cd` countdown, `tl` time left, `caps [[progress, capper, n]]` |
| `me` | host -> each client, 1 Hz | `s` = the captain's `tank.stats` |
| `end` | host -> each client | `outcome` for the receiver's team, `reason` (mirrored for the losing side), `winner` (World team), `time`, `s` stats, `alive`, PvP: `pvp` table |
| `abort` | host -> all | the host left before the end |
| `bye` | client -> host | the captain left; his tank goes back to the AI |

A client gives up after 15 s without `start`, or 12 s without anything from the host while the
match runs ("Verbindung zum Gastgeber verloren"). The transport's peer-leave of the host alone does
not end a running match (a relay route can time out under load and come back).

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
object destroyed (trees fall, houses break on every client). Events are not filtered per team
(tracers of unspotted tanks are visible, as in the single-player game).

## Client replica (`replica.js`)

Tanks are interpolated between snapshots ~1.6 snapshot intervals in the past (0.08..0.4 s); the
own tank's turret and gun are predicted locally every frame from the own aim point (`Tank._aim`),
so aiming feels instant; shells fly locally from their spawn data and end at the host's impact
point; effects age locally; reload / consumable cooldowns count down between snapshots.

## Measured

Node (`tests/net.test.mjs`, memory hub, 7 v 7): co-op host + 2 clients: snapshot 256 B avg at 20/s,
client down 5.6 kB/s, up 1.0 kB/s, host up 11.2 kB/s; PvP 2v2 (host + 3 clients): client down
6.0-6.7 kB/s, host up 18.7 kB/s; replica position error vs the host at the client's clock: median
0.02 m, p95 0.05 m; no unspotted enemy ever on the wire.

## Not done / open

- **Host migration** (game side): a lost host ends the match (`abort` or silence). Seam: the lobby
  already names successors (`session.onSuccessor` / `onHost`); the game would need a `mig` state
  (World tanks, AI, shells, caps, timer) sent to the successor like warships `migrate.js`.
- Late join of a captain who never sent `hello` before the countdown ended works (`rejoin`), but the
  events before his join (kill feed) are not replayed.
- No movement prediction for the own hull (interpolated like everybody else).
