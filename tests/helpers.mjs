// Shared test helpers (not a test file itself: only tests/*.test.mjs are run).
import { City } from '../src/core/city.js';
import { COLS, ROWS } from '../src/core/constants.js';
import { Game } from '../src/core/game.js';
import { launchVelocity, simulateShot } from '../src/core/physics.js';

export const HUMANS = Object.freeze([{ name: 'Lefty', cpu: null }, { name: 'Righty', cpu: null }]);

/** Inclusive numeric range with a step, safe against float drift. */
export function range(from, to, step) {
  const out = [];
  const n = Math.round((to - from) / step);
  for (let i = 0; i <= n; i++) out.push(Math.round((from + i * step) * 1e6) / 1e6);
  return out;
}

/**
 * A City built from solid rectangles: [{ col0, col1, row0 = 0, row1 }] (col1 and row1 exclusive).
 * Block i becomes building i, so grid cells hold i + 1.
 */
export function makeCity(blocks = []) {
  const grid = new Uint8Array(COLS * ROWS);
  const buildings = blocks.map((b, id) => ({
    id, col0: b.col0, col1: b.col1, height: b.row1, color: id % 4, windowSeed: 0, roof: 0,
  }));
  blocks.forEach((b, id) => {
    for (let c = b.col0; c < b.col1; c++) {
      for (let r = b.row0 ?? 0; r < b.row1; r++) grid[r * COLS + c] = id + 1;
    }
  });
  return new City(buildings, grid, 'random');
}

/** Monkey-like objects for physics tests. */
export function monkey(index, x, y, extra = {}) {
  return { index, x, y, facing: index === 0 ? 1 : -1, alive: true, falling: false, ...extra };
}

/**
 * Start a human-vs-human game (no wind by default). Optionally swap in a custom city and move the
 * monkeys: positions = [{x, y}, {x, y}].
 */
export function stageGame({ city, positions, ...settings } = {}) {
  const game = new Game({ seed: 1234, windStrength: 'none', players: HUMANS, ...settings });
  game.start();
  if (city) game.city = city;
  positions?.forEach((p, i) => Object.assign(game.monkeys[i], p));
  return game;
}

/** Like stageGame without the swaps, but with a Driver attached before start() so it sees every event. */
export function recordedGame(settings = {}) {
  const game = new Game({ seed: 1234, windStrength: 'none', players: HUMANS, ...settings });
  const driver = new Driver(game);
  game.start();
  return { game, d: driver };
}

/**
 * Drives a game with fixed frame steps and records every event with the simulated time at the end of
 * the frame in which it was emitted (events from direct calls get the current time).
 */
export class Driver {
  constructor(game) {
    this.game = game;
    this.time = 0;
    this.events = [];
    game.onAny((type, payload) => this.events.push({ type, payload, time: this.time }));
  }

  step(dt = 1 / 60) {
    this.time += dt;
    this.game.update(dt);
  }

  /** Step until pred() is true; throws if it takes longer than `max` simulated seconds. */
  runUntil(pred, { dt = 1 / 60, max = 120, label = 'condition' } = {}) {
    const start = this.time;
    while (!pred()) {
      if (this.time - start > max) throw new Error(`timed out after ${max}s waiting for ${label}`);
      this.step(dt);
    }
    return this.time - start;
  }

  /** Step until an event of `type` arrives (after index `from`); returns that event record. */
  waitFor(type, { from = this.events.length, ...opts } = {}) {
    let found = null;
    this.runUntil(() => (found = this.events.slice(from).find(e => e.type === type)), { label: type, ...opts });
    return found;
  }

  runFor(seconds, dt = 1 / 60) {
    const end = this.time + seconds - 1e-9;
    while (this.time < end) this.step(dt);
  }

  mark() {
    return this.events.length;
  }

  since(mark) {
    return this.events.slice(mark);
  }

  typesSince(mark) {
    return this.since(mark).map(e => e.type);
  }
}

/**
 * Search for an { angle, power } that the current player could pass to throwShot whose outcome
 * satisfies accept(hit, result). The search uses the same stepping as a real flight, so a live
 * throw with the returned aim ends exactly at the returned hit.
 */
export function findShot(game, accept, { angles = range(5, 89, 0.5), powers = range(10, 100, 0.5) } = {}) {
  const player = game.turn;
  const m = game.monkeys[player];
  const o = game.handPosition(player);
  for (const angle of angles) {
    for (const power of powers) {
      const { vx, vy } = launchVelocity(angle, power, m.facing);
      const result = simulateShot({
        city: game.city, monkeys: game.monkeys, x: o.x, y: o.y, vx, vy,
        wind: game.wind, gravity: game.gravity, ignore: player,
      });
      if (accept(result.hit, result)) return { angle, power, hit: result.hit, result };
    }
  }
  return null;
}

/** Throw with an aim that is known to fly out of the city behind the thrower (a guaranteed miss). */
export const MISS = Object.freeze({ angle: 135, power: 100 });

/** Run a whole turn that misses: throw backwards and wait for the next player's turn. */
export function playMiss(driver) {
  const from = driver.mark();
  if (!driver.game.throwShot(MISS)) throw new Error(`throwShot refused in phase ${driver.game.phase}`);
  driver.waitFor('turn', { from });
  return driver.since(from);
}

/** Throw straight up (comes back down on the thrower) and wait for the round to end. */
export function playSelfHit(driver) {
  const from = driver.mark();
  if (!driver.game.throwShot({ angle: 90, power: 40 })) throw new Error(`throwShot refused in phase ${driver.game.phase}`);
  driver.waitFor('roundOver', { from });
  return driver.since(from);
}

/** Cells of a grid as a sorted list of "col,row" keys for set comparisons. */
export function cellKeys(cells) {
  return cells.map(c => `${c.col},${c.row}`).sort();
}
