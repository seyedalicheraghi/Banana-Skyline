// scripts/build.mjs (the static build for GitHub Pages and the Quest app), the service worker it writes,
// the generated icons, and `server.mjs --dist`. Every build goes to a temporary folder, never to dist/.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { build, buildVersion } from '../scripts/build.mjs';
import { pagesUrl } from '../scripts/deploy.mjs';
import { drawIcon, encodePng } from '../scripts/icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-build-'));
  tmpDirs.push(dir);
  return dir;
};
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const files = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort();

/** { width, height, colorType, pixels } of a PNG written by encodePng (one IDAT, filter 0). */
function readPng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  let pos = 8;
  let idat = null;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    if (type === 'IDAT') idat = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
  }
  return { width, height, colorType: buf[25], raw: zlib.inflateSync(idat) };
}

const swFiles = (sw) => JSON.parse(sw.match(/const FILES = (\[[\s\S]*?\]);/)[1]);

describe('build: dist/ for static hosting', () => {
  let out;
  let result;
  before(() => {
    out = path.join(tmp(), 'dist');
    result = build(out);
  });

  test('index.html loads three.js from lib/, links the manifest and registers the service worker', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(!html.includes('node_modules'), 'no node_modules paths left');
    const { imports } = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
    assert.equal(imports.three, './lib/three/build/three.module.js');
    assert.equal(imports['three/addons/'], './lib/three/examples/jsm/');
    assert.ok(fs.existsSync(path.join(out, imports.three)));
    assert.match(html, /<link rel="manifest" href="manifest.webmanifest">\n<\/head>/);
    assert.match(html, /navigator\.serviceWorker\.register\('sw\.js'\)/);
    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (!/^(data:|https?:|#)/.test(m[1])) assert.ok(fs.existsSync(path.join(out, m[1])), `index.html references ${m[1]}`);
    }
  });

  test('src/ is copied unchanged', () => {
    const src = files(path.join(ROOT, 'src'));
    assert.deepEqual(files(path.join(out, 'src')), src);
    for (const f of src) assert.deepEqual(fs.readFileSync(path.join(out, 'src', f)), fs.readFileSync(path.join(ROOT, 'src', f)), f);
  });

  test('every import in the build resolves to a file in the build (except the dev-only ?emulate runtime)', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const { imports } = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]);
    const SPEC = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;
    let checked = 0;
    for (const f of files(out).filter((x) => x.endsWith('.js') && x !== 'sw.js')) {
      for (const m of fs.readFileSync(path.join(out, f), 'utf8').matchAll(SPEC)) {
        const spec = m[1] ?? m[2];
        if (spec.includes('node_modules/iwer/')) continue;
        let target;
        if (spec.startsWith('.')) target = path.join(path.dirname(path.join(out, f)), spec);
        else {
          const key = Object.keys(imports).find((k) => (k.endsWith('/') ? spec.startsWith(k) : spec === k));
          assert.ok(key, `${f}: "${spec}" is not in the import map`);
          target = path.join(out, imports[key] + spec.slice(key.length));
        }
        assert.ok(fs.existsSync(target), `${f}: import ${spec} is missing from the build`);
        checked++;
      }
    }
    assert.ok(checked > 50, `checked ${checked} imports`);
  });

  test('only the three.js files the game imports are copied', () => {
    const lib = files(path.join(out, 'lib'));
    assert.ok(lib.includes('three/build/three.module.js'));
    assert.ok(lib.includes('three/build/three.core.js'), 'followed from three.module.js');
    assert.ok(!lib.some((f) => f.includes('webgpu') || f.includes('three.cjs')), lib.join(', '));
    for (const f of lib) assert.deepEqual(fs.readFileSync(path.join(out, 'lib', f)), fs.readFileSync(path.join(ROOT, 'node_modules', f)), f);
  });

  test('the manifest is an installable standalone app with built PNG icons of the stated sizes', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.webmanifest'), 'utf8'));
    assert.equal(manifest.name, 'Banana Skyline');
    assert.ok(manifest.short_name);
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.start_url, './');
    assert.equal(manifest.scope, './');
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
    assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    for (const icon of manifest.icons) {
      const png = readPng(fs.readFileSync(path.join(out, icon.src)));
      assert.equal(`${png.width}x${png.height}`, icon.sizes, icon.src);
      assert.equal(icon.type, 'image/png');
    }
  });

  test('sw.js precaches exactly the files of the build, under a version that hashes them', () => {
    const sw = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
    const listed = swFiles(sw);
    assert.deepEqual(listed, ['./', ...files(out).filter((f) => f !== 'sw.js' && f !== '.nojekyll')]);
    assert.deepEqual(result.files, listed.slice(1));
    assert.match(result.version, /^[0-9a-f]{12}$/);
    assert.ok(sw.includes(`const VERSION = '${result.version}';`));
    assert.ok(fs.existsSync(path.join(out, '.nojekyll')), 'GitHub Pages serves the files as they are');
  });

  test('building again gives the same version; a changed or renamed file gives a new one', () => {
    const again = path.join(tmp(), 'dist');
    assert.equal(build(again).version, result.version);
    assert.equal(buildVersion(again, result.files), result.version);
    fs.appendFileSync(path.join(again, 'src/app/main.js'), '\n');
    assert.notEqual(buildVersion(again, result.files), result.version);
    fs.copyFileSync(path.join(ROOT, 'src/app/main.js'), path.join(again, 'src/app/main.js'));
    assert.equal(buildVersion(again, result.files), result.version);
    fs.renameSync(path.join(again, 'src/ui/ui.css'), path.join(again, 'src/ui/ui2.css'));
    const renamed = result.files.map((f) => (f === 'src/ui/ui.css' ? 'src/ui/ui2.css' : f)).sort();
    assert.notEqual(buildVersion(again, renamed), result.version);
  });

  test('refuses to replace the project or a folder that is not an earlier build', () => {
    assert.throws(() => build(ROOT), /refusing/);
    assert.throws(() => build(path.dirname(ROOT)), /refusing/);
    const other = tmp();
    fs.writeFileSync(path.join(other, 'notes.txt'), 'keep me');
    assert.throws(() => build(other), /not an earlier build/);
    assert.equal(fs.readFileSync(path.join(other, 'notes.txt'), 'utf8'), 'keep me');
    build(out); // an earlier build is replaced
  });
});

