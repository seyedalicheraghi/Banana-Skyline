// POST /__log: the game in the headset reports to the PC's terminal through the dev server.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const server = { port, child, stdout: '' };
  child.stdout.on('data', (chunk) => { server.stdout += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 5 s')), 5000);
    const poll = setInterval(() => {
      if (server.stdout.includes(`:${port}`)) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 20);
  });
  return server;
}

function post(server, rawPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, method: 'POST', path: rawPath, agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise(r => setTimeout(r, 20));
  }
  return true;
};

describe('server.mjs: headset log', () => {
  let server;
  before(async () => { server = await startServer(); });
  after(() => server?.child.kill());

  test('prints each entry as a [headset] line and answers 204', async () => {
    const status = await post(server, '/__log', JSON.stringify([{ msg: 'vr-start', data: { refSpace: 'XRReferenceSpace' } }, { msg: 'fps', data: { avg: 72 } }]));
    assert.equal(status, 204);
    assert.ok(await waitFor(() => server.stdout.includes('[headset] fps {"avg":72}')), server.stdout);
    assert.ok(server.stdout.includes('[headset] vr-start {"refSpace":"XRReferenceSpace"}'));
  });

  test('ignores bodies that are not JSON arrays without crashing', async () => {
    assert.equal(await post(server, '/__log', 'not json'), 204);
    assert.equal(await post(server, '/__log', '{"msg":"x"}'), 204);
    assert.equal(server.child.exitCode, null);
  });

  test('hostile entries are printed safely and never stop the server', async () => {
    const deep = '['.repeat(7990) + ']'.repeat(7990);
    assert.equal(await post(server, '/__log', `[{"msg":{"toString":0}}]`), 204);
    assert.equal(await post(server, '/__log', `[{"msg":"x","data":${deep}}]`), 204);
    assert.equal(await post(server, '/__log', JSON.stringify([{ msg: 'fake\n[headset] line\u001b[2J' }])), 204);
    assert.ok(await waitFor(() => server.stdout.includes('[headset] fake?[headset] line?[2J')), server.stdout);
    assert.ok(server.stdout.includes('[headset] (unprintable entry)'), 'deep data is reported, not fatal');
    assert.equal(server.child.exitCode, null, 'still running');
    assert.equal(await post(server, '/__log', JSON.stringify([{ msg: 'alive' }])), 204);
    assert.ok(await waitFor(() => server.stdout.includes('[headset] alive')));
  });

  test('refuses oversized bodies', async () => {
    const status = await post(server, '/__log', 'x'.repeat(64 * 1024)).catch(() => 413);
    assert.equal(status, 413);
    assert.equal(server.child.exitCode, null);
  });

  test('POST anywhere else is still 405', async () => {
    assert.equal(await post(server, '/__log/x', '[]'), 405);
    assert.equal(await post(server, '/', '[]'), 405);
  });
});
