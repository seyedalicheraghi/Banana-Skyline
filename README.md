# Banana Skyline

Two monkeys, a windy skyline, and bananas. A modern 3D take on the 1990s QBasic "Gorillas" game:
take turns throwing a banana over the city, mind the wind and the buildings, and hit the other monkey.
Bananas blow holes in buildings, monkeys fall when their roof is gone, and the moon does not like
being hit.

Plays in a desktop browser and in VR on Meta Quest (WebXR, through Quest Browser over USB).

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

## For developers

- `docs/DESIGN.md`: architecture, coordinates, and the contracts between modules.
- `npm test`: unit tests for the game logic, prefs and server (`node --test`).
- `npm run check`: parses every module, loads them in Node, and verifies every import resolves.
- No build step and no network assets: the browser loads `src/` as ES modules; three.js comes from
  `node_modules` through the import map in `index.html`. Everything you see and hear is generated in code.
- This project uses the [LeanLoop](https://github.com/seyedalicheraghi/LeanLoop) Claude Code plugin:
  `leanloop.json` records the checks (`unit`, `static`) that must pass before a task counts as done.
