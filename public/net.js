// Netwerk: één websocket naar de server (/ws). De server draait het spel.
let state = null; // laatste spelstatus van de server

const net = (() => {
  let ws = null, pid = null, name = '', wantJoin = false;
  const hooks = { onState() {}, onStatus() {}, onFull() {} };

  const send = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { if (wantJoin) send({ t: 'join', name }); };
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.t === 'state') { state = m.s; hooks.onState(); }
      else if (m.t === 'welcome') pid = m.pid;
      else if (m.t === 'full') { wantJoin = false; hooks.onFull(); }
    };
    ws.onclose = () => {
      pid = null;
      hooks.onStatus('Verbinding verbroken — opnieuw verbinden…');
      setTimeout(connect, 1000); // na herverbinden doe je vanzelf weer mee
    };
  }
  connect();

  return {
    hooks,
    join(n) { name = n; wantJoin = true; send({ t: 'join', name }); },
    input: dir => send({ t: 'input', dir }),
    bomb: () => send({ t: 'bomb' }),
    pid: () => pid,
  };
})();
