// Visual themes. Plain data (sRGB hex strings); the view converts them to THREE.Color when applied.
// Light intensities are in "legacy" units (1 = full color on a surface facing the light); the view multiplies by PI.

/**
 * @typedef {object} Theme
 * @property {string} name
 * @property {{zenith:string, mid:string, horizon:string, glow:string, glowStrength:number}} sky
 * @property {string} fog          horizon/fog color (also the sky below the horizon)
 * @property {boolean} stars
 * @property {object} orb          sun/moon face drawing: kind 'sun'|'moon', colors, rays, craters
 * @property {{sky:string, ground:string, intensity:number}} hemi
 * @property {{color:string, intensity:number, dir:number[]}} key   directional "sun/moon" light
 * @property {string[]} buildings  4 colors, indexed by building.color
 * @property {string[]} windowLit  lit window colors (first is most common)
 * @property {string} windowOff
 * @property {number} litRatio     share of lit windows
 */

/** @type {Record<string, Theme>} */
export const THEMES = {
  night: {
    name: 'night',
    sky: { zenith: '#04071a', mid: '#141a4c', horizon: '#3e2a6e', glow: '#9aa4ff', glowStrength: 0.22 },
    fog: '#3e2a6e', // = sky.horizon: distant buildings fade into the horizon
    stars: true,
    orb: {
      kind: 'moon', fill: '#f7f2d8', edge: '#d8d0a6', rim: '#fffbea', face: '#3a3452', cheek: '#f4a3a8',
      glow: [190, 200, 255], glowAlpha: 0.5, rays: null, craters: '#ddd4a8',
    },
    hemi: { sky: '#c3cbff', ground: '#3b3358', intensity: 0.95 },
    key: { color: '#d6dcff', intensity: 0.6, dir: [-0.45, 0.7, 0.55] },
    monkeyLift: '#2a1e18',
    buildings: ['#46507f', '#62447a', '#33627a', '#6a6488'],
    windowLit: ['#ffd36b', '#ffe6a3', '#fff7e2', '#9fd4ff'],
    windowOff: '#171b30',
    litRatio: 0.42,
    char: '#15100e',
    roof: {
      metal: '#6a7092', dark: '#2a2d42', tank: '#7a5238', tankBand: '#3a2a22', tankRoof: '#4c3a30',
      light: '#ff3b30', lightOff: '#3a1412',
    },
    street: {
      ground: '#1a1730', road: '#262540', sidewalk: '#3c3a58', curb: '#4f4d6e', marking: '#c9b56c',
      lampPole: '#34364f', lampHead: '#ffe3a0', pool: '#ffc56e',
    },
    bg: ['#181a3a', '#1c1b40', '#221c47'],
    bgWindow: ['#ffd88a', '#fff0c8', '#ffc870'],
    bgLitRatio: 0.2,
    clouds: '#3a3a72',
    fx: { smoke: '#3b3542', dust: '#8c8296', flash: '#fff4c2' },
    wind: { kind: 'sparkle', colors: ['#fff6c4', '#c2e6ff', '#ffd6f2'] },
    trail: '#fff0a0',
  },

  sunset: {
    name: 'sunset',
    sky: { zenith: '#2a2468', mid: '#b24e7e', horizon: '#ffa25a', glow: '#ffd27a', glowStrength: 0.5 },
    fog: '#ffa25a',
    stars: false,
    orb: {
      kind: 'sun', fill: '#ffd860', edge: '#ff9a3c', rim: '#fff2b0', face: '#7a3216', cheek: '#ff7458',
      glow: [255, 196, 96], glowAlpha: 0.6, rays: null, craters: null,
    },
    hemi: { sky: '#ffd9b8', ground: '#6c3652', intensity: 0.85 },
    key: { color: '#ffc28c', intensity: 0.7, dir: [-0.55, 0.5, 0.65] },
    monkeyLift: '#1c0e08',
    buildings: ['#b85a4c', '#cf8f50', '#8e4c6a', '#d9ae7e'],
    windowLit: ['#ffe8a2', '#ffd27a', '#fff4d2', '#ffc08a'],
    windowOff: '#5a3450',
    litRatio: 0.18,
    char: '#2a1612',
    roof: {
      metal: '#9a7a84', dark: '#4a2e3a', tank: '#8a5638', tankBand: '#4a2c22', tankRoof: '#5e3a32',
      light: '#ff3b30', lightOff: '#5a2420',
    },
    street: {
      ground: '#4a2c3e', road: '#40293c', sidewalk: '#7c5562', curb: '#906874', marking: '#f4d28c',
      lampPole: '#3c2a38', lampHead: '#ffe8bc', pool: null,
    },
    bg: ['#5c2e54', '#7e3f5f', '#a95866'],
    bgWindow: ['#ffe2a0', '#ffd080'],
    bgLitRatio: 0.12,
    clouds: '#ffb69a',
    fx: { smoke: '#4a3436', dust: '#c8a088', flash: '#fff2c0' },
    wind: { kind: 'leaf', colors: ['#e0682a', '#f2a03a', '#c8452e', '#a8722e'] },
    trail: '#fff2b0',
  },

  // Nostalgic: solid blue sky, red / cyan / light grey / teal buildings, yellow windows, a yellow sun with a face.
  classic: {
    name: 'classic',
    sky: { zenith: '#0000aa', mid: '#0000aa', horizon: '#0000aa', glow: '#5555ff', glowStrength: 0 },
    fog: '#0000aa',
    stars: false,
    orb: {
      kind: 'sun', fill: '#ffff55', edge: '#ffff55', rim: '#ffff55', face: '#0000aa', cheek: null,
      glow: null, glowAlpha: 0, rays: '#ffff55', craters: null,
    },
    hemi: { sky: '#ffffff', ground: '#9c9cb8', intensity: 0.95 },
    key: { color: '#ffffff', intensity: 0.4, dir: [-0.45, 0.7, 0.55] },
    monkeyLift: '#000000',
    buildings: ['#aa0000', '#00aaaa', '#aaaaaa', '#008a8a'],
    windowLit: ['#ffff55'],
    windowOff: '#555555',
    litRatio: 0.62,
    char: '#1a1a1a',
    roof: {
      metal: '#888888', dark: '#444444', tank: '#aa5500', tankBand: '#552a00', tankRoof: '#555555',
      light: '#ff5555', lightOff: '#550000',
    },
    street: {
      ground: '#00005a', road: '#2a2a3c', sidewalk: '#777777', curb: '#999999', marking: '#ffff55',
      lampPole: '#555555', lampHead: '#ffff55', pool: null,
    },
    bg: ['#00007e', '#000088', '#000094'],
    bgWindow: ['#ffff55'],
    bgLitRatio: 0.18,
    clouds: null,
    fx: { smoke: '#555555', dust: '#aaaaaa', flash: '#ffffaa' },
    wind: { kind: 'dust', colors: ['#ffffff', '#aaaaff', '#ffff55'] },
    trail: '#ffff88',
  },
};

export const THEME_NAMES = Object.keys(THEMES);
export const DEFAULT_THEME = 'night';

/** Theme by name; unknown names fall back to the default. */
export function getTheme(name) {
  return THEMES[name] ?? THEMES[DEFAULT_THEME];
}
