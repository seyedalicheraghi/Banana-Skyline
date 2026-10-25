// A strict, render-free fake of the Web Audio API for testing src/audio in Node.
//
// - Validates arguments the way browsers do and THROWS on misuse (non-finite values, negative times,
//   exponential ramps to 0, start() twice, stop() before start(), bad enum values, connecting to
//   something that is not a node/param of the same context). Every thrown misuse is also recorded in
//   ctx.errors, because src/audio catches exceptions and only logs them.
// - Records legal-but-suspicious usage in ctx.issues (exponential ramp from 0 or across a sign change,
//   nodes created on a closed context, runaway automation lists).
// - Evaluates AudioParam automation (set / linear / exponential / setTarget / cancel) at any time, so
//   tests can ask "what is this gain at t?" without rendering samples.
// - Simulated time only: ctx.advance(seconds) moves currentTime (only while 'running', like a real
//   context) and fires `ended` on sources whose end time has passed. Nothing uses real timers.
// - Tracks the live graph incrementally: ctx.connected (nodes with at least one output) and
//   ctx.playing (sources started and not yet ended), so leak checks are cheap every frame.
//
// installFakeAudio(policy) puts a fake constructor on globalThis and returns a handle with uninstall().

const ENUM_OSC = ['sine', 'square', 'sawtooth', 'triangle'];
const ENUM_FILTER = ['lowpass', 'highpass', 'bandpass', 'lowshelf', 'highshelf', 'peaking', 'notch', 'allpass'];
const FLT_MAX = 3.4028234663852886e38;
const MAX_EVENTS = 20000;

class DOMExceptionLike extends Error {
  constructor(name, message) {
    super(message);
    this.name = name;
  }
}

function fail(ctx, ErrorType, message, name) {
  const err = name ? new DOMExceptionLike(name, message) : new ErrorType(message);
  ctx.errors.push(`${err.name}: ${message}`);
  throw err;
}

function requireFinite(ctx, v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(ctx, TypeError, `${what} is not a finite number (${String(v)})`);
}

function requireTime(ctx, t, what) {
  requireFinite(ctx, t, what);
  if (t < 0) fail(ctx, RangeError, `${what} is negative (${t})`);
}

export class FakeAudioParam {
  #intrinsic;

  constructor(ctx, name, defaultValue, minValue = -FLT_MAX, maxValue = FLT_MAX) {
    this.ctx = ctx;
    this.name = name;
    this.defaultValue = defaultValue;
    this.minValue = minValue;
    this.maxValue = maxValue;
    this.automationRate = 'a-rate';
    this.events = []; // sorted by time; equal times keep insertion order
    this.inputs = new Set(); // nodes modulating this param (ignored by valueAt)
    this.#intrinsic = defaultValue;
  }

  /** The automation value at the context's current time. */
  get value() {
    return this.valueAt(this.ctx.currentTime);
  }

  set value(v) {
    requireFinite(this.ctx, v, `${this.name}.value`);
    // Spec: assigning value is setValueAtTime(value, currentTime). With no automation that is just the value.
    if (this.events.length === 0) this.#intrinsic = v;
    else this.#insert({ type: 'set', value: v, time: this.ctx.currentTime });
  }

