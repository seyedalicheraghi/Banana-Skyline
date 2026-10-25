// World units are "meters". The game is played in the vertical x/y plane at z = 0:
// x grows to the right (player 0 on the left, player 1 on the right), y grows up, y = 0 is the street.

export const CELL = 2;               // size of one destructible building cell
export const COLS = 72;              // grid columns
export const ROWS = 48;              // grid rows
export const CITY_WIDTH = COLS * CELL;   // 144
export const CITY_HEIGHT = ROWS * CELL;  // 96
export const BUILDING_DEPTH = 12;    // visual depth of buildings along z (physics ignores z)

export const MIN_BUILDING_CELLS = 6;  // building height range, in cells
export const MAX_BUILDING_CELLS = 36;

export const GRAVITY_PRESETS = { earth: 9.8, moon: 1.62, mars: 3.71, jupiter: 24.79 };
export const DEFAULT_GRAVITY = GRAVITY_PRESETS.earth;

export const WIND_SCALE = 0.3;       // wind number (-15..15) -> horizontal acceleration (m/s^2)
export const MAX_WIND = 15;

export const MAX_POWER = 100;        // power 0..100
export const POWER_TO_SPEED = 0.6;   // power -> launch speed (m/s); 100 -> 60 m/s

export const BANANA_RADIUS = 0.45;
// Monkey hit box: centered on monkey.x, standing on monkey.y (feet).
export const MONKEY = { width: 3.6, height: 5, handX: 1.35, handY: 4.25, footHalf: 1.2 };

export const CRATER_RADIUS = 3.4;    // banana hits a building
export const BIG_CRATER_RADIUS = 6.5; // banana hits a monkey
export const SPLASH_RADIUS = 2.2;    // explosion this close to a monkey's box also hits it
export const GROUND_SPLASH = 1.6;    // visual size of a street impact

export const SIM_DT = 1 / 240;       // fixed physics step
export const OUT_MARGIN = 40;        // banana is "out" this far beyond either city edge
export const MAX_FLIGHT_TIME = 30;

// The sun sits in the sky behind the play plane; the banana can pass through it (it reacts, flight continues).
export const SUN = { x: CITY_WIDTH / 2, y: 86, radius: 5 };

export const FALL_GRAVITY = 30;      // monkeys drop faster than bananas for snappier feel

// Seconds spent in each pause between game phases.
export const TIMING = {
  impact: 1.1,      // after a miss, before the next turn
  monkeyHit: 1.4,   // after a monkey is hit, before the round-over celebration
  roundOver: 4.0,   // victory dance before the next round
  cpuThink: 1.2,    // minimum CPU "thinking" time
  throwAnim: 0.7,   // how long monkey.anim stays 'throw'
};

export const DEFAULT_AIM = { angle: 45, power: 50 };

// In VR the world group is scaled by this so a 5 m monkey feels person-sized.
export const VR_SCALE = 0.4;

// Identity colors (headband, HUD name, score) for player 0 (left) and player 1 (right).
export const PLAYER_COLORS = ['#3fb6ff', '#ff6b4a'];
