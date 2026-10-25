import { MAX_POWER, SIM_DT, SPLASH_RADIUS } from './constants.js';
import { circleHitsBox, launchVelocity, monkeyBox, simulateShot } from './physics.js';

// Aim error (standard deviation) for the CPU's first shot of a round; it shrinks by `decay` with every
// shot it takes that round, like a player correcting their aim, but never below the floor.
export const CPU_LEVELS = {
  easy: { angleSigma: 9, powerSigma: 11, decay: 0.8, minAngle: 2.5, minPower: 3.5 },
  normal: { angleSigma: 5.5, powerSigma: 7, decay: 0.62, minAngle: 1, minPower: 1.6 },
  hard: { angleSigma: 2.5, powerSigma: 3.2, decay: 0.45, minAngle: 0.25, minPower: 0.4 },
};

const COARSE_DT = 1 / 90;
const BATCH = 24; // simulations between yields, so planning can be spread across frames

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = (v) => Math.round(v * 10) / 10;

// Lower is better: hits on the target score below -40, self-harm scores 1e6, misses score their closest distance.
export function scoreShot(game, player, angle, power, dt = SIM_DT) {
  const me = game.monkeys[player];
  const target = 1 - player;
  const origin = game.handPosition(player);
  const { vx, vy } = launchVelocity(angle, power, me.facing);
  const r = simulateShot({
    city: game.city, monkeys: game.monkeys, x: origin.x, y: origin.y, vx, vy,
    wind: game.wind, gravity: game.gravity, ignore: player, dt, target,
  });
  const { hit } = r;
  if (hit.kind === 'monkey') return hit.victim === target ? r.closest - 100 : 1e6;
  if (hit.kind === 'building' || hit.kind === 'ground') {
    if (circleHitsBox(hit.x, hit.y, SPLASH_RADIUS, monkeyBox(me))) return 1e6;
    if (game.monkeys[target].alive && circleHitsBox(hit.x, hit.y, SPLASH_RADIUS, monkeyBox(game.monkeys[target]))) {
      return r.closest - 50;
    }
  }
  return r.closest + (hit.kind === 'out' ? 5 : 0);
}

/**
 * Generator that plans the CPU's throw. Iterate it to completion; the return value is { angle, power }.
 * It yields every few simulations so the caller can spread the work over several frames.
 */
export function* planShot(game, player, rng) {
  const level = CPU_LEVELS[game.monkeys[player].cpu] ?? CPU_LEVELS.normal;
  const tieBreak = (angle) => 0.02 * Math.abs(angle - 50); // prefer natural-looking arcs

  let best = { score: Infinity, angle: 45, power: 50 };
  let n = 0;
  for (let angle = 15; angle <= 85; angle += 2.5) {
    for (let power = 10; power <= MAX_POWER; power += 2) {
      const score = scoreShot(game, player, angle, power, COARSE_DT) + tieBreak(angle);
      if (score < best.score) best = { score, angle, power };
      if (++n % BATCH === 0) yield;
    }
  }

  // Refine around the best coarse shot at full physics precision.
  const center = { angle: best.angle, power: best.power };
  best = { score: Infinity, ...center };
  for (let da = -2.5; da <= 2.5; da += 0.5) {
    for (let dp = -2; dp <= 2; dp += 0.25) {
      const angle = clamp(center.angle + da, 1, 89);
      const power = clamp(center.power + dp, 1, MAX_POWER);
      const score = scoreShot(game, player, angle, power, SIM_DT) + tieBreak(angle);
      if (score < best.score) best = { score, angle, power };
      if (++n % BATCH === 0) yield;
    }
  }

  const shots = game.shotsThisRound?.[player] ?? 0;
  const decay = level.decay ** shots;
  const angleSigma = Math.max(level.minAngle, level.angleSigma * decay);
  const powerSigma = Math.max(level.minPower, level.powerSigma * decay);
  return {
    angle: round1(clamp(best.angle + rng.gauss() * angleSigma, 5, 88)),
    power: round1(clamp(best.power + rng.gauss() * powerSigma, 5, MAX_POWER)),
  };
}

// Run planShot to completion (tests and tools).
export function chooseShot(game, player, rng) {
  const it = planShot(game, player, rng);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
