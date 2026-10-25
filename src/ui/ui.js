// DOM overlay for the PC: title and menus, the in-match HUD, and mouse/touch/keyboard/typed input.
// Contract: docs/DESIGN.md, section "UI". Nothing here runs at import time.
import { PLAYER_COLORS } from '../core/constants.js';
import { h, moveFocus } from './dom.js';
import { Hud } from './hud.js';
import { PointerAim, activatesNatively, isTextEntry, onUserGesture, usesArrows } from './input.js';
import { HowToPanel, MatchOverPanel, PauseMenu, SetupPanel, TitleScreen } from './menus.js';
import { DEFAULT_UI_PREFS, formFromSettings, formatAim, rematchSettings, settingsFromForm, windInfo } from './settings.js';
import { Toasts } from './toasts.js';

const OWN_GOAL_COLOR = '#ff8f8f';
const NEAR_MISS = 9; // world units from the opponent's middle that still earn a "So close!"
const MAX_LOGGED_ERRORS = 3;

/**
 * @typedef {object} UICallbacks
 * @property {(settings: object) => void} startMatch
 * @property {() => void} quitToTitle
 * @property {(paused: boolean) => void} setPaused
 * @property {() => (void|Promise<void>)} enterVR
 * @property {(prefs: object) => void} prefsChanged
 * @property {() => void} toggleFollow
 * @property {(x: number, y: number, z?: number) => {x: number, y: number}} worldToScreen
 * @property {(px: number, py: number) => {x: number, y: number}} screenToWorld
 * @property {() => void} unlockAudio
 */

