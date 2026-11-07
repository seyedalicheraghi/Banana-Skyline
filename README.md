# Banana Skyline

Two monkeys, a windy skyline, and bananas. A modern 3D take on the 1990s QBasic "Gorillas" game:
take turns throwing a banana over the city, mind the wind and the buildings, and hit the other monkey.
Bananas blow holes in buildings, monkeys fall when their roof is gone, and the moon does not like
being hit.

Plays in a desktop browser and in VR on Meta Quest: as an app in the Quest library, or in Quest Browser
served from this PC over USB. Play it in any browser at <https://seyedalicheraghi.github.io/Banana-Skyline/>,
or as a Windows program (the desktop build below, for Steam and itch.io).

## Play on this PC

Needs Node.js 22 or newer.

```bash
npm install
npm start
```

Open <http://localhost:8080> in Chrome or Edge.

Controls on PC:

| Do this | To |
|---|---|
| Press anywhere and drag away from your monkey, then let go | aim (direction = angle, distance = power) and throw |
| ← / → | angle down / up (hold Shift for steps of 5) |
| ↑ / ↓ | power up / down (hold Shift for steps of 5) |
| Space or Enter | throw |
| Type in the Angle and Power boxes, Enter, Enter | throw the original way |
| C | camera follows the banana |
| M | sound on/off |
| P or Esc | pause menu |

Settings on the title screen: vs CPU (Easy / Normal / Hard) or 2 players on one keyboard, points to win,
gravity (Earth, Moon, Mars, Jupiter or your own), wind (none, calm, normal, wild), look (Night,
Sunset, Classic), and an aiming helper (off, arrow, or a short path preview).

## Play on Meta Quest

One-time setup:

1. In the **Meta Horizon** phone app: Devices → your headset → Headset settings → **Developer Mode** on
   (it asks you to create a free developer account at developers.meta.com the first time).
2. Restart the headset and connect it to this PC with a USB-C **data** cable.
3. Put the headset on: a pop-up asks **Allow USB debugging?** Tick "Always allow from this computer"
   and choose **Allow**. (Missed it? Meta button → Notifications.)
4. Install adb once, if you do not have it: `winget install Google.PlatformTools`.

Every time you play:

```bash
npm run quest
```

This finds the headset, starts the game server on this PC, connects the headset to it over the cable
(`adb reverse`), and opens the game in Quest Browser. Put the headset on and press **Play in VR**.
Keep the terminal open while you play: the game reports to it from the headset (`[headset]` lines for
page loads, entering and leaving VR, errors, frame rate, and every throw's angle and power), because there
is no developer console inside a Quest. `node scripts/quest.mjs --status` only checks the connection.

Controls in VR:

| Do this | To |
|---|---|
| On your turn, hold the trigger (or grip) near the glowing banana, swing your arm and let go | throw |
| Point at a panel and pull the trigger | press a button |
| B or Y, or the Menu button on the scoreboard | open/close the menu: Throw: Stick aims with the thumbstick instead; Throw boost High helps if your bananas fall short |
| A or X | rematch when a match is over |

Try VR mode without a headset: open <http://localhost:8080/?emulate> (uses Meta's WebXR emulator, a dev
dependency).

## The Quest app

