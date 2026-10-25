// src/render (GameView + PCCamera) driven in Node: a fake renderer (shadow map, pixel ratio, renderer.xr), a fake
// canvas document for the sun/moon faces, and a real core Game. Math.random and performance.now are replaced
// with deterministic stand-ins (the view's particles and blinks use Math.random; the core plans CPU shots
// against a wall-clock budget), so every match below plays out the same on any machine.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CELL, CITY_WIDTH, COLS, MONKEY, PLAYER_COLORS, ROWS, VR_SCALE } from '../src/core/constants.js';
import { Game } from '../src/core/game.js';
import { PCCamera } from '../src/render/camera.js';
import { THEME_NAMES, getTheme } from '../src/render/themes.js';
import { GameView } from '../src/render/view.js';
import { HUMANS, MISS, findShot, makeCity, range } from './helpers.mjs';
import {
  FakeCanvas, captureConsole, fakeRenderer, installFakeCanvasDocument, installSeededRandom, installSimClock,
} from './support/render-fakes.mjs';

const DT = 1 / 60;
const QUEST_DT = 1 / 72;
const MAX_MATCH_FRAMES = 60 * 60 * 20; // 20 minutes of game time
const EVENT_TYPES = ['matchStart', 'roundStart', 'turn', 'cpuThinking', 'wind', 'aim', 'throw', 'sunHit', 'impact',
  'crater', 'monkeyHit', 'monkeyFall', 'monkeyLand', 'roundOver', 'matchOver'];

let restoreRandom;
let clock;
let logs;
let doc;

before(() => {
  restoreRandom = installSeededRandom(0xbada55);
  clock = installSimClock();
  logs = captureConsole();
  doc = installFakeCanvasDocument();
});

after(() => {
  doc?.restore();
  logs?.restore();
  clock?.restore();
  restoreRandom?.();
});

/** A test that also fails on any console.error / console.warn output (the view reports every caught error there). */
function quietTest(name, fn) {
  test(name, async () => {
    logs.take();
    try {
      await fn();
    } catch (err) {
      const out = logs.take();
      if (out.length) err.message += `\nconsole output:\n${out.join('\n')}`;
      throw err;
    }
    assert.deepEqual(logs.take(), [], 'console.error / console.warn output');
  });
}

// Handles into the view's scene graph, in one place.
const parts = {
  body: (view, i) => view.monkeys[i].root,
  xray: (view, i) => view.monkeys[i].xrayMat,
  marker: (view, i) => view.markers[i],
  banana: (view) => view.banana.mesh,
  arrow: (view) => view.aim.arrow,
  previewDots: (view) => view.aim.dots,
  lastShot: (view) => view.aim.line,
  cells: (scene) => scene.getObjectByName('cityCells'),
  windows: (scene) => scene.getObjectByName('cityWindows'),
  effects: (scene) => scene.getObjectByName('effects'),
  sun: (scene) => scene.getObjectByName('sunMoon'),
  skyDome: (scene) => scene.getObjectByName('skyDome'),
  trail: (scene) => scene.getObjectByName('bananaTrail'),
  flag: (scene, i) => scene.getObjectByName(`flag${i}`),
  flagCloth: (scene, i) => scene.getObjectByName(`flag${i}`).children[1], // [pole, cloth]
};

// ------------------------------------------------------------------------------------------------ helpers

function stage({ quality = 'high', renderer = fakeRenderer() } = {}) {
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  world.name = 'world';
  scene.add(world);
  const view = new GameView({ renderer, scene, world, quality });
  return { scene, world, view, renderer };
}

function cpuMatch(seed, levels = ['normal', 'normal'], extra = {}) {
  return new Game({
    seed, targetScore: 2, windStrength: 'wild',
    players: [{ name: 'Bongo', cpu: levels[0] }, { name: 'Mango', cpu: levels[1] }],
    ...extra,
  });
}

const humanGame = (seed = 1234, extra = {}) => new Game({ seed, windStrength: 'none', players: HUMANS, ...extra });

/** Forward every event to the targets as src/app/main.js does, then call afterEvent(type, payload). */
function wire(game, targets, afterEvent) {
  game.onAny((type, payload) => {
    for (const t of targets) t.onEvent(type, payload, game);
    afterEvent?.(type, payload);
  });
}

/** One app frame: game.update -> view.update -> camera.update, on the simulated clock. */
function frame(game, view, cams = [], dt = DT) {
  clock.advance(dt);
  game?.update(dt);
  view?.update(dt, game);
  for (const cam of cams) cam.update(dt, game);
}

function runUntil(game, view, pred, { dt = DT, seconds = 60, label = 'condition' } = {}) {
  for (let t = 0; !pred(); t += dt) {
    if (t > seconds) throw new Error(`timed out after ${seconds}s waiting for ${label}`);
    frame(game, view, [], dt);
  }
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Grid index -> number of drawn (non-zero scale) instances of an InstancedMesh placed on that cell. */
function drawnPerCell(mesh) {
  const a = mesh.instanceMatrix.array;
  const out = new Map();
  for (let i = 0; i < mesh.count; i++) {
    const o = i * 16;
    if (Math.hypot(a[o], a[o + 1], a[o + 2]) < 1e-9) continue;
    const idx = Math.floor(a[o + 13] / CELL) * COLS + Math.floor(a[o + 12] / CELL);
    out.set(idx, (out.get(idx) ?? 0) + 1);
  }
  return out;
}

/** The drawn city equals the core grid: one box per solid cell, two windows (front/back) on it, nothing on air. */
function assertCityDrawn(scene, city, label) {
  const cells = drawnPerCell(parts.cells(scene));
  const windows = drawnPerCell(parts.windows(scene));
  const bad = { missingCells: [], extraCells: [], badWindows: [] };
  for (let idx = 0; idx < COLS * ROWS; idx++) {
    const solid = city.grid[idx] !== 0;
    const at = `${idx % COLS},${Math.floor(idx / COLS)}`;
    const n = cells.get(idx) ?? 0;
    if (solid && n !== 1) bad.missingCells.push(`${at} x${n}`);
    if (!solid && n > 0) bad.extraCells.push(`${at} x${n}`);
    const w = windows.get(idx) ?? 0;
    if (w !== (solid ? 2 : 0)) bad.badWindows.push(`${at} x${w}`);
  }
  for (const k of Object.keys(bad)) bad[k] = bad[k].slice(0, 8);
  assert.deepEqual(bad, { missingCells: [], extraCells: [], badWindows: [] }, `drawn city vs grid (${label})`);
}

/** Visible effect pieces: live particle instances plus visible flash/ring/peel meshes and sprites. */
function liveEffects(scene) {
  let n = 0;
  parts.effects(scene).traverse((o) => {
    if (o.isInstancedMesh) n += o.count;
    else if ((o.isMesh || o.isSprite) && o.visible) n++;
  });
  return n;
}

function instancedMeshes(scene) {
  const out = [];
  scene.traverse((o) => { if (o.isInstancedMesh) out.push(o); });
  return out;
}

function assertInstancesBounded(scene, label) {
  for (const m of instancedMeshes(scene)) {
    assert.ok(Number.isInteger(m.count) && m.count >= 0 && m.count <= m.instanceMatrix.count,
      `${label}: ${m.name} draws ${m.count} of ${m.instanceMatrix.count} instances`);
  }
}

function sceneStats(scene) {
  let objects = 0;
  const geometries = new Set();
  const materials = new Set();
  scene.traverse((o) => {
    objects++;
    if (o.geometry) geometries.add(o.geometry);
    for (const m of [].concat(o.material ?? [])) materials.add(m);
  });
  return { objects, geometries: geometries.size, materials: materials.size };
}

function texturesOf(material) {
  const out = [];
  for (const v of Object.values(material)) if (v?.isTexture) out.push(v);
  for (const u of Object.values(material.uniforms ?? {})) if (u?.value?.isTexture) out.push(u.value);
  return out;
}

/** Every geometry, material and texture reachable from the scene, with a label for messages. */
function collectResources(scene) {
  const out = new Map();
  scene.traverse((o) => {
    const name = o.name || o.parent?.name || o.type;
    if (o.geometry && !o.isSprite) out.set(o.geometry, `${name} geometry`); // sprites share three.js's own quad
    for (const m of [].concat(o.material ?? [])) {
      out.set(m, `${name} material (${m.type})`);
      for (const t of texturesOf(m)) out.set(t, `${name} texture`);
    }
  });
  return out;
}

/** Monkeys, markers, flying banana and aim arrow agree with the game state after view.update. */
function checkFrame(view, game, { localPlayer = null, label = '' } = {}) {
  for (const i of [0, 1]) {
    const m = game.monkeys[i];
    const live = m.alive !== false && m.anim !== 'dead';
    const where = `${label} monkey ${i} (anim ${m.anim}, alive ${m.alive})`;
    const body = parts.body(view, i);
    assert.equal(body.visible, live && localPlayer !== i, `${where}: body visible`);
    if (body.visible) {
      assert.ok(near(body.position.x, m.x) && near(body.position.y, m.y) && body.position.z === 0,
        `${where}: body at ${body.position.toArray()} not at the feet (${m.x}, ${m.y}, 0)`);
    }
    const marker = parts.marker(view, i);
    assert.equal(marker.visible, live && localPlayer !== i, `${where}: marker visible`);
    if (marker.visible) {
      assert.ok(near(marker.position.x, m.x) && marker.position.y > m.y + MONKEY.height,
        `${where}: marker at ${marker.position.toArray()} is not over the monkey`);
    }
  }
  const b = game.banana;
  const banana = parts.banana(view);
  assert.equal(banana.visible, Boolean(b), `${label}: flying banana visible`);
  if (b) {
    assert.ok(near(banana.position.x, b.x) && near(banana.position.y, b.y) && banana.position.z === 0,
      `${label}: banana mesh at ${banana.position.toArray()}, banana at (${b.x}, ${b.y})`);
    assert.ok(near(banana.rotation.z, b.spin || 0), `${label}: banana spin`);
  }
  if (!game.humanTurn) assert.equal(parts.arrow(view).visible, false, `${label}: aim arrow on a non-human turn`);
}

// VR eye of the player standing in monkey `m`, in world (play-plane) units: the rig stands on the monkey's
// anchor, 0.25 m back from it, eyes 1.6 m up (scene meters, divided by the world scale).
const eyeOf = (m, scale = VR_SCALE) => ({ x: m.x - (m.facing * 0.25) / scale, y: m.y + 1.6 / scale });

function placeHeadset(view, renderer, index, game, scale = VR_SCALE) {
  const m = game.monkeys[index];
  const a = view.monkeyAnchor(index);
  renderer.setHeadset(a.x - m.facing * 0.25, a.y + 1.6, a.z);
  return eyeOf(m, scale);
}

function segmentBlocked(city, a, b) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.05);
  for (let k = 1; k < n; k++) if (city.solidAt(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n)) return true;
  return false;
}