export class UI {
  /**
   * @param {{ root: HTMLElement, canvas: HTMLCanvasElement, callbacks: UICallbacks }} options
   */
  constructor({ root, canvas, callbacks = {} } = {}) {
    this.root = root ?? document.body;
    this.canvas = canvas ?? null;
    this.callbacks = callbacks ?? {};
    this.game = null;
    this.prefs = { ...DEFAULT_UI_PREFS };
    this.form = formFromSettings(null);
    this.formSeeded = false;
    this.screen = null;     // 'title' | 'setup' | 'howto' | 'pause' | 'matchOver' | null (HUD only)
    this.returnTo = null;   // where setup / how-to go back to: 'title' | 'pause'
    this.paused = false;
    this.xrActive = false;
    this.lastThrow = [null, null];
    this.hitShown = null;   // 'direct' once this throw produced a direct hit (an own goal then stays quiet)
    this.errorsLogged = 0;
    this.disposers = [];

    this.hud = new Hud({
      onPause: () => this.#openPause(),
      onAim: (aim) => this.#typedAim(aim),
      onThrow: (typed) => this.#throw(typed),
    });
    this.toasts = new Toasts();
    this.layers = {
      title: new TitleScreen({
        onVsCpu: () => this.#openSetup('title', { mode: 'cpu', heading: '1 Player vs CPU' }),
        onTwoPlayers: () => this.#openSetup('title', { mode: '2p', heading: '2 Players' }),
        onVR: () => this.#enterVR(),
        onSettings: () => this.#openSetup('title', { heading: 'Settings' }),
        onHowTo: () => this.#openHowTo('title'),
      }),
      setup: new SetupPanel({
        onStart: (form) => this.#start(form),
        onBack: () => this.#back(),
        onPrefs: (patch) => this.#changePrefs(patch),
      }),
      howto: new HowToPanel({ onBack: () => this.#back() }),
      pause: new PauseMenu({
        onResume: () => this.#show(null),
        onRestart: () => this.#restart(),
        onSettings: () => this.#openSetup('pause'),
        onHowTo: () => this.#openHowTo('pause'),
        onQuit: () => this.#quit(),
      }),
      matchOver: new MatchOverPanel({
        onRematch: () => this.#restart(),
        onMenu: () => this.#quit(),
      }),
    };

    this.el = h('div', { class: 'bs-ui' }, this.hud.el, this.toasts.el, Object.values(this.layers).map((l) => l.el));
    this.el.style.setProperty('--bs-p0', PLAYER_COLORS[0]);
    this.el.style.setProperty('--bs-p1', PLAYER_COLORS[1]);
    // Quest Browser's 2D mode: backdrop blur over a live WebGL canvas is re-rendered every frame; use solid glass.
    if (/OculusBrowser|Quest/i.test(globalThis.navigator?.userAgent ?? '')) this.el.classList.add('bs-lite');
    this.root.append(this.el);

    this.pointer = new PointerAim({
      canvas: this.canvas,
      getGame: () => (this.#canAim() ? this.game : null),
      screenToWorld: (px, py) => this.#call('screenToWorld', px, py),
      worldToScreen: (x, y, z) => this.#call('worldToScreen', x, y, z),
      onGuide: (g) => this.hud.showGuide(g && { ...g, color: PLAYER_COLORS[g.turn] }),
      onPress: () => this.#blurOwnFocus(),
    });
    this.disposers.push(() => this.pointer.dispose());
    this.disposers.push(onUserGesture(() => this.#call('unlockAudio')));
    const onKey = (e) => this.#onKeyDown(e);
    window.addEventListener('keydown', onKey);
    this.disposers.push(() => window.removeEventListener('keydown', onKey));
  }

  // ---------------------------------------------------------------- public API

  /**
   * CSS pixels at the bottom of the screen the aim panel covers during a match with a human player
   * (0 otherwise). Kept steady between turns so the camera does not bob when the panel hides.
   */
  get bottomInset() {
    const g = this.game;
    if (!g || g.isDemo || this.xrActive || !g.monkeys?.some(m => !m.cpu)) return 0;
    const panel = this.hud?.aimPanel;
    if (panel && !panel.hidden) {
      const r = panel.getBoundingClientRect();
      if (r.height > 0) this.aimInset = Math.max(0, window.innerHeight - r.top) + 12;
    }
    return this.aimInset ?? 0;
  }

  /** True while a DOM menu (title, setup, how to play, pause, match over) is open and visible. */
  get menuOpen() {
    return !this.xrActive && this.screen !== null;
  }

  /** Use this game from now on. A real match closes the menus; a demo match brings back the title. */
  setGame(game) {
    const next = game ?? null;
    if (next === this.game) return;
    this.game = next;
    this.lastThrow = [null, null];
    this.hitShown = null;
    this.pointer.cancel(false);
    this.toasts.clear();
    if (next && !next.isDemo) {
      if (this.screen !== null) this.#show(null);
    } else if (next?.isDemo && this.screen === null) {
      this.#show('title');
    }
    this.refresh();
  }

  /** Game events (forwarded from game.onAny). Demo games are ignored. Never throws. */
  onEvent(type, payload = {}, game = this.game) {
    try {
      if (game && game !== this.game) this.setGame(game);
      const g = this.game;
      if (!g || g.isDemo) return;
      this.#handleEvent(type, payload ?? {}, g);
      this.refresh();
    } catch (err) {
      this.#logError(err);
    }
  }

  /** Per frame: toasts, drag validity, HUD state. Never throws. */
  update(dt, game) {
    try {
      if (game !== undefined && game !== this.game) this.setGame(game);
      if (this.game?.isDemo && this.screen === null) this.#show('title');
      this.toasts.update(dt);
      this.pointer.update();
      this.refresh();
    } catch (err) {
      this.#logError(err);
    }
  }

  /** Saved preferences (theme, sound, volume, assist, lastSettings, ...). */
  setPrefs(prefs) {
    this.prefs = { ...DEFAULT_UI_PREFS, ...(prefs ?? {}) };
    if (!this.formSeeded) {
      this.form = formFromSettings(this.prefs.lastSettings);
      this.formSeeded = true;
    }
    this.layers.setup.setPrefs(this.prefs);
  }

  /** Show the "Play in VR" button only when immersive VR is available. */
  setVRSupported(supported) {
    this.layers.title.setVRSupported(Boolean(supported));
  }

  /** Hide every DOM overlay while presenting in VR (VR has its own panels); restore afterwards. */
  setXRActive(active) {
    const on = Boolean(active);
    if (on === this.xrActive) return;
    this.xrActive = on;
    this.pointer.cancel();
    if (on) {
      this.#blurOwnFocus();
      // The session start already unpaused the game; leave the pause menu behind.
      if (this.paused || this.screen === 'pause') this.#show(this.game?.isDemo ? 'title' : null);
    }
    this.el.hidden = on;
    if (!on) {
      if (this.game?.isDemo && this.screen === null) this.#show('title');
      else if (this.screen !== null) this.layers[this.screen].focus();
    }
    this.refresh();
  }

  /** Show the title screen (over the demo match). Keeps a setup / how-to panel opened from it. */
  showTitle() {
    const titleChild = (this.screen === 'setup' || this.screen === 'howto') && this.returnTo === 'title';
    if (this.screen === 'title' || titleChild) return;
    this.#show('title');
  }

  /** Push the current game state into the HUD (cheap: only changed values touch the DOM). */
  refresh() {
    if (this.xrActive) return; // the overlay is hidden; setXRActive(false) refreshes on the way out
    const g = this.game;
    const live = Boolean(g && !g.isDemo && g.monkeys?.length >= 2);
    this.hud.setVisible(live);
    if (!live) {
      this.hud.setAimVisible(false);
      this.hud.showGuide(null);
      return;
    }
    const target = g.settings?.targetScore;
    g.monkeys.forEach((m, i) => this.hud.setPlayer(i, m.name ?? `Player ${i + 1}`));
    this.hud.setScores(g.scores, target);
    this.hud.setRound(g.round, target);
    this.hud.setWind(g.wind);
    const turn = g.turn === 1 ? 1 : 0;
    const cur = g.monkeys[turn];
    const playing = g.phase === 'aim' || g.phase === 'flight';
    this.hud.setActive(playing ? turn : -1);
    if (g.phase === 'aim' && cur && this.screen !== 'matchOver') {
      const text = cur.cpu ? `${cur.name} is thinking…` : /^you$/i.test(cur.name) ? 'Your turn' : `${cur.name}'s turn`;
      this.hud.setBanner(text, PLAYER_COLORS[turn], Boolean(cur.cpu));
    } else if (g.phase === 'flight' && this.lastThrow[turn]?.readout) {
      // Angle/power readout of the banana in the air (the only place a CPU's numbers show up).
      this.hud.setBanner(this.lastThrow[turn].readout, PLAYER_COLORS[turn]);
    } else {
      this.hud.setBanner('');
    }
    const canAim = this.#canAim();
    this.hud.setAimVisible(canAim);
    if (canAim) {
      const aim = g.aim?.[turn] ?? { angle: 45, power: 50 };
      this.hud.syncAim(aim.angle, aim.power);
      this.hud.setAimPlayer(cur.name, PLAYER_COLORS[turn], this.lastThrow[turn]);
    }
  }

  /** Remove listeners and DOM (not used by main.js, handy for tests and hot reloads). */
  dispose() {
    for (const off of this.disposers.splice(0)) off();
    this.el.remove();
  }

  // ---------------------------------------------------------------- game events

  #handleEvent(type, p, g) {
    switch (type) {
      case 'matchStart':
        this.lastThrow = [null, null];
        break;
      case 'roundStart': {
        const round = p.round ?? g.round;
        const target = g.settings?.targetScore;
        const sub = round === 1 && target
          ? `First to ${target} ${target === 1 ? 'point' : 'points'} wins`
          : windInfo(p.wind ?? g.wind).description;
        this.toasts.show(`Round ${round}`, { size: 'big', sub, duration: 2 });
        break;
      }
      case 'wind':
        this.toasts.show('The wind changed!', { size: 'small' });
        this.hud.pulseWind();
        break;
      case 'throw':
        if (p.player === 0 || p.player === 1) {
          const name = g.monkeys[p.player]?.name ?? `Player ${p.player + 1}`;
          const readout = `${name}: ${formatAim(p.angle)}° · power ${formatAim(p.power)}`;
          this.lastThrow[p.player] = { angle: p.angle, power: p.power, readout };
        }
        this.hitShown = null;
        this.pointer.cancel(false);
        break;
      case 'sunHit':
        this.toasts.show('The sun says ouch!', { size: 'small' });
        break;
      case 'impact':
        if (p.victim == null && p.kind !== 'monkey') this.#missToast(p, g);
        break;
      case 'monkeyHit':
        if (!p.selfHit) {
          this.hitShown = 'direct';
          this.toasts.show('Direct hit!', { size: 'big', color: PLAYER_COLORS[p.thrower] ?? '', duration: 1.6 });
        } else if (this.hitShown !== 'direct') {
          this.toasts.show('Ouch — own goal!', { size: 'big', color: OWN_GOAL_COLOR, duration: 1.6 });
        }
        break;
      case 'roundOver': {
        const w = p.winner === 1 ? 1 : 0;
        const scores = p.scores ?? g.scores;
        const name = g.monkeys[w]?.name ?? `Player ${w + 1}`;
        this.toasts.show(`${name} wins the round!`, {
          size: 'big', color: PLAYER_COLORS[w], sub: `${scores[0]} – ${scores[1]}`, duration: 3.4,
        });
        break;
      }
      case 'matchOver':
        this.#openMatchOver(p, g);
        break;
      default:
        break;
    }
  }

  #missToast(p, g) {
    if (p.kind === 'out') {
      this.toasts.show('Out of the city!', { size: 'small' });
      return;
    }
    const opponent = g.monkeys[1 - (p.thrower ?? g.turn)];
    if (!opponent?.alive || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (Math.hypot(p.x - opponent.x, p.y - (opponent.y + 2)) < NEAR_MISS) this.toasts.show('So close!', { size: 'small' });
  }

  #openMatchOver(p, g) {
    const winner = (p.winner ?? g.winner) === 1 ? 1 : 0;
    const names = g.monkeys.map((m, i) => m?.name ?? `Player ${i + 1}`);
    const loserHuman = !g.monkeys[1 - winner]?.cpu;
    this.toasts.clear();
    this.layers.matchOver.setResult({
      winner, names, scores: p.scores ?? g.scores, colors: PLAYER_COLORS, cpuWon: Boolean(g.monkeys[winner]?.cpu) && loserHuman,
    });
    this.#show('matchOver');
  }

  // ---------------------------------------------------------------- screens

  #show(screen) {
    const prev = this.screen;
    this.screen = screen;
    for (const [name, layer] of Object.entries(this.layers)) layer.el.hidden = name !== screen;
    // Menus are modal: keep Tab focus out of the HUD controls behind them.
    this.hud.el.inert = screen !== null;
    if (screen !== null) this.pointer.cancel();
    const pauseScreens = screen === 'pause' || ((screen === 'setup' || screen === 'howto') && this.returnTo === 'pause');
    this.#setPaused(pauseScreens && Boolean(this.game) && !this.game.isDemo);
    if (screen !== null && screen !== prev && !this.xrActive) this.layers[screen].focus();
    if (screen === null && prev !== null) this.#blurOwnFocus();
    this.refresh();
  }

  #setPaused(on) {
    if (on === this.paused) return;
    this.paused = on;
    this.#call('setPaused', on);
  }

  #openSetup(context, { mode, heading } = {}) {
    this.returnTo = context;
    this.layers.setup.open({ context, mode, heading, form: this.form, prefs: this.prefs });
    this.#show('setup');
  }

