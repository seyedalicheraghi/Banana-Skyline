// Controllers: one XRHand per WebXR controller slot, with a cartoon monkey glove on the grip space,
// button edge detection and haptics. No downloaded controller models.

import * as THREE from 'three';

/** xr-standard gamepad mapping on Quest Touch controllers. */
export const BUTTON = { trigger: 0, squeeze: 1, stick: 3, a: 4, b: 5 };

/** Rising-edge detection for gamepad buttons. */
export class ButtonEdges {
  constructor() {
    this.prev = [];
    this.pressed = [];
  }

  /**
   * @param {ArrayLike<{pressed:boolean}>|null|undefined} buttons
   * @returns {number[]} indices that went down since the last call (reused: valid until the next call)
   */
  update(buttons) {
    const pressed = this.pressed;
    pressed.length = 0;
    const n = buttons?.length ?? 0;
    for (let i = 0; i < n; i++) {
      const down = Boolean(buttons[i]?.pressed);
      if (down && !this.prev[i]) pressed.push(i);
      this.prev[i] = down;
    }
    this.prev.length = n;
    return pressed;
  }

  reset() {
    this.prev.length = 0;
  }
}

// Glove layout in WebXR grip space (right hand): origin inside the fist, -Z along the held rod toward the
// thumb, +X out of the back of the hand, +Y back along the forearm. The left glove is mirrored in x.
// If the glove looks rotated on the headset, adjust GLOVE_ROTATION.
export const GLOVE_ROTATION = new THREE.Euler(0, 0, 0);

const FUR = 0x6e4426;
const SKIN = 0xd9a877;
/**
 * The HUD is drawn without depth test in the transparent pass, which would paint it over opaque gloves. The
 * gloves are therefore "transparent" at opacity 1 (looks identical) and sorted after the HUD (910) and menu
 * (920); they still write depth, so the wrist panel (renderOrder 970) is correctly hidden behind them.
 */
export const GLOVE_RENDER_ORDER = 960;
let sharedGeometry = null;

function gloveGeometry() {
  if (!sharedGeometry) {
    sharedGeometry = {
      ball: new THREE.SphereGeometry(1, 16, 12),
      finger: new THREE.CapsuleGeometry(0.0105, 0.022, 4, 8).translate(0, -0.022, 0), // pivot at the base, extends -Y
      tip: new THREE.CapsuleGeometry(0.0095, 0.016, 4, 8).translate(0, -0.017, 0),
      thumb: new THREE.CapsuleGeometry(0.011, 0.026, 4, 8).rotateX(Math.PI / 2).translate(0, 0, -0.022), // extends -Z
      cuff: new THREE.CylinderGeometry(0.036, 0.04, 0.03, 16, 1, true),
    };
  }
  return sharedGeometry;
}

/** Cartoon monkey glove: furry back of the hand, three fingers and a thumb that curl with the trigger/grip. */
export class Glove {
  constructor() {
    const g = gloveGeometry();
    // Lambert keeps it cheap on Quest; a little emissive so it stays visible in the night theme.
    this.furMat = new THREE.MeshLambertMaterial({ color: FUR, emissive: 0x24140a, transparent: true });
    this.skinMat = new THREE.MeshLambertMaterial({ color: SKIN, emissive: 0x3a2614, transparent: true });

    this.group = new THREE.Group();
    this.group.name = 'glove';
    this.inner = new THREE.Group();
    this.inner.rotation.copy(GLOVE_ROTATION);
    this.group.add(this.inner);

    const back = new THREE.Mesh(g.ball, this.furMat);
    back.scale.set(0.02, 0.046, 0.044);
    back.position.set(0.026, 0.034, 0);
    const palm = new THREE.Mesh(g.ball, this.skinMat);
    palm.scale.set(0.012, 0.04, 0.038);
    palm.position.set(0.012, 0.036, 0);
    const cuff = new THREE.Mesh(g.cuff, this.furMat);
    cuff.scale.set(0.75, 1, 1);
    cuff.position.set(0.02, 0.085, 0);
    this.inner.add(back, palm, cuff);

    this.fingers = [];
    for (const z of [-0.022, 0, 0.022]) {
      const base = new THREE.Group();
      base.position.set(0.024, -0.008, z);
      const prox = new THREE.Mesh(g.finger, this.skinMat);
      const mid = new THREE.Group();
      mid.position.set(0, -0.044, 0);
      const tip = new THREE.Mesh(g.tip, this.skinMat);
      mid.add(tip);
      base.add(prox, mid);
      this.inner.add(base);
      this.fingers.push({ base, mid });
    }
    this.thumb = new THREE.Group();
    this.thumb.position.set(0.016, 0.012, -0.034);
    this.thumb.add(new THREE.Mesh(g.thumb, this.skinMat));
    this.inner.add(this.thumb);
    this.group.traverse((o) => {
      if (o.isMesh) o.renderOrder = GLOVE_RENDER_ORDER;
    });

    this.curl = 0.2;
    this.applyCurl();
  }

  /** Mirror the glove for the left hand. */
  setHandedness(handedness) {
    this.group.scale.x = handedness === 'left' ? -1 : 1;
  }

