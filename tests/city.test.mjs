import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { City, PATTERNS, BUILDING_COLORS } from '../src/core/city.js';
import {
  CELL, COLS, ROWS, CITY_WIDTH, MIN_BUILDING_CELLS, MAX_BUILDING_CELLS, MONKEY,
} from '../src/core/constants.js';
import { createRng } from '../src/core/rng.js';
import { cellKeys, makeCity } from './helpers.mjs';

const SEEDS = Array.from({ length: 300 }, (_, i) => (i * 2654435761 + 12345) >>> 0);
const generate = (seed) => City.generate(createRng(seed));
const CITIES = SEEDS.map(seed => ({ seed, city: generate(seed) }));
const solidCount = (city) => city.grid.reduce((n, v) => n + (v ? 1 : 0), 0);

describe('City.generate: layout', () => {
  test('the grid matches the buildings cell for cell', () => {
    for (const { seed, city } of CITIES.slice(0, 80)) {
      assert.equal(city.grid.length, COLS * ROWS);
      const expected = new Uint8Array(COLS * ROWS);
      for (const b of city.buildings) {
        for (let c = b.col0; c < b.col1; c++) for (let r = 0; r < b.height; r++) expected[r * COLS + c] = b.id + 1;
      }
      assert.deepEqual(city.grid, expected, `seed ${seed}`);
    }
  });

  test('building ids are their index in the list', () => {
    for (const { city } of CITIES) city.buildings.forEach((b, i) => assert.equal(b.id, i));
  });

  test('buildings tile columns 0..COLS-1 from left to right without overlap', () => {
    for (const { seed, city } of CITIES) {
      const bs = city.buildings;
      assert.equal(bs[0].col0, 0, `seed ${seed}: first building starts at column 0`);
      assert.equal(bs.at(-1).col1, COLS, `seed ${seed}: last building ends at the right edge`);
      for (let i = 0; i < bs.length; i++) {
        assert.ok(bs[i].col1 > bs[i].col0, `seed ${seed}: building ${i} is empty`);
        if (i > 0) {
          const gap = bs[i].col0 - bs[i - 1].col1;
          assert.ok(gap >= 0, `seed ${seed}: buildings ${i - 1} and ${i} overlap`);
          assert.ok(gap <= 1, `seed ${seed}: alley wider than one column before building ${i}`);
        }
      }
    }
  });

  test('alleys are empty all the way up', () => {
    for (const { seed, city } of CITIES.slice(0, 80)) {
      const covered = new Set();
      for (const b of city.buildings) for (let c = b.col0; c < b.col1; c++) covered.add(c);
      for (let c = 0; c < COLS; c++) {
        if (!covered.has(c)) assert.equal(city.columnTop(c), 0, `seed ${seed}: alley column ${c}`);
      }
    }
  });

  test('building heights stay within MIN_BUILDING_CELLS..MAX_BUILDING_CELLS', () => {
    for (const { seed, city } of CITIES) {
      for (const b of city.buildings) {
        assert.ok(Number.isInteger(b.height), `seed ${seed}`);
        assert.ok(b.height >= MIN_BUILDING_CELLS && b.height <= MAX_BUILDING_CELLS, `seed ${seed}: height ${b.height}`);
      }
    }
  });

  test('buildings are 4..8 columns wide; only the last may be wider (it absorbs the right edge)', () => {
    for (const { seed, city } of CITIES) {
      const bs = city.buildings;
      bs.slice(0, -1).forEach((b, i) => {
        const w = b.col1 - b.col0;
        assert.ok(w >= 4 && w <= 8, `seed ${seed}: building ${i} is ${w} columns wide`);
      });
      const last = bs.at(-1).col1 - bs.at(-1).col0;
      assert.ok(last <= 11, `seed ${seed}: last building is ${last} columns wide`);
    }
  });

  // city.js: "if (left - width < 4) width = left; // absorb a sliver at the right edge".
  test('the right edge never leaves a sliver building narrower than 4 columns', () => {
    const slivers = CITIES
      .filter(({ city }) => city.buildings.at(-1).col1 - city.buildings.at(-1).col0 < 4)
      .map(({ seed, city }) => `seed ${seed}: last building cols ${city.buildings.at(-1).col0}..${city.buildings.at(-1).col1 - 1}`);
    assert.deepEqual(slivers, [], `${slivers.length} of ${CITIES.length} cities end in a sliver`);
  });

  test('colors are 0..3 and neighbours never share a color', () => {
    const used = new Set();
    for (const { seed, city } of CITIES) {
      city.buildings.forEach((b, i) => {
        assert.ok(Number.isInteger(b.color) && b.color >= 0 && b.color < BUILDING_COLORS, `seed ${seed}: color ${b.color}`);
        if (i > 0) assert.notEqual(b.color, city.buildings[i - 1].color, `seed ${seed}: buildings ${i - 1} and ${i}`);
        used.add(b.color);
      });
    }
    assert.equal(BUILDING_COLORS, 4);
    assert.equal(used.size, 4);
  });

  test('roof style is 0..3 and windowSeed is a non-negative integer', () => {
    for (const { city } of CITIES) {
      for (const b of city.buildings) {
        assert.ok(Number.isInteger(b.roof) && b.roof >= 0 && b.roof <= 3, `roof ${b.roof}`);
        assert.ok(Number.isInteger(b.windowSeed) && b.windowSeed >= 0 && b.windowSeed <= 0x7fffffff);
      }
    }
  });

  test('every skyline pattern occurs and is reported', () => {
    const seen = new Set(CITIES.map(({ city }) => city.pattern));
    for (const p of seen) assert.ok(PATTERNS.includes(p), `unknown pattern ${p}`);
    assert.deepEqual([...seen].sort(), [...PATTERNS].sort());
  });

  test('skylines follow their pattern: up rises, down falls, valley dips, peak bulges', () => {
    const middle = (bs) => bs[Math.round((bs.length - 1) / 2)].height;
    const checks = {
      up: (bs) => bs[0].height < bs.at(-1).height,
      down: (bs) => bs[0].height > bs.at(-1).height,
      valley: (bs) => middle(bs) < Math.min(bs[0].height, bs.at(-1).height),
      peak: (bs) => middle(bs) > Math.max(bs[0].height, bs.at(-1).height),
    };
    const counts = {};
    for (const { seed, city } of CITIES) {
      const check = checks[city.pattern];
      if (!check) continue;
      counts[city.pattern] = (counts[city.pattern] ?? 0) + 1;
      assert.ok(check(city.buildings), `seed ${seed}: ${city.pattern} heights ${city.buildings.map(b => b.height)}`);
    }
    for (const p of Object.keys(checks)) assert.ok(counts[p] >= 10, `too few ${p} samples`);
  });

  test('the same seed generates the same city', () => {
    for (const seed of SEEDS.slice(0, 40)) {
      const a = generate(seed);
      const b = generate(seed);
      assert.deepEqual(a.buildings, b.buildings);
      assert.deepEqual(a.grid, b.grid);
      assert.equal(a.pattern, b.pattern);
    }
  });

  test('different seeds generate different cities', () => {
    const shapes = new Set(CITIES.map(({ city }) => city.buildings.map(b => `${b.col0}:${b.height}`).join(',')));
    assert.ok(shapes.size > CITIES.length * 0.95, `${shapes.size} distinct skylines out of ${CITIES.length}`);
  });
});

