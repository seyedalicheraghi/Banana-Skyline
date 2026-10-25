// Scoring, round flow, craters and falling monkeys, driven by real throws whose outcome is computed
// in advance with the same physics the game uses.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIG_CRATER_RADIUS, CRATER_RADIUS, MONKEY, SIM_DT, SPLASH_RADIUS, TIMING,
} from '../src/core/constants.js';
import { circleHitsBox, launchVelocity, monkeyBox, sunContains } from '../src/core/physics.js';
import { Driver, cellKeys, findShot, makeCity, playSelfHit, recordedGame, stageGame } from './helpers.mjs';

const EPS = 1e-6;
const FRAME = 1 / 60;
const KEY_EVENTS = new Set(['throw', 'impact', 'crater', 'monkeyHit', 'monkeyFall', 'monkeyLand', 'roundOver', 'roundStart', 'turn', 'matchOver']);
const keyTypes = (events) => events.map(e => e.type).filter(t => KEY_EVENTS.has(t));
const splashes = (hit, m) => circleHitsBox(hit.x, hit.y, SPLASH_RADIUS, monkeyBox(m));
const removedBy = (city, x, y, radius) => city.clone().carve(x, y, radius);

describe('a direct hit', () => {
  test('gives the thrower a point: impact → crater → monkeyHit → roundOver → next round', () => {
    const game = stageGame();
    const d = new Driver(game);
    const shot = findShot(game, (hit) => hit.kind === 'monkey' && hit.victim === 1);
    assert.ok(shot, 'precondition: a direct hit exists');
    const before = game.city.clone();
    const from = d.mark();

    assert.equal(game.throwShot(shot), true);
    const roundOver = d.waitFor('roundOver', { max: 30 });
    const events = d.since(from);
    assert.deepEqual(keyTypes(events), ['throw', 'impact', 'crater', 'monkeyHit', 'roundOver']);

    const impact = events.find(e => e.type === 'impact');
    assert.equal(impact.payload.kind, 'monkey');
    assert.equal(impact.payload.victim, 1);
    assert.equal(impact.payload.thrower, 0);
    assert.equal(impact.payload.radius, BIG_CRATER_RADIUS);
    assert.equal(impact.payload.x, shot.hit.x, 'the live flight ends where the simulation said');
    assert.equal(impact.payload.y, shot.hit.y);

    const crater = events.find(e => e.type === 'crater').payload;
    assert.equal(crater.x, impact.payload.x);
    assert.equal(crater.y, impact.payload.y);
    assert.equal(crater.radius, BIG_CRATER_RADIUS);
    const expected = removedBy(before, crater.x, crater.y, BIG_CRATER_RADIUS);
    assert.ok(expected.length > 0, 'the monkey stood on a roof, so the crater bites into it');
    assert.deepEqual(cellKeys(crater.removed), cellKeys(expected));
    for (const cell of crater.removed) {
      assert.equal(game.city.isSolid(cell.col, cell.row), false);
      assert.equal(cell.building, before.cellBuilding(cell.col, cell.row));
    }

    assert.deepEqual(events.find(e => e.type === 'monkeyHit').payload, { victim: 1, thrower: 0, selfHit: false });
    assert.equal(game.monkeys[1].alive, false);
    assert.equal(game.monkeys[1].anim, 'dead');
    assert.equal(game.monkeys[0].alive, true);

    const wait = roundOver.time - impact.time;
    assert.ok(wait >= TIMING.monkeyHit - EPS && wait <= TIMING.monkeyHit + 3 * FRAME, `roundOver after ${wait}s`);
    assert.deepEqual(roundOver.payload, { winner: 0, scores: [1, 0], selfHit: false, matchPoint: false });
    assert.deepEqual(game.scores, [1, 0]);
    assert.equal(game.phase, 'roundOver');
    assert.equal(game.monkeys[0].anim, 'victory');
    assert.equal(game.lastShots[0].hit.kind, 'monkey');

    // After the celebration, round 2 starts with a fresh city and player 1 to throw.
    const roundStart = d.waitFor('roundStart');
    const pause = roundStart.time - roundOver.time;
    assert.ok(pause >= TIMING.roundOver - EPS && pause <= TIMING.roundOver + 3 * FRAME, `next round after ${pause}s`);
    assert.equal(roundStart.payload.round, 2);
    assert.equal(roundStart.payload.turn, 1);
    assert.equal(d.events.at(-1).type, 'turn');
    assert.equal(d.events.at(-1).payload.player, 1);
    assert.equal(game.round, 2);
    assert.equal(game.phase, 'aim');
    assert.deepEqual(game.scores, [1, 0]);
    assert.ok(game.monkeys.every(m => m.alive && m.anim === 'idle'));
    assert.deepEqual(game.lastShots, [null, null]);
    assert.notDeepEqual(game.city.grid, before.grid);
  });

  test('reaching targetScore ends the match in matchOver, and the game stays there', () => {
    const game = stageGame({ targetScore: 1 });
    const d = new Driver(game);
    const shot = findShot(game, (hit) => hit.kind === 'monkey' && hit.victim === 1);
    game.throwShot(shot);
    const roundOver = d.waitFor('roundOver', { max: 30 });
    assert.equal(roundOver.payload.matchPoint, true);
    const matchOver = d.waitFor('matchOver');
    assert.ok(matchOver.time - roundOver.time >= TIMING.roundOver - EPS);
    assert.deepEqual(matchOver.payload, { winner: 0, scores: [1, 0] });
    assert.equal(game.phase, 'matchOver');
    assert.equal(game.winner, 0);

    const mark = d.mark();
    d.runFor(30);
    assert.deepEqual(d.typesSince(mark), [], 'nothing happens after the match');
    assert.equal(game.phase, 'matchOver');
    assert.equal(game.throwShot({ angle: 45, power: 50 }), false);
    assert.equal(game.throwVelocity(10, 10), false);
    assert.equal(game.humanTurn, false);
    assert.deepEqual(game.scores, [1, 0]);
  });
});

