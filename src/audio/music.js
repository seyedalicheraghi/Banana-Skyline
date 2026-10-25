// Original 8-bit style jingles. Each song is a few monophonic lines written as "Note:steps" tokens
// ("R" is a rest) plus a one-character-per-step drum pattern. Every line is a single oscillator whose
// pitch and gain are automated note by note, so a whole jingle costs about a dozen nodes.

import { FLOOR, clamp } from './engine.js';

const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Frequency of a note name like 'A4', 'C#5', 'Bb3' (A4 = 440 Hz). Returns NaN for bad input.
 * @param {string} name
 * @returns {number}
 */
export function noteFreq(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(String(name).trim());
  if (!m) return NaN;
  const semi = SEMITONES[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  const midi = (Number(m[3]) + 1) * 12 + semi;
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Parse a line like 'C5:2 E5:1 R:1' into timed notes.
 * @param {string} line
 * @param {number} step seconds per step
 * @param {number} [t0=0] start time
 * @returns {{t: number, d: number, f: number}[]} rests are skipped
 */
export function lineEvents(line, step, t0 = 0) {
  const out = [];
  let pos = 0;
  for (const token of String(line).trim().split(/\s+/)) {
    if (!token) continue;
    const [name, len = '1'] = token.split(':');
    const steps = Math.max(0, Number(len) || 0);
    const f = name === 'R' ? NaN : noteFreq(name);
    if (Number.isFinite(f) && steps > 0) out.push({ t: t0 + pos * step, d: steps * step, f });
    pos += steps;
  }
  return out;
}

/** Total length of a line in steps. */
export function lineSteps(line) {
  return String(line).trim().split(/\s+/).reduce((sum, tok) => sum + (Math.max(0, Number(tok.split(':')[1] ?? 1)) || 0), 0);
}

// Drum chars: k kick, s snare, r soft snare roll, c crash, x kick+snare, K kick+crash, '.' nothing.
const DRUM_HITS = { k: ['kick'], s: ['snare'], r: ['roll'], c: ['crash'], x: ['kick', 'snare'], K: ['kick', 'crash'] };

/** Drum hit times by instrument for a pattern string. */
export function drumEvents(pattern, step, t0 = 0) {
  const out = { kick: [], snare: [], crash: [] };
  [...String(pattern)].forEach((ch, i) => {
    for (const hit of DRUM_HITS[ch] ?? []) {
      const kind = hit === 'roll' ? 'snare' : hit;
      out[kind].push({ t: t0 + i * step, level: hit === 'roll' ? 0.55 : 1 });
    }
  });
  return out;
}

export const SONGS = {
  // Round won, variant A (C major): quick arpeggio pickup, step down, leap to the top.
  victoryA: {
    step: 0.1,
    lead: 'G4:1 C5:1 E5:1 G5:1 E5:2 G5:2 A5:2 F5:2 D5:2 G5:2 C6:6',
    harmony: 'E4:4 G4:4 A4:4 B4:4 E5:6',
    bass: 'C3:4 C3:2 G2:2 F2:4 G2:4 C3:6',
    drums: 'k...s...k...s.rrK.....',
  },
  // Round won, variant B (F major): repeated-note call and a climbing answer.
  victoryB: {
    step: 0.1,
    lead: 'C5:2 C5:1 C5:1 F5:4 A5:2 G5:1 F5:1 G5:2 A5:2 C6:6',
    harmony: 'A4:4 C5:4 G4:4 E4:4 A4:6',
    bass: 'F2:4 F2:4 C3:4 C3:4 F2:6',
    drums: 'k...k...k...s.s.K.....',
  },
  // Match won: a longer fanfare with a walking bass and a drum roll into the last chord.
  fanfare: {
    step: 0.11,
    lead: 'C5:2 E5:2 G5:2 C6:4 G5:2 A5:3 G5:1 F5:2 E5:2 F5:2 G5:2 A5:2 B5:2 C6:8',
    harmony: 'E4:8 A4:8 G4:4 A4:4 B4:4 E5:8',
    bass: 'C3:2 C3:2 E3:2 G3:2 F2:4 F2:4 C3:4 F2:4 G2:2 G2:2 C3:8',
    drums: 'k...x...k...x...k...x...krrrK.......',
  },
};

// One monophonic line: per note, attack -> decay to sustain -> hold -> release (all linear, strictly ordered).
function scheduleLine(osc, param, events, { peak, sustain = 0.7, attack = 0.008, decay = 0.08 }) {
  events.forEach((e, i) => {
    const last = i === events.length - 1;
    const end = e.t + e.d;
    const rel = last ? Math.min(0.45, e.d * 0.6) : Math.min(0.045, e.d * 0.3);
    const tA = e.t + Math.min(attack, e.d * 0.2);
    const tR = end - rel;
    const tD = Math.min(tA + decay, tR);
    const level = tD > tA ? peak * sustain : peak;
    osc.frequency.setValueAtTime(e.f, e.t);
    param.setValueAtTime(0, e.t);
    param.linearRampToValueAtTime(peak, tA);
    if (tD > tA) param.linearRampToValueAtTime(level, tD);
    if (tR > tD) param.setValueAtTime(level, tR);
    param.linearRampToValueAtTime(0, end);
  });
}

// Hits closer together than their decay are shortened so envelopes never overlap.
function scheduleHits(hits, decay, fn) {
  hits.forEach((h, i) => {
    const next = hits[i + 1]?.t ?? Infinity;
    fn(h, Math.max(0.01, Math.min(decay, next - h.t - 0.005)));
  });
}

/**
 * Schedule a song on a voice starting at t. Returns the time the last sound ends.
 * @param {import('./engine.js').Voice} v
 * @param {number} t
 * @param {{step:number, lead:string, harmony?:string, bass?:string, drums?:string}} song
 */
export function playSong(v, t, song) {
  const step = clamp(Number(song.step) || 0.1, 0.03, 1);
  const lengths = [song.lead, song.harmony, song.bass].filter(Boolean).map(lineSteps);
  const total = Math.max(...lengths, String(song.drums ?? '').length) * step;
  const end = t + total + 0.6;

  const line = (src, type, peak, opts = {}) => {
    const events = lineEvents(src, step, t);
    if (!events.length) return null;
    const g = v.gain(0, opts.dest ?? v.out);
    const o = v.osc(type, events[0].f, t, end, g);
    scheduleLine(o, g.gain, events, { peak, ...opts });
    return o;
  };

  const lead = line(song.lead, 'square', 0.1, { dest: v.filter('lowpass', 2400, 0.5), sustain: 0.65 });
  if (lead) v.lfo(5.5, [lead.detune], t, end, 9); // gentle vibrato, in cents
  if (song.harmony) line(song.harmony, 'triangle', 0.09, { sustain: 0.75 });
  if (song.bass) line(song.bass, 'triangle', 0.22, { sustain: 0.85, decay: 0.05 });

  if (song.drums) {
    const d = drumEvents(song.drums, step, t);
    if (d.kick.length) {
      const g = v.gain(0);
      const o = v.osc('sine', 150, t, end, g);
      scheduleHits(d.kick, 0.18, (h, dec) => {
        o.frequency.setValueAtTime(160, h.t);
        o.frequency.exponentialRampToValueAtTime(48, h.t + Math.min(0.1, dec));
        g.gain.setValueAtTime(0, h.t);
        g.gain.linearRampToValueAtTime(0.3 * h.level, h.t + 0.003);
        g.gain.exponentialRampToValueAtTime(FLOOR, h.t + dec);
      });
    }
    const noiseHits = (hits, filterType, freq, Q, level, decay) => {
      if (!hits.length) return;
      const g = v.gain(0);
      v.noise(t, end, v.filter(filterType, freq, Q, g));
      scheduleHits(hits, decay, (h, dec) => {
        g.gain.setValueAtTime(0, h.t);
        g.gain.linearRampToValueAtTime(level * h.level, h.t + 0.002);
        g.gain.exponentialRampToValueAtTime(FLOOR, h.t + dec);
      });
    };
    noiseHits(d.snare, 'bandpass', 1800, 0.7, 0.22, 0.09);
    noiseHits(d.crash, 'bandpass', 3200, 0.35, 0.09, 1.2);
  }
  return end;
}