describe('City cell queries', () => {
  // Building 0: column 5, rows 0..2 (x 10..12, y 0..6). Building 1: columns 10..11, rows 0..9.
  const city = makeCity([{ col0: 5, col1: 6, row1: 3 }, { col0: 10, col1: 12, row1: 10 }]);

  test('isSolid() is false outside the grid on every side', () => {
    const full = makeCity([{ col0: 0, col1: COLS, row1: ROWS }]);
    assert.equal(full.isSolid(0, 0), true);
    assert.equal(full.isSolid(COLS - 1, ROWS - 1), true);
    for (const [c, r] of [[-1, 0], [0, -1], [COLS, 0], [0, ROWS], [-5, -5], [COLS + 3, ROWS + 3]]) {
      assert.equal(full.isSolid(c, r), false, `${c},${r}`);
    }
  });

  test('isSolid() and cellBuilding() agree with the grid', () => {
    assert.equal(city.isSolid(5, 0), true);
    assert.equal(city.isSolid(5, 2), true);
    assert.equal(city.isSolid(5, 3), false);
    assert.equal(city.isSolid(4, 0), false);
    assert.equal(city.cellBuilding(5, 1), 0);
    assert.equal(city.cellBuilding(11, 9), 1);
    assert.equal(city.cellBuilding(6, 0), -1);
    assert.equal(city.cellBuilding(-1, 0), -1);
    assert.equal(city.cellBuilding(COLS, 0), -1);
    assert.equal(city.cellBuilding(0, ROWS), -1);
  });

  test('solidAt() maps world points to cells, with cell edges belonging to the cell on their right/top', () => {
    assert.equal(city.solidAt(10, 0), true);
    assert.equal(city.solidAt(11.9, 5.9), true);
    assert.equal(city.solidAt(9.999, 1), false);
    assert.equal(city.solidAt(12, 1), false);
    assert.equal(city.solidAt(11, 6), false);
    assert.equal(city.solidAt(23.5, 19.5), true);
    assert.equal(city.solidAt(23.5, 20), false);
  });

  test('solidAt() is false below the street and beyond the city edges', () => {
    const full = makeCity([{ col0: 0, col1: COLS, row1: ROWS }]);
    assert.equal(full.solidAt(50, 0), true);
    assert.equal(full.solidAt(50, -0.01), false);
    assert.equal(full.solidAt(50, -100), false);
    assert.equal(full.solidAt(-0.01, 10), false);
    assert.equal(full.solidAt(CITY_WIDTH, 10), false);
    assert.equal(full.solidAt(CITY_WIDTH + 30, 10), false);
    assert.equal(full.solidAt(50, ROWS * CELL), false);
  });

  test('solidAt() agrees with the grid on a generated city', () => {
    const { city: gen } = CITIES[0];
    const rng = createRng(5);
    for (let i = 0; i < 5000; i++) {
      const x = rng.float(0, CITY_WIDTH);
      const y = rng.float(0, ROWS * CELL);
      const c = Math.floor(x / CELL);
      const r = Math.floor(y / CELL);
      assert.equal(gen.solidAt(x, y), gen.grid[r * COLS + c] !== 0);
    }
  });

  test('columnTop() is the top of the highest solid cell, or 0', () => {
    assert.equal(city.columnTop(5), 6);
    assert.equal(city.columnTop(10), 20);
    assert.equal(city.columnTop(0), 0);
    assert.equal(city.columnTop(-1), 0);
    assert.equal(city.columnTop(COLS), 0);
    const floating = makeCity([{ col0: 3, col1: 4, row0: 20, row1: 21 }]);
    assert.equal(floating.columnTop(3), 42);
  });

  test('columnTop() equals building height on a generated city', () => {
    for (const { city: gen } of CITIES.slice(0, 50)) {
      for (const b of gen.buildings) {
        for (let c = b.col0; c < b.col1; c++) assert.equal(gen.columnTop(c), b.height * CELL);
      }
    }
  });
});