describe('self hits', () => {
  test('a banana thrown straight up lands on the thrower and the opponent scores', () => {
    const game = stageGame();
    const d = new Driver(game);
    const events = playSelfHit(d);
    assert.deepEqual(keyTypes(events), ['throw', 'impact', 'crater', 'monkeyHit', 'roundOver']);
    const impact = events.find(e => e.type === 'impact').payload;
    assert.equal(impact.kind, 'monkey');
    assert.equal(impact.victim, 0);
    assert.equal(impact.thrower, 0);
    assert.deepEqual(events.find(e => e.type === 'monkeyHit').payload, { victim: 0, thrower: 0, selfHit: true });
    assert.deepEqual(events.at(-1).payload, { winner: 1, scores: [0, 1], selfHit: true, matchPoint: false });
    assert.equal(game.monkeys[0].alive, false);
    assert.equal(game.monkeys[1].anim, 'victory');
  });

  test('the first turn alternates by round', () => {
    const { game, d } = recordedGame({ targetScore: 9 });
    const scores = [];
    for (let round = 1; round <= 4; round++) {
      playSelfHit(d);
      scores.push([...game.scores]);
      d.waitFor('turn');
    }
    const starts = d.events.filter(e => e.type === 'roundStart').map(e => e.payload);
    assert.deepEqual(starts.map(s => s.round), [1, 2, 3, 4, 5]);
    assert.deepEqual(starts.map(s => s.turn), [0, 1, 0, 1, 0]);
    // The first turn event of every round belongs to the round's starting player.
    for (const [i, e] of d.events.entries()) {
      if (e.type !== 'roundStart') continue;
      const turn = d.events.slice(i).find(x => x.type === 'turn');
      assert.equal(turn.payload.player, e.payload.turn);
    }
    // Each self hit gives the point to whoever did not throw.
    assert.deepEqual(scores, [[0, 1], [1, 1], [1, 2], [2, 2]]);
  });

  test('a match decided by self hits ends on the right player with matchPoint flags', () => {
    const { game, d } = recordedGame({ targetScore: 2 });
    playSelfHit(d); // player 0 → [0, 1]
    d.waitFor('turn');
    playSelfHit(d); // player 1 → [1, 1]
    d.waitFor('turn');
    playSelfHit(d); // player 0 → [1, 2]
    const matchOver = d.waitFor('matchOver');
    assert.deepEqual(matchOver.payload, { winner: 1, scores: [1, 2] });
    const flags = d.events.filter(e => e.type === 'roundOver').map(e => e.payload.matchPoint);
    assert.deepEqual(flags, [false, false, true]);
    assert.equal(d.events.filter(e => e.type === 'roundStart').length, 3);
    d.runFor(20);
    assert.equal(game.phase, 'matchOver');
    assert.equal(d.events.filter(e => e.type === 'roundStart').length, 3);
  });
});

