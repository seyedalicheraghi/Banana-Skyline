// UI (src/ui/ui.js) driven through a fake DOM (tests/support/ui-fake-dom.mjs) with a real core Game, wired
// the way src/app/main.js wires them. Contract: docs/DESIGN.md, section "UI".
// Everything runs on simulated time with fixed seeds; the DOM is inspected by role, label and text, plus
// the class names ui.css styles.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseShot } from '../src/core/ai.js';
import { GRAVITY_PRESETS, MAX_POWER, MAX_WIND, PLAYER_COLORS } from '../src/core/constants.js';
import { DEFAULT_SETTINGS, Game, normalizeSettings } from '../src/core/game.js';
import { createRng } from '../src/core/rng.js';
import { DRAG_FULL_POWER, DRAG_MIN } from '../src/ui/settings.js';
import { UI } from '../src/ui/ui.js';
import {
  FakeEvent, accessibleName, choose, click, installFakeDom, notClickable, pointer, pressKey, typeInto, visibleText,
} from './support/ui-fake-dom.mjs';

const WIDTH = 1280;
const HEIGHT = 720;
// The canvas sits away from the window corner so client px and canvas px differ (screenToWorld takes canvas px).
const CANVAS_RECT = { left: 24, top: 16, width: 1232, height: 688 };
const AIM_PANEL_RECT = { left: 340, top: HEIGHT - 150, width: 600, height: 130 };
const PX_PER_M = 7;
const ORIGIN = { x: 112, y: 640 }; // canvas px of world (0, 0)
const worldToCanvas = (x, y) => ({ x: ORIGIN.x + x * PX_PER_M, y: ORIGIN.y - y * PX_PER_M });
const canvasToWorld = (px, py) => ({ x: (px - ORIGIN.x) / PX_PER_M, y: (ORIGIN.y - py) / PX_PER_M });
const clientAt = (x, y) => {
  const c = worldToCanvas(x, y);
  return { x: c.x + CANVAS_RECT.left, y: c.y + CANVAS_RECT.top };
};

const DEMO = {
  demo: true,
  players: [{ name: 'Bongo', cpu: 'normal' }, { name: 'Mango', cpu: 'normal' }],
  targetScore: 20,
  windStrength: 'normal',
};
const PREFS = { theme: 'night', sound: true, volume: 0.8, assist: 'arrow', vrThrow: 'hand', lastSettings: null };
const SETTINGS_KEYS = Object.keys(DEFAULT_SETTINGS);
const LAYERS = {
  'bs-title-screen': 'title', 'bs-setup-layer': 'setup', 'bs-howto-layer': 'howto',
  'bs-pause-layer': 'pause', 'bs-matchover-layer': 'matchOver',
};

let env;
const consoleLog = [];
let restoreConsole = null;
// The core spends a wall-clock budget per frame planning CPU shots (performance.now). A clock that only moves
// with simulated frames makes every plan finish inside one frame, so frame counts do not depend on the machine.
let simMs = 0;
let restoreClock = null;

before(() => {
  env = installFakeDom({ width: WIDTH, height: HEIGHT });
  const saved = { error: console.error, warn: console.warn };
  console.error = (...args) => consoleLog.push({ level: 'error', args });
  console.warn = (...args) => consoleLog.push({ level: 'warn', args });
  restoreConsole = () => Object.assign(console, saved);
  const perf = globalThis.performance;
  const own = Object.getOwnPropertyDescriptor(perf, 'now');
  Object.defineProperty(perf, 'now', { value: () => simMs, configurable: true, writable: true });
  restoreClock = () => {
    if (own) Object.defineProperty(perf, 'now', own);
    else delete perf.now;
  };
});

after(() => {
  restoreClock?.();
  restoreConsole?.();
  env?.restore();
});

const fmt = (e) => `${e.level}: ${e.args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}`;

/** The pieces of src/app/main.js the UI talks to, with recorded callbacks. */
function createApp(t, { seed = 1, callbacks: overrides = {}, withCallbacks = true, prefs = PREFS } = {}) {
  const doc = env.document;
  const root = doc.createElement('div');
  root.id = 'ui';
  const canvas = doc.createElement('canvas');
  doc.body.append(canvas, root);
  env.setRect(canvas, CANVAS_RECT);
  const app = {
    doc, root, canvas, game: null, paused: false, calls: [], events: [], inset: 0,
    consoleFrom: consoleLog.length, listenerFrom: env.listenerErrors.length,
  };
  const record = (name, ...args) => app.calls.push({ name, args });
  app.callsOf = (name) => app.calls.filter((c) => c.name === name).map((c) => c.args);

  app.start = (settings) => {
    app.game?.destroy();
    app.paused = false;
    const game = new Game({ ...settings, seed: settings?.seed ?? seed });
    app.game = game;
    game.onAny((type, payload) => {
      app.events.push({ type, payload, game });
      app.ui.onEvent(type, payload, game);
    });
    app.ui.setGame(game);
    game.start();
    return game;
  };
  app.startDemo = () => {
    app.start(DEMO);
    app.ui.showTitle();
  };

  const callbacks = {
    startMatch: (s) => { record('startMatch', s); app.start(s); },
    quitToTitle: () => { record('quitToTitle'); app.startDemo(); },
    setPaused: (v) => { record('setPaused', v); app.paused = Boolean(v); },
    enterVR: () => { record('enterVR'); },
    prefsChanged: (p) => { record('prefsChanged', p); app.ui.setPrefs(p); },
    toggleFollow: () => record('toggleFollow'),
    worldToScreen: (x, y) => worldToCanvas(x, y),
    screenToWorld: (px, py) => canvasToWorld(px, py),
    unlockAudio: () => record('unlockAudio'),
    ...overrides,
  };
  app.ui = withCallbacks ? new UI({ root, canvas, callbacks }) : new UI({ root, canvas });
  app.ui.setPrefs(prefs);
  const panel = root.querySelector('.bs-aim');
  if (panel) env.setRect(panel, AIM_PANEL_RECT); // layout for when it is shown (hidden elements measure 0)

  // One animation frame, in main.js order.
  app.frame = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) {
      simMs += dt * 1000;
      if (app.game && !app.paused) app.game.update(dt);
      if (app.game?.isDemo && app.game.phase === 'matchOver') app.startDemo();
      app.inset = app.ui.bottomInset;
      app.ui.update(dt, app.game);
    }
  };
  app.runUntil = (pred, { seconds = 120, dt = 1 / 60, label = 'condition', each = null } = {}) => {
    for (let i = 0; i < seconds / dt && !pred(); i++) {
      app.frame(1, dt);
      each?.();
    }
    assert.ok(pred(), `timed out after ${seconds}s of game time waiting for ${label}`);
  };
  app.throws = () => app.events.filter((e) => e.type === 'throw' && e.game === app.game).map((e) => e.payload);

  app.key = (key, opts) => pressKey(doc, key, opts);
  app.q = (sel) => root.querySelector(sel);
  app.buttons = (name) => root.querySelectorAll('button').filter((b) => b._rendered && accessibleName(b) === name);
  app.button = (name) => {
    const found = app.buttons(name);
    assert.equal(found.length, 1, `exactly one visible "${name}" button (screen: ${app.screen()})`);
    return found[0];
  };
  app.press = (name) => click(app.button(name));
  app.control = (label) => {
    const found = root.querySelectorAll('input').filter((i) => i.getAttribute('aria-label') === label);
    assert.equal(found.length, 1, `one "${label}" control`);
    return found[0];
  };
  app.field = (labelText) => {
    const label = root.querySelectorAll('label').find((l) => l._rendered && l.getAttribute('for') && visibleText(l).startsWith(labelText));
    assert.ok(label, `visible field labelled "${labelText}"`);
    return root.querySelector(`#${label.getAttribute('for')}`);
  };
  app.radio = (legend, value) => {
    const set = root.querySelectorAll('fieldset').find((f) => f._rendered && f.querySelector('legend')?.textContent === legend);
    assert.ok(set, `visible choice "${legend}"`);
    const input = set.querySelector(`input[type=radio][value="${value}"]`);
    assert.ok(input, `"${legend}" has option ${value}`);
    return input;
  };
  /** Which full-screen layer is showing: 'title' | 'setup' | 'howto' | 'pause' | 'matchOver' | null. */
  app.screen = () => {
    const shown = root.querySelectorAll('.bs-layer').filter((l) => l._rendered);
    assert.ok(shown.length <= 1, `at most one layer visible, got ${shown.length}`);
    if (!shown.length) return null;
    return Object.entries(LAYERS).find(([cls]) => shown[0].classList.contains(cls))?.[1] ?? 'unknown';
  };
  app.hud = () => app.q('.bs-hud');
  app.hudVisible = () => app.hud()._rendered;
  app.aimPanelVisible = () => app.q('.bs-aim')._rendered;
  app.banner = () => visibleText(app.q('.bs-banner'));
  app.toasts = () => app.q('.bs-toasts').querySelectorAll('.bs-toast-text').map((n) => visibleText(n));
  app.nameFields = () => root.querySelectorAll('.bs-names label').filter((l) => l._rendered).map((l) => visibleText(l));
  app.overlayHidden = () => !app.root.querySelector('.bs-ui')?._rendered;

  app.assertClean = ({ warnings = 0 } = {}) => {
    const logged = consoleLog.slice(app.consoleFrom);
    assert.deepEqual(logged.filter((e) => e.level === 'error').map(fmt), [], 'console.error during the test');
    assert.equal(logged.filter((e) => e.level === 'warn').length, warnings, logged.map(fmt).join('\n'));
    assert.deepEqual(env.listenerErrors.slice(app.listenerFrom).map(String), [], 'exceptions in event listeners');
  };
  app.dispose = () => {
    app.ui.dispose();
    app.game?.destroy();
    root.remove();
    canvas.remove();
  };
  t.after(() => app.dispose());
  return app;
}

