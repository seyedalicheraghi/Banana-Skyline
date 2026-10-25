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
async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
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