describe('City.carve', () => {
  const fullCity = () => makeCity([{ col0: 0, col1: COLS, row1: ROWS }]);
  const expectedCrater = (city, x, y, radius) => {
    const reach = radius + CELL / 4;
    const cells = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (!city.isSolid(c, r)) continue;
        if (((c + 0.5) * CELL - x) ** 2 + ((r + 0.5) * CELL - y) ** 2 <= reach * reach) cells.push({ col: c, row: r });
      }
    }
    return cells;
  };

  test('removes exactly the cells whose centers are within radius + CELL/4 and returns them', () => {
    const cases = [[50, 40, 3.4], [51, 41, 6.5], [70.3, 33.7, 2.2], [1, 1, 3.4], [0, 0, 5], [143, 95, 4], [72, 0.5, 1]];
    for (const [x, y, radius] of cases) {
      const city = fullCity();
      const want = expectedCrater(city, x, y, radius);
      const before = solidCount(city);
      const removed = city.carve(x, y, radius);
      assert.deepEqual(cellKeys(removed), cellKeys(want), `carve(${x}, ${y}, ${radius})`);
      assert.equal(solidCount(city), before - want.length);
      for (const { col, row } of removed) assert.equal(city.isSolid(col, row), false);
      assert.ok(removed.length > 0);
    }
  });

  test('a cell center exactly at radius + CELL/4 is removed, one just beyond is kept', () => {
    const city = fullCity();
    // Center of cell (0,0) is (1,1). Reach = 1.5 + 0.5 = 2: cell (1,0) at (3,1) is exactly 2 away.
    const removed = cellKeys(city.carve(1, 1, 1.5));
    assert.ok(removed.includes('1,0'));
    assert.ok(removed.includes('0,1'));
    assert.ok(!removed.includes('1,1'), 'diagonal neighbour is sqrt(8) away');
    assert.deepEqual(removed, ['0,0', '0,1', '1,0']);
  });

  test('reports the building each removed cell belonged to', () => {
    const city = makeCity([{ col0: 10, col1: 12, row1: 10 }, { col0: 12, col1: 14, row1: 10 }]);
    const removed = city.carve(24, 10, 3.4);
    assert.ok(removed.length > 0);
    for (const cell of removed) assert.equal(cell.building, cell.col < 12 ? 0 : 1);
    assert.ok(removed.some(c => c.building === 0) && removed.some(c => c.building === 1));
  });

  test('air is never reported, and carving the same spot twice removes nothing new', () => {
    const city = makeCity([{ col0: 20, col1: 26, row1: 8 }]);
    const first = city.carve(46, 16, 3.4);
    for (const cell of first) assert.ok(cell.row < 8 && cell.col >= 20 && cell.col < 26);
    assert.deepEqual(city.carve(46, 16, 3.4), []);
  });

  test('carving far outside the grid removes nothing and does not throw', () => {
    const city = fullCity();
    assert.deepEqual(city.carve(-100, -100, 5), []);
    assert.deepEqual(city.carve(CITY_WIDTH + 50, 10, 3.4), []);
    assert.deepEqual(city.carve(70, 500, 6.5), []);
    assert.equal(solidCount(city), COLS * ROWS);
  });

  test('on a generated city it only touches solid cells near the blast', () => {
    for (const { seed, city: gen } of CITIES.slice(0, 30)) {
      const city = gen.clone();
      const b = city.buildings[4];
      const x = b.col0 * CELL + 1;
      const y = b.height * CELL - 1;
      const before = new Uint8Array(city.grid);
      const removed = city.carve(x, y, 3.4);
      assert.ok(removed.length > 0, `seed ${seed}`);
      const keys = new Set(cellKeys(removed));
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const i = r * COLS + c;
          if (keys.has(`${c},${r}`)) {
            assert.notEqual(before[i], 0);
            assert.equal(city.grid[i], 0);
          } else {
            assert.equal(city.grid[i], before[i]);
          }
        }
      }
      for (const cell of removed) assert.equal(cell.building, before[cell.row * COLS + cell.col] - 1);
    }
  });

  test('clone() gives an independent copy', () => {
    const { city: gen } = CITIES[1];
    const copy = gen.clone();
    assert.deepEqual(copy.grid, gen.grid);
    assert.deepEqual(copy.buildings, gen.buildings);
    assert.equal(copy.pattern, gen.pattern);
    const b = copy.buildings[3];
    copy.carve(b.col0 * CELL + 2, b.height * CELL - 1, 6.5);
    copy.buildings[0].height = 999;
    assert.notDeepEqual(copy.grid, gen.grid);
    assert.notEqual(gen.buildings[0].height, 999);
  });
});

