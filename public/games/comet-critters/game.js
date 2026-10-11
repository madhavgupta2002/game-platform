/* =========================================================================
 * Comet Critters — an original slingshot destruction game.
 * Vanilla HTML/CSS/JS, zero dependencies. All visuals drawn procedurally.
 * ========================================================================= */
'use strict';
(() => {

/* ------------------------------------------------------------------ *
 * Constants & tuning
 * ------------------------------------------------------------------ */
const W = 1600, H = 900;            // logical world size (letterboxed)
const GROUND = 830;                 // ground surface y
const GRAVITY = 1700;               // px / s^2
const DT = 1 / 120;                 // fixed physics timestep
const SOLVER_ITERS = 4;
const SLOP = 0.5, CORRECT = 0.4;    // positional correction
const SLEEP_SPEED = 25, SLEEP_TIME = 0.5;
const MAX_SPEED = 3000;

const SLING = { x: 235, y: 648 };   // launch anchor
const MAX_DRAG = 155;               // max pull distance
const POWER = 11.2;                 // drag px -> launch speed
const GRAB_RADIUS = 110;            // generous, touch friendly

const MATERIALS = {
  wood:  { hp: 150, thr: 170, density: 1.0, score: 100, rest: 0.15, fric: 0.50 },
  stone: { hp: 330, thr: 300, density: 2.2, score: 150, rest: 0.05, fric: 0.60 },
  glass: { hp: 70,  thr: 90,  density: 0.7, score: 50,  rest: 0.10, fric: 0.30 },
  enemy: { hp: 85,  thr: 95,  density: 0.8, score: 500, rest: 0.30, fric: 0.50 },
  comet: { hp: Infinity, thr: Infinity, density: 1.3, score: 0, rest: 0.30, fric: 0.55 },
};

// Projectile flavours (all original critters).
const COMETS = {
  coral: { r: 24, density: 1.35, powerMul: 1.0,  color: '#FF5E5B', dark: '#d33532', name: 'Pip'  },
  gold:  { r: 30, density: 2.10, powerMul: 0.9,  color: '#FFC145', dark: '#d99a17', name: 'Boulder' },
  teal:  { r: 18, density: 1.05, powerMul: 1.28, color: '#3DDBD9', dark: '#1fa9a7', name: 'Zippy' },
};

const REDUCED_MOTION = window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);
const rand = (a, b) => a + Math.random() * (b - a);

function loadBest() {
  try { return JSON.parse(localStorage.getItem('cometCrittersBest') || '{}'); }
  catch { return {}; }
}
function saveBest(best) {
  try { localStorage.setItem('cometCrittersBest', JSON.stringify(best)); }
  catch { /* storage unavailable (private mode / file://) — fine */ }
}

/* ------------------------------------------------------------------ *
 * Audio — tiny procedural synth, initialised on first user gesture
 * ------------------------------------------------------------------ */
const Sound = {
  ctx: null, muted: false,
  init() {
    if (this.ctx) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { this.ctx = null; }
  },
  tone(freq, dur, type = 'sine', vol = 0.15, slide = 0) {
    if (!this.ctx || this.muted) return;
    try {
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t); o.stop(t + dur);
    } catch { /* ignore */ }
  },
  launch() { this.tone(300, 0.25, 'sawtooth', 0.10, 500); },
  thud()   { this.tone(110, 0.12, 'triangle', 0.18, -60); },
  crack()  { this.tone(700, 0.10, 'square', 0.06, -300); },
  pop()    { this.tone(500, 0.18, 'sine', 0.20, 400); },
  win()    { [523, 659, 784, 1047].forEach((f, i) =>
               setTimeout(() => this.tone(f, 0.22, 'triangle', 0.15), i * 120)); },
  lose()   { [330, 262, 196].forEach((f, i) =>
               setTimeout(() => this.tone(f, 0.3, 'triangle', 0.12), i * 160)); },
};

/* ------------------------------------------------------------------ *
 * Physics bodies
 * ------------------------------------------------------------------ */
let BODY_SEQ = 0;

function makeBox(x, y, w, h, mat) {
  const m = MATERIALS[mat];
  const mass = (w * h / 1000) * m.density;
  return {
    id: BODY_SEQ++, shape: 'box', mat,
    x, y, w, h, hw: w / 2, hh: h / 2,
    vx: 0, vy: 0, mass, invMass: 1 / mass,
    rest: m.rest, fric: m.fric,
    hp: m.hp, maxHp: m.hp,
    sleeping: true, sleepT: SLEEP_TIME,
    seed: Math.random() * 100, removed: false,
  };
}

function makeCircle(x, y, r, mat, density) {
  const m = MATERIALS[mat];
  const mass = (Math.PI * r * r / 1000) * (density || m.density);
  return {
    id: BODY_SEQ++, shape: 'circle', mat,
    x, y, r,
    vx: 0, vy: 0, mass, invMass: 1 / mass,
    rest: m.rest, fric: m.fric,
    hp: m.hp, maxHp: m.hp,
    sleeping: mat !== 'comet', sleepT: mat !== 'comet' ? SLEEP_TIME : 0,
    seed: Math.random() * 100, removed: false,
  };
}

function wake(b) { b.sleeping = false; b.sleepT = 0; }

