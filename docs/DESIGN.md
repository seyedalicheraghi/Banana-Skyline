# Banana Skyline — design and module contracts

A modern take on the 1990s "two gorillas throwing bananas over a skyline" game. Two monkeys stand
on rooftops; players take turns throwing a banana (angle + power) across a destructible city while
gravity and wind bend its path. Hit the other monkey to win the round. First to N points wins.

Runs from one codebase in two ways:

- **PC**: desktop browser at `http://localhost:8080` (`npm start`). Side-on 3D view, mouse/keyboard.
- **Meta Quest**: Quest Browser at the same URL through `adb reverse tcp:8080 tcp:8080` over USB
  (`localhost` is a secure context, so WebXR works). "Enter VR" puts you on your monkey's rooftop; you
  physically swing and release to throw, or use the thumbstick aim mode.
- **Quest app**: `npm run deploy` publishes a static build to GitHub Pages
  (`https://seyedalicheraghi.github.io/Banana-Skyline/`). `npm run apk` wraps that address in an Android
  package (a Bubblewrap Trusted Web Activity in Meta's immersive app mode; 2D mode has no WebXR) and
  installs it with adb. The app opens the site with `?app`, and `main.js` then enters VR at once
  (`src/app/launch.js`: the icon tap counts as the user activation). The site's origin must publish
  `/.well-known/assetlinks.json` for the app, or an immersive app does not launch. A service worker
  caches the whole build, so the app starts offline after its first run.
- **Desktop app** (Steam / itch.io): `npm run desktop:build` wraps the same `dist/` in an Electron window
  (`desktop/main.mjs`) and packages it with electron-builder: a Windows installer and a portable exe in
  `desktop/out/`. Flat screen only: Electron has no OpenXR, so there is no WebXR there.

No build step for development (`npm run build` only assembles `dist/` for publishing). ES modules served as-is. `index.html` has an import map:
`"three"` → `/node_modules/three/build/three.module.js`, `"three/addons/"` → `/node_modules/three/examples/jsm/`.
Only runtime dependency: `three@0.186.1`. Dev-only: `iwer@2.5.0` (Meta's WebXR emulator), loaded only with `?emulate` to try VR mode without a headset. No CDN or network assets: everything (models, textures, sounds) is
generated in code, so the game works offline on the headset.

## Coordinates and units

- World units are meters. The **play plane** is z = 0: x to the right, y up, y = 0 is the street.
- City spans x ∈ [0, 144] (`CITY_WIDTH`), grid of `COLS`×`ROWS` = 72×48 cells of `CELL` = 2 m.
- Buildings are drawn with depth `BUILDING_DEPTH` (12 m) centered on z = 0. Physics ignores z.
- Player 0 stands on the left and faces +x (`facing = 1`); player 1 on the right faces −x.
- Angles are degrees from horizontal toward the opponent (90 = straight up). Power is 0..100 →
  speed `power * 0.6` m/s.
- In VR the whole `world` group is scaled by `VR_SCALE` (0.4) so a 5 m monkey feels person-sized.
  Physics never sees the scale.

All tunables live in `src/core/constants.js`. Read it.

## Source layout and owners

| Path | What | Notes |
|---|---|---|
| `src/core/` | Pure game logic, no DOM, no three.js | constants, rng, events, city, physics, ai, game. Unit-tested in Node. |
| `src/app/` | `main.js` (wiring + loop), `prefs.js` (localStorage prefs), `launch.js` (`?app`: started as the Quest app, enter VR at once) | Integration layer. |
| `src/render/` | Everything drawn with three.js: city, sky, monkeys, banana, effects, PC camera | `GameView`, `PCCamera` |
| `src/ui/` | DOM overlay: title/menus, HUD, PC input (mouse/keyboard/typed), CSS | `UI` |
| `src/audio/` | Synthesized WebAudio sound effects and jingles | `Sfx` |
| `src/xr/` | WebXR: session, rig, controllers/hands, throwing, VR panels | `XRMode` |
| `tests/` | `node --test` unit tests for `src/core` | |
| `desktop/` | The Electron app: `main.mjs` (one 1280×720 window, the privileged `app://` scheme serving `dist/`, sandboxed page without Node, no new windows, no navigation or network elsewhere, F11 full screen), `files.mjs` (request → file in `dist/`, types, 404 for anything else), `icon.mjs` (.ico from `scripts/icons.mjs`), `electron-builder.json` (targets, `desktop/out/`) | `tests/desktop.test.mjs` |
| `scripts/desktop.mjs` | Builds `dist/`, writes `desktop/build/icon.{ico,png}`, then runs Electron (`npm run desktop`) or electron-builder (`npm run desktop:build`: Windows x64 NSIS installer + portable exe; `-- --mac` / `-- --linux` on those machines) | |
| `server.mjs` | Zero-dependency static server, 127.0.0.1:8080 | |
| `scripts/quest.mjs` | adb helper: find headset, reverse port, open the game in Quest Browser |
| `scripts/build.mjs` | `dist/`: index.html with the import map pointed at `lib/`, `src/` as is, the three.js files reached from `src/` imports, icons (`scripts/icons.mjs`), `manifest.webmanifest`, `sw.js` (from `scripts/sw.js`: precache every file, cache-first, one cache per build hash) | `server.mjs --dist` serves it on 8081 |
| `scripts/deploy.mjs` | Commits `dist/` as the `gh-pages` branch through a temporary index (working tree and branch untouched) and pushes it | |
| `scripts/apk.mjs` + `quest-app/twa-manifest.json` | Bubblewrap update + build, signing key in `quest-app/` (git-ignored), `assetlinks.json`, adb install | |
| `src/app/remote-log.js` | In Quest Browser on localhost (or with `?log`): POSTs load, VR start/end, errors, fps and throws to `/__log`; `server.mjs` prints them as `[headset]` lines | |

Modules talk only through the contracts below. `src/core` must stay importable in Node.

## Core API (`src/core/game.js`) — implemented

```js
const game = new Game(settings); game.start(); // then call game.update(dt) every frame
```

`settings` (all optional, see `normalizeSettings`):
`{ players: [{name, cpu: null|'easy'|'normal'|'hard'}, {...}], targetScore: 3, gravity: 9.8,
   windStrength: 'none'|'calm'|'normal'|'wild', seed: null|int, demo: false }`

State read by other modules (treat as read-only):

- `game.phase`: `'idle' | 'aim' | 'flight' | 'impact' | 'roundOver' | 'matchOver'`
- `game.turn` (0|1), `game.current` (monkey whose turn it is), `game.humanTurn` (bool: a human may throw now)
- `game.round`, `game.scores` [a, b], `game.settings`, `game.isDemo`, `game.wind` (int −15..15; + blows right), `game.gravity`
- `game.city`: `City` — `buildings[] {id, col0, col1, height (cells), color 0..3, windowSeed, roof 0..3}`,
  `grid` (Uint8Array, `grid[row*COLS+col]` = 0 air or building id+1), `isSolid(col,row)`, `solidAt(x,y)`,
  `cellBuilding(col,row)`, `columnTop(col)`.
- `game.monkeys[i]`: `{ index, name, cpu, x, y (feet), facing, alive, falling, anim, animTime }` where
  `anim` ∈ `'idle' | 'throw' | 'fall' | 'dead' | 'victory'` and `animTime` is seconds in that anim.
- `game.banana`: `null` or `{ x, y, vx, vy, t, spin }` (spin = radians to rotate around z).
- `game.aim[i]`: `{ angle, power }` — the current/last aim of each player (kept between turns).
- `game.lastShots[i]`: `null` or `{ angle, power, path: [{x,y}], hit: {kind,x,y} }` — previous throw this round.
- `game.handPosition(i)` → `{x, y}` where the banana leaves the hand.

Commands:

- `game.setAim(player, angle, power)` — clamps (angle 0..180, power 0..100), stores, emits `aim`.
- `game.throwShot({angle, power})` — current player throws (only in phase `'aim'`). Returns bool.
- `game.throwVelocity(vx, vy, origin?)` — VR hand throw in world units/s, origin `{x,y}` in world
  (clamped near the monkey). Humans only. Returns bool.
- `game.previewPath(player, angle, power, seconds=0.8)` → `[{x,y}]` first part of the path (aim assist).
- `game.destroy()` — stop and remove listeners.

CPU turns are automatic: the game plans the CPU shot over several frames and throws after
`TIMING.cpuThink` seconds.

### Events (`game.on(type, fn)` / `game.onAny((type, payload) => ...)`)

| type | payload | when |
|---|---|---|
| `matchStart` | `{settings, seed}` | `start()` |
| `roundStart` | `{round, wind, turn, pattern}` | new city and monkeys are ready (rebuild visuals now) |
| `turn` | `{player, cpu, name}` | a player may aim |
| `cpuThinking` | `{player, level}` | CPU started planning |
| `wind` | `{wind}` | wind changed mid-round ('wild' wind) |
| `aim` | `{player, angle, power}` | aim changed |
| `throw` | `{player, angle, power, x, y, vx, vy, method: 'aim'|'hand'}` | banana launched; `game.banana` is live |
| `sunHit` | `{x, y}` | banana passed through the sun (flight continues) |
| `impact` | `{kind: 'building'|'monkey'|'ground'|'out', x, y, radius, victim, thrower}` | banana stopped |
| `crater` | `{x, y, radius, removed: [{col,row,building}]}` | cells removed from `game.city.grid` |
| `monkeyHit` | `{victim, thrower, selfHit}` | a monkey was blown up |
| `monkeyFall` | `{player, fromY, toY}` | roof gone, monkey drops (y animates in core) |
| `monkeyLand` | `{player, y}` | landed |
| `roundOver` | `{winner, scores, selfHit, matchPoint}` | point awarded; winner's anim = 'victory' |
| `matchOver` | `{winner, scores}` | match finished; game stays in 'matchOver' |

## App wiring (`src/app/main.js`)

- One `THREE.WebGLRenderer` (`xr.enabled = true`), one `THREE.Scene`, and a `world` group (all game
  content lives in `world` so VR can scale it).
- On load, a **demo match** (`demo: true`, CPU vs CPU) plays behind the title screen.
- `startMatch(settings)` destroys the old game, creates a new one, forwards every event with
  `game.onAny((type, p) => { view.onEvent(type, p, game); pcCamera.onEvent(type, p, game); sfx.onEvent(type, p, game); ui.onEvent(type, p, game); xr.onEvent(type, p, game); })`,
  calls `view.setGame(game)`, `ui.setGame(game)`, `xr.setGame(game)`, then `game.start()`.
- Per frame (`renderer.setAnimationLoop`): `game.update(dt)` unless paused → `view.update(dt, game)` →
  `xr.active ? xr.update(dt, frame, game) : pcCamera.update(dt, game)` → `sfx.update(dt, game)` →
  `ui.update(dt, game)` → `renderer.render(scene, xr.active ? xr.camera : pcCamera.camera)`.
- Prefs (`src/app/prefs.js`): `{ theme: 'night'|'sunset'|'classic', sound: bool, volume: 0..1,
  assist: 'off'|'arrow'|'preview', lastSettings, vrThrow: 'hand'|'stick', vrBoost: 'low'|'normal'|'high' }`. `main` applies them via
  `view.setPrefs(prefs)`, `sfx.setEnabled/setVolume`, `xr.setPrefs(prefs)`, `ui.setPrefs(prefs)`.
- `quality`: `'quest'` when `navigator.userAgent` contains `OculusBrowser` or `Quest`, else `'high'`.

## `GameView` (`src/render/view.js`)

```js
const view = new GameView({ renderer, scene, world, quality: 'high'|'quest' });
```

- `setGame(game)` — remember the game; if `game.city` exists, build it.
- `onEvent(type, payload, game)` — react: `roundStart` → rebuild city meshes, monkeys, roof flags;
  `crater` → remove destroyed cells (update instanced meshes), spawn debris in the building's color;
  `impact` → explosion (big for `monkey`, puff for `ground`, none for `out`); `sunHit` → sun face
  "shocked" for ~2 s; `throw` → banana trail starts; `wind` → flags/particles update.
- `update(dt, game)` — per frame: place monkeys at `(m.x, m.y, 0)` and animate from `m.anim`/`m.animTime`
  (idle breathing/blink, throw arm swing, fall flail, dead = hidden after explosion, victory = arms up
  dance); banana at `(b.x, b.y, 0)` rotated by `b.spin` with a short glowing trail; particles; flags
  and wind particles from `game.wind`; aim arrow and assist (below).
- Aim display: when `game.humanTurn` and the current monkey is not hidden by `setLocalPlayer`,
  draw an arrow from `game.handPosition(turn)` in the direction of `game.aim[turn].angle` (respect
  facing) with length proportional to power. If `prefs.assist === 'preview'`, also draw
  `game.previewPath(...)` as dots (cache by angle/power). `'off'` hides the arrow.
  Also draw `game.lastShots[turn].path` as a faint dotted line ("where my last banana went").
- `setPrefs(prefs)` — theme (`'night'` default, `'sunset'`, `'classic'` = blue sky / red-cyan-grey
  buildings / yellow windows like the original), assist mode.
- `setTheme(name)`.
- `setLocalPlayer(index|null)` — in VR, hide that monkey's body (you are that monkey); `null` shows both.
- A player-colored arrow floats over each live monkey (drawn on top of buildings, bobbing over the one whose turn it is).
- `setXRScale(s)` — set `world.scale` to s (1 on PC, `VR_SCALE` in VR) and adjust anything
  scale-dependent outside `world` (fog distances, sky dome). Sky/stars/fog may live outside `world`.
- `createBananaMesh()` → a new banana `Object3D` (≈0.9 m long in world units) for the VR hand.
- `monkeyAnchor(index, target = new THREE.Vector3())` → feet position of a monkey in scene coordinates
  (after world scale).
- `dispose()`.
- Performance: `quality === 'quest'` must hold 72–90 fps on Quest 2/3: instanced meshes for cells and
  windows, no shadows, cheap materials (Lambert/basic + emissive), few lights, capped particles,
  no post-processing. `'high'` may add shadows, antialias-friendly details.

## `PCCamera` (`src/render/camera.js`)

```js
const pcCamera = new PCCamera(); // PerspectiveCamera looking at the play plane from +z
```

- `camera` — the `THREE.PerspectiveCamera`.
- `resize(width, height)`.
- `update(dt, game)` — smoothly frame the stretch between the two monkeys (±16 m, within the city) from the street to above the tallest building in that stretch
  for the current aspect ratio; slight 3/4 angle so building depth shows; when the banana flies above
  the frame, zoom out/pan smoothly to keep it visible; `followBanana` mode (toggle with `C`) chases it.
- `onEvent(type, payload, game)` — camera shake on impacts (bigger for monkey hits).
- `setFollow(bool)`, `get follow`.
- `worldToScreen(x, y, z = 0)` → `{x, y}` in CSS pixels of the canvas.
- `screenToWorld(px, py)` → `{x, y}` on the z = 0 plane.

## `UI` (`src/ui/ui.js`)

```js
const ui = new UI({ root: document.getElementById('ui'), canvas, callbacks });
```

callbacks: `{ startMatch(settings), quitToTitle(), setPaused(bool), enterVR(), prefsChanged(prefs),
toggleFollow(), worldToScreen(x,y,z), screenToWorld(px,py), unlockAudio() }` — `unlockAudio` must be called on
the first user gesture.

- `setGame(game)`, `onEvent(type, payload, game)`, `update(dt, game)`, `setPrefs(prefs)`.
- `setVRSupported(bool)` — show the "Play in VR" button only when true.
- `setXRActive(bool)` — hide DOM overlays while presenting in VR.
- `showTitle()`, `get menuOpen`.
- Title screen over the demo match: game title, "1 Player vs CPU", "2 Players", "Play in VR",
  settings (difficulty, points to win, gravity presets Earth/Moon/Mars/Jupiter/custom, wind
  none/calm/normal/wild, player names, theme, aim assist, sound), short how-to-play.
- HUD during a real match: both names + scores (left/right, colored like each monkey), round,
  wind indicator (arrow whose length ∝ |wind|, label), whose turn, angle/power readout,
  messages ("CPU is thinking…", "Direct hit!", "Ouch, own goal!", "Player 1 wins the match!").
- PC input on a human turn:
  - Mouse: press anywhere, drag; the vector from the thrower's hand (`worldToScreen`) to the pointer
    sets angle and power (longer = stronger, capped); release throws. Escape/right-click cancels.
  - Keyboard: → raises / ← lowers the angle by 1 (Shift 5) for both players, ↑/↓ power ±1 (Shift ±5), Space/Enter throws, P pauses,
    C toggles camera follow, M mutes, Esc opens the pause menu.
  - Typed (the original way): an angle and power box; Enter in power throws.
  - Touch works like mouse.
  All of these call `game.setAim(...)` / `game.throwShot(...)` and only when `game.humanTurn`.
- Match-over screen: winner, final score, Rematch / Menu.
- Pause menu: Resume, Restart, Settings, Quit to title.

## `Sfx` (`src/audio/sfx.js`)

- `new Sfx()`; `unlock()` (create/resume the AudioContext on a user gesture); `setEnabled(bool)`;
  `setVolume(0..1)`.
- `onEvent(type, payload, game)` — ignore everything when `game.isDemo`. throw → whoosh;
  impact building → explosion, ground → thud, monkey → big explosion + monkey yelp; sunHit → "boing";
  monkeyFall → falling whistle; monkeyLand → thump; turn → soft tick; roundOver → short victory jingle;
  matchOver → fanfare; roundStart → city ambience swell.
- `update(dt, game)` — continuous wind ambience scaled by |wind| (quiet), banana whistle while flying
  (pitch follows speed).
- `play(name, {pan})` for UI sounds: `'click'`, `'hover'`, `'error'`.
- All sounds synthesized (oscillators, filtered noise). Original melodies only.

## `XRMode` (`src/xr/xr.js`)

```js
const xr = new XRMode({ renderer, scene, world, view, sfx, getPrefs, setPrefs, startMatch, quitToTitle, onSessionChange });
```

- `static async isSupported()` → `navigator.xr?.isSessionSupported('immersive-vr')`.
- `enter()` — request `immersive-vr` with `local-floor` (optional `bounded-floor`, `hand-tracking`),
  `renderer.xr.setReferenceSpaceType('local-floor')`, `renderer.xr.setSession(session)`.
  On start: `view.setXRScale(VR_SCALE)`; `onSessionChange(true)`. On end: `view.setXRScale(1)`,
  `view.setLocalPlayer(null)`, `onSessionChange(false)`.
- `camera` — `THREE.PerspectiveCamera` inside a `rig` group (render with it while presenting).
- `active` — presenting.
- `setGame(game)`, `onEvent(type, payload, game)`, `update(dt, frame, game)`, `setPrefs(prefs)`.
- Rig: in a real match, stand on the local player's rooftop (`view.monkeyAnchor`), facing the
  opponent. Vs CPU: you are player 0. 2 players: the rig moves (fade to black and back) to whoever's
  turn it is. Demo/menu: a floating overview spot in front of the city. `view.setLocalPlayer(i)`
  hides the monkey you are standing in.
- Hands: simple monkey-glove models on both controllers (no downloaded controller models).
- Throw ("hand" mode, default): on your turn a banana (`view.createBananaMesh()`) appears in your
  dominant hand while you hold trigger or grip; swing and release. Release velocity = controller
  linear velocity (prefer `XRPose.linearVelocity`, else smoothed finite differences over the last
  ~80 ms, peak-weighted), converted from scene to world units (÷ `VR_SCALE`), only the components in
  the play plane (x and y) are kept, multiplied by a throw boost (≈2.5, tune so a comfortable overhand
  throw reaches mid-power), then `game.throwVelocity(vx, vy, originInWorld)`. Ignore releases slower
  than a small threshold (dropped banana → put it back in the hand).
- Throw ("stick" mode): thumbstick Y = angle (push up to raise it), X = power, show the aim arrow, A/X or trigger throws.
- VR panels (canvas textures on planes, readable at ~1.5–2 m): menu (vs CPU easy/normal/hard,
  2 players, throw mode, exit VR) usable with a controller laser + trigger; HUD (names, scores,
  wind arrow, turn, last throw angle/power, messages). Keep text large and high-contrast.
- Comfort: no smooth locomotion, fades for rig moves, no camera shake in VR.
