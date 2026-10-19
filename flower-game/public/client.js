// ===== Flower Game client =====
// Draws the world, animates it smoothly, and sends your controls to the server.
const cv = document.getElementById('game');
const mainCtx = cv.getContext('2d');
let ctx = mainCtx;            // swapped temporarily when drawing gallery icons
const $ = id => document.getElementById(id);
const TAU = Math.PI * 2;
const now = () => performance.now() / 1000;
const FLASH = 0.75;         // how red a hit flash starts (0..1); fades in ~0.12s

let ws, myId = null, MAP = null, PETALS = {}, MOBDEFS = {}, FR = 25, SPIN = 2.5, ZOOM = 0.85;
const sview = {};             // pea projectiles
let wview = [];               // web patches on the ground
let zoomCur = null;           // eases toward the target zoom (Antennae widen the view)
let state = { players: [], mobs: [], drops: [], me: null };
let death = null;                       // { by, t } while the death screen is up
let paused = null;                      // { by } while someone has paused the game
const PAUSE_BTN = { x: 16, y: 16, s: 48 }; // pause button, top left
const onPauseBtn = (x, y) => x >= PAUSE_BTN.x && x <= PAUSE_BTN.x + PAUSE_BTN.s && y >= PAUSE_BTN.y && y <= PAUSE_BTN.y + PAUSE_BTN.s;
const view = {}, mview = {}, dview = {}; // smoothed players / mobs / drops
const ghosts = [];                      // fading-out mobs, drops flying to a flower
const cam = { x: 0, y: 0 };
const input = { mx: innerWidth / 2, my: innerHeight / 2, mouseL: false, mouseR: false, keys: {} };

