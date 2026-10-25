// Aim display for a human turn: an arrow from the hand (length ~ power), optional preview dots of the first part
// of the path, and a faint dotted trace showing where this player's previous banana went.
import * as THREE from 'three';
import { PLAYER_COLORS } from '../core/constants.js';
import { DEG, dotTexture, themeColor } from './util.js';

const HEAD_LEN = 0.8;
const MAX_DOTS = 64;
// Last-shot trace: screen-sized point sprites (GL lines are 1 px wide, nearly invisible in the headset).
const MAX_TRACE = 600;
const TRACE_SPACING = 1.6;          // world units between dots (grows for very long paths)
const TRACE_PX = { pc: 3, vr: 7 };  // dot size in pixels (times the pixel ratio on PC; XR renders at ratio 1)

export class AimView {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.name = 'aim';
    parent.add(this.group);

    this.arrowMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 });
    const shaft = new THREE.CylinderGeometry(0.11, 0.11, 1, 10).rotateZ(-Math.PI / 2).translate(0.5, 0, 0);
    const head = new THREE.ConeGeometry(0.34, HEAD_LEN, 14).rotateZ(-Math.PI / 2).translate(HEAD_LEN / 2, 0, 0);
    this.arrow = new THREE.Group();
    this.shaft = new THREE.Mesh(shaft, this.arrowMat);
    this.head = new THREE.Mesh(head, this.arrowMat);
    this.arrow.add(this.shaft, this.head);
    this.arrow.visible = false;

    this.dotMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 });
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), this.dotMat, MAX_DOTS);
    this.dots.name = 'aimPreview';
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.visible = false;

    const lineGeo = new THREE.BufferGeometry();
    this.linePos = new THREE.BufferAttribute(new Float32Array(MAX_TRACE * 3), 3);
    lineGeo.setAttribute('position', this.linePos);
    lineGeo.setDrawRange(0, 0);
    this.lineMat = new THREE.PointsMaterial({
      size: TRACE_PX.pc, sizeAttenuation: false, map: dotTexture(), transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.line = new THREE.Points(lineGeo, this.lineMat);
    this.line.name = 'lastShot';
    this.line.frustumCulled = false;
    this.line.visible = false;
    this.markerMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false });
    this.marker = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.11, 6, 24), this.markerMat);
    this.marker.visible = false;

    this.group.add(this.arrow, this.dots, this.line, this.marker);
    this.lastPath = null;
    this.previewKey = { turn: -1, angle: NaN, power: NaN, wind: NaN, version: -1 };
    this.m = new THREE.Matrix4();
  }

  hide() {
    this.arrow.visible = false;
    this.dots.visible = false;
    this.line.visible = false;
    this.marker.visible = false;
    this.lastPath = null; // rebuild the line (and marker) when it shows again
  }

  /**
   * @param {object|null} game
   * @param {{assist: string, localPlayer: number|null, cityVersion: number, scale?: number}} opts
   *   scale is the world scale: below 1 in VR, where the trace dots are drawn larger.
   */
  update(game, { assist, localPlayer, cityVersion, scale = 1 }) {
    const turn = game?.turn;
    const m = game?.monkeys?.[turn];
    const human = Boolean(game?.humanTurn) && Boolean(m) && m.alive !== false && Boolean(game.city);
    if (!human) {
      this.hide();
      return;
    }
    const color = themeColor(PLAYER_COLORS[turn] ?? '#ffffff');
    this.arrowMat.color.copy(color);
    this.dotMat.color.copy(color).lerp(themeColor('#ffffff'), 0.5);
    this.lineMat.color.copy(color);
    this.lineMat.size = scale < 1 ? TRACE_PX.vr : TRACE_PX.pc;
    this.markerMat.color.copy(color);

    const showArrow = assist !== 'off' && localPlayer !== turn;
    const aim = game.aim?.[turn];
    this.arrow.visible = showArrow && Boolean(aim);
    if (this.arrow.visible) {
      const hand = game.handPosition(turn);
      const facing = m.facing < 0 ? -1 : 1;
      const a = (aim.angle || 0) * DEG;
      const len = 1 + (aim.power || 0) * 0.08;
      this.arrow.position.set(hand.x, hand.y, 0);
      this.arrow.rotation.set(0, 0, Math.atan2(Math.sin(a), Math.cos(a) * facing));
      const shaftLen = Math.max(0.05, len - HEAD_LEN);
      this.shaft.scale.set(shaftLen, 1, 1);
      this.head.position.x = shaftLen;
    }

    const showPreview = this.arrow.visible && assist === 'preview';
    this.dots.visible = showPreview;
    if (showPreview) this.updatePreview(game, turn, aim, cityVersion);

    this.updateLastShot(game.lastShots?.[turn] ?? null);
  }

  updatePreview(game, turn, aim, version) {
    const k = this.previewKey;
    if (k.turn === turn && k.angle === aim.angle && k.power === aim.power && k.wind === game.wind && k.version === version) return;
    k.turn = turn;
    k.angle = aim.angle;
    k.power = aim.power;
    k.wind = game.wind;
    k.version = version;
    let path = null;
    try {
      path = game.previewPath(turn, aim.angle, aim.power);
    } catch {
      path = null;
    }
    const n = Math.min(MAX_DOTS, Math.max(0, (path?.length ?? 0) - 1));
    for (let i = 0; i < n; i++) {
      const p = path[i + 1];
      const s = 1 - (0.5 * i) / Math.max(1, n);
      this.m.makeScale(s, s, s).setPosition(p.x, p.y, 0);
      this.dots.setMatrixAt(i, this.m);
    }
    this.dots.count = n;
    this.dots.instanceMatrix.needsUpdate = true;
  }

  updateLastShot(shot) {
    const path = shot?.path;
    if (!path || path.length < 2) {
      this.line.visible = false;
      this.marker.visible = false;
      this.lastPath = null;
      return;
    }
    if (path !== this.lastPath) {
      this.lastPath = path;
      const n = resamplePath(path, this.linePos.array, MAX_TRACE, TRACE_SPACING);
      this.linePos.needsUpdate = true;
      this.line.geometry.setDrawRange(0, n);
      const hit = shot.hit ?? path[path.length - 1];
      this.marker.position.set(hit.x, hit.y, 0);
      this.marker.visible = shot.hit?.kind !== 'out';
    }
    this.line.visible = true;
  }

  dispose() {
    this.shaft.geometry.dispose();
    this.head.geometry.dispose();
    this.arrowMat.dispose();
    this.dots.geometry.dispose();
    this.dotMat.dispose();
    this.dots.dispose();
    this.line.geometry.dispose();
    this.marker.geometry.dispose();
    this.markerMat.dispose();
    this.lineMat.dispose();
    this.group.removeFromParent();
  }
}

/**
 * Evenly spaced points along a polyline [{x, y}], written into `out` as (x, y, 0) triples; at most `max` points
 * (the spacing grows when the path is too long). Returns the number of points written.
 */
export function resamplePath(path, out, max, spacing) {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  const step = Math.max(spacing, length / Math.max(1, max - 1));
  let n = 0;
  let next = 0;   // distance along the path of the next dot
  let walked = 0; // distance along the path at the start of the current segment
  for (let i = 1; i < path.length && n < max; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    while (next <= walked + seg && n < max) {
      const t = seg > 0 ? (next - walked) / seg : 0;
      out[n * 3] = a.x + (b.x - a.x) * t;
      out[n * 3 + 1] = a.y + (b.y - a.y) * t;
      out[n * 3 + 2] = 0;
      n++;
      next += step;
    }
    walked += seg;
  }
  return n;
}