/**
 * Independent line-of-sight check, fine-sampled from eyes jittered by ±0.5 m to points from the opponent's legs to
 * its head: true when every sightline is blocked by the city, false when none is, null when it is a close call
 * (partly hidden, or a building corner within half a meter), which the view may decide either way.
 */
function hiddenFrom(city, eye, m) {
  let blocked = 0;
  let total = 0;
  for (const dx of [-0.5, 0, 0.5]) {
    for (const dy of [-0.5, 0, 0.5]) {
      for (const h of [0.3, 0.45, 0.7, 0.9]) {
        total++;
        if (segmentBlocked(city, { x: eye.x + dx, y: eye.y + dy }, { x: m.x, y: m.y + MONKEY.height * h })) blocked++;
      }
    }
  }
  return blocked === total ? true : blocked === 0 ? false : null;
}

function onScreen(cam, x, y, z = 0) {
  const s = cam.worldToScreen(x, y, z);
  return s.x >= 0 && s.x <= cam.width && s.y >= 0 && s.y <= cam.height;
}

// ------------------------------------------------------------------------------------------------ GameView

describe('GameView construction', () => {
  quietTest("'high' turns on shadows with a shadow-capable renderer; 'quest' casts none and has smaller pools", () => {
    const castCount = (scene) => {
      let n = 0;
      scene.traverse((o) => { if (o.castShadow) n++; });
      return n;
    };
    const high = stage({ quality: 'high' });
    const quest = stage({ quality: 'quest' });
    assert.equal(high.renderer.shadowMap.enabled, true, 'high: renderer.shadowMap.enabled');
    assert.ok(castCount(high.scene) > 0, 'high: something casts shadows');
    assert.equal(quest.renderer.shadowMap.enabled, false, 'quest: renderer.shadowMap.enabled');
    assert.equal(castCount(quest.scene), 0, 'quest: nothing casts shadows');

    for (const { scene, world, view } of [high, quest]) {
      assert.ok(scene.fog, 'fog set');
      assert.ok(scene.background?.isColor, 'background color set');
      for (const i of [0, 1]) {
        assert.equal(parts.body(view, i).visible, false, 'no monkey before a game');
        assert.equal(parts.marker(view, i).visible, false, 'no marker before a game');
        assert.ok(world.getObjectById(parts.body(view, i).id), 'monkeys live inside the world group (VR scale)');
      }
      assert.equal(parts.banana(view).visible, false);
      assert.ok(world.getObjectById(parts.cells(scene).id), 'the city lives inside the world group');
    }

    // Quest pools are capped no higher than 'high' ones, and smaller in total.
    const caps = (scene) => Object.fromEntries(instancedMeshes(scene).map((m) => [m.name, m.instanceMatrix.count]));
    const hc = caps(high.scene);
    const qc = caps(quest.scene);
    for (const [name, cap] of Object.entries(qc)) assert.ok(cap <= (hc[name] ?? Infinity), `${name}: quest ${cap} > high ${hc[name]}`);
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
    assert.ok(sum(qc) < sum(hc), `quest instance capacity ${sum(qc)} vs high ${sum(hc)}`);
  });

  quietTest('works without a renderer (no shadows, no XR) and with the world defaulting to the scene', () => {
    const scene = new THREE.Scene();
    const view = new GameView({ scene, quality: 'high' });
    const game = humanGame(5);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    view.setLocalPlayer(0);
    frame(game, view);
    checkFrame(view, game, { localPlayer: 0, label: 'no renderer' });
    assert.equal(parts.xray(view, 1).visible, false, 'no x-ray without a presenting XR session');
    assert.ok(scene.getObjectById(parts.body(view, 1).id));
    view.dispose();
  });
});

