// Throwing math for VR: release-velocity estimation and thumbstick aiming.
// Pure functions and plain data (no three.js, no DOM) so they can be tested in Node.

/** Multiplier from measured hand speed (world units/s) to banana launch speed. Tune on the headset. */
export const THROW_BOOST = 2.3;
// The VR menu's "Throw boost" choice (prefs.vrBoost): pick High if your bananas fall short.
export const THROW_BOOSTS = { low: 1.8, normal: THROW_BOOST, high: 2.9 };

/** Releases slower than this (world units/s, before the boost) count as a drop: the banana returns to the hand. */
export const DROP_SPEED = 2.5;

/** How much grip history to keep while the banana is held (seconds). */
export const HISTORY_SECONDS = 0.12;

/** Only samples this close to the release are used to estimate the throw (seconds). */
export const FIT_SECONDS = 0.075;

/**
 * Finite-difference segments shorter than this are not trusted as the swing's peak: the release sample comes
 * from the input event's frame, a few ms off the animation-frame samples, and would spike the speed.
 */
export const MIN_SEGMENT_SECONDS = 0.004;

/** Thumbstick aiming: deadzone and rates at full deflection (degrees/s and power/s). */
export const STICK_DEADZONE = 0.18;
export const STICK_ANGLE_RATE = 45;
export const STICK_POWER_RATE = 35;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Rolling history of the holding hand in play-plane (world) units.
 * Each sample: { t (s), x, y, vx, vy, hasV } where vx/vy is the runtime's measured velocity when available.
 */
export class ThrowTracker {
  constructor({ keep = HISTORY_SECONDS, fit = FIT_SECONDS } = {}) {
    this.keep = keep;
    this.fit = fit;
    this.samples = [];
  }

  reset() {
    this.samples.length = 0;
  }

  /**
   * Record one sample. Non-finite input is ignored.
   * @param {number} t seconds
   * @param {number} x world-plane x
   * @param {number} y world-plane y
   * @param {?number} [vx] measured velocity x (world units/s), or null
   * @param {?number} [vy] measured velocity y (world units/s), or null
   */
  add(t, x, y, vx = null, vy = null) {
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const last = this.samples[this.samples.length - 1];
    if (last && t < last.t) this.samples.length = 0; // clock jumped backwards: start over
    const hasV = Number.isFinite(vx) && Number.isFinite(vy);
    this.samples.push({ t, x, y, vx: hasV ? vx : 0, vy: hasV ? vy : 0, hasV });
    const cutoff = t - this.keep;
    while (this.samples.length > 3 && this.samples[0].t < cutoff) this.samples.shift();
  }

  /** Last recorded sample, or null. */
  get last() {
    return this.samples[this.samples.length - 1] ?? null;
  }

  /**
   * Estimated release velocity. See estimateReleaseVelocity.
   * @param {number} [now] release time in seconds (defaults to the last sample's time)
   * @returns {?{vx:number, vy:number, speed:number, source:'measured'|'fitted'}}
   */
  estimate(now) {
    return estimateReleaseVelocity(this.samples, now, this.fit);
  }
}

/**
 * Release velocity from a short history of samples.
 * - Every recent sample has a runtime-measured velocity: take the fastest one (peak of the swing,
 *   because people tend to release a little late) averaged with its neighbors.
 * - Otherwise: finite differences find the fastest segment, then a least-squares line through the
 *   few samples around it gives a smoothed velocity.
 * @returns {?{vx:number, vy:number, speed:number, source:'measured'|'fitted'}} null without data
 */
