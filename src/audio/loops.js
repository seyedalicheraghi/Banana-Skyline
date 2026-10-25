// Continuous sounds driven every frame: the wind/city ambience bed and the banana flight whistle.
// Their main gain is "dead-man" steered: each update schedules a fade to silence shortly after, which the
// next update cancels. If updates stop (tab hidden, loop paused), the sound fades out by itself.

import { MAX_WIND } from '../core/constants.js';
import { clamp, panForX, steer } from './engine.js';

const DEADMAN = 0.4; // seconds without an update before a loop fades out

// Loops never end on their own, so a half-built one would leak a running source: dispose it and rethrow.
function buildLoop(voice, build) {
  try {
    build(voice);
  } catch (err) {
    voice.dispose();
    throw err;
  }
  return voice;
}

function keepAlive(param, value, now, tau) {
  steer(param, value, now, tau);
  param.setTargetAtTime(0, now + DEADMAN, 0.08);
}

// A biquad whose frequency is modulated by an LFO recomputes its coefficients every sample while any of
// its params is a-rate. For a slow, always-on sweep, once per 128-sample block is plenty (cheaper on Quest).
function kRate(filter) {
  for (const p of [filter.frequency, filter.Q, filter.gain, filter.detune]) {
    try {
      if (p && 'automationRate' in p) p.automationRate = 'k-rate';
    } catch { /* fixed rate in this browser */ }
  }
}

/**
 * Ambience targets for a wind value (-15..15): very quiet at 0, clearly audible at 15.
 * @param {number} wind
 * @returns {{gain:number, cutoff:number, q:number, gust:number, sway:number, pan:number}}
 */
export function windParams(wind) {
  const w = Number.isFinite(wind) ? wind : 0;
  const k = clamp(Math.abs(w) / MAX_WIND, 0, 1);
  const gain = 0.02 + 0.33 * k ** 1.5;
  const cutoff = 280 + 1100 * k;
  return {
    gain,
    cutoff,
    q: 0.9 - 0.3 * k,
    gust: gain * 0.4,   // LFO depth on the wind level (stays below gain, so it never inverts)
    sway: cutoff * 0.25, // LFO depth on the cutoff
    pan: Math.sign(w) * 0.3 * k,
  };
}

/**
 * Whistle pitch for a banana velocity: faster is higher, rising adds pitch, falling drops it.
 * @param {number} vx
 * @param {number} vy
 * @returns {number} Hz
 */
export function whistlePitch(vx, vy) {
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed)) return 600;
  return clamp(560 + speed * 7 + vy * 6, 300, 1500);
}

/** Looping wind noise bed plus a faint low city rumble, on the ambience bus. */
export class Ambience {
  constructor(engine) {
    this.wind = NaN;
    this.armedAt = -Infinity;
    this.voice = buildLoop(engine.voice({ bus: 'ambience', kind: 'loop', pannable: true }), (v) => this.#build(v));
  }

  #build(v) {
    const t = v.t0;
    this.level = v.gain(0);
    this.windGain = v.gain(0, this.level);
    this.windFilter = v.filter('bandpass', 300, 0.9, this.windGain);
    kRate(this.windFilter);
    this.cityGain = v.gain(0.12, this.level);
    const src = v.noise(t, null, this.windFilter);
    src.connect(v.filter('lowpass', 150, 0.7, this.cityGain));
    this.gust = v.lfo(0.13, [this.windGain.gain], t, null, 0);
    this.sway = v.lfo(0.31, [this.windFilter.frequency], t, null, 0);
  }

  /** Follow the wind; call every frame (work is throttled to ~10 Hz unless the wind changes). */
  update(wind, now) {
    if (wind === this.wind && now - this.armedAt < 0.1) return;
    this.armedAt = now;
    keepAlive(this.level.gain, 1, now, 0.35);
    if (wind === this.wind) return;
    this.wind = wind;
    const p = windParams(wind);
    steer(this.windGain.gain, p.gain, now, 0.6);
    steer(this.windFilter.frequency, p.cutoff, now, 0.6);
    steer(this.windFilter.Q, p.q, now, 0.6);
    steer(this.gust.gain, p.gust, now, 0.6);
    steer(this.sway.gain, p.sway, now, 0.6);
    if (this.voice.panNode) steer(this.voice.panNode.pan, p.pan, now, 0.6);
  }

  stop(fade = 0.6) {
    this.voice.stop(fade);
  }
}

/** Quiet whistle following the banana: pitch from its velocity, pan from its x. */
export class Whistle {
  constructor(engine) {
    this.voice = buildLoop(engine.voice({ bus: 'sfx', kind: 'loop', pannable: true }), (v) => this.#build(v));
  }

  #build(v) {
    const t = v.t0;
    this.level = v.gain(0);
    this.main = v.osc('sine', 700, t, null, this.level);
    this.edgeGain = v.gain(0.15, this.level);
    this.edge = v.osc('triangle', 1400, t, null, this.edgeGain);
    v.lfo(5.8, [this.main.frequency, this.edge.frequency], t, null, 9);
  }

  /** @param {{x:number, vx:number, vy:number}} banana */
  update(banana, now, panWidth = 0.8) {
    const f = whistlePitch(banana.vx, banana.vy);
    const speed = Math.hypot(banana.vx, banana.vy) || 0;
    keepAlive(this.level.gain, 0.02 + 0.025 * clamp(speed / 60, 0, 1), now, 0.04);
    steer(this.main.frequency, f, now, 0.03);
    steer(this.edge.frequency, f * 2, now, 0.03);
    if (this.voice.panNode) steer(this.voice.panNode.pan, panForX(banana.x, panWidth), now, 0.05);
  }

  stop(fade = 0.07) {
    this.voice.stop(fade);
  }
}
