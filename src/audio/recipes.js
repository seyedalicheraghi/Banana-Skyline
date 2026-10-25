// Sound recipes. Each one is (voice, t, options) => void and schedules its nodes on `voice` starting at
// time t (AudioContext seconds). Levels are pre-bus; the master limiter catches the loud ones.

import { FLOOR, clamp, crackle, glide, hold, pluck } from './engine.js';

// Formants (F1, F2 in Hz) for the cartoon monkey voice.
const VOWELS = { oo: [340, 780], aa: [820, 1250], uh: [640, 1150] };

/** Airy bandpassed noise sweep. intensity 0..1 makes it louder and brighter. */
export function whoosh(v, t, { intensity = 0.5, dur = 0.38, level = 0.4 } = {}) {
  const k = clamp(intensity, 0, 1);
  const g = v.gain(0);
  const bp = v.filter('bandpass', 400, 1.1, g);
  v.noise(t, t + dur + 0.05, bp);
  glide(bp.frequency, t, [[0, 380], [dur * 0.35, 1100 + 1200 * k], [dur, 600]]);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level * (0.6 + 0.7 * k), t + dur * 0.3);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
}

/** A short effort grunt: breathy "h" then a voiced "up" with an upward flick. */
export function hup(v, t, { pitch = 1, level = 0.09 } = {}) {
  const breath = v.gain(0);
  v.noise(t, t + 0.07, v.filter('bandpass', 1600, 0.7, breath));
  pluck(breath.gain, t, level * 0.35, 0.005, 0.05);

  const tv = t + 0.03;
  const env = v.gain(0, v.filter('lowpass', 1500, 0.7));
  const [f1, f2] = VOWELS.uh;
  const saw = v.osc('sawtooth', 230 * pitch, tv, tv + 0.16, v.filter('bandpass', f1, 2, env));
  saw.connect(v.filter('bandpass', f2, 3, env));
  const body = v.osc('sine', 230 * pitch, tv, tv + 0.16, env);
  for (const o of [saw, body]) glide(o.frequency, tv, [[0, 220 * pitch], [0.07, 350 * pitch]]);
  pluck(env.gain, tv, level * 2.2, 0.012, 0.11);
}

/** throw = whoosh + "hup!" */
export function throwSound(v, t, o = {}) {
  whoosh(v, t, o);
  hup(v, t + 0.01, o);
}

/** Crunchy building explosion: noise through a falling lowpass, a crackle layer, and a low thump. */
export function explosion(v, t, { size = 1 } = {}) {
  const s = clamp(size, 0.6, 1.5);
  const dur = 0.85 * s;
  const body = v.gain(0);
  const lp = v.filter('lowpass', 2600, 0.8, body);
  const crunch = v.gain(0);
  const bp = v.filter('bandpass', 1400, 0.9, crunch);
  const src = v.noise(t, t + dur + 0.1, lp);
  src.connect(bp);
  glide(lp.frequency, t, [[0, 2600], [dur * 0.8, 220]]);
  pluck(body.gain, t, 0.55, 0.004, dur);
  glide(bp.frequency, t, [[0, 1600], [0.25, 700]]);
  crackle(crunch.gain, t, 6, 0.32, 0.28);

  const tg = v.gain(0);
  const o = v.osc('sine', 140, t, t + 0.6, tg);
  glide(o.frequency, t, [[0, 140], [0.35, 42]]);
  pluck(tg.gain, t, 0.75 * s, 0.003, 0.5);
}

/** Rubble settling: a few short bandpassed clicks after an explosion. */
export function debris(v, t, { count = 4 } = {}) {
  const n = clamp(Math.round(count), 1, 8);
  const g = v.gain(0);
  const bp = v.filter('bandpass', 1500, 4, g);
  const times = [];
  let tt = t + 0.12;
  for (let i = 0; i < n; i++) {
    tt += 0.045 + Math.random() * 0.11;
    times.push(tt);
  }
  v.noise(t, tt + 0.1, bp);
  times.forEach((ti, i) => {
    bp.frequency.setValueAtTime(900 + Math.random() * 1600, ti);
    g.gain.setValueAtTime((0.9 - i * 0.07) * (0.6 + 0.4 * Math.random()), ti);
    g.gain.exponentialRampToValueAtTime(FLOOR, ti + 0.035);
  });
}

