// Turning controller input into rover commands, and deciding when to send them. No DOM: tested in Node.
//
// The EarthRover SDK takes POST /control {command: {linear, angular, lamp}}: linear +1 is full forward,
// angular +1 is full left (FrodoBots' dashboard and ride logs; some of their docs say right, so the sign can
// be flipped: see `steer`), and the rover keeps doing the last command it received. So the link below
// streams while moving, sends explicit stops, and stops by itself when the input goes quiet.

export const SPEED_STEPS = [0.3, 0.6, 1];
export const DEADZONE = 0.15;
export const SEND_MS = 100; // 10 Hz, the rate the SDK recommends
export const STALE_MS = 300; // input older than this is no input: stop
export const STOP_REPEATS = 5; // stops sent after moving, in case one is lost
export const TIMEOUT_MS = 1500; // a request without an answer by then is given up, so stops are not held up
export const SETTLE_MS = 1500; // quiet time after a drive before the lamp is restated (see CommandLink)
// The rover ignores |linear| or |angular| up to 0.05 (firmware deadband): the first bit of stick past the
// dead zone starts just above it, so the rover answers as soon as you move the stick.
export const MIN_DRIVE = 0.06;

/** Stick deflection (-1..1) to drive amount: dead centre, then gentle near the middle, full at the edge. */
export function shape(v) {
  const a = Math.min(1, Math.abs(v));
  if (!(a > DEADZONE)) return 0;
  const t = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * t * (0.5 + 0.5 * t);
}

const round = v => Math.round(v * 100) / 100 || 0; // "|| 0" turns -0 into 0

/** Shaped stick value (-1..1) to a command value: 0 stays 0, otherwise from MIN_DRIVE up to `scale`. */
function drive(shaped, scale) {
  if (!shaped) return 0;
  const floor = Math.min(MIN_DRIVE, scale);
  return Math.sign(shaped) * (floor + (scale - floor) * Math.abs(shaped));
}

/**
 * @param {{throttleY: number, steerX: number, stop: boolean, scale: number, lamp: boolean, steer: 1|-1}} input
 *   throttleY: left stick Y as the gamepad reports it (up is -1); steerX: right stick X (right is +1);
 *   steer: -1 when this rover turns the other way.
 */
export function commandFrom({ throttleY = 0, steerX = 0, stop = false, scale = 1, lamp = false, steer = 1 }) {
  if (stop) return { linear: 0, angular: 0, lamp: lamp ? 1 : 0 };
  return { linear: round(drive(-shape(throttleY), scale)), angular: round(drive(-shape(steerX), scale) * steer), lamp: lamp ? 1 : 0 };
}

/**
 * One hand's xr-standard gamepad (WebXR Gamepads Module): buttons 0 trigger, 1 grip, 3 thumbstick click,
 * 4 and 5 the face buttons (A/B on the right, X/Y on the left). Touch controllers put the thumbstick on
 * axes 2 and 3; simpler pads only have axes 0 and 1.
 */
export function readPad(gamepad) {
  if (!gamepad) return { x: 0, y: 0, trigger: false, grip: false, stick: false, lower: false, upper: false };
  const ax = gamepad.axes ?? [];
  const at = ax.length >= 4 ? 2 : 0;
  const down = i => !!gamepad.buttons?.[i]?.pressed;
  return { x: ax[at] ?? 0, y: ax[at + 1] ?? 0, trigger: down(0), grip: down(1), stick: down(3), lower: down(4), upper: down(5) };
}

/** Calls back once per press, not while held. */
export class Edges {
  constructor() {
    this.was = new Map();
  }

  press(name, isDown, fn) {
    if (isDown && !this.was.get(name)) fn();
    this.was.set(name, isDown);
  }
}

export const CLICK_MS = 600; // a stick held down longer is not a click (pushing the stick hard presses it)
export const CHORD_MS = 300; // two clicks that start this close together are one "both" click

/**
 * Clicks of the two thumbsticks, reported once both are up: 'left', 'right', or 'both' when the two were
 * clicked together (pressed within CHORD_MS of each other). A press held longer than CLICK_MS is not a click,
 * so a stick pressed in while driving does not turn another click into 'both'.
 */