function resize() {
  cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio;
  cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();

// ---------- Connect ----------
function join() {
  if (ws && ws.readyState <= 1) return;
  const name = $('name').value;
  document.activeElement.blur();
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ t: 'join', name, start: takeCustomStart() }));
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.t === 'init') { myId = m.id; MAP = m.map; PETALS = m.petals; MOBDEFS = m.mobs; FR = m.flowerRadius; SPIN = m.spin; ZOOM = m.zoom || 1; irisOpen(); }
    else if (m.t === 's') onState(m);
    else if (m.t === 'dead') death = { by: m.by, t: now(), level: m.level, keep: m.keep || [], slots: m.slots || 5 };
    else if (m.t === 'pause') paused = m.on ? { by: m.by } : null;
    else if (m.t === 'pick' && m.row !== 'e') inv.pops[m.slot] = now() + 0.18;   // bench slot pops in as the drop arrives
  };
  ws.onclose = () => {
    homeAfterDeath = null; death = null; myId = null; paused = null;              // so Play joins again instead of waiting for a respawn
    showTitle(); $('title').querySelector('h1').textContent = 'Disconnected'; updateSpawnInfo();
  };
}
// Play: first time joins; after a death it brings you back with what you kept
const play = () => {
  if (homeAfterDeath) { send({ t: 'respawn', name: $('name').value, start: takeCustomStart() }); homeAfterDeath = null; irisOpen(); }
  else join();
};
$('play').onclick = play;
$('name').onkeydown = e => { if (e.key === 'Enter') play(); };
const send = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
// Death screen -> Enter/click goes back to the home screen, which shows what you'll respawn with
let homeAfterDeath = null;
function respawn() {
  if (!death || now() - death.t <= 0.6) return;
  homeAfterDeath = death; death = null;
  showTitle(); $('title').querySelector('h1').textContent = 'Petal Arena';
  updateSpawnInfo();
  $('name').focus();
}
// Under the Play button: what you'll spawn with - a saved custom start, or what you kept
// after dying. Only real petals are shown (no empty boxes).
function updateSpawnInfo() {
  const el = $('spawnInfo'); el.innerHTML = '';
  let level, load, bench;
  if (startCfg.armed) {
    level = startCfg.level; const n = slotsFor(level);
    load = startCfg.petals.slice(0, n).filter(Boolean); bench = startCfg.bench.filter(Boolean);
  } else if (homeAfterDeath && homeAfterDeath.level) {
    level = homeAfterDeath.level; const n = homeAfterDeath.slots;
    load = homeAfterDeath.keep.slice(0, n); bench = homeAfterDeath.keep.slice(n);
  } else { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const h = document.createElement('div'); h.textContent = `You will ${homeAfterDeath ? 're' : ''}spawn at level ${level} with:`; el.appendChild(h);
  const row = (types, size) => { if (!types.length) return; const r = document.createElement('div'); r.className = 'prow rrow';
    types.forEach(t => r.appendChild(iconCanvas(size, s => drawSlotBox(0, 0, s, t)))); el.appendChild(r); };
  row(load, 52); row(bench, 40);
  if (!load.length && !bench.length) { const n = document.createElement('div'); n.className = 'mnote'; n.textContent = 'no petals'; el.appendChild(n); }
}
// Title screen in / out. Leaving it, the game opens up through a growing circle.
function showTitle() { const t = $('title'); t.style.webkitMaskImage = t.style.maskImage = ''; t.classList.remove('hidden'); }
function irisOpen() {
  const t = $('title'), t0 = performance.now(), dur = 650, far = Math.hypot(innerWidth, innerHeight) / 2 + 40;
  $('startModal').classList.add('hidden');
  const step = ts => {
    const k = Math.min(1, (ts - t0) / dur), r = far * (1 - Math.pow(1 - k, 3));
    const m = `radial-gradient(circle at 50% 50%, transparent ${r}px, #000 ${r + 2}px)`;
    t.style.webkitMaskImage = t.style.maskImage = m;
    if (k < 1) requestAnimationFrame(step); else { t.classList.add('hidden'); t.style.webkitMaskImage = t.style.maskImage = ''; }
  };
  requestAnimationFrame(step);
}

// ---------- Incoming state: detect hits, deaths, pickups ----------
function onState(m) {
  const t = now();
  for (const p of m.players) {
    let v = view[p.id];
    if (!v) v = view[p.id] = { x: p.x, y: p.y, ang: p.pa, pr: p.pr, hp: p.hp, lastHp: p.hp, flash: 0, rf: {} };
    if (p.f && !p.d) v.flash = FLASH;
    if (p.d && !v.deadT) v.deadT = t;
    if (!p.d) v.deadT = 0;
    v.lastHp = p.hp;
  }
  const seen = new Set();
  for (const a of m.mobs) {
    const [id, type, x, y, ang, hp, r, head, fl] = a;
    seen.add(id);
    let v = mview[id];
    if (!v) v = mview[id] = { id, type, x, y, ang, hp, r, head, flash: 0, born: t };
    if (fl) v.flash = FLASH;
    Object.assign(v, { tx: x, ty: y, tang: ang, thp: hp, r, head });
  }
  for (const id in mview) if (!seen.has(+id)) { const v = mview[id]; v.flash = FLASH; ghosts.push({ kind: 'mob', v, t0: t }); delete mview[id]; }

  wview = m.webs || [];
  const sseen = new Set();
  for (const [id, type, x, y, ang] of m.shots || []) {
    sseen.add(id);
    if (!sview[id]) sview[id] = { type, x, y, ang: ang || 0 };
    sview[id].tx = x; sview[id].ty = y;
  }
  for (const id in sview) if (!sseen.has(+id)) delete sview[id];
  const dseen = new Set();
  for (const [id, type, x, y, left, ox, oy] of m.drops) {
    dseen.add(id);
    if (!dview[id]) dview[id] = { id, type, x, y, ox: ox ?? x, oy: oy ?? y, born: t };
    dview[id].left = left;
  }
  for (const id in dview) if (!dseen.has(+id)) {
    const d = dview[id];
    // Picked up? fly into the nearest flower. Otherwise just fade.
    let best = null, bd = 90 * 90;
    for (const p of m.players) { const dd = (p.x - d.x) ** 2 + (p.y - d.y) ** 2; if (!p.d && dd < bd) { bd = dd; best = p.id; } }
    ghosts.push({ kind: best ? 'fly' : 'fade', d, to: best, t0: t });
    delete dview[id];
  }
  // New items landing in my bench pop in
  if (state.me && m.me) m.me.bench.forEach((b, i) => { if (b && !state.me.bench[i] && !inv.pops[i] && !inv.animTo('b', i)) inv.pops[i] = t; });
  state = m;
}

// ---------- Inventory ----------
// Slot colours as in the original (fill, then the border = fill darkened to 80%)
const RARITY = {
  common: ['#7eef6d', '#65bf57'], unusual: ['#ffe65d', '#ccb84a'], rare: ['#5d4de2', '#4a3eb5'],
  epic: ['#861fde', '#6b19b2'], legendary: ['#de1f1f', '#b21919'], unique: ['#ff2b75', '#cc225e'],
};
const SLOT_ALPHA = 0.85;
const inv = {
  open: false, sel: -1, press: null, drag: null, L: null, anims: [], pops: {},
  animTo(row, i) { return this.anims.some(a => a.toRow === row && a.toI === i && now() < a.t0 + a.dur); },
};
const inRect = (x, y, r) => x >= r.x && x <= r.x + (r.w ?? r.s) && y >= r.y && y <= r.y + (r.h ?? r.s);
function invLayout(W, H) {
  const eqN = state.me.slots.length, bN = state.me.bench.length;
  // Sizes follow the original: everything scales with the window height (1080p numbers)
  const u = uiScale(H), es = 70 * u, eg = 20 * u, bs = 50 * u, bg = 15 * u, hintH = 34 * u;
  const by = H - 94 * u, ey = H - 180 * u;
  const eqW = eqN * es + (eqN - 1) * eg, bW = (bN + 1) * bs + bN * bg, maxW = Math.max(eqW, bW);
  const eq = [], bench = [];
  for (let i = 0; i < eqN; i++) eq.push({ row: 'e', i, x: W / 2 - eqW / 2 + i * (es + eg), y: ey, s: es });
  for (let i = 0; i < bN; i++) bench.push({ row: 'b', i, x: W / 2 - bW / 2 + i * (bs + bg), y: by, s: bs });
  return {
    eq, bench, trash: { row: 't', x: W / 2 - bW / 2 + bN * (bs + bg), y: by, s: bs },
    hint: { x: W / 2 - 148 * u, y: H - hintH, w: 296 * u, h: hintH },
    panel: { x: W / 2 - maxW / 2 - 40, y: ey - 24, w: maxW + 80, h: H - ey + 24 },
  };
}
const rectOf = (row, i) => row === 'e' ? inv.L.eq[i] : row === 'b' ? inv.L.bench[i] : inv.L.trash;
function slotAt(x, y) { const L = inv.L; if (!L) return null; for (const r of [...L.eq, ...L.bench, L.trash]) if (inRect(x, y, r)) return r; return null; }
const slotType = (row, i) => row === 'e' ? (state.me.slots[i] || [])[0] : row === 'b' ? state.me.bench[i] : null;

// Animate petals sliding between slots, then tell the server
// dragged = the petal from slot a was dropped by hand, so it lands instantly (no slide)
function doSwap(a, b, dragged = false) {
  const ta = slotType(a.row, a.i), tb = slotType(b.row, b.i);
  if (!ta && !tb) return;
  const t = now(), A = rectOf(a.row, a.i), B = rectOf(b.row, b.i);
  if (ta && !dragged) inv.anims.push({ type: ta, from: A, to: B, toRow: b.row, toI: b.i, t0: t, dur: 0.16 });
  if (tb) inv.anims.push({ type: tb, from: B, to: A, toRow: a.row, toI: a.i, t0: t, dur: 0.16 });
  inv.hide = dragged ? { [a.row + a.i]: t + 0.16 } : { [a.row + a.i]: t + 0.16, [b.row + b.i]: t + 0.16 };
  send({ t: 'swap', a: { row: a.row, i: a.i }, b: { row: b.row, i: b.i } });
  // Update our copy right away so the selection below sticks before the server replies
  const set = (row, i, type) => {
    if (row === 'e') state.me.slots[i] = type ? [type, 0] : null; else state.me.bench[i] = type || null;
  };
  set(a.row, a.i, tb); set(b.row, b.i, ta);
  // A petal that was just subbed out to the bench becomes selected (and shakes)
  const benchSide = a.row === 'b' ? a : b.row === 'b' ? b : null, eqSide = a.row === 'e' ? a : b.row === 'e' ? b : null;
  if (benchSide && eqSide) {
    if (state.me.bench[benchSide.i]) { inv.sel = benchSide.i; inv.selT = t; } else inv.sel = -1;
  }
}
function doTrash(s, dragged = false) {
  const type = slotType(s.row, s.i); if (!type) return;
  const t = now();
  if (!dragged) inv.anims.push({ type, from: rectOf(s.row, s.i), to: inv.L.trash, toRow: 't', toI: 0, t0: t, dur: 0.16, shrink: true });
  inv.hide = { [s.row + s.i]: t + 0.2 };
  send({ t: 'trash', s: { row: s.row, i: s.i } });
}
// Q/E: first press selects the leftmost bench petal; then Q steps left, E steps right,
// both wrapping around the ends.
function cycleSel(dir) {
  const filled = state.me.bench.map((t, i) => t ? i : -1).filter(i => i >= 0);
  inv.selT = now();
  if (!filled.length) { inv.sel = -1; return; }
  const pos = filled.indexOf(inv.sel);
  if (pos < 0) { inv.sel = filled[0]; return; }
  inv.sel = filled[((pos + dir) % filled.length + filled.length) % filled.length];
}
// After trashing the selected petal, the next one to the right (or wrapping to the
// leftmost) becomes selected, so Q T T T quick-sells a row.
function selectAfterTrash(i) {
  const filled = state.me.bench.map((t, k) => t && k !== i ? k : -1).filter(k => k >= 0);
  inv.sel = filled.length ? (filled.find(k => k > i) ?? filled[0]) : -1;
  inv.selT = now();
}

// ---------- Controls ----------
addEventListener('mousemove', e => {
  input.mx = e.clientX; input.my = e.clientY;
  if (inv.press && !inv.drag && Math.hypot(e.clientX - inv.press.x, e.clientY - inv.press.y) > 6) inv.drag = inv.press;
});
cv.addEventListener('mousedown', e => {
  if (!death && state.me && !homeAfterDeath && e.button === 0 && onPauseBtn(e.clientX, e.clientY)) { send({ t: 'pause' }); return; }
  if (death) { respawn(); return; }
  if (e.button === 0) {                                     // petals can be grabbed any time
    const r = slotAt(e.clientX, e.clientY);
    if (r && r.row !== 't' && slotType(r.row, r.i)) { inv.press = { row: r.row, i: r.i, type: slotType(r.row, r.i), x: e.clientX, y: e.clientY }; return; }
    if (inv.open) return;
  }
  if (e.button === 0) input.mouseL = true; if (e.button === 2) input.mouseR = true;
});
addEventListener('mouseup', e => {
  if (e.button === 0 && inv.press) {
    const from = { row: inv.press.row, i: inv.press.i }, r = slotAt(e.clientX, e.clientY);
    if (inv.drag) {                                          // dragged: drop on a slot or the trash
      if (r && r.row === 't') doTrash(from, true);
      else if (r && !(r.row === from.row && r.i === from.i)) doSwap(from, r, true);
    } else {                                                 // clicked: swap with the slot above/below
      const other = from.row === 'b' ? { row: 'e', i: from.i } : { row: 'b', i: from.i };
      if (other.i < (other.row === 'e' ? state.me.slots.length : state.me.bench.length)) doSwap(from, other);
    }
    inv.press = inv.drag = null;
  }
  if (e.button === 0) input.mouseL = false; if (e.button === 2) input.mouseR = false;
});
addEventListener('contextmenu', e => e.preventDefault());
addEventListener('keydown', e => {
  if (document.activeElement.tagName === 'INPUT') return;
  if (['Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
  input.keys[e.code] = true;
  if (e.repeat || !state.me) return;
  if (death) { if (e.code === 'Enter') respawn(); return; }
  if (e.code === 'KeyE') cycleSel(1);
  else if (e.code === 'KeyQ') cycleSel(-1);
  else if (e.code === 'KeyX') {
    const n = Math.min(state.me.slots.length, state.me.bench.length);
    for (let i = 0; i < n; i++) { const A = rectOf('e', i), B = rectOf('b', i), t = now();
      const ta = slotType('e', i), tb = slotType('b', i);
      if (ta) inv.anims.push({ type: ta, from: A, to: B, toRow: 'b', toI: i, t0: t, dur: 0.16 });
      if (tb) inv.anims.push({ type: tb, from: B, to: A, toRow: 'e', toI: i, t0: t, dur: 0.16 }); }
    inv.hide = { all: now() + 0.16 };
    send({ t: 'swapAll' });
  }
  else if (e.code === 'KeyT' && inv.sel >= 0 && state.me.bench[inv.sel]) {
    const i = inv.sel; doTrash({ row: 'b', i });
    state.me.bench[i] = null;                       // update locally so fast T presses chain
    selectAfterTrash(i);
  }
  else if (/^Digit[1-8]$/.test(e.code)) {
    const i = +e.code.slice(5) - 1;
    if (i >= state.me.slots.length) return;
    // Number N swaps loadout slot N with: the selected bench petal, otherwise the
    // leftmost bench petal, otherwise (empty bench) it just moves down to the first open spot.
    const bench = state.me.bench;
    let bi = inv.sel >= 0 && bench[inv.sel] ? inv.sel : bench.findIndex(Boolean);
    if (bi < 0) { if (!slotType('e', i)) return; bi = bench.indexOf(null); }
    if (bi < 0) return;
    doSwap({ row: 'b', i: bi }, { row: 'e', i });
  }
});
addEventListener('keyup', e => { input.keys[e.code] = false; });
addEventListener('blur', () => { input.keys = {}; input.mouseL = input.mouseR = false; });

let lastSent = '';
setInterval(() => {
  if (!ws || ws.readyState !== 1 || myId === null) return;
  const k = input.keys;
  const kx = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0);
  const ky = (k.KeyS || k.ArrowDown ? 1 : 0) - (k.KeyW || k.ArrowUp ? 1 : 0);
  let a, m;
  if (kx || ky) { a = Math.atan2(ky, kx); m = 1; }
  else {
    const dx = input.mx - innerWidth / 2, dy = input.my - innerHeight / 2;
    a = Math.atan2(dy, dx); m = Math.min(1, Math.hypot(dx, dy) / 150);
    if (m < 0.08 || inv.open) m = 0;
  }
  const z = zoomCur || ZOOM;                         // how much world your screen shows (used for the curse)
  const msg = JSON.stringify({ t: 'in', a: +a.toFixed(3), m: +m.toFixed(2),
    at: input.mouseL || k.Space ? 1 : 0, df: input.mouseR || k.ShiftLeft || k.ShiftRight ? 1 : 0,
    vw: Math.round(innerWidth / z / 2 / 25) * 25, vh: Math.round(innerHeight / z / 2 / 25) * 25 });
  if (msg !== lastSent) { ws.send(msg); lastSent = msg; }
}, 1000 / 30);

// ---------- Math / color helpers ----------
const angDiff = (a, b) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const rgbCache = {};
function rgb(h) {
  if (rgbCache[h]) return rgbCache[h];
  const n = parseInt(h.slice(1), 16);
  return (rgbCache[h] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]);
}
// Blend a color toward hit-red by amount f (0..1) — used for damage flashes
function shade(h, f) { const [r, g, b] = rgb(h); return `rgb(${r * f | 0},${g * f | 0},${b * f | 0})`; }
function col(h, f) {
  if (!f) return h;
  const [r, g, b] = rgb(h);
  return `rgb(${r + (255 - r) * f | 0},${g + (60 - g) * f | 0},${b + (60 - b) * f | 0})`;
}
function seeded(id) { let s = id * 9301 + 49297; return () => ((s = (s * 9301 + 49297) % 233280) / 233280); }
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const uiScale = H => Math.max(0.6, Math.min(1.3, H / 1080));
// Ubuntu Bold, white with a dark outline - the original's lettering (petal slots, level bar)
function labelU(text, x, y, size, align = 'center', maxW = 0) {
  ctx.font = `700 ${size}px Ubuntu, system-ui, sans-serif`;
  if (maxW) { const w = ctx.measureText(text).width; if (w > maxW) { size *= maxW / w; ctx.font = `700 ${size}px Ubuntu, system-ui, sans-serif`; } }
  ctx.textAlign = align; ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.2; ctx.strokeStyle = '#000'; ctx.fillStyle = '#fff';
  ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
}
function label(text, x, y, size = 16, align = 'left', color = '#fff') {
  ctx.font = `bold ${size}px system-ui, -apple-system, sans-serif`; ctx.textAlign = align; ctx.lineWidth = Math.max(3, size / 4);
  ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.fillStyle = color;
  ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
}

// ---------- Drawing: petals ----------
const rockShapes = {};
function rockPoly(key, n) {
  if (rockShapes[key]) return rockShapes[key];
  const rnd = seeded(typeof key === 'number' ? key : key.length * 77 + 13), pts = [];
  for (let i = 0; i < n; i++) { const a = i / n * TAU + rnd() * 0.4; const r = 0.82 + rnd() * 0.2; pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
  return (rockShapes[key] = pts);
}
function drawPetal(x, y, type, scale = 1, angle = 0, alpha = 1, flash = 0, single = false) {
  const d = PETALS[type] || { radius: 10, color: '#fff', outline: '#aaa' };
  const r = d.radius * scale;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = col(d.color, flash); ctx.strokeStyle = col(d.outline, flash); ctx.lineWidth = 3 * scale; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (d.shape === 'leaf') {
    ctx.moveTo(r * 1.3, 0); ctx.quadraticCurveTo(0, -r * 1.1, -r * 1.1, 0); ctx.quadraticCurveTo(0, r * 1.1, r * 1.3, 0);
    ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-r * 1.5, 0); ctx.lineTo(r * 0.9, 0); ctx.lineWidth = 2 * scale; ctx.stroke();
  } else if (d.shape === 'square') {                     // Square petal
    const h = r * 0.85; ctx.rect(-h, -h, h * 2, h * 2); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'triangle') {
    ctx.moveTo(r * 1.3, 0); ctx.lineTo(-r * 0.8, -r * 0.95); ctx.lineTo(-r * 0.8, r * 0.95); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'rock') {
    rockPoly('petal', 7).forEach(([px, py], i) => i ? ctx.lineTo(px * r, py * r) : ctx.moveTo(px * r, py * r));
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'hex') {                        // Honey
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'bubble') {                     // Bubble: see-through with a shine
    ctx.globalAlpha *= 0.75; ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.globalAlpha /= 0.75; ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(-r * 0.35, -r * 0.35, r * 0.25, 0, TAU); ctx.fill();
  } else if (d.shape === 'wing') {                       // Wing: crescent
    ctx.arc(0, 0, r, -Math.PI * 0.55, Math.PI * 0.55); ctx.quadraticCurveTo(r * 0.15, 0, Math.cos(-Math.PI * 0.55) * r, Math.sin(-Math.PI * 0.55) * r);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'peas' && !single) {            // Peas: 4 little peas in a cluster
    const pr = r * 0.48;
    for (const [px, py] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.beginPath(); ctx.arc(px * pr, py * pr, pr, 0, TAU); ctx.fill(); ctx.stroke(); }
  } else if (d.shape === 'rice') {                       // Rice: small grain
    ctx.ellipse(0, 0, r * 1.25, r * 0.6, 0, 0, TAU); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'salt') {                       // Salt: a little crystal
    ctx.moveTo(0, -r); ctx.lineTo(r * 0.87, -r * 0.5); ctx.lineTo(r * 0.87, r * 0.5); ctx.lineTo(0, r); ctx.lineTo(-r * 0.87, r * 0.5); ctx.lineTo(-r * 0.87, -r * 0.5);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, r); ctx.lineWidth = 1.2 * scale; ctx.stroke();
  } else if (d.shape === 'missile') {                    // Missile: long dart
    ctx.moveTo(r * 1.5, 0); ctx.lineTo(-r * 0.9, -r * 0.6); ctx.lineTo(-r * 0.5, 0); ctx.lineTo(-r * 0.9, r * 0.6); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'cactus') {                     // Cactus: round with little spikes
    ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col(d.rarity === 'epic' ? '#8a5aa8' : '#2f6e2f', flash);
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; ctx.beginPath(); ctx.arc(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, r * 0.13, 0, TAU); ctx.fill(); }
  } else if (d.shape === 'web') {                        // Web: small spun web
    ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = col('#9a9a9a', flash); ctx.lineWidth = 1 * scale; ctx.beginPath();
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85); }
    ctx.moveTo(r * 0.5, 0); ctx.arc(0, 0, r * 0.5, 0, TAU); ctx.stroke();
  } else if (d.shape === 'dandelion') {                  // Dandelion: fluffy seed head on a stem
    ctx.strokeStyle = col('#7a9a5a', flash); ctx.lineWidth = 4 * scale; ctx.beginPath(); ctx.moveTo(-r * 0.4, 0); ctx.lineTo(-r * 1.4, 0); ctx.stroke();
    ctx.fillStyle = col(d.color, flash); ctx.strokeStyle = col(d.outline, flash); ctx.lineWidth = 2 * scale;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.85, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = col('#d8d8d8', flash); ctx.lineWidth = 1 * scale; ctx.beginPath();
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.8); }
    ctx.stroke();
  } else if (d.shape === 'yinyang') {                    // Yin Yang: black and white swirl
    ctx.fillStyle = col('#ffffff', flash); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.fillStyle = col('#2a2a2a', flash); ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.arc(0, r / 2, r / 2, Math.PI / 2, -Math.PI / 2, true); ctx.arc(0, -r / 2, r / 2, Math.PI / 2, -Math.PI / 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -r / 2, r * 0.15, 0, TAU); ctx.fill();
    ctx.fillStyle = col('#ffffff', flash); ctx.beginPath(); ctx.arc(0, r / 2, r * 0.15, 0, TAU); ctx.fill();
    ctx.strokeStyle = col('#2a2a2a', flash); ctx.lineWidth = 1.5 * scale; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke();
  } else if (d.shape === 'antennae') {                   // Antennae (icon only; worn on the flower)
    ctx.strokeStyle = col(d.color, flash); ctx.lineWidth = 2.2 * scale; ctx.lineCap = 'round'; ctx.beginPath();
    for (const sx of [-1, 1]) { ctx.moveTo(sx * r * 0.25, r * 0.8); ctx.quadraticCurveTo(sx * r * 0.3, -r * 0.2, sx * r * 0.9, -r * 0.8); }
    ctx.stroke(); ctx.fillStyle = col(d.color, flash);
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(sx * r * 0.9, -r * 0.8, r * 0.18, 0, TAU); ctx.fill(); }
  } else if (d.shape === 'egg') {                        // Egg
    ctx.ellipse(0, 0, r * 0.82, r, 0, 0, TAU); ctx.fill(); ctx.stroke();
  } else if (d.shape === 'corn') {                       // Corn: kernel cob
    ctx.ellipse(0, 0, r * 1.4, r * 0.8, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.lineWidth = 1.2 * scale; ctx.beginPath();
    for (const k of [-0.5, 0, 0.5]) { ctx.moveTo(k * r * 1.4, -r * 0.6); ctx.lineTo(k * r * 1.4, r * 0.6); }
    ctx.stroke();
  } else { ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke(); }
  if (d.sparkle) {                                       // Unique Basic: little sparkles drifting off it
    const t = performance.now() / 1000;
    ctx.fillStyle = d.sparkle;
    for (let i = 0; i < 5; i++) {
      const k = (t * 0.8 + i / 5) % 1, a = i * 2.4 + Math.floor(t * 0.8 + i / 5) * 1.7;
      ctx.globalAlpha = alpha * (1 - k);
      ctx.beginPath(); ctx.arc(Math.cos(a) * r * (1 + k * 1.2), Math.sin(a) * r * (1 + k * 1.2), r * 0.18 * (1 - k * 0.5), 0, TAU); ctx.fill();
    }
  }
  ctx.restore();
}

