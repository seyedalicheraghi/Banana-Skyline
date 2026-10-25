import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  CELL, COLS, DEFAULT_AIM, DEFAULT_GRAVITY, MAX_POWER, MAX_WIND, MONKEY, SIM_DT, TIMING,
} from '../src/core/constants.js';
import { DEFAULT_SETTINGS, Game, normalizeSettings } from '../src/core/game.js';
import { MAX_SPEED, launchVelocity, velocityToAim, windAccel } from '../src/core/physics.js';
import { Driver, HUMANS, MISS, makeCity, playMiss, stageGame } from './helpers.mjs';

const EPS = 1e-6;
const close = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} expected ${expected}, got ${actual}`);
const round1 = (v) => Math.round(v * 10) / 10;

/** A started human-vs-human game on a generated city whose wind is not zero. */
function windyGame(strength = 'normal') {
  for (let seed = 1; seed < 200; seed++) {
    const game = new Game({ seed, windStrength: strength, players: HUMANS });
    game.start();
    if (game.wind !== 0) return game;
  }
  throw new Error('no windy seed found');
}

/** Street-level duel on an empty city, so every throw has a predictable outcome. */
const streetDuel = (settings = {}) =>
  stageGame({ city: makeCity([]), positions: [{ x: 30, y: 0 }, { x: 110, y: 0 }], ...settings });

/** A street duel with a wind that is not zero. */
function windyStreet() {
  for (let seed = 1; seed < 200; seed++) {
    const game = streetDuel({ seed, windStrength: 'normal' });
    if (game.wind !== 0) return game;
  }
  throw new Error('no windy seed found');
}

describe('normalizeSettings', () => {
  test('fills in every default', () => {
    const s = normalizeSettings();
    assert.deepEqual(s, {
      players: DEFAULT_SETTINGS.players.map(p => ({ ...p })),
      targetScore: 3,
      gravity: DEFAULT_GRAVITY,
      windStrength: DEFAULT_SETTINGS.windStrength,
      seed: null,
      demo: false,
    });
    assert.deepEqual(normalizeSettings({}), s);
    assert.deepEqual(normalizeSettings(DEFAULT_SETTINGS), s);
    assert.notEqual(s.players[0], DEFAULT_SETTINGS.players[0], 'returns fresh player objects');
  });

  test('keeps valid players, drops unknown CPU levels', () => {
    const s = normalizeSettings({ players: [{ name: 'Ann', cpu: 'hard' }, { name: 'Bob', cpu: 'genius' }] });
    assert.deepEqual(s.players, [{ name: 'Ann', cpu: 'hard' }, { name: 'Bob', cpu: null }]);
    for (const level of ['easy', 'normal', 'hard']) {
      assert.equal(normalizeSettings({ players: [{ name: 'x', cpu: level }, { name: 'y', cpu: null }] }).players[0].cpu, level);
    }
  });

  test('trims names, limits their length and falls back when empty', () => {
    const long = 'Bartholomew-the-Magnificent';
    const s = normalizeSettings({ players: [{ name: `  ${long}  `, cpu: null }, { name: '   ', cpu: 'easy' }] });
    assert.ok(s.players[0].name.length <= 16 && s.players[0].name.length > 0);
    assert.ok(long.startsWith(s.players[0].name));
    assert.equal(s.players[1].name, 'CPU');
    const humans = normalizeSettings({ players: [{ name: '', cpu: null }, { name: null, cpu: null }] });
    assert.deepEqual(humans.players.map(p => p.name), ['Player 1', 'Player 2']);
    assert.equal(normalizeSettings({ players: [{ name: 42, cpu: null }, {}] }).players[0].name, '42');
  });

  test('missing players fall back to the defaults', () => {
    const s = normalizeSettings({ players: [{ name: 'Solo', cpu: null }] });
    assert.deepEqual(s.players[1], { ...DEFAULT_SETTINGS.players[1] });
    assert.deepEqual(normalizeSettings({ players: [] }).players, DEFAULT_SETTINGS.players.map(p => ({ ...p })));
  });

  test('clamps targetScore to 1..20 and parses numeric strings', () => {
    const t = (v) => normalizeSettings({ targetScore: v }).targetScore;
    assert.equal(t(5), 5);
    assert.equal(t('7'), 7);
    assert.equal(t(0), 1);
    assert.equal(t(-4), 1);
    assert.equal(t(25), 20);
    assert.equal(t('lots'), 3);
    assert.equal(t(undefined), 3);
    assert.ok(Number.isInteger(t(2.9)));
  });

  test('clamps gravity to 0.5..40 and rejects non-positive or non-numeric values', () => {
    const g = (v) => normalizeSettings({ gravity: v }).gravity;
    for (const preset of [1.62, 3.71, 9.8, 24.79]) assert.equal(g(preset), preset);
    assert.equal(g('3.71'), 3.71);
    assert.equal(g(0.1), 0.5);
    assert.equal(g(1000), 40);
    assert.equal(g(0), DEFAULT_GRAVITY);
    assert.equal(g(-3), DEFAULT_GRAVITY);
    assert.equal(g('heavy'), DEFAULT_GRAVITY);
    assert.equal(g(Infinity), DEFAULT_GRAVITY);
  });

  test('windStrength must be one of none/calm/normal/wild', () => {
    for (const w of ['none', 'calm', 'normal', 'wild']) assert.equal(normalizeSettings({ windStrength: w }).windStrength, w);
    assert.equal(normalizeSettings({ windStrength: 'hurricane' }).windStrength, DEFAULT_SETTINGS.windStrength);
  });

  test('seed is an unsigned 32-bit integer or null', () => {
    const s = (v) => normalizeSettings({ seed: v }).seed;
    assert.equal(s(42), 42);
    assert.equal(s(0), 0);
    assert.equal(s(-1), 0xffffffff);
    assert.equal(s(3.7), 3);
    assert.equal(s(null), null);
    assert.equal(s('42'), null);
    assert.equal(s(NaN), null);
    assert.equal(s(Infinity), null);
  });

  test('demo is a boolean', () => {
    assert.equal(normalizeSettings({ demo: true }).demo, true);
    assert.equal(normalizeSettings({ demo: 1 }).demo, true);
    assert.equal(normalizeSettings({ demo: 0 }).demo, false);
  });

  test('is idempotent', () => {
    const inputs = [{}, { targetScore: 99, gravity: -1, seed: -5, players: [{ name: '  x ', cpu: 'hard' }] }, DEFAULT_SETTINGS];
    for (const input of inputs) {
      const once = normalizeSettings(input);
      assert.deepEqual(normalizeSettings(once), once);
    }
  });
});

describe('Game before start()', () => {
  test('is idle with no city or monkeys', () => {
    const game = new Game({ seed: 5 });
    assert.equal(game.phase, 'idle');
    assert.equal(game.round, 0);
    assert.deepEqual(game.scores, [0, 0]);
    assert.equal(game.city, null);
    assert.deepEqual(game.monkeys, []);
    assert.equal(game.banana, null);
    assert.equal(game.humanTurn, false);
    assert.equal(game.current, undefined);
    assert.equal(game.seed, 5);
    assert.equal(game.gravity, DEFAULT_GRAVITY);
    assert.deepEqual(game.aim, [{ ...DEFAULT_AIM }, { ...DEFAULT_AIM }]);
    assert.deepEqual(game.lastShots, [null, null]);
  });

  test('normalizes its settings and picks a random seed when none is given', () => {
    const game = new Game({ targetScore: 50, gravity: 1.62, demo: true });
    assert.deepEqual(game.settings, normalizeSettings({ targetScore: 50, gravity: 1.62, demo: true }));
    assert.equal(game.isDemo, true);
    assert.equal(game.gravity, 1.62);
    assert.ok(Number.isInteger(game.seed) && game.seed >= 0 && game.seed < 2 ** 32);
  });

  test('update() is safe and silent, whatever dt is', () => {
    const game = new Game({ seed: 1 });
    let events = 0;
    game.onAny(() => events++);
    for (const dt of [1 / 60, 0, -1, NaN, 10, undefined]) game.update(dt);
    assert.equal(events, 0);
    assert.equal(game.phase, 'idle');
  });

  test('refuses to throw', () => {
    const game = new Game({ seed: 1, players: HUMANS });
    assert.equal(game.throwShot({ angle: 45, power: 50 }), false);
    assert.equal(game.throwVelocity(10, 10), false);
    assert.equal(game.banana, null);
  });
});

describe('Game.start()', () => {
  test('emits matchStart, roundStart, turn in that order', () => {
    const game = new Game({ seed: 9, players: HUMANS });
    const d = new Driver(game);
    game.start();
    assert.deepEqual(d.events.map(e => e.type), ['matchStart', 'roundStart', 'turn']);
    const [matchStart, roundStart, turn] = d.events.map(e => e.payload);
    assert.deepEqual(matchStart, { settings: game.settings, seed: 9 });
    assert.deepEqual(roundStart, { round: 1, wind: game.wind, turn: 0, pattern: game.city.pattern });
    assert.deepEqual(turn, { player: 0, cpu: null, name: 'Lefty' });
  });

  test('a CPU that moves first starts thinking right after its turn event', () => {
    const game = new Game({ seed: 9, players: [{ name: 'Robo', cpu: 'hard' }, HUMANS[1]] });
    const d = new Driver(game);
    game.start();
    assert.deepEqual(d.events.map(e => e.type), ['matchStart', 'roundStart', 'turn', 'cpuThinking']);
    assert.deepEqual(d.events[2].payload, { player: 0, cpu: 'hard', name: 'Robo' });
    assert.deepEqual(d.events[3].payload, { player: 0, level: 'hard' });
    assert.equal(game.humanTurn, false);
  });

  test('sets up round 1: city, two monkeys on their roofs facing each other, player 0 to aim', () => {
    const game = new Game({ seed: 21, players: HUMANS });
    game.start();
    assert.equal(game.phase, 'aim');
    assert.equal(game.round, 1);
    assert.equal(game.turn, 0);
    assert.equal(game.humanTurn, true);
    assert.equal(game.current, game.monkeys[0]);
    assert.ok(game.city);
    assert.equal(game.monkeys.length, 2);
    const [a, b] = game.monkeys;
    assert.ok(a.x < b.x);
    assert.equal(a.facing, 1);
    assert.equal(b.facing, -1);
    for (const [i, m] of game.monkeys.entries()) {
      assert.equal(m.index, i);
      assert.equal(m.name, HUMANS[i].name);
      assert.equal(m.cpu, null);
      assert.equal(m.alive, true);
      assert.equal(m.falling, false);
      assert.equal(m.anim, 'idle');
      assert.equal(game.city.supportY(m.x - MONKEY.footHalf, m.x + MONKEY.footHalf, m.y), m.y, 'standing on a roof');
      assert.ok(m.y > 0);
    }
    assert.equal(game.banana, null);
    assert.ok(Number.isInteger(game.wind) && Math.abs(game.wind) <= MAX_WIND);
  });

  test('the same seed sets up the same match; other seeds differ', () => {
    const setup = (seed) => {
      const g = new Game({ seed, players: HUMANS });
      g.start();
      return { grid: g.city.grid, buildings: g.city.buildings, monkeys: g.monkeys, wind: g.wind };
    };
    assert.deepEqual(setup(77), setup(77));
    assert.notDeepEqual(setup(77).grid, setup(78).grid);
  });

  test('handPosition() is in front of the monkey, within its body', () => {
    const game = stageGame();
    for (const m of game.monkeys) {
      const h = game.handPosition(m.index);
      assert.ok((h.x - m.x) * m.facing > 0, 'hand is on the side facing the opponent');
      assert.ok(Math.abs(h.x - m.x) <= MONKEY.width / 2);
      assert.ok(h.y > m.y && h.y <= m.y + MONKEY.height);
    }
  });
});

describe('Game.setAim()', () => {
  test('clamps angle to 0..180 and power to 0..100, stores and emits aim', () => {
    const game = stageGame();
    const d = new Driver(game);
    game.setAim(0, 200, 150);
    assert.deepEqual(game.aim[0], { angle: 180, power: MAX_POWER });
    game.setAim(1, -20, -5);
    assert.deepEqual(game.aim[1], { angle: 0, power: 0 });
    game.setAim(0, 37.5, 61.2);
    assert.deepEqual(game.aim[0], { angle: 37.5, power: 61.2 });
    assert.deepEqual(d.events.map(e => [e.type, e.payload]), [
      ['aim', { player: 0, angle: 180, power: 100 }],
      ['aim', { player: 1, angle: 0, power: 0 }],
      ['aim', { player: 0, angle: 37.5, power: 61.2 }],
    ]);
  });

  test('garbage becomes 0', () => {
    const game = stageGame();
    game.setAim(0, 'steep', undefined);
    assert.deepEqual(game.aim[0], { angle: 0, power: 0 });
  });
});

describe('Game.throwShot()', () => {
  test('throws in the aim phase: emits aim then throw from the hand', () => {
    const game = stageGame();
    const d = new Driver(game);
    const hand = game.handPosition(0);
    assert.equal(game.throwShot({ angle: 60, power: 70 }), true);
    assert.deepEqual(d.events.map(e => e.type), ['aim', 'throw']);
    const { vx, vy } = launchVelocity(60, 70, 1);
    assert.deepEqual(d.events[1].payload, { player: 0, angle: 60, power: 70, x: hand.x, y: hand.y, vx, vy, method: 'aim' });
    assert.equal(game.phase, 'flight');
    assert.equal(game.humanTurn, false);
    assert.deepEqual(game.aim[0], { angle: 60, power: 70 });
    const b = game.banana;
    assert.ok(b);
    assert.deepEqual({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, t: b.t }, { x: hand.x, y: hand.y, vx, vy, t: 0 });
    assert.equal(typeof b.spin, 'number');
    assert.equal(game.monkeys[0].anim, 'throw');
  });

  test('the throw event carries the clamped angle and power', () => {
    const game = stageGame();
    const d = new Driver(game);
    game.throwShot({ angle: 200, power: 150 });
    const ev = d.events.find(e => e.type === 'throw').payload;
    assert.equal(ev.angle, 180);
    assert.equal(ev.power, 100);
    const { vx, vy } = launchVelocity(180, 100, 1);
    assert.equal(ev.vx, vx);
    assert.equal(ev.vy, vy);
  });

  test('a negative angle is clamped to a flat throw', () => {
    const game = stageGame();
    const d = new Driver(game);
    game.throwShot({ angle: -30, power: 40 });
    const ev = d.events.find(e => e.type === 'throw').payload;
    assert.equal(ev.angle, 0);
    assert.equal(ev.power, 40);
    close(ev.vy, 0, 1e-12);
  });

  test('only works in the aim phase', () => {
    const game = streetDuel();
    const d = new Driver(game);
    assert.equal(game.throwShot(MISS), true);
    assert.equal(game.throwShot(MISS), false, 'not during flight');
    d.waitFor('impact');
    assert.equal(game.phase, 'impact');
    assert.equal(game.throwShot(MISS), false, 'not during impact');
    assert.equal(d.events.filter(e => e.type === 'throw').length, 1);
    d.waitFor('turn');
    assert.equal(game.throwShot(MISS), true, 'the next player may throw');
  });

  test('the thrower anim returns to idle after the throw animation', () => {
    const game = streetDuel();
    const d = new Driver(game);
    game.throwShot(MISS);
    d.runFor(TIMING.throwAnim - 0.05);
    assert.equal(game.monkeys[0].anim, 'throw');
    d.runFor(0.1);
    assert.equal(game.monkeys[0].anim, 'idle');
  });

  test('in flight the banana follows the closed-form path under gravity and wind', () => {
    const game = windyStreet();
    const hand = game.handPosition(0);
    const shot = { angle: 100, power: 100 }; // steep and backwards: clear sky for the first frames
    const { vx, vy } = launchVelocity(shot.angle, shot.power, 1);
    game.throwShot(shot);
    for (let i = 0; i < 12; i++) game.update(1 / 60);
    const b = game.banana;
    assert.ok(b, 'still flying');
    assert.ok(b.t > 0.15 && b.t <= 0.2 + EPS, `t ${b.t}`);
    const ax = windAccel(game.wind);
    close(b.x, hand.x + vx * b.t + 0.5 * ax * b.t ** 2, 1e-6, 'x');
    close(b.y, hand.y + vy * b.t - 0.5 * game.gravity * b.t ** 2, 1e-6, 'y');
    close(b.vx, vx + ax * b.t, 1e-6, 'vx');
    close(b.vy, vy - game.gravity * b.t, 1e-6, 'vy');
    assert.ok(Number.isFinite(b.spin));
  });

  test('a miss ends the turn after TIMING.impact and the other player aims', () => {
    const game = streetDuel();
    const d = new Driver(game);
    const hand = game.handPosition(0);
    const from = d.mark();
    game.throwShot(MISS);
    const impact = d.waitFor('impact');
    assert.equal(game.banana, null);
    assert.equal(game.phase, 'impact');
    assert.equal(game.humanTurn, false);
    assert.deepEqual(
      { kind: impact.payload.kind, victim: impact.payload.victim, thrower: impact.payload.thrower },
      { kind: 'out', victim: null, thrower: 0 },
    );
    const turn = d.waitFor('turn');
    assert.deepEqual(turn.payload, { player: 1, cpu: null, name: 'Righty' });
    const wait = turn.time - impact.time;
    assert.ok(wait >= TIMING.impact - EPS && wait <= TIMING.impact + 3 / 60, `waited ${wait}s`);
    assert.deepEqual(d.typesSince(from), ['aim', 'throw', 'impact', 'turn']);
    assert.equal(game.turn, 1);
    assert.equal(game.current, game.monkeys[1]);
    assert.equal(game.humanTurn, true);
    assert.deepEqual(game.scores, [0, 0]);
    assert.ok(game.monkeys.every(m => m.alive));

    const last = game.lastShots[0];
    assert.equal(last.angle, MISS.angle);
    assert.equal(last.power, MISS.power);
    assert.deepEqual(last.hit, { kind: 'out', x: impact.payload.x, y: impact.payload.y });
    assert.deepEqual(last.path[0], hand);
    assert.deepEqual(last.path.at(-1), { x: impact.payload.x, y: impact.payload.y });
    assert.ok(last.path.length > 10);
    assert.equal(game.lastShots[1], null);
  });

  test('turns alternate after misses and each player keeps their last aim', () => {
    const game = streetDuel();
    const d = new Driver(game);
    const turns = [game.turn];
    for (let i = 0; i < 4; i++) {
      const events = playMiss(d);
      turns.push(events.at(-1).payload.player);
    }
    assert.deepEqual(turns, [0, 1, 0, 1, 0]);
    assert.deepEqual(game.aim, [{ ...MISS }, { ...MISS }]);
    assert.ok(game.lastShots[0] && game.lastShots[1]);
    assert.equal(game.round, 1);
  });
});

describe('wind', () => {
  test("'none' is always 0, every round and turn, with no wind events", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const game = new Game({ seed, windStrength: 'none', players: HUMANS });
      const d = new Driver(game);
      game.start();
      assert.equal(game.wind, 0);
      for (let i = 0; i < 3; i++) {
        playMiss(d);
        assert.equal(game.wind, 0);
      }
      assert.equal(d.events.filter(e => e.type === 'wind').length, 0);
      assert.equal(d.events.find(e => e.type === 'roundStart').payload.wind, 0);
    }
  });

  test('every strength gives an integer wind within ±MAX_WIND, reported in roundStart', () => {
    for (const windStrength of ['none', 'calm', 'normal', 'wild']) {
      for (let seed = 0; seed < 100; seed++) {
        const game = new Game({ seed, windStrength, players: HUMANS });
        let reported;
        game.on('roundStart', p => { reported = p.wind; });
        game.start();
        assert.ok(Number.isInteger(game.wind) && Math.abs(game.wind) <= MAX_WIND, `${windStrength} seed ${seed}: ${game.wind}`);
        assert.equal(reported, game.wind);
      }
    }
  });

  test('stronger settings blow harder on average', () => {
    const meanAbs = (windStrength) => {
      let sum = 0;
      for (let seed = 0; seed < 200; seed++) {
        const game = new Game({ seed, windStrength, players: HUMANS });
        game.start();
        sum += Math.abs(game.wind);
      }
      return sum / 200;
    };
    const [none, calm, normal, wild] = ['none', 'calm', 'normal', 'wild'].map(meanAbs);
    assert.equal(none, 0);
    assert.ok(calm > 0 && calm < normal && normal < wild, `calm ${calm} normal ${normal} wild ${wild}`);
  });

  test("'wild' re-rolls the wind on each turn and announces it before the turn", () => {
    const game = new Game({ seed: 314, windStrength: 'wild', players: HUMANS });
    const d = new Driver(game);
    game.start();
    const winds = [game.wind];
    for (let i = 0; i < 8; i++) {
      const events = playMiss(d);
      const types = events.map(e => e.type);
      assert.equal(types.filter(t => t === 'wind').length, 1, `turn ${i}: ${types}`);
      assert.ok(types.indexOf('wind') < types.indexOf('turn'));
      const { wind } = events.find(e => e.type === 'wind').payload;
      assert.equal(wind, game.wind);
      assert.ok(Number.isInteger(wind) && Math.abs(wind) <= MAX_WIND);
      winds.push(wind);
    }
    assert.ok(new Set(winds).size >= 3, `winds ${winds}`);
  });

  test('other strengths keep the same wind for the whole round', () => {
    for (const windStrength of ['calm', 'normal']) {
      const game = new Game({ seed: 314, windStrength, players: HUMANS });
      const d = new Driver(game);
      game.start();
      const wind = game.wind;
      for (let i = 0; i < 4; i++) playMiss(d);
      assert.equal(game.wind, wind);
      assert.equal(d.events.filter(e => e.type === 'wind').length, 0);
    }
  });
});

describe('Game.throwVelocity()', () => {
  const throwOf = (d) => d.events.find(e => e.type === 'throw')?.payload;

  test('is refused on a CPU turn', () => {
    const game = new Game({ seed: 3, players: [{ name: 'Robo', cpu: 'easy' }, HUMANS[1]] });
    const d = new Driver(game);
    game.start();
    assert.equal(game.phase, 'aim');
    assert.equal(game.throwVelocity(20, 20), false);
    assert.equal(game.throwVelocity(20, 20, game.handPosition(0)), false);
    assert.equal(throwOf(d), undefined);
    assert.equal(game.phase, 'aim');
    assert.equal(game.banana, null);
  });

  test('is refused while a banana is in the air', () => {
    const game = stageGame();
    assert.equal(game.throwVelocity(18, 24), true);
    assert.equal(game.throwVelocity(18, 24), false);
  });

  test('throws from the hand with the given velocity and reports it as angle and power', () => {
    const game = stageGame();
    const d = new Driver(game);
    const hand = game.handPosition(0);
    assert.equal(game.throwVelocity(18, 24), true);
    const ev = throwOf(d);
    assert.deepEqual(ev, { player: 0, angle: 53.1, power: 50, x: hand.x, y: hand.y, vx: 18, vy: 24, method: 'hand' });
    assert.equal(game.banana.vx, 18);
    assert.equal(game.banana.vy, 24);
    assert.equal(game.phase, 'flight');
    close(game.aim[0].angle, 53.13, 0.01);
    close(game.aim[0].power, 50, 1e-9);
  });

  test('clamps the speed to MAX_SPEED and keeps the direction', () => {
    for (const [vx, vy] of [[300, 400], [1000, 0], [-90, 120]]) {
      const game = stageGame();
      const d = new Driver(game);
      game.throwVelocity(vx, vy);
      const ev = throwOf(d);
      close(Math.hypot(ev.vx, ev.vy), MAX_SPEED, 1e-9, 'speed');
      close(Math.atan2(ev.vy, ev.vx), Math.atan2(vy, vx), 1e-12, 'direction');
      assert.equal(ev.power, MAX_POWER);
      close(game.banana.vx, ev.vx, 1e-12);
      close(game.banana.vy, ev.vy, 1e-12);
    }
  });

  test('angles are relative to the facing of the thrower', () => {
    const game = streetDuel();
    const d = new Driver(game);
    game.throwVelocity(-18, 24);
    assert.equal(throwOf(d).angle, 126.9, 'player 0 throwing left throws backwards');
    d.waitFor('turn');
    const from = d.mark();
    game.throwVelocity(-18, 24);
    const ev = d.since(from).find(e => e.type === 'throw').payload;
    assert.equal(ev.player, 1);
    assert.equal(ev.angle, 53.1, 'player 1 throwing left throws toward player 0');
    assert.equal(ev.power, 50);
  });

  test('a release point close to the monkey is used as is', () => {
    const game = stageGame();
    const d = new Driver(game);
    const m = game.monkeys[0];
    const origin = { x: m.x + 0.5, y: m.y + 3 };
    game.throwVelocity(18, 24, origin);
    const ev = throwOf(d);
    assert.equal(ev.x, origin.x);
    assert.equal(ev.y, origin.y);
    assert.equal(game.banana.x, origin.x);
  });

  test('a far-away release point is pulled back next to the monkey', () => {
    for (const [dx, dy] of [[50, 50], [-50, -50], [8, 2], [0, 40]]) {
      const game = stageGame();
      const d = new Driver(game);
      const m = game.monkeys[0];
      game.throwVelocity(18, 24, { x: m.x + dx, y: m.y + dy });
      const ev = throwOf(d);
      assert.ok(Math.abs(ev.x - m.x) <= 3, `dx ${dx}: x offset ${ev.x - m.x}`);
      assert.ok(ev.y > m.y && ev.y - m.y <= 6.5, `dy ${dy}: y offset ${ev.y - m.y}`);
      assert.ok(Math.sign(ev.x - m.x) === Math.sign(dx) || dx === 0);
      assert.equal(game.city.solidAt(ev.x, ev.y), false);
    }
  });

  test('a missing or invalid release point means the hand', () => {
    for (const origin of [null, undefined, {}, { x: NaN, y: 3 }, { x: 3, y: Infinity }]) {
      const game = stageGame();
      const d = new Driver(game);
      const hand = game.handPosition(0);
      game.throwVelocity(18, 24, origin);
      const ev = throwOf(d);
      assert.deepEqual({ x: ev.x, y: ev.y }, hand, `origin ${JSON.stringify(origin)}`);
    }
  });

  test('never launches from inside a building', () => {
    const game = stageGame();
    const d = new Driver(game);
    const m = game.monkeys[0];
    const origin = { x: m.x - 2, y: m.y + 3 };
    const col = Math.floor(origin.x / CELL);
    const row = Math.floor(origin.y / CELL);
    game.city.grid[row * COLS + col] = 1; // a chimney right where the hand is
    assert.equal(game.city.solidAt(origin.x, origin.y), true);
    game.throwVelocity(18, 24, origin);
    const ev = throwOf(d);
    assert.equal(game.city.solidAt(ev.x, ev.y), false);
  });

  test('the stored aim stays within the setAim ranges, even for odd throws', () => {
    for (const [vx, vy] of [[10, -10], [-10, -10], [0, -30], [500, -500], [0, 0], [-60, 1]]) {
      const game = stageGame();
      game.throwVelocity(vx, vy);
      const { angle, power } = game.aim[0];
      assert.ok(angle >= 0 && angle <= 180, `angle ${angle} for ${vx},${vy}`);
      assert.ok(power >= 0 && power <= MAX_POWER, `power ${power}`);
    }
  });

  test('the reported angle and power describe the velocity', () => {
    const game = stageGame();
    const d = new Driver(game);
    game.throwVelocity(25, 7);
    const ev = throwOf(d);
    const aim = velocityToAim(25, 7, 1);
    assert.equal(ev.angle, round1(aim.angle));
    assert.equal(ev.power, round1(aim.power));
  });
});

describe('Game.previewPath()', () => {
  /** Closest point of the closed-form trajectory (sampled at physics steps) to p: { dist, t }. */
  const onPath = (p, start, v, ax, ay, seconds) => {
    let best = { dist: Infinity, t: 0 };
    for (let n = 0; n * SIM_DT <= seconds + SIM_DT; n++) {
      const t = n * SIM_DT;
      const dist = Math.hypot(start.x + v.vx * t + 0.5 * ax * t * t - p.x, start.y + v.vy * t + 0.5 * ay * t * t - p.y);
      if (dist < best.dist) best = { dist, t };
    }
    return best;
  };

  test('starts at the hand and follows the real trajectory for about `seconds`', () => {
    const game = windyStreet();
    for (const player of [0, 1]) {
      const m = game.monkeys[player];
      const hand = game.handPosition(player);
      const v = launchVelocity(70, 60, m.facing);
      for (const seconds of [0.8, 1.5]) {
        const path = game.previewPath(player, 70, 60, seconds);
        assert.deepEqual(path[0], hand);
        assert.ok(path.length >= 5, `only ${path.length} points`);
        let t = 0;
        for (const p of path) {
          assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
          const near = onPath(p, hand, v, windAccel(game.wind), -game.gravity, seconds);
          assert.ok(near.dist < 1e-6, `point ${p.x},${p.y} is off the path by ${near.dist}`);
          assert.ok(near.t >= t, 'points are in flight order');
          t = near.t;
        }
        assert.ok(t > seconds - 0.1 && t <= seconds + SIM_DT, `last point at ${t}s of ${seconds}s`);
      }
    }
  });

  test('defaults to 0.8 s, and a shorter preview is the start of a longer one', () => {
    const game = windyStreet();
    assert.deepEqual(game.previewPath(0, 50, 50), game.previewPath(0, 50, 50, 0.8));
    const short = game.previewPath(0, 50, 50, 0.3);
    const long = game.previewPath(0, 50, 50, 1.2);
    assert.ok(long.length > short.length);
    assert.deepEqual(long.slice(0, short.length - 1), short.slice(0, -1));
  });

  test('changes nothing in the game', () => {
    const game = windyGame();
    const d = new Driver(game);
    const grid = new Uint8Array(game.city.grid);
    const monkeys = structuredClone(game.monkeys);
    const aim = structuredClone(game.aim);
    for (let a = 0; a <= 180; a += 15) game.previewPath(0, a, 80, 2);
    game.previewPath(1, 45, 100, 5);
    assert.deepEqual(d.events, []);
    assert.equal(game.phase, 'aim');
    assert.equal(game.banana, null);
    assert.deepEqual(game.city.grid, grid);
    assert.deepEqual(game.monkeys, monkeys);
    assert.deepEqual(game.aim, aim);
  });

  test('stops where the banana would hit something', () => {
    // A tall wall 4 m in front of player 0, who stands on the street.
    const game = stageGame({
      city: makeCity([{ col0: 17, col1: 19, row1: 20 }]),
      positions: [{ x: 30, y: 0 }, { x: 110, y: 0 }],
    });
    const path = game.previewPath(0, 0, 50, 2);
    const last = path.at(-1);
    assert.ok(game.city.solidAt(last.x, last.y), 'ends inside the wall');
    assert.ok(path.every(p => p.x <= 34 + 0.2));
  });
});

describe('Game.destroy()', () => {
  test('stops events and leaves an idle game that is safe to update', () => {
    const game = streetDuel();
    let events = 0;
    game.onAny(() => events++);
    game.on('turn', () => events++);
    game.destroy();
    assert.equal(game.phase, 'idle');
    assert.equal(game.throwShot(MISS), false);
    for (let i = 0; i < 120; i++) game.update(1 / 60);
    game.setAim(0, 10, 10);
    assert.equal(events, 0);
  });
});