/** Contact manifold between two bodies, or null. Normal points a -> b. */
function manifold(a, b) {
  if (a.shape === 'circle' && b.shape === 'circle') {
    const dx = b.x - a.x, dy = b.y - a.y;
    const rr = a.r + b.r, d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr) return null;
    const d = Math.sqrt(d2) || 0.001;
    return { nx: dx / d, ny: dy / d, pen: rr - d };
  }
  if (a.shape === 'box' && b.shape === 'box') {
    const ox = a.hw + b.hw - Math.abs(b.x - a.x);
    if (ox <= 0) return null;
    const oy = a.hh + b.hh - Math.abs(b.y - a.y);
    if (oy <= 0) return null;
    if (ox < oy) return { nx: b.x > a.x ? 1 : -1, ny: 0, pen: ox };
    return { nx: 0, ny: b.y > a.y ? 1 : -1, pen: oy };
  }
  // circle vs box — make a the circle
  if (a.shape === 'box') {
    const m = manifold(b, a);
    if (m) { m.nx = -m.nx; m.ny = -m.ny; }
    return m;
  }
  const cx = clamp(a.x, b.x - b.hw, b.x + b.hw);
  const cy = clamp(a.y, b.y - b.hh, b.y + b.hh);
  let dx = a.x - cx, dy = a.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > a.r * a.r) return null;
  if (d2 < 1e-9) { // centre inside box: push out along least axis
    const px = b.hw - Math.abs(a.x - b.x), py = b.hh - Math.abs(a.y - b.y);
    if (px < py) return { nx: a.x < b.x ? 1 : -1, ny: 0, pen: a.r + px };
    return { nx: 0, ny: a.y < b.y ? 1 : -1, pen: a.r + py };
  }
  const d = Math.sqrt(d2);
  // normal a -> b is from circle towards box surface point
  return { nx: -dx / d, ny: -dy / d, pen: a.r - d };
}

/* ------------------------------------------------------------------ *
 * Level data. Blocks: [cx, cy, w, h, material]; enemies: [cx, cy, r].
 * Coordinates authored so structures rest exactly on each other.
 * ------------------------------------------------------------------ */
const LEVELS = [
  {
    name: 'First Flight',
    shots: ['coral', 'coral', 'coral'],
    blocks: [
      [1250, 760, 30, 140, 'wood'], [1370, 760, 30, 140, 'wood'],
      [1310, 677, 200, 26, 'wood'],
    ],
    enemies: [[1000, 804, 26], [1310, 638, 26]],
  },
  {
    name: 'Tumble Tower',
    shots: ['coral', 'coral', 'gold'],
    blocks: [
      [1180, 755, 28, 150, 'wood'], [1320, 755, 28, 150, 'wood'],
      [1250, 667, 210, 26, 'wood'],
      [1180, 579, 28, 150, 'wood'], [1320, 579, 28, 150, 'wood'],
      [1250, 491, 210, 26, 'wood'],
      [1080, 775, 34, 110, 'stone'],
    ],
    enemies: [[1250, 804, 26], [1250, 452, 26]],
  },
  {
    name: 'Glass Palace',
    shots: ['teal', 'coral', 'teal'],
    blocks: [
      [1060, 750, 26, 160, 'glass'], [1240, 750, 26, 160, 'glass'], [1420, 750, 26, 160, 'glass'],
      [1240, 658, 390, 24, 'glass'],
      [1150, 581, 26, 130, 'glass'], [1330, 581, 26, 130, 'glass'],
      [1240, 504, 390, 24, 'glass'],
    ],
    enemies: [[1150, 804, 24], [1330, 804, 24], [1240, 620, 24], [1240, 466, 24]],
  },
  {
    name: 'Stone Keep',
    shots: ['gold', 'gold', 'coral', 'teal'],
    blocks: [
      [1000, 700, 40, 260, 'stone'], [1000, 510, 40, 120, 'stone'],
      [1280, 755, 34, 150, 'stone'], [1440, 755, 34, 150, 'stone'],
      [1360, 665, 220, 30, 'stone'],
      [1150, 745, 26, 170, 'glass'],
    ],
    enemies: [[1200, 804, 26], [1360, 804, 26], [1360, 624, 26]],
  },
  {
    name: 'Gloop Citadel',
    shots: ['coral', 'gold', 'teal', 'gold'],
    blocks: [
      [1050, 760, 36, 140, 'stone'], [1210, 760, 36, 140, 'stone'],
      [1130, 676, 240, 28, 'stone'],
      [1060, 597, 26, 130, 'wood'], [1200, 597, 26, 130, 'wood'],
      [1130, 520, 220, 24, 'wood'],
      [1380, 755, 26, 150, 'glass'], [1500, 755, 26, 150, 'glass'],
      [1440, 668, 190, 24, 'glass'],
    ],
    enemies: [[1130, 804, 26], [1130, 482, 24], [1440, 804, 24], [1440, 630, 24]],
  },
];

/* ------------------------------------------------------------------ *
 * The game
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

const ui = {
  hud: document.getElementById('hud'),
  level: document.getElementById('hud-level'),
  score: document.getElementById('hud-score'),
  ammo: document.getElementById('hud-ammo'),
  overlay: document.getElementById('overlay'),
  panels: {
    start: document.getElementById('panel-start'),
    levels: document.getElementById('panel-levels'),
    win: document.getElementById('panel-win'),
    lose: document.getElementById('panel-lose'),
  },
  levelGrid: document.getElementById('level-grid'),
  winStars: document.getElementById('win-stars'),
  winScore: document.getElementById('win-score'),
  winBonus: document.getElementById('win-bonus'),
  winNext: document.getElementById('btn-win-next'),
  loseScore: document.getElementById('lose-score'),
};

const game = {
  state: 'menu',           // menu | aiming | dragging | flying | won | lost
  levelIndex: 0,
  bodies: [],
  enemiesAlive: 0,
  shots: [],               // comet type keys for this level
  shotsUsed: 0,
  proj: null,              // active in-flight projectile body
  dragX: 0, dragY: 0,      // current drag position (world)
  score: 0,
  turnT: 0,
  endPending: null,        // { t, kind: 'win' | 'evaluate' }
  particles: [],
  popups: [],
  confetti: [],
  shakeT: 0, shakeMag: 0,
  time: 0,
  best: loadBest(),
};

// static decorations, generated once
const STARS = Array.from({ length: 90 }, () => ({
  x: Math.random() * W, y: Math.random() * (GROUND - 260),
  r: rand(0.8, 2.4), tw: Math.random() * 6.28,
}));

/* ---------------- level lifecycle ---------------- */

