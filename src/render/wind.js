// Wind display: a waving flag on each monkey's roof (cloth animated on the CPU) and drifting particles
// (sparkles / leaves / dust depending on the theme) whose speed follows game.wind.
import * as THREE from 'three';
import { CELL, CITY_WIDTH, PLAYER_COLORS } from '../core/constants.js';
import { ColorBatch, clamp, lerp, smoothstep, themeColor, trs } from './util.js';

const POLE_H = 5.2;
const FLAG_W = 2.3;
const FLAG_H = 1.35;
const SX = 12;
const SY = 6;
const POLE_OFFSET = 2.6; // behind the monkey, away from the opponent
const POLE_Z = -2.6;
const BOX = { x0: -40, x1: CITY_WIDTH + 40, y0: 3, y1: 100, z0: -5, z1: 10 };

class Flag {
  constructor(index, poleGeometry, poleMaterial, shadows) {
    this.group = new THREE.Group();
    this.group.name = `flag${index}`;
    this.pole = new THREE.Mesh(poleGeometry, poleMaterial);
    this.pole.castShadow = shadows;
    const geo = new THREE.PlaneGeometry(FLAG_W, FLAG_H, SX, SY);
    geo.deleteAttribute('uv');
    this.pos = geo.getAttribute('position');
    this.nor = geo.getAttribute('normal');
    this.pos.setUsage(THREE.DynamicDrawUsage);
    this.nor.setUsage(THREE.DynamicDrawUsage);
    const colors = new Float32Array(this.pos.count * 3);
    const base = new THREE.Color(PLAYER_COLORS[index] ?? '#ffffff');
    const light = base.clone().lerp(new THREE.Color('#ffffff'), 0.75);
    const c = new THREE.Color();
    for (let iy = 0; iy <= SY; iy++) {
      for (let ix = 0; ix <= SX; ix++) {
        c.copy(iy === 3 || (iy === 2 && ix > 0) || (iy === 4 && ix > 0) ? light : base);
        if (ix === 0) c.multiplyScalar(0.8);
        c.toArray(colors, (iy * (SX + 1) + ix) * 3);
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.cloth = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    this.cloth.castShadow = shadows;
    this.cloth.frustumCulled = false;
    this.cloth.position.set(0, POLE_H - 0.12, 0);
    this.group.add(this.pole, this.cloth);
    this.dir = 1;
    this.phase = index * 2.1;
    this.col = -1;
    this.row = -1;
    this.group.visible = false;
  }

  place(x, y) {
    this.group.position.set(x, y, POLE_Z);
    this.col = Math.floor(x / CELL);
    this.row = Math.round(y / CELL) - 1;
  }

  supported(city) {
    return Boolean(city) && (this.row < 0 || city.isSolid(this.col, this.row));
  }

  update(time, wind) {
    if (wind > 0) this.dir = 1;
    else if (wind < 0) this.dir = -1;
    const k = clamp(Math.abs(wind) / 12, 0, 1);
    const droop = lerp(1.3, 0.1, smoothstep(0, 1, k));
    const cosD = Math.cos(droop);
    const sinD = Math.sin(droop);
    const amp = 0.08 + 0.28 * k;
    const w = 3 + 11 * k;
    const P = this.pos.array;
    for (let iy = 0; iy <= SY; iy++) {
      const v = iy / SY;
      for (let ix = 0; ix <= SX; ix++) {
        const u = ix / SX;
        const along = u * FLAG_W;
        const i = (iy * (SX + 1) + ix) * 3;
        P[i] = this.dir * along * cosD;
        P[i + 1] = -v * FLAG_H - along * sinD + Math.sin(u * 9 - time * w * 1.3 + this.phase) * 0.05 * u * k;
        P[i + 2] = Math.sin(u * 6.5 - time * w + this.phase) * amp * u + Math.sin(v * 3 + time * w * 0.5) * 0.03 * u;
      }
    }
    this.computeNormals();
    this.pos.needsUpdate = true;
    this.nor.needsUpdate = true;
  }

  // Grid normals from central differences: cheap and allocation-free.
  computeNormals() {
    const P = this.pos.array;
    const N = this.nor.array;
    const row = SX + 1;
    for (let iy = 0; iy <= SY; iy++) {
      const ya = (Math.max(0, iy - 1) * row) * 3;
      const yb = (Math.min(SY, iy + 1) * row) * 3;
      for (let ix = 0; ix <= SX; ix++) {
        const xa = (iy * row + Math.max(0, ix - 1)) * 3;
        const xb = (iy * row + Math.min(SX, ix + 1)) * 3;
        const dux = P[xb] - P[xa];
        const duy = P[xb + 1] - P[xa + 1];
        const duz = P[xb + 2] - P[xa + 2];
        const dvx = P[yb + ix * 3] - P[ya + ix * 3];
        const dvy = P[yb + ix * 3 + 1] - P[ya + ix * 3 + 1];
        const dvz = P[yb + ix * 3 + 2] - P[ya + ix * 3 + 2];
        let nx = duy * dvz - duz * dvy;
        let ny = duz * dvx - dux * dvz;
        let nz = dux * dvy - duy * dvx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        const i = (iy * row + ix) * 3;
        N[i] = nx;
        N[i + 1] = ny;
        N[i + 2] = nz;
      }
    }
  }
}

export class WindView {
  /** @param {{parent: THREE.Object3D, quality?: string, shadows?: boolean}} opts */
  constructor({ parent, quality = 'high', shadows = false }) {
    this.group = new THREE.Group();
    this.group.name = 'wind';
    parent.add(this.group);

    const pole = new ColorBatch();
    pole.add(new THREE.CylinderGeometry(0.07, 0.09, POLE_H, 8), '#c9ccd8', { matrix: trs(0, POLE_H / 2, 0) });
    pole.add(new THREE.SphereGeometry(0.16, 10, 8), '#ffd24a', { matrix: trs(0, POLE_H + 0.1, 0) });
    pole.add(new THREE.BoxGeometry(0.5, 0.2, 0.5), '#5a5e70', { matrix: trs(0, 0.1, 0) });
    this.poleGeometry = pole.build((key, _r, t) => t.set(key));
    this.poleMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.flags = [0, 1].map((i) => new Flag(i, this.poleGeometry, this.poleMaterial, shadows));
    for (const f of this.flags) this.group.add(f.group);

    const count = quality === 'quest' ? 50 : 110;
    this.count = count;
    this.mesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.5, 0), new THREE.MeshBasicMaterial(), count);
    this.mesh.name = 'windParticles';
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.pz = new Float32Array(count);
    this.phase = new Float32Array(count);
    this.size = new Float32Array(count);
    this.rot = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.px[i] = lerp(BOX.x0, BOX.x1, Math.random());
      this.py[i] = lerp(BOX.y0, BOX.y1, Math.random());
      this.pz[i] = lerp(BOX.z0, BOX.z1, Math.random());
      this.phase[i] = Math.random() * Math.PI * 2;
      this.size[i] = Math.random();
      this.rot[i * 3] = Math.random() * 6.28;
      this.rot[i * 3 + 1] = Math.random() * 6.28;
      this.rot[i * 3 + 2] = Math.random() * 6.28;
    }
    this.kind = 'sparkle';
    this.m = new THREE.Matrix4();
    this.p = new THREE.Vector3();
    this.s = new THREE.Vector3();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler();
  }

  /** Place the flags for a new round (on each monkey's roof, behind the monkey). */
  setup(game) {
    const monkeys = game?.monkeys ?? [];
    this.flags.forEach((f, i) => {
      const m = monkeys[i];
      if (!m) {
        f.group.visible = false;
        return;
      }
      f.place(m.x - (m.facing < 0 ? -1 : 1) * POLE_OFFSET, m.y);
      f.group.visible = f.supported(game.city);
    });
  }

  /** Hide a flag whose roof cell was blown away. */
  checkSupport(city) {
    for (const f of this.flags) if (f.group.visible && !f.supported(city)) f.group.visible = false;
  }

  setTheme(theme) {
    this.kind = theme.wind.kind;
    const colors = theme.wind.colors;
    for (let i = 0; i < this.count; i++) this.mesh.setColorAt(i, themeColor(colors[i % colors.length]));
    this.mesh.instanceColor.needsUpdate = true;
  }

  hideFlags() {
    for (const f of this.flags) f.group.visible = false;
  }

  /**
   * @param {number} dt
   * @param {number} wind game.wind (-15..15, + blows right)
   * @param {number} time
   */
  update(dt, wind, time) {
    for (let i = 0; i < this.flags.length; i++) if (this.flags[i].group.visible) this.flags[i].update(time, wind);

    const kind = this.kind;
    const drift = wind === 0 ? 0.6 : Math.sign(wind) * 0.8;
    const vx = wind * (kind === 'leaf' ? 0.9 : 1.05) + drift;
    const stretch = kind === 'leaf' ? 1 : 1 + Math.abs(wind) * 0.08;
    const span = BOX.x1 - BOX.x0;
    for (let i = 0; i < this.count; i++) {
      const ph = this.phase[i];
      let vy;
      if (kind === 'leaf') vy = -0.6 + Math.sin(time * 1.7 + ph) * 0.8;
      else if (kind === 'sparkle') vy = Math.sin(time * 0.8 + ph) * 0.4;
      else vy = Math.sin(time * 1.1 + ph) * 0.3 + 0.1;
      let x = this.px[i] + vx * (0.8 + 0.4 * this.size[i]) * dt;
      let y = this.py[i] + vy * dt;
      if (x > BOX.x1) x -= span;
      else if (x < BOX.x0) x += span;
      if (y < BOX.y0) y = BOX.y1;
      else if (y > BOX.y1) y = BOX.y0;
      this.px[i] = x;
      this.py[i] = y;

      const r = i * 3;
      let sx;
      let sy;
      let sz;
      if (kind === 'leaf') {
        const spin = (1 + Math.abs(wind) * 0.15) * dt;
        this.rot[r] += spin * 1.3;
        this.rot[r + 1] += spin * 0.9;
        this.rot[r + 2] += spin * 1.7;
        const s = 0.5 + 0.3 * this.size[i];
        sx = s;
        sy = s * 0.12;
        sz = s * 0.7;
      } else if (kind === 'sparkle') {
        const s = (0.22 + 0.18 * this.size[i]) * (0.55 + 0.45 * Math.sin(time * 5 + ph * 20));
        sx = s * stretch;
        sy = s;
        sz = s;
      } else {
        const s = 0.12 + 0.13 * this.size[i];
        sx = s * stretch;
        sy = s;
        sz = s;
      }
      this.p.set(x, y, this.pz[i]);
      if (kind === 'leaf') this.q.setFromEuler(this.e.set(this.rot[r], this.rot[r + 1], this.rot[r + 2]));
      else this.q.identity();
      this.s.set(sx, sy, sz);
      this.mesh.setMatrixAt(i, this.m.compose(this.p, this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const f of this.flags) {
      f.cloth.geometry.dispose();
      f.cloth.material.dispose();
    }
    this.poleGeometry.dispose();
    this.poleMaterial.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
    this.group.removeFromParent();
  }
}
