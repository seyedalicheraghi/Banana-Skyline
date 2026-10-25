// Impact effects: flash + glow, fire and smoke puffs, shockwave ring, dust, crater debris, fur tufts and a banana peel.
// Particles live in three pooled InstancedMeshes (fire, smoke-like, debris); live instances are kept packed at the
// front (swap-remove) so `count` is exactly the number drawn. No allocations per frame.
import * as THREE from 'three';
import { BUILDING_DEPTH, CELL } from '../core/constants.js';
import { bananaMaterial } from './banana.js';
import { ColorBatch, clamp, glowTexture, ringTexture, smoothstep, surfaceBelow, themeColor, trs } from './util.js';

const FIRE = 0;
const SMOKE = 1;
const DUST = 2;
const FUR = 3;
const DEBRIS = 4;
const HALF_D = BUILDING_DEPTH / 2;
const FUR_COLOR = '#7b4a2a';
const CAPS = { quest: { fire: 100, smoke: 120, debris: 80 }, high: { fire: 380, smoke: 420, debris: 400 } };

const rand = (a, b) => a + Math.random() * (b - a);

// Height of whatever is under a point that is not on a roof: sidewalks are raised a little.
function streetHeight(z) {
  const a = Math.abs(z);
  return (a > 6 && a < 9) || (a > 21 && a < 24) ? 0.18 : 0;
}

class ParticlePool {
  constructor(name, geometry, material, capacity, parent) {
    this.cap = capacity;
    this.n = 0;
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = name;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
    const f = () => new Float32Array(capacity);
    this.px = f(); this.py = f(); this.pz = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.age = f(); this.life = f(); this.size = f();
    this.rx = f(); this.ry = f(); this.rz = f(); this.spin = f();
    this.cr = f(); this.cg = f(); this.cb = f();
    this.bounceAge = f();
    this.type = new Uint8Array(capacity);
    this.bounced = new Uint8Array(capacity);
    this.arrays = [this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.size,
      this.rx, this.ry, this.rz, this.spin, this.cr, this.cg, this.cb, this.bounceAge, this.type, this.bounced];
  }

  /** Returns the particle index, or -1 when the pool is full. */
  spawn(type, x, y, z, vx, vy, vz, life, size, color) {
    if (this.n >= this.cap) return -1;
    const i = this.n++;
    this.type[i] = type;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size[i] = size;
    this.rx[i] = Math.random() * 6.28; this.ry[i] = Math.random() * 6.28; this.rz[i] = Math.random() * 6.28;
    this.spin[i] = rand(-8, 8);
    this.cr[i] = color.r; this.cg[i] = color.g; this.cb[i] = color.b;
    this.bounced[i] = 0;
    return i;
  }

  kill(i) {
    const j = --this.n;
    if (i === j) return;
    const arrays = this.arrays;
    for (let k = 0; k < arrays.length; k++) arrays[k][i] = arrays[k][j];
  }

  clear() {
    this.n = 0;
    this.mesh.count = 0;
  }
}

export class Effects {
  /** @param {{parent: THREE.Object3D, quality?: string}} opts */
  constructor({ parent, quality = 'high' }) {
    this.group = new THREE.Group();
    this.group.name = 'effects';
    parent.add(this.group);
    this.q = quality === 'quest' ? 0.6 : 1;
    const caps = CAPS[quality] ?? CAPS.high;
    const blob = quality === 'quest' ? new THREE.IcosahedronGeometry(0.5, 0) : new THREE.IcosahedronGeometry(0.5, 1);
    this.fire = new ParticlePool('fire', blob, new THREE.MeshBasicMaterial(), caps.fire, this.group);
    this.smoke = new ParticlePool('smoke', blob, new THREE.MeshLambertMaterial({ flatShading: true }), caps.smoke, this.group);
    this.debris = new ParticlePool('debris', new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), caps.debris, this.group);
    this.pools = [this.fire, this.smoke, this.debris];
    this.blobGeometry = blob;

