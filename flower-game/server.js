// ===== Flower Game server =====
// Runs the game world (flowers, petals, mobs, drops) and sends updates to every browser.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, 'config', f)));
const S = load('settings.json'), PETALS = load('petals.json'), MOBS = load('mobs.json');
const PUB = path.join(__dirname, 'public');
const MAP_W = S.map.zones.reduce((a, z) => a + z.width, 0), MAP_H = S.map.height;
const DT = 1 / S.tickRate, TAU = Math.PI * 2, KB_DECAY = 8;   // knockback fades like the original: x0.67 every 1/20 s
const RANK = { common: 0, unusual: 1, rare: 2, epic: 3, legendary: 4, unique: 5 };

// ---------- Web server: hands the game files to browsers ----------
const MIME = { '.woff2': 'font/woff2', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/gallery.json') {               // data for the title-screen Mobs / Petals tabs
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ petals: PETALS, mobs: MOBS }));
  }
  if (p === '/') p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// ---------- Helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const zoneBounds = {};
{ let x = 0; for (const z of S.map.zones) { zoneBounds[z.name] = [x, x + z.width]; x += z.width; } }
function zoneAt(x) {
  for (const z of S.map.zones) { const [a, b] = zoneBounds[z.name]; if (x < b) return z; }
  return S.map.zones[S.map.zones.length - 1];
}
// XP to go from level lvl to lvl+1: table measured from the original game (level 60 ~ 22.4k points)
const XPT = S.leveling.xpTable;
const xpForLevel = lvl => XPT[lvl - 1] ?? Math.round(XPT[XPT.length - 1] * Math.pow(1.075, lvl - XPT.length));   // past the table: +7.5% per level
function maxHpFor(lvl) {
  const f = S.flower, t = (Math.min(lvl, f.levelCap) - 1) / (f.levelCap - 1);
  return Math.round(f.baseHealth + (f.maxHealth - f.baseHealth) * t);
}
const slotCount = lvl => 5 + S.flower.extraSlotLevels.filter(l => lvl >= l).length;
let nextEntityId = 1;

// ---------- Petal slots ----------
// A slot holds one petal type; some types (Twin) have several sub-petals.
function makeSlot(type, startReloading = true) {
  const def = PETALS[type], subs = [];
  for (let i = 0; i < (def.count || 1); i++)
    subs.push({ uid: nextEntityId++, hp: def.health, alive: false, reload: startReloading ? def.reload : 0.3, x: 0, y: 0, rf: 1, rr: 1, aliveT: 0, off: undefined });
  return { type, subs };
}
function slotReady(s) {
  if (PETALS[s.type].noOrbit) return 1;          // Antennae is always 'ready'
  const r = PETALS[s.type].reload;
  return Math.min(...s.subs.map(q => q.alive ? 1 : Math.max(0, 1 - q.reload / (q.rmax || r))));
}
function breakSub(type, q) { q.alive = false; q.reload = q.rmax = PETALS[type].reload; q.rf = 1; }

// ---------- Players ----------
const players = new Map();

// Spawn zone comes from your level, like the original (levels 1-12 Easy, 13-27 Medium,
// 28-42 Hard, 43+ "?"), unless a custom start picked one.
function zoneForLevel(l) { const z = S.map.zones; return z[l <= 12 ? 0 : l <= 27 ? 1 : l <= 42 ? 2 : Math.min(3, z.length - 1)].name; }
// Unique petals: only one can exist on the whole server (in a loadout, a bench, a respawn kit or on the ground)
function uniqueTaken(type, except) {
  for (const o of players.values()) {
    if (o === except) continue;
    if ((o.petals || []).some(s => s && s.type === type) || (o.bench || []).includes(type) || (o.dead && (o.keep || []).includes(type))) return true;
  }
  for (const d of drops.values()) if (d.type === type) return true;
  return false;
}
function spawn(p, start) {
  const wasDead = p.dead && p.joined && p.everSpawned;
  const firstTime = !p.everSpawned;
  if (start) {                                            // custom start from the title-screen menu
    p.level = start.level; p.xp = 0;
  } else if (p.dead && p.joined && p.everSpawned) {       // after dying: 3/4 of your level, and what you kept
    p.level = p.respawnLevel || 1; p.xp = 0;
  }
  const zone = (start && start.zone) || zoneForLevel(p.level);
  const [zx0, zx1] = zoneBounds[zone];
  // Pick a spot that isn't on top of (or right next to) any mob: try random spots and keep the
  // first one that's clear; if the zone is packed, use the roomiest one found
  let best = null, bestGap = -Infinity;
  for (let tries = 0; tries < 80; tries++) {
    const x = rand(zx0 + 200, zx1 - 200), y = rand(200, MAP_H - 200);
    let gap = Infinity;
    for (const m of mobs.values()) {
      if (m.owner) continue;
      const g = Math.hypot(m.x - x, m.y - y) - m.r - S.flower.radius;
      if (g < gap) gap = g;
    }
    if (gap > bestGap) { bestGap = gap; best = { x, y }; }
    if (gap >= S.flower.spawnClearance) break;
  }
  p.x = best.x; p.y = best.y;
  p.vx = p.vy = p.kx = p.ky = 0; p.poison = null; p.slowUntil = 0;
  p.everSpawned = true;
  p.score = 0; for (let l = 1; l < p.level; l++) p.score += xpForLevel(l);   // points match the level you start at
  p.immuneUntil = gameNow() + S.flower.spawnImmunity;   // mobs ignore you for a moment after spawning
  p.maxHp = maxHpFor(p.level); p.hp = p.maxHp; p.dead = false;
  const n = slotCount(p.level);
  let load, rest;
  if (start) { load = start.petals.slice(0, n); rest = start.bench; }
  else { const keep = p.keep || []; load = keep.slice(0, n); rest = keep.slice(n); }   // kept petals go in the loadout
  const fresh = !start && wasDead;     // after a death empty slots stay empty (no Basics)
  p.petals = [];
  const filler = i => (!start && S.flower.startingPetals[i]) || 'basic';
  for (let i = 0; i < n; i++) p.petals.push(load[i] ? makeSlot(load[i], false) : fresh ? null : makeSlot(filler(i), false));
  p.bench = Array(S.flower.benchSlots).fill(null);
  rest.filter(Boolean).slice(0, p.bench.length).forEach((t, i) => p.bench[i] = t);
  // Unique petals: keep only one, and none if someone else already has it
  let uniq = {};
  p.petals.forEach((s, i) => { if (s && PETALS[s.type].rarity === 'unique' && (uniq[s.type] || uniqueTaken(s.type, p))) p.petals[i] = makeSlot('basic', false); else if (s && PETALS[s.type].rarity === 'unique') uniq[s.type] = 1; });
  p.bench.forEach((t, i) => { if (t && PETALS[t].rarity === 'unique' && (uniq[t] || uniqueTaken(t, p))) p.bench[i] = null; else if (t && PETALS[t].rarity === 'unique') uniq[t] = 1; });
  // 0.1% chance to start your very first life with the Unique Basic in your first slot
  if (firstTime && !start && PETALS.basicUnique && Math.random() < S.flower.uniqueBasicChance && !uniqueTaken('basicUnique', p) && p.petals.length)
    p.petals[0] = makeSlot('basicUnique', false);
  p.keep = [];
  // Every petal you have during this run, for the respawn top-up
  p.history = [...p.petals.filter(Boolean).map(s => s.type), ...p.bench.filter(Boolean)].filter(t => t !== 'basic');
}
function addXp(p, amount) {
  if (!amount) return;
  p.xp += amount; p.score += amount;
  while (p.xp >= xpForLevel(p.level)) {
    p.xp -= xpForLevel(p.level); p.level++;
    const old = p.maxHp; p.maxHp = maxHpFor(p.level); p.hp += p.maxHp - old;
    while (p.petals.length < slotCount(p.level)) {
      const bi = p.bench.findIndex(Boolean);
      if (bi >= 0) { p.petals.push(makeSlot(p.bench[bi])); p.bench[bi] = null; } else p.petals.push(null);
    }
  }
}
const heal = (p, amt) => { if (!p.dead && !((p.noHealUntil || 0) > gameNow())) p.hp = Math.min(p.maxHp, p.hp + amt); };

