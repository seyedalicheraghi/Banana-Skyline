// XRMode (src/xr): session lifecycle, rig placement, hand and thumbstick throwing, VR panels, disposal.
// Drives the real module and a real core Game through fakes of three's WebXRManager, navigator.xr, Quest
// controllers / tracked hands and a contract-shaped GameView (tests/support/xr-fakes.mjs), on a simulated
// clock (performance.now only moves with the frames). Contract: docs/DESIGN.md, "XRMode".
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BUILDING_DEPTH, CITY_WIDTH, MAX_POWER, VR_SCALE } from '../src/core/constants.js';
import { Game } from '../src/core/game.js';
import { THROW_BOOST, XRMode } from '../src/xr/xr.js';
import { BOW_MIN_POWER, THROW_BOOSTS, bowAim } from '../src/xr/throw.js';
import { MISS } from './helpers.mjs';
import {
  FRAME, FakeWebXRManager, FakeXRSystem, TEST_SEED, buttonCenter, createXRApp, headInScene, installXREnv,
  pointAt, rigForward, touchController, trackedHand,
} from './support/xr-fakes.mjs';

const BUTTON = { trigger: 0, squeeze: 1, a: 4, b: 5 }; // xr-standard on Quest Touch (A/X = 4, B/Y = 5)
const STICK_X = 2;
const STICK_Y = 3;

let env;
let pristine;
before(() => {
  pristine = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    now: Object.getOwnPropertyDescriptor(globalThis.performance, 'now'),
    error: console.error,
    warn: console.warn,
  };
  env = installXREnv();
});
after(() => {
  env.restore();
  // Nothing patched for this file outlives it.
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'navigator'), pristine.navigator);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, 'document'), pristine.document);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis.performance, 'now'), pristine.now);
  assert.equal(console.error, pristine.error);
  assert.equal(console.warn, pristine.warn);
});
beforeEach(() => {
  env.clearLogs();
  env.nav.xr = new FakeXRSystem();
});

// --- helpers -------------------------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));
const fade = (app) => app.xr.camera.getObjectByName('xr-fade')?.material.opacity ?? 0;
/** The player XRMode says you are (last view.setLocalPlayer), or null in the overview. */
const me = (app) => app.view.argsOf('setLocalPlayer').at(-1) ?? null;
const deg = (rad) => (rad * 180) / Math.PI;

function assertQuiet(label = '') {
  assert.deepEqual(env.logs.errors, [], `console.error ${label}`);
  assert.deepEqual(env.logs.warns, [], `console.warn ${label}`);
}

function isUnder(obj, ancestor) {
  for (let o = obj; o; o = o.parent) if (o === ancestor) return true;
  return false;
}

/** Controllers resting at the sides, pointing down at the floor (their rays hit no panel). */
function rest(app, slots = [0, 1]) {
  for (const i of slots) {
    const x = app.head.x + (i === 0 ? 0.25 : -0.25);
    app.manager.pose(i, {
      position: new THREE.Vector3(x, 1.0, app.head.z - 0.15),
      lookAt: new THREE.Vector3(x, 0, app.head.z - 0.6),
    });
  }
}

/** Run at least one frame, then until any rig move has faded back in. */
function settle(app, label = 'rig placed and faded in') {
  app.frame();
  app.runUntil(() => fade(app) === 0, { label, maxSeconds: 5 });
}

async function enterVR(app, { hands = false } = {}) {
  assert.equal(await app.xr.enter(), true, 'enter() resolves true');
  const make = hands ? trackedHand : touchController;
  app.manager.connect(0, make('right'));
  app.manager.connect(1, make('left'));
  rest(app);
  settle(app);
}

/** Press and release on slot i in two consecutive frames (input events fire at the start of a frame). */
function click(app, i, kind = 'select') {
  app.frame(FRAME, () => app.manager.fire(i, `${kind}start`));
  app.frame(FRAME, () => app.manager.fire(i, `${kind}end`));
}

function clickButton(app, panel, id, i = 0) {
  pointAt(app, i, buttonCenter(panel, id));
  app.frame(); // laser + hover with the new pose
  click(app, i);
  rest(app, [i]);
}

/** Press gamepad button `index` on slot i for `frames` frames, then release it for one frame. */
function tap(app, i, index, frames = 1) {
  const b = app.manager.slot(i).source.gamepad.buttons[index];
  b.pressed = true;
  b.value = 1;
  app.run(frames);
  b.pressed = false;
  b.value = 0;
  app.frame();
}

/** From the VR menu over the demo: laser-click "vs CPU <level>" and wait until you stand on your roof. */
function startVsCpu(app, level = 'normal') {
  assert.equal(app.xr.menu.visible, true, 'the VR menu is shown');
  clickButton(app, app.xr.menu, `cpu-${level}`);
  settle(app);
  return app.game;
}

function untilMyTurn(app, label = 'your turn') {
  app.runUntil(() => {
    const g = app.game;
    return g.phase === 'aim' && g.humanTurn && g.turn === me(app) && fade(app) === 0 && !app.xr.menu.visible;
  }, { label, maxSeconds: 120 });
  app.frame();
}

/**
 * Grab with `button` on slot i, move along path(t) (rig-local position/velocity t seconds after the grab)
 * for `frames` frames, and let go at the start of the next one. `measured` reports XRPose.linearVelocity.
 * Returns the throwVelocity calls and 'throw' events that the release caused.
 */
function swing(app, i, path, { frames = 7, measured = false, button = 'select' } = {}) {
  const at = (k) => {
    const { position, velocity } = path(k * FRAME);
    app.manager.pose(i, {
      position,
      lookAt: position.clone().add(new THREE.Vector3(0, -0.6, -1)),
      velocity: measured ? velocity : null,
    });
  };
  app.frame(FRAME, () => {
    at(0);
    app.manager.fire(i, `${button}start`);
  });
  for (let k = 1; k <= frames; k++) app.frame(FRAME, () => at(k));
  const calls = app.throwCalls.length;
  const events = app.events.length;
  app.frame(FRAME, () => {
    at(frames + 1);
    app.manager.fire(i, `${button}end`);
  });
  return { calls: app.throwCalls.slice(calls), throws: app.eventsOf('throw', events) };
}

/** Uniformly accelerating straight swing from `from` along `dir`, reaching `speed` m/s after `seconds`. */
function accelerating(from, dir, speed, seconds) {
  const d = dir.clone().normalize();
  const a = speed / seconds;
  return (t) => ({
    position: from.clone().addScaledVector(d, 0.5 * a * t * t),
    velocity: d.clone().multiplyScalar(a * t),
  });
}

function steady(from, velocity) {
  return (t) => ({ position: from.clone().addScaledVector(velocity, t), velocity: velocity.clone() });
}

