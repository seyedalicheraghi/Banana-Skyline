// Sfx (src/audio) against a strict fake Web Audio API (tests/support/fake-webaudio.mjs) and a real core Game.
// Contract: docs/DESIGN.md "Sfx". Everything runs on simulated time: the fake context's clock only moves
// with ctx.advance(), games only move with game.update(), and Math.random is seeded for the whole file.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Sfx, SOUND_NAMES } from '../src/audio/sfx.js';
import { Game } from '../src/core/game.js';
import { FakeGainNode, FakeOscillatorNode, FakeStereoPannerNode, installFakeAudio } from './support/fake-webaudio.mjs';

const DT = 1 / 60;
const ONE_SHOT_CAP = 36;            // engine.js: MAX_VOICES (28) one-shots + 8 still fading out
const VOICE_CAP = ONE_SHOT_CAP + 2; // + the two loops (wind ambience, banana whistle)
const AUDIBLE_HZ = 200;             // continuous oscillators below this are LFOs, not tones
const HUMANS = [{ name: 'Lefty', cpu: null }, { name: 'Righty', cpu: null }];
const LONG_THROW = Object.freeze({ angle: 80, power: 100 }); // a steep lob: many seconds in the air

// ---- file-wide patches (restored in after()) ----

const logs = [];
const saved = {};
let installed = [];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

before(() => {
  saved.random = Math.random;
  saved.warn = console.warn;
  saved.error = console.error;
  console.warn = (...args) => logs.push(`warn: ${args.map(String).join(' ')}`);
  console.error = (...args) => logs.push(`error: ${args.map(String).join(' ')}`);
});

beforeEach(() => {
  Math.random = mulberry32(0x5eed); // noise buffers, crackles and noise offsets: same every test
  logs.length = 0;
});

afterEach(() => {
  for (const audio of installed) audio.uninstall();
  installed = [];
});

after(() => {
  Math.random = saved.random;
  console.warn = saved.warn;
  console.error = saved.error;
  for (const audio of installed) audio.uninstall();
});

/**
 * The CPU planner spends a real-time budget (performance.now) per frame. Swap in a clock that ticks 1 ms
 * per call while `fn` runs, so planning takes the same number of frames on any machine.
 */
function withPlannerClock(fn) {
  const perf = globalThis.performance;
  const own = Object.getOwnPropertyDescriptor(perf, 'now');
  let ms = 0;
  perf.now = () => (ms += 1);
  try {
    return fn();
  } finally {
    if (own) Object.defineProperty(perf, 'now', own);
    else delete perf.now;
  }
}

// ---- rigs ----

function install(policy) {
  const audio = installFakeAudio(policy);
  installed.push(audio);
  return audio;
}

/** An unlocked Sfx on a fresh fake context, with probes into the audio graph. */
function unlocked(policy) {
  const audio = install(policy);
  const sfx = new Sfx();
  assert.equal(sfx.unlock(), true, 'unlock() with Web Audio available');
  const ctx = audio.ctx;
  ctx.advance(0.05); // the silent unlock blip ends
  // Baseline: the master chain (buses -> mix -> ... -> master gain -> speakers) and nothing else.
  const chain = new Set(ctx.connected);
  const master = [...ctx.destination.inputs].find(n => n instanceof FakeGainNode && chain.has(n));
  assert.ok(master, 'a gain node feeds the speakers');
  assert.equal(ctx.playing.size, 0, 'nothing is sounding right after unlock');
  return rigFor(sfx, ctx, chain, master, audio);
}