  #insert(e) {
    e.insertedAt = this.ctx.currentTime;
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].time > e.time) i--;
    this.events.splice(i, 0, e);
    if (this.events.length === MAX_EVENTS) this.ctx.issue(`${this.name}: automation list reached ${MAX_EVENTS} events`);
    return this;
  }

  setValueAtTime(value, time) {
    requireFinite(this.ctx, value, `${this.name}.setValueAtTime value`);
    requireTime(this.ctx, time, `${this.name}.setValueAtTime time`);
    return this.#insert({ type: 'set', value, time });
  }

  linearRampToValueAtTime(value, time) {
    requireFinite(this.ctx, value, `${this.name}.linearRampToValueAtTime value`);
    requireTime(this.ctx, time, `${this.name}.linearRampToValueAtTime time`);
    return this.#insert({ type: 'linear', value, time });
  }

  exponentialRampToValueAtTime(value, time) {
    requireFinite(this.ctx, value, `${this.name}.exponentialRampToValueAtTime value`);
    requireTime(this.ctx, time, `${this.name}.exponentialRampToValueAtTime time`);
    if (value === 0) fail(this.ctx, RangeError, `${this.name}.exponentialRampToValueAtTime to 0`);
    const before = this.valueAt(Math.max(0, time - 1e-9));
    const prev = [...this.events].reverse().find(e => e.time <= time);
    if (prev?.type !== 'target' && (before === 0 || Math.sign(before) !== Math.sign(value))) {
      this.ctx.issue(`${this.name}: exponential ramp from ${before} to ${value} has no effect until its end`);
    }
    return this.#insert({ type: 'exp', value, time });
  }

  setTargetAtTime(value, time, timeConstant) {
    requireFinite(this.ctx, value, `${this.name}.setTargetAtTime value`);
    requireTime(this.ctx, time, `${this.name}.setTargetAtTime time`);
    requireFinite(this.ctx, timeConstant, `${this.name}.setTargetAtTime timeConstant`);
    if (timeConstant < 0) fail(this.ctx, RangeError, `${this.name}.setTargetAtTime negative timeConstant`);
    return this.#insert({ type: 'target', value, time, tau: timeConstant });
  }

  cancelScheduledValues(time) {
    requireTime(this.ctx, time, `${this.name}.cancelScheduledValues time`);
    this.events = this.events.filter(e => e.time < time);
    return this;
  }

  cancelAndHoldAtTime(time) {
    requireTime(this.ctx, time, `${this.name}.cancelAndHoldAtTime time`);
    const held = this.valueAt(time);
    this.events = this.events.filter(e => e.time < time);
    return this.#insert({ type: 'set', value: held, time });
  }

  setValueCurveAtTime() {
    fail(this.ctx, Error, `${this.name}.setValueCurveAtTime is not supported by the fake`, 'NotSupportedError');
  }

  /**
   * Automation value at time t (seconds), clamped to the nominal range. Modulation inputs are ignored.
   * A ramp that follows a setTarget starts from the setTarget's own start (close enough for tests).
   */
  valueAt(t) {
    let v = this.#intrinsic;
    let target = null;
    let segT = null; // time and value where the current segment started (previous event)
    let segV = v;
    const current = (time) => {
      if (!target) return v;
      if (target.tau === 0) return target.value;
      return target.value + (target.v0 - target.value) * Math.exp(-(time - target.t) / target.tau);
    };
    let out = null;
    for (const e of this.events) {
      if (e.time > t) {
        if (e.type === 'linear' || e.type === 'exp') {
          const t0 = segT ?? e.insertedAt;
          const v0 = segT == null ? current(t0) : segV;
          if (e.time <= t0 || t <= t0) out = t <= t0 ? v0 : e.value;
          else {
            const k = (t - t0) / (e.time - t0);
            if (e.type === 'linear') out = v0 + (e.value - v0) * k;
            else out = v0 !== 0 && Math.sign(v0) === Math.sign(e.value) ? v0 * (e.value / v0) ** k : v0;
          }
        }
        break;
      }
      if (e.type === 'target') {
        const v0 = current(e.time);
        target = { t: e.time, v0, value: e.value, tau: e.tau };
        segT = e.time;
        segV = v0;
      } else {
        v = e.value;
        target = null;
        segT = e.time;
        segV = v;
      }
    }
    if (out == null) out = current(t);
    return Math.min(this.maxValue, Math.max(this.minValue, out));
  }
}

