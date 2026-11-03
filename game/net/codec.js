// game/net/codec.js — binary snapshot (`snap`, host -> one client, latest wins). See CONTRACT.md.
//
// little endian:
//   u8 0x54 'T' | u32 tick | u32 actionAck | u32 cmdSeq echo | u8 n
//   n x tank (27 B): u8 id | u8 flags | i16 x*20 | i16 y*50 | i16 z*20 | u16 yaw | i16 pitch*1e4 | i16 roll*1e4
//                    | i16 speed*100 | u16 turretYaw | i16 gunPitch*1e4 | u16 hp | u32 bits | u8 shots mod 256
//     flags: 1 alive, 2 burning, 4 spotted, 8 turretOff, 16 detected, 32 gunBlocked
//     bits:  modules 2 bits each (0 ok, 1 damaged, 2 destroyed) in MOD_IDS order (18 bits),
//            crew dead bits << 18 (7), crew wounded bits << 25 (7), cfg.crew order
//   own detail: u8 ownId (0 = none) | u16 reload*100 | u16 reloadMax*100 | u16 aimDisp*1000 | u8 ammoSel index
//            | u8 nAmmo, nAmmo x u16 count (cfg.gun.ammo order) | u8 nCons, nCons x (u8 count, u16 cd*10) (CONS_IDS order)
// Visibility (filter on the host, `visibleTo`): own team, enemies spotted by the receiver's team, wrecks.
import { CONSUMABLES } from '../config.js';

export const MOD_IDS = ['engine', 'ammo', 'fuel', 'gun', 'turretRing', 'radio', 'optics', 'trackL', 'trackR'];
export const CONS_IDS = Object.keys(CONSUMABLES);
const MS = { ok: 0, damaged: 1, destroyed: 2 }, MS_R = ['ok', 'damaged', 'destroyed'];
const TAU = Math.PI * 2;
const ang16 = (a) => Math.round((((a % TAU) + TAU) % TAU) / TAU * 65536) & 0xffff;
const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
const u16 = (v) => Math.max(0, Math.min(65535, Math.round(v)));

export const visibleTo = (t, team) => t.team === team || !t.alive || t.spotted;

/** Host: snapshot for one receiver. */
export function encodeSnap(world, tick, ack, echo, own, team) {
   const list = world.tanks.filter((t) => visibleTo(t, team));
   const nA = own ? own.cfg.gun.ammo.length : 0;
   const buf = new ArrayBuffer(14 + list.length * 27 + 1 + (own ? 8 + 1 + nA * 2 + 1 + CONS_IDS.length * 3 : 0));
   const v = new DataView(buf); let o = 0;
   v.setUint8(o++, 0x54); v.setUint32(o, tick >>> 0, true); o += 4; v.setUint32(o, ack >>> 0, true); o += 4;
   v.setUint32(o, echo >>> 0, true); o += 4; v.setUint8(o++, list.length);
   for (const t of list) {
      v.setUint8(o++, t.id);
      v.setUint8(o++, (t.alive ? 1 : 0) | (t.burning ? 2 : 0) | (t.spotted ? 4 : 0) | (t.turretOff ? 8 : 0) | (t.detected ? 16 : 0) | (t.gunBlocked ? 32 : 0));
      v.setInt16(o, i16(t.pos.x * 20), true); v.setInt16(o + 2, i16(t.pos.y * 50), true); v.setInt16(o + 4, i16(t.pos.z * 20), true); o += 6;
      v.setUint16(o, ang16(t.yaw), true); v.setInt16(o + 2, i16(t.pitch * 1e4), true); v.setInt16(o + 4, i16(t.roll * 1e4), true); o += 6;
      v.setInt16(o, i16(t.speed * 100), true); v.setUint16(o + 2, ang16(t.turretYaw), true); v.setInt16(o + 4, i16(t.gunPitch * 1e4), true); o += 6;
      v.setUint16(o, u16(t.hp), true); o += 2;
      let bits = 0;
      MOD_IDS.forEach((id, i) => { bits |= (MS[t.modules[id]?.state] ?? 0) << (i * 2); });
      t.cfg.crew.forEach((c, i) => { if (i < 7) { const m = t.crew[c.id]; if (!m.alive) bits |= 1 << (18 + i); if (m.wounded) bits |= 1 << (25 + i); } });
      v.setUint32(o, bits >>> 0, true); o += 4;
      v.setUint8(o++, t.stats.shots & 255);
   }
   v.setUint8(o++, own ? own.id : 0);
   if (own) {
      v.setUint16(o, u16(own.reload * 100), true); v.setUint16(o + 2, u16(own.reloadMax * 100), true); v.setUint16(o + 4, u16(own.aimDisp * 1000), true); o += 6;
      const am = own.cfg.gun.ammo;
      v.setUint8(o++, Math.max(0, am.findIndex((a) => a.type === own.ammoSel)));
      v.setUint8(o++, nA);
      for (const a of am) { v.setUint16(o, u16(own.ammoCount[a.type]), true); o += 2; }
      v.setUint8(o++, CONS_IDS.length);
      for (const id of CONS_IDS) { const c = own.consumables[id] || { count: 0, cd: 0 }; v.setUint8(o++, c.count & 255); v.setUint16(o, u16(c.cd * 10), true); o += 2; }
   }
   return new Uint8Array(buf, 0, o);
}

