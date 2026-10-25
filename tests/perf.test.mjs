// Performance guard for the CPU planner. Planning a CPU turn runs the banana physics thousands of times,
// spread over frames with a small per-frame budget. If V8 falls into a deoptimization loop in the hot
// physics functions, planning gets several times slower for the rest of the session (on the headset the
// CPU then throws late). The check runs a short planning workload in a fresh Node process with
// --trace-deopt-verbose and counts deoptimizations, which is deterministic where wall-clock timing is not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/core/')).href + '/';

// Plan on one city, then on others: the second city is what used to trigger the loop.
const WORKLOAD = `
const base = ${JSON.stringify(CORE)};
const { Game } = await import(base + 'game.js');
const { chooseShot } = await import(base + 'ai.js');
const { createRng } = await import(base + 'rng.js');
for (const seed of [2, 1, 3]) {
  const g = new Game({ seed, windStrength: 'normal', players: [{ name: 'A', cpu: 'easy' }, { name: 'B', cpu: 'easy' }] });
  g.start();
  for (let i = 0; i < 3; i++) chooseShot(g, i % 2, createRng(i));
}
`;

test('CPU planning on successive cities does not get stuck in a V8 deoptimization loop', () => {
  const r = spawnSync(process.execPath, ['--trace-deopt-verbose', '--input-type=module', '-e', WORKLOAD], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr);
  const deopts = r.stdout.split('\n').filter(line => line.includes('deoptimizing'));
  const byFunction = {};
  for (const line of deopts) {
    const name = /<JSFunction (\S+)/.exec(line)?.[1] ?? '?';
    byFunction[name] = (byFunction[name] ?? 0) + 1;
  }
  const where = {};
  for (const line of r.stdout.split('\n')) {
    const at = /deoptimize at <([^>]+)>/.exec(line)?.[1];
    if (at) where[at] = (where[at] ?? 0) + 1;
  }
  const top = Object.entries(where).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v}x ${k}`);
  // A healthy run has around ten deopts while V8 warms up; the loop produced hundreds to thousands.
  assert.ok(deopts.length < 200, `${deopts.length} deopts ${JSON.stringify(byFunction)}; hottest sites: ${top.join('; ')}`);
});
