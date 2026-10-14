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
const DT = 1 / S.tickRate, TAU = Math.PI * 2, KB_DECAY = 10;
const RANK = { common: 0, unusual: 1, rare: 2, epic: 3, legendary: 4, unique: 5 };

// ---------- Web server: hands the game files to browsers ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
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
const xpForLevel = lvl => Math.round(S.leveling.base * Math.pow(lvl, S.leveling.exponent));
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
  return Math.min(...s.subs.map(q => q.alive ? 1 : Math.max(0, 1 - q.reload / r)));
}
function breakSub(type, q) { q.alive = false; q.reload = PETALS[type].reload; q.rf = 1; }

// ---------- Players ----------
const players = new Map();
const HUES = [45, 330, 200, 280, 120, 15, 170, 250];

function spawn(p) {
  const [zx0, zx1] = zoneBounds[S.map.zones[0].name];
  p.x = rand(zx0 + 200, zx0 + (zx1 - zx0) * 0.5); p.y = rand(200, MAP_H - 200);
  p.vx = p.vy = p.kx = p.ky = 0; p.poison = null; p.slowUntil = 0;
  if (p.dead && p.joined && p.everSpawned) { p.level = 1; p.xp = 0; }   // dying resets your level
  p.everSpawned = true;
  p.maxHp = maxHpFor(p.level); p.hp = p.maxHp; p.dead = false;
  p.petals = [];
  for (let i = 0; i < slotCount(p.level); i++) p.petals.push(makeSlot(S.flower.startingPetals[i] || 'basic', false));
  p.bench = Array(S.flower.benchSlots).fill(null);
  (p.keep || []).slice(0, p.bench.length).forEach((t, i) => p.bench[i] = t);
  p.keep = [];
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
const heal = (p, amt) => { if (!p.dead && !((p.noHealUntil || 0) > Date.now() / 1000)) p.hp = Math.min(p.maxHp, p.hp + amt); };

function killPlayer(p, byName) {
  p.dead = true; p.hp = 0;
  // Drop the best petals; the next best are kept for respawn
  const all = [];
  p.petals.forEach(s => { if (s && s.type !== 'basic') all.push(s.type); });
  p.bench.forEach(t => { if (t && t !== 'basic') all.push(t); });
  all.sort((a, b) => RANK[PETALS[b].rarity] - RANK[PETALS[a].rarity]);
  const n = S.drops.deathDropCount;
  spawnDrops(all.slice(0, n).filter(() => Math.random() > S.drops.deathVanishChance), p.x, p.y);
  p.keep = all.slice(n);
  p.score = 0;
  send(p, { t: 'dead', by: byName });
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
      stepT: rand(0, 2), pauseT: 0, slowUntil: 0, poison: null,
      angle: rand(0, TAU), heading: rand(0, TAU), phase: rand(0, TAU), lastHitBy: null, leader: null, chain: null, ...extraAll, ...extra };
    if (def.releases) {                          // Ant Hole: the ants it will let out as it takes damage
      m.queue = [];
      for (const [t, n] of Object.entries(def.releases)) for (let i = 0; i < n; i++) m.queue.push(t);
      for (let i = m.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [m.queue[i], m.queue[j]] = [m.queue[j], m.queue[i]]; }
      m.released = 0; m.queenOut = false;
    }
    mobs.set(m.id, m); return m;
  };
  if (def.segments) {
    const chain = nextEntityId, dir = rand(0, TAU); let prev = null, head = null;
    for (let i = 0; i < def.segments; i++) {
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
function antHoleRelease(h, attacker) {
  const def = MOBS[h.type], frac = 1 - Math.max(0, h.hp) / h.maxHp;
  const due = Math.min(h.queue.length, Math.floor(frac * h.queue.length + 0.0001));
  const tgt = attacker && attacker.ws ? attacker.id : null;
  const out = (type, extra = {}) => {
    const a = rand(0, TAU), d = rand(0, 4);              // out of the middle of the hole
    spawnMob(type, h.zone, { x: h.x + Math.cos(a) * d, y: h.y + Math.sin(a) * d }, { target: tgt, ...extra });
  };
  while (h.released < due) out(h.queue[h.released++]);
  if (!h.queenOut && h.hp <= def.queenAt) { h.queenOut = true; out('queenAnt', { home: h.id }); }
  // Nearby worker ants get angry when their hole is attacked
  if (tgt) for (const m of mobs.values()) if (m.type === 'workerAnt' && !m.owner && dist2(m, h) < 700 ** 2) m.target = tgt;
}
const chanceFor = (def, zone) => typeof def.spawnChance === 'object' ? (def.spawnChance[zone] ?? S.mobs.refillChance) : (def.spawnChance ?? S.mobs.refillChance);
// Each mob has a [min, max] count per zone. Below min it refills right away;
// between min and max it trickles back in, so a zone always looks full.
function populate() {
  for (const [type, def] of Object.entries(MOBS)) for (const [zone, range] of Object.entries(def.zones || {})) {
    if (!zoneBounds[zone]) continue;
    const [min, max] = Array.isArray(range) ? range : [range, range];
    // Centipedes count by living heads; cut-off pieces don't count
    const have = [...mobs.values()].filter(m => m.type === type && m.zone === zone && !m.owner && (!def.segments || m.head)).length;
    if (def.globalMax !== undefined && [...mobs.values()].filter(m => m.type === type && !m.owner).length >= def.globalMax) continue;
    for (let i = have; i < min; i++) spawnMob(type, zone);
    if (have >= min && have < max && Math.random() < chanceFor(def, zone)) spawnMob(type, zone);
  }
}
function killMob(m) {
  mobs.delete(m.id);
  if (m.owner) return;                         // pets give nothing when they die
  const md = MOBS[m.type];
  if (md.segments && md.aggroRange) {
    // Aggressive centipedes: the body behind the one that died keeps hunting (no new head grows)
    for (const f of mobs.values()) if (f.leader === m.id) {
      f.leader = null; f.lead = true; f.target = m.target || m.lastHitBy || null;
      f.cv = m.cv || 0; f.angle = m.angle;            // carry on at the same speed and heading
    }
  }
  const def = MOBS[m.type], killer = players.get(m.lastHitBy);
  if (killer && !killer.dead) addXp(killer, Math.round(def.xp * S.leveling.xpMultiplier));
  const got = Object.entries(def.drops || {}).filter(([type, chance]) => PETALS[type] && Math.random() < chance).map(([t]) => t);
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
      expires: Date.now() / 1000 + (S.drops.despawn[PETALS[type].rarity] || 30) });
  });
}

