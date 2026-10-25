// PCCamera: a perspective camera looking at the play plane from +z with a slight 3/4 angle.
// Frames the whole city for any aspect ratio, widens to keep a high banana in view, optionally follows the
// banana, and shakes on impacts. See docs/DESIGN.md, "PCCamera".
import * as THREE from 'three';
import { CELL, CITY_WIDTH, MONKEY } from '../core/constants.js';

const FOV = 40;
const DEG = Math.PI / 180;
const YAW = 5 * DEG;    // camera sits a little right of center...
const PITCH = 8 * DEG;  // ...and a little above, so building sides, roofs and the street read
const FRAME = { x0: -6, x1: CITY_WIDTH + 6, y0: 0, z0: -6, z1: 10, minTop: 50 };
const MONKEY_SIDE = 16; // frame the stretch between the monkeys (plus this much) so they read large; a flying banana widens it
const MARGIN = { side: 0.02, top: 0.1, bottom: 0.04 }; // fractions of the screen (HUD on top)
const BANANA_MARGIN = 7;
const LOOKAHEAD = 0.4;          // seconds of banana velocity to keep in frame
const FOLLOW_DISTANCE = 55;
const HOLD_AFTER_IMPACT = 0.6;  // keep the widened framing this long after the banana stops
const SHAKE = { monkey: 1.2, building: 0.45, ground: 0.25 };

const damp = (lambda, dt) => 1 - Math.exp(-lambda * dt);

export class PCCamera {
  constructor() {
    const hasWindow = typeof window !== 'undefined';
    this.width = Math.max(1, hasWindow ? window.innerWidth : 1280);
    this.height = Math.max(1, hasWindow ? window.innerHeight : 720);
    this.camera = new THREE.PerspectiveCamera(FOV, this.width / this.height, 1, 6000);
    this.camera.name = 'pcCamera';

    const forward = new THREE.Vector3(-Math.sin(YAW) * Math.cos(PITCH), -Math.sin(PITCH), -Math.cos(YAW) * Math.cos(PITCH));
    const basis = new THREE.Matrix4().lookAt(new THREE.Vector3(), forward, new THREE.Vector3(0, 1, 0));
    this.camera.quaternion.setFromRotationMatrix(basis);
    this.right = new THREE.Vector3().setFromMatrixColumn(basis, 0);
    this.up = new THREE.Vector3().setFromMatrixColumn(basis, 1);
    this.back = new THREE.Vector3().setFromMatrixColumn(basis, 2);

    this.center = new THREE.Vector3(CITY_WIDTH / 2, 40, 0);
    this.distance = 160;
    this.goalCenter = new THREE.Vector3().copy(this.center);
    this.goalDistance = this.distance;
    this.box = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0 };
    this.followMode = false;
    this.bottomInset = 0;
    this.flying = false;
    this.hold = 0;
    this.shake = 0;
    this.time = 0;
    this.initialized = false;
    this.v = new THREE.Vector3();
    this.ndc = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this.hit = new THREE.Vector3();
    this.screen = { x: 0, y: 0 };

