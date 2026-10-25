// Banana Skyline sound: every effect, jingle and loop is synthesized with Web Audio (no audio files).
// Contract: docs/DESIGN.md "Sfx". All public methods are no-ops before unlock() or without Web Audio,
// and none of them throw.

import { CRATER_RADIUS, FALL_GRAVITY, MAX_POWER, POWER_TO_SPEED } from '../core/constants.js';
import { AudioEngine, clamp, panForX } from './engine.js';
import { Ambience, Whistle } from './loops.js';
import { SONGS, playSong } from './music.js';
import * as R from './recipes.js';

const MAX_SPEED = MAX_POWER * POWER_TO_SPEED;
const FROZEN_BANANA = 0.15; // seconds without banana movement (game paused) before the whistle stops
const MAX_WARNINGS = 5;
const MAX_LOOP_ERRORS = 3;

// name -> [recipe(voice, t, options), bus, kind]. kind 'music' is faded out when the match changes.
const SOUNDS = {
  click: [R.click],
  hover: [R.hover],
  error: [R.error],
  throw: [R.throwSound],
  whoosh: [R.whoosh],
  hup: [R.hup],
  explosion: [R.explosion],
  bigExplosion: [R.bigExplosion],
  debris: [R.debris],
  groundHit: [R.groundHit],
  yelp: [R.yelp],
  boing: [R.boing],
  slideWhistle: [R.slideWhistle],
  thump: [R.thump],
  tick: [R.tick],
  blip: [R.blip],
  swell: [R.swell, 'ambience'],
  gust: [R.gust, 'ambience'],
  victoryA: [(v, t) => playSong(v, t, SONGS.victoryA), 'music', 'music'],
  victoryB: [(v, t) => playSong(v, t, SONGS.victoryB), 'music', 'music'],
  fanfare: [(v, t) => playSong(v, t, SONGS.fanfare), 'music', 'music'],
};

/** Names accepted by Sfx.play(). The UI uses 'click', 'hover' and 'error'. */
export const SOUND_NAMES = Object.freeze(Object.keys(SOUNDS));

export class Sfx {
  #engine = new AudioEngine();
  #enabled = true;
  #volume = 0.8;
  #panWidth = 0.8;
  #ambience = null;
  #whistle = null;
  #game = null;
  #yelpAt = [-Infinity, -Infinity];
  #hoverAt = -Infinity;
  #bananaT = -1;
  #frozen = 0;
  #warnings = 0;
  #loopErrors = 0;

  /** True when sounds can play: unlocked, context running, and enabled. */
  get ready() {
    return this.#enabled && this.#engine.running;
  }

  /** @returns {boolean} */
  get enabled() {
    return this.#enabled;
  }

  /** @returns {number} 0..1 */
  get volume() {
    return this.#volume;
  }

  /**
   * Create (first call) and resume the AudioContext. Call from a user gesture; safe to call repeatedly.
   * @returns {boolean} false when Web Audio is unavailable
   */
  unlock() {
    try {
      const ok = this.#engine.init(this.#level());
      if (ok) this.#engine.resume();
      return ok;
    } catch (err) {
      this.#warn('unlock', err);
      return false;
    }
  }

  /**
   * Mute (false) or unmute (true). Muting ramps the master down and stops loops and playing sounds.
   * @param {boolean} on
   */
  setEnabled(on) {
    this.#enabled = Boolean(on);
    try {
      this.#engine.setLevel(this.#level());
      if (!this.#enabled) {
        this.#stopLoops(0.1);
        this.#engine.stopAll(null, 0.1);
      }
    } catch (err) {
      this.#warn('setEnabled', err);
    }
  }

  /**
   * Master volume 0..1 (ramped; perceptual curve).
   * @param {number} value
   */
  setVolume(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    this.#volume = clamp(n, 0, 1);
    try {
      this.#engine.setLevel(this.#level());
    } catch (err) {
      this.#warn('setVolume', err);
    }
  }

  /**
   * How wide event sounds are panned by world x (0 = mono, default 0.8). In VR, where the city is in front
   * of the player rather than side-on, a small width (about 0.25) sounds more natural.
   * @param {number} width 0..1
   */
  setPanWidth(width) {
    const n = Number(width);
    if (Number.isFinite(n)) this.#panWidth = clamp(n, 0, 1);
  }