// ---------- Damage ----------
function hurt(target, amount, attacker, isMob, noReflect = false) {
  if (amount <= 0) return;
  if (isMob) {
    if (!mobs.has(target.id)) return;
    const def = MOBS[target.type];
    target.hp -= amount;
    if (attacker && attacker.ws && !target.owner) {
      target.lastHitBy = attacker.id;
      // Worker Ants / Yellow Ladybugs fight back when hit; aggressive mobs too
      if (def.aggro === 'onHit' || def.aggroRange) target.target = attacker.id;
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
      const L = S.leveling;
      addXp(attacker, Math.round((L.killXpBase + target.level * L.killXpPerLevel) * L.xpMultiplier));
    }
    killPlayer(target, attacker ? (attacker.ws ? attacker.name : MOBS[attacker.type].name) : null);
  }
}

// ---------- Petal side effects ----------
// Honey slows whatever it hits; poison petals deal damage over time.
function hitFx(def, target, attacker, now) {
  if (def.slow) target.slowUntil = now + def.slow;
  if (def.poison) applyPoison(target, def.poison[0], def.poison[1], attacker);
}
// Poison hits in once-a-second waves. Same total damage, split evenly:
// e.g. Iris = 60 over ~7s -> 7 hits of ~8.6, one per second.
function applyPoison(target, total, seconds, by) {
  const waves = Math.max(1, Math.ceil(seconds - 0.01));
  target.poison = { dmg: total / waves, waves, t: 1, by };
}
function tickPoison(t, isMob) {
  const ps = t.poison; if (!ps) return;
  ps.t -= DT;
  if (ps.t > 0) return;
  ps.t += 1; ps.waves--;
  if (ps.waves <= 0) t.poison = null;
  hurt(t, ps.dmg, ps.by, isMob);
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
    s.x += s.vx * DT; s.y += s.vy * DT;
    if (s.life <= 0 || s.x < 0 || s.y < 0 || s.x > MAP_W || s.y > MAP_H) { landWeb(s, now); projectiles.delete(s.id); continue; }
    if (s.fromMob) { tickMobShot(s, live); continue; }
    const owner = players.get(s.owner), def = PETALS[s.type];
    let hit = null, isMob = false;
    for (const m of nearMobs(s.x, s.y, s.r)) if (!(m.owner === s.owner) && dist2(s, m) < (s.r + m.r) ** 2) { hit = m; isMob = true; break; }
    if (!hit) for (const p of live) if (p.id !== s.owner && !p.dead && dist2(s, p) < (s.r + S.flower.radius) ** 2) { hit = p; break; }
    if (!hit) continue;
    hitFx(def, hit, owner, now);
    if (def.noHeal && !isMob) hit.noHealUntil = now + def.noHeal;      // Dandelion
    hurt(hit, s.dmg, owner, isMob);
    if (def.web) { landWeb(s, now); projectiles.delete(s.id); continue; }
    s.hp -= isMob ? MOBS[hit.type].damage : S.flower.bodyDamage;
    if (s.hp <= 0) projectiles.delete(s.id);
    else { s.vx *= 0.6; s.vy *= 0.6; }
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
  for (const w of webs.values()) if (w.owner !== e.id && (e.x - w.x) ** 2 + (e.y - w.y) ** 2 < w.r * w.r) return w.slow;
  return 1;
}

