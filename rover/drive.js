// Turning controller input into rover commands, and deciding when to send them. No DOM: tested in Node.
//
// The EarthRover SDK takes POST /control {command: {linear, angular, lamp}}: linear +1 is full forward,
// angular +1 is full left in FrodoBots' own dashboard (their firmware notes say right, so the sign can be
// flipped: see `steer`), and the rover keeps doing the last command it received. So the link below streams
// while moving, sends explicit stops, and stops by itself when the input goes quiet.

export const SPEED_STEPS = [0.3, 0.6, 1];
export const DEADZONE = 0.15;
export const SEND_MS = 100; // 10 Hz, the rate the SDK recommends

/** Stick deflection (-1..1) to drive amount: dead centre, then gentle near the middle, full at the edge. */
export function shape(v) {
  const a = Math.min(1, Math.abs(v));
  if (!(a > DEADZONE)) return 0;
  const t = (a - DEADZONE) / (1 - DEADZONE);
  return Math.sign(v) * t * (0.5 + 0.5 * t);
}

const round = v => Math.round(v * 100) / 100 || 0; // "|| 0" turns -0 into 0

/**
 * @param {{throttleY: number, steerX: number, stop: boolean, scale: number, lamp: boolean, steer: 1|-1}} input
 *   throttleY: left stick Y as the gamepad reports it (up is -1); steerX: right stick X (right is +1);
 *   steer: -1 when this rover turns the other way.
 */
export function commandFrom({ throttleY = 0, steerX = 0, stop = false, scale = 1, lamp = false, steer = 1 }) {
  if (stop) return { linear: 0, angular: 0, lamp: lamp ? 1 : 0 };
  return { linear: round(-shape(throttleY) * scale), angular: round(-shape(steerX) * scale * steer), lamp: lamp ? 1 : 0 };
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

/**
 * Clicks of the two thumbsticks, reported when released: 'left', 'right', or 'both' when the two were
 * down together at some point (then neither single click counts).
 */
export class StickClicks {
  constructor() {
    this.left = false;
    this.right = false;
  }

  /** @returns {'left'|'right'|'both'|null} */
  update(leftDown, rightDown) {
    if (leftDown) this.left = true;
    if (rightDown) this.right = true;
    if (leftDown || rightDown || !(this.left || this.right)) return null;
    const click = this.left && this.right ? 'both' : this.left ? 'left' : 'right';
    this.left = false;
    this.right = false;
    return click;
  }
}

/**
 * Sends the latest command at a steady rate. Call setInput() whenever input is read (every frame) and
 * tick() every SEND_MS. Rules:
 *   - while moving, every tick; input older than staleMs counts as "stop" (headset off, page frozen),
 *   - after moving, the stop is sent on the next `repeats` ticks in case one is lost,
 *   - standing still, a stop every `idleEvery` ticks: it keeps the lamp as chosen (the SDK's watchdog
 *     resends an old lamp state when commands stop) and shows whether commands still get through,
 *   - one request in flight at a time; a newer command replaces a waiting one.
 */
export class CommandLink {
  constructor({ send, now = () => performance.now(), staleMs = 300, repeats = 5, idleEvery = 5 }) {
    this.send = send;
    this.now = now;
    this.staleMs = staleMs;
    this.repeats = repeats;
    this.idleEvery = idleEvery;
    this.cmd = { linear: 0, angular: 0, lamp: 0 };
    this.at = -Infinity;
    this.tail = 0;
    this.idle = 0;
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
    if (moving) this.tail = this.repeats;
    else if (cmd.lamp !== this.sentLamp) { /* a lamp switch goes out at once */ }
    else if (this.tail > 0) this.tail--;
    else if (!this.idleEvery || ++this.idle < this.idleEvery) return;
    this.idle = 0;
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
    Promise.resolve()
      .then(() => this.send(cmd))
      .then((ok) => { this.ok = ok !== false; }, () => { this.ok = false; })
      .finally(() => {
        this.busy = false;
        const next = this.waiting;
        this.waiting = null;
        if (next) this.#post(next);
      });
  }
}
