// Web Audio plumbing for the synthesized sound effects: a lazily created AudioContext, a master chain
// (buses -> mix -> warmth shelf -> limiter -> volume -> speakers), one shared noise buffer, and Voice,
// a sound that owns its nodes and disconnects them when its sources end.
// Nothing here touches browser globals until AudioEngine.init() runs (on a user gesture).

import { CITY_WIDTH } from '../core/constants.js';

export const FLOOR = 1e-4;          // "silence" for exponential ramps, which cannot reach 0
const START_LEAD = 0.01;            // schedule slightly ahead so attacks are never clipped
const MAX_VOICES = 28;              // one-shot voices alive at once (loops are not counted)
const NOISE_SECONDS = 2;
const BUS_LEVELS = { sfx: 0.9, music: 0.55, ambience: 0.8 };
const MIX_LEVEL = 0.6;              // headroom: the limiter adds makeup gain
const RETRY = 1.5;                  // seconds between attempts to resume a context the system suspended

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const positive = (v) => Math.max(FLOOR, v);

/**
 * Stereo position for a world x (city spans 0..CITY_WIDTH): -width at the left edge, +width at the right.
 * @param {number} x
 * @param {number} [width=0.8]
 * @returns {number}
 */
export function panForX(x, width = 0.8) {
  if (!Number.isFinite(x)) return 0;
  return clamp((x / CITY_WIDTH) * 2 - 1, -1, 1) * width;
}

// ---- envelope helpers (operate on AudioParams) ----

/** Linear attack to `peak`, then exponential decay to silence. */
export function pluck(param, t, peak, attack, decay) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.exponentialRampToValueAtTime(FLOOR, t + attack + decay);
}

/** Linear attack, hold at `peak`, exponential release. */
export function hold(param, t, peak, attack, sustain, release) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setValueAtTime(peak, t + attack + sustain);
  param.exponentialRampToValueAtTime(FLOOR, t + attack + sustain + release);
}

/** Exponential glide through points [[timeOffset, value], ...] starting at t. */
export function glide(param, t, points) {
  points.forEach(([dt, value], i) => {
    if (i === 0) param.setValueAtTime(positive(value), t + dt);
    else param.exponentialRampToValueAtTime(positive(value), t + Math.max(dt, 0.001));
  });
}

/** Smoothly move a param toward `value` from `now`; replaces anything scheduled later. */
export function steer(param, value, now, tau = 0.05) {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tau);
}

// A few sharp, randomly spaced spikes: the crackle of an explosion.
export function crackle(param, t, count, level, span) {
  let tt = t;
  for (let i = 0; i < count && tt < t + span; i++) {
    param.setValueAtTime(level * (i === 0 ? 1 : 0.35 + 0.5 * Math.random()), tt);
    param.exponentialRampToValueAtTime(FLOOR, tt + 0.03);
    tt += 0.035 + Math.random() * 0.05;
  }
}

/**
 * One sound: an output gain (optionally panned) on a bus, plus every node the sound creates.
 * When all of its sources have ended it disconnects everything and leaves the engine.
 */
