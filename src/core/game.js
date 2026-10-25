import { planShot } from './ai.js';
import { City } from './city.js';
import {
  BIG_CRATER_RADIUS, CRATER_RADIUS, DEFAULT_AIM, DEFAULT_GRAVITY, FALL_GRAVITY, GROUND_SPLASH, MAX_POWER,
  MAX_WIND, MONKEY, SIM_DT, SPLASH_RADIUS, TIMING,
} from './constants.js';
import { Emitter } from './events.js';
import {
  MAX_SPEED, circleHitsBox, launchVelocity, monkeyBox, probe, simulateShot, stepBanana, sunContains,
  updateIgnore, velocityToAim, windAccel,
} from './physics.js';
import { createRng, randomSeed } from './rng.js';

export const CPU_NAMES = ['easy', 'normal', 'hard'];
export const WIND_STRENGTHS = ['none', 'calm', 'normal', 'wild'];
const WIND_FACTOR = { none: 0, calm: 0.4, normal: 1, wild: 1.4 };

const PATH_EVERY = 4;      // record the flight path every N physics steps (60 points/s)
const CPU_BUDGET_MS = 3;   // planning time per frame
const now = () => globalThis.performance?.now() ?? Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const DEFAULT_SETTINGS = Object.freeze({
  players: [{ name: 'Player 1', cpu: null }, { name: 'CPU', cpu: 'normal' }],
  targetScore: 3,
  gravity: DEFAULT_GRAVITY,
  windStrength: 'normal',
  seed: null,
  demo: false, // attract-mode match behind the title screen: UI and sound ignore it
});

export function normalizeSettings(s = {}) {
  const players = [0, 1].map((i) => {
    const p = s.players?.[i] ?? DEFAULT_SETTINGS.players[i];
    const cpu = CPU_NAMES.includes(p?.cpu) ? p.cpu : null;
    const fallback = cpu ? 'CPU' : `Player ${i + 1}`;
    const name = String(p?.name ?? '').trim().slice(0, 16) || fallback;
    return { name, cpu };
  });
  const target = Number.parseInt(s.targetScore, 10);
  const gravity = Number(s.gravity);
  return {
    players,
    targetScore: Number.isFinite(target) ? clamp(target, 1, 20) : DEFAULT_SETTINGS.targetScore,
    gravity: Number.isFinite(gravity) && gravity > 0 ? clamp(gravity, 0.5, 40) : DEFAULT_GRAVITY,
    windStrength: WIND_STRENGTHS.includes(s.windStrength) ? s.windStrength : DEFAULT_SETTINGS.windStrength,
    seed: Number.isFinite(s.seed) ? s.seed >>> 0 : null,
    demo: Boolean(s.demo),
  };
}

/**
 * One match between two monkeys. Drive it with update(dt); listen with on()/onAny().
 * phase: 'idle' -> ('aim' -> 'flight' -> 'impact')* -> 'roundOver' -> ... -> 'matchOver'.
 * See docs/DESIGN.md for the event list.
 */
export class Game extends Emitter {
  constructor(settings = {}) {
    super();
    this.settings = normalizeSettings(settings);
    this.seed = this.settings.seed ?? randomSeed();
    this.rng = createRng(this.seed);
    this.aiRng = createRng(this.seed ^ 0x9e3779b9);
    this.gravity = this.settings.gravity;
    this.isDemo = this.settings.demo;
    this.scores = [0, 0];
    this.round = 0;
    this.turn = 0;
    this.phase = 'idle';
    this.timer = 0;
    this.city = null;
    this.monkeys = [];
    this.wind = 0;
    this.banana = null;
    this.flight = null;
    this.cpu = null;
    this.aim = [{ ...DEFAULT_AIM }, { ...DEFAULT_AIM }];
    this.lastShots = [null, null];
    this.shotsThisRound = [0, 0];
    this.roundWinner = null;
    this.roundSelfHit = false;
    this.winner = null;
  }

