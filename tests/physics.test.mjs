import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { City } from '../src/core/city.js';
import {
  BANANA_RADIUS, CITY_WIDTH, MAX_FLIGHT_TIME, MAX_POWER, MONKEY, OUT_MARGIN, POWER_TO_SPEED, SIM_DT, SUN,
  WIND_SCALE,
} from '../src/core/constants.js';
import {
  MAX_SPEED, circleHitsBox, launchVelocity, monkeyBox, probe, simulateShot, stepBanana, sunContains, updateIgnore,
  velocityToAim, windAccel,
} from '../src/core/physics.js';
import { createRng } from '../src/core/rng.js';
import { makeCity, monkey, range } from './helpers.mjs';

const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected}, got ${actual}`);

/** Closed-form position and velocity under constant acceleration. */
const exact = (b0, t, ax, ay) => ({
  x: b0.x + b0.vx * t + 0.5 * ax * t * t,
  y: b0.y + b0.vy * t + 0.5 * ay * t * t,
  vx: b0.vx + ax * t,
  vy: b0.vy + ay * t,
});

/** First time a body launched from y0 with vy0 under gravity g reaches y = 0. */
const groundTime = (y0, vy0, g) => (vy0 + Math.sqrt(vy0 * vy0 + 2 * g * y0)) / g;

describe('launchVelocity / velocityToAim', () => {
  test('speed is power * POWER_TO_SPEED, MAX_SPEED is full power', () => {
    assert.equal(MAX_SPEED, MAX_POWER * POWER_TO_SPEED);
    for (const power of [0, 1, 37.5, 50, 100]) {
      for (const angle of [0, 30, 45, 89, 135]) {
        const { vx, vy } = launchVelocity(angle, power, 1);
        close(Math.hypot(vx, vy), power * POWER_TO_SPEED, 1e-9);
      }
    }
  });

  test('angle is measured from the horizontal toward the opponent', () => {
    const right = launchVelocity(0, 50, 1);
    const left = launchVelocity(0, 50, -1);
    assert.equal(right.vx, 30);
    assert.equal(left.vx, -30);
    close(right.vy, 0, 1e-12);
    const up = launchVelocity(90, 50, -1);
    close(up.vx, 0, 1e-9);
    close(up.vy, 30, 1e-9);
    const diag = launchVelocity(45, 100, -1);
    close(-diag.vx, diag.vy, 1e-9);
    assert.ok(diag.vy > 0);
  });

  test('angles above 90 throw backwards, away from the opponent', () => {
    assert.ok(launchVelocity(120, 50, 1).vx < 0);
    assert.ok(launchVelocity(120, 50, -1).vx > 0);
  });

  test('velocityToAim inverts launchVelocity for both facings', () => {
    for (const facing of [1, -1]) {
      for (const angle of range(0, 175, 2.5)) {
        for (const power of [0.5, 12.3, 50, 99.9, 100]) {
          const { vx, vy } = launchVelocity(angle, power, facing);
          const aim = velocityToAim(vx, vy, facing);
          close(aim.angle, angle, 1e-9, `facing ${facing} angle`);
          close(aim.power, power, 1e-9, `facing ${facing} power`);
        }
      }
    }
  });

  test('launchVelocity inverts velocityToAim for any velocity, including downward throws', () => {
    const rng = createRng(12);
    for (let i = 0; i < 500; i++) {
      const vx = rng.float(-60, 60);
      const vy = rng.float(-60, 60);
      for (const facing of [1, -1]) {
        const aim = velocityToAim(vx, vy, facing);
        const v = launchVelocity(aim.angle, aim.power, facing);
        close(v.vx, vx, 1e-9);
        close(v.vy, vy, 1e-9);
      }
    }
  });

  test('a still banana has zero power and a finite angle', () => {
    const aim = velocityToAim(0, 0, 1);
    assert.equal(aim.power, 0);
    assert.ok(Number.isFinite(aim.angle));
  });
});

describe('stepBanana', () => {
  test('matches the closed-form constant-acceleration solution', () => {
    const b0 = { x: 3, y: 50, vx: 12, vy: 25, t: 0 };
    for (const dt of [SIM_DT, 0.01, 0.05]) {
      for (const n of [1, 10, 240, 1000]) {
        for (const [ax, ay] of [[0, -9.8], [1.5, -9.8], [-4.5, -1.62], [0, 0]]) {
          const b = { ...b0 };
          for (let i = 0; i < n; i++) stepBanana(b, dt, ax, ay);
          const t = n * dt;
          const e = exact(b0, t, ax, ay);
          const tol = 1e-9 * (1 + n);
          close(b.x, e.x, tol, `x dt=${dt} n=${n}`);
          close(b.y, e.y, tol, `y dt=${dt} n=${n}`);
          close(b.vx, e.vx, tol, 'vx');
          close(b.vy, e.vy, tol, 'vy');
          close(b.t, t, tol, 't');
        }
      }
    }
  });

  test('is exact for any split of the time (no integration drift)', () => {
    const one = { x: 0, y: 0, vx: 7, vy: 30, t: 0 };
    const many = { ...one };
    stepBanana(one, 1, 2, -9.8);
    for (const dt of [0.1, 0.3, 0.05, 0.55]) stepBanana(many, dt, 2, -9.8);
    for (const k of ['x', 'y', 'vx', 'vy', 't']) close(many[k], one[k], 1e-12, k);
  });

  test('wind accelerates the banana horizontally with the sign of the wind, gravity pulls it down', () => {
    assert.equal(windAccel(0), 0);
    for (const wind of [-15, -7, -1, 1, 7, 15]) {
      assert.equal(windAccel(wind), wind * WIND_SCALE);
      assert.equal(Math.sign(windAccel(wind)), Math.sign(wind));
      const b = { x: 0, y: 0, vx: 10, vy: 10, t: 0 };
      for (let i = 0; i < 240; i++) stepBanana(b, SIM_DT, windAccel(wind), -9.8);
      close(b.vx - 10, wind * WIND_SCALE, 1e-9, `wind ${wind}`);
      close(b.vy - 10, -9.8, 1e-9, 'vertical speed does not depend on wind');
    }
  });
});

describe('geometry helpers', () => {
  test('monkeyBox is centered on x and stands on y', () => {
    const box = monkeyBox({ x: 10, y: 20 });
    assert.deepEqual(box, { x0: 10 - MONKEY.width / 2, x1: 10 + MONKEY.width / 2, y0: 20, y1: 20 + MONKEY.height });
  });

  test('circleHitsBox: inside, touching and just missing', () => {
    const box = { x0: 0, x1: 2, y0: 0, y1: 4 };
    assert.equal(circleHitsBox(1, 2, 0.1, box), true);
    assert.equal(circleHitsBox(2.5, 2, 0.5, box), true);
    assert.equal(circleHitsBox(2.51, 2, 0.5, box), false);
    assert.equal(circleHitsBox(-0.5, 4.5, 0.75, box), true);
    assert.equal(circleHitsBox(-0.6, 4.6, 0.75, box), false);
  });

  test('sunContains', () => {
    assert.equal(sunContains(SUN.x, SUN.y), true);
    assert.equal(sunContains(SUN.x + SUN.radius - 0.01, SUN.y), true);
    assert.equal(sunContains(SUN.x + SUN.radius + 0.01, SUN.y), false);
    assert.equal(sunContains(SUN.x, SUN.y - SUN.radius - 0.01), false);
  });
});

describe('probe', () => {
  // A building at columns 10..15 (x 20..32), 8 rows high (roof at y = 16).
  const city = makeCity([{ col0: 10, col1: 16, row1: 8 }]);
  const banana = (x, y, extra = {}) => ({ x, y, vx: 0, vy: 0, t: 1, ignore: null, ...extra });

  test('returns null in open air', () => {
    assert.equal(probe(city, [monkey(0, 26, 16), monkey(1, 120, 0)], banana(60, 40)), null);
  });

  test('a monkey is hit before the building it stands on', () => {
    const monkeys = [monkey(0, 26, 16)];
    const b = banana(26, 15.8);
    assert.equal(city.solidAt(b.x, b.y), true, 'precondition: banana is inside the roof');
    assert.deepEqual(probe(city, monkeys, b), { kind: 'monkey', victim: 0, x: 26, y: 15.8 });
  });

  test('the banana radius counts for monkeys', () => {
    const monkeys = [monkey(0, 60, 0)];
    const edge = 60 + MONKEY.width / 2;
    assert.equal(probe(city, monkeys, banana(edge + BANANA_RADIUS - 0.01, 2))?.kind, 'monkey');
    assert.equal(probe(city, monkeys, banana(edge + BANANA_RADIUS + 0.01, 2)), null);
  });

  test('a building is hit before the ground', () => {
    assert.equal(probe(city, [], banana(26, 0)).kind, 'building');
    assert.equal(probe(city, [], banana(26, 0.5)).kind, 'building');
  });

  test('the street stops the banana at y = 0', () => {
    assert.deepEqual(probe(city, [], banana(60, 0)), { kind: 'ground', x: 60, y: 0 });
    assert.deepEqual(probe(city, [], banana(60, -0.3)), { kind: 'ground', x: 60, y: 0 });
  });

  test('the ground is checked before leaving the play area', () => {
    assert.equal(probe(city, [], banana(-OUT_MARGIN - 10, -1)).kind, 'ground');
    assert.equal(probe(city, [], banana(CITY_WIDTH + OUT_MARGIN + 10, -1)).kind, 'ground');
  });

  test('the banana is out beyond OUT_MARGIN on either side, or after MAX_FLIGHT_TIME', () => {
    assert.equal(probe(city, [], banana(-OUT_MARGIN + 0.1, 30)), null);
    assert.equal(probe(city, [], banana(-OUT_MARGIN - 0.1, 30)).kind, 'out');
    assert.equal(probe(city, [], banana(CITY_WIDTH + OUT_MARGIN - 0.1, 30)), null);
    assert.equal(probe(city, [], banana(CITY_WIDTH + OUT_MARGIN + 0.1, 30)).kind, 'out');
    assert.equal(probe(city, [], banana(70, 300, { t: MAX_FLIGHT_TIME + 0.01 })).kind, 'out');
    assert.equal(probe(city, [], banana(70, 300, { t: MAX_FLIGHT_TIME - 0.01 })), null);
  });

  test('dead monkeys and the ignored thrower are not hit; the other monkey still is', () => {
    const monkeys = [monkey(0, 60, 0), monkey(1, 61, 0)];
    const b = banana(60.5, 2, { ignore: 0 });
    assert.equal(probe(city, monkeys, b).victim, 1);
    monkeys[1].alive = false;
    assert.equal(probe(city, monkeys, b), null);
    assert.equal(probe(city, monkeys, { ...b, ignore: null }).victim, 0);
  });
});

describe('updateIgnore', () => {
  test('keeps ignoring the thrower until the banana leaves its box, then never again', () => {
    const monkeys = [monkey(0, 50, 0), monkey(1, 120, 0)];
    const b = { x: 51.1, y: 3.4, ignore: 0 };
    updateIgnore(b, monkeys);
    assert.equal(b.ignore, 0, 'still inside the box');
    b.y = MONKEY.height + BANANA_RADIUS + 0.5;
    updateIgnore(b, monkeys);
    assert.equal(b.ignore, null, 'left the box');
    b.y = 3.4;
    updateIgnore(b, monkeys);
    assert.equal(b.ignore, null, 'coming back does not restore the ignore');
    assert.equal(probe(makeCity([]), monkeys, { ...b, t: 1 }).victim, 0);
  });

  test('an ignore index without a monkey is dropped', () => {
    const b = { x: 0, y: 0, ignore: 5 };
    updateIgnore(b, [monkey(0, 50, 0)]);
    assert.equal(b.ignore, null);
  });
});

describe('simulateShot', () => {
  const empty = makeCity([]);
  const far = [monkey(0, -30, 0, { alive: false }), monkey(1, 200, 0, { alive: false })];

  test('is deterministic', () => {
    const city = City.generate(createRng(3));
    const monkeys = city.monkeySpots(createRng(3)).map((s, i) => monkey(i, s.x, s.y));
    const args = {
      city, monkeys, x: monkeys[0].x + 1.1, y: monkeys[0].y + 3.4, vx: 22, vy: 25, wind: 6, gravity: 9.8,
      ignore: 0, target: 1, recordEvery: 3,
    };
    assert.deepEqual(simulateShot(args), simulateShot(args));
  });

  test('does not change the city or the monkeys', () => {
    const city = City.generate(createRng(4));
    const monkeys = city.monkeySpots(createRng(4)).map((s, i) => monkey(i, s.x, s.y));
    const grid = new Uint8Array(city.grid);
    const copy = structuredClone(monkeys);
    for (let a = 10; a < 90; a += 10) {
      const { vx, vy } = launchVelocity(a, 70, 1);
      simulateShot({ city, monkeys, x: monkeys[0].x + 1.1, y: monkeys[0].y + 3.4, vx, vy, wind: -3, gravity: 9.8, ignore: 0 });
    }
    assert.deepEqual(city.grid, grid);
    assert.deepEqual(monkeys, copy);
  });

  test('the recorded path follows the closed-form trajectory and ends at the hit', () => {
    const b0 = { x: 20, y: 30, vx: 15, vy: 20 };
    const wind = 4;
    const g = 9.8;
    const every = 5;
    const r = simulateShot({ city: empty, monkeys: far, ...b0, wind, gravity: g, recordEvery: every });
    assert.equal(r.hit.kind, 'ground');
    assert.deepEqual(r.path[0], { x: 20, y: 30 });
    assert.deepEqual(r.path.at(-1), { x: r.hit.x, y: r.hit.y });
    for (let k = 1; k < r.path.length - 1; k++) {
      const e = exact(b0, k * every * SIM_DT, windAccel(wind), -g);
      close(r.path[k].x, e.x, 1e-6, `path[${k}].x`);
      close(r.path[k].y, e.y, 1e-6, `path[${k}].y`);
    }
    const steps = Math.round(r.time / SIM_DT);
    assert.equal(r.path.length, Math.floor(steps / every) + 2);
  });

  test('without recordEvery there is no path; without a target closest is Infinity', () => {
    const r = simulateShot({ city: empty, monkeys: far, x: 20, y: 10, vx: 10, vy: 0, wind: 0, gravity: 9.8 });
    assert.equal(r.path, null);
    assert.equal(r.closest, Infinity);
  });

  test('gravity: the ground is reached at the closed-form time', () => {
    for (const g of [1.62, 3.71, 9.8, 24.79]) {
      const r = simulateShot({ city: empty, monkeys: far, x: 10, y: 30, vx: 3, vy: 12, wind: 0, gravity: g });
      assert.equal(r.hit.kind, 'ground');
      const t = groundTime(30, 12, g);
      assert.ok(r.time >= t - 1e-9 && r.time <= t + SIM_DT + 1e-9, `g ${g}: ${r.time} vs ${t}`);
      close(r.hit.x, 10 + 3 * r.time, 1e-6);
    }
  });

  test('wind pushes the landing point downwind and leaves the flight time alone', () => {
    const shot = (wind) => simulateShot({ city: empty, monkeys: far, x: 50, y: 30, vx: 5, vy: 15, wind, gravity: 9.8 });
    const [west, still, east] = [-10, 0, 10].map(shot);
    assert.ok(west.hit.x < still.hit.x && still.hit.x < east.hit.x);
    assert.equal(west.time, still.time);
    assert.equal(east.time, still.time);
    close(east.hit.x - still.hit.x, 0.5 * windAccel(10) * still.time ** 2, 1e-6);
  });

  test('stopAt ends the flight early with no hit', () => {
    const b0 = { x: 50, y: 60, vx: 5, vy: 10 };
    const r = simulateShot({ city: empty, monkeys: far, ...b0, wind: 2, gravity: 9.8, stopAt: 0.5, recordEvery: 1 });
    assert.equal(r.hit, null);
    assert.ok(r.time >= 0.5 - 1e-9 && r.time < 0.5 + SIM_DT + 1e-9, `time ${r.time}`);
    const e = exact(b0, r.time, windAccel(2), -9.8);
    close(r.path.at(-1).x, e.x, 1e-6);
    close(r.path.at(-1).y, e.y, 1e-6);
  });

  test('a hit before stopAt is still reported', () => {
    const r = simulateShot({ city: empty, monkeys: far, x: 50, y: 1, vx: 0, vy: 0, wind: 0, gravity: 9.8, stopAt: 5 });
    assert.equal(r.hit.kind, 'ground');
    assert.ok(r.time < 1);
  });

  test('the thrower is ignored until the banana leaves its box', () => {
    const monkeys = [monkey(0, 50, 0)];
    const start = { x: 51.1, y: 3.4, vx: 20, vy: 0, wind: 0, gravity: 0 };
    const ignored = simulateShot({ city: empty, monkeys, ...start, ignore: 0 });
    assert.equal(ignored.hit.kind, 'out');
    const notIgnored = simulateShot({ city: empty, monkeys, ...start, ignore: null });
    assert.equal(notIgnored.hit.kind, 'monkey');
    assert.equal(notIgnored.hit.victim, 0);
  });

  test('a banana that never lands is out after MAX_FLIGHT_TIME', () => {
    const r = simulateShot({ city: empty, monkeys: far, x: 70, y: 50, vx: 0, vy: 0, wind: 0, gravity: 0, dt: 0.05 });
    assert.equal(r.hit.kind, 'out');
    assert.ok(r.time > MAX_FLIGHT_TIME && r.time <= MAX_FLIGHT_TIME + 0.05 + 1e-9);
  });

  test('a shot fired straight up comes back down on the thrower', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const city = City.generate(createRng(seed));
      const monkeys = city.monkeySpots(createRng(seed)).map((s, i) => monkey(i, s.x, s.y));
      for (const thrower of [0, 1]) {
        const m = monkeys[thrower];
        const { vx, vy } = launchVelocity(90, 40, m.facing);
        const r = simulateShot({
          city, monkeys, x: m.x + m.facing * MONKEY.handX, y: m.y + MONKEY.handY, vx, vy, wind: 0, gravity: 9.8, ignore: thrower,
        });
        assert.equal(r.hit.kind, 'monkey', `seed ${seed} thrower ${thrower}`);
        assert.equal(r.hit.victim, thrower);
        assert.ok(r.time > 1, 'it went up first');
      }
    }
  });

  test('closest tracks the nearest approach to the target center', () => {
    const monkeys = [monkey(0, 10, 0), monkey(1, 130, 0)];
    const center = { x: 130, y: MONKEY.height / 2 };
    const start = { x: 11.1, y: 3.4 };
    const miss = simulateShot({ city: empty, monkeys, ...start, vx: 20, vy: 15, wind: 0, gravity: 9.8, ignore: 0, target: 1 });
    assert.equal(miss.hit.kind, 'ground');
    assert.ok(Number.isFinite(miss.closest) && miss.closest > 0);
    // The reported ground hit is snapped to y = 0; the banana itself is up to one step below it.
    assert.ok(miss.closest <= Math.hypot(miss.hit.x - center.x, miss.hit.y - center.y) + 0.2);
    assert.ok(miss.closest <= Math.hypot(start.x - center.x, start.y - center.y));
    // Aim straight at the target with no gravity: a direct hit with a small closest distance.
    const hit = simulateShot({ city: empty, monkeys, ...start, vx: 40, vy: 0, wind: 0, gravity: 0, ignore: 0, target: 1 });
    assert.equal(hit.hit.kind, 'monkey');
    assert.equal(hit.hit.victim, 1);
    assert.ok(hit.closest <= Math.hypot(MONKEY.width / 2 + BANANA_RADIUS, MONKEY.height / 2 + BANANA_RADIUS));
    assert.ok(hit.closest < miss.closest);
  });

  test('reports passing through the sun without stopping there', () => {
    const through = simulateShot({ city: empty, monkeys: far, x: SUN.x - 20, y: SUN.y, vx: 20, vy: 0, wind: 0, gravity: 0 });
    assert.equal(through.sun, true);
    assert.equal(through.hit.kind, 'out');
    assert.ok(through.hit.x > CITY_WIDTH + OUT_MARGIN);
    const low = simulateShot({ city: empty, monkeys: far, x: 20, y: 5, vx: 20, vy: 0, wind: 0, gravity: 9.8 });
    assert.equal(low.sun, false);
  });
});