    this.frameFor(null);
    this.center.copy(this.goalCenter);
    this.distance = this.goalDistance;
    this.applyPose();
  }

  /** True while the camera chases the banana. */
  get follow() {
    return this.followMode;
  }

  /** Chase the banana with a closer camera (returns to the overview between throws). */
  setFollow(value) {
    this.followMode = Boolean(value);
  }

  /** Keep the city above a bottom overlay (the aim panel) this many CSS pixels tall. */
  setBottomInset(px) {
    this.bottomInset = Math.max(0, Number(px) || 0);
  }

  /** Viewport size in CSS pixels. */
  resize(width, height) {
    this.width = Math.max(1, Number(width) || 1);
    this.height = Math.max(1, Number(height) || 1);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  /** Camera shake on impacts (bigger for monkey hits); decays quickly. */
  onEvent(type, payload) {
    if (type === 'impact') this.shake = Math.max(this.shake, SHAKE[payload?.kind] ?? 0);
  }

  /**
   * @param {number} dt
   * @param {object} [game]
   */
  update(dt, game) {
    try {
      dt = Number.isFinite(dt) ? Math.min(Math.max(dt, 0), 0.1) : 0;
      this.time += dt;
      const b = game?.banana;
      const flying = Boolean(b) && Number.isFinite(b.x) && Number.isFinite(b.y);
      if (this.flying && !flying) this.hold = HOLD_AFTER_IMPACT;
      this.flying = flying;
      this.hold = Math.max(0, this.hold - dt);

      if (flying && this.followMode) {
        const lx = Math.max(-15, Math.min(15, (b.vx || 0) * 0.25));
        const ly = Math.max(-15, Math.min(15, (b.vy || 0) * 0.25));
        this.goalCenter.set(b.x + lx, Math.max(b.y + ly, 12), 0);
        this.goalDistance = FOLLOW_DISTANCE;
      } else if (this.hold <= 0) {
        this.frameFor(game);
      }

      if (!this.initialized) {
        this.center.copy(this.goalCenter);
        this.distance = this.goalDistance;
        this.initialized = true;
      } else {
        // Widen quickly (keep the banana in view), settle back slowly.
        const widening = this.goalDistance > this.distance;
        const rate = this.followMode && flying ? 3.5 : widening ? 4 : 1.2;
        this.distance += (this.goalDistance - this.distance) * damp(rate, dt);
        this.center.lerp(this.goalCenter, damp(this.followMode && flying ? 3.5 : widening ? 4 : 1.6, dt));
      }
      this.shake *= Math.exp(-4 * dt);
      if (this.shake < 1e-3) this.shake = 0;
      this.applyPose();
    } catch (err) {
      if (!this.reported) console.error('[render] PCCamera.update:', err);
      this.reported = true;
    }
  }

  applyPose() {
    const cam = this.camera;
    cam.position.copy(this.center).addScaledVector(this.back, this.distance);
    if (this.shake > 0) {
      const t = this.time;
      const k = this.shake * (this.distance / 120);
      cam.position.addScaledVector(this.right, k * (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 31.7 + 1.3) * 0.4));
      cam.position.addScaledVector(this.up, k * (Math.sin(t * 41.1 + 2.1) * 0.6 + Math.sin(t * 27.9 + 0.4) * 0.4));
    }
    cam.updateMatrixWorld();
  }

  /** Compute goalCenter / goalDistance that fit the city (and a flying banana) on screen. */
  frameFor(game) {
    const box = this.box;
    box.x0 = FRAME.x0;
    box.x1 = FRAME.x1;
    box.y0 = FRAME.y0;
    box.z0 = FRAME.z0;
    box.z1 = FRAME.z1;
    let top = FRAME.minTop;
    const ms = Array.isArray(game?.monkeys) ? game.monkeys.filter(m => Number.isFinite(m?.x) && Number.isFinite(m?.y)) : [];
    if (ms.length === 2) {
      box.x0 = Math.max(FRAME.x0, Math.min(ms[0].x, ms[1].x) - MONKEY_SIDE);
      box.x1 = Math.min(FRAME.x1, Math.max(ms[0].x, ms[1].x) + MONKEY_SIDE);
    }
    const bs = game?.city?.buildings;
    if (bs) {
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if ((b.col1 * CELL) > box.x0 && (b.col0 * CELL) < box.x1) top = Math.max(top, b.height * CELL + 6);
      }
    }
    for (const m of ms) top = Math.max(top, m.y + MONKEY.height + 6);
    box.y1 = top;
    const b = game?.banana;
    if (b && Number.isFinite(b.x) && Number.isFinite(b.y)) {
      const ax = b.x + (b.vx || 0) * LOOKAHEAD;
      const ay = b.y + (b.vy || 0) * LOOKAHEAD;
      box.x0 = Math.min(box.x0, b.x - BANANA_MARGIN, ax - BANANA_MARGIN);
      box.x1 = Math.max(box.x1, b.x + BANANA_MARGIN, ax + BANANA_MARGIN);
      box.y1 = Math.max(box.y1, b.y + BANANA_MARGIN, ay + BANANA_MARGIN);
    }
    this.fitBox(box);
  }

  fitBox(box) {
    const tanV = Math.tan((FOV * DEG) / 2);
    const tanH = tanV * this.camera.aspect;
    const tanHu = tanH * (1 - 2 * MARGIN.side);
    const bottom = Math.min(0.45, Math.max(MARGIN.bottom, this.bottomInset / this.height));
    const tanVu = tanV * (1 - MARGIN.top - bottom);
    const cx = (box.x0 + box.x1) / 2;
    const cy = (box.y0 + box.y1) / 2;
    const cz = (box.z0 + box.z1) / 2;
    const r = this.right;
    const u = this.up;
    const k = this.back;

    let d = 1;
    for (let i = 0; i < 8; i++) {
      const px = (i & 1 ? box.x1 : box.x0) - cx;
      const py = (i & 2 ? box.y1 : box.y0) - cy;
      const pz = (i & 4 ? box.z1 : box.z0) - cz;
      const ax = px * r.x + py * r.y + pz * r.z;
      const ay = px * u.x + py * u.y + pz * u.z;
      const az = px * k.x + py * k.y + pz * k.z;
      d = Math.max(d, Math.abs(ax) / tanHu + az, Math.abs(ay) / tanVu + az);
    }

    // Anchor the street near the bottom of the screen: any spare height goes to the sky.
    let minNdc = Infinity;
    for (let i = 0; i < 8; i++) {
      const px = (i & 1 ? box.x1 : box.x0) - cx;
      const py = (i & 2 ? box.y1 : box.y0) - cy;
      const pz = (i & 4 ? box.z1 : box.z0) - cz;
      const ay = px * u.x + py * u.y + pz * u.z;
      const az = px * k.x + py * k.y + pz * k.z;
      minNdc = Math.min(minNdc, ay / ((d - az) * tanV));
    }
    const shift = (minNdc - (-1 + 2 * bottom)) * d * tanV;
    this.goalCenter.set(cx, cy, cz).addScaledVector(u, shift);
    this.goalDistance = d;
  }

  /**
   * Project a world point (z = 0 plane by default) to CSS pixels of the canvas.
   * @returns {{x:number, y:number}}
   */
  worldToScreen(x, y, z = 0) {
    this.v.set(x, y, z).project(this.camera);
    return { x: ((this.v.x + 1) / 2) * this.width, y: ((1 - this.v.y) / 2) * this.height };
  }

  /**
   * Intersect the ray under a CSS pixel with the play plane (z = 0).
   * @returns {{x:number, y:number}}
   */
  screenToWorld(px, py) {
    this.ndc.set((px / this.width) * 2 - 1, -(py / this.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.plane, this.hit);
    if (hit) return { x: hit.x, y: hit.y };
    this.raycaster.ray.at(this.distance, this.hit);
    return { x: this.hit.x, y: this.hit.y };
  }
}
