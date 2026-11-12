// Netwerk via PeerJS (WebRTC), zonder eigen server.
//
// Wie host is, wordt bepaald door één vaste peer-ID (ROOM). De PeerJS-server geeft die ID
// aan precies één deelnemer tegelijk: wie hem heeft is de host, alle anderen verbinden ermee.
// - Host weg  -> de volgende speler in de lijst claimt ROOM en gaat verder vanaf de laatste status.
//                De overige spelers wachten (rang * 2,5 s) en nemen het alleen over als dat mislukt.
// - Onenigheid -> een host die ROOM kwijt is treedt af en wordt gewoon speler. Komen er spelers
//                binnen uit een ander spel (andere gameId), dan reset de host alles.
const ROOM = 'bommen-arena-' + (new URLSearchParams(location.search).get('room') || 'k7q2x9');
const GRACE_TICKS = 100;      // 5 s om na een host-wissel opnieuw te verbinden
const HOST_TIMEOUT_MS = 3000; // zo lang niets van de host gehoord = host weg
const CLIENT_TIMEOUT_MS = 6000;

let state = null; // laatste spelstatus (bij de host: het spel zelf)

const net = (() => {
  let me = null;       // eigen peer; me.id is je speler-id
  let room = null;     // alleen bij de host: de peer met de vaste ROOM-ID
  let conn = null;     // alleen bij spelers: verbinding met de host
  let role = null;     // 'host' | 'client' | null (zoekend)
  let name = '';
  let game = null;
  let stopped = true;
  let seekTimer, connTimer, ticker, lastMsg = 0;
  const conns = new Map();  // pid -> { c, seen }
  const merged = new Set(); // gameIds die al tot een reset hebben geleid
  const hooks = { onState() {}, onStatus() {}, onFull() {} };

  function join(n) {
    name = n;
    stopped = false;
    if (me && !me.destroyed) { if (me.open) seek(0, 0); return; }
    hooks.onStatus('Verbinden…');
    me = new Peer();
    const p = me;
    p.on('open', () => seek(0, 0));
    p.on('disconnected', () => { if (!p.destroyed) p.reconnect(); });
    p.on('error', e => {
      if (e.type === 'peer-unavailable') return connectFailed();
      if (p.destroyed && me === p && !stopped) {
        hooks.onStatus('Geen verbinding met de PeerJS-server — opnieuw proberen…');
        me = null;
        setTimeout(() => { if (!stopped) join(name); }, 2000);
      }
    });
  }

  function seek(delay, retries) {
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => tryClaim(retries), delay);
  }

  // Probeer host te worden. Lukt dat niet omdat er al een host is, verbind dan als speler.
  function tryClaim(retries) {
    if (role || stopped || !me || !me.open) return;
    const r = new Peer(ROOM);
    let settled = false;
    r.on('open', () => { settled = true; room = r; becomeHost(); });
    r.on('disconnected', () => { if (room === r && !r.destroyed) r.reconnect(); });
    r.on('error', e => {
      if (room === r) { // we waren host
        if (e.type === 'unavailable-id' || r.destroyed) stepDown();
        return;
      }
      if (settled) return;
      settled = true;
      r.destroy();
      if (e.type !== 'unavailable-id') seek(1500, retries);
      else if (retries > 0) seek(400, retries - 1);
      else tryConnect();
    });
  }

  function tryConnect() {
    if (role || stopped) return;
    if (!me || me.destroyed) return;
    if (me.disconnected) { me.reconnect(); return seek(1000, 0); }
    const c = me.connect(ROOM, { serialization: 'json', reliable: true });
    if (!c) return seek(1000, 0);
    conn = c;
    clearTimeout(connTimer);
    connTimer = setTimeout(connectFailed, 5000);
    c.on('open', () => {
      if (conn !== c) return;
      clearTimeout(connTimer);
      role = 'client';
      lastMsg = Date.now();
      c.send({ t: 'hello', name, gameId: state && state.gameId });
    });
    c.on('data', m => {
      if (conn !== c || !m) return;
      lastMsg = Date.now();
      if (m.t === 'state') { state = m.s; hooks.onState(); }
      else if (m.t === 'bye') hostLost();
      else if (m.t === 'full') { stopped = true; role = null; conn = null; c.close(); hooks.onFull(); }
    });
    c.on('close', () => { if (conn === c) hostLost(); });
    c.on('error', () => {});
  }

  function connectFailed() {
    if (role || !conn) return;
    clearTimeout(connTimer);
    const c = conn;
    conn = null;
    try { c.close(); } catch {}
    seek(300 + Math.random() * 500, 0);
  }

  // De host is weg: de eerstvolgende speler in de lijst neemt het over.
  function hostLost() {
    if (role !== 'client') return connectFailed();
    role = null;
    const c = conn;
    conn = null;
    try { c.close(); } catch {}
    let rank = 0;
    if (state) {
      const order = state.players.filter(p => p.pid !== state.hostPid && p.conn !== false).map(p => p.pid);
      rank = order.indexOf(me.id);
      if (rank < 0) rank = order.length;
    }
    hooks.onStatus('Host is weg — nieuwe host wordt gekozen…');
    seek(rank * 2500, rank === 0 ? 5 : 0);
  }

  function becomeHost() {
    role = 'host';
    if (state && state.gameId) {
      // Overnemen: ga verder vanaf de laatst bekende status
      game = state;
      game.players = game.players.filter(p => p.pid !== game.hostPid || p.pid === me.id);
      for (const p of game.players) {
        if (p.pid !== me.id) { p.conn = false; p.lostAt = game.tick; p.dir = null; }
      }
      const mine = getPlayer(game, me.id) || addPlayer(game, me.id, name);
      mine.conn = true;
    } else {
      game = newGame();
      addPlayer(game, me.id, name);
    }
    game.hostPid = me.id;
    conns.clear();
    room.on('connection', onConnection);
    // Timer in een worker: loopt door als het tabblad op de achtergrond staat
    const src = `setInterval(() => postMessage(0), ${CFG.TICK_MS})`;
    ticker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    ticker.onmessage = tick;
  }

  // Onenigheid: wij zijn de vaste ID kwijt, dus iemand anders is host. Aftreden en aansluiten.
  function stepDown() {
    if (role !== 'host') return;
    role = null;
    if (ticker) ticker.terminate();
    ticker = null;
    for (const e of conns.values()) try { e.c.close(); } catch {}
    conns.clear();
    try { room.destroy(); } catch {}
    room = null;
    game = null;
    hooks.onStatus('Host-conflict — opnieuw aansluiten…');
    seek(0, 0);
  }

  // Onenigheid: er sluit iemand aan uit een ander spel. Alles reset, deze host blijft host.
  function resetAll(otherGameId) {
    merged.add(otherGameId);
    merged.add(game.gameId);
    const old = game;
    game = newGame();
    game.hostPid = me.id;
    for (const p of old.players) if (p.conn !== false) addPlayer(game, p.pid, p.name);
  }

  function onConnection(c) {
    c.on('data', m => {
      if (role !== 'host' || !m) return;
      const pid = c.peer;
      if (m.t === 'hello') {
        if (m.gameId && m.gameId !== game.gameId && !merged.has(m.gameId)) resetAll(m.gameId);
        let p = getPlayer(game, pid);
        if (p) p.conn = true; // terug na een host-wissel
        else p = addPlayer(game, pid, m.name);
        if (!p) { c.send({ t: 'full' }); return; }
        conns.set(pid, { c, seen: Date.now() });
        return;
      }
      const e = conns.get(pid);
      if (!e || e.c !== c) return;
      e.seen = Date.now();
      if (m.t === 'input') setInput(game, pid, m.dir);
      else if (m.t === 'bomb') placeBomb(game, pid);
    });
    c.on('close', () => {
      const e = conns.get(c.peer);
      if (e && e.c === c) drop(c.peer);
    });
    c.on('error', () => {});
  }

  function drop(pid) {
    conns.delete(pid);
    if (game) removePlayer(game, pid);
  }

  function tick() {
    if (role !== 'host') return;
    step(game);
    for (const p of [...game.players]) {
      if (p.conn === false && game.tick - p.lostAt > GRACE_TICKS) removePlayer(game, p.pid);
    }
    const now = Date.now();
    const msg = { t: 'state', s: game };
    for (const [pid, e] of [...conns]) {
      if (now - e.seen > CLIENT_TIMEOUT_MS) { try { e.c.close(); } catch {} drop(pid); continue; }
      if (e.c.open) e.c.send(msg);
    }
    state = game;
    hooks.onState();
  }

  // Spelers: ping naar de host en bewaken of de host nog leeft
  setInterval(() => {
    if (role !== 'client' || !conn) return;
    if (Date.now() - lastMsg > HOST_TIMEOUT_MS) return hostLost();
    if (conn.open) conn.send({ t: 'ping' });
  }, 1000);

  // Netjes afmelden, zodat de overdracht meteen gebeurt
  addEventListener('pagehide', () => {
    stopped = true;
    if (role === 'host') {
      for (const e of conns.values()) try { e.c.send({ t: 'bye' }); } catch {}
      try { room.destroy(); } catch {}
    }
    if (me) try { me.destroy(); } catch {}
  });

  function input(dir) {
    if (role === 'host') setInput(game, me.id, dir);
    else if (role === 'client' && conn.open) conn.send({ t: 'input', dir });
  }
  function bomb() {
    if (role === 'host') placeBomb(game, me.id);
    else if (role === 'client' && conn.open) conn.send({ t: 'bomb' });
  }

  return {
    join, input, bomb, hooks,
    pid: () => (me ? me.id : null),
    role: () => role,
  };
})();