  get current() {
    return this.monkeys[this.turn];
  }

  // True when a human may aim and throw right now.
  get humanTurn() {
    return this.phase === 'aim' && Boolean(this.current) && !this.current.cpu;
  }

  start() {
    this.emit('matchStart', { settings: this.settings, seed: this.seed });
    this.startRound();
  }

  destroy() {
    this.removeAllListeners();
    this.phase = 'idle';
    this.cpu = null;
  }

  startRound() {
    this.round += 1;
    this.city = City.generate(this.rng);
    const spots = this.city.monkeySpots(this.rng);
    this.monkeys = spots.map((spot, i) => ({
      index: i,
      name: this.settings.players[i].name,
      cpu: this.settings.players[i].cpu,
      x: spot.x,
      y: spot.y,
      facing: i === 0 ? 1 : -1,
      alive: true,
      falling: false,
      vy: 0,
      landY: spot.y,
      anim: 'idle',     // 'idle' | 'throw' | 'fall' | 'dead' | 'victory'
      animTime: 0,
    }));
    this.wind = this.rollWind();
    this.turn = (this.round - 1) % 2;
    this.banana = null;
    this.flight = null;
    this.lastShots = [null, null];
    this.shotsThisRound = [0, 0];
    this.roundWinner = null;
    this.emit('roundStart', { round: this.round, wind: this.wind, turn: this.turn, pattern: this.city.pattern });
    this.beginTurn();
  }

  rollWind() {
    const rng = this.rng;
    let w = rng.int(-5, 5);
    if (rng.int(1, 3) === 1) w += (w >= 0 ? 1 : -1) * rng.int(1, 10); // now and then a gale, as in the original
    return clamp(Math.round(w * WIND_FACTOR[this.settings.windStrength]), -MAX_WIND, MAX_WIND) || 0;
  }

  beginTurn() {
    this.phase = 'aim';
    this.timer = 0;
    const m = this.current;
    this.emit('turn', { player: this.turn, cpu: m.cpu, name: m.name });
    if (m.cpu) {
      this.cpu = { timer: TIMING.cpuThink, planner: planShot(this, this.turn, this.aiRng), result: null };
      this.emit('cpuThinking', { player: this.turn, level: m.cpu });
    } else {
      this.cpu = null;
    }
  }

  nextTurn() {
    this.turn = 1 - this.turn;
    if (this.settings.windStrength === 'wild') {
      this.wind = this.rollWind();
      this.emit('wind', { wind: this.wind });
    }
    this.beginTurn();
  }

  handPosition(player) {
    const m = this.monkeys[player];
    return { x: m.x + m.facing * MONKEY.handX, y: m.y + MONKEY.handY };
  }

  setAim(player, angle, power) {
    const a = clamp(Number(angle) || 0, 0, 180);
    const p = clamp(Number(power) || 0, 0, MAX_POWER);
    this.aim[player] = { angle: a, power: p };
    this.emit('aim', { player, angle: a, power: p });
  }

  // Throw for the current player with an angle (degrees from horizontal, toward the opponent) and power 0..100.
  throwShot({ angle, power }) {
    if (this.phase !== 'aim') return false;
    this.setAim(this.turn, angle, power);
    const { angle: a, power: p } = this.aim[this.turn];
    const { vx, vy } = launchVelocity(a, p, this.current.facing);
    this.launch(vx, vy, this.handPosition(this.turn), a, p, 'aim');
    return true;
  }