function rigFor(sfx, ctx, chain, master, audio) {
  const r = {
    audio, sfx, ctx, chain, master,
    /** Sounds currently plugged into the master chain. */
    voices() {
      let n = 0;
      for (const node of ctx.connected) {
        if (chain.has(node)) continue;
        for (const out of node.outputs) if (chain.has(out)) { n += 1; break; }
      }
      return n;
    },
    /** How many sounds were ever plugged into the master chain (use differences). */
    made() {
      let n = 0;
      for (const node of chain) n += ctx.connectsInto.get(node) ?? 0;
      return n;
    },
    /** Connected nodes that are not part of the master chain. */
    stray() {
      let n = 0;
      for (const node of ctx.connected) if (!chain.has(node)) n += 1;
      return n;
    },
    /** Audible oscillators that run until stopped (loops such as the banana whistle), with their pitch. */
    tones() {
      const t = ctx.currentTime;
      return [...ctx.playing]
        .filter(s => s instanceof FakeOscillatorNode && s.stopTime === Infinity && s.playingAt(t))
        .map(s => s.frequency.valueAt(t))
        .filter(f => f >= AUDIBLE_HZ);
    },
    level: () => master.gain.valueAt(ctx.currentTime),
    /** One app frame: audio time passes, the game steps (unless paused), then sfx.update (main.js order). */
    frame(game, { dt = DT, paused = false } = {}) {
      ctx.advance(dt);
      if (game && !paused) game.update(dt);
      sfx.update(dt, game);
    },
    run(seconds, game, opts = {}) {
      const dt = opts.dt ?? DT;
      for (let t = 0; t < seconds - 1e-9; t += dt) r.frame(game, opts);
    },
    /** Graph is back to the master chain only: no voices, nothing sounding, nothing left connected. */
    assertBaseline(label) {
      assert.equal(r.voices(), 0, `${label}: no voices`);
      assert.equal(ctx.playing.size, 0, `${label}: no sources still playing`);
      assert.deepEqual([...ctx.connected].filter(n => !chain.has(n)).map(n => n.kind), [], `${label}: nothing left connected`);
      assert.equal(ctx.stats.sourcesStarted, ctx.stats.sourcesEnded, `${label}: every started source ended`);
    },
  };
  return r;
}

function assertQuiet(ctx) {
  assert.deepEqual(logs, [], 'no console.warn / console.error');
  if (ctx) {
    assert.deepEqual(ctx.errors, [], 'no Web Audio API misuse');
    assert.deepEqual(ctx.issues, [], 'no suspicious Web Audio usage');
  }
}

function humanGame(settings = {}) {
  const game = new Game({ seed: 1234, windStrength: 'none', players: HUMANS, ...settings });
  game.start();
  return game;
}

/** Route a game's events to sfx like main.js does (game.onAny -> sfx.onEvent). */
function wire(sfx, game) {
  game.onAny((type, payload) => sfx.onEvent(type, payload, game));
  return game;
}

/** Every event type in the contract, with realistic payloads. */
function sampleEvents(game) {
  return [
    ['matchStart', { settings: game.settings, seed: game.seed }],
    ['roundStart', { round: 1, wind: 5, turn: 0, pattern: 'random' }],
    ['turn', { player: 0, cpu: null, name: 'Lefty' }],
    ['cpuThinking', { player: 1, level: 'hard' }],
    ['wind', { wind: -7 }],
    ['aim', { player: 0, angle: 45, power: 50 }],
    ['throw', { player: 0, angle: 45, power: 50, x: 10, y: 20, vx: 21, vy: 21, method: 'aim' }],
    ['sunHit', { x: 72, y: 86 }],
    ['impact', { kind: 'building', x: 40, y: 20, radius: 3.4, victim: null, thrower: 0 }],
    ['crater', { x: 40, y: 20, radius: 3.4, removed: [{ col: 20, row: 10, building: 3 }] }],
    ['impact', { kind: 'ground', x: 40, y: 0, radius: 1.6, victim: null, thrower: 0 }],
    ['impact', { kind: 'out', x: -50, y: 10, radius: 0, victim: null, thrower: 0 }],
    ['impact', { kind: 'monkey', x: 120, y: 30, radius: 6.5, victim: 1, thrower: 0 }],
    ['monkeyHit', { victim: 1, thrower: 0, selfHit: false }],
    ['monkeyFall', { player: 0, fromY: 40, toY: 12 }],
    ['monkeyLand', { player: 0, y: 12 }],
    ['roundOver', { winner: 0, scores: [1, 0], selfHit: false, matchPoint: false }],
    ['matchOver', { winner: 0, scores: [3, 1] }],
  ];
}

/** Call every public method in every plausible way (used where all of them must be harmless no-ops). */
function exerciseEverything(sfx, game, frames = 120) {
  sfx.setEnabled(false);
  sfx.setEnabled(true);
  sfx.setVolume(0.3);
  sfx.setVolume('loud');
  sfx.setPanWidth(0.25);
  for (const name of [...SOUND_NAMES, 'nope', undefined]) sfx.play(name, { pan: 0.5 });
  sfx.play('click', null);
  for (const [type, payload] of sampleEvents(game)) {
    sfx.onEvent(type, payload, game);
    sfx.onEvent(type, null, game);
    sfx.onEvent(type, payload);
  }
  for (let i = 0; i < frames; i++) {
    game.update(DT);
    sfx.update(DT, game);
  }
  sfx.update(NaN, game);
  sfx.update(-1, null);
  sfx.update(Infinity, undefined);
}

