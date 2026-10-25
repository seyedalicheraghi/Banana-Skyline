// Fakes for testing src/xr (XRMode) in Node: a simulated clock, a canvas-only DOM, navigator.xr,
// three's WebXRManager surface (controllers, grips, sessions), Quest input sources, a contract-shaped
// GameView, and an app that wires them like src/app/main.js. Not a test file (only tests/*.test.mjs run).
import * as THREE from 'three';
import { Game } from '../../src/core/game.js';
import { XRMode } from '../../src/xr/xr.js';

// --- global environment ------------------------------------------------------------------------------

/** 2D context that records the text drawn since the last full clear (enough for the VR panels). */
class FakeContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.font = '10px sans-serif';
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.textAlign = 'start';
    this.textBaseline = 'alphabetic';
    canvas.texts = [];
  }

  clearRect(x, y, w, h) {
    if (x <= 0 && y <= 0 && w >= this.canvas.width && h >= this.canvas.height) this.canvas.texts = [];
  }

  fillText(text) {
    this.canvas.texts.push(String(text));
  }

  measureText(text) {
    const px = Number(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? 10);
    return { width: String(text).length * px * 0.55 };
  }

  beginPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  arcTo() {}
  arc() {}
  rect() {}
  fill() {}
  stroke() {}
  fillRect() {}
  strokeRect() {}
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  scale() {}
  setTransform() {}
  drawImage() {}
}

function createFakeDocument() {
  return {
    createElement(tag) {
      const el = { tagName: String(tag).toUpperCase(), width: 300, height: 150, style: {}, texts: [] };
      if (el.tagName === 'CANVAS') {
        let ctx = null;
        el.getContext = (type) => (type === '2d' ? (ctx ??= new FakeContext2D(el)) : null);
      }
      return el;
    },
  };
}

/** Simulated time for performance.now(): only advance() moves it. */
export class SimClock {
  constructor(startMs = 1000) {
    this.ms = startMs;
  }

  /** @param {number} seconds */
  advance(seconds) {
    this.ms += seconds * 1000;
  }

  get seconds() {
    return this.ms / 1000;
  }
}

const fmt = (v) => (v instanceof Error ? `${v.name}: ${v.message}` : typeof v === 'string' ? v : (() => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
})());

/**
 * Patch the globals XRMode reads: performance.now (simulated clock), document (canvas only),
 * navigator (with a replaceable `xr`), console.error/warn (captured). restore() puts everything back.
 */
export function installXREnv() {
  const perf = globalThis.performance;
  const saved = {
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    now: Object.getOwnPropertyDescriptor(perf, 'now'),
    error: console.error,
    warn: console.warn,
  };
  const clock = new SimClock();
  Object.defineProperty(perf, 'now', { configurable: true, writable: true, value: () => clock.ms });
  const nav = { userAgent: 'node-test (XRMode)', xr: undefined };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, enumerable: true, writable: true, value: nav });
  Object.defineProperty(globalThis, 'document', { configurable: true, enumerable: true, writable: true, value: createFakeDocument() });
  const logs = { errors: [], warns: [] };
  console.error = (...args) => logs.errors.push(args.map(fmt).join(' '));
  console.warn = (...args) => logs.warns.push(args.map(fmt).join(' '));

  const define = (target, key, desc) => {
    if (desc) Object.defineProperty(target, key, desc);
    else delete target[key];
  };
  return {
    clock,
    nav,
    logs,
    /** Forget captured console output (e.g. after a test that expects an error). */
    clearLogs() {
      logs.errors.length = 0;
      logs.warns.length = 0;
    },
    restore() {
      console.error = saved.error;
      console.warn = saved.warn;
      define(perf, 'now', saved.now);
      define(globalThis, 'navigator', saved.navigator);
      define(globalThis, 'document', saved.document);
    },
  };
}

// --- navigator.xr --------------------------------------------------------------------------------------

/** XRSession: an EventTarget whose end() fires 'end' asynchronously, like a browser. */
export class FakeXRSession extends EventTarget {
  constructor({ mode = 'immersive-vr', init = {}, enabledFeatures = ['viewer', 'local', 'local-floor'] } = {}) {
    super();
    this.mode = mode;
    this.init = init;
    this.enabledFeatures = Object.freeze([...enabledFeatures]);
    this.ended = false;
    this.endCalls = 0;
  }

  end() {
    this.endCalls += 1;
    if (this.ended) return Promise.reject(new Error('InvalidStateError: the session has already ended'));
    this.ended = true;
    return Promise.resolve().then(() => this.dispatchEvent(new Event('end')));
  }
}