  /**
   * Throw with a velocity in world units (VR hand throw). `origin` is where the hand released the banana,
   * already projected into the play plane; it is kept close to the monkey. Humans only.
   */
  throwVelocity(vx, vy, origin = null) {
    if (!this.humanTurn) return false;
    const m = this.current;
    const speed = Math.hypot(vx, vy);
    if (speed > MAX_SPEED) {
      vx *= MAX_SPEED / speed;
      vy *= MAX_SPEED / speed;
    }
    const aim = velocityToAim(vx, vy, m.facing);
    const hand = this.handPosition(this.turn);
    let start = hand;
    if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
      start = {
        x: clamp(origin.x, m.x - 2.5, m.x + 2.5),
        y: clamp(origin.y, m.y + 1, m.y + 6),
      };
      if (this.city.solidAt(start.x, start.y)) start = hand;
    }
    const angle = clamp(aim.angle < -90 ? aim.angle + 360 : aim.angle, -90, 270);
    this.aim[this.turn] = { angle: clamp(angle, 0, 180), power: clamp(aim.power, 0, MAX_POWER) };
    this.launch(vx, vy, start, Math.round(angle * 10) / 10, Math.round(aim.power * 10) / 10, 'hand');
    return true;
  }

  launch(vx, vy, start, angle, power, method) {
    const player = this.turn;
    const m = this.current;
    this.cpu = null;
    this.banana = { x: start.x, y: start.y, vx, vy, t: 0, ignore: player, spin: 0, sun: false };
    this.flight = { acc: 0, steps: 0, path: [{ x: start.x, y: start.y }], angle, power };
    this.phase = 'flight';
    this.shotsThisRound[player] += 1;
    m.anim = 'throw';
    m.animTime = 0;
    this.emit('throw', { player, angle, power, x: start.x, y: start.y, vx, vy, method });
  }

  // Path (world points) of the first `seconds` of a throw at this aim, for the optional aiming assist.
  previewPath(player, angle, power, seconds = 0.8) {
    const m = this.monkeys[player];
    const o = this.handPosition(player);
    const { vx, vy } = launchVelocity(angle, power, m.facing);
    return simulateShot({
      city: this.city, monkeys: this.monkeys, x: o.x, y: o.y, vx, vy, wind: this.wind,
      gravity: this.gravity, ignore: player, stopAt: seconds, recordEvery: 6,
    }).path;
  }

  update(dt) {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.1);
    for (const m of this.monkeys) {
      m.animTime += dt;
      if (m.anim === 'throw' && m.animTime >= TIMING.throwAnim) this.setAnim(m, 'idle');
    }
    this.updateFalls(dt);

    switch (this.phase) {
      case 'aim':
        if (this.cpu) this.updateCpu(dt);
        break;
      case 'flight':
        this.updateFlight(dt);
        break;
      case 'impact':
        this.timer -= dt;
        if (this.timer <= 0 && !this.monkeys.some(m => m.falling)) {
          if (this.roundWinner !== null) this.endRound();
          else this.nextTurn();
        }
        break;
      case 'roundOver':
        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.scores[this.roundWinner] >= this.settings.targetScore) {
            this.phase = 'matchOver';
            this.winner = this.roundWinner;
            this.emit('matchOver', { winner: this.winner, scores: [...this.scores] });
          } else {
            this.startRound();
          }
        }
        break;
      default:
        break;
    }
  }

  setAnim(m, anim) {
    m.anim = anim;
    m.animTime = 0;
  }

  updateCpu(dt) {
    const cpu = this.cpu;
    cpu.timer -= dt;
    if (!cpu.result) {
      const t0 = now();
      do {
        const r = cpu.planner.next();
        if (r.done) {
          cpu.result = r.value;
          break;
        }
      } while (now() - t0 < CPU_BUDGET_MS);
    }
    if (cpu.result && cpu.timer <= 0) this.throwShot(cpu.result);
  }

  updateFlight(dt) {
    const b = this.banana;
    const f = this.flight;
    const ax = windAccel(this.wind);
    const ay = -this.gravity;
    f.acc += dt;
    while (f.acc >= SIM_DT) {
      f.acc -= SIM_DT;
      stepBanana(b, SIM_DT, ax, ay);
      updateIgnore(b, this.monkeys);
      f.steps += 1;
      if (f.steps % PATH_EVERY === 0) f.path.push({ x: b.x, y: b.y });
      if (!b.sun && sunContains(b.x, b.y)) {
        b.sun = true;
        this.emit('sunHit', { x: b.x, y: b.y });
      }
      const hit = probe(this.city, this.monkeys, b);
      if (hit) {
        f.path.push({ x: hit.x, y: hit.y });
        this.resolveImpact(hit);
        return;
      }
    }
    b.spin = b.t * 14 * this.current.facing;
  }

  resolveImpact(hit) {
    const thrower = this.turn;
    const f = this.flight;
    this.lastShots[thrower] = { angle: f.angle, power: f.power, path: f.path, hit: { kind: hit.kind, x: hit.x, y: hit.y } };
    this.banana = null;
    this.flight = null;

    const victims = [];
    let radius = 0;
    if (hit.kind === 'monkey') {
      victims.push(hit.victim);
      radius = BIG_CRATER_RADIUS;
    } else if (hit.kind === 'building' || hit.kind === 'ground') {
      radius = hit.kind === 'building' ? CRATER_RADIUS : GROUND_SPLASH;
      this.monkeys.forEach((m, i) => {
        if (m.alive && circleHitsBox(hit.x, hit.y, SPLASH_RADIUS, monkeyBox(m))) victims.push(i);
      });
    }
    this.emit('impact', { kind: hit.kind, x: hit.x, y: hit.y, radius, victim: victims[0] ?? null, thrower });

    if (hit.kind === 'monkey' || hit.kind === 'building') {
      const craterRadius = hit.kind === 'monkey' ? BIG_CRATER_RADIUS : CRATER_RADIUS;
      const removed = this.city.carve(hit.x, hit.y, craterRadius);
      this.emit('crater', { x: hit.x, y: hit.y, radius: craterRadius, removed });
    }

    this.roundWinner = null;
    if (victims.length) {
      for (const v of victims) {
        const m = this.monkeys[v];
        m.alive = false;
        m.falling = false;
        this.setAnim(m, 'dead');
      }
      const opponent = 1 - thrower;
      this.roundWinner = victims.includes(opponent) ? thrower : opponent;
      this.roundSelfHit = !victims.includes(opponent);
      for (const v of victims) this.emit('monkeyHit', { victim: v, thrower, selfHit: v === thrower });
      this.phase = 'impact';
      this.timer = TIMING.monkeyHit;
    } else {
      this.phase = 'impact';
      this.timer = TIMING.impact;
    }

    // Monkeys whose roof was blown away drop to whatever is left below them.
    for (const m of this.monkeys) {
      if (!m.alive || m.falling) continue;
      const land = this.city.supportY(m.x - MONKEY.footHalf, m.x + MONKEY.footHalf, m.y);
      if (land < m.y - 1e-6) {
        m.falling = true;
        m.vy = 0;
        m.landY = land;
        this.setAnim(m, 'fall');
        this.emit('monkeyFall', { player: m.index, fromY: m.y, toY: land });
      }
    }
  }

  updateFalls(dt) {
    for (const m of this.monkeys) {
      if (!m.falling) continue;
      m.vy -= FALL_GRAVITY * dt;
      m.y += m.vy * dt;
      if (m.y <= m.landY) {
        m.y = m.landY;
        m.vy = 0;
        m.falling = false;
        if (m.alive) this.setAnim(m, 'idle');
        this.emit('monkeyLand', { player: m.index, y: m.y });
      }
    }
  }

  endRound() {
    const w = this.roundWinner;
    this.scores[w] += 1;
    if (this.monkeys[w].alive) this.setAnim(this.monkeys[w], 'victory');
    this.phase = 'roundOver';
    this.timer = TIMING.roundOver;
    this.emit('roundOver', {
      winner: w,
      scores: [...this.scores],
      selfHit: this.roundSelfHit,
      matchPoint: this.scores[w] >= this.settings.targetScore,
    });
  }
}
