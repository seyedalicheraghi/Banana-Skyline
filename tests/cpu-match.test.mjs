// Whole CPU-vs-CPU matches, simulated at 10 frames per second of game time.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_POWER } from '../src/core/constants.js';
import { Game } from '../src/core/game.js';
import { Driver } from './helpers.mjs';

const LEVELS = ['easy', 'normal', 'hard'];
const SEEDS = [1, 2, 3];
const TARGET = 2;
const MAX_MATCH_TIME = 900; // simulated seconds for a first-to-2 match, generous for 'easy'

function playCpuMatch(level, seed) {
  const game = new Game({
    seed, targetScore: TARGET, windStrength: 'normal',
    players: [{ name: 'Bongo', cpu: level }, { name: 'Mango', cpu: level }],
  });
  const d = new Driver(game);
  game.start();
  d.runUntil(() => game.phase === 'matchOver', { dt: 0.1, max: MAX_MATCH_TIME, label: `${level} seed ${seed} matchOver` });
  const count = (type) => d.events.filter(e => e.type === type).length;
  return { game, events: d.events, time: d.time, throws: count('throw'), rounds: count('roundOver') };
}

const cache = new Map();
const match = (level, seed) => {
  const key = `${level}:${seed}`;
  if (!cache.has(key)) cache.set(key, playCpuMatch(level, seed));
  return cache.get(key);
};

describe('CPU vs CPU matches', () => {
  for (const level of LEVELS) {
    test(`'${level}' matches finish within ${MAX_MATCH_TIME}s of game time`, () => {
      for (const seed of SEEDS) {
        const r = match(level, seed);
        assert.equal(r.game.phase, 'matchOver', `${level} seed ${seed}`);
        assert.ok(r.time < MAX_MATCH_TIME, `${level} seed ${seed}: ${r.time}s`);
        const over = r.events.filter(e => e.type === 'matchOver');
        assert.equal(over.length, 1);
        const { winner, scores } = over[0].payload;
        assert.equal(scores[winner], TARGET);
        assert.ok(scores[1 - winner] < TARGET);
        assert.equal(r.rounds, scores[0] + scores[1]);
        for (const e of r.events.filter(x => x.type === 'throw')) {
          const { angle, power, method } = e.payload;
          assert.equal(method, 'aim');
          assert.ok(Number.isFinite(angle) && angle >= 0 && angle <= 180);
          assert.ok(Number.isFinite(power) && power >= 0 && power <= MAX_POWER);
        }
      }
    });
  }

  test("'hard' needs fewer throws per round than 'easy' (and 'normal' than 'easy')", () => {
    const perRound = (level) => {
      const runs = SEEDS.map(seed => match(level, seed));
      return runs.reduce((n, r) => n + r.throws, 0) / runs.reduce((n, r) => n + r.rounds, 0);
    };
    const easy = perRound('easy');
    const normal = perRound('normal');
    const hard = perRound('hard');
    assert.ok(hard < easy, `hard ${hard.toFixed(2)} vs easy ${easy.toFixed(2)} throws per round`);
    assert.ok(normal < easy, `normal ${normal.toFixed(2)} vs easy ${easy.toFixed(2)} throws per round`);
  });

  test('the same seed replays the same CPU match', () => {
    const log = (r) => r.events.map(e => [e.type, JSON.stringify(e.payload)]);
    const a = playCpuMatch('hard', 1);
    const b = playCpuMatch('hard', 1);
    assert.deepEqual(log(a), log(b));
    assert.deepEqual(a.game.scores, b.game.scores);
  });
});
