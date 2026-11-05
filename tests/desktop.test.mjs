// The desktop app (desktop/): the Electron main process parses and keeps the page locked down, the app:// scheme
// serves only files of the build, the .ico is well formed, and the packaging config points at what exists.
// Electron itself is not started here.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../scripts/build.mjs';
import { writeIcons } from '../scripts/desktop.mjs';
import { ICO_SIZES, PNG_FROM, dibEntry, encodeIco, iconIco } from '../desktop/icon.mjs';
import { ORIGIN, TYPES, contentType, filePath, serve } from '../desktop/files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmpDirs = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-desktop-'));
  tmpDirs.push(dir);
  return dir;
};
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngSize = (png) => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

describe('desktop: Electron main process', () => {
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.mjs'), 'utf8');

  test('main.mjs and scripts/desktop.mjs parse', () => {
    for (const f of ['desktop/main.mjs', 'scripts/desktop.mjs']) {
      const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    }
  });

  test('package.json runs it: main, the two scripts, exact Electron pins', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.main, 'desktop/main.mjs');
    assert.ok(fs.existsSync(path.join(ROOT, pkg.main)));
    assert.equal(pkg.scripts.desktop, 'node scripts/desktop.mjs');
    assert.equal(pkg.scripts['desktop:build'], 'node scripts/desktop.mjs --build');
    for (const dep of ['electron', 'electron-builder']) assert.match(pkg.devDependencies[dep], /^\d+\.\d+\.\d+$/, `${dep} is pinned exactly`);
  });

  test('the page is locked down: privileged app scheme, sandbox, no Node, no new windows, no other navigation', () => {
    assert.match(main, /registerSchemesAsPrivileged\(\[\{ scheme: 'app', privileges: \{ standard: true, secure: true, supportFetchAPI: true \} \}\]\)/);
    assert.ok(main.indexOf('registerSchemesAsPrivileged') < main.indexOf('whenReady'), 'the scheme is registered before the app is ready');
    assert.match(main, /protocol\.handle\('app'/);
    assert.match(main, /contextIsolation: true/);
    assert.match(main, /nodeIntegration: false/);
    assert.match(main, /sandbox: true/);
    assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/);
    assert.match(main, /'will-navigate'/);
    assert.match(main, /input\.key === 'F11'/);
    assert.match(main, /BACKGROUND = '#0b1026'/);
    assert.match(main, /width: 1280,\s+height: 720/);
  });
});

describe('desktop: the app:// scheme serves only the build', () => {
  let out;
  before(() => {
    out = path.join(tmp(), 'dist');
    build(out);
  });

  test('/ is index.html, the query string is ignored, paths map into the build', () => {
    assert.equal(filePath(`${ORIGIN}/`, out), path.join(out, 'index.html'));
    assert.equal(filePath('/', out), path.join(out, 'index.html'));
    assert.equal(filePath(`${ORIGIN}/index.html?source=pwa`, out), path.join(out, 'index.html'));
    assert.equal(filePath(`${ORIGIN}/src/app/main.js`, out), path.join(out, 'src', 'app', 'main.js'));
    assert.equal(filePath(`${ORIGIN}/lib/three/build/three.module.js`, out), path.join(out, 'lib', 'three', 'build', 'three.module.js'));
    assert.equal(filePath(`${ORIGIN}/a%20b/c.png`, out), path.join(out, 'a b', 'c.png'));
  });

  test('traversal, encoded traversal, drive letters, null bytes and bad encodings never leave the build', async () => {
    const attempts = [
      '/../package.json', `${ORIGIN}/../../package.json`, '/src/../../package.json',
      '/%2e%2e/package.json', '/src/%2e%2e/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/%2e%2e%2fpackage.json',
      '/%5c..%5c..%5cpackage.json', '/src%5c..%5c..%5cpackage.json',
      '/C:/Windows/win.ini', '/%00', '/index.html%00.png', '/%zz',
    ];
    for (const url of attempts) {
      const file = filePath(url, out);
      assert.ok(file === null || file.startsWith(out + path.sep), `${url} -> ${file}`);
      assert.equal((await serve(url, out)).status, 404, url);
    }
    // The URL parser folds `..` and `%2e%2e` segments into the path (they end at the build's root); an encoded slash
    // hides them from it, so those reach the mapping and must come back null.
    assert.equal(filePath('/%2e%2e/package.json', out), path.join(out, 'package.json'));
    for (const url of ['/..%2f..%2fpackage.json', '/%2e%2e%2fpackage.json', '/%00', '/%zz']) assert.equal(filePath(url, out), null, url);
    if (process.platform === 'win32') assert.equal(filePath('/%5c..%5c..%5cpackage.json', out), null);
    assert.equal(filePath('/', path.join(out, 'nowhere')), path.join(out, 'nowhere', 'index.html'), 'a missing root is just a missing file');
  });

  test('serve: the file with its type and no caching; 404 for directories, missing files and the source tree', async () => {
    const page = await serve(`${ORIGIN}/`, out);
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(page.body, fs.readFileSync(path.join(out, 'index.html')));
    const expect = async (p, type) => {
      const r = await serve(p, out);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.deepEqual(r.body, fs.readFileSync(path.join(out, ...p.split('/').filter(Boolean))), p);
    };
    await expect('/src/app/main.js', 'text/javascript; charset=utf-8');
    await expect('/lib/three/build/three.module.js', 'text/javascript; charset=utf-8');
    await expect('/src/ui/ui.css', 'text/css; charset=utf-8');
    await expect('/manifest.webmanifest', 'application/manifest+json; charset=utf-8');
    await expect('/assets/icon-192.png', 'image/png');
    await expect('/sw.js', 'text/javascript; charset=utf-8');
    for (const p of ['/src', '/src/', '/missing.js', '/node_modules/three/build/three.module.js', '/package.json']) {
      assert.equal((await serve(p, out)).status, 404, p);
    }
  });

  test('content types: by extension, case-insensitive, octet-stream for the unknown', () => {
    assert.equal(contentType('x.JS'), TYPES['.js']);
    assert.equal(contentType('x.mjs'), TYPES['.js']);
    assert.equal(contentType('x.webmanifest'), TYPES['.webmanifest']);
    assert.equal(contentType('x.bin'), 'application/octet-stream');
    assert.equal(contentType('noext'), 'application/octet-stream');
  });
});

