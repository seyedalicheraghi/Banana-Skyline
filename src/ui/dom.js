// Tiny DOM helpers. They touch `document` only when called, never at import time.

let uid = 0;

/** Unique id for label/for pairs and aria references. */
export const nextId = (prefix = 'bs') => `${prefix}-${++uid}`;

/**
 * Create an element.
 * props: `class`, `text`, `on` ({type: listener}), `style` ({'css-prop' or '--var': value}); `true` becomes
 * an empty attribute, `false`/null are skipped, anything else is set as an attribute.
 * Children may be nodes, strings, arrays, or null/false (skipped).
 * @returns {HTMLElement}
 */
export function h(tag, props = null, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'on') for (const [type, fn] of Object.entries(value)) node.addEventListener(type, fn);
      else if (key === 'style') for (const [prop, v] of Object.entries(value)) node.style.setProperty(prop, String(v));
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : String(child));
  }
}

/** Set textContent only when it changed (cheap to call every frame). */
export function setText(node, text) {
  const t = String(text ?? '');
  if (node.textContent !== t) node.textContent = t;
}

/** Keep a range input's filled-track CSS variable in step with its value. */
export function paintRange(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--fill', `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`);
}

/** Set an input's value unless the user is editing it right now. */
export function syncValue(input, value) {
  if (input.ownerDocument?.activeElement === input) return;
  const v = String(value);
  if (input.value !== v) {
    input.value = v;
    if (input.type === 'range') paintRange(input);
  }
}

/**
 * A labelled group of radio buttons drawn as a segmented control (arrow keys move the choice natively).
 * @param {{ label: string, options: Array<{value: any, label: string, sub?: string}>, value?: any,
 *   onChange?: (value: any) => void, className?: string }} o
 * @returns {{ el: HTMLFieldSetElement, value: string|null, set(value: any): void }}
 */
export function choiceGroup({ label, options, value = null, onChange, className = '' }) {
  const name = nextId('choice');
  const inputs = [];
  const seg = h('div', { class: 'bs-seg' });
  for (const opt of options) {
    const input = h('input', { type: 'radio', name, value: String(opt.value) });
    input.checked = String(opt.value) === String(value);
    input.addEventListener('change', () => { if (input.checked) onChange?.(opt.value); });
    inputs.push(input);
    seg.append(h('label', { class: 'bs-seg-opt' }, input,
      h('span', null, opt.label, opt.sub ? h('small', { text: opt.sub }) : null)));
  }
  const el = h('fieldset', { class: `bs-choice ${className}`.trim() }, h('legend', { text: label }), seg);
  return {
    el,
    get value() { return inputs.find((i) => i.checked)?.value ?? null; },
    set(v) { for (const i of inputs) i.checked = i.value === String(v); },
  };
}

/**
 * An on/off switch (a checkbox with role="switch").
 * @returns {{ el: HTMLLabelElement, input: HTMLInputElement, set(on: boolean): void }}
 */
export function switchToggle({ label, checked = false, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch' });
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange?.(input.checked));
  const el = h('label', { class: 'bs-switch' }, input, h('span', { class: 'bs-switch-track', 'aria-hidden': 'true' }),
    h('span', { class: 'bs-switch-label', text: label }));
  return { el, input, set(on) { input.checked = Boolean(on); } };
}

/** Move focus to the next/previous visible button inside `container`. Returns true when it moved. */
export function moveFocus(container, dir) {
  const buttons = [...container.querySelectorAll('button')].filter((b) => !b.disabled && b.offsetParent !== null);
  if (!buttons.length) return false;
  const i = buttons.indexOf(container.ownerDocument.activeElement);
  const next = i < 0 ? (dir > 0 ? 0 : buttons.length - 1) : (i + dir + buttons.length) % buttons.length;
  buttons[next].focus();
  return true;
}