function loadLevel(i) {
  const L = LEVELS[i];
  game.levelIndex = i;
  game.bodies = [];
  game.particles = [];
  game.popups = [];
  game.confetti = [];
  game.score = 0;
  game.shots = L.shots.slice();
  game.shotsUsed = 0;
  game.proj = null;
  game.turnT = 0;
  game.endPending = null;
  game.shakeT = 0;

  for (const [x, y, w, h, m] of L.blocks) game.bodies.push(makeBox(x, y, w, h, m));
  for (const [x, y, r] of L.enemies) game.bodies.push(makeCircle(x, y, r, 'enemy'));
  game.enemiesAlive = L.enemies.length;

  game.state = 'aiming';
  showPanel(null);
  ui.hud.classList.remove('hidden');
  updateHud();
}

function currentCometType() {
  return COMETS[game.shots[game.shotsUsed]];
}

function launch(dx, dy) {
  const type = currentCometType();
  const px = SLING.x + dx, py = SLING.y + dy;
  const speed = POWER * type.powerMul;
  const body = makeCircle(px, py, type.r, 'comet', type.density);
  body.vx = -dx * speed;
  body.vy = -dy * speed;
  body.sleeping = false;
  body.cometKey = game.shots[game.shotsUsed];
  game.bodies.push(body);
  game.proj = body;
  game.shotsUsed++;
  game.turnT = 0;
  game.state = 'flying';
  Sound.launch();
  updateHud();
}

function endTurn() {
  game.proj = null;
  if (game.enemiesAlive === 0) return; // win pending already
  if (game.shotsUsed < game.shots.length) {
    game.state = 'aiming';
    updateHud();
  } else {
    // give tumbling debris a moment to finish the job
    game.endPending = game.endPending || { t: 1.8, kind: 'evaluate' };
    game.state = 'flying';
  }
}

function triggerWin() {
  if (game.state === 'won') return;
  game.state = 'won';
  const left = game.shots.length - game.shotsUsed;
  const bonus = left * 1000;
  game.score += bonus;
  const stars = left >= 2 ? 3 : left === 1 ? 2 : 1;

  const key = String(game.levelIndex);
  if (!game.best[key] || stars > game.best[key]) {
    game.best[key] = stars;
    saveBest(game.best);
  }
  ui.winStars.innerHTML =
    '★'.repeat(stars) + '<span class="off">' + '★'.repeat(3 - stars) + '</span>';
  ui.winStars.setAttribute('aria-label', `${stars} of 3 stars`);
  ui.winScore.textContent = game.score;
  ui.winBonus.textContent = bonus ? `+${bonus} spare comet bonus!` : '';
  ui.winNext.style.display = game.levelIndex < LEVELS.length - 1 ? '' : 'none';
  spawnConfetti();
  Sound.win();
  updateHud();
  setTimeout(() => showPanel('win'), 650);
}

function triggerLose() {
  if (game.state === 'lost' || game.state === 'won') return;
  game.state = 'lost';
  ui.loseScore.textContent = game.score;
  Sound.lose();
  showPanel('lose');
}

/* ---------------- physics ---------------- */

function destroyBody(b) {
  b.removed = true;
  const m = MATERIALS[b.mat];
  game.score += m.score;
  addPopup(b.x, b.y - 30, `+${m.score}`);
  spawnDebris(b);
  if (b.mat === 'enemy') {
    game.enemiesAlive--;
    Sound.pop();
    if (game.enemiesAlive === 0 && !game.endPending) {
      game.endPending = { t: 0.9, kind: 'win' };
    }
  } else if (b.mat === 'glass') {
    Sound.crack();
  } else {
    Sound.thud();
  }
  // wake neighbours so unsupported stacks fall
  for (const o of game.bodies) {
    if (!o.removed && Math.abs(o.x - b.x) < 420 && Math.abs(o.y - b.y) < 420) wake(o);
  }
  updateHud();
}

function applyDamage(b, vn) {
  const m = MATERIALS[b.mat];
  if (!isFinite(m.hp) || vn <= m.thr) return;
  b.hp -= (vn - m.thr) * 0.55;
  if (b.hp <= 0 && !b.removed) destroyBody(b);
}

