// Client: invoer, UI en de render-loop. Netwerk zit in net.js, spelregels op de server (src/sim.js).
// De eigen speler wordt lokaal voorspeld: een stap is meteen zichtbaar en de server bevestigt later.
const $ = id => document.getElementById(id);
const canvas = $('c');
const pos = new Map(); // pid -> getekende (vloeiende) positie
const TICK_MS = 50, MOVE_TICKS = 3; // gelijk aan CFG in src/sim.js
const STEP_MS = TICK_MS * MOVE_TICKS;
const SPEED = 1000 / STEP_MS; // cellen per seconde
const MAX_PENDING = 4;        // zoveel onbevestigde stappen mogen we vooruitlopen
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
let joined = false;
let pending = []; // voorspelde stappen die de server nog niet bevestigd heeft: {seq, dir}
let nextMoveAt = 0;

$('joinForm').onsubmit = e => {
  e.preventDefault();
  $('err').textContent = '';
  joined = true;
  $('join').style.display = 'none';
  $('name').blur();
  net.join($('name').value);
};

net.hooks.onStatus = text => { $('status').textContent = text; };
net.hooks.onFull = () => {
  joined = false;
  $('join').style.display = '';
  $('err').textContent = 'Het spel zit vol (max 20 spelers).';
};
net.hooks.onWelcome = () => { pending = []; };
net.hooks.onState = () => {
  const me = myPlayer();
  pending = me && me.alive && state.phase === 'playing' ? pending.filter(m => m.seq > me.ack) : [];
  updateUi();
};

const myPlayer = () => state && state.players.find(p => p.pid === net.pid());

// ---- Voorspelling ----
function blocked(x, y) {
  const c = state.grid[y * state.w + x];
  return c === '#' || c === 'c' || state.bombs.some(b => b.x === x && b.y === y);
}
// Serverpositie plus de nog onbevestigde stappen
function predicted(me) {
  let { x, y } = me;
  for (const m of pending) {
    const [dx, dy] = DIRS[m.dir];
    if (!blocked(x + dx, y + dy)) { x += dx; y += dy; }
  }
  return { x, y };
}

// ---- Invoer: toetsenbord en touch geven allebei een "gewenste richting" ----
const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};
const held = [];   // ingedrukte toetsen, laatst ingedrukte wint
let padDir = null; // richting van de touch-stick
let tap = null;    // korte tik levert altijd één stap op

addEventListener('keydown', e => {
  if (!joined || e.repeat) return;
  if (e.code === 'Space') { net.bomb(); e.preventDefault(); return; }
  const d = KEYS[e.code];
  if (!d) return;
  e.preventDefault();
  if (!held.includes(d)) held.push(d);
  tap = d;
});
addEventListener('keyup', e => {
  const i = held.indexOf(KEYS[e.code]);
  if (i >= 0) held.splice(i, 1);
});
addEventListener('blur', () => { held.length = 0; padDir = null; });

// Touch-stick: richting = de as waarlangs de vinger het verst van het midden is
const pad = $('pad'), knob = $('knob');
function padMove(e) {
  const r = pad.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  const max = r.width / 2 - 24, len = Math.hypot(dx, dy) || 1, k = Math.min(1, max / len);
  knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  const d = len < 14 ? null : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
  if (d && d !== padDir) tap = d;
  padDir = d;
}
let padActive = false;
function padEnd() { padActive = false; padDir = null; knob.style.transform = ''; }
pad.addEventListener('pointerdown', e => {
  try { pad.setPointerCapture(e.pointerId); } catch {}
  padActive = true;
  padMove(e);
  e.preventDefault();
});
pad.addEventListener('pointermove', e => { if (padActive) padMove(e); });
pad.addEventListener('pointerup', padEnd);
pad.addEventListener('pointercancel', padEnd);
$('bombBtn').addEventListener('pointerdown', e => { e.preventDefault(); if (joined) net.bomb(); });
addEventListener('contextmenu', e => e.preventDefault());

// Zet stappen zodra het mag; de stap is lokaal meteen zichtbaar
setInterval(() => {
  const dir = held[held.length - 1] || padDir || tap;
  if (!dir) return;
  const me = myPlayer();
  if (!me || !me.alive || state.phase !== 'playing' || !net.connected()) { tap = null; return; }
  const now = performance.now();
  if (now < nextMoveAt || pending.length >= MAX_PENDING) return;
  tap = null;
  const p = predicted(me), [dx, dy] = DIRS[dir];
  if (blocked(p.x + dx, p.y + dy)) return;
  pending.push({ seq: net.move(dir), dir });
  nextMoveAt = now + STEP_MS;
}, 16);

// ---- UI ----
function updateUi() {
  const myId = net.pid();
  const me = myPlayer();
  const secs = Math.ceil(state.timer * TICK_MS / 1000);
  let s;
  if (state.phase === 'lobby') s = 'Wachten op spelers…';
  else if (state.phase === 'countdown') s = `Ronde begint over ${secs}…`;
  else if (state.phase === 'ended') {
    const win = state.players.find(p => p.pid === state.winner);
    s = (win ? `${win.name} wint!` : 'Ronde voorbij') + ` Nieuwe ronde over ${secs}…`;
  } else if (state.idleLeft != null) {
    s = `Iedereen staat stil — nieuwe ronde over ${Math.ceil(state.idleLeft * TICK_MS / 1000)}…`;
  } else {
    const t = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    s = !me ? t : me.alive ? `${t} · 🔥 ${me.range} · 💣 ${me.maxBombs}`
      : `${t} · Je wacht tot de volgende ronde begint`;
  }
  $('status').textContent = s;

  const list = $('list');
  list.textContent = '';
  for (const p of [...state.players].sort((a, b) => b.wins - a.wins || a.slot - b.slot)) {
    const row = document.createElement('div');
    row.className = 'p' + (p.alive ? '' : ' out') + (p.pid === myId ? ' me' : '');
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = playerColor(p.slot);
    const n = document.createElement('span');
    n.className = 'n'; n.textContent = p.name;
    const wins = document.createElement('span');
    wins.textContent = p.wins;
    row.append(dot, n, wins);
    list.append(row);
  }
}

// ---- Render-loop: getekende posities glijden naar hun doel ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state && state.grid) {
    const myId = net.pid();
    for (const p of state.players) {
      const target = p.pid === myId && p.alive ? predicted(p) : p;
      let q = pos.get(p.pid);
      const far = q && Math.abs(q.x - target.x) + Math.abs(q.y - target.y);
      if (!q || far > 5) { q = { x: target.x, y: target.y }; pos.set(p.pid, q); }
      for (const a of ['x', 'y']) {
        const d = target[a] - q[a];
        // Na een hapering (achterstand > 1 cel) sneller inlopen in plaats van verspringen
        q[a] += Math.sign(d) * Math.min(Math.abs(d), SPEED * Math.max(1, Math.abs(d)) * dt);
      }
    }
    render(canvas, state, pos, myId);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