  #openHowTo(context) {
    this.returnTo = context;
    this.#show('howto');
  }

  #openPause() {
    if (this.screen === null && this.#inMatch()) this.#show('pause');
  }

  #back() {
    this.#show(this.returnTo === 'pause' && this.#inMatch() ? 'pause' : 'title');
  }

  #start(form) {
    this.form = form ?? this.form;
    this.#startWith(settingsFromForm(this.form));
  }

  #restart() {
    this.#startWith(rematchSettings(this.game?.settings));
  }

  // main.js saves these as prefs.lastSettings; mirror that so a later prefsChanged does not send stale ones.
  #startWith(settings) {
    this.prefs = { ...this.prefs, lastSettings: settings };
    this.#show(null);
    this.#call('startMatch', settings);
  }

  #quit() {
    this.#show(null);
    this.#call('quitToTitle');
    this.showTitle();
  }

  #enterVR() {
    this.#call('unlockAudio');
    let result;
    try {
      result = this.callbacks.enterVR?.();
    } catch (err) {
      this.#vrFailed(err);
      return;
    }
    Promise.resolve(result).catch((err) => this.#vrFailed(err));
  }

  #vrFailed(err) {
    console.warn('[ui] could not enter VR', err);
    this.toasts.show('VR did not start. Is the headset awake?', { size: 'small', duration: 3 });
  }

  // ---------------------------------------------------------------- input

  #inMatch() {
    const g = this.game;
    return Boolean(g && !g.isDemo && g.monkeys?.length >= 2 && g.phase !== 'matchOver');
  }

  #canAim() {
    const g = this.game;
    return Boolean(g && !g.isDemo && g.humanTurn && this.screen === null && !this.xrActive && g.monkeys?.length >= 2);
  }

  // Number boxes and sliders change one value; keep the other from the game's current aim.
  #typedAim({ angle, power }) {
    if (!this.#canAim()) return;
    const g = this.game;
    const cur = g.aim[g.turn];
    g.setAim(g.turn, angle ?? cur.angle, power ?? cur.power);
  }

  #throw(typed) {
    if (!this.#canAim() || this.pointer.dragging) return;
    const g = this.game;
    if (typed && (typed.angle !== null || typed.power !== null)) {
      const cur = g.aim[g.turn];
      g.setAim(g.turn, typed.angle ?? cur.angle, typed.power ?? cur.power);
    }
    g.throwShot(g.aim[g.turn]);
  }

  #toggleSound() {
    const on = !this.prefs.sound;
    this.#changePrefs({ sound: on });
    this.toasts.show(on ? 'Sound on' : 'Sound off', { size: 'small' });
  }

  #changePrefs(patch) {
    this.prefs = { ...this.prefs, ...patch };
    this.layers.setup.setPrefs(this.prefs);
    this.#call('prefsChanged', { ...this.prefs });
  }

  #onKeyDown(e) {
    try {
      if (this.xrActive || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key;
      const typing = isTextEntry(e.target);
      if (key === 'Escape') {
        e.preventDefault();
        if (this.pointer.dragging) this.pointer.cancel();
        else if (typing) e.target.blur();
        else this.#escape();
        return;
      }
      if (typing) return; // Enter in the aim boxes is handled by the boxes themselves
      const letter = key.length === 1 ? key.toLowerCase() : '';
      if (letter === 'm') {
        if (!e.repeat) this.#toggleSound();
        e.preventDefault();
        return;
      }
      if (this.screen !== null) {
        this.#menuKey(e, key, letter);
        return;
      }
      if (!this.#inMatch()) return;
      if (letter === 'p') {
        if (!e.repeat) this.#openPause();
        e.preventDefault();
        return;
      }
      if (letter === 'c') {
        if (!e.repeat) this.#call('toggleFollow');
        e.preventDefault();
        return;
      }
      this.#aimKey(e, key);
    } catch (err) {
      this.#logError(err);
    }
  }

  #menuKey(e, key, letter) {
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (usesArrows(e.target)) return; // radio groups and sliders move their own value
      if (moveFocus(this.layers[this.screen].el, key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
    } else if (letter === 'p' && this.screen === 'pause' && !e.repeat) {
      e.preventDefault();
      this.#show(null);
    }
  }

  // ←/→ angle -/+, ↓/↑ power -/+ (Shift = 5), Space/Enter throws (docs/DESIGN.md). Same keys for both players.
  #aimKey(e, key) {
    if (!this.#canAim() || this.pointer.dragging) return;
    const g = this.game;
    const { angle, power } = g.aim[g.turn];
    const step = e.shiftKey ? 5 : 1;
    const arrow = key.startsWith('Arrow');
    if (arrow && usesArrows(e.target)) return; // a focused slider moves itself (and updates the aim)
    let a = angle;
    let p = power;
    switch (key) {
      case 'ArrowRight': a += step; break;
      case 'ArrowLeft': a -= step; break;
      case 'ArrowUp': p += step; break;
      case 'ArrowDown': p -= step; break;
      case ' ':
      case 'Spacebar':
      case 'Enter':
        if (activatesNatively(e.target)) return; // the focused button handles it (THROW, pause)
        e.preventDefault();
        if (!e.repeat) g.throwShot(g.aim[g.turn]);
        return;
      default:
        return;
    }
    e.preventDefault();
    g.setAim(g.turn, Math.round(a), Math.round(p));
  }

  #escape() {
    switch (this.screen) {
      case 'setup':
      case 'howto':
        this.#back();
        break;
      case 'pause':
        this.#show(null);
        break;
      case null:
        this.#openPause();
        break;
      default:
        break; // title and match over have no "back"
    }
  }

  // ---------------------------------------------------------------- helpers

  #blurOwnFocus() {
    const active = this.el.ownerDocument?.activeElement;
    if (active && active !== this.el.ownerDocument.body && this.el.contains(active)) active.blur?.();
  }

  // Optional callback; geometry callbacks run inside pointer handlers, so their errors become null.
  #call(name, ...args) {
    const fn = this.callbacks?.[name];
    if (typeof fn !== 'function') return null;
    if (name === 'worldToScreen' || name === 'screenToWorld' || name === 'unlockAudio' || name === 'setPaused') {
      try {
        return fn(...args);
      } catch (err) {
        this.#logError(err);
        return null;
      }
    }
    return fn(...args);
  }

  // A few errors are enough to debug; a per-frame failure must not flood the console.
  #logError(err) {
    if (this.errorsLogged >= MAX_LOGGED_ERRORS) return;
    this.errorsLogged += 1;
    console.error('[ui]', err);
  }
}