// Custom start picked on the title screen: level, zone and petals (checked here)
function readStart(st) {
  if (!st || typeof st !== 'object') return null;
  const level = clamp(Math.floor(+st.level) || 1, 1, 75);
  const zone = S.map.zones.some(z => z.name === st.zone) ? st.zone : zoneForLevel(level);
  const ok = t => (typeof t === 'string' && PETALS[t]) ? t : null;
  const petals = (Array.isArray(st.petals) ? st.petals : []).slice(0, 8).map(ok);
  const bench = (Array.isArray(st.bench) ? st.bench : []).slice(0, S.flower.benchSlots).map(ok);
  return { level, zone, petals, bench };
}
function killPlayer(p, byName) {
  p.dead = true; p.hp = 0;
  // Drop the best petals; the next best are kept for respawn
  const all = [];
  p.petals.forEach(s => { if (s && s.type !== 'basic') all.push(s.type); });
  p.bench.forEach(t => { if (t && t !== 'basic') all.push(t); });
  // Like the original: your best petals (ties broken randomly) fall on the ground,
  // each remaining one has a 10% chance to be lost, Basics are never kept,
  // and you come back at 3/4 of your level.
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  all.sort((a, b) => RANK[PETALS[b].rarity] - RANK[PETALS[a].rarity]);
  // Going down from the best: each petal has a 5% chance not to drop, and then the next one
  // drops instead. Any rare-or-better petal that drops has a 1% chance to turn into Pollen.
  const n = S.drops.deathDropCount, dropped = [], rest = [];
  for (const t of all) {
    if (dropped.length < n && Math.random() >= S.drops.deathSkipChance) dropped.push(t);
    else rest.push(t);
  }
  spawnDrops(dropped.map(t => RANK[PETALS[t].rarity] >= RANK.rare && PETALS.pollen && Math.random() < S.drops.pollenSwapChance ? 'pollen' : t), p.x, p.y);
  const kept = rest.filter(() => Math.random() >= S.drops.deathLoseChance);
  // Top up to 8 from everything you picked up this run (not counting what you still had,
  // dropped or lost just now): best rarity first, random within a rarity
  const max = S.drops.respawnPetals, used = {};
  for (const t of all) used[t] = (used[t] || 0) + 1;
  const pool = [];
  for (const t of p.history || []) { if (used[t] > 0) used[t]--; else pool.push(t); }
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  pool.sort((a, b) => RANK[PETALS[b].rarity] - RANK[PETALS[a].rarity]);
  p.keep = kept.slice(0, max);
  for (const t of pool) {
    if (p.keep.length >= max) break;
    if (PETALS[t].rarity === 'unique' && (p.keep.includes(t) || uniqueTaken(t, p))) continue;   // only one can exist
    p.keep.push(t);
  }
  p.respawnLevel = Math.max(1, Math.floor(p.level * 0.75));
  p.score = 0;
  send(p, { t: 'dead', by: byName, level: p.respawnLevel, keep: p.keep, slots: slotCount(p.respawnLevel) });
}

// ---------- Mobs ----------
const mobs = new Map();
// Some mobs only live in part of a zone, e.g. Worker Ants in the right half of Easy
function mobBounds(def, zoneName) {
  const [zx0, zx1] = zoneBounds[zoneName], fr = (def.zoneRange || {})[zoneName] || [0, 1];
  return [zx0 + (zx1 - zx0) * fr[0], zx0 + (zx1 - zx0) * fr[1]];
}
function spawnMob(type, zoneName, at, extraAll = {}) {
  const def = MOBS[type], [zx0, zx1] = zoneName ? mobBounds(def, zoneName) : [0, MAP_W];
  const pad = Math.min(60 + (def.radius || 20), (zx1 - zx0) / 3);
  let x, y, tries = 0;
  // Pick a spot away from players and not overlapping any other mob
  const r0 = (def.sizeRange ? def.sizeRange[1] : def.radius) || 20;
  do { x = rand(zx0 + pad, zx1 - pad); y = rand(pad, MAP_H - pad); tries++; }
  while (!at && tries < 40 && (
    [...players.values()].some(p => !p.dead && p.joined && dist2(p, { x, y }) < S.mobs.minSpawnDistance ** 2) ||
    !spotFree(x, y, r0)));
  if (at) { x = at.x; y = at.y; }
  const make = (px, py, extra = {}) => {
    let r = def.radius, hp = def.health;
    if (def.sizeRange) { const t = Math.random(); r = def.sizeRange[0] + t * (def.sizeRange[1] - def.sizeRange[0]); hp = Math.round(def.healthRange[0] + t * (def.healthRange[1] - def.healthRange[0])); }
    const m = { id: nextEntityId++, type, zone: zoneName, bx0: zx0, bx1: zx1, x: px, y: py, r, hp, maxHp: hp, kx: 0, ky: 0,
      stepT: rand(0, 2), slowUntil: 0, poison: null,
      angle: rand(0, TAU), heading: rand(0, TAU), phase: rand(0, TAU), lastHitBy: null, leader: null, chain: null, ...extraAll, ...extra };
    if (def.releases) {                          // Ant Hole: the ants it will let out as it takes damage
      // Like the original: Baby Ants come out while the hole is near full health, then a mix
      // of Worker and Soldier Ants, then only Soldier Ants
      const R = def.releases, shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
      const nB = R.babyAnt || 0, nW = R.workerAnt || 0, nS = R.soldierAnt || 0, nMix = Math.min(nW, nS);
      m.queue = [...Array(nB).fill('babyAnt'),
        ...shuffle([...Array(nW).fill('workerAnt'), ...Array(nMix).fill('soldierAnt')]),
        ...Array(nS - nMix).fill('soldierAnt')];
      m.released = 0; m.queenOut = false;
    }
    mobs.set(m.id, m); return m;
  };
  if (def.segments) {
    const chain = nextEntityId, dir = rand(0, TAU); let prev = null, head = null;
    // Now and then a "massive" one spawns: same segments, but 51 of them instead of 11
    const n = def.massive && !extraAll.owner && Math.random() < def.massive.chance ? def.massive.segments : def.segments;
    for (let i = 0; i < n; i++) {
      const m = make(x - Math.cos(dir) * i * def.radius * 1.8, y - Math.sin(dir) * i * def.radius * 1.8, { chain, head: i === 0 });
      m.angle = m.heading = dir;
      if (prev) m.leader = prev.id; else head = m;
      prev = m;
    }
    return head;
  }
  return make(x, y);
}
// True if a circle of radius r at (x, y) wouldn't overlap any existing mob
function spotFree(x, y, r) {
  for (const m of mobs.values()) { const g = m.r + r + 12; if ((m.x - x) ** 2 + (m.y - y) ** 2 < g * g) return false; }
  return true;
}
// Ant Hole lets ants out as its health drops; the Queen comes out at low health
// How easily a mob gets shoved: small mobs (ant-sized and below) take the full push,
// bigger ones less by their size squared - a Massive Ladybug barely moves
const heft = m => Math.min(1, (S.mobs.knockbackRefRadius / m.r) ** 2);
const ANTS = new Set(['babyAnt', 'workerAnt', 'soldierAnt', 'queenAnt']);
function antHoleRelease(h, attacker) {
  const def = MOBS[h.type], frac = 1 - Math.max(0, h.hp) / h.maxHp;
  const due = Math.min(h.queue.length, Math.floor(frac * h.queue.length + 0.0001));
  const tgt = attacker && attacker.ws ? attacker.id : null;
  const out = (type, extra = {}) => {
    const a = rand(0, TAU), d = rand(0, 4);              // out of the middle of the hole
    spawnMob(type, h.zone, { x: h.x + Math.cos(a) * d, y: h.y + Math.sin(a) * d }, { target: tgt, fromHole: true, ...extra });
  };
  while (h.released < due) {
    const t = h.queue[h.released++];
    if (t === 'babyAnt' && h.queenDead) continue;        // no more Baby Ants once its Queen is killed
    out(t);
  }
  if (!h.queenOut && h.hp <= def.queenAt) { h.queenOut = true; out('queenAnt', { home: h.id }); }
  // Nearby worker ants get angry when their hole is attacked
  if (tgt) for (const m of mobs.values()) if (m.type === 'workerAnt' && !m.owner && dist2(m, h) < 700 ** 2 && !lockedOnOther(m, attacker)) m.target = tgt;
}
const chanceFor = (def, zone) => typeof def.spawnChance === 'object' ? (def.spawnChance[zone] ?? S.mobs.refillChance) : (def.spawnChance ?? S.mobs.refillChance);
// Each mob has a [min, max] count per zone. Below min it refills right away;
// between min and max it trickles back in, so a zone always looks full.
// Common mobs aim for a count picked at random in [min, max] (re-picked every few
// minutes), like the original's population, instead of creeping up to the max.
// Rare mobs (with their own spawnChance) can still trickle up to the max.
const popTarget = {};
function populate() {
  if (paused) return;
  const now = gameNow();
  for (const [type, def] of Object.entries(MOBS)) for (const [zone, range] of Object.entries(def.zones || {})) {
    if (!zoneBounds[zone]) continue;
    const [min, max] = Array.isArray(range) ? range : [range, range];
    const key = type + '|' + zone;
    if (!popTarget[key] || popTarget[key].until < now)
      popTarget[key] = { n: min + Math.floor(Math.random() * (max - min + 1)), until: now + rand(150, 300) };
    const goal = def.spawnChance !== undefined ? max : popTarget[key].n;
    // Centipedes count by living heads; cut-off pieces and ants let out of a hole don't count
    const have = [...mobs.values()].filter(m => m.type === type && m.zone === zone && !m.owner && !m.fromHole && (!def.segments || m.head)).length;
    if (def.globalMax !== undefined && [...mobs.values()].filter(m => m.type === type && !m.owner).length >= def.globalMax) continue;
    for (let i = have; i < min; i++) spawnMob(type, zone);
    if (have >= min && have < goal && Math.random() < chanceFor(def, zone)) spawnMob(type, zone);
  }
  // Cut-off centipede pieces nobody is near fade away after a while so they don't pile up
  for (const m of mobs.values()) if (m.chain && !m.head && !m.lead && !m.leader && !m.target) {
    m.cutT = m.cutT || now;
    const seen = [...players.values()].some(p => p.joined && !p.dead && Math.abs(p.x - m.x) < S.view.halfWidth && Math.abs(p.y - m.y) < S.view.halfHeight);
    if (seen) m.cutT = now;
    else if (now - m.cutT > S.mobs.pieceDespawn) {                    // the piece and the segments trailing it go together
      const gone = new Set([m.id]); let grew = true;
      while (grew) { grew = false; for (const f of mobs.values()) if (f.leader && gone.has(f.leader) && !gone.has(f.id)) { gone.add(f.id); grew = true; } }
      for (const id of gone) mobs.delete(id);
    }
  }
  // Old hit-cooldown records are no longer needed
  for (const k in pairHits) if (pairHits[k] < now) delete pairHits[k];
}
function killMob(m) {
  mobs.delete(m.id);
  if (m.owner) return;                         // pets give nothing when they die
  const md = MOBS[m.type];
  if (m.home && mobs.has(m.home)) mobs.get(m.home).queenDead = true;   // Queen Ant: her hole stops sending Baby Ants
  if (md.segments && md.aggroRange) {
    // Aggressive centipedes: the body behind the one that died keeps hunting (no new head grows)
    for (const f of mobs.values()) if (f.leader === m.id) {
      f.leader = null; f.lead = true; f.target = m.target || m.lastHitBy || null;
      f.cv = m.cv || 0; f.angle = m.angle;            // carry on at the same speed and heading
    }
  }
  const def = MOBS[m.type], killer = players.get(m.lastHitBy);
  if (killer && !killer.dead) addXp(killer, Math.round(def.xp * S.leveling.xpMultiplier));
  // A Unique petal (Square) doesn't drop if one already exists somewhere on the server
  const got = Object.entries(def.drops || {}).filter(([type, chance]) => PETALS[type] && Math.random() < chance &&
    !(PETALS[type].rarity === 'unique' && uniqueTaken(type, null))).map(([t]) => t);
  spawnDrops(got, m.x, m.y);
}