describe('GameView without a game', () => {
  quietTest('every public method and every event is safe before setGame and with a null or missing game', () => {
    const { scene, view } = stage();
    const samples = {
      matchStart: { settings: {}, seed: 1 }, roundStart: { round: 1, wind: 3, turn: 0, pattern: 'random' },
      turn: { player: 0, cpu: null, name: 'A' }, cpuThinking: { player: 1, level: 'hard' }, wind: { wind: -7 },
      aim: { player: 0, angle: 45, power: 50 }, throw: { player: 0, angle: 45, power: 50, x: 10, y: 30, vx: 20, vy: 20, method: 'aim' },
      sunHit: { x: 72, y: 86 }, impact: { kind: 'building', x: 40, y: 20, radius: 3.4, victim: null, thrower: 0 },
      crater: { x: 40, y: 20, radius: 3.4, removed: [{ col: 20, row: 9, building: 3 }] },
      monkeyHit: { victim: 1, thrower: 0, selfHit: false }, monkeyFall: { player: 0, fromY: 30, toY: 10 },
      monkeyLand: { player: 0, y: 10 }, roundOver: { winner: 0, scores: [1, 0], selfHit: false, matchPoint: false },
      matchOver: { winner: 0, scores: [3, 1] },
    };
    for (const type of EVENT_TYPES) {
      view.onEvent(type, samples[type], null);
      view.onEvent(type, undefined, undefined);
      view.onEvent(type, null);
    }
    view.onEvent('notAnEvent', { x: 1 }, null);
    for (const dt of [DT, 0, -1, NaN, Infinity, undefined]) {
      view.update(dt, null);
      view.update(dt, undefined);
    }
    view.setGame(null);
    view.setGame(undefined);
    view.setPrefs(null);
    view.setPrefs({});
    view.setPrefs({ assist: 'bogus' });
    view.setLocalPlayer(0);
    view.setLocalPlayer(null);
    view.setXRScale(VR_SCALE);
    view.setXRScale(1);
    view.update(DT, null);

    for (const i of [0, 1]) {
      assert.equal(parts.body(view, i).visible, false, `monkey ${i} hidden without a game`);
      assert.equal(parts.marker(view, i).visible, false, `marker ${i} hidden without a game`);
      const a = view.monkeyAnchor(i);
      assert.ok(a.isVector3 && [a.x, a.y, a.z].every(Number.isFinite), `monkeyAnchor(${i}) without a game: ${a.toArray()}`);
      const target = new THREE.Vector3();
      assert.equal(view.monkeyAnchor(i, target), target, 'monkeyAnchor fills and returns the target');
    }
    assert.equal(parts.banana(view).visible, false);
    assert.equal(parts.arrow(view).visible, false);
    assert.equal(parts.cells(scene).count, 0, 'no city drawn');

    // A game whose round has not started yet: still nothing to draw.
    const game = humanGame(21);
    view.setGame(game);
    view.update(DT, game);
    assert.equal(parts.body(view, 0).visible, false, 'no monkey before game.start()');
    assert.equal(parts.cells(scene).count, 0, 'no city before game.start()');
    // ...and once it starts (events forwarded), the city and monkeys appear.
    wire(game, [view]);
    game.start();
    frame(game, view);
    checkFrame(view, game, { label: 'after start' });
    assertCityDrawn(scene, game.city, 'after start');
  });

  quietTest('a roundStart event before setGame adopts that game and builds its city', () => {
    const { scene, view } = stage();
    const game = humanGame(8);
    wire(game, [view]);
    game.start(); // view.setGame was never called
    assertCityDrawn(scene, game.city, 'built from roundStart');
    view.update(DT, game);
    checkFrame(view, game, { label: 'adopted' });
    const a = view.monkeyAnchor(1);
    assert.ok(near(a.x, game.monkeys[1].x) && near(a.y, game.monkeys[1].y), 'monkeyAnchor reads the adopted game');
  });
});

describe('GameView during whole CPU-vs-CPU matches', () => {
  for (const [quality, seed, dt] of [['high', 1001, DT], ['quest', 1002, QUEST_DT]]) {
    quietTest(`${quality}: monkeys, markers, banana and city follow the game every frame; resources stay bounded`, () => {
      const { scene, view } = stage({ quality });
      const cam = new PCCamera();
      cam.resize(1280, 720);
      const game = cpuMatch(seed, ['normal', 'hard']);
      const counts = {};
      let firstRound = null;
      wire(game, [view, cam], (type) => {
        counts[type] = (counts[type] ?? 0) + 1;
        if (type === 'roundStart' || type === 'crater') assertCityDrawn(scene, game.city, `${type} #${counts[type]}`);
        if (type === 'roundStart') {
          const stats = sceneStats(scene);
          firstRound ??= stats;
          assert.deepEqual(stats, firstRound, `scene objects/geometries/materials at round ${game.round}`);
        }
      });
      view.update(dt, game); // before setGame and start(): nothing to draw
      assert.equal(parts.body(view, 0).visible, false);
      view.setGame(game);
      game.start();

      let frames = 0;
      let maxEffects = 0;
      while (game.phase !== 'matchOver') {
        frame(game, view, [cam], dt);
        frames++;
        assert.ok(frames < MAX_MATCH_FRAMES, `match still in phase ${game.phase} after ${frames} frames`);
        checkFrame(view, game, { label: `frame ${frames} (${game.phase}, round ${game.round})` });
        maxEffects = Math.max(maxEffects, liveEffects(scene));
        if (frames % 30 === 0) assertInstancesBounded(scene, `frame ${frames}`);
        if (frames % 1000 === 0) { // switch themes mid-round
          const name = THEME_NAMES[(frames / 1000) % THEME_NAMES.length];
          view.setTheme(name);
          assert.equal(view.themeName, name);
          assertCityDrawn(scene, game.city, `after setTheme('${name}') at frame ${frames}`);
        }
      }
      for (let i = 0; i < 120; i++) { // the match-over screen keeps drawing the final state
        frame(game, view, [cam], dt);
        checkFrame(view, game, { label: `after matchOver +${i}` });
      }

      assert.equal(counts.matchStart, 1);
      assert.equal(counts.matchOver, 1);
      assert.ok(counts.roundStart >= 2, `${counts.roundStart} rounds`);
      assert.equal(counts.roundOver, game.scores[0] + game.scores[1]);
      assert.equal(counts.impact, counts.throw);
      assert.ok(counts.crater >= 1, 'at least one crater');
      assert.ok(counts.wind >= 1, "'wild' wind changed mid-round");
      assert.ok(maxEffects > 0, 'impacts drew effects');
      assert.ok(frames > 1000, `${frames} frames`);
    });
  }

  quietTest('VR (quest): the local monkey stays hidden and the opponent gets x-ray exactly when the city hides it', () => {
    const renderer = fakeRenderer({ presenting: true, shadows: false });
    const { view } = stage({ quality: 'quest', renderer });
    view.setXRScale(VR_SCALE);
    view.setLocalPlayer(0);
    const game = cpuMatch(3, ['normal', 'normal'], { targetScore: 1 });
    wire(game, [view]);
    view.setGame(game);
    game.start();
    let frames = 0;
    let decided = 0;
    let xrayFrames = 0;
    while (game.phase !== 'matchOver') {
      clock.advance(QUEST_DT);
      game.update(QUEST_DT);
      const eye = placeHeadset(view, renderer, 0, game);
      view.update(QUEST_DT, game);
      frames++;
      assert.ok(frames < MAX_MATCH_FRAMES, 'match did not finish');
      const label = `frame ${frames} (${game.phase})`;
      checkFrame(view, game, { localPlayer: 0, label });
      assert.equal(parts.xray(view, 0).visible, false, `${label}: no x-ray on your own monkey`);
      const xray = parts.xray(view, 1).visible;
      if (!parts.body(view, 1).visible) {
        assert.equal(xray, false, `${label}: no x-ray for a hidden (dead) opponent`);
        continue;
      }
      if (xray) xrayFrames++;
      const hidden = hiddenFrom(game.city, eye, game.monkeys[1]);
      if (hidden === null) continue;
      decided++;
      assert.equal(xray, hidden, `${label}: x-ray ${xray} but the opponent is ${hidden ? 'hidden' : 'in plain sight'}`);
    }
    assert.ok(decided > frames / 2, `${decided} of ${frames} frames had a clear-cut sightline`);
    assert.ok(xrayFrames > 0, 'the opponent was behind buildings at some point');
  });
});