describe('desktop: icons and packaging config', () => {
  test('dibEntry: 32-bit BGRA rows bottom-up behind a BITMAPINFOHEADER, then a padded AND mask', () => {
    const rgba = Buffer.from([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]); // 2x2, top row first
    const dib = dibEntry(2, rgba);
    assert.equal(dib.length, 40 + 16 + 2 * 4);
    assert.equal(dib.readUInt32LE(0), 40);
    assert.equal(dib.readInt32LE(4), 2);
    assert.equal(dib.readInt32LE(8), 4);
    assert.equal(dib.readUInt16LE(12), 1);
    assert.equal(dib.readUInt16LE(14), 32);
    assert.deepEqual([...dib.subarray(40, 48)], [9, 8, 7, 255, 12, 11, 10, 255], 'the bottom row comes first, BGRA');
    assert.deepEqual([...dib.subarray(48, 56)], [3, 2, 1, 255, 6, 5, 4, 255]);
    assert.ok(dib.subarray(56).every((b) => b === 0), 'the AND mask is all opaque');
  });

  test('iconIco: a valid ICONDIR with every size, DIBs small and PNGs large, entries contiguous', () => {
    const ico = iconIco();
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
    assert.ok(ICO_SIZES.includes(256) && ICO_SIZES.includes(16));
    let offset = 6 + 16 * ICO_SIZES.length;
    ICO_SIZES.forEach((size, i) => {
      const o = 6 + i * 16;
      assert.equal(ico[o], size === 256 ? 0 : size, `width of ${size}`);
      assert.equal(ico[o + 1], size === 256 ? 0 : size);
      assert.equal(ico.readUInt16LE(o + 4), 1);
      assert.equal(ico.readUInt16LE(o + 6), 32);
      const bytes = ico.readUInt32LE(o + 8);
      assert.equal(ico.readUInt32LE(o + 12), offset, `entry ${size} follows the previous one`);
      const data = ico.subarray(offset, offset + bytes);
      if (size >= PNG_FROM) {
        assert.deepEqual(data.subarray(0, 8), PNG_SIGNATURE, `${size} is a PNG`);
        assert.deepEqual(pngSize(data), { width: size, height: size });
      } else {
        assert.equal(data.readUInt32LE(0), 40, `${size} is a DIB`);
        assert.equal(data.readInt32LE(4), size);
        assert.equal(data.readInt32LE(8), size * 2);
        assert.equal(bytes, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
      }
      offset += bytes;
    });
    assert.equal(offset, ico.length, 'nothing after the last entry');
    assert.deepEqual(encodeIco([{ size: 16, data: Buffer.from([1, 2, 3]) }]).subarray(22), Buffer.from([1, 2, 3]));
  });

  test('writeIcons: icon.ico and a 512 px icon.png where electron-builder looks for them', () => {
    const dir = path.join(tmp(), 'build');
    writeIcons(dir);
    const ico = fs.readFileSync(path.join(dir, 'icon.ico'));
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
    const png = fs.readFileSync(path.join(dir, 'icon.png'));
    assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
    assert.deepEqual(pngSize(png), { width: 512, height: 512 });
  });

  test('electron-builder.json: the main process and dist/ only, Windows installer + portable, outputs git-ignored', () => {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'electron-builder.json'), 'utf8'));
    assert.equal(config.productName, 'Banana Skyline');
    assert.equal(config.appId, 'io.github.seyedalicheraghi.bananaskyline');
    assert.equal(config.directories.output, 'desktop/out');
    assert.equal(config.directories.buildResources, 'desktop/build');
    for (const f of ['desktop/main.mjs', 'desktop/files.mjs', 'dist/**/*', '!node_modules/**/*']) assert.ok(config.files.includes(f), f);
    assert.deepEqual(config.win.target.map((t) => t.target), ['nsis', 'portable']);
    assert.ok(config.win.target.every((t) => t.arch.includes('x64')));
    assert.equal(config.win.icon, 'desktop/build/icon.ico');
    assert.ok(config.mac.target.length && config.linux.target.length, 'macOS and Linux targets are configured');
    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/);
    for (const dir of ['dist/', 'desktop/out/', 'desktop/build/']) assert.ok(ignored.includes(dir), `${dir} is git-ignored`);
  });
});