// ---------- Drops on the ground ----------
// Several drops fan out evenly in a ring from where the mob died, and never
// land on top of each other or on drops already lying there.
const drops = new Map();
const DROP_GAP = 44;
function spawnDrops(types, x, y) {
  const n = types.length; if (!n) return;
  const R = n === 1 ? 0 : Math.max(DROP_GAP / (2 * Math.sin(Math.PI / n)), 26), a0 = rand(0, TAU);
  types.forEach((type, i) => {
    const a = a0 + (i / n) * TAU;
    let px = x + Math.cos(a) * R, py = y + Math.sin(a) * R;
    for (let k = 0; k < 10; k++) {
      const hit = [...drops.values()].find(d => (d.x - px) ** 2 + (d.y - py) ** 2 < (DROP_GAP - 2) ** 2);
      if (!hit) break;
      const ang = Math.atan2(py - hit.y, px - hit.x) || a;
      px = hit.x + Math.cos(ang) * DROP_GAP; py = hit.y + Math.sin(ang) * DROP_GAP;
    }
    const id = nextEntityId++;
    drops.set(id, { id, type, x: clamp(px, 20, MAP_W - 20), y: clamp(py, 20, MAP_H - 20), ox: Math.round(x), oy: Math.round(y),
      expires: gameNow() + (S.drops.despawn[PETALS[type].rarity] || 30) });
  });
}

// ---------- Damage ----------
// True if the mob is already chasing a different flower that's alive and still in range
function lockedOnOther(m, attacker) {
  const cur = m.target && players.get(m.target), def = MOBS[m.type];
  if (!cur || cur === attacker || cur.dead) return false;
  const giveUp = m.cursed ? (cur.viewW || S.view.halfWidth) * 1.3 : def.aggroRange ? def.aggroRange * S.mobs.deaggroFactor : S.mobs.onHitGiveUp;
  return dist2(cur, m) < giveUp ** 2;
}
let tickNo = 0;
// Pause: any player can freeze the whole world for everyone. The game clock stops too, so
// drops, webs, spawn protection and other timers don't run out while paused.
let paused = null, pausedMs = 0;
const gameNow = () => ((paused ? paused.since : Date.now()) - pausedMs) / 1000;
function setPaused(on, by) {
  if (on && !paused) paused = { since: Date.now(), by };
  else if (!on && paused) { pausedMs += Date.now() - paused.since; paused = null; }
  else return;
  for (const o of players.values()) send(o, { t: 'pause', on: !!paused, by });
}                                  // counts game ticks (used for hit flashes)
// Body damage against other flowers: none until level 9, then it builds up to the full 25
// (the sheet doesn't know when it's full; here it's at level 14). Against mobs it's always 25.
function flowerBodyDamage(p) {
  const [l0, l1] = S.flower.pvpBodyDamageLevels;
  return S.flower.bodyDamage * clamp((p.level - l0) / (l1 - l0), 0, 1);
}
function hurt(target, amount, attacker, isMob, noReflect = false, quiet = false) {
  if (amount <= 0) return;
  if (!quiet) target.fl = tickNo;                // the client flashes it red this tick
  if (isMob) {
    if (!mobs.has(target.id)) return;
    const def = MOBS[target.type];
    target.hp -= amount;
    if (attacker && attacker.ws && !target.owner) {
      target.lastHitBy = attacker.id;
      // Worker Ants / Yellow Ladybugs fight back when hit; aggressive mobs too
      if (def.aggro === 'onHit' || def.aggroRange) {
        // A centipede segment still attached to the one in front of it doesn't break off:
        // the front of its chain turns on you and the rest keeps following
        let front = target, guard = 0;
        while (front.leader && mobs.has(front.leader) && guard++ < 50) front = mobs.get(front.leader);
        // Already after someone else (who's still alive and in range)? It stays on them.
        if (!lockedOnOther(front, attacker)) front.target = attacker.id;
      }
    }
    if (target.queue) antHoleRelease(target, attacker);
    if (target.hp <= 0) killMob(target);
    return;
  }
  if (target.dead) return;
  // Salt: a flower hurting you takes part of that damage back (doesn't bounce back and forth)
  if (!noReflect && target.salt && attacker && attacker.ws && attacker !== target) hurt(attacker, amount * target.salt, target, false, true);
  target.hp -= amount;
  if (target.hp <= 0) {
    if (attacker && attacker.ws && attacker !== target) {
      addXp(attacker, Math.round(target.score / 2));        // you get half of their points
    }
    killPlayer(target, attacker ? (attacker.ws ? attacker.name : MOBS[attacker.type].name) : null);
  }
}

// ---------- Petal side effects ----------
// Honey slows whatever it hits; poison petals deal damage over time.
function hitFx(def, target, attacker, now) {
  if (def.slow) {
    // On flowers the slow stacks: 1 honey = half speed, 2 = a third, 3 = a quarter
    if (target.ws) target.slowN = Math.min(3, ((target.slowUntil || 0) > now ? (target.slowN || 1) : 0) + 1);
    target.slowUntil = now + def.slow;
  }
  if (def.poison) applyPoison(target, def.poison[0], def.poison[1], attacker);
}
// Like the original: all poison does a steady 9 damage a second until its total is used up
// (Iris 60 = about 6.7 s). A new poison replaces whatever was left of the old one.
function applyPoison(target, total, _seconds, by) {
  if (!(total > 0)) return;
  target.poison = { left: total, by };
}
function tickPoison(t, isMob) {
  const ps = t.poison; if (!ps) return;
  const dmg = Math.min(ps.left, S.poisonPerSecond * DT);
  ps.left -= dmg;
  // It only flashes red once a second, even though the damage is constant
  ps.ft = (ps.ft ?? 0) - DT; const loud = ps.ft <= 0; if (loud) ps.ft += 1;
  if (ps.left <= 1e-6) t.poison = null;
  hurt(t, dmg, ps.by, isMob, false, !loud);
}

