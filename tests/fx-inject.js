(() => { const g = window.__game, w = g.world, p = w.player, e = w.tanks[5];
 g.tcam.yaw = Math.atan2(-(e.pos.x - p.pos.x), -(e.pos.z - p.pos.z)) + 0.25; g.tcam.pitch = -0.12;
 w.events.seq = 0; p.lastFire = 1; p.burning = true; w.tanks[3].alive = false; w.tanks[3].burning = true;
 const mk = (type, t, extra={}) => w.events.push({ seq: ++w.events.seq, type, srcId: p.id, dstId: t.id, pos: { x: t.pos.x, y: t.pos.y + 1.5, z: t.pos.z }, normal: { x: 0, y: 0, z: 1 }, dmg: 220, effT: 142, ...extra });
 mk('pen', w.tanks[5]); mk('ricochet', w.tanks[6], { angleDeg: 74 }); mk('he', w.tanks[7]); mk('ammoRack', w.tanks[8]); mk('kill', w.tanks[8]);
 mk('crit', w.tanks[5], { module: 'engine' }); mk('noPen', w.tanks[9]);
 w.events.push({ seq: ++w.events.seq, type: 'pen', srcId: w.tanks[6].id, dstId: p.id, dmg: 160, pos: p.pos });
 w.shells.push({ pos: { x: p.pos.x + 30, y: p.pos.y + 3, z: p.pos.z - 20 }, vel: { x: -300, y: 0, z: -700 }, ammo: 'AP', alive: true });
 p.input.throttle = 1;
 return w.events.length; })()