function resolvePair(a, b, allowDamage) {
  const man = manifold(a, b);
  if (!man) return;
  const { nx, ny, pen } = man;

  let rvx = b.vx - a.vx, rvy = b.vy - a.vy;
  const vn = rvx * nx + rvy * ny; // negative = approaching

  if ((a.sleeping || b.sleeping) && (Math.abs(vn) > 30 || pen > 2)) {
    wake(a); wake(b);
  }
  if (a.sleeping && b.sleeping) return;

  if (allowDamage && vn < 0) {
    const impact = -vn;
    applyDamage(a, impact);
    applyDamage(b, impact);
    if (impact > 520) { addShake(Math.min(10, impact / 90)); }
    if (impact > 260) spawnDust((a.x + b.x) / 2, (a.y + b.y) / 2, impact);
  }

  if (vn < 0) {
    const e = Math.min(a.rest, b.rest);
    const invSum = a.invMass + b.invMass;
    const j = -(1 + e) * vn / invSum;
    a.vx -= j * nx * a.invMass; a.vy -= j * ny * a.invMass;
    b.vx += j * nx * b.invMass; b.vy += j * ny * b.invMass;

    // friction along tangent
    rvx = b.vx - a.vx; rvy = b.vy - a.vy;
    const tx = -ny, ty = nx;
    const vt = rvx * tx + rvy * ty;
    let jt = -vt / invSum;
    const mu = Math.sqrt(a.fric * b.fric);
    jt = clamp(jt, -j * mu, j * mu);
    a.vx -= jt * tx * a.invMass; a.vy -= jt * ty * a.invMass;
    b.vx += jt * tx * b.invMass; b.vy += jt * ty * b.invMass;
  }

  // positional correction
  const corr = Math.max(pen - SLOP, 0) / (a.invMass + b.invMass) * CORRECT;
  a.x -= corr * nx * a.invMass; a.y -= corr * ny * a.invMass;
  b.x += corr * nx * b.invMass; b.y += corr * ny * b.invMass;
}

function resolveGround(b, allowDamage) {
  const bottom = b.shape === 'circle' ? b.y + b.r : b.y + b.hh;
  const pen = bottom - GROUND;
  if (pen <= 0) return;
  if (b.sleeping) { b.y -= pen; return; }

  if (allowDamage && b.vy > 0) {
    applyDamage(b, b.vy);
    if (b.vy > 300) spawnDust(b.x, GROUND, b.vy);
    if (b.vy > 600) addShake(Math.min(9, b.vy / 110));
  }
  if (b.vy > 0) b.vy = -b.vy * b.rest;
  if (Math.abs(b.vy) < 40) b.vy = 0;
  // ground friction
  const mu = 1 - clamp(b.fric * 8 * DT, 0, 0.4);
  b.vx *= mu;
  b.y -= Math.max(pen - SLOP, 0) * CORRECT * 2;
}

function physicsStep() {
  const bodies = game.bodies;

  // integrate
  for (const b of bodies) {
    if (b.removed || b.sleeping) continue;
    b.vy += GRAVITY * DT;
    b.vx = clamp(b.vx, -MAX_SPEED, MAX_SPEED);
    b.vy = clamp(b.vy, -MAX_SPEED, MAX_SPEED);
    b.x += b.vx * DT;
    b.y += b.vy * DT;
  }

  // solve contacts
  for (let iter = 0; iter < SOLVER_ITERS; iter++) {
    const damage = iter === 0;
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (a.removed) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (b.removed) continue;
        if (a.sleeping && b.sleeping) continue;
        resolvePair(a, b, damage);
      }
      resolveGround(a, damage);
    }
  }

  // sleep bookkeeping & cleanup
  for (const b of bodies) {
    if (b.removed || b.sleeping) continue;
    if (b.y > H + 400 || b.x < -500 || b.x > W + 500) { b.removed = true; continue; }
    const sp = Math.hypot(b.vx, b.vy);
    if (sp < SLEEP_SPEED) {
      b.sleepT += DT;
      if (b.sleepT > SLEEP_TIME) { b.sleeping = true; b.vx = 0; b.vy = 0; }
    } else {
      b.sleepT = 0;
    }
  }
  game.bodies = bodies.filter(b => !b.removed);
}

/* ---------------- effects ---------------- */

function addShake(mag) {
  if (REDUCED_MOTION) return;
  game.shakeMag = Math.max(game.shakeMag, mag);
  game.shakeT = 0.14;
}

function addPopup(x, y, text) {
  game.popups.push({ x, y, text, age: 0 });
}

const MAT_DEBRIS = {
  wood: '#C98A4B', stone: '#AEB8C4', glass: '#BDE8FF', enemy: '#A8E05F', comet: '#FFC145',
};

function spawnDebris(b) {
  const color = MAT_DEBRIS[b.mat] || '#fff';
  const n = b.mat === 'enemy' ? 16 : 12;
  for (let i = 0; i < n; i++) {
    game.particles.push({
      x: b.x + rand(-14, 14), y: b.y + rand(-14, 14),
      vx: rand(-260, 260), vy: rand(-380, -40),
      size: rand(3, b.mat === 'enemy' ? 7 : 9),
      color, age: 0, life: rand(0.5, 1.0),
    });
  }
}

function spawnDust(x, y, power) {
  const n = clamp(Math.round(power / 90), 2, 10);
  for (let i = 0; i < n; i++) {
    game.particles.push({
      x: x + rand(-10, 10), y: y + rand(-6, 6),
      vx: rand(-140, 140), vy: rand(-180, -20),
      size: rand(2, 5), color: 'rgba(255,240,220,0.8)',
      age: 0, life: rand(0.3, 0.6),
    });
  }
}

function spawnConfetti() {
  if (REDUCED_MOTION) return;
  const colors = ['#FF5E5B', '#FFC145', '#3DDBD9', '#A8E05F', '#FFD447'];
  for (let i = 0; i < 130; i++) {
    game.confetti.push({
      x: rand(0, W), y: rand(-250, -20),
      vx: rand(-60, 60), vy: rand(120, 340),
      size: rand(4, 9), rot: rand(0, 6.28), vr: rand(-5, 5),
      color: colors[i % colors.length], age: 0, life: rand(2.2, 3.6),
    });
  }
}

