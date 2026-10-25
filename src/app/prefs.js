// Per-device preferences, kept in localStorage. Storage can be unavailable (private mode), so every access is guarded.
const KEY = 'banana-skyline.prefs.v1';

export const DEFAULT_PREFS = Object.freeze({
  theme: 'night',          // 'night' | 'sunset' | 'classic'
  sound: true,
  volume: 0.8,
  assist: 'arrow',         // 'off' | 'arrow' | 'preview'
  vrThrow: 'hand',         // 'hand' | 'stick'
  vrBoost: 'normal',       // 'low' | 'normal' | 'high': multiplier on hand-throw speed in VR
  lastSettings: null,      // settings of the last match started from the menu
});

const THEMES = ['night', 'sunset', 'classic'];
const ASSISTS = ['off', 'arrow', 'preview'];
const THROWS = ['hand', 'stick'];
const BOOSTS = ['low', 'normal', 'high'];

export function sanitizePrefs(p = {}) {
  const volume = p.volume == null ? NaN : Number(p.volume);
  return {
    theme: THEMES.includes(p.theme) ? p.theme : DEFAULT_PREFS.theme,
    sound: typeof p.sound === 'boolean' ? p.sound : DEFAULT_PREFS.sound,
    volume: Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : DEFAULT_PREFS.volume,
    assist: ASSISTS.includes(p.assist) ? p.assist : DEFAULT_PREFS.assist,
    vrThrow: THROWS.includes(p.vrThrow) ? p.vrThrow : DEFAULT_PREFS.vrThrow,
    vrBoost: BOOSTS.includes(p.vrBoost) ? p.vrBoost : DEFAULT_PREFS.vrBoost,
    lastSettings: p.lastSettings && typeof p.lastSettings === 'object' ? p.lastSettings : null,
  };
}

export function loadPrefs() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return sanitizePrefs(raw ? JSON.parse(raw) : {});
  } catch {
    return sanitizePrefs({});
  }
}

export function savePrefs(prefs) {
  const clean = sanitizePrefs(prefs);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(clean));
  } catch {
    // Not persisted; the game still works for this visit.
  }
  return clean;
}