/** Overhand: start behind and above the shoulder, forward (-z) and 30 degrees up, 6 m/s at the release (~110 ms). */
const OVERHAND_ANGLE = 30;
const OVERHAND_SPEED = 6;
function overhand(app) {
  const from = new THREE.Vector3(app.head.x + 0.2, 1.75, app.head.z + 0.25);
  const a = (OVERHAND_ANGLE * Math.PI) / 180;
  return accelerating(from, new THREE.Vector3(0, Math.sin(a), -Math.cos(a)), OVERHAND_SPEED, 8 * FRAME);
}

/** Checks for one hand throw by `player` toward the other monkey. */
function assertHandThrowToward(app, result, player, { angle = OVERHAND_ANGLE, handSpeed = OVERHAND_SPEED } = {}) {
  const game = app.game;
  const m = game.monkeys[player];
  const foe = game.monkeys[1 - player];
  assert.equal(result.calls.length, 1, 'release calls game.throwVelocity once');
  const c = result.calls[0];
  assert.equal(c.player, player);
  assert.equal(c.ok, true, 'throwVelocity accepted the throw');
  assert.equal(Math.sign(c.vx), Math.sign(foe.x - m.x), `vx ${c.vx.toFixed(2)} points at the opponent (x ${m.x} -> ${foe.x})`);
  assert.ok(c.vy > 0, `vy ${c.vy} is up`);
  const thrownAngle = deg(Math.atan2(c.vy, Math.abs(c.vx)));
  assert.ok(Math.abs(thrownAngle - angle) < 4, `throw angle ${thrownAngle.toFixed(1)} follows the swing (${angle})`);
  const ideal = (handSpeed / VR_SCALE) * app.xr.throwBoost; // scene m/s -> world units/s, boosted
  const speed = Math.hypot(c.vx, c.vy);
  assert.ok(speed > 0.7 * ideal && speed < 1.1 * ideal, `launch speed ${speed.toFixed(1)} vs ideal ${ideal.toFixed(1)}`);
  // The release point is passed in world units, at the thrower's hand.
  assert.ok(c.origin && Number.isFinite(c.origin.x) && Number.isFinite(c.origin.y), 'origin given');
  assert.ok(Math.abs(c.origin.x - m.x) < 2.5, `origin x ${c.origin.x.toFixed(2)} near the monkey (${m.x})`);
  assert.ok(c.origin.y > m.y && c.origin.y < m.y + 6, `origin y ${c.origin.y.toFixed(2)} above the roof (${m.y})`);
  assert.equal(result.throws.length, 1, 'one throw event');
  const t = result.throws[0].payload;
  assert.equal(t.method, 'hand');
  assert.equal(t.player, player);
  assert.ok(t.power >= 30 && t.power <= 90, `a comfortable overhand swing gives a sensible power (${t.power})`);
  assert.equal(game.phase, 'flight');
}

function collectResources(roots) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  for (const root of roots) {
    root?.traverse((o) => {
      if (o.geometry) geometries.add(o.geometry);
      for (const mat of [o.material].flat()) {
        if (!mat) continue;
        materials.add(mat);
        if (mat.map) textures.add(mat.map);
      }
    });
  }
  return { geometries, materials, textures };
}

function countObjects(root) {
  let n = 0;
  root.traverse(() => {
    n += 1;
  });
  return n;
}

// --- tests ---------------------------------------------------------------------------------------------

describe('XRMode.isSupported', () => {
  test('asks navigator.xr about immersive-vr', async () => {
    assert.equal(await XRMode.isSupported(), true);
    assert.deepEqual(env.nav.xr.supportCalls, ['immersive-vr']);
    env.nav.xr = new FakeXRSystem({ supported: false });
    assert.equal(await XRMode.isSupported(), false);
  });

  test('is false (never throws) without WebXR or when the check throws or rejects', async () => {
    env.nav.xr = undefined;
    assert.equal(await XRMode.isSupported(), false);
    env.nav.xr = {};
    assert.equal(await XRMode.isSupported(), false);
    env.nav.xr = { isSessionSupported() { throw new Error('SecurityError'); } };
    assert.equal(await XRMode.isSupported(), false);
    env.nav.xr = { isSessionSupported: () => Promise.reject(new Error('NotSupportedError')) };
    assert.equal(await XRMode.isSupported(), false);
    Object.defineProperty(env.nav, 'xr', { configurable: true, get() { throw new Error('blocked by permissions policy'); } });
    try {
      assert.equal(await XRMode.isSupported(), false);
    } finally {
      Object.defineProperty(env.nav, 'xr', { configurable: true, enumerable: true, writable: true, value: undefined });
    }
    assertQuiet();
  });
});

