/**
 * HTTP + WebSocket server. Serves the static frontend (web/), the bundled
 * fonts (fonts/), and the same API surface the frontend expects:
 *   GET  /api/snapshot   current snapshot
 *   GET  /api/health     liveness + build
 *   GET  /api/config     settings schema (stub in the PoC)
 *   WS   /ws             pushes a new snapshot whenever the version changes
 */

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { State } from './state.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..'); // project root (src/ under tsx, dist/ once built)
const WEB_DIR = path.join(ROOT, 'web');
const FONT_DIR = path.join(ROOT, 'fonts');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export function startServer(state: State, port: number, host = '0.0.0.0') {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const p = url.pathname;
    res.setHeader('Cache-Control', 'no-store');

    if (p === '/api/health') return json(res, { status: 'ok', build: state.snapshot().build });
    if (p === '/api/snapshot') return json(res, state.snapshot());
    if (p === '/api/config') return json(res, { sections: [] }); // stub for the PoC
    if (p === '/api/system') {
      res.statusCode = 501;
      return res.end('not implemented');
    }

    // Static files: /fonts/* from fonts/, everything else from web/.
    const file = p.startsWith('/fonts/')
      ? path.join(FONT_DIR, p.slice('/fonts/'.length))
      : path.join(WEB_DIR, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));

    const resolved = path.resolve(file);
    if (!resolved.startsWith(WEB_DIR) && !resolved.startsWith(FONT_DIR)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    if (!existsSync(resolved)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    try {
      const body = await readFile(resolved);
      res.setHeader('Content-Type', MIME[path.extname(resolved)] || 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 500;
      res.end('read error');
    }
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    let last = -1;
    const push = () => {
      const snap = state.snapshot();
      if (snap.version !== last) {
        last = snap.version;
        try {
          socket.send(JSON.stringify(snap));
        } catch {
          /* socket closing */
        }
      }
    };
    push();
    const timer = setInterval(push, 500);
    socket.on('close', () => clearInterval(timer));
  });

  server.listen(port, host, () => {
    console.log(`[tempest-lens] UI + API on http://${host}:${port}`);
  });
  return server;
}

function json(res: http.ServerResponse, data: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}
