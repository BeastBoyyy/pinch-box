// Tiny static server (correct MIME types incl. .wasm/.mjs, HTTP Range for video). `npm start` -> http://localhost:8080
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8080;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.task': 'application/octet-stream', '.mp4': 'video/mp4', '.png': 'image/png', '.css': 'text/css', '.glsl': 'text/plain', '.onnx': 'application/octet-stream', '.ico': 'image/x-icon' };

/** rootDir: folder to serve (default: the project); p = 0 picks a free port. Binds to 127.0.0.1 only. */
export function start(p = port, root = defaultRoot) {
  root = normalize(root);
  const srv = createServer((req, res) => {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || file.includes('node_modules') && !file.includes('vendor') || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    const size = statSync(file).size, type = MIME[extname(file)] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Cross-Origin-Resource-Policy': 'same-origin' };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = m[1] ? Number(m[1]) : size - Number(m[2]), b = m[1] && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
      createReadStream(file, { start: a, end: b }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': size });
      createReadStream(file).pipe(res);
    }
  });
  return new Promise(r => srv.listen(p, '127.0.0.1', () => r(srv)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  await start();
  console.log(`Pinch-Box: http://localhost:${port}`);
}