export class Voice {
  constructor(engine, dest, { pan = 0, gain = 1, kind = 'sfx', pannable = false } = {}) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.ctx = ctx;
    this.kind = kind;
    this.nodes = [];
    this.sources = [];
    this.ends = [];     // scheduled stop time per source (Infinity = runs until the voice is stopped)
    this.live = 0;
    this.endTime = 0;
    this.stopAt = Infinity;
    this.disposed = false;
    this.t0 = ctx.currentTime + START_LEAD;
    this.out = this.node(ctx.createGain());
    this.out.gain.value = gain;
    this.panNode = null;
    if ((pannable || Math.abs(pan) > 0.01) && typeof ctx.createStereoPanner === 'function') {
      this.panNode = this.node(ctx.createStereoPanner());
      this.panNode.pan.value = clamp(pan, -1, 1);
      this.out.connect(this.panNode);
      this.panNode.connect(dest);
    } else {
      this.out.connect(dest);
    }
  }

  node(n) {
    this.nodes.push(n);
    return n;
  }

  /** A GainNode connected to `dest` (default: the voice output). */
  gain(value = 0, dest = this.out) {
    const g = this.node(this.ctx.createGain());
    g.gain.value = value;
    g.connect(dest);
    return g;
  }

  /** A BiquadFilterNode connected to `dest`. */
  filter(type, frequency, Q = 1, dest = this.out) {
    const f = this.node(this.ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    f.connect(dest);
    return f;
  }

  /** An oscillator playing from `start` until `stop` (null = until the voice is stopped). */
  osc(type, frequency, start, stop, dest = this.out) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = frequency;
    o.connect(dest);
    this.#play(o, start, stop);
    return o;
  }

  /** Looping white noise from the shared buffer, starting at a random offset. */
  noise(start, stop, dest = this.out) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.engine.noiseBuffer;
    s.loop = true;
    s.connect(dest);
    this.#play(s, start, stop, Math.random() * (NOISE_SECONDS - 0.2));
    return s;
  }

  /** A sine LFO whose output (scaled by `depth`) is added to each target AudioParam. Returns the depth gain. */
  lfo(frequency, targets, start, stop, depth = 0) {
    const d = this.node(this.ctx.createGain());
    d.gain.value = depth;
    for (const p of targets) d.connect(p);
    this.osc('sine', frequency, start, stop, d);
    return d;
  }

  #play(src, start, stop, offset = 0) {
    this.node(src);
    this.sources.push(src);
    this.live += 1;
    src.onended = () => {
      this.live -= 1;
      if (this.live <= 0) this.dispose();
    };
    src.start(Math.max(start, 0), offset);
    let end = Infinity;
    if (stop != null) {
      end = Math.max(stop, start + 0.001);
      src.stop(end);
    }
    this.ends.push(end);
    this.endTime = Math.max(this.endTime, end);
  }

  /** Fade out over `fade` seconds and stop every source. A later call can only make the fade shorter. */
  stop(fade = 0.05) {
    if (this.disposed) return;
    const f = Math.max(Number(fade) || 0, 0);
    const now = this.ctx.currentTime;
    const stopAt = now + f + 0.03;
    if (stopAt >= this.stopAt) return;
    this.stopAt = stopAt;
    try {
      steer(this.out.gain, 0, now, Math.max(f, 0.005) / 4);
    } catch { /* param already gone */ }
    // A second stop() replaces the first, so only move stop times earlier, never later.
    this.sources.forEach((s, i) => {
      if (this.ends[i] <= stopAt) return;
      this.ends[i] = stopAt;
      try { s.stop(stopAt); } catch { /* already stopped */ }
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    // Evicted or swept voices may still have running sources; stop them so they are freed now.
    if (this.live > 0) {
      for (const s of this.sources) {
        try { s.stop(); } catch { /* already stopped */ }
      }
    }
    for (const n of this.nodes) {
      try { n.disconnect(); } catch { /* not connected */ }
      if ('onended' in n) n.onended = null;
    }
    this.nodes.length = 0;
    this.sources.length = 0;
    this.ends.length = 0;
    this.engine.release(this);
  }
}

/** Owns the AudioContext and the master chain. Every method is safe before init(). */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.unavailable = false;
    this.voices = [];
    this.buses = null;
    this.master = null;
    this.noiseBuffer = null;
    this.tickled = false;
    this.ran = false;       // the context has been running at least once (so the page may resume it)
    this.retryIn = 0;
  }

  get running() {
    return Boolean(this.ctx) && this.ctx.state === 'running';
  }

  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Create the context and master chain once. Returns false when Web Audio is unavailable. */
  init(level = 1) {
    if (this.ctx) return true;
    if (this.unavailable) return false;
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof AC !== 'function') {
      this.unavailable = true;
      return false;
    }
    let ctx = null;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      try { ctx = new AC(); } catch { ctx = null; }
    }
    if (!ctx) {
      this.unavailable = true;
      return false;
    }
    try {
      this.#build(ctx, level);
    } catch {
      try { ctx.close?.(); } catch { /* ignore */ }
      this.unavailable = true;
      return false;
    }
    this.ctx = ctx;
    return true;
  }

  #build(ctx, level) {
    this.master = ctx.createGain();
    this.master.gain.value = level;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.18;
    const shelf = ctx.createBiquadFilter(); // tame anything harsh on headset speakers
    shelf.type = 'highshelf';
    shelf.frequency.value = 6000;
    shelf.gain.value = -5;
    const mix = ctx.createGain();
    mix.gain.value = MIX_LEVEL;
    mix.connect(shelf);
    shelf.connect(limiter);
    limiter.connect(this.master);
    this.master.connect(ctx.destination);
    this.buses = {};
    for (const [name, value] of Object.entries(BUS_LEVELS)) {
      const g = ctx.createGain();
      g.gain.value = value;
      g.connect(mix);
      this.buses[name] = g;
    }
    this.noiseBuffer = makeNoiseBuffer(ctx, NOISE_SECONDS);
  }

  /** Resume a suspended context (call from a user gesture). */
  resume() {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'closed') return;
    const suspended = ctx.state !== 'running';
    if (suspended) {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* not allowed yet */ }
    }
    if (this.tickled && !suspended) return;
    this.tickled = true;
    // A silent one-sample buffer played inside the gesture fully unlocks some mobile browsers.
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.onended = () => { try { src.disconnect(); } catch { /* ignore */ } };
      src.start(0);
    } catch { /* ignore */ }
  }

  /**
   * Per frame: if the system suspended a context that was already running (headset sleep, app switch,
   * iOS "interrupted"), try to resume it every RETRY seconds. Never called on a context that has not run,
   * so it cannot trip autoplay warnings before the first gesture.
   */
  recover(dt) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'running') {
      this.ran = true;
      this.retryIn = 0;
      return;
    }
    if (!this.ran || ctx.state === 'closed') return;
    this.retryIn -= Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (this.retryIn > 0) return;
    this.retryIn = RETRY;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* not allowed right now */ }
  }

  /** Ramp the master level (volume, or 0 when muted). */
  setLevel(level, tau = 0.04) {
    if (!this.ctx) return;
    steer(this.master.gain, clamp(level, 0, 1), this.ctx.currentTime, tau);
  }

  /**
   * A new voice on a bus. One-shot voices beyond MAX_VOICES evict the oldest one-shot.
   * @returns {Voice}
   */
  voice({ bus = 'sfx', pan = 0, gain = 1, kind = 'sfx', pannable = false } = {}) {
    if (kind !== 'loop') {
      const shots = this.voices.filter(v => v.kind !== 'loop');
      const playing = shots.filter(v => v.kind === 'sfx' && v.stopAt === Infinity); // jingles are not evicted
      if (playing.length >= MAX_VOICES) playing[0].stop(0.03);
      // Hard cap including voices still fading out (a burst of sounds within one frame). Jingles go last.
      if (shots.length >= MAX_VOICES + 8) (shots.find(v => v.kind === 'sfx') ?? shots[0]).dispose();
    }
    const v = new Voice(this, this.buses[bus] ?? this.buses.sfx, { pan, gain, kind, pannable });
    this.voices.push(v);
    return v;
  }

  release(voice) {
    const i = this.voices.indexOf(voice);
    if (i >= 0) this.voices.splice(i, 1);
  }

  /** Safety net when `ended` events do not arrive: drop voices well past their end. */
  sweep() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Backwards, without copying: dispose() splices the voice out of this.voices.
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v && now > Math.min(v.endTime, v.stopAt) + 0.5) v.dispose();
    }
  }

  /** Fade out every voice (or only those of one kind: 'sfx' | 'music' | 'loop'). */
  stopAll(kind = null, fade = 0.08) {
    for (const v of [...this.voices]) if (!kind || v.kind === kind) v.stop(fade);
  }

  close() {
    for (const v of [...this.voices]) v.dispose();
    try {
      const p = this.ctx?.close?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* ignore */ }
    this.ctx = null;
    this.buses = null;
    this.master = null;
    this.noiseBuffer = null;
    this.tickled = false;
    this.ran = false;
  }
}

function makeNoiseBuffer(ctx, seconds) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // White noise has no continuity to break, so the loop seam needs no crossfade.
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}