  /**
   * Play a named sound now (see SOUND_NAMES; the UI uses 'click', 'hover', 'error').
   * @param {string} name
   * @param {{pan?: number, x?: number, delay?: number}} [options] pan -1..1, or x = world x to pan from
   */
  play(name, options = {}) {
    try {
      const o = options ?? {};
      if (name === 'hover') {
        const now = this.#engine.now;
        if (now - this.#hoverAt < 0.05) return;
        this.#hoverAt = now;
      }
      const pan = Number.isFinite(o.x) ? panForX(o.x, this.#panWidth) : o.pan;
      this.#sound(name, { ...o, pan });
    } catch (err) {
      this.#warn(`play:${name}`, err);
    }
  }

  /**
   * React to a game event (see the event table in docs/DESIGN.md). Demo games are ignored.
   * @param {string} type
   * @param {object} payload
   * @param {object} [game]
   */
  onEvent(type, payload, game) {
    try {
      this.#watch(game);
      if (game?.isDemo || !this.ready) return;
      this.#react(type, payload ?? {}, game);
    } catch (err) {
      this.#warn(`onEvent:${type}`, err);
    }
  }

  /**
   * Per frame: wind ambience follows |game.wind|, the banana whistle follows the banana.
   * @param {number} dt seconds
   * @param {object} [game]
   */
  update(dt, game) {
    try {
      this.#watch(game);
      const engine = this.#engine;
      if (!engine.ctx) return;
      const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
      engine.recover(step);
      engine.sweep();
      const now = engine.now;
      const active = this.ready && Boolean(game) && !game.isDemo;

      if (active && game.city) {
        this.#ambience ??= this.#makeLoop(Ambience);
        this.#ambience?.update(game.wind, now);
      } else if (this.#ambience) {
        this.#ambience.stop();
        this.#ambience = null;
      }

      const banana = active && game.phase === 'flight' ? game.banana : null;
      if (banana && this.#bananaMoving(banana, step)) {
        this.#whistle ??= this.#makeLoop(Whistle);
        this.#whistle?.update(banana, now, this.#panWidth);
      } else if (this.#whistle) {
        this.#whistle.stop();
        this.#whistle = null;
      }
    } catch (err) {
      this.#warn('update', err);
    }
  }

  /** Stop everything and close the AudioContext. */
  dispose() {
    try {
      this.#stopLoops(0);
      this.#engine.close();
    } catch (err) {
      this.#warn('dispose', err);
    }
  }

  // ---- internals ----

  #level() {
    return this.#enabled ? this.#volume ** 2 : 0;
  }

  #pan(x) {
    return panForX(x, this.#panWidth);
  }

  #sound(name, { pan = 0, delay = 0, ...options } = {}) {
    if (!this.ready) return;
    const entry = Object.hasOwn(SOUNDS, name) ? SOUNDS[name] : null;
    if (!entry) return;
    const [recipe, bus = 'sfx', kind = 'sfx'] = entry;
    const v = this.#engine.voice({ bus, kind, pan: clamp(Number(pan) || 0, -1, 1) });
    try {
      recipe(v, v.t0 + clamp(Number(delay) || 0, 0, 2), options);
    } catch (err) {
      v.stop(0.02);
      throw err;
    }
  }

  // A new game object (new match or back to the demo): fade leftover music, reset per-match state.
  #watch(game) {
    if (!game || game === this.#game) return;
    this.#game = game;
    this.#yelpAt = [-Infinity, -Infinity];
    this.#bananaT = -1;
    this.#frozen = 0;
    if (!this.#engine.ctx) return;
    this.#engine.stopAll('music', 0.3);
    this.#whistle?.stop();
    this.#whistle = null;
  }

  #bananaMoving(b, dt) {
    if (!Number.isFinite(b.vx) || !Number.isFinite(b.vy)) return false;
    if (b.t === this.#bananaT) {
      this.#frozen += dt;
    } else {
      this.#frozen = 0;
      this.#bananaT = b.t;
    }
    return this.#frozen < FROZEN_BANANA;
  }