// ---------- Spatial grid ----------
// With hundreds of mobs, checking every pair each tick is too slow. Mobs are
// sorted into map squares so we only compare things that are near each other.
const GRID = 250;
let grid = new Map();
function buildGrid() {
  grid = new Map();
  for (const m of mobs.values()) {
    const x0 = Math.floor((m.x - m.r) / GRID), x1 = Math.floor((m.x + m.r) / GRID);
    const y0 = Math.floor((m.y - m.r) / GRID), y1 = Math.floor((m.y + m.r) / GRID);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const k = gx * 4096 + gy; let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(m);
    }
  }
}
function nearMobs(x, y, r) {
  const out = [], seen = new Set();
  const x0 = Math.floor((x - r) / GRID), x1 = Math.floor((x + r) / GRID), y0 = Math.floor((y - r) / GRID), y1 = Math.floor((y + r) / GRID);
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
    const c = grid.get(gx * 4096 + gy); if (!c) continue;
    for (const m of c) if (!seen.has(m.id) && mobs.has(m.id)) { seen.add(m.id); out.push(m); }
  }
  return out;
}

// ---------- Projectiles (Peas, Missile) ----------
const projectiles = new Map();
function spawnProjectile(o) { const id = nextEntityId++; projectiles.set(id, { id, ...o }); }
function tickProjectiles(live, now) {
  for (const s of projectiles.values()) {
    s.life -= DT;
    if (s.vt) {                                   // Hornet missile: launched fast, settles to cruise speed
      const sp = Math.hypot(s.vx, s.vy) || 1, ns = s.vt + (sp - s.vt) * Math.exp(-8 * DT);
      s.vx *= ns / sp; s.vy *= ns / sp;
    }
    if (s.glide) { const g = Math.exp(-s.glide * DT); s.vx *= g; s.vy *= g; }   // Pollen slides to a stop
    if (s.left !== undefined) {                   // aimed shot (Triple Web): lands exactly on its spot
      const step = Math.hypot(s.vx, s.vy) * DT;
      if (s.left <= step) { s.x = s.tx; s.y = s.ty; landWeb(s, now); projectiles.delete(s.id); continue; }
      s.left -= step;
    }
    s.x += s.vx * DT; s.y += s.vy * DT;
    if (s.life <= 0 || s.x < 0 || s.y < 0 || s.x > MAP_W || s.y > MAP_H) { landWeb(s, now); projectiles.delete(s.id); continue; }
    if (s.fromMob) { tickMobShot(s, live); continue; }
    const owner = players.get(s.owner), def = PETALS[s.type];
    let hit = null, isMob = false;
    for (const m of nearMobs(s.x, s.y, s.r)) if (!(m.owner === s.owner) && dist2(s, m) < (s.r + m.r) ** 2) { hit = m; isMob = true; break; }
    if (!hit) for (const p of live) if (p.id !== s.owner && !p.dead && dist2(s, p) < (s.r + S.flower.radius) ** 2) { hit = p; break; }
    if (!hit) continue;
    hitFx({ ...def, poison: s.poison }, hit, owner, now);   // a shot carries its own poison (each pea's)
    if (def.noHeal && !isMob) hit.noHealUntil = now + def.noHeal;      // Dandelion
    hurt(hit, s.dmg, owner, isMob);
    if (def.web) { landWeb(s, now); projectiles.delete(s.id); continue; }
    s.hp -= isMob ? MOBS[hit.type].damage : S.flower.bodyDamage;
    if (s.hp <= 0) projectiles.delete(s.id);
    else if (!s.glide) { s.vx *= 0.6; s.vy *= 0.6; }
  }
}

// ---------- Webs ----------
// A shot Web lands as a sticky patch for 10s. Anything inside (except Spiders and
// the flower that made it) moves at a quarter speed. Each Web petal keeps 3 at most.
const webs = new Map();
function landWeb(s, now) {
  const def = PETALS[s.type]; if (!def || !def.web || s.landed) return;
  s.landed = true;
  const w = { id: nextEntityId++, x: s.x, y: s.y, r: def.web.radius, until: now + def.web.life, slow: def.web.slow, owner: s.owner };
  webs.set(w.id, w);
  if (s.src) { s.src.webs = (s.src.webs || []).filter(id => webs.has(id)); s.src.webs.push(w.id);
    while (s.src.webs.length > def.web.max) webs.delete(s.src.webs.shift()); }
}
function webSlow(e, isMob) {
  if (isMob && MOBS[e.type].webImmune) return 1;
  // Overlapping webs multiply: 1 web = -75%, 2 webs = -93.75%
  let f = 1;
  for (const w of webs.values()) if (w.owner !== e.id && (e.x - w.x) ** 2 + (e.y - w.y) ** 2 < w.r * w.r) f *= w.slow;
  return f;
}

// Chasing mobs build up to their top speed
const topSpeed = def => def.accel ? def.accel * 50 / (1 - S.mobs.chaseKeep) : (def.chaseSpeed || S.mobs.curseChaseSpeed);
function chaseVel(m, def) {
  // Like the original (and the stat sheet's "Acceleration" column): every tick the mob keeps
  // 60% of its speed and adds its acceleration (in units, 1 unit = 50 px). So it tops out at
  // acceleration / 0.4: 2.4 -> 6 units/s (300 px/s), Spider 2.88 -> 7.2 units/s (360 px/s).
  // Mobs that normally never chase use the curse speed.
  const keep = S.mobs.chaseKeep, f = keep ** (DT / 0.04);
  const top = topSpeed(def);
  m.cv = (m.cv || 0) * f + top * (1 - f);
  return m.cv;
}
// Walking burst measured from the original (speed as a fraction of peak, 20 samples/s),
// followed by a short rest
const STEP_SHAPE = [1,2,3,4,6,8,11,15,19,24,30,36,43,50,57,65,72,80,88,95,101,107,112,116,119,121,122,121,120,117,113,109,103,97,90,83,75,68,60,53,45,39,32,27,22,17,14,10,8,6,4,3,2,1,1].map(v => v / 122);
const STEP_CYCLE = (STEP_SHAPE.length + 9) / 20;
function stepProfile(t) {
  const i = t * 20, k = Math.floor(i);
  if (k >= STEP_SHAPE.length - 1) return 0;
  return STEP_SHAPE[k] + (STEP_SHAPE[k + 1] - STEP_SHAPE[k]) * (i - k);
}
// ---------- Hornet missiles ----------
// Fired at flowers; they hurt flowers and can be blocked (and broken) by petals.
function tickMobShot(s, live) {
  for (const p of live) {
    if (p.dead) continue;
    for (const [type, q] of p.ring) {
      if (!q.alive) continue;
      const pd = PETALS[type];
      if (dist2(s, q) < (s.r + pd.radius) ** 2) {
        q.hp -= s.dmg; if (q.hp <= 0) breakSub(type, q);
        s.hp -= pd.damage;
        if (s.hp <= 0) { projectiles.delete(s.id); return; }
      }
    }
    if (dist2(s, p) < (s.r + S.flower.radius) ** 2) {
      hurt(p, s.dmg, mobs.get(s.fromMob) || { type: s.mobType }, false);
      projectiles.delete(s.id); return;
    }
  }
}
function hornetAct(m, def, target, now) {
  // Like the original: once it has spotted you it slowly circles (50 px/s, side-on),
  // turns to face you and fires every 2 s (some shots lead your movement, some don't).
  // Each shot kicks the Hornet backwards.
  // If you get far enough away (about 30% of a screen) it flies after you, a bit slower
  // than a Beetle, until you're out of its range.
  const sh = def.shooter, d = Math.sqrt(dist2(m, target)) || 1;
  const a = Math.atan2(target.y - m.y, target.x - m.x);
  const mul = webSlow(m, true) * (m.slowUntil > now ? 0.5 : 1);
  m.strafe = m.strafe || (Math.random() < 0.5 ? 1 : -1);
  if (d > sh.followAt) { m.hv = (m.hv || 0) + (sh.followSpeed - (m.hv || 0)) * (1 - Math.exp(-4 * DT)); }
  else m.hv = (m.hv || 0) * Math.exp(-4 * DT);
  m.x += (Math.cos(a + m.strafe * Math.PI / 2) * sh.strafe + Math.cos(a) * m.hv) * mul * DT;
  m.y += (Math.sin(a + m.strafe * Math.PI / 2) * sh.strafe + Math.sin(a) * m.hv) * mul * DT;
  m.angle += angDiff(m.angle, a) * Math.min(1, sh.turnRate * DT); m.heading = m.angle;
  m.shotT = (m.shotT ?? 0) - DT;
  if (m.shotT <= 0 && Math.abs(angDiff(m.angle, a)) < 0.25) {   // fires once it is facing you
    m.shotT = sh.every;
    const nose = m.r * 1.3;
    // Some shots go straight at where you are; others aim ahead of where you're moving
    let fa = m.angle;
    if (Math.random() < (sh.leadChance ?? 0.5)) {
      const tt = d / ((sh.launch + sh.speed) / 2);            // rough flight time to you
      fa = Math.atan2(target.y + (target.vy || 0) * tt - m.y, target.x + (target.vx || 0) * tt - m.x);
    }
    spawnProjectile({ type: 'hornetMissile', fromMob: m.id, mobType: m.type, x: m.x + Math.cos(fa) * nose, y: m.y + Math.sin(fa) * nose,
      vx: Math.cos(fa) * sh.launch, vy: Math.sin(fa) * sh.launch, vt: sh.speed, r: 11.7, dmg: sh.damage, hp: sh.health, life: sh.life });
    m.kx -= Math.cos(fa) * sh.recoil; m.ky -= Math.sin(fa) * sh.recoil;
  }
}

