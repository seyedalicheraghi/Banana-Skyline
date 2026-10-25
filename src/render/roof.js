// Roof decorations (rims, stair huts, water towers, antennas with blinking lights, AC units).
// Each primitive kind is one InstancedMesh, so all decorations cost a handful of draw calls.
import * as THREE from 'three';
import { BUILDING_DEPTH, CELL } from '../core/constants.js';
import { createRng } from '../core/rng.js';
import { themeColor } from './util.js';

const HALF_D = BUILDING_DEPTH / 2;
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** One instanced primitive with per-instance owner (building id) and palette reference. */
class PartSet {
  constructor(name, geometry, material, capacity, shadows) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadows;
    this.mesh.receiveShadow = shadows;
    this.capacity = capacity;
    this.owners = new Int16Array(capacity);
    this.refs = [];
    this.count = 0;
  }

  reset() {
    this.count = 0;
    this.refs.length = 0;
    this.mesh.count = 0;
  }

  add(matrix, ref, owner) {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.mesh.setMatrixAt(i, matrix);
    this.owners[i] = owner;
    this.refs[i] = ref;
    return i;
  }

  finish() {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  hideOwner(owner) {
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      if (this.owners[i] !== owner) continue;
      this.mesh.setMatrixAt(i, ZERO);
      this.owners[i] = -1;
      changed = true;
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  recolor(resolve, tmp) {
    for (let i = 0; i < this.count; i++) this.mesh.setColorAt(i, resolve(this.refs[i], tmp));
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}

export class RoofDecor {
  /** @param {{parent: THREE.Object3D, quality: string, shadows: boolean}} opts */
  constructor({ parent, quality, shadows }) {
    const seg = quality === 'quest' ? 8 : 12;
    const lambert = () => new THREE.MeshLambertMaterial();
    this.boxes = new PartSet('roofBoxes', new THREE.BoxGeometry(1, 1, 1), lambert(), 480, shadows);
    this.cylinders = new PartSet('roofCylinders', new THREE.CylinderGeometry(0.5, 0.5, 1, seg), lambert(), 120, shadows);
    this.cones = new PartSet('roofCones', new THREE.ConeGeometry(0.5, 1, seg), lambert(), 32, shadows);
    this.lights = new PartSet('roofLights', new THREE.SphereGeometry(0.5, 8, 6), new THREE.MeshBasicMaterial(), 32, false);
    this.sets = [this.boxes, this.cylinders, this.cones, this.lights];
    for (const s of this.sets) parent.add(s.mesh);
    this.lightPhase = new Float32Array(32);
    this.lightOn = new Uint8Array(32);
    this.theme = null;
    this.tmpColor = new THREE.Color();
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3(1, 1, 1);
    this.buildings = [];
  }

  /**
   * Rebuild for a new city. Buildings in `skip` (the monkeys' buildings) get nothing.
   * @param {object} city core City
   * @param {Set<number>} skip building ids
   */
  build(city, skip) {
    for (const s of this.sets) s.reset();
    this.buildings = city.buildings;
    for (const b of city.buildings) {
      if (skip.has(b.id)) continue;
      this.decorate(b);
    }
    for (const s of this.sets) s.finish();
    this.lightOn.fill(2); // force a color write on the next update
    if (this.theme) this.recolor(this.theme);
  }

  place(set, x, y, z, sx, sy, sz, ref, owner) {
    this.p.set(x, y, z);
    this.s.set(sx, sy, sz);
    this.m.compose(this.p, this.q, this.s);
    return set.add(this.m, ref, owner);
  }

  decorate(b) {
    const rng = createRng((b.windowSeed ^ 0x5bd1e995) >>> 0);
    const x0 = b.col0 * CELL;
    const x1 = b.col1 * CELL;
    const w = x1 - x0;
    const cx = (x0 + x1) / 2;
    const top = b.height * CELL;
    const id = b.id;
    const lo = x0 + 2.2;
    const hi = Math.max(lo, x1 - 2.2);
    const pick = () => lo + (hi - lo) * rng.next();
    const wall = (f) => ({ b: b.color, f });
    const style = b.roof | 0;

    if (style !== 2 || rng.chance(0.5)) {
      const rim = wall(0.72);
      this.place(this.boxes, cx, top + 0.3, HALF_D - 0.2, w, 0.6, 0.4, rim, id);
      this.place(this.boxes, cx, top + 0.3, -HALF_D + 0.2, w, 0.6, 0.4, rim, id);
      this.place(this.boxes, x0 + 0.2, top + 0.3, 0, 0.4, 0.6, BUILDING_DEPTH - 0.8, rim, id);
      this.place(this.boxes, x1 - 0.2, top + 0.3, 0, 0.4, 0.6, BUILDING_DEPTH - 0.8, rim, id);
    }

    if (style === 0) {
      // Stair hut with a door, toward the back of the roof.
      const hx = pick();
      this.place(this.boxes, hx, top + 1.25, -3.2, 2.4, 2.5, 2.8, wall(0.9), id);
      this.place(this.boxes, hx, top + 2.55, -3.2, 2.7, 0.16, 3.1, { k: 'metal', f: 0.85 }, id);
      this.place(this.boxes, hx, top + 0.95, -3.2 + 1.41, 0.9, 1.9, 0.06, { k: 'dark' }, id);
      if (rng.chance(0.6)) this.vent(pick(), top, -1.5 - rng.next() * 2, id);
    } else if (style === 1) {
      // Water tower on four legs.
      const tx = pick();
      const tz = -3.2;
      const legH = 2.2;
      for (const [dx, dz] of [[-0.8, -0.8], [0.8, -0.8], [-0.8, 0.8], [0.8, 0.8]]) {
        this.place(this.boxes, tx + dx, top + legH / 2, tz + dz, 0.16, legH, 0.16, { k: 'dark' }, id);
      }
      const base = top + legH;
      this.place(this.cylinders, tx, base + 1.2, tz, 2.4, 2.4, 2.4, { k: 'tank' }, id);
      this.place(this.cylinders, tx, base + 0.5, tz, 2.48, 0.12, 2.48, { k: 'tankBand' }, id);
      this.place(this.cylinders, tx, base + 1.9, tz, 2.48, 0.12, 2.48, { k: 'tankBand' }, id);
      this.place(this.cones, tx, base + 2.4 + 0.45, tz, 2.75, 0.9, 2.75, { k: 'tankRoof' }, id);
    } else if (style === 2) {
      // Antenna mast with a blinking light, plus an AC unit.
      const ax = pick();
      const az = -2.8;
      const h = 5 + rng.next() * 4;
      this.place(this.boxes, ax, top + 0.25, az, 1.0, 0.5, 1.0, { k: 'metal' }, id);
      this.place(this.cylinders, ax, top + 0.5 + h / 2, az, 0.18, h, 0.18, { k: 'metal' }, id);
      this.place(this.boxes, ax, top + 0.5 + h * 0.72, az, 1.6, 0.1, 0.1, { k: 'metal' }, id);
      this.place(this.boxes, ax, top + 0.5 + h * 0.48, az, 2.3, 0.1, 0.1, { k: 'metal' }, id);
      const li = this.place(this.lights, ax, top + 0.5 + h + 0.15, az, 0.45, 0.45, 0.45, { k: 'light' }, id);
      if (li >= 0) this.lightPhase[li] = rng.next();
      let ux = pick();
      if (Math.abs(ux - ax) < 2.5) ux = ax < cx ? hi : lo;
      this.acUnit(ux, top, -1.2, id);
    } else {
      // A row of AC units with fans.
      const n = w >= 12 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const ux = lo + ((i + 0.5) / n) * (hi - lo);
        this.acUnit(ux, top, -2.6 + rng.float(-1.2, 1.4), id);
      }
    }
  }

  acUnit(x, top, z, id) {
    this.place(this.boxes, x, top + 0.55, z, 1.8, 1.1, 1.4, { k: 'metal' }, id);
    this.place(this.cylinders, x, top + 1.14, z, 0.95, 0.08, 0.95, { k: 'dark' }, id);
  }

  vent(x, top, z, id) {
    this.place(this.cylinders, x, top + 0.6, z, 0.5, 1.2, 0.5, { k: 'metal', f: 0.9 }, id);
    this.place(this.cylinders, x, top + 1.25, z, 0.8, 0.12, 0.8, { k: 'dark' }, id);
  }

  /** Remove all decorations of a building (its roof was hit). */
  hideBuilding(id) {
    for (const s of this.sets) s.hideOwner(id);
  }

  recolor(theme) {
    this.theme = theme;
    const tint = (ref, target) => {
      if (ref.b !== undefined) return target.copy(themeColor(theme.buildings[ref.b] ?? theme.buildings[0])).multiplyScalar(ref.f ?? 1);
      return target.copy(themeColor(theme.roof[ref.k] ?? theme.roof.metal)).multiplyScalar(ref.f ?? 1);
    };
    for (const s of this.sets) s.recolor(tint, this.tmpColor);
    this.lightOn.fill(2);
  }

  /** Blink the antenna lights. */
  update(time) {
    const set = this.lights;
    if (!this.theme || set.count === 0) return;
    let changed = false;
    for (let i = 0; i < set.count; i++) {
      const on = (time * 0.7 + this.lightPhase[i]) % 1 < 0.2 ? 1 : 0;
      if (on === this.lightOn[i]) continue;
      this.lightOn[i] = on;
      set.mesh.setColorAt(i, themeColor(on ? this.theme.roof.light : this.theme.roof.lightOff));
      changed = true;
    }
    if (changed) set.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    for (const s of this.sets) s.dispose();
  }
}
