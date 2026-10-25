import { CELL, COLS, ROWS, MAX_BUILDING_CELLS, MIN_BUILDING_CELLS } from './constants.js';

// Skyline shapes, as in the original game: rising, falling, a valley, a peak, or no trend.
export const PATTERNS = ['up', 'down', 'valley', 'peak', 'random'];
export const BUILDING_COLORS = 4; // themes map color index 0..3 to real colors

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * The destructible skyline: a COLS x ROWS grid of cells. Row 0 is at street level.
 * grid[row * COLS + col] is 0 for air, or building.id + 1 for a solid cell.
 */
export class City {
  constructor(buildings, grid, pattern = 'random') {
    this.buildings = buildings;
    this.grid = grid;
    this.pattern = pattern;
  }

  static generate(rng) {
    const pattern = rng.pick(PATTERNS);
    const spans = [];
    let col = 0;
    while (col < COLS) {
      const left = COLS - col;
      let width = Math.min(rng.int(4, 8), left);
      if (left - width < 4) width = left; // absorb a sliver at the right edge
      spans.push([col, col + width]);
      col += width;
      if (COLS - col > 4 && rng.chance(0.3)) col += 1; // an alley, unless it would leave a sliver
    }

    const n = spans.length;
    const lo = MIN_BUILDING_CELLS + 2;
    const hi = MAX_BUILDING_CELLS - 6;
    const buildings = [];
    let prevColor = -1;
    spans.forEach(([col0, col1], i) => {
      const t = n > 1 ? i / (n - 1) : 0.5;
      const edge = Math.abs(2 * t - 1); // 1 at the edges, 0 in the middle
      const base = {
        up: lo + (hi - lo) * t,
        down: hi - (hi - lo) * t,
        valley: lo + (hi - lo) * edge,
        peak: lo + (hi - lo) * (1 - edge),
        random: (lo + hi) / 2,
      }[pattern];
      const jitter = pattern === 'random' ? 10 : 6;
      const height = clamp(Math.round(base + rng.int(-jitter, jitter)), MIN_BUILDING_CELLS, MAX_BUILDING_CELLS);
      let color = rng.int(0, BUILDING_COLORS - 1);
      if (color === prevColor) color = (color + 1 + rng.int(0, BUILDING_COLORS - 2)) % BUILDING_COLORS;
      prevColor = color;
      buildings.push({
        id: i, col0, col1, height, color,
        windowSeed: rng.int(0, 0x7fffffff), // renderer: which windows are lit
        roof: rng.int(0, 3),                // renderer: roof decoration style
      });
    });

    const grid = new Uint8Array(COLS * ROWS);
    for (const b of buildings) {
      for (let c = b.col0; c < b.col1; c++) {
        for (let r = 0; r < b.height; r++) grid[r * COLS + c] = b.id + 1;
      }
    }
    return new City(buildings, grid, pattern);
  }

  clone() {
    return new City(this.buildings.map(b => ({ ...b })), new Uint8Array(this.grid), this.pattern);
  }

  isSolid(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return this.grid[row * COLS + col] !== 0;
  }

  // Building id at a cell, or -1 for air.
  cellBuilding(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return -1;
    return this.grid[row * COLS + col] - 1;
  }

  solidAt(x, y) {
    if (y < 0) return false;
    return this.isSolid(Math.floor(x / CELL), Math.floor(y / CELL));
  }

  // Height (in world units) of the top of the highest solid cell in a column; 0 if empty.
  columnTop(col) {
    for (let r = ROWS - 1; r >= 0; r--) if (this.isSolid(col, r)) return (r + 1) * CELL;
    return 0;
  }

  /**
   * Highest walkable surface at or below `fromY` under the x-range [x0, x1]. 0 is the street.
   * A monkey standing on it at `fromY` is supported when the result equals fromY.
   */
  supportY(x0, x1, fromY) {
    const c0 = Math.max(0, Math.floor(x0 / CELL));
    const c1 = Math.min(COLS - 1, Math.floor((x1 - 1e-9) / CELL));
    const startRow = Math.min(ROWS - 1, Math.floor((fromY - 1e-6) / CELL));
    let best = 0;
    for (let c = c0; c <= c1; c++) {
      for (let r = startRow; r >= 0; r--) {
        if (this.isSolid(c, r)) {
          best = Math.max(best, (r + 1) * CELL);
          break;
        }
      }
    }
    return best;
  }

  /**
   * Remove every cell whose center lies within `radius` (plus a quarter cell, for rounder craters).
   * Returns the removed cells: [{ col, row, building }].
   */
  carve(x, y, radius) {
    const removed = [];
    const reach = radius + CELL * 0.25;
    const c0 = Math.max(0, Math.floor((x - reach) / CELL));
    const c1 = Math.min(COLS - 1, Math.floor((x + reach) / CELL));
    const r0 = Math.max(0, Math.floor((y - reach) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((y + reach) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * COLS + c;
        if (!this.grid[i]) continue;
        const cx = (c + 0.5) * CELL;
        const cy = (r + 0.5) * CELL;
        if ((cx - x) ** 2 + (cy - y) ** 2 <= reach * reach) {
          removed.push({ col: c, row: r, building: this.grid[i] - 1 });
          this.grid[i] = 0;
        }
      }
    }
    return removed;
  }

  /**
   * Choose the two monkeys' rooftops: the 2nd or 3rd building from each end.
   * Returns [{ x, y, building }, { x, y, building }] with x at the roof center and y on the roof.
   */
  monkeySpots(rng) {
    const n = this.buildings.length;
    const left = this.buildings[Math.min(n - 1, rng.int(1, 2))];
    const right = this.buildings[Math.max(0, n - 1 - rng.int(1, 2))];
    return [left, right].map(b => ({
      x: ((b.col0 + b.col1) / 2) * CELL,
      y: b.height * CELL,
      building: b.id,
    }));
  }
}