/** Start a real match the way main.js does after the setup screen (app.start = main's startMatch). */
function startReal(app, settings) {
  app.start(settings);
  app.frame(1);
  return app.game;
}

const aimOf = (app) => ({ ...app.game.aim[app.game.turn] });

/** Settings as callbacks.startMatch must send them: normalizeSettings keeps every value as it is. */
function assertNormalizedShape(settings) {
  assert.equal(typeof settings, 'object');
  for (const k of Object.keys(settings)) assert.ok(SETTINGS_KEYS.includes(k), `unknown settings key "${k}"`);
  assert.ok(!settings.demo, 'a match from the menus is not a demo');
  const n = normalizeSettings(settings);
  for (const k of ['players', 'targetScore', 'gravity', 'windStrength']) {
    assert.deepEqual(settings[k], n[k], `settings.${k} survives normalizeSettings unchanged`);
  }
}

// ------------------------------------------------------------------ input helpers (what a player does)

function aimWithKeys(app, angle, power) {
  const g = app.game;
  const p = g.turn;
  for (let guard = 0; g.aim[p].angle !== angle; guard++) {
    assert.ok(guard < 200, 'angle reached');
    const before = g.aim[p].angle;
    const diff = angle - before;
    const big = Math.abs(diff) >= 5;
    app.key(diff > 0 ? 'ArrowRight' : 'ArrowLeft', { shift: big });
    assert.equal(g.aim[p].angle, before + Math.sign(diff) * (big ? 5 : 1));
  }
  for (let guard = 0; g.aim[p].power !== power; guard++) {
    assert.ok(guard < 200, 'power reached');
    const before = g.aim[p].power;
    const diff = power - before;
    const big = Math.abs(diff) >= 5;
    app.key(diff > 0 ? 'ArrowUp' : 'ArrowDown', { shift: big });
    assert.equal(g.aim[p].power, before + Math.sign(diff) * (big ? 5 : 1));
  }
}

function throwTyped(app, angle, power) {
  const angleBox = app.control('Angle in degrees');
  const powerBox = app.control('Power');
  typeInto(angleBox, String(angle));
  app.key('Enter');
  assert.ok(app.doc.activeElement === powerBox, 'Enter in the angle box moves to the power box');
  typeInto(powerBox, String(power));
  app.key('Enter');
}

/** Press on the monkey, drag to where the throw should go, release. */
function dragTo(app, angle, power, { release = true } = {}) {
  const g = app.game;
  const m = g.monkeys[g.turn];
  const hand = g.handPosition(g.turn);
  const dist = (power * DRAG_FULL_POWER) / MAX_POWER;
  const rad = (angle * Math.PI) / 180;
  const to = clientAt(hand.x + Math.cos(rad) * dist * m.facing, hand.y + Math.sin(rad) * dist);
  pointer(app.canvas, 'pointerdown', { ...clientAt(m.x, m.y + 2), buttons: 1 });
  pointer(app.canvas, 'pointermove', { ...to, buttons: 1 });
  if (release) pointer(app.canvas, 'pointerup', { ...to, buttons: 0 });
  return to;
}

// ------------------------------------------------------------------ tests

describe('UI without a game', () => {
  test('public methods are safe before any game exists and with a null game', (t) => {
    const app = createApp(t);
    const { ui } = app;
    assert.equal(ui.menuOpen, false);
    assert.equal(ui.bottomInset, 0);
    ui.update(1 / 60);
    ui.update(1 / 60, null);
    ui.update(Number.NaN, undefined);
    ui.onEvent('turn', { player: 0 }, null);
    ui.onEvent('roundStart', undefined);
    ui.onEvent('matchOver', null, undefined);
    ui.onEvent(undefined);
    ui.setGame(null);
    ui.setGame(undefined);
    ui.refresh();
    ui.setPrefs(null);
    ui.setPrefs(undefined);
    ui.setVRSupported(undefined);
    ui.setXRActive(true);
    ui.setXRActive(false);
    assert.equal(app.hudVisible(), false, 'no HUD without a match');
    assert.equal(app.screen(), null);
    for (const key of ['Escape', ' ', 'Enter', 'ArrowRight', 'ArrowUp', 'p', 'c']) app.key(key);
    pointer(app.canvas, 'pointerdown', { ...clientAt(10, 20), buttons: 1 });
    pointer(app.canvas, 'pointermove', { ...clientAt(30, 40), buttons: 1 });
    pointer(app.canvas, 'pointerup', { ...clientAt(30, 40) });
    assert.deepEqual(app.callsOf('setPaused'), [], 'Esc without a match does not pause');
    assert.deepEqual(app.callsOf('toggleFollow'), [], 'C only works in a match');
    assert.deepEqual(app.callsOf('startMatch'), []);
    assert.equal(ui.bottomInset, 0);

    ui.showTitle();
    assert.equal(app.screen(), 'title');
    assert.equal(ui.menuOpen, true);
    app.frame(5);
    app.assertClean();
  });

  test('works without any callbacks', (t) => {
    const app = createApp(t, { withCallbacks: false });
    app.start(DEMO);
    app.ui.showTitle();
    app.frame(10);
    app.key('m');
    app.press('1 Player vs CPU');
    app.press('Start!'); // nobody listens: no match starts, nothing breaks
    app.frame(1);
    assert.equal(app.game.isDemo, true);
    assert.equal(app.screen(), 'title', 'still on the title over the demo');
    startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    dragTo(app, 45, 40); // no screenToWorld: a drag cannot aim, but must not break either
    assert.equal(app.throws().length, 0);
    app.key('Escape');
    app.press('Resume');
    app.key(' ');
    assert.equal(app.throws().length, 1, 'keyboard still throws');
    app.frame(30);
    app.assertClean();
  });

  test('events that arrive before setGame adopt their game', (t) => {
    const app = createApp(t);
    const demo = new Game({ ...DEMO, seed: 5 });
    demo.onAny((type, p) => app.ui.onEvent(type, p, demo));
    demo.start(); // no setGame: the UI learns about the game from its events
    assert.equal(app.screen(), 'title', 'a demo game brings up the title');
    assert.equal(app.hudVisible(), false);
    assert.deepEqual(app.toasts(), [], 'demo events are ignored');

    const real = new Game({ players: [{ name: 'Ann' }, { name: 'Bob', cpu: 'easy' }], seed: 6 });
    real.onAny((type, p) => app.ui.onEvent(type, p, real));
    real.start();
    assert.equal(app.screen(), null, 'a real match closes the menus');
    assert.equal(app.hudVisible(), true);
    assert.equal(visibleText(app.q('.bs-player-0 .bs-player-name')), 'Ann');
    assert.equal(visibleText(app.q('.bs-player-1 .bs-player-name')), 'Bob');
    assert.equal(app.banner(), "Ann's turn");
    assert.ok(app.toasts().some((s) => s.startsWith('Round 1')), app.toasts().join(' | '));
    demo.destroy();
    real.destroy();
    app.assertClean();
  });

  test('unlockAudio is called on the first user gesture', (t) => {
    const app = createApp(t);
    app.startDemo();
    app.frame(3);
    assert.deepEqual(app.callsOf('unlockAudio'), [], 'not before a gesture');
    app.key('ArrowDown'); // any key on the title screen
    assert.ok(app.callsOf('unlockAudio').length >= 1, 'called during the first keydown');
    const n = app.callsOf('unlockAudio').length;
    for (let i = 0; i < 3; i++) app.key('ArrowDown');
    click(app.button('2 Players'));
    assert.ok(app.callsOf('unlockAudio').length <= n + 2, 'not called on every later gesture');
    app.assertClean();
  });
});

