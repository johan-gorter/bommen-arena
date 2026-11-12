// Spel-logica. Draait alleen bij de host. De hele spelstatus is één JSON-object,
// zodat een nieuwe host het spel kan overnemen vanaf de laatst ontvangen status.
const CFG = {
  MAX_PLAYERS: 16,
  TICK_MS: 50,
  MOVE_TICKS: 3,        // ticks per stap (150 ms per cel)
  FUSE_TICKS: 50,       // 2,5 s
  FLAME_TICKS: 10,      // 0,5 s
  COUNTDOWN_TICKS: 60,  // 3 s
  ENDED_TICKS: 80,      // 4 s
  ROUND_TICKS: 3 * 60 * 20, // 3 min, daarna gelijkspel
  CRATE_CHANCE: 0.8,
  POWERUP_CHANCE: 0.3,
  START_RANGE: 2,
  START_BOMBS: 1,
};

// Grid-tekens: '#' muur, 'c' krat, ' ' leeg, 'f' vlam-powerup, 'b' bom-powerup
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const toOdd = v => 2 * Math.round((v - 1) / 2) + 1;

function newGame() {
  return {
    gameId: Math.random().toString(36).slice(2, 10),
    hostPid: null,
    phase: 'lobby', // lobby | countdown | playing | ended
    timer: 0, tick: 0, w: 11, h: 9,
    grid: '',       // w*h tekens
    bombs: [],      // {x, y, owner, range, at}
    flames: [],     // [celindex, tick waarop de vlam dooft]
    winner: null,   // pid, of null bij gelijkspel
    solo: false,
    players: [],    // volgorde = volgorde van binnenkomst = volgorde van host-opvolging
  };
}

function addPlayer(s, pid, name) {
  if (s.players.length >= CFG.MAX_PLAYERS) return null;
  const used = new Set(s.players.map(p => p.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  // Nieuwe spelers wachten (alive: false) tot de volgende ronde
  const p = {
    pid, slot, name: String(name || '').trim().slice(0, 12) || 'Speler ' + (slot + 1),
    x: 0, y: 0, alive: false, wins: 0, conn: true, lostAt: 0,
    dir: null, tap: null, cooldown: 0, range: CFG.START_RANGE, maxBombs: CFG.START_BOMBS, active: 0,
  };
  s.players.push(p);
  return p;
}

function removePlayer(s, pid) {
  s.players = s.players.filter(p => p.pid !== pid);
}

const getPlayer = (s, pid) => s.players.find(p => p.pid === pid);
const cell = (s, x, y) => s.grid[y * s.w + x];
function setCell(s, x, y, c) {
  const k = y * s.w + x;
  s.grid = s.grid.slice(0, k) + c + s.grid.slice(k + 1);
}
const hasFlame = (s, k) => s.flames.some(f => f[0] === k);
function setFlame(s, k, until) {
  const f = s.flames.find(f => f[0] === k);
  if (f) f[1] = until; else s.flames.push([k, until]);
}

function setInput(s, pid, dir) {
  const p = getPlayer(s, pid);
  if (!p) return;
  p.dir = Object.hasOwn(DIRS, dir) ? dir : null;
  if (p.dir) p.tap = p.dir; // korte toetsaanslag levert altijd één stap op
}

function placeBomb(s, pid) {
  const p = getPlayer(s, pid);
  if (!p || s.phase !== 'playing' || !p.alive || p.active >= p.maxBombs) return;
  if (s.bombs.some(b => b.x === p.x && b.y === p.y)) return;
  s.bombs.push({ x: p.x, y: p.y, owner: pid, range: p.range, at: s.tick + CFG.FUSE_TICKS });
  p.active++;
}

function startRound(s) {
  const ps = [...s.players].sort(() => Math.random() - 0.5);
  if (!ps.length) { s.phase = 'lobby'; return; }

  // Veldgrootte groeit mee met het aantal spelers
  const area = 60 + ps.length * 45;
  s.w = toOdd(Math.sqrt(area * 1.25));
  s.h = toOdd(area / s.w);
  const { w, h } = s;

  let grid = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wall = x === 0 || y === 0 || x === w - 1 || y === h - 1 || (x % 2 === 0 && y % 2 === 0);
      grid += wall ? '#' : Math.random() < CFG.CRATE_CHANCE ? 'c' : ' ';
    }
  }
  s.grid = grid;

  // Startplekken: zo ver mogelijk uit elkaar (farthest-point sampling)
  const cand = [];
  for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) cand.push([x, y]);
  const spawns = [cand[0]];
  while (spawns.length < ps.length) {
    let best = null, bestD = -1;
    for (const c of cand) {
      const d = Math.min(...spawns.map(q => Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1])));
      if (d > bestD) { bestD = d; best = c; }
    }
    spawns.push(best);
  }

  ps.forEach((p, i) => {
    const [x, y] = spawns[i];
    Object.assign(p, { x, y, alive: true, dir: null, tap: null, cooldown: 0,
      range: CFG.START_RANGE, maxBombs: CFG.START_BOMBS, active: 0 });
    // Het "gat": eigen cel plus boven, onder, links en rechts leeg
    for (const [dx, dy] of [[0, 0], ...Object.values(DIRS)]) {
      if (cell(s, x + dx, y + dy) !== '#') setCell(s, x + dx, y + dy, ' ');
    }
  });

  s.bombs = [];
  s.flames = [];
  s.winner = null;
  s.solo = ps.length === 1;
  s.phase = 'countdown';
  s.timer = CFG.COUNTDOWN_TICKS;
}