describe('XRMode session', () => {
  test('enter() requests immersive-vr with local-floor, scales the world and reports the session', async () => {
    const app = createXRApp(env);
    app.startDemo();
    const xrs = env.nav.xr;
    assert.equal(app.xr.active, false);
    assert.equal(await app.xr.enter(), true);

    assert.equal(xrs.requests.length, 1);
    const { mode, init } = xrs.requests[0];
    assert.equal(mode, 'immersive-vr');
    const optional = init.optionalFeatures ?? [];
    assert.ok([...(init.requiredFeatures ?? []), ...optional].includes('local-floor'), 'local-floor requested');
    assert.ok(optional.includes('bounded-floor') && optional.includes('hand-tracking'), 'bounded-floor and hand-tracking are optional');
    assert.deepEqual(app.manager.referenceSpaceCalls, ['local-floor']);
    assert.deepEqual(app.manager.setSessionCalls, [xrs.lastSession]);
    assert.equal(app.xr.active, true);
    assert.deepEqual(app.view.argsOf('setXRScale'), [VR_SCALE]);
    assert.equal(app.world.scale.x, VR_SCALE);
    assert.deepEqual(app.sessionChanges, [true]);
    assert.ok(app.xr.camera.isPerspectiveCamera, 'camera to render with');
    assert.ok(isUnder(app.xr.camera, app.xr.rig) && isUnder(app.xr.rig, app.scene), 'camera inside the rig, rig in the scene');

    // Over the demo: the menu, at the overview spot in front of the city, looking at it.
    app.manager.connect(0, touchController('right'));
    app.manager.connect(1, touchController('left'));
    rest(app);
    settle(app);
    assert.equal(app.xr.menu.visible, true, 'menu shown over the demo');
    assert.equal(app.xr.hud.visible, false, 'no match HUD over the demo');
    assert.equal(me(app), null, 'both monkeys visible');
    const head = headInScene(app);
    assert.ok(head.x > 0 && head.x < CITY_WIDTH * VR_SCALE, `head x ${head.x.toFixed(2)} in front of the city`);
    assert.ok(head.z > (BUILDING_DEPTH / 2) * VR_SCALE, `head z ${head.z.toFixed(2)} in front of the buildings`);
    assert.ok(rigForward(app.xr.rig).z < -0.99, 'looking at the city');
    assertQuiet();
  });

  test('entering twice does nothing', async () => {
    const app = createXRApp(env);
    app.startDemo();
    const xrs = env.nav.xr;
    assert.equal(await app.xr.enter(), true);
    assert.equal(await app.xr.enter(), true, 'already presenting');
    assert.equal(xrs.requests.length, 1);
    assert.equal(app.manager.setSessionCalls.length, 1);
    assert.deepEqual(app.view.argsOf('setXRScale'), [VR_SCALE]);
    assert.deepEqual(app.sessionChanges, [true]);

    // Two clicks before the first request resolves: still one session.
    const other = createXRApp(env);
    other.startDemo();
    env.nav.xr = new FakeXRSystem();
    const [first] = await Promise.all([other.xr.enter(), other.xr.enter()]);
    assert.equal(first, true);
    assert.equal(env.nav.xr.requests.length, 1);
    assert.equal(other.xr.active, true);
    assert.deepEqual(other.sessionChanges, [true]);
    assertQuiet();
  });

  test('a failed requestSession resolves false, changes nothing, and a retry can still succeed', async () => {
    const app = createXRApp(env);
    app.startDemo();
    env.nav.xr = new FakeXRSystem({ requestError: new Error('NotAllowedError: the user denied the request') });
    assert.equal(await app.xr.enter(), false);
    assert.equal(app.xr.active, false);
    assert.equal(app.manager.setSessionCalls.length, 0);
    assert.deepEqual(app.view.argsOf('setXRScale'), []);
    assert.equal(app.world.scale.x, 1);
    assert.deepEqual(app.sessionChanges, []);
    app.xr.update(FRAME, {}, app.game); // not presenting: a no-op
    assert.ok(env.logs.errors.every((e) => e.includes('the user denied the request')), `only the cause is reported: ${env.logs.errors}`);
    env.clearLogs();

    env.nav.xr.requestError = null;
    assert.equal(await app.xr.enter(), true, 'not stuck in "entering"');
    assert.deepEqual(app.sessionChanges, [true]);
    assertQuiet();
  });

  test('a session that cannot be set up is ended again, and enter() resolves false', async () => {
    const app = createXRApp(env);
    app.startDemo();
    app.manager.setSessionError = new Error('InvalidStateError: no layers');
    assert.equal(await app.xr.enter(), false);
    assert.equal(env.nav.xr.lastSession.ended, true, 'no orphaned session left running');
    assert.equal(app.xr.active, false);
    assert.deepEqual(app.sessionChanges, []);
    assert.equal(app.world.scale.x, 1);
    assert.ok(env.logs.errors.every((e) => e.includes('no layers')), `only the cause is reported: ${env.logs.errors}`);
    env.clearLogs();
  });

  test('without WebXR, enter() resolves false', async () => {
    const app = createXRApp(env);
    env.nav.xr = undefined;
    assert.equal(await app.xr.enter(), false);
    assert.equal(app.xr.active, false);
    assert.deepEqual(app.sessionChanges, []);
    assert.deepEqual(env.logs.errors, [], 'missing WebXR is not an error');
    env.clearLogs();
    const bare = new XRMode(); // no renderer at all
    env.nav.xr = new FakeXRSystem();
    assert.equal(await bare.enter(), false);
    assert.equal(env.nav.xr.requests.length, 0);
    bare.update(FRAME, null, null);
    bare.dispose();
    assert.deepEqual(env.logs.errors, []);
    env.clearLogs();
  });

  test('without local-floor it uses a local space and still puts your eyes at standing height', async () => {
    env.nav.xr = new FakeXRSystem({ enabledFeatures: ['viewer', 'local'] });
    const app = createXRApp(env);
    app.startDemo();
    app.head.set(0.02, 0.01, -0.03); // 'local': the origin is where the head started
    await enterVR(app);
    assert.deepEqual(app.manager.referenceSpaceCalls, ['local']);
    const game = startVsCpu(app);
    const anchor = app.view.monkeyAnchor(0);
    const eye = headInScene(app).y - anchor.y;
    assert.equal(me(app), 0);
    assert.ok(eye > 1.3 && eye < 1.9, `eyes ${eye.toFixed(2)} m above your roof`);
    assert.equal(game.isDemo, false);
    assertQuiet();
  });

  test('session end (system menu) restores scale and local player and reports it; re-entering resumes', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    const game = startVsCpu(app);
    untilMyTurn(app);
    app.frame(FRAME, () => app.manager.fire(0, 'selectstart')); // holding the banana when the session ends
    assert.equal(app.xr.banana.held, true);

    await env.nav.xr.lastSession.end();
    assert.equal(app.xr.active, false);
    assert.deepEqual(app.sessionChanges, [true, false]);
    assert.equal(app.view.argsOf('setXRScale').at(-1), 1);
    assert.equal(app.world.scale.x, 1);
    assert.equal(me(app), null, 'local player cleared');
    for (const [name, obj] of [['menu', app.xr.menu.mesh], ['hud', app.xr.hud.mesh], ['banana', app.xr.banana.root],
      ['laser', app.xr.laser.group], ['arrow', app.xr.arrow.group]]) {
      assert.equal(obj.visible, false, `${name} hidden after the session`);
    }
    assert.equal(app.paused, false);
    app.run(20); // PC play goes on; XRMode does nothing without a session
    assert.deepEqual(app.throwCalls, [], 'the banana held at the end was not thrown');
    assert.equal(app.game, game);

    await enterVR(app);
    assert.deepEqual(app.sessionChanges, [true, false, true]);
    assert.equal(app.world.scale.x, VR_SCALE);
    assert.equal(me(app), 0, 'back on your roof in the same match');
    assert.equal(app.xr.hud.visible, true);
    assertQuiet();
  });

  test('"Exit VR" in the menu ends the session', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    clickButton(app, app.xr.menu, 'exit');
    await flush();
    assert.equal(app.xr.active, false);
    assert.equal(env.nav.xr.lastSession.ended, true);
    assert.deepEqual(app.sessionChanges, [true, false]);
    assert.equal(app.world.scale.x, 1);
    assertQuiet();
  });
});

