// Small VR-only props: the banana that floats in / is held by your hand, the bow, the aim preview and the
// thumbstick aim arrow.

import * as THREE from 'three';

const HALO_COLOR = 0xffe36b;
const BANANA_RENDER_ORDER = 955; // after the HUD (910), before the gloves (960)
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const _f = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/**
 * The view's banana for a VR prop. The view's mesh shares geometry/material with every flying banana (never
 * disposed here); its material is cloned so a prop can fade it. Falls back to a private banana.
 * @param {() => THREE.Object3D} createMesh
 */
function adoptBanana(createMesh) {
  let mesh = null;
  try {
    mesh = createMesh?.();
  } catch (err) {
    console.warn('[xr] createBananaMesh failed, using a fallback banana', err);
  }
  const owns = !mesh?.isObject3D;
  if (owns) mesh = makeFallbackBanana();
  let material = null;
  if (!owns && mesh.material && !Array.isArray(mesh.material)) {
    material = mesh.material.clone();
    material.transparent = true;
    material.opacity = 1;
    mesh.material = material;
  }
  mesh.renderOrder = BANANA_RENDER_ORDER;
  return { mesh, owns, material, baseScale: mesh.scale.clone() };
}

function disposeBanana(b) {
  b.material?.dispose();
  if (b.owns) {
    b.mesh.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose?.();
    });
  }
}

function makeHalo(radius) {
  const material = new THREE.MeshBasicMaterial({
    color: HALO_COLOR, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending,
    depthWrite: false, fog: false, toneMapped: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
}

/** Fallback banana (≈0.9 world units long, lying along x) if the view cannot make one. */
export function makeFallbackBanana() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.TorusGeometry(0.42, 0.1, 8, 20, 2.0),
    new THREE.MeshLambertMaterial({ color: 0xffd23a, emissive: 0x4a3a00 }),
  );
  body.rotation.z = -Math.PI / 2 - 1.0; // a "smile": the arc's middle at the bottom, ends at ±x
  body.position.y = 0.3;
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshLambertMaterial({ color: 0x5a3a12 }));
  tip.position.set(0.35, 0.07, 0);
  group.add(body, tip);
  return group;
}

/**
 * The banana you throw by hand. While waiting it hovers and glows above your dominant hand (a rig child,
 * so it stays upright whatever the controller's angle); once grabbed it sits in the fist (a grip child).
 */
export class HandBanana {
  /** @param {() => THREE.Object3D} createMesh */
  constructor(createMesh) {
    this.root = new THREE.Group();
    this.root.name = 'hand-banana';
    this.holder = new THREE.Group();
    this.root.add(this.holder);
    this.banana = adoptBanana(createMesh);
    this.mesh = this.banana.mesh;
    this.ownsMesh = this.banana.owns;
    this.ownMaterial = this.banana.material;
    this.baseScale = this.banana.baseScale;
    this.holder.add(this.mesh);
    this.halo = makeHalo(0.11);
    this.haloMat = this.halo.material;
    this.root.add(this.halo);
    this.root.visible = false;
    this.time = 0;
    this.held = false;
  }

  /** Size the banana like the one that flies through the scaled world. */
  setWorldScale(s) {
    this.mesh.scale.copy(this.baseScale).multiplyScalar(s > 0 ? s : 1);
  }

  hide() {
    this.root.visible = false;
  }

  /**
   * Hover above the hand.
   * @param {THREE.Object3D} rig parent while floating
   * @param {THREE.Vector3} gripPos grip position in rig coordinates
   */
  float(rig, gripPos, dt) {
    if (this.root.parent !== rig) rig.add(this.root);
    this.held = false;
    this.time += dt;
    this.root.visible = true;
    this.root.position.set(gripPos.x, gripPos.y + 0.13 + Math.sin(this.time * 3) * 0.012, gripPos.z);
    this.root.rotation.set(0, this.time * 1.4, 0);
    this.holder.rotation.set(0, 0, 0.35);
    this.holder.position.set(0, 0, 0);
    this.haloMat.opacity = 0.2 + 0.12 * (0.5 + 0.5 * Math.sin(this.time * 5));
    this.halo.visible = true;
  }

  /** Sit in the fist, along the grip's rod axis (-Z, toward the thumb). */
  hold(grip) {
    if (this.root.parent !== grip) grip.add(this.root);
    this.held = true;
    this.root.visible = true;
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.holder.position.set(-0.01, 0, -0.06);
    this.holder.rotation.set(0, Math.PI / 2, 0); // banana lies along x; turn it along -Z
    this.haloMat.opacity = 0.1;
  }

  dispose() {
    this.root.removeFromParent();
    this.haloMat.dispose();
    this.halo.geometry.dispose();
    disposeBanana(this.banana);
  }
}

