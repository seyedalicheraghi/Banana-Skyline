// Rover Cockpit: see what the FrodoBots EarthRover's camera sees, at the camera's true field of view, and
// drive it with the two Touch controllers. The page goes into VR by itself, so the browser never shows (the
// Quest app, and Quest Browser when the launch counts as a user action); otherwise one tap on Start does it.
// Video and driving go through the PC: server.mjs forwards /rover-api/* to the Earth Rovers SDK.
import * as THREE from 'three';
import { MjpegParser } from './mjpeg.js';
import { CommandLink, Edges, SEND_MS, SPEED_STEPS, StickClicks, commandFrom, readPad } from './drive.js';
import { DEG, PICTURE_DISTANCE, VIEW_MODES, cameraFov, cameraLens, desktopFov, domeDrop, domeMesh, forwardOf, pictureSize, yawOf } from './view.js';
import { apiBase, logEndpoint } from './api.js';

const params = new URLSearchParams(location.search);

// ?emulate: a fake Quest 3 (Meta's iwer, a dev dependency) to try the VR view and controls without a headset.
if (params.has('emulate')) {
  const { XRDevice, metaQuest3 } = await import('../node_modules/iwer/build/iwer.module.js');
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  window.xrDevice = device;
}

const API = apiBase(location);
const LOG = logEndpoint(location);
const SAME_ORIGIN = API.startsWith('/');
// The Quest app loads this page from GitHub Pages and talks to http://localhost:8080 (adb reverse). Chromium
// treats that as a public site reaching into the device (Local Network Access): it needs a one-time
// 'loopback-network' permission. Declaring the target lets the browser apply it.
const LOCAL = SAME_ORIGIN ? {} : { targetAddressSpace: 'loopback' };
const IN_APP = matchMedia('(display-mode: standalone)').matches || document.referrer.startsWith('android-app://');

/** 'granted', 'prompt', 'denied', or 'unknown' (this browser has no such permission: requests just go). */
const access = { state: SAME_ORIGIN ? 'granted' : 'unknown' };
if (!SAME_ORIGIN) {
  navigator.permissions?.query({ name: 'loopback-network' }).then((p) => {
    access.state = p.state;
    p.onchange = () => { access.state = p.state; };
  }, () => { /* not a known permission here */ });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const other = view => (view === 'front' ? 'rear' : 'front');
const title = s => s[0].toUpperCase() + s.slice(1);

/** One line in the terminal of the PC's server ([headset] ...): there is no dev console in the headset. */
function report(msg, data) {
  fetch(LOG, { method: 'POST', body: JSON.stringify([{ msg, data }]), headers: { 'content-type': 'text/plain' }, keepalive: true }).catch(() => {});
}
addEventListener('error', e => report('rover-error', { message: e.message, at: `${e.filename}:${e.lineno}` }));
addEventListener('unhandledrejection', e => report('rover-unhandled', { reason: String(e.reason?.stack ?? e.reason).slice(0, 500) }));

// ---------------------------------------------------------------------------------------------- video

const STALL_MS = 6000; // no bytes for this long: the stream is dead even if it was never closed
const LIVE_MS = 2500; // a picture older than this is not live: the rover stops

/** One camera stream, kept as a texture that always holds the newest frame. */
class Feed {
  constructor(view, fps) {
    this.view = view;
    this.fps = fps;
    this.texture = null;
    this.state = 'connecting'; // connecting | live | offline | denied (token refused) | none (no such camera)
    this.frameAt = 0;
    this.count = 0;
    this.rate = 0;
    this.pending = null;
    this.decoding = false;
    this.run();
    setInterval(() => { this.rate = this.count; this.count = 0; }, 1000);
  }

  get live() {
    return !!this.texture && performance.now() - this.frameAt < LIVE_MS;
  }

  /** Width / height of the picture (16:9 until the first frame says otherwise). */
  get aspect() {
    const img = this.texture?.image;
    return img?.width && img?.height ? img.width / img.height : 16 / 9;
  }

  async run() {
    for (;;) {
      let wait = 1500;
      const abort = new AbortController();
      let heard = performance.now();
      const watchdog = setInterval(() => { if (performance.now() - heard > STALL_MS) abort.abort(); }, 1000);
      try {
        const res = await fetch(`${API}/feed?view=${this.view}&fps=${this.fps}`, { cache: 'no-store', signal: abort.signal, ...LOCAL });
        heard = performance.now();
        if (res.status === 404) {
          this.state = 'none';
          wait = 10000;
        } else if (res.status === 401 || res.status === 403) {
          this.state = 'denied';
          wait = 5000;
        } else if (!res.ok) {
          this.state = this.texture ? 'offline' : 'connecting';
        } else {
          const parser = new MjpegParser();
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            heard = performance.now();
            for (const part of parser.push(value)) this.offer(part);
          }
          this.state = 'offline';
        }
      } catch {
        this.state = this.texture ? 'offline' : 'connecting';
      } finally {
        clearInterval(watchdog);
        abort.abort();
      }
      await sleep(wait);
    }
  }

  // Frames that arrive while one is being decoded replace each other: always the newest, never a queue.
  offer(part) {
    this.pending = part;
    if (!this.decoding) this.decode();
  }

  async decode() {
    this.decoding = true;
    while (this.pending) {
      const part = this.pending;
      this.pending = null;
      try {
        this.show(await createImageBitmap(new Blob([part.data], { type: part.type })));
      } catch { /* a damaged frame: wait for the next */ }
    }
    this.decoding = false;
  }

  show(bitmap) {
    const old = this.texture?.image;
    if (!old || old.width !== bitmap.width || old.height !== bitmap.height) {
      this.texture?.dispose();
      this.texture = new THREE.Texture(bitmap);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.generateMipmaps = false;
      this.texture.minFilter = THREE.LinearFilter;
      this.texture.anisotropy = MAX_ANISOTROPY;
      this.texture.flipY = false; // bitmaps upload top row first; the picture's UVs are flipped instead
    } else {
      this.texture.image = bitmap;
    }
    old?.close?.();
    this.texture.needsUpdate = true;
    if (this.state !== 'live') report('rover-feed', { view: this.view, w: bitmap.width, h: bitmap.height });
    this.state = 'live';
    this.frameAt = performance.now();
    this.count++;
  }
}

