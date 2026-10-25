// A small fake DOM for driving src/ui in Node (no dependencies). Not a test file: only tests/*.test.mjs run.
//
// What it models, because src/ui depends on it:
// - a node tree (elements, text) with attributes, reflected properties (id, className, hidden, inert,
//   disabled, type, value, checked), classList, style (custom properties included) and textContent;
// - events with capture / target / bubble phases from the target up to document and window, passive and
//   once listeners, stopPropagation, preventDefault (cancelable only, ignored in passive listeners);
// - focus: only connected, rendered, non-inert, focusable elements take focus; activeElement falls back to
//   body when the focused element is hidden, made inert or removed (browser "focus fixup");
// - input value sanitizing for number and range inputs (a range is never empty: it starts at its midpoint);
// - a subset of CSS selectors (tag, #id, .class, [attr], [attr=value], :not(...), descendant and child
//   combinators, comma lists). Anything else throws, so a new selector in src/ui is noticed;
// - layout only where a test sets it: setRect(el, rect). Hidden or detached elements measure 0x0;
// - pointer capture, with lostpointercapture on release.
// User-level helpers (click, pressKey, typeInto, pointer) emulate what a browser does around the event:
// focus on mouse down, native button activation by Enter/Space, a focused slider moving with the arrows.
// Exceptions thrown by listeners are collected (env.listenerErrors) instead of being swallowed.

const ZERO_RECT = Object.freeze({ x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
// Short descriptions when a node ends up in an assertion message (inspecting the whole tree is very slow).
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const FORM_CONTROLS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
const INPUT_TYPES = new Set(['text', 'number', 'range', 'checkbox', 'radio', 'search', 'email', 'url', 'tel', 'password', 'hidden', 'button', 'submit']);
const NUMBER_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;

let listenerErrors = [];

// ------------------------------------------------------------------ events

export class FakeEvent {
  /** @param {string} type @param {object} [init] any extra fields (key, clientX, pointerId, ...) are copied */
  constructor(type, init = {}) {
    const { bubbles = false, cancelable = false, ...rest } = init;
    Object.assign(this, rest);
    this.type = type;
    this.bubbles = Boolean(bubbles);
    this.cancelable = Boolean(cancelable);
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.eventPhase = 0;
    this.isTrusted = false;
    this._stop = false;
    this._stopNow = false;
    this._passive = false;
  }

  preventDefault() {
    if (this.cancelable && !this._passive) this.defaultPrevented = true;
  }

  stopPropagation() {
    this._stop = true;
  }

  stopImmediatePropagation() {
    this._stop = true;
    this._stopNow = true;
  }
}

const KEY_DEFAULTS = { key: '', code: '', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false };
const POINTER_DEFAULTS = {
  pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0, clientX: 0, clientY: 0,
  shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
};

export const keyEvent = (type, init = {}) => new FakeEvent(type, { bubbles: true, cancelable: true, ...KEY_DEFAULTS, ...init });
export const pointerEvent = (type, init = {}) => new FakeEvent(type, {
  bubbles: true,
  cancelable: type !== 'pointercancel' && type !== 'lostpointercapture' && type !== 'gotpointercapture',
  ...POINTER_DEFAULTS, ...init,
});

export class FakeEventTarget {
  #listeners = [];

  addEventListener(type, callback, options) {
    if (!callback) return;
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    if (this.#listeners.some((l) => l.type === type && l.callback === callback && l.capture === capture)) return;
    this.#listeners.push({
      type, callback, capture, once: Boolean(options?.once), passive: Boolean(options?.passive), removed: false,
    });
  }

  removeEventListener(type, callback, options) {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture);
    const i = this.#listeners.findIndex((l) => l.type === type && l.callback === callback && l.capture === capture);
    if (i < 0) return;
    this.#listeners[i].removed = true;
    this.#listeners.splice(i, 1);
  }

  dispatchEvent(event) {
    return dispatch(this, event);
  }

  [INSPECT]() {
    if (this instanceof FakeElement) return describe(this);
    if (this instanceof FakeText) return `#text ${JSON.stringify(this.data.slice(0, 40))}`;
    if (this instanceof FakeDocument) return '#document';
    return this.constructor.name;
  }

  /** Test introspection: registered listeners as "type" or "type(capture)", sorted. */
  _listenerList() {
    return this.#listeners.map((l) => (l.capture ? `${l.type}(capture)` : l.type)).sort();
  }

  _invoke(event, phase) {
    for (const l of [...this.#listeners]) {
      if (l.removed || l.type !== event.type) continue;
      if (phase === 'capture' && !l.capture) continue;
      if (phase === 'bubble' && l.capture) continue;
      if (l.once) this.removeEventListener(l.type, l.callback, l.capture);
      event._passive = l.passive;
      try {
        if (typeof l.callback === 'function') l.callback.call(this, event);
        else l.callback.handleEvent(event);
      } catch (err) {
        listenerErrors.push(err);
      } finally {
        event._passive = false;
      }
      if (event._stopNow) return;
    }
  }
}

function eventParent(node) {
  if (node instanceof FakeDocument) return node.defaultView ?? null;
  if (node instanceof FakeNode) return node.parentNode ?? null;
  return null;
}

function dispatch(target, event) {
  event.target = target;
  const path = [];
  for (let n = target; n; n = eventParent(n)) path.push(n);
  event.eventPhase = 1;
  for (let i = path.length - 1; i > 0 && !event._stop; i--) {
    event.currentTarget = path[i];
    path[i]._invoke(event, 'capture');
  }
  if (!event._stop) {
    event.eventPhase = 2;
    event.currentTarget = target;
    target._invoke(event, 'capture');
    if (!event._stopNow) target._invoke(event, 'bubble');
  }
  if (event.bubbles) {
    event.eventPhase = 3;
    for (let i = 1; i < path.length && !event._stop; i++) {
      event.currentTarget = path[i];
      path[i]._invoke(event, 'bubble');
    }
  }
  event.eventPhase = 0;
  event.currentTarget = null;
  return !event.defaultPrevented;
}

// ------------------------------------------------------------------ selectors

function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim());
}

