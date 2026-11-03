// relay.js over a fake broker: a peer that timed out (DEAD_MS) and is heard again goes on with its
// streams, both ways, also when only one side had dropped the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRoomTransport } from '../game/net/relay.js';

const real = performance.now.bind(performance);
let off = 0;
performance.now = () => real() + off;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeBroker() {
   const subs = new Map(), blocked = new Set();
   const mkBus = (name) => ({
      size: 1, watch: new Set(), name,
      isOpen: () => true, gap: () => 0, backlog: () => 0, status: () => ({ open: 1, total: 1 }),
      subscribe(topic, fn) { (subs.get(topic) || subs.set(topic, new Set()).get(topic)).add(fn); },
      unsubscribe(topic, fn) { subs.get(topic)?.delete(fn); },
      publish(b, topic, bytes) { if (blocked.has(name)) return true; setTimeout(() => { for (const fn of [...(subs.get(topic) || [])]) fn(bytes.slice(), 0); }, 2); return true; },
      publishAll(topic, bytes) { return this.publish(0, topic, bytes); },
   });
   return { mkBus, blocked };
}

test('a timed-out peer is revived with its streams', async () => {
   const br = makeBroker();
   const A = await makeRoomTransport({ bus: br.mkBus('A'), selfId: 'aaaa', room: 'r1', hostId: 'aaaa' });
   const B = await makeRoomTransport({ bus: br.mkBus('B'), selfId: 'bbbb', room: 'r1', hostId: 'aaaa' });
   const gotB = [], gotA = [], snapsB = [], log = [];
   B.on('sync', (d) => gotB.push(d)); A.on('sync', (d) => gotA.push(d)); B.on('snap', (d) => snapsB.push(d));
   A.onPeerLeave((id) => log.push('A-leave ' + id)); A.onPeerJoin((id) => log.push('A-join ' + id));
   try {
   await sleep(400);
   for (let i = 0; i < 20; i++) { A.send('sync', { n: i }); B.send('sync', { m: i }); A.send('snap', { s: i }); await sleep(20); }
   await sleep(300);
   assert.equal(gotB.length, 20); assert.equal(gotA.length, 20);
   // B goes silent for longer than DEAD_MS (time moves in steps a tick does not take for a stall)
   br.blocked.add('B');
   for (let i = 0; i < 14; i++) { off += 900; await sleep(270); }
   assert.ok(log.includes('A-leave bbbb'), 'A dropped B: ' + log);
   br.blocked.delete('B');
   B.send('sync', { m: 'back' });
   await sleep(400);
   assert.ok(log.filter((x) => x === 'A-join bbbb').length >= 2, 'A heard B again: ' + log);
   A.send('sync', { n: 'after' }); A.send('snap', { s: 'after' });
   await sleep(600);
   assert.deepEqual(gotA.at(-1), { m: 'back' });
   assert.deepEqual(gotB.at(-1), { n: 'after' }, 'reliable frames of the revived link reach B');
   assert.deepEqual(snapsB.at(-1), { s: 'after' }, 'latest frames of the revived link reach B');
   // a page frozen for 15 s does not drop its peers for its own silence
   const t0 = real(); while (real() - t0 < 50) { /* busy */ }
   off += 15000; await sleep(600);
   assert.equal(log.filter((x) => x === 'A-leave bbbb').length, 1, 'no drop after an own stall: ' + log);
   } finally { A.leave(); B.leave(); }
});