// ---------------------------------------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local'); // origin at the eyes when VR starts; always available
renderer.xr.setFoveation(0); // the picture fills the view: keep its edges as sharp as its middle
document.getElementById('app').append(renderer.domElement);
const MAX_ANISOTROPY = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.02, 100);

/** A unit plane facing +Z whose UVs read a top-row-first bitmap upright; `mirrored` flips it left-right. */
function pictureGeometry(mirrored) {
  const geo = new THREE.PlaneGeometry(1, 1);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setY(i, 1 - uv.getY(i));
    if (mirrored) uv.setX(i, 1 - uv.getX(i));
  }
  return geo;
}
const PLAIN = pictureGeometry(false);
const MIRRORED = pictureGeometry(true);
const blank = () => new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });

/** A plane showing a 2D canvas; draw() repaints it. */
function board(width, height, pxPerMetre, { onTop = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * pxPerMetre);
  canvas.height = Math.round(height * pxPerMetre);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = MAX_ANISOTROPY;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: !onTop });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  if (onTop) mesh.renderOrder = 10;
  const ctx = canvas.getContext('2d');
  let key = null;
  return {
    mesh,
    /** Repaint with paint(ctx, w, h) unless `newKey` is what was painted last. */
    draw(newKey, paint) {
      if (newKey === key) return;
      key = newKey;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paint(ctx, canvas.width, canvas.height);
      texture.needsUpdate = true;
    },
  };
}

/** Set the largest font up to `size` px at which `text` fits in `maxWidth`. */
function fitFont(ctx, text, maxWidth, size, weight = 400) {
  let px = size;
  ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  while (px > 12 && ctx.measureText(text).width > maxWidth) {
    px -= 1;
    ctx.font = `${weight} ${px}px system-ui, sans-serif`;
  }
}