**Banana Skyline** is installed on the headset as an app: Library → **Unknown Sources** → Banana Skyline.
It runs without this PC and opens straight into VR. The app is a small Android package made with Meta's
[Bubblewrap](https://developers.meta.com/horizon/documentation/web/pwa-packaging/) in Meta's *immersive*
PWA mode: it loads the game published on GitHub Pages with `?app`, and the game then enters VR by itself
(`src/app/launch.js`), since an immersive app has no flat window to put a button in. (Meta's *2D* mode would
give a flat window instead, with no WebXR at all.) It needs Wi-Fi the first time. After that it starts
offline, because a service worker keeps every file of the game on the headset.

### Update the game

```bash
npm run deploy
```

This builds `dist/` and pushes it to the `gh-pages` branch of the GitHub repository, which GitHub Pages
serves at the address above. Nothing has to be reinstalled. The app downloads the new version in the
background the next time it starts, and shows it from the launch after that.

Before publishing, you can try the build:

- `npm run preview` serves `dist/` at <http://localhost:8081>. It uses port 8081 so the build's service
  worker never caches the source tree on 8080.
- `npm run quest -- --dist` opens the same build in Quest Browser over USB, with `[headset]` logs.

### Rebuild and reinstall the app

Only needed when the address, name, icon or signing key change, or for another headset. Connect the
headset as in "Play on Meta Quest" and run:

```bash
npm run apk
```

This regenerates the Android project in `quest-app/` from `quest-app/twa-manifest.json`, then builds and
signs `quest-app/app-release-signed.apk`. It installs the APK with adb and starts the app.

One-time setup on a new PC:

1. `npm install -g @meta-quest/bubblewrap-cli@1.24.1`
2. `bubblewrap doctor`: let it install JDK 17 and the Android SDK (into `~/.bubblewrap`). The first
   `npm run apk` also asks you to accept the Android SDK license for its build tools.
3. The signing key: the first `npm run apk` creates `quest-app/android.keystore` and its passwords in
   `quest-app/signing.json`. Git ignores both files. **Back them up.** An app signed with a different key
   cannot replace the installed one: you would have to run `adb uninstall io.github.seyedalicheraghi.bananaskyline`
   first, which also clears the game's settings.

**Asset links.** An immersive app only launches if the site's origin vouches for it:
`https://seyedalicheraghi.github.io/.well-known/assetlinks.json` must list the app's package and signing
key. `npm run apk` writes that file as `quest-app/assetlinks.json` and checks the published one. It lives in
the GitHub user-site repository [`seyedalicheraghi.github.io`](https://github.com/seyedalicheraghi/seyedalicheraghi.github.io)
(`.well-known/assetlinks.json`, plus an empty `.nojekyll`), not in this one: after a new signing key, copy
the file there and push.

## Desktop build (Steam / itch.io)

Steam and itch.io distribute programs, not web pages, so for them the game ships as a Windows program: the
static build (`dist/`) inside an [Electron](https://www.electronjs.org/) window. It is the flat-screen game
with the PC controls above; there is no VR in it (see below).

```bash
npm run desktop
```

builds `dist/` and opens it in an Electron window from this folder. F11 toggles full screen. To package it:

```bash
npm run desktop:build
```

This builds `dist/`, draws the app icon (`desktop/build/icon.ico`, from `scripts/icons.mjs`: no binary is
committed) and runs electron-builder for Windows x64. The first run downloads Electron and the NSIS tools into
`%LOCALAPPDATA%` caches; after that the build works offline. It writes to `desktop/out/` (git-ignored):

| File | What |
|---|---|
| `BananaSkyline-0.1.0-setup.exe` | Installer (NSIS): per user, asks for the folder, adds a Start menu shortcut and an uninstaller |
| `BananaSkyline-0.1.0-portable.exe` | One file that runs without installing (it unpacks itself to a temporary folder on each start) |
| `win-unpacked/` | The installed program as a folder: `Banana Skyline.exe` plus Electron's files. This is what the stores get |

The exe is not code-signed, so Windows SmartScreen warns the first time someone runs it. Neither store requires
signing; with a certificate, electron-builder signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are set. macOS
(`npm run desktop:build -- --mac`, on a Mac) and Linux (`-- --linux`) targets are configured in
`desktop/electron-builder.json` but have not been built here.

**Steam.** In [Steamworks](https://partner.steamgames.com/), give the app one Windows depot whose content is
the `win-unpacked/` folder and upload it with SteamPipe: `steamcmd +login <account> +run_app_build <app_build.vdf>`
with a depot script pointing at that folder, or the SteamPipe GUI from the Steamworks SDK. The launch option is
`Banana Skyline.exe`. The game has no Steam features, so nothing from the Steamworks SDK goes into the depot, and
no redistributables need to be selected: Electron brings everything it needs on Windows 10 or newer.

**itch.io.** Zip the `win-unpacked/` folder and upload it as a Windows executable, or push the folder with
[butler](https://itch.io/docs/butler/). The portable exe works as a single-file download too.

**No VR in this build.** Official Electron builds have no OpenXR, so WebXR reports no VR support
(`navigator.xr.isSessionSupported('immersive-vr')` is false) and the "Play in VR" button never appears. PC-VR players use the web version: open
<https://seyedalicheraghi.github.io/Banana-Skyline/> in Chrome or Edge with SteamVR set as the OpenXR runtime,
and press Play in VR.

How it works: `desktop/main.mjs` opens one window and serves `dist/` through a privileged `app://` scheme
(`file://` would refuse module scripts and the import map). The page runs sandboxed without Node, cannot open
windows or navigate elsewhere, and every http(s) request is refused: the game needs no network.
`tests/desktop.test.mjs` covers the path mapping (nothing outside `dist/` is served) and the icon file.

## For developers

- `docs/DESIGN.md`: architecture, coordinates, and the contracts between modules.
- `npm test`: unit tests for the game logic, prefs, server, build and desktop app (`node --test`).
- `npm run check`: parses every module, loads them in Node, and verifies every import resolves.
- No build step for development and no network assets: the browser loads `src/` as ES modules; three.js
  comes from `node_modules` through the import map in `index.html`. Everything you see and hear is
  generated in code, the app icon included (`scripts/icons.mjs`).
- `npm run build` only assembles `dist/` for publishing (`scripts/build.mjs`). It copies `src/` as it is,
  plus the three.js files the game imports (under `lib/`), and rewrites the import map. It adds
  `manifest.webmanifest`, the icons, and `sw.js`, the offline cache made from `scripts/sw.js`.
  `?emulate` is not part of the build.
- This project uses the [LeanLoop](https://github.com/seyedalicheraghi/LeanLoop) Claude Code plugin:
  `leanloop.json` records the checks (`unit`, `static`) that must pass before a task counts as done.
