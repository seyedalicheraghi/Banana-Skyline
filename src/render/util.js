// Small shared helpers for the render module: math, hashing, merged vertex-colored geometry, procedural textures.
import * as THREE from 'three';
import { CELL, COLS, ROWS } from '../core/constants.js';

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent smoothing factor for `value += (target - value) * k`. */
export const dampFactor = (lambda, dt) => 1 - Math.exp(-lambda * dt);
export const DEG = Math.PI / 180;

const colorCache = new Map();
/** Cached THREE.Color for a CSS color string (theme colors). Read-only: copy before modifying. */
export function themeColor(hex) {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

/** Deterministic hash of up to three integers, in [0, 1). */
export function hash3(a, b = 0, c = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) + Math.imul(b | 0, 0x165667b1) + Math.imul(c | 0, 0x9e3779b1) + 0x5bd1e995) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Matrix from position, Euler rotation (radians) and scale. Build-time helper (allocates). */
export function trs(x, y, z, sx = 1, sy = sx, sz = sx, rx = 0, ry = 0, rz = 0) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz));
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(sx, sy, sz));
}

const _batchColor = new THREE.Color();

/**
 * Collects many small geometries into one indexed BufferGeometry with a per-vertex `color` attribute,
 * so a whole set of static props costs one draw call. Each part keeps a palette key so the batch can be
 * recolored later (theme switch) without rebuilding.
 */
export class ColorBatch {
  constructor() {
    this.parts = [];
    this.ranges = [];
    this.geometry = null;
  }

  /**
   * Add a geometry (it is consumed and disposed by build()).
   * @param {THREE.BufferGeometry} geometry
   * @param {*} key palette key passed back to the color resolver
   * @param {{matrix?: THREE.Matrix4, shade?: number, rand?: number}} [opts]
   */
  add(geometry, key, opts = {}) {
    if (opts.matrix) geometry.applyMatrix4(opts.matrix);
    this.parts.push({ geometry, key, shade: opts.shade ?? 1, rand: opts.rand ?? 0 });
    return this;
  }

  /** Merge all parts. `colorOf(key, rand, target)` fills a THREE.Color for each part. */
  build(colorOf) {
    let vertexCount = 0;
    let indexCount = 0;
    for (const p of this.parts) {
      const n = p.geometry.attributes.position.count;
      vertexCount += n;
      indexCount += p.geometry.index ? p.geometry.index.count : n;
    }
    const position = new Float32Array(vertexCount * 3);
    const normal = new Float32Array(vertexCount * 3);
    const color = new Float32Array(vertexCount * 3);
    const index = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    let vo = 0;
    let io = 0;
    for (const p of this.parts) {
      const g = p.geometry;
      const n = g.attributes.position.count;
      if (!g.attributes.normal) g.computeVertexNormals();
      position.set(g.attributes.position.array.subarray(0, n * 3), vo * 3);
      normal.set(g.attributes.normal.array.subarray(0, n * 3), vo * 3);
      if (g.index) {
        const src = g.index.array;
        for (let i = 0; i < g.index.count; i++) index[io++] = src[i] + vo;
      } else {
        for (let i = 0; i < n; i++) index[io++] = vo + i;
      }
      this.ranges.push({ start: vo, count: n, key: p.key, shade: p.shade, rand: p.rand });
      vo += n;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(color, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();
    this.parts = [];
    this.geometry = geo;
    if (colorOf) this.recolor(colorOf);
    return geo;
  }

  /** Rewrite the vertex colors. `colorOf(key, rand, target)` must fill `target`. */
  recolor(colorOf) {
    if (!this.geometry) return;
    const attr = this.geometry.getAttribute('color');
    const arr = attr.array;
    for (const r of this.ranges) {
      colorOf(r.key, r.rand, _batchColor);
      const cr = _batchColor.r * r.shade;
      const cg = _batchColor.g * r.shade;
      const cb = _batchColor.b * r.shade;
      for (let v = r.start, end = r.start + r.count; v < end; v++) {
        arr[v * 3] = cr;
        arr[v * 3 + 1] = cg;
        arr[v * 3 + 2] = cb;
      }
    }
    attr.needsUpdate = true;
  }
}

// Procedural textures: computed into typed arrays, no canvas needed.
let glowTex = null;
let ringTex = null;

function radialTexture(size, alphaAt) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(clamp(alphaAt(Math.hypot(dx, dy)), 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  tex.userData.shared = true;
  return tex;
}

/** Soft white radial glow (alpha falls off to the edge). Shared; do not dispose. */
export function glowTexture() {
  if (!glowTex) {
    glowTex = radialTexture(64, (d) => {
      const t = clamp(1 - d, 0, 1);
      return t * t * (0.35 + 0.65 * t);
    });
  }
  return glowTex;
}

/** Thin bright ring with soft edges, for shockwaves. Shared; do not dispose. */
export function ringTexture() {
  if (!ringTex) ringTex = radialTexture(128, (d) => Math.exp(-(((d - 0.78) / 0.09) ** 2)) * (d < 1 ? 1 : 0));
  return ringTex;
}

let dotTex = null;
/** Small round dot with an anti-aliased edge, for point sprites. Shared; do not dispose. */
export function dotTexture() {
  if (!dotTex) dotTex = radialTexture(32, (d) => 1 - smoothstep(0.72, 1, d));
  return dotTex;
}

export function disposeSharedTextures() {
  glowTex?.dispose();
  ringTex?.dispose();
  dotTex?.dispose();
  glowTex = null;
  ringTex = null;
  dotTex = null;
}

/** Highest solid surface (world y) at or below `y` in the column under `x`; 0 = street. */
export function surfaceBelow(city, x, y) {
  if (!city || !city.grid) return 0;
  const col = Math.floor(x / CELL);
  if (col < 0 || col >= COLS) return 0;
  for (let r = Math.min(ROWS - 1, Math.floor(y / CELL)); r >= 0; r--) {
    if (city.isSolid(col, r)) return (r + 1) * CELL;
  }
  return 0;
}

/** Log an error once per message, so a bug in a per-frame path cannot flood the console or stop the loop. */
const reported = new Set();
const MAX_REPORTS = 50; // messages can embed varying values: keep the set bounded
export function reportOnce(where, err) {
  const msg = `${where}: ${err?.message ?? err}`;
  if (reported.has(msg) || reported.size >= MAX_REPORTS) return;
  reported.add(msg);
  console.error(`[render] ${msg}`, err);
}