function panel(ctx, w, h, radius = 28) {
  ctx.fillStyle = 'rgba(6, 10, 20, .74)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, w, h, radius);
  else ctx.rect(0, 0, w, h);
  ctx.fill();
}

// Everything you look at hangs off `anchor`, placed at your eyes and turned to your heading when VR starts
// (and when you recentre).
const anchor = new THREE.Group();
scene.add(anchor);

// The camera picture at the camera's true field of view: in VR a piece of sphere (the lens is a fisheye),
// on a flat screen the picture as it is.
const dome = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false, side: THREE.DoubleSide }));
anchor.add(dome);
const domeBezel = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x0c111c, side: THREE.DoubleSide }));
anchor.add(domeBezel);
const domeShapes = new Map();
/** The dome geometry for a field of view and picture shape (made once per shape). */
function domeGeometry(hfov, aspect, radius) {
  const key = `${hfov.toFixed(2)}|${aspect.toFixed(4)}|${radius}`;
  if (!domeShapes.has(key)) {
    const m = domeMesh(hfov, aspect, radius);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(m.uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
    domeShapes.set(key, geo);
  }
  return domeShapes.get(key);
}
const picture = new THREE.Mesh(PLAIN, blank());
picture.position.z = -PICTURE_DISTANCE;
anchor.add(picture);
const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)), new THREE.LineBasicMaterial({ color: 0x1b2436 }));
picture.add(outline);
const bezel = new THREE.Mesh(new THREE.PlaneGeometry(1.025, 1.045), new THREE.MeshBasicMaterial({ color: 0x0c111c }));
bezel.position.z = -0.02;
picture.add(bezel);
const floor = new THREE.GridHelper(60, 120, 0x18213a, 0x0d1322); // only in the framed view: a still reference
floor.position.y = -1.3;
anchor.add(floor);

// The other camera as a rear-view mirror above the middle, nearer than the picture.
const MIRROR = { distance: 1.6, elevation: 21 * DEG, width: 2 * 1.6 * Math.tan(12.5 * DEG) };
const mirrorRig = new THREE.Group();
mirrorRig.position.set(0, Math.sin(MIRROR.elevation) * MIRROR.distance, -Math.cos(MIRROR.elevation) * MIRROR.distance);
mirrorRig.rotation.x = MIRROR.elevation; // faces the eyes
anchor.add(mirrorRig);
const mirror = new THREE.Mesh(MIRRORED, blank());
mirrorRig.add(mirror);
const mirrorBezel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0x0c111c }));
mirrorBezel.position.z = -0.005;
mirrorRig.add(mirrorBezel);
const mirrorTag = board(0.16, 0.04, 1600);
mirrorRig.add(mirrorTag.mesh);

// Messages: a note that follows your gaze lazily, below the middle of the view.
const toast = board(1.0, 0.22, 900, { onTop: true });
scene.add(toast.mesh);

