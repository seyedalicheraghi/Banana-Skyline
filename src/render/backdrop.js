// Static surroundings: ground, streets with lane markings, sidewalks, street lamps, low buildings on both
// sides of the city and 3 layers of background silhouettes. Built once; recolored on theme change.
// Everything is merged by material: lit props, unlit silhouettes, glowing windows/lamps, additive lamp pools.
import * as THREE from 'three';
import { CITY_WIDTH } from '../core/constants.js';
import { createRng } from '../core/rng.js';
import { ColorBatch, themeColor } from './util.js';

const STREET_X0 = -520;
const STREET_X1 = 680;
const STREET_LEN = STREET_X1 - STREET_X0;
const STREET_CX = (STREET_X0 + STREET_X1) / 2;
const BANANA_X0 = -48;              // the banana can fly this far out (OUT_MARGIN + a bit)
const BANANA_X1 = CITY_WIDTH + 48;
const POOL_SEGMENTS = 20;
// Lane markings sit this high above the road (y 0.01). In VR the world is scaled by 0.4 and the XR camera's near
// plane is 0.05, so a 1 cm gap z-fights on 24-bit depth beyond ~50 m; 5 cm holds to ~130 m (fog takes over there).
const MARKING_Y = 0.06;
const POOL_Y = MARKING_Y + 0.03; // additive lamp light pools lie over the markings

const LAYERS = [
  { z: [-66, -46], x: [-170, 320], w: [6, 15], h: [14, 62], d: [8, 14], win: { gx: 2.4, gy: 3.2, p: 0.5, w: 0.9, h: 1.2 } },
  { z: [-136, -92], x: [-300, 450], w: [10, 24], h: [22, 96], d: [12, 22], win: { gx: 3, gy: 4, p: 0.4, w: 1.1, h: 1.5 } },
  { z: [-250, -172], x: [-480, 640], w: [14, 34], h: [30, 140], d: [16, 30], win: { gx: 4, gy: 5, p: 0.3, w: 1.4, h: 1.9 } },
];
const LAYER_WINDOW_DIM = [0.72, 0.52, 0.38]; // keep the playable city the brightest thing on screen

const box = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
const flat = (w, d, x, y, z) => new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(x, y, z);
const quad = (w, h, x, y, z) => new THREE.PlaneGeometry(w, h).translate(x, y, z);

export class Backdrop {
  /** @param {{parent: THREE.Object3D, quality?: string, shadows?: boolean}} opts */
  constructor({ parent, quality = 'high', shadows = false }) {
    this.group = new THREE.Group();
    this.group.name = 'backdrop';
    parent.add(this.group);
    this.quality = quality;
    this.theme = null;
    this.lit = new ColorBatch();
    this.silhouettes = new ColorBatch();
    this.glow = new ColorBatch();
    this.lamps = [];
    const rng = createRng(20240611);

    this.buildStreets();
    this.buildLamps();
    this.buildSides(rng);
    this.buildLayers(rng);

    const gray = (key, rand, target) => target.set(0x808080);
    this.litMesh = new THREE.Mesh(this.lit.build(gray), new THREE.MeshLambertMaterial({ vertexColors: true }));
    this.litMesh.name = 'backdropLit';
    this.litMesh.receiveShadow = shadows;
    this.silhouetteMesh = new THREE.Mesh(this.silhouettes.build(gray), new THREE.MeshBasicMaterial({ vertexColors: true }));
    this.silhouetteMesh.name = 'backdropSilhouettes';
    this.glowMesh = new THREE.Mesh(this.glow.build(gray), new THREE.MeshBasicMaterial({
      vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
    }));
    this.glowMesh.name = 'backdropGlow';
    this.poolMesh = this.buildPools();
    for (const m of [this.litMesh, this.silhouetteMesh, this.glowMesh, this.poolMesh]) {
      m.frustumCulled = false;
      this.group.add(m);
    }
  }

