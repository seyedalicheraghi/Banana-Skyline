// The banana: a curved, tapered, slightly five-sided tube (yellow with brown ends), the flying banana with a
// soft glow and a short additive trail ribbon, and createBananaMesh() for the VR hands and the monkeys.
import * as THREE from 'three';
import { clamp, glowTexture, themeColor } from './util.js';

const SEGMENTS = 28;
const RADIAL = 10;
const TRAIL_MAX = 48;
const TRAIL_TIME = 0.4;
const TRAIL_STEP = 1 / 90;
const TRAIL_WIDTH = 0.34;

let sharedGeometry = null;
let sharedMaterial = null;

function buildBananaGeometry() {
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.44, 0.1, 0),
    new THREE.Vector3(0, -0.2, 0),
    new THREE.Vector3(0.44, 0.1, 0),
  );
  const frames = curve.computeFrenetFrames(SEGMENTS, false);
  const ringCount = SEGMENTS + 1;
  const vertexCount = ringCount * RADIAL + 2;
  const pos = new Float32Array(vertexCount * 3);
  const col = new Float32Array(vertexCount * 3);
  const p = new THREE.Vector3();
  const o = new THREE.Vector3();
  const c = new THREE.Color();
  const stem = new THREE.Color('#6b4a1e');
  const tip = new THREE.Color('#3a2810');
  const green = new THREE.Color('#c4d23a');
  const yellow = new THREE.Color('#ffd93d');
  const ridge = new THREE.Color('#f0b21e');

  for (let i = 0; i < ringCount; i++) {
    const t = i / SEGMENTS;
    curve.getPointAt(t, p);
    const body = 0.09 * Math.pow(Math.sin(Math.PI * clamp((t - 0.03) / 0.97, 0, 1)), 0.6);
    const r = Math.max(t < 0.08 ? 0.024 : 0.012, body);
    for (let j = 0; j < RADIAL; j++) {
      const a = (j / RADIAL) * Math.PI * 2;
      const ridged = r * (1 + 0.07 * Math.cos(5 * a)); // bananas are a little pentagonal
      o.copy(frames.normals[i]).multiplyScalar(Math.cos(a) * ridged).addScaledVector(frames.binormals[i], Math.sin(a) * ridged);
      const v = i * RADIAL + j;
      pos[v * 3] = p.x + o.x;
      pos[v * 3 + 1] = p.y + o.y;
      pos[v * 3 + 2] = p.z + o.z;
      if (t < 0.075) c.copy(stem);
      else if (t > 0.955) c.copy(tip);
      else {
        c.copy(green).lerp(yellow, clamp((t - 0.075) / 0.15, 0, 1));
        c.lerp(ridge, 0.25 * Math.max(0, Math.cos(5 * a)));
      }
      col[v * 3] = c.r;
      col[v * 3 + 1] = c.g;
      col[v * 3 + 2] = c.b;
    }
  }
  // End caps (stem and tip).
  const caps = [ringCount * RADIAL, ringCount * RADIAL + 1];
  for (const [k, t, colr] of [[0, 0, stem], [1, 1, tip]]) {
    curve.getPointAt(t, p);
    const tangent = curve.getTangentAt(t);
    p.addScaledVector(tangent, k === 0 ? -0.012 : 0.01);
    const v = caps[k];
    pos.set([p.x, p.y, p.z], v * 3);
    col.set([colr.r, colr.g, colr.b], v * 3);
  }

  const index = [];
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const a = i * RADIAL + j;
      const b = i * RADIAL + ((j + 1) % RADIAL);
      const cc = (i + 1) * RADIAL + j;
      const d = (i + 1) * RADIAL + ((j + 1) % RADIAL);
      index.push(a, b, cc, b, d, cc); // outward winding: (along ring) x (along curve) = +normal
    }
  }
  const last = SEGMENTS * RADIAL;
  for (let j = 0; j < RADIAL; j++) {
    const j1 = (j + 1) % RADIAL;
    index.push(caps[0], j1, j);
    index.push(caps[1], last + j, last + j1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Shared banana geometry (about 0.9 m long along x, curving down in the middle). Do not dispose. */
export function bananaGeometry() {
  if (!sharedGeometry) sharedGeometry = buildBananaGeometry();
  return sharedGeometry;
}

/** Shared banana material. Do not dispose. */
export function bananaMaterial() {
  if (!sharedMaterial) {
    sharedMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: new THREE.Color('#2e2400') });
    sharedMaterial.userData.shared = true;
  }
  return sharedMaterial;
}

/**
 * A new banana Object3D (≈0.9 m long in world units) that shares geometry and material with every other banana.
 * @returns {THREE.Mesh}
 */
export function createBananaMesh() {
  const mesh = new THREE.Mesh(bananaGeometry(), bananaMaterial());
  mesh.name = 'banana';
  mesh.userData.sharedResources = true;
  return mesh;
}

