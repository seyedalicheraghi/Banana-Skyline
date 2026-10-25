import * as THREE from 'three';
import { Game } from '../core/game.js';
import { GameView } from '../render/view.js';
import { PCCamera } from '../render/camera.js';
import { UI } from '../ui/ui.js';
import { Sfx } from '../audio/sfx.js';
import { XRMode } from '../xr/xr.js';
import { loadPrefs, savePrefs } from './prefs.js';
import { createRemoteLog } from './remote-log.js';

const userAgent = navigator.userAgent; // before ?emulate replaces it with a Quest's

// ?emulate: fake a Quest 3 with Meta's WebXR emulator (dev dependency) to try VR mode without a headset.
if (new URLSearchParams(location.search).has('emulate')) {
  const { XRDevice, metaQuest3 } = await import('../../node_modules/iwer/build/iwer.module.js');
  const device = new XRDevice(metaQuest3);
  device.installRuntime({ forceInstall: true });
  window.xrDevice = device;
}

const isQuest = /OculusBrowser|Quest/i.test(userAgent);
const quality = isQuest ? 'quest' : 'high';

const remote = createRemoteLog(userAgent);
remote.send('load', { ua: userAgent, quality, dpr: window.devicePixelRatio, size: [window.innerWidth, window.innerHeight] });

const DEMO_SETTINGS = {
  demo: true,
  players: [{ name: 'Bongo', cpu: 'normal' }, { name: 'Mango', cpu: 'normal' }],
  targetScore: 20,
  windStrength: 'normal',
};

const container = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isQuest ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const world = new THREE.Group();
world.name = 'world';
scene.add(world);

let prefs = loadPrefs();
let game = null;
let paused = false;

const view = new GameView({ renderer, scene, world, quality });
const pcCamera = new PCCamera();
const sfx = new Sfx();

const ui = new UI({
  root: document.getElementById('ui'),
  canvas: renderer.domElement,
  callbacks: {
    startMatch: (settings) => {
      prefs = savePrefs({ ...prefs, lastSettings: settings });
      startMatch(settings);
    },
    quitToTitle: () => startDemo(),
    setPaused: (value) => { paused = Boolean(value); },
    enterVR: () => (xr.entering ? undefined : xr.enter().then((ok) => {
      if (!ok) throw new Error('VR did not start');
    })),
    prefsChanged: (next) => applyPrefs(next),
    toggleFollow: () => pcCamera.setFollow(!pcCamera.follow),
    worldToScreen: (x, y, z) => pcCamera.worldToScreen(x, y, z),
    screenToWorld: (px, py) => pcCamera.screenToWorld(px, py),
    unlockAudio: () => sfx.unlock(),
  },
});

const xr = new XRMode({
  renderer, scene, world, view, sfx,
  getPrefs: () => prefs,
  setPrefs: (next) => applyPrefs(next),
  startMatch: (settings) => startMatch(settings),
  quitToTitle: () => startDemo(),
  setPaused: (value) => { paused = Boolean(value); },
  onSessionChange: (active) => {
    remote.send(active ? 'vr-start' : 'vr-end', active ? { refSpace: renderer.xr.getReferenceSpace()?.constructor?.name } : undefined);
    paused = false;
    sfx.setPanWidth?.(active ? 0.2 : 0.8); // in VR you face along x, so wide left/right panning would be wrong
    ui.setXRActive(active);
    if (!active) onResize();
  },
});

function applyPrefs(next) {
  prefs = savePrefs(next);
  view.setPrefs(prefs);
  sfx.setEnabled(prefs.sound);
  sfx.setVolume(prefs.volume);
  ui.setPrefs(prefs);
  xr.setPrefs(prefs);
}

function startMatch(settings) {
  game?.destroy();
  paused = false;
  game = new Game(settings);
  if (!game.isDemo) remote.send('match', { players: game.settings.players, vr: xr.active });
  game.onAny((type, payload) => {
    if (!game.isDemo && type === 'throw') remote.send('throw', payload);
    if (!game.isDemo && (type === 'roundOver' || type === 'matchOver')) remote.send(type, payload);
    view.onEvent(type, payload, game);
    pcCamera.onEvent(type, payload, game);
    sfx.onEvent(type, payload, game);
    ui.onEvent(type, payload, game);
    xr.onEvent(type, payload, game);
  });
  view.setGame(game);
  ui.setGame(game);
  xr.setGame(game);
  game.start();
  return game;
}

function startDemo() {
  startMatch(DEMO_SETTINGS);
  ui.showTitle();
}

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!renderer.xr.isPresenting) renderer.setSize(w, h);
  pcCamera.resize(w, h);
}
window.addEventListener('resize', onResize);

applyPrefs(prefs);
onResize();
startDemo();
XRMode.isSupported().then((ok) => {
  ui.setVRSupported(ok);
  remote.send('vr-supported', { ok });
}).catch(() => ui.setVRSupported(false));

const timer = new THREE.Timer(); // not connect()ed: a page hidden during VR would get dt = 0; big steps are capped below
renderer.setAnimationLoop((time, frame) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.1);
  remote.frame(dt, xr.active);
  if (game && !paused) game.update(dt);
  if (game?.isDemo && game.phase === 'matchOver') startDemo();
  view.update(dt, game);
  if (xr.active) xr.update(dt, frame, game);
  else {
    pcCamera.setBottomInset(ui.bottomInset);
    pcCamera.update(dt, game);
  }
  sfx.update(dt, game);
  ui.update(dt, game);
  renderer.render(scene, xr.active ? xr.camera : pcCamera.camera);
});

// Handles for debugging from the browser console.
window.bananaSkyline = { get game() { return game; }, view, pcCamera, ui, sfx, xr, renderer, scene };