// Status above the left controller, controls above the right one: there when you look at your hands.
const status = board(0.18, 0.115, 3600);
const help = board(0.18, 0.115, 3600);
for (const b of [status, help]) {
  b.mesh.position.set(0, 0.085, -0.01);
  b.mesh.rotation.x = -0.75; // tilted back toward the eyes
}
const handProxy = () => {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.07, 4, 10), new THREE.MeshBasicMaterial({ color: 0x2a3550 }));
  mesh.rotation.x = Math.PI / 2;
  return mesh;
};
for (const i of [0, 1]) {
  const grip = renderer.xr.getControllerGrip(i);
  scene.add(grip);
  grip.addEventListener('connected', (e) => {
    grip.clear();
    grip.add(handProxy());
    if (e.data?.handedness === 'left') grip.add(status.mesh);
    if (e.data?.handedness === 'right') grip.add(help.mesh);
  });
  grip.addEventListener('disconnected', () => grip.clear());
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (!renderer.xr.isPresenting) renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------------------------- rover

const feeds = { front: new Feed('front', 20), rear: new Feed('rear', 10) }; // the rover sends 20 fps
// Which way +angular turns is not settled (FrodoBots' dashboard says left, their firmware notes right):
// clicking both sticks reverses steering, remembered on this headset.
const STEER_KEY = 'rover-cockpit.steer';
const savedSteer = (() => { try { return localStorage.getItem(STEER_KEY) === '-1' ? -1 : 1; } catch { return 1; } })();
const state = { main: 'front', mirror: true, lamp: false, speed: 0 /* index into SPEED_STEPS: start slow */, mode: 'exact', steer: savedSteer };
const net = { pc: null, sdk: null }; // null until known
let telemetry = null;
let telemetryAt = 0;

// keepalive lets the last stop leave as the page closes. Only same-origin: a cross-origin JSON POST needs a
// CORS preflight, which older Chromium refused for keepalive requests. The SDK's watchdog
// (CONTROL_WATCHDOG_S) stops the rover anyway once commands stop arriving.
const link = new CommandLink({
  send: async (command) => {
    const res = await fetch(`${API}/control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command }),
      keepalive: SAME_ORIGIN,
      signal: AbortSignal.timeout(1500), // a request that hangs must not block the stops behind it
      ...LOCAL,
    });
    return res.ok;
  },
});
setInterval(() => link.tick(), SEND_MS);

// The SDK's own view of things, from GET /status (no side effects): whether its browser is up, whether its
// link to the rover works, how many commands the rover confirmed, how old the telemetry is, and why a camera
// has no picture. A 200 from /control only means "sent", so the rover's confirmations tell the real story.
let sdk = null;
let deliveredCount = null;
let deliveredAt = performance.now();

// One loop for both polls, one request at a time: the browser allows six connections to the PC, and the
// two video streams already hold two.
async function poll() {
  for (;;) {
    try {
      const res = await fetch(`${API}/status`, { cache: 'no-store', signal: AbortSignal.timeout(3000), ...LOCAL });
      net.pc = true;
      net.sdk = res.status !== 502;
      sdk = res.ok ? await res.json() : null;
      const delivered = Number(sdk?.rtm?.delivered);
      if (Number.isFinite(delivered) && delivered !== deliveredCount) {
        deliveredCount = delivered;
        deliveredAt = performance.now();
      }
    } catch {
      net.pc = false;
      net.sdk = null;
      sdk = null;
    }
    // Telemetry only while the SDK has a fresh report: asking /data otherwise can make it restart its browser.
    const age = Number(sdk?.telemetry_age_s);
    if (sdk?.browser_ready && Number.isFinite(age) && age < 10) {
      try {
        const res = await fetch(`${API}/data`, { cache: 'no-store', signal: AbortSignal.timeout(3000), ...LOCAL });
        if (res.ok) {
          telemetry = await res.json();
          telemetryAt = performance.now() - age * 1000;
        }
      } catch { /* the status request reports the link */ }
    }
    await sleep(1000);
  }
}
poll();

/** Commands are being sent but the rover has confirmed none for a while. */
function deliveriesStalled(now) {
  return !!sdk?.rtm?.ready && now - link.sentAt < 1500 && now - deliveredAt > 4000;
}

// ---------------------------------------------------------------------------------------------- input

let flash = null; // short-lived message
const say = (text, detail = '') => { flash = { text, detail, until: performance.now() + 1800 }; };
let needCenter = true;

const actions = {
  lamp() { state.lamp = !state.lamp; say(state.lamp ? 'Lamp on' : 'Lamp off'); },
  swap() { state.main = other(state.main); say(`${title(state.main)} camera`); },
  mirror() { state.mirror = !state.mirror; say(state.mirror ? 'Mirror on' : 'Mirror off'); },
  speed() { state.speed = (state.speed + 1) % SPEED_STEPS.length; say(`Speed limit ${Math.round(SPEED_STEPS[state.speed] * 100)}%`); },
  view() { state.mode = state.mode === 'exact' ? 'framed' : 'exact'; say(VIEW_MODES[state.mode].label); },
  recenter() { needCenter = true; say('View centred'); },
  steer() {
    state.steer = -state.steer;
    try { localStorage.setItem(STEER_KEY, String(state.steer)); } catch { /* remembered for this session only */ }
    say(state.steer < 0 ? 'Steering reversed' : 'Steering normal', 'Click both sticks again to switch back');
    report('rover-steer', { steer: state.steer });
  },
};

const keys = new Set();
const KEY_ACTIONS = { KeyL: 'lamp', KeyC: 'swap', KeyM: 'mirror', KeyV: 'view', KeyR: 'recenter', KeyF: 'steer' };
addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (KEY_ACTIONS[e.code]) actions[KEY_ACTIONS[e.code]]();
  const digit = e.code.match(/^Digit([1-3])$/);
  if (digit) {
    state.speed = Number(digit[1]) - 1;
    say(`Speed limit ${Math.round(SPEED_STEPS[state.speed] * 100)}%`);
  }
  if (/^(Arrow|Space)/.test(e.code)) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
const haltAll = () => { keys.clear(); link.halt(); };
addEventListener('blur', haltAll);
document.addEventListener('visibilitychange', () => { if (document.hidden) haltAll(); });
addEventListener('pagehide', () => link.halt());
const held = (...codes) => codes.some(c => keys.has(c));
const edges = new Edges();
const clicks = new StickClicks();
const CLICK_ACTIONS = { left: 'view', right: 'recenter', both: 'steer' };

function readInput() {
  let throttleY = (held('KeyS', 'ArrowDown') ? 1 : 0) - (held('KeyW', 'ArrowUp') ? 1 : 0);
  let steerX = (held('KeyD', 'ArrowRight') ? 1 : 0) - (held('KeyA', 'ArrowLeft') ? 1 : 0);
  let stop = held('Space');
  let leftStick = false;
  let rightStick = false;
  const session = renderer.xr.getSession();
  if (session) {
    if (session.visibilityState !== 'visible') stop = true; // a system menu has the controllers
    for (const source of session.inputSources) {
      if (!source.gamepad) continue; // tracked hands have no sticks
      const pad = readPad(source.gamepad);
      if (source.handedness === 'left') {
        throttleY += pad.y;
        leftStick = pad.stick;
        edges.press('x', pad.lower, actions.mirror);
        edges.press('y', pad.upper, actions.speed);
      } else if (source.handedness === 'right') {
        steerX += pad.x;
        rightStick = pad.stick;
        edges.press('a', pad.lower, actions.lamp);
        edges.press('b', pad.upper, actions.swap);
      }
      if (pad.trigger) stop = true;
    }
  }
  const click = clicks.update(leftStick, rightStick);
  if (click) actions[CLICK_ACTIONS[click]]();
  if (!feeds[state.main].live) stop = true; // never drive blind
  link.setInput(commandFrom({ throttleY, steerX, stop, scale: SPEED_STEPS[state.speed], lamp: state.lamp, steer: state.steer }));
}

// ---------------------------------------------------------------------------------------------- VR

const startScreen = document.getElementById('start');
const info = document.getElementById('info');
let xrSupported = false;
let entering = false;

/** Start the immersive session. Without a user action it may be refused; then the Start button does it. */
async function enterVR() {
  if (entering || renderer.xr.isPresenting || !navigator.xr) return renderer.xr.isPresenting;
  entering = true;
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['hand-tracking'] });
    await renderer.xr.setSession(session);
    return true;
  } catch (err) {
    report('rover-vr-refused', { message: String(err?.message ?? err).slice(0, 200) });
    return false;
  } finally {
    entering = false;
  }
}

function showDesktop() {
  startScreen.hidden = true;
  info.hidden = false;
}

document.getElementById('go').addEventListener('click', () => {
  if (xrSupported) enterVR().then((ok) => { if (!ok) showDesktop(); });
  else showDesktop();
});

const support = navigator.xr?.isSessionSupported ? navigator.xr.isSessionSupported('immersive-vr').catch(() => false) : Promise.resolve(false);
support.then((ok) => {
  xrSupported = ok;
  report('rover-load', { xr: ok, app: params.has('app'), inApp: IN_APP, api: API, access: access.state });
  if (!ok) return showDesktop();
  startScreen.classList.add('ready');
  // Straight into VR: the Quest app's launch (and an adb launch of Quest Browser) counts as the user action.
  enterVR().then(ok2 => report('rover-vr-auto', { ok: ok2 }));
});

renderer.xr.addEventListener('sessionstart', () => {
  const session = renderer.xr.getSession();
  startScreen.hidden = true;
  info.hidden = true;
  needCenter = true;
  say('Rover Cockpit', 'Status on your left hand, controls on your right');
  session.addEventListener('visibilitychange', () => { if (session.visibilityState !== 'visible') link.halt(); });
  renderer.xr.getReferenceSpace()?.addEventListener?.('reset', () => { needCenter = true; }); // system recentre
  report('rover-vr-start');
});
renderer.xr.addEventListener('sessionend', () => {
  link.halt();
  anchor.position.set(0, 0, 0);
  anchor.rotation.set(0, 0, 0);
  if (xrSupported) startScreen.hidden = false;
  report('rover-vr-end');
});

// ---------------------------------------------------------------------------------------------- drawing

function setMap(mesh, texture) {
  if (mesh.material.map === texture) return;
  mesh.material.map = texture;
  mesh.material.color.set(texture ? 0xffffff : 0x000000);
  mesh.material.needsUpdate = true;
}

/** What needs saying now: a fresh short message, else whatever stops the rover, else nothing. */
function message(now) {
  if (flash && now < flash.until) return flash;
  const feed = feeds[state.main];
  if (net.pc === false && access.state === 'denied') {
    return { text: 'Rover Cockpit may not reach your PC', detail: 'Quest Browser settings: allow "Apps on device" for seyedalicheraghi.github.io', warn: true };
  }
  if (net.pc === false && access.state === 'prompt') {
    return { text: 'Allow Rover Cockpit to reach your PC', detail: 'On the PC run npm run rover -- --allow, then allow it in Quest Browser', warn: true };
  }
  if (net.pc === false) return { text: 'Cannot reach the PC', detail: 'Connect the headset to the PC and run npm run rover there', warn: true };
  if (net.sdk === false) return { text: 'The rover SDK is not running on the PC', detail: 'Start it there with npm run rover:sdk', warn: true };
  if (feed.state === 'denied') return { text: 'FrodoBots refused the SDK', detail: 'Check SDK_API_TOKEN and BOT_SLUG in the SDK .env file on the PC', warn: true };
  if (sdk && sdk.browser_ready === false && sdk.browser_error) return { text: 'The SDK could not start', detail: clip(sdk.browser_error), warn: true };
  if (!feed.live) {
    const why = sdk?.video?.[feed.view]?.last_error;
    if (feed.state === 'none') return { text: `This rover has no ${feed.view} camera`, detail: 'Press B to switch back', warn: true };
    if (!feed.texture) return { text: `Waiting for the ${feed.view} camera`, detail: why ? clip(why) : 'The SDK can take a minute to reach the rover', warn: !!why };
    return { text: `No video from the ${feed.view} camera`, detail: why ? clip(why) : 'The rover is stopped. Is it on, with signal?', warn: true };
  }
  if (sdk?.rtm && sdk.rtm.ready === false) return { text: 'The SDK has lost its link to the rover', detail: sdk.rtm.last_error ? clip(sdk.rtm.last_error) : 'Driving will not work until it is back', warn: true };
  if (deliveriesStalled(now)) return { text: 'The rover is not confirming commands', detail: sdk?.rtm?.last_error ? clip(sdk.rtm.last_error) : 'It may not respond. Check its signal', warn: true };
  if (link.ok === false) return { text: 'Drive commands are not getting through', detail: 'The rover may not respond', warn: true };
  return null;
}

const clip = (s, n = 70) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

const fmt = (v, digits = 0, unit = '') => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? `${Number(v).toFixed(digits)}${unit}` : '–');

function drawBoards(now) {
  const msg = message(now);
  toast.mesh.visible = !!msg;
  if (msg) {
    toast.draw(`${msg.text}|${msg.detail}|${msg.warn}`, (ctx, w, h) => {
      panel(ctx, w, h, 40);
      ctx.textAlign = 'center';
      ctx.fillStyle = msg.warn ? '#ffcf5a' : '#eef3fb';
      fitFont(ctx, msg.text, w - 60, 58, 600);
      ctx.fillText(msg.text, w / 2, msg.detail ? h * 0.44 : h * 0.62);
      if (msg.detail) {
        ctx.fillStyle = '#a9b8d2';
        fitFont(ctx, msg.detail, w - 60, 36);
        ctx.fillText(msg.detail, w / 2, h * 0.8);
      }
    });
  }

  const inset = other(state.main);
  mirrorTag.draw(inset, (ctx, w, h) => {
    panel(ctx, w, h, 12);
    ctx.fillStyle = '#dbe4f3';
    ctx.font = `600 ${Math.round(h * 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(inset.toUpperCase(), w / 2, h / 2 + 2);
  });

  const t = now - telemetryAt < 12000 ? telemetry : null;
  const feed = feeds[state.main];
  const cmd = link.last;
  const stalled = deliveriesStalled(now) || link.ok === false;
  const rows = [
    ['Video', feed.live ? `${title(state.main)} · ${feed.rate} fps` : 'none', !feed.live],
    ['Battery', fmt(t?.battery, 0, '%'), Number(t?.battery) < 20],
    ['Signal', t?.signal_level !== undefined ? `${fmt(t.signal_level)} / 5` : '–', Number(t?.signal_level) <= 1],
    ['Speed limit', `${Math.round(SPEED_STEPS[state.speed] * 100)}%${state.steer < 0 ? ' · reversed' : ''}`, false],
    ['Lamp', state.lamp ? 'on' : 'off', false],
    ['Drive', stalled ? 'not reaching rover' : `${cmd.linear.toFixed(1)} / ${cmd.angular.toFixed(1)}`, stalled],
  ];
  status.draw(JSON.stringify(rows), (ctx, w, h) => {
    panel(ctx, w, h);
    ctx.textBaseline = 'middle';
    const rowH = h / (rows.length + 0.6);
    rows.forEach(([label, value, warn], i) => {
      const y = rowH * (i + 0.8);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#8fa2c2';
      ctx.font = '34px system-ui, sans-serif';
      ctx.fillText(label, 30, y);
      ctx.textAlign = 'right';
      ctx.fillStyle = warn ? '#ff7b7b' : '#eef3fb';
      ctx.font = '600 38px system-ui, sans-serif';
      ctx.fillText(value, w - 30, y);
    });
  });

  help.draw('help', (ctx, w, h) => {
    panel(ctx, w, h);
    const lines = [
      ['Left stick', 'forward / back'],
      ['Right stick', 'steer'],
      ['Trigger', 'stop'],
      ['A / B', 'lamp / swap cameras'],
      ['X / Y', 'mirror / speed limit'],
      ['Stick click', 'L: view size, R: centre'],
      ['Both sticks', 'click: reverse steering'],
    ];
    ctx.textBaseline = 'middle';
    const rowH = h / (lines.length + 0.6);
    const split = w * 0.37;
    lines.forEach(([k, v], i) => {
      const y = rowH * (i + 0.8);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffcf5a';
      fitFont(ctx, k, split - 40, 32, 600);
      ctx.fillText(k, 26, y);
      ctx.fillStyle = '#dbe4f3';
      fitFont(ctx, v, w - split - 26, 32, 400);
      ctx.fillText(v, split, y);
    });
  });

  const line = msg && msg !== flash ? msg.text : feed.live ? `Live: ${state.main} camera, ${feed.rate} fps` : 'No video';
  const el = document.getElementById('link');
  if (el.textContent !== line) {
    el.textContent = line;
    el.style.color = feed.live ? '#7be0a0' : '#ffcf5a';
  }
}

/** Size and fill the picture and the mirror for the current cameras and view mode. */
function layout() {
  const main = feeds[state.main];
  const inset = feeds[other(state.main)];
  const fov = cameraFov(state.main, params) * VIEW_MODES[state.mode].scale;
  const framed = state.mode === 'framed';
  const texture = main.live ? main.texture : null;
  const curved = renderer.xr.isPresenting && cameraLens(state.main, params) === 'fisheye';
  const { width, height } = pictureSize(fov, main.aspect);
  picture.visible = !curved;
  dome.visible = curved;
  domeBezel.visible = curved && framed;
  let drop = height / 2;
  if (curved) {
    dome.geometry = domeGeometry(fov, main.aspect, PICTURE_DISTANCE);
    if (framed) domeBezel.geometry = domeGeometry(fov * 1.03, main.aspect * 0.985, PICTURE_DISTANCE + 0.05);
    setMap(dome, texture);
    drop = domeDrop(fov, main.aspect);
  } else {
    picture.scale.set(width, height, 1);
    setMap(picture, texture);
  }
  bezel.visible = framed && !curved;
  floor.visible = framed;
  floor.position.y = Math.min(-1.3, -drop - 0.3); // below the picture, never through it

  mirrorRig.visible = state.mirror && inset.state !== 'none';
  setMap(mirror, inset.live ? inset.texture : null);
  mirror.geometry = inset.view === 'rear' ? MIRRORED : PLAIN; // the rear camera reads like a mirror
  const mh = MIRROR.width / inset.aspect;
  mirror.scale.set(MIRROR.width, mh, 1);
  mirrorBezel.scale.set(MIRROR.width + 0.03, mh + 0.03, 1);
  mirrorTag.mesh.position.set(0, -mh / 2 - 0.04, 0.002);

  if (!renderer.xr.isPresenting) {
    const fovY = desktopFov(fov, main.aspect, camera.aspect);
    if (Math.abs(camera.fov - fovY) > 0.01) {
      camera.fov = fovY;
      camera.updateProjectionMatrix();
    }
  }
}

const headPos = new THREE.Vector3();
const headQuat = new THREE.Quaternion();
const target = new THREE.Vector3();
let toastPlaced = false;

/** The viewer's pose this frame (VR), or false. */
function readHead(frame) {
  if (!frame || !renderer.xr.isPresenting) return false;
  const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
  if (!pose) return false;
  const { position: p, orientation: o } = pose.transform;
  headPos.set(p.x, p.y, p.z);
  headQuat.set(o.x, o.y, o.z, o.w);
  return true;
}

function recenter() {
  const f = forwardOf(headQuat.x, headQuat.y, headQuat.z, headQuat.w);
  anchor.position.copy(headPos);
  anchor.rotation.set(0, yawOf(f.x, f.z, anchor.rotation.y), 0);
}

const TOAST_DISTANCE = 1.3;
function followToast(hasHead, dt) {
  if (!toast.mesh.visible) {
    toastPlaced = false;
    return;
  }
  if (!hasHead) {
    toast.mesh.position.set(0, -0.22, -TOAST_DISTANCE);
    toast.mesh.rotation.set(0, 0, 0);
    return;
  }
  const f = forwardOf(headQuat.x, headQuat.y, headQuat.z, headQuat.w);
  target.set(headPos.x + f.x * TOAST_DISTANCE, headPos.y + f.y * TOAST_DISTANCE - 0.2, headPos.z + f.z * TOAST_DISTANCE);
  if (!toastPlaced) toast.mesh.position.copy(target);
  else toast.mesh.position.lerp(target, 1 - Math.exp(-dt * 4));
  toastPlaced = true;
  toast.mesh.lookAt(headPos);
}

let last = 0;
let boardsAt = 0;
renderer.setAnimationLoop((time, frame) => {
  const dt = Math.min((time - last) / 1000, 0.1);
  last = time;
  readInput();
  const hasHead = readHead(frame);
  if (needCenter && hasHead) {
    recenter();
    needCenter = false;
  }
  layout();
  const now = performance.now();
  if (now - boardsAt > 100) {
    boardsAt = now;
    drawBoards(now);
  }
  followToast(hasHead, dt);
  renderer.render(scene, camera);
});

// For debugging from the console, over adb, or from tests in the emulator.
window.rover = {
  feeds, state, link, actions, enterVR, renderer,
  get net() { return net; },
  get sdk() { return sdk; },
  get telemetry() { return telemetry; },
  message: () => message(performance.now()),
};