  buildStreets() {
    const b = this.lit;
    b.add(flat(3200, 3200, CITY_WIDTH / 2, -0.06, 0), 'ground');
    b.add(flat(CITY_WIDTH + 8, 12, CITY_WIDTH / 2, 0.005, 0), 'sidewalk', { shade: 0.78 }); // lot under the city
    for (const side of [1, -1]) {
      const z = (v) => v * side;
      b.add(box(STREET_LEN, 0.18, 3, STREET_CX, 0.09, z(7.5)), 'sidewalk');
      b.add(box(STREET_LEN, 0.22, 0.3, STREET_CX, 0.11, z(9)), 'curb');
      b.add(flat(STREET_LEN, 12, STREET_CX, 0.01, z(15)), 'road');
      b.add(box(STREET_LEN, 0.22, 0.3, STREET_CX, 0.11, z(21)), 'curb');
      b.add(box(STREET_LEN, 0.18, 3, STREET_CX, 0.09, z(22.5)), 'sidewalk');
      b.add(flat(STREET_LEN, 0.16, STREET_CX, MARKING_Y, z(9.6)), 'marking', { shade: 0.75 });
      b.add(flat(STREET_LEN, 0.16, STREET_CX, MARKING_Y, z(20.4)), 'marking', { shade: 0.75 });
      for (let x = STREET_X0 + 4; x < STREET_X1 - 4; x += 7) b.add(flat(3, 0.25, x, MARKING_Y, z(15)), 'marking');
    }
  }

  buildLamps() {
    for (const side of [1, -1]) {
      const zPole = 8.2 * side;
      for (let k = 0; k < 14; k++) {
        const x = -96 + k * 24 + (side < 0 ? 12 : 0);
        this.lit.add(box(0.22, 6.6, 0.22, x, 3.3, zPole), 'lampPole');
        this.lit.add(box(0.5, 0.3, 0.5, x, 0.15, zPole), 'lampPole', { shade: 0.8 });
        this.lit.add(box(0.14, 0.14, 1.9, x, 6.5, zPole + side * 0.85), 'lampPole');
        this.lit.add(box(0.62, 0.16, 1.0, x, 6.5, zPole + side * 1.75), 'lampPole', { shade: 0.85 });
        this.glow.add(box(0.5, 0.12, 0.85, x, 6.38, zPole + side * 1.75), 'lampHead');
        this.lamps.push({ x, z: zPole + side * 2.6 });
      }
    }
  }