test('deploy: the GitHub Pages address of a remote', () => {
  assert.equal(pagesUrl('https://github.com/seyedalicheraghi/Banana-Skyline.git'), 'https://seyedalicheraghi.github.io/Banana-Skyline/');
  assert.equal(pagesUrl('git@github.com:SomeOne/game'), 'https://someone.github.io/game/');
  assert.equal(pagesUrl('https://github.com/someone/someone.github.io'), 'https://someone.github.io/');
  assert.equal(pagesUrl('https://gitlab.com/someone/game.git'), null);
  assert.equal(pagesUrl(null), null);
});

describe('sw.js: offline cache', () => {
  /** Load a built sw.js into a fake service worker scope with in-memory caches and a scripted network. */
  function loadSw(code, { origin = 'https://example.github.io', base = '/Banana-Skyline/', existing = [] } = {}) {
    const stores = new Map(existing.map((k) => [k, new Map()]));
    const listeners = {};
    const network = [];
    const fakeCache = (name) => ({
      async addAll(requests) {
        for (const r of requests) {
          network.push({ url: r.url, cache: r.cache });
          stores.get(name).set(r.url, `body of ${r.url}`);
        }
      },
      async match(req, opts) {
        const url = new URL(typeof req === 'string' ? req : req.url, origin + base);
        if (opts?.ignoreSearch) url.search = '';
        return stores.get(name).get(url.href);
      },
    });
    const scope = {
      location: new URL(`${origin}${base}sw.js`),
      URL,
      Request: class { constructor(url, init) { this.url = new URL(url, `${origin}${base}`).href; this.cache = init?.cache; } },
      caches: {
        async open(name) { if (!stores.has(name)) stores.set(name, new Map()); return fakeCache(name); },
        async keys() { return [...stores.keys()]; },
        async delete(name) { return stores.delete(name); },
      },
      async fetch(req) { network.push({ url: req.url }); return `network ${req.url}`; },
      skipWaiting: async () => { scope.skipped = true; },
      clients: { claim: async () => { scope.claimed = true; } },
      addEventListener: (type, fn) => { listeners[type] = fn; },
    };
    scope.self = scope;
    vm.runInNewContext(code, scope);
    const fire = async (type, data = {}) => {
      let waited;
      let responded;
      listeners[type]({ ...data, waitUntil: (p) => { waited = p; }, respondWith: (p) => { responded = p; } });
      await waited;
      return responded === undefined ? undefined : await responded;
    };
    return { scope, stores, network, fire };
  }

  let code;
  let version;
  before(() => {
    const out = path.join(tmp(), 'dist');
    ({ version } = build(out));
    code = fs.readFileSync(path.join(out, 'sw.js'), 'utf8');
  });

  test('install caches every file fresh from the network (not the HTTP cache) and takes over at once', async () => {
    const sw = loadSw(code);
    await sw.fire('install');
    const cached = [...sw.stores.get(`banana-skyline-${version}`).keys()];
    assert.equal(cached.length, swFiles(code).length);
    assert.ok(cached.includes('https://example.github.io/Banana-Skyline/'));
    assert.ok(cached.includes('https://example.github.io/Banana-Skyline/lib/three/build/three.module.js'));
    assert.ok(sw.network.every((r) => r.cache === 'reload'));
    assert.equal(sw.scope.skipped, true);
  });

  test('activate drops older builds, keeps other caches and claims open pages', async () => {
    const sw = loadSw(code, { existing: ['banana-skyline-0123456789ab', 'someone-else'] });
    await sw.fire('install');
    await sw.fire('activate');
    assert.deepEqual([...sw.stores.keys()].sort(), [`banana-skyline-${version}`, 'someone-else']);
    assert.equal(sw.scope.claimed, true);
  });

  test('fetch answers from the cache with no network, falls back to the network, and leaves other requests alone', async () => {
    const sw = loadSw(code);
    await sw.fire('install');
    sw.network.length = 0;
    const get = (url, method = 'GET') => sw.fire('fetch', { request: { url, method } });
    assert.equal(await get('https://example.github.io/Banana-Skyline/src/app/main.js'), 'body of https://example.github.io/Banana-Skyline/src/app/main.js');
    assert.equal(await get('https://example.github.io/Banana-Skyline/?source=pwa'), 'body of https://example.github.io/Banana-Skyline/');
    assert.deepEqual(sw.network, [], 'cached files never touch the network');
    assert.equal(await get('https://example.github.io/Banana-Skyline/not-built.js'), 'network https://example.github.io/Banana-Skyline/not-built.js');
    assert.equal(await get('https://example.github.io/Banana-Skyline/__log', 'POST'), undefined, 'POST passes through');
    assert.equal(await get('https://elsewhere.example/x.js'), undefined, 'other origins pass through');
  });
});

