// Runs server.mjs as a child process on a free port and talks raw HTTP to it (raw paths, so the
// client does not normalize "..", "%2e%2e" and friends before they reach the server).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** Start `node server.mjs` and resolve once it says it is listening. */
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { port, child, stderr: '', exited: null };
  child.stderr.on('data', (chunk) => { server.stderr += chunk; });
  child.on('exit', (code, signal) => { server.exited = { code, signal }; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 5 s')), 5000);
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes(`:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}: ${server.stderr}`));
    });
  });
  return server;
}

async function stopServer(server) {
  if (!server || server.exited) return;
  const gone = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill();
  await gone;
}

/** One raw HTTP request; resolves { status, headers, body } or rejects on a connection error. */
function request(server, method, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: rawPath, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end();
  });
}

describe('server.mjs: serving the game', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await stopServer(server); });

  test('GET / serves index.html as text/html', async () => {
    const res = await request(server, 'GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.deepEqual(res.body, read('index.html'));
  });

  test('GET /index.html serves the same page', async () => {
    const res = await request(server, 'GET', '/index.html');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, read('index.html'));
  });

  test('a source module is served as text/javascript', async () => {
    const res = await request(server, 'GET', '/src/core/game.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/javascript/);
    assert.deepEqual(res.body, read('src/core/game.js'));
  });

  test('query strings are ignored', async () => {
    const res = await request(server, 'GET', '/src/core/physics.js?v=123');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, read('src/core/physics.js'));
  });

  test('three.js and its addons are served from node_modules', async () => {
    const core = await request(server, 'HEAD', '/node_modules/three/build/three.module.js');
    assert.equal(core.status, 200);
    assert.match(core.headers['content-type'], /^text\/javascript/);
    assert.equal(Number(core.headers['content-length']), fs.statSync(path.join(ROOT, 'node_modules/three/build/three.module.js')).size);
    assert.equal(core.body.length, 0, 'HEAD has no body');
    const addon = await request(server, 'GET', '/node_modules/three/examples/jsm/webxr/VRButton.js');
    assert.equal(addon.status, 200);
    assert.match(addon.headers['content-type'], /^text\/javascript/);
  });

  test('missing files and directories are 404', async () => {
    for (const p of ['/src/nope.js', '/src/', '/src', '/src/core/', '/nothing-here.html']) {
      const res = await request(server, 'GET', p);
      assert.equal(res.status, 404, p);
    }
  });

  test('path traversal and files outside the allow-list are 404', async () => {
    const pkg = read('package.json').toString();
    const attempts = [
      '/../package.json',
      '/%2e%2e/package.json',
      '/%2E%2E/%2E%2E/Windows/win.ini',
      '/package.json',
      '/.git/config',
      '/.git/HEAD',
      '/server.mjs',
      '/.gitignore',
      '/package-lock.json',
      '/docs/DESIGN.md',
      '/tests/server.test.mjs',
      '/node_modules/three/package.json',
      '/node_modules/three/src/Three.js',
      '//package.json',
      '/src/../package.json',
      '/src/%2e%2e/package.json',
      '/src/..%2fpackage.json',
      '/src/..%5cpackage.json',
      '/..%5cpackage.json',
      '/src%5c..%5cpackage.json',
      '/src/..%5c..%5cpackage.json',
      '/node_modules/three/build/../package.json',
      '/node_modules/three/build/%2e%2e/%2e%2e/%2e%2e/package.json',
      '/%2fetc%2fpasswd',
      '/C:/Windows/win.ini',
      '/C%3A%5CWindows%5Cwin.ini',
      '/%5C%5C127.0.0.1%5Cc$%5CWindows%5Cwin.ini',
      '/%E0%A4%A',
      '/%',
    ];
    for (const p of attempts) {
      const res = await request(server, 'GET', p);
      assert.equal(res.status, 404, `${p} → ${res.status}`);
      assert.ok(!res.body.toString().includes(pkg.slice(0, 40)), `${p} leaked package.json`);
    }
    // The server is still fine afterwards.
    assert.equal((await request(server, 'GET', '/')).status, 200);
  });

  test('anything but GET and HEAD is 405', async () => {
    for (const [method, p] of [['POST', '/'], ['PUT', '/index.html'], ['DELETE', '/src/core/game.js'], ['PATCH', '/'], ['POST', '/../package.json']]) {
      const res = await request(server, method, p);
      assert.equal(res.status, 405, `${method} ${p}`);
    }
  });
});