// ---------- Pets (from Eggs) ----------
// A pet follows its flower and attacks nearby mobs and other flowers,
// but never wanders too far from its owner.
function movePet(m, def) {
  const owner = players.get(m.owner);
  if (!owner || owner.dead || !owner.ring.some(([, q]) => q.petId === m.id)) { mobs.delete(m.id); return; }
  // A pet hunts anything within its range of its owner (the Legendary Egg's Beetle looks
  // much further out) and comes back if it strays too far
  const range = m.petRange || 380;
  // Flowers come first: it only goes for a mob when no other flower is in range
  let tgt = null, bd = range ** 2;
  if (dist2(m, owner) < (range + 170) ** 2) {
    for (const p of players.values()) {
      if (p === owner || p.dead || !p.joined) continue;
      const d = dist2(p, owner); if (d < bd) { bd = d; tgt = p; }
    }
    if (!tgt) for (const w of nearMobs(owner.x, owner.y, range)) {
      if (w.owner) continue;
      const d = dist2(w, owner); if (d < bd) { bd = d; tgt = w; }
    }
  }
  const goal = tgt || owner, d = Math.sqrt(dist2(m, goal)) || 1;
  const spd = tgt ? topSpeed(def) : (d > 110 ? Math.min(S.flower.speed * 1.1, d * 2) : 0);
  const a = Math.atan2(goal.y - m.y, goal.x - m.x);
  m.angle += angDiff(m.angle, a) * Math.min(1, 8 * DT);
  m.x = clamp(m.x + Math.cos(a) * spd * DT + m.kx * DT, m.r, MAP_W - m.r);
  m.y = clamp(m.y + Math.sin(a) * spd * DT + m.ky * DT, m.r, MAP_H - m.r);
  const kd = Math.exp(-KB_DECAY * DT); m.kx *= kd; m.ky *= kd;
}
function petFights(now) {
  for (const m of [...mobs.values()]) {
    if (!m.owner || !mobs.has(m.id)) continue;
    const owner = players.get(m.owner), def = MOBS[m.type];
    for (const w of nearMobs(m.x, m.y, m.r)) {
      if (w.owner || !mobs.has(m.id) || dist2(w, m) > (w.r + m.r) ** 2) continue;
      if (pairReady(`pet${m.id}_${w.id}`, now, 0.4)) { hurt(w, def.damage, owner, true); hurt(m, MOBS[w.type].damage, null, true); }
    }
    for (const p of players.values()) {
      if (p === owner || p.dead || !p.joined || !mobs.has(m.id) || dist2(p, m) > (S.flower.radius + m.r) ** 2) continue;
      if (pairReady(`petf${m.id}_${p.id}`, now, 0.4)) { hurt(p, def.damage, owner, false); hurt(m, S.flower.bodyDamage, null, true); }
    }
  }
}
// Epic Cactus: anything your flower body touches gets poisoned
function toxicTouch(p, target) {
  if (p.toxic) applyPoison(target, p.toxic[0], p.toxic[1], p);
}

// ---------- Game loop ----------
const pairHits = {};
function pairReady(key, now, cd) { if ((pairHits[key] || 0) > now) return false; pairHits[key] = now + cd; return true; }

