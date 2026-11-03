#!/usr/bin/env node
// Builds the game as static files for an HTTPS host (GitHub Pages) and the Quest app. dist/ gets:
//   index.html   the page, with the import map pointed at lib/ and the manifest and service worker added,
//   src/         the game as it is (no bundling),
//   lib/three/   only the three.js files the game imports (followed from the imports in src/),
//   assets/      the app icons, drawn by scripts/icons.mjs,
//   manifest.webmanifest, sw.js (offline cache of every file above), .nojekyll (GitHub Pages: serve as is).
// Usage: node scripts/build.mjs [--out dist]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { iconPng } from './icons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_SIZES = [192, 512];
const DEV_ONLY = [path.join(ROOT, 'node_modules', 'iwer') + path.sep]; // ?emulate's WebXR emulator stays out of the build

const rel = (base, file) => path.relative(base, file).split(path.sep).join('/');
const inside = (dir, file) => file.startsWith(dir + path.sep);

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : [full];
  });
}

// Module specifiers: import/export ... from 'x', import 'x', import('x').
const SPEC_RE = /\b(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;

function importMap(html) {
  const m = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('index.html has no import map');
  return JSON.parse(m[1]).imports;
}

/** Resolve a specifier like the browser does with index.html's import map; null for dev-only files. */
function resolveSpec(spec, from, imports) {
  let target;
  if (spec.startsWith('.')) {
    target = path.resolve(path.dirname(from), spec);
  } else {
    const key = Object.keys(imports).filter(k => (k.endsWith('/') ? spec.startsWith(k) : spec === k)).sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`${rel(ROOT, from)}: bare import "${spec}" is not in the import map`);
    target = path.resolve(ROOT, imports[key] + spec.slice(key.length));
  }
  if (DEV_ONLY.some(d => target.startsWith(d))) return null;
  if (!fs.existsSync(target)) throw new Error(`${rel(ROOT, from)}: imports missing file ${spec}`);
  return target;
}

/** Every file under node_modules the game loads, following imports from src/ through the libraries. */
function libraryFiles(imports) {
  const src = path.join(ROOT, 'src');
  const queue = walk(src).filter(f => f.endsWith('.js'));
  const found = new Set();
  for (let i = 0; i < queue.length; i++) {
    const text = fs.readFileSync(queue[i], 'utf8');
    for (const m of text.matchAll(SPEC_RE)) {
      const target = resolveSpec(m[1] ?? m[2], queue[i], imports);
      if (!target || inside(src, target) || found.has(target)) continue;
      if (!inside(path.join(ROOT, 'node_modules'), target)) throw new Error(`${rel(ROOT, queue[i])}: imports ${target}, outside src/ and node_modules/`);
      found.add(target);
      queue.push(target);
    }
  }
  return [...found].sort();
}

/** Hash of the build's file names and contents: the service worker's cache version. */
export function buildVersion(out, files) {
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(`${f}\n`).update(fs.readFileSync(path.join(out, f)));
  return hash.digest('hex').slice(0, 12);
}

const REGISTER_SW = `  <script>
    // Offline: sw.js caches every file of this build (scripts/build.mjs).
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('[sw] ' + e); });
      });
    }
  </script>
`;

function replaceOnce(text, pattern, replacement, what) {
  if (!pattern.test(text)) throw new Error(`index.html: cannot find ${what}`);
  return text.replace(pattern, replacement);
}

/** Build into `out` (absolute). Returns { files, version, bytes }. */
export function build(out) {
  if (out === ROOT || inside(out, ROOT) || out === path.parse(out).root) throw new Error(`refusing to build into ${out}`);
  if (fs.existsSync(out) && fs.readdirSync(out).length && !fs.existsSync(path.join(out, 'sw.js'))) {
    throw new Error(`${out} is not empty and is not an earlier build; refusing to replace it`);
  }
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const imports = importMap(html);
  const toLib = (p) => p.replace(/^\.\/node_modules\//, './lib/');

  fs.cpSync(path.join(ROOT, 'src'), path.join(out, 'src'), { recursive: true });
  for (const file of libraryFiles(imports)) {
    const dest = path.join(out, 'lib', path.relative(path.join(ROOT, 'node_modules'), file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }

  fs.mkdirSync(path.join(out, 'assets'));
  for (const size of ICON_SIZES) fs.writeFileSync(path.join(out, 'assets', `icon-${size}.png`), iconPng(size));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons) {
    if (!fs.existsSync(path.join(out, icon.src))) throw new Error(`manifest.webmanifest: icon ${icon.src} is not built`);
  }
  fs.copyFileSync(path.join(ROOT, 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));

  const map = JSON.stringify({ imports: Object.fromEntries(Object.entries(imports).map(([k, v]) => [k, toLib(v)])) }, null, 2);
  let page = replaceOnce(html, /(<script type="importmap">)[\s\S]*?(<\/script>)/, `$1\n${map.replace(/^/gm, '    ')}\n  $2`, 'the import map');
  page = replaceOnce(page, /(\n<\/head>)/, '\n  <link rel="manifest" href="manifest.webmanifest">$1', '</head>');
  page = replaceOnce(page, /(<\/body>)/, `${REGISTER_SW}$1`, '</body>');
  fs.writeFileSync(path.join(out, 'index.html'), page);
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  const files = walk(out).map(f => rel(out, f)).filter(f => f !== '.nojekyll').sort();
  const version = buildVersion(out, files);
  const sw = fs.readFileSync(path.join(ROOT, 'scripts', 'sw.js'), 'utf8')
    .replace("const VERSION = 'dev';", `const VERSION = '${version}';`)
    .replace('const FILES = [];', `const FILES = ${JSON.stringify(['./', ...files], null, 2)};`);
  if (!sw.includes(version) || sw.includes('const FILES = [];')) throw new Error('scripts/sw.js: VERSION or FILES line not found');
  fs.writeFileSync(path.join(out, 'sw.js'), sw);

  const bytes = files.reduce((n, f) => n + fs.statSync(path.join(out, f)).size, 0);
  return { files, version, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: opts } = parseArgs({ options: { out: { type: 'string', default: 'dist' } } });
  const out = path.resolve(ROOT, opts.out);
  try {
    const { files, version, bytes } = build(out);
    console.log(`Built ${rel(ROOT, out) || out}/: ${files.length} files, ${(bytes / 1024).toFixed(0)} KB, version ${version}`);
  } catch (err) {
    console.error(`build: ${err.message}`);
    process.exit(1);
  }
}
