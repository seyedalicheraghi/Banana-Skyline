// What the VR player should see, derived from the game. Pure functions (no three.js, no DOM).

import { MONKEY } from '../core/constants.js';

/** Impacts closer than this to your monkey (world units) rumble both controllers. */
export const RUMBLE_DISTANCE = 8;

/**
 * Where the rig belongs for this game.
 * - demo, no monkeys yet, or CPU vs CPU: the overview spot in front of the city
 * - one human: that player's roof, for the whole match
 * - two humans (hot seat): the roof of whoever's turn it is
 * `key` changes whenever the rig must move (new game, new round, other player).
 * @param {object|null} game
 * @param {number} [serial] increments with every new game object
 * @returns {{kind:'overview'|'roof', player:?number, hotSeat:boolean, key:string}}
 */
export function rigSpot(game, serial = 0) {
  const overview = { kind: 'overview', player: null, hotSeat: false, key: 'overview' };
  const monkeys = game?.monkeys;
  if (!game || game.isDemo || !Array.isArray(monkeys) || monkeys.length < 2) return overview;
  const humans = monkeys.filter((m) => m && !m.cpu).map((m) => m.index);
  if (!humans.length) return overview;
  const hotSeat = humans.length > 1;
  const player = hotSeat ? (game.turn === 1 ? 1 : 0) : humans[0];
  return { kind: 'roof', player, hotSeat, key: `roof:${serial}:${game.round}:${player}` };
}

/** Wind as seen by a player: strength, screen direction (+1 blows right), and tail/headwind when a facing is known. */
export function windInfo(wind, facing = 0) {
  const w = Number(wind) || 0;
  let relative = '';
  if (w !== 0 && facing) relative = w * facing > 0 ? 'tailwind' : 'headwind';
  return { value: Math.abs(w), dir: Math.sign(w), relative };
}

export function playerName(game, i) {
  return game?.monkeys?.[i]?.name ?? game?.settings?.players?.[i]?.name ?? `Player ${i + 1}`;
}

/** "You win" / "Mango wins". */
export function winnerPhrase(name, isYou) {
  return isYou ? 'You win' : `${name} wins`;
}

/** "47° · power 62" (angles can be negative or above 180 for hand throws). */
export function formatShot(shot) {
  if (!shot || !Number.isFinite(shot.angle) || !Number.isFinite(shot.power)) return '';
  return `${Math.round(shot.angle)}° · power ${Math.round(shot.power)}`;
}

/**
 * Plain data for the HUD panel (compared as JSON to decide when to redraw).
 * @param {object} game
 * @param {object} o
 * @param {?number} o.local the player you are standing in (null in the overview)
 * @param {boolean} o.hotSeat
 * @param {'hand'|'stick'} o.mode throw mode
 * @param {Array<?{angle:number,power:number}>} o.lastThrow last throw of each player this round
 * @param {?{text:string, color:string}} o.message transient message
 */
export function hudState(game, { local = null, hotSeat = false, mode = 'hand', lastThrow = [null, null], message = null } = {}) {
  const names = [playerName(game, 0), playerName(game, 1)];
  const turn = game?.turn === 1 ? 1 : 0;
  const cur = game?.monkeys?.[turn];
  const facing = local != null ? game?.monkeys?.[local]?.facing ?? 0 : 0;
  const phase = game?.phase ?? 'idle';
  const myTurn = local != null && local === turn;

  let turnText = '';
  let turnColor = '#ffffff';
  let hint = '';
  if (phase === 'aim' && cur) {
    if (cur.cpu) {
      turnText = `${cur.name} is thinking…`;
      turnColor = '#c9d3f5';
    } else if (myTurn) {
      turnText = hotSeat ? `${cur.name}, your turn!` : 'Your turn!';
      turnColor = '#ffe066';
      hint = mode === 'stick'
        ? 'Stick up/down: angle · left/right: power · trigger throws'
        : 'Grab the banana, swing and let go';
    } else {
      turnText = /^you$/i.test(cur.name) ? 'Your turn' : `${cur.name}'s turn`;
    }
  } else if (phase === 'flight') {
    turnText = 'Banana in the air…';
    turnColor = '#c9d3f5';
  }

  // Your own last throw is what you need to correct the next one; spectators see the current player's.
  const who = local ?? turn;
  const shot = lastThrow?.[who] ?? game?.lastShots?.[who] ?? null;
  let lastText = '';
  if (myTurn && mode === 'stick' && phase === 'aim' && game?.aim?.[turn]) {
    lastText = `Aim: ${formatShot(game.aim[turn])}`;
  } else if (shot) {
    const owner = local != null ? 'Your' : `${names[who]}'s`;
    lastText = `${owner} last throw: ${formatShot(shot)}`;
  }

  const matchOver = phase === 'matchOver' && !game?.isDemo;
  const winner = Number.isInteger(game?.winner) ? game.winner : null;
  return {
    names,
    scores: [game?.scores?.[0] ?? 0, game?.scores?.[1] ?? 0],
    round: game?.round ?? 0,
    target: game?.settings?.targetScore ?? 0,
    wind: windInfo(game?.wind, facing),
    turn,
    turnText,
    turnColor,
    hint,
    lastText,
    message: message ? { text: message.text, color: message.color ?? '#ffe066' } : null,
    matchOver: matchOver ? {
      text: winner != null ? `${winnerPhrase(names[winner], winner === local && !hotSeat)} the match!` : 'Match over',
      winner,
    } : null,
  };
}

/** Plain data for the small wrist panel. */
export function wristState(game, { local = null, lastThrow = [null, null] } = {}) {
  const facing = local != null ? game?.monkeys?.[local]?.facing ?? 0 : 0;
  const who = local ?? (game?.turn === 1 ? 1 : 0);
  const shot = lastThrow?.[who] ?? game?.lastShots?.[who] ?? null;
  return { wind: windInfo(game?.wind, facing), last: formatShot(shot) };
}

/** Distance (world units) from an impact to the middle of a monkey's body, or Infinity. */
export function impactDistance(game, player, x, y) {
  const m = game?.monkeys?.[player];
  if (!m || !Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
  return Math.hypot(x - m.x, y - (m.y + MONKEY.height / 2));
}
