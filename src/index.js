// Cloudflare Worker: Hono voor de routes, één Durable Object dat het ene spel draait.
// Statische bestanden (public/) worden door Workers Assets geserveerd.
import { Hono } from 'hono';
import { DurableObject } from 'cloudflare:workers';
import { CFG, newGame, addPlayer, removePlayer, queueAction, step } from './sim.js';

const MAX_SOCKETS = 64;   // spelers plus toeschouwers die nog geen naam hebben ingevuld
const GRACE_MS = 5000;    // zo lang houdt een speler zijn plek na een verbroken verbinding

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
    this.reset();
    this.interval = null;
  }

  reset() {
    this.game = newGame();
    this.sockets = new Map(); // WebSocket -> pid (null zolang de speler niet meedoet)
    this.keys = new Map();    // geheime sleutel van de client -> pid, voor herverbinden
    this.away = new Map();    // pid -> tijdstip waarop de verbinding wegviel
    this.nextId = 1;
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
    if (!this.interval) {
      this.nextAt = Date.now() + CFG.TICK_MS;
      this.interval = setInterval(() => this.tick(), CFG.TICK_MS / 2);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(ws, data) {
    if (typeof data !== 'string' || data.length > 200) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m !== 'object' || !this.sockets.has(ws)) return;
    const pid = this.sockets.get(ws);
    if (m.t === 'join' && pid == null) this.join(ws, m);
    else if (pid == null) return;
    else if (m.t === 'move') queueAction(this.game, pid, { seq: m.seq, dir: m.dir });
    else if (m.t === 'bomb') queueAction(this.game, pid, { seq: m.seq, bomb: true });
  }

  join(ws, m) {
    const key = typeof m.key === 'string' ? m.key.slice(0, 40) : '';
    let p = key && this.game.players.find(q => q.pid === this.keys.get(key));
    if (p) {
      // Terug na een netwerkhapering: zelfde speler, oude verbinding loslaten
      for (const [other, pid] of this.sockets) if (pid === p.pid) this.sockets.set(other, null);
      this.away.delete(p.pid);
    } else {
      p = addPlayer(this.game, this.nextId, m.name);
      if (!p) return ws.send(JSON.stringify({ t: 'full' }));
      this.nextId++;
      if (key) this.keys.set(key, p.pid);
    }
    this.sockets.set(ws, p.pid);
    ws.send(JSON.stringify({ t: 'welcome', pid: p.pid }));
  }

  onClose(ws) {
    if (!this.sockets.has(ws)) return;
    const pid = this.sockets.get(ws);
    this.sockets.delete(ws);
    try { ws.close(); } catch {}
    if (pid != null) this.away.set(pid, Date.now()); // plek blijft nog even bewaard
  }

  tick() {
    const now = Date.now();
    for (const [pid, since] of this.away) {
      if (now - since < GRACE_MS) continue;
      this.away.delete(pid);
      removePlayer(this.game, pid);
      for (const [key, p] of this.keys) if (p === pid) this.keys.delete(key);
    }
    if (!this.sockets.size && !this.away.size) { // niemand meer: stoppen en schoon beginnen
      clearInterval(this.interval);
      this.interval = null;
      this.reset();
      return;
    }
    // Op kloktijd lopen: een trage of haperende timer wordt ingehaald met extra stappen
    let steps = 0;
    while (now >= this.nextAt && steps < 5) { step(this.game); this.nextAt += CFG.TICK_MS; steps++; }
    if (steps === 5) this.nextAt = now + CFG.TICK_MS;
    if (!steps) return;
    const msg = JSON.stringify({ t: 'state', s: this.game });
    for (const ws of [...this.sockets.keys()]) {
      try { ws.send(msg); } catch { this.onClose(ws); }
    }
  }
}
