// PC input helpers: drag-to-aim on the canvas, typing detection, and the audio-unlock gesture hook.
import { DRAG_MIN, aimFromDrag } from './settings.js';

const finitePoint = (p) => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y);

const TEXT_TYPES = new Set(['text', 'number', 'search', 'email', 'url', 'tel', 'password']);

/** True while the user types into a field: game keys are ignored then (except Enter/Esc). */
export function isTextEntry(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && TEXT_TYPES.has(String(t.type || 'text').toLowerCase());
}

/** True for controls that use the arrow keys themselves (sliders, radio groups, fields). */
export function usesArrows(t) {
  const tag = t?.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
}

/** True for elements that Space/Enter activate natively (buttons, checkboxes, radios). */
export function activatesNatively(t) {
  if (!t || typeof t !== 'object') return false;
  if (t.tagName === 'BUTTON' || t.getAttribute?.('role') === 'button') return true;
  return t.tagName === 'INPUT' && (t.type === 'checkbox' || t.type === 'radio');
}

/**
 * Call `fn` on early user gestures (so an AudioContext can be resumed) and stop after the first one
 * that grants user activation in every browser. `fn` may run 1-3 times, so it must be idempotent.
 * @returns {() => void} dispose
 */
export function onUserGesture(fn, target = globalThis.window) {
  if (!target?.addEventListener) return () => {};
  const types = ['pointerdown', 'pointerup', 'touchend', 'keydown', 'click'];
  const opts = { capture: true, passive: true };
  const activates = (e) => {
    if (e.type === 'pointerdown') return e.pointerType === 'mouse';
    if (e.type === 'pointerup') return e.pointerType !== 'mouse';
    if (e.type === 'keydown') return e.key !== 'Escape';
    return true;
  };
  const handler = (e) => {
    try {
      fn();
    } catch (err) {
      console.warn('[ui] unlockAudio failed', err);
    }
    if (activates(e)) dispose();
  };
  const dispose = () => types.forEach((t) => target.removeEventListener(t, handler, opts));
  types.forEach((t) => target.addEventListener(t, handler, opts));
  return dispose;
}

/**
 * Drag on the canvas to aim: the vector from the thrower's hand to the pointer (in world units, so zoom does
 * not matter) sets angle and power while dragging; releasing throws. Moving less than DRAG_MIN world units
 * is a click and does nothing. Esc (via cancel()), right-click, pointercancel or losing the turn cancels and
 * restores the aim from before the drag.
 */