function updateEffects(dt) {
  for (const p of game.particles) {
    p.age += dt; p.vy += GRAVITY * 0.6 * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
  }
  game.particles = game.particles.filter(p => p.age < p.life);

  for (const p of game.popups) { p.age += dt; p.y -= 55 * dt; }
  game.popups = game.popups.filter(p => p.age < 1.1);

  for (const c of game.confetti) {
    c.age += dt; c.x += c.vx * dt; c.y += c.vy * dt; c.rot += c.vr * dt;
  }
  game.confetti = game.confetti.filter(c => c.age < c.life && c.y < H + 40);

  if (game.shakeT > 0) game.shakeT -= dt; else game.shakeMag = 0;
}

/* ---------------- game update ---------------- */

let accumulator = 0;
function update(dt) {
  game.time += dt;
  const simulating = game.state === 'aiming' || game.state === 'dragging' ||
                     game.state === 'flying' || game.state === 'won' || game.state === 'lost';
  if (simulating) {
    accumulator = Math.min(accumulator + dt, 0.1);
    while (accumulator >= DT) { physicsStep(); accumulator -= DT; }
  }
  updateEffects(dt);

  if (game.endPending) {
    game.endPending.t -= dt;
    if (game.endPending.t <= 0) {
      const kind = game.endPending.kind;
      game.endPending = null;
      if (kind === 'win' || game.enemiesAlive === 0) triggerWin();
      else triggerLose();
    }
  }

  if (game.state === 'flying' && game.proj) {
    game.turnT += dt;
    const p = game.proj;
    const gone = p.removed || p.sleeping || game.turnT > 7;
    if (gone) endTurn();
  }
}

/* ---------------- rendering ---------------- */

let cssW = 0, cssH = 0, scale = 1, offX = 0, offY = 0, dpr = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cssW = window.innerWidth; cssH = window.innerHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  scale = Math.min(cssW / W, cssH / H);
  offX = (cssW - W * scale) / 2;
  offY = (cssH - H * scale) / 2;
}
window.addEventListener('resize', resize);
resize();

function toWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - offX) / scale,
    y: (clientY - rect.top - offY) / scale,
  };
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBackground() {
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND);
  sky.addColorStop(0, '#2B1B54');
  sky.addColorStop(0.55, '#7A4FBF');
  sky.addColorStop(1, '#FF9A6C');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, GROUND);

  // twinkling stars
  for (const s of STARS) {
    const a = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(game.time * 1.4 + s.tw));
    ctx.globalAlpha = a * clamp(1 - s.y / (GROUND - 200), 0.15, 1);
    ctx.fillStyle = '#FFF3D6';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, 6.28);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // moon
  ctx.fillStyle = 'rgba(255, 244, 214, 0.95)';
  ctx.beginPath(); ctx.arc(1380, 150, 55, 0, 6.28); ctx.fill();
  ctx.fillStyle = 'rgba(210, 190, 170, 0.35)';
  ctx.beginPath(); ctx.arc(1362, 138, 13, 0, 6.28); ctx.fill();
  ctx.beginPath(); ctx.arc(1400, 172, 9, 0, 6.28); ctx.fill();

  // far hills
  ctx.fillStyle = '#4a3585';
  ctx.beginPath();
  ctx.moveTo(0, GROUND);
  for (let x = 0; x <= W; x += 20) {
    ctx.lineTo(x, GROUND - 90 - 55 * Math.sin(x * 0.004 + 1.3) - 30 * Math.sin(x * 0.011));
  }
  ctx.lineTo(W, GROUND); ctx.closePath(); ctx.fill();

  // near hills
  ctx.fillStyle = '#3EC46D';
  ctx.beginPath();
  ctx.moveTo(0, GROUND);
  for (let x = 0; x <= W; x += 20) {
    ctx.lineTo(x, GROUND - 34 - 30 * Math.sin(x * 0.006 + 4) - 14 * Math.sin(x * 0.017 + 2));
  }
  ctx.lineTo(W, GROUND); ctx.closePath(); ctx.fill();

  // ground
  ctx.fillStyle = '#2A9B54';
  ctx.fillRect(0, GROUND, W, H - GROUND);
  ctx.fillStyle = '#238247';
  ctx.fillRect(0, GROUND + 26, W, H - GROUND - 26);
}

function drawSlingshotBack() {
  ctx.strokeStyle = '#6b4326';
  ctx.lineCap = 'round';
  // rear fork arm
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.moveTo(SLING.x, GROUND);
  ctx.quadraticCurveTo(SLING.x + 4, SLING.y + 90, SLING.x + 26, SLING.y - 12);
  ctx.stroke();
}

function slingProjectilePos() {
  if (game.state === 'dragging') return { x: game.dragX, y: game.dragY };
  return { x: SLING.x, y: SLING.y };
}

function drawSlingshotFront(loadedType) {
  const p = slingProjectilePos();
  const hasLoad = game.state === 'aiming' || game.state === 'dragging';

  if (hasLoad && loadedType) {
    // rear band (behind projectile drawn earlier), front band here
    const pull = clamp(dist(SLING.x, SLING.y, p.x, p.y) / MAX_DRAG, 0, 1);
    ctx.strokeStyle = `rgb(${90 + pull * 130}, ${60 - pull * 20}, 60)`;
    ctx.lineWidth = 9 - pull * 3;
    ctx.beginPath();
    ctx.moveTo(SLING.x - 26, SLING.y - 12);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }

  // front fork arm + trunk
  ctx.strokeStyle = '#8a5a33';
  ctx.lineCap = 'round';
  ctx.lineWidth = 18;
  ctx.beginPath();
  ctx.moveTo(SLING.x, GROUND + 4);
  ctx.quadraticCurveTo(SLING.x - 4, SLING.y + 90, SLING.x - 26, SLING.y - 12);
  ctx.stroke();
}