describe('icons', () => {
  test('encodePng writes a valid RGBA PNG of the pixels', () => {
    const px = drawIcon(24);
    const png = readPng(encodePng(24, 24, px));
    assert.equal(png.width, 24);
    assert.equal(png.colorType, 6);
    for (let y = 0; y < 24; y++) {
      assert.equal(png.raw[y * (24 * 4 + 1)], 0, 'filter byte');
      assert.deepEqual(png.raw.subarray(y * (24 * 4 + 1) + 1, (y + 1) * (24 * 4 + 1)), px.subarray(y * 96, (y + 1) * 96));
    }
  });

  test('the icon is opaque and the banana stays inside the maskable safe zone (80% circle)', () => {
    const n = 128;
    const px = drawIcon(n);
    let banana = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const o = (j * n + i) * 4;
        assert.equal(px[o + 3], 255);
        const yellow = px[o] > 200 && px[o + 1] > 140 && px[o + 2] < 90 && j < 0.6 * n; // windows are lower down
        if (!yellow) continue;
        banana++;
        assert.ok(Math.hypot((i + 0.5) / n - 0.5, (j + 0.5) / n - 0.5) < 0.4, `banana pixel ${i},${j} outside the safe zone`);
      }
    }
    assert.ok(banana > n * n * 0.05, `banana covers ${banana} pixels`);
  });
});

describe('server.mjs --dist', () => {
  let child;
  let port;
  let dir;
  before(async () => {
    dir = path.join(tmp(), 'dist');
    build(dir);
    const srv = net.createServer();
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    port = srv.address().port;
    await new Promise((resolve) => srv.close(resolve));
    child = spawn(process.execPath, [path.join(ROOT, 'server.mjs'), '--dist'], {
      env: { ...process.env, PORT: String(port), DIST_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve, reject) => {
      let outText = '';
      child.stdout.on('data', (c) => { outText += c; if (outText.includes(`:${port}`)) resolve(); });
      child.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
    });
  });
  after(() => child?.kill());

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });

  test('serves the build, not the source tree', async () => {
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.deepEqual(page.body, fs.readFileSync(path.join(dir, 'index.html')));
    assert.match((await get('/manifest.webmanifest')).type, /^application\/manifest\+json/);
    assert.match((await get('/sw.js')).type, /^text\/javascript/);
    assert.match((await get('/assets/icon-512.png')).type, /^image\/png/);
    assert.equal((await get('/lib/three/build/three.core.js')).status, 200);
    for (const p of ['/node_modules/three/build/three.module.js', '/package.json', '/../package.json', '/%2e%2e/server.mjs']) {
      assert.equal((await get(p)).status, 404, p);
    }
  });
});
