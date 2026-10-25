// Fakes and helpers for tests/render.test.mjs (not a test file itself: only tests/*.test.mjs are run).
// They let the three.js view and camera run in Node without WebGL, a DOM or a headset:
//   - fakeRenderer(): the parts of THREE.WebGLRenderer the render module touches (shadowMap, pixel ratio, renderer.xr),
//   - installFakeCanvasDocument(): document.createElement('canvas') with a strict 2D context (the sky draws the
//     sun/moon faces on canvases); it throws where a browser throws and records what a browser silently ignores,
//   - installSeededRandom(), installSimClock(): make Math.random and performance.now deterministic,
//   - captureConsole(): collect console.error / console.warn output (the view reports caught errors there).
// Every install* function returns a restore function; call it from an after() hook.
import * as THREE from 'three';

/** Replace Math.random with a seeded generator (mulberry32). */
export function installSeededRandom(seed = 1) {
  const original = Math.random;
  let s = seed >>> 0;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    Math.random = original;
  };
}

/**
 * Replace performance.now with a clock that only moves when advance(dt) is called. The core game spends a
 * wall-clock budget per frame planning CPU shots; with a simulated clock every plan finishes in the frame it
 * starts, so CPU matches play out identically on any machine.
 */
export function installSimClock() {
  const own = Object.getOwnPropertyDescriptor(performance, 'now');
  let ms = 0;
  Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => ms });
  return {
    advance(seconds) {
      ms += seconds * 1000;
    },
    restore() {
      if (own) Object.defineProperty(performance, 'now', own);
      else delete performance.now;
    },
  };
}

/** Collect console.error and console.warn calls (still silent on the terminal). */
export function captureConsole() {
  const original = { error: console.error, warn: console.warn };
  const messages = [];
  const grab = (level) => (...args) => {
    messages.push(`${level}: ${args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join(' ')}`);
  };
  console.error = grab('error');
  console.warn = grab('warn');
  return {
    messages,
    /** Messages logged since the last take(). */
    take() {
      return messages.splice(0, messages.length);
    },
    restore() {
      console.error = original.error;
      console.warn = original.warn;
    },
  };
}

/**
 * The parts of a WebGLRenderer that GameView uses. `renderer.xr` mimics WebXRManager: while presenting,
 * getCamera() returns the XR camera whose matrixWorld WebXR wrote for this frame (its position/quaternion fields
 * stay at the origin, as on the real ArrayCamera, so code must read matrixWorld).
 */
export function fakeRenderer({ shadows = true, presenting = false, pixelRatio = 2 } = {}) {
  const xrCamera = new THREE.PerspectiveCamera();
  xrCamera.matrixWorld.identity();
  const renderer = {
    getPixelRatio: () => pixelRatio,
    xr: {
      enabled: true,
      isPresenting: presenting,
      getCamera: () => xrCamera,
    },
    /** Put the headset at a point in scene coordinates (meters, after the world scale). */
    setHeadset(x, y, z = 0) {
      xrCamera.matrixWorld.makeTranslation(x, y, z);
    },
  };
  if (shadows) renderer.shadowMap = { enabled: false, type: THREE.BasicShadowMap };
  return renderer;
}

// Canvas colors the sky uses: #rgb/#rrggbb, rgb()/rgba() with numbers. Anything else would be ignored by a browser.
const COLOR_RE = /^(#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i;

class IndexSizeError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'IndexSizeError';
  }
}

class FakeGradient {
  constructor(ctx) {
    this.ctx = ctx;
    this.stops = [];
  }

  addColorStop(offset, color) {
    if (!Number.isFinite(offset)) throw new TypeError(`addColorStop: non-finite offset ${offset}`);
    if (offset < 0 || offset > 1) throw new IndexSizeError(`addColorStop: offset ${offset} outside [0, 1]`);
    if (!COLOR_RE.test(String(color))) throw new SyntaxError(`addColorStop: unparsable color ${color}`);
    this.stops.push([offset, color]);
  }
}