function drawSlingshotBands(loadedType) {
  if (!(game.state === 'aiming' || game.state === 'dragging') || !loadedType) return;
  const p = slingProjectilePos();
  const pull = clamp(dist(SLING.x, SLING.y, p.x, p.y) / MAX_DRAG, 0, 1);
  ctx.strokeStyle = `rgb(${80 + pull * 120}, ${55 - pull * 15}, 55)`;
  ctx.lineWidth = 8 - pull * 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(SLING.x + 26, SLING.y - 12);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
}

function drawComet(x, y, r, key, vx, vy, squash) {
  const t = COMETS[key];
  const speed = Math.hypot(vx || 0, vy || 0);

  // tail when moving fast
  if (speed > 120) {
    const ang = Math.atan2(vy, vx);
    const len = clamp(speed * 0.09, 20, 120);
    const g = ctx.createLinearGradient(
      x - Math.cos(ang) * len, y - Math.sin(ang) * len, x, y);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, t.color + 'cc');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(x - Math.cos(ang) * len + Math.sin(ang) * 3,
               y - Math.sin(ang) * len - Math.cos(ang) * 3);
    ctx.lineTo(x + Math.sin(ang) * r * 0.8, y - Math.cos(ang) * r * 0.8);
    ctx.lineTo(x - Math.sin(ang) * r * 0.8, y + Math.cos(ang) * r * 0.8);
    ctx.closePath();
    ctx.fill();
  }

  ctx.save();
  ctx.translate(x, y);
  if (squash) ctx.scale(1 + squash, 1 - squash);

  // body
  ctx.fillStyle = t.color;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.28); ctx.fill();
  ctx.strokeStyle = t.dark;
  ctx.lineWidth = 3;
  ctx.stroke();
  // highlight
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.beginPath(); ctx.arc(-r * 0.3, -r * 0.35, r * 0.35, 0, 6.28); ctx.fill();

  // star mark
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const sr = r * 0.22;
  ctx.save();
  ctx.translate(r * 0.32, r * 0.3);
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
    const a2 = a + Math.PI / 5;
    ctx.lineTo(Math.cos(a) * sr, Math.sin(a) * sr);
    ctx.lineTo(Math.cos(a2) * sr * 0.45, Math.sin(a2) * sr * 0.45);
  }
  ctx.closePath(); ctx.fill();
  ctx.restore();

  // eyes
  const ex = r * 0.34, ey = -r * 0.15, er = r * 0.24;
  for (const s of [-1, 1]) {
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(s * ex - r * 0.05, ey, er, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#26203c';
    ctx.beginPath(); ctx.arc(s * ex + er * 0.3 - r * 0.05, ey, er * 0.5, 0, 6.28); ctx.fill();
  }
  // determined brows
  ctx.strokeStyle = t.dark;
  ctx.lineWidth = Math.max(2, r * 0.12);
  ctx.beginPath();
  ctx.moveTo(-ex - er * 0.8, ey - er * 1.15);
  ctx.lineTo(-ex + er * 0.6, ey - er * 0.75);
  ctx.moveTo(ex + er * 0.7, ey - er * 1.15);
  ctx.lineTo(ex - er * 0.7, ey - er * 0.75);
  ctx.stroke();

  ctx.restore();
}

function drawEnemy(b) {
  const wob = b.sleeping ? 0.03 : 0.06;
  const s = 1 + wob * Math.sin(game.time * 3.2 + b.seed);
  const rx = b.r * s, ry = b.r * (2 - s);

  ctx.save();
  ctx.translate(b.x, b.y);

  // blob body
  ctx.fillStyle = '#A8E05F';
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, 6.28);
  ctx.fill();
  ctx.strokeStyle = '#7cbb33';
  ctx.lineWidth = 3;
  ctx.stroke();
  // droopy antenna
  ctx.strokeStyle = '#7cbb33';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(0, -ry + 2);
  ctx.quadraticCurveTo(6, -ry - 14, 12, -ry - 10);
  ctx.stroke();
  ctx.fillStyle = '#d5f7a6';
  ctx.beginPath(); ctx.arc(12, -ry - 10, 4, 0, 6.28); ctx.fill();

  // hp tint
  if (b.hp < b.maxHp * 0.6) {
    ctx.fillStyle = 'rgba(120, 80, 30, 0.25)';
    ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, 6.28); ctx.fill();
  }

  // eyes look toward the slingshot / incoming comet
  const target = game.proj || slingProjectilePos();
  const ang = Math.atan2(target.y - b.y, target.x - b.x);
  const er = b.r * 0.26;
  for (const sx of [-1, 1]) {
    const cx = sx * b.r * 0.36, cy = -b.r * 0.2;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx, cy, er, 0, 6.28); ctx.fill();
    ctx.fillStyle = '#26203c';
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * er * 0.45, cy + Math.sin(ang) * er * 0.45, er * 0.5, 0, 6.28);
    ctx.fill();
  }
  // worried mouth
  ctx.strokeStyle = '#5f9426';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, b.r * 0.34, b.r * 0.22, Math.PI * 1.15, Math.PI * 1.85);
  ctx.stroke();

  ctx.restore();
}

const MAT_STYLE = {
  wood:  { fill: '#C98A4B', edge: '#A96F38', line: '#8a5a2c' },
  stone: { fill: '#AEB8C4', edge: '#8B98A8', line: '#6f7d8e' },
  glass: { fill: 'rgba(189,232,255,0.55)', edge: 'rgba(140,200,240,0.85)', line: 'rgba(220,245,255,0.9)' },
};