describe('server.mjs: hostile input', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(async () => { await stopServer(server); });

  // A percent-encoded NUL inside an allowed tree reaches fs.stat(), which throws synchronously on
  // paths containing "\0"; the server must answer (404) instead of crashing.
  test('a NUL byte in the path is a 404 and does not crash the server', async () => {
    let res;
    let error;
    try {
      res = await request(server, 'GET', '/src/%00.js');
    } catch (e) {
      error = e;
      await new Promise((resolve) => setTimeout(resolve, 300)); // let a crashing child report its exit
    }
    const state = server.exited ? `server exited (code ${server.exited.code}): ${server.stderr.split('\n').slice(0, 6).join(' | ')}` : 'server alive';
    assert.equal(error, undefined, `request failed: ${error?.message}; ${state}`);
    assert.equal(res.status, 404);
    assert.equal((await request(server, 'GET', '/')).status, 200, 'still serving');
  });
});

/** A request with headers and a body; resolves { status, headers, body }. */
function send(server, { method = 'GET', path: p, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

describe('server.mjs: the Rover Cockpit proxy', () => {
  const COCKPIT = 'https://cockpit.example';
  let server;
  let upstream;
  const seen = [];
  let feedClosed = null;

  before(async () => {
    // A stand-in for the Earth Rovers SDK.
    upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
        if (req.url.startsWith('/feed')) {
          res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
          res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\nabc\r\n'); // then nothing: a live stream
          feedClosed = new Promise((resolve) => res.on('close', resolve));
          return;
        }
        if (req.url === '/data') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"battery":80}');
        if (req.url === '/control') return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"message":"Command sent successfully"}');
        res.writeHead(404).end();
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    server = await startServer({ ROVER_URL: `http://127.0.0.1:${upstream.address().port}`, ROVER_ORIGINS: COCKPIT });
  });
  after(async () => {
    await stopServer(server);
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
  });

  test('the page served here gets telemetry and can drive', async () => {
    const data = await send(server, { path: '/rover-api/data' });
    assert.equal(data.status, 200);
    assert.equal(data.body, '{"battery":80}');
    assert.equal(data.headers['cache-control'], 'no-store');
    const drive = await send(server, {
      method: 'POST', path: '/rover-api/control', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${server.port}` },
      body: '{"command":{"linear":0.5,"angular":0,"lamp":0}}',
    });
    assert.equal(drive.status, 200);
    assert.deepEqual(seen.at(-1), { method: 'POST', url: '/control', type: 'application/json', body: '{"command":{"linear":0.5,"angular":0,"lamp":0}}' });
  });

  test('only the calls the cockpit makes are forwarded', async () => {
    const calls = [['GET', '/rover-api/speak'], ['POST', '/rover-api/end-mission'], ['GET', '/rover-api/control'],
      ['GET', '/rover-api/../package.json'], ['GET', '/rover-api/data/../start-mission']];
    for (const [method, p] of calls) {
      const res = await send(server, { method, path: p, headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  });

  test('a drive command must be JSON (other sites cannot send that without asking first)', async () => {
    const count = seen.length;
    const res = await send(server, { method: 'POST', path: '/rover-api/control', headers: { 'content-type': 'text/plain' }, body: '{"command":{"linear":1,"angular":0}}' });
    assert.equal(res.status, 415);
    assert.equal(seen.length, count, 'not forwarded');
  });

  test('the Quest app origin may read responses; other sites are refused', async () => {
    const ok = await send(server, { path: '/rover-api/data', headers: { origin: COCKPIT } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], COCKPIT);
    assert.match(ok.headers.vary, /Origin/);
    const count = seen.length;
    const evil = await send(server, {
      method: 'POST', path: '/rover-api/control', headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{"command":{"linear":1,"angular":0}}',
    });
    assert.equal(evil.status, 403);
    assert.equal(seen.length, count, 'not forwarded');
  });

  test('pages served by this machine (other ports, *.localhost) may call it; look-alikes may not', async () => {
    for (const origin of ['http://localhost:8081', 'http://cockpit.localhost:8081', 'http://127.0.0.1:9000']) {
      const res = await send(server, { path: '/rover-api/data', headers: { origin } });
      assert.equal(res.status, 200, origin);
      assert.equal(res.headers['access-control-allow-origin'], origin);
    }
    for (const origin of ['http://localhost.evil.example', 'https://evil.localhost.example', 'http://evil.example/localhost', 'null']) {
      const res = await send(server, { path: '/rover-api/data', headers: { origin } });
      assert.equal(res.status, 403, origin);
    }
  });

  test('a DNS-rebinding page (foreign Host) is refused', async () => {
    const res = await send(server, { path: '/rover-api/data', headers: { host: `evil.example:${server.port}` } });
    assert.equal(res.status, 403);
  });

  test('preflights: yes to the Quest app (with Private Network Access), no to others', async () => {
    const ask = (origin) => send(server, {
      method: 'OPTIONS', path: '/rover-api/control',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', 'access-control-request-private-network': 'true' },
    });
    const ok = await ask(COCKPIT);
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], COCKPIT);
    assert.match(ok.headers['access-control-allow-methods'], /POST/);
    assert.match(ok.headers['access-control-allow-headers'], /content-type/);
    assert.equal(ok.headers['access-control-allow-private-network'], 'true');
    assert.equal((await ask('https://evil.example')).status, 403);
    const log = await send(server, { method: 'OPTIONS', path: '/__log', headers: { origin: COCKPIT, 'access-control-request-method': 'POST' } });
    assert.equal(log.status, 204);
  });

  test('video streams through without waiting for the end, and stops upstream when the page leaves', async () => {
    const first = await new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.port, path: '/rover-api/feed?view=front&fps=15', agent: false }, (res) => {
        assert.match(res.headers['content-type'], /^multipart\/x-mixed-replace/);
        res.once('data', (chunk) => {
          resolve(chunk.toString());
          req.destroy(); // the page goes away
        });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    });
    assert.match(first, /Content-Length: 3\r\n\r\nabc/);
    await Promise.race([feedClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream feed was not closed')), 3000))]);
  });

  test('without the SDK running the page gets a 502 that says so', async () => {
    const down = await startServer({ ROVER_URL: `http://127.0.0.1:${await freePort()}` });
    try {
      const res = await send(down, { path: '/rover-api/data' });
      assert.equal(res.status, 502);
      assert.match(res.body, /not running/);
    } finally {
      await stopServer(down);
    }
  });

  test('/rover/ serves the cockpit page; /rover redirects there, query kept', async () => {
    const res = await send(server, { path: '/rover/' });
    assert.equal(res.status, 200);
    assert.match(res.body, /<title>Rover Cockpit<\/title>/);
    const bare = await send(server, { path: '/rover?app' });
    assert.equal(bare.status, 301);
    assert.equal(bare.headers.location, '/rover/?app');
    assert.equal((await send(server, { path: '//rover' })).status, 404, 'no protocol-relative redirect');
    assert.equal((await send(server, { path: '/src' })).status, 404, 'only folders with a page');
  });

  test('an SDK stream that breaks off also ends the page request', async () => {
    const broken = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame' });
      res.write('--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 10\r\n\r\nabc'); // cut mid-part
      setTimeout(() => res.destroy(), 50);
    });
    await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve));
    const proxy = await startServer({ ROVER_URL: `http://127.0.0.1:${broken.address().port}` });
    try {
      const ended = await new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port: proxy.port, path: '/rover-api/feed?view=front', agent: false }, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve('end'));
          res.on('error', () => resolve('error'));
          res.on('close', () => resolve('close'));
        });
        req.on('error', () => resolve('error'));
        setTimeout(() => resolve('hung'), 3000);
      });
      assert.notEqual(ended, 'hung');
    } finally {
      await stopServer(proxy);
      broken.closeAllConnections?.();
      await new Promise((resolve) => broken.close(resolve));
    }
  });
});