describe('title screen and match setup', () => {
  test('the demo match plays behind the title: menu visible, HUD hidden, demo events ignored', (t) => {
    const app = createApp(t);
    app.startDemo();
    assert.equal(app.screen(), 'title');
    assert.equal(app.ui.menuOpen, true);
    const text = visibleText(app.q('.bs-title-screen'));
    for (const s of ['Banana', 'Skyline']) assert.ok(text.includes(s), text);
    for (const name of ['1 Player vs CPU', '2 Players', 'Settings', 'How to play']) app.button(name);
    assert.equal(app.buttons('Play in VR').length, 0, 'no VR button until VR is supported');
    app.ui.setVRSupported(true);
    app.button('Play in VR');
    app.ui.setVRSupported(false);
    assert.equal(app.buttons('Play in VR').length, 0);

    app.runUntil(() => app.events.some((e) => e.type === 'impact'), { seconds: 60, label: 'a demo throw', each: () => {
      assert.equal(app.hudVisible(), false, 'HUD hidden during the demo');
      assert.equal(app.aimPanelVisible(), false);
      assert.equal(app.inset, 0, 'bottomInset is 0 for a demo');
    } });
    assert.deepEqual(app.toasts(), [], 'no toasts for demo events');
    assert.equal(app.screen(), 'title');
    app.runUntil(() => app.game.phase === 'aim', { seconds: 10, label: 'a demo turn' });
    const aims = app.game.aim.map((a) => ({ ...a }));
    const throws = app.throws().length;
    app.doc.activeElement.blur();
    for (const key of ['Escape', 'p', ' ', 'Enter', 'ArrowRight', 'ArrowUp']) app.key(key);
    dragTo(app, 30, 30);
    assert.equal(app.screen(), 'title', 'title has no "back" and cannot be paused');
    assert.deepEqual(app.callsOf('setPaused'), []);
    assert.deepEqual(app.game.aim, aims, 'no aiming for demo monkeys');
    assert.equal(app.throws().length, throws, 'no throws for demo monkeys');
    app.assertClean();
  });

  test('1 Player vs CPU: Start! sends settings shaped for normalizeSettings and starts a real match', (t) => {
    const app = createApp(t);
    app.startDemo();
    app.frame(2);
    app.press('1 Player vs CPU');
    assert.equal(app.screen(), 'setup');
    assert.equal(app.ui.menuOpen, true);
    assert.equal(app.game.isDemo, true, 'the demo keeps playing behind the setup');
    const nameBox = app.field('Your name');
    assert.equal(notClickable(nameBox), null);
    assert.deepEqual(app.nameFields(), ['Your name'], 'one name field vs CPU');
    choose(app.radio('CPU difficulty', 'hard'));
    choose(app.radio('Points to win', '5'));
    choose(app.radio('Gravity (m/s²)', 'moon'));
    choose(app.radio('Wind', 'calm'));
    typeInto(nameBox, '  Ali  ');
    app.key('m'); // typing in a text field: M is a letter, not "mute"
    assert.deepEqual(app.callsOf('prefsChanged'), []);
    // main.js restarts the demo (and calls showTitle) when the demo match ends: the setup stays open.
    app.startDemo();
    app.frame(2);
    assert.equal(app.screen(), 'setup', 'a demo restart does not close the setup');
    assert.equal(app.field('Your name').value, '  Ali  ');
    app.press('Start!');

    const starts = app.callsOf('startMatch');
    assert.equal(starts.length, 1);
    const [settings] = starts[0];
    assert.deepEqual(settings, {
      players: [{ name: 'Ali', cpu: null }, { name: 'Hard CPU', cpu: 'hard' }],
      targetScore: 5,
      gravity: GRAVITY_PRESETS.moon,
      windStrength: 'calm',
    });
    assertNormalizedShape(settings);
    assert.equal(app.screen(), null, 'menus close for the match');
    assert.equal(app.ui.menuOpen, false);
    assert.equal(app.game.isDemo, false);
    assert.deepEqual(app.callsOf('setPaused'), [], 'starting from the title never pauses');
    app.frame(1);
    assert.equal(app.hudVisible(), true);
    assert.equal(visibleText(app.q('.bs-player-0 .bs-player-name')), 'Ali');
    assert.equal(visibleText(app.q('.bs-player-1 .bs-player-name')), 'Hard CPU');
    app.assertClean();
  });

  test('2 Players with custom gravity: blank names fall back to Player 1 / Player 2', (t) => {
    const app = createApp(t);
    app.startDemo();
    app.press('2 Players');
    assert.equal(app.screen(), 'setup');
    assert.deepEqual(app.nameFields(), ['Player 1', 'Player 2']);
    assert.ok(!visibleText(app.q('.bs-setup-layer')).includes('CPU difficulty'), 'no CPU difficulty for 2 players');
    choose(app.radio('Gravity (m/s²)', 'custom'));
    typeInto(app.field('Custom gravity'), '4.2');
    choose(app.radio('Wind', 'wild'));
    choose(app.radio('Points to win', '1'));
    app.press('Start!');
    const [[settings]] = app.callsOf('startMatch');
    assert.deepEqual(settings, {
      players: [{ name: 'Player 1', cpu: null }, { name: 'Player 2', cpu: null }],
      targetScore: 1,
      gravity: 4.2,
      windStrength: 'wild',
    });
    assertNormalizedShape(settings);
    assert.equal(app.game.gravity, 4.2);
    app.assertClean();
  });

  test('custom gravity is kept within what the core accepts', (t) => {
    const app = createApp(t);
    app.startDemo();
    for (const [typed, expected] of [['99', 40], ['0.1', 0.5], ['12.5', 12.5]]) {
      app.press('2 Players');
      choose(app.radio('Gravity (m/s²)', 'custom'));
      typeInto(app.field('Custom gravity'), typed);
      app.press('Start!');
      const [settings] = app.callsOf('startMatch').at(-1);
      assert.equal(settings.gravity, expected, `typed ${typed}`);
      assertNormalizedShape(settings);
      app.key('Escape');
      app.press('Quit to title');
      assert.equal(app.screen(), 'title');
    }
    app.assertClean();
  });

  test('setup starts from prefs.lastSettings; options go out through prefsChanged right away', (t) => {
    const last = {
      players: [{ name: 'Ali', cpu: null }, { name: 'Hard CPU', cpu: 'hard' }],
      targetScore: 5, gravity: GRAVITY_PRESETS.mars, windStrength: 'wild',
    };
    const app = createApp(t, { prefs: { ...PREFS, lastSettings: last } });
    app.startDemo();
    app.press('Settings');
    assert.equal(app.screen(), 'setup');
    assert.equal(app.field('Your name').value, 'Ali');
    for (const [legend, value] of [['CPU difficulty', 'hard'], ['Points to win', '5'], ['Gravity (m/s²)', 'mars'], ['Wind', 'wild']]) {
      assert.equal(app.radio(legend, value).checked, true, `${legend} = ${value}`);
    }
    const lastPrefs = () => app.callsOf('prefsChanged').at(-1)?.[0];
    choose(app.radio('Look', 'classic'));
    assert.equal(lastPrefs().theme, 'classic');
    choose(app.radio('Aim helper', 'preview'));
    assert.equal(lastPrefs().assist, 'preview');
    const sound = app.root.querySelectorAll('label.bs-switch').find((l) => visibleText(l) === 'Sound').querySelector('input');
    const volume = app.control('Volume');
    choose(sound);
    assert.equal(lastPrefs().sound, false);
    assert.equal(volume.disabled, true, 'no volume while muted');
    choose(sound);
    assert.equal(lastPrefs().sound, true);
    volume.focus();
    app.key('ArrowLeft');
    assert.equal(lastPrefs().volume, 0.79, 'the volume slider moves by 1%');
    assert.equal(app.screen(), 'setup', 'arrows on the slider do not leave the panel');
    assert.equal(lastPrefs().theme, 'classic', 'every change carries the earlier ones');
    for (const [p] of app.callsOf('prefsChanged')) assert.deepEqual(p.lastSettings, last);

    app.press('Start!');
    const [[settings]] = app.callsOf('startMatch');
    assert.deepEqual(settings, last, 'the form came from lastSettings');
    app.frame(1);
    app.key('m');
    assert.equal(lastPrefs().sound, false, 'M mutes');
    assert.deepEqual(lastPrefs().lastSettings, settings, 'prefsChanged carries the match just started');
    assert.ok(app.toasts().includes('Sound off'));
    app.assertClean();
  });

  test('Back, Escape and How to play return to the title without starting a match', (t) => {
    const app = createApp(t);
    app.startDemo();
    app.press('1 Player vs CPU');
    app.press('Back');
    assert.equal(app.screen(), 'title');
    app.press('Settings');
    assert.equal(app.screen(), 'setup');
    app.key('Escape');
    assert.equal(app.screen(), 'title');
    app.press('How to play');
    assert.equal(app.screen(), 'howto');
    assert.ok(visibleText(app.q('.bs-howto-layer')).includes('Space'), 'how-to mentions the keys');
    app.press('Got it!');
    assert.equal(app.screen(), 'title');
    app.key('Escape');
    assert.equal(app.screen(), 'title');
    assert.deepEqual(app.callsOf('startMatch'), []);
    assert.deepEqual(app.callsOf('setPaused'), []);
    app.assertClean();
  });
});

