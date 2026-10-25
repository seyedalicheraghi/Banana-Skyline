import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRng, randomSeed } from '../src/core/rng.js';

const draw = (n, f) => Array.from({ length: n }, f);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return mean(xs.map(x => (x - m) ** 2));
};

describe('createRng: determinism', () => {
  test('the same seed always produces the same sequence', () => {
    for (const seed of [0, 1, 42, 123456789, 0xdeadbeef]) {
      const a = createRng(seed);
      const b = createRng(seed);
      assert.deepEqual(draw(500, () => a.next()), draw(500, () => b.next()), `seed ${seed}`);
    }
  });

  test('mixed helper calls replay identically for the same seed', () => {
    const script = (rng) => [
      rng.int(1, 6), rng.float(-2, 2), rng.pick(['a', 'b', 'c']), rng.chance(0.5), rng.gauss(), rng.next(),
    ];
    const a = createRng(99);
    const b = createRng(99);
    for (let i = 0; i < 100; i++) assert.deepEqual(script(a), script(b));
  });

  test('different seeds produce different sequences', () => {
    const seeds = [0, 1, 2, 3, 1000, 0x7fffffff, 0xffffffff];
    const heads = seeds.map((s) => {
      const rng = createRng(s);
      return draw(8, () => rng.next()).join(',');
    });
    assert.equal(new Set(heads).size, seeds.length);
  });

  test('the seed is taken as an unsigned 32-bit integer', () => {
    const head = (seed) => {
      const rng = createRng(seed);
      return draw(20, () => rng.next());
    };
    assert.deepEqual(head(-1), head(0xffffffff));
    assert.deepEqual(head(2 ** 32 + 7), head(7));
  });
});

describe('createRng: ranges', () => {
  test('next() stays in [0, 1)', () => {
    const rng = createRng(2024);
    const xs = draw(50000, () => rng.next());
    assert.ok(xs.every(x => x >= 0 && x < 1));
  });

  test('int(min, max) is inclusive on both ends and only returns integers', () => {
    const rng = createRng(7);
    const seen = new Set();
    for (let i = 0; i < 10000; i++) {
      const v = rng.int(-3, 3);
      assert.ok(Number.isInteger(v), `not an integer: ${v}`);
      assert.ok(v >= -3 && v <= 3, `out of range: ${v}`);
      seen.add(v);
    }
    assert.deepEqual([...seen].sort((a, b) => a - b), [-3, -2, -1, 0, 1, 2, 3]);
  });

  test('int(a, a) always returns a', () => {
    const rng = createRng(5);
    for (let i = 0; i < 200; i++) assert.equal(rng.int(4, 4), 4);
  });

  test('int(0, 1) can return both 0 and 1', () => {
    const rng = createRng(11);
    const seen = new Set(draw(200, () => rng.int(0, 1)));
    assert.deepEqual([...seen].sort(), [0, 1]);
  });

  test('float(min, max) stays within [min, max)', () => {
    const rng = createRng(3);
    for (let i = 0; i < 10000; i++) {
      const v = rng.float(-5, 2.5);
      assert.ok(v >= -5 && v < 2.5, `out of range: ${v}`);
    }
    const unit = createRng(3);
    for (let i = 0; i < 1000; i++) {
      const v = unit.float();
      assert.ok(v >= 0 && v < 1);
    }
  });

  test('pick() returns members of the list and reaches all of them', () => {
    const rng = createRng(17);
    const items = ['up', 'down', 'valley', 'peak', 'random'];
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const v = rng.pick(items);
      assert.ok(items.includes(v));
      seen.add(v);
    }
    assert.equal(seen.size, items.length);
  });

  test('chance(0) is never true and chance(1) is always true', () => {
    const rng = createRng(23);
    for (let i = 0; i < 2000; i++) {
      assert.equal(rng.chance(0), false);
      assert.equal(rng.chance(1), true);
    }
  });
});

describe('createRng: distribution sanity', () => {
  test('next() has the mean and variance of a uniform distribution', () => {
    const rng = createRng(31337);
    const xs = draw(50000, () => rng.next());
    assert.ok(Math.abs(mean(xs) - 0.5) < 0.01, `mean ${mean(xs)}`);
    assert.ok(Math.abs(variance(xs) - 1 / 12) < 0.003, `variance ${variance(xs)}`);
  });

  test('int(0, 9) is roughly uniform (chi-square)', () => {
    const rng = createRng(4242);
    const n = 50000;
    const counts = new Array(10).fill(0);
    for (let i = 0; i < n; i++) counts[rng.int(0, 9)] += 1;
    const expected = n / 10;
    const chi2 = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    // 9 degrees of freedom: 27.9 is the p = 0.001 critical value.
    assert.ok(chi2 < 27.9, `chi2 ${chi2.toFixed(2)} counts ${counts}`);
  });

  test('chance(p) comes up about p of the time', () => {
    const rng = createRng(77);
    for (const p of [0.1, 0.3, 0.75]) {
      const hits = draw(20000, () => rng.chance(p)).filter(Boolean).length / 20000;
      assert.ok(Math.abs(hits - p) < 0.015, `p ${p}: ${hits}`);
    }
  });

  test('successive values are not correlated', () => {
    const rng = createRng(8);
    const xs = draw(20001, () => rng.next());
    const a = xs.slice(0, -1);
    const b = xs.slice(1);
    const ma = mean(a);
    const mb = mean(b);
    const cov = mean(a.map((x, i) => (x - ma) * (b[i] - mb)));
    const corr = cov / Math.sqrt(variance(a) * variance(b));
    assert.ok(Math.abs(corr) < 0.03, `lag-1 correlation ${corr}`);
  });

  test('gauss() is a standard normal sample', () => {
    const rng = createRng(1001);
    const xs = draw(40000, () => rng.gauss());
    assert.ok(xs.every(Number.isFinite));
    assert.ok(Math.abs(mean(xs)) < 0.03, `mean ${mean(xs)}`);
    assert.ok(Math.abs(Math.sqrt(variance(xs)) - 1) < 0.03, `sd ${Math.sqrt(variance(xs))}`);
    const within1 = xs.filter(x => Math.abs(x) < 1).length / xs.length;
    assert.ok(Math.abs(within1 - 0.6827) < 0.015, `P(|x|<1) ${within1}`);
  });
});

describe('randomSeed', () => {
  test('returns unsigned 32-bit integers that vary', () => {
    const seeds = draw(200, () => randomSeed());
    for (const s of seeds) {
      assert.ok(Number.isInteger(s) && s >= 0 && s < 2 ** 32, `bad seed ${s}`);
    }
    assert.ok(new Set(seeds).size > 190);
  });
});
