// A cute, readable monkey built from primitives, animated from the core state (m.anim / m.animTime).
// Static parts of each limb are merged into one vertex-colored mesh, so a monkey is ~9 draw calls.
// Built facing +z with the throwing arm on +x; the root is mirrored (scale.x = facing) and turned 3/4 to the camera.
import * as THREE from 'three';
import { MONKEY, PLAYER_COLORS } from '../core/constants.js';
import { createBananaMesh } from './banana.js';
import { ColorBatch, DEG, clamp, dampFactor, lerp, trs } from './util.js';

const SIZE = MONKEY.height / 4; // the model is built 4 m tall; scale it to the hit box
const YAW = 0.7;            // radians of the 3/4 turn toward the camera
const VR_YAW = 1.0;         // in VR you stand on the play line (at ±x): a bigger turn faces the opponent toward you
const HIP_X = 0.34;
const HIP_Y = 1.05;
const TORSO_Y = 1.05;
const SHOULDER_X = 0.7;
const SHOULDER_Y = 1.22;    // torso-local
const NECK_Y = 1.48;        // torso-local
const AIM_ANGLE = 148;      // degrees: throwing arm raised; the hand lands near MONKEY.handX / handY

const FUR = ['#7b4a2a', '#8c5530'];
const SKIN = '#f1c89c';
const MUZZLE = '#f7d9b6';
const BELLY = '#e8b98a';
const INNER_EAR = '#e6a58a';
const EYE = '#ffffff';
const PUPIL = '#1b1210';
const MOUTH = '#4a1c14';
const NOSE = '#4a2818';

const POSE_KEYS = ['armR', 'armL', 'armRx', 'armLx', 'legL', 'legR', 'lean', 'twist', 'hop', 'headTilt', 'headNod', 'headTurn', 'yaw', 'mouthScale'];
const ease = (t) => t * t * (3 - 2 * t);
const sphere = (r, w = 16, h = 12) => new THREE.SphereGeometry(r, w, h);
const literal = (key, _rand, target) => target.set(key);

function legGeometry(fur) {
  const b = new ColorBatch();
  b.add(new THREE.CapsuleGeometry(0.2, 0.55, 4, 10), fur, { matrix: trs(0, -0.475, 0) });
  b.add(sphere(0.27, 12, 8), SKIN, { matrix: trs(0, -0.9, 0.12, 1, 0.55, 1.45) });
  return b.build(literal);
}

function armGeometry(fur) {
  const b = new ColorBatch();
  b.add(new THREE.CapsuleGeometry(0.15, 0.85, 4, 8), fur, { matrix: trs(0, -0.575, 0) });
  b.add(sphere(0.22, 12, 8), SKIN, { matrix: trs(0, -1.22, 0.02) });
  return b.build(literal);
}

function torsoGeometry(fur) {
  const b = new ColorBatch();
  b.add(sphere(0.72, 20, 14), fur, { matrix: trs(0, 0.72, 0, 1, 1.12, 0.85) });
  b.add(sphere(0.55, 16, 12), BELLY, { matrix: trs(0, 0.62, 0.36, 0.9, 1, 0.55) });
  return b.build(literal);
}

function headGeometry(fur, band) {
  const b = new ColorBatch();
  b.add(sphere(0.78, 22, 16), fur, { matrix: trs(0, 0.62, 0) });
  b.add(sphere(0.6), SKIN, { matrix: trs(0, 0.5, 0.38, 1.12, 0.92, 0.62) });
  b.add(sphere(0.36), MUZZLE, { matrix: trs(0, 0.3, 0.66, 1.25, 0.82, 0.85) });
  for (const s of [-1, 1]) {
    b.add(sphere(0.045, 8, 6), NOSE, { matrix: trs(s * 0.09, 0.38, 0.96) });
    b.add(sphere(0.3, 14, 10), fur, { matrix: trs(s * 0.8, 0.72, -0.05, 1, 1, 0.42) });
    b.add(sphere(0.19, 12, 8), INNER_EAR, { matrix: trs(s * 0.81, 0.72, 0.03, 1, 1, 0.4) });
    b.add(sphere(0.17, 14, 10), EYE, { matrix: trs(s * 0.25, 0.76, 0.68, 0.9, 1.15, 0.6) });
    b.add(sphere(0.085, 10, 8), PUPIL, { matrix: trs(s * 0.25 + 0.03, 0.75, 0.77, 1, 1.1, 0.5) });
    b.add(sphere(0.03, 6, 4), EYE, { matrix: trs(s * 0.25 + 0.055, 0.79, 0.81) });
  }
  // Headband in the player's color, knotted at the back with two short tails.
  b.add(new THREE.TorusGeometry(0.67, 0.085, 8, 28), band, { matrix: trs(0, 1.06, 0, 1, 1, 1, Math.PI / 2) });
  b.add(sphere(0.13, 10, 8), band, { matrix: trs(0, 1.04, -0.66) });
  b.add(sphere(0.16, 10, 8), band, { matrix: trs(0.13, 0.95, -0.82, 0.55, 0.3, 1.25, 0.5, 0.3) });
  b.add(sphere(0.16, 10, 8), band, { matrix: trs(-0.12, 0.92, -0.8, 0.55, 0.3, 1.2, 0.7, -0.3) });
  return b.build(literal);
}