// Chasing mobs build up to top speed over chaseAccel seconds (Spiders are instant)
function chaseVel(m, def) {
  const top = def.chaseSpeed || def.speed;
  if (def.instantChase || !def.chaseAccel) return top;
  m.cv = Math.min(top, Math.max(m.cv || 0, def.speed || 0) + top / def.chaseAccel * DT);
  return m.cv;
}
// Where to aim so a shot moving at 'speed' meets a target moving at (vx, vy)
function intercept(sx, sy, tx, ty, vx, vy, speed) {
  const dx = tx - sx, dy = ty - sy, a = vx * vx + vy * vy - speed * speed, b = 2 * (dx * vx + dy * vy), c = dx * dx + dy * dy;
  let t;
  if (Math.abs(a) < 1e-6) t = -c / b;
  else { const disc = b * b - 4 * a * c; if (disc < 0) return [tx, ty]; const r = Math.sqrt(disc); const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a); t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2); }
  if (!(t > 0)) return [tx, ty];
  return [tx + vx * t, ty + vy * t];
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
  const sh = def.shooter, d = Math.sqrt(dist2(m, target)) || 1;
  // keep a little distance: close in, back off, or circle
  let a = Math.atan2(target.y - m.y, target.x - m.x), spd = chaseVel(m, def);
  if (d < sh.keepAway * 0.8) { a += Math.PI; spd *= 0.6; } else if (d < sh.keepAway * 1.2) { a += Math.PI / 2; spd *= 0.35; }
  const mul = webSlow(m, true) * (m.slowUntil > now ? 0.5 : 1);
  m.x += Math.cos(a) * spd * mul * DT; m.y += Math.sin(a) * spd * mul * DT;
  // Aim: where the flower will be when a missile fired from our nose arrives
  const nose = m.r, ovx = target.ovx || 0, ovy = target.ovy || 0;
  const [tx, ty] = intercept(m.x + Math.cos(m.angle) * nose, m.y + Math.sin(m.angle) * nose, target.x, target.y, ovx, ovy, sh.speed);
  const aim = Math.atan2(ty - m.y, tx - m.x);
  m.angle += angDiff(m.angle, aim) * Math.min(1, sh.turnRate * DT); m.heading = m.angle;
  m.shotT = (m.shotT ?? sh.every * Math.random()) - DT;
  // Fire straight out the front, only once it's lined up
  if (m.shotT <= 0 && Math.abs(angDiff(m.angle, aim)) < sh.aimTolerance) {
    m.shotT = sh.every;
    const fa = m.angle;
    spawnProjectile({ type: 'hornetMissile', fromMob: m.id, mobType: m.type, x: m.x + Math.cos(fa) * nose, y: m.y + Math.sin(fa) * nose,
      vx: Math.cos(fa) * sh.speed, vy: Math.sin(fa) * sh.speed, r: 9, dmg: sh.damage, hp: sh.health, life: sh.life });
  }
}