  sideBuilding(rng, x, w, h, d, zFront, colorIndex, windowScale) {
    this.lit.add(box(w, h, d, x + w / 2, h / 2, zFront - d / 2), `side${colorIndex}`, { shade: rng.float(0.85, 1.02) });
    this.lit.add(box(w + 0.3, 0.5, d + 0.3, x + w / 2, h + 0.25, zFront - d / 2), `side${colorIndex}`, { shade: 0.7 });
    const cols = Math.floor((w - 1.4) / 2.6);
    const rows = Math.floor((h - 2.4) / 3.2);
    const x0 = x + (w - (cols - 1) * 2.6) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng.next() > windowScale) continue;
        this.glow.add(quad(1.0, 1.3, x0 + c * 2.6, 2.2 + r * 3.2, zFront + 0.04), 'winSide', { rand: rng.next() });
      }
    }
  }

  buildSides(rng) {
    const windowScale = this.quality === 'quest' ? 0.7 : 1;
    // Front row: on the city's own block (front face at z 4..6, between the two streets), but only beyond the
    // range the banana can fly through so it never passes through a prop. Back row: behind the back street.
    const strip = (x0, x1, back) => {
      let x = x0;
      while (x < x1) {
        const w = rng.float(8, 18);
        const h = back ? rng.float(14, 40) : rng.float(8, 30);
        const d = back ? rng.float(10, 16) : rng.float(8, 10);
        const zFront = back ? rng.float(-30, -25) : rng.float(4, 6);
        this.sideBuilding(rng, x, w, h, d, zFront, rng.int(0, 3), windowScale);
        x += w + rng.float(0.5, 4);
      }
    };
    // A building starting before x1 may be up to 18 m wide.
    strip(-262, BANANA_X0 - 18, false);
    strip(BANANA_X1, 410, false);
    strip(-262, -40, true); // stays left of x = -20
    strip(174, 410, true);
  }

  buildLayers(rng) {
    const quest = this.quality === 'quest';
    LAYERS.forEach((L, li) => {
      let x = L.x[0];
      while (x < L.x[1]) {
        const w = rng.float(L.w[0], L.w[1]);
        const h = rng.float(L.h[0], L.h[1]);
        const d = rng.float(L.d[0], L.d[1]);
        const zc = rng.float(L.z[0], L.z[1]);
        const cx = x + w / 2;
        const key = `bg${li}`;
        this.silhouettes.add(box(w, h, d, cx, h / 2, zc), key, { shade: rng.float(0.92, 1.06) });
        if (rng.chance(0.3)) {
          const h2 = h * rng.float(0.12, 0.25);
          this.silhouettes.add(box(w * 0.6, h2, d * 0.6, cx, h + h2 / 2, zc), key);
          if (li > 0 && rng.chance(0.5)) this.silhouettes.add(box(0.8, rng.float(6, 18), 0.8, cx, h + h2, zc), key);
        } else if (li > 0 && rng.chance(0.15)) {
          this.silhouettes.add(box(0.9, rng.float(8, 20), 0.9, cx + rng.float(-w / 4, w / 4), h + 5, zc), key);
        }
        const win = L.win;
        const cols = Math.floor((w - 1) / win.gx);
        const rows = Math.floor((h - 3) / win.gy);
        const x0 = cx - ((cols - 1) * win.gx) / 2;
        const zf = zc + d / 2 + 0.05;
        const p = win.p * (quest ? 0.6 : 1);
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            if (rng.next() > p) continue;
            this.glow.add(quad(win.w, win.h, x0 + c * win.gx, 2.5 + r * win.gy, zf), `winBg${li}`, { rand: rng.next() });
          }
        }
        x += w + rng.float(-1, 6);
      }
    });
  }

  buildPools() {
    const n = this.lamps.length;
    const vpl = POOL_SEGMENTS + 1;
    const pos = new Float32Array(n * vpl * 3);
    const col = new Float32Array(n * vpl * 3);
    const idx = [];
    this.lamps.forEach((lamp, i) => {
      const base = i * vpl;
      pos.set([lamp.x, POOL_Y, lamp.z], base * 3);
      for (let s = 0; s < POOL_SEGMENTS; s++) {
        const a = (s / POOL_SEGMENTS) * Math.PI * 2;
        pos.set([lamp.x + Math.cos(a) * 4.6, POOL_Y, lamp.z + Math.sin(a) * 3.6], (base + 1 + s) * 3);
        idx.push(base, base + 1 + ((s + 1) % POOL_SEGMENTS), base + 1 + s);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    }));
    mesh.name = 'lampPools';
    mesh.renderOrder = 1;
    return mesh;
  }

  /** @param {import('./themes.js').Theme} theme */
  recolor(theme) {
    this.theme = theme;
    const st = theme.street;
    this.lit.recolor((key, rand, t) => {
      if (key.startsWith('side')) return t.copy(themeColor(theme.buildings[+key.slice(4)] ?? theme.buildings[0])).multiplyScalar(0.8);
      return t.copy(themeColor(st[key] ?? st.ground));
    });
    this.silhouettes.recolor((key, rand, t) => t.copy(themeColor(theme.bg[+key.slice(2)] ?? theme.bg[0])));
    this.glow.recolor((key, rand, t) => {
      if (key === 'lampHead') return t.copy(themeColor(st.lampHead));
      const pick = (list) => themeColor(list[Math.floor(((rand * 7.31) % 1) * list.length)] ?? list[0]);
      if (key === 'winSide') {
        return rand < theme.litRatio * 0.8 ? t.copy(pick(theme.windowLit)) : t.copy(themeColor(theme.windowOff));
      }
      const li = +key.slice(5);
      if (rand < theme.bgLitRatio) return t.copy(pick(theme.bgWindow)).multiplyScalar(LAYER_WINDOW_DIM[li] ?? 1);
      return t.copy(themeColor(theme.bg[li] ?? theme.bg[0])).multiplyScalar(0.82);
    });

    const pool = st.pool ? themeColor(st.pool) : null;
    this.poolMesh.visible = Boolean(pool);
    if (pool) {
      const attr = this.poolMesh.geometry.getAttribute('color');
      const vpl = POOL_SEGMENTS + 1;
      for (let i = 0; i < this.lamps.length; i++) {
        const v = i * vpl * 3;
        attr.array[v] = pool.r * 0.4;
        attr.array[v + 1] = pool.g * 0.4;
        attr.array[v + 2] = pool.b * 0.4;
      }
      attr.needsUpdate = true;
    }
  }

  dispose() {
    for (const m of [this.litMesh, this.silhouetteMesh, this.glowMesh, this.poolMesh]) {
      m.geometry.dispose();
      m.material.dispose();
    }
    this.group.removeFromParent();
  }
}