describe('HUD', () => {
  test('shows names, scores, round and wind for a real match and follows the score', (t) => {
    const app = createApp(t, { seed: 21 });
    const g = startReal(app, { players: [{ name: 'Ali' }, { name: 'Robo', cpu: 'hard' }], targetScore: 3, windStrength: 'normal' });
    assert.equal(app.hudVisible(), true);
    assert.equal(visibleText(app.q('.bs-player-0 .bs-player-name')), 'Ali');
    assert.equal(visibleText(app.q('.bs-player-1 .bs-player-name')), 'Robo');
    assert.equal(visibleText(app.q('.bs-player-0 .bs-player-score')), '0');
    assert.equal(visibleText(app.q('.bs-player-1 .bs-player-score')), '0');
    assert.match(visibleText(app.q('.bs-round')), /^Round 1\b.*3/);
    assertWind(app, g.wind);
    assert.equal(app.q('.bs-ui').style.getPropertyValue('--bs-p0'), PLAYER_COLORS[0]);
    assert.equal(app.q('.bs-ui').style.getPropertyValue('--bs-p1'), PLAYER_COLORS[1]);

    // Play rounds (the human throws the AI's shot) until someone scores, then until round 2 starts.
    const rng = createRng(3);
    const playTurn = () => {
      if (g.humanTurn) {
        const s = chooseShot(g, g.turn, rng);
        g.setAim(g.turn, Math.round(s.angle), Math.round(s.power));
        app.key(' ');
      }
    };
    app.runUntil(() => g.round === 2 && g.phase === 'aim', { seconds: 300, label: 'round 2', each: playTurn });
    const [a, b] = g.scores;
    assert.equal(a + b, 1);
    assert.equal(visibleText(app.q('.bs-player-0 .bs-player-score')), String(a));
    assert.equal(visibleText(app.q('.bs-player-1 .bs-player-score')), String(b));
    assert.match(visibleText(app.q('.bs-round')), /^Round 2\b/);
    assertWind(app, g.wind);
    app.assertClean();
  });

  test('"No wind" when the match has none', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'A' }, { name: 'B' }], windStrength: 'none' });
    assert.equal(g.wind, 0);
    assertWind(app, 0);
    app.assertClean();
  });

  test('turn banner: "Your turn" for You, "<name>\'s turn" for other humans, "<name> is thinking…" for a CPU', (t) => {
    const app = createApp(t, { seed: 4 });
    startReal(app, { players: [{ name: 'You' }, { name: 'Robo', cpu: 'easy' }] });
    const active = () => [0, 1].filter((i) => app.q(`.bs-player-${i}`).classList.contains('bs-active'));
    assert.equal(app.banner(), 'Your turn');
    assert.deepEqual(active(), [0], 'the card of the player whose turn it is is highlighted');
    assert.equal(app.aimPanelVisible(), true, 'aim panel on the human turn');
    app.key(' ');
    app.frame(1);
    assert.match(app.banner(), /^You: \d+(\.\d)?° · power \d+/, 'readout while the banana flies');
    app.runUntil(() => app.game.phase === 'aim' && app.game.turn === 1, { seconds: 30, label: 'CPU turn' });
    app.frame(1);
    assert.equal(app.banner(), 'Robo is thinking…');
    assert.deepEqual(active(), [1]);
    assert.equal(app.aimPanelVisible(), false, 'no aim panel on a CPU turn');
    app.runUntil(() => app.game.phase === 'flight', { seconds: 10, label: 'CPU throw' });
    app.frame(1);
    const cpuThrow = app.throws().at(-1);
    assert.equal(cpuThrow.player, 1);
    assert.ok(app.banner().startsWith('Robo: ') && app.banner().includes('power'), `CPU readout: ${app.banner()}`);

    startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    assert.equal(app.banner(), "Ann's turn");
    app.assertClean();
  });

  test('messages: hits, own goals and misses; bounded, and they expire with simulated time', (t) => {
    const app = createApp(t, { seed: 9 });
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }], windStrength: 'none' });
    app.frame(150); // the "Round 1" message is gone
    assert.deepEqual(app.toasts(), []);
    const opp = g.monkeys[1];
    app.ui.onEvent('impact', { kind: 'building', x: opp.x - 3, y: opp.y + 2, radius: 3.4, victim: null, thrower: 0 }, g);
    assert.deepEqual(app.toasts(), ['So close!']);
    app.ui.onEvent('impact', { kind: 'building', x: opp.x - 60, y: 5, radius: 3.4, victim: null, thrower: 0 }, g);
    assert.deepEqual(app.toasts(), ['So close!'], 'a wide miss gets no message');
    app.ui.onEvent('impact', { kind: 'out', x: -50, y: 10, radius: 0, victim: null, thrower: 0 }, g);
    assert.ok(app.toasts().includes('Out of the city!'));
    app.ui.onEvent('monkeyHit', { victim: 0, thrower: 0, selfHit: true }, g);
    assert.ok(app.toasts().some((s) => /^Ouch\b.*own goal!$/.test(s)), app.toasts().join(' | '));

    // One splash that hits both monkeys: the direct hit is announced, the own goal stays quiet.
    app.ui.onEvent('throw', { player: 0, angle: 45, power: 50, x: 0, y: 0, vx: 1, vy: 1, method: 'aim' }, g);
    app.ui.onEvent('monkeyHit', { victim: 1, thrower: 0, selfHit: false }, g);
    app.ui.onEvent('monkeyHit', { victim: 0, thrower: 0, selfHit: true }, g);
    assert.ok(app.toasts().includes('Direct hit!'));
    assert.ok(!app.toasts().some((s) => s.includes('own goal')), app.toasts().join(' | '));

    for (let i = 0; i < 12; i++) {
      app.ui.onEvent('wind', { wind: i - 6 }, g);
      app.ui.onEvent('sunHit', { x: 72, y: 86 }, g);
      app.ui.onEvent('roundStart', { round: i + 1, wind: 0, turn: 0 }, g);
    }
    const big = app.q('.bs-toasts').querySelectorAll('.bs-toast-big').length;
    const small = app.q('.bs-toasts').querySelectorAll('.bs-toast-small').length;
    assert.equal(big, 1, 'one big message at a time');
    assert.ok(small <= 3, `at most 3 small messages (${small})`);
    assert.equal(app.toasts()[0], 'Round 12', 'the newest big message wins');
    app.paused = true; // messages keep fading while the game is paused
    app.frame(5 * 60);
    assert.deepEqual(app.toasts(), [], 'all messages expired');
    assert.equal(app.q('.bs-toasts').childNodes.length, 0, 'and left the DOM');
    app.assertClean();
  });
});

function assertWind(app, wind) {
  const label = visibleText(app.q('.bs-wind-label'));
  const arrow = app.q('.bs-wind-arrow');
  const abs = Math.abs(wind);
  if (abs === 0) {
    assert.equal(label, 'No wind');
  } else {
    assert.equal(label, `Wind ${abs}`);
    assert.match(app.q('.bs-wind').getAttribute('aria-label'), new RegExp(`blowing ${wind > 0 ? 'right' : 'left'}`));
    assert.equal(Number(arrow.style.getPropertyValue('--dir')), Math.sign(wind));
  }
  assert.ok(Math.abs(Number(arrow.style.getPropertyValue('--len')) - abs / MAX_WIND) < 1e-3, 'arrow length ∝ |wind|');
}

