// VR panels: canvas-textured planes with large high-contrast text. Canvases are created lazily
// (constructors only), and redrawn only when their content key changes.

import * as THREE from 'three';
import { MAX_WIND, PLAYER_COLORS } from '../core/constants.js';

export const FONT_STACK = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
export const COLORS = {
  card: 'rgba(9, 13, 30, 0.88)',
  border: 'rgba(255, 255, 255, 0.22)',
  text: '#ffffff',
  dim: '#b9c5ea',
  accent: '#ffd84a',
  button: '#24305e',
  buttonHover: '#3d58b8',
  buttonBorder: 'rgba(255, 255, 255, 0.35)',
  selected: '#ffd84a',
  selectedText: '#1b1400',
};

export const font = (px, weight = 700) => `${weight} ${Math.round(px)}px ${FONT_STACK}`;

const nowSeconds = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;

export function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Draw one line of text, shrinking the font until it fits `maxWidth`. */
export function drawText(ctx, text, x, y, {
  px = 48, weight = 700, color = COLORS.text, align = 'center', maxWidth = Infinity, shadow = true,
} = {}) {
  if (!text) return;
  let size = px;
  ctx.font = font(size, weight);
  while (size > 16 && ctx.measureText(text).width > maxWidth) {
    size -= 2;
    ctx.font = font(size, weight);
  }
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  if (shadow) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillText(text, x + 3, y + 3);
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

export function drawCard(ctx, w, h, { radius = 40, inset = 6 } = {}) {
  roundRectPath(ctx, inset, inset, w - inset * 2, h - inset * 2, radius);
  ctx.fillStyle = COLORS.card;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = COLORS.border;
  ctx.stroke();
}

/** Rounded button with a label and optional second line. */
export function drawButton(ctx, { x, y, w, h, label, sub = '', hover = false, selected = false, px = 46 }) {
  roundRectPath(ctx, x, y, w, h, 24);
  ctx.fillStyle = selected ? COLORS.selected : hover ? COLORS.buttonHover : COLORS.button;
  ctx.fill();
  ctx.lineWidth = hover ? 6 : 3;
  ctx.strokeStyle = hover ? '#ffffff' : COLORS.buttonBorder;
  ctx.stroke();
  const color = selected ? COLORS.selectedText : COLORS.text;
  if (sub) {
    drawText(ctx, label, x + w / 2, y + h * 0.38, { px, color, maxWidth: w - 32, shadow: !selected });
    drawText(ctx, sub, x + w / 2, y + h * 0.74, { px: px * 0.58, weight: 500, color: selected ? COLORS.selectedText : COLORS.dim, maxWidth: w - 32, shadow: false });
  } else {
    drawText(ctx, label, x + w / 2, y + h / 2 + 2, { px, color, maxWidth: w - 32, shadow: !selected });
  }
}

/** Horizontal wind arrow centered at (cx, cy); length grows with strength, +dir points right. */
export function drawWindArrow(ctx, cx, cy, value, dir, maxLen, color = COLORS.accent, thickness = 16) {
  if (!value || !dir) {
    ctx.beginPath();
    ctx.arc(cx, cy, thickness * 0.8, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = COLORS.dim;
    ctx.stroke();
    return;
  }
  const len = maxLen * (0.25 + 0.75 * Math.min(1, value / MAX_WIND));
  const head = thickness * 2.2;
  const x0 = cx - (len / 2) * dir;
  const x1 = cx + (len / 2) * dir;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x0, cy - thickness / 2);
  ctx.lineTo(x1 - head * dir, cy - thickness / 2);
  ctx.lineTo(x1 - head * dir, cy - head * 0.75);
  ctx.lineTo(x1, cy);
  ctx.lineTo(x1 - head * dir, cy + head * 0.75);
  ctx.lineTo(x1 - head * dir, cy + thickness / 2);
  ctx.lineTo(x0, cy + thickness / 2);
  ctx.closePath();
  ctx.fill();
}

/**
 * A plane showing a 2D canvas. Buttons are canvas-pixel rectangles hit-tested from raycast uvs.
 */
export class CanvasPanel {
  /**
   * @param {object} o
   * @param {number} [o.width] canvas width in px
   * @param {number} [o.height] canvas height in px
   * @param {number} [o.meters] plane width in meters (height follows the canvas aspect)
   * @param {boolean} [o.depthTest]
   * @param {number} [o.renderOrder]
   * @param {string} [o.name]
   * @param {number} [o.minInterval] seconds between redraws while the content keeps changing
   */
  constructor({
    width = 1024, height = 512, meters = 1, depthTest = true, renderOrder = 900, name = 'xr-panel', minInterval = 0,
  } = {}) {
    this.width = width;
    this.height = height;
    this.minInterval = minInterval;
    this.lastDraw = -Infinity;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture, transparent: true, depthTest, depthWrite: false, fog: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(meters, (meters * height) / width), this.material);
    this.mesh.name = name;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
    this.mesh.userData.panel = this;
    this.buttons = [];
    this.key = null;
  }

  get visible() {
    return this.mesh.visible;
  }

  set visible(v) {
    this.mesh.visible = Boolean(v);
  }

  /** True when the laser should be able to click this panel. */
  get interactive() {
    return this.mesh.visible && this.buttons.length > 0;
  }

  /**
   * Redraw with `draw(ctx)` only if `key` changed. `draw` registers its buttons with addButton().
   * @returns {boolean} whether it redrew
   */
  redraw(key, draw) {
    if (key === this.key || !this.ctx) return false;
    // Each redraw re-uploads the whole texture (and its mipmaps): cap the rate on Quest.
    const now = nowSeconds();
    if (now - this.lastDraw < this.minInterval) return false; // the key stays stale, so it redraws soon
    this.lastDraw = now;
    this.key = key;
    this.buttons = [];
    this.ctx.clearRect(0, 0, this.width, this.height);
    draw(this.ctx);
    this.texture.needsUpdate = true;
    return true;
  }

  addButton(id, x, y, w, h) {
    this.buttons.push({ id, x, y, w, h });
    return { x, y, w, h };
  }

  /** Button under a raycast uv (PlaneGeometry uv: origin bottom-left), or null. */
  buttonAt(uv) {
    if (!uv) return null;
    const px = uv.x * this.width;
    const py = (1 - uv.y) * this.height;
    return this.buttons.find((b) => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) ?? null;
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

/** Match HUD: names and scores, round, wind, whose turn, last throw, messages, match-over buttons. */
export class HudPanel extends CanvasPanel {
  constructor() {
    // Not depth tested: it floats in the sky ahead of you and must never vanish inside a tall building.
    super({ width: 1024, height: 512, meters: 2.0, depthTest: false, renderOrder: 910, name: 'xr-hud', minInterval: 1 / 12 });
  }

  /** @param {object} s hudState(...) @param {?string} hover hovered button id */
  draw(s, hover = null) {
    this.redraw(JSON.stringify([s, hover]), (ctx) => {
      const W = this.width;
      drawCard(ctx, W, this.height);
      const active = s.turnText && !s.matchOver ? s.turn : -1;
      for (const i of [0, 1]) {
        const x = i === 0 ? 48 : W - 48;
        const align = i === 0 ? 'left' : 'right';
        drawText(ctx, s.names[i], x, 66, { px: 52, color: PLAYER_COLORS[i], align, maxWidth: 330 });
        drawText(ctx, String(s.scores[i]), x, 150, { px: 104, align });
        if (active === i) {
          ctx.fillStyle = PLAYER_COLORS[i];
          const ux = i === 0 ? 48 : W - 48 - 120;
          roundRectPath(ctx, ux, 98, 120, 8, 4);
          ctx.fill();
        }
      }
      drawText(ctx, s.round ? `ROUND ${s.round}` : '', W / 2, 62, { px: 40, color: COLORS.dim });
      drawText(ctx, s.target ? `first to ${s.target}` : '', W / 2, 104, { px: 30, weight: 500, color: COLORS.dim, shadow: false });

      // Wind: label, arrow (points toward the player it blows at), value and tail/headwind.
      drawText(ctx, 'WIND', W / 2 - 170, 170, { px: 38, color: COLORS.dim, align: 'right' });
      drawWindArrow(ctx, W / 2, 170, s.wind.value, s.wind.dir, 220);
      const windText = s.wind.value ? `${s.wind.value}${s.wind.relative ? ` ${s.wind.relative}` : ''}` : 'calm';
      drawText(ctx, windText, W / 2 + 170, 170, { px: 38, align: 'left', maxWidth: 200 });

      if (s.matchOver) {
        const color = s.matchOver.winner != null ? PLAYER_COLORS[s.matchOver.winner] : COLORS.accent;
        drawText(ctx, s.matchOver.text, W / 2, 262, { px: 64, color, maxWidth: W - 80 });
        const bw = 380;
        const bh = 112;
        const by = 340;
        const a = this.addButton('rematch', W / 2 - bw - 20, by, bw, bh);
        drawButton(ctx, { ...a, label: 'Rematch', sub: 'press A', hover: hover === 'rematch' });
        const b = this.addButton('menu', W / 2 + 20, by, bw, bh);
        drawButton(ctx, { ...b, label: 'Menu', sub: 'press B', hover: hover === 'menu' });
        return;
      }
      drawText(ctx, s.turnText, W / 2, 252, { px: 54, color: s.turnColor, maxWidth: W - 80 });
      drawText(ctx, s.hint, W / 2, 308, { px: 32, weight: 500, color: COLORS.dim, maxWidth: W - 80, shadow: false });
      drawText(ctx, s.lastText, W / 2, 362, { px: 36, weight: 600, maxWidth: W - 80 });
      if (s.message) drawText(ctx, s.message.text, W / 2, 440, { px: 66, color: s.message.color, maxWidth: W - 480 });
      // Always reachable with the laser, so hand-tracking players (no B/Y button) can open the menu too.
      const m = this.addButton('menu', 24, 444, 190, 56);
      drawButton(ctx, { ...m, label: 'Menu', hover: hover === 'menu', px: 30 });
    });
  }
}

/** Watch-style panel on the non-dominant wrist: wind and your last throw. */
export class WristPanel extends CanvasPanel {
  constructor() {
    // After the gloves (hands.js GLOVE_RENDER_ORDER), so their depth hides the part of the face behind them.
    super({ width: 1024, height: 512, meters: 0.15, depthTest: true, renderOrder: 970, name: 'xr-wrist' });
  }

  /** @param {object} s wristState(...) */
  draw(s) {
    this.redraw(JSON.stringify(s), (ctx) => {
      const W = this.width;
      drawCard(ctx, W, this.height, { radius: 60 });
      drawText(ctx, s.wind.value ? `WIND ${s.wind.value}` : 'WIND calm', W / 2, 92, { px: 92 });
      drawWindArrow(ctx, W / 2, 200, s.wind.value, s.wind.dir, 520, COLORS.accent, 34);
      drawText(ctx, s.wind.relative, W / 2, 300, { px: 72, color: COLORS.accent });
      drawText(ctx, s.last ? `Last: ${s.last}` : 'No throw yet', W / 2, 418, { px: 70, weight: 600, maxWidth: W - 60, color: s.last ? COLORS.text : COLORS.dim });
    });
  }
}
