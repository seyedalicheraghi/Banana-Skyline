import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFS, loadPrefs, sanitizePrefs, savePrefs } from '../src/app/prefs.js';

const DEFAULTS = { ...DEFAULT_PREFS };
const ORIGINAL = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

/** A minimal in-memory Storage. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

/** Install `storage` as globalThis.localStorage; a function is used as a getter (so it can throw). */
function installStorage(storage) {
  const desc = typeof storage === 'function' ? { get: storage } : { value: storage, writable: true };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, enumerable: true, ...desc });
}

afterEach(() => {
  if (ORIGINAL) Object.defineProperty(globalThis, 'localStorage', ORIGINAL);
  else delete globalThis.localStorage;
});

describe('sanitizePrefs', () => {
  test('no input gives the defaults', () => {
    assert.deepEqual(sanitizePrefs(), DEFAULTS);
    assert.deepEqual(sanitizePrefs({}), DEFAULTS);
    assert.deepEqual(DEFAULTS, {
      theme: 'night', sound: true, volume: 0.8, assist: 'arrow', vrThrow: 'hand', vrBoost: 'normal', lastSettings: null,
    });
  });

  test('keeps valid values', () => {
    const p = {
      theme: 'classic', sound: false, volume: 0.25, assist: 'preview', vrThrow: 'stick', vrBoost: 'high',
      lastSettings: { targetScore: 5 },
    };
    assert.deepEqual(sanitizePrefs(p), p);
    for (const theme of ['night', 'sunset', 'classic']) assert.equal(sanitizePrefs({ theme }).theme, theme);
    for (const assist of ['off', 'arrow', 'preview']) assert.equal(sanitizePrefs({ assist }).assist, assist);
    for (const vrThrow of ['hand', 'stick']) assert.equal(sanitizePrefs({ vrThrow }).vrThrow, vrThrow);
  });

  test('replaces unknown choices with the defaults', () => {
    const p = sanitizePrefs({ theme: 'neon', assist: 'aimbot', vrThrow: 'telekinesis', sound: 'yes' });
    assert.equal(p.theme, DEFAULTS.theme);
    assert.equal(p.assist, DEFAULTS.assist);
    assert.equal(p.vrThrow, DEFAULTS.vrThrow);
    assert.equal(p.sound, DEFAULTS.sound);
  });

  test('clamps volume to 0..1 and ignores non-numbers', () => {
    const v = (volume) => sanitizePrefs({ volume }).volume;
    assert.equal(v(0), 0);
    assert.equal(v(1), 1);
    assert.equal(v(0.5), 0.5);
    assert.equal(v(2), 1);
    assert.equal(v(-1), 0);
    assert.equal(v('0.3'), 0.3);
    assert.equal(v('loud'), DEFAULTS.volume);
    assert.equal(v(NaN), DEFAULTS.volume);
    assert.equal(v(Infinity), DEFAULTS.volume);
    assert.equal(v(undefined), DEFAULTS.volume);
  });

  test('lastSettings must be an object', () => {
    assert.equal(sanitizePrefs({ lastSettings: 'x' }).lastSettings, null);
    assert.equal(sanitizePrefs({ lastSettings: 42 }).lastSettings, null);
    assert.equal(sanitizePrefs({ lastSettings: null }).lastSettings, null);
    const s = { players: [{ name: 'A', cpu: null }] };
    assert.deepEqual(sanitizePrefs({ lastSettings: s }).lastSettings, s);
  });

  test('drops unknown keys', () => {
    const p = sanitizePrefs({ theme: 'sunset', evil: true, __proto__x: 1 });
    assert.deepEqual(Object.keys(p).sort(), Object.keys(DEFAULTS).sort());
  });
});

describe('loadPrefs / savePrefs', () => {
  test('without localStorage: load gives defaults and save still returns clean prefs', () => {
    delete globalThis.localStorage;
    assert.deepEqual(loadPrefs(), DEFAULTS);
    assert.deepEqual(savePrefs({ theme: 'sunset', volume: 3 }), { ...DEFAULTS, theme: 'sunset', volume: 1 });
  });

  test('save then load round-trips through localStorage', () => {
    const storage = memoryStorage();
    installStorage(storage);
    const prefs = { theme: 'classic', sound: false, volume: 0.4, assist: 'off', vrThrow: 'stick', vrBoost: 'low', lastSettings: { targetScore: 7 } };
    assert.deepEqual(savePrefs(prefs), prefs);
    assert.equal(storage.data.size, 1, 'one key holds the prefs');
    const [[, raw]] = [...storage.data];
    assert.deepEqual(JSON.parse(raw), prefs, 'stored as JSON');
    assert.deepEqual(loadPrefs(), prefs);
  });

  test('save sanitizes before storing', () => {
    const storage = memoryStorage();
    installStorage(storage);
    const saved = savePrefs({ theme: 'bogus', volume: -4, junk: 1 });
    assert.deepEqual(saved, { ...DEFAULTS, volume: 0 });
    const [[, raw]] = [...storage.data];
    assert.deepEqual(JSON.parse(raw), saved);
  });

  test('load sanitizes what it finds', () => {
    const storage = memoryStorage();
    installStorage(storage);
    savePrefs(DEFAULTS);
    const [[key]] = [...storage.data];
    storage.setItem(key, JSON.stringify({ theme: 'sunset', volume: 9, assist: 42, extra: 'x' }));
    assert.deepEqual(loadPrefs(), { ...DEFAULTS, theme: 'sunset', volume: 1 });
  });

  test('load falls back to defaults on corrupt JSON', () => {
    const storage = memoryStorage();
    installStorage(storage);
    savePrefs({ theme: 'sunset' });
    const [[key]] = [...storage.data];
    storage.setItem(key, '{not json');
    assert.deepEqual(loadPrefs(), DEFAULTS);
    storage.setItem(key, 'null');
    assert.deepEqual(loadPrefs(), DEFAULTS);
  });

  test('nothing stored yet gives the defaults', () => {
    installStorage(memoryStorage());
    assert.deepEqual(loadPrefs(), DEFAULTS);
  });

  test('getItem / setItem throwing (private mode, quota) is survived', () => {
    installStorage({
      getItem() { throw new Error('SecurityError'); },
      setItem() { throw new Error('QuotaExceededError'); },
    });
    assert.deepEqual(loadPrefs(), DEFAULTS);
    assert.deepEqual(savePrefs({ theme: 'classic' }), { ...DEFAULTS, theme: 'classic' });
  });

  test('a localStorage getter that throws is survived', () => {
    installStorage(() => { throw new Error('SecurityError: access denied'); });
    assert.throws(() => globalThis.localStorage, /SecurityError/, 'precondition');
    assert.deepEqual(loadPrefs(), DEFAULTS);
    assert.deepEqual(savePrefs({ sound: false }), { ...DEFAULTS, sound: false });
  });
});