function tick() {
  tickNo++;
  // Paused: nothing moves; everyone still gets the (frozen) picture a few times a second
  if (paused) { if (tickNo % 5 === 0) sendState(gameNow()); return; }
  const now = gameNow();
  const P = S.petals, F = S.flower;
  const live = [...players.values()].filter(p => p.joined && !p.dead);

  // --- Flowers + their petals ---
  for (const p of live) {
    p.slowed = (p.slowUntil || 0) > now;                    // Honey: slower movement + slower petals (stacks)
    p.honeyF = p.slowed ? 1 / (1 + (p.slowN || 1)) : 1;
    const spdF = F.speed * p.honeyF * webSlow(p, false);
    const tvx = Math.cos(p.input.angle) * spdF * p.input.mag, tvy = Math.sin(p.input.angle) * spdF * p.input.mag;
    const k = Math.min(1, F.acceleration * DT), kd = Math.exp(-KB_DECAY * DT);
    p.vx += (tvx - p.vx) * k; p.vy += (tvy - p.vy) * k;
    p.x = clamp(p.x + (p.vx + p.kx) * DT, F.radius, MAP_W - F.radius);
    p.y = clamp(p.y + (p.vy + p.ky) * DT, F.radius, MAP_H - F.radius);
    p.kx *= kd; p.ky *= kd;

    const z = zoneAt(p.x);
    p.overleveled = z.maxLevel !== null && p.level >= z.maxLevel;
    // Overleveled: petals keep working until the countdown finishes, then they disappear
    p.olT = p.overleveled ? (p.olT || 0) + DT : 0;
    const olGone = p.overleveled && p.olT >= F.overlevelGrace;

    const target = p.input.attack ? P.attackRadius : p.input.defend ? P.defendRadius : P.orbitRadius;
    p.petalRadius += (target - p.petalRadius) * Math.min(1, P.radiusSpeed * DT);
    // Ring spots: most petals get one each; "cluster" petals (Rare Rose, Legendary Stinger,
    // Cactus, Web) share one spot as a little triangle, but each one still hits and breaks on its own
    const ring = []; let groups = 0;
    p.petals.forEach(s => {
      if (!s || PETALS[s.type].noOrbit) return;
      const cl = PETALS[s.type].cluster;
      s.subs.forEach((q, k) => { q.gi = cl ? groups : groups++; q.ck = cl ? k : -1; ring.push([s.type, q]); });
      if (cl) groups++;
    });
    p.vision = Math.max(1, ...p.petals.filter(Boolean).map(s => PETALS[s.type].vision || 1));
    // Passive effects from equipped petals
    let spinBonus = 0, hpBonus = 0; p.salt = 0; p.toxic = null;
    for (const [type, q] of ring) {
      const d = PETALS[type];
      if (d.hpBonus && !p.overleveled) hpBonus += d.hpBonus;      // Cactus: more max health (even reloading, not when overleveled)
      if (d.healPerSec && !olGone) heal(p, d.healPerSec * DT);   // Leaf: heals even while reloading
      if (!q.alive) continue;
      if (d.spinBonus) spinBonus += d.spinBonus;                  // Faster: petals spin faster
      if (d.reflect) p.salt = d.reflect;                          // Salt (doesn't stack)
      if (d.toxic) p.toxic = d.toxic;                             // Epic Cactus: poisonous body
    }
    p.maxHp = maxHpFor(p.level) + Math.round(hpBonus);
    if (p.hp > p.maxHp) p.hp = p.maxHp;
    // Yin Yang: 1 reverses the spin, 2 stop it completely; an odd number spins backwards,
    // an even number stops it, and all 8 make it spin forwards much faster
    const yy = p.petals.filter(s => s && PETALS[s.type].reverse).length;
    const yyF = yy === 0 ? 1 : yy >= 8 ? P.yinYangAllSpeed : yy % 2 ? -1 : 0;
    p.spin = (P.spinSpeed + spinBonus) / P.spinSpeed * p.honeyF * yyF;
    p.petalAngle = (p.petalAngle + P.spinSpeed * p.spin * DT) % TAU;
    ring.forEach(([type, q], i) => {
      const def = PETALS[type];
      // Each petal glides to its spot when the ring size changes (no snapping)
      const want = (q.gi / groups) * TAU;
      q.off = q.off === undefined ? want : (q.off + angDiff(q.off, want) * Math.min(1, 8 * DT) + TAU) % TAU;
      // Overleveled too long: every petal dies and stays dead (slot shaded). Once you're in the
      // right zone again they reload in 2.5 s (or their own reload time if that's quicker).
      if (olGone) { q.alive = false; q.petId = null; q.reload = q.rmax = Math.min(2.5, def.reload); return; }
      if (!q.alive) {
        if (q.petId) {                                         // Egg: waits while its pet is alive
          if (mobs.has(q.petId)) return;
          q.petId = null; q.reload = q.rmax = def.reload;
        }
        q.reload -= DT;
        // Respawn at the flower's center and grow back out to the ring. (Before, a petal came
        // back at the spot where it broke for one tick, landing a "phantom" hit on that mob.)
        if (q.reload <= 0) { q.alive = true; q.hp = def.health; q.rf = 0.15; q.aliveT = 0; q.x = p.x; q.y = p.y; q.held = !!(p.input.attack || p.input.defend); }
        return;
      }
      q.aliveT += DT;
      // (Dandelion's no-heal also stops roses being absorbed)
      if (def.heal && p.hp < p.maxHp && q.aliveT > (def.healDelay || 1) && !((p.noHealUntil || 0) > now)) {
        q.rf -= DT * 2.2;                                      // Rose flies into the flower
        if (q.rf <= 0.05) { heal(p, def.heal); breakSub(type, q); return; }
      } else q.rf = Math.min(1, q.rf + DT * 3);
      // Roses never extend on attack: they stay at the normal orbit distance
      let base = def.noExtend ? Math.min(p.petalRadius, P.orbitRadius) : p.petalRadius;
      // Wing: swings out and back like a boomerang while attacking
      if (def.wing && p.input.attack) base *= 1 + 0.6 * (0.5 - 0.5 * Math.cos(now * 5 + q.uid));
      q.rr = (base / p.petalRadius) * q.rf;
      const a = p.petalAngle + q.off;
      q.x = p.x + Math.cos(a) * base * q.rf;
      q.y = p.y + Math.sin(a) * base * q.rf;
      if (q.ck >= 0) { const ca = a + q.ck * TAU / 3, cr = def.radius * 1.15 * q.rf; q.x += Math.cos(ca) * cr; q.y += Math.sin(ca) * cr; }
      // Bubble: holding defend pops it and launches your flower away from it
      if (def.bubble && p.input.defend && q.aliveT > 0.3) {
        const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
        const boost = def.boost || 2600;
        p.kx += (p.x - q.x) / d * boost; p.ky += (p.y - q.y) / d * boost;   // several bubbles add up
        breakSub(type, q); return;
      }
      // Pollen: drops on the ground and sits there 5 s hurting whatever walks into it, and the
      // slot reloads. Attack throws the loaded pollen far out; defend drops it clumped up where it
      // is. If you're already holding the button when it reloads, it waits 0.5 s before dropping.
      if (def.drop) {
        if (!p.input.attack && !p.input.defend) q.held = false;
        if ((p.input.attack || p.input.defend) && q.aliveT > (q.held ? 0.5 : 0.15)) {
          const slot = p.petals.find(s => s && s.subs.includes(q));
          const subs = slot ? slot.subs.filter(u => u.alive && u.aliveT > 0.15) : [q];
          const far = p.input.attack;
          const w = P.spinSpeed * p.spin, gx = -Math.sin(a) * w * base + (p.vx || 0), gy = Math.cos(a) * w * base + (p.vy || 0);
          subs.forEach((u, k) => {
            let x, y, vx, vy;
            if (far) {                                         // thrown outward from the flower, each its own way
              const ua = Math.atan2(u.y - p.y, u.x - p.x);
              x = u.x; y = u.y; vx = Math.cos(ua) * def.drop.throwSpeed + (p.vx || 0); vy = Math.sin(ua) * def.drop.throwSpeed + (p.vy || 0);
            } else {                                           // a little clump right here
              const ca = k / subs.length * TAU + a, cr = def.radius * 0.75;
              x = q.x + Math.cos(ca) * cr; y = q.y + Math.sin(ca) * cr; vx = gx; vy = gy;
            }
            spawnProjectile({ type, owner: p.id, src: u, x, y, vx, vy, glide: 6,
              r: def.radius, dmg: def.damage, hp: def.health, life: def.drop.life, poison: def.poison });
            breakSub(type, u);
          });
          return;
        }
      }
      // Peas / Missile: holding attack fires them. A missile flies straight out; Peas split into
      // 4 - the first at a random angle, the others at right angles to it. Each pea carries its own
      // poison (shoot.poison); the petal's own poison is for hits before it splits.
      if (def.shoot && p.input.attack && q.aliveT > (def.shoot.delay ?? 0.5)) {
        const sh = def.shoot;
        // Triple Web: all three fire together from the same spot and land side by side in a
        // short arc, each web overlapping the next by about 20%
        if (def.cluster && def.web) {
          const slot = p.petals.find(s => s && s.subs.includes(q));
          const subs = (slot ? slot.subs : [q]).filter(u => u.alive && u.aliveT > (sh.delay ?? 0.5));
          const ox = p.x + Math.cos(a) * base * q.rf, oy = p.y + Math.sin(a) * base * q.rf;
          const R = base * q.rf + sh.speed * sh.life;                       // how far out they land
          const gap = 2 * def.web.radius * (1 - def.web.overlap);           // centre-to-centre distance
          const step = 2 * Math.asin(Math.min(1, gap / 2 / R));
          subs.forEach((u, k) => {
            const ang = a + (k - (subs.length - 1) / 2) * step;
            // aim from the shooting spot so the webs land on the arc around the flower
            const tx = p.x + Math.cos(ang) * R, ty = p.y + Math.sin(ang) * R, d = Math.hypot(tx - ox, ty - oy) || 1;
            const sp = d / sh.life;
            spawnProjectile({ type, owner: p.id, src: u, x: ox, y: oy, vx: (tx - ox) / d * sp, vy: (ty - oy) / d * sp,
              r: def.radius * 0.9, dmg: def.damage, hp: sh.health, life: sh.life + 1, poison: null, tx, ty, left: d });
            breakSub(type, u);
          });
          return;
        }
        const base0 = sh.single ? a : rand(0, TAU);
        for (let k = 0; k < sh.count; k++) {
          const ang = base0 + k * TAU / sh.count;
          spawnProjectile({ type, owner: p.id, src: q, x: q.x, y: q.y, vx: Math.cos(ang) * sh.speed, vy: Math.sin(ang) * sh.speed,
            r: def.radius * (sh.single ? 0.9 : 0.7), dmg: def.damage, hp: sh.health, life: sh.life, poison: sh.poison || (sh.single ? def.poison : null) });
        }
        breakSub(type, q); return;
      }
      // Egg: hatches into a pet that fights for you; the egg reloads once the pet dies
      if (def.pet && q.aliveT > (def.hatch || 1) && MOBS[def.pet]) {
        const pet = spawnMob(def.pet, null, { x: q.x, y: q.y }, { owner: p.id, petRange: def.petRange || 380 });
        q.petId = pet.id; q.alive = false; return;
      }
    });
    p.ring = ring;
  }

  // --- Mobs move ---
  for (const m of mobs.values()) {
    const def = MOBS[m.type];
    if (def.stationary) continue;
    const leader = m.leader && mobs.get(m.leader);
    if (m.leader && !leader) m.leader = null;
    if (m.owner) { movePet(m, def); continue; }
    if (!m.target) { m.cv = 0; m.hv = 0; }                  // not chasing: next chase starts from a standstill
    // Aggressive mobs (Beetle, Soldier Ant, Evil Centipede head...) notice flowers in range
    if (def.aggroRange && !m.target && (!m.chain || m.head || m.lead)) {
      let best = null, bd = def.aggroRange ** 2;
      for (const p of live) { if ((p.immuneUntil || 0) > now) continue; const d = dist2(p, m); if (d < bd) { bd = d; best = p; } }
      if (best) m.target = best.id;
    }
    // The curse: from level 60, every mob that can see you on your screen comes after you
    if (!m.target && !m.leader) {
      for (const p of live) {
        if (p.level < S.flower.curseLevel || (p.immuneUntil || 0) > now) continue;
        if (Math.abs(p.x - m.x) < (p.viewW || S.view.halfWidth) && Math.abs(p.y - m.y) < (p.viewH || S.view.halfHeight)) { m.target = p.id; m.cursed = true; break; }
      }
    }
    const chaser = m.target && players.get(m.target);
    const giveUp = m.cursed ? ((chaser && chaser.viewW) || S.view.halfWidth) * 1.3 : def.aggroRange ? def.aggroRange * S.mobs.deaggroFactor : S.mobs.onHitGiveUp;
    if (m.target && (!chaser || chaser.dead || dist2(chaser, m) > giveUp ** 2)) { m.target = null; m.cursed = false; }
    // Queen Ant: won't stray too far from her Ant Hole while it stands
    const home = m.home && mobs.get(m.home);
    if (home && def.leash && dist2(m, home) > def.leash ** 2) {
      m.target = null; m.cursed = false;
      const a = Math.atan2(home.y - m.y, home.x - m.x);
      m.angle += angDiff(m.angle, a) * Math.min(1, 6 * DT); m.heading = m.angle;
      m.x += Math.cos(m.angle) * def.speed * 1.5 * DT; m.y += Math.sin(m.angle) * def.speed * 1.5 * DT;
    } else if (m.chain && !m.head && !m.lead && !leader && !m.target) {
      // Cut-off centipede piece: stays put, just wiggles
      m.phase += DT * 3; m.angle += Math.sin(m.phase) * 0.6 * DT;
    } else if (leader) {
      // Attached centipede segment: always follows the one in front (it only goes its own
      // way once that one dies)
      const dx = leader.x - m.x, dy = leader.y - m.y, d = Math.hypot(dx, dy) || 1, gap = m.r * 1.8;
      if (d > gap) { m.x += dx / d * (d - gap); m.y += dy / d * (d - gap); }
      m.angle = Math.atan2(dy, dx); m.target = null;
    } else if (m.target && chaser && def.shooter) {
      hornetAct(m, def, chaser, now);
    } else if (m.target && chaser) {
      const a = Math.atan2(chaser.y - m.y, chaser.x - m.x), mul = webSlow(m, true) * (m.slowUntil > now ? 0.5 : 1);
      m.angle += angDiff(m.angle, a) * Math.min(1, (def.turnRate || 8) * DT); m.heading = m.angle;
      const v = chaseVel(m, def);
      m.x += Math.cos(m.angle) * v * mul * DT; m.y += Math.sin(m.angle) * v * mul * DT;
    } else if (leader) {
      const dx = leader.x - m.x, dy = leader.y - m.y, d = Math.hypot(dx, dy) || 1, gap = m.r * 1.8;
      if (d > gap) { m.x += dx / d * (d - gap); m.y += dy / d * (d - gap); }
      m.angle = Math.atan2(dy, dx);
    } else {
      const slow = (m.slowUntil > now ? 0.5 : 1) * webSlow(m, true);
      const zx0 = m.bx0, zx1 = m.bx1, edge = 80 + m.r;
      const out = m.x < zx0 + edge || m.x > zx1 - edge || m.y < edge || m.y > MAP_H - edge;
      const back = Math.atan2(MAP_H / 2 - m.y, (zx0 + zx1) / 2 - m.x);
      let spd;
      if (def.move === 'step') {
        // Ladybugs, ants, beetles, spiders: smooth bursts (speed swells to a peak and fades),
        // then a short rest and a new direction - the original's walking rhythm
        m.stepT = (m.stepT || 0) + DT;
        if (m.stepT >= STEP_CYCLE) { m.stepT -= STEP_CYCLE; m.heading = out ? back + rand(-0.6, 0.6) : rand(0, TAU); }
        spd = def.speed * stepProfile(m.stepT);
      } else if (def.move === 'weave') {
        // Bees and Hornets: swing side to side, slowing at each turn and fastest mid-swing
        m.phase += DT * Math.PI / 2.3;
        m.heading += (Math.random() - 0.5) * 0.6 * DT;
        if (out) m.heading += Math.sin(back - m.heading) * 2 * DT;
        const amp = def.weaveSlow ?? 0.12;
        spd = def.speed * (1 - (1 - amp) * (0.5 + 0.5 * Math.cos(2 * m.phase)));
        const dir = m.heading + 0.45 * Math.cos(m.phase);
        m.x += Math.cos(dir) * spd * slow * DT; m.y += Math.sin(dir) * spd * slow * DT;
        spd = 0;
      } else {
        // Centipedes: a slow, steady crawl that gently curves (the Square drifts the same way, very slowly)
        m.heading += (Math.random() - 0.5) * 1.6 * DT;
        if (out) m.heading += Math.sin(back - m.heading) * 2 * DT;
        spd = def.speed;
      }
      spd *= slow;
      m.x += Math.cos(m.heading) * spd * DT; m.y += Math.sin(m.heading) * spd * DT;
      if (def.spinRate) m.angle = (m.angle + def.spinRate * DT) % TAU;   // Square: slowly spins
      else m.angle += Math.sin(m.heading - m.angle) * Math.min(1, 6 * DT);
    }
    const kd = Math.exp(-KB_DECAY * DT);
    m.x = clamp(m.x + m.kx * DT, m.r, MAP_W - m.r); m.y = clamp(m.y + m.ky * DT, m.r, MAP_H - m.r);
    m.kx *= kd; m.ky *= kd;
  }
  // Mobs gently push apart (not segments of the same centipede)
  buildGrid();
  const ml = [...mobs.values()];
  for (const a of ml) for (const b of nearMobs(a.x, a.y, a.r)) {
    if (b.id <= a.id) continue;
    if (a.chain && a.chain === b.chain) continue;
    if ((a.type === 'antHole' && ANTS.has(b.type)) || (b.type === 'antHole' && ANTS.has(a.type))) continue;   // ants climb out of the middle of the hole
    const dx = a.x - b.x, dy = a.y - b.y, r = a.r + b.r;
    if (Math.abs(dx) > r || Math.abs(dy) > r) continue;
    const d = Math.hypot(dx, dy);
    if (d >= r || d === 0) continue;
    const push = (r - d) / 2, nx = dx / d, ny = dy / d;
    const sa = MOBS[a.type].stationary, sb = MOBS[b.type].stationary;
    if (!sa) { a.x += nx * push * (sb ? 2 : 1); a.y += ny * push * (sb ? 2 : 1); }
    if (!sb) { b.x -= nx * push * (sa ? 2 : 1); b.y -= ny * push * (sa ? 2 : 1); }
  }

  // --- Pets fight ---
  petFights(now);

  // --- Flowers vs mobs (only mobs near each flower; big mobs are found by their edges) ---
  for (const p of live) for (const m of nearMobs(p.x, p.y, S.petals.attackRadius * 1.7 + 40)) {
    if (p.dead || !mobs.has(m.id) || m.owner === p.id) continue;
    const mdef = MOBS[m.type];
    for (let qi = 0; qi < p.ring.length; qi++) {
      const [type, q] = p.ring[qi];
      if (!q.alive || !mobs.has(m.id)) continue;
      const def = PETALS[type];
      if (dist2(q, m) < (def.radius + m.r) ** 2 && pairReady(`q${p.id}_${m.id}_${qi}`, now, P.hitCooldown)) {
        q.hp -= mdef.damage; p.immuneUntil = 0;           // touching a mob ends spawn protection
        if (q.hp <= 0) breakSub(type, q);
        if (!mdef.stationary) { const d = Math.sqrt(dist2(q, m)) || 1; const kb = S.mobs.knockback * heft(m); m.kx += (m.x - q.x) / d * kb; m.ky += (m.y - q.y) / d * kb; m.cv = (m.cv || 0) * (1 - 0.5 * heft(m)); }
        hitFx(def, m, p, now);
        hurt(m, def.damage, p, true);
      }
    }
    if (!mobs.has(m.id)) continue;
    const r = F.radius + m.r, d2 = dist2(p, m);
    if (d2 < r * r && d2 > 0) {
      const d = Math.sqrt(d2), nx = (p.x - m.x) / d, ny = (p.y - m.y) / d;
      if (mdef.stationary) { p.x += nx * (r - d); p.y += ny * (r - d); }
      else { p.x += nx * (r - d) / 2; p.y += ny * (r - d) / 2; m.x -= nx * (r - d) / 2; m.y -= ny * (r - d) / 2; }
      p.immuneUntil = 0;
      if (pairReady(`b${p.id}_${m.id}`, now, 0.3)) {
        const kv = F.knockback * KB_DECAY;
        p.kx = nx * kv; p.ky = ny * kv;
        if (!mdef.stationary) { const kb = S.mobs.bumpKnockback * heft(m); m.kx = -nx * kb; m.ky = -ny * kb; m.cv *= 1 - heft(m); }   // bounces off and has to speed up again
        toxicTouch(p, m);
        hurt(m, F.bodyDamage, p, true);
        hurt(p, mdef.damage, m, false);
      }
    }
  }

  // --- Flowers vs flowers (free-for-all) ---
  for (let i = 0; i < live.length; i++) for (let j = 0; j < live.length; j++) {
    if (i === j) continue;
    const a = live[i], b = live[j];
    if (a.dead || b.dead) continue;
    a.ring.forEach(([type, q], qi) => {
      if (!q.alive) return;
      const def = PETALS[type];
      if (dist2(q, b) < (def.radius + F.radius) ** 2 && pairReady(`f${a.id}_${qi}_${b.id}`, now, P.hitCooldown)) {
        hitFx(def, b, a, now);
        hurt(b, def.damage, a, false);
        q.hp -= F.bodyDamage;
        if (q.hp <= 0) breakSub(type, q);
      }
      if (i < j) b.ring.forEach(([t2, q2], qj) => {
        if (!q.alive || !q2.alive) return;
        const d2 = PETALS[t2];
        if (dist2(q, q2) < (def.radius + d2.radius) ** 2 && pairReady(`pp${a.id}_${qi}_${b.id}_${qj}`, now, P.hitCooldown)) {
          q.hp -= d2.damage; q2.hp -= def.damage;
          if (q.hp <= 0) breakSub(type, q);
          if (q2.hp <= 0) breakSub(t2, q2);
        }
      });
    });
    if (i < j && !a.dead && !b.dead) {
      const d2 = dist2(a, b), r = F.radius * 2;
      if (d2 < r * r && d2 > 0) {
        const d = Math.sqrt(d2), push = (r - d) / 2, nx = (a.x - b.x) / d, ny = (a.y - b.y) / d;
        a.x += nx * push; a.y += ny * push; b.x -= nx * push; b.y -= ny * push;
        if (pairReady(`body${a.id}_${b.id}`, now, 0.3)) {
          // Flowers get an extra-hard knock when they bump each other
          const kv = F.knockback * KB_DECAY * F.flowerBumpKnockback;
          a.kx = nx * kv; a.ky = ny * kv; b.kx = -nx * kv; b.ky = -ny * kv;
          toxicTouch(a, b); toxicTouch(b, a);
          hurt(b, flowerBodyDamage(a), a, false); hurt(a, flowerBodyDamage(b), b, false);
        }
      }
    }
  }

  for (const w of webs.values()) if (w.until < now) webs.delete(w.id);
  // --- Projectiles + poison ---
  tickProjectiles(live, now);
  for (const m of [...mobs.values()]) if (m.poison) tickPoison(m, true);
  for (const p of live) if (p.poison && !p.dead) tickPoison(p, false);

  // --- Drops: pick up and despawn ---
  for (const d of drops.values()) {
    if (d.expires < now) { drops.delete(d.id); continue; }
    for (const p of live) {
      if (p.dead || dist2(p, d) > (F.radius + S.drops.pickupRadius) ** 2) continue;
      // An open loadout slot is filled first, otherwise the first free bench spot
      const eSlot = p.petals.indexOf(null), slot = eSlot >= 0 ? -1 : p.bench.indexOf(null);
      if (eSlot < 0 && slot < 0) continue;
      if (eSlot >= 0) p.petals[eSlot] = makeSlot(d.type); else p.bench[slot] = d.type;
      if (d.type !== 'basic') (p.history = p.history || []).push(d.type);
      drops.delete(d.id);
      send(p, { t: 'pick', row: eSlot >= 0 ? 'e' : 'b', slot: eSlot >= 0 ? eSlot : slot });
      break;
    }
  }

  sendState(now);
}

