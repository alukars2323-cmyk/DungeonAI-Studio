import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Verification server for the compiled static site. It exposes no application API.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist-pages');
const prefix = '/DungeonAI-Studio/';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/DungeonAI-Studio') { res.writeHead(302, { Location: prefix }); res.end(); return; }
    if (!pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
    const relative = pathname.slice(prefix.length) || 'index.html';
    const filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
    const data = await readFile(filename);
    res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.PAGES_PORT || 3102), '127.0.0.1', () => console.log('Static Pages verification server started'));
