// GameView: everything drawn with three.js for the game (see docs/DESIGN.md, "GameView").
// Owns the city, sky, backdrop, monkeys, banana, effects, wind and aim display, plus lights and fog.
import * as THREE from 'three';
import { CITY_WIDTH, MONKEY, PLAYER_COLORS } from '../core/constants.js';
import { AimView } from './aim.js';
import { Backdrop } from './backdrop.js';
import { BananaView, createBananaMesh, disposeBananaResources } from './banana.js';
import { CityView } from './city-view.js';
import { Effects } from './effects.js';
import { MonkeyModel } from './monkey.js';
import { Sky } from './sky.js';
import { DEFAULT_THEME, getTheme } from './themes.js';
import { clamp, disposeSharedTextures, reportOnce, themeColor } from './util.js';
import { WindView } from './wind.js';

const CITY_CENTER = Object.freeze({ x: CITY_WIDTH / 2, y: 30, z: 0 });
const FOG_NEAR_EXTRA = 60;   // fog starts this far (world units) beyond the city center as seen from the camera
const FOG_FAR_EXTRA = 520;
const LIGHT_DISTANCE = 220;
const SHADOW_BOUNDS = { x: 105, y: 75, near: 20, far: 480 };
const ASSISTS = ['off', 'arrow', 'preview'];

export class GameView {
  /**
   * @param {{renderer?: THREE.WebGLRenderer, scene: THREE.Scene, world?: THREE.Object3D, quality?: 'high'|'quest'}} opts
   */
  constructor({ renderer = null, scene, world = null, quality = 'high' } = {}) {
    if (!scene) throw new Error('GameView: a scene is required');
    this.renderer = renderer;
    this.scene = scene;
    this.world = world ?? scene;
    this.quality = quality === 'quest' ? 'quest' : 'high';
    this.shadows = this.quality === 'high' && Boolean(renderer?.shadowMap);
    if (this.shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
    }

    this.root = new THREE.Group();
    this.root.name = 'gameView';
    this.world.add(this.root);

    this.theme = getTheme(DEFAULT_THEME);
    this.assist = 'arrow';
    this.localPlayer = null;
    this.game = null;
    this.time = 0;
    this.cityVersion = 0;
    this.tmp = new THREE.Vector3();

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1);
    this.keyLight.target.position.set(CITY_CENTER.x, CITY_CENTER.y, CITY_CENTER.z);
    this.root.add(this.hemi, this.keyLight, this.keyLight.target);
    if (this.shadows) {
      const sh = this.keyLight.shadow;
      this.keyLight.castShadow = true;
      sh.mapSize.set(2048, 2048);
      sh.bias = -0.0005;
      sh.normalBias = 0.04;
      this.setShadowScale(1);
    }

    this.sky = new Sky({ scene, world: this.root, quality: this.quality, renderer });
    this.backdrop = new Backdrop({ parent: this.root, quality: this.quality, shadows: this.shadows });
    this.city = new CityView({ parent: this.root, quality: this.quality, shadows: this.shadows });
    this.monkeyMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.monkeys = [0, 1].map((i) => new MonkeyModel(i, { material: this.monkeyMaterial, shadows: this.shadows }));
    for (const mk of this.monkeys) {
      mk.root.visible = false;
      this.root.add(mk.root);
    }
    this.markers = [0, 1].map((i) => this.makeMarker(i));
    this.banana = new BananaView(this.root);
    this.effects = new Effects({ parent: this.root, quality: this.quality });
    this.wind = new WindView({ parent: this.root, quality: this.quality, shadows: this.shadows });
    this.aim = new AimView(this.root);

    this.fog = new THREE.Fog(0x000000, 200, 800);
    this.background = new THREE.Color();
    scene.fog = this.fog;
    scene.background = this.background;

