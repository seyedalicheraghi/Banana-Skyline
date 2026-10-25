// Full-screen layers: title, match setup / settings, how to play, pause, match over.
import { choiceGroup, h, nextId, paintRange, switchToggle, syncValue } from './dom.js';
import {
  ASSIST_OPTIONS, CPU_OPTIONS, GRAVITY_MAX, GRAVITY_MIN, GRAVITY_OPTIONS, MODE_OPTIONS, NAME_MAX, TARGET_OPTIONS,
  THEME_OPTIONS, WIND_OPTIONS, cleanGravity, defaultForm,
} from './settings.js';

function button(label, extra, onClick, { autofocus = false } = {}) {
  return h('button', {
    type: 'button', class: `bs-btn ${extra}`.trim(), 'data-autofocus': autofocus, on: { click: onClick },
  }, label);
}

/** A full-screen layer holding one panel. Hidden until show(). */
class Layer {
  constructor(className, { dim = true, role = 'dialog', label = null, panelClass = 'bs-panel' } = {}) {
    this.headingId = nextId('heading');
    this.panel = h('section', {
      class: panelClass, role, tabindex: '-1',
      'aria-modal': role === 'dialog' ? 'true' : null,
      'aria-label': label,
      'aria-labelledby': label ? null : this.headingId,
    });
    this.el = h('div', { class: ['bs-layer', dim && 'bs-dim', className].filter(Boolean).join(' '), hidden: true }, this.panel);
  }

  heading(text, extra = '') {
    return h('h2', { id: this.headingId, class: `bs-panel-title ${extra}`.trim(), text });
  }

  /** Focus the element marked data-autofocus, else the panel itself (no on-screen keyboard pops up). */
  focus() {
    const target = this.el.querySelector('[data-autofocus]:not([hidden])') ?? this.panel;
    target?.focus?.({ preventScroll: true });
  }
}

export class TitleScreen extends Layer {
  /** @param {{ onVsCpu, onTwoPlayers, onVR, onSettings, onHowTo }} actions */
  constructor(actions) {
    super('bs-title-screen', { dim: false, role: 'region', label: 'Banana Skyline', panelClass: 'bs-title-wrap' });
    this.vrBtn = button('Play in VR', 'bs-btn-vr bs-btn-big', actions.onVR);
    this.vrBtn.hidden = true;
    const menu = h('nav', { class: 'bs-panel bs-menu', 'aria-label': 'Main menu' },
      button('1 Player vs CPU', 'bs-btn-primary bs-btn-big', actions.onVsCpu, { autofocus: true }),
      button('2 Players', 'bs-btn-big', actions.onTwoPlayers),
      this.vrBtn,
      h('div', { class: 'bs-menu-row' },
        button('Settings', '', actions.onSettings),
        button('How to play', '', actions.onHowTo)));
    this.panel.append(
      h('h1', { class: 'bs-title' }, h('span', { text: 'Banana' }), ' ', h('span', { text: 'Skyline' })),
      h('p', { class: 'bs-tagline', text: 'Mind the wind. Mind the buildings. Throw the banana.' }),
      menu,
      h('p', { class: 'bs-title-foot' }, 'Esc pauses · C follows the banana · M mutes'));
  }

  setVRSupported(on) {
    this.vrBtn.hidden = !on;
  }
}

/**
 * Match setup and settings in one panel. From the title it shows everything plus Start; from the pause
 * menu only the options (look, aim helper, sound) since match rules cannot change mid-match.
 */