describe('GameView VR helpers', () => {
  quietTest('setXRScale scales the world, the fog and the sky dome; monkeyAnchor is the feet times the scale', () => {
    const { scene, world, view } = stage();
    const game = humanGame(31);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    frame(game, view);
    const fogSpan = () => scene.fog.far - scene.fog.near;
    const span1 = fogSpan();
    const dome1 = parts.skyDome(scene).scale.x;
    for (const i of [0, 1]) {
      const a = view.monkeyAnchor(i);
      assert.ok(near(a.x, game.monkeys[i].x) && near(a.y, game.monkeys[i].y) && near(a.z, 0), `scale 1 anchor ${i}`);
    }

    view.setXRScale(VR_SCALE);
    frame(game, view);
    assert.ok(near(world.scale.x, VR_SCALE) && near(world.scale.y, VR_SCALE) && near(world.scale.z, VR_SCALE));
    for (const i of [0, 1]) {
      const m = game.monkeys[i];
      const target = new THREE.Vector3(9, 9, 9);
      const a = view.monkeyAnchor(i, target);
      assert.equal(a, target);
      assert.ok(near(a.x, m.x * VR_SCALE, 1e-9) && near(a.y, m.y * VR_SCALE, 1e-9) && near(a.z, 0),
        `anchor ${i} ${a.toArray()} vs feet x scale (${m.x * VR_SCALE}, ${m.y * VR_SCALE}, 0)`);
    }
    assert.ok(near(fogSpan() / span1, VR_SCALE, 1e-6), `fog span ${fogSpan()} vs ${span1}`);
    assert.ok(near(parts.skyDome(scene).scale.x / dome1, VR_SCALE, 1e-9), 'sky dome follows the scale');
    checkFrame(view, game, { label: 'VR scale' }); // positions are in world (play-plane) units whatever the scale

    view.setXRScale(1);
    frame(game, view);
    assert.ok(near(world.scale.x, 1));
    assert.ok(near(view.monkeyAnchor(1).x, game.monkeys[1].x));
    assert.ok(near(fogSpan(), span1, 1e-6), 'fog back to PC distances');
    for (const bad of [0, -2, NaN, undefined, 'x']) {
      view.setXRScale(bad);
      assert.ok(world.scale.x > 0 && Number.isFinite(world.scale.x), `setXRScale(${bad}) left scale ${world.scale.x}`);
    }
  });

  quietTest('setLocalPlayer hides that monkey and its marker; null (or anything else) shows both', () => {
    const { view } = stage();
    const game = humanGame(32);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    for (const [local, expect] of [[0, 0], [1, 1], [null, null], [undefined, null], [7, null], ['0', null]]) {
      view.setLocalPlayer(local);
      frame(game, view);
      checkFrame(view, game, { localPlayer: expect, label: `setLocalPlayer(${local})` });
    }
  });

  quietTest('markers float over live monkeys in player colors, drawn through buildings, bobbing for the current turn', () => {
    const { view } = stage();
    const game = humanGame(33);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    const ys = [[], []];
    for (let i = 0; i < 90; i++) {
      frame(game, view);
      for (const k of [0, 1]) ys[k].push(parts.marker(view, k).position.y);
    }
    const spread = (a) => Math.max(...a) - Math.min(...a);
    assert.equal(game.turn, 0);
    assert.ok(spread(ys[0]) > 0.3, `current player's marker bobs (${spread(ys[0])})`);
    assert.ok(spread(ys[1]) < 1e-9, `the other marker is still (${spread(ys[1])})`);
    for (const k of [0, 1]) {
      const mk = parts.marker(view, k);
      assert.equal(mk.material.color.getHexString(), new THREE.Color(PLAYER_COLORS[k]).getHexString(), `marker ${k} color`);
      assert.equal(mk.material.depthTest, false, `marker ${k} is drawn on top of buildings`);
    }
    // A dead monkey loses its body and its marker; the other keeps both.
    Object.assign(game.monkeys[1], { alive: false, anim: 'dead', animTime: 0 });
    frame(game, view);
    checkFrame(view, game, { label: 'monkey 1 dead' });
    assert.equal(parts.marker(view, 1).visible, false);
    assert.equal(parts.marker(view, 0).visible, true);
  });

  quietTest('createBananaMesh returns a new ~0.9 m banana each call', () => {
    const { view } = stage();
    const a = view.createBananaMesh();
    const b = view.createBananaMesh();
    assert.ok(a.isObject3D && b.isObject3D && a !== b);
    const size = new THREE.Box3().setFromObject(a).getSize(new THREE.Vector3());
    const length = Math.max(size.x, size.y, size.z);
    assert.ok(length > 0.75 && length < 1.05, `banana is ${length} m long`);
  });
});

describe('GameView x-ray in VR', () => {
  // Two roofs 124 m apart; `tower` puts a 60 m building in the middle of the sightline.
  function xrayStage({ tower, presenting = true }) {
    const renderer = fakeRenderer({ presenting, shadows: false });
    const { view } = stage({ quality: 'quest', renderer });
    const game = humanGame(41);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    const blocks = [{ col0: 0, col1: 10, row1: 10 }, { col0: 62, col1: 72, row1: 10 }];
    if (tower) blocks.push({ col0: 30, col1: 40, row1: 30 });
    game.city = makeCity(blocks);
    Object.assign(game.monkeys[0], { x: 10, y: 20 });
    Object.assign(game.monkeys[1], { x: 134, y: 20 });
    view.setXRScale(VR_SCALE);
    view.setLocalPlayer(0);
    return { view, game, renderer };
  }

  quietTest('the opponent behind a tower gets x-ray; with a clear sightline it does not', () => {
    for (const tower of [true, false]) {
      const { view, game, renderer } = xrayStage({ tower });
      const eye = placeHeadset(view, renderer, 0, game);
      view.update(QUEST_DT, game); // the swapped-in city is picked up here
      assert.equal(hiddenFrom(game.city, eye, game.monkeys[1]), tower, 'test setup: sightline');
      checkFrame(view, game, { localPlayer: 0, label: `tower ${tower}` });
      assert.equal(parts.xray(view, 1).visible, tower, `tower ${tower}: opponent x-ray`);
      assert.equal(parts.xray(view, 0).visible, false, 'never on your own monkey');
    }
  });

  quietTest('x-ray follows the headset pose (matrixWorld, in scene units) and needs a presenting session', () => {
    const { view, game, renderer } = xrayStage({ tower: true });
    placeHeadset(view, renderer, 0, game);
    view.update(QUEST_DT, game);
    assert.equal(parts.xray(view, 1).visible, true, 'behind the tower');

    // Lift the headset high above the tower (scene coordinates = world x VR_SCALE): the opponent is in sight.
    const high = { x: 10, y: 140 };
    assert.equal(hiddenFrom(game.city, high, game.monkeys[1]), false, 'test setup: sightline over the tower');
    renderer.setHeadset(high.x * VR_SCALE, high.y * VR_SCALE, 0);
    view.update(QUEST_DT, game);
    assert.equal(parts.xray(view, 1).visible, false, 'seen over the tower');

    placeHeadset(view, renderer, 0, game);
    renderer.xr.isPresenting = false;
    view.update(QUEST_DT, game);
    assert.equal(parts.xray(view, 1).visible, false, 'not presenting: no x-ray');

    renderer.xr.isPresenting = true;
    view.setLocalPlayer(null);
    view.update(QUEST_DT, game);
    assert.equal(parts.xray(view, 0).visible, false, 'no local player: no x-ray');
    assert.equal(parts.xray(view, 1).visible, false, 'no local player: no x-ray');

    view.setLocalPlayer(0);
    Object.assign(game.monkeys[1], { alive: false, anim: 'dead' });
    view.update(QUEST_DT, game);
    assert.equal(parts.xray(view, 1).visible, false, 'dead opponent: no x-ray');
  });

  quietTest('on generated cities the x-ray agrees with an independent line-of-sight check (hidden and visible seeds)', () => {
    const renderer = fakeRenderer({ presenting: true, shadows: false });
    const { view } = stage({ quality: 'quest', renderer });
    view.setXRScale(VR_SCALE);
    view.setLocalPlayer(0);
    const seen = { hidden: [], visible: [] };
    for (let seed = 1; seed <= 60; seed++) {
      const game = new Game({ seed, players: [{ name: 'You', cpu: null }, { name: 'CPU', cpu: 'normal' }] });
      wire(game, [view]);
      view.setGame(game);
      game.start();
      const eye = placeHeadset(view, renderer, 0, game);
      view.update(QUEST_DT, game);
      const hidden = hiddenFrom(game.city, eye, game.monkeys[1]);
      game.destroy();
      if (hidden === null) continue;
      assert.equal(parts.xray(view, 1).visible, hidden, `seed ${seed}: opponent ${hidden ? 'hidden' : 'visible'}`);
      seen[hidden ? 'hidden' : 'visible'].push(seed);
    }
    assert.ok(seen.hidden.length >= 3 && seen.visible.length >= 3, `hidden seeds ${seen.hidden}; visible seeds ${seen.visible}`);
  });
});