describe('XRMode menu and rig', () => {
  test('the VR menu starts a vs-CPU match: you are player 0, on that roof, facing +x', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    const game = startVsCpu(app, 'hard');
    const players = app.started.at(-1).players;
    assert.equal(players[0].cpu, null, 'human is player 0');
    assert.equal(players[1].cpu, 'hard');
    assert.equal(game.isDemo, false);
    assert.equal(app.xr.menu.visible, false, 'menu closed');
    assert.equal(app.xr.hud.visible, true, 'match HUD shown');
    assert.equal(me(app), 0, 'your monkey is hidden: you are standing in it');

    const anchor = app.view.monkeyAnchor(0);
    const head = headInScene(app);
    assert.ok(Math.abs(app.xr.rig.position.y - anchor.y) < 1e-6, 'feet on the roof (local-floor)');
    assert.ok(Math.abs(head.x - anchor.x) < 0.5 && Math.abs(head.z - anchor.z) < 0.5, `head over your monkey (${head.x.toFixed(2)} vs ${anchor.x.toFixed(2)})`);
    const fwd = rigForward(app.xr.rig);
    assert.ok(fwd.x > 0.999, `facing +x toward the opponent (${fwd.toArray().map((v) => v.toFixed(3))})`);
    assert.ok(game.monkeys[1].x > game.monkeys[0].x);
    const hudTexts = app.xr.hud.canvas.texts;
    assert.ok(hudTexts.includes('You') && hudTexts.includes('CPU'), `HUD names (${hudTexts.join(' | ')})`);
    assert.ok(hudTexts.includes('Your turn!'), 'HUD says it is your turn');
    assertQuiet();
  });

  test('B toggles the menu (once per press); while it is open the match waits', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    startVsCpu(app);
    untilMyTurn(app);
    tap(app, 0, BUTTON.b, 4); // held for 4 frames: one toggle
    assert.equal(app.xr.menu.visible, true);
    assert.equal(app.xr.hud.visible, false);
    assert.equal(app.xr.banana.root.visible, false, 'no banana while the menu is open');
    assert.equal(app.paused, true, 'match paused through setPaused');
    const drawn = app.xr.menu.buttons.map((b) => b.id);
    assert.ok(drawn.includes('resume') && drawn.includes('quit'), `in-match menu (${drawn})`);
    const phase = app.game.phase;
    app.run(30);
    assert.equal(app.xr.menu.visible, true, 'stays open');
    assert.equal(app.game.phase, phase);

    tap(app, 1, BUTTON.b); // Y on the left controller closes it again
    assert.equal(app.xr.menu.visible, false);
    assert.equal(app.xr.hud.visible, true);
    assert.equal(app.paused, false);
    assert.deepEqual(app.pauses, [true, false]);
    app.frame();
    assert.equal(app.xr.banana.root.visible, true, 'the banana is back on your turn');
    assertQuiet();
  });

  test('the HUD Menu button opens the menu when clicked with the laser, without grabbing the banana', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    startVsCpu(app);
    untilMyTurn(app);
    assert.equal(app.xr.hud.visible, true);
    assert.equal(app.xr.laser.group.visible, false, 'mid-match the laser hides while not aiming at a button');
    pointAt(app, 0, buttonCenter(app.xr.hud, 'menu'));
    app.frame();
    assert.equal(app.xr.laser.group.visible, true, 'laser shows on the Menu button');
    click(app, 0);
    assert.equal(app.xr.menu.visible, true, 'menu opened');
    assert.equal(app.xr.hud.visible, false);
    assert.equal(app.xr.banana.held, false, 'the click did not grab the banana');
    assert.deepEqual(app.throwCalls, []);
    assert.equal(app.game.phase, 'aim');

    clickButton(app, app.xr.menu, 'resume');
    app.frame();
    assert.equal(app.xr.menu.visible, false);
    assert.equal(app.xr.hud.visible, true);
    assertQuiet();
  });

  test('hot seat: the rig fades to the other roof when the turn changes', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    clickButton(app, app.xr.menu, 'two-players');
    settle(app);
    const game = app.game;
    assert.deepEqual(app.started.at(-1).players.map((p) => p.cpu), [null, null]);
    untilMyTurn(app, 'player 0 turn');
    assert.equal(game.turn, 0);
    assert.equal(me(app), 0);
    assert.ok(rigForward(app.xr.rig).x > 0.999, 'player 0 faces +x');
    const round = game.round;

    assert.equal(game.throwShot(MISS), true);
    const samples = [];
    app.runUntil(() => game.turn === 1 && game.phase === 'aim' && me(app) === 1 && fade(app) === 0, {
      label: 'rig on player 1', maxSeconds: 20,
      each: () => samples.push({ opacity: fade(app), x: app.xr.rig.position.x, banana: app.xr.banana.root.visible }),
    });
    assert.equal(game.round, round, 'same round: a handover, not a new city');
    const moved = samples.findIndex((s, k) => k > 0 && s.x !== samples[k - 1].x);
    assert.ok(moved > 0, 'the rig moved');
    assert.equal(samples[moved].opacity, 1, 'moved while the view was black');
    assert.ok(samples.slice(0, moved).some((s) => s.opacity > 0 && s.opacity < 1), 'faded out first (no cut)');
    assert.ok(samples.slice(moved + 1).some((s) => s.opacity > 0 && s.opacity < 1), 'then faded back in');
    assert.equal(samples.slice(moved + 1).filter((s, k, a) => k > 0 && s.x !== a[k - 1].x).length, 0, 'moved once');
    assert.deepEqual(samples.filter((s) => s.opacity >= 0.05 && s.banana), [], 'no banana to grab while fading');

    const anchor = app.view.monkeyAnchor(1);
    const head = headInScene(app);
    assert.ok(Math.abs(app.xr.rig.position.y - anchor.y) < 1e-6, 'on player 1\'s roof');
    assert.ok(Math.abs(head.x - anchor.x) < 0.5, `head over player 1 (${head.x.toFixed(2)} vs ${anchor.x.toFixed(2)})`);
    assert.ok(rigForward(app.xr.rig).x < -0.999, 'player 1 faces -x');
    app.frame();
    assert.equal(app.xr.banana.root.visible, true, 'banana offered to player 1');

    // Forward for player 1 is -x: a forward swing must throw toward player 0.
    rest(app);
    const result = swing(app, 0, overhand(app));
    assertHandThrowToward(app, result, 1);
    assert.ok(result.calls[0].vx < 0);
    assertQuiet();
  });

  test('quitting to the title puts you back at the overview with the menu', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    startVsCpu(app);
    tap(app, 0, BUTTON.b);
    clickButton(app, app.xr.menu, 'quit');
    settle(app);
    assert.equal(app.game.isDemo, true);
    assert.equal(me(app), null);
    assert.equal(app.xr.menu.visible, true);
    assert.equal(app.xr.hud.visible, false);
    assert.ok(rigForward(app.xr.rig).z < -0.99);
    assertQuiet();
  });
});