// --- Send each player what's near them ---
function sendState(now) {
  const plist = [...players.values()].filter(p => p.joined).map(p => ({
    id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp * 10) / 10, mh: p.maxHp,
    l: p.level, s: p.score, d: p.dead ? 1 : 0, f: p.fl === tickNo ? 1 : 0, m: p.input.attack ? 1 : p.input.defend ? 2 : 0,
    po: p.poison && !p.dead ? 1 : 0, pa: +p.petalAngle.toFixed(3), pr: Math.round(p.petalRadius), sp: +(p.spin ?? 1).toFixed(3), an: (p.vision || 1) > 1 ? 1 : 0,
    pt: p.dead || !p.ring ? [] : p.ring.map(([type, q]) => [type, q.alive ? 1 : 0, +q.rr.toFixed(3), q.uid, +(q.off || 0).toFixed(3), +(Math.max(0, q.hp) / PETALS[type].health).toFixed(2), q.ck]),
  }));
  const VW = S.view.halfWidth, VH = S.view.halfHeight;
  for (const p of players.values()) {
    if (!p.joined) continue;
    const vw = VW * (p.vision || 1), vh = VH * (p.vision || 1);      // Antennae see further
    const near = e => Math.abs(e.x - p.x) < vw + (e.r || 0) && Math.abs(e.y - p.y) < vh + (e.r || 0);
    send(p, {
      t: 's', players: plist,
      mobs: [...mobs.values()].filter(m => mobs.has(m.id) && near(m)).map(m => [m.id, m.type, Math.round(m.x), Math.round(m.y), +m.angle.toFixed(2), Math.round(m.hp / m.maxHp * 1000) / 10, Math.round(m.r), m.head ? 1 : 0, m.fl === tickNo ? 1 : 0]),
      webs: [...webs.values()].filter(near).map(w => [w.id, Math.round(w.x), Math.round(w.y), w.r]),
      shots: [...projectiles.values()].filter(near).map(s => [s.id, s.type, Math.round(s.x), Math.round(s.y), +Math.atan2(s.vy, s.vx).toFixed(2)]),
      drops: [...drops.values()].filter(near).map(d => [d.id, d.type, Math.round(d.x), Math.round(d.y), Math.round(d.expires - now), d.ox, d.oy]),
      me: { xp: Math.round(p.xp), next: xpForLevel(p.level), vis: p.vision || 1,
            ol: p.overleveled ? +Math.min(1, Math.max(0.001, p.olT / S.flower.overlevelGrace)).toFixed(3) : 0,
            slots: p.petals.map(s => s ? [s.type, slotReady(s)] : null), bench: p.bench },
    });
  }
}