export class PointerAim {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement|null} o.canvas
   * @param {() => object|null} o.getGame          the game when the local human may aim right now, else null
   * @param {(px: number, py: number) => {x: number, y: number}|null} o.screenToWorld  canvas CSS px -> world
   * @param {(x: number, y: number, z: number) => {x: number, y: number}|null} o.worldToScreen  world -> canvas CSS px
   * @param {(guide: object|null) => void} [o.onGuide]   drag guide in client px, null to hide
   * @param {(e: PointerEvent) => void} [o.onPress]     any pointerdown on the canvas
   */
  constructor({ canvas, getGame, screenToWorld, worldToScreen, onGuide, onPress }) {
    this.canvas = canvas ?? null;
    this.getGame = getGame;
    this.screenToWorld = screenToWorld;
    this.worldToScreen = worldToScreen;
    this.onGuide = onGuide ?? (() => {});
    this.onPress = onPress ?? (() => {});
    this.drag = null;
    this.listeners = [];
    if (this.canvas?.addEventListener) {
      this.#listen(this.canvas, 'pointerdown', this.#down);
      this.#listen(this.canvas, 'pointermove', this.#move);
      this.#listen(this.canvas, 'pointerup', this.#up);
      this.#listen(this.canvas, 'pointercancel', this.#lost);
      this.#listen(this.canvas, 'lostpointercapture', this.#lost);
      this.#listen(this.canvas, 'contextmenu', this.#context);
    }
    if (globalThis.window?.addEventListener) this.#listen(globalThis.window, 'blur', () => this.cancel());
  }

  get dragging() {
    return this.drag !== null;
  }

  /** Per frame: drop the drag if aiming is no longer allowed (menu opened, turn changed). */
  update() {
    if (this.drag && !this.#valid(this.drag)) this.cancel();
  }

  /** End the drag; with `restore`, put back the aim from before it started. */
  cancel(restore = true) {
    const d = this.drag;
    if (!d) return;
    this.#end();
    if (restore && d.armed && d.game.phase === 'aim' && d.game.turn === d.turn) {
      d.game.setAim(d.turn, d.prev.angle, d.prev.power);
    }
  }

  dispose() {
    this.cancel(false);
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
    this.listeners = [];
  }

  #listen(target, type, fn) {
    const safe = (e) => {
      try {
        fn(e);
      } catch (err) {
        console.error(`[ui] ${type} handler failed`, err);
      }
    };
    target.addEventListener(type, safe);
    this.listeners.push([target, type, safe]);
  }

  #down = (e) => {
    this.onPress(e);
    if (this.drag) {
      if (e.button === 2) this.cancel();
      return;
    }
    if (e.button !== 0 || e.isPrimary === false) return;
    const game = this.getGame();
    if (!game) return;
    const start = this.#world(e);
    if (!finitePoint(start)) return;
    const turn = game.turn;
    this.drag = { id: e.pointerId, game, turn, prev: { ...game.aim[turn] }, start, armed: false, last: null };
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; the drag still works while the pointer stays over the canvas.
    }
    e.preventDefault();
  };

  #move = (e) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (e.buttons & 2) {
      this.cancel(); // right button pressed during a left-button drag
      return;
    }
    if (!this.#valid(d)) {
      this.cancel();
      return;
    }
    const point = this.#world(e);
    if (!finitePoint(point)) return;
    if (!d.armed && Math.hypot(point.x - d.start.x, point.y - d.start.y) >= DRAG_MIN) d.armed = true;
    if (!d.armed) return;
    const monkey = d.game.monkeys[d.turn];
    const hand = d.game.handPosition(d.turn);
    const aim = aimFromDrag(hand, point, monkey?.facing ?? 1);
    const angle = Math.round(aim.angle);
    const power = Math.round(aim.power);
    if (!d.last || d.last.angle !== angle || d.last.power !== power) {
      d.game.setAim(d.turn, angle, power);
      d.last = { angle, power };
    }
    this.#guide(d, hand, e, angle, power);
  };

  #up = (e) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const throwIt = d.armed && this.#valid(d);
    this.#end();
    if (throwIt) d.game.throwShot(d.game.aim[d.turn]);
  };

  #lost = (e) => {
    if (this.drag && e.pointerId === this.drag.id) this.cancel();
  };

  #context = (e) => {
    e.preventDefault(); // right-click cancels a drag; the canvas has no useful context menu anyway
    this.cancel();
  };

  #end() {
    const d = this.drag;
    this.drag = null;
    try {
      if (this.canvas?.hasPointerCapture?.(d.id)) this.canvas.releasePointerCapture(d.id);
    } catch {
      // Already released.
    }
    this.onGuide(null);
  }

  #valid(d) {
    const game = this.getGame();
    return game === d.game && game.turn === d.turn;
  }

  #world(e) {
    const rect = this.canvas.getBoundingClientRect();
    try {
      return this.screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    } catch {
      return null;
    }
  }

  #guide(d, hand, e, angle, power) {
    let s = null;
    try {
      s = this.worldToScreen(hand.x, hand.y, 0);
    } catch {
      s = null;
    }
    if (!finitePoint(s)) return;
    const rect = this.canvas.getBoundingClientRect();
    this.onGuide({ x0: s.x + rect.left, y0: s.y + rect.top, x1: e.clientX, y1: e.clientY, angle, power, turn: d.turn });
  }
}