describe('XRMode hand throw', () => {
  async function myTurnVsCpu(options) {
    const app = createXRApp(env, options);
    app.startDemo();
    await enterVR(app, options);
    startVsCpu(app);
    untilMyTurn(app);
    return app;
  }

  test('on your turn a banana floats over your dominant hand and sits in it while you hold the trigger', async () => {
    const app = await myTurnVsCpu();
    const banana = app.xr.banana.root;
    const grip = app.manager.getControllerGrip(0);
    assert.equal(banana.visible, true);
    assert.equal(isUnder(banana, grip), false, 'floating, not held');
    const bp = banana.getWorldPosition(new THREE.Vector3());
    const gp = grip.getWorldPosition(new THREE.Vector3());
    assert.ok(bp.y > gp.y && bp.distanceTo(gp) < 0.3, 'just above the right hand');
    assert.ok(app.view.bananas.some((b) => isUnder(b.mesh, banana)), 'the banana mesh comes from view.createBananaMesh()');

    app.frame(FRAME, () => app.manager.fire(0, 'selectstart'));
    assert.equal(isUnder(banana, grip), true, 'in the fist');
    assert.equal(banana.visible, true);
    assertQuiet();
  });

  test('an overhand swing (finite differences) throws toward the opponent with a sensible power', async () => {
    const app = await myTurnVsCpu();
    const result = swing(app, 0, overhand(app), { frames: 7 });
    assertHandThrowToward(app, result, 0);
    app.frame();
    assert.equal(app.xr.banana.root.visible, false, 'the banana left the hand');
    assertQuiet();
  });

  test('with XRPose.linearVelocity: scene m/s -> world units (/VR_SCALE), play plane only, times the boost', async () => {
    const app = await myTurnVsCpu();
    const v = new THREE.Vector3(0.8, 2.5, -4.5); // rig-local: a bit to the right, up, forward
    const from = new THREE.Vector3(app.head.x + 0.2, 1.6, app.head.z + 0.1);
    const result = swing(app, 0, steady(from, v), { frames: 7, measured: true, button: 'squeeze' });
    assert.equal(result.calls.length, 1);
    const { vx, vy } = result.calls[0];
    const boost = app.xr.throwBoost;
    assert.ok(Math.abs(vx - (4.5 / VR_SCALE) * boost) < 1e-6, `vx ${vx} = forward speed / VR_SCALE * boost`);
    assert.ok(Math.abs(vy - (2.5 / VR_SCALE) * boost) < 1e-6, `vy ${vy} = up speed / VR_SCALE * boost`);
    assert.equal(result.throws[0].payload.method, 'hand');
    assertQuiet();
  });

  test('a slow release is a drop: no throw, the banana returns, and you can throw again', async () => {
    const app = await myTurnVsCpu();
    const game = app.game;
    const from = new THREE.Vector3(app.head.x + 0.2, 1.3, app.head.z - 0.1);
    const slow = swing(app, 0, steady(from, new THREE.Vector3(0, 0.1, -0.3)), { frames: 7 });
    assert.deepEqual(slow.calls, [], 'throwVelocity not called');
    assert.deepEqual(slow.throws, []);
    assert.equal(game.phase, 'aim');
    assert.equal(game.turn, 0);
    app.frame();
    const banana = app.xr.banana.root;
    assert.equal(banana.visible, true, 'banana back over the hand');
    assert.equal(isUnder(banana, app.manager.getControllerGrip(0)), false, 'floating again');

    // Grab, hold still for two seconds, then swing: only the swing counts.
    rest(app, [0]);
    const still = new THREE.Vector3(app.head.x + 0.2, 1.75, app.head.z + 0.25);
    app.frame(FRAME, () => {
      app.manager.pose(0, { position: still, lookAt: still.clone().add(new THREE.Vector3(0, -0.6, -1)) });
      app.manager.fire(0, 'selectstart');
    });
    app.run(144);
    assert.equal(app.xr.banana.held, true);
    assert.deepEqual(app.throwCalls, []);
    app.manager.fire(0, 'selectend'); // let go without moving: another drop
    assert.deepEqual(app.throwCalls, []);
    const result = swing(app, 0, overhand(app));
    assertHandThrowToward(app, result, 0);
    assertQuiet();
  });

  test('no banana and no throw outside your turn', async () => {
    const app = await myTurnVsCpu();
    const game = app.game;
    assert.equal(game.throwShot(MISS), true); // your throw, then the CPU's turn
    app.runUntil(() => game.turn === 1 && game.phase === 'aim', { label: 'CPU turn' });
    app.frame();
    assert.equal(app.xr.banana.root.visible, false, 'no banana on the CPU turn');
    const result = swing(app, 0, overhand(app));
    assert.deepEqual(result.calls, [], 'cannot throw on the CPU turn');
    assert.equal(app.xr.hud.canvas.texts.some((t) => t.includes('thinking')), true, 'HUD shows the CPU thinking');
    assertQuiet();
  });
});

describe('XRMode stick mode', () => {
  test('the menu switches to stick mode; the thumbstick aims and the trigger throws', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    const game = startVsCpu(app);
    untilMyTurn(app);
    tap(app, 0, BUTTON.b);
    clickButton(app, app.xr.menu, 'throw-stick');
    assert.equal(app.prefs.vrThrow, 'stick', 'saved through setPrefs');
    assert.equal(app.xr.mode, 'stick');
    tap(app, 0, BUTTON.b);
    untilMyTurn(app);
    assert.equal(app.xr.arrow.group.visible, true, 'aim arrow shown');
    assert.equal(app.xr.banana.root.visible, false, 'no hand banana in stick mode');
    assert.ok(app.xr.hud.canvas.texts.some((t) => t.startsWith('Aim:')), 'HUD shows the aim');

    const pad = app.manager.slot(0).source.gamepad;
    const a0 = { ...game.aim[0] };
    pad.axes[STICK_Y] = -1; // pushed up
    app.run(36); // 0.5 s
    pad.axes[STICK_Y] = 0;
    const a1 = { ...game.aim[0] };
    assert.ok(a1.angle > a0.angle + 15 && a1.angle < a0.angle + 30, `up raises the angle (${a0.angle} -> ${a1.angle})`);
    assert.equal(a1.power, a0.power);
    pad.axes[STICK_X] = 1; // right
    app.run(36);
    pad.axes[STICK_X] = 0;
    const a2 = { ...game.aim[0] };
    assert.ok(a2.power > a1.power + 10 && a2.power <= MAX_POWER, `right adds power (${a1.power} -> ${a2.power})`);
    assert.equal(a2.angle, a1.angle);
    pad.axes[STICK_Y] = 1; // down
    app.run(18);
    pad.axes[STICK_Y] = 0.1; // inside the deadzone
    const a3 = { ...game.aim[0] };
    assert.ok(a3.angle < a2.angle, 'down lowers the angle');
    app.run(36);
    assert.deepEqual(game.aim[0], a3, 'deadzone: no drift');
    pad.axes[STICK_Y] = 0;

    const mark = app.events.length;
    click(app, 0); // trigger
    const throws = app.eventsOf('throw', mark);
    assert.equal(throws.length, 1, 'the trigger throws');
    assert.equal(throws[0].payload.method, 'aim');
    assert.equal(throws[0].payload.angle, a3.angle);
    assert.equal(throws[0].payload.power, a3.power);
    assert.deepEqual(app.throwCalls, [], 'not a hand throw');
    app.frame();
    assert.equal(app.xr.arrow.group.visible, false, 'arrow gone after the throw');

    // The CPU's turn: the stick does nothing.
    app.runUntil(() => game.turn === 1 && game.phase === 'aim', { label: 'CPU turn' });
    const cpuAim = { ...game.aim[1] };
    pad.axes[STICK_Y] = -1;
    app.run(10);
    pad.axes[STICK_Y] = 0;
    assert.deepEqual(game.aim[0], a3);
    assert.deepEqual(game.aim[1], cpuAim);
    assert.equal(app.xr.arrow.group.visible, false);
    assertQuiet();
  });

  test('A throws in stick mode too', async () => {
    const app = createXRApp(env, { prefs: { vrThrow: 'stick', lastSettings: null } });
    app.startDemo();
    await enterVR(app);
    startVsCpu(app);
    untilMyTurn(app);
    const mark = app.events.length;
    tap(app, 0, BUTTON.a);
    assert.equal(app.eventsOf('throw', mark).length, 1);
    assertQuiet();
  });

  test('with only tracked hands (no thumbsticks) stick mode falls back to hand throwing', async () => {
    const app = createXRApp(env, { prefs: { vrThrow: 'stick', lastSettings: null } });
    app.startDemo();
    await enterVR(app, { hands: true });
    assert.equal(app.xr.mode, 'hand');
    startVsCpu(app); // pinch on the menu
    untilMyTurn(app);
    assert.equal(app.xr.arrow.group.visible, false, 'no stick arrow');
    assert.equal(app.xr.banana.root.visible, true, 'banana offered to your hand');
    const result = swing(app, 0, overhand(app)); // pinch, swing, open
    assertHandThrowToward(app, result, 0);

    app.manager.connect(0, touchController('right')); // picks a controller back up
    assert.equal(app.xr.mode, 'stick');
    assertQuiet();
  });
});