function tailGeometry(fur) {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.05, -0.15, -0.3), new THREE.Vector3(0.12, -0.05, -0.65),
    new THREE.Vector3(0.15, 0.35, -0.85), new THREE.Vector3(0.12, 0.75, -0.75), new THREE.Vector3(0.08, 0.92, -0.45),
    new THREE.Vector3(0.05, 0.75, -0.3), new THREE.Vector3(0.06, 0.6, -0.45), new THREE.Vector3(0.08, 0.68, -0.6),
  ]);
  const b = new ColorBatch();
  b.add(new THREE.TubeGeometry(curve, 40, 0.075, 6, false), fur);
  b.add(sphere(0.08, 8, 6), fur, { matrix: trs(0.08, 0.68, -0.6) });
  return b.build(literal);
}

function lidGeometry(fur) {
  const b = new ColorBatch();
  // Slightly larger than the eye and pupil so a blink covers them completely.
  for (const s of [-1, 1]) b.add(sphere(0.185, 14, 10), fur, { matrix: trs(s * 0.25, 0.76, 0.7, 0.95, 1.2, 0.8) });
  return b.build(literal);
}

function mouthGeometries() {
  const smile = new ColorBatch();
  // Built around the origin so the mesh can be scaled in place (bigger grin when dancing).
  smile.add(new THREE.TorusGeometry(0.15, 0.032, 6, 14, Math.PI), MOUTH, { matrix: trs(0, 0, 0, 1, 1, 1, -0.3, 0, Math.PI) });
  const o = new ColorBatch();
  o.add(sphere(0.11, 12, 8), MOUTH, { matrix: trs(0, 0, 0, 1, 1.25, 0.5) });
  return { smile: smile.build(literal), o: o.build(literal) };
}