// ---------- Inventory: equipped row 'e', bench row 'b' ----------
const slotGet = (p, row, i) => row === 'e' ? (p.petals[i] ? p.petals[i].type : null) : p.bench[i];
function slotSet(p, row, i, type) {
  if (row === 'e') p.petals[i] = type ? makeSlot(type) : null;   // moved-in petals must recharge
  else p.bench[i] = type;
}
const validSlot = (p, row, i) => Number.isInteger(i) && i >= 0 && (row === 'e' ? i < p.petals.length : row === 'b' ? i < p.bench.length : false);
function swapSlots(p, a, b) {
  if (!validSlot(p, a.row, a.i) || !validSlot(p, b.row, b.i)) return;
  if (a.row === b.row) { const arr = a.row === 'e' ? p.petals : p.bench; [arr[a.i], arr[b.i]] = [arr[b.i], arr[a.i]]; return; }
  const ta = slotGet(p, a.row, a.i), tb = slotGet(p, b.row, b.i);
  slotSet(p, a.row, a.i, tb); slotSet(p, b.row, b.i, ta);
}
function trashSlot(p, s) {
  if (!validSlot(p, s.row, s.i)) return;
  const type = slotGet(p, s.row, s.i);
  if (!type) return;
  slotSet(p, s.row, s.i, null);
  addXp(p, Math.round((PETALS[type].trashXp || 0) * S.leveling.xpMultiplier));
}

function send(p, msg) { if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg)); }

// ---------- Connections ----------
let nextPlayerId = 1;
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const p = {
    id: 1e6 + nextPlayerId++, ws, name: 'Flower', level: 1, xp: 0, score: 0, joined: false, dead: true,
    input: { angle: 0, mag: 0, attack: false, defend: false }, petalAngle: 0, petalRadius: S.petals.orbitRadius,
    petals: [], bench: [], ring: [], keep: [],
  };
  players.set(p.id, p);
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'join' && !p.joined) {
      p.name = String(m.name || '').trim().slice(0, 16) || 'Flower';
      p.joined = true; spawn(p, readStart(m.start));
      send(p, { t: 'init', id: p.id, map: { w: MAP_W, h: MAP_H, zones: S.map.zones }, petals: PETALS,
        mobs: Object.fromEntries(Object.entries(MOBS).map(([k, v]) => [k, { stationary: !!v.stationary }])),
        flowerRadius: S.flower.radius, spin: S.petals.spinSpeed, zoom: (S.client || {}).zoom || 1 });
      if (paused) send(p, { t: 'pause', on: true, by: paused.by });
    } else if (m.t === 'pause') {
      setPaused(!paused, p.name);
    } else if (m.t === 'in') {
      p.input.angle = +m.a || 0; p.input.mag = clamp(+m.m || 0, 0, 1);
      p.input.attack = !!m.at; p.input.defend = !!m.df;
      // How much of the world this player's screen shows (for the curse), capped at the server's view
      if (m.vw > 0 && m.vh > 0) { p.viewW = clamp(+m.vw, 200, S.view.halfWidth * 1.6); p.viewH = clamp(+m.vh, 150, S.view.halfHeight * 1.6); }
    } else if (m.t === 'swap' && !p.dead && m.a && m.b) swapSlots(p, m.a, m.b);
    else if (m.t === 'swapAll' && !p.dead) {
      for (let i = 0; i < Math.min(p.petals.length, p.bench.length); i++) swapSlots(p, { row: 'e', i }, { row: 'b', i });
    } else if (m.t === 'trash' && !p.dead && m.s) trashSlot(p, m.s);
    else if (m.t === 'respawn' && p.dead && p.joined) {
      if (typeof m.name === 'string') p.name = m.name.trim().slice(0, 16) || p.name;   // can change name on the home screen
      spawn(p, readStart(m.start));                                   // a custom start saved on the home screen wins
    }
  });
  ws.on('close', () => {
    players.delete(p.id);
    if (paused && ![...players.values()].some(o => o.joined)) setPaused(false);   // everyone left: don't stay frozen
  });
});

populate();
setInterval(populate, S.mobs.respawnInterval * 1000);
setInterval(tick, 1000 / S.tickRate);
server.listen(S.port, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log('\n🌼 Flower Game server is running!');
  console.log(`   You:      http://localhost:${S.port}`);
  ips.forEach(ip => console.log(`   Friends:  http://${ip}:${S.port}   (same wifi)`));
  console.log('\n   Press Ctrl + C to stop.\n');
});