describe('keyboard', () => {
  test('→/← change the angle and ↑/↓ the power by 1, by 5 with Shift', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'normal' }] });
    assert.equal(g.humanTurn, true);
    app.doc.activeElement.blur();
    const start = aimOf(app);
    const steps = [
      ['ArrowRight', false, 1, 0], ['ArrowLeft', false, -1, 0], ['ArrowRight', true, 5, 0], ['ArrowLeft', true, -5, 0],
      ['ArrowUp', false, 0, 1], ['ArrowDown', false, 0, -1], ['ArrowUp', true, 0, 5], ['ArrowDown', true, 0, -5],
      ['ArrowRight', true, 5, 0], ['ArrowUp', false, 0, 1],
    ];
    for (const [key, shift, da, dp] of steps) {
      const before = aimOf(app);
      const { down } = app.key(key, { shift });
      assert.deepEqual(aimOf(app), { angle: before.angle + da, power: before.power + dp }, `${shift ? 'Shift+' : ''}${key}`);
      assert.equal(down.defaultPrevented, true, `${key} does not scroll the page`);
    }
    assert.deepEqual(aimOf(app), { angle: start.angle + 5, power: start.power + 1 });
    app.frame(1);
    assert.equal(app.control('Angle in degrees').value, String(start.angle + 5), 'aim boxes follow the keys');
    assert.equal(app.control('Power').value, String(start.power + 1));
    assert.equal(app.control('Power slider').value, String(start.power + 1));

    for (let i = 0; i < 30; i++) app.key('ArrowUp', { shift: true });
    assert.equal(aimOf(app).power, MAX_POWER, 'power stops at the maximum');
    for (let i = 0; i < 50; i++) app.key('ArrowLeft', { shift: true });
    assert.equal(aimOf(app).angle, 0, 'angle stops at 0');
    app.key('ArrowRight', { ctrl: true });
    assert.equal(aimOf(app).angle, 0, 'Ctrl+arrow is left to the browser');
    assert.equal(app.throws().length, 0, 'aiming never throws');
    app.assertClean();
  });

  test('Space and Enter throw on a human turn, never during flight or a CPU turn', (t) => {
    const app = createApp(t, { seed: 8 });
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'normal' }] });
    app.key('ArrowRight');
    const aim = aimOf(app);
    app.key(' ', { repeat: true });
    assert.equal(app.throws().length, 0, 'a Space held down since before the turn does not throw');
    const { down } = app.key(' ');
    assert.equal(down.defaultPrevented, true);
    assert.equal(g.phase, 'flight');
    assert.equal(app.throws().length, 1);
    assert.deepEqual(pick(app.throws()[0], ['player', 'angle', 'power', 'method']), { player: 0, ...aim, method: 'aim' });
    app.key(' ');
    app.key('Enter');
    assert.equal(app.throws().length, 1, 'no second throw while the banana flies');

    app.runUntil(() => g.phase === 'aim' && g.turn === 1, { seconds: 30, label: 'CPU turn' });
    const cpuAim = { ...g.aim[1] };
    for (const [key, shift] of [[' ', false], ['Enter', false], ['ArrowRight', false], ['ArrowUp', true]]) {
      app.key(key, { shift });
      assert.equal(app.throws().length, 1, `${key} on a CPU turn does not throw`);
      assert.equal(g.phase, 'aim');
      assert.deepEqual(g.aim[1], cpuAim, `${key} on a CPU turn does not aim`);
      app.frame(1);
    }
    app.runUntil(() => g.phase === 'aim' && g.turn === 0, { seconds: 30, label: 'human turn again' });
    app.key('Enter');
    assert.equal(app.throws().length, 3, 'Enter throws on the human turn');
    assert.equal(app.throws()[2].player, 0);
    app.assertClean();
  });

  test('no aiming or throwing from the keyboard while a menu is open', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    const aim = aimOf(app);
    app.key('Escape');
    assert.equal(app.screen(), 'pause');
    app.doc.activeElement.blur(); // keys on the page itself, not on a menu button
    for (const [key, shift] of [[' ', false], ['Enter', false], ['ArrowRight', false], ['ArrowUp', true], ['ArrowDown', false]]) {
      app.key(key, { shift });
      assert.equal(app.screen(), 'pause', key);
    }
    assert.deepEqual(aimOf(app), aim);
    assert.equal(app.throws().length, 0);

    // Space on the focused Resume button activates Resume (the browser's click), it does not also throw.
    app.button('Resume').focus();
    app.key(' ');
    assert.equal(app.screen(), null);
    assert.equal(app.throws().length, 0);
    assert.equal(g.phase, 'aim');

    app.key('Escape');
    app.press('Settings');
    assert.equal(app.screen(), 'setup');
    app.doc.activeElement.blur();
    for (const key of [' ', 'Enter', 'ArrowLeft', 'ArrowUp']) app.key(key);
    assert.deepEqual(aimOf(app), aim);
    assert.equal(app.throws().length, 0);
    app.assertClean();
  });

  test('Space on the focused THROW button throws exactly once; a focused slider moves by one step', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    const slider = app.control('Power slider');
    slider.focus();
    const before = aimOf(app);
    app.key('ArrowRight');
    assert.deepEqual(aimOf(app), { angle: before.angle, power: before.power + 1 }, 'slider step, not slider + game key');
    app.key('ArrowUp');
    assert.deepEqual(aimOf(app), { angle: before.angle, power: before.power + 2 });
    app.button('THROW!').focus();
    app.key(' ');
    assert.equal(app.throws().length, 1);
    assert.equal(app.throws()[0].power, before.power + 2);
    assert.equal(g.phase, 'flight');
    app.assertClean();
  });

  test('2 players: the same keys aim for whoever has the turn', (t) => {
    const app = createApp(t, { seed: 14 });
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }], windStrength: 'none' });
    app.key(' ');
    app.runUntil(() => g.phase === 'aim' && g.turn === 1, { seconds: 30, label: "Bob's turn" });
    app.frame(1);
    assert.equal(app.banner(), "Bob's turn");
    const ann = { ...g.aim[0] };
    const bob = { ...g.aim[1] };
    app.key('ArrowRight', { shift: true });
    app.key('ArrowDown');
    assert.deepEqual(g.aim[1], { angle: bob.angle + 5, power: bob.power - 1 }, '→ raises the angle for the right-hand player too');
    assert.deepEqual(g.aim[0], ann, "Ann's aim is left alone");
    app.key('Enter');
    assert.equal(app.throws().at(-1).player, 1);
    assert.ok(app.throws().at(-1).vx < 0, 'Bob throws toward Ann');
    app.assertClean();
  });
});

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

describe('typed aim', () => {
  test('type the angle, Enter, type the power, Enter throws with those numbers', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'easy' }] });
    const angleBox = app.control('Angle in degrees');
    typeInto(angleBox, '60');
    assert.equal(g.aim[0].angle, 60, 'the angle box aims while typing');
    app.key('m');
    assert.deepEqual(app.callsOf('prefsChanged'), [], 'M typed in a box does not mute');
    app.key('ArrowUp');
    assert.deepEqual(g.aim[0], { angle: 61, power: 50 }, '↑ in the angle box steps the box only, not the power');
    assert.equal(app.throws().length, 0);
    app.key('Escape');
    assert.ok(app.doc.activeElement !== angleBox, 'Esc in a box leaves the box');
    assert.equal(app.screen(), null, '... without opening the pause menu');
    throwTyped(app, 60, 70);
    assert.equal(app.throws().length, 1);
    assert.deepEqual(pick(app.throws()[0], ['player', 'angle', 'power']), { player: 0, angle: 60, power: 70 });
    assert.ok(app.doc.activeElement !== app.control('Power'), 'the box lets go of the keys after the throw');
    app.frame(1);
    assert.equal(app.aimPanelVisible(), false, 'aim panel hides during the flight');
    app.assertClean();
  });

  test('Enter in the power box uses the typed values even without input events', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    const angleBox = app.control('Angle in degrees');
    const powerBox = app.control('Power');
    angleBox.value = '33';
    powerBox.focus();
    powerBox.value = '81';
    app.key('Enter');
    assert.equal(g.phase, 'flight');
    assert.deepEqual(pick(app.throws()[0], ['angle', 'power']), { angle: 33, power: 81 });
    app.assertClean();
  });
});

