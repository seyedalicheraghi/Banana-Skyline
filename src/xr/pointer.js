// Laser pointer: a thin beam from a controller's target ray, raycasting the interactive panels.

import * as THREE from 'three';

const IDLE_LENGTH = 1.5;

export class Laser {
  constructor() {
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false, fog: false, toneMapped: false });
    // A thin box rather than a GL line: 1-px lines are nearly invisible on the headset.
    this.beam = new THREE.Mesh(new THREE.BoxGeometry(0.003, 0.003, 1).translate(0, 0, -0.5), this.beamMat);
    this.beam.renderOrder = 950;
    // Transparent (at full opacity) so it sorts after the depth-test-free HUD instead of vanishing under it.
    this.dotMat = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, fog: false, toneMapped: false });
    this.dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), this.dotMat);
    this.dot.renderOrder = 951;
    this.group = new THREE.Group();
    this.group.name = 'xr-laser';
    this.group.add(this.beam, this.dot);
    this.group.visible = false;
    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = 20;
    this.hits = [];
  }

  /**
   * Nearest interactive panel under a controller's ray.
   * @param {THREE.Object3D} controller target-ray space (its matrixWorld must be current)
   * @param {Array<import('./panels.js').CanvasPanel>} panels
   * @returns {?{panel:object, button:?object, distance:number}}
   */
  cast(controller, panels) {
    this.raycaster.setFromXRController(controller);
    let best = null;
    for (const panel of panels) {
      if (!panel?.interactive) continue;
      this.hits.length = 0;
      this.raycaster.intersectObject(panel.mesh, false, this.hits);
      const hit = this.hits[0];
      if (hit && (!best || hit.distance < best.distance)) {
        best = { panel, button: panel.buttonAt(hit.uv), distance: hit.distance };
      }
    }
    return best;
  }

  /** Show the beam on `controller`, ending at the hit (if any). */
  show(controller, hit) {
    if (this.group.parent !== controller) controller.add(this.group);
    const length = hit ? Math.max(0.02, hit.distance) : IDLE_LENGTH;
    this.beam.scale.set(1, 1, length);
    this.beamMat.opacity = hit ? 0.85 : 0.4;
    this.dot.visible = Boolean(hit);
    this.dot.position.set(0, 0, -length);
    this.dotMat.color.set(hit?.button ? 0xffe066 : 0xffffff);
    this.group.visible = true;
  }

  hide() {
    this.group.visible = false;
  }

  dispose() {
    this.group.removeFromParent();
    this.beam.geometry.dispose();
    this.beamMat.dispose();
    this.dot.geometry.dispose();
    this.dotMat.dispose();
  }
}