describe('splash damage', () => {
  test('a building hit within SPLASH_RADIUS of the opponent counts as a hit', () => {
    const game = stageGame();
    const d = new Driver(game);
    const [me, them] = game.monkeys;
    const shot = findShot(game, (hit) => hit.kind === 'building' && splashes(hit, them) && !splashes(hit, me));
    assert.ok(shot, 'precondition: a near miss on the roof exists');
    const from = d.mark();
    game.throwShot(shot);
    d.waitFor('roundOver', { max: 30 });
    const events = d.since(from);
    const impact = events.find(e => e.type === 'impact').payload;
    assert.equal(impact.kind, 'building');
    assert.equal(impact.victim, 1);
    assert.equal(impact.radius, CRATER_RADIUS);
    assert.equal(events.find(e => e.type === 'crater').payload.radius, CRATER_RADIUS);
    assert.deepEqual(events.find(e => e.type === 'monkeyHit').payload, { victim: 1, thrower: 0, selfHit: false });
    assert.equal(events.at(-1).payload.winner, 0);
    assert.deepEqual(game.scores, [1, 0]);
  });
});

describe('craters and falling monkeys', () => {
  test('a building hit far from both monkeys carves the city and passes the turn', () => {
    const game = stageGame();
    const d = new Driver(game);
    const shot = findShot(game, (hit) => {
      if (hit.kind !== 'building') return false;
      const far = game.monkeys.every(m => Math.hypot(hit.x - m.x, hit.y - m.y) > 15);
      const after = game.city.clone();
      after.carve(hit.x, hit.y, CRATER_RADIUS);
      const supported = game.monkeys.every(m => after.supportY(m.x - MONKEY.footHalf, m.x + MONKEY.footHalf, m.y) === m.y);
      return far && supported;
    });
    assert.ok(shot, 'precondition: a harmless building hit exists');
    const before = game.city.clone();
    const col = Math.floor(shot.hit.x / 2);
    const from = d.mark();
    game.throwShot(shot);
    d.waitFor('turn');
    const events = d.since(from);
    assert.deepEqual(keyTypes(events), ['throw', 'impact', 'crater', 'turn']);
    const crater = events.find(e => e.type === 'crater').payload;
    assert.equal(crater.radius, CRATER_RADIUS);
    assert.deepEqual(cellKeys(crater.removed), cellKeys(removedBy(before, shot.hit.x, shot.hit.y, CRATER_RADIUS)));
    assert.ok(crater.removed.length > 0);
    let solidBefore = 0;
    let solidAfter = 0;
    for (let i = 0; i < before.grid.length; i++) {
      solidBefore += before.grid[i] ? 1 : 0;
      solidAfter += game.city.grid[i] ? 1 : 0;
    }
    assert.equal(solidAfter, solidBefore - crater.removed.length);
    assert.ok(game.city.columnTop(col) <= before.columnTop(col));
    assert.equal(events.find(e => e.type === 'impact').payload.victim, null);
    assert.equal(events.at(-1).payload.player, 1);
    assert.deepEqual(game.scores, [0, 0]);
  });

  test('a monkey whose roof is blown away falls (monkeyFall, then monkeyLand) and the turn waits for it', () => {
    // Player 1 stands on a 2x2-cell slab (x 80..84, y 36..40) with nothing under it: once the slab is
    // gone they drop 40 m to the street, which takes longer than TIMING.impact.
    const city = makeCity([{ col0: 10, col1: 16, row1: 5 }, { col0: 40, col1: 42, row0: 18, row1: 20 }]);
    const game = stageGame({ city, positions: [{ x: 26, y: 10 }, { x: 82, y: 40 }] });
    const d = new Driver(game);
    const target = game.monkeys[1];
    const shot = findShot(game, (hit) => {
      if (hit.kind !== 'building' || splashes(hit, target)) return false;
      const after = game.city.clone();
      after.carve(hit.x, hit.y, CRATER_RADIUS);
      return after.supportY(target.x - MONKEY.footHalf, target.x + MONKEY.footHalf, target.y) === 0;
    });
    assert.ok(shot, 'precondition: a shot that knocks out the slab exists');
    const from = d.mark();
    game.throwShot(shot);
    const fall = d.waitFor('monkeyFall', { max: 10 });
    assert.deepEqual(fall.payload, { player: 1, fromY: 40, toY: 0 });
    assert.deepEqual(keyTypes(d.since(from)), ['throw', 'impact', 'crater', 'monkeyFall']);
    assert.equal(d.since(from).find(e => e.type === 'impact').payload.victim, null);
    for (const cell of [[40, 18], [41, 18], [40, 19], [41, 19]]) assert.equal(game.city.isSolid(...cell), false);
    assert.equal(target.falling, true);
    assert.equal(target.anim, 'fall');
    assert.equal(target.alive, true);

    // The fall is animated by the core and the next turn does not start until the monkey lands.
    let lastY = target.y;
    const impactTime = fall.time;
    while (target.falling) {
      d.step(FRAME);
      assert.ok(target.y <= lastY, 'falls monotonically');
      lastY = target.y;
      if (target.falling) assert.equal(game.phase, 'impact', 'no new turn while a monkey is falling');
      assert.ok(d.time - impactTime < 5, 'the fall ends');
    }
    const land = d.events.find(e => e.type === 'monkeyLand');
    assert.deepEqual(land.payload, { player: 1, y: 0 });
    assert.ok(land.time - impactTime > TIMING.impact, 'the fall outlasted the impact pause');
    assert.equal(target.y, 0);
    assert.equal(target.anim, 'idle');
    assert.equal(target.alive, true);

    const turn = d.waitFor('turn', { from });
    assert.ok(turn.time >= land.time);
    assert.equal(turn.payload.player, 1);
    assert.deepEqual(keyTypes(d.since(from)), ['throw', 'impact', 'crater', 'monkeyFall', 'monkeyLand', 'turn']);
    assert.deepEqual(game.scores, [0, 0]);
    // The fallen monkey throws from its new spot.
    assert.deepEqual(game.handPosition(1), { x: 82 - MONKEY.handX, y: MONKEY.handY });
  });
});

