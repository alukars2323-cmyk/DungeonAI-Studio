import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = createApp({
  dataDir: process.env.DUNGEON_DATA_DIR || path.join(root, '.data'),
  aiKey: process.env.DUNGEON_AI_KEY,
  aiModel: process.env.DUNGEON_AI_MODEL,
});
const server = createServer(app);
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}

server.listen(port, host, () => {
  console.log(`DungeonAI Studio started on port ${port} (${process.env.NODE_ENV === 'production' ? 'production' : 'development'})`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