describe('GameView craters and effects', () => {
  /** A human game and a throw for player 0 that blows a crater in a building without hurting anyone. */
  function craterSetup() {
    const game = humanGame(1234);
    game.start();
    const shot = findShot(game, (hit) => hit.kind === 'building', { angles: range(20, 70, 1), powers: range(30, 90, 1) });
    assert.ok(shot, 'test setup: a building shot exists');
    return { game, shot };
  }

  quietTest('crater events hide exactly the removed cells and their windows; a late view builds the cratered city', () => {
    const { scene, view } = stage();
    const { game, shot } = craterSetup();
    view.setGame(game);
    wire(game, [view], (type, p) => {
      if (type !== 'crater') return;
      assert.ok(p.removed.length > 0, 'the shot removed cells');
      assertCityDrawn(scene, game.city, 'after crater');
      const drawn = drawnPerCell(parts.cells(scene));
      for (const c of p.removed) assert.equal(drawn.has(c.row * COLS + c.col), false, `cell ${c.col},${c.row} still drawn`);
    });
    const before = drawnPerCell(parts.cells(scene)).size;
    let craters = 0;
    game.on('crater', () => craters++);
    assert.ok(game.throwShot(shot));
    runUntil(game, view, () => craters > 0, { label: 'crater' });
    const after = drawnPerCell(parts.cells(scene)).size;
    assert.ok(after < before, `${before} -> ${after} drawn cells`);
    frame(game, view);
    assert.ok(liveEffects(scene) > 0, 'explosion and debris are drawn');

    // A view that joins mid-round (missed roundStart and the crater) draws the grid as it is now.
    const late = stage();
    late.view.setGame(game);
    late.view.update(DT, game);
    assertCityDrawn(late.scene, game.city, 'late setGame');

    // A crater for a game the view has never seen: it rebuilds for that game's city.
    const other = humanGame(77);
    other.start();
    view.onEvent('crater', { x: 0, y: 0, radius: 3.4, removed: [] }, other);
    assertCityDrawn(scene, other.city, 'crater from an unseen game');
  });

  quietTest('impact effects: a big burst for monkeys, smaller for buildings, a puff on the street, nothing when out', () => {
    for (const quality of ['high', 'quest']) {
      const { scene, view } = stage({ quality });
      const game = humanGame(51);
      wire(game, [view]);
      view.setGame(game);
      game.start();
      const size = {};
      for (const kind of ['out', 'ground', 'building', 'monkey']) {
        for (let i = 0; i < 100; i++) view.update(0.1, game); // ten seconds: earlier effects die out
        assert.equal(liveEffects(scene), 0, `${quality}: effects gone before '${kind}'`);
        const radius = { out: 0, ground: 1.6, building: 3.4, monkey: 6.5 }[kind];
        view.onEvent('impact', { kind, x: 70, y: kind === 'ground' ? 0 : 30, radius, victim: null, thrower: 0 }, game);
        view.update(0, game);
        size[kind] = liveEffects(scene);
      }
      assert.equal(size.out, 0, `${quality}: 'out' draws nothing`);
      assert.ok(size.ground > 0, `${quality}: street puff`);
      assert.ok(size.building > size.ground && size.monkey > size.building, `${quality}: ${JSON.stringify(size)}`);
    }
  });

  quietTest('a burst of hundreds of impacts and craters stays within the particle pools (quest no more than high)', () => {
    const live = {};
    for (const quality of ['high', 'quest']) {
      const { scene, view } = stage({ quality });
      const game = humanGame(52);
      wire(game, [view]);
      view.setGame(game);
      game.start();
      for (let k = 0; k < 300; k++) {
        const x = 20 + (k % 100);
        view.onEvent('impact', { kind: k % 3 ? 'building' : 'monkey', x, y: 30, radius: 6.5, victim: null, thrower: 0 }, game);
        view.onEvent('monkeyHit', { victim: k % 2, thrower: 1 - (k % 2), selfHit: false }, game);
        view.onEvent('crater', { x, y: 10, radius: 6.5, removed: game.city.carve(x, 10, 6.5) }, game);
      }
      view.update(DT, game);
      assertInstancesBounded(scene, `${quality} burst`);
      assertCityDrawn(scene, game.city, `${quality} burst`);
      live[quality] = liveEffects(scene);
    }
    assert.ok(live.quest <= live.high, `quest draws ${live.quest} effect pieces, high ${live.high}`);
  });
});