function parseCompound(src) {
  const c = { tag: null, ids: [], classes: [], attrs: [], nots: [] };
  let rest = src;
  const take = (re) => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  let m = take(/^(\*|[a-zA-Z][\w-]*)/);
  let any = Boolean(m);
  if (m && m[1] !== '*') c.tag = m[1].toUpperCase();
  while (rest) {
    any = true;
    if ((m = take(/^#([\w-]+)/))) c.ids.push(m[1]);
    else if ((m = take(/^\.([\w-]+)/))) c.classes.push(m[1]);
    else if ((m = take(/^\[\s*([\w-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*)?\]/))) {
      c.attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] ?? null });
    } else if ((m = take(/^:not\(([^()]*)\)/))) c.nots.push(parseCompound(m[1].trim()));
    else throw new Error(`fake DOM: unsupported selector "${src}"`);
  }
  if (!any) throw new Error('fake DOM: empty selector');
  return c;
}

function parseComplex(src) {
  const parts = [];
  let i = 0;
  let combinator = null;
  const s = src.trim();
  if (!s) throw new Error('fake DOM: empty selector');
  while (i < s.length) {
    let j = i;
    let depth = 0;
    while (j < s.length && (depth > 0 || !/[\s>]/.test(s[j]))) {
      if (s[j] === '(' || s[j] === '[') depth++;
      else if (s[j] === ')' || s[j] === ']') depth--;
      j++;
    }
    if (j === i) throw new Error(`fake DOM: unsupported selector "${src}"`);
    parts.push({ combinator, compound: parseCompound(s.slice(i, j)) });
    let k = j;
    let comb = ' ';
    while (k < s.length && /[\s>]/.test(s[k])) {
      if (s[k] === '>') comb = '>';
      k++;
    }
    combinator = comb;
    i = k;
  }
  return parts;
}

const parseSelector = (text) => splitTop(String(text), ',').map(parseComplex);

function matchesCompound(el, c) {
  if (c.tag && el.tagName !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    if (a.value !== null && el.getAttribute(a.name) !== a.value) return false;
  }
  for (const n of c.nots) if (matchesCompound(el, n)) return false;
  return true;
}

function matchFrom(el, parts, idx) {
  if (!matchesCompound(el, parts[idx].compound)) return false;
  if (idx === 0) return true;
  if (parts[idx].combinator === '>') {
    const p = el.parentElement;
    return Boolean(p) && matchFrom(p, parts, idx - 1);
  }
  for (let p = el.parentElement; p; p = p.parentElement) if (matchFrom(p, parts, idx - 1)) return true;
  return false;
}

const matchesList = (el, list) => list.some((parts) => matchFrom(el, parts, parts.length - 1));

// ------------------------------------------------------------------ nodes

export class FakeNode extends FakeEventTarget {
  constructor(doc) {
    super();
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }

  get firstChild() {
    return this.childNodes[0] ?? null;
  }

  get children() {
    return this.childNodes.filter((n) => n instanceof FakeElement);
  }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n instanceof FakeDocument;
  }

  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    for (const c of [...this.childNodes]) this._detach(c);
    const t = value == null ? '' : String(value);
    if (t !== '') this._insert(new FakeText(this.ownerDocument ?? this, t), null);
  }

  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }

  remove() {
    this.parentNode?._detach(this);
  }

  append(...nodes) {
    for (const n of nodes) this._insert(this._toNode(n), null);
  }

  prepend(...nodes) {
    const first = this.firstChild;
    for (const n of nodes) this._insert(this._toNode(n), first);
  }

  appendChild(node) {
    this._insert(node, null);
    return node;
  }

  insertBefore(node, ref) {
    this._insert(node, ref ?? null);
    return node;
  }

  removeChild(node) {
    if (node.parentNode !== this) throw new Error('fake DOM: NotFoundError (removeChild)');
    this._detach(node);
    return node;
  }

  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) this._detach(c);
    this.append(...nodes);
  }

  /** Descendant elements in document order. */
  *_descendants() {
    for (const c of this.children) {
      yield c;
      yield* c._descendants();
    }
  }

  querySelectorAll(selector) {
    const list = parseSelector(selector);
    return [...this._descendants()].filter((el) => matchesList(el, list));
  }

  querySelector(selector) {
    const list = parseSelector(selector);
    for (const el of this._descendants()) if (matchesList(el, list)) return el;
    return null;
  }

  _toNode(n) {
    if (n instanceof FakeNode) return n;
    return new FakeText(this.ownerDocument ?? this, String(n));
  }

  _insert(node, ref) {
    if (!(node instanceof FakeNode)) throw new TypeError('fake DOM: not a node');
    if (node.contains(this)) throw new Error('fake DOM: HierarchyRequestError');
    if (ref && ref.parentNode !== this) throw new Error('fake DOM: NotFoundError (insertBefore)');
    node.parentNode?._detach(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, node);
    else this.childNodes.push(node);
    node.parentNode = this;
  }

  _detach(node) {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) this.childNodes.splice(i, 1);
    node.parentNode = null;
  }
}