describe('City.supportY', () => {
  test('a monkey on an intact roof is supported at roof height', () => {
    const city = makeCity([{ col0: 10, col1: 16, row1: 8 }]);
    assert.equal(city.supportY(25, 27, 16), 16);
    assert.equal(city.supportY(20.5, 31.5, 16), 16);
  });

  test('after the roof under the feet is carved away, support drops to what is left below', () => {
    const city = makeCity([{ col0: 10, col1: 16, row1: 8 }]);
    // Remove the top two rows of columns 12..13 (x 24..28).
    for (let c = 12; c < 14; c++) for (let r = 6; r < 8; r++) city.grid[r * COLS + c] = 0;
    assert.equal(city.supportY(25, 27, 16), 12);
    assert.ok(city.supportY(25, 27, 16) < 16);
  });

  test('one remaining column under the feet is enough support', () => {
    const city = makeCity([{ col0: 10, col1: 16, row1: 8 }]);
    city.grid[7 * COLS + 12] = 0; // x 24..26 loses its top cell, x 26..28 keeps it
    assert.equal(city.supportY(25, 27, 16), 16);
  });

  test('support after a real crater matches what carve() removed', () => {
    const city = makeCity([{ col0: 10, col1: 16, row1: 8 }]);
    city.carve(26, 15, 3.4);
    let expected = 0;
    for (let c = 12; c <= 13; c++) expected = Math.max(expected, city.columnTop(c));
    assert.ok(expected < 16);
    assert.equal(city.supportY(25, 27, 16), expected);
  });

  test('nothing underneath means the street (0)', () => {
    const city = makeCity([{ col0: 10, col1: 16, row1: 8 }]);
    assert.equal(city.supportY(50, 52, 30), 0);
    assert.equal(city.supportY(25, 27, 0), 0);
  });

  test('ignores anything above fromY (an overhang over the head)', () => {
    const city = makeCity([{ col0: 10, col1: 16, row1: 4 }, { col0: 10, col1: 16, row0: 10, row1: 12 }]);
    assert.equal(city.supportY(25, 27, 8), 8);
    assert.equal(city.supportY(25, 27, 19.9), 8);
    assert.equal(city.supportY(25, 27, 24), 24);
  });

  test('ranges that hang over the city edges do not throw', () => {
    const city = makeCity([{ col0: 0, col1: 2, row1: 5 }, { col0: COLS - 2, col1: COLS, row1: 3 }]);
    assert.equal(city.supportY(-3, 1, 10), 10);
    assert.equal(city.supportY(CITY_WIDTH - 1, CITY_WIDTH + 3, 10), 6);
    assert.equal(city.supportY(-10, -5, 10), 0);
  });
});

