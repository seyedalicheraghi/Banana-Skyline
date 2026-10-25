import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CPU_LEVELS, chooseShot, planShot, scoreShot } from '../src/core/ai.js';
import { MAX_POWER } from '../src/core/constants.js';
import { Game } from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import { Driver, MISS, findShot, stageGame } from './helpers.mjs';

/** A started game where both players are CPUs of `level` (nothing is updated, so no CPU acts). */
function cpuGame(level, seed, windStrength = 'normal') {
  const game = new Game({ seed, windStrength, players: [{ name: 'A', cpu: level }, { name: 'B', cpu: level }] });
  game.start();
  return game;
}

/** An rng whose gauss() is always 0: the CPU's aim without its deliberate error. */
const steadyHand = () => ({ ...createRng(1), gauss: () => 0 });

const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};

describe('chooseShot', () => {
  test('returns a finite angle toward the opponent and a power within range', () => {
    for (const level of ['easy', 'normal', 'hard']) {
      for (const seed of [5, 6]) {
        const game = cpuGame(level, seed);
        for (const player of [0, 1]) {
          const shot = chooseShot(game, player, createRng(seed * 10 + player));
          assert.ok(Number.isFinite(shot.angle) && Number.isFinite(shot.power), `${level} ${seed} ${player}`);
          assert.ok(shot.angle > 0 && shot.angle < 90, `angle ${shot.angle}`);
          assert.ok(shot.power > 0 && shot.power <= MAX_POWER, `power ${shot.power}`);
        }
      }
    }
  });

  test('is deterministic for the same rng seed and leaves the game untouched', () => {
    const game = cpuGame('normal', 12);
    const d = new Driver(game);
    const grid = new Uint8Array(game.city.grid);
    const monkeys = structuredClone(game.monkeys);
    const a = chooseShot(game, 1, createRng(99));
    const b = chooseShot(game, 1, createRng(99));
    assert.deepEqual(a, b);
    assert.deepEqual(game.city.grid, grid);
    assert.deepEqual(game.monkeys, monkeys);
    assert.deepEqual(d.events, []);
    assert.equal(game.phase, 'aim');
    assert.equal(game.banana, null);
  });

  test('also plans for a player without a CPU level (falls back to a default level)', () => {
    const game = stageGame({ windStrength: 'normal' });
    const shot = chooseShot(game, 0, createRng(3));
    assert.ok(shot.angle > 0 && shot.angle < 90 && shot.power > 0 && shot.power <= MAX_POWER);
  });

  test('without aim error the plan is a direct hit when one exists', () => {
    for (const seed of [1234, 77]) {
      const game = stageGame({ seed, windStrength: 'normal' });
      const exists = findShot(game, (hit) => hit.kind === 'monkey' && hit.victim === 1);
      assert.ok(exists, `precondition: seed ${seed} has a direct hit`);
      const shot = chooseShot(game, 0, steadyHand());
      assert.ok(scoreShot(game, 0, shot.angle, shot.power) < -40, `seed ${seed}: planned ${JSON.stringify(shot)} misses`);
      // And the live throw really hits.
      const d = new Driver(game);
      game.throwShot(shot);
      const hit = d.waitFor('monkeyHit', { max: 30 });
      assert.deepEqual(hit.payload, { victim: 1, thrower: 0, selfHit: false });
    }
  });

  test('easy aims with more error than hard', () => {
    const spread = (level) => {
      const game = cpuGame(level, 21);
      const shots = [0, 1, 2, 3, 4, 5, 6, 7].map(s => chooseShot(game, 0, createRng(1000 + s)));
      return { angle: sd(shots.map(s => s.angle)), power: sd(shots.map(s => s.power)) };
    };
    const easy = spread('easy');
    const hard = spread('hard');
    assert.ok(hard.angle < easy.angle, `angle spread hard ${hard.angle} vs easy ${easy.angle}`);
    assert.ok(hard.power < easy.power, `power spread hard ${hard.power} vs easy ${easy.power}`);
  });

  test('levels are ordered: easy has the largest first-shot error, hard the smallest', () => {
    assert.ok(CPU_LEVELS.easy.angleSigma > CPU_LEVELS.normal.angleSigma);
    assert.ok(CPU_LEVELS.normal.angleSigma > CPU_LEVELS.hard.angleSigma);
    assert.ok(CPU_LEVELS.easy.powerSigma > CPU_LEVELS.normal.powerSigma);
    assert.ok(CPU_LEVELS.normal.powerSigma > CPU_LEVELS.hard.powerSigma);
  });
});

describe('planShot', () => {
  test('yields along the way (so planning can be spread over frames) and returns the same shot as chooseShot', () => {
    const game = cpuGame('hard', 31);
    const it = planShot(game, 0, createRng(5));
    let yields = 0;
    let r = it.next();
    while (!r.done) {
      yields += 1;
      r = it.next();
    }
    assert.ok(yields > 10, `only ${yields} yields`);
    assert.deepEqual(r.value, chooseShot(game, 0, createRng(5)));
  });
});

describe('scoreShot', () => {
  test('ranks a hitting shot below a missing one, and self-harm worst of all', () => {
    const game = stageGame();
    const hit = findShot(game, (h) => h.kind === 'monkey' && h.victim === 1);
    assert.ok(hit, 'precondition: a direct hit exists');
    const hitScore = scoreShot(game, 0, hit.angle, hit.power);
    const missScore = scoreShot(game, 0, MISS.angle, MISS.power);
    const selfScore = scoreShot(game, 0, 90, 40);
    assert.ok(hitScore < -40, `hit scores ${hitScore}`);
    assert.ok(missScore >= 0, `miss scores ${missScore}`);
    assert.equal(selfScore, 1e6);
    assert.ok(hitScore < missScore && missScore < selfScore);
  });

  test('a shot that comes close to the target scores better than one that flies away', () => {
    const game = stageGame();
    const hit = findShot(game, (h) => h.kind === 'monkey' && h.victim === 1);
    const near = scoreShot(game, 0, hit.angle, hit.power - 4);
    const away = scoreShot(game, 0, MISS.angle, MISS.power);
    assert.ok(near < away, `near ${near} vs away ${away}`);
  });

  test('works for the right-hand player too', () => {
    const game = stageGame();
    // Make it player 1's view: aim at player 0 with a steady hand.
    const shot = chooseShot(game, 1, steadyHand());
    const score = scoreShot(game, 1, shot.angle, shot.power);
    assert.ok(Number.isFinite(score));
    assert.ok(score < scoreShot(game, 1, MISS.angle, MISS.power));
  });
});