// ---------------------------------------------------------------------------------------------------

describe('Sfx before unlock() and without Web Audio', () => {
  test('every method is a no-op before unlock(): no AudioContext is created and nothing throws', () => {
    const audio = install();
    const sfx = new Sfx();
    const game = humanGame();
    assert.ok(game.throwShot(LONG_THROW)); // a banana in flight while update() runs
    assert.doesNotThrow(() => exerciseEverything(sfx, game));
    sfx.dispose();
    assert.equal(audio.contexts.length, 0, 'nothing touches Web Audio before the first gesture');
    assert.equal(sfx.ready, false);
    assert.equal(sfx.enabled, true);
    assert.equal(sfx.volume, 0.3);
    assertQuiet();
  });

  test('mute and volume chosen before unlock() apply to the context it creates', () => {
    const audio = install();
    const sfx = new Sfx();
    sfx.setVolume(0.5);
    sfx.setEnabled(false); // main.js applies the saved prefs at load, before any gesture
    assert.equal(sfx.unlock(), true);
    assert.equal(sfx.unlock(), true, 'unlock() is safe to repeat');
    assert.equal(audio.contexts.length, 1, 'one context, however often unlock() is called');
    const ctx = audio.ctx;
    ctx.advance(0.05);
    const master = [...ctx.destination.inputs].find(n => n instanceof FakeGainNode);
    assert.equal(master.gain.value, 0, 'muted before unlock -> silent master');
    assert.equal(sfx.ready, false, 'muted: not ready');
    const startedBefore = ctx.stats.sourcesStarted;
    sfx.play('click');
    assert.equal(ctx.stats.sourcesStarted, startedBefore, 'no sound while muted');

    sfx.setEnabled(true);
    ctx.advance(0.5);
    const half = master.gain.value;
    assert.ok(half > 0.05 && half < 0.9, `volume 0.5 is a partial level (got ${half})`);
    sfx.setVolume(1);
    ctx.advance(0.5);
    assert.ok(master.gain.value > half, 'full volume is louder than half volume');
    sfx.play('click');
    assert.ok(ctx.stats.sourcesStarted > startedBefore, 'click plays once enabled');
    assertQuiet(ctx);
  });

  test('without Web Audio, unlock() returns false and every method stays a silent no-op', () => {
    install({ global: 'none' });
    assert.equal(typeof globalThis.AudioContext, 'undefined');
    const sfx = new Sfx();
    assert.equal(sfx.unlock(), false);
    assert.equal(sfx.unlock(), false);
    const game = humanGame();
    assert.ok(game.throwShot(LONG_THROW));
    assert.doesNotThrow(() => exerciseEverything(sfx, game));
    assert.equal(sfx.unlock(), false);
    assert.doesNotThrow(() => sfx.dispose());
    assert.equal(sfx.ready, false);
    assertQuiet();
  });

  test('an AudioContext constructor that throws counts as no Web Audio (and is not retried)', () => {
    const audio = install({ throwOnConstruct: true });
    const sfx = new Sfx();
    assert.equal(sfx.unlock(), false);
    assert.equal(sfx.unlock(), false);
    const game = humanGame();
    assert.doesNotThrow(() => exerciseEverything(sfx, game, 10));
    assert.equal(audio.contexts.length, 0);
    assert.equal(sfx.ready, false);
    assertQuiet();
  });

  test('falls back to webkitAudioContext without options, and plays panned sounds without StereoPannerNode', () => {
    const r = unlocked({ global: 'webkitAudioContext', rejectOptions: true, noStereoPanner: true });
    assert.equal(r.audio.contexts.length, 1);
    const made = r.made();
    r.sfx.play('click', { pan: -0.7 });
    r.sfx.play('error', { pan: 0.7 });
    assert.equal(r.made() - made, 2, 'both sounds play');
    r.run(1.5, null);
    r.assertBaseline('after the sounds end');
    assertQuiet(r.ctx);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('Sfx in a match', () => {
  test('a full CPU-vs-CPU match plays the contract sounds without errors, stays bounded, and cleans up', () => {
    const r = unlocked();
    // Seed 3, 'hard', wild wind: covers building/ground/monkey impacts, sun hits and mid-round wind changes.
    const game = new Game({
      seed: 3, targetScore: 3, windStrength: 'wild',
      players: [{ name: 'Bongo', cpu: 'hard' }, { name: 'Mango', cpu: 'hard' }],
    });
    const fired = []; // { key, made } per event
    game.onAny((type, p) => {
      const before = r.made();
      r.sfx.onEvent(type, p, game);
      fired.push({ key: type === 'impact' ? `impact:${p.kind}` : type, made: r.made() - before });
    });
    const dt = 1 / 30;
    let time = 0;
    let peakVoices = 0;
    let peakStray = 0;
    let minVoices = Infinity;
    withPlannerClock(() => {
      game.start();
      r.frame(game, { dt }); // first frame starts the ambience
      while (game.phase !== 'matchOver' && time < 900) {
        r.frame(game, { dt });
        time += dt;
        const v = r.voices();
        peakVoices = Math.max(peakVoices, v);
        minVoices = Math.min(minVoices, v);
        peakStray = Math.max(peakStray, r.stray());
      }
    });
    assert.equal(game.phase, 'matchOver', `match finished (after ${time.toFixed(1)}s)`);
    assertQuiet(r.ctx);

    const keys = new Set(fired.map(f => f.key));
    for (const k of ['roundStart', 'turn', 'throw', 'impact:building', 'impact:ground', 'impact:monkey', 'sunHit', 'wind', 'roundOver', 'matchOver']) {
      assert.ok(keys.has(k), `the fixed seed produced a '${k}' event`);
    }
    // docs/DESIGN.md: which events make sounds.
    const minimum = {
      throw: 1, 'impact:building': 1, 'impact:ground': 1, 'impact:monkey': 2, sunHit: 1, monkeyFall: 1,
      monkeyLand: 1, turn: 1, roundOver: 1, matchOver: 1, roundStart: 1,
    };
    for (const f of fired) {
      if (f.key in minimum) assert.ok(f.made >= minimum[f.key], `'${f.key}' made ${f.made} sound(s), expected >= ${minimum[f.key]}`);
    }

    assert.ok(minVoices >= 1, 'the wind ambience plays throughout the match');
    assert.ok(peakVoices <= VOICE_CAP, `peak voices ${peakVoices} <= ${VOICE_CAP}`);
    assert.ok(peakStray <= VOICE_CAP * 40, `peak connected nodes ${peakStray} stay bounded`);

    // The match-over fanfare is still playing a second later...
    r.run(1, game, { dt });
    assert.ok(r.voices() >= 2, 'ambience + fanfare after match over');
    // ...then the player goes back to the title screen (a new demo match): the jingle and loops fade out.
    const demo = wire(r.sfx, new Game({ seed: 99, demo: true, players: [{ cpu: 'hard' }, { cpu: 'hard' }] }));
    withPlannerClock(() => {
      demo.start();
      r.run(1.5, demo, { dt });
    });
    r.assertBaseline('back at the title screen');
    assertQuiet(r.ctx);
  });

  test('demo games are silent, but UI sounds still play over them', () => {
    const r = unlocked();
    const demo = wire(r.sfx, new Game({
      seed: 5, demo: true, targetScore: 2, windStrength: 'wild',
      players: [{ name: 'A', cpu: 'hard' }, { name: 'B', cpu: 'hard' }],
    }));
    const started = r.ctx.stats.sourcesStarted;
    const made = r.made();
    withPlannerClock(() => {
      demo.start();
      for (let t = 0; demo.phase !== 'matchOver' && t < 600; t += 1 / 30) r.frame(demo, { dt: 1 / 30 });
    });
    assert.equal(demo.phase, 'matchOver', 'the whole demo match ran');
    assert.equal(r.made() - made, 0, 'no sound for any demo event or demo frame');
    assert.equal(r.ctx.stats.sourcesStarted, started, 'no source started');

    r.sfx.play('click');
    assert.equal(r.made() - made, 1, 'menu clicks over the demo still play');
    r.run(1, demo);
    r.assertBaseline('after the click');

    // Starting a real match from the title screen brings the ambience in.
    const game = wire(r.sfx, humanGame());
    r.run(0.2, game);
    assert.ok(r.voices() >= 1, 'ambience in a real match');
    assertQuiet(r.ctx);
  });

  test('each event in the contract makes its sound (incl. falls and landings the seeded match lacks)', () => {
    const r = unlocked();
    const game = humanGame();
    const expected = {
      roundStart: 1, turn: 1, throw: 1, sunHit: 1, 'impact:building': 1, 'impact:ground': 1,
      'impact:monkey': 2, monkeyFall: 1, monkeyLand: 1, roundOver: 1, matchOver: 1,
    };
    for (const [type, payload] of sampleEvents(game)) {
      const key = type === 'impact' ? `impact:${payload.kind}` : type;
      const before = r.made();
      r.sfx.onEvent(type, payload, game);
      const made = r.made() - before;
      if (key in expected) assert.ok(made >= expected[key], `'${key}' made ${made} sound(s), expected >= ${expected[key]}`);
      r.run(0.7, game, { paused: true });
    }
    r.sfx.update(DT, null);
    r.run(6, null);
    r.assertBaseline('after all event sounds');
    assertQuiet(r.ctx);
  });

  test('odd payloads, a missing game and odd frame times never throw or misuse Web Audio', () => {
    const r = unlocked();
    const game = humanGame();
    const odd = [null, undefined, {}, { x: NaN, y: Infinity, vx: 'fast', vy: null, player: 7, victim: 'both' },
      { kind: 'monkey', victim: 5, x: -1e9, radius: -3 }, { kind: 'unknown', radius: NaN }, { removed: 'lots' },
      { removed: new Array(500) }, { fromY: 'high', toY: {} }, { wind: Infinity }];
    const types = [...new Set(sampleEvents(game).map(([t]) => t)), 'bogus', '', undefined];
    assert.doesNotThrow(() => {
      for (const type of types) {
        for (const p of odd) {
          r.sfx.onEvent(type, p, game);
          r.sfx.onEvent(type, p);
          r.sfx.onEvent(type, p, null);
          r.sfx.onEvent(type, p, {});
        }
        r.run(0.05, game, { paused: true });
      }
      for (const dt of [NaN, -1, 0, Infinity, 1e9, 'x']) r.sfx.update(dt, game);
      r.sfx.update(DT, { city: {}, wind: NaN, phase: 'flight', banana: { x: NaN, vx: NaN, vy: 1, t: 0 } });
      r.sfx.update(DT, { city: {}, wind: 'east', phase: 'flight', banana: { x: 'a', vx: 1e9, vy: -1e9, t: 1 } });
      r.sfx.update(DT, { isDemo: false });
    });
    r.run(8, null);
    r.assertBaseline('after the odd events');
    assertQuiet(r.ctx);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('Sfx controls', () => {
  test('setEnabled(false) ramps the master gain to 0, stops the loops and silences events; true restores', () => {
    const r = unlocked();
    const game = wire(r.sfx, humanGame());
    assert.ok(game.throwShot(LONG_THROW));
    r.run(0.5, game);
    assert.ok(r.voices() >= 2, 'ambience and whistle (and the throw) before muting');
    assert.ok(r.tones().length > 0, 'whistle playing');
    const full = r.level();
    assert.ok(full > 0.5, `master level at the default volume (got ${full})`);

    r.sfx.setEnabled(false);
    assert.equal(r.sfx.enabled, false);
    assert.equal(r.sfx.ready, false);
    const now = r.ctx.currentTime;
    assert.ok(Math.abs(r.master.gain.valueAt(now) - full) < 1e-6, 'no jump at the moment of muting');
    const soon = r.master.gain.valueAt(now + 0.02);
    assert.ok(soon < full && soon > 0, `ramping down (got ${soon})`);
    assert.ok(r.master.gain.valueAt(now + 0.5) < 1e-3, 'reaches silence');

    r.run(0.5, game); // the game keeps flying and update() keeps being called
    assert.ok(r.level() < 1e-3, 'master gain is 0');
    assert.deepEqual(r.tones(), [], 'whistle stopped');
    r.assertBaseline('muted');

    const made = r.made();
    r.sfx.onEvent('impact', { kind: 'building', x: 40, y: 20, radius: 3.4 }, game);
    r.sfx.play('click');
    r.run(1, game);
    assert.equal(r.made() - made, 0, 'no events, UI sounds or loops while muted');

    r.sfx.setEnabled(true);
    r.run(0.5, game);
    assert.ok(Math.abs(r.level() - full) < 1e-3, 'master back to the volume level');
    assert.ok(r.voices() >= 1, 'ambience is back');
    const back = r.made();
    r.sfx.play('click');
    assert.equal(r.made() - back, 1, 'UI sounds are back');
    assertQuiet(r.ctx);
  });

  test('setVolume clamps to 0..1, ignores non-numbers, and sets the master level monotonically', () => {
    const r = unlocked();
    const levelFor = (v) => {
      r.sfx.setVolume(v);
      r.ctx.advance(0.5);
      return r.level();
    };
    const l1 = levelFor(1);
    assert.equal(r.sfx.volume, 1);
    const lHalf = levelFor(0.5);
    const lQuarter = levelFor(0.25);
    const l0 = levelFor(0);
    assert.ok(l1 <= 1 + 1e-9 && l1 > 0.9, `full volume ~ unity (got ${l1})`);
    assert.ok(l1 > lHalf && lHalf > lQuarter && lQuarter > l0, `monotonic: ${[l1, lHalf, lQuarter, l0]}`);
    assert.ok(l0 < 1e-3, 'volume 0 is silent');

    assert.ok(Math.abs(levelFor(2) - l1) < 1e-3, 'volume 2 sounds like 1');
    assert.equal(r.sfx.volume, 1, 'clamped to 1');
    assert.ok(levelFor(-3) < 1e-3, 'volume -3 sounds like 0');
    assert.equal(r.sfx.volume, 0, 'clamped to 0');

    levelFor(0.5);
    for (const junk of ['loud', NaN, undefined, Infinity, -Infinity, {}]) {
      assert.ok(Math.abs(levelFor(junk) - lHalf) < 1e-3, `setVolume(${String(junk)}) keeps the level`);
      assert.equal(r.sfx.volume, 0.5, `setVolume(${String(junk)}) keeps the volume`);
    }
    assert.equal(r.sfx.enabled, true, 'volume does not touch mute');
    assertQuiet(r.ctx);
  });

  test("play('click' | 'hover' | 'error') each plays one short sound that cleans up after itself", () => {
    const r = unlocked();
    for (const name of ['click', 'hover', 'error']) {
      const made = r.made();
      const started = r.ctx.stats.sourcesStarted;
      r.sfx.play(name);
      assert.equal(r.made() - made, 1, `${name}: one voice`);
      assert.ok(r.ctx.stats.sourcesStarted > started, `${name}: sources started`);
      assert.equal(r.voices(), 1, `${name}: sounding`);
      r.run(1, null);
      r.assertBaseline(`${name} after 1 s`);
    }
    assertQuiet(r.ctx);
  });

  test('play() honours {pan}, ignores unknown names, and does not stack hover sounds', () => {
    const r = unlocked();
    const pannerOfNewVoice = () => [...r.ctx.connected].find(n => n instanceof FakeStereoPannerNode && !r.chain.has(n));

    r.sfx.play('click', { pan: -0.7 });
    const left = pannerOfNewVoice();
    assert.ok(left, 'a panned sound goes through a StereoPannerNode');
    assert.ok(left.pan.value < 0 && left.pan.value >= -1, `pan left (got ${left.pan.value})`);
    r.run(1, null);

    r.sfx.play('error', { pan: 5 });
    const right = pannerOfNewVoice();
    assert.ok(right && right.pan.value > 0 && right.pan.value <= 1, 'pan 5 is clamped to the right edge');
    r.run(1, null);

    const made = r.made();
    for (const name of ['nope', 'toString', '__proto__', 'constructor', '', undefined, null, 42]) r.sfx.play(name);
    for (const opts of [{ pan: NaN }, { pan: 'left' }, { delay: -5 }, { delay: 1e9 }]) r.sfx.play('click', opts);
    r.sfx.play('click', null);
    assert.equal(r.made() - made, 5, 'only the five valid clicks play');
    r.run(3, null);
    r.assertBaseline('after the clicks');

    const hovers = r.made();
    for (let i = 0; i < 5; i++) r.sfx.play('hover');
    assert.equal(r.made() - hovers, 1, 'five hovers in the same instant make one sound');
    r.run(0.2, null);
    r.sfx.play('hover');
    assert.equal(r.made() - hovers, 2, 'a later hover plays again');
    r.run(1, null);
    r.assertBaseline('after the hovers');
    assertQuiet(r.ctx);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('Sfx loops', () => {
  test('the wind ambience follows |wind|: quiet at 0, louder with strength, the same either way', () => {
    const r = unlocked();
    const game = humanGame(); // phase 'aim', a city, no banana: only the ambience plays
    const levelAt = (wind) => {
      game.wind = wind;
      r.run(5, game, { paused: true });
      assert.equal(r.voices(), 1, `wind ${wind}: just the ambience`);
      return r.ctx.outputLevel();
    };
    const lv = Object.fromEntries([0, 4, 8, 15, -15, -8, -4, 0].map(w => [w, levelAt(w)]));
    assert.ok(lv[0] > 0, 'some city ambience even without wind');
    assert.ok(lv[0] < lv[4] && lv[4] < lv[8] && lv[8] < lv[15], `rises with |wind|: ${[lv[0], lv[4], lv[8], lv[15]]}`);
    for (const w of [4, 8, 15]) {
      assert.ok(Math.abs(lv[-w] - lv[w]) / lv[w] < 0.01, `wind ${-w} as loud as ${w}: ${lv[-w]} vs ${lv[w]}`);
    }
    assert.ok(lv[15] / lv[0] > 2, `a gale is clearly louder than calm (x${(lv[15] / lv[0]).toFixed(2)})`);

    r.sfx.update(DT, null); // no game: no ambience
    r.run(1.5, null);
    r.assertBaseline('ambience stops without a game');
    assertQuiet(r.ctx);
  });

  test('the banana whistle plays only while a banana flies, and goes quiet when the game is paused', () => {
    const r = unlocked();
    const game = wire(r.sfx, humanGame());
    r.run(0.5, game);
    assert.deepEqual(r.tones(), [], 'no whistle before the throw');

    assert.ok(game.throwShot(LONG_THROW));
    r.run(0.3, game);
    assert.equal(game.phase, 'flight');
    assert.ok(r.tones().length > 0, 'whistle while flying');

    r.run(0.5, game, { paused: true }); // paused mid-flight: the banana stops moving, update() continues
    assert.equal(game.phase, 'flight');
    assert.deepEqual(r.tones(), [], 'whistle stops while the banana is frozen');
    r.run(0.1, game);
    assert.ok(r.tones().length > 0, 'whistle back after unpausing');

    let flightFramesWithout = 0;
    let frames = 0;
    while (game.phase === 'flight' && frames < 60 * 30) {
      r.frame(game);
      frames += 1;
      if (r.tones().length === 0) flightFramesWithout += 1;
    }
    assert.notEqual(game.phase, 'flight', 'the banana landed');
    assert.ok(flightFramesWithout <= 1, `whistle missing in ${flightFramesWithout} flight frames`);
    r.run(0.25, game);
    assert.deepEqual(r.tones(), [], 'no whistle after the impact');
    r.run(2, game);
    assert.deepEqual(r.tones(), [], 'and none until the next throw');
    assertQuiet(r.ctx);
  });

  test('the whistle pitch rises with banana speed', () => {
    const r = unlocked();
    const game = humanGame();
    assert.ok(game.throwShot(LONG_THROW));
    const b = game.banana;
    const pitchAt = (speed) => {
      Object.assign(b, { vx: speed, vy: 0 }); // level flight at a chosen speed
      for (let i = 0; i < 18; i++) {
        b.t += DT; // the banana is moving (game time advances) but we hold its velocity
        r.frame(game, { paused: true });
      }
      const tones = r.tones();
      assert.ok(tones.length > 0, `whistle at speed ${speed}`);
      return Math.min(...tones);
    };
    const pitches = [5, 20, 40, 60].map(pitchAt);
    for (let i = 1; i < pitches.length; i++) {
      assert.ok(pitches[i] > pitches[i - 1], `faster is higher: ${pitches.map(p => p.toFixed(0))}`);
    }
    game.banana = null;
    game.phase = 'impact';
    r.run(0.25, game, { paused: true });
    assert.deepEqual(r.tones(), [], 'no banana, no whistle');
    assertQuiet(r.ctx);
  });

  test('a burst of sounds is capped and fully released afterwards', () => {
    const r = unlocked();
    let peak = 0;
    for (let i = 0; i < 300; i++) r.sfx.play('explosion', { x: i % 144 });
    peak = Math.max(peak, r.voices());
    for (let f = 0; f < 60; f++) {
      for (let i = 0; i < 10; i++) r.sfx.play(i % 2 ? 'bigExplosion' : 'debris', { pan: (i / 5) - 1 });
      r.frame(null);
      peak = Math.max(peak, r.voices());
    }
    assert.ok(peak <= ONE_SHOT_CAP, `peak ${peak} voices <= ${ONE_SHOT_CAP}`);
    assert.ok(peak >= 20, `the burst really overlapped (${peak} voices)`);
    r.run(4, null);
    r.assertBaseline('after the burst');
    assertQuiet(r.ctx);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('Sfx context lifecycle', () => {
  test('recovers when the system suspends a running context, without hammering resume()', () => {
    const r = unlocked();
    const game = wire(r.sfx, humanGame());
    r.run(0.2, game);
    assert.equal(r.sfx.ready, true);

    for (const state of ['suspended', 'interrupted']) {
      r.ctx.interrupt(state); // headset sleep / app switch / iOS interruption
      r.ctx.autoplayAllowed = false; // and the system refuses to resume for a while
      assert.equal(r.sfx.ready, false, `${state}: not ready`);
      const made = r.made();
      r.sfx.onEvent('impact', { kind: 'building', x: 40, y: 20, radius: 3.4 }, game);
      assert.equal(r.made() - made, 0, `${state}: events are dropped, not queued`);

      const calls = r.ctx.stats.resumeCalls;
      r.run(3, game);
      const tries = r.ctx.stats.resumeCalls - calls;
      assert.ok(tries >= 1 && tries <= 5, `${state}: ${tries} resume attempts in 3 s (180 frames)`);
      assert.equal(r.ctx.state, state);

      r.ctx.allowAutoplay(); // the system lets us run again
      let waited = 0;
      while (r.ctx.state !== 'running' && waited < 5) {
        r.frame(game);
        waited += DT;
      }
      assert.equal(r.ctx.state, 'running', `${state}: resumed by update()`);
      assert.ok(waited <= 1.6, `${state}: resumed within ${waited.toFixed(2)} s`);
      assert.equal(r.sfx.ready, true);
      r.run(0.1, game);
      assert.ok(r.voices() >= 1, `${state}: ambience back`);
      const again = r.made();
      r.sfx.play('click');
      assert.equal(r.made() - again, 1, `${state}: sounds play again`);
    }
    assertQuiet(r.ctx);
  });

  test('a context that never ran (autoplay blocked) is left alone until the next unlock()', () => {
    const audio = install({ state: 'suspended', autoplay: 'blocked' });
    const sfx = new Sfx();
    assert.equal(sfx.unlock(), true, 'the context exists, it just is not running yet');
    const ctx = audio.ctx;
    assert.equal(ctx.state, 'suspended');
    assert.equal(sfx.ready, false);
    const calls = ctx.stats.resumeCalls;
    const game = wire(sfx, humanGame());
    for (let i = 0; i < 300; i++) {
      ctx.advance(DT);
      sfx.update(DT, game);
    }
    assert.equal(ctx.stats.resumeCalls, calls, 'update() never calls resume() on a context that has not run');

    ctx.allowAutoplay(); // a real user gesture
    assert.equal(sfx.unlock(), true);
    assert.equal(ctx.state, 'running');
    assert.equal(audio.contexts.length, 1, 'the same context is resumed');
    assert.equal(sfx.ready, true);
    ctx.advance(0.05);
    const r = rigFor(sfx, ctx, new Set([...ctx.connected]), null, audio);
    const made = r.made();
    sfx.play('click');
    assert.equal(r.made() - made, 1, 'sounds play after the gesture');
    assertQuiet(ctx);
  });

  test('dispose() stops everything, closes the context, and later calls are harmless', () => {
    const r = unlocked();
    const game = wire(r.sfx, humanGame());
    assert.ok(game.throwShot(LONG_THROW));
    r.run(0.5, game);
    r.sfx.play('click');
    assert.ok(r.voices() >= 3, 'ambience, whistle and one-shots are playing');

    r.sfx.dispose();
    assert.equal(r.ctx.state, 'closed');
    assert.equal(r.ctx.stats.closeCalls, 1);
    assert.equal(r.voices(), 0, 'every voice is disconnected at once');
    assert.equal(r.stray(), 0, 'no node outside the master chain stays connected');
    const now = r.ctx.currentTime;
    assert.ok([...r.ctx.playing].every(s => s.stopTime <= now), 'every running source was told to stop');
    assert.equal(r.sfx.ready, false);

    const nodes = r.ctx.stats.nodes;
    assert.doesNotThrow(() => {
      exerciseEverything(r.sfx, game, 60);
      r.sfx.dispose();
    });
    assert.equal(r.ctx.stats.nodes, nodes, 'nothing is created on the closed context');
    assert.equal(r.ctx.stats.closeCalls, 1, 'the context is closed only once');
    assert.equal(r.audio.contexts.length, 1, 'no new context without unlock()');
    assertQuiet(r.ctx);

    const fresh = new Sfx();
    assert.doesNotThrow(() => fresh.dispose());
    assert.equal(r.audio.contexts.length, 1, 'dispose() before unlock() touches nothing');
  });
});