// ---------- Drawing: our flower ----------
function drawDart(x, y, a) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.scale(1.3, 1.3); ctx.fillStyle = "#2a2a2a"; ctx.strokeStyle = '#111'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(13, 0); ctx.lineTo(-8, -6); ctx.lineTo(-4, 0); ctx.lineTo(-8, 6); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.restore();
}
function drawWebPatch(x, y, r) {
  ctx.save(); ctx.globalAlpha = 0.55; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  for (const k of [0.3, 0.55, 0.8, 1]) { ctx.moveTo(x + r * k, y); for (let i = 1; i <= 10; i++) { const a = i / 10 * TAU; ctx.lineTo(x + Math.cos(a) * r * k, y + Math.sin(a) * r * k); } }
  ctx.stroke(); ctx.restore();
}
function drawFlower(p, x, y, isMe, v) {
  const r = FR, f = v.flash;
  let alpha = 1, scale = 1;
  if (v.deadT) { const k = (now() - v.deadT) / 0.5; if (k >= 1) return; alpha = 1 - ease(k); scale = 1 + k * 0.4; }
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(scale, scale);
  if (p.an) {                                             // wearing Antennae
    ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.beginPath();
    for (const sx of [-1, 1]) { ctx.moveTo(sx * r * 0.3, -r * 0.8); ctx.quadraticCurveTo(sx * r * 0.45, -r * 1.5, sx * r * 0.95, -r * 1.75); }
    ctx.stroke(); ctx.fillStyle = '#2b2b2b';
    for (const sx of [-1, 1]) { ctx.beginPath(); ctx.arc(sx * r * 0.95, -r * 1.75, 3.5, 0, TAU); ctx.fill(); }
  }
  ctx.fillStyle = col(p.po ? '#b06ad8' : '#ffe36b', f); ctx.strokeStyle = col(p.po ? '#8a4fb0' : '#d8b83f', f); ctx.lineWidth = 4;   // purple while poisoned
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = '#2a2418'; ctx.fillStyle = '#2a2418'; ctx.lineCap = 'round';
  if (p.d) {
    ctx.lineWidth = 3;
    for (const ex of [-8, 8]) { ctx.beginPath(); ctx.moveTo(ex - 4, -8); ctx.lineTo(ex + 4, 0); ctx.moveTo(ex + 4, -8); ctx.lineTo(ex - 4, 0); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(0, 12, 5, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke();
  } else {
    for (const ex of [-8, 8]) {
      ctx.fillStyle = '#2a2418'; ctx.beginPath(); ctx.arc(ex, -3, 3.6, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(ex + 1.2, -4.4, 1.3, 0, TAU); ctx.fill();
    }
    ctx.lineWidth = 2.5;
    if (p.m === 1) {
      ctx.beginPath(); ctx.moveTo(-13, -12); ctx.lineTo(-4, -9); ctx.moveTo(13, -12); ctx.lineTo(4, -9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-5, 10); ctx.lineTo(5, 10); ctx.stroke();
    } else if (p.m === 2) {
      ctx.beginPath(); ctx.moveTo(-12, -10); ctx.lineTo(-5, -13); ctx.moveTo(12, -10); ctx.lineTo(5, -13); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 10, 2.8, 0, TAU); ctx.stroke();
    } else { ctx.beginPath(); ctx.arc(0, 6, 5, Math.PI * 0.15, Math.PI * 0.85); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,140,110,0.4)';
    ctx.beginPath(); ctx.arc(-14, 5, 3.5, 0, TAU); ctx.arc(14, 5, 3.5, 0, TAU); ctx.fill();
  }
  ctx.restore();
  if (p.d) return;
  label(p.n, x, y - r - 14, 15, 'center');
  if (!isMe || v.hp < p.mh - 0.5) hpBar(x, y + r + 12, 54, v.hp / p.mh);
}
function hpBar(x, y, w, frac) {
  frac = Math.max(0, Math.min(1, frac));
  ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(x - w / 2 - 2, y - 2, w + 4, 9, 4.5); ctx.fill();
  if (frac > 0.01) { ctx.fillStyle = '#7be08f'; roundRect(x - w / 2, y, Math.max(5, w * frac), 5, 2.5); ctx.fill(); }
}

// ---------- Drawing: mobs (original designs) ----------
function drawMob(v, x, y, alpha = 1, scale = 1) {
  const r = v.r * scale, f = v.flash, t = now();
  ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.rotate(v.ang); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (v.type === 'ladybug' || v.type === 'massiveLadybug' || v.type === 'yellowLadybug' || v.type === 'darkLadybug') {
    const yel = v.type === 'yellowLadybug', dark = v.type === 'darkLadybug';
    ctx.fillStyle = col('#2b2b2b', f); ctx.beginPath(); ctx.arc(r * 0.72, 0, r * 0.5, 0, TAU); ctx.fill();
    ctx.fillStyle = col(yel ? '#f2d43c' : dark ? '#962921' : '#e8483e', f); ctx.strokeStyle = col(yel ? '#c4a82a' : dark ? '#6f1d17' : '#b0332b', f); ctx.lineWidth = Math.max(3, r * 0.12);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(-r * 0.6, 0); ctx.stroke();
    ctx.fillStyle = col(dark ? '#e8483e' : '#2b2b2b', f);
    for (const [sx, sy, sr] of [[0.25, -0.45, 0.2], [-0.35, -0.5, 0.17], [0.3, 0.48, 0.18], [-0.4, 0.45, 0.2], [-0.7, 0, 0.13]]) {
      ctx.beginPath(); ctx.arc(sx * r, sy * r, sr * r, 0, TAU); ctx.fill();
    }
  } else if (v.type === 'bee') {
    const flap = Math.sin(t * 30) * 0.25;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(-r * 0.1, s * r * 0.75, r * 0.55, r * 0.3, s * (0.5 + flap), 0, TAU); ctx.fill(); }
    ctx.fillStyle = col('#2b2b2b', f);
    ctx.beginPath(); ctx.moveTo(-r * 1.35, 0); ctx.lineTo(-r * 0.85, -r * 0.22); ctx.lineTo(-r * 0.85, r * 0.22); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, r * 1.05, r * 0.72, 0, 0, TAU);
    ctx.fillStyle = col('#f5cf3f', f); ctx.fill(); ctx.clip();
    ctx.fillStyle = col('#2b2b2b', f);
    for (const sx of [-0.55, -0.05, 0.45]) ctx.fillRect(sx * r - r * 0.13, -r, r * 0.26, r * 2);
    ctx.restore();
    ctx.strokeStyle = col('#c7a22b', f); ctx.lineWidth = 3; ctx.beginPath(); ctx.ellipse(0, 0, r * 1.05, r * 0.72, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 2;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(r * 0.95, s * r * 0.15); ctx.quadraticCurveTo(r * 1.3, s * r * 0.2, r * 1.45, s * r * 0.5); ctx.stroke();
      ctx.beginPath(); ctx.arc(r * 1.45, s * r * 0.5, 2.5, 0, TAU); ctx.fillStyle = '#2b2b2b'; ctx.fill(); }
  } else if (v.type === 'rock' || v.type === 'boulder') {
    ctx.fillStyle = col('#8f8f8f', f); ctx.strokeStyle = col('#6c6c6c', f); ctx.lineWidth = 4;
    ctx.beginPath(); rockPoly(v.id, 7 + (v.id % 3)).forEach(([px, py], i) => i ? ctx.lineTo(px * r, py * r) : ctx.moveTo(px * r, py * r));
    ctx.closePath(); ctx.fill(); ctx.stroke();
  } else if (v.type === 'babyAnt' || v.type === 'workerAnt') {
    // Baby Ant: one round segment. Worker Ant: head + abdomen.
    const two = v.type === 'workerAnt', hx = two ? r * 0.55 : 0, wig = Math.sin(t * 9 + v.id) * 0.12;
    ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = 2;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(hx + r * 0.6, s * r * 0.3); ctx.quadraticCurveTo(hx + r * 1.15, s * r * (0.35 + wig), hx + r * 1.35, s * r * (0.85 + wig)); ctx.stroke(); }
    ctx.fillStyle = col(two ? '#4f4f4f' : '#5e5e5e', f); ctx.strokeStyle = col('#363636', f); ctx.lineWidth = 3;
    if (two) { ctx.beginPath(); ctx.arc(-r * 0.6, 0, r * 0.8, 0, TAU); ctx.fill(); ctx.stroke(); }
    ctx.fillStyle = col('#5e5e5e', f);
    ctx.beginPath(); ctx.arc(hx, 0, two ? r * 0.68 : r, 0, TAU); ctx.fill(); ctx.stroke();
  } else if (v.type === 'centipede' || v.type === 'evilCentipede') {
    const evil = v.type === 'evilCentipede';
    ctx.fillStyle = col('#2b2b2b', f);
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(0, s * r * 0.95, r * 0.22, r * 0.38, 0, 0, TAU); ctx.fill(); }
    ctx.fillStyle = col(evil ? '#9a5bc4' : '#93c75c', f); ctx.strokeStyle = col(evil ? '#6f3f93' : '#6f9c42', f); ctx.lineWidth = Math.max(3, r * 0.17);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
    if (v.head) {
      ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = Math.max(2, r * 0.08);
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(r * 0.8, s * r * 0.3); ctx.quadraticCurveTo(r * 1.3, s * r * 0.35, r * 1.5, s * r * 0.8); ctx.stroke(); }
    }
  } else if (v.type === 'square') {                     // Square: a plain yellow square that slowly spins
    ctx.fillStyle = col('#ffe869', f); ctx.strokeStyle = col('#bfae4e', f); ctx.lineWidth = Math.max(3, r * 0.16);
    const h = r * 0.8; ctx.beginPath(); ctx.rect(-h, -h, h * 2, h * 2); ctx.fill(); ctx.stroke();
  } else if (v.type === 'cactus') {
    // Cactus: round green body ringed with spikes
    const n = 12 + (v.id % 4);
    ctx.fillStyle = col('#2f6e2f', f);
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU; ctx.beginPath();
      ctx.moveTo(Math.cos(a - 0.12) * r * 0.92, Math.sin(a - 0.12) * r * 0.92); ctx.lineTo(Math.cos(a) * r * 1.22, Math.sin(a) * r * 1.22);
      ctx.lineTo(Math.cos(a + 0.12) * r * 0.92, Math.sin(a + 0.12) * r * 0.92); ctx.fill();
    }
    ctx.fillStyle = col('#4fae4f', f); ctx.strokeStyle = col('#37843a', f); ctx.lineWidth = Math.max(3, r * 0.1);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
  } else if (v.type === 'beetle' || v.type === 'massiveBeetle') {
    // Beetle: purple shell split down the middle, with pincers
    // Beetle: rounded purple shell with darker spots and two curved black pincers
    const pinch = Math.sin(t * 6 + v.id) * 0.12;
    ctx.fillStyle = col('#2a2a2a', f);
    for (const s of [-1, 1]) {
      ctx.save(); ctx.translate(r * 0.78, s * r * 0.3); ctx.rotate(s * (0.15 + pinch));
      ctx.beginPath(); ctx.moveTo(0, -s * r * 0.12); ctx.quadraticCurveTo(r * 0.55, -s * r * 0.15, r * 0.62, s * r * 0.18);
      ctx.quadraticCurveTo(r * 0.4, s * r * 0.02, 0, s * r * 0.12); ctx.closePath(); ctx.fill(); ctx.restore();
    }
    ctx.fillStyle = col('#9b59c9', f); ctx.strokeStyle = col('#7a3fa6', f); ctx.lineWidth = Math.max(3, r * 0.11);
    ctx.beginPath(); ctx.ellipse(0, 0, r * 1.02, r * 0.86, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col('#7a3fa6', f);
    for (const [sx, sy, sr] of [[0.35, -0.3, 0.11], [0.0, -0.45, 0.1], [-0.4, -0.35, 0.11], [0.35, 0.3, 0.11], [0.0, 0.45, 0.1], [-0.4, 0.35, 0.11], [-0.05, 0, 0.12], [-0.7, 0, 0.09]])
      { ctx.beginPath(); ctx.arc(sx * r, sy * r, sr * r, 0, TAU); ctx.fill(); }
  } else if (v.type === 'soldierAnt' || v.type === 'queenAnt') {
    // Winged ants: soldier has 2 segments, queen has 3 and is bigger
    const queen = v.type === 'queenAnt', flap = Math.sin(t * 25 + v.id) * 0.25, wig = Math.sin(t * 9 + v.id) * 0.12;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(-r * 0.3, s * r * 0.55, r * 0.7, r * 0.28, s * (0.35 + flap), 0, TAU); ctx.fill(); }
    ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = Math.max(2, r * 0.09);
    const hx = queen ? r * 0.7 : r * 0.55;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(hx + r * 0.4, s * r * 0.2); ctx.quadraticCurveTo(hx + r * 0.85, s * r * (0.3 + wig), hx + r * 1.0, s * r * (0.65 + wig)); ctx.stroke(); }
    ctx.fillStyle = col('#4f4f4f', f); ctx.strokeStyle = col('#363636', f); ctx.lineWidth = Math.max(3, r * 0.12);
    if (queen) { ctx.beginPath(); ctx.arc(-r * 0.75, 0, r * 0.62, 0, TAU); ctx.fill(); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(queen ? 0 : -r * 0.6, 0, r * (queen ? 0.55 : 0.8), 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col('#5e5e5e', f);
    ctx.beginPath(); ctx.arc(hx, 0, r * (queen ? 0.45 : 0.68), 0, TAU); ctx.fill(); ctx.stroke();
  } else if (v.type === 'spider') {
    // Spider: round dark body with eight jointed legs that scuttle
    ctx.strokeStyle = col('#2a2118', f); ctx.lineWidth = Math.max(2.5, r * 0.13); ctx.lineCap = 'round';
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) {
      const base = (i - 1.5) * 0.45, wob = Math.sin(t * 14 + i * 1.7 + (s > 0 ? 1 : 0)) * 0.18;
      const a1 = s * (Math.PI / 2) + base * s + wob;
      const kx = Math.cos(a1) * r * 1.05, ky = Math.sin(a1) * r * 1.05;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(kx, ky); ctx.lineTo(kx * 1.55 + base * r * 0.35, ky * 1.35); ctx.stroke();
    }
    ctx.fillStyle = col('#5b4433', f); ctx.strokeStyle = col('#3e2e22', f); ctx.lineWidth = Math.max(3, r * 0.12);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.fillStyle = col('#3e2e22', f); ctx.beginPath(); ctx.arc(r * 0.45, 0, r * 0.3, 0, TAU); ctx.fill();
  } else if (v.type === 'hornet') {
    // Hornet: slimmer orange-and-black body with a long stinger and buzzing wings
    const flap = Math.sin(t * 32) * 0.3;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(-r * 0.05, s * r * 0.7, r * 0.6, r * 0.26, s * (0.45 + flap), 0, TAU); ctx.fill(); }
    ctx.fillStyle = col('#222222', f);
    ctx.beginPath(); ctx.moveTo(-r * 1.6, 0); ctx.lineTo(-r * 0.85, -r * 0.2); ctx.lineTo(-r * 0.85, r * 0.2); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, r * 1.05, r * 0.62, 0, 0, TAU);
    ctx.fillStyle = col('#f0922b', f); ctx.fill(); ctx.clip();
    ctx.fillStyle = col('#222222', f);
    for (const sx of [-0.6, -0.15, 0.3]) ctx.fillRect(sx * r - r * 0.11, -r, r * 0.22, r * 2);
    ctx.restore();
    ctx.strokeStyle = col('#b9651a', f); ctx.lineWidth = Math.max(3, r * 0.1); ctx.beginPath(); ctx.ellipse(0, 0, r * 1.05, r * 0.62, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#222'; ctx.lineWidth = 2;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(r * 0.95, s * r * 0.12); ctx.quadraticCurveTo(r * 1.3, s * r * 0.15, r * 1.42, s * r * 0.45); ctx.stroke(); }
  } else if (v.type === 'antHole') {
    // Ant Hole: three rings of sandy earth, darker toward the middle
    ctx.fillStyle = col('#ad882e', f); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.fillStyle = col('#8b6c24', f); ctx.beginPath(); ctx.arc(0, 0, r * 0.67, 0, TAU); ctx.fill();
    ctx.fillStyle = col('#654f16', f); ctx.beginPath(); ctx.arc(0, 0, r * 0.34, 0, TAU); ctx.fill();
  } else { ctx.fillStyle = col('#999999', f); ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); }
  ctx.restore();
}

