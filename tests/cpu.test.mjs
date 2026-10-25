// CPU turns driven by Game.update().
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_POWER, TIMING } from '../src/core/constants.js';
import { Game } from '../src/core/game.js';
import { Driver, HUMANS } from './helpers.mjs';

describe('CPU turns', () => {
  test('the CPU thinks for at least TIMING.cpuThink, then throws with the aim method', () => {
    const game = new Game({ seed: 8, windStrength: 'normal', players: [{ name: 'Robo', cpu: 'normal' }, HUMANS[1]] });
    const d = new Driver(game);
    game.start();
    assert.deepEqual(d.events.map(e => e.type), ['matchStart', 'roundStart', 'turn', 'cpuThinking']);
    assert.deepEqual(d.events[3].payload, { player: 0, level: 'normal' });
    assert.equal(game.humanTurn, false);
    assert.equal(game.throwVelocity(20, 20), false, 'a human cannot hand-throw for the CPU');

    const thrown = d.waitFor('throw', { dt: 1 / 60, max: 10 });
    assert.ok(thrown.time >= TIMING.cpuThink - 1e-6, `threw after ${thrown.time}s`);
    const { player, angle, power, method } = thrown.payload;
    assert.equal(player, 0);
    assert.equal(method, 'aim');
    assert.ok(Number.isFinite(angle) && angle > 0 && angle < 90, `angle ${angle}`);
    assert.ok(Number.isFinite(power) && power > 0 && power <= MAX_POWER, `power ${power}`);

    // The CPU only ever throws once per turn; then (unless it scored) the human gets the next turn.
    const next = d.waitFor('impact', { from: 0, dt: 1 / 60, max: 30 });
    if (next.payload.victim === null) {
      const turn = d.waitFor('turn', { dt: 1 / 60, max: 10 });
      assert.equal(turn.payload.player, 1);
      assert.equal(game.humanTurn, true);
      d.runFor(5);
      assert.equal(d.events.filter(e => e.type === 'throw').length, 1, 'the CPU does not throw on the human turn');
      assert.equal(d.events.filter(e => e.type === 'cpuThinking').length, 1);
    }
  });

  test('a demo match is CPU vs CPU and flagged as a demo', () => {
    const game = new Game({ demo: true, seed: 4, players: [{ name: 'A', cpu: 'normal' }, { name: 'B', cpu: 'normal' }] });
    const d = new Driver(game);
    game.start();
    assert.equal(game.isDemo, true);
    d.waitFor('throw', { dt: 0.1, max: 10 });
    assert.equal(game.humanTurn, false);
  });
});