export class FakeAudioNode {
  constructor(ctx, kind) {
    this.context = ctx;
    this.kind = kind;
    this.outputs = new Set();
    this.inputs = new Set();
    this.channelCount = 2;
    ctx._created(this);
  }

  connect(destination, output = 0, input = 0) {
    const ctx = this.context;
    const isNode = destination instanceof FakeAudioNode;
    const isParam = destination instanceof FakeAudioParam;
    if (!isNode && !isParam) fail(ctx, TypeError, `${this.kind}.connect: destination is not an AudioNode or AudioParam`);
    const destCtx = isNode ? destination.context : destination.ctx;
    if (destCtx !== ctx) fail(ctx, Error, `${this.kind}.connect: destination belongs to another context`, 'InvalidAccessError');
    if (!Number.isInteger(output) || output !== 0) fail(ctx, Error, `${this.kind}.connect: bad output ${output}`, 'IndexSizeError');
    if (isNode && (!Number.isInteger(input) || input !== 0)) fail(ctx, Error, `${this.kind}.connect: bad input ${input}`, 'IndexSizeError');
    if (destination === ctx.destination && this === destination) fail(ctx, Error, 'connect to itself', 'InvalidAccessError');
    this.outputs.add(destination);
    destination.inputs.add(this);
    ctx._connected(this, destination);
    return isNode ? destination : undefined;
  }

  disconnect(destination) {
    const ctx = this.context;
    if (destination === undefined) {
      for (const d of this.outputs) d.inputs.delete(this);
      this.outputs.clear();
    } else {
      if (!this.outputs.has(destination)) fail(ctx, Error, `${this.kind}.disconnect: not connected to that destination`, 'InvalidAccessError');
      this.outputs.delete(destination);
      destination.inputs.delete(this);
    }
    ctx._disconnected(this);
  }
}

export class FakeGainNode extends FakeAudioNode {
  constructor(ctx) {
    super(ctx, 'GainNode');
    this.gain = new FakeAudioParam(ctx, 'gain.gain', 1);
  }
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  #type = 'lowpass';

  constructor(ctx) {
    super(ctx, 'BiquadFilterNode');
    const nyquist = ctx.sampleRate / 2;
    this.frequency = new FakeAudioParam(ctx, 'filter.frequency', 350, 0, nyquist);
    this.Q = new FakeAudioParam(ctx, 'filter.Q', 1);
    this.gain = new FakeAudioParam(ctx, 'filter.gain', 0);
    this.detune = new FakeAudioParam(ctx, 'filter.detune', 0);
  }

  get type() { return this.#type; }

  set type(v) {
    // Browsers ignore invalid enum assignments silently; flag it because the sound would be wrong.
    if (!ENUM_FILTER.includes(v)) fail(this.context, TypeError, `BiquadFilterNode.type "${v}"`);
    this.#type = v;
  }
}

export class FakeStereoPannerNode extends FakeAudioNode {
  constructor(ctx) {
    super(ctx, 'StereoPannerNode');
    this.pan = new FakeAudioParam(ctx, 'panner.pan', 0, -1, 1);
  }
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  constructor(ctx) {
    super(ctx, 'DynamicsCompressorNode');
    this.threshold = new FakeAudioParam(ctx, 'compressor.threshold', -24, -100, 0);
    this.knee = new FakeAudioParam(ctx, 'compressor.knee', 30, 0, 40);
    this.ratio = new FakeAudioParam(ctx, 'compressor.ratio', 12, 1, 20);
    this.attack = new FakeAudioParam(ctx, 'compressor.attack', 0.003, 0, 1);
    this.release = new FakeAudioParam(ctx, 'compressor.release', 0.25, 0, 1);
    this.reduction = 0;
  }
}

export class FakeAudioDestinationNode extends FakeAudioNode {
  constructor(ctx) {
    super(ctx, 'AudioDestinationNode');
    this.maxChannelCount = 2;
  }
}

class FakeScheduledSourceNode extends FakeAudioNode {
  constructor(ctx, kind) {
    super(ctx, kind);
    this.started = false;
    this.startTime = NaN;
    this.stopTime = Infinity; // last stop() wins, as in the spec
    this.offset = 0;
    this.ended = false;
    this.onended = null;
  }

