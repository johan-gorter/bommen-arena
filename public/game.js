// Client: invoer, UI en de render-loop. Netwerk zit in net.js, spelregels in sim.js.
const $ = id => document.getElementById(id);
const canvas = $('c');
const pos = new Map(); // pid -> geïnterpoleerde positie
const SPEED = 1000 / (CFG.TICK_MS * CFG.MOVE_TICKS); // cellen per seconde
let joined = false;

$('joinForm').onsubmit = e => {
  e.preventDefault();
  $('err').textContent = '';
  joined = true;
  $('join').style.display = 'none';
  net.join($('name').value);
};

net.hooks.onStatus = text => { $('status').textContent = text; $('host').hidden = true; };
net.hooks.onFull = () => {
  joined = false;
  $('join').style.display = '';
  $('err').textContent = 'Het spel zit vol (max 16 spelers).';
};
net.hooks.onState = updateUi;

// ---- Invoer ----
const KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};
const held = []; // laatst ingedrukte richting wint
addEventListener('keydown', e => {
  if (!joined || e.repeat) return;
  if (e.code === 'Space') { net.bomb(); e.preventDefault(); return; }
  const d = KEYS[e.code];
  if (!d) return;
  e.preventDefault();
  if (!held.includes(d)) held.push(d);
  net.input(d);
});
addEventListener('keyup', e => {
  const d = KEYS[e.code];
  if (!d) return;
  const i = held.indexOf(d);
  if (i >= 0) held.splice(i, 1);
  net.input(held[held.length - 1] || null);
});
addEventListener('blur', () => { held.length = 0; net.input(null); });

// ---- UI ----
function updateUi() {
  if (!net.role()) return; // tijdens een host-wissel blijft de statusmelding staan
  const myId = net.pid();
  const me = state.players.find(p => p.pid === myId);
  const secs = Math.ceil(state.timer * CFG.TICK_MS / 1000);
  let s;
  if (state.phase === 'lobby') s = 'Wachten op spelers…';
  else if (state.phase === 'countdown') s = `Ronde begint over ${secs}…`;
  else if (state.phase === 'ended') {
    const win = state.players.find(p => p.pid === state.winner);
    s = (win ? `${win.name} wint!` : 'Ronde voorbij') + ` Nieuwe ronde over ${secs}…`;
  } else {
    const t = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    s = !me ? t : me.alive ? `${t} · 🔥 ${me.range} · 💣 ${me.maxBombs}`
      : `${t} · Je wacht tot de volgende ronde begint`;
  }
  $('status').textContent = s;
  $('host').hidden = net.role() !== 'host';

  const list = $('list');
  list.textContent = '';
  for (const p of [...state.players].sort((a, b) => b.wins - a.wins || a.slot - b.slot)) {
    const row = document.createElement('div');
    row.className = 'p' + (p.alive ? '' : ' out') + (p.pid === myId ? ' me' : '');
    const dot = document.createElement('span');
    dot.className = 'dot'; dot.style.background = playerColor(p.slot);
    const n = document.createElement('span');
    n.className = 'n'; n.textContent = p.name + (p.pid === state.hostPid ? ' 👑' : '');
    const wins = document.createElement('span');
    wins.textContent = p.wins;
    row.append(dot, n, wins);
    list.append(row);
  }
}

// ---- Render-loop met interpolatie ----
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (state && state.grid) {
    for (const p of state.players) {
      let q = pos.get(p.pid);
      if (!q || Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > 2) { q = { x: p.x, y: p.y }; pos.set(p.pid, q); }
      for (const a of ['x', 'y']) {
        const d = p[a] - q[a];
        q[a] += Math.sign(d) * Math.min(Math.abs(d), SPEED * dt);
      }
    }
    render(canvas, state, pos, net.pid());
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
