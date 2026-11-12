// Tekenlaag. Uitbreiden = een functie in `sprites` vervangen (bijv. door ctx.drawImage).
// Elke sprite krijgt: ctx, x en y in pixels (linkerbovenhoek van de cel), s = celgrootte, data.
const playerColor = slot => `hsl(${(slot * 137.5) % 360} 75% 60%)`;

const sprites = {
  floor(ctx, x, y, s) { ctx.fillStyle = '#3a7d44'; ctx.fillRect(x, y, s, s); },
  wall(ctx, x, y, s) { ctx.fillStyle = '#555b66'; ctx.fillRect(x, y, s, s); },
  crate(ctx, x, y, s) {
    ctx.fillStyle = '#b07a3b'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
  },
  powerFlame(ctx, x, y, s) { circle(ctx, x, y, s, 0.3, '#ff7b2e'); label(ctx, x, y, s, '🔥'); },
  powerBomb(ctx, x, y, s) { circle(ctx, x, y, s, 0.3, '#222'); label(ctx, x, y, s, '+'); },
  bomb(ctx, x, y, s) { circle(ctx, x, y, s, 0.36, '#111'); },
  flame(ctx, x, y, s) { ctx.fillStyle = '#ffd23e'; ctx.fillRect(x, y, s, s); },
  player(ctx, x, y, s, p) {
    circle(ctx, x, y, s, 0.4, playerColor(p.slot));
    if (p.isMe) { ctx.strokeStyle = '#fff'; ctx.lineWidth = Math.max(2, s / 12); ctx.stroke(); }
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.max(9, s * 0.3)}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(p.name, x + s / 2, y + s * 0.1);
  },
};

function circle(ctx, x, y, s, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(x + s / 2, y + s / 2, s * r, 0, Math.PI * 2); ctx.fill();
}
function label(ctx, x, y, s, text) {
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${s * 0.4}px system-ui`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + s / 2, y + s / 2);
}

const TILE_SPRITE = { '#': 'wall', c: 'crate', f: 'powerFlame', b: 'powerBomb' };

// state: laatste spelstatus; pos: Map pid -> {x, y} (geïnterpoleerde posities); myId
function render(canvas, state, pos, myId) {
  const wrap = canvas.parentElement;
  const s = Math.max(8, Math.floor(Math.min(wrap.clientWidth / state.w, wrap.clientHeight / state.h)));
  if (canvas.width !== s * state.w || canvas.height !== s * state.h) {
    canvas.width = s * state.w; canvas.height = s * state.h;
  }
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < state.h; y++) {
    for (let x = 0; x < state.w; x++) {
      sprites.floor(ctx, x * s, y * s, s);
      const name = TILE_SPRITE[state.grid[y * state.w + x]];
      if (name) sprites[name](ctx, x * s, y * s, s);
    }
  }
  for (const b of state.bombs) sprites.bomb(ctx, b.x * s, b.y * s, s);
  for (const [k] of state.flames) sprites.flame(ctx, (k % state.w) * s, Math.floor(k / state.w) * s, s);
  for (const p of state.players) {
    if (!p.alive) continue;
    const q = pos.get(p.pid) || p;
    sprites.player(ctx, q.x * s, q.y * s, s, { ...p, isMe: p.pid === myId });
  }
}