describe('GameView themes', () => {
  // Linear-space direction of a color, to compare "a shade of" a palette color.
  const dir = (r, g, b) => {
    const n = Math.hypot(r, g, b) || 1;
    return [r / n, g / n, b / n];
  };
  const shadeOf = (rgb, hexes) => hexes.some((h) => {
    const c = new THREE.Color(h);
    const a = dir(...rgb);
    const p = dir(c.r, c.g, c.b);
    return Math.hypot(a[0] - p[0], a[1] - p[1], a[2] - p[2]) < 0.02;
  });

  quietTest('setTheme switches every theme mid-round: sky, fog and city colors change, destroyed cells stay gone', () => {
    const { scene, view } = stage();
    const game = humanGame(1234);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    const shot = findShot(game, (hit) => hit.kind === 'building', { angles: range(20, 70, 1), powers: range(30, 90, 1) });
    let crater = null;
    game.on('crater', (p) => { crater = p; });
    game.throwShot(shot);
    runUntil(game, view, () => crater, { label: 'crater' });

    let orbTexture = parts.sun(scene).material.map;
    for (const name of [...THEME_NAMES.slice(1), THEME_NAMES[0], ...THEME_NAMES]) {
      let disposed = false;
      const previous = orbTexture;
      previous.addEventListener('dispose', () => { disposed = true; });
      const changed = name !== view.themeName;
      view.setTheme(name);
      frame(game, view);
      const theme = getTheme(name);
      assert.equal(view.themeName, name);
      const fog = new THREE.Color(theme.fog).getHexString();
      assert.equal(scene.background.getHexString(), fog, `${name}: background`);
      assert.equal(scene.fog.color.getHexString(), fog, `${name}: fog`);
      assertCityDrawn(scene, game.city, `setTheme('${name}')`);
      orbTexture = parts.sun(scene).material.map;
      if (changed) assert.ok(disposed && orbTexture !== previous, `${name}: the old sun/moon face texture is disposed`);

      // Cells away from the scorched crater rim are shades of the theme's building colors, windows of its window colors.
      for (const [mesh, palette] of [[parts.cells(scene), theme.buildings], [parts.windows(scene), [...theme.windowLit, theme.windowOff]]]) {
        const m = mesh.instanceMatrix.array;
        const c = mesh.instanceColor.array;
        let checked = 0;
        for (let i = 0; i < mesh.count; i++) {
          const o = i * 16;
          if (Math.hypot(m[o], m[o + 1], m[o + 2]) < 1e-9) continue;
          if (Math.hypot(m[o + 12] - crater.x, m[o + 13] - crater.y) < crater.radius + 10) continue;
          checked++;
          const rgb = [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
          assert.ok(shadeOf(rgb, palette), `${name}: ${mesh.name} instance ${i} color ${rgb} is not from ${palette}`);
        }
        assert.ok(checked > 50, `${name}: checked ${checked} ${mesh.name}`);
      }
    }
    view.setPrefs({ theme: 'classic', assist: 'preview' });
    assert.equal(view.themeName, 'classic');
    view.setTheme('no-such-theme');
    assert.equal(view.themeName, 'night', "unknown names fall back to 'night'");
  });

  quietTest('the sun/moon faces are drawn on canvases without errors, and sunHit shows the shocked face for ~2 s', () => {
    const before = doc.canvases.length;
    const { scene, view } = stage();
    const game = humanGame(61);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    for (const name of THEME_NAMES) view.setTheme(name); // draws every theme's faces
    view.setTheme('night');
    const made = doc.canvases.slice(before);
    assert.ok(made.length >= 3 * THEME_NAMES.length, `${made.length} face canvases`);
    for (const c of made) {
      assert.ok(c.context && c.context.calls > 20, 'face canvas was drawn');
      assert.deepEqual(c.context.ignored, [], 'canvas input a browser would ignore');
    }

    const sun = parts.sun(scene);
    frame(game, view);
    const normal = sun.material.map;
    assert.ok(normal.image instanceof FakeCanvas, 'the face is a canvas texture');
    view.onEvent('sunHit', { x: 72, y: 86 }, game);
    frame(game, view);
    const shocked = sun.material.map;
    assert.notEqual(shocked, normal, 'the face changes on sunHit');
    for (let t = DT; t < 1.9; t += DT) {
      frame(game, view);
      assert.equal(sun.material.map, shocked, `still shocked at ${t.toFixed(2)} s`);
    }
    for (let t = 0; t < 0.3; t += DT) frame(game, view);
    assert.notEqual(sun.material.map, shocked, 'back to normal after ~2 s');
  });
});

describe('GameView wind', () => {
  quietTest('roof flags stand by each monkey, blow downwind and fall with their roof; wind particles drift with the wind', () => {
    const { scene, view } = stage();
    const game = humanGame(1234);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    frame(game, view);
    const flags = [0, 1].map((i) => parts.flag(scene, i));
    for (const i of [0, 1]) {
      const f = flags[i];
      const m = game.monkeys[i];
      assert.ok(Math.abs(f.position.x - m.x) < 6 && near(f.position.y, m.y), `flag ${i} at ${f.position.toArray()} is on monkey ${i}'s roof`);
      assert.equal(f.visible, game.city.solidAt(f.position.x, f.position.y - 0.5), `flag ${i} shown exactly when its pole stands on the roof`);
    }
    const shown = [0, 1].filter((i) => flags[i].visible);
    assert.ok(shown.length > 0, 'test setup: a flag is up');

    // Horizontal reach of the cloth from its pole (world scale 1).
    const reach = (i) => {
      scene.updateMatrixWorld(true); // nothing renders here, so world matrices are only as fresh as we make them
      return new THREE.Box3().setFromObject(parts.flagCloth(scene, i), true).getCenter(new THREE.Vector3()).x - flags[i].position.x;
    };
    const reaches = {};
    for (const wind of [12, -12, 0]) {
      game.wind = wind;
      view.onEvent('wind', { wind }, game);
      for (let k = 0; k < 30; k++) frame(game, view);
      reaches[wind] = shown.map(reach);
    }
    for (const [k, i] of shown.entries()) {
      assert.ok(reaches[12][k] > 0.5, `flag ${i} blows right in a right wind (${reaches[12][k]})`);
      assert.ok(reaches[-12][k] < -0.5, `flag ${i} blows left in a left wind (${reaches[-12][k]})`);
      assert.ok(Math.abs(reaches[0][k]) < Math.abs(reaches[12][k]) * 0.6, `flag ${i} droops without wind (${reaches[0][k]})`);
    }

    const particles = scene.getObjectByName('windParticles');
    const xs = () => Array.from({ length: particles.count }, (_, i) => particles.instanceMatrix.array[i * 16 + 12]);
    for (const wind of [10, -10]) {
      game.wind = wind;
      frame(game, view);
      const x0 = xs();
      frame(game, view, [], 0.1);
      const moved = xs().map((x, i) => x - x0[i]).filter((dx) => Math.abs(dx) < 50); // skip wrap-arounds
      assert.ok(moved.length > particles.count * 0.9, 'most particles did not wrap');
      assert.ok(moved.every((dx) => Math.sign(dx) === Math.sign(wind)), `every particle drifts with wind ${wind}`);
    }

    // Blow the roof away under a flag: the flag goes with it.
    const i = shown[0];
    const f = flags[i];
    const removed = game.city.carve(f.position.x, f.position.y - 1, 3);
    view.onEvent('crater', { x: f.position.x, y: f.position.y - 1, radius: 3, removed }, game);
    frame(game, view);
    assert.equal(flags[i].visible, false, `flag ${i} fell with its roof`);
  });
});

describe('GameView flying banana', () => {
  quietTest('the banana flies with a short trail behind it that fades right after the impact', () => {
    const { scene, view } = stage();
    const game = humanGame(1234);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    frame(game, view);
    const trail = parts.trail(scene);
    assert.equal(trail.visible, false, 'no trail before a throw');
    for (const [player, shot] of [[0, MISS], [1, { angle: 60, power: 70 }]]) {
      runUntil(game, view, () => game.humanTurn && game.turn === player, { label: `turn ${player}` });
      assert.ok(game.throwShot(shot));
      let flight = 0;
      while (game.banana) {
        frame(game, view);
        if (!game.banana) break;
        flight++;
        const b = game.banana;
        if (flight < 3) continue;
        assert.equal(trail.visible, true, `throw ${player} frame ${flight}: trail visible`);
        const n = trail.geometry.drawRange.count / 12 + 1; // ribbon: 4 vertices per sample
        const p = trail.geometry.attributes.position.array;
        const reach = Math.hypot(b.vx, b.vy) * 0.45 + 2; // ~0.4 s of flight
        for (let v = 0; v < n * 4; v++) {
          const d = Math.hypot(p[v * 3] - b.x, p[v * 3 + 1] - b.y);
          assert.ok(d <= reach, `throw ${player} frame ${flight}: trail vertex ${d.toFixed(1)} m from the banana (max ${reach.toFixed(1)})`);
        }
      }
      assert.ok(flight > 30, `throw ${player}: ${flight} flight frames`);
      assert.equal(parts.banana(view).visible, false, 'banana gone at the impact');
      for (let t = 0; t < 0.5; t += DT) frame(game, view);
      assert.equal(trail.visible, false, `throw ${player}: trail faded 0.5 s after the impact`);
    }
  });
});

describe('GameView aim display', () => {
  quietTest('on a human turn an arrow leaves the hand at the aim angle (facing-aware) and grows with power', () => {
    const { scene, view } = stage();
    const game = humanGame(1234);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    const arrow = parts.arrow(view);
    const q = new THREE.Quaternion();
    const checkArrow = (label) => {
      const turn = game.turn;
      const { angle } = game.aim[turn];
      const hand = game.handPosition(turn);
      assert.equal(arrow.visible, true, `${label}: arrow visible`);
      const p = arrow.getWorldPosition(new THREE.Vector3());
      assert.ok(near(p.x, hand.x, 1e-9) && near(p.y, hand.y, 1e-9), `${label}: arrow starts at the hand`);
      const d = new THREE.Vector3(1, 0, 0).applyQuaternion(arrow.getWorldQuaternion(q));
      const a = (angle * Math.PI) / 180;
      const facing = game.monkeys[turn].facing;
      assert.ok(Math.hypot(d.x - Math.cos(a) * facing, d.y - Math.sin(a), d.z) < 1e-6, `${label}: direction ${d.toArray()}`);
    };
    const arrowSize = () => {
      scene.updateMatrixWorld(true);
      return new THREE.Box3().setFromObject(arrow).getSize(new THREE.Vector3()).length();
    };

    game.setAim(0, 30, 20);
    frame(game, view);
    checkArrow('player 0, 30 deg');
    const short = arrowSize();
    game.setAim(0, 70, 90);
    frame(game, view);
    checkArrow('player 0, 70 deg');
    assert.ok(arrowSize() > short * 1.5, `arrow length grows with power (${short} -> ${arrowSize()})`);

    view.setPrefs({ assist: 'off' });
    frame(game, view);
    assert.equal(arrow.visible, false, "assist 'off' hides the arrow");
    view.setPrefs({ assist: 'preview' });
    frame(game, view);
    const dots = parts.previewDots(view);
    assert.equal(dots.visible, true, 'preview dots');
    assert.ok(dots.count > 3, `${dots.count} preview dots`);
    const path = game.previewPath(0, 70, 90);
    const first = new THREE.Matrix4();
    dots.getMatrixAt(0, first);
    const fp = new THREE.Vector3().setFromMatrixPosition(first);
    assert.ok(Math.hypot(fp.x - path[1].x, fp.y - path[1].y) < 1e-4, `first dot ${fp.toArray()} on game.previewPath ${JSON.stringify(path[1])}`); // float32 matrices
    view.setLocalPlayer(0);
    frame(game, view);
    assert.equal(arrow.visible, false, 'no arrow while you stand in the aiming monkey (VR)');
    assert.equal(dots.visible, false);
    view.setLocalPlayer(null);
    view.setPrefs({ assist: 'arrow' });
    frame(game, view);
    assert.equal(dots.visible, false, "assist 'arrow': no preview");

    // Throw: no arrow in flight; then player 1 aims leftward; after both threw, each sees their last path.
    assert.ok(game.throwShot(MISS));
    frame(game, view);
    assert.equal(arrow.visible, false, 'no arrow during flight');
    runUntil(game, view, () => game.humanTurn && game.turn === 1, { label: 'turn 1' });
    frame(game, view);
    checkArrow('player 1');
    assert.equal(parts.lastShot(view).visible, false, 'player 1 has no last shot yet');
    assert.ok(game.throwShot(MISS));
    runUntil(game, view, () => game.humanTurn && game.turn === 0, { label: 'turn 0 again' });
    frame(game, view);
    const line = parts.lastShot(view);
    assert.equal(line.visible, true, "player 0's last banana path is drawn");
    assert.ok(line.geometry.drawRange.count > 2, `${line.geometry.drawRange.count} trace dots`);
  });
});

describe('GameView dispose', () => {
  quietTest('dispose() empties the scene and disposes every geometry, material and texture it created', () => {
    for (const quality of ['high', 'quest']) {
      const { scene, world, view } = stage({ quality });
      const game = cpuMatch(7, ['hard', 'hard'], { targetScore: 1 });
      wire(game, [view]);
      view.setGame(game);
      game.start();
      view.setTheme('sunset');
      view.setPrefs({ assist: 'preview' });
      for (let i = 0; i < 60 * 8; i++) frame(game, view);
      view.onEvent('sunHit', { x: 72, y: 86 }, game);
      view.onEvent('impact', { kind: 'monkey', x: 60, y: 30, radius: 6.5, victim: null, thrower: 0 }, game);
      view.update(DT, game);

      const resources = collectResources(scene);
      const disposed = new Set();
      for (const r of resources.keys()) r.addEventListener('dispose', () => disposed.add(r));
      view.dispose();
      const leaked = [...resources].filter(([r]) => !disposed.has(r)).map(([, label]) => label);
      assert.deepEqual(leaked, [], `${quality}: not disposed`);
      assert.deepEqual(scene.children, [world], `${quality}: only the world group is left in the scene`);
      assert.deepEqual(world.children, [], `${quality}: the world group is empty`);
      assert.equal(scene.fog, null);
      assert.equal(scene.background, null);
      game.destroy();
    }
    // A view that never had a game disposes too, and a new view works afterwards (shared resources rebuilt).
    stage().view.dispose();
    const { scene, view } = stage();
    const game = humanGame(9);
    wire(game, [view]);
    view.setGame(game);
    game.start();
    frame(game, view);
    checkFrame(view, game, { label: 'new view after dispose' });
    assertCityDrawn(scene, game.city, 'new view after dispose');
  });
});

// ------------------------------------------------------------------------------------------------ PCCamera

describe('PCCamera', () => {
  const SIZES = [[1920, 1080], [1280, 720], [800, 1000], [390, 844]];

  function settledCamera(game, [w, h], inset = 0) {
    const cam = new PCCamera();
    cam.resize(w, h);
    cam.setBottomInset(inset);
    cam.update(DT, game); // the first update jumps straight to the framing
    return cam;
  }

  quietTest('worldToScreen and screenToWorld are inverse on the play plane', () => {
    const game = humanGame(3);
    game.start();
    for (const size of SIZES) {
      const cam = settledCamera(game, size);
      for (let x = 0; x <= CITY_WIDTH; x += 12) {
        for (let y = 0; y <= 80; y += 10) {
          const s = cam.worldToScreen(x, y);
          const w = cam.screenToWorld(s.x, s.y);
          assert.ok(Math.hypot(w.x - x, w.y - y) < 1e-6, `${size}: (${x}, ${y}) -> ${JSON.stringify(s)} -> ${JSON.stringify(w)}`);
        }
      }
      // The image is not stretched for this aspect ratio: a meter across and a meter up measure about the same.
      const c = cam.worldToScreen(72, 30);
      const r = cam.worldToScreen(73, 30);
      const u = cam.worldToScreen(72, 31);
      const ratio = Math.hypot(r.x - c.x, r.y - c.y) / Math.hypot(u.x - c.x, u.y - c.y);
      assert.ok(Math.abs(ratio - 1) < 0.05, `${size}: horizontal/vertical pixels per meter ${ratio}`);
      for (let px = 0; px <= size[0]; px += size[0] / 8) {
        for (let py = 0; py <= size[1]; py += size[1] / 8) {
          const w = cam.screenToWorld(px, py);
          const s = cam.worldToScreen(w.x, w.y, 0);
          assert.ok(Math.hypot(s.x - px, s.y - py) < 1e-6, `${size}: pixel (${px}, ${py}) round trip ${JSON.stringify(s)}`);
        }
      }
    }
  });

  quietTest('frames both monkeys, the street ±16 m around them and the tallest roof between, at any aspect ratio', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const game = humanGame(seed);
      game.start();
      const [m0, m1] = game.monkeys;
      const x0 = Math.max(0, Math.min(m0.x, m1.x) - 16);
      const x1 = Math.min(CITY_WIDTH, Math.max(m0.x, m1.x) + 16);
      const points = [[x0, 0, 'street left'], [x1, 0, 'street right']];
      for (const m of game.monkeys) {
        for (const dx of [-MONKEY.width / 2, MONKEY.width / 2]) {
          for (const dy of [0, MONKEY.height]) points.push([m.x + dx, m.y + dy, `monkey ${m.index}`]);
        }
      }
      for (const b of game.city.buildings) {
        const bx0 = Math.max(b.col0 * CELL, x0);
        const bx1 = Math.min(b.col1 * CELL, x1);
        const sky = b.height * CELL + 3; // a little sky above every roof of the stretch
        if (bx0 < bx1) points.push([bx0, sky, `above roof ${b.id}`], [bx1, sky, `above roof ${b.id}`]);
      }
      for (const size of SIZES) {
        const cam = settledCamera(game, size);
        for (const [x, y, what] of points) {
          assert.ok(onScreen(cam, x, y), `seed ${seed} ${size}: ${what} (${x}, ${y}) at ${JSON.stringify(cam.worldToScreen(x, y))}`);
        }
      }
    }

    // A 92 m tower between two low roofs (the height decides the framing even on wide screens), and one just outside
    // the stretch that may be cut off.
    const game = humanGame(1);
    game.start();
    game.city = makeCity([
      { col0: 15, col1: 25, row1: 10 }, { col0: 33, col1: 38, row1: 46 }, { col0: 45, col1: 55, row1: 10 },
    ]);
    Object.assign(game.monkeys[0], { x: 40, y: 20 });
    Object.assign(game.monkeys[1], { x: 100, y: 20 });
    for (const size of SIZES) {
      const cam = settledCamera(game, size);
      for (const x of [66, 76]) {
        assert.ok(onScreen(cam, x, 95), `${size}: above the tower (${x}, 95) at ${JSON.stringify(cam.worldToScreen(x, 95))}`);
      }
      for (const m of game.monkeys) assert.ok(onScreen(cam, m.x, m.y) && onScreen(cam, m.x, m.y + MONKEY.height));
    }
  });

  quietTest('moves smoothly to a new framing (no cut) and settles on it', () => {
    const a = humanGame(11);
    a.start();
    const b = humanGame(12);
    b.start();
    const cam = settledCamera(a, [1280, 720]);
    for (let i = 0; i < 60; i++) cam.update(DT, a);
    const from = cam.camera.position.clone();
    const goal = settledCamera(b, [1280, 720]).camera.position.clone();
    const total = from.distanceTo(goal);
    assert.ok(total > 1, `test setup: the framings differ (${total})`);
    cam.update(DT, b);
    assert.ok(cam.camera.position.distanceTo(from) < 0.25 * total, 'one frame moves only part of the way');
    for (let i = 0; i < 60 * 8; i++) cam.update(DT, b);
    assert.ok(cam.camera.position.distanceTo(goal) < 0.01 * total, `settled within ${cam.camera.position.distanceTo(goal)}`);
  });

  quietTest('keeps the flying banana (and in overview the monkeys) on screen through whole matches; follow mode closes in', () => {
    const cams = [];
    for (const size of [[1280, 720], [390, 844]]) {
      for (const follow of [false, true]) {
        const cam = new PCCamera();
        cam.resize(...size);
        cam.setFollow(follow);
        assert.equal(cam.follow, follow);
        cams.push({ cam, label: `${size} follow=${follow}`, follow, pxPerM: 0 });
      }
    }
    let flightFrames = 0;
    for (const seed of [1, 2]) {
      const game = cpuMatch(seed, ['normal', 'easy'], { targetScore: 1 });
      wire(game, cams.map((c) => c.cam));
      game.start();
      for (let f = 0; game.phase !== 'matchOver'; f++) {
        assert.ok(f < MAX_MATCH_FRAMES, 'match did not finish');
        frame(game, null, cams.map((c) => c.cam));
        const b = game.banana;
        if (b) flightFrames++;
        for (const c of cams) {
          if (b) {
            assert.ok(onScreen(c.cam, b.x, b.y), `seed ${seed} frame ${f} ${c.label}: banana (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) at ${JSON.stringify(c.cam.worldToScreen(b.x, b.y))}`);
            const s0 = c.cam.worldToScreen(b.x, b.y);
            const s1 = c.cam.worldToScreen(b.x + 1, b.y);
            c.pxPerM += Math.hypot(s1.x - s0.x, s1.y - s0.y);
          }
          if (!c.follow) {
            for (const m of game.monkeys) {
              if (!m.alive) continue;
              assert.ok(onScreen(c.cam, m.x, m.y) && onScreen(c.cam, m.x, m.y + MONKEY.height),
                `seed ${seed} frame ${f} ${c.label}: monkey ${m.index} off screen`);
            }
          }
        }
      }
      game.destroy();
    }
    assert.ok(flightFrames > 300, `${flightFrames} flight frames`);
    for (let i = 0; i < cams.length; i += 2) {
      const [overview, follow] = [cams[i], cams[i + 1]];
      assert.ok(follow.pxPerM > 1.3 * overview.pxPerM, `${follow.label} ${follow.pxPerM / flightFrames} px/m vs ${overview.pxPerM / flightFrames}`);
    }
  });

  quietTest('a banana far above the frame widens the view to keep it visible, then the camera settles back', () => {
    const game = humanGame(13);
    game.start();
    for (const size of [[1280, 720], [390, 844]]) {
      const plain = settledCamera(game, size);
      const cam = settledCamera(game, size);
      const lofted = { monkeys: game.monkeys, city: game.city, banana: { x: 72, y: 400, vx: 0, vy: 0, spin: 0 } };
      assert.equal(onScreen(cam, 72, 400), false, 'test setup: the banana starts above the frame');
      for (let i = 0; i < 60 * 3; i++) cam.update(DT, lofted);
      assert.ok(onScreen(cam, 72, 400), `${size}: banana on screen`);
      for (const m of game.monkeys) assert.ok(onScreen(cam, m.x, m.y + MONKEY.height), `${size}: monkey ${m.index} still on screen`);
      for (let i = 0; i < 60 * 10; i++) cam.update(DT, game);
      assert.ok(cam.camera.position.distanceTo(plain.camera.position) < 0.05, `${size}: settled back`);
    }
  });

  quietTest('setBottomInset keeps the monkeys above a bottom overlay of that height', () => {
    // ~28% of the screen, and the real aim panel (~196 px) on landscape phones, where it covers half the screen.
    const cases = [...SIZES.map(([w, h]) => [[w, h], Math.round(h * 0.28)]), [[844, 390], 196], [[667, 375], 196]];
    for (const [size, inset] of cases) {
      const [w, h] = size;
      for (let seed = 1; seed <= 10; seed++) {
        const game = humanGame(seed);
        game.start();
        const plain = settledCamera(game, size, 0);
        const cam = settledCamera(game, size, inset);
        for (const m of game.monkeys) {
          const feet = cam.worldToScreen(m.x, m.y);
          const head = cam.worldToScreen(m.x, m.y + MONKEY.height);
          const where = `${size} inset ${inset} seed ${seed} monkey ${m.index}`;
          assert.ok(feet.y <= h - inset, `${where}: feet at y=${feet.y.toFixed(1)}, overlay starts at ${h - inset}`);
          assert.ok(head.y >= 0 && feet.x >= 0 && feet.x <= w, `${where}: on screen (${feet.x.toFixed(1)}, ${head.y.toFixed(1)})`);
          assert.ok(feet.y < plain.worldToScreen(m.x, m.y).y, `${where}: lifted compared with no inset`);
        }
      }
    }
    const game = humanGame(1);
    game.start();
    const zero = settledCamera(game, [1280, 720], 0).camera.position;
    for (const bad of [-50, NaN, undefined, 'tall']) {
      const pos = settledCamera(game, [1280, 720], bad).camera.position;
      assert.ok(pos.distanceTo(zero) < 1e-9, `setBottomInset(${bad}) acts like 0`);
    }
  });

  quietTest('impacts shake the camera (monkey > building > ground, none for out) and the shake dies down', () => {
    const game = humanGame(14);
    game.start();
    const amplitude = {};
    for (const kind of ['out', 'ground', 'building', 'monkey']) {
      const still = settledCamera(game, [1280, 720]);
      const shaken = settledCamera(game, [1280, 720]);
      shaken.onEvent('impact', { kind, x: 50, y: 20, radius: 3.4 }, game);
      let max = 0;
      for (let i = 0; i < 30; i++) {
        still.update(DT, game);
        shaken.update(DT, game);
        max = Math.max(max, still.camera.position.distanceTo(shaken.camera.position));
      }
      amplitude[kind] = max;
      for (let i = 0; i < 180; i++) {
        still.update(DT, game);
        shaken.update(DT, game);
      }
      assert.ok(still.camera.position.distanceTo(shaken.camera.position) < 1e-3, `${kind}: shake gone after 3.5 s`);
    }
    assert.equal(amplitude.out, 0);
    assert.ok(amplitude.ground > 0 && amplitude.building > amplitude.ground && amplitude.monkey > amplitude.building,
      JSON.stringify(amplitude));
  });

  quietTest('update/onEvent with no game, a half-made game or bad numbers never throw and keep a finite pose', () => {
    const cam = new PCCamera();
    cam.resize(0, NaN); // clamps to at least 1x1
    cam.resize(1280, 720);
    const odd = [null, undefined, {}, { monkeys: [] }, { monkeys: [{ x: NaN, y: 1 }, null] },
      { banana: { x: NaN, y: Infinity } }, { city: { buildings: [] }, monkeys: [{ x: 10, y: 20 }, { x: 100, y: 30 }] }];
    for (const g of odd) {
      for (const dt of [DT, 0, -1, NaN, Infinity, undefined]) cam.update(dt, g);
      cam.onEvent('impact', undefined, g);
      cam.onEvent('impact', null, g);
      cam.onEvent('impact', { kind: 'nonsense' }, g);
      cam.onEvent('roundStart', {}, g);
    }
    cam.setFollow(1);
    assert.equal(cam.follow, true);
    cam.update(DT, { banana: { x: 50, y: 60, vx: 3, vy: 1 } });
    cam.setFollow(0);
    assert.equal(cam.follow, false);
    cam.update(DT, null);
    const p = cam.camera.position;
    assert.ok([p.x, p.y, p.z].every(Number.isFinite), `camera at ${p.toArray()}`);
    const s = cam.worldToScreen(72, 20);
    const w = cam.screenToWorld(640, 360);
    assert.ok([s.x, s.y, w.x, w.y].every(Number.isFinite));
    assert.ok(onScreen(cam, 72, 20), 'without a game the city is framed');
  });
});