/** Monkey hit: longer, deeper explosion with a sub thump and a rumbling tail. */
export function bigExplosion(v, t) {
  const dur = 1.6;
  const body = v.gain(0);
  const lp = v.filter('lowpass', 3800, 0.9, body);
  const rumble = v.gain(0);
  const lp2 = v.filter('lowpass', 180, 0.7, rumble);
  const crunch = v.gain(0);
  const bp = v.filter('bandpass', 1100, 0.8, crunch);
  const src = v.noise(t, t + dur + 0.3, lp);
  src.connect(lp2);
  src.connect(bp);
  glide(lp.frequency, t, [[0, 3800], [dur * 0.85, 140]]);
  pluck(body.gain, t, 0.7, 0.005, dur);
  hold(rumble.gain, t, 1.4, 0.08, 0.25, dur);
  crackle(crunch.gain, t, 8, 0.4, 0.45);

  const sub = v.gain(0);
  const o = v.osc('sine', 95, t, t + 1.4, sub);
  glide(o.frequency, t, [[0, 95], [0.9, 28]]);
  pluck(sub.gain, t, 0.95, 0.004, 1.3);

  const mid = v.gain(0);
  const m = v.osc('triangle', 210, t, t + 0.6, mid);
  glide(m.frequency, t, [[0, 210], [0.45, 55]]);
  pluck(mid.gain, t, 0.3, 0.003, 0.5);
}

/** Banana hits the street: dull thud plus a small squishy splat. */
export function groundHit(v, t) {
  const tg = v.gain(0);
  const o = v.osc('sine', 95, t, t + 0.35, tg);
  glide(o.frequency, t, [[0, 95], [0.16, 45]]);
  pluck(tg.gain, t, 0.55, 0.004, 0.28);

  const dull = v.gain(0);
  const src = v.noise(t, t + 0.3, v.filter('lowpass', 500, 0.7, dull));
  pluck(dull.gain, t, 0.35, 0.003, 0.18);

  const splat = v.gain(0);
  const bp = v.filter('bandpass', 1400, 1.4, splat);
  src.connect(bp);
  glide(bp.frequency, t + 0.015, [[0, 1400], [0.12, 450]]);
  pluck(splat.gain, t + 0.015, 0.45, 0.003, 0.14);

  const wet = v.gain(0);
  const w = v.osc('sine', 520, t + 0.01, t + 0.12, wet);
  glide(w.frequency, t + 0.01, [[0, 520], [0.07, 160]]);
  pluck(wet.gain, t + 0.01, 0.12, 0.003, 0.08);
}

/** Cartoon monkey yelp "ooh-ooh-aah": a buzzy source through two moving formant filters. */
export function yelp(v, t, { pitch = 1, level = 0.34 } = {}) {
  const sylls = [
    { at: 0.0, dur: 0.15, f: [370, 540], vowel: 'oo' },
    { at: 0.19, dur: 0.15, f: [400, 580], vowel: 'oo' },
    { at: 0.4, dur: 0.48, f: [470, 780, 430], vowel: 'aa' },
  ];
  const end = t + 0.95;
  const env = v.gain(0, v.filter('lowpass', 2600, 0.7));
  const f1 = v.filter('bandpass', VOWELS.oo[0], 5, env);
  const f2Gain = v.gain(0.6, env);
  const f2 = v.filter('bandpass', VOWELS.oo[1], 7, f2Gain);
  const saw = v.osc('sawtooth', 400, t, end, f1);
  saw.connect(f2);
  const bodyGain = v.gain(0.25, env);
  const body = v.osc('sine', 400, t, end, bodyGain);
  const vib = v.lfo(8.5, [saw.frequency, body.frequency], t, end, 0);
  vib.gain.setValueAtTime(0, t + 0.42);
  vib.gain.linearRampToValueAtTime(24 * pitch, t + 0.58);

  for (const s of sylls) {
    const ts = t + s.at;
    const [a, b, c] = s.f.map(f => f * pitch);
    for (const o of [saw, body]) {
      const pts = c ? [[0, a], [s.dur * 0.35, b], [s.dur, c]] : [[0, a], [s.dur, b]];
      glide(o.frequency, ts, pts);
    }
    f1.frequency.setValueAtTime(VOWELS[s.vowel][0], ts);
    f2.frequency.setValueAtTime(VOWELS[s.vowel][1], ts);
    env.gain.setValueAtTime(0, ts);
    env.gain.linearRampToValueAtTime(level * 2.6, ts + 0.025);
    env.gain.setValueAtTime(level * 2.6, ts + s.dur - 0.05);
    env.gain.linearRampToValueAtTime(0, ts + s.dur);
  }
}

/** Sun hit: a springy "boing" (pitch flick up, then a decaying wobble). */
export function boing(v, t) {
  const dur = 0.85;
  const g = v.gain(0);
  const o = v.osc('sine', 170, t, t + dur, g);
  glide(o.frequency, t, [[0, 170], [0.05, 440], [dur - 0.05, 300]]);
  const g2 = v.gain(0);
  const o2 = v.osc('triangle', 340, t, t + dur, g2);
  glide(o2.frequency, t, [[0, 340], [0.05, 880], [dur - 0.05, 600]]);
  const wobble = v.lfo(12, [o.frequency, o2.frequency], t, t + dur, 0);
  wobble.gain.setValueAtTime(0, t + 0.04);
  wobble.gain.linearRampToValueAtTime(70, t + 0.06);
  wobble.gain.exponentialRampToValueAtTime(2, t + dur - 0.05);
  pluck(g.gain, t, 0.32, 0.006, dur - 0.06);
  pluck(g2.gain, t, 0.05, 0.006, 0.5);
}

