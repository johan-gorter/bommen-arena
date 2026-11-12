// Alleen voor lokaal testen: serveert de map public/. Het spel zelf is volledig statisch
// (PeerJS, host draait in de browser) en kan op elke statische webhost staan.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

http.createServer((req, res) => {
  const name = path.basename(req.url.split('?')[0]) || 'index.html';
  fs.readFile(path.join(ROOT, name), (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': (TYPES[path.extname(name)] || 'application/octet-stream') + '; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Bommen Arena op http://localhost:${PORT}`));
