// Netwerk: één websocket naar de server (/ws). De server draait het spel.
// Valt de verbinding weg, dan verbinden we opnieuw met dezelfde sleutel en houden we onze plek.
let state = null; // laatste spelstatus van de server

const net = (() => {
  const STALE_MS = 3000; // zo lang niets gehoord = verbinding als dood beschouwen
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
  let ws = null, pid = null, name = '', wantJoin = false, seq = 0, lastMsg = 0;
  const hooks = { onState() {}, onStatus() {}, onFull() {}, onWelcome() {} };

  const open = () => ws && ws.readyState === 1;
  const send = m => { if (open()) ws.send(JSON.stringify(m)); };
  const sendJoin = () => send({ t: 'join', name, key });

  function connect() {
    const sock = ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    lastMsg = Date.now();
    sock.onopen = () => { if (wantJoin) sendJoin(); };
    sock.onmessage = e => {
      if (ws !== sock) return;
      lastMsg = Date.now();
      const m = JSON.parse(e.data);
      if (m.t === 'state') { state = m.s; hooks.onState(); }
      else if (m.t === 'welcome') { pid = m.pid; hooks.onWelcome(); }
      else if (m.t === 'full') { wantJoin = false; hooks.onFull(); }
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      hooks.onStatus('Verbinding verbroken — opnieuw verbinden…');
      setTimeout(connect, 500);
    };
  }
  connect();

  // Een hangende verbinding merk je niet altijd vanzelf: zelf bewaken
  setInterval(() => {
    if (ws && Date.now() - lastMsg > STALE_MS) {
      const sock = ws;
      sock.onclose();
      try { sock.close(); } catch {}
    }
  }, 1000);

  return {
    hooks,
    join(n) { name = n; wantJoin = true; sendJoin(); },
    // Geeft het volgnummer terug; de server meldt in p.ack tot waar hij verwerkt heeft
    move(dir) { send({ t: 'move', seq: ++seq, dir }); return seq; },
    bomb() { send({ t: 'bomb', seq: ++seq }); },
    connected: () => open() && pid != null,
    pid: () => pid,
  };
})();