describe('City.monkeySpots', () => {
  test('spots are on the 2nd or 3rd building from each end, centered on the roof', () => {
    for (const { seed, city } of CITIES) {
      const spots = city.monkeySpots(createRng(seed ^ 0x5bd1e995));
      const n = city.buildings.length;
      assert.equal(spots.length, 2);
      const [left, right] = spots;
      assert.ok([1, 2].includes(left.building), `seed ${seed}: left on building ${left.building}`);
      assert.ok([n - 2, n - 3].includes(right.building), `seed ${seed}: right on building ${right.building} of ${n}`);
      for (const s of spots) {
        const b = city.buildings[s.building];
        assert.equal(s.x, ((b.col0 + b.col1) / 2) * CELL);
        assert.equal(s.y, b.height * CELL);
      }
      assert.ok(left.x < right.x);
    }
  });

  test('a monkey at a spot stands on the roof with open sky above', () => {
    for (const { seed, city } of CITIES.slice(0, 100)) {
      for (const s of city.monkeySpots(createRng(seed))) {
        assert.equal(city.solidAt(s.x, s.y - 0.01), true, `seed ${seed}: solid under the feet`);
        assert.equal(city.supportY(s.x - MONKEY.footHalf, s.x + MONKEY.footHalf, s.y), s.y, `seed ${seed}: supported`);
        // The whole hit box is in the air.
        for (let y = s.y + 0.01; y < s.y + MONKEY.height; y += 0.5) {
          for (let x = s.x - MONKEY.width / 2; x <= s.x + MONKEY.width / 2; x += 0.5) {
            assert.equal(city.solidAt(x, y), false, `seed ${seed}: box overlaps a building at ${x},${y}`);
          }
        }
      }
    }
  });

  test('both the 2nd and the 3rd building get picked over many rounds', () => {
    const { city } = CITIES[2];
    const n = city.buildings.length;
    const rng = createRng(1);
    const left = new Set();
    const right = new Set();
    for (let i = 0; i < 100; i++) {
      const [l, r] = city.monkeySpots(rng);
      left.add(l.building);
      right.add(r.building);
    }
    assert.deepEqual([...left].sort(), [1, 2]);
    assert.deepEqual([...right].sort((a, b) => a - b), [n - 3, n - 2]);
  });

  test('is deterministic for the same rng seed', () => {
    const { city } = CITIES[3];
    assert.deepEqual(city.monkeySpots(createRng(77)), city.monkeySpots(createRng(77)));
  });
});