// ---------- Pets (from Eggs) ----------
// A pet follows its flower and attacks nearby mobs and other flowers,
// but never wanders too far from its owner.
function movePet(m, def, now) {
  const owner = players.get(m.owner);
  if (!owner || owner.dead || !owner.ring.some(([, q]) => q.petId === m.id)) { mobs.delete(m.id); return; }
  let tgt = null, bd = 380 ** 2;
  if (dist2(m, owner) < 550 ** 2) {
    for (const w of nearMobs(owner.x, owner.y, 380)) {
      if (w.owner) continue;
      const d = dist2(w, owner); if (d < bd) { bd = d; tgt = w; }
    }
    for (const p of players.values()) {
      if (p === owner || p.dead || !p.joined) continue;
      const d = dist2(p, owner); if (d < bd) { bd = d; tgt = p; }
    }
  }
  const goal = tgt || owner, d = Math.sqrt(dist2(m, goal)) || 1;
  const spd = tgt ? (def.chaseSpeed || def.speed * 2) : (d > 110 ? Math.min(S.flower.speed * 1.1, d * 2) : 0);
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
  const now = Date.now() / 1000;
  const P = S.petals, F = S.flower;
  const live = [...players.values()].filter(p => p.joined && !p.dead);

  // --- Flowers + their petals ---
  for (const p of live) {
    p.slowed = (p.slowUntil || 0) > now;                    // Honey: half speed + slower petals
    const spdF = F.speed * (p.slowed ? 0.5 : 1) * webSlow(p, false);
    const tvx = Math.cos(p.input.angle) * spdF * p.input.mag, tvy = Math.sin(p.input.angle) * spdF * p.input.mag;
    const k = Math.min(1, F.acceleration * DT), kd = Math.exp(-KB_DECAY * DT);
    p.vx += (tvx - p.vx) * k; p.vy += (tvy - p.vy) * k;
    const px0 = p.x, py0 = p.y;
    p.x = clamp(p.x + (p.vx + p.kx) * DT, F.radius, MAP_W - F.radius);
    p.y = clamp(p.y + (p.vy + p.ky) * DT, F.radius, MAP_H - F.radius);
    // smoothed real velocity, used by Hornets to lead their shots
    p.ovx = (p.ovx || 0) + ((p.x - px0) / DT - (p.ovx || 0)) * 0.5; p.ovy = (p.ovy || 0) + ((p.y - py0) / DT - (p.ovy || 0)) * 0.5;
    p.kx *= kd; p.ky *= kd;

    const z = zoneAt(p.x);
    p.overleveled = z.maxLevel !== null && p.level >= z.maxLevel;
    // Overleveled: petals keep working until the countdown finishes, then they disappear
    p.olT = p.overleveled ? (p.olT || 0) + DT : 0;
    const olGone = p.overleveled && p.olT >= F.overlevelGrace;

    const target = p.input.attack ? P.attackRadius : p.input.defend ? P.defendRadius : P.orbitRadius;
    p.petalRadius += (target - p.petalRadius) * Math.min(1, P.radiusSpeed * DT);
    const ring = [];
    p.petals.forEach(s => s && !PETALS[s.type].noOrbit && s.subs.forEach(q => ring.push([s.type, q])));
    p.vision = Math.max(1, ...p.petals.filter(Boolean).map(s => PETALS[s.type].vision || 1));
    // Passive effects from equipped petals
    let spinBonus = 0, hpBonus = 0; p.salt = 0; p.toxic = null;
    for (const [type, q] of ring) {
      const d = PETALS[type];
      if (d.hpBonus) hpBonus += d.hpBonus;                        // Cactus: more max health
      if (!q.alive) continue;
      if (d.spinBonus) spinBonus += d.spinBonus;                  // Faster: petals spin faster
      if (d.reflect) p.salt = d.reflect;                          // Salt (doesn't stack)
      if (d.toxic) p.toxic = d.toxic;                             // Epic Cactus: poisonous body
    }
    p.maxHp = maxHpFor(p.level) + Math.round(hpBonus);
    if (p.hp > p.maxHp) p.hp = p.maxHp;
    p.spin = (P.spinSpeed + spinBonus) / P.spinSpeed * (p.slowed ? 0.5 : 1);
    p.petalAngle = (p.petalAngle + P.spinSpeed * p.spin * DT) % TAU;
    ring.forEach(([type, q], i) => {
      const def = PETALS[type];
      // Each petal glides to its spot when the ring size changes (no snapping)
      const want = (i / ring.length) * TAU;
      q.off = q.off === undefined ? want : (q.off + angDiff(q.off, want) * Math.min(1, 8 * DT) + TAU) % TAU;
      if (olGone) { q.alive = false; q.reload = Math.max(q.reload, 0.5); return; }
      if (!q.alive) {
        if (q.petId) {                                         // Egg: waits while its pet is alive
          if (mobs.has(q.petId)) return;
          q.petId = null; q.reload = def.reload;
        }
        q.reload -= DT;
        // Respawn at the flower's center and grow back out to the ring. (Before, a petal came
        // back at the spot where it broke for one tick, landing a "phantom" hit on that mob.)
        if (q.reload <= 0) { q.alive = true; q.hp = def.health; q.rf = 0.15; q.aliveT = 0; q.x = p.x; q.y = p.y; }
        return;
      }
      q.aliveT += DT;
      if (def.healPerSec) heal(p, def.healPerSec * DT);
      if (def.heal && p.hp < p.maxHp && q.aliveT > (def.healDelay || 1)) {
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
      // Bubble: holding defend pops it and launches your flower away from it
      if (def.bubble && p.input.defend && q.aliveT > 0.3) {
        const d = Math.hypot(p.x - q.x, p.y - q.y) || 1;
        const boost = def.boost || 2600;
        p.kx = (p.x - q.x) / d * boost; p.ky = (p.y - q.y) / d * boost;
        breakSub(type, q); return;
      }
      // Peas / Missile: holding attack fires them outward
      if (def.shoot && p.input.attack && q.aliveT > 0.5) {
        const sh = def.shoot;
        for (let k = 0; k < sh.count; k++) {
          const ang = a + k * TAU / sh.count;
          spawnProjectile({ type, owner: p.id, src: q, x: q.x, y: q.y, vx: Math.cos(ang) * sh.speed, vy: Math.sin(ang) * sh.speed,
            r: def.radius * (sh.single ? 0.9 : 0.7), dmg: def.damage, hp: sh.health, life: sh.life, poison: def.poison });
        }
        breakSub(type, q); return;
      }
      // Egg: hatches into a pet that fights for you; the egg reloads once the pet dies
      if (def.pet && q.aliveT > (def.hatch || 1) && MOBS[def.pet]) {
        const pet = spawnMob(def.pet, null, { x: q.x, y: q.y }, { owner: p.id });
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
    if (m.owner) { movePet(m, def, now); continue; }
    if (!m.target) m.cv = 0;                                // not chasing: next chase starts from a standstill
    // Aggressive mobs (Beetle, Soldier Ant, Evil Centipede head...) notice flowers in range
    if (def.aggroRange && !m.target && (!m.chain || m.head || m.lead)) {
      let best = null, bd = def.aggroRange ** 2;
      for (const p of live) { const d = dist2(p, m); if (d < bd) { bd = d; best = p; } }
      if (best) m.target = best.id;
    }
    const chaser = m.target && players.get(m.target);
    const giveUp = def.aggroRange ? def.aggroRange * S.mobs.deaggroFactor : S.mobs.onHitGiveUp;
    if (m.target && (!chaser || chaser.dead || dist2(chaser, m) > giveUp ** 2)) m.target = null;
    // Queen Ant: won't stray too far from her Ant Hole while it stands
    const home = m.home && mobs.get(m.home);
    if (home && def.leash && dist2(m, home) > def.leash ** 2) {
      m.target = null;
      const a = Math.atan2(home.y - m.y, home.x - m.x);
      m.angle += angDiff(m.angle, a) * Math.min(1, 6 * DT); m.heading = m.angle;
      m.x += Math.cos(m.angle) * def.speed * 1.5 * DT; m.y += Math.sin(m.angle) * def.speed * 1.5 * DT;
    } else if (m.chain && !m.head && !m.lead && !leader) {
      // Cut-off centipede piece: stays put, just wiggles
      m.phase += DT * 3; m.angle += Math.sin(m.phase) * 0.6 * DT;
    } else if (m.target && chaser && def.shooter) {
      hornetAct(m, def, chaser, now);
    } else if (m.target && chaser) {
      const a = Math.atan2(chaser.y - m.y, chaser.x - m.x), mul = webSlow(m, true) * (m.slowUntil > now ? 0.5 : 1);
      m.angle += angDiff(m.angle, a) * Math.min(1, 8 * DT); m.heading = m.angle;
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
        // Ladybugs: walk straight a short way, pause, pick a new direction
        if (m.pauseT > 0) { m.pauseT -= DT; spd = 0; if (m.pauseT <= 0) { m.heading = out ? back + rand(-0.6, 0.6) : rand(0, TAU); m.stepT = rand(1.8, 3.2); } }
        else { m.stepT -= DT; spd = def.speed; if (m.stepT <= 0) m.pauseT = rand(0.6, 1.4); }
      } else {
        // Wander: drift heading, speed swells and fades
        m.phase += DT * 0.8;
        m.heading += (Math.random() - 0.5) * 1.6 * DT;
        if (out) m.heading += Math.sin(back - m.heading) * 2 * DT;
        spd = def.speed * (0.25 + 0.75 * (0.5 + 0.5 * Math.sin(m.phase)));
      }
      spd *= slow;
      m.x += Math.cos(m.heading) * spd * DT; m.y += Math.sin(m.heading) * spd * DT;
      if (def.wobble) {                                   // bees zig-zag side to side
        const w = Math.sin(m.phase * 7) * 45 * DT;
        m.x += Math.cos(m.heading + Math.PI / 2) * w; m.y += Math.sin(m.heading + Math.PI / 2) * w;
      }
      m.angle += Math.sin(m.heading - m.angle) * Math.min(1, 6 * DT);
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
        q.hp -= mdef.damage;
        if (q.hp <= 0) breakSub(type, q);
        if (!mdef.stationary) { const d = Math.sqrt(dist2(q, m)) || 1; m.kx += (m.x - q.x) / d * S.mobs.knockback * KB_DECAY * 0.3; m.ky += (m.y - q.y) / d * S.mobs.knockback * KB_DECAY * 0.3; }
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
      if (pairReady(`b${p.id}_${m.id}`, now, 0.3)) {
        const kv = F.knockback * KB_DECAY;
        p.kx = nx * kv; p.ky = ny * kv;
        if (!mdef.stationary) { m.kx = -nx * kv * 0.5; m.ky = -ny * kv * 0.5; }
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
          const kv = F.knockback * KB_DECAY;
          a.kx = nx * kv; a.ky = ny * kv; b.kx = -nx * kv; b.ky = -ny * kv;
          toxicTouch(a, b); toxicTouch(b, a);
          hurt(b, F.bumpDamage, a, false); hurt(a, F.bumpDamage, b, false);
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
      const slot = p.bench.indexOf(null);
      if (slot < 0) continue;
      p.bench[slot] = d.type; drops.delete(d.id);
      send(p, { t: 'pick', slot, from: [Math.round(d.x), Math.round(d.y)] });
      break;
    }
  }

  // --- Send each player what's near them ---
  const plist = [...players.values()].filter(p => p.joined).map(p => ({
    id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp * 10) / 10, mh: p.maxHp,
    l: p.level, s: p.score, d: p.dead ? 1 : 0, m: p.input.attack ? 1 : p.input.defend ? 2 : 0,
    pa: +p.petalAngle.toFixed(3), pr: Math.round(p.petalRadius), sp: p.spin || 1, an: (p.vision || 1) > 1 ? 1 : 0,
    pt: p.dead || !p.ring ? [] : p.ring.map(([type, q]) => [type, q.alive ? 1 : 0, +q.rr.toFixed(3), q.uid, +(q.off || 0).toFixed(3), +(Math.max(0, q.hp) / PETALS[type].health).toFixed(2)]),
  }));
  const VW = S.view.halfWidth, VH = S.view.halfHeight;
  for (const p of players.values()) {
    if (!p.joined) continue;
    const vw = VW * (p.vision || 1), vh = VH * (p.vision || 1);      // Antennae see further
    const near = e => Math.abs(e.x - p.x) < vw + (e.r || 0) && Math.abs(e.y - p.y) < vh + (e.r || 0);
    send(p, {
      t: 's', players: plist,
      mobs: ml.filter(m => mobs.has(m.id) && near(m)).map(m => [m.id, m.type, Math.round(m.x), Math.round(m.y), +m.angle.toFixed(2), Math.round(m.hp / m.maxHp * 1000) / 10, Math.round(m.r), m.head ? 1 : 0]),
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
      p.joined = true; spawn(p);
      send(p, { t: 'init', id: p.id, map: { w: MAP_W, h: MAP_H, zones: S.map.zones }, petals: PETALS,
        mobs: Object.fromEntries(Object.entries(MOBS).map(([k, v]) => [k, { name: v.name, stationary: !!v.stationary }])),
        flowerRadius: S.flower.radius, spin: S.petals.spinSpeed, zoom: (S.client || {}).zoom || 1 });
    } else if (m.t === 'in') {
      p.input.angle = +m.a || 0; p.input.mag = clamp(+m.m || 0, 0, 1);
      p.input.attack = !!m.at; p.input.defend = !!m.df;
    } else if (m.t === 'swap' && !p.dead && m.a && m.b) swapSlots(p, m.a, m.b);
    else if (m.t === 'swapAll' && !p.dead) {
      for (let i = 0; i < Math.min(p.petals.length, p.bench.length); i++) swapSlots(p, { row: 'e', i }, { row: 'b', i });
    } else if (m.t === 'trash' && !p.dead && m.s) trashSlot(p, m.s);
    else if (m.t === 'respawn' && p.dead && p.joined) spawn(p);
  });
  ws.on('close', () => players.delete(p.id));
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
