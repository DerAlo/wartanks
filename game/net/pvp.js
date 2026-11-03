// game/net/pvp.js — PvP rules: two teams of humans, free places are bots. See CONTRACT.md "PvP".
export const PVP_MAX = 10, TEAM_MAX = 5;
export function pvpMissions() { return ['standard', 'encounter']; }
/** Humans a PvP mode takes (0 = not in PvP). */
export function pvpSlots(mission) { return pvpMissions().includes(mission) ? PVP_MAX : 0; }
