import {
  BANANA_RADIUS, CITY_WIDTH, MAX_FLIGHT_TIME, MAX_POWER, MONKEY, OUT_MARGIN, POWER_TO_SPEED,
  SIM_DT, SUN, WIND_SCALE,
} from './constants.js';

const DEG = Math.PI / 180;
// Copied once: reading SUN's fields on every physics step kept V8 deoptimizing the planner across cities.
const SUN_X = SUN.x;
const SUN_Y = SUN.y;
const SUN_R2 = SUN.radius ** 2;

export const windAccel = (wind) => wind * WIND_SCALE;

// angle is in degrees measured from the horizontal toward the opponent (facing = +1 right, -1 left).
// 90 is straight up; above 90 throws backwards.
export function launchVelocity(angleDeg, power, facing) {
  const speed = power * POWER_TO_SPEED;
  return { vx: Math.cos(angleDeg * DEG) * speed * facing, vy: Math.sin(angleDeg * DEG) * speed };
}

// Inverse of launchVelocity: describe a velocity as the angle and power a player would type.
export function velocityToAim(vx, vy, facing) {
  const angle = Math.atan2(vy, vx * facing) / DEG;
  return { angle, power: Math.hypot(vx, vy) / POWER_TO_SPEED };
}

export const MAX_SPEED = MAX_POWER * POWER_TO_SPEED;

// Exact integration under constant acceleration (gravity + wind) for one step.
export function stepBanana(b, dt, ax, ay) {
  b.x += b.vx * dt + 0.5 * ax * dt * dt;
  b.y += b.vy * dt + 0.5 * ay * dt * dt;
  b.vx += ax * dt;
  b.vy += ay * dt;
  b.t += dt;
}

export function monkeyBox(m) {
  return { x0: m.x - MONKEY.width / 2, x1: m.x + MONKEY.width / 2, y0: m.y, y1: m.y + MONKEY.height };
}

export function circleHitsBox(cx, cy, r, box) {
  const px = Math.max(box.x0, Math.min(box.x1, cx));
  const py = Math.max(box.y0, Math.min(box.y1, cy));
  return (cx - px) ** 2 + (cy - py) ** 2 <= r * r;
}

export function sunContains(x, y) {
  return (x - SUN_X) ** 2 + (y - SUN_Y) ** 2 <= SUN_R2;
}

// The thrower's own box is ignored until the banana has left it once (so a straight-up throw can still come back down on you).
export function updateIgnore(b, monkeys) {
  if (b.ignore == null) return;
  const m = monkeys[b.ignore];
  if (!m || !circleHitsBox(b.x, b.y, BANANA_RADIUS, monkeyBox(m))) b.ignore = null;
}

/**
 * What the banana touches at its current position, or null. Checked in this order:
 * a live monkey, a building cell, the street, leaving the play area (or flying too long).
 */
export function probe(city, monkeys, b) {
  for (let i = 0; i < monkeys.length; i++) {
    const m = monkeys[i];
    if (!m.alive || b.ignore === i) continue;
    if (circleHitsBox(b.x, b.y, BANANA_RADIUS, monkeyBox(m))) return { kind: 'monkey', victim: i, x: b.x, y: b.y };
  }
  if (city.solidAt(b.x, b.y)) return { kind: 'building', x: b.x, y: b.y };
  if (b.y <= 0) return { kind: 'ground', x: b.x, y: 0 };
  if (b.x < -OUT_MARGIN || b.x > CITY_WIDTH + OUT_MARGIN || b.t > MAX_FLIGHT_TIME) return { kind: 'out', x: b.x, y: b.y };
  return null;
}

/**
 * Fly a banana without changing the city. Uses the same step/probe order as a real throw.
 * Returns { hit, path, closest, time, sun }:
 *  - hit: the probe result, or null if stopAt was reached first
 *  - path: [{x, y}] sampled every `recordEvery` steps (null when recordEvery is 0)
 *  - closest: closest distance from the banana to the center of monkeys[target] (Infinity without a target)
 *  - sun: whether the banana passed through the sun
 */
export function simulateShot({
  city, monkeys, x, y, vx, vy, wind, gravity, ignore = null, dt = SIM_DT,
  stopAt = MAX_FLIGHT_TIME + 1, target = null, recordEvery = 0,
}) {
  const b = { x, y, vx, vy, t: 0, ignore };
  const ax = windAccel(wind);
  const ay = -gravity;
  const path = recordEvery ? [{ x, y }] : null;
  const tgt = target == null ? null : monkeys[target];
  const tx = tgt ? tgt.x : 0;
  const ty = tgt ? tgt.y + MONKEY.height / 2 : 0;
  let closest = Infinity;
  let sun = false;
  for (let steps = 1; ; steps++) {
    stepBanana(b, dt, ax, ay);
    updateIgnore(b, monkeys);
    if (path && steps % recordEvery === 0) path.push({ x: b.x, y: b.y });
    if (tgt) closest = Math.min(closest, Math.hypot(b.x - tx, b.y - ty));
    if (!sun && sunContains(b.x, b.y)) sun = true;
    const hit = probe(city, monkeys, b);
    if (hit) {
      if (path) path.push({ x: hit.x, y: hit.y });
      return { hit, path, closest, time: b.t, sun };
    }
    if (b.t >= stopAt) return { hit: null, path, closest, time: b.t, sun };
  }
}
