#!/usr/bin/env node
// Static checks for the browser code (there is no bundler to catch these):
//   1. every file under src/ parses (node --check),
//   2. every module except the app entry loads in Node (no DOM access at import time),
//   3. every named import in every file (main.js included) exists in the module it imports from,
//   4. the import map and the server allow-list cover what the page loads.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'src', 'app', 'main.js'); // touches the DOM at load; checked statically only
const problems = [];

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith('.js') || e.name.endsWith('.mjs') ? [full] : [];
  });
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const files = walk(path.join(ROOT, 'src')).sort();

for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`${rel(file)}: syntax error\n${(r.stderr || '').trim()}`);
}

const loaded = new Map();
async function load(file) {
  if (!loaded.has(file)) {
    loaded.set(file, import(pathToFileURL(file).href).then(
      (mod) => ({ mod }),
      (err) => ({ err }),
    ));
  }
  return loaded.get(file);
}

for (const file of files) {
  if (file === ENTRY) continue;
  const { err } = await load(file);
  if (err) problems.push(`${rel(file)}: fails to load in Node: ${err.message}`);
}

// Named imports: `import { a, b as c } from './x.js'` and `export { a } from './x.js'`.
const IMPORT_RE = /(?:import|export)\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const DEFAULT_RE = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s*['"]([^'"]+)['"]/g;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wanted = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const names = m[1].split(',').map(s => s.trim()).filter(Boolean).map(s => s.split(/\s+as\s+/)[0].trim());
    wanted.push({ spec: m[2], names });
  }
  for (const m of src.matchAll(DEFAULT_RE)) wanted.push({ spec: m[2], names: ['default'] });
  for (const { spec, names } of wanted) {
    let target;
    if (spec.startsWith('.')) {
      target = path.resolve(path.dirname(file), spec);
      if (!fs.existsSync(target)) {
        problems.push(`${rel(file)}: imports missing file ${spec}`);
        continue;
      }
    } else if (spec === 'three' || spec.startsWith('three/')) {
      const sub = spec === 'three' ? 'build/three.module.js' : spec.replace(/^three\/addons\//, 'examples/jsm/').replace(/^three\//, '');
      target = path.join(ROOT, 'node_modules', 'three', sub);
      if (!fs.existsSync(target)) {
        problems.push(`${rel(file)}: imports ${spec}, which is not in node_modules/three`);
        continue;
      }
    } else {
      problems.push(`${rel(file)}: bare import "${spec}" is not in the import map`);
      continue;
    }
    if (target === ENTRY) continue;
    const { mod, err } = await load(target);
    if (err) continue; // already reported
    for (const name of names) {
      if (name === 'default' ? !('default' in mod) : !(name in mod)) {
        problems.push(`${rel(file)}: "${name}" is not exported by ${spec}`);
      }
    }
  }
}

// The page: import map targets exist and the server serves every loaded path.
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const map = JSON.parse(html.match(/<script type="importmap">([\s\S]*?)<\/script>/)[1]).imports;
for (const [key, value] of Object.entries(map)) {
  if (!fs.existsSync(path.join(ROOT, value))) problems.push(`index.html: import map "${key}" -> ${value} does not exist`);
}
const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
for (const needed of ['src/', 'node_modules/three/build/', 'node_modules/three/examples/jsm/', 'index.html']) {
  if (!server.includes(`'${needed}'`)) problems.push(`server.mjs: allow-list is missing ${needed}`);
}
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(data:|https?:|#)/.test(ref)) continue;
  if (!fs.existsSync(path.join(ROOT, ref))) problems.push(`index.html: references missing file ${ref}`);
}

if (problems.length) {
  console.error(`check: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`check: ok (${files.length} source files parsed, ${loaded.size} modules loaded in Node, imports resolved)`);