describe('pointer drag', () => {
  test('dragging sets angle and power from the hand to the pointer; release throws', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'easy' }] });
    const to = dragTo(app, 45, 40, { release: false });
    assert.deepEqual(aimOf(app), { angle: 45, power: 40 });
    const guide = app.q('.bs-guide');
    assert.equal(guide._rendered, true, 'drag guide shows while dragging');
    assert.equal(visibleText(app.q('.bs-guide-chip')), '45° · 40');
    assert.equal(app.throws().length, 0, 'no throw before release');
    const hand = g.handPosition(0);
    // The guide line runs from the hand (worldToScreen, in client px) to the pointer.
    const line = app.q('.bs-guide-line').style;
    const [x0, y0] = line.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).slice(1).map(Number);
    const h = clientAt(hand.x, hand.y);
    assert.ok(Math.abs(x0 - h.x) < 0.1 && Math.abs(y0 - h.y) < 0.1, `guide starts at the hand: ${line.transform}`);
    assert.ok(Math.abs(Number.parseFloat(line.width) - Math.hypot(to.x - h.x, to.y - h.y)) < 0.1, `guide length ${line.width}`);
    const far = clientAt(hand.x, hand.y + 200);
    pointer(app.canvas, 'pointermove', { ...far, buttons: 1 });
    assert.deepEqual(aimOf(app), { angle: 90, power: MAX_POWER }, 'straight up, power capped');
    pointer(app.canvas, 'pointermove', { ...to, buttons: 1 });
    pointer(app.canvas, 'pointerup', { ...to });
    assert.equal(app.throws().length, 1);
    assert.deepEqual(pick(app.throws()[0], ['player', 'angle', 'power', 'method']), { player: 0, angle: 45, power: 40, method: 'aim' });
    assert.equal(guide._rendered, false, 'guide hides after release');
    app.assertClean();
  });

  test('a click without dragging does not throw; Escape and right-click cancel and restore the aim', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    const aim = aimOf(app);
    const m = g.monkeys[0];
    const p0 = clientAt(m.x + 10, m.y + 10);
    const p1 = clientAt(m.x + 10 + DRAG_MIN / 2, m.y + 10);
    pointer(app.canvas, 'pointerdown', { ...p0, buttons: 1 });
    pointer(app.canvas, 'pointermove', { ...p1, buttons: 1 });
    pointer(app.canvas, 'pointerup', { ...p1 });
    assert.deepEqual(aimOf(app), aim, 'a click does not aim');
    assert.equal(app.throws().length, 0, 'a click does not throw');

    dragTo(app, 70, 80, { release: false });
    assert.deepEqual(aimOf(app), { angle: 70, power: 80 });
    app.key('Escape');
    assert.deepEqual(aimOf(app), aim, 'Escape restores the aim from before the drag');
    assert.equal(app.screen(), null, 'Escape during a drag only cancels it');
    assert.equal(app.q('.bs-guide')._rendered, false);
    pointer(app.canvas, 'pointerup', { ...clientAt(m.x + 20, m.y + 20) });
    assert.equal(app.throws().length, 0, 'releasing a cancelled drag does not throw');

    // A second mouse button during a drag arrives as a pointermove with more buttons (chorded buttons).
    const to = dragTo(app, 30, 60, { release: false });
    assert.deepEqual(aimOf(app), { angle: 30, power: 60 });
    pointer(app.canvas, 'pointermove', { ...to, button: 2, buttons: 3 });
    assert.deepEqual(aimOf(app), aim, 'right button cancels');
    pointer(app.canvas, 'pointerup', { ...to });
    assert.equal(app.throws().length, 0);

    dragTo(app, 30, 60, { release: false });
    const menu = new FakeEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
    app.canvas.dispatchEvent(menu);
    assert.equal(menu.defaultPrevented, true, 'no browser context menu over the game');
    assert.deepEqual(aimOf(app), aim, 'right-click (context menu) cancels');
    pointer(app.canvas, 'pointerup', { ...to });
    assert.equal(app.throws().length, 0);
    app.assertClean();
  });

  test('player 1 faces left: dragging up and to the left aims toward the opponent', (t) => {
    const app = createApp(t, { seed: 12 });
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }], windStrength: 'none' });
    dragTo(app, 50, 60);
    assert.equal(app.throws().length, 1);
    // A miss hands the turn to Bob; a hit starts round 2, which Bob opens.
    app.runUntil(() => g.phase === 'aim' && g.turn === 1, { seconds: 30, label: "Bob's turn" });
    assert.equal(g.monkeys[1].facing, -1);
    const hand = g.handPosition(1);
    const to = dragTo(app, 60, 50, { release: false });
    assert.ok(to.x < clientAt(hand.x, hand.y).x, 'the pointer is left of the hand');
    assert.deepEqual(aimOf(app), { angle: 60, power: 50 });
    pointer(app.canvas, 'pointerup', { ...to });
    assert.deepEqual(pick(app.throws()[1], ['player', 'angle', 'power']), { player: 1, angle: 60, power: 50 });
    assert.ok(app.throws()[1].vx < 0, 'thrown toward player 0');
    app.assertClean();
  });

  test('touch works like the mouse; a second finger is ignored and pointercancel cancels', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    const m = g.monkeys[0];
    const aim = aimOf(app);
    const touch = (type, at, id, extra = {}) => pointer(app.canvas, type, {
      ...at, pointerType: 'touch', pointerId: id, isPrimary: id === 7, buttons: type === 'pointerup' ? 0 : 1, ...extra,
    });
    const hand = g.handPosition(0);
    const to = clientAt(hand.x + 10, hand.y + 10); // 45°, distance √200
    const power = Math.round((Math.hypot(10, 10) * MAX_POWER) / DRAG_FULL_POWER);

    touch('pointerdown', clientAt(m.x, m.y + 2), 7);
    touch('pointerdown', clientAt(m.x + 30, m.y + 30), 8);
    touch('pointermove', clientAt(m.x + 40, m.y + 5), 8);
    assert.deepEqual(aimOf(app), aim, 'the second finger does not aim');
    touch('pointermove', to, 7);
    assert.deepEqual(aimOf(app), { angle: 45, power });
    touch('pointerup', to, 8);
    assert.equal(app.throws().length, 0, 'lifting the second finger does not throw');
    touch('pointercancel', to, 7);
    assert.deepEqual(aimOf(app), aim, 'pointercancel restores the aim');
    assert.equal(app.throws().length, 0);

    touch('pointerdown', clientAt(m.x, m.y + 2), 7);
    touch('pointermove', to, 7);
    touch('pointerup', to, 7);
    assert.equal(app.throws().length, 1, 'lifting the finger throws');
    assert.deepEqual(pick(app.throws()[0], ['angle', 'power']), { angle: 45, power });
    app.assertClean();
  });

  test('no drag aiming during a CPU turn or while a menu is open', (t) => {
    const app = createApp(t, { seed: 8 });
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'normal' }] });
    app.key('Escape');
    assert.equal(app.screen(), 'pause');
    const aim = aimOf(app);
    dragTo(app, 70, 90);
    assert.deepEqual(aimOf(app), aim);
    assert.equal(app.throws().length, 0, 'no throw from a drag behind the pause menu');
    app.press('Resume');
    app.key(' ');
    app.runUntil(() => g.phase === 'aim' && g.turn === 1, { seconds: 30, label: 'CPU turn' });
    const cpuAim = { ...g.aim[1] };
    dragTo(app, 10, 95);
    assert.deepEqual(g.aim[1], cpuAim, 'a drag does not aim for the CPU');
    assert.equal(app.throws().length, 1, 'a drag does not throw for the CPU');
    assert.equal(app.q('.bs-guide')._rendered, false);
    app.assertClean();
  });
});