const BOW_LIMB = 0.55;   // half length (meters; a prop you hold, so real size, not world scale)
const BOW_BRACE = 0.21;  // the string's distance behind the riser at rest (+Z, toward you)
const BOW_SETTLE = 14;   // damping rate of the idle bow's orientation: hand tremor stays out of it

/**
 * The bow for the two-handed throw. It sits in the bow hand; the string runs from the limb tips to the
 * nock, which follows the hand on the string while you draw; the banana rides on the nock, pointing where
 * it will fly. Bow space: -Z toward the target, +Y along the limbs, string on the +Z side.
 */
export class Bow {
  /** @param {() => THREE.Object3D} createMesh the view's banana */
  constructor(createMesh) {
    this.group = new THREE.Group();
    this.group.name = 'xr-bow';
    this.woodMat = new THREE.MeshLambertMaterial({ color: 0x8a5524, emissive: 0x2c1a08 });
    this.stringMat = new THREE.MeshBasicMaterial({ color: 0xf2ead2, fog: false, toneMapped: false });
    // A recurve: the limbs bow toward the target and the tips come back to the string.
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, -BOW_LIMB, BOW_BRACE), new THREE.Vector3(0, -BOW_LIMB * 0.55, 0.05), ZERO.clone(),
      new THREE.Vector3(0, BOW_LIMB * 0.55, 0.05), new THREE.Vector3(0, BOW_LIMB, BOW_BRACE),
    ]);
    this.limbs = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.012, 7, false), this.woodMat);
    this.riser = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.13, 10), this.woodMat);
    this.stringGeometry = new THREE.CylinderGeometry(0.003, 0.003, 1, 6).translate(0, 0.5, 0); // from a tip along +Y
    this.strings = [0, 1].map(() => new THREE.Mesh(this.stringGeometry, this.stringMat));
    this.tips = [new THREE.Vector3(0, -BOW_LIMB, BOW_BRACE), new THREE.Vector3(0, BOW_LIMB, BOW_BRACE)];
    this.rest = new THREE.Vector3(0, 0, BOW_BRACE);

    this.nock = new THREE.Group();
    this.nock.position.copy(this.rest);
    this.banana = adoptBanana(createMesh);
    this.banana.mesh.rotation.set(0, Math.PI / 2, 0); // the banana lies along x; point it along -Z
    this.halo = makeHalo(0.08);
    this.haloMat = this.halo.material;
    this.nock.add(this.banana.mesh, this.halo);

    this.group.add(this.limbs, this.riser, ...this.strings, this.nock);
    this.group.visible = false;
    this.settled = false;
    this.drawing = false;
    this.time = 0;
  }

  /** Size the banana like the one that flies through the scaled world. */
  setWorldScale(s) {
    this.banana.mesh.scale.copy(this.banana.baseScale).multiplyScalar(s > 0 ? s : 1);
  }

  hide() {
    this.group.visible = false;
    this.settled = false;
    this.drawing = false;
  }

  /** The banana left the string: the bow stays until the turn is over. */
  loose() {
    this.nock.visible = false;
    this.drawing = false;
  }

  /**
   * Place the bow in the bow hand. Idle it points where the rig faces (the opponent); while drawing it lies
   * along the pull, from the string hand to the bow hand, limbs as upright as that allows.
   * @param {THREE.Object3D} rig parent (the hands are rig children, so positions are rig-local)
   * @param {THREE.Vector3} bowPos grip position of the bow hand
   * @param {?THREE.Vector3} stringPos grip position of the hand on the string, or null when not drawing
   * @param {number} dt seconds
   */
  show(rig, bowPos, stringPos, dt) {
    if (this.group.parent !== rig) rig.add(this.group);
    this.group.visible = true;
    this.nock.visible = true;
    this.time += dt;
    this.group.position.copy(bowPos);

    if (stringPos && _f.subVectors(bowPos, stringPos).lengthSq() > 1e-4) _f.normalize();
    else _f.set(0, 0, -1);
    _u.set(0, 1, 0).addScaledVector(_f, -_f.y); // vertical, made perpendicular to the pull
    if (_u.lengthSq() < 1e-4) _u.set(0, 0, -1).addScaledVector(_f, _f.z); // pulling straight up or down
    _u.normalize();
    _m.lookAt(ZERO, _f, _u); // -Z toward the target
    _q.setFromRotationMatrix(_m);
    const drawing = Boolean(stringPos);
    if (drawing || !this.settled) this.group.quaternion.copy(_q);
    else this.group.quaternion.slerp(_q, 1 - Math.exp(-BOW_SETTLE * Math.max(0, dt || 0)));
    this.settled = true;

    if (drawing) _v.subVectors(stringPos, bowPos).applyQuaternion(_q.copy(this.group.quaternion).invert());
    else _v.copy(this.rest);
    this.nock.position.copy(_v);
    for (let i = 0; i < 2; i++) {
      const s = this.strings[i];
      _d.subVectors(_v, this.tips[i]);
      const len = _d.length();
      s.position.copy(this.tips[i]);
      s.scale.set(1, Math.max(1e-3, len), 1);
      s.quaternion.setFromUnitVectors(Y_AXIS, len > 1e-6 ? _d.divideScalar(len) : Y_AXIS);
    }
    this.haloMat.opacity = drawing ? 0.12 : 0.18 + 0.1 * (0.5 + 0.5 * Math.sin(this.time * 5));
    this.drawing = drawing;
  }

  dispose() {
    this.group.removeFromParent();
    this.limbs.geometry.dispose();
    this.riser.geometry.dispose();
    this.stringGeometry.dispose();
    this.halo.geometry.dispose();
    this.woodMat.dispose();
    this.stringMat.dispose();
    this.haloMat.dispose();
    disposeBanana(this.banana);
  }
}