  start(when = 0, offset = 0) {
    const ctx = this.context;
    if (this.started) fail(ctx, Error, `${this.kind}.start called twice`, 'InvalidStateError');
    requireTime(ctx, when, `${this.kind}.start when`);
    requireTime(ctx, offset, `${this.kind}.start offset`);
    this.started = true;
    this.startTime = Math.max(when, ctx.currentTime);
    this.offset = offset;
    ctx._started(this);
  }

  stop(when = 0) {
    const ctx = this.context;
    if (!this.started) fail(ctx, Error, `${this.kind}.stop before start`, 'InvalidStateError');
    requireTime(ctx, when, `${this.kind}.stop when`);
    if (this.ended) return;
    this.stopTime = when;
  }

  /** When this source stops producing sound (Infinity while it runs until stopped). */
  get endTime() {
    if (!this.started) return Infinity;
    return Math.max(this.startTime, Math.min(this.stopTime, this.naturalEnd()));
  }

  naturalEnd() {
    return Infinity;
  }

  /** True when started, not ended, and t is within [start, end). */
  playingAt(t) {
    return this.started && !this.ended && t >= this.startTime && t < this.endTime;
  }
}

export class FakeOscillatorNode extends FakeScheduledSourceNode {
  #type = 'sine';

  constructor(ctx) {
    super(ctx, 'OscillatorNode');
    const nyquist = ctx.sampleRate / 2;
    this.frequency = new FakeAudioParam(ctx, 'osc.frequency', 440, -nyquist, nyquist);
    this.detune = new FakeAudioParam(ctx, 'osc.detune', 0);
  }

  get type() { return this.#type; }

  set type(v) {
    if (v === 'custom') fail(this.context, Error, 'OscillatorNode.type "custom" needs setPeriodicWave', 'InvalidStateError');
    if (!ENUM_OSC.includes(v)) fail(this.context, TypeError, `OscillatorNode.type "${v}"`);
    this.#type = v;
  }
}

export class FakeAudioBuffer {
  constructor(ctx, numberOfChannels, length, sampleRate) {
    if (!Number.isInteger(numberOfChannels) || numberOfChannels < 1 || numberOfChannels > 32) {
      fail(ctx, Error, `createBuffer: ${numberOfChannels} channels`, 'NotSupportedError');
    }
    if (!Number.isInteger(length) || length < 1) fail(ctx, Error, `createBuffer: length ${length}`, 'NotSupportedError');
    if (!(sampleRate >= 3000 && sampleRate <= 768000)) fail(ctx, Error, `createBuffer: sampleRate ${sampleRate}`, 'NotSupportedError');
    this.ctx = ctx;
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }

  getChannelData(channel) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= this.numberOfChannels) {
      fail(this.ctx, Error, `getChannelData(${channel})`, 'IndexSizeError');
    }
    return this.channels[channel];
  }
}

export class FakeAudioBufferSourceNode extends FakeScheduledSourceNode {
  #buffer = null;

  constructor(ctx) {
    super(ctx, 'AudioBufferSourceNode');
    this.loop = false;
    this.loopStart = 0;
    this.loopEnd = 0;
    this.playbackRate = new FakeAudioParam(ctx, 'source.playbackRate', 1);
    this.detune = new FakeAudioParam(ctx, 'source.detune', 0);
  }