describe('XRMode robustness', () => {
  test('update() and onEvent() never throw with a null, missing or unstarted game', async () => {
    const app = createXRApp(env); // no match at all
    app.xr.update(FRAME, {}, null);
    app.xr.onEvent('turn', { player: 0 }, null);
    app.xr.onEvent('impact', null, undefined);
    app.xr.setPrefs(null);
    app.xr.setGame(null);
    app.xr.exit();
    assert.equal(app.xr.active, false);

    await enterVR(app);
    for (const dt of [FRAME, 0, -1, NaN, Infinity, 5]) {
      app.xr.update(dt, null, null);
      app.xr.update(dt, undefined, undefined);
    }
    app.run(30);
    assert.equal(app.xr.menu.visible, true, 'no game: the menu');
    assert.equal(me(app), null);
    assert.ok(rigForward(app.xr.rig).z < -0.99, 'overview');
    tap(app, 0, BUTTON.b); // the menu stays usable
    tap(app, 0, BUTTON.a);
    swing(app, 0, overhand(app));

    // Events before setGame: XRMode adopts the game they come from.
    const unstarted = new Game({ seed: TEST_SEED, players: [{ name: 'You', cpu: null }, { name: 'CPU', cpu: 'easy' }] });
    for (let i = 0; i < 5; i++) app.xr.update(FRAME, null, unstarted); // no monkeys yet
    app.xr.onEvent('turn', { player: 0, cpu: null }, unstarted);
    unstarted.onAny((type, payload) => app.xr.onEvent(type, payload, unstarted));
    unstarted.start();
    for (const [type, payload] of [['impact', { kind: 'monkey', x: NaN }], ['monkeyFall', { player: 0, fromY: 'a', toY: null }],
      ['roundOver', { winner: 7 }], ['nonsense', undefined], ['throw', { player: 5 }]]) {
      app.xr.onEvent(type, payload, unstarted);
    }
    app.runUntil(() => me(app) === 0 && fade(app) === 0, { label: 'rig on the adopted game', maxSeconds: 5 });
    app.xr.update(FRAME, null, null); // keeps the adopted game
    assert.equal(me(app), 0);

    app.xr.setGame(null);
    settle(app);
    assert.equal(me(app), null, 'back to the overview');
    assert.equal(app.xr.menu.visible, true);
    unstarted.destroy();
    assertQuiet();
  });

  test('a whole CPU-vs-CPU match in VR runs clean: overview, HUD, no banana, bounded scene', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    const game = app.startMatch({
      players: [{ name: 'Bongo', cpu: 'hard' }, { name: 'Mango', cpu: 'hard' }], targetScore: 2, windStrength: 'normal',
    });
    settle(app);
    const spot = app.xr.rig.position.clone();
    const objects = countObjects(app.scene);
    const texts = new Set();
    const dt = 1 / 30;
    app.runUntil(() => game.phase === 'matchOver', {
      dt, maxSeconds: 900, label: 'matchOver',
      each: () => {
        assert.equal(me(app), null);
        assert.ok(app.xr.rig.position.equals(spot), 'the rig stays at the overview');
        assert.equal(app.xr.banana.root.visible, false);
        assert.equal(app.xr.arrow.group.visible, false);
        assert.equal(app.xr.menu.visible, false);
        assert.equal(app.xr.hud.visible, true);
        for (const t of app.xr.hud.canvas.texts) texts.add(t);
        assert.equal(countObjects(app.scene), objects, 'no objects pile up');
      },
    });
    app.run(3, dt);
    for (const t of app.xr.hud.canvas.texts) texts.add(t);
    const all = [...texts];
    assert.ok(all.includes('Bongo') && all.includes('Mango') && all.includes('ROUND 1'), 'names and round on the HUD');
    assert.ok(all.some((t) => t === 'Direct hit!' || t === 'Ouch, own goal!'), 'hit message shown');
    assert.ok(all.some((t) => t.endsWith('wins the round!')), 'round winner shown');
    assert.ok(all.some((t) => t.endsWith('wins the match!')), 'match winner shown');
    const ids = app.xr.hud.buttons.map((b) => b.id);
    assert.ok(ids.includes('rematch') && ids.includes('menu'), `match-over buttons (${ids})`);

    tap(app, 1, BUTTON.a); // X on the left controller: rematch
    assert.notEqual(app.game, game);
    assert.equal(app.game.isDemo, false);
    assert.deepEqual(app.game.settings.players, game.settings.players);
    app.run(30);
    assert.equal(app.xr.hud.visible, true);
    assert.equal(countObjects(app.scene), objects);
    assertQuiet();
  });

  test('the demo behind the VR menu plays whole matches and restarts, menu up throughout', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    const first = app.game;
    const objects = countObjects(app.scene);
    app.runUntil(() => app.game !== first && app.game.round >= 1, {
      dt: 1 / 30, maxSeconds: 900, label: 'demo restarted',
      each: () => {
        assert.equal(app.xr.menu.visible, true);
        assert.equal(app.xr.hud.visible, false);
        assert.equal(me(app), null);
        assert.equal(countObjects(app.scene), objects);
      },
    });
    assert.equal(app.events.filter((e) => e.game === first && e.type === 'matchOver').length, 1, 'the first demo match finished');
    assert.ok(app.events.filter((e) => e.game === first && e.type === 'roundOver').length >= 2, 'over several rounds');
    assert.equal(app.game.isDemo, true);
    assertQuiet();
  });

  test('dispose() ends the session and frees what XRMode made, not what the view owns', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    startVsCpu(app);
    untilMyTurn(app);
    pointAt(app, 0, buttonCenter(app.xr.hud, 'menu'));
    app.frame(); // laser on, banana floating, wrist panel on the left hand

    const xr = app.xr;
    const mine = collectResources([xr.rig, xr.arrow.group, xr.laser.group, xr.banana.root, xr.wrist.mesh]);
    // Glove geometry is one module-wide cache shared by every XRMode (bounded, never disposed).
    const other = new XRMode({ renderer: { xr: new FakeWebXRManager() }, scene: new THREE.Scene(), world: new THREE.Group() });
    const shared = [...collectResources([other.rig]).geometries].filter((g) => mine.geometries.has(g));
    const viewOwned = app.view.bananas.flatMap((b) => [b.geometry, b.material]);
    const disposed = new Set();
    const watch = (r) => r.addEventListener('dispose', () => disposed.add(r));
    for (const set of Object.values(mine)) set.forEach(watch);
    viewOwned.forEach(watch);
    assert.ok(mine.textures.size >= 3, 'panel textures found');

    xr.dispose();
    await flush();
    assert.equal(xr.active, false);
    assert.deepEqual(app.sessionChanges, [true, false]);
    assert.equal(app.world.scale.x, 1);
    assert.deepEqual(app.scene.children, [app.world], 'only the world is left in the scene');
    const leaked = (set, skip = []) => [...set].filter((r) => !disposed.has(r) && !skip.includes(r));
    assert.deepEqual(leaked(mine.materials).map((m) => m.type), [], 'materials disposed');
    assert.deepEqual(leaked(mine.textures).map((t) => t.type), [], 'textures disposed');
    assert.deepEqual(leaked(mine.geometries, [...shared, ...viewOwned]).map((g) => g.type), [], 'geometries disposed');
    assert.deepEqual(viewOwned.filter((r) => disposed.has(r)), [], 'the view\'s banana geometry/material left alone');
    app.run(5);
    xr.update(FRAME, {}, app.game);
    other.dispose();
    assertQuiet();
  });
});

