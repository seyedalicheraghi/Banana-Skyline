#!/usr/bin/env node
// Zero-dependency static server for the game. Binds to 127.0.0.1 only; the Quest reaches it via `adb reverse`.
// `--dist` serves the build (npm run build) instead of the source tree, on port 8081 by default: a separate
// origin, so the build's service worker never caches pages of the source tree on 8080.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const DIST = process.argv.includes('--dist');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = DIST ? path.resolve(HERE, process.env.DIST_DIR || 'dist') : HERE;
const PORT = Number(process.env.PORT) || (DIST ? 8081 : 8080);
const HOST = process.env.HOST || '127.0.0.1';

// Only these trees are served (a build holds nothing else, so all of it is).
const ALLOWED = DIST ? null : ['index.html', 'rover/', 'manifest.webmanifest', 'src/', 'assets/', 'node_modules/three/build/', 'node_modules/three/examples/jsm/',
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
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  const posix = path.relative(ROOT, full).split(path.sep).join('/');
  if (ALLOWED && !ALLOWED.some(a => (a.endsWith('/') ? posix.startsWith(a) : posix === a))) return null;
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

// Rover Cockpit (rover/): the page reaches the EarthRover SDK, which runs on this PC, through here, so the
// headset needs only this one port. Only the calls the page makes are forwarded.
const ROVER = new URL(process.env.ROVER_URL || 'http://127.0.0.1:8000');
const ROVER_PREFIX = '/rover-api';
const ROVER_CALLS = { GET: ['/feed', '/data', '/status'], POST: ['/control'] };

// The Quest app loads the cockpit from GitHub Pages and calls this server through adb reverse as
// http://localhost:8080: a public site talking to this machine, which browsers only allow when the server
// says so (CORS, and Private Network Access preflights). Only the cockpit's own origins get that answer, so
// no other web page can drive the rover through here. The Host check stops DNS-rebinding pages, which would
// otherwise look same-origin.
const ROVER_ORIGINS = (process.env.ROVER_ORIGINS ?? 'https://seyedalicheraghi.github.io').split(',').map(s => s.trim()).filter(Boolean);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// Pages served by this machine itself (other ports, *.localhost names, which browsers resolve to this
// machine): the build preview (npm run preview) and tests of the cross-origin path.
const LOCAL_ORIGIN = /^http:\/\/(([a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Extra headers for a cockpit request; null when it must be refused (foreign site or foreign Host). */
function roverAccess(headers, allowed = ROVER_ORIGINS) {
  if (!LOOPBACK_HOST.test(headers.host ?? '')) return null;
  const origin = headers.origin;
  if (!origin || origin === `http://${headers.host}`) return {}; // the page served here, or a tool like curl
  if (!allowed.includes(origin) && !LOCAL_ORIGIN.test(origin)) return null;
  return { 'access-control-allow-origin': origin, vary: 'Origin' };
}

function preflight(req, res) {
  const access = roverAccess(req.headers);
  if (!access || !access['access-control-allow-origin']) {
    res.writeHead(403).end();
    return;
  }
  res.writeHead(204, {
    ...access,
    'access-control-allow-methods': 'GET, POST',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '7200', // Chromium's ceiling: one preflight per two hours
    ...(req.headers['access-control-request-private-network'] === 'true' ? { 'access-control-allow-private-network': 'true' } : {}),
  }).end();
}

function roverProxy(req, res) {
  const access = roverAccess(req.headers);
  if (!access) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden');
    return;
  }
  const target = req.url.slice(ROVER_PREFIX.length);
  if (!ROVER_CALLS[req.method]?.includes(target.split('?')[0])) {
    res.writeHead(404, { 'content-type': 'text/plain', ...access }).end('Not found');
    return;
  }
  // A drive command must be JSON: other sites cannot send that without a preflight, which they fail above.
  if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    res.writeHead(415, { 'content-type': 'text/plain', ...access }).end('Send application/json');
    return;
  }
  const headers = {};
  for (const name of ['content-type', 'content-length', 'accept']) if (req.headers[name]) headers[name] = req.headers[name];
  const upstream = http.request({ host: ROVER.hostname, port: ROVER.port || 80, method: req.method, path: target, headers }, (up) => {
    const out = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...access };
    for (const name of ['content-type', 'content-length']) if (up.headers[name]) out[name] = up.headers[name];
    res.writeHead(up.statusCode ?? 502, out);
    pipeline(up, res, () => {}); // an SDK stream that breaks off also ends the page's request
  });
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.writeHead(502, { 'content-type': 'application/json', ...access }).end('{"detail":"The EarthRover SDK is not running on this PC"}');
  });
  res.on('close', () => upstream.destroy()); // the page left: stop pulling video
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const pathOnly = req.url?.split('?')[0] ?? '';
  if (req.method === 'OPTIONS' && (pathOnly.startsWith(`${ROVER_PREFIX}/`) || pathOnly === '/__log')) {
    preflight(req, res);
    return;
  }
  if (req.url?.startsWith(`${ROVER_PREFIX}/`)) {
    roverProxy(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/__log') {
    headsetLog(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  // A folder asked for without its slash (/rover): redirect, so the page's relative imports resolve.
  if (/^\/(?!\/)[^?]*[^/?]$/.test(pathOnly) && !path.extname(pathOnly)) {
    const index = resolve(`${pathOnly}/`);
    if (index && fs.existsSync(index)) {
      res.writeHead(301, { location: `${pathOnly}/${req.url.slice(pathOnly.length)}` }).end();
      return;
    }
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

if (DIST && !fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`No build in ${ROOT}: run npm run build first.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Banana Skyline${DIST ? ' (build)' : ''}: http://localhost:${PORT}/`);
});

export default server;
