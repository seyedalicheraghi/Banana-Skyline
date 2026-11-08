// Bow throw math (src/xr/throw.js bowAim) and the bow as the default VR throw.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BOW_FULL_DRAW, BOW_MIN_POWER, BOW_SLACK, bowAim } from '../src/xr/throw.js';
import { DEFAULT_PREFS, sanitizePrefs } from '../src/app/prefs.js';
import { hudState } from '../src/xr/state.js';
import { MENU_ACTIONS } from '../src/xr/menu.js';

const full = BOW_FULL_DRAW;

describe('bowAim', () => {
  test('the banana flies from the string hand toward the bow hand: level, up, back, and never down', () => {
    assert.equal(bowAim({ x: 10, y: 5 }, { x: 9, y: 5 }, full, 1).angle, 0, 'level pull toward the opponent');
    assert.equal(bowAim({ x: 10, y: 6 }, { x: 10, y: 5 }, full, 1).angle, 90, 'straight up');
    assert.equal(bowAim({ x: 10, y: 6 }, { x: 11, y: 5 }, full, 1).angle, 135, 'up and backwards');
    assert.equal(bowAim({ x: 9, y: 5 }, { x: 10, y: 5 }, full, 1).angle, 180, 'backwards');
    assert.equal(bowAim({ x: 11, y: 4 }, { x: 10, y: 5 }, full, 1).angle, 0, 'aiming below the horizon is level');
    assert.equal(bowAim({ x: 11, y: 6 }, { x: 10, y: 5 }, full, 1).angle, 45);
  });

  test('facing -1 mirrors x: player 1 shoots toward smaller x', () => {
    assert.equal(bowAim({ x: 9, y: 6 }, { x: 10, y: 5 }, full, -1).angle, 45);
    assert.equal(bowAim({ x: 11, y: 6 }, { x: 10, y: 5 }, full, -1).angle, 135);
  });

  test('power follows the draw: nothing within the slack, 100 at full draw, no more beyond', () => {
    const at = (meters) => bowAim({ x: 1, y: 0 }, { x: 0, y: 0 }, meters, 1).power;
    assert.equal(at(0), 0);
    assert.equal(at(BOW_SLACK), 0);
    assert.equal(at(BOW_SLACK + (full - BOW_SLACK) / 2), 50);
    assert.equal(at(full), 100);
    assert.equal(at(full + 0.4), 100);
    assert.ok(at(0.12) < BOW_MIN_POWER, 'hands 12 cm apart: letting go, not a shot');
    assert.ok(at(0.2) > BOW_MIN_POWER, 'hands 20 cm apart: a shot');
  });

  test('angle and power come in halves, so a steady draw reads steadily', () => {
    const a = bowAim({ x: 10 + Math.cos(0.3), y: 5 + Math.sin(0.3) }, { x: 10, y: 5 }, 0.3333, 1);
    assert.equal(a.angle * 2, Math.round(a.angle * 2));
    assert.equal(a.power * 2, Math.round(a.power * 2));
    assert.ok(Math.abs(a.angle - 17.19) <= 0.5);
  });

  test('garbage in gives a harmless aim', () => {
    assert.deepEqual(bowAim(null, undefined, NaN, 1), { angle: 0, power: 0 });
    assert.deepEqual(bowAim({ x: 'a', y: 'b' }, {}, -1, 0), { angle: 0, power: 0 });
    assert.deepEqual(bowAim({ x: 1, y: 1 }, { x: 1, y: 1 }, Infinity, 1), { angle: 0, power: 100 });
  });
});

describe('bow mode in prefs, menu and HUD', () => {
  test('the bow is the default VR throw and a valid preference next to hand and stick', () => {
    assert.equal(DEFAULT_PREFS.vrThrow, 'bow');
    for (const vrThrow of ['bow', 'hand', 'stick']) assert.equal(sanitizePrefs({ vrThrow }).vrThrow, vrThrow);
    assert.equal(sanitizePrefs({ vrThrow: 'crossbow' }).vrThrow, 'bow');
  });

  test('the VR menu has a Throw: Bow button', () => {
    assert.ok(MENU_ACTIONS.includes('throw-bow'));
  });

  test('the HUD explains the bow and shows the aim only while the string is pulled', () => {
    const game = {
      turn: 0, phase: 'aim', humanTurn: true, aim: [{ angle: 30, power: 60 }, null], scores: [0, 0], round: 1, wind: 0,
      monkeys: [{ name: 'You', cpu: null, facing: 1 }, { name: 'CPU', cpu: 'normal', facing: -1 }],
      settings: { targetScore: 3, players: [{ name: 'You' }, { name: 'CPU' }] },
    };
    const idle = hudState(game, { local: 0, mode: 'bow' });
    assert.match(idle.hint, /bow/i);
    assert.match(idle.hint, /pull/i);
    assert.equal(idle.lastText, '');
    const drawing = hudState(game, { local: 0, mode: 'bow', drawing: true });
    assert.equal(drawing.lastText, 'Aim: 30° · power 60');
    const stick = hudState(game, { local: 0, mode: 'stick' });
    assert.equal(stick.lastText, 'Aim: 30° · power 60', 'stick mode is always live');
  });
});
