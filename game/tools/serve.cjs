const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // game/tools -> корень репозитория
const PORT = parseInt(process.argv[2] || '8000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.txt': 'text/plain; charset=utf-8',
};

function serve(req, res) {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let p = path.join(ROOT, 'game', url === '/' ? 'index.html' : url);
  if (!p.startsWith(path.join(ROOT, 'game'))) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(p, (err, st) => {
    if (err || st.isDirectory()) {
      if (!err && st.isDirectory()) { p = path.join(p, 'index.html'); } else {
        // fallback: возможно, запрос к корню репозитория (releases)
        const alt = path.join(ROOT, url);
        if (fs.existsSync(alt) && fs.statSync(alt).isFile()) return sendFile(alt, req, res);
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + url);
      }
    }
    sendFile(p, req, res);
  });
}
function sendFile(p, req, res) {
  const ext = path.extname(p).toLowerCase();
  const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
  res.writeHead(200, h);
  fs.createReadStream(p).pipe(res);
}

http.createServer(serve).listen(PORT, '0.0.0.0', () => console.log('ShopSim dev server on 0.0.0.0:' + PORT));