function endRound(s, winnerPid) {
  s.winner = winnerPid;
  const p = winnerPid != null && getPlayer(s, winnerPid);
  if (p && !s.solo) p.wins++;
  s.phase = 'ended';
  s.timer = CFG.ENDED_TICKS;
}

function explode(s, bomb) {
  s.bombs.splice(s.bombs.indexOf(bomb), 1);
  const owner = getPlayer(s, bomb.owner);
  if (owner) owner.active--;
  const until = s.tick + CFG.FLAME_TICKS;
  setFlame(s, bomb.y * s.w + bomb.x, until);
  for (const [dx, dy] of Object.values(DIRS)) {
    for (let i = 1; i <= bomb.range; i++) {
      const x = bomb.x + dx * i, y = bomb.y + dy * i, k = y * s.w + x;
      const c = cell(s, x, y);
      if (c === '#') break;
      if (c === 'c') {
        const r = Math.random();
        setCell(s, x, y, r < CFG.POWERUP_CHANCE / 2 ? 'f' : r < CFG.POWERUP_CHANCE ? 'b' : ' ');
        setFlame(s, k, until);
        break;
      }
      if (c !== ' ' && !hasFlame(s, k)) setCell(s, x, y, ' '); // powerup verbrandt
      setFlame(s, k, until);
      const other = s.bombs.find(b => b.x === x && b.y === y);
      if (other) other.at = s.tick; // kettingreactie
    }
  }
}

// Eén tick van het spel
function step(s) {
  s.tick++;
  if (s.phase === 'lobby') {
    if (s.players.length) startRound(s);
  } else if (s.phase === 'countdown') {
    if (--s.timer <= 0) { s.phase = 'playing'; s.timer = CFG.ROUND_TICKS; }
  } else if (s.phase === 'ended') {
    if (--s.timer <= 0) startRound(s);
  } else if (s.phase === 'playing') {
    for (const p of s.players) {
      if (!p.alive) continue;
      if (p.cooldown > 0) p.cooldown--;
      const dir = p.dir || p.tap;
      if (p.cooldown > 0 || !dir) continue;
      p.tap = null;
      const [dx, dy] = DIRS[dir];
      const x = p.x + dx, y = p.y + dy;
      const c = cell(s, x, y);
      if (c === '#' || c === 'c' || s.bombs.some(b => b.x === x && b.y === y)) continue;
      p.x = x; p.y = y; p.cooldown = CFG.MOVE_TICKS;
      if (c === 'f') { p.range++; setCell(s, x, y, ' '); }
      if (c === 'b') { p.maxBombs++; setCell(s, x, y, ' '); }
    }
    let b;
    while ((b = s.bombs.find(b => b.at <= s.tick))) explode(s, b);
    s.flames = s.flames.filter(f => f[1] > s.tick);
    for (const p of s.players) {
      if (p.alive && hasFlame(s, p.y * s.w + p.x)) p.alive = false;
    }
    const alive = s.players.filter(p => p.alive);
    s.timer--;
    if (s.solo) {
      if (!alive.length || s.players.length > 1) endRound(s, null);
    } else if (alive.length <= 1) {
      endRound(s, alive.length ? alive[0].pid : null);
    } else if (s.timer <= 0) {
      endRound(s, null);
    }
  }
}