function drawBlock(b) {
  const st = MAT_STYLE[b.mat];
  const x = b.x - b.hw, y = b.y - b.hh;

  ctx.fillStyle = st.fill;
  roundRect(x, y, b.w, b.h, 5);
  ctx.fill();
  ctx.strokeStyle = st.edge;
  ctx.lineWidth = 3;
  ctx.stroke();

  // material detail
  ctx.strokeStyle = st.line;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  if (b.mat === 'wood') {
    if (b.w > b.h) { // plank grain
      ctx.moveTo(x + 8, b.y - 4); ctx.lineTo(x + b.w - 8, b.y - 4);
      ctx.moveTo(x + 8, b.y + 5); ctx.lineTo(x + b.w - 8, b.y + 5);
    } else {
      ctx.moveTo(b.x - 4, y + 8); ctx.lineTo(b.x - 4, y + b.h - 8);
      ctx.moveTo(b.x + 5, y + 8); ctx.lineTo(b.x + 5, y + b.h - 8);
    }
  } else if (b.mat === 'stone') {
    ctx.moveTo(x + 4, b.y); ctx.lineTo(x + b.w - 4, b.y);
    ctx.moveTo(b.x, y + 4); ctx.lineTo(b.x, b.y - 2);
    ctx.moveTo(b.x - b.hw * 0.5, b.y + 2); ctx.lineTo(b.x - b.hw * 0.5, y + b.h - 4);
  } else { // glass sheen
    ctx.moveTo(x + b.w * 0.25, y + 4); ctx.lineTo(x + b.w * 0.55, y + b.h - 4);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // cracks as HP drops
  const frac = b.hp / b.maxHp;
  if (frac < 0.66) {
    ctx.strokeStyle = 'rgba(40, 25, 15, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const s1 = Math.sin(b.seed) * 0.4;
    ctx.moveTo(b.x - b.hw * 0.5, y + 3);
    ctx.lineTo(b.x + b.hw * s1, b.y);
    ctx.lineTo(b.x - b.hw * 0.3, y + b.h - 3);
    if (frac < 0.33) {
      ctx.moveTo(x + 3, b.y - b.hh * 0.4);
      ctx.lineTo(b.x, b.y + b.hh * (0.2 + s1));
      ctx.lineTo(x + b.w - 3, b.y + b.hh * 0.5);
    }
    ctx.stroke();
  }
}

function drawTrajectory() {
  if (game.state !== 'dragging') return;
  const type = currentCometType();
  const dx = game.dragX - SLING.x, dy = game.dragY - SLING.y;
  if (dist(0, 0, dx, dy) < 12) return;
  const speed = POWER * type.powerMul;
  const vx = -dx * speed, vy = -dy * speed;

  ctx.fillStyle = '#FFF6E8';
  for (let i = 1; i <= 26; i++) {
    const t = i * 0.055;
    const px = game.dragX + vx * t;
    const py = game.dragY + vy * t + 0.5 * GRAVITY * t * t;
    if (py > GROUND || px > W || px < 0) break;
    ctx.globalAlpha = clamp(1 - i / 26, 0.12, 0.85);
    ctx.beginPath();
    ctx.arc(px, py, 5 - i * 0.12, 0, 6.28);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawWaitingComets() {
  // upcoming comets queue beside the slingshot
  let qx = SLING.x - 95;
  for (let i = game.shotsUsed + (game.state === 'aiming' || game.state === 'dragging' ? 1 : 0);
       i < game.shots.length; i++) {
    const t = COMETS[game.shots[i]];
    drawComet(qx, GROUND - t.r * 0.72, t.r * 0.72, game.shots[i], 0, 0, 0);
    qx -= t.r * 1.6 + 14;
  }
}

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#14102b';
  ctx.fillRect(0, 0, cssW, cssH);

  let sx = 0, sy = 0;
  if (game.shakeT > 0 && game.shakeMag > 0) {
    sx = rand(-game.shakeMag, game.shakeMag);
    sy = rand(-game.shakeMag, game.shakeMag);
  }
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (offX + sx * scale), dpr * (offY + sy * scale));

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();

  drawBackground();
  drawSlingshotBack();

  const inMenu = game.state === 'menu';
  const loadedKey = !inMenu && game.shotsUsed < game.shots.length ? game.shots[game.shotsUsed] : null;

  if (!inMenu) {
    drawSlingshotBands(loadedKey && COMETS[loadedKey]);

    // world bodies
    for (const b of game.bodies) {
      if (b.removed) continue;
      if (b.shape === 'box') drawBlock(b);
      else if (b.mat === 'enemy') drawEnemy(b);
      else drawComet(b.x, b.y, b.r, b.cometKey || 'coral', b.vx, b.vy, 0);
    }

    // comet loaded on the sling
    if (loadedKey && (game.state === 'aiming' || game.state === 'dragging')) {
      const p = slingProjectilePos();
      const t = COMETS[loadedKey];
      const pull = clamp(dist(SLING.x, SLING.y, p.x, p.y) / MAX_DRAG, 0, 1);
      drawComet(p.x, p.y, t.r, loadedKey, 0, 0, pull * 0.12);
    }
    drawWaitingComets();
  }

  drawSlingshotFront(loadedKey && COMETS[loadedKey]);
  if (!inMenu) drawTrajectory();

  // particles
  for (const p of game.particles) {
    ctx.globalAlpha = clamp(1 - p.age / p.life, 0, 1);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  // confetti
  for (const c of game.confetti) {
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.fillStyle = c.color;
    ctx.fillRect(-c.size / 2, -c.size / 4, c.size, c.size / 2);
    ctx.restore();
  }

  // score popups
  ctx.font = '700 30px "Trebuchet MS", sans-serif';
  ctx.textAlign = 'center';
  for (const p of game.popups) {
    ctx.globalAlpha = clamp(1.4 - p.age * 1.3, 0, 1);
    ctx.fillStyle = '#1E1436';
    ctx.fillText(p.text, p.x + 2, p.y + 2);
    ctx.fillStyle = '#FFD447';
    ctx.fillText(p.text, p.x, p.y);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

/* ---------------- main loop ---------------- */

let lastT = performance.now();
function frame(now) {
  const dt = Math.min((now - lastT) / 1000, 0.05);
  lastT = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------------- input ---------------- */

let activePointer = null;

canvas.addEventListener('pointerdown', (e) => {
  Sound.init();
  if (game.state !== 'aiming') return;
  const p = toWorld(e.clientX, e.clientY);
  const grabR = e.pointerType === 'touch' ? GRAB_RADIUS * 1.4 : GRAB_RADIUS;
  if (dist(p.x, p.y, SLING.x, SLING.y) <= grabR) {
    activePointer = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    game.state = 'dragging';
    setDrag(p.x, p.y);
    canvas.classList.add('grabbing');
    e.preventDefault();
  }
});

canvas.addEventListener('pointermove', (e) => {
  const p = toWorld(e.clientX, e.clientY);
  if (game.state === 'dragging' && e.pointerId === activePointer) {
    setDrag(p.x, p.y);
    e.preventDefault();
  } else if (game.state === 'aiming') {
    const near = dist(p.x, p.y, SLING.x, SLING.y) <= GRAB_RADIUS;
    canvas.classList.toggle('can-grab', near);
  }
});

function releasePointer(e) {
  if (game.state !== 'dragging' || e.pointerId !== activePointer) return;
  activePointer = null;
  canvas.classList.remove('grabbing');
  const dx = game.dragX - SLING.x, dy = game.dragY - SLING.y;
  if (dist(0, 0, dx, dy) < 18) {
    game.state = 'aiming'; // too small a pull: snap back
  } else {
    launch(dx, dy);
  }
}
canvas.addEventListener('pointerup', releasePointer);
canvas.addEventListener('pointercancel', releasePointer);

function setDrag(x, y) {
  let dx = x - SLING.x, dy = y - SLING.y;
  const d = Math.hypot(dx, dy);
  if (d > MAX_DRAG) { dx *= MAX_DRAG / d; dy *= MAX_DRAG / d; }
  game.dragX = SLING.x + dx;
  game.dragY = Math.min(SLING.y + dy, GROUND - 20);
}

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'r' && game.state !== 'menu') loadLevel(game.levelIndex);
  else if (k === 'escape' && game.state !== 'menu') showPanel('levels');
  else if (k === 'n' && game.state === 'won' && game.levelIndex < LEVELS.length - 1) {
    loadLevel(game.levelIndex + 1);
  }
});

/* ---------------- DOM UI ---------------- */

function showPanel(name) {
  for (const [key, el] of Object.entries(ui.panels)) {
    el.classList.toggle('hidden', key !== name);
  }
  if (name) {
    const btn = ui.panels[name].querySelector('.btn-primary, .btn, button');
    if (btn) btn.focus({ preventScroll: true });
  }
}

function updateHud() {
  ui.level.textContent = `${game.levelIndex + 1} · ${LEVELS[game.levelIndex].name}`;
  ui.score.textContent = game.score;
  let html = '';
  for (let i = 0; i < game.shots.length; i++) {
    const t = COMETS[game.shots[i]];
    const cls = i < game.shotsUsed ? 'used' : i === game.shotsUsed ? 'loaded' : '';
    html += `<span class="pip ${cls}" style="background:${t.color}"></span>`;
  }
  ui.ammo.innerHTML = html;
}

function buildLevelGrid() {
  ui.levelGrid.innerHTML = '';
  LEVELS.forEach((L, i) => {
    const btn = document.createElement('button');
    btn.className = 'level-card';
    btn.setAttribute('aria-label', `Play level ${i + 1}: ${L.name}`);
    const stars = game.best[String(i)] || 0;
    btn.innerHTML =
      `<span class="num">${i + 1}</span>` +
      `<span class="name">${L.name}</span>` +
      `<span class="best">${stars ? '★'.repeat(stars) : '·'}</span>`;
    btn.addEventListener('click', () => loadLevel(i));
    ui.levelGrid.appendChild(btn);
  });
}

document.getElementById('btn-play').addEventListener('click', () => loadLevel(0));
document.getElementById('btn-start-levels').addEventListener('click', () => {
  buildLevelGrid(); showPanel('levels');
});
document.getElementById('btn-levels').addEventListener('click', () => {
  buildLevelGrid(); showPanel('levels');
});
document.getElementById('btn-levels-back').addEventListener('click', () => {
  if (game.state === 'menu') showPanel('start');
  else showPanel(null);
});
document.getElementById('btn-restart').addEventListener('click', () => loadLevel(game.levelIndex));
document.getElementById('btn-win-retry').addEventListener('click', () => loadLevel(game.levelIndex));
document.getElementById('btn-win-levels').addEventListener('click', () => {
  buildLevelGrid(); showPanel('levels');
});
ui.winNext.addEventListener('click', () => {
  if (game.levelIndex < LEVELS.length - 1) loadLevel(game.levelIndex + 1);
});
document.getElementById('btn-lose-retry').addEventListener('click', () => loadLevel(game.levelIndex));
document.getElementById('btn-lose-levels').addEventListener('click', () => {
  buildLevelGrid(); showPanel('levels');
});
document.getElementById('btn-mute').addEventListener('click', (e) => {
  Sound.init();
  Sound.muted = !Sound.muted;
  e.currentTarget.setAttribute('aria-pressed', String(Sound.muted));
});

// initial state: menu with start panel visible
showPanel('start');

})();