/** Client: decode into plain records (no world access). */
export function decodeSnap(u8) {
   const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); let o = 0;
   if (v.getUint8(o++) !== 0x54) return null;
   const s = { tick: v.getUint32(o, true), ack: v.getUint32(o + 4, true), echo: v.getUint32(o + 8, true), tanks: [], own: null }; o += 12;
   const n = v.getUint8(o++);
   for (let i = 0; i < n; i++) {
      const r = { id: v.getUint8(o), flags: v.getUint8(o + 1) }; o += 2;
      r.x = v.getInt16(o, true) / 20; r.y = v.getInt16(o + 2, true) / 50; r.z = v.getInt16(o + 4, true) / 20; o += 6;
      r.yaw = v.getUint16(o, true) / 65536 * TAU; r.pitch = v.getInt16(o + 2, true) / 1e4; r.roll = v.getInt16(o + 4, true) / 1e4; o += 6;
      r.speed = v.getInt16(o, true) / 100; r.turretYaw = v.getUint16(o + 2, true) / 65536 * TAU; r.gunPitch = v.getInt16(o + 4, true) / 1e4; o += 6;
      r.hp = v.getUint16(o, true); r.bits = v.getUint32(o + 2, true); r.shots = v.getUint8(o + 6); o += 7;
      s.tanks.push(r);
   }
   const ownId = v.getUint8(o++);
   if (ownId) {
      const d = s.own = { id: ownId, reload: v.getUint16(o, true) / 100, reloadMax: v.getUint16(o + 2, true) / 100, aimDisp: v.getUint16(o + 4, true) / 1000 }; o += 6;
      d.ammoIdx = v.getUint8(o++);
      const nA = v.getUint8(o++); d.ammo = [];
      for (let i = 0; i < nA; i++) { d.ammo.push(v.getUint16(o, true)); o += 2; }
      const nC = v.getUint8(o++); d.cons = [];
      for (let i = 0; i < nC; i++) { d.cons.push([v.getUint8(o), v.getUint16(o + 1, true) / 10]); o += 3; }
   }
   return s;
}

/** Client: module / crew bits onto a tank. */
export function applyBits(t, bits) {
   MOD_IDS.forEach((id, i) => { const m = t.modules[id]; if (m) m.state = MS_R[(bits >>> (i * 2)) & 3] || 'ok'; });
   t.cfg.crew.forEach((c, i) => { if (i < 7) { const m = t.crew[c.id]; m.alive = !((bits >>> (18 + i)) & 1); m.wounded = !!((bits >>> (25 + i)) & 1); } });
}
/** Client: own-tank detail. */
export function applyOwn(t, d) {
   t.reload = d.reload; t.reloadMax = d.reloadMax || t.reloadMax;
   const am = t.cfg.gun.ammo;
   if (am[d.ammoIdx]) t.ammoSel = am[d.ammoIdx].type;
   am.forEach((a, i) => { if (i < d.ammo.length) t.ammoCount[a.type] = d.ammo[i]; });
   CONS_IDS.forEach((id, i) => { const c = t.consumables[id]; if (c && d.cons[i]) { c.count = d.cons[i][0]; c.cd = d.cons[i][1]; } });
   t.netAimDisp = d.aimDisp;
}
