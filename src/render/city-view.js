// The destructible skyline: one InstancedMesh for all cells, one for all windows (front and back faces),
// plus roof decorations. Craters hide cells (zero-scale matrices) and char the cells around the hole.
import * as THREE from 'three';
import { BUILDING_DEPTH, CELL, COLS, ROWS } from '../core/constants.js';
import { RoofDecor } from './roof.js';
import { clamp, hash3, smoothstep, themeColor } from './util.js';

const CAP = COLS * ROWS;
const HALF_D = BUILDING_DEPTH / 2;
const WIN_W = 0.95;
const WIN_H = 1.2;
// Window shapes (scale of the base quad, vertical offset from the cell center).
const WINDOW_STYLES = [
  { sx: 1, sy: 1, lift: 0.12 },        // square-ish
  { sx: 1.45, sy: 0.8, lift: 0.1 },    // wide
  { sx: 0.72, sy: 1.3, lift: 0.05 },   // tall and narrow
];
const SHOP_WINDOW = { sx: 1.6, sy: 1.05, lift: -0.15 };
const WIN_GAP = 0.03;      // distance in front of the facade (plus polygon offset)
const CHAR_REACH = CELL * 1.8;
const BROKEN = 0.35;       // charred more than this: the window goes dark
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class CityView {
  /** @param {{parent: THREE.Object3D, quality?: string, shadows?: boolean}} opts */
  constructor({ parent, quality = 'high', shadows = false }) {
    this.group = new THREE.Group();
    this.group.name = 'city';
    parent.add(this.group);

    this.cells = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CELL, CELL, BUILDING_DEPTH),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      CAP,
    );
    this.cells.name = 'cityCells';
    this.cells.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3), 3);
    this.cells.count = 0;
    this.cells.frustumCulled = false;
    this.cells.castShadow = shadows;
    this.cells.receiveShadow = shadows;

    this.windows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(WIN_W, WIN_H),
      new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }),
      CAP * 2,
    );
    this.windows.name = 'cityWindows';
    this.windows.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 6), 3);
    this.windows.count = 0;
    this.windows.frustumCulled = false;
    this.group.add(this.cells, this.windows);

    this.cellInst = new Int32Array(CAP).fill(-1); // grid index -> instance
    this.instCell = new Int32Array(CAP);          // instance -> grid index
    this.cellBld = new Int16Array(CAP).fill(-1);  // grid index -> building id (kept after removal)
    this.char = new Float32Array(CAP);
    this.removed = new Uint8Array(CAP);
    this.tint = new Float32Array(0);
    this.litBias = new Float32Array(0);
    this.style = new Uint8Array(0);
    this.count = 0;

    this.decor = new RoofDecor({ parent: this.group, quality, shadows });
    this.city = null;
    this.theme = null;
    this.m = new THREE.Matrix4();
    this.backRot = new THREE.Matrix4().makeRotationY(Math.PI);
    this.color = new THREE.Color();
  }

  /**
   * Rebuild every mesh for a new city (current grid state, so already-removed cells stay gone).
   * @param {object} city core City
   * @param {object[]} monkeys game.monkeys (their buildings get no roof decorations)
   * @param {import('./themes.js').Theme} [theme]
   */
  build(city, monkeys, theme) {
    this.city = city;
    if (theme) this.theme = theme;
    this.cellInst.fill(-1);
    this.cellBld.fill(-1);
    this.char.fill(0);
    this.removed.fill(0);
    const nb = city.buildings.length;
    this.tint = new Float32Array(nb);
    this.litBias = new Float32Array(nb);
    this.style = new Uint8Array(nb);
    for (const b of city.buildings) {
      this.tint[b.id] = 0.93 + 0.14 * hash3(b.id, b.windowSeed, 11);
      this.litBias[b.id] = hash3(b.id, b.windowSeed, 23);
      this.style[b.id] = Math.floor(hash3(b.id, b.windowSeed, 37) * WINDOW_STYLES.length);
    }

    let n = 0;
    const m = this.m;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const idx = row * COLS + col;
        const bid = city.grid[idx] - 1;
        if (bid < 0) continue;
        const i = n++;
        this.cellInst[idx] = i;
        this.instCell[i] = idx;
        this.cellBld[idx] = bid;
        const x = (col + 0.5) * CELL;
        const y = (row + 0.5) * CELL;
        this.cells.setMatrixAt(i, m.makeTranslation(x, y, 0));
        // Window shape: shop fronts on the street, otherwise one style per building.
        const style = row === 0 ? SHOP_WINDOW : WINDOW_STYLES[this.style[bid]];
        const wy = y + style.lift;
        this.windows.setMatrixAt(2 * i, m.makeScale(style.sx, style.sy, 1).setPosition(x, wy, HALF_D + WIN_GAP));
        this.windows.setMatrixAt(2 * i + 1, m.makeScale(style.sx, style.sy, 1).premultiply(this.backRot).setPosition(x, wy, -HALF_D - WIN_GAP));
      }
    }
    this.count = n;
    this.cells.count = n;
    this.windows.count = 2 * n;
    this.cells.instanceMatrix.needsUpdate = true;
    this.windows.instanceMatrix.needsUpdate = true;

    const skip = new Set();
    for (const mk of monkeys ?? []) {
      const col = Math.floor(mk.x / CELL);
      for (const b of city.buildings) if (col >= b.col0 && col < b.col1) skip.add(b.id);
    }
    this.decor.build(city, skip);
    if (this.theme) this.recolor(this.theme);
  }

  /** Color of a cell (also valid for removed cells, for debris). */
  cellColor(idx, target) {
    const theme = this.theme;
    const b = this.city?.buildings[this.cellBld[idx]];
    if (!theme || !b) return target.set(0x808080);
    const row = (idx / COLS) | 0;
    target.copy(themeColor(theme.buildings[b.color] ?? theme.buildings[0]));
    let shade = this.tint[b.id] * (0.8 + 0.2 * smoothstep(0, 5, row));
    if (row === b.height - 1) shade *= 1.07;
    target.multiplyScalar(shade);
    if (this.char[idx] > 0) target.lerp(themeColor(theme.char), this.char[idx]);
    return target;
  }

  /** Color of the cell at (col, row), for debris. */
  colorAt(col, row, target) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return target.set(0x808080);
    return this.cellColor(row * COLS + col, target);
  }

  windowColor(idx, back, target) {
    const theme = this.theme;
    const b = this.city.buildings[this.cellBld[idx]];
    if (this.char[idx] > BROKEN) return target.copy(themeColor(theme.windowOff)).multiplyScalar(0.3);
    const col = idx % COLS;
    const row = (idx / COLS) | 0;
    const ratio = clamp(theme.litRatio * (0.5 + this.litBias[b.id]) * (row === 0 ? 1.3 : 1), 0, 0.95);
    const h = hash3(col, row + (back ? 977 : 0), b.windowSeed);
    if (h >= ratio) return target.copy(themeColor(theme.windowOff));
    const lit = theme.windowLit;
    const p = hash3(col * 7 + 3, row * 13 + (back ? 5 : 1), b.windowSeed ^ 0x2545f491);
    const k = p < 0.55 || lit.length < 2 ? 0 : Math.min(lit.length - 1, 1 + Math.floor(((p - 0.55) / 0.45) * (lit.length - 1)));
    return target.copy(themeColor(lit[k])).multiplyScalar(0.86 + 0.14 * (h / ratio));
  }

  /** @param {import('./themes.js').Theme} theme */
  recolor(theme) {
    this.theme = theme;
    if (this.city) {
      const c = this.color;
      for (let i = 0; i < this.count; i++) {
        const idx = this.instCell[i];
        this.cells.setColorAt(i, this.cellColor(idx, c));
        this.windows.setColorAt(2 * i, this.windowColor(idx, false, c));
        this.windows.setColorAt(2 * i + 1, this.windowColor(idx, true, c));
      }
      this.cells.instanceColor.needsUpdate = true;
      this.windows.instanceColor.needsUpdate = true;
    }
    this.decor.recolor(theme);
  }

  /**
   * Apply a 'crater' event: hide removed cells and their windows, char the rim, drop roof decorations.
   * @param {{x:number, y:number, radius:number, removed:{col:number,row:number,building:number}[]}} crater
   */
  applyCrater({ x, y, radius, removed }) {
    if (!this.city) return;
    let hidden = false;
    for (const r of removed ?? []) {
      const idx = r.row * COLS + r.col;
      const i = this.cellInst[idx];
      if (i < 0 || this.removed[idx]) continue;
      this.removed[idx] = 1;
      this.cells.setMatrixAt(i, ZERO);
      this.windows.setMatrixAt(2 * i, ZERO);
      this.windows.setMatrixAt(2 * i + 1, ZERO);
      hidden = true;
      const b = this.city.buildings[r.building];
      if (b && r.row >= b.height - 1) this.decor.hideBuilding(b.id);
    }
    if (hidden) {
      this.cells.instanceMatrix.needsUpdate = true;
      this.windows.instanceMatrix.needsUpdate = true;
    }

    if (!this.theme || !(radius > 0)) return;
    const reach = radius + CHAR_REACH;
    const c0 = Math.max(0, Math.floor((x - reach) / CELL));
    const c1 = Math.min(COLS - 1, Math.floor((x + reach) / CELL));
    const r0 = Math.max(0, Math.floor((y - reach) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((y + reach) / CELL));
    const c = this.color;
    let recolored = false;
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const idx = row * COLS + col;
        const i = this.cellInst[idx];
        if (i < 0 || this.removed[idx]) continue;
        const d = Math.hypot((col + 0.5) * CELL - x, (row + 0.5) * CELL - y);
        const amount = clamp(1 - (d - radius) / CHAR_REACH, 0, 1) * 0.85;
        if (amount <= this.char[idx]) continue;
        this.char[idx] = amount;
        this.cells.setColorAt(i, this.cellColor(idx, c));
        this.windows.setColorAt(2 * i, this.windowColor(idx, false, c));
        this.windows.setColorAt(2 * i + 1, this.windowColor(idx, true, c));
        recolored = true;
      }
    }
    if (recolored) {
      this.cells.instanceColor.needsUpdate = true;
      this.windows.instanceColor.needsUpdate = true;
    }
  }

  update(time) {
    this.decor.update(time);
  }

  dispose() {
    this.decor.dispose();
    for (const mesh of [this.cells, this.windows]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh.dispose();
    }
    this.group.removeFromParent();
    this.city = null;
  }
}
