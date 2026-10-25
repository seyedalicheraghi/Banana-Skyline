// The VR rig: where you stand, and the fade-to-black used for every teleport (comfort: no smooth moves).

import * as THREE from 'three';
import { CITY_WIDTH } from '../core/constants.js';

/** Overview spot (scene meters): centered in front of the city, looking at it from +z. */
export const OVERVIEW = { y: 6, z: 35 };
/** How far behind your monkey's center you stand (scene meters). */
export const ROOF_BACKOFF = 0.25;
/** Never shift the rig more than this to put your head (not your play-area origin) on the spot. */
const MAX_RECENTER = 2;

const FADE_OUT_SECONDS = 0.18;
const FADE_IN_SECONDS = 0.3;
const UP = new THREE.Vector3(0, 1, 0);
const _offset = new THREE.Vector3();

/** Rig yaw so the default forward (-z) looks toward +x (facing 1) or -x (facing -1). */
export function roofYaw(facing) {
  return facing < 0 ? Math.PI / 2 : -Math.PI / 2;
}

/** Feet position on the roof: a little behind the monkey's anchor. */
export function roofTarget(anchor, facing, target = new THREE.Vector3()) {
  return target.set(anchor.x - (facing < 0 ? -1 : 1) * ROOF_BACKOFF, anchor.y, anchor.z);
}

export function overviewTarget(worldScale, target = new THREE.Vector3()) {
  return target.set((CITY_WIDTH / 2) * worldScale, OVERVIEW.y, OVERVIEW.z);
}

/**
 * Put the rig on `target` with `yaw`. With a known head position (rig-local), shift horizontally so the
 * head ends up over the target even if the player is standing off-center in their room.
 */
export function placeRig(rig, target, yaw, head = null) {
  rig.rotation.set(0, yaw, 0);
  rig.position.copy(target);
  if (head) {
    _offset.set(head.x, 0, head.z);
    if (_offset.lengthSq() > MAX_RECENTER * MAX_RECENTER) _offset.setLength(MAX_RECENTER);
    _offset.applyAxisAngle(UP, yaw);
    rig.position.sub(_offset);
  }
  rig.updateMatrixWorld(true);
}

/**
 * Black sphere around the head. transition(action): fade out, run the action (once `hold()` is false),
 * fade in. cut(action): go black at once, run it, fade in. A newer request replaces a pending action.
 */
export class Fader {
  constructor(camera) {
    this.material = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0, side: THREE.BackSide,
      depthTest: false, depthWrite: false, fog: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), this.material);
    this.mesh.name = 'xr-fade';
    this.mesh.renderOrder = 10000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    camera.add(this.mesh);
    this.opacity = 0;
    this.target = 0;
    this.action = null;
    this.hold = null;
  }

  /** Fading, black, or waiting to run an action. */
  get busy() {
    return this.opacity > 0.02 || this.target > 0 || this.action !== null;
  }

  transition(action, hold = null) {
    this.action = action;
    this.hold = hold;
    this.target = 1;
  }

  cut(action) {
    this.opacity = 1;
    this.transition(action);
    this.update(0);
  }

  /** Stay black until the next cut or transition. */
  holdBlack() {
    this.opacity = 1;
    this.target = 1;
    this.action = null;
    this.hold = null;
    this.apply();
  }

  reset() {
    this.opacity = 0;
    this.target = 0;
    this.action = null;
    this.hold = null;
    this.apply();
  }

  update(dt) {
    const step = dt / (this.target > this.opacity ? FADE_OUT_SECONDS : FADE_IN_SECONDS);
    if (this.opacity < this.target) this.opacity = Math.min(this.target, this.opacity + step);
    else if (this.opacity > this.target) this.opacity = Math.max(this.target, this.opacity - step);
    if (this.action && this.target === 1 && this.opacity >= 1) {
      let waiting = false;
      try {
        waiting = Boolean(this.hold?.());
      } catch {
        waiting = false;
      }
      if (!waiting) {
        const action = this.action;
        this.action = null;
        this.hold = null;
        this.target = 0;
        try {
          action();
        } catch (err) {
          console.error('[xr] fade action failed', err);
        }
      }
    }
    this.apply();
  }

  apply() {
    this.material.opacity = this.opacity;
    this.mesh.visible = this.opacity > 0.001;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
