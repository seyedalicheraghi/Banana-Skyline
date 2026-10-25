// Pure helpers for the UI: option lists, match-setup form <-> core settings, drag-to-aim math.
// No DOM here, so everything can be tested in Node.
import { GRAVITY_PRESETS, MAX_POWER, MAX_WIND } from '../core/constants.js';

export const NAME_MAX = 16;            // core normalizeSettings keeps 16 characters
export const GRAVITY_MIN = 0.5;        // core clamps gravity to 0.5..40
export const GRAVITY_MAX = 40;
export const DRAG_FULL_POWER = 35;     // world units of drag that give power 100
export const DRAG_MIN = 2;             // pointer travel (world units) below this is a click, not a throw

export const MODE_OPTIONS = [
  { value: 'cpu', label: 'vs CPU' },
  { value: '2p', label: '2 Players' },
];
export const CPU_OPTIONS = [
  { value: 'easy', label: 'Easy' },
  { value: 'normal', label: 'Normal' },
  { value: 'hard', label: 'Hard' },
];
export const TARGET_OPTIONS = [1, 3, 5, 7, 10].map((v) => ({ value: v, label: String(v) }));
export const GRAVITY_OPTIONS = [
  { value: 'earth', label: 'Earth', sub: String(GRAVITY_PRESETS.earth) },
  { value: 'moon', label: 'Moon', sub: String(GRAVITY_PRESETS.moon) },
  { value: 'mars', label: 'Mars', sub: String(GRAVITY_PRESETS.mars) },
  { value: 'jupiter', label: 'Jupiter', sub: String(GRAVITY_PRESETS.jupiter) },
  { value: 'custom', label: 'Custom', sub: 'm/s²' },
];
export const WIND_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'calm', label: 'Calm' },
  { value: 'normal', label: 'Normal' },
  { value: 'wild', label: 'Wild' },
];
export const THEME_OPTIONS = [
  { value: 'night', label: 'Night' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'classic', label: 'Classic' },
];
export const ASSIST_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'preview', label: 'Preview' },
];

