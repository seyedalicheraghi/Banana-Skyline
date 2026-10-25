#!/usr/bin/env node
// Zero-dependency static server for the game. Binds to 127.0.0.1 only; the Quest reaches it via `adb reverse`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

// Only these trees are served.
const ALLOWED = ['index.html', 'manifest.webmanifest', 'src/', 'assets/', 'node_modules/three/build/', 'node_modules/three/examples/jsm/',
  'node_modules/iwer/build/']; // dev-only Quest emulator, loaded only with ?emulate

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
};

function resolve(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel.includes('\u0000')) return null;
  if (rel === '') rel = 'index.html';
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  const posix = path.relative(ROOT, full).split(path.sep).join('/');
  if (!ALLOWED.some(a => (a.endsWith('/') ? posix.startsWith(a) : posix === a))) return null;
  return full;
}

// The game in the headset reports loads, VR sessions, errors, frame rate and throws here (src/app/remote-log.js).
const LOG_LIMIT = 16 * 1024;
function headsetLog(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > LOG_LIMIT) {
      res.writeHead(413).end();
      req.destroy();
    }
  });
  req.on('end', () => {
    if (res.headersSent) return;
    res.writeHead(204).end();
    let entries;
    try {
      entries = JSON.parse(body);
    } catch {
      return;
    }
    for (const e of Array.isArray(entries) ? entries.slice(0, 50) : []) {
      try {
        const msg = typeof e?.msg === 'string' ? e.msg.replace(/[^\x20-\x7e]/g, '?').slice(0, 40) : '?';
        const data = e?.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
        console.log(`[headset] ${msg}${data.slice(0, 600)}`);
      } catch {
        console.log('[headset] (unprintable entry)');
      }
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__log') {
    headsetLog(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const file = resolve(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Banana Skyline: http://localhost:${PORT}/`);
});

export default server;