const PATH_DOTS = 48;

/**
 * Preview of a throw: dots along the first part of the banana's path, in play-plane units. Lives in the
 * scene and takes the world group's transform, so it lands exactly where the banana will fly.
 */
export class AimPath {
  constructor() {
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85, fog: false, toneMapped: false, depthWrite: false,
    });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.2, 8, 6), this.material, PATH_DOTS);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 6;
    this.group = new THREE.Group();
    this.group.name = 'xr-aim-path';
    this.group.matrixAutoUpdate = false;
    this.group.add(this.dots);
    this.group.visible = false;
    this.m = new THREE.Matrix4();
  }

  /**
   * @param {Array<{x:number, y:number}>} path world points, the first one at the hand
   * @param {THREE.Matrix4} worldMatrix the world group's matrixWorld
   * @param {string|number} color
   */
  show(path, worldMatrix, color) {
    this.group.matrix.copy(worldMatrix);
    this.group.matrixWorldNeedsUpdate = true;
    this.material.color.set(color);
    const n = Math.max(0, (path?.length ?? 0) - 1);
    const count = Math.min(PATH_DOTS, n);
    const stride = n / Math.max(1, count); // the dots spread over the whole preview, shrinking along it
    for (let i = 0; i < count; i++) {
      const p = path[1 + Math.min(n - 1, Math.floor(i * stride))];
      const s = 1 - (0.45 * i) / Math.max(1, count);
      this.m.makeScale(s, s, s).setPosition(p.x, p.y, 0);
      this.dots.setMatrixAt(i, this.m);
    }
    this.dots.count = count;
    this.dots.instanceMatrix.needsUpdate = true;
    this.group.visible = count > 0;
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.group.removeFromParent();
    this.dots.geometry.dispose();
    this.dots.dispose();
    this.material.dispose();
  }
}

/**
 * Aim arrow for thumbstick mode, drawn in the play plane from the thrower's hand. Lives in the scene
 * (not in `world`, which the view owns) and copies the world group's scale.
 */
export class AimArrow {
  constructor() {
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, fog: false, toneMapped: false });
    const shaftGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 10).rotateZ(-Math.PI / 2).translate(0.5, 0, 0);
    const headGeo = new THREE.ConeGeometry(0.38, 0.9, 12).rotateZ(-Math.PI / 2).translate(0.45, 0, 0);
    this.shaft = new THREE.Mesh(shaftGeo, this.material);
    this.head = new THREE.Mesh(headGeo, this.material);
    this.group = new THREE.Group();
    this.group.name = 'xr-aim-arrow';
    this.group.add(this.shaft, this.head);
    this.group.visible = false;
    this.shaft.renderOrder = 5;
    this.head.renderOrder = 5;
  }

  /**
   * @param {THREE.Vector3} origin scene position of the thrower's hand
   * @param {number} angleDeg degrees from horizontal toward the opponent
   * @param {number} power 0..100
   * @param {number} facing +1 right, -1 left
   * @param {number} scale world group scale
   * @param {string|number} color
   */
  show(origin, angleDeg, power, facing, scale, color) {
    const a = (angleDeg * Math.PI) / 180;
    const len = 1.5 + (Math.max(0, Math.min(100, power)) / 100) * 9; // world units
    this.group.position.copy(origin);
    this.group.scale.setScalar(scale > 0 ? scale : 1);
    this.group.rotation.set(0, 0, Math.atan2(Math.sin(a), Math.cos(a) * (facing < 0 ? -1 : 1)));
    this.shaft.scale.set(len, 1, 1);
    this.head.position.x = len;
    this.material.color.set(color);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.group.removeFromParent();
    this.shaft.geometry.dispose();
    this.head.geometry.dispose();
    this.material.dispose();
  }
}