export class SetupPanel extends Layer {
  /** @param {{ onStart: (form) => void, onBack: () => void, onPrefs: (patch: object) => void }} actions */
  constructor({ onStart, onBack, onPrefs }) {
    super('bs-setup-layer', { panelClass: 'bs-panel bs-setup' });
    this.form = defaultForm();
    this.context = 'title';

    this.headingEl = this.heading('New match');
    this.subEl = h('p', { class: 'bs-panel-sub' });

    // Match rules.
    this.mode = choiceGroup({ label: 'Players', options: MODE_OPTIONS, onChange: (v) => this.#patch({ mode: v }) });
    this.names = [0, 1].map((i) => this.#nameField(i));
    this.namesEl = h('div', { class: 'bs-names' }, this.names[0].el, this.names[1].el);
    this.cpu = choiceGroup({ label: 'CPU difficulty', options: CPU_OPTIONS, onChange: (v) => this.#patch({ cpu: v }) });
    this.points = choiceGroup({ label: 'Points to win', options: TARGET_OPTIONS, onChange: (v) => this.#patch({ targetScore: v }) });
    this.gravity = choiceGroup({ label: 'Gravity (m/s²)', options: GRAVITY_OPTIONS, className: 'bs-choice-gravity', onChange: (v) => this.#patch({ gravityPreset: v }) });
    this.customGravity = h('input', {
      id: nextId('gravity'), class: 'bs-num', type: 'number', min: GRAVITY_MIN, max: GRAVITY_MAX, step: 0.01,
      inputmode: 'decimal', autocomplete: 'off',
    });
    this.customGravity.addEventListener('input', () => {
      const g = cleanGravity(this.customGravity.value);
      if (g !== null) this.form.customGravity = g;
    });
    this.customGravity.addEventListener('change', () => { this.customGravity.value = String(this.form.customGravity); });
    this.customRow = h('div', { class: 'bs-custom-gravity' },
      h('label', { for: this.customGravity.id, class: 'bs-field-label', text: `Custom gravity (${GRAVITY_MIN}–${GRAVITY_MAX})` }),
      this.customGravity);
    this.wind = choiceGroup({ label: 'Wind', options: WIND_OPTIONS, onChange: (v) => this.#patch({ windStrength: v }) });
    this.matchSection = h('div', { class: 'bs-section' },
      h('h3', { class: 'bs-section-title', text: 'Match' }),
      this.mode.el, this.namesEl, this.cpu.el, this.points.el, this.gravity.el, this.customRow, this.wind.el);

    // Device options (saved in prefs, applied live).
    this.theme = choiceGroup({ label: 'Look', options: THEME_OPTIONS, onChange: (v) => onPrefs?.({ theme: v }) });
    this.assist = choiceGroup({ label: 'Aim helper', options: ASSIST_OPTIONS, onChange: (v) => onPrefs?.({ assist: v }) });
    this.sound = switchToggle({ label: 'Sound', onChange: (on) => onPrefs?.({ sound: on }) });
    this.volume = h('input', { class: 'bs-range', type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Volume' });
    this.volumeOut = h('output', { class: 'bs-volume-out' });
    this.volume.addEventListener('input', () => {
      paintRange(this.volume);
      this.volumeOut.textContent = `${this.volume.value}%`;
      onPrefs?.({ volume: Number(this.volume.value) / 100 });
    });
    const optionsSection = h('div', { class: 'bs-section' },
      h('h3', { class: 'bs-section-title', text: 'Options' }),
      this.theme.el, this.assist.el,
      h('div', { class: 'bs-sound-row' }, this.sound.el,
        h('div', { class: 'bs-volume' }, h('span', { class: 'bs-field-label', text: 'Volume' }), this.volume, this.volumeOut)));

    this.backBtn = button('Back', '', () => onBack?.());
    this.startBtn = button('Start!', 'bs-btn-primary bs-btn-start', () => onStart?.(this.form));
    this.panel.append(
      h('header', { class: 'bs-setup-head' }, this.headingEl, this.subEl),
      h('div', { class: 'bs-setup-body' }, this.matchSection, optionsSection),
      h('footer', { class: 'bs-setup-foot' }, this.backBtn, this.startBtn));
  }

  #nameField(i) {
    const input = h('input', {
      id: nextId('name'), class: 'bs-text', type: 'text', maxlength: NAME_MAX, autocomplete: 'off',
      spellcheck: 'false', placeholder: `Player ${i + 1}`,
    });
    input.addEventListener('input', () => { this.form.names[i] = input.value; });
    const text = h('span');
    const el = h('div', { class: 'bs-field' },
      h('label', { for: input.id, class: 'bs-field-label' }, h('span', { class: `bs-dot bs-dot-${i}`, 'aria-hidden': 'true' }), text),
      input);
    return { el, input, text };
  }

  /**
   * @param {{ context: 'title'|'pause', mode?: 'cpu'|'2p', heading?: string, form?: object, prefs?: object }} o
   *   `form` is kept by reference, so edits survive closing and reopening the panel.
   */
  open({ context = 'title', mode, heading, form, prefs } = {}) {
    this.context = context;
    if (form) this.form = form;
    if (mode) this.form.mode = mode;
    const inMatch = context === 'pause';
    this.matchSection.hidden = inMatch;
    this.startBtn.hidden = inMatch;
    this.startBtn.toggleAttribute('data-autofocus', !inMatch);
    this.backBtn.toggleAttribute('data-autofocus', inMatch);
    this.backBtn.textContent = inMatch ? 'Back to pause' : 'Back';
    this.headingEl.textContent = heading ?? (inMatch ? 'Settings' : 'New match');
    this.subEl.textContent = inMatch
      ? 'Changes apply right away.'
      : 'Pick your rules, then hit Start. Look and sound changes apply right away.';
    this.#render();
    if (prefs) this.setPrefs(prefs);
  }

  /** Reflect saved prefs in the option controls. */
  setPrefs(prefs) {
    if (!prefs) return;
    this.theme.set(prefs.theme);
    this.assist.set(prefs.assist);
    this.sound.set(prefs.sound);
    const vol = Math.round((Number(prefs.volume) || 0) * 100);
    syncValue(this.volume, vol);
    paintRange(this.volume);
    this.volumeOut.textContent = `${vol}%`;
    this.volume.disabled = !prefs.sound;
  }

  #patch(patch) {
    Object.assign(this.form, patch);
    this.#render();
  }

  #render() {
    const f = this.form;
    const vsCpu = f.mode !== '2p';
    this.mode.set(f.mode);
    this.names[0].text.textContent = vsCpu ? 'Your name' : 'Player 1';
    this.names[1].text.textContent = 'Player 2';
    this.names.forEach((n, i) => { if (n.input.value !== (f.names[i] ?? '')) n.input.value = f.names[i] ?? ''; });
    this.names[1].el.hidden = vsCpu;
    this.namesEl.classList.toggle('bs-single', vsCpu);
    this.cpu.el.hidden = !vsCpu;
    this.cpu.set(f.cpu);
    this.points.set(f.targetScore);
    this.gravity.set(f.gravityPreset);
    this.customRow.hidden = f.gravityPreset !== 'custom';
    this.customGravity.value = String(f.customGravity);
    this.wind.set(f.windStrength);
  }
}

export class HowToPanel extends Layer {
  /** @param {{ onBack: () => void }} actions */
  constructor({ onBack }) {
    super('bs-howto-layer', { panelClass: 'bs-panel bs-howto' });
    const k = (key) => h('kbd', { text: key });
    this.backBtn = button('Got it!', 'bs-btn-primary', () => onBack?.(), { autofocus: true });
    this.panel.append(
      this.heading('How to play'),
      h('p', { class: 'bs-panel-sub', text: 'Two monkeys, one windy city. Take turns throwing a banana at the other monkey!' }),
      h('ul', { class: 'bs-list' },
        h('li', null, h('b', { text: 'Angle' }), ' is how high you throw (0 is flat, 90 is straight up). ', h('b', { text: 'Power' }), ' is how hard.'),
        h('li', null, 'Watch the ', h('b', { text: 'wind arrow' }), ' at the top. Wind pushes the banana sideways: a longer arrow means stronger wind.'),
        h('li', null, 'Bananas blow holes in buildings. If a roof breaks, the monkey on it falls down!'),
        h('li', null, 'Hit the other monkey to win the round. Careful, you can hit yourself too.'),
        h('li', null, 'The first monkey to reach the winning score wins the match.')),
      h('h3', { text: 'On the computer' }),
      h('ul', { class: 'bs-list' },
        h('li', null, h('b', { text: 'Drag: ' }), 'press and pull away from your monkey. The direction is the angle, the distance is the power. Let go to throw. ', k('Esc'), ' or right-click cancels.'),
        h('li', null, h('b', { text: 'Keys: ' }), k('←'), ' ', k('→'), ' angle, ', k('↓'), ' ', k('↑'), ' power (hold ', k('Shift'), ' for big steps), ', k('Space'), ' or ', k('Enter'), ' throws.'),
        h('li', null, h('b', { text: 'Type it: ' }), 'enter the angle, press ', k('Enter'), ', enter the power, press ', k('Enter'), '. Just like the original!'),
        h('li', null, k('P'), ' or ', k('Esc'), ' pauses, ', k('C'), ' makes the camera follow the banana, ', k('M'), ' turns sound on or off.')),
      h('h3', { text: 'In VR (Meta Quest)' }),
      h('ul', { class: 'bs-list' },
        h('li', null, 'Hold the ', h('b', { text: 'trigger' }), ' to grab a banana, swing your arm and let go.'),
        h('li', null, 'Prefer buttons? Pick ', h('b', { text: 'stick mode' }), ': the thumbstick sets angle and power, then press A or X (or the trigger) to throw.'),
        h('li', null, 'Point at a menu and pull the trigger to press a button.')),
      h('div', { class: 'bs-panel-actions' }, this.backBtn));
  }
}

export class PauseMenu extends Layer {
  /** @param {{ onResume, onRestart, onSettings, onHowTo, onQuit }} actions */
  constructor(actions) {
    super('bs-pause-layer', { panelClass: 'bs-panel bs-pause' });
    this.panel.append(
      this.heading('Paused'),
      h('div', { class: 'bs-stack' },
        button('Resume', 'bs-btn-primary bs-btn-big', actions.onResume, { autofocus: true }),
        button('Restart match', '', actions.onRestart),
        button('Settings', '', actions.onSettings),
        button('How to play', '', actions.onHowTo),
        button('Quit to title', 'bs-btn-quiet', actions.onQuit)));
  }
}

export class MatchOverPanel extends Layer {
  /** @param {{ onRematch: () => void, onMenu: () => void }} actions */
  constructor({ onRematch, onMenu }) {
    super('bs-matchover-layer', { panelClass: 'bs-panel bs-matchover' });
    this.titleEl = this.heading('', 'bs-mo-title');
    this.scoreEl = h('div', { class: 'bs-mo-score' });
    this.subEl = h('p', { class: 'bs-panel-sub' });
    this.panel.append(
      h('div', { class: 'bs-mo-trophy', 'aria-hidden': 'true' }),
      this.titleEl, this.subEl, this.scoreEl,
      h('div', { class: 'bs-panel-actions' },
        button('Menu', '', () => onMenu?.()),
        button('Rematch', 'bs-btn-primary bs-btn-big', () => onRematch?.(), { autofocus: true })));
  }

  /**
   * @param {{ winner: number, names: string[], scores: number[], colors: string[], cpuWon?: boolean }} o
   */
  setResult({ winner, names, scores, colors, cpuWon = false }) {
    const w = winner === 1 ? 1 : 0;
    this.panel.style.setProperty('--winner', colors[w]);
    this.titleEl.textContent = `${names[w]} wins the match!`;
    this.subEl.textContent = cpuWon ? 'So close! Rematch to get even.' : 'What a throw. Want to go again?';
    const side = (i) => h('div', { class: `bs-mo-side bs-mo-side-${i}`, style: { '--pc': colors[i] } },
      h('span', { class: 'bs-mo-name', text: names[i] }), h('b', { text: String(scores[i] ?? 0) }));
    this.scoreEl.replaceChildren(side(0), h('span', { class: 'bs-mo-dash', text: '–' }), side(1));
    this.scoreEl.setAttribute('aria-label', `Final score: ${names[0]} ${scores[0]}, ${names[1]} ${scores[1]}`);
  }
}