    this.monkeyCtx = { hidden: false, aiming: false, thinking: false, banana: null, thrower: -1, vr: false, xray: false };
    this.eye = new THREE.Vector3();
    this.aimOpts = { assist: this.assist, localPlayer: null, cityVersion: 0, scale: 1 };
    this.frame = { dt: 0, game: null, ready: false, wind: 0 };
    this.steps = [this.stepMonkeys, this.stepBanana, this.stepEffects, this.stepWind, this.stepAim, this.stepCity, this.stepSky];
    this.applyTheme();
  }

  /** Remember the game; build its city if it already has one. */
  setGame(game) {
    try {
      this.game = game ?? null;
      if (this.game?.city) this.buildRound(this.game);
      else this.clearRound();
    } catch (err) {
      reportOnce('setGame', err);
    }
  }

  clearRound() {
    for (const mk of this.monkeys) mk.root.visible = false;
    this.wind.hideFlags();
    this.effects.clear();
    this.banana.reset();
    this.aim.hide();
  }

  buildRound(game) {
    this.city.build(game.city, game.monkeys, this.theme);
    for (const mk of this.monkeys) mk.reset();
    this.wind.setup(game);
    this.effects.clear();
    this.banana.reset();
    this.aim.hide();
    this.cityVersion++;
  }

  /**
   * React to a game event (see the event table in docs/DESIGN.md).
   * @param {string} type
   * @param {object} payload
   * @param {object} [game]
   */
  onEvent(type, payload, game) {
    try {
      const g = game ?? this.game;
      if (g && g !== this.game) this.game = g;
      const p = payload ?? {};
      switch (type) {
        case 'matchStart':
          this.effects.clear();
          this.banana.reset();
          break;
        case 'roundStart':
          if (g?.city) this.buildRound(g);
          break;
        case 'throw':
          this.banana.start();
          break;
        case 'impact':
          this.effects.explode(p.kind, p.x, p.y, p.radius);
          break;
        case 'crater':
          if (!g?.city) break;
          if (g.city !== this.city.city) {
            this.buildRound(g); // missed the round start: the grid already has the crater
            break;
          }
          this.effects.debrisFor(p, this.city);
          this.city.applyCrater(p);
          this.wind.checkSupport(g.city);
          this.cityVersion++;
          break;
        case 'monkeyHit': {
          const m = g?.monkeys?.[p.victim];
          if (m) this.effects.monkeyHit(m.x, m.y + MONKEY.height * 0.5);
          break;
        }
        case 'sunHit':
          this.sky.shock(2);
          break;
        default:
          break; // 'wind' and the rest are read from the game every frame
      }
    } catch (err) {
      reportOnce(`onEvent(${type})`, err);
    }
  }

  /**
   * Per frame. Safe with a missing game, a game whose round has not started, or a round in any phase.
   * Each part runs in its own guard, so a failure in one cannot freeze the others or stop the loop.
   * @param {number} dt seconds
   * @param {object} [game]
   */
  update(dt, game) {
    const f = this.frame;
    f.dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0;
    this.time += f.dt;
    f.game = null;
    f.ready = false;
    try {
      const g = game ?? this.game;
      if (g && g !== this.game) this.game = g;
      if (g?.city && g.city !== this.city.city) this.buildRound(g);
      f.game = g ?? null;
      f.ready = Boolean(g?.city) && g.city === this.city.city && Array.isArray(g.monkeys) && g.monkeys.length >= 2;
      f.wind = f.ready && Number.isFinite(g.wind) ? g.wind : 0;
    } catch (err) {
      reportOnce('update(sync)', err);
    }
    for (let i = 0; i < this.steps.length; i++) {
      try {
        this.steps[i].call(this, f);
      } catch (err) {
        reportOnce(`update(${this.steps[i].name})`, err);
      }
    }
  }

  stepMonkeys(f) {
    const g = f.game;
    const ctx = this.monkeyCtx;
    ctx.banana = f.ready ? g.banana : null;
    ctx.thrower = f.ready ? g.turn : -1;
    ctx.vr = this.localPlayer !== null;
    const eye = ctx.vr ? this.headsetEye() : null;
    for (let i = 0; i < this.monkeys.length; i++) {
      const model = this.monkeys[i];
      const m = f.ready ? g.monkeys[i] : null;
      if (!m) {
        model.root.visible = false;
        this.markers[i].visible = false;
        continue;
      }
      const myTurn = g.phase === 'aim' && g.turn === i;
      this.placeMarker(i, m, myTurn);
      ctx.hidden = this.localPlayer === i;
      ctx.xray = Boolean(eye) && !ctx.hidden && this.sightBlocked(g.city, eye, m);
      ctx.aiming = myTurn && !m.cpu;
      ctx.thinking = myTurn && Boolean(m.cpu);
      model.update(f.dt, m, ctx);
    }
  }

  // Headset position in world (play-plane) units, or null when not presenting.
  headsetEye() {
    const xr = this.renderer?.xr;
    if (!xr?.isPresenting) return null;
    // Read the pose WebXR wrote last frame; getWorldPosition() would rebuild it from the XR camera's unused fields.
    this.eye.setFromMatrixPosition(xr.getCamera().matrixWorld);
    return this.world.worldToLocal(this.eye);
  }

  // In VR you stand inside the row of buildings, so the opponent is usually behind one. Cells are boxes
  // spanning z = ±BUILDING_DEPTH/2 around the play plane, so a 2D test along the sightline is exact enough.
  sightBlocked(city, eye, m) {
    const blocked = (tx, ty) => {
      const dx = tx - eye.x;
      const dy = ty - eye.y;
      const n = Math.ceil(Math.hypot(dx, dy));
      for (let k = 1; k < n; k++) if (city.solidAt(eye.x + (dx * k) / n, eye.y + (dy * k) / n)) return true;
      return false;
    };
    // Both: a partly visible monkey is seen directly (the ghost would also tint its own visible parts).
    return blocked(m.x, m.y + MONKEY.height * 0.45) && blocked(m.x, m.y + MONKEY.height * 0.9);
  }

  // A floating player-colored arrow over each monkey: finds them at a glance (and the opponent in VR).
  makeMarker(i) {
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(1.15, 2.3, 16),
      new THREE.MeshBasicMaterial({ color: PLAYER_COLORS[i], fog: false, transparent: true, opacity: 0.95, depthTest: false }),
    );
    mesh.rotation.x = Math.PI; // point down
    mesh.name = `marker${i}`;
    mesh.visible = false;
    mesh.renderOrder = 20; // drawn last, through buildings
    this.root.add(mesh);
    return mesh;
  }

  placeMarker(i, m, active) {
    const mk = this.markers[i];
    mk.visible = m.alive !== false && m.anim !== 'dead' && this.localPlayer !== i;
    if (!mk.visible) return;
    const bob = active ? 0.6 * Math.sin(this.time * 4) : 0;
    mk.position.set(m.x, m.y + MONKEY.height + 2.6 + bob, 0);
    mk.scale.setScalar(active ? 1.2 : 0.9);
    mk.material.opacity = active ? 1 : 0.8;
  }

  stepBanana(f) {
    this.banana.update(f.dt, f.ready ? f.game.banana : null, this.time);
  }

  stepEffects(f) {
    this.effects.update(f.dt, f.ready ? f.game.city : null);
  }

  stepWind(f) {
    this.wind.update(f.dt, f.wind, this.time);
  }

  stepAim(f) {
    const o = this.aimOpts;
    o.assist = this.assist;
    o.localPlayer = this.localPlayer;
    o.cityVersion = this.cityVersion;
    o.scale = this.world.scale.x || 1;
    this.aim.update(f.ready ? f.game : null, o);
  }

  stepCity() {
    this.city.update(this.time);
  }

  stepSky(f) {
    const s = this.world.scale.x || 1;
    this.sky.update(f.dt, this.time, f.wind, s);
    this.updateFog(s);
  }

  // Fog starts just behind the city whatever the camera distance (portrait, follow mode, VR rooftop).
  updateFog(scale) {
    this.world.updateWorldMatrix(true, false);
    const center = this.world.localToWorld(this.tmp.set(CITY_CENTER.x, CITY_CENTER.y, CITY_CENTER.z));
    const d = this.sky.cameraPos.distanceTo(center);
    this.fog.near = d + FOG_NEAR_EXTRA * scale;
    this.fog.far = d + FOG_FAR_EXTRA * scale;
  }

  /** @param {{theme?: string, assist?: string}} prefs */
  setPrefs(prefs) {
    if (!prefs) return;
    if (ASSISTS.includes(prefs.assist)) this.assist = prefs.assist;
    if (prefs.theme) this.setTheme(prefs.theme);
  }

  /** Switch theme live: 'night' (default), 'sunset' or 'classic'. */
  setTheme(name) {
    const theme = getTheme(name);
    if (theme === this.theme) return;
    this.theme = theme;
    try {
      this.applyTheme();
    } catch (err) {
      reportOnce('setTheme', err);
    }
  }

  get themeName() {
    return this.theme.name;
  }

  applyTheme() {
    const th = this.theme;
    this.sky.setTheme(th);
    this.fog.color.copy(themeColor(th.fog));
    this.background.copy(this.fog.color);
    this.hemi.color.copy(themeColor(th.hemi.sky));
    this.hemi.groundColor.copy(themeColor(th.hemi.ground));
    this.hemi.intensity = th.hemi.intensity * Math.PI;
    this.keyLight.color.copy(themeColor(th.key.color));
    this.keyLight.intensity = th.key.intensity * Math.PI;
    const [dx, dy, dz] = th.key.dir;
    this.keyLight.position.set(dx, dy, dz).normalize().multiplyScalar(LIGHT_DISTANCE)
      .add(this.keyLight.target.position);
    this.monkeyMaterial.emissive.copy(themeColor(th.monkeyLift));
    this.city.recolor(th);
    this.backdrop.recolor(th);
    this.wind.setTheme(th);
    this.banana.setTheme(th);
    this.effects.setTheme(th);
  }

  /** In VR, hide the monkey you are standing in (null shows both). */
  setLocalPlayer(index) {
    this.localPlayer = index === 0 || index === 1 ? index : null;
  }

  /** Scale the world (1 on PC, VR_SCALE in VR). Fog, sky dome and stars follow every frame. */
  setXRScale(s) {
    const scale = Number(s) > 0 ? Number(s) : 1;
    this.world.scale.setScalar(scale);
    this.world.updateWorldMatrix(true, false);
    if (this.shadows) this.setShadowScale(scale);
  }

  setShadowScale(scale) {
    const cam = this.keyLight.shadow.camera;
    cam.left = -SHADOW_BOUNDS.x * scale;
    cam.right = SHADOW_BOUNDS.x * scale;
    cam.top = SHADOW_BOUNDS.y * scale;
    cam.bottom = -SHADOW_BOUNDS.y * scale;
    cam.near = SHADOW_BOUNDS.near * scale;
    cam.far = SHADOW_BOUNDS.far * scale;
    cam.updateProjectionMatrix();
  }

  /** A new banana Object3D (≈0.9 m long in world units) for a VR hand. Shares geometry/material. */
  createBananaMesh() {
    return createBananaMesh();
  }

  /**
   * Feet position of a monkey in scene coordinates (after the world scale).
   * @param {number} index
   * @param {THREE.Vector3} [target]
   */
  monkeyAnchor(index, target = new THREE.Vector3()) {
    const m = this.game?.monkeys?.[index];
    if (m && Number.isFinite(m.x) && Number.isFinite(m.y)) target.set(m.x, m.y, 0);
    else target.set(index === 1 ? CITY_WIDTH - 12 : 12, 40, 0);
    this.world.updateWorldMatrix(true, false);
    return this.world.localToWorld(target);
  }

  dispose() {
    this.sky.dispose();
    this.backdrop.dispose();
    this.city.dispose();
    for (const mk of this.monkeys) mk.dispose();
    this.monkeyMaterial.dispose();
    this.banana.dispose();
    this.effects.dispose();
    this.wind.dispose();
    this.aim.dispose();
    for (const mk of this.markers) {
      mk.geometry.dispose();
      mk.material.dispose();
    }
    this.keyLight.dispose();
    this.hemi.dispose();
    this.root.removeFromParent();
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this.scene.background === this.background) this.scene.background = null;
    disposeBananaResources();
    disposeSharedTextures();
    this.game = null;
  }
}
