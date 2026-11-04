// ---------- Bots: computer-controlled flowers ----------
// A bot is a normal player that lives on the server instead of in a browser. Every tick it
// decides what to "press" (where to move, attack, defend) and the game treats those inputs
// exactly like a real player's - same speed, same petals, same rules. The only exception:
// for now bots never hurt other flowers (server.js checks `p.bot` for that).
//
// How a bot plays:
//  1. It picks a goal build from config/builds.json (better-ranked builds more often).
//  2. It starts with healing and Heavies (the "Starter"), then plays whichever build it can
//     fill best right now: its goal, the goal's easier stepping-stone build, or the
//     Killing Strat in Medium. Slots it can't fill yet use stand-in petals.
//  3. It farms the mobs most likely to drop the petals it's missing, in the best zone it's
//     allowed in for its level, picks up every drop and sells the junk.
//  4. It heals when hurt, runs when low, dodges Hornet missiles and fights off anything
//     chasing it. How well it does all this depends on its skill.
const fs = require('fs'), path = require('path');

module.exports = function createBots(api) {
  const { S, MOBS, PETALS, RANK, players, mobs, drops, projectiles, zoneBounds, MAP_W, MAP_H } = api;
  const DT = 1 / S.tickRate, TAU = Math.PI * 2;
  const BS = Object.assign({ count: 1, names: [] }, S.bots || {});
  const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config', 'builds.json'), 'utf8'));
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const angDiff = (a, b) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const has = t => !!PETALS[t];
  const isHeal = t => !!(PETALS[t] && (PETALS[t].heal || PETALS[t].healPerSec));
  const HEAVYISH = new Set(['heavy', 'rock', 'heaviest']);
  const ZONES = S.map.zones.map(z => z.name);
  const zoneIdxAt = x => { for (let i = 0; i < ZONES.length; i++) if (x < zoneBounds[ZONES[i]][1]) return i; return ZONES.length - 1; };

  // ---------- Builds ----------
  // Families, with any petal that isn't in this game (e.g. Iris Missile in the version without it) left out
  const FAM = {};
  for (const [k, f] of Object.entries(CFG.families)) FAM[k] = { petals: f.petals.filter(has), standIns: f.standIns.filter(has), heal: !!f.heal };
  function norm(name, b, kind) {
    const slots = b.slots.filter(f => FAM[f] && FAM[f].petals.length + FAM[f].standIns.length);
    const healSlots = slots.filter(f => FAM[f].heal).length;
    // Every build gets about 2 Roses' worth of healing: in the loadout, or on the bench to swap in
    const heal = b.heal === 'bench' || healSlots === 0 ? 'bench' : 'equipped';
    return { name, kind, slots, heal, style: b.style || 'farm', weight: b.weight || 1, bench: (b.bench || []).filter(f => FAM[f]), stepping: b.stepping, tactic: b.tactic };
  }
  const STEP = {}, GOALS = [];
  for (const [n, b] of Object.entries(CFG.steppingStones)) STEP[n] = norm(n, b, 'step');
  for (const [n, b] of Object.entries(CFG.goals)) GOALS.push(norm(n, b, 'goal'));

  // Which slots of a build to use when you only have n slots: healing first (up to 2),
  // then the rest in the build's order. They stay in the build's order on the flower.
  function slotsFor(build, n) {
    const idx = build.slots.map((f, i) => i);
    const heals = idx.filter(i => FAM[build.slots[i]].heal), rest = idx.filter(i => !FAM[build.slots[i]].heal);
    const pick = build.heal === 'equipped' ? [...heals.slice(0, 2), ...rest, ...heals.slice(2)] : [...rest, ...heals];
    return pick.slice(0, n).sort((a, b) => a - b);
  }
  // A rough "how good is this petal in general" for filling spare slots and choosing what to sell
  const RVAL = { common: 1, unusual: 2, rare: 3, epic: 4, legendary: 5, unique: 6 };
  const petalValue = t => (RVAL[PETALS[t].rarity] || 1) + (isHeal(t) ? 0.5 : 0) + (t === 'basic' ? -1 : 0);

  // Fill a build's slots from what the bot owns. Returns the loadout (in build order), a score
  // (how complete it is) and what's still missing.
  function assign(build, n, inv, forceHeal) {
    const pool = {};
    for (const t of inv) pool[t] = (pool[t] || 0) + 1;
    const take = t => { if (pool[t] > 0) { pool[t]--; return true; } return false; };
    let order = slotsFor(build, n);
    const fams = order.map(i => build.slots[i]);
    const out = Array(order.length).fill(null), qual = Array(order.length).fill(0), missing = [];
    // priority: healing slots first, then left to right
    const pri = fams.map((f, k) => k).sort((a, b) => (FAM[fams[b]].heal ? 1 : 0) - (FAM[fams[a]].heal ? 1 : 0) || a - b);
    for (const k of pri) {                                  // 1) the real petals
      const f = FAM[fams[k]];
      for (let j = 0; j < f.petals.length; j++) if (take(f.petals[j])) { out[k] = f.petals[j]; qual[k] = 1 - 0.04 * j; break; }
    }
    for (const k of pri) if (!out[k]) {                     // 2) stand-ins
      const f = FAM[fams[k]];
      for (let j = 0; j < f.standIns.length; j++) if (take(f.standIns[j])) { out[k] = f.standIns[j]; qual[k] = 0.45 - 0.07 * j; break; }
    }
    for (let k = 0; k < out.length; k++) {                  // what to farm for this slot
      const f = FAM[fams[k]];
      if (out[k] !== f.petals[0]) missing.push({ fam: fams[k], have: out[k], upgrade: f.petals.includes(out[k]) });
    }
    const left = Object.entries(pool).flatMap(([t, c]) => Array(c).fill(t)).sort((a, b) => petalValue(b) - petalValue(a));
    for (let k = 0; k < out.length; k++) if (!out[k] && left.length) { out[k] = left.shift(); qual[k] = 0.1; }   // 3) best spare
    // A clearly better petal it owns but the build doesn't call for (say an Epic Cactus while
    // playing Twin Faster) takes the place of the weakest petal - the build is still built
    // around it. Up to ~40% of the slots; healing stays at 2.
    const SKIP = new Set(['yinYang', 'antennae']);                      // these change how the build works
    const spares = left.filter(t => !SKIP.has(t) && PETALS[t].rarity !== 'unique');
    let swaps = Math.max(1, Math.floor(out.length * 0.4));
    while (swaps-- > 0 && spares.length) {
      const healsIn = out.filter(t => t && isHeal(t)).length;
      let weakest = -1, ww = 1e9;
      for (let k = 0; k < out.length; k++) {
        if (!out[k] || (isHeal(out[k]) && healsIn <= 2)) continue;
        const w = petalValue(out[k]) + (qual[k] >= 0.9 ? 0.5 : 0);
        if (w < ww) { ww = w; weakest = k; }
      }
      const best = spares[0];
      if (weakest < 0 || petalValue(best) - ww < 1.5) break;
      left.splice(left.indexOf(best), 1); spares.shift();
      left.push(out[weakest]); out[weakest] = best; qual[weakest] = Math.max(qual[weakest], 0.6);
    }
    // Builds that keep healing on the bench: while healing, Roses go in the last slots
    if (forceHeal) {
      const heals = left.filter(isHeal).slice(0, 2);
      for (let h = 0; h < heals.length; h++) { const k = out.length - 1 - h; if (k >= 0 && !isHeal(out[k])) out[k] = heals[h]; }
    }
    // spare slots past the build's length
    while (out.length < n && left.length) out.push(left.shift());
    const score = qual.reduce((a, q, k) => a + q * (FAM[fams[k]].heal ? 1.4 : 1), 0);
    return { out, score, missing };
  }

  // ---------- Skill ----------
  // 0.1 = brand new player, 1 = very good. Everything about how a bot plays scales with it.
  function makeSkill() {
    const s = rand(0.1, 1), aggr = rand(0, 1);
    return {
      s, aggr,                           // aggr: 0 = avoids fights, 1 = picks fights it might lose (not tied to skill)
      mood: aggr > 0.75 ? 'aggressive' : aggr > 0.45 ? 'bold' : aggr > 0.2 ? 'cautious' : 'timid',
      label: s > 0.8 ? 'expert' : s > 0.55 ? 'good' : s > 0.3 ? 'okay' : 'beginner',
      reaction: 0.6 - 0.45 * s,          // seconds before it notices changes
      aimErr: (1 - s) * 40,              // how far off it stands from the ideal spot (px)
      angNoise: (1 - s) * 0.3,           // wobble in its steering (radians)
      dodge: 0.15 + 0.75 * s,            // chance to sidestep a Hornet missile it sees coming
      flee: 0.12 + 0.1 * s,              // only runs below this much health, and only from a swarm
      heal: 0.45 - 0.15 * s,             // takes a healing break below this (good players keep farming while Roses work)
      sloppy: (1 - s) * 0.25,            // chance to forget to attack for a moment
      equipT: 2.5 - 1.5 * s,             // how often it rethinks its loadout (s)
      actionT: 0.7 - 0.45 * s,           // time per petal swap / sell (s)
      shotTol: 0.12 + (1 - s) * 0.5,     // how well it times Missile / Dandelion shots (radians)
      pull: 1 + Math.round(s * 3),       // how many aggressive mobs it's happy to take on at once
    };
  }

  // ---------- Making bots ----------
  const NAMES = BS.names.length ? BS.names : ['Petal Pusher', 'Daisy Chain', 'Sprout Scout', 'Mari Gold', 'Pollen Pal', 'Bloom Boom',
    'Thorny', 'Stem Cell', 'Bud Buddy', 'Lily Pad', 'Tulip Trip', 'Fern Ando', 'Rosie Posie', 'Sunny Seed', 'Leaf Me Alone',
    'Petalgeist', 'Vine Dining', 'Bee Friend', 'Nectar Hector', 'Clover Rover', 'Poppy Seed', 'Orchid Ace', 'Root Toot', 'Blossom Possum'];
  const bots = [];
  function addBot() {
    const used = new Set([...players.values()].map(p => p.name));
    const name = NAMES.find(n => !used.has(n)) || `Bloom ${bots.length + 1}`;
    const p = {
      id: api.nextId(), ws: { readyState: 3, send() {} }, bot: true, name, level: 1, xp: 0, score: 0, joined: true, dead: true,
      input: { angle: 0, mag: 0, attack: false, defend: false }, petalAngle: 0, petalRadius: S.petals.orbitRadius,
      petals: [], bench: [], ring: [], keep: [],
    };
    const skill = makeSkill();
    p.brain = { skill, goal: pickGoal(null, skill), active: null, mode: 'wander', thinkT: 0, equipT: 0, actT: 0,
      plan: null, dodge: new Map(), circle: Math.random() < 0.5 ? 1 : -1, way: null, noise: 0, zoneT: 0, zone: 0 };
    players.set(p.id, p);
    api.spawn(p, null);
    bots.push(p);
    return p;
  }
  // Goal: weighted pick; after a death it may switch to whatever it's now closest to
  // Each style sits somewhere between farming (0) and killing (1); a bot likes builds whose
  // style is close to its own aggression (0 = calm, 1 = aggressive)
  const STYLE = { farm: 0, 'lean-farm': 0.25, hybrid: 0.5, 'lean-kill': 0.75, kill: 1 };
  const styleW = (g, sk) => 0.1 + 1.9 * (1 - Math.abs(sk.aggr - (STYLE[g.style] ?? 0.5))) ** 4;
  function pickGoal(p, sk) {
    sk = sk || p.brain.skill;
    let list = GOALS.map(g => ({ g, w: g.weight * styleW(g, sk) }));
    if (p) { const inv = invOf(p); list = list.map(o => ({ g: o.g, w: o.w * (0.5 + assign(o.g, 8, inv).score / 8) })); }
    let r = Math.random() * list.reduce((a, o) => a + o.w, 0);
    for (const o of list) if ((r -= o.w) <= 0) return o.g;
    return list[0].g;
  }
  const invOf = p => [...p.petals.filter(Boolean).map(s => s.type), ...p.bench.filter(Boolean)];

  // ---------- Which build to play right now ----------
  function chooseActive(p) {
    const b = p.brain, inv = invOf(p), n = api.slotCount(p.level);
    const heals = inv.filter(isHeal).length, heavies = inv.filter(t => HEAVYISH.has(t)).length;
    // First things first: healing and Heavies
    if (p.level < 15 && (heals < 1 || heavies < 2)) return STEP['Starter'];
    // Farming builds (Twin Faster, Wing Faster) kill mobs much faster than the Killing Strat,
    // which is really for fighting flowers - so they're the usual in-between builds
    const ag = b.skill.aggr;                                            // aggressive bots favour the Killing Strat
    const cands = [[b.goal, 1.12], [STEP['Starter'], p.level < 15 ? 0.9 : 0.6], [STEP['Killing Strat'], 0.8 + 0.35 * ag],
      [STEP['Twin Faster'], 1.05 - 0.2 * ag], [STEP['Wing Faster'], 1.05 - 0.2 * ag]];
    if (b.goal.stepping && STEP[b.goal.stepping]) cands.push([STEP[b.goal.stepping], 1.0]);
    let best = null, bs = -1;
    for (const [build, bias] of cands) {
      const sc = assign(build, n, inv).score * bias * (build === b.active ? 1.08 : 1);   // a little stickiness
      if (sc > bs) { bs = sc; best = build; }
    }
    return best;
  }

  // Petals it wants, with how much it wants them
  function wanted(p) {
    const b = p.brain, inv = invOf(p), want = {};
    const add = (t, w) => { want[t] = (want[t] || 0) + w; };
    const plans = [[b.active || b.goal, 1, api.slotCount(p.level)], [b.goal, 0.7, 8]];
    for (const [build, w, n] of plans) {
      for (const m of assign(build, n, inv).missing) {
        const f = FAM[m.fam], hw = f.heal ? 1.3 : 1;
        if (m.upgrade) { const at = f.petals.indexOf(m.have); f.petals.slice(0, at).forEach(t => add(t, 0.3 * w)); }
        else f.petals.forEach((t, j) => add(t, w * hw * (j === 0 ? 1 : 0.8)));
      }
      for (const fam of build.bench) if (!FAM[fam].petals.some(t => inv.includes(t))) FAM[fam].petals.forEach(t => add(t, 0.5 * w));
    }
    if (inv.filter(isHeal).length < 3) { add('rose', 1.2); add('roseRare', 1.2); add('roseEpic', 1.2); add('leaf', 0.6); }   // ~2 Roses + a spare
    return want;
  }

  // ---------- Where to farm ----------
  // Points a mob is worth when killed (XP + what its drops sell for) and the health you have
  // to chew through. An Ant Hole counts the ants it lets out (~500 points in all), a
  // centipede all its segments - big targets mean no time lost walking between kills.
  const PTS = {};
  function mobPoints(type) {
    if (PTS[type]) return PTS[type];
    const def = MOBS[type];
    let pts = def.xp || 1;
    for (const [t, c] of Object.entries(def.drops || {})) if (PETALS[t]) pts += c * (PETALS[t].trashXp || 0);
    let hp = def.healthRange ? (def.healthRange[0] + def.healthRange[1]) / 2 : def.health;
    if (def.segments) { pts *= def.segments; hp *= def.segments; }
    if (def.releases) for (const [t, n] of Object.entries(def.releases)) { const a = mobPoints(t); pts += a.pts * n; hp += a.hp * n; }
    if (def.queenAt) { const q = mobPoints('queenAnt'); pts += q.pts; hp += q.hp; }
    return (PTS[type] = { pts, hp });
  }
  // How much damage per second its petals do (roughly; not every swing lands)
  function dpsOf(p) {
    let d = 0;
    for (const s of p.petals) { if (!s) continue; const def = PETALS[s.type]; d += (def.damage || 0) * (def.count || 1) / Math.max(0.25, def.reload); }
    return Math.max(10, d * 0.5);
  }
  // How good a mob is to farm: petals it wants + points per second (kill time + walk time)
  function mobValue(type, want, p, d = 400) {
    const def = MOBS[type];
    let v = 0;
    for (const [t, c] of Object.entries(def.drops || {})) if (PETALS[t] && want[t]) v += c * want[t] * 100;
    const { pts, hp } = mobPoints(type), dps = p ? p.brain.dps || 30 : 30;
    return v + pts / (hp / dps + d / 280 + 1.5) * 25;
  }
  // Mobs a bot shouldn't pick a fight with yet (it still fights back if they come for it)
  function tooRisky(p, m) {
    const def = MOBS[m.type], s = p.brain.skill.s, L = p.level + s * 8;   // good players punch above their level
    if (m.type === 'hornet' && L < 24) return true;
    if (m.type === 'spider' && L < 26) return true;
    if (m.type === 'antHole' && (L < 20 || p.hp < p.maxHp * 0.6)) return true;
    if (m.type === 'queenAnt' && L < 26) return true;
    if (m.type === 'evilCentipede' && L < 24) return true;
    if (m.type === 'beetle' && L < 18) return true;
    if (m.r > 90 && L < 34) return true;                                // Massive mobs
    if (m.type === 'cactus' && p.hp < p.maxHp * 0.5) return true;
    return false;
  }
  // Zones: bots move up with their level (Medium from 13, Hard from 28, "?" from 43), without
  // waiting until they're nearly overleveled. They only hold back if badly under-equipped for
  // the next zone, and only turn back when they have nothing to fight with at all.
  function gear(p) {
    const inv = invOf(p);
    return { heals: inv.filter(isHeal).length, good: inv.filter(t => RANK[PETALS[t].rarity] >= RANK.rare).length,
      fair: inv.filter(t => t !== 'basic').length };
  }
  function ready(p, i) {
    const g = gear(p);
    if (i <= 0) return true;
    if (i === 1) return g.heals >= 1 && g.fair >= 3;
    if (i === 2) return g.heals >= 2 && g.good >= 2;
    return g.heals >= 2 && g.good >= 4;
  }
  function chooseZone(p) {
    const lvlIdx = ZONES.indexOf(api.zoneForLevel(p.level)), here = zoneIdxAt(p.x);
    const ok = i => i >= 0 && !(S.map.zones[i].maxLevel !== null && p.level >= S.map.zones[i].maxLevel);   // not overleveled
    let z = lvlIdx;
    if (!ready(p, z) && ok(z - 1)) {
      const g = gear(p), veryUnder = g.heals === 0 && g.good === 0;
      if (here < z || veryUnder) z = z - 1;                              // hold back (or, rarely, go back)
    }
    return z;
  }

  // ---------- Loadout: equip, heal-swap and sell ----------
  function planLoadout(p) {
    const b = p.brain, n = api.slotCount(p.level);
    const forceHeal = b.healing && (b.active || b.goal).heal === 'bench';
    b.plan = assign(b.active, n, invOf(p), forceHeal).out;
  }
  // One action at a time, like a player clicking: a swap, or selling one petal
  function stepLoadout(p) {
    const b = p.brain, plan = b.plan; if (!plan) return false;
    for (let i = 0; i < Math.min(plan.length, p.petals.length); i++) {
      const cur = p.petals[i] ? p.petals[i].type : null, want = plan[i];
      if (!want || cur === want) continue;
      const j = p.bench.indexOf(want);
      if (j >= 0) { api.swapSlots(p, { row: 'e', i }, { row: 'b', i: j }); return true; }
      const k = p.petals.findIndex((s, kk) => kk > i && s && s.type === want && plan[kk] !== want);
      if (k >= 0) { api.swapSlots(p, { row: 'e', i }, { row: 'e', i: k }); return true; }
    }
    // Sell anything it doesn't need straight away - selling drops is where most points come from.
    // Keeps: what its current build and goal build use, a couple of spare healing petals,
    // anything its build wants on the bench, and never sells Legendaries or Uniques.
    const n = api.slotCount(p.level), inv = invOf(p), keep = {};
    const need = t => { keep[t] = (keep[t] || 0) + 1; };
    assign(b.active, n, inv).out.forEach(t => t && need(t));
    const goalUse = {}; assign(b.goal, 8, inv).out.forEach(t => { if (t) goalUse[t] = (goalUse[t] || 0) + 1; });
    for (const [t, c] of Object.entries(goalUse)) keep[t] = Math.max(keep[t] || 0, c);
    for (const fam of [...(b.active.bench || []), ...(b.goal.bench || [])]) { const t = FAM[fam].petals.find(x => inv.includes(x)); if (t) need(t); }
    let heals = 0; for (const t of inv) if (isHeal(t)) heals++;
    const counts = {}; for (const t of inv) counts[t] = (counts[t] || 0) + 1;
    for (let i = 0; i < p.bench.length; i++) {
      const t = p.bench[i]; if (!t) continue;
      const d = PETALS[t];
      if (d.rarity === 'legendary' || d.rarity === 'unique') continue;
      if (counts[t] <= (keep[t] || 0)) continue;
      if (isHeal(t) && heals <= (keep.__h ?? 0) + 4) continue;              // ~2 Roses + a couple of spares
      api.trashSlot(p, { row: 'b', i }); return true;
    }
    // Always keep a bench spot free so it can pick up drops: if the bench is full of things
    // it's keeping, sell the least valuable one (never a Legendary or Unique)
    if (!p.bench.includes(null) && !p.petals.includes(null)) {
      const worst = p.bench.map((t, i) => ({ t, i })).filter(o => o.t && PETALS[o.t].rarity !== 'legendary' && PETALS[o.t].rarity !== 'unique')
        .sort((x, y) => petalValue(x.t) - petalValue(y.t))[0];
      if (worst) { api.trashSlot(p, { row: 'b', i: worst.i }); return true; }
    }
    return false;
  }

  // ---------- Fighting players ----------
  // A rough "how strong is this flower": health left (plus some for healing petals) times how
  // much damage its petals deal. A bot judges itself by its skill; a person counts as decent.
  function strength(o, skillF) {
    let dps = 0, heal = 0;
    for (const sl of o.petals || []) {
      if (!sl) continue; const d = PETALS[sl.type];
      dps += (d.damage || 0) * (d.count || 1) / Math.max(0.25, d.reload);
      if (d.heal) heal += d.heal * (d.count || 1); if (d.healPerSec) heal += d.healPerSec * 10;
    }
    return (o.hp + heal) * Math.max(5, dps) * skillF;
  }
  const winChance = (p, o) => { const a = strength(p, 0.6 + 0.8 * p.brain.skill.s), b = strength(o, 1); return a / (a + b); };
  // How sure of winning it needs to be to fight: a timid bot only fights when it's 75% sure,
  // an aggressive one takes on fights it has only a ~15% chance of winning
  const fightBar = sk => 0.75 - 0.6 * sk.aggr;
  // How close a player has to get before it reacts (aggressive bots come from further away)
  const noticeRange = sk => 260 + 420 * sk.aggr;

  // ---------- Thinking ----------
  const VIEW = 1100;                                                    // how far a bot "sees"
  function think(p, now, live) {
    const b = p.brain, sk = b.skill, hp = p.hp / p.maxHp;
    const near = [...mobs.values()].filter(m => !m.owner && Math.abs(m.x - p.x) < VIEW && Math.abs(m.y - p.y) < VIEW * 0.7);
    const threats = near.filter(m => m.target === p.id);
    b.attack = false; b.defend = false;

    // Hornet missiles: notices the ones heading at it and (maybe) sidesteps
    for (const s of projectiles.values()) {
      if (s.type !== 'hornetMissile' || b.dodge.has(s.id)) continue;
      const dx = p.x - s.x, dy = p.y - s.y, d = Math.hypot(dx, dy), v = Math.hypot(s.vx, s.vy) || 1;
      if (d > 420) continue;
      const along = (dx * s.vx + dy * s.vy) / v, miss = Math.abs(dx * s.vy - dy * s.vx) / v;
      if (along > 0 && miss < 55) {
        const ok = Math.random() < sk.dodge;
        b.dodge.set(s.id, ok);
        if (ok) { const side = (dx * s.vy - dy * s.vx) > 0 ? 1 : -1; b.dodgeDir = Math.atan2(s.vy, s.vx) + side * Math.PI / 2; b.dodgeUntil = now + 0.4; }
      }
    }
    if (b.dodge.size > 50) for (const id of b.dodge.keys()) if (!projectiles.has(id)) b.dodge.delete(id);

    // Healing break / running away
    // (a healing break that isn't working - e.g. no healing petals alive - ends after 30 s,
    // and it won't start another one for a while)
    if (b.healing && (hp >= 0.85 || now - b.healT > 30)) { if (hp < 0.85) b.noHealUntil = now + 25; b.healing = false; }
    const close = threats.filter(m => dist(m, p) < 450);
    const canHeal = !(b.noHealUntil > now);
    // Runs from: a swarm when hurt, anything when nearly dead, or a mob it's not ready for
    // (e.g. a Massive Beetle at a low level). One ordinary chaser it would rather fight - a
    // Beetle is about as fast as a flower, so running just gets it bitten from behind.
    // Bots clear out what follows them: they fight back, even taking some damage. They only run
    // when nearly dead and outnumbered, or from a Massive mob far too strong for them.
    const big = close.some(m => m.r > 60 && tooRisky(p, m) && m.hp > p.hp);
    if (close.length && ((hp < sk.flee && close.length >= 2) || hp < 0.08 || (big && sk.s > 0.3))) b.mode = 'flee';
    else if (b.mode === 'flee' && !threats.some(m => dist(m, p) < 650)) { b.mode = 'wander'; if (canHeal) { b.healing = true; b.healT = now; } }
    else if (!b.healing && canHeal && hp < sk.heal && !close.length) { b.healing = true; b.healT = now; }

    // Which zone to be in (rechecked every ~10 s), and what it wants
    if (now > b.zoneT) { b.want = wanted(p); b.zone = chooseZone(p); b.zoneT = now + 10; }
    const want = b.want || {};
    const myZone = zoneIdxAt(p.x), inZone = myZone === b.zone;

    b.target = null; b.goto = null; b.orbit = null;
    // A player close by? Fight if it thinks it can win (how sure it needs to be depends on how
    // aggressive it is), otherwise get away. Rechecked constantly, so a fight that turns bad
    // makes it run. Bots don't fight each other yet.
    let foe = null;
    for (const o of live) {
      if (o.bot || o === p || o.dead) continue;
      const d = dist(o, p), hitMe = b.hitBy === o.id && now - b.hitAt < 4;
      if (d < noticeRange(sk) || (hitMe && d < 700) || (b.foe === o.id && d < noticeRange(sk) * 1.6)) if (!foe || d < dist(foe, p)) foe = o;
    }
    b.foeAct = null;
    if (foe) {
      const ch = winChance(p, foe), fighting = b.foe === foe.id && b.foeMode === 'fight';
      const hitMe = b.hitBy === foe.id && now - b.hitAt < 6;
      if (fighting || hitMe) {
        // already in it (or you started it): fights on while the odds are good enough for its temper
        b.foeMode = ch >= fightBar(sk) - (fighting ? 0.08 : 0) ? 'fight' : 'run';
      } else {
        // You're just nearby. It only starts a fight when it's clearly stronger than you
        // (a super aggressive bot goes by its temper); if it would likely lose it keeps away,
        // otherwise it minds its own business
        const startBar = sk.aggr > 0.85 ? fightBar(sk) : Math.max(0.72, fightBar(sk));
        b.foeMode = ch >= startBar ? 'fight' : ch < 0.35 && dist(foe, p) < 320 ? 'run' : null;
      }
      if (b.foeMode) { b.foe = foe.id; b.foeAct = foe; } else b.foe = null;
      b.chance = ch;
    } else { b.foe = null; b.foeMode = null; }

    // Staying alive comes first: about to die -> get away from whatever is hurting it
    const dying = hp < 0.2 + 0.1 * sk.s;
    if (dying && b.foeAct && b.foeMode === 'fight') {                   // no new or continued fights while nearly dead
      if (dist(b.foeAct, p) < 900) b.foeMode = 'run'; else { b.foeMode = null; b.foeAct = null; b.foe = null; }
    }
    const danger = [...close, ...(b.foeAct && dist(b.foeAct, p) < 700 ? [b.foeAct] : []), ...(b.hitBy && now - b.hitAt < 3 ? live.filter(o => o.id === b.hitBy) : [])];
    if (dying && danger.length) { b.mode = 'flee'; b.foeAct = null; b.foeMode = null; b.fleeFrom = danger; }
    else b.fleeFrom = null;

    if (b.mode !== 'flee' && b.foeAct && b.foeMode === 'fight') {
      // circle the player at petal range with petals out (it can hit and bump them like anyone)
      b.mode = 'pvp';
      b.orbit = { m: b.foeAct, D: S.petals.attackRadius - 6 + rand(-1, 1) * sk.aimErr * 0.6 };
      b.attack = true;
    } else if (b.foeAct && b.foeMode === 'run') {
      // get away from the player; swing if they're right on it, pop a Bubble if it has one
      b.mode = 'escape';
      const o = b.foeAct, d = dist(o, p) || 1;
      b.goto = { x: p.x + (p.x - o.x) / d * 600, y: p.y + (p.y - o.y) / d * 600 };
      if (d < 180) b.attack = true; else b.defend = true;
      bubbleEscape(p, [o]);
    } else if (p.overleveled && b.zone !== myZone) {
      // Overleveled: head straight for the zone it should be in (its petals will die if it
      // stays), swinging only at things right on it
      b.mode = 'travel';
      const [zx0, zx1] = zoneBounds[ZONES[b.zone]];
      b.goto = { x: clamp(p.x, zx0 + 800, zx1 - 800) === p.x ? zx0 + 1200 : clamp(p.x, zx0 + 800, zx1 - 800),
        y: ZONES[b.zone] === '?' ? MAP_H * 0.85 : clamp(p.y, 500, MAP_H - 500) };
      if (threats.some(m => dist(m, p) < m.r + 220)) b.attack = true;
    } else if (b.mode === 'flee') {
      // run away from whatever is chasing, towards easier ground; pop a Bubble on the threat's side
      let fx = 0, fy = 0;
      for (const m of b.fleeFrom || threats) { const d = dist(m, p) || 1; fx += (p.x - m.x) / d; fy += (p.y - m.y) / d; }
      const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
      // lean towards the zone it should be in (not back into one it's too high a level for)
      const [zx0, zx1] = zoneBounds[ZONES[b.zone]];
      const cx = clamp(p.x, zx0 + 500, zx1 - 500);
      const pull = (p.olT || 0) < 20 ? -0.5 : cx === p.x ? 0 : Math.sign(cx - p.x) * 0.8;   // easier ground is to the left
      fx += pull; fy += (MAP_H / 2 - p.y) / MAP_H * 0.6;
      const a = Math.atan2(fy, fx);
      b.goto = { x: p.x + Math.cos(a) * 600, y: p.y + Math.sin(a) * 600 };
      bubbleEscape(p, b.fleeFrom || threats);                           // any Bubble on the chaser's side gets popped
      if ((b.fleeFrom || threats).some(m => dist(m, p) < (m.r || 25) + 260)) b.attack = true;   // keep swinging at whatever is close
      else b.defend = true;                                              // otherwise petals in to shield
    } else if (threats.length) {
      b.mode = 'fight'; b.target = threats.sort((x, y) => dist(x, p) - dist(y, p))[0];
      b.kite = threats.length > sk.pull ? threats : null;               // too many: fight while backing off
    } else if ((b.prize = prizeDrop(p, near))) {
      // Something good on the ground (like the petals a flower drops when it dies): go get it,
      // even mid healing break - Roses keep working on the way
      b.mode = 'loot'; b.goto = { x: b.prize.x, y: b.prize.y };
    } else if (b.healing && inZone && !p.overleveled) {
      b.mode = 'heal';
      // drift away from nearby mobs while Roses/Leaves do their work
      let fx = 0, fy = 0;
      for (const m of near) { const d = dist(m, p) || 1; if (d < 500) { fx += (p.x - m.x) / d; fy += (p.y - m.y) / d; } }
      if (fx || fy) b.goto = { x: p.x + fx * 200, y: p.y + fy * 200 };
      else {
        const [zx0, zx1] = zoneBounds[ZONES[b.zone]];
        if (!b.way || dist(b.way, p) < 200 || now > b.wayT) { b.way = { x: rand(zx0 + 400, zx1 - 400), y: rand(400, MAP_H - 400) }; b.wayT = now + 25; }
        b.goto = b.way;
      }
    } else {
      // Loot: pick up anything nearby (sells the junk later)
      const free = p.petals.includes(null) || p.bench.includes(null) || p.bench.some(t => t && PETALS[t].rarity !== 'legendary' && PETALS[t].rarity !== 'unique');
      let loot = null, ld = 800;
      if (free) for (const d of drops.values()) { const dd = dist(d, p); if (dd < ld && !near.some(m => MOBS[m.type].stationary && dist(m, d) < m.r + 40)) { ld = dd; loot = d; } }
      if (loot) { b.mode = 'loot'; b.goto = { x: loot.x, y: loot.y }; }
      else if (!inZone || p.overleveled) {
        // travel to the chosen zone (through the bottom of Hard on the way to "?")
        b.mode = 'travel';
        const [zx0, zx1] = zoneBounds[ZONES[b.zone]];
        const tx = clamp(p.x, zx0 + 600, zx1 - 600);
        const ty = ZONES[b.zone] === '?' && myZone < b.zone ? MAP_H * 0.85 : p.y;
        b.goto = { x: tx === p.x ? (zx0 + zx1) / 2 : tx, y: ty };
        // still fights small things in the way
        const inWay = near.filter(m => dist(m, p) < 300 && !MOBS[m.type].stationary && !tooRisky(p, m));
        if (inWay.length) { b.mode = 'fight'; b.target = inWay[0]; b.goto = null; }
      } else {
        // Farm: the best mob in view, closer is better, risky ones skipped
        let best = null, bv = 0;
        const aggro = near.filter(m => MOBS[m.type].aggroRange);
        const crowd = m => aggro.filter(o => o !== m && dist(o, m) < 650).length;   // others it would wake up
        for (const m of near) {
          if (zoneIdxAt(m.x) !== b.zone || tooRisky(p, m)) continue;
          if (live.some(o => o !== p && dist(o, m) < 220 - sk.s * 80)) continue;   // someone else is on it
          const c = crowd(m); if (c > sk.pull + 1) continue;             // pull a few at a time, not a swarm
          // bunched-up mobs are worth more: spinning petals hit several at once
          let bunch = 0; for (const o of near) if (o !== m && !MOBS[o.type].aggroRange && Math.abs(o.x - m.x) < 220 && Math.abs(o.y - m.y) < 220) bunch += mobValue(o.type, want, p, 0) * 0.6;
          const v = (mobValue(m.type, want, p, dist(m, p)) + bunch) / (1 + c * 1.5);
          if (v > bv) { bv = v; best = m; }
        }
        if (best) { b.mode = 'fight'; b.target = best; }
        else {
          b.mode = 'wander';
          const [zx0, zx1] = zoneBounds[ZONES[b.zone]];
          if (!b.way || dist(b.way, p) < 200 || now > b.wayT || zoneIdxAt(b.way.x) !== b.zone)
          {                                                               // of a few random spots, the one with fewest aggressive mobs
            let bestW = null, bc = 1e9;
            for (let k = 0; k < 6; k++) {
              const w = { x: rand(zx0 + 400, zx1 - 400), y: rand(400, MAP_H - 400) };
              let c = 0; for (const m of mobs.values()) if (MOBS[m.type].aggroRange && !m.owner && Math.abs(m.x - w.x) < 700 && Math.abs(m.y - w.y) < 700) c++;
              if (c < bc) { bc = c; bestW = w; }
            }
            b.way = bestW; b.wayT = now + 25;
          }
          b.goto = b.way;
        }
      }
    }

    // Fighting: circle the mob just inside petal reach, attack while petals are loaded,
    // back off while they reload (unless it's a slow/stationary mob)
    if (b.target) {
      const m = b.target, def = MOBS[m.type];
      const ring = p.ring || [], loaded = ring.length ? ring.filter(([, q]) => q.alive).length / ring.length : 1;
      // Keep the mob right on the ring the petals sweep when spread out (130 px from the flower),
      // circling it - steered every tick in steer(), like a player tracking it with the mouse.
      // If it closes in, the same steering backs away so it keeps running into the petals.
      let D = Math.max(S.petals.attackRadius - 4, m.r + S.flower.radius + 28) + rand(-1, 1) * sk.aimErr * 0.6;
      if (m.target === p.id && !def.stationary) D += m.r * 0.6 * (0.5 + sk.s * 0.5);   // a chaser: keep it at the far edge of petal reach
      b.orbit = { m, D };
      b.goto = null; b.backoff = 0;
      if (b.kite) {                                                       // several chasing: back off while swinging
        let fx = 0, fy = 0;
        for (const o of b.kite) { const d = dist(o, p) || 1; fx += (p.x - o.x) / d; fy += (p.y - o.y) / d; }
        const fl = Math.hypot(fx, fy) || 1;
        b.goto = { x: p.x + fx / fl * 300, y: p.y + fy / fl * 300 };
        b.kite = null; b.orbit = null;
      }
      // petals stay spread out the whole time it's working a mob (beginners sometimes forget)
      b.attack = dist(m, p) < D + 300 && (m.target === p.id || dist(m, p) < D + 60 || Math.random() >= sk.sloppy);
      if (Math.random() < 0.01) b.circle *= -1;
      // single-shot petals (Missile, Dandelion): only fire when one is pointing at the target
      const shooters = ring.filter(([t, q]) => q.alive && PETALS[t].shoot && PETALS[t].shoot.single);
      if (shooters.length && dist(m, p) > 220 && dist(m, p) < 650) {
        const ta = Math.atan2(m.y - p.y, m.x - p.x);
        b.attack = shooters.some(([, q]) => Math.abs(angDiff(Math.atan2(q.y - p.y, q.x - p.x), ta)) < sk.shotTol);
      }
    }

    // Steering wobble (worse players wobble more)
    b.noise = clamp(b.noise + rand(-1, 1) * sk.angNoise, -sk.angNoise * 2, sk.angNoise * 2);
  }

  // The best rare-or-better drop within reach (worth walking further for), if it has room
  function prizeDrop(p, near) {
    const free = p.petals.includes(null) || p.bench.includes(null) || p.bench.some(t => t && PETALS[t].rarity !== 'legendary' && PETALS[t].rarity !== 'unique');
    if (!free) return null;
    let best = null, bv = 0;
    for (const d of drops.values()) {
      const r = RANK[PETALS[d.type].rarity]; if (r < RANK.rare) continue;
      const dd = dist(d, p); if (dd > 1500) continue;
      if (near.some(m => MOBS[m.type].stationary && dist(m, d) < m.r + 40)) continue;
      const v = (r + 1) / (1 + dd / 500);
      if (v > bv) { bv = v; best = d; }
    }
    return best;
  }

  // Bubble escape: pop when a Bubble is between the bot and what's chasing it
  function bubbleEscape(p, threats) {
    if (!threats.length) return;
    const m = threats[0], ta = Math.atan2(m.y - p.y, m.x - p.x);
    for (const [t, q] of p.ring || []) if (q.alive && PETALS[t].bubble && Math.abs(angDiff(Math.atan2(q.y - p.y, q.x - p.x), ta)) < 0.6) { p.brain.pop = true; return; }
  }

  // Turn the plan into this tick's inputs
  function steer(p, now, live) {
    const b = p.brain, inp = p.input;
    let gx = 0, gy = 0, mag = 0;
    if (b.dodgeUntil > now) { gx = Math.cos(b.dodgeDir); gy = Math.sin(b.dodgeDir); mag = 1; }
    else if (b.orbit && (mobs.has(b.orbit.m.id) || (b.orbit.m.joined && !b.orbit.m.dead))) {
      // circle the target at petal range: sideways along the circle, plus in/out to hold the distance
      const m = b.orbit.m, d = dist(m, p) || 1, ux = (p.x - m.x) / d, uy = (p.y - m.y) / d;
      const radial = clamp((b.orbit.D - d) / 30, -3, 3);
      gx = ux * radial - uy * b.circle; gy = uy * radial + ux * b.circle;
      const gl = Math.hypot(gx, gy) || 1; gx /= gl; gy /= gl; mag = 1;
    }
    else if (b.goto) {
      const dx = b.goto.x - p.x, dy = b.goto.y - p.y, d = Math.hypot(dx, dy);
      if (d > 8) { gx = dx / d; gy = dy / d; mag = b.mode === 'heal' ? 0.7 : b.backoff ? b.backoff : b.mode === 'fight' ? clamp(d / 50, 0.8, 1) : clamp(d / 100, 0.6, 1); }
    }
    // don't walk into mobs (a Bee does 50 damage on touch)
    for (const m of mobs.values()) {
      if (m.owner || MOBS[m.type].stationary && m.type !== 'cactus') continue;
      const d = dist(m, p), g = m.r + S.flower.radius + 45;
      if (d < g && d > 0) { const k = (g - d) / g * 2.5; gx += (p.x - m.x) / d * k; gy += (p.y - m.y) / d * k; mag = Math.max(mag, 0.8); }
    }
    // steer clear of aggressive mobs it isn't ready for, so it doesn't wake them up
    if (b.mode !== 'fight' || !b.target || b.target.target !== p.id) for (const m of mobs.values()) {
      const def = MOBS[m.type];
      if (!def.aggroRange || m.owner || m.target === p.id || !tooRisky(p, m)) continue;
      const d = dist(m, p), g = def.aggroRange + 150;
      if (d < g && d > 0) { const k = (g - d) / g * 1.6; gx += (p.x - m.x) / d * k; gy += (p.y - m.y) / d * k; mag = Math.max(mag, 0.7); }
    }
    // keep away from other flowers (bots don't fight) and don't brush against cacti
    for (const o of live) {
      if (o === p || (b.mode === 'pvp' && o === b.foeAct)) continue;     // (not the player it's fighting)
      const d = dist(o, p); if (d < 320 && d > 0) { gx += (p.x - o.x) / d * (320 - d) / 320 * 1.2; gy += (p.y - o.y) / d * (320 - d) / 320 * 1.2; mag = Math.max(mag, 0.6); }
    }
    for (const m of mobs.values()) {
      if (m.type !== 'cactus' || m === b.target) continue;
      const d = dist(m, p), g = m.r + (b.mode === 'flee' ? 150 : 70); if (d < g && d > 0) { gx += (p.x - m.x) / d * 1.5; gy += (p.y - m.y) / d * 1.5; mag = Math.max(mag, 0.6); }
    }
    // stay off the map edge
    const e = 150;
    if (p.x < e) gx += 1; if (p.x > MAP_W - e) gx -= 1; if (p.y < e) gy += 1; if (p.y > MAP_H - e) gy -= 1;
    inp.angle = Math.atan2(gy, gx) + b.noise;
    inp.mag = (gx || gy) ? mag : 0;
    inp.attack = !!b.attack;
    inp.defend = !!b.defend || !!b.pop;
    b.pop = false;
  }

  // ---------- Every tick ----------
  let manageT = 0;
  function update(now, live) {
    // keep the number of bots right
    if (now > manageT) {
      manageT = now + 1;
      const want = (S.bots && S.bots.count) ?? BS.count;
      while (bots.length < want) addBot();
      while (bots.length > want) { const p = bots.pop(); players.delete(p.id); }
    }
    for (const p of bots) {
      const b = p.brain;
      if (p.dead) {                                                      // respawn like a player would
        if (!b.respawnAt) b.respawnAt = now + 3;                         // back 3 seconds after dying
        if (now >= b.respawnAt) {
          b.respawnAt = 0; api.spawn(p, null);
          if (Math.random() < 0.5) b.goal = pickGoal(p, b.skill);
          b.active = null; b.mode = 'wander'; b.healing = false; b.zoneT = 0; b.way = null;
        }
        continue;
      }
      if (!b.active || now > b.equipT) {                                 // rethink build + loadout
        b.active = chooseActive(p); planLoadout(p); b.dps = dpsOf(p);
        b.equipT = now + b.skill.equipT * rand(0.8, 1.2);
      }
      if (b.mode !== 'flee' && now > b.actT) {                           // one petal action at a time
        if (stepLoadout(p)) b.actT = now + b.skill.actionT * rand(0.8, 1.3);
      }
      if (b.target && !mobs.has(b.target.id)) { b.target = null; b.orbit = null; b.thinkT = Math.min(b.thinkT, b.skill.reaction * 0.4); }
      b.thinkT -= DT;
      if (b.thinkT <= 0) { think(p, now, live); b.thinkT = b.skill.reaction * rand(0.7, 1.3); if (b.healing !== b.wasHealing) { b.wasHealing = b.healing; planLoadout(p); } }
      steer(p, now, live);
    }
  }

  return { update, list: () => bots, GOALS, STEP, assign, slotsFor };
};