// ---------- Drawing: drops on the ground ----------
// Petal icon inside a slot/drop box. Multi-petals (Twin) show one dot per petal.
function drawPetalIcon(type, cx, cy, scale) {
  const n = (PETALS[type] || {}).count || 1;
  if (n === 1) return drawPetal(cx, cy, type, scale, -0.5);
  if (PETALS[type].cluster) {                                  // triangle cluster, like in the ring
    const cr = (PETALS[type].radius || 8) * scale * 1.15;
    for (let i = 0; i < n; i++) { const ca = -Math.PI / 2 + i * TAU / n; drawPetal(cx + Math.cos(ca) * cr, cy + Math.sin(ca) * cr, type, scale, -0.5); }
    return;
  }
  const gap = ((PETALS[type].radius || 8) * scale) * 2.3;
  for (let i = 0; i < n; i++) drawPetal(cx + (i - (n - 1) / 2) * gap, cy, type, scale, -0.5);
}
function drawDropBox(x, y, type, s, alpha = 1) {
  const d = PETALS[type] || {}, [fill, edge] = RARITY[d.rarity] || RARITY.common;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.translate(x, y);      // same look as the petal slots
  slotFrame(s, fill, edge);
  drawPetalIcon(type, 0, -s * 0.09, s / 56 * 0.8);
  labelU(d.name || type, 0, s * 0.3, s * 0.21, 'center', s * 0.86);
  ctx.restore();
}