/** Falling monkey: a descending slide whistle lasting about `dur` seconds. */
export function slideWhistle(v, t, { dur = 0.8 } = {}) {
  const d = clamp(dur, 0.3, 1.8);
  const g = v.gain(0);
  const o = v.osc('sine', 1350, t, t + d + 0.15, g);
  glide(o.frequency, t, [[0, 1250], [0.04, 1350], [d, 330]]);
  v.lfo(6.5, [o.frequency], t, t + d + 0.15, 14);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.17, t + 0.05);
  g.gain.linearRampToValueAtTime(0.13, t + d);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + d + 0.12);
  const breath = v.gain(0);
  v.noise(t, t + d + 0.1, v.filter('bandpass', 1200, 1.5, breath));
  hold(breath.gain, t, 0.03, 0.05, d - 0.1, 0.1);
}

/** Monkey lands: soft low thump. */
export function thump(v, t) {
  const g = v.gain(0);
  const o = v.osc('sine', 120, t, t + 0.3, g);
  glide(o.frequency, t, [[0, 120], [0.12, 50]]);
  pluck(g.gain, t, 0.4, 0.003, 0.22);
  const n = v.gain(0);
  v.noise(t, t + 0.15, v.filter('lowpass', 380, 0.7, n));
  pluck(n.gain, t, 0.25, 0.002, 0.1);
}

/** Turn change: soft rising two-note tick (quieter and lower for CPU turns). */
export function tick(v, t, { soft = false } = {}) {
  const notes = soft ? [659.25, 880] : [783.99, 1046.5];
  const level = soft ? 0.045 : 0.07;
  notes.forEach((f, i) => {
    const ti = t + i * 0.075;
    const g = v.gain(0);
    v.osc('triangle', f, ti, ti + 0.13, g);
    pluck(g.gain, ti, level, 0.004, 0.1);
  });
}

/** CPU thinking: a barely-there blip. */
export function blip(v, t) {
  const g = v.gain(0);
  const o = v.osc('sine', 520, t, t + 0.12, g);
  glide(o.frequency, t, [[0, 520], [0.06, 600]]);
  pluck(g.gain, t, 0.03, 0.005, 0.08);
}

/** Round start: city ambience swell (filtered noise rising and falling over a soft open fifth). */
export function swell(v, t) {
  const dur = 1.8;
  const g = v.gain(0);
  const lp = v.filter('lowpass', 220, 0.6, g);
  v.noise(t, t + dur + 0.1, lp);
  glide(lp.frequency, t, [[0, 220], [0.7, 1100], [dur, 300]]);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.16, t + 0.7);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
  [[130.81, 0.05], [196, 0.035], [261.63, 0.02]].forEach(([f, level]) => {
    const pg = v.gain(0);
    v.osc('sine', f, t, t + dur + 0.1, pg);
    hold(pg.gain, t, level, 0.6, 0.3, 0.85);
  });
}

/** Wind changed: a soft gust. */
export function gust(v, t) {
  const dur = 1.1;
  const g = v.gain(0);
  const bp = v.filter('bandpass', 300, 0.8, g);
  v.noise(t, t + dur + 0.05, bp);
  glide(bp.frequency, t, [[0, 300], [dur * 0.45, 900], [dur, 350]]);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.14, t + dur * 0.4);
  g.gain.exponentialRampToValueAtTime(FLOOR, t + dur);
}

/** UI: button press. */
export function click(v, t) {
  const g = v.gain(0);
  const o = v.osc('sine', 900, t, t + 0.09, g);
  glide(o.frequency, t, [[0, 900], [0.03, 1300]]);
  pluck(g.gain, t, 0.12, 0.002, 0.06);
  const n = v.gain(0);
  v.noise(t, t + 0.03, v.filter('lowpass', 2500, 0.7, n));
  pluck(n.gain, t, 0.05, 0.001, 0.015);
}

/** UI: pointer over a button (very soft). */
export function hover(v, t) {
  const g = v.gain(0);
  v.osc('sine', 1320, t, t + 0.07, g);
  pluck(g.gain, t, 0.022, 0.003, 0.04);
}

/** UI: not allowed. Two low descending buzzes. */
export function error(v, t) {
  const g = v.gain(0, v.filter('lowpass', 900, 0.7));
  const o = v.osc('square', 233.08, t, t + 0.3, g);
  o.frequency.setValueAtTime(174.61, t + 0.13);
  for (const ti of [t, t + 0.13]) {
    g.gain.setValueAtTime(0, ti);
    g.gain.linearRampToValueAtTime(0.09, ti + 0.008);
    g.gain.setValueAtTime(0.09, ti + 0.08);
    g.gain.linearRampToValueAtTime(0, ti + 0.11);
  }
}