export const DEFAULT_UI_PREFS = Object.freeze({
  theme: 'night', sound: true, volume: 0.8, assist: 'arrow', vrThrow: 'hand', lastSettings: null,
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const values = (options) => options.map((o) => o.value);

/** Display name of the CPU opponent for a difficulty level, e.g. "Hard CPU". */
export function cpuName(level) {
  const opt = CPU_OPTIONS.find((o) => o.value === level) ?? CPU_OPTIONS[1];
  return `${opt.label} CPU`;
}

/** Trimmed, length-limited player name, or `fallback` when empty. */
export function cleanName(name, fallback) {
  return String(name ?? '').trim().slice(0, NAME_MAX) || fallback;
}

/** Gravity clamped to what the core accepts, or null when not a usable number. */
export function cleanGravity(value) {
  const g = Number(value);
  if (!Number.isFinite(g) || g <= 0) return null;
  return Math.round(clamp(g, GRAVITY_MIN, GRAVITY_MAX) * 100) / 100;
}

/** Preset key ('earth', 'moon', ...) matching a gravity value, or 'custom'. */
export function gravityPresetFor(g) {
  const n = Number(g);
  for (const [key, value] of Object.entries(GRAVITY_PRESETS)) if (Math.abs(value - n) < 0.005) return key;
  return 'custom';
}

/**
 * State of the match-setup form.
 * @typedef {{ mode: 'cpu'|'2p', names: [string, string], cpu: 'easy'|'normal'|'hard', targetScore: number,
 *   gravityPreset: string, customGravity: number, windStrength: string }} SetupForm
 */

/** @returns {SetupForm} */
export function defaultForm() {
  return {
    mode: 'cpu', names: ['', ''], cpu: 'normal', targetScore: 3,
    gravityPreset: 'earth', customGravity: GRAVITY_PRESETS.earth, windStrength: 'normal',
  };
}

/**
 * Prefill the form from settings saved earlier (prefs.lastSettings); anything missing or odd falls back
 * to the defaults. Default names ("Player 1", "Normal CPU") come back empty so the placeholder shows.
 * @returns {SetupForm}
 */
export function formFromSettings(s) {
  const form = defaultForm();
  if (!s || typeof s !== 'object') return form;
  const players = Array.isArray(s.players) ? s.players : [];
  const p0 = players[0] ?? {};
  const p1 = players[1] ?? {};
  const cpus = values(CPU_OPTIONS);
  form.mode = cpus.includes(p1.cpu) || !players.length ? 'cpu' : '2p';
  if (cpus.includes(p1.cpu)) form.cpu = p1.cpu;
  const n0 = cleanName(p0.name, '');
  form.names[0] = n0 === 'Player 1' ? '' : n0;
  if (form.mode === '2p') {
    const n1 = cleanName(p1.name, '');
    form.names[1] = n1 === 'Player 2' ? '' : n1;
  }
  const target = Number(s.targetScore);
  if (Number.isFinite(target)) {
    const targets = values(TARGET_OPTIONS);
    form.targetScore = targets.reduce((best, t) => (Math.abs(t - target) < Math.abs(best - target) ? t : best), targets[0]);
  }
  const g = cleanGravity(s.gravity);
  if (g !== null) {
    form.gravityPreset = gravityPresetFor(g);
    form.customGravity = g;
  }
  if (values(WIND_OPTIONS).includes(s.windStrength)) form.windStrength = s.windStrength;
  return form;
}

/**
 * Settings for callbacks.startMatch, shaped like core normalizeSettings expects.
 * @param {SetupForm} form
 * @returns {{ players: Array<{name: string, cpu: string|null}>, targetScore: number, gravity: number, windStrength: string }}
 */
export function settingsFromForm(form) {
  const f = { ...defaultForm(), ...(form ?? {}) };
  const names = Array.isArray(f.names) ? f.names : [];
  const cpu = values(CPU_OPTIONS).includes(f.cpu) ? f.cpu : 'normal';
  const p0 = { name: cleanName(names[0], 'Player 1'), cpu: null };
  const p1 = f.mode === '2p'
    ? { name: cleanName(names[1], 'Player 2'), cpu: null }
    : { name: cpuName(cpu), cpu };
  const gravity = f.gravityPreset === 'custom'
    ? cleanGravity(f.customGravity) ?? GRAVITY_PRESETS.earth
    : GRAVITY_PRESETS[f.gravityPreset] ?? GRAVITY_PRESETS.earth;
  const target = Number(f.targetScore);
  return {
    players: [p0, p1],
    targetScore: Number.isFinite(target) ? clamp(Math.round(target), 1, 20) : 3,
    gravity,
    windStrength: values(WIND_OPTIONS).includes(f.windStrength) ? f.windStrength : 'normal',
  };
}

/** Same match again (Rematch / Restart): the game's normalized settings without seed or demo flag. */
export function rematchSettings(settings) {
  const s = settings ?? {};
  const players = [0, 1].map((i) => ({ name: s.players?.[i]?.name ?? '', cpu: s.players?.[i]?.cpu ?? null }));
  return { players, targetScore: s.targetScore, gravity: s.gravity, windStrength: s.windStrength };
}

/**
 * Drag-to-aim: the vector from the thrower's hand to the pointer (both in world units) as angle/power.
 * Angle is degrees from horizontal toward the opponent, clamped to 0..180 (pointing below the hand
 * gives a flat throw forward or backward). Power grows with distance: DRAG_FULL_POWER units = 100.
 */
export function aimFromDrag(hand, point, facing = 1) {
  const dx = (point.x - hand.x) * (facing < 0 ? -1 : 1);
  const dy = point.y - hand.y;
  const distance = Math.hypot(dx, dy);
  let angle = Math.atan2(dy, dx) * (180 / Math.PI);
  if (angle < -90) angle = 180;
  else if (angle < 0) angle = 0;
  const power = clamp(distance * (MAX_POWER / DRAG_FULL_POWER), 0, MAX_POWER);
  return { angle, power, distance };
}

/** Wind number -> what the HUD shows. `fraction` is 0..1 of MAX_WIND, `dir` is -1, 0 or 1. */
export function windInfo(wind) {
  const w = Math.round(Number(wind) || 0);
  const abs = Math.min(MAX_WIND, Math.abs(w));
  const dir = abs ? Math.sign(w) : 0;
  return {
    abs,
    dir,
    fraction: abs / MAX_WIND,
    label: abs ? `Wind ${abs}` : 'No wind',
    description: abs ? `Wind ${abs}, blowing ${dir > 0 ? 'right' : 'left'}` : 'No wind',
  };
}

/** Angle/power for display: whole numbers stay whole, others get one decimal. */
export function formatAim(v) {
  const n = Math.round((Number(v) || 0) * 10) / 10;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