// ---------- Background ----------
function drawBackground(W, H) {
  const ox = W / 2 - cam.x, oy = H / 2 - cam.y;
  let left = 0;
  for (const z of MAP.zones) { ctx.fillStyle = z.color; ctx.fillRect(left + ox, oy, z.width, MAP.h); left += z.width; }
  ctx.strokeStyle = 'rgba(0,0,0,0.07)'; ctx.lineWidth = 1;
  const step = 50, gx = (ox % step + step) % step, gy = (oy % step + step) % step;
  ctx.beginPath();
  for (let x = gx; x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
  for (let y = gy; y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(10,20,14,0.45)';
  ctx.fillRect(0, 0, W, oy); ctx.fillRect(0, oy + MAP.h, W, H); ctx.fillRect(0, 0, ox, H); ctx.fillRect(ox + MAP.w, 0, W, H);
}

// ---------- HUD ----------
// Leaderboard points: plain up to 9999, then 10.0K, 22.4K, 409.9K, 1.2M ...
const fmtScore = n => n < 10000 ? String(n) : n < 1e6 ? (Math.floor(n / 100) / 10).toFixed(1) + 'K' : (Math.floor(n / 1e5) / 10).toFixed(1) + 'M';
function drawHUD(W, H, me, self) {
  if (self) {
    // Level bar like the original: a dark pill tucked against the left edge with a
    // yellow fill that starts as a round blob and stretches as you gain XP
    const u = uiScale(H), x0 = -6 * u, x1 = 320 * u, y0 = H - 130 * u, bh = 40 * u, cx = (x0 + x1) / 2, ins = 3 * u;
    const frac = Math.min(1, me.xp / me.next), ih = bh - 2 * ins, iw = x1 - x0 - 2 * ins;
    ctx.save(); ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#333333'; roundRect(x0, y0, x1 - x0, bh, bh / 2); ctx.fill();
    ctx.fillStyle = '#f4fb62'; roundRect(x0 + ins, y0 + ins, ih + (iw - ih) * frac, ih, ih / 2); ctx.fill();
    ctx.restore();
    labelU(self.n, cx, y0 - 12 * u, 24 * u);
    labelU(`Lvl ${self.l} Flower`, cx, y0 + bh / 2 + 6 * u, 17 * u);
    const nextSlot = [15, 30, 45].find(l => l > self.l);
    if (nextSlot) labelU(`Extra petal slot at level ${nextSlot}`, cx, y0 + bh + 18 * u, 14 * u);
  }
  const sorted = state.players.filter(p => !p.d).sort((a, b) => b.s - a.s),   // dead flowers leave the leaderboard
        top = sorted.slice(0, 10), lw = 220, lx = W - lw - 16;
  ctx.fillStyle = 'rgba(0,0,0,0.35)'; roundRect(lx, 16, lw, 40 + top.length * 22, 10); ctx.fill();
  ctx.fillStyle = 'rgba(111,209,143,0.9)'; roundRect(lx, 16, lw, 30, 10); ctx.fill();
  label(`${sorted.length} Flower${sorted.length === 1 ? '' : 's'}`, lx + lw / 2, 37, 15, 'center');
  top.forEach((p, i) => {
    const c = p.id === myId ? '#f6d55c' : '#fff';
    label(`${i + 1}. ${p.n}`, lx + 12, 68 + i * 22, 14, 'left', c); label(fmtScore(p.s), lx + lw - 12, 68 + i * 22, 14, 'right', c);
  });
  if (self && !self.d && !top.includes(self)) label(`${sorted.indexOf(self) + 1}. ${self.n} — ${fmtScore(self.s)}`, lx + 12, 68 + top.length * 22 + 6, 14, 'left', '#f6d55c');

  const mw = 220, mh = Math.max(26, mw * MAP.h / MAP.w), mmx = W - mw - 16, mmy = H - mh - 16;
  let zx = mmx;
  ctx.save(); roundRect(mmx, mmy, mw, mh, 6); ctx.clip();
  for (const z of MAP.zones) { const zw = z.width / MAP.w * mw; ctx.fillStyle = z.color; ctx.fillRect(zx, mmy, zw, mh); zx += zw; }
  ctx.restore();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3; roundRect(mmx, mmy, mw, mh, 6); ctx.stroke();
  zx = mmx; for (const z of MAP.zones) { const zw = z.width / MAP.w * mw; label(z.name, zx + zw / 2, mmy + mh / 2 + 5, 12, 'center'); zx += zw; }
  label('Map', mmx + mw / 2, mmy - 8, 16, 'center');
  if (self) { ctx.fillStyle = '#ffd34a'; ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mmx + view[self.id].x / MAP.w * mw, mmy + mh / 2, 6, 0, TAU); ctx.fill(); ctx.stroke(); }
  drawInventory(W, H, me);
}

// One petal slot, drawn like the original: see-through square, thick border with
// slightly rounded outer corners, name in Ubuntu Bold. While recharging the inside
// goes dark and a bright wedge spins round and grows until it fills the slot.
function slotFrame(s, fill, edge, inner) {
  const b = s * 0.08;
  ctx.fillStyle = inner || fill; ctx.fillRect(-s / 2 + b, -s / 2 + b, s - 2 * b, s - 2 * b);
  ctx.strokeStyle = edge; ctx.lineWidth = b; ctx.lineJoin = 'round';
  ctx.strokeRect(-s / 2 + b / 2, -s / 2 + b / 2, s - b, s - b);
}
function drawSlotBox(x, y, s, type, ready = 1, bob = 0, pop = 1) {
  if (!type || pop <= 0) {
    ctx.save(); ctx.globalAlpha = SLOT_ALPHA * 0.8; ctx.translate(x + s / 2, y + s / 2);
    slotFrame(s, '#ffffff', '#cccccc'); ctx.restore();
    if (!type) return;
  }
  const d = PETALS[type] || {}, [fill, edge] = RARITY[d.rarity] || RARITY.common;
  ctx.save(); ctx.translate(x + s / 2, y + s / 2 + (bob ? Math.sin(bob) * 2 : 0)); if (bob) ctx.rotate(Math.sin(bob * 0.8) * 0.06);
  ctx.scale(pop, pop); ctx.globalAlpha = SLOT_ALPHA;
  if (ready < 1) {
    slotFrame(s, fill, edge, shade(fill, 0.635));
    const b = s * 0.08, q = Math.pow(Math.max(0, ready), 1.7), a0 = q * Math.PI * 10;
    ctx.save(); ctx.beginPath(); ctx.rect(-s / 2 + b, -s / 2 + b, s - 2 * b, s - 2 * b); ctx.clip();
    ctx.fillStyle = fill; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, s, a0, a0 + q * TAU); ctx.closePath(); ctx.fill();
    ctx.restore();
  } else slotFrame(s, fill, edge);
  drawPetalIcon(type, 0, -s * 0.09, s / 56 * 0.8);
  labelU(d.name || type, 0, s * 0.3, s * 0.21, 'center', s * 0.86);
  ctx.restore();
}
function drawInventory(W, H, me) {
  const L = inv.L = invLayout(W, H), t = now();
  inv.open = !death && inRect(input.mx, input.my, inv.open ? L.panel : L.hint);
  if (inv.sel >= 0 && (!me.bench[inv.sel] || t - inv.selT > 5)) inv.sel = -1;   // selection times out after 5s
  if (inv.open) { ctx.fillStyle = 'rgba(0,0,0,0.38)'; roundRect(L.panel.x, L.panel.y, L.panel.w, L.panel.h + 20, 14); ctx.fill(); }
  const hidden = (row, i) => (inv.hide && ((inv.hide[row + i] || 0) > t || (inv.hide.all || 0) > t)) || (inv.drag && inv.drag.row === row && inv.drag.i === i);
  const popScale = i => { const p = inv.pops[i]; if (!p) return 1; const k = (t - p) / 0.22; if (k >= 1) { delete inv.pops[i]; return 1; } if (k < 0) return 0; return ease(k) * 1.12 - Math.max(0, k - 0.7) * 0.4; };

  // Reload sweep: the server only reports progress 25x a second, so we advance it
  // every frame ourselves and stay in step with the server -> a smooth sweep, no ticking
  const now2 = performance.now(), dtI = Math.min(0.1, (now2 - (inv.lastT || now2)) / 1000); inv.lastT = now2;
  inv.ready = inv.ready || [];
  L.eq.forEach(r => {
    const s = me.slots[r.i];
    let shown = inv.ready[r.i];
    if (s) {
      const srv = s[1], rel = (PETALS[s[0]] || {}).reload || 1;
      // learn how fast this slot is really filling (overleveled reloads are quicker than normal)
      inv.rate = inv.rate || []; inv.last = inv.last || [];
      const L0 = inv.last[r.i];
      if (L0 && srv > L0.v && srv < 1) inv.rate[r.i] = (srv - L0.v) / Math.max(0.02, now2 / 1000 - L0.t);
      if (!L0 || srv !== L0.v) inv.last[r.i] = { v: srv, t: now2 / 1000 };
      const rate = srv <= 0 ? 0 : (inv.rate[r.i] || 1 / rel);
      if (srv >= 1) shown = 1;
      else if (shown === undefined || Math.abs(shown - srv) > 0.2 || shown >= 1) shown = srv;
      else shown = Math.min(shown + dtI * rate, srv + 0.06);
      inv.ready[r.i] = shown;
    }
    drawSlotBox(r.x, r.y, r.s, hidden('e', r.i) ? null : s && s[0], s ? shown : 1);
    labelU(`[${r.i + 1}]`, r.x + r.s / 2, r.y - r.s * 0.12, r.s * 0.17);
  });
  L.bench.forEach(r => {
    const sel = r.i === inv.sel, g = sel ? 6 : 0;
    drawSlotBox(r.x - g / 2, r.y - g / 2, r.s + g, hidden('b', r.i) ? null : me.bench[r.i], 1, sel ? t * 6 : 0, popScale(r.i));
  });
  const tr = L.trash;
  ctx.save(); ctx.globalAlpha = SLOT_ALPHA * 0.8; ctx.translate(tr.x + tr.s / 2, tr.y + tr.s / 2);
  slotFrame(tr.s, '#ff7676', '#cc5e5e'); ctx.restore();
  labelU('Delete', tr.x + tr.s / 2, tr.y + tr.s / 2 + tr.s * 0.08, tr.s * 0.2);
  label('[T]', tr.x + tr.s + 6, tr.y + 10, 12, 'left');

  ctx.fillStyle = 'rgba(0,0,0,0.42)'; roundRect(L.hint.x, L.hint.y, L.hint.w, L.hint.h + 12, 10); ctx.fill();
  labelU(inv.open ? 'You can also use [Q] and [E] to modify the inventory' : 'Move mouse here to disable movement', W / 2, H - L.hint.h * 0.32, L.hint.h * 0.42, 'center', L.hint.w * 0.94);

  // Petals sliding between slots
  inv.anims = inv.anims.filter(a => t < a.t0 + a.dur + 0.02);
  for (const a of inv.anims) {
    const k = ease((t - a.t0) / a.dur);
    const x = a.from.x + (a.to.x - a.from.x) * k, y = a.from.y + (a.to.y - a.from.y) * k, s = a.from.s + (a.to.s - a.from.s) * k;
    drawSlotBox(x, y, s, a.type, 1, 0, a.shrink ? 1 - k * 0.8 : 1);
  }
  if (inv.drag) { const ds = 70 * uiScale(H); drawSlotBox(input.mx - ds / 2, input.my - ds / 2, ds, inv.drag.type); }
}