describe('pause menu', () => {
  test('Esc / P / the pause button pause through setPaused(true); Resume and Esc unpause', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'normal' }] });
    app.key('Escape');
    assert.equal(app.screen(), 'pause');
    assert.equal(app.ui.menuOpen, true);
    assert.deepEqual(app.callsOf('setPaused'), [[true]]);
    assert.equal(app.hud().inert, true, 'HUD behind the menu is inert');
    assert.equal(app.aimPanelVisible(), false);
    app.frame(30);
    assert.equal(g.phase, 'aim', 'nothing moves while paused');
    app.press('Resume');
    assert.equal(app.screen(), null);
    assert.deepEqual(app.callsOf('setPaused'), [[true], [false]]);
    assert.equal(app.hud().inert, false);

    app.key('p');
    assert.equal(app.screen(), 'pause');
    app.key('p');
    assert.equal(app.screen(), null);
    click(app.button('Pause (Esc)'));
    assert.equal(app.screen(), 'pause');
    app.key('Escape');
    assert.equal(app.screen(), null);
    assert.deepEqual(app.callsOf('setPaused').map(([v]) => v), [true, false, true, false, true, false]);

    // Settings and How to play from the pause menu keep the game paused.
    app.key('Escape');
    app.press('Settings');
    assert.equal(app.screen(), 'setup');
    assert.deepEqual(app.buttons('Start!'), [], 'match rules cannot change mid-match');
    app.key('m');
    assert.equal(app.callsOf('prefsChanged').at(-1)[0].sound, false, 'M mutes');
    app.press('Back to pause');
    assert.equal(app.screen(), 'pause');
    app.press('How to play');
    assert.equal(app.screen(), 'howto');
    app.key('Escape');
    assert.equal(app.screen(), 'pause');
    assert.deepEqual(app.callsOf('setPaused').map(([v]) => v), [true, false, true, false, true, false, true]);
    assert.equal(app.paused, true);
    app.key('Escape');
    assert.equal(app.paused, false);
    app.key('c');
    assert.equal(app.callsOf('toggleFollow').length, 1, 'C toggles the camera follow in a match');
    app.assertClean();
  });

  test('Restart and Quit to title from the pause menu', (t) => {
    const app = createApp(t);
    startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'hard' }], targetScore: 7, gravity: 3.71, windStrength: 'wild' });
    const first = app.game;
    app.key('Escape');
    app.press('Restart match');
    assert.equal(app.screen(), null);
    assert.equal(app.paused, false);
    assert.equal(app.callsOf('setPaused').at(-1)[0], false);
    const [[settings]] = app.callsOf('startMatch');
    assert.deepEqual(settings, {
      players: [{ name: 'Ann', cpu: null }, { name: 'Robo', cpu: 'hard' }], targetScore: 7, gravity: 3.71, windStrength: 'wild',
    });
    assertNormalizedShape(settings);
    assert.ok(app.game !== first, 'a new game');
    app.frame(1);
    assert.equal(app.banner(), "Ann's turn");

    app.key('Escape');
    app.press('Quit to title');
    assert.equal(app.callsOf('quitToTitle').length, 1);
    assert.equal(app.paused, false, 'quitting unpauses');
    assert.equal(app.game.isDemo, true);
    assert.equal(app.screen(), 'title');
    app.frame(5);
    assert.equal(app.hudVisible(), false);
    app.assertClean();
  });
});

describe('match over', () => {
  test('a CPU vs CPU match runs to the end through the UI: HUD, toasts, winner screen, Rematch', (t) => {
    const app = createApp(t, { seed: 2 });
    const settings = { players: [{ name: 'Bongo', cpu: 'hard' }, { name: 'Mango', cpu: 'hard' }], targetScore: 2, windStrength: 'wild' };
    const g = startReal(app, settings);
    const seen = new Set();
    const baseline = app.root.querySelectorAll('*').length;
    let maxNodes = baseline;
    let maxToasts = 0;
    let frame = 0;
    app.runUntil(() => g.phase === 'matchOver', { seconds: 900, dt: 1 / 30, label: 'match over', each: () => {
      const toasts = app.toasts();
      for (const s of toasts) seen.add(s);
      maxToasts = Math.max(maxToasts, toasts.length);
      if (g.phase === 'matchOver' || frame++ % 10) return;
      maxNodes = Math.max(maxNodes, app.root.querySelectorAll('*').length);
      assert.equal(app.screen(), null);
      assert.equal(app.hudVisible(), true);
      assert.equal(app.aimPanelVisible(), false, 'no aim panel without a human');
      assert.equal(app.inset, 0, 'bottomInset is 0 without a human');
      assert.equal(visibleText(app.q('.bs-wind-label')), g.wind ? `Wind ${Math.abs(g.wind)}` : 'No wind');
      if (g.phase === 'aim') assert.equal(app.banner(), `${g.current.name} is thinking…`);
    } });
    app.frame(1, 1 / 30);
    assert.equal(app.screen(), 'matchOver');
    const { winner, scores } = app.events.find((e) => e.type === 'matchOver').payload;
    assert.equal(scores[winner], 2);
    assert.ok(app.events.some((e) => e.type === 'wind'), 'wild wind changed during the match');
    assert.ok(seen.has('Round 1'), [...seen].join(' | '));
    assert.ok([...seen].some((s) => /^(Bongo|Mango) wins the round!/.test(s)), [...seen].join(' | '));
    assert.ok([...seen].some((s) => s === 'Direct hit!' || s.startsWith('Ouch')), [...seen].join(' | '));
    assert.ok(maxToasts <= 4, `toasts are capped (saw ${maxToasts})`);
    assert.ok(maxNodes <= baseline + 30, `overlay DOM stays bounded (${baseline} -> ${maxNodes} elements)`);

    // Winner screen.
    assert.equal(app.ui.menuOpen, true);
    const panel = app.q('.bs-matchover-layer');
    const text = visibleText(panel);
    const name = settings.players[winner].name;
    assert.ok(text.includes(`${name} wins the match!`), text);
    assert.ok(text.includes(`Bongo ${scores[0]} – Mango ${scores[1]}`), `final score in: ${text}`);
    assert.equal(app.hud().inert, true);
    app.button('Menu');
    assert.ok(app.doc.activeElement === app.button('Rematch'), 'Rematch has the focus');
    assert.deepEqual(app.toasts(), [], 'messages are cleared for the winner screen');
    app.doc.activeElement.blur();
    app.key(' ');
    assert.equal(app.screen(), 'matchOver', 'Space on the winner screen does nothing');
    assert.deepEqual(app.callsOf('setPaused'), [], 'match over is not a pause');

    app.press('Rematch');
    const [[again]] = app.callsOf('startMatch');
    assert.deepEqual(again, {
      players: [{ name: 'Bongo', cpu: 'hard' }, { name: 'Mango', cpu: 'hard' }], targetScore: 2, gravity: GRAVITY_PRESETS.earth, windStrength: 'wild',
    });
    assertNormalizedShape(again);
    assert.equal(app.screen(), null);
    assert.ok(app.game !== g, 'a new game');
    app.frame(1);
    assert.deepEqual([0, 1].map((i) => visibleText(app.q(`.bs-player-${i} .bs-player-score`))), ['0', '0']);
    assert.ok(app.toasts().some((s) => s.startsWith('Round 1')));
    app.frame(4 * 30, 1 / 30);
    assert.ok(!app.toasts().some((s) => s.startsWith('Round 1')), 'the round toast expires with simulated time');
    app.assertClean();
  });

  test('a human vs CPU match with keyboard, typed and drag throws ends on the winner screen; Menu goes to the title', (t) => {
    const app = createApp(t, { seed: 31 });
    app.startDemo();
    app.press('1 Player vs CPU');
    typeInto(app.field('Your name'), 'You');
    choose(app.radio('CPU difficulty', 'easy'));
    choose(app.radio('Points to win', '1'));
    choose(app.radio('Wind', 'calm'));
    app.press('Start!');
    const g = app.game;
    assert.equal(g.isDemo, false);
    const rng = createRng(11);
    const methods = ['keys', 'typed', 'drag'];
    let humanThrows = 0;
    const playTurn = () => {
      if (!g.humanTurn) return;
      assert.equal(app.banner(), 'Your turn');
      const s = chooseShot(g, 0, rng);
      const angle = Math.round(s.angle);
      const power = Math.round(s.power);
      const method = methods[humanThrows % methods.length];
      const before = app.throws().length;
      if (method === 'keys') {
        app.doc.activeElement.blur();
        aimWithKeys(app, angle, power);
        app.key(' ');
      } else if (method === 'typed') {
        throwTyped(app, angle, power);
      } else {
        dragTo(app, angle, power);
      }
      assert.equal(app.throws().length, before + 1, `${method} throw`);
      assert.deepEqual(pick(app.throws().at(-1), ['player', 'angle', 'power']), { player: 0, angle, power }, method);
      humanThrows += 1;
    };
    app.frame(1);
    app.runUntil(() => g.phase === 'matchOver', { seconds: 600, dt: 1 / 30, label: 'match over', each: playTurn });
    app.frame(1, 1 / 30);
    assert.equal(app.screen(), 'matchOver');
    assert.ok(humanThrows >= 1);
    assert.equal(app.throws().filter((e) => e.player === 0).length, humanThrows, 'every human throw came from an input');
    assert.ok(app.throws().some((e) => e.player === 1), 'the CPU threw too');
    const { winner } = app.events.find((e) => e.type === 'matchOver').payload;
    const text = visibleText(app.q('.bs-matchover-layer'));
    assert.ok(text.includes(`${winner === 0 ? 'You' : 'Easy CPU'} wins the match!`), text);
    app.button('Rematch');
    app.press('Menu');
    assert.equal(app.callsOf('quitToTitle').length, 1);
    assert.equal(app.game.isDemo, true);
    assert.equal(app.screen(), 'title');
    app.assertClean();
  });
});

