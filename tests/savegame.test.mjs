// Save file export / import (game/savegame.js) and the logo cheat (progress.maxOutProfile).
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSave, readSave, importSave, saveFileName, SAVE_APP } from '../game/savegame.js';
import * as P from '../game/progress.js';
import { TANKS, TANK_LIST, CHEAT_TANKS, PERK_LIST, MAX_PERKS } from '../game/config.js';

class MemStore {
   constructor(o = {}) { this.m = new Map(Object.entries(o)); }
   get length() { return this.m.size; }
   key(i) { return [...this.m.keys()][i] ?? null; }
   getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
   setItem(k, v) { this.m.set(k, String(v)); }
   removeItem(k) { this.m.delete(k); }
}

test('export carries every game key but the device-local graphics preset', () => {
   const s = new MemStore({
      'wartanks.profile.v1': JSON.stringify({ v: 1, credits: 7 }), 'wartanks.menu.v1': '{"cls":"pz4h"}', 'wartanks.input.v1': '{"sens":1.2}',
      'wartanks.audio.v1': '{"volume":0.5}', 'wartanks.net.name': 'Hauptmann Kurt', 'wartanks.gfx.v1': 'high', 'other.app': '{}',
   });
   const j = JSON.parse(exportSave(s, new Date('2026-11-04T10:00:00Z')));
   assert.equal(j.app, SAVE_APP); assert.equal(j.app, 'panzer'); assert.equal(j.v, 1); assert.equal(j.saved, '2026-11-04T10:00:00.000Z');
   assert.deepEqual(Object.keys(j.data).sort(), ['wartanks.audio.v1', 'wartanks.input.v1', 'wartanks.menu.v1', 'wartanks.net.name', 'wartanks.profile.v1']);
});

test('import replaces the career, keeps graphics and foreign keys, round trip is exact', () => {
   const a = new MemStore({ 'wartanks.profile.v1': '{"v":1,"credits":123}', 'wartanks.net.name': 'Anna', 'wartanks.gfx.v1': 'low' });
   const file = exportSave(a);
   const b = new MemStore({ 'wartanks.profile.v1': '{"v":1,"credits":5}', 'wartanks.menu.v1': '{"cls":"kv1"}', 'wartanks.gfx.v1': 'high', 'x.y': '1' });
   const r = importSave(file, b);
   assert.equal(r.ok, true); assert.equal(r.count, 2);
   assert.equal(b.getItem('wartanks.profile.v1'), '{"v":1,"credits":123}');
   assert.equal(b.getItem('wartanks.net.name'), 'Anna');
   assert.equal(b.getItem('wartanks.menu.v1'), null, 'keys missing from the file are removed');
   assert.equal(b.getItem('wartanks.gfx.v1'), 'high', 'graphics preset stays on the device');
   assert.equal(b.getItem('x.y'), '1');
   assert.equal(exportSave(b).replace(/"saved".*\n/, ''), exportSave(a).replace(/"saved".*\n/, '').replace(/"wartanks.gfx[^\n]*\n/, ''));
});

test('garbage and foreign files are rejected with German messages, storage untouched', () => {
   const s = new MemStore({ 'wartanks.profile.v1': '{"v":1}' });
   for (const bad of ['nicht json', '[]', '{"app":"kriegsschiffe","data":{"wartanks.profile.v1":"{}"}}', '{"app":"panzer","data":[]}',
      '{"app":"panzer","data":{"wartanks.profile.v1":"kein json","wartanks.gfx.v1":"\\"x\\"","fremd":"{}"}}']) {
      const r = importSave(bad, s);
      assert.equal(r.ok, false, bad); assert.match(r.error, /Speicherstand|JSON/);
   }
   assert.equal(s.length, 1); assert.equal(s.getItem('wartanks.profile.v1'), '{"v":1}');
   assert.equal(readSave('{"app":"panzer","data":{"wartanks.menu.v1":"{}"}}').ok, true);
   assert.equal(importSave('{"app":"panzer","data":{"wartanks.menu.v1":"{}"}}', null).ok, false, 'no storage');
});

test('file name', () => {
   assert.equal(saveFileName(new Date(2026, 0, 5)), 'panzer-speicherstand-2026-01-05.json');
});

test('logo cheat: every tank owned with full crews, credits, all operations won; persists through sanitize', () => {
   const p = P.newProfile(), ops = ['op1', 'op2', 'op3'];
   for (const id of CHEAT_TANKS) assert.equal(P.tankState(p, id).owned, false, 'cheat tanks start locked');
   assert.deepEqual(P.garageTanks(p), TANK_LIST);
   P.maxOutProfile(p, ops);
   assert.equal(p.cheat, true);
   assert.ok(p.credits >= 1e7 && p.freeXP >= 1e5);
   for (const id of [...TANK_LIST, ...CHEAT_TANKS]) {
      const s = P.tankState(p, id), c = P.crewState(p, id);
      assert.ok(s.owned && s.researched, id);
      assert.equal(c.points, MAX_PERKS, id); assert.deepEqual(P.perksOf(p, id), PERK_LIST);
   }
   for (const id of ops) { assert.equal(P.campaignUnlocked(p, id, ops), true); assert.equal(p.campaign[id].stars, 3); }
   assert.deepEqual(P.garageTanks(p), [...TANK_LIST, ...CHEAT_TANKS]);
   const back = P.importProfile(P.exportProfile(p));                  // sanitize keeps the flag and the cheat tanks
   assert.equal(back.cheat, true);
   for (const id of CHEAT_TANKS) assert.equal(back.tanks[id].owned, true);
   const forged = JSON.parse(JSON.stringify(p)); forged.cheat = false;   // owning a cheat tank without the flag: taken away
   const f = P.importProfile(P.exportProfile(forged));
   for (const id of CHEAT_TANKS) assert.equal(f.tanks[id].owned, false);
   for (const id of CHEAT_TANKS) assert.ok(TANKS[id] && !TANK_LIST.includes(id));
});