export function disposeBananaResources() {
  sharedGeometry?.dispose();
  sharedMaterial?.dispose();
  sharedGeometry = null;
  sharedMaterial = null;
}

/** The banana in flight with its glow and trail. */
export class BananaView {
  constructor(parent) {
    this.mesh = createBananaMesh();
    this.mesh.visible = false;
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xfff0a0, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.5,
    }));
    this.glow.scale.set(2.6, 2.6, 1);
    this.glow.visible = false;

    this.sx = new Float32Array(TRAIL_MAX);
    this.sy = new Float32Array(TRAIL_MAX);
    this.st = new Float32Array(TRAIL_MAX);
    this.n = 0;
    this.lastInsert = -1;
    this.trailColor = new THREE.Color(0xfff0a0);
    const geo = new THREE.BufferGeometry();
    this.trailPos = new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 4 * 3), 3);
    this.trailCol = new THREE.BufferAttribute(new Float32Array(TRAIL_MAX * 4 * 3), 3);
    this.trailPos.setUsage(THREE.DynamicDrawUsage);
    this.trailCol.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.trailPos);
    geo.setAttribute('color', this.trailCol);
    const idx = [];
    for (let k = 0; k < TRAIL_MAX - 1; k++) {
      const a = 4 * k;
      const b = a + 4;
      idx.push(a, a + 1, b, a + 1, b + 1, b);             // ribbon in the play plane
      idx.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2); // crossed ribbon, visible edge-on in VR
    }
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this.trail = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }));
    this.trail.name = 'bananaTrail';
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    parent.add(this.mesh, this.glow, this.trail);
  }

  setTheme(theme) {
    this.trailColor.copy(themeColor(theme.trail));
    this.glow.material.color.copy(this.trailColor);
  }

  /** A new throw: restart the trail. */
  start() {
    this.n = 0;
    this.lastInsert = -1;
  }

  reset() {
    this.n = 0;
    this.mesh.visible = false;
    this.glow.visible = false;
    this.trail.visible = false;
  }

  /**
   * @param {number} dt
   * @param {{x:number, y:number, spin:number}|null} banana game.banana
   * @param {number} time view time in seconds
   */
  update(dt, banana, time) {
    const flying = Boolean(banana) && Number.isFinite(banana.x) && Number.isFinite(banana.y);
    this.mesh.visible = flying;
    this.glow.visible = flying;
    if (flying) {
      this.mesh.position.set(banana.x, banana.y, 0);
      this.mesh.rotation.set(0, 0, banana.spin || 0);
      this.glow.position.set(banana.x, banana.y, 0);
      if (this.n === 0 || time - this.lastInsert >= TRAIL_STEP) {
        this.sx.copyWithin(1, 0, TRAIL_MAX - 1);
        this.sy.copyWithin(1, 0, TRAIL_MAX - 1);
        this.st.copyWithin(1, 0, TRAIL_MAX - 1);
        this.n = Math.min(this.n + 1, TRAIL_MAX);
        this.lastInsert = time;
      }
      this.sx[0] = banana.x;
      this.sy[0] = banana.y;
      this.st[0] = time;
    }
    while (this.n > 0 && time - this.st[this.n - 1] > TRAIL_TIME) this.n--;
    this.writeTrail(time);
  }

  writeTrail(time) {
    const n = this.n;
    this.trail.visible = n > 1;
    if (n < 2) return;
    const P = this.trailPos.array;
    const C = this.trailCol.array;
    const col = this.trailColor;
    for (let k = 0; k < n; k++) {
      const kp = Math.max(0, k - 1);
      const kn = Math.min(n - 1, k + 1);
      let tx = this.sx[kp] - this.sx[kn];
      let ty = this.sy[kp] - this.sy[kn];
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const f = clamp(1 - (time - this.st[k]) / TRAIL_TIME, 0, 1);
      const w = TRAIL_WIDTH * Math.pow(f, 0.7) + 0.02;
      const x = this.sx[k];
      const y = this.sy[k];
      const v = k * 12;
      P[v] = x - ty * w; P[v + 1] = y + tx * w; P[v + 2] = 0;
      P[v + 3] = x + ty * w; P[v + 4] = y - tx * w; P[v + 5] = 0;
      P[v + 6] = x; P[v + 7] = y; P[v + 8] = w;
      P[v + 9] = x; P[v + 10] = y; P[v + 11] = -w;
      const b = Math.pow(f, 1.6);
      for (let q = 0; q < 4; q++) {
        C[v + q * 3] = col.r * b;
        C[v + q * 3 + 1] = col.g * b;
        C[v + q * 3 + 2] = col.b * b;
      }
    }
    this.trailPos.needsUpdate = true;
    this.trailCol.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, (n - 1) * 12);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.glow.removeFromParent();
    this.glow.material.dispose();
    this.trail.removeFromParent();
    this.trail.geometry.dispose();
    this.trail.material.dispose();
  }
}