/** navigator.xr: configurable support answer and request outcome; records every call. */
export class FakeXRSystem {
  constructor({ supported = true, enabledFeatures = ['viewer', 'local', 'local-floor', 'hand-tracking'], requestError = null } = {}) {
    this.supported = supported;
    this.enabledFeatures = enabledFeatures;
    this.requestError = requestError;
    this.supportCalls = [];
    this.requests = [];
    this.sessions = [];
  }

  async isSessionSupported(mode) {
    this.supportCalls.push(mode);
    return this.supported && mode === 'immersive-vr';
  }

  async requestSession(mode, init = {}) {
    this.requests.push({ mode, init });
    await null;
    if (this.requestError) throw this.requestError;
    const session = new FakeXRSession({ mode, init, enabledFeatures: this.enabledFeatures });
    this.sessions.push(session);
    return session;
  }

  get lastSession() {
    return this.sessions[this.sessions.length - 1] ?? null;
  }
}

// --- renderer.xr (three's WebXRManager surface) ------------------------------------------------------

function makeSpace(kind) {
  const g = new THREE.Group();
  g.name = `fake-${kind}`;
  g.matrixAutoUpdate = false;
  g.visible = false;
  g.hasLinearVelocity = false;
  g.linearVelocity = new THREE.Vector3();
  g.hasAngularVelocity = false;
  g.angularVelocity = new THREE.Vector3();
  if (kind === 'grip') g.eventsEnabled = false;
  return g;
}

/**
 * The parts of three r186's WebXRManager that XRMode uses, plus test controls: connect/disconnect input
 * sources, set rig-local poses (as the XR frame loop would), and fire select/squeeze events.
 */
export class FakeWebXRManager {
  constructor() {
    this.enabled = true;
    this.isPresenting = false;
    this.session = null;
    this.referenceSpaceType = 'local-floor';
    this.referenceSpaceCalls = [];
    this.setSessionCalls = [];
    this.setSessionError = null;
    this.slots = [];
    this.onSessionEnd = () => {
      // three's own 'end' handler (added in setSession, before anyone else's): drop every input source.
      for (let i = 0; i < this.slots.length; i++) if (this.slots[i]?.source) this.disconnect(i);
      this.session?.removeEventListener('end', this.onSessionEnd);
      this.session = null;
      this.isPresenting = false;
    };
  }

  slot(i) {
    return (this.slots[i] ??= { targetRay: makeSpace('target-ray'), grip: makeSpace('grip'), source: null });
  }

  getController(i) {
    return this.slot(i).targetRay;
  }

  getControllerGrip(i) {
    return this.slot(i).grip;
  }

  setReferenceSpaceType(type) {
    this.referenceSpaceCalls.push(type);
    this.referenceSpaceType = type;
    if (this.isPresenting) console.warn('THREE.WebXRManager: Cannot change reference space type while presenting.');
  }

  getReferenceSpace() {
    return this.session ? { type: this.referenceSpaceType } : null;
  }

  async setSession(session) {
    this.setSessionCalls.push(session);
    await null;
    if (this.setSessionError) throw this.setSessionError;
    if (session === null) return;
    this.session = session;
    session.addEventListener('end', this.onSessionEnd);
    this.isPresenting = true;
  }

  getSession() {
    return this.session;
  }

  #dispatch(i, event) {
    const s = this.slot(i);
    s.targetRay.dispatchEvent(event);
    s.grip.dispatchEvent(event);
  }

  /** An input source appears in slot i (three: 'inputsourceschange' -> controller.connect). */
  connect(i, source) {
    if (this.slot(i).source) this.disconnect(i);
    this.slot(i).source = source;
    this.#dispatch(i, { type: 'connected', data: source });
    return source;
  }

  disconnect(i) {
    const s = this.slot(i);
    const source = s.source;
    if (!source) return;
    s.source = null;
    this.#dispatch(i, { type: 'disconnected', data: source });
    s.targetRay.visible = false;
    s.grip.visible = false;
  }

  /** Fire an input event for slot i: 'selectstart' | 'selectend' | 'squeezestart' | 'squeezeend'. */
  fire(i, type) {
    const source = this.slot(i).source;
    this.#dispatch(i, { type, data: source });
    if (type === 'selectend') this.#dispatch(i, { type: 'select', data: source });
    if (type === 'squeezeend') this.#dispatch(i, { type: 'squeeze', data: source });
  }

  /**
   * Rig-local (reference space) pose of slot i, as XRFrame.getPose would give: both the target ray and the
   * grip get it. `lookAt` (rig-local point) orients -z toward it. `velocity` (rig-local m/s) is the
   * runtime's XRPose.linearVelocity; omit it for a runtime that does not report one.
   */
  pose(i, { position, lookAt = null, quaternion = null, velocity = null }) {
    const m = new THREE.Matrix4();
    if (lookAt) m.lookAt(position, lookAt, new THREE.Vector3(0, 1, 0));
    else if (quaternion) m.makeRotationFromQuaternion(quaternion);
    m.setPosition(position);
    const s = this.slot(i);
    for (const space of [s.targetRay, s.grip]) {
      space.matrix.copy(m);
      space.matrix.decompose(space.position, space.quaternion, space.scale);
      space.matrixWorldNeedsUpdate = true;
      space.visible = true;
      space.hasLinearVelocity = Boolean(velocity);
      if (velocity) space.linearVelocity.copy(velocity);
    }
  }

  /** Tracking lost for slot i (no pose this frame). */
  lose(i) {
    const s = this.slot(i);
    s.targetRay.visible = false;
    s.grip.visible = false;
  }
}

