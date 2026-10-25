import { h } from './dom.js';

const FADE = 0.35;      // seconds of fade-out at the end of a toast's life
const MAX_SMALL = 3;

/**
 * Center-screen messages. One "big" slot (a new big toast replaces the old one) plus a few small pills.
 * Lifetimes run on update(dt), so they keep fading while the game is paused.
 */
export class Toasts {
  constructor() {
    this.el = h('div', { class: 'bs-toasts', role: 'status', 'aria-live': 'polite' });
    this.items = [];
  }

  /**
   * @param {string} text
   * @param {{ size?: 'big'|'small', sub?: string, color?: string, duration?: number }} [opts]
   */
  show(text, { size = 'small', sub = '', color = '', duration } = {}) {
    const same = this.items.filter((t) => t.size === size);
    if (size === 'big') same.forEach((t) => this.#remove(t));
    else if (same.length >= MAX_SMALL) this.#remove(same[0]);
    const node = h('div', { class: `bs-toast bs-toast-${size}` },
      h('div', { class: 'bs-toast-text', text }),
      sub ? h('div', { class: 'bs-toast-sub', text: sub }) : null);
    if (color) node.style.setProperty('--toast-color', color);
    if (size === 'big') this.el.prepend(node);
    else this.el.append(node);
    const item = { node, size, life: duration ?? (size === 'big' ? 1.8 : 1.4), fading: false };
    this.items.push(item);
    return item;
  }

  update(dt) {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    // Backwards, so removing an item does not skip the next one (and no per-frame array copy).
    for (let i = this.items.length - 1; i >= 0; i--) {
      const t = this.items[i];
      t.life -= step;
      if (!t.fading && t.life <= FADE) {
        t.fading = true;
        t.node.classList.add('bs-out');
      }
      if (t.life <= 0) this.#remove(t);
    }
  }

  clear() {
    for (const t of [...this.items]) this.#remove(t);
  }

  #remove(t) {
    t.node.remove();
    this.items = this.items.filter((x) => x !== t);
  }
}