export class MonkeyModel {
  /**
   * @param {number} index player index (0 left, 1 right)
   * @param {{material: THREE.Material, shadows?: boolean}} opts
   */
  constructor(index, { material, shadows = false }) {
    this.index = index;
    const fur = FUR[index % FUR.length];
    const band = PLAYER_COLORS[index] ?? '#ffffff';
    this.geometries = [];
    const mesh = (geo) => {
      this.geometries.push(geo);
      const m = new THREE.Mesh(geo, material);
      m.castShadow = shadows;
      return m;
    };

    this.root = new THREE.Group();
    this.root.name = `monkey${index}`;
    this.hips = new THREE.Group();
    this.root.add(this.hips);

    const legGeo = legGeometry(fur);
    this.legL = mesh(legGeo);
    this.legR = new THREE.Mesh(legGeo, material);
    this.legR.castShadow = shadows;
    this.legL.position.set(-HIP_X, HIP_Y, 0);
    this.legR.position.set(HIP_X, HIP_Y, 0);
    this.torso = new THREE.Group();
    this.torso.position.set(0, TORSO_Y, 0);
    this.hips.add(this.legL, this.legR, this.torso);

    this.body = mesh(torsoGeometry(fur));
    this.tail = mesh(tailGeometry(fur));
    this.tail.position.set(0, 0.3, -0.55);
    const armGeo = armGeometry(fur);
    this.armR = mesh(armGeo);
    this.armL = new THREE.Mesh(armGeo, material);
    this.armL.castShadow = shadows;
    this.armR.position.set(SHOULDER_X, SHOULDER_Y, 0);
    this.armL.position.set(-SHOULDER_X, SHOULDER_Y, 0);
    this.head = new THREE.Group();
    this.head.position.set(0, NECK_Y, 0);
    this.torso.add(this.body, this.tail, this.armR, this.armL, this.head);

    this.headMesh = mesh(headGeometry(fur, band));
    const mouths = mouthGeometries();
    this.smile = mesh(mouths.smile);
    this.mouthO = mesh(mouths.o);
    this.smile.position.set(0, 0.3, 0.935);
    this.mouthO.position.set(0, 0.2, 0.93);
    this.lids = mesh(lidGeometry(fur));
    this.head.add(this.headMesh, this.smile, this.mouthO, this.lids);

    // Banana held in the throwing hand by its stem, pointing past the hand.
    this.banana = createBananaMesh();
    this.banana.position.set(0, -1.62, 0.06);
    this.banana.rotation.set(0.3, 0, -Math.PI / 2);
    this.banana.castShadow = shadows;
    this.armR.add(this.banana);

    // VR x-ray: a player-colored silhouette drawn only where buildings hide the monkey (GreaterDepth),
    // switched on by the view when the line of sight from the headset is blocked.
    this.xrayMat = new THREE.MeshBasicMaterial({
      color: band, transparent: true, opacity: 0.55, depthWrite: false, depthFunc: THREE.GreaterDepth, fog: false,
    });
    this.xrayMat.visible = false;
    for (const part of [this.legL, this.legR, this.body, this.tail, this.armR, this.armL, this.headMesh]) {
      const ghost = new THREE.Mesh(part.geometry, this.xrayMat);
      ghost.renderOrder = 19;
      part.add(ghost);
    }

    this.pose = {};
    this.tgt = {};
    for (const k of POSE_KEYS) this.pose[k] = this.tgt[k] = 0;
    this.time = 0;
    this.phase = index * 1.7;
    this.blinkTimer = 1 + index * 1.3;
    this.blinkLeft = 0;
    this.reset();
  }

  /** Back to a neutral idle pose (new round). */
  reset() {
    const p = this.pose;
    for (const k of POSE_KEYS) p[k] = 0;
    p.armR = 12;
    p.armL = -12;
    p.yaw = YAW;
    p.mouthScale = 1;
  }