  get buffer() { return this.#buffer; }

  set buffer(b) {
    if (b !== null && !(b instanceof FakeAudioBuffer)) fail(this.context, TypeError, 'AudioBufferSourceNode.buffer is not an AudioBuffer');
    if (b !== null && this.#buffer !== null) fail(this.context, Error, 'AudioBufferSourceNode.buffer set twice', 'InvalidStateError');
    this.#buffer = b;
  }

  naturalEnd() {
    if (this.loop) return Infinity;
    const duration = this.#buffer ? this.#buffer.duration : 0;
    const rate = Math.abs(this.playbackRate.valueAt(this.startTime)) || 1;
    return this.startTime + Math.max(0, duration - this.offset) / rate;
  }
}

/**
 * @typedef {object} FakeAudioPolicy
 * @property {'running'|'suspended'} [state='running'] state of a newly created context
 * @property {'allowed'|'blocked'} [autoplay='allowed'] 'blocked': resume() does nothing until ctx.allowAutoplay()
 * @property {number} [sampleRate=8000] low by default so the 2 s noise buffer is cheap to fill
 * @property {boolean} [noStereoPanner=false] like old Safari: createStereoPanner is missing
 * @property {boolean} [rejectOptions=false] the constructor throws when given an options object
 * @property {boolean} [throwOnConstruct=false] the constructor always throws
 */

export class FakeAudioContext {
  #time = 0;
  #policy;

  constructor(options, policy = {}) {
    this.#policy = { state: 'running', autoplay: 'allowed', sampleRate: 8000, ...policy };
    if (this.#policy.throwOnConstruct) throw new DOMExceptionLike('NotSupportedError', 'AudioContext is not allowed here');
    if (options !== undefined && this.#policy.rejectOptions) throw new TypeError('AudioContext() takes no arguments');
    this.options = options;
    this.sampleRate = this.#policy.sampleRate;
    this.baseLatency = 0.01;
    this.state = this.#policy.state;
    this.autoplayAllowed = this.#policy.autoplay !== 'blocked';
    this.onstatechange = null;
    this.errors = [];
    this.issues = [];
    this.connected = new Set(); // nodes with at least one output
    this.playing = new Set();   // sources started and not yet ended
    this.stats = { nodes: 0, sourcesStarted: 0, sourcesEnded: 0, connects: 0, resumeCalls: 0, closeCalls: 0 };
    this.connectsInto = new Map(); // destination -> number of connect() calls into it
    this.destination = new FakeAudioDestinationNode(this);
    if (this.#policy.noStereoPanner) this.createStereoPanner = undefined;
  }

  issue(message) {
    if (this.issues.length < 100) this.issues.push(message);
  }

  get currentTime() {
    return this.#time;
  }

  // ---- bookkeeping called by nodes ----
  _created(node) {
    this.stats.nodes += 1;
    if (this.state === 'closed') this.issue(`${node.kind} created on a closed context`);
  }

  _connected(node, dest) {
    this.stats.connects += 1;
    this.connected.add(node);
    this.connectsInto.set(dest, (this.connectsInto.get(dest) ?? 0) + 1);
  }

  _disconnected(node) {
    if (node.outputs.size === 0) this.connected.delete(node);
  }

  _started(src) {
    this.stats.sourcesStarted += 1;
    this.playing.add(src);
  }

  // ---- factory methods ----
  createGain() { return new FakeGainNode(this); }
  createOscillator() { return new FakeOscillatorNode(this); }
  createBiquadFilter() { return new FakeBiquadFilterNode(this); }
  createBufferSource() { return new FakeAudioBufferSourceNode(this); }
  createStereoPanner() { return new FakeStereoPannerNode(this); }
  createDynamicsCompressor() { return new FakeDynamicsCompressorNode(this); }
  createBuffer(numberOfChannels, length, sampleRate) {
    return new FakeAudioBuffer(this, numberOfChannels, length, sampleRate);
  }

  // ---- state ----
  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    try { this.onstatechange?.({ type: 'statechange', target: this }); } catch (err) { this.errors.push(`onstatechange threw: ${err.message}`); }
  }

  resume() {
    this.stats.resumeCalls += 1;
    if (this.state === 'closed') return Promise.reject(new DOMExceptionLike('InvalidStateError', 'resume() on a closed context'));
    if (!this.autoplayAllowed) return new Promise(() => {}); // stays pending, like a blocked autoplay resume
    this.#setState('running');
    return Promise.resolve();
  }

  suspend() {
    if (this.state === 'closed') return Promise.reject(new DOMExceptionLike('InvalidStateError', 'suspend() on a closed context'));
    this.#setState('suspended');
    return Promise.resolve();
  }

  close() {
    this.stats.closeCalls += 1;
    if (this.state === 'closed') return Promise.reject(new DOMExceptionLike('InvalidStateError', 'close() twice'));
    this.#setState('closed');
    return Promise.resolve();
  }

  // ---- test controls ----

  /** The system (not the page) suspends the context: headset sleep, app switch, iOS 'interrupted'. */
  interrupt(state = 'suspended') {
    if (this.state !== 'closed') this.#setState(state);
  }

  /** A user gesture happened: later resume() calls succeed. */
  allowAutoplay() {
    this.autoplayAllowed = true;
  }

  /**
   * While running, let `seconds` of audio time pass and fire `ended` for sources that finished.
   * @param {number} seconds
   */
  advance(seconds) {
    if (this.state !== 'running') return; // a suspended context neither advances nor fires `ended`
    if (Number.isFinite(seconds) && seconds > 0) this.#time += seconds;
    const now = this.#time;
    for (const s of [...this.playing]) {
      if (now < s.endTime) continue;
      s.ended = true;
      this.playing.delete(s);
      this.stats.sourcesEnded += 1;
      try {
        s.onended?.({ type: 'ended', target: s });
      } catch (err) {
        this.errors.push(`onended threw: ${err.message}`);
      }
    }
  }

  /**
   * Linear gain from `node` to the speakers at time t: the sum over every node-to-node path to the
   * destination of the product of GainNode gains along it (filters and panners count as 1, param
   * modulation is ignored). A cheap stand-in for "how loud is this source".
   */
  pathGain(node, t = this.currentTime) {
    const memo = new Map();
    const walk = (n) => {
      if (n === this.destination) return 1;
      if (memo.has(n)) return memo.get(n);
      memo.set(n, 0); // cycle guard
      let sum = 0;
      for (const out of n.outputs) if (out instanceof FakeAudioNode) sum += walk(out);
      const own = n instanceof FakeGainNode ? n.gain.valueAt(t) : 1;
      memo.set(n, own * sum);
      return own * sum;
    };
    return walk(node);
  }

  /** Sum of pathGain over the sources sounding at time t. */
  outputLevel(t = this.currentTime) {
    let sum = 0;
    for (const s of this.playing) if (s.playingAt(t)) sum += this.pathGain(s, t);
    return sum;
  }
}

/**
 * Install a fake AudioContext constructor on globalThis (removing any other Web Audio globals first).
 * @param {FakeAudioPolicy & {global?: 'AudioContext'|'webkitAudioContext'|'none'}} [policy]
 */
export function installFakeAudio(policy = {}) {
  const names = ['AudioContext', 'webkitAudioContext'];
  const saved = names.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  const contexts = [];
  const { global: where = 'AudioContext', ...rest } = policy;
  class InstalledAudioContext extends FakeAudioContext {
    constructor(options) {
      super(options, rest);
      contexts.push(this);
    }
  }
  for (const n of names) delete globalThis[n];
  if (where !== 'none') {
    Object.defineProperty(globalThis, where, { value: InstalledAudioContext, configurable: true, writable: true });
  }
  return {
    Class: InstalledAudioContext,
    contexts,
    get ctx() { return contexts.at(-1) ?? null; },
    uninstall() {
      for (const [n, d] of saved) {
        delete globalThis[n];
        if (d) Object.defineProperty(globalThis, n, d);
      }
    },
  };
}