// Overleveled: screen dims a little, and a small banner floats above your flower
// with a round timer that fills red until your petals are gone.
function drawOverleveled(W, H, fx, fy, prog) {
  ctx.fillStyle = 'rgba(0,0,0,0.1)'; ctx.fillRect(0, 0, W, H);
  const bw = 222, bh = 46, bx = fx - bw / 2, by = fy - FR - 64 - bh / 2;
  ctx.fillStyle = 'rgba(25,40,30,0.88)'; roundRect(bx, by, bw, bh, 3); ctx.fill();
  ctx.textAlign = 'left'; ctx.fillStyle = '#ff7b8a'; ctx.font = 'bold 13px system-ui, -apple-system, sans-serif';
  ctx.fillText('MOVE RIGHT ->', bx + 7, by + 15);
  ctx.fillStyle = '#ffffff'; ctx.font = '600 10px system-ui, -apple-system, sans-serif';
  ctx.fillText('You are overleveled for this zone', bx + 7, by + 28);
  ctx.fillText('You will be unable to attack', bx + 7, by + 40);
  const cx = bx + bw - 25, cy = by + bh / 2, r = 15;
  ctx.fillStyle = '#2a2a2a'; ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
  ctx.fillStyle = '#c4303f'; ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, r - 1, -Math.PI / 2, -Math.PI / 2 + prog * TAU); ctx.closePath(); ctx.fill();
}