export class StickClicks {
  constructor() {
    this.sides = { left: this.#fresh(), right: this.#fresh() };
  }

  #fresh() {
    return { down: false, pressed: false, start: 0, held: 0 };
  }

  /** @returns {'left'|'right'|'both'|null} */
  update(leftDown, rightDown, now) {
    for (const [side, isDown] of [['left', leftDown], ['right', rightDown]]) {
      const s = this.sides[side];
      if (isDown && !s.down) Object.assign(s, { down: true, pressed: true, start: now });
      if (!isDown && s.down) Object.assign(s, { down: false, held: now - s.start });
    }
    const { left: l, right: r } = this.sides;
    if (l.down || r.down || !(l.pressed || r.pressed)) return null;
    const clickL = l.pressed && l.held <= CLICK_MS;
    const clickR = r.pressed && r.held <= CLICK_MS;
    let click = null;
    if (clickL && clickR) click = Math.abs(l.start - r.start) <= CHORD_MS ? 'both' : null; // ambiguous: neither
    else if (clickL) click = 'left';
    else if (clickR) click = 'right';
    this.sides = { left: this.#fresh(), right: this.#fresh() };
    return click;
  }
}

/**
 * Sends the latest command at a steady rate. Call setInput() whenever input is read (every frame) and
 * tick() every SEND_MS. Rules:
 *   - while moving, every tick; input older than staleMs counts as "stop" (headset off, page frozen),
 *   - after moving, the stop is sent on the next `repeats` ticks in case one is lost,
 *   - standing still, nothing, except a lamp switch, and one restatement of the lamp `settleMs` after the
 *     last send following a drive: the SDK's watchdog sends its own stop about a second after commands stop,
 *     with the lamp as it was when the drive began, and that restatement puts the lamp back,
 *   - one request in flight at a time, given up after timeoutMs; a newer command replaces a waiting one.
 */
export class CommandLink {
  constructor({
    send, now = () => performance.now(), staleMs = STALE_MS, repeats = STOP_REPEATS, timeoutMs = TIMEOUT_MS, settleMs = SETTLE_MS,
  }) {
    this.send = send;
    this.now = now;
    this.staleMs = staleMs;
    this.repeats = repeats;
    this.timeoutMs = timeoutMs;
    this.settleMs = settleMs;
    this.cmd = { linear: 0, angular: 0, lamp: 0 };
    this.at = -Infinity;
    this.tail = 0;
    this.armed = false; // the rover was driven since the lamp was last restated
    this.sentLamp = 0;
    this.busy = false;
    this.waiting = null;
    this.ok = null; // did the last request succeed (null: none sent yet)
    this.last = this.cmd; // what the rover was last told
    this.sentAt = -Infinity;
  }

  setInput(cmd) {
    this.cmd = cmd;
    this.at = this.now();
  }

  /** Stop now, whatever the input says, and keep saying it. */
  halt() {
    this.cmd = { linear: 0, angular: 0, lamp: this.cmd.lamp };
    this.at = -Infinity; // until fresh input arrives
    this.tail = this.repeats;
    this.tick();
  }

  tick() {
    const fresh = this.now() - this.at <= this.staleMs;
    const cmd = fresh ? this.cmd : { linear: 0, angular: 0, lamp: this.cmd.lamp };
    const moving = cmd.linear !== 0 || cmd.angular !== 0;
    if (moving) {
      this.tail = this.repeats;
      this.armed = true;
    } else if (cmd.lamp !== this.sentLamp) {
      // a lamp switch goes out at once
    } else if (this.tail > 0) {
      this.tail--;
    } else if (this.armed && this.now() - this.sentAt >= this.settleMs) {
      this.armed = false;
    } else {
      return;
    }
    this.#post(cmd);
  }

  #post(cmd) {
    if (this.busy) {
      this.waiting = cmd;
      return;
    }
    this.busy = true;
    this.last = cmd;
    this.sentLamp = cmd.lamp;
    this.sentAt = this.now();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), this.timeoutMs); });
    Promise.race([Promise.resolve().then(() => this.send(cmd)), timeout])
      .then((ok) => { this.ok = ok !== false; }, () => { this.ok = false; })
      .finally(() => {
        clearTimeout(timer);
        this.busy = false;
        const next = this.waiting;
        this.waiting = null;
        if (next) this.#post(next);
      });
  }
}