export class FakeText extends FakeNode {
  constructor(doc, data) {
    super(doc);
    this.nodeType = 3;
    this.nodeName = '#text';
    this.data = String(data);
  }

  get textContent() {
    return this.data;
  }

  set textContent(v) {
    this.data = v == null ? '' : String(v);
  }
}

class FakeClassList {
  #el;

  constructor(el) {
    this.#el = el;
  }

  #list() {
    return (this.#el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }

  #write(list) {
    this.#el.setAttribute('class', [...new Set(list)].join(' '));
  }

  add(...tokens) { this.#write([...this.#list(), ...tokens]); }

  remove(...tokens) { this.#write(this.#list().filter((c) => !tokens.includes(c))); }

  contains(token) { return this.#list().includes(token); }

  toggle(token, force) {
    const has = this.contains(token);
    const on = force === undefined ? !has : Boolean(force);
    if (on && !has) this.add(token);
    else if (!on && has) this.remove(token);
    return on;
  }

  get length() { return this.#list().length; }

  [Symbol.iterator]() { return this.#list()[Symbol.iterator](); }

  toString() { return this.#list().join(' '); }
}

const kebab = (k) => (k.startsWith('--') ? k : k.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`));

/** CSSStyleDeclaration-like: setProperty/getPropertyValue/removeProperty plus camelCase properties. */
function createStyle() {
  const props = new Map();
  const api = {
    setProperty: (name, value) => { props.set(String(name), String(value ?? '')); },
    getPropertyValue: (name) => props.get(String(name)) ?? '',
    removeProperty: (name) => {
      const v = props.get(String(name)) ?? '';
      props.delete(String(name));
      return v;
    },
  };
  return new Proxy(api, {
    get: (target, key) => (typeof key !== 'string' || key in target ? target[key] : props.get(kebab(key)) ?? ''),
    set: (target, key, value) => {
      if (typeof key === 'string' && !(key in target)) props.set(kebab(key), String(value ?? ''));
      return true;
    },
  });
}

export class FakeElement extends FakeNode {
  #attrs = new Map();

  constructor(doc, tag) {
    super(doc);
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.localName = String(tag).toLowerCase();
    this.classList = new FakeClassList(this);
    this.style = createStyle();
    this.isContentEditable = false;
    this._value = null;      // dirty value of an input
    this._checked = false;
    this._selectedAll = false;
  }

  get nodeName() { return this.tagName; }

  // ---- attributes and reflected properties

  getAttribute(name) {
    const k = String(name).toLowerCase();
    return this.#attrs.has(k) ? this.#attrs.get(k) : null;
  }

  setAttribute(name, value) { this.#attrs.set(String(name).toLowerCase(), String(value)); }

  hasAttribute(name) { return this.#attrs.has(String(name).toLowerCase()); }

  removeAttribute(name) { this.#attrs.delete(String(name).toLowerCase()); }

  toggleAttribute(name, force) {
    const on = force === undefined ? !this.hasAttribute(name) : Boolean(force);
    if (on) { if (!this.hasAttribute(name)) this.setAttribute(name, ''); } else this.removeAttribute(name);
    return on;
  }

  getAttributeNames() { return [...this.#attrs.keys()]; }

  get id() { return this.getAttribute('id') ?? ''; }

  set id(v) { this.setAttribute('id', v); }

  get className() { return this.getAttribute('class') ?? ''; }

  set className(v) { this.setAttribute('class', v); }

  get hidden() { return this.hasAttribute('hidden'); }

  set hidden(v) { this.toggleAttribute('hidden', Boolean(v)); }

  get inert() { return this.hasAttribute('inert'); }

  set inert(v) { this.toggleAttribute('inert', Boolean(v)); }

  get disabled() { return FORM_CONTROLS.has(this.tagName) && this.hasAttribute('disabled'); }

  set disabled(v) { this.toggleAttribute('disabled', Boolean(v)); }

  get name() { return this.getAttribute('name') ?? ''; }

  get type() {
    const t = (this.getAttribute('type') ?? '').toLowerCase();
    if (this.tagName === 'INPUT') return INPUT_TYPES.has(t) ? t : 'text';
    if (this.tagName === 'BUTTON') return t === 'button' || t === 'reset' ? t : 'submit';
    return t;
  }

  set type(v) { this.setAttribute('type', v); }

  get min() { return this.getAttribute('min') ?? ''; }

  get max() { return this.getAttribute('max') ?? ''; }

  get step() { return this.getAttribute('step') ?? ''; }

  get value() {
    if (this.tagName === 'INPUT') {
      if (this.type === 'checkbox' || this.type === 'radio') return this.getAttribute('value') ?? 'on';
      return sanitizeValue(this, this._value ?? this.getAttribute('value') ?? '');
    }
    if (this.tagName === 'TEXTAREA') return this._value ?? this.textContent;
    if (this.tagName === 'OUTPUT') return this.textContent;
    if (this.tagName === 'BUTTON' || this.tagName === 'OPTION' || this.tagName === 'SELECT') return this.getAttribute('value') ?? '';
    return undefined;
  }

  set value(v) {
    if (this.tagName === 'OUTPUT') this.textContent = v;
    else if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) this.setAttribute('value', v);
    else this._value = v == null ? '' : String(v);
  }

  get checked() { return this._checked; }

  set checked(v) {
    this._checked = Boolean(v);
    if (this._checked && this.tagName === 'INPUT' && this.type === 'radio' && this.name) {
      let root = this;
      while (root.parentNode) root = root.parentNode;
      const group = root instanceof FakeNode ? [...root._descendants()] : [];
      for (const other of group) {
        if (other !== this && other.tagName === 'INPUT' && other.type === 'radio' && other.name === this.name) other._checked = false;
      }
    }
  }

  get tabIndex() {
    const t = Number.parseInt(this.getAttribute('tabindex') ?? '', 10);
    if (Number.isFinite(t)) return t;
    return FORM_CONTROLS.has(this.tagName) ? 0 : -1;
  }

  // ---- rendering, focus, layout

  /** False when this element or an ancestor is hidden (ui.css: [hidden] { display: none !important }). */
  get _rendered() {
    if (!this.isConnected) return false;
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (n.hasAttribute('hidden')) return false;
    return true;
  }

  get _inert() {
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (n.hasAttribute('inert')) return true;
    return false;
  }

  get _focusable() {
    if (!this._rendered || this._inert) return false;
    if (FORM_CONTROLS.has(this.tagName)) return !this.disabled && !(this.tagName === 'INPUT' && this.type === 'hidden');
    return this.hasAttribute('tabindex') || this.isContentEditable || (this.tagName === 'A' && this.hasAttribute('href'));
  }

  focus() {
    const doc = this.ownerDocument;
    if (!this._focusable) return;
    const prev = doc.activeElement;
    if (prev === this) return;
    doc._active = this;
    if (prev && prev !== doc.body) {
      prev.dispatchEvent(new FakeEvent('blur'));
      prev.dispatchEvent(new FakeEvent('focusout', { bubbles: true }));
    }
    this.dispatchEvent(new FakeEvent('focus'));
    this.dispatchEvent(new FakeEvent('focusin', { bubbles: true }));
  }

  blur() {
    const doc = this.ownerDocument;
    if (doc.activeElement !== this) return;
    doc._active = null;
    this._selectedAll = false;
    this.dispatchEvent(new FakeEvent('blur'));
    this.dispatchEvent(new FakeEvent('focusout', { bubbles: true }));
  }

  select() {
    if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') this._selectedAll = true;
  }

  click() {
    if (this.disabled) return;
    let toggled = null;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      toggled = this.checked;
      this.checked = !this.checked;
    } else if (this.tagName === 'INPUT' && this.type === 'radio' && !this.checked) {
      toggled = false;
      this.checked = true;
    }
    const ok = this.dispatchEvent(new FakeEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
    if (toggled === null) return;
    if (!ok) {
      this._checked = toggled;
      return;
    }
    this.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    this.dispatchEvent(new FakeEvent('change', { bubbles: true }));
  }

  matches(selector) {
    return matchesList(this, parseSelector(selector));
  }

  closest(selector) {
    const list = parseSelector(selector);
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (matchesList(n, list)) return n;
    return null;
  }

  getBoundingClientRect() {
    if (!this._rendered) return { ...ZERO_RECT };
    const r = this.ownerDocument._layout.get(this);
    return r ? { ...r } : { ...ZERO_RECT };
  }

  get offsetParent() {
    return this._rendered && this.tagName !== 'BODY' ? (this.parentElement ?? null) : null;
  }

  get offsetWidth() { return Math.round(this.getBoundingClientRect().width); }

  get offsetHeight() { return Math.round(this.getBoundingClientRect().height); }

  setPointerCapture(pointerId) {
    if (!this.isConnected) throw new Error('fake DOM: InvalidStateError (setPointerCapture on a detached element)');
    this.ownerDocument._captures.set(pointerId, this);
  }

  hasPointerCapture(pointerId) {
    return this.ownerDocument._captures.get(pointerId) === this;
  }

  releasePointerCapture(pointerId) {
    if (!this.hasPointerCapture(pointerId)) return;
    this.ownerDocument._captures.delete(pointerId);
    this.dispatchEvent(pointerEvent('lostpointercapture', { pointerId }));
  }
}

function sanitizeValue(el, raw) {
  const s = String(raw);
  if (el.type === 'number') return NUMBER_RE.test(s.trim()) ? s.trim() : '';
  if (el.type !== 'range') return s.replace(/[\r\n]/g, '');
  const num = (v, d) => (NUMBER_RE.test(String(v).trim()) ? Number(v) : d);
  const min = num(el.min, 0);
  const max = Math.max(min, num(el.max, 100));
  const step = el.step === 'any' ? 0 : num(el.step, 1) > 0 ? num(el.step, 1) : 1;
  let v = num(s, min + (max - min) / 2);
  v = Math.min(max, Math.max(min, v));
  if (step) {
    v = min + Math.round((v - min) / step) * step;
    if (v > max) v -= step;
  }
  return String(Math.round(v * 1e9) / 1e9);
}

export class FakeDocument extends FakeNode {
  constructor(win) {
    super(null);
    this.nodeType = 9;
    this.nodeName = '#document';
    this.defaultView = win;
    this._active = null;
    this._layout = new Map();
    this._captures = new Map();
    this.documentElement = this.createElement('html');
    this.head = this.createElement('head');
    this.body = this.createElement('body');
    this.documentElement.append(this.head, this.body);
    this._insert(this.documentElement, null);
  }

  createElement(tag) {
    return new FakeElement(this, tag);
  }

  createTextNode(text) {
    return new FakeText(this, text);
  }

  /** The focused element, or body. A focused element that got hidden, inert or removed loses focus. */
  get activeElement() {
    const a = this._active;
    if (a && a._focusable) return a;
    this._active = null;
    return this.body;
  }
}

export class FakeWindow extends FakeEventTarget {
  constructor({ width = 1280, height = 720 } = {}) {
    super();
    this.innerWidth = width;
    this.innerHeight = height;
    this.devicePixelRatio = 1;
    this.window = this;
    this.self = this;
    this.document = new FakeDocument(this);
  }
}

// ------------------------------------------------------------------ install

const PATCHED_GLOBALS = ['window', 'document', 'Node'];

/**
 * Install window, document and Node on globalThis (src/ui reads them only when called).
 * @returns {{ window: FakeWindow, document: FakeDocument, listenerErrors: Error[],
 *   setRect(el: FakeElement, rect: {left: number, top: number, width: number, height: number}): void,
 *   restore(): void }}
 */
export function installFakeDom({ width = 1280, height = 720 } = {}) {
  const saved = PATCHED_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  const win = new FakeWindow({ width, height });
  const define = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true, enumerable: false });
  define('window', win);
  define('document', win.document);
  define('Node', FakeNode);
  listenerErrors = [];
  let restored = false;
  return {
    window: win,
    document: win.document,
    get listenerErrors() { return listenerErrors; },
    setRect(el, { left = 0, top = 0, width: w = 0, height: h = 0 }) {
      win.document._layout.set(el, { x: left, y: top, left, top, width: w, height: h, right: left + w, bottom: top + h });
    },
    restore() {
      if (restored) return;
      restored = true;
      for (const [key, desc] of saved) {
        if (desc) Object.defineProperty(globalThis, key, desc);
        else delete globalThis[key];
      }
    },
  };
}

// ------------------------------------------------------------------ user-level helpers

/** Normalized text of the rendered (not hidden) part of `node`. */
export function visibleText(node) {
  const parts = [];
  const walk = (n) => {
    if (n instanceof FakeText) parts.push(n.data);
    else if (n instanceof FakeElement) {
      if (n.hasAttribute('hidden')) return;
      for (const c of n.childNodes) walk(c);
      parts.push(' ');
    }
  };
  if (node instanceof FakeElement && !node._rendered) return '';
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Accessible name used to find controls: aria-label, else the text. */
export const accessibleName = (el) => (el.getAttribute('aria-label') ?? el.textContent).replace(/\s+/g, ' ').trim();

function describe(el) {
  const cls = el.className ? `.${el.className.split(/\s+/).join('.')}` : '';
  return `<${el.localName}${cls}> "${accessibleName(el).slice(0, 40)}"`;
}

/** Why a user could not click `el` right now, or null. */
export function notClickable(el) {
  if (!(el instanceof FakeElement)) return 'not an element';
  if (!el.isConnected) return `${describe(el)} is not in the document`;
  if (!el._rendered) return `${describe(el)} is hidden`;
  if (el._inert) return `${describe(el)} is inert`;
  if (el.disabled) return `${describe(el)} is disabled`;
  return null;
}

/** A real mouse click: pointerdown (focus moves), pointerup, click. Throws if a user could not click it. */
export function click(el) {
  const why = notClickable(el);
  if (why) throw new Error(`cannot click: ${why}`);
  const doc = el.ownerDocument;
  const at = { clientX: 1, clientY: 1, pointerType: 'mouse', button: 0 };
  const down = el.dispatchEvent(pointerEvent('pointerdown', { ...at, buttons: 1 }));
  if (down) {
    let f = el;
    while (f instanceof FakeElement && !f._focusable) f = f.parentElement;
    if (f instanceof FakeElement) f.focus();
    else if (doc.activeElement !== doc.body) doc.activeElement.blur();
  }
  el.dispatchEvent(pointerEvent('pointerup', { ...at, buttons: 0 }));
  el.click();
}

const isButtonLike = (t) => t?.tagName === 'BUTTON' || (t?.tagName === 'INPUT' && ['checkbox', 'radio', 'button', 'submit'].includes(t.type));

/**
 * Press and release a key on the focused element (or `target`), with the browser's default actions when not
 * prevented: Enter clicks a focused button, Space clicks a focused button/checkbox/radio on keyup, the arrow
 * keys move a focused range input (input + change) and ↑/↓ step a focused number input (input).
 * @returns {{ down: FakeEvent, up: FakeEvent }}
 */
export function pressKey(doc, key, { shift = false, repeat = false, ctrl = false, alt = false, meta = false, target = null } = {}) {
  const t = target ?? doc.activeElement;
  const init = { key, shiftKey: shift, repeat, ctrlKey: ctrl, altKey: alt, metaKey: meta };
  const down = keyEvent('keydown', init);
  t.dispatchEvent(down);
  if (!down.defaultPrevented) {
    if (key === 'Enter' && t.tagName === 'BUTTON') t.click();
    const slider = t.tagName === 'INPUT' && t.type === 'range' && /^Arrow(Up|Down|Left|Right)$/.test(key);
    const spinner = t.tagName === 'INPUT' && t.type === 'number' && (key === 'ArrowUp' || key === 'ArrowDown');
    if (slider || spinner) {
      const step = Number(t.step) > 0 ? Number(t.step) : 1;
      const before = t.value;
      let v = (before === '' ? 0 : Number(before)) + (key === 'ArrowUp' || key === 'ArrowRight' ? step : -step);
      if (t.min !== '' && Number.isFinite(Number(t.min))) v = Math.max(Number(t.min), v);
      if (t.max !== '' && Number.isFinite(Number(t.max))) v = Math.min(Number(t.max), v);
      t.value = String(Math.round(v * 1e9) / 1e9);
      if (t.value !== before) {
        t.dispatchEvent(new FakeEvent('input', { bubbles: true }));
        if (slider) t.dispatchEvent(new FakeEvent('change', { bubbles: true }));
      }
    }
  }
  const up = keyEvent('keyup', { key, shiftKey: shift, ctrlKey: ctrl, altKey: alt, metaKey: meta });
  t.dispatchEvent(up);
  if (key === ' ' && !down.defaultPrevented && !up.defaultPrevented && isButtonLike(t)) t.click();
  return { down, up };
}

/**
 * Type into a text or number field like a user: focus it, then one keydown / input / keyup per character.
 * The first character replaces the old value (as after select-all) unless `append` is set.
 */
export function typeInto(input, text, { append = false } = {}) {
  const doc = input.ownerDocument;
  const why = notClickable(input);
  if (why) throw new Error(`cannot type: ${why}`);
  input.focus();
  let raw = append ? String(input._value ?? input.value ?? '') : '';
  for (const ch of String(text)) {
    const down = keyEvent('keydown', { key: ch });
    doc.activeElement.dispatchEvent(down);
    if (!down.defaultPrevented) {
      raw += ch;
      input._value = raw;
      input._selectedAll = false;
      input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
    }
    doc.activeElement.dispatchEvent(keyEvent('keyup', { key: ch }));
  }
}

/** Select a radio button or set a checkbox like a user (click on it). */
export function choose(input) {
  const why = notClickable(input);
  if (why) throw new Error(`cannot choose: ${why}`);
  if (input.type === 'radio' && input.checked) return;
  click(input);
}

/**
 * Dispatch a pointer event on `target` at client coordinates. A pointerup also ends any pointer capture of
 * that pointer (lostpointercapture), as browsers do.
 */
export function pointer(target, type, { x = 0, y = 0, ...init } = {}) {
  const e = pointerEvent(type, { clientX: x, clientY: y, ...init });
  target.dispatchEvent(e);
  if (type === 'pointerup' || type === 'pointercancel') {
    const doc = target.ownerDocument;
    const id = e.pointerId;
    const holder = doc._captures.get(id);
    if (holder) holder.releasePointerCapture(id);
  }
  return e;
}