describe('VR', () => {
  test('setXRActive(true) hides the overlay and ignores DOM input; false brings it back', (t) => {
    const app = createApp(t);
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'normal' }] });
    app.frame(1);
    assert.ok(app.inset > 0);
    app.key('Escape');
    assert.equal(app.paused, true);

    app.ui.setXRActive(true);
    assert.equal(app.overlayHidden(), true, 'overlay hidden in VR');
    assert.equal(app.ui.menuOpen, false);
    assert.equal(app.paused, false, 'entering VR leaves the pause behind');
    assert.equal(app.callsOf('setPaused').at(-1)[0], false);
    assert.equal(app.ui.bottomInset, 0, 'nothing covers the view in VR');
    const aim = aimOf(app);
    for (const key of ['Escape', 'p', 'ArrowRight', 'ArrowUp', ' ', 'Enter', 'm', 'c']) app.key(key);
    dragTo(app, 20, 90);
    assert.deepEqual(aimOf(app), aim);
    assert.equal(app.throws().length, 0, 'no DOM throws in VR');
    assert.deepEqual(app.callsOf('toggleFollow'), []);
    assert.deepEqual(app.callsOf('prefsChanged'), []);
    app.frame(10);
    assert.equal(app.overlayHidden(), true, 'stays hidden across frames');

    app.ui.setXRActive(false);
    assert.equal(app.overlayHidden(), false);
    assert.equal(app.screen(), null, 'the pause menu does not come back');
    app.frame(1);
    assert.equal(app.hudVisible(), true);
    app.key(' ');
    assert.equal(app.throws().length, 1, 'keys work again after VR');
    assert.equal(g.phase, 'flight');
    app.assertClean();
  });

  test('a match that ends in VR shows the winner screen once VR ends', (t) => {
    const app = createApp(t, { seed: 5 });
    const g = startReal(app, { players: [{ name: 'Bot A', cpu: 'hard' }, { name: 'Bot B', cpu: 'hard' }], targetScore: 1, windStrength: 'none' });
    app.ui.setXRActive(true);
    let frame = 0;
    app.runUntil(() => g.phase === 'matchOver', { seconds: 600, dt: 1 / 30, label: 'match over', each: () => {
      if (frame++ % 15) return;
      assert.equal(app.overlayHidden(), true);
      assert.equal(app.ui.menuOpen, false);
      assert.equal(app.inset, 0);
    } });
    app.frame(5, 1 / 30);
    assert.equal(app.overlayHidden(), true, 'the winner screen waits while in VR');
    assert.equal(app.ui.menuOpen, false);
    app.ui.setXRActive(false);
    assert.equal(app.screen(), 'matchOver');
    assert.equal(app.ui.menuOpen, true);
    assert.ok(app.doc.activeElement === app.button('Rematch'), 'Rematch has the focus');
    assert.match(visibleText(app.q('.bs-matchover-layer')), /^Bot [AB] wins the match!/);
    app.assertClean();
  });

  test('on the title screen: VR hides the menu, leaving VR shows it again', (t) => {
    const app = createApp(t);
    app.startDemo();
    app.ui.setXRActive(true);
    assert.equal(app.overlayHidden(), true);
    assert.equal(app.ui.menuOpen, false);
    app.frame(20);
    app.ui.setXRActive(false);
    assert.equal(app.overlayHidden(), false);
    assert.equal(app.screen(), 'title');
    assert.equal(app.ui.menuOpen, true);
    app.assertClean();
  });

  test('Play in VR calls unlockAudio and enterVR; a failed start shows a message', async (t) => {
    const vr = { calls: 0, mode: 'ok' };
    const enterVR = () => {
      vr.calls += 1;
      if (vr.mode === 'throw') throw new Error('sync failure');
      return vr.mode === 'reject' ? Promise.reject(new Error('no headset')) : Promise.resolve();
    };
    const app = createApp(t, { callbacks: { enterVR } });
    app.startDemo();
    app.ui.setVRSupported(true);
    app.press('Play in VR');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(vr.calls, 1);
    assert.ok(app.callsOf('unlockAudio').length >= 1, 'audio unlocked by the VR button');
    assert.deepEqual(app.toasts(), [], 'no message when VR starts');

    vr.mode = 'reject';
    app.press('Play in VR');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(app.toasts(), ['VR did not start. Is the headset awake?']);
    vr.mode = 'throw';
    app.press('Play in VR');
    assert.equal(vr.calls, 3);
    assert.equal(app.toasts().filter((s) => s.startsWith('VR did not start')).length, 2);
    assert.equal(app.screen(), 'title');
    app.assertClean({ warnings: 2 });
  });
});

describe('bottomInset', () => {
  test('0 for demo and CPU-only games, positive during a human match once the aim panel was shown', (t) => {
    const app = createApp(t);
    app.startDemo();
    app.frame(30);
    assert.equal(app.ui.bottomInset, 0, 'demo');

    startReal(app, { players: [{ name: 'Bot A', cpu: 'easy' }, { name: 'Bot B', cpu: 'easy' }] });
    app.frame(120);
    assert.equal(app.ui.bottomInset, 0, 'CPU vs CPU');

    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Robo', cpu: 'easy' }] });
    assert.equal(app.aimPanelVisible(), true);
    app.frame(1);
    const inset = app.ui.bottomInset;
    assert.ok(Number.isFinite(inset) && inset >= HEIGHT - AIM_PANEL_RECT.top, `inset ${inset} covers the aim panel`);
    app.key(' ');
    app.runUntil(() => g.phase === 'aim' && g.turn === 1, { seconds: 30, label: 'CPU turn' });
    app.frame(1);
    assert.equal(app.aimPanelVisible(), false);
    assert.equal(app.ui.bottomInset, inset, 'kept steady while the panel is hidden between turns');
    app.ui.setXRActive(true);
    assert.equal(app.ui.bottomInset, 0);
    app.ui.setXRActive(false);
    app.startDemo();
    assert.equal(app.ui.bottomInset, 0, 'back to the demo');
    app.assertClean();
  });
});

describe('dispose', () => {
  test('removes every listener it added and its DOM; later input does nothing', (t) => {
    const doc = env.document;
    const before = { window: env.window._listenerList(), document: doc._listenerList(), body: doc.body._listenerList() };
    const app = createApp(t);
    const added = env.window._listenerList();
    assert.ok(added.length > before.window.length, 'the UI listens on window');
    assert.ok(app.canvas._listenerList().length > 0, 'the UI listens on the canvas');
    const g = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    for (let i = 0; i < 5; i++) startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    app.startDemo();
    assert.deepEqual(env.window._listenerList(), added, 'no listeners pile up across matches');
    const real = startReal(app, { players: [{ name: 'Ann' }, { name: 'Bob' }] });
    assert.ok(real !== g);

    app.ui.dispose();
    assert.deepEqual(env.window._listenerList(), before.window, 'window listeners removed');
    assert.deepEqual(doc._listenerList(), before.document);
    assert.deepEqual(doc.body._listenerList(), before.body);
    assert.deepEqual(app.canvas._listenerList(), [], 'canvas listeners removed');
    assert.equal(app.root.childNodes.length, 0, 'overlay removed');
    const aim = aimOf(app);
    app.key('ArrowRight');
    app.key(' ');
    app.key('Escape');
    dragTo(app, 30, 30);
    assert.deepEqual(aimOf(app), aim);
    assert.equal(app.throws().length, 0);
    assert.deepEqual(app.callsOf('setPaused'), []);
    app.ui.dispose(); // twice is harmless
    app.assertClean();
  });
});