  /**
   * Pose the monkey for this frame.
   * @param {number} dt
   * @param {object} m game monkey: {x, y, facing, alive, anim, animTime}
   * @param {{hidden?: boolean, aiming?: boolean, thinking?: boolean, banana?: {x:number,y:number}|null, thrower?: number, vr?: boolean}} ctx
   *   vr: a player stands in one of the monkeys (opponent turns toward them); xray: show through buildings
   */
  update(dt, m, ctx) {
    const visible = Boolean(m) && !ctx.hidden && m.alive !== false && m.anim !== 'dead';
    this.root.visible = visible;
    this.xrayMat.visible = visible && Boolean(ctx.xray);
    if (!visible) return;
    this.time += dt;
    const T = this.time + this.phase;
    const t = Number.isFinite(m.animTime) ? m.animTime : 0;
    const facing = m.facing < 0 ? -1 : 1;
    this.root.position.set(m.x, m.y, 0);
    this.root.scale.set(facing * SIZE, SIZE, SIZE);

    const g = this.tgt;
    const breath = Math.sin(T * 2.4);
    g.armR = 12 + 4 * Math.sin(T * 1.7);
    g.armL = -12 - 4 * Math.sin(T * 1.7 + 1);
    g.armRx = 0;
    g.armLx = 0;
    g.legL = 0;
    g.legR = 0;
    g.lean = 0.03 * Math.sin(T * 0.9);
    g.twist = 0;
    g.hop = 0;
    g.headTilt = 0.04 * Math.sin(T * 0.7);
    g.headNod = 0;
    g.headTurn = 0;
    g.yaw = ctx.vr ? VR_YAW : YAW;
    g.mouthScale = 1;
    let mouth = 'smile';
    let holding = false;
    let snapArm = false;

    if (m.anim === 'throw') {
      snapArm = t < 0.36;
      if (t < 0.07) g.armR = lerp(AIM_ANGLE, 220, ease(t / 0.07));
      else if (t < 0.2) g.armR = lerp(220, 40, ease((t - 0.07) / 0.13));
      else if (t < 0.36) g.armR = lerp(40, 26, (t - 0.2) / 0.16);
      const swing = Math.sin(Math.PI * clamp(t / 0.45, 0, 1));
      g.lean = -0.22 * swing;
      g.twist = t < 0.2 ? -0.25 : 0.2 * (1 - clamp((t - 0.2) / 0.4, 0, 1));
      g.armL = -(25 + 35 * swing);
      g.headNod = -0.1 * swing;
    } else if (m.anim === 'fall') {
      g.armR = 150 + 35 * Math.sin(T * 24);
      g.armL = -(150 + 35 * Math.sin(T * 24 + Math.PI));
      g.legL = 0.6 * Math.sin(T * 18);
      g.legR = -0.6 * Math.sin(T * 18);
      g.lean = 0.1 * Math.sin(T * 11);
      g.headNod = -0.2;
      mouth = 'o';
    } else if (m.anim === 'victory') {
      g.yaw = 0.15;
      g.armR = 160 + 25 * Math.sin(T * 9);
      g.armL = -(160 + 25 * Math.sin(T * 9 + Math.PI));
      g.hop = 0.6 * Math.abs(Math.sin(T * 4.5));
      g.legL = g.legR = -0.6 * g.hop;
      g.headTilt = 0.12 * Math.sin(T * 9);
      g.lean = 0.06 * Math.sin(T * 4.5);
      g.mouthScale = 1.35;
    } else if (ctx.aiming || ctx.thinking) {
      holding = true;
      g.armR = AIM_ANGLE + 3 * Math.sin(T * 2.5);
      g.armRx = -0.15;
      g.armL = -22;
      if (ctx.thinking) {
        // CPU: scratch the head while planning.
        g.armL = 138 + 8 * Math.sin(T * 14);
        g.armLx = 0.35;
        g.headTilt = 0.1;
      }
    }

    // Watch a flying banana; look worried when the opponent's banana gets close.
    const b = ctx.banana;
    if (b && m.anim !== 'throw' && m.anim !== 'victory') {
      const dx = (b.x - m.x) * facing;
      const dy = b.y - (m.y + 3.2);
      g.headNod = -0.45 * clamp(Math.atan2(dy, Math.abs(dx) + 1), -0.6, 0.9);
      g.headTurn = 0.35 * clamp(dx / 20, -1, 1);
      if (ctx.thrower !== this.index && Math.hypot(b.x - m.x, dy) < 14) mouth = 'o';
    }

    const p = this.pose;
    const k = dampFactor(12, dt);
    for (let i = 0; i < POSE_KEYS.length; i++) {
      const key = POSE_KEYS[i];
      p[key] += (g[key] - p[key]) * k;
    }
    if (snapArm) p.armR = g.armR;

    this.root.rotation.set(0, facing * p.yaw, 0);
    this.hips.position.y = p.hop;
    this.legL.rotation.x = p.legL;
    this.legR.rotation.x = p.legR;
    this.torso.rotation.set(0, p.twist, p.lean);
    this.torso.scale.set(1 - 0.01 * breath, 1 + 0.025 * breath, 1);
    this.armR.rotation.set(p.armRx, 0, p.armR * DEG);
    this.armL.rotation.set(p.armLx, 0, p.armL * DEG);
    this.head.position.y = NECK_Y + 0.015 * breath;
    this.head.rotation.set(p.headNod, p.headTurn, p.headTilt);
    this.tail.rotation.set(0.1 * Math.sin(T * 2.1), 0.4 * Math.sin(T * 1.6), 0);
    this.banana.visible = holding;
    this.smile.visible = mouth === 'smile';
    this.mouthO.visible = mouth === 'o';
    this.smile.scale.setScalar(p.mouthScale);

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkLeft = 0.13;
      this.blinkTimer = 2 + Math.random() * 4;
    }
    this.blinkLeft = Math.max(0, this.blinkLeft - dt);
    this.lids.visible = this.blinkLeft > 0 && mouth !== 'o';
  }

  dispose() {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    this.xrayMat.dispose();
  }
}
