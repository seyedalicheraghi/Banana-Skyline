// XRMode: Banana Skyline in immersive VR (Meta Quest Browser) through three.js WebXR.
// Owns the rig (camera + controllers), gloves, hand/stick throwing, the VR panels and fades.
// Contract: docs/DESIGN.md, "XRMode".

import * as THREE from 'three';
import { PLAYER_COLORS, VR_SCALE } from '../core/constants.js';
import { BUTTON, XRHand } from './hands.js';
import { MenuPanel } from './menu.js';
import { HudPanel, WristPanel } from './panels.js';
import { Laser } from './pointer.js';
import { AimArrow, HandBanana } from './props.js';
import { Fader, overviewTarget, placeRig, roofTarget, roofYaw } from './rig.js';
import {
  RUMBLE_DISTANCE, hudState, impactDistance, playerName, rigSpot, winnerPhrase, wristState,
} from './state.js';
import { DROP_SPEED, THROW_BOOST, THROW_BOOSTS, ThrowTracker, stickAim } from './throw.js';

export { DROP_SPEED, THROW_BOOST } from './throw.js';

// 'layers' as in three's VRButton: r186 renders through an XRProjectionLayer whenever the browser has one.
const SESSION_INIT = { optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking', 'layers'] };
const MESSAGE_SECONDS = 2.6;
const BIG_DROP = 1.2;          // scene meters: falls longer than this fade instead of sliding
const FALL_FADE_MAX = 2.5;     // seconds to stay black waiting for monkeyLand
const HEAD_WAIT_FRAMES = 12;   // frames to wait (black) for the first head pose before placing the rig
const FOLLOW_RATE = 10;        // rig follows small monkey drops with this damping rate
const MENU_DISTANCE = 1.6;
const DEFAULT_EYE = 1.6;
const HUD_OFFSET = new THREE.Vector3(-1.3, 2.75, -3.0); // rig-local: ahead, up and a bit left
// Wrist panel on the back of the off-hand wrist, in WebXR grip space (see hands.js for the axes).
// Far enough out (x) and up the forearm (y) to clear the glove's back and cuff.
const WRIST_OFFSET = { x: 0.06, y: 0.13, z: 0 };

const nowSec = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000;
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _target = new THREE.Vector3();
const _toWorld = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _n3 = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const _ay = new THREE.Vector3();
const _az = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class XRMode {
  /**
   * @param {object} deps
   * @param {THREE.WebGLRenderer} deps.renderer renderer with xr.enabled
   * @param {THREE.Scene} deps.scene
   * @param {THREE.Group} deps.world group holding the game (scaled by the view in VR)
   * @param {object} [deps.view] GameView: setXRScale, setLocalPlayer, monkeyAnchor, createBananaMesh
   * @param {object} [deps.sfx] Sfx: play('click'|'hover'|'error')
   * @param {() => object} [deps.getPrefs]
   * @param {(prefs: object) => void} [deps.setPrefs]
   * @param {(settings: object) => void} [deps.startMatch]
   * @param {() => void} [deps.quitToTitle]
   * @param {(active: boolean) => void} [deps.onSessionChange]
   * @param {?(paused: boolean) => void} [deps.setPaused] optional: pause the match while the VR menu is open
   */
  constructor({
    renderer, scene, world, view = null, sfx = null, getPrefs = () => ({}), setPrefs = () => {},
    startMatch = () => {}, quitToTitle = () => {}, onSessionChange = () => {}, setPaused = null,
  } = {}) {
    this.logged = new Set();
    this.renderer = renderer;
    this.scene = scene;
    this.world = world;
    this.view = view;
    this.sfx = sfx;
    this.deps = { getPrefs, setPrefs, startMatch, quitToTitle, onSessionChange, setPaused };

    /** Rig group: everything that moves with you (camera, controllers, menu, HUD). */
    this.rig = new THREE.Group();
    this.rig.name = 'xr-rig';
    scene?.add(this.rig);
    /** Camera to render with while presenting (three drives it from the headset pose). */
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 2000);
    this.camera.name = 'xr-camera';
    this.rig.add(this.camera);
    this.fader = new Fader(this.camera);

    /** Measured hand speed -> launch speed multiplier; tweak live from the console if needed. */
    this.throwBoost = THROW_BOOST;
    this.session = null;
    this.entering = false;
    /** Rig height added when the runtime only grants a 'local' (head-height) reference space. */
    this.floorOffset = 0;
    this.turnCue = false;
    this.game = null;
    this.serial = 0;
    this.prefs = this.#safe(() => getPrefs()) ?? {};
    this.time = 0;
    this.framesInSession = 0;

    this.localPlayer = null;
    this.hotSeat = false;
    this.spotKey = null;
    this.pendingKey = null;
    this.fall = null;
    this.menuOpen = false;
    this.menuBlind = false;
    this.pausedByMenu = false;
    this.message = null;
    this.lastThrow = [null, null];
    this.held = null;
    this.tracker = new ThrowTracker();
    this.dominant = 'right';
    this.pointerHand = null;
    this.hover = null;

    // Controllers must exist before a session starts: three only binds input sources to known slots.
    this.hands = renderer?.xr
      ? [0, 1].map((i) => new XRHand(renderer, i, {
        onPress: (hand, kind) => this.#onPress(hand, kind),
        onRelease: (hand, kind) => this.#onRelease(hand, kind),
      }))
      : [];
    for (const h of this.hands) this.rig.add(h.controller, h.grip);

    this.built = false; // panels/props need a canvas: built on the first session
  }

  /** @returns {Promise<boolean>} whether immersive-vr sessions are supported */
  static async isSupported() {
    try {
      const xr = globalThis.navigator?.xr;
      if (!xr?.isSessionSupported) return false;
      return Boolean(await xr.isSessionSupported('immersive-vr'));
    } catch {
      return false;
    }
  }

  /** True while presenting in VR. */
  get active() {
    return this.session !== null;
  }

  /** Current throw mode from prefs. */
  get mode() {
    if (this.prefs?.vrThrow !== 'stick') return 'hand';
    const hands = this.hands?.filter(h => h.connected) ?? [];
    return hands.length && hands.every(h => h.isTrackedHand) ? 'hand' : 'stick';
  }

  /**
   * Start an immersive-vr session (call from a user gesture). Never throws.
   * @returns {Promise<boolean>} true when presenting
   */
  async enter() {
    if (this.session || this.entering) return this.session !== null;
    const xr = globalThis.navigator?.xr;
    if (!xr?.requestSession || !this.renderer?.xr) {
      console.warn('[xr] WebXR is not available in this browser');
      return false;
    }
    this.entering = true;
    let session = null;
    try {
      // requestSession must be the first await so it still counts as part of the user gesture.
      session = await xr.requestSession('immersive-vr', SESSION_INIT);
      // local-floor is optional in SESSION_INIT; requesting it when not granted would fail setSession.
      const features = session.enabledFeatures;
      const floor = typeof features?.includes !== 'function' || features.includes('local-floor');
      this.floorOffset = floor ? 0 : DEFAULT_EYE;
      this.renderer.xr.setReferenceSpaceType(floor ? 'local-floor' : 'local');
      await this.renderer.xr.setSession(session);
      if (this.renderer.xr.getSession?.() !== session) throw new Error('the session ended while starting');
      // Added after three's own 'end' handler, so ours runs once the renderer has been restored.
      this.onSessionEnd = () => this.#sessionEnded(session);
      session.addEventListener('end', this.onSessionEnd);
      this.#sessionStarted(session);
      return true;
    } catch (err) {
      console.error('[xr] could not enter VR', err);
      if (session && this.session !== session) {
        try {
          await session.end();
        } catch {
          // already ended
        }
      }
      return false;
    } finally {
      this.entering = false;
    }
  }

  /** End the VR session (if any). */
  exit() {
    try {
      this.session?.end()?.catch?.(() => {});
    } catch (err) {
      console.warn('[xr] could not end the session', err);
    }
  }

  /** Remember the game to show; called before game.start(). */
  setGame(game) {
    if (game === this.game) return;
    this.game = game ?? null;
    this.serial += 1;
    this.held = null;
    this.tracker.reset();
    this.fall = null;
    this.message = null;
    this.lastThrow = [null, null];
    this.menuOpen = !game || Boolean(game.isDemo);
    if (this.menuOpen && this.active) this.#placeMenu();
  }

  /** Apply preferences (vrThrow: 'hand' | 'stick'). */
  setPrefs(prefs) {
    if (!prefs || typeof prefs !== 'object') return;
    const before = this.mode;
    this.prefs = prefs;
    this.throwBoost = THROW_BOOSTS[prefs.vrBoost] ?? THROW_BOOST;
    if (this.mode !== before) {
      this.held = null;
      this.tracker.reset();
    }
  }

  /** Game events (forwarded by main for every event). Never throws. */
  onEvent(type, payload, game) {
    try {
      this.#onEvent(type, payload ?? {}, game ?? this.game);
    } catch (err) {
      this.#logOnce(`event:${type}`, err);
    }
  }

  /** Per frame while presenting: input, held banana, laser, panels, fades. Never throws. */
  update(dt, frame, game) {
    if (!this.session) return;
    try {
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.1)) : 0;
      this.#update(step, frame, game ?? this.game);
    } catch (err) {
      this.#logOnce('update', err);
    }
  }

  /** Remove everything this module added to the scene. */
  dispose() {
    this.exit();
    for (const h of this.hands) h.dispose();
    this.fader.dispose();
    if (this.built) {
      for (const p of [this.menu, this.hud, this.wrist]) p.dispose();
      this.laser.dispose();
      this.arrow.dispose();
      this.banana.dispose();
    }
    this.rig.removeFromParent();
  }

  // --- session -----------------------------------------------------------------------------------

  #build() {
    if (this.built) return;
    this.menu = new MenuPanel();
    this.hud = new HudPanel();
    this.wrist = new WristPanel();
    this.rig.add(this.menu.mesh, this.hud.mesh);
    this.laser = new Laser();
    this.arrow = new AimArrow();
    this.scene?.add(this.arrow.group);
    this.banana = new HandBanana(() => this.view?.createBananaMesh?.());
    this.built = true;
  }

  #sessionStarted(session) {
    this.session = session;
    this.#build();
    this.framesInSession = 0;
    this.camera.position.set(0, 0, 0);
    this.camera.quaternion.identity();
    this.spotKey = null;
    this.pendingKey = null;
    this.fall = null;
    this.held = null;
    this.hover = null;
    this.message = null; // this.time only runs in VR: a message from PC play would linger
    this.fader.holdBlack();
    this.#setWorldScale(VR_SCALE);
    if (!this.game || this.game.isDemo) this.menuOpen = true;
    if (this.menuOpen) this.#placeMenu();
    this.#safe(() => this.deps.onSessionChange(true));
  }

  #sessionEnded(session) {
    if (this.session !== session) return;
    session.removeEventListener('end', this.onSessionEnd);
    this.session = null;
    this.held = null;
    this.tracker.reset();
    this.fader.reset();
    this.spotKey = null;
    this.pendingKey = null;
    this.fall = null;
    this.localPlayer = null;
    this.hover = null;
    if (this.built) {
      this.menu.visible = false;
      this.hud.visible = false;
      this.wrist.visible = false;
      this.laser.hide();
      this.arrow.hide();
      this.banana.hide();
    }
    this.camera.position.set(0, 0, 0);
    if (this.pausedByMenu) {
      this.pausedByMenu = false;
      if (this.deps.setPaused) this.#safe(() => this.deps.setPaused(false));
    }
    this.turnCue = false;
    this.#setWorldScale(1);
    this.#safe(() => this.view?.setLocalPlayer?.(null));
    this.#safe(() => this.deps.onSessionChange(false));
  }

  /** view.setXRScale per the contract; without a view, scale the world group directly. */
  #setWorldScale(s) {
    const view = this.view;
    if (typeof view?.setXRScale === 'function') this.#safe(() => view.setXRScale(s));
    else this.world?.scale?.setScalar?.(s);
  }

  // --- events ------------------------------------------------------------------------------------

  #onEvent(type, p, game) {
    if (game && game !== this.game) this.setGame(game);
    game = this.game;
    if (!game) return;
    const real = !game.isDemo;
    switch (type) {
      case 'roundStart':
        this.lastThrow = [null, null];
        this.message = null;
        this.held = null;
        this.fall = null;
        break;
      case 'turn':
        this.held = null;
        this.tracker.reset();
        // Pulsed in #update once you can act: in hot seat the rig only reaches the new player after a fade.
        this.turnCue = real && this.active && !p.cpu;
        break;
      case 'throw':
        if (p.player === 0 || p.player === 1) this.lastThrow[p.player] = { angle: p.angle, power: p.power };
        if (p.player === this.localPlayer) {
          this.held = null;
          this.banana?.hide();
        }
        break;
      case 'impact':
        if (real && this.active && this.localPlayer != null) {
          const d = impactDistance(game, this.localPlayer, p.x, p.y);
          if (d < RUMBLE_DISTANCE) this.#rumble(0.35 + 0.65 * (1 - d / RUMBLE_DISTANCE), p.kind === 'monkey' ? 260 : 140);
        }
        break;
      case 'monkeyHit':
        if (real) this.#say(p.selfHit ? 'Ouch, own goal!' : 'Direct hit!', p.selfHit ? '#ff9a7a' : '#ffe066');
        if (real && this.active && p.victim === this.localPlayer) this.#rumble(1, 320);
        break;
      case 'monkeyFall':
        if (this.active && p.player === this.localPlayer) this.#startFall(p);
        break;
      case 'monkeyLand':
        if (this.fall && p.player === this.fall.player) this.fall.landed = true;
        break;
      case 'roundOver':
        if (real && (p.winner === 0 || p.winner === 1)) {
          const you = p.winner === this.localPlayer && !this.hotSeat;
          this.#say(`${winnerPhrase(playerName(game, p.winner), you)} the round!`, PLAYER_COLORS[p.winner]);
        }
        break;
      case 'matchOver':
        if (real) {
          this.message = null;
          this.menuOpen = false;
        }
        break;
      default:
        break;
    }
  }

  #say(text, color) {
    this.message = { text, color, until: this.time + MESSAGE_SECONDS };
  }

  #startFall(p) {
    const drop = (Number(p.fromY) - Number(p.toY)) * this.#worldScale();
    if (!(drop > BIG_DROP)) return; // small drops: the per-frame follow slides you down
    if (this.pendingKey || this.fader.action) return; // a rig move is already on its way
    this.fall = { player: p.player, landed: false, until: this.time + FALL_FADE_MAX };
    this.fader.transition(
      () => this.#snapToMonkey(),
      () => this.fall && !this.fall.landed && this.time < this.fall.until,
    );
  }

  #snapToMonkey() {
    this.fall = null;
    if (this.localPlayer == null || !this.game?.monkeys?.[this.localPlayer]) return;
    this.rig.position.y = this.#anchor(this.localPlayer, _anchor).y + this.floorOffset;
  }

  // --- frame -------------------------------------------------------------------------------------

  #update(dt, frame, game) {
    if (game && game !== this.game) this.setGame(game);
    game = this.game;
    this.time += dt;
    this.framesInSession += 1;
    if (this.scene && this.rig.parent !== this.scene) this.scene.add(this.rig);
    if (this.scene && this.arrow.group.parent !== this.scene) this.scene.add(this.arrow.group);

    this.world?.updateWorldMatrix?.(true, false); // world -> scene conversions below need the current scale
    this.fader.update(dt);
    this.#updatePlacement(game, dt);
    this.rig.updateMatrixWorld(true);
    if (this.message && this.time > this.message.until) this.message = null;
    if (this.menuBlind && this.#headKnown()) this.#placeMenu();

    const mode = this.mode;
    for (const h of this.hands) h.update(dt, this.held?.hand === h);
    this.#pollButtons(game, mode);
    game = this.game; // a menu button may have started a new match just now
    this.#updateTurnCue(game);
    this.#updateBanana(game, mode, dt);
    this.#updateStick(game, mode, dt);
    this.#updatePanels(game, mode);
    this.#syncPause(game);
  }

  #updateTurnCue(game) {
    if (!this.turnCue) return;
    if (!game || game.phase !== 'aim') this.turnCue = false;
    else if (this.#canAct(game)) {
      this.turnCue = false;
      this.#dominantHand()?.pulse(0.25, 30);
    }
  }

  /** With the optional setPaused hook, a real match waits while the menu is open. */
  #syncPause(game) {
    const pause = Boolean(game) && !game.isDemo && this.menuOpen && game.phase !== 'matchOver';
    if (pause === this.pausedByMenu) return;
    this.pausedByMenu = pause;
    if (this.deps.setPaused) this.#safe(() => this.deps.setPaused(pause));
  }

  #updatePlacement(game, dt) {
    const spot = rigSpot(game, this.serial);
    this.hotSeat = spot.hotSeat;
    if (spot.key !== this.spotKey && spot.key !== this.pendingKey) {
      const first = this.spotKey === null;
      if (first && !this.#headKnown() && this.framesInSession < HEAD_WAIT_FRAMES) return; // stay black
      // Only a hot-seat handover within the same round fades out first; anything else (new game, new
      // city, first placement) cuts to black at once, so you never see yourself inside the new skyline.
      const prefix = `roof:${this.serial}:${game?.round}:`;
      const handover = !first && spot.hotSeat && this.spotKey.startsWith(prefix) && spot.key.startsWith(prefix);
      this.pendingKey = spot.key;
      const apply = () => {
        this.pendingKey = null;
        this.#applySpot(rigSpot(this.game, this.serial));
      };
      if (handover) this.fader.transition(apply);
      else this.fader.cut(apply);
      return;
    }
    // Stand with your monkey when its roof crumbles (small drops; big ones fade, see #startFall).
    const m = this.localPlayer != null ? game?.monkeys?.[this.localPlayer] : null;
    if (m && !this.fall && !this.pendingKey && !this.fader.busy) {
      const y = this.#anchor(this.localPlayer, _anchor).y + this.floorOffset;
      if (Number.isFinite(y)) this.rig.position.y = THREE.MathUtils.damp(this.rig.position.y, y, FOLLOW_RATE, dt);
    }
  }

  #applySpot(spot) {
    const game = this.game;
    const head = this.#headKnown() ? this.camera.position : null;
    const m = spot.kind === 'roof' ? game?.monkeys?.[spot.player] : null;
    if (m) {
      const anchor = this.#anchor(spot.player, _anchor);
      roofTarget(anchor, m.facing, _target).y += this.floorOffset;
      placeRig(this.rig, _target, roofYaw(m.facing), head);
      this.localPlayer = spot.player;
    } else {
      overviewTarget(this.#worldScale(), _target).y += this.floorOffset;
      placeRig(this.rig, _target, 0, head);
      this.localPlayer = null;
    }
    this.spotKey = spot.key;
    this.fall = null;
    this.held = null;
    this.#safe(() => this.view?.setLocalPlayer?.(this.localPlayer));
    this.#placeHud();
    if (this.menuOpen) this.#placeMenu();
  }

  /** Feet of a monkey in scene coordinates (view.monkeyAnchor, else computed from the world group). */
  #anchor(i, target) {
    const viaView = this.#safe(() => this.view?.monkeyAnchor?.(i, target));
    if (viaView && Number.isFinite(viaView.x) && Number.isFinite(viaView.y) && Number.isFinite(viaView.z)) {
      return target.copy(viaView);
    }
    const m = this.game?.monkeys?.[i];
    target.set(m?.x ?? 0, m?.y ?? 0, 0);
    if (this.world) return this.world.localToWorld(target);
    return target.multiplyScalar(VR_SCALE);
  }

  #worldScale() {
    const s = this.world?.scale?.x;
    return s > 0 ? s : VR_SCALE;
  }

  #headKnown() {
    return this.camera.position.lengthSq() > 1e-6;
  }

  /** Rig-local eye height when the head pose is not known yet (0 in a 'local' space: the head is the origin). */
  #defaultEye() {
    return DEFAULT_EYE - this.floorOffset;
  }

  #eyeHeight() {
    return this.#headKnown() ? this.camera.position.y : this.#defaultEye();
  }

  /** HUD ahead, up and left of the head (rig-local; the rig faces the opponent). */
  #placeHud() {
    if (!this.built) return;
    const mesh = this.hud.mesh;
    const known = this.#headKnown();
    const hx = known ? this.camera.position.x : 0;
    const hz = known ? this.camera.position.z : 0;
    const eye = this.#eyeHeight();
    mesh.position.set(hx + HUD_OFFSET.x, eye + (HUD_OFFSET.y - DEFAULT_EYE), hz + HUD_OFFSET.z);
    _p.set(hx, eye, hz);
    _m.lookAt(_p, mesh.position, UP); // +z of the panel toward the head
    mesh.quaternion.setFromRotationMatrix(_m);
  }

  /** Menu in front of where you are looking (yaw only), slightly below eye level. */
  #placeMenu() {
    if (!this.built) return;
    const mesh = this.menu.mesh;
    const known = this.#headKnown();
    let yaw = 0;
    if (known) {
      _v.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
      if (_v.x * _v.x + _v.z * _v.z > 1e-4) yaw = Math.atan2(-_v.x, -_v.z);
    }
    const head = known ? this.camera.position : _p.set(0, this.#defaultEye(), 0);
    mesh.position.set(head.x - Math.sin(yaw) * MENU_DISTANCE, head.y - 0.25, head.z - Math.cos(yaw) * MENU_DISTANCE);
    mesh.rotation.set(-0.12, yaw, 0, 'YXZ');
    this.menuBlind = !known;
  }

  // --- input -------------------------------------------------------------------------------------

  /** Connected hand matching `dominant`, else the first non-left one, else any (no per-frame arrays). */
  #dominantHand() {
    let notLeft = null;
    let any = null;
    for (const h of this.hands) {
      if (!h.connected) continue;
      if (h.handedness === this.dominant) return h;
      if (!notLeft && h.handedness !== 'left') notLeft = h;
      if (!any) any = h;
    }
    return notLeft ?? any;
  }

  #offHand() {
    const main = this.#dominantHand();
    for (const h of this.hands) if (h.connected && h !== main) return h;
    return null;
  }

  /** The hand whose laser is shown: the last one that clicked, else the dominant one, else any. */
  #pointingHand() {
    if (this.pointerHand?.pointing) return this.pointerHand;
    const main = this.#dominantHand();
    if (main?.pointing) return main;
    for (const h of this.hands) if (h.pointing) return h;
    return null;
  }

  #rumble(intensity, ms) {
    for (const h of this.hands) h.pulse(intensity, ms);
  }

  /** Local human may act now (aim, grab, throw). */
  #canAct(game) {
    return Boolean(game) && !game.isDemo && game.humanTurn && game.turn === this.localPlayer
      && !this.menuOpen && !this.fader.busy && this.pendingKey === null;
  }

  #pollButtons(game, mode) {
    for (const h of this.hands) {
      if (!h.connected) continue;
      for (const b of h.pollButtons()) {
        if (b === BUTTON.b) this.#toggleMenu();
        else if (b === BUTTON.a) this.#pressA(h, game, mode);
      }
    }
  }

  #pressA(hand, game, mode) {
    if (this.hover?.button) {
      this.#activate(this.hover.button, hand);
    } else if (game && !game.isDemo && game.phase === 'matchOver') {
      this.#activate('rematch', hand);
    } else if (mode === 'stick' && this.#canAct(game)) {
      this.#stickThrow(game, hand);
    }
  }

  #toggleMenu() {
    this.menuOpen = !this.menuOpen;
    this.held = null;
    this.tracker.reset();
    if (this.menuOpen) this.#placeMenu();
    this.#safe(() => this.sfx?.play?.('click'));
  }

  #onPress(hand, kind) {
    if (!this.session) return;
    const game = this.game;
    if (kind === 'select') {
      this.pointerHand = hand;
      if (this.#laserWanted()) {
        hand.controller.updateWorldMatrix(true, false);
        const hit = this.laser.cast(hand.controller, this.#panels());
        if (hit?.button) {
          this.#activate(hit.button.id, hand);
          return;
        }
        if (hit && this.#laserAlways()) return; // a click on a menu never grabs the banana
      }
    }
    if (this.menuOpen) return;
    const mode = this.mode;
    if (mode === 'stick') {
      if (kind === 'select' && this.#canAct(game)) this.#stickThrow(game, hand);
      return;
    }
    if (this.held || !this.#canAct(game) || !hand.tracked) return;
    // Whichever hand grabs first becomes the throwing hand from now on.
    this.dominant = hand.handedness === 'left' ? 'left' : 'right';
    this.held = { hand };
    this.tracker.reset();
    this.#sample(hand);
    this.banana.hold(hand.grip);
    hand.pulse(0.45, 35);
  }

  #onRelease(hand, kind) {
    if (!this.held || this.held.hand !== hand) return;
    if (kind === 'disconnect') {
      this.held = null;
      this.tracker.reset();
      return;
    }
    if (hand.pressing) return; // still holding with the other button
    this.#release(hand);
  }

  #release(hand) {
    const game = this.game;
    if (hand.grip.visible) this.#sample(hand);
    const last = this.tracker.last;
    const est = this.tracker.estimate(nowSec());
    this.held = null;
    this.tracker.reset();
    if (!est || !last || est.speed < DROP_SPEED || !this.#canAct(game) || this.mode !== 'hand') {
      hand.pulse(0.15, 20); // dropped: the banana floats back above the hand
      return;
    }
    const ok = game.throwVelocity(est.vx * this.throwBoost, est.vy * this.throwBoost, { x: last.x, y: last.y });
    if (ok) {
      this.banana.hide();
      hand.pulse(0.8, 60);
    }
  }

  /** Record the holding grip in play-plane (world) units: rig-local pose -> scene -> world group. */
  #sample(hand) {
    const grip = hand.grip;
    this.rig.updateWorldMatrix(true, false);
    if (this.world) {
      this.world.updateWorldMatrix(true, false);
      _toWorld.copy(this.world.matrixWorld).invert().multiply(this.rig.matrixWorld);
    } else {
      _toWorld.copy(this.rig.matrixWorld).premultiply(_m.makeScale(1 / VR_SCALE, 1 / VR_SCALE, 1 / VR_SCALE));
    }
    _p.setFromMatrixPosition(grip.matrix).applyMatrix4(_toWorld);
    let vx = null;
    let vy = null;
    if (grip.hasLinearVelocity && grip.linearVelocity) {
      _v.copy(grip.linearVelocity).applyMatrix3(_n3.setFromMatrix4(_toWorld));
      vx = _v.x;
      vy = _v.y;
    }
    this.tracker.add(nowSec(), _p.x, _p.y, vx, vy);
  }

  #stickThrow(game, hand) {
    const aim = game.aim?.[game.turn];
    if (aim && game.throwShot({ angle: aim.angle, power: aim.power })) hand?.pulse(0.7, 50);
  }

  // --- banana, stick, panels ---------------------------------------------------------------------

  #updateBanana(game, mode, dt) {
    const banana = this.banana;
    if (mode !== 'hand' || !this.#canAct(game)) {
      if (this.held) {
        this.held = null;
        this.tracker.reset();
      }
      banana.hide();
      return;
    }
    if (this.held) {
      const h = this.held.hand;
      if (!h.connected) {
        this.held = null;
        this.tracker.reset();
      } else {
        banana.setWorldScale(this.#worldScale());
        banana.hold(h.grip);
        if (h.grip.visible) this.#sample(h);
        return;
      }
    }
    const hand = this.#dominantHand();
    if (!hand?.tracked) {
      banana.hide();
      return;
    }
    banana.setWorldScale(this.#worldScale());
    banana.float(this.rig, hand.grip.position, dt);
  }

  #updateStick(game, mode, dt) {
    if (mode !== 'stick' || !this.#canAct(game)) {
      this.arrow.hide();
      return;
    }
    const turn = game.turn;
    let best = null;
    let mag = 0;
    for (const h of this.hands) {
      if (!h.connected) continue;
      const s = h.thumbstick();
      const len = Math.hypot(s.x, s.y);
      if (len > mag) {
        mag = len;
        best = s;
      }
    }
    const aim = game.aim[turn];
    if (best) {
      const next = stickAim(aim, best.x, best.y, dt);
      if (next.changed) game.setAim(turn, next.angle, next.power);
    }
    // The view hides its own arrow for the monkey you stand in, so draw one from its hand.
    const hand = game.handPosition(turn);
    _p.set(hand.x, hand.y, 0);
    if (this.world) this.world.localToWorld(_p);
    else _p.multiplyScalar(VR_SCALE);
    const cur = game.aim[turn];
    this.arrow.show(_p, cur.angle, cur.power, game.monkeys[turn]?.facing ?? 1, this.#worldScale(), PLAYER_COLORS[turn]);
  }

  #panels() {
    return this.built ? [this.menu, this.hud] : [];
  }

  #laserWanted() {
    return this.built && (this.menu.interactive || this.hud.interactive);
  }

  // Menu open or match over: the panels are the point, so the laser always shows.
  // Mid-match the HUD only has its small Menu button, so the laser appears only while aiming at it.
  #laserAlways() {
    return this.menu.interactive || this.game?.phase === 'matchOver';
  }

  #updatePanels(game, mode) {
    const real = Boolean(game) && !game.isDemo;
    this.menu.visible = this.menuOpen;
    this.hud.visible = real && !this.menuOpen && (game.round ?? 0) > 0;

    // Laser + hover first (uses the buttons drawn last frame), then redraw what changed.
    this.rig.updateMatrixWorld(true); // panels may have just been moved
    this.#updateLaser();
    const hoverOn = (panel) => (this.hover?.panel === panel ? this.hover.button : null);
    if (this.menu.visible) this.menu.draw({ mode, inMatch: real, boost: this.prefs?.vrBoost ?? 'normal' }, hoverOn(this.menu));
    if (this.hud.visible) {
      this.hud.draw(hudState(game, {
        local: this.localPlayer, hotSeat: this.hotSeat, mode, lastThrow: this.lastThrow, message: this.message,
      }), hoverOn(this.hud));
    }

    const off = this.#offHand();
    const showWrist = real && this.localPlayer != null && Boolean(off?.tracked);
    this.wrist.visible = showWrist;
    if (showWrist) {
      this.#attachWrist(off);
      this.wrist.draw(wristState(game, { local: this.localPlayer, lastThrow: this.lastThrow }));
    }
  }

  #updateLaser() {
    if (!this.#laserWanted()) {
      this.laser.hide();
      this.#setHover(null);
      return;
    }
    const hand = this.#pointingHand();
    if (!hand) {
      this.laser.hide();
      this.#setHover(null);
      return;
    }
    const hit = this.laser.cast(hand.controller, this.#panels());
    if (this.#laserAlways() || hit?.button) this.laser.show(hand.controller, hit);
    else this.laser.hide();
    this.#setHover(hit?.button ? { panel: hit.panel, button: hit.button.id, hand } : null);
  }

  #setHover(next) {
    const same = (this.hover?.panel ?? null) === (next?.panel ?? null) && (this.hover?.button ?? null) === (next?.button ?? null);
    this.hover = next;
    if (!same && next) {
      next.hand?.pulse(0.1, 12);
      this.#safe(() => this.sfx?.play?.('hover'));
    }
  }

  /** Watch face on the back of the off-hand wrist; built from axes so the text is never mirrored. */
  #attachWrist(hand) {
    const mesh = this.wrist.mesh;
    if (mesh.parent !== hand.grip || mesh.userData.handedness !== hand.handedness) {
      hand.grip.add(mesh);
      mesh.userData.handedness = hand.handedness;
      const left = hand.handedness === 'left';
      // Grip axes: +X back of the right hand (-X for the left), +Y toward the elbow, -Z toward the thumb.
      _az.set(left ? -1 : 1, 0, 0);       // panel normal: out of the back of the hand
      _ay.set(0, 0, 1);                   // panel up: away from the thumb ("12 o'clock")
      _ax.crossVectors(_ay, _az);         // panel right: along the forearm
      _m.makeBasis(_ax, _ay, _az);
      mesh.quaternion.copy(_q.setFromRotationMatrix(_m));
      mesh.position.set((left ? -1 : 1) * WRIST_OFFSET.x, WRIST_OFFSET.y, WRIST_OFFSET.z);
    }
  }

  #activate(id, hand) {
    hand?.pulse(0.3, 25);
    this.#safe(() => this.sfx?.play?.('click'));
    const prefs = this.#prefs();
    const targetScore = prefs?.lastSettings?.targetScore ?? 3;
    switch (id) {
      case 'cpu-easy':
      case 'cpu-normal':
      case 'cpu-hard':
        this.menuOpen = false;
        this.#safe(() => this.deps.startMatch({
          players: [{ name: 'You', cpu: null }, { name: 'CPU', cpu: id.slice(4) }],
          targetScore,
          windStrength: 'normal',
        }));
        break;
      case 'two-players':
        this.menuOpen = false;
        this.#safe(() => this.deps.startMatch({
          players: [{ name: 'Player 1', cpu: null }, { name: 'Player 2', cpu: null }],
          targetScore,
          windStrength: 'normal',
        }));
        break;
      case 'boost-low':
      case 'boost-normal':
      case 'boost-high': {
        const next = { ...prefs, vrBoost: id.slice('boost-'.length) };
        this.setPrefs(next);
        this.#safe(() => this.deps.setPrefs(next));
        break;
      }
      case 'throw-hand':
      case 'throw-stick': {
        const next = { ...prefs, vrThrow: id === 'throw-stick' ? 'stick' : 'hand' };
        this.setPrefs(next);
        this.#safe(() => this.deps.setPrefs(next));
        break;
      }
      case 'resume':
        this.menuOpen = false;
        break;
      case 'quit':
        this.menuOpen = false;
        this.#safe(() => this.deps.quitToTitle());
        break;
      case 'exit':
        this.exit();
        break;
      case 'rematch':
        this.#rematch();
        break;
      case 'menu':
        this.menuOpen = true;
        this.#placeMenu();
        break;
      default:
        break;
    }
  }

  #rematch() {
    const s = this.game?.settings;
    if (!s || this.game.isDemo) return;
    this.menuOpen = false;
    this.#safe(() => this.deps.startMatch({ ...s, players: s.players.map((p) => ({ ...p })), seed: null }));
  }

  /** Latest prefs from main (they hold lastSettings), else the last ones passed to setPrefs. */
  #prefs() {
    const fresh = this.#safe(() => this.deps.getPrefs());
    return fresh && typeof fresh === 'object' ? fresh : this.prefs ?? {};
  }

  // --- helpers -----------------------------------------------------------------------------------

  /** Run a call into another module; log (once per message) instead of throwing. */
  #safe(fn) {
    try {
      return fn();
    } catch (err) {
      this.#logOnce(String(err?.message ?? err), err);
      return undefined;
    }
  }

  #logOnce(key, err) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.error(`[xr] ${key}`, err);
  }
}