/** A strict CanvasRenderingContext2D stand-in: validates arguments, counts calls, records ignored input. */
export class FakeContext2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = 0;
    this.ignored = []; // input a browser would silently drop (non-finite numbers, bad colors)
    this._fill = '#000000';
    this._stroke = '#000000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this.globalAlpha = 1;
  }

  get fillStyle() { return this._fill; }
  set fillStyle(v) { this._setStyle('fillStyle', v); }
  get strokeStyle() { return this._stroke; }
  set strokeStyle(v) { this._setStyle('strokeStyle', v); }

  _setStyle(name, v) {
    if (v instanceof FakeGradient) {
      if (v.ctx !== this) this.ignored.push(`${name}: gradient from another context`);
    } else if (!COLOR_RE.test(String(v))) {
      this.ignored.push(`${name}: ${v}`);
      return;
    }
    if (name === 'fillStyle') this._fill = v;
    else this._stroke = v;
  }

  _nums(name, args) {
    this.calls++;
    if (!args.every(Number.isFinite)) this.ignored.push(`${name}(${args.join(', ')})`);
  }

  clearRect(...a) { this._nums('clearRect', a); }
  fillRect(...a) { this._nums('fillRect', a); }
  beginPath() { this.calls++; }
  closePath() { this.calls++; }
  moveTo(...a) { this._nums('moveTo', a); }
  lineTo(...a) { this._nums('lineTo', a); }
  fill() { this.calls++; }
  stroke() { this.calls++; }
  save() { this.calls++; }
  restore() { this.calls++; }

  arc(x, y, r, a0, a1, ccw = false) {
    this._nums('arc', [x, y, r, a0, a1]);
    if (r < 0) throw new IndexSizeError(`arc: negative radius ${r}`);
    void ccw;
  }

  ellipse(x, y, rx, ry, rot, a0, a1, ccw = false) {
    this._nums('ellipse', [x, y, rx, ry, rot, a0, a1]);
    if (rx < 0 || ry < 0) throw new IndexSizeError(`ellipse: negative radius ${rx}, ${ry}`);
    void ccw;
  }

  createRadialGradient(x0, y0, r0, x1, y1, r1) {
    this.calls++;
    const a = [x0, y0, r0, x1, y1, r1];
    if (!a.every(Number.isFinite)) throw new TypeError(`createRadialGradient: non-finite argument (${a.join(', ')})`);
    if (r0 < 0 || r1 < 0) throw new IndexSizeError(`createRadialGradient: negative radius ${r0}, ${r1}`);
    return new FakeGradient(this);
  }

  createLinearGradient(x0, y0, x1, y1) {
    this.calls++;
    const a = [x0, y0, x1, y1];
    if (!a.every(Number.isFinite)) throw new TypeError(`createLinearGradient: non-finite argument (${a.join(', ')})`);
    return new FakeGradient(this);
  }
}

export class FakeCanvas {
  constructor() {
    this.width = 300;
    this.height = 150;
    this.nodeName = 'CANVAS';
    this.context = null;
  }

  getContext(type) {
    if (type !== '2d') return null;
    this.context ??= new FakeContext2D(this);
    return this.context;
  }
}

/**
 * Install a minimal `document` whose createElement('canvas') returns FakeCanvas. Returns
 * { canvases, restore } where canvases lists every canvas created (in order).
 */
export function installFakeCanvasDocument() {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const previous = globalThis.document;
  const canvases = [];
  globalThis.document = {
    createElement(tag) {
      if (String(tag).toLowerCase() !== 'canvas') throw new Error(`fake document: createElement(${tag}) not supported`);
      const c = new FakeCanvas();
      canvases.push(c);
      return c;
    },
  };
  return {
    canvases,
    restore() {
      if (had) globalThis.document = previous;
      else delete globalThis.document;
    },
  };
}