  // Build a loop; after a few failures stop retrying so a broken browser feature cannot cost every frame.
  #makeLoop(Kind) {
    if (this.#loopErrors >= MAX_LOOP_ERRORS) return null;
    try {
      return new Kind(this.#engine);
    } catch (err) {
      this.#loopErrors += 1;
      this.#warn(`loop:${Kind.name}`, err);
      return null;
    }
  }

  #stopLoops(fade) {
    this.#ambience?.stop(fade);
    this.#whistle?.stop(fade);
    this.#ambience = null;
    this.#whistle = null;
  }

  #react(type, p, game) {
    const monkeyX = (i) => game?.monkeys?.[i]?.x;
    switch (type) {
      case 'roundStart':
        this.#sound('swell');
        break;
      case 'turn':
        this.#sound('tick', { soft: Boolean(p.cpu), pan: this.#pan(monkeyX(p.player)) });
        break;
      case 'cpuThinking':
        this.#sound('blip', { delay: 0.3, pan: this.#pan(monkeyX(p.player)) });
        break;
      case 'wind':
        this.#sound('gust', { pan: Math.sign(Number(p.wind) || 0) * this.#panWidth * 0.6 });
        break;
      case 'throw': {
        const speed = Math.hypot(p.vx, p.vy);
        this.#sound('throw', {
          intensity: Number.isFinite(speed) ? speed / MAX_SPEED : 0.5,
          pitch: p.player === 1 ? 1.12 : 1,
          pan: this.#pan(p.x),
        });
        break;
      }
      case 'sunHit':
        this.#sound('boing', { pan: this.#pan(p.x) });
        break;
      case 'impact':
        this.#impact(p, game);
        break;
      case 'crater': {
        const n = Array.isArray(p.removed) ? p.removed.length : 0;
        if (n > 0) this.#sound('debris', { count: 2 + n / 4, pan: this.#pan(p.x) });
        break;
      }
      case 'monkeyHit':
        this.#yelp(p.victim, game, 0.25);
        break;
      case 'monkeyFall': {
        const h = Math.max(0, (Number(p.fromY) || 0) - (Number(p.toY) || 0));
        this.#sound('slideWhistle', { dur: Math.sqrt((2 * h) / FALL_GRAVITY), pan: this.#pan(monkeyX(p.player)) });
        break;
      }
      case 'monkeyLand':
        this.#sound('thump', { pan: this.#pan(monkeyX(p.player)) });
        break;
      case 'roundOver':
        this.#sound((game?.round ?? 1) % 2 ? 'victoryA' : 'victoryB', { delay: 0.05 });
        break;
      case 'matchOver':
        this.#engine.stopAll('music', 0.15);
        this.#sound('fanfare', { delay: 0.1 });
        break;
      default:
        break;
    }
  }

  #impact(p, game) {
    const pan = this.#pan(p.x);
    switch (p.kind) {
      case 'building':
        this.#sound('explosion', { size: (Number(p.radius) || CRATER_RADIUS) / CRATER_RADIUS, pan });
        break;
      case 'ground':
        this.#sound('groundHit', { pan });
        break;
      case 'monkey':
        this.#sound('bigExplosion', { pan });
        this.#yelp(p.victim, game, 0.25);
        break;
      default:
        break; // 'out': the banana simply leaves the city
    }
  }

  // One yelp per victim even though both `impact` and `monkeyHit` report the hit.
  #yelp(victim, game, delay) {
    if (victim !== 0 && victim !== 1) return;
    const now = this.#engine.now;
    if (now - this.#yelpAt[victim] < 0.6) return;
    this.#yelpAt[victim] = now;
    this.#sound('yelp', { delay, pitch: victim === 1 ? 1.1 : 1, pan: this.#pan(game?.monkeys?.[victim]?.x) });
  }

  #warn(where, err) {
    if (this.#warnings >= MAX_WARNINGS) return;
    this.#warnings += 1;
    try { globalThis.console?.warn?.(`[sfx] ${where}:`, err); } catch { /* ignore */ }
  }
}