export function estimateReleaseVelocity(samples, now, fit = FIT_SECONDS) {
  if (!samples?.length) return null;
  const t1 = Number.isFinite(now) ? now : samples[samples.length - 1].t;
  let recent = samples.filter((s) => s.t >= t1 - fit - 1e-9 && s.t <= t1 + 1e-9);
  if (recent.length < 2) recent = samples.slice(-2);
  // One sample without a runtime velocity (the grab, or an input-event pose) must not discard the rest.
  const measured = recent.filter((s) => s.hasV);
  if (measured.length >= 2 || (measured.length > 0 && measured.length === recent.length)) return peakMeasured(measured);
  if (recent.length < 2) return null;
  return peakFitted(recent);
}

function peakMeasured(list) {
  let peak = 0;
  for (let i = 1; i < list.length; i++) {
    if (Math.hypot(list[i].vx, list[i].vy) > Math.hypot(list[peak].vx, list[peak].vy)) peak = i;
  }
  let vx = 0;
  let vy = 0;
  let w = 0;
  for (let i = peak - 1; i <= peak + 1; i++) {
    const s = list[i];
    if (!s) continue;
    const weight = i === peak ? 2 : 1;
    vx += s.vx * weight;
    vy += s.vy * weight;
    w += weight;
  }
  vx /= w;
  vy /= w;
  return { vx, vy, speed: Math.hypot(vx, vy), source: 'measured' };
}

function peakFitted(list) {
  let best = -1;
  let bestK = 1;
  for (let k = 1; k < list.length; k++) {
    const dt = list[k].t - list[k - 1].t;
    if (dt < MIN_SEGMENT_SECONDS) continue;
    const speed = Math.hypot(list[k].x - list[k - 1].x, list[k].y - list[k - 1].y) / dt;
    if (speed > best) {
      best = speed;
      bestK = k;
    }
  }
  if (best < 0) return { vx: 0, vy: 0, speed: 0, source: 'fitted' };
  const fitList = list.slice(Math.max(0, bestK - 2), Math.min(list.length, bestK + 2));
  const v = leastSquaresVelocity(fitList);
  if (!v) return { vx: 0, vy: 0, speed: 0, source: 'fitted' };
  return { ...v, speed: Math.hypot(v.vx, v.vy), source: 'fitted' };
}

/** Slope of the best-fit lines x(t) and y(t). Null if all samples share one timestamp. */
export function leastSquaresVelocity(list) {
  const n = list.length;
  if (n < 2) return null;
  let tm = 0;
  let xm = 0;
  let ym = 0;
  for (const s of list) {
    tm += s.t;
    xm += s.x;
    ym += s.y;
  }
  tm /= n;
  xm /= n;
  ym /= n;
  let stt = 0;
  let stx = 0;
  let sty = 0;
  for (const s of list) {
    const dt = s.t - tm;
    stt += dt * dt;
    stx += dt * (s.x - xm);
    sty += dt * (s.y - ym);
  }
  if (stt < 1e-12) return null;
  return { vx: stx / stt, vy: sty / stt };
}

/** Deadzone plus a quadratic response: fine control near the center, full rate at the edge. */
export function shapeAxis(value, deadzone = STICK_DEADZONE) {
  const a = Math.abs(Number(value) || 0);
  if (a <= deadzone) return 0;
  const n = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(value) * n * n;
}

/**
 * Thumbstick aiming step. Up raises the angle, right adds power (gamepad y is negative when pushed up).
 * @param {{angle:number, power:number}} aim current aim
 * @param {number} axisX thumbstick x (-1..1)
 * @param {number} axisY thumbstick y (-1..1, up is negative)
 * @param {number} dt seconds
 * @returns {{angle:number, power:number, changed:boolean}}
 */
export function stickAim(aim, axisX, axisY, dt) {
  const da = -shapeAxis(axisY) * STICK_ANGLE_RATE * dt;
  const dp = shapeAxis(axisX) * STICK_POWER_RATE * dt;
  const angle = clamp((Number(aim?.angle) || 0) + da, 0, 180);
  const power = clamp((Number(aim?.power) || 0) + dp, 0, 100);
  return { angle, power, changed: da !== 0 || dp !== 0 };
}
