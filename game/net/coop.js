// game/net/coop.js — co-op rules (humans vs bots). See CONTRACT.md "Co-op".
export const COOP_MAX = 5;
const COOP_MODES = ['standard', 'encounter'];
/** Max human players incl. host (0 = mode not playable in co-op; training is single-player only). */
export function coopSlots(mission) { return COOP_MODES.includes(mission) ? COOP_MAX : 0; }
export function coopModes() { return COOP_MODES.slice(); }