describe('XRMode bow mode', () => {
  const BOW = { vrThrow: 'bow', lastSettings: null };
  async function myTurn(options = {}) {
    const app = createXRApp(env, { prefs: BOW, ...options });
    app.startDemo();
    await enterVR(app, options);
    startVsCpu(app);
    untilMyTurn(app);
    return app;
  }
  const ahead = (p) => p.clone().add(new THREE.Vector3(0, 0, -1));
  /** Hold the bow at `bowAt` and take the string at `stringAt` (rig-local), then hold the pull for `frames`. */
  function pull(app, { bowSlot = 1, stringSlot = 0, bowAt, stringAt, frames = 4, button = 'select' }) {
    app.manager.pose(bowSlot, { position: bowAt, lookAt: ahead(bowAt) });
    app.frame(FRAME, () => {
      app.manager.pose(stringSlot, { position: stringAt, lookAt: ahead(stringAt) });
      app.manager.fire(stringSlot, `${button}start`);
    });
    app.run(frames);
  }
  /** Let go of the string; returns the 'throw' events that caused. */
  function letGo(app, { stringSlot = 0, button = 'select' } = {}) {
    const mark = app.events.length;
    app.frame(FRAME, () => app.manager.fire(stringSlot, `${button}end`));
    return app.eventsOf('throw', mark);
  }
  /** Bow hand ahead and above, string hand back near the chest: 40 cm forward, 20 cm up, 20 cm across. */
  function stance(app) {
    return {
      bowAt: new THREE.Vector3(app.head.x - 0.1, 1.45, app.head.z - 0.55),
      stringAt: new THREE.Vector3(app.head.x + 0.1, 1.25, app.head.z - 0.15),
    };
  }

  test('the bow is the default; the menu switches to hand and back and saves it', async () => {
    const app = await myTurn();
    assert.equal(app.xr.mode, 'bow');
    tap(app, 0, BUTTON.b);
    assert.ok(app.xr.menu.buttons.some((b) => b.id === 'throw-bow'), 'Throw: Bow button');
    clickButton(app, app.xr.menu, 'throw-hand');
    assert.equal(app.prefs.vrThrow, 'hand');
    assert.equal(app.xr.mode, 'hand');
    clickButton(app, app.xr.menu, 'throw-bow');
    assert.equal(app.prefs.vrThrow, 'bow');
    assert.equal(app.xr.mode, 'bow');
    tap(app, 0, BUTTON.b);
    assertQuiet();
  });

  test('on your turn the bow waits in your off hand with the banana on the string', async () => {
    const app = await myTurn();
    const bow = app.xr.bow;
    assert.equal(bow.group.visible, true);
    assert.ok(isUnder(bow.group, app.xr.rig), 'a rig child, like the hands');
    const left = app.manager.getControllerGrip(1);
    assert.ok(bow.group.position.distanceTo(left.position) < 1e-6, 'at the left (off) hand');
    assert.equal(bow.nock.visible, true);
    assert.ok(isUnder(bow.banana.mesh, bow.nock), 'the banana rides on the string');
    assert.ok(app.view.bananas.some((b) => b.mesh === bow.banana.mesh), 'the bow got its banana from the view');
    assert.equal(app.xr.banana.root.visible, false, 'no hand-throw banana');
    assert.equal(app.xr.path.group.visible, false, 'no preview until you draw');
    assert.ok(app.xr.hud.canvas.texts.some((t) => /pull the banana back/.test(t)), 'the HUD explains the bow');
    assertQuiet();
  });

  test('pulling the string aims the shot (angle from the hands, power from the draw) with a path preview; letting go shoots', async () => {
    const app = await myTurn();
    const game = app.game;
    const { bowAt, stringAt } = stance(app);
    pull(app, { bowAt, stringAt });
    assert.ok(app.xr.draw, 'drawing');
    // Rig -z is toward the opponent: 0.4 forward and 0.2 up; the draw is the full distance between the hands.
    const expected = bowAim({ x: 0.4, y: 0.2 }, { x: 0, y: 0 }, bowAt.distanceTo(stringAt), 1);
    assert.ok(expected.angle > 24 && expected.angle < 29, `angle ${expected.angle}`);
    assert.ok(expected.power > 84 && expected.power < 92, `power ${expected.power}`);
    assert.deepEqual(game.aim[0], expected, 'the game aim follows the draw');
    assert.ok(app.xr.hud.canvas.texts.some((t) => t.startsWith('Aim:')), 'HUD shows the live aim');

    const bow = app.xr.bow;
    assert.equal(bow.drawing, true);
    assert.ok(bow.group.position.distanceTo(bowAt) < 1e-6, 'the bow is in the bow hand');
    const nock = bow.nock.getWorldPosition(new THREE.Vector3());
    const string = app.manager.getControllerGrip(0).getWorldPosition(new THREE.Vector3());
    assert.ok(nock.distanceTo(string) < 0.01, `the nock follows the string hand (${nock.distanceTo(string).toFixed(3)} m off)`);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(bow.group.quaternion);
    assert.ok(forward.angleTo(bowAt.clone().sub(stringAt)) < 1e-3, 'the bow points along the pull');

    const path = app.xr.path;
    assert.equal(path.group.visible, true, 'preview shown');
    // The preview ends where the banana would land: in this city that is the building in front of you.
    const points = game.previewPath(0, expected.angle, expected.power, 1.2);
    assert.equal(path.dots.count, Math.min(48, points.length - 1), 'one dot per preview point (up to 48)');
    assert.ok(path.dots.count >= 1);
    const first = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(path.dots.instanceMatrix.array, 0));
    const hand = game.handPosition(0);
    assert.ok(first.x > hand.x && first.x < hand.x + 6 && first.y > hand.y, `the preview leaves the hand toward the opponent (${first.x.toFixed(1)}, ${first.y.toFixed(1)})`);
    assert.ok(path.group.matrixWorld.equals(app.world.matrixWorld), 'drawn in world coordinates');

    const throws = letGo(app);
    assert.equal(throws.length, 1, 'one shot');
    const t = throws[0].payload;
    assert.equal(t.method, 'aim');
    assert.equal(t.player, 0);
    assert.equal(t.angle, expected.angle);
    assert.equal(t.power, expected.power);
    assert.deepEqual(app.throwCalls, [], 'not a velocity throw');
    assert.equal(game.phase, 'flight');
    assert.equal(app.xr.draw, null);
    app.frame();
    assert.equal(bow.group.visible, false, 'bow gone while the banana flies');
    assert.equal(path.group.visible, false);
    assertQuiet();
  });

  test('a slack string is let go without a shot; the bow stays and a real draw follows', async () => {
    const app = await myTurn();
    const game = app.game;
    const { bowAt, stringAt } = stance(app);
    const close = bowAt.clone().add(new THREE.Vector3(0.04, -0.04, 0.08)); // 10 cm apart
    pull(app, { bowAt, stringAt: close });
    assert.ok(app.xr.draw, 'the string is taken');
    assert.ok(game.aim[0].power < BOW_MIN_POWER, `power ${game.aim[0].power}`);
    assert.equal(app.xr.path.group.visible, false, 'no preview: letting go would not shoot');
    assert.deepEqual(letGo(app), [], 'no shot');
    assert.equal(game.phase, 'aim');
    assert.equal(game.turn, 0);
    app.frame();
    assert.equal(app.xr.bow.group.visible, true, 'the bow is still offered');
    assert.equal(app.xr.bow.drawing, false);
    pull(app, { bowAt, stringAt, button: 'squeeze' }); // the grip works too
    assert.equal(letGo(app, { button: 'squeeze' }).length, 1, 'the grip shoots as well');
    assertQuiet();
  });

  test('with tracked hands, a pinch of either hand takes the string and the other hand holds the bow', async () => {
    const app = await myTurn({ hands: true });
    assert.equal(app.xr.mode, 'bow');
    const bowAt = new THREE.Vector3(app.head.x + 0.15, 1.45, app.head.z - 0.55);
    const stringAt = new THREE.Vector3(app.head.x - 0.1, 1.2, app.head.z - 0.1);
    pull(app, { bowSlot: 0, stringSlot: 1, bowAt, stringAt }); // left hand pinches
    assert.equal(app.xr.draw?.hand, app.xr.hands[1]);
    assert.equal(app.xr.draw?.bowHand, app.xr.hands[0]);
    assert.ok(app.xr.bow.group.position.distanceTo(bowAt) < 1e-6, 'the bow moved to the right hand');
    const throws = letGo(app, { stringSlot: 1 });
    assert.equal(throws.length, 1);
    assert.equal(throws[0].payload.method, 'aim');
    assert.equal(app.xr.dominant, 'left', 'the pinching hand throws from now on');
    assertQuiet();
  });

  test('the bow goes away with the menu and on the CPU turn, when pulling does nothing', async () => {
    const app = await myTurn();
    const game = app.game;
    tap(app, 0, BUTTON.b);
    assert.equal(app.xr.menu.visible, true);
    assert.equal(app.xr.bow.group.visible, false, 'no bow behind the menu');
    tap(app, 0, BUTTON.b);
    app.frame();
    assert.equal(app.xr.bow.group.visible, true);

    assert.equal(game.throwShot(MISS), true);
    app.runUntil(() => game.turn === 1 && game.phase === 'aim', { label: 'CPU turn' });
    app.frame();
    assert.equal(app.xr.bow.group.visible, false, 'no bow on the CPU turn');
    const { bowAt, stringAt } = stance(app);
    pull(app, { bowAt, stringAt });
    assert.equal(app.xr.draw, null);
    assert.deepEqual(letGo(app), []);
    assert.equal(game.turn, 1);
    assertQuiet();
  });
});

describe('XRMode throw boost', () => {
  test('the menu Throw boost buttons save prefs.vrBoost and change the hand-throw multiplier', async () => {
    const app = createXRApp(env);
    app.startDemo();
    await enterVR(app);
    assert.equal(app.xr.throwBoost, THROW_BOOST, 'Normal by default');
    clickButton(app, app.xr.menu, 'boost-high');
    assert.equal(app.prefs.vrBoost, 'high', 'saved through setPrefs');
    assert.equal(app.xr.throwBoost, THROW_BOOSTS.high);
    clickButton(app, app.xr.menu, 'boost-low');
    assert.equal(app.prefs.vrBoost, 'low');
    assert.equal(app.xr.throwBoost, THROW_BOOSTS.low);
    assert.ok(THROW_BOOSTS.low < THROW_BOOSTS.normal && THROW_BOOSTS.normal < THROW_BOOSTS.high);
    app.xr.setPrefs({ ...app.prefs, vrBoost: 'bogus' });
    assert.equal(app.xr.throwBoost, THROW_BOOST, 'unknown values fall back to Normal');
    assertQuiet();
  });
});