describe('flight details', () => {
  test('passing through the sun emits sunHit once and the flight goes on', () => {
    const game = stageGame();
    const d = new Driver(game);
    const shot = findShot(game, (hit, r) => r.sun && hit.kind !== 'monkey');
    assert.ok(shot, 'precondition: a shot through the sun exists');
    let during = null;
    game.on('sunHit', (p) => { during = { phase: game.phase, banana: Boolean(game.banana), ...p }; });
    const from = d.mark();
    game.throwShot(shot);
    d.waitFor('turn', { max: 40 });
    const types = d.typesSince(from);
    assert.equal(types.filter(t => t === 'sunHit').length, 1);
    assert.ok(types.indexOf('sunHit') < types.indexOf('impact'));
    assert.equal(during.phase, 'flight');
    assert.equal(during.banana, true);
    assert.ok(sunContains(during.x, during.y));
    assert.equal(d.since(from).find(e => e.type === 'impact').payload.kind, shot.hit.kind);
  });

  test('a street hit stops the banana at y = 0 where gravity says it lands', () => {
    const game = stageGame({ city: makeCity([]), positions: [{ x: 20, y: 0 }, { x: 130, y: 0 }] });
    const d = new Driver(game);
    const hand = game.handPosition(0);
    const { vx, vy } = launchVelocity(45, 40, 1);
    game.throwShot({ angle: 45, power: 40 });
    const impact = d.waitFor('impact').payload;
    assert.equal(impact.kind, 'ground');
    assert.equal(impact.y, 0);
    assert.equal(impact.victim, null);
    const t = (vy + Math.sqrt(vy * vy + 2 * game.gravity * hand.y)) / game.gravity;
    const x = hand.x + vx * t;
    assert.ok(impact.x >= x - 1e-6 && impact.x <= x + vx * SIM_DT + 1e-6, `landed at ${impact.x}, expected ~${x}`);
    d.waitFor('turn');
    assert.equal(game.turn, 1);
  });

  test('the gravity setting changes the flight: the same throw goes farther on the Moon', () => {
    const land = (gravity) => {
      const game = stageGame({ gravity, city: makeCity([]), positions: [{ x: 20, y: 0 }, { x: 130, y: 0 }] });
      assert.equal(game.gravity, gravity);
      const d = new Driver(game);
      game.throwShot({ angle: 45, power: 15 });
      return d.waitFor('impact', { max: 30 }).payload;
    };
    const earth = land(9.8);
    const moon = land(1.62);
    assert.equal(earth.kind, 'ground');
    assert.equal(moon.kind, 'ground');
    assert.ok(moon.x > earth.x + 20, `moon ${moon.x} vs earth ${earth.x}`);
  });
});