// --- input sources -------------------------------------------------------------------------------------

/** Quest Touch controller: xr-standard gamepad (trigger 0, squeeze 1, stick 3, A/X 4, B/Y 5; axes 2/3 = stick). */
export function touchController(handedness) {
  const pulses = [];
  return {
    handedness,
    targetRayMode: 'tracked-pointer',
    profiles: ['oculus-touch-v3', 'generic-trigger-squeeze-thumbstick'],
    hand: null,
    pulses,
    gamepad: {
      mapping: 'xr-standard',
      buttons: Array.from({ length: 7 }, () => ({ pressed: false, touched: false, value: 0 })),
      axes: [0, 0, 0, 0],
      hapticActuators: [{ pulse: (value, ms) => { pulses.push([value, ms]); return Promise.resolve(true); } }],
    },
  };
}

/** Tracked hand (hand-tracking): an XRHand, a pinch-only gamepad without axes, no haptics. */
export function trackedHand(handedness) {
  return {
    handedness,
    targetRayMode: 'tracked-pointer',
    profiles: ['generic-hand-select', 'generic-hand'],
    hand: new Map(),
    pulses: [],
    gamepad: { mapping: '', buttons: [{ pressed: false, touched: false, value: 0 }], axes: [] },
  };
}

// --- GameView (contract-shaped, see docs/DESIGN.md "GameView") ---------------------------------------

export function createFakeView(world) {
  return {
    calls: [],
    game: null,
    /** Every banana handed out: { mesh, geometry, material } as created (the view owns these). */
    bananas: [],
    setGame(game) {
      this.game = game;
    },
    onEvent() {},
    update() {},
    setPrefs() {},
    setXRScale(s) {
      this.calls.push(['setXRScale', s]);
      world.scale.setScalar(s);
      world.updateMatrixWorld(true);
    },
    setLocalPlayer(i) {
      this.calls.push(['setLocalPlayer', i]);
    },
    createBananaMesh() {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.2, 0.2), new THREE.MeshLambertMaterial({ color: 0xffd23a }));
      this.bananas.push({ mesh, geometry: mesh.geometry, material: mesh.material });
      return mesh;
    },
    monkeyAnchor(i, target = new THREE.Vector3()) {
      const m = this.game?.monkeys?.[i];
      target.set(m?.x ?? 0, m?.y ?? 0, 0);
      world.updateWorldMatrix(true, false);
      return world.localToWorld(target);
    },
    dispose() {},
    /** Arguments of every call to `name`, in order. */
    argsOf(name) {
      return this.calls.filter((c) => c[0] === name).map((c) => c[1]);
    },
  };
}

// --- the app (mirrors src/app/main.js) ---------------------------------------------------------------

export const TEST_SEED = 1234;
export const DEMO_SETTINGS = Object.freeze({
  demo: true,
  players: [{ name: 'Bongo', cpu: 'normal' }, { name: 'Mango', cpu: 'normal' }],
  targetScore: 2,
  windStrength: 'normal',
});
export const FRAME = 1 / 72;

/**
 * Wire an XRMode like main.js does: one scene with a `world` group, a fake view, prefs, startMatch that
 * forwards every game event, and a frame loop (game.update unless paused -> view -> xr.update -> "render",
 * where three copies the headset pose into xr.camera). Games get a fixed seed unless one is passed.
 * Every game's throwVelocity is wrapped to record its calls in app.throwCalls.
 */