  /** Ease the fingers toward `target` curl (0 open .. 1 fist). */
  update(dt, target) {
    const t = Math.max(0, Math.min(1, Number(target) || 0));
    this.curl = THREE.MathUtils.damp(this.curl, t, 18, Math.max(0, dt || 0));
    this.applyCurl();
  }

  applyCurl() {
    const c = this.curl;
    // Rotating about +Z by a negative angle swings the fingers from pointing forward (-Y) to wrapping toward the palm (-X).
    for (const f of this.fingers) {
      f.base.rotation.z = -c * 1.35;
      f.mid.rotation.z = -c * 1.5;
    }
    this.thumb.rotation.y = -0.25 + c * 1.1;
  }

  dispose() {
    this.furMat.dispose();
    this.skinMat.dispose();
    this.group.removeFromParent();
  }
}

/**
 * One WebXR controller slot: target-ray space (pointing), grip space (holding), its input source and glove.
 * Callbacks: onPress(hand, kind), onRelease(hand, kind) with kind 'select' | 'squeeze' | 'disconnect'.
 */
export class XRHand {
  constructor(renderer, index, { onPress = () => {}, onRelease = () => {} } = {}) {
    this.index = index;
    this.controller = renderer.xr.getController(index);
    this.grip = renderer.xr.getControllerGrip(index);
    this.inputSource = null;
    this.handedness = 'none';
    this.selecting = false;
    this.squeezing = false;
    this.edges = new ButtonEdges();
    this.glove = new Glove();
    this.grip.add(this.glove.group);

    const safe = (fn) => (event) => {
      try {
        fn(event);
      } catch (err) {
        console.error('[xr] controller event failed', err);
      }
    };
    this.listeners = {
      connected: safe((e) => {
        const src = e.data;
        if (!src || (src.targetRayMode && src.targetRayMode !== 'tracked-pointer')) return;
        this.inputSource = src;
        this.handedness = src.handedness || 'none';
        this.glove.setHandedness(this.handedness);
        this.edges.reset();
      }),
      disconnected: safe((e) => {
        if (e?.data && this.inputSource && e.data !== this.inputSource) return; // a source we never adopted
        const wasPressing = this.pressing;
        this.inputSource = null;
        this.selecting = false;
        this.squeezing = false;
        this.edges.reset();
        if (wasPressing) onRelease(this, 'disconnect');
      }),
      selectstart: safe(() => {
        if (!this.inputSource) return;
        this.selecting = true;
        onPress(this, 'select');
      }),
      selectend: safe(() => {
        if (!this.selecting) return;
        this.selecting = false;
        onRelease(this, 'select');
      }),
      squeezestart: safe(() => {
        if (!this.inputSource) return;
        this.squeezing = true;
        onPress(this, 'squeeze');
      }),
      squeezeend: safe(() => {
        if (!this.squeezing) return;
        this.squeezing = false;
        onRelease(this, 'squeeze');
      }),
    };
    for (const [type, fn] of Object.entries(this.listeners)) this.controller.addEventListener(type, fn);
  }

  get connected() {
    return this.inputSource !== null;
  }

  /** Grip pose known this frame (the glove is visible). */
  get tracked() {
    return this.connected && this.grip.visible;
  }

  /** Target-ray pose known this frame. */
  get pointing() {
    return this.connected && this.controller.visible;
  }

  get gamepad() {
    return this.inputSource?.gamepad ?? null;
  }

  get pressing() {
    return this.selecting || this.squeezing;
  }

  get isTrackedHand() {
    return Boolean(this.inputSource?.hand);
  }

  /** Thumbstick deflection: axes 2/3 on Quest (xr-standard), falling back to 0/1. */
  thumbstick() {
    const axes = this.gamepad?.axes;
    if (!axes || axes.length < 2) return { x: 0, y: 0 };
    const i = axes.length >= 4 ? 2 : 0;
    return { x: Number(axes[i]) || 0, y: Number(axes[i + 1]) || 0 };
  }

  /** Buttons pressed since the last poll (call once per frame). */
  pollButtons() {
    return this.edges.update(this.gamepad?.buttons);
  }

  /** Haptic pulse; silently does nothing where unsupported. */
  pulse(intensity = 0.5, ms = 40) {
    const gp = this.gamepad;
    if (!gp) return;
    const value = Math.max(0, Math.min(1, intensity));
    try {
      const actuator = gp.hapticActuators?.[0];
      const p = actuator?.pulse
        ? actuator.pulse(value, ms)
        : gp.vibrationActuator?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: value, weakMagnitude: value });
      p?.catch?.(() => {});
    } catch {
      // Haptics are a nicety.
    }
  }

  /** Per frame: curl the glove with the analog trigger/grip, or into a fist while holding the banana. */
  update(dt, holding = false) {
    const b = this.gamepad?.buttons;
    const trigger = Number(b?.[BUTTON.trigger]?.value) || (this.selecting ? 1 : 0);
    const squeeze = Number(b?.[BUTTON.squeeze]?.value) || (this.squeezing ? 1 : 0);
    const target = holding ? 1 : Math.max(0.2, Math.min(1, trigger * 0.55 + squeeze * 0.9));
    this.glove.update(dt, target);
  }

  dispose() {
    for (const [type, fn] of Object.entries(this.listeners)) this.controller.removeEventListener(type, fn);
    this.glove.dispose();
  }
}
