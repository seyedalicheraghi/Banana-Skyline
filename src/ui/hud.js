import { MAX_POWER } from '../core/constants.js';
import { h, nextId, paintRange, setText, syncValue } from './dom.js';
import { formatAim, windInfo } from './settings.js';

const HINT_FINE = 'Drag from your monkey, or use ← → for angle, ↑ ↓ for power and Space to throw';
const HINT_COARSE = 'Drag from your monkey, then let go to throw';
const MAX_PIPS = 10;

const parse = (value) => {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * In-match heads-up display: player cards with scores, round + wind, turn banner, the aim panel and the
 * drag guide. Every setter caches its last value, so the UI can push the full state every frame.
 */
export class Hud {
  /**
   * @param {{ onPause: () => void, onAim: (aim: {angle?: number, power?: number}) => void,
   *   onThrow: (typed?: {angle: number|null, power: number|null}) => void }} actions
   */
  constructor({ onPause, onAim, onThrow }) {
    this.cache = new Map();
    this.cards = [0, 1].map((i) => playerCard(i));

    this.roundEl = h('div', { class: 'bs-round' });
    this.windArrow = h('div', { class: 'bs-wind-arrow' });
    this.windLabel = h('div', { class: 'bs-wind-label' });
    this.windEl = h('div', { class: 'bs-wind', role: 'img' },
      h('div', { class: 'bs-wind-track' }, h('div', { class: 'bs-wind-tick' }), this.windArrow),
      this.windLabel);
    const pauseBtn = h('button', {
      class: 'bs-icon-btn', type: 'button', 'aria-label': 'Pause (Esc)', title: 'Pause (Esc)',
      on: { click: () => onPause?.() },
    }, h('span', { class: 'bs-pause-icon', 'aria-hidden': 'true' }));
    const mid = h('div', { class: 'bs-hud-mid' }, h('div', { class: 'bs-mid-info' }, this.roundEl, this.windEl), pauseBtn);
    this.banner = h('div', { class: 'bs-banner', 'aria-live': 'polite' });
    const top = h('div', { class: 'bs-hud-top' }, this.cards[0].el, mid, this.cards[1].el, this.banner);

    this.#buildAimPanel(onAim, onThrow);

    this.guideLine = h('div', { class: 'bs-guide-line' });
    this.guideChip = h('div', { class: 'bs-guide-chip' });
    this.guide = h('div', { class: 'bs-guide', hidden: true, 'aria-hidden': 'true' }, this.guideLine, this.guideChip);

    this.el = h('div', { class: 'bs-hud', hidden: true }, top, this.aimPanel, this.guide);
  }

  #buildAimPanel(onAim, onThrow) {
    const angleId = nextId('angle');
    const powerId = nextId('power');
    const hintId = nextId('aim-hint');
    const number = (id, max, label) => h('input', {
      id, class: 'bs-num', type: 'number', min: 0, max, step: 1, inputmode: 'numeric',
      autocomplete: 'off', 'aria-describedby': hintId, 'aria-label': label,
    });
    const range = (max, label) => h('input', { class: 'bs-range', type: 'range', min: 0, max, step: 1, 'aria-label': label });

    this.angleNum = number(angleId, 180, 'Angle in degrees');
    this.powerNum = number(powerId, MAX_POWER, 'Power');
    this.angleRange = range(180, 'Angle slider');
    this.powerRange = range(MAX_POWER, 'Power slider');

    const typed = () => ({ angle: parse(this.angleNum.value), power: parse(this.powerNum.value) });
    this.angleNum.addEventListener('input', () => { const v = parse(this.angleNum.value); if (v !== null) onAim?.({ angle: v }); });
    this.powerNum.addEventListener('input', () => { const v = parse(this.powerNum.value); if (v !== null) onAim?.({ power: v }); });
    this.angleRange.addEventListener('input', () => { paintRange(this.angleRange); onAim?.({ angle: Number(this.angleRange.value) }); });
    this.powerRange.addEventListener('input', () => { paintRange(this.powerRange); onAim?.({ power: Number(this.powerRange.value) }); });
    // After a mouse/touch slide, hand the keys back to the game (arrows = angle/power, Space = throw).
    for (const r of [this.angleRange, this.powerRange]) r.addEventListener('pointerup', () => r.blur());
    // The original game's flow: type the angle, Enter, type the power, Enter throws.
    this.angleNum.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      this.powerNum.focus();
      this.powerNum.select();
    });
    this.powerNum.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const values = typed();
      this.powerNum.blur();
      onThrow?.(values);
    });

    const field = (id, labelText, num, unit, slider) => h('div', { class: 'bs-aim-field' },
      h('label', { for: id, class: 'bs-aim-label', text: labelText }),
      h('div', { class: 'bs-aim-num' }, num, h('span', { class: 'bs-unit', 'aria-hidden': 'true', text: unit })),
      slider);

    this.aimWho = h('span', { class: 'bs-aim-who' });
    this.aimLast = h('span', { class: 'bs-aim-last' });
    this.throwBtn = h('button', { class: 'bs-btn bs-btn-primary bs-throw', type: 'button', on: { click: () => onThrow?.() } }, 'THROW!');
    this.aimPanel = h('div', { class: 'bs-aim', role: 'group', 'aria-label': 'Aim and throw', hidden: true },
      h('div', { class: 'bs-aim-head' }, this.aimWho, this.aimLast),
      h('div', { class: 'bs-aim-row' },
        field(angleId, 'Angle', this.angleNum, '°', this.angleRange),
        field(powerId, 'Power', this.powerNum, '', this.powerRange),
        this.throwBtn),
      h('div', { class: 'bs-aim-hint', id: hintId },
        h('span', { class: 'bs-hint-fine', text: HINT_FINE }),
        h('span', { class: 'bs-hint-coarse', text: HINT_COARSE })));
  }

  // True (and remembered) when the value for `key` differs from last time.
  #changed(key, value) {
    if (this.cache.get(key) === value) return false;
    this.cache.set(key, value);
    return true;
  }

  setVisible(on) {
    if (this.#changed('visible', on)) this.el.hidden = !on;
  }

  setPlayer(i, name) {
    if (!this.#changed(`name${i}`, name)) return;
    setText(this.cards[i].name, name);
    this.#labelCard(i);
  }

  // Screen readers get "name: score of target"; the visible score and pips are aria-hidden.
  #labelCard(i) {
    const card = this.cards[i];
    const s = this.cache.get(`score${i}`) ?? 0;
    const t = this.cache.get(`pips${i}`) ?? 1;
    card.el.setAttribute('aria-label', `${card.name.textContent}: ${s} of ${t}`);
  }

  /** Scores plus pips for the target; a score that went up gets a little bump. */
  setScores(scores, target) {
    const t = Math.max(1, Math.round(Number(target) || 1));
    [0, 1].forEach((i) => {
      const card = this.cards[i];
      const s = Number(scores?.[i]) || 0;
      if (this.#changed(`pips${i}`, t)) {
        card.pips.replaceChildren(...Array.from({ length: Math.min(t, MAX_PIPS) }, () => h('span', { class: 'bs-pip' })));
        card.pips.hidden = t > MAX_PIPS;
        this.cache.delete(`score${i}`);
      }
      const prev = this.cache.get(`score${i}`);
      if (this.#changed(`score${i}`, s)) {
        setText(card.score, s);
        [...card.pips.children].forEach((pip, k) => pip.classList.toggle('bs-on', k < s));
        this.#labelCard(i);
        if (prev !== undefined && s > prev) bump(card.score);
      }
    });
  }

  setRound(round, target) {
    const key = `${round}|${target}`;
    if (!this.#changed('round', key)) return;
    this.roundEl.replaceChildren(`Round ${round}`, target ? h('small', { text: ` · first to ${target}` }) : null);
  }

  setWind(wind) {
    const info = windInfo(wind);
    if (!this.#changed('wind', `${info.abs}|${info.dir}`)) return;
    this.windArrow.style.setProperty('--len', info.fraction.toFixed(3));
    this.windArrow.style.setProperty('--dir', String(info.dir || 1));
    // Calm winds are cool cyan, gales turn orange-red.
    const hue = Math.round(190 - 175 * info.fraction);
    this.windArrow.style.setProperty('--wind-color', `hsl(${hue} 95% 66%)`);
    this.windEl.classList.toggle('bs-wind-none', info.abs === 0);
    setText(this.windLabel, info.label);
    this.windEl.setAttribute('aria-label', info.description);
  }

  pulseWind() {
    bump(this.windEl, 'bs-pulse');
  }

  /** Highlight the card of the player whose turn it is (-1 for none). */
  setActive(player) {
    if (!this.#changed('active', player)) return;
    this.cards.forEach((c, i) => c.el.classList.toggle('bs-active', i === player));
  }

  setBanner(text, color = '', thinking = false) {
    if (!this.#changed('banner', `${text}|${color}|${thinking}`)) return;
    setText(this.banner, text);
    this.banner.hidden = !text;
    if (color) this.banner.style.setProperty('--banner-color', color);
    this.banner.classList.toggle('bs-thinking', Boolean(thinking));
  }

  setAimVisible(on) {
    if (this.#changed('aimVisible', on)) this.aimPanel.hidden = !on;
  }

  /** Who is aiming (name, identity color) and what they threw last time. */
  setAimPlayer(name, color, last) {
    if (this.#changed('aimColor', color)) this.aimPanel.style.setProperty('--aim-color', color);
    if (this.#changed('aimWho', name)) setText(this.aimWho, `${name}, aim and throw!`);
    const lastText = last ? `Last throw: ${formatAim(last.angle)}° · power ${formatAim(last.power)}` : 'First throw: good luck!';
    if (this.#changed('aimLast', lastText)) setText(this.aimLast, lastText);
  }

  /** Mirror the game's aim into the boxes and sliders (a box being typed in is left alone). */
  syncAim(angle, power) {
    const a = Math.round(Number(angle) || 0);
    const p = Math.round(Number(power) || 0);
    syncValue(this.angleNum, a);
    syncValue(this.powerNum, p);
    syncValue(this.angleRange, a);
    syncValue(this.powerRange, p);
  }

  /**
   * Drag guide: a dashed line from the hand to the pointer and a chip with the numbers.
   * @param {null | { x0: number, y0: number, x1: number, y1: number, angle: number, power: number, color?: string }} g
   *   client-pixel coordinates; null hides it
   */
  showGuide(g) {
    if (!g) {
      if (!this.guide.hidden) this.guide.hidden = true;
      return;
    }
    this.guide.hidden = false;
    if (g.color) this.guide.style.setProperty('--guide-color', g.color);
    const len = Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
    const rot = Math.atan2(g.y1 - g.y0, g.x1 - g.x0);
    this.guideLine.style.width = `${len.toFixed(1)}px`;
    this.guideLine.style.transform = `translate(${g.x0.toFixed(1)}px, ${g.y0.toFixed(1)}px) rotate(${rot.toFixed(4)}rad)`;
    this.guideChip.style.left = `${g.x1.toFixed(1)}px`;
    this.guideChip.style.top = `${(g.y1 - 28).toFixed(1)}px`;
    setText(this.guideChip, `${g.angle}° · ${g.power}`);
  }
}

function playerCard(i) {
  const name = h('div', { class: 'bs-player-name' });
  const score = h('div', { class: 'bs-player-score', 'aria-hidden': 'true', text: '0' });
  const pips = h('div', { class: 'bs-pips', 'aria-hidden': 'true' });
  const el = h('div', { class: `bs-player bs-player-${i}`, role: 'group' }, score,
    h('div', { class: 'bs-player-text' }, name, pips));
  return { el, name, score, pips };
}

// Restart a one-shot CSS animation class.
function bump(node, cls = 'bs-bump') {
  node.classList.remove(cls);
  void node.offsetWidth; // force a reflow so the animation starts again
  node.classList.add(cls);
}