export function createXRApp(env, { withView = true, prefs = { vrThrow: 'hand', lastSettings: null }, seed = TEST_SEED } = {}) {
  const manager = new FakeWebXRManager();
  const renderer = { xr: manager };
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  world.name = 'world';
  scene.add(world);
  const view = withView ? createFakeView(world) : null;
  const app = {
    env, manager, renderer, scene, world, view,
    game: null,
    paused: false,
    prefs,
    started: [],
    sessionChanges: [],
    pauses: [],
    sounds: [],
    events: [],
    throwCalls: [],
    head: new THREE.Vector3(0.3, 1.62, -0.2),
    headQuat: new THREE.Quaternion(),
    frames: 0,
  };

  app.startMatch = (settings = {}) => {
    app.game?.destroy();
    app.paused = false;
    app.started.push(settings);
    const game = new Game({ ...settings, seed: settings.seed ?? seed });
    const throwVelocity = game.throwVelocity.bind(game);
    game.throwVelocity = (vx, vy, origin) => {
      const call = { player: game.turn, vx, vy, origin: origin ? { x: origin.x, y: origin.y } : origin, ok: false };
      app.throwCalls.push(call);
      call.ok = throwVelocity(vx, vy, origin);
      return call.ok;
    };
    app.game = game;
    game.onAny((type, payload) => {
      app.events.push({ type, payload, game, frame: app.frames });
      view?.onEvent(type, payload, game);
      app.xr.onEvent(type, payload, game);
    });
    view?.setGame(game);
    app.xr.setGame(game);
    game.start();
    return game;
  };
  app.startDemo = () => app.startMatch(DEMO_SETTINGS);

  app.xr = new XRMode({
    renderer, scene, world, view,
    sfx: { play: (name) => app.sounds.push(name) },
    getPrefs: () => app.prefs,
    setPrefs: (next) => {
      app.prefs = next;
      app.xr.setPrefs(next);
    },
    startMatch: (settings) => app.startMatch(settings),
    quitToTitle: () => app.startDemo(),
    setPaused: (value) => {
      app.paused = Boolean(value);
      app.pauses.push(Boolean(value));
    },
    onSessionChange: (active) => {
      app.paused = false;
      app.sessionChanges.push(active);
    },
  });
  app.xr.setPrefs(app.prefs);

  /** One animation frame. `input` runs at the start of the frame, where the browser fires XR input events. */
  app.frame = (dt = FRAME, input = null) => {
    env.clock.advance(dt);
    app.frames += 1;
    input?.();
    const game = app.game;
    if (game && !app.paused) game.update(dt);
    if (app.game?.isDemo && app.game.phase === 'matchOver') app.startDemo();
    view?.update(dt, app.game);
    if (app.xr.active) app.xr.update(dt, {}, app.game);
    if (app.xr.active) {
      app.xr.camera.position.copy(app.head);
      app.xr.camera.quaternion.copy(app.headQuat);
    }
    app.scene.updateMatrixWorld(true);
  };
  app.run = (frames, dt = FRAME) => {
    for (let i = 0; i < frames; i++) app.frame(dt);
  };
  /** Run frames until pred() holds; throws after maxSeconds of simulated time. */
  app.runUntil = (pred, { maxSeconds = 60, dt = FRAME, label = 'condition', each = null } = {}) => {
    const limit = Math.ceil(maxSeconds / dt);
    for (let i = 0; i <= limit; i++) {
      if (pred()) return i;
      app.frame(dt);
      each?.();
    }
    throw new Error(`timed out after ${maxSeconds}s of simulated time waiting for ${label}`);
  };
  app.eventsOf = (type, from = 0) => app.events.slice(from).filter((e) => e.type === type);
  return app;
}

// --- geometry helpers ----------------------------------------------------------------------------------

/** Scene position of the center of a panel button (from the buttons the panel registered when it drew). */
export function buttonCenter(panel, id) {
  const b = panel.buttons.find((x) => x.id === id);
  if (!b) throw new Error(`panel ${panel.mesh.name} has no '${id}' button (has: ${panel.buttons.map((x) => x.id).join(', ')})`);
  const { width, height } = panel.mesh.geometry.parameters;
  const u = (b.x + b.w / 2) / panel.width;
  const v = 1 - (b.y + b.h / 2) / panel.height;
  panel.mesh.updateWorldMatrix(true, false);
  return panel.mesh.localToWorld(new THREE.Vector3((u - 0.5) * width, (v - 0.5) * height, 0));
}

/** Point controller `i` (held at chest height, rig-local) at a scene position. */
export function pointAt(app, i, scenePoint) {
  const rig = app.xr.rig;
  rig.updateWorldMatrix(true, false);
  const target = rig.worldToLocal(scenePoint.clone());
  const hand = new THREE.Vector3(app.head.x + (i === 1 ? -0.2 : 0.2), 1.2, app.head.z - 0.25);
  app.manager.pose(i, { position: hand, lookAt: target });
}

/** Rig forward (-z) in scene coordinates, horizontal. */
export function rigForward(rig) {
  rig.updateWorldMatrix(true, false);
  const q = rig.getWorldQuaternion(new THREE.Quaternion());
  return new THREE.Vector3(0, 0, -1).applyQuaternion(q);
}

/** Headset position in scene coordinates (the camera is a child of the rig). */
export function headInScene(app) {
  app.xr.rig.updateWorldMatrix(true, false);
  return app.xr.rig.localToWorld(app.head.clone());
}
