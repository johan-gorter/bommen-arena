// Cloudflare Worker: Hono voor de routes, één Durable Object dat het ene spel draait.
// Statische bestanden (public/) worden door Workers Assets geserveerd.
import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import { CFG, newGame, addPlayer, removePlayer, setInput, placeBomb, step } from './sim.js';

const MAX_SOCKETS = 64; // spelers plus toeschouwers die nog geen naam hebben ingevuld

const app = new Hono();

app.get('/ws', c => {
  if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected websocket', 426);
  // Altijd dezelfde naam -> altijd hetzelfde object -> er is maar één spel
  const stub = c.env.GAME.get(c.env.GAME.idFromName('main'));
  return stub.fetch(c.req.raw);
});

export default app;

export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.game = newGame();
    this.sockets = new Map(); // WebSocket -> pid (null zolang de speler niet meedoet)
    this.nextId = 1;
    this.interval = null;
  }

  async fetch() {
    if (this.sockets.size >= MAX_SOCKETS) return new Response('Vol', { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.set(server, null);
    server.addEventListener('message', e => this.onMessage(server, e.data));
    server.addEventListener('close', () => this.onClose(server));
    server.addEventListener('error', () => this.onClose(server));
    if (!this.interval) this.interval = setInterval(() => this.tick(), CFG.TICK_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 200) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object') return;
    const pid = this.sockets.get(ws);
    if (m.t === 'join' && pid == null) {
      const p = addPlayer(this.game, this.nextId, m.name);
      if (!p) return ws.send(JSON.stringify({ t: 'full' }));
      this.sockets.set(ws, this.nextId++);
      ws.send(JSON.stringify({ t: 'welcome', pid: p.pid }));
    } else if (pid != null) {
      if (m.t === 'input') setInput(this.game, pid, m.dir);
      else if (m.t === 'bomb') placeBomb(this.game, pid);
    }
  }

  onClose(ws) {
    if (!this.sockets.has(ws)) return;
    const pid = this.sockets.get(ws);
    this.sockets.delete(ws);
    if (pid != null) removePlayer(this.game, pid);
    try { ws.close(); } catch {}
    if (!this.sockets.size) { // niemand meer: stoppen en schoon beginnen
      clearInterval(this.interval);
      this.interval = null;
      this.game = newGame();
    }
  }

  tick() {
    step(this.game);
    const msg = JSON.stringify({ t: 'state', s: this.game });
    for (const ws of [...this.sockets.keys()]) {
      try { ws.send(msg); } catch { this.onClose(ws); }
    }
  }
}