function drawDeathScreen(W, H) {
  const k = ease((now() - death.t) / 0.4);
  ctx.fillStyle = `rgba(0,0,0,${0.3 * k})`; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.globalAlpha = k;
  label('You were destroyed by', W / 2, H / 2 - 70, 18, 'center');
  label(death.by || 'the void', W / 2, H / 2 - 40, 30, 'center');
  label('(press Enter or click to continue)', W / 2, H / 2 + 60, 15, 'center', '#e8f2ea');
  ctx.restore();
}

// ---------- Main render loop ----------
let lastFrame = performance.now();
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (ts - lastFrame) / 1000 || 0); lastFrame = ts;
  const W = innerWidth, H = innerHeight, t = now();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  if (!MAP || !state.me || homeAfterDeath) { ctx.fillStyle = '#2fa86a'; ctx.fillRect(0, 0, W, H); return; }   // plain green behind the home screen

  const kPos = 1 - Math.exp(-dt * 18), kHp = 1 - Math.exp(-dt * 7), kFlash = Math.exp(-dt * 22);
  const pseen = new Set();
  for (const p of state.players) {
    const v = view[p.id]; pseen.add(String(p.id));
    if (Math.hypot(v.x - p.x, v.y - p.y) > 400) { v.x = p.x; v.y = p.y; }
    v.x += (p.x - v.x) * kPos; v.y += (p.y - v.y) * kPos; v.pr += (p.pr - v.pr) * kPos;
    v.ang += SPIN * (p.sp ?? 1) * (paused ? 0 : dt);   // frozen while paused v.ang += angDiff(v.ang, p.pa) * (1 - Math.exp(-dt * 4));
    v.hp += (p.hp - v.hp) * kHp;                           // health drains/fills like liquid
    v.flash *= kFlash; if (v.flash < 0.02) v.flash = 0;
  }
  for (const id in view) if (!pseen.has(id)) delete view[id];
  for (const v of Object.values(mview)) {
    v.x += (v.tx - v.x) * kPos; v.y += (v.ty - v.y) * kPos;
    v.ang += angDiff(v.ang, v.tang) * kPos;
    v.hp += (v.thp - v.hp) * kHp;
    v.flash *= kFlash; if (v.flash < 0.02) v.flash = 0;
  }

  const self = state.players.find(p => p.id === myId);
  if (self) { cam.x = view[self.id].x; cam.y = view[self.id].y; }
  // World is drawn zoomed out; the HUD is drawn afterwards at normal size
  const zTarget = ZOOM / (state.me.vis || 1);
  zoomCur = zoomCur === null ? zTarget : zoomCur + (zTarget - zoomCur) * (1 - Math.exp(-dt * 3));
  const VW = W / zoomCur, VH = H / zoomCur;
  ctx.save(); ctx.scale(zoomCur, zoomCur);
  drawBackground(VW, VH);
  const ox = VW / 2 - cam.x, oy = VH / 2 - cam.y;

  // Web patches (under everything)
  for (const [, wx, wy, wr] of wview) drawWebPatch(wx + ox, wy + oy, wr);
  // Drops (under everything)
  for (const d of Object.values(dview)) {
    // New drops slide out from where the mob died and pop to full size
    const age = t - d.born, k = ease(age / 0.35), pop = age < 0.3 ? ease(age / 0.3) * 1.1 - Math.max(0, age / 0.3 - 0.7) * 0.33 : 1;
    const dx = d.ox + (d.x - d.ox) * k, dy = d.oy + (d.y - d.oy) * k;
    const blink = d.left < 5 ? 0.55 + 0.45 * Math.cos(t * 12) : 1;
    drawDropBox(dx + ox, dy + oy + Math.sin(t * 2.5 + d.id) * 1.5, d.type, 38 * Math.max(0.05, pop), blink);
  }
  // Ghosts: dying mobs fade + swell, picked-up drops fly into the flower
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const g = ghosts[i], k = (t - g.t0) / (g.kind === 'mob' ? 0.22 : 0.2);
    if (k >= 1) { ghosts.splice(i, 1); continue; }
    if (g.kind === 'mob') { g.v.flash *= kFlash; drawMob(g.v, g.v.x + ox, g.v.y + oy, 1 - k, 1 + k * 0.35); }
    else {
      const tgt = g.to && view[g.to], e = ease(k);
      const x = tgt ? g.d.x + (tgt.x - g.d.x) * e : g.d.x, y = tgt ? g.d.y + (tgt.y - g.d.y) * e : g.d.y;
      drawDropBox(x + ox, y + oy, g.d.type, 38 * (1 - e * 0.7), 1 - e * 0.6);
    }
  }
  // Mobs
  // Ground-level things (holes, rocks, cacti) draw underneath moving mobs
  const low = v => (MOBDEFS[v.type] || {}).stationary ? 0 : 1;
  const mlist = Object.values(mview).sort((a, b) => low(a) - low(b) || a.r - b.r);
  for (const v of mlist) drawMob(v, v.x + ox, v.y + oy, Math.min(1, (t - v.born) / 0.25));
  for (const v of mlist) if (v.hp < 99.5 && v.type !== 'rock' || v.type === 'rock' && v.hp < 99.5)
    hpBar(v.x + ox, v.y + oy + v.r + 9, Math.min(160, Math.max(36, v.r * 2)), v.hp / 100);

  // Flowers + petals
  for (const p of state.players) {
    const v = view[p.id], sx = v.x + ox, sy = v.y + oy;
    if (!p.d) {
      // Every petal has its own id, so it keeps its own smooth position even
      // when petals are swapped in/out or the ring grows/shrinks.
      const live = new Set(), kOff = 1 - Math.exp(-dt * 10), kRf = 1 - Math.exp(-dt * 14);
      for (const [type, alive, rr, uid, off, php, ck] of p.pt) {
        live.add(uid);
        let s = v.rf[uid];
        if (!s) s = v.rf[uid] = { off, r: 0, hp: php, flash: 0 };
        s.off += angDiff(s.off, off) * kOff;               // glide to its spot in the ring
        if (!alive) { s.r = 0; s.hp = 1; s.flash = 0; continue; }   // broken: just not drawn
        if (php < s.hp - 0.01) s.flash = FLASH;            // petal took a hit but survived
        s.hp = php; s.flash *= kFlash;
        s.r += (rr - s.r) * kRf;                           // grows out from the flower on respawn
        const a = v.ang + s.off, dist = v.pr * s.r;
        let px = sx + Math.cos(a) * dist, py = sy + Math.sin(a) * dist;
        if (ck >= 0) { const ca = a + ck * TAU / 3, cr = ((PETALS[type] || {}).radius || 8) * 1.15 * Math.min(1, s.r); px += Math.cos(ca) * cr; py += Math.sin(ca) * cr; }   // triangle cluster
        drawPetal(px, py, type, 1, a, 1, s.flash);
      }
      for (const k in v.rf) if (!live.has(+k)) delete v.rf[k];
    }
    drawFlower(p, sx, sy, p.id === myId, v);
  }
  // Pea projectiles in flight
  for (const s of Object.values(sview)) { s.x += (s.tx - s.x) * kPos; s.y += (s.ty - s.y) * kPos;
    if (s.type === 'hornetMissile') { drawDart(s.x + ox, s.y + oy, s.ang); continue; }
    const sd = PETALS[s.type] || {};
    drawPetal(s.x + ox, s.y + oy, s.type, sd.shape === 'missile' || sd.drop ? 1 : 0.7, s.ang, 1, 0, true); }
  ctx.restore();

  if (state.me.ol && !death && self) drawOverleveled(W, H, (view[self.id].x + ox) * zoomCur, (view[self.id].y + oy) * zoomCur, state.me.ol);
  drawHUD(W, H, state.me, self);
  if (death) drawDeathScreen(W, H);
  else drawPause(W, H);
}
// Pause button (top left) and, while paused, a dimmed screen saying who paused it
function drawPause(W, H) {
  const { x, y, s } = PAUSE_BTN, hover = onPauseBtn(input.mx, input.my);
  if (paused) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, 0, W, H);
    label('Paused', W / 2, H * 0.28, 56, 'center');
    label(`by ${paused.by} — click the button at the top left to resume`, W / 2, H * 0.28 + 40, 18, 'center');
  }
  ctx.fillStyle = hover ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)'; roundRect(x, y, s, s, 10); ctx.fill();
  ctx.fillStyle = '#fff';
  if (paused) {                                            // play triangle: click to resume
    ctx.beginPath(); ctx.moveTo(x + s * 0.36, y + s * 0.26); ctx.lineTo(x + s * 0.74, y + s / 2); ctx.lineTo(x + s * 0.36, y + s * 0.74); ctx.closePath(); ctx.fill();
  } else {                                                 // two bars: click to pause
    roundRect(x + s * 0.3, y + s * 0.26, s * 0.14, s * 0.48, 2); ctx.fill();
    roundRect(x + s * 0.56, y + s * 0.26, s * 0.14, s * 0.48, 2); ctx.fill();
  }
}
requestAnimationFrame(frame);

