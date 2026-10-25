// Small VR-only props: the banana that floats in / is held by your hand, and the thumbstick aim arrow.

import * as THREE from 'three';

const HALO_COLOR = 0xffe36b;

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
    let mesh = null;
    try {
      mesh = createMesh?.();
    } catch (err) {
      console.warn('[xr] createBananaMesh failed, using a fallback banana', err);
    }
    // The view's banana shares geometry/material with every other banana (never dispose it); ours is private.
    this.ownsMesh = !mesh?.isObject3D;
    this.mesh = this.ownsMesh ? makeFallbackBanana() : mesh;
    this.ownMaterial = null;
    if (!this.ownsMesh && this.mesh.material && !Array.isArray(this.mesh.material)) {
      this.ownMaterial = this.mesh.material.clone(); // never change the shared banana material
      this.ownMaterial.transparent = true;
      this.ownMaterial.opacity = 1;
      this.mesh.material = this.ownMaterial;
    }
    this.mesh.renderOrder = 955; // after the HUD (910), before the gloves (960)
    this.baseScale = this.mesh.scale.clone();
    this.holder.add(this.mesh);
    this.haloMat = new THREE.MeshBasicMaterial({
      color: HALO_COLOR, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, toneMapped: false,
    });
    this.halo = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), this.haloMat);
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
    this.ownMaterial?.dispose();
    if (this.ownsMesh) {
      this.mesh.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
    }
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