    this.flashes = [];
    const sphere = new THREE.SphereGeometry(1, 16, 12);
    this.flashGeometry = sphere;
    for (let i = 0; i < 3; i++) {
      const core = new THREE.Mesh(sphere, new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      core.visible = glow.visible = false;
      this.group.add(core, glow);
      this.flashes.push({ core, glow, age: 0, life: 1, radius: 1, active: false });
    }
    this.rings = [];
    for (let i = 0; i < 2; i++) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ringTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      sprite.visible = false;
      this.group.add(sprite);
      this.rings.push({ sprite, age: 0, life: 0.55, radius: 1, active: false });
    }
    this.peelGeometry = this.buildPeel();
    this.peels = [];
    for (let i = 0; i < 2; i++) {
      const mesh = new THREE.Mesh(this.peelGeometry, bananaMaterial());
      mesh.visible = false;
      this.group.add(mesh);
      this.peels.push({ mesh, x: 0, y: 0, vx: 0, vy: 0, spin: 0, rest: -1, age: 0, active: false });
    }

    this.theme = null;
    this.fireStops = [
      [0, new THREE.Color('#fff7d0')], [0.12, new THREE.Color('#ffd23a')], [0.35, new THREE.Color('#ff7b1c')],
      [0.65, new THREE.Color('#b3260e')], [1, new THREE.Color('#2e2224')],
    ];
    this.c = new THREE.Color();
    this.m = new THREE.Matrix4();
    this.pos = new THREE.Vector3();
    this.scale = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.euler = new THREE.Euler();
  }

  buildPeel() {
    const b = new ColorBatch();
    const yellow = '#ffd93d';
    b.add(new THREE.CylinderGeometry(0.05, 0.06, 0.16, 8), '#6b4a1e', { matrix: trs(0, 0.42, 0) });
    b.add(new THREE.SphereGeometry(0.12, 10, 8), yellow, { matrix: trs(0, 0.3, 0, 1, 0.9, 1) });
    const phi = 2.0; // petals droop outward and down
    for (let i = 0; i < 4; i++) {
      const a = i * (Math.PI / 2) + 0.4;
      const out = Math.sin(phi);
      const up = Math.cos(phi);
      b.add(new THREE.SphereGeometry(1, 10, 8), yellow, {
        matrix: trs(Math.cos(a) * 0.34 * out, 0.3 + 0.34 * up, Math.sin(a) * 0.34 * out, 0.12, 0.34, 0.045, 0, -a, -phi),
      });
      b.add(new THREE.SphereGeometry(0.05, 6, 4), '#5a3a14', {
        matrix: trs(Math.cos(a) * 0.66 * out, 0.3 + 0.66 * up, Math.sin(a) * 0.66 * out),
      });
    }
    return b.build((key, _r, t) => t.set(key));
  }

  setTheme(theme) {
    this.theme = theme;
  }

  /** Remove every live effect (new round). */
  clear() {
    for (const p of this.pools) p.clear();
    for (const f of this.flashes) f.active = f.core.visible = f.glow.visible = false;
    for (const r of this.rings) r.active = r.sprite.visible = false;
    for (const p of this.peels) p.active = p.mesh.visible = false;
  }

  flash(x, y, radius, life) {
    const f = this.flashes.find((e) => !e.active) ?? this.flashes.reduce((a, e) => (e.age / e.life > a.age / a.life ? e : a));
    f.active = true;
    f.age = 0;
    f.life = life;
    f.radius = radius;
    f.core.position.set(x, y, 0);
    f.glow.position.set(x, y, 0.5);
    const col = themeColor(this.theme?.fx.flash ?? '#fff4c2');
    f.core.material.color.copy(col);
    f.glow.material.color.copy(col);
    f.core.visible = f.glow.visible = true;
  }

  ring(x, y, radius) {
    const r = this.rings.find((e) => !e.active) ?? this.rings[0];
    r.active = true;
    r.age = 0;
    r.radius = radius;
    r.sprite.position.set(x, y, 0.3);
    r.sprite.material.color.copy(themeColor(this.theme?.fx.flash ?? '#fff4c2'));
    r.sprite.visible = true;
  }

  /**
   * Explosion for an 'impact' event.
   * @param {'building'|'monkey'|'ground'|'out'} kind
   */
  explode(kind, x, y, radius) {
    if (kind === 'out' || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const q = this.q;
    const fx = this.theme?.fx ?? { smoke: '#3b3542', dust: '#8c8296' };
    const c = this.c;
    if (kind === 'ground') {
      this.flash(x, 0.8, 1.4, 0.25);
      const dust = themeColor(fx.dust);
      for (let i = Math.round(14 * q); i > 0; i--) {
        const a = Math.random() * Math.PI * 2;
        const s = rand(2, 5.5);
        c.copy(dust).multiplyScalar(rand(0.8, 1.15));
        this.smoke.spawn(DUST, x + rand(-0.6, 0.6), rand(0.2, 0.6), rand(-1, 1), Math.cos(a) * s, rand(1, 3.5), Math.sin(a) * s * 0.7, rand(0.9, 1.5), rand(0.6, 1.1), c);
      }
      for (let i = Math.round(5 * q); i > 0; i--) {
        this.fire.spawn(FIRE, x, 0.4, 0, rand(-3, 3), rand(2, 6), rand(-2, 2), rand(0.25, 0.45), rand(0.4, 0.7), c);
      }
      return;
    }
    const big = kind === 'monkey';
    const r = Math.max(1, radius || 3.4);
    this.flash(x, y, r * (big ? 1.2 : 0.95), big ? 0.45 : 0.32);
    if (big) this.ring(x, y, r);
    for (let i = Math.round((big ? 36 : 18) * q); i > 0; i--) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const h = Math.sqrt(1 - u * u);
      const s = r * rand(1.6, 3.6);
      this.fire.spawn(FIRE, x, y, 0, Math.cos(a) * h * s, u * s + r * 0.6, Math.sin(a) * h * s * 0.6, rand(0.35, 0.75), r * rand(0.16, 0.3), c);
    }
    const smoke = themeColor(fx.smoke);
    for (let i = Math.round((big ? 16 : 9) * q); i > 0; i--) {
      const a = Math.random() * Math.PI * 2;
      const s = r * rand(0.3, 1);
      c.copy(smoke).multiplyScalar(rand(0.8, 1.2));
      this.smoke.spawn(SMOKE, x + rand(-0.3, 0.3) * r, y + rand(-0.3, 0.3) * r, rand(-1, 1), Math.cos(a) * s, Math.sin(a) * s + 1.5, rand(-1, 1), rand(1.3, 2.4), r * rand(0.22, 0.38), c);
    }
  }

  /** Fur tufts and a flying banana peel where a monkey was hit (center of the monkey). */
  monkeyHit(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const fur = themeColor(FUR_COLOR);
    const c = this.c;
    for (let i = Math.round(16 * this.q); i > 0; i--) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(5, 11);
      c.copy(fur).multiplyScalar(rand(0.8, 1.25));
      this.smoke.spawn(FUR, x, y, 0, Math.cos(a) * s, Math.abs(Math.sin(a)) * s + rand(3, 7), rand(-4, 4), rand(1.6, 2.6), rand(0.28, 0.45), c);
    }
    const p = this.peels.find((e) => !e.active) ?? this.peels[0];
    p.active = true;
    p.x = x;
    p.y = y + 1;
    p.vx = rand(-4, 4);
    p.vy = rand(10, 13);
    p.spin = rand(6, 10) * (Math.random() < 0.5 ? -1 : 1);
    p.rest = -1;
    p.age = 0;
    p.mesh.visible = true;
    p.mesh.rotation.set(0, 0, 0);
    p.mesh.position.set(p.x, p.y, 0.4);
  }

  /**
   * Debris cubes for a 'crater' event, colored like the removed cells.
   * @param {{x:number, y:number, removed:{col:number,row:number}[]}} crater
   * @param {{colorAt(col:number,row:number,target:THREE.Color):THREE.Color}} cityView
   */
  debrisFor({ x, y, removed }, cityView) {
    if (!removed?.length) return;
    const per = removed.length > 24 || this.q < 1 ? 1 : 2;
    const free = this.debris.cap - this.debris.n;
    if (free <= 0) return;
    const stride = Math.max(1, Math.ceil((removed.length * per) / free));
    const c = this.c;
    for (let k = 0; k < removed.length; k += stride) {
      const cell = removed[k];
      const cx = (cell.col + 0.5) * CELL;
      const cy = (cell.row + 0.5) * CELL;
      for (let j = 0; j < per; j++) {
        const px = cx + rand(-0.7, 0.7);
        const py = cy + rand(-0.7, 0.7);
        const pz = rand(-HALF_D + 0.5, HALF_D - 0.5);
        let dx = px - x;
        let dy = py - y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const s = rand(5, 13);
        cityView.colorAt(cell.col, cell.row, c).multiplyScalar(rand(0.85, 1.1));
        if (this.debris.spawn(DEBRIS, px, py, pz, dx * s, dy * s + rand(3, 9), pz * 0.5 + rand(-3, 3), rand(2.2, 3), rand(0.35, 0.8), c) < 0) return;
      }
    }
  }

  fireColor(t, target) {
    const stops = this.fireStops;
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1];
        const [t1, c1] = stops[i];
        return target.lerpColors(c0, c1, (t - t0) / (t1 - t0));
      }
    }
    return target.copy(stops[stops.length - 1][1]);
  }

  updatePool(pool, dt, city) {
    const c = this.c;
    for (let i = pool.n - 1; i >= 0; i--) {
      pool.age[i] += dt;
      if (pool.age[i] >= pool.life[i]) pool.kill(i);
    }
    for (let i = 0; i < pool.n; i++) {
      const type = pool.type[i];
      const t = pool.age[i] / pool.life[i];
      let drag = 0.15;
      let ay = -22;
      let s = pool.size[i];
      if (type === FIRE) { drag = 3.5; ay = 4; s *= (0.55 + 0.9 * Math.min(1, t * 4)) * Math.pow(1 - t, 0.6); }
      else if (type === SMOKE) { drag = 1.6; ay = 2.2; s *= (0.5 + 0.9 * t) * (1 - smoothstep(0.75, 1, t)); }
      else if (type === DUST) { drag = 2.5; ay = -1; s *= (0.6 + 0.8 * t) * (1 - smoothstep(0.6, 1, t)); }
      else if (type === FUR) { drag = 0.6; ay = -9; s *= 1 - smoothstep(0.75, 1, t); }
      else {
        if (pool.bounced[i]) s *= 1 - clamp((pool.age[i] - pool.bounceAge[i]) / 0.7, 0, 1);
        s *= 1 - smoothstep(0.85, 1, t);
      }

      const k = Math.exp(-drag * dt);
      pool.vx[i] *= k;
      pool.vz[i] *= k;
      pool.vy[i] = pool.vy[i] * k + ay * dt;
      pool.px[i] += pool.vx[i] * dt;
      pool.py[i] += pool.vy[i] * dt;
      pool.pz[i] += pool.vz[i] * dt;
      const sp = pool.spin[i] * dt;
      pool.rx[i] += sp;
      pool.ry[i] += sp * 0.7;

      if ((type === DEBRIS || type === FUR) && pool.vy[i] < 0) {
        const z = pool.pz[i];
        const floor = Math.abs(z) < HALF_D ? surfaceBelow(city, pool.px[i], pool.py[i] + 0.3) : streetHeight(z);
        const bottom = pool.py[i] - s * 0.5;
        if (bottom <= floor) {
          pool.py[i] = floor + s * 0.5;
          if (!pool.bounced[i]) {
            pool.bounced[i] = 1;
            pool.bounceAge[i] = pool.age[i];
            pool.vy[i] *= -0.38;
            pool.vx[i] *= 0.6;
            pool.vz[i] *= 0.6;
            pool.spin[i] *= 0.5;
          } else {
            pool.vy[i] = 0;
            pool.vx[i] *= 0.8;
            pool.vz[i] *= 0.8;
            pool.spin[i] *= 0.8;
          }
        }
      }

      if (type === FIRE) this.fireColor(t, c);
      else c.setRGB(pool.cr[i], pool.cg[i], pool.cb[i]);
      if (type === SMOKE) c.multiplyScalar(1 + 0.35 * t);
      pool.mesh.setColorAt(i, c);
      this.pos.set(pool.px[i], pool.py[i], pool.pz[i]);
      this.quat.setFromEuler(this.euler.set(pool.rx[i], pool.ry[i], pool.rz[i]));
      this.scale.setScalar(Math.max(0, s));
      pool.mesh.setMatrixAt(i, this.m.compose(this.pos, this.quat, this.scale));
    }
    pool.mesh.count = pool.n;
    if (pool.n > 0) {
      pool.mesh.instanceMatrix.needsUpdate = true;
      pool.mesh.instanceColor.needsUpdate = true;
    }
  }

  /**
   * @param {number} dt
   * @param {object|null} city core City (for debris and peel landing)
   */
  update(dt, city) {
    for (let i = 0; i < this.pools.length; i++) this.updatePool(this.pools[i], dt, city);

    for (let i = 0; i < this.flashes.length; i++) {
      const f = this.flashes[i];
      if (!f.active) continue;
      f.age += dt;
      const t = f.age / f.life;
      if (t >= 1) {
        f.active = f.core.visible = f.glow.visible = false;
        continue;
      }
      const e = 1 - (1 - t) * (1 - t);
      f.core.scale.setScalar(f.radius * (0.35 + e));
      f.core.material.opacity = (1 - t) * (1 - t);
      const g = f.radius * 3.4 * (0.6 + 0.6 * e);
      f.glow.scale.set(g, g, 1);
      f.glow.material.opacity = 0.9 * (1 - t);
    }
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (!r.active) continue;
      r.age += dt;
      const t = r.age / r.life;
      if (t >= 1) {
        r.active = r.sprite.visible = false;
        continue;
      }
      const s = r.radius * (0.6 + 2.8 * (1 - (1 - t) * (1 - t)));
      r.sprite.scale.set(s, s, 1);
      r.sprite.material.opacity = Math.pow(1 - t, 1.5);
    }
    for (let i = 0; i < this.peels.length; i++) {
      const p = this.peels[i];
      if (!p.active) continue;
      p.age += dt;
      const m = p.mesh;
      if (p.rest < 0) {
        p.vy -= 20 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        m.rotation.z += p.spin * dt;
        const floor = surfaceBelow(city, p.x, p.y + 0.5);
        if (p.vy < 0 && p.y <= floor) {
          p.y = floor;
          p.rest = p.age;
          m.rotation.set(0, Math.random() * 6.28, 0);
        }
        if (p.age > 6) p.active = false;
        m.scale.setScalar(1.8);
      } else {
        const t = p.age - p.rest;
        const squash = t < 0.25 ? 1 - 0.3 * Math.sin((t / 0.25) * Math.PI) : 1;
        const fade = 1 - clamp((t - 3.5) / 0.4, 0, 1);
        m.scale.set(1.8 * fade, 1.8 * squash * fade, 1.8 * fade);
        if (fade <= 0) p.active = false;
      }
      m.position.set(p.x, p.y, 0.4);
      m.visible = p.active;
    }
  }

  dispose() {
    for (const p of this.pools) {
      p.mesh.material.dispose();
      p.mesh.dispose();
    }
    this.blobGeometry.dispose();
    this.debris.mesh.geometry.dispose();
    this.flashGeometry.dispose();
    for (const f of this.flashes) {
      f.core.material.dispose();
      f.glow.material.dispose();
    }
    for (const r of this.rings) r.sprite.material.dispose();
    this.peelGeometry.dispose();
    this.group.removeFromParent();
  }
}