// ---------- Title screen: Mobs / Petals gallery ----------
// Reads the live config from the server, so new mobs and petals appear automatically.
let galleryData = null, galleryTab = null;
const RNAMES = { common: 'Common', unusual: 'Unusual', rare: 'Rare', epic: 'Epic', legendary: 'Legendary', unique: 'Unique' };
function iconCanvas(size, draw) {
  const c = document.createElement('canvas'), dpr = devicePixelRatio || 1;
  c.width = size * dpr; c.height = size * dpr; c.style.width = c.style.height = size + 'px';
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const saved = ctx; ctx = g; try { draw(size); } finally { ctx = saved; }
  return c;
}
function showGallery(tab) {
  const el = $('gallery');
  if (galleryTab === tab) { galleryTab = null; el.classList.add('hidden'); $('tabMobs').classList.remove('on'); $('tabPetals').classList.remove('on'); return; }
  galleryTab = tab;
  $('tabMobs').classList.toggle('on', tab === 'mobs'); $('tabPetals').classList.toggle('on', tab === 'petals');
  el.classList.remove('hidden'); el.innerHTML = '';
  if (!galleryData) { el.textContent = 'Loading…'; return; }
  PETALS = Object.keys(PETALS).length ? PETALS : galleryData.petals;
  const P = galleryData.petals;
  if (tab === 'mobs') {
    for (const [type, m] of Object.entries(galleryData.mobs)) {
      const card = document.createElement('div'); card.className = 'card';
      const r = m.sizeRange ? m.sizeRange[1] : m.radius;
      card.appendChild(iconCanvas(64, s => {
        const sc = Math.min(1, 22 / r);
        if (m.segments) for (let i = 2; i >= 0; i--) drawMob({ id: 1, type, r: r * sc * 0.75, ang: 0, flash: 0, head: i === 0 }, s / 2 + 18 - i * r * sc * 1.3, s / 2);
        else drawMob({ id: 3, type, r: r * sc, ang: -0.4, flash: 0, head: 1 }, s / 2, s / 2);
      }));
      const info = document.createElement('div');
      const part = r => !r ? '' : r[0] >= 0.5 ? ' (right half)' : r[1] <= 0.5 ? ' (left half)' : '';
      const zones = Object.keys(m.zones || {}).map(z => z + part((m.zoneRange || {})[z])).join(', ') || `From ${m.from || '?'}`;
      info.innerHTML = `<b>${m.name}</b>HP ${m.healthRange ? m.healthRange.join('–') : m.health}${m.segments ? ' per segment' : ''} · Dmg ${m.damage} · XP ${m.xp}<br>Zones: ${zones}<br>`;
      for (const [pt, ch] of Object.entries(m.drops || {})) {
        if (!P[pt]) continue;
        const d = document.createElement('span'); d.className = 'drop';
        d.appendChild(iconCanvas(22, s => drawDropBox(s / 2, s / 2, pt, s)));
        d.append(`${+(ch * 100).toFixed(3)}%`);
        info.appendChild(d);
      }
      card.appendChild(info); el.appendChild(card);
    }
  } else {
    const RK = ['common', 'unusual', 'rare', 'epic', 'legendary', 'unique'];   // rarity first, then A-Z
    const sortedP = Object.entries(P).sort(([, a], [, b]) => RK.indexOf(a.rarity) - RK.indexOf(b.rarity) || a.name.localeCompare(b.name));
    for (const [type, p] of sortedP) {
      const card = document.createElement('div'); card.className = 'card';
      card.appendChild(iconCanvas(56, s => drawDropBox(s / 2, s / 2, type, s)));
      const info = document.createElement('div');
      const extra = [p.count > 1 ? `${p.count} per slot` : '', p.heal ? `Heals ${p.heal}` : '', p.healPerSec ? `Heals ${p.healPerSec}/s` : '', p.noExtend ? "Doesn't extend" : ''].filter(Boolean).join(' · ');
      info.innerHTML = `<b>${p.name}</b>${RNAMES[p.rarity] || p.rarity}<br>Dmg ${p.damage} · HP ${p.health} · Reload ${p.reload}s${extra ? '<br>' + extra : ''}`;
      card.appendChild(info); el.appendChild(card);
    }
  }
}
$('tabMobs').onclick = () => showGallery('mobs');
$('tabPetals').onclick = () => showGallery('petals');
fetch('/gallery.json').then(r => r.json()).then(d => {
  galleryData = d;
  if (!Object.keys(PETALS).length) PETALS = d.petals;
  if (galleryTab) { const t = galleryTab; galleryTab = null; showGallery(t); }
  updateSpawnInfo();
});


// ---------- Custom start (title screen) ----------
// Pick a starting level, zone and petals. Saved in this browser and used when you press Play.
const START_KEY = 'petalArenaStart';
let startCfg = { armed: false, level: 1, zone: 'auto', petals: [], bench: [] };
try { Object.assign(startCfg, JSON.parse(localStorage.getItem(START_KEY)) || {}); } catch (e) {}
const saveStart = () => { try { localStorage.setItem(START_KEY, JSON.stringify(startCfg)); } catch (e) {} };
const slotsFor = l => 5 + [15, 30, 45].filter(x => l >= x).length;
// A saved custom start is used once, for your next spawn (first join or after dying)
function takeCustomStart() {
  if (!startCfg.armed) return null;
  const st = { level: startCfg.level, zone: startCfg.zone === 'auto' ? null : startCfg.zone, petals: startCfg.petals.slice(0, slotsFor(startCfg.level)), bench: startCfg.bench };
  startCfg.armed = false; saveStart(); updateSpawnInfo();
  return st;
}
let pickTarget = { row: 'petals', i: 0 };
function renderStart() {
  const P = (galleryData && galleryData.petals) || PETALS, el = $('startBody');
  if (!Object.keys(P).length) { el.textContent = 'Loading…'; return; }
  if (!Object.keys(PETALS).length) PETALS = P;
  const n = slotsFor(startCfg.level);
  $('startLevel').value = startCfg.level; $('startLevelNum').textContent = startCfg.level;
  $('startZone').value = startCfg.zone;
  const box = (t, size, sel) => { const c = iconCanvas(size, s => drawSlotBox(0, 0, s, t || null)); c.className = 'pslot' + (sel ? ' sel' : ''); return c; };
  const row = (name, count, size) => {
    const r = document.createElement('div'); r.className = 'prow';
    for (let i = 0; i < count; i++) {
      const c = box(startCfg[name][i], size, pickTarget.row === name && pickTarget.i === i);
      c.onclick = () => { pickTarget = { row: name, i }; renderStart(); };
      c.oncontextmenu = e => { e.preventDefault(); startCfg[name][i] = null; saveStart(); renderStart(); };
      r.appendChild(c);
    }
    return r;
  };
  el.innerHTML = '';
  const h = t => { const d = document.createElement('div'); d.className = 'plabel'; d.textContent = t; return d; };
  el.append(h(`Loadout (${n} slots at level ${startCfg.level})`), row('petals', n, 46), h('Bench'), row('bench', 8, 38),
    h('Click a slot, then a petal · right-click a slot to empty it'));
  const pal = document.createElement('div'); pal.className = 'ppal';
  const RANKS = ['common', 'unusual', 'rare', 'epic', 'legendary', 'unique'];
  const order = Object.keys(P).sort((a, b) => RANKS.indexOf(P[a].rarity) - RANKS.indexOf(P[b].rarity) || P[a].name.localeCompare(P[b].name));
  for (const t of order) { const c = box(t, 40, false); c.title = P[t].name; c.onclick = () => {
    startCfg[pickTarget.row][pickTarget.i] = t;
    if (pickTarget.row === 'petals' && pickTarget.i >= n - 1) pickTarget = { row: 'bench', i: 0 };   // loadout full: carry on into the bench
    else pickTarget.i = Math.min((pickTarget.row === 'petals' ? n : 8) - 1, pickTarget.i + 1);
    saveStart(); renderStart(); }; pal.appendChild(c); }
  el.appendChild(pal);
}
$('startOpen').onclick = () => { $('startModal').classList.remove('hidden'); renderStart(); };
$('startClose').onclick = () => $('startModal').classList.add('hidden');
$('startModal').onclick = e => { if (e.target === $('startModal')) $('startModal').classList.add('hidden'); };
$('startLevel').oninput = e => { startCfg.level = +e.target.value; saveStart(); renderStart(); };
$('startZone').onchange = e => { startCfg.zone = e.target.value; saveStart(); };
$('startSave').onclick = () => { startCfg.armed = true; saveStart(); updateSpawnInfo(); const b = $('startSave'); b.textContent = 'Saved ✓'; setTimeout(() => { b.textContent = 'Save'; $('startModal').classList.add('hidden'); }, 450); };
$('startClear').onclick = () => { Object.assign(startCfg, { armed: false, level: 1, zone: 'auto', petals: [], bench: [] }); pickTarget = { row: 'petals', i: 0 }; saveStart(); renderStart(); updateSpawnInfo(); };

updateSpawnInfo();   // a custom start saved earlier shows up straight away
