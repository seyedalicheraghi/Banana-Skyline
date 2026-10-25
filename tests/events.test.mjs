import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Emitter } from '../src/core/events.js';

describe('Emitter', () => {
  test('on() receives the payload of its own event type only', () => {
    const e = new Emitter();
    const got = [];
    e.on('a', p => got.push(['a', p]));
    e.on('b', p => got.push(['b', p]));
    e.emit('a', { n: 1 });
    e.emit('c', { n: 2 });
    assert.deepEqual(got, [['a', { n: 1 }]]);
  });

  test('emit() without a payload passes an empty object', () => {
    const e = new Emitter();
    let got;
    e.on('x', p => { got = p; });
    e.emit('x');
    assert.deepEqual(got, {});
  });

  test('onAny() receives (type, payload) for every event, after the typed listeners', () => {
    const e = new Emitter();
    const order = [];
    e.onAny((type, p) => order.push(`any:${type}:${p.v}`));
    e.on('a', p => order.push(`a:${p.v}`));
    e.emit('a', { v: 1 });
    e.emit('b', { v: 2 });
    assert.deepEqual(order, ['a:1', 'any:a:1', 'any:b:2']);
  });

  test('on() and onAny() return unsubscribe functions', () => {
    const e = new Emitter();
    let typed = 0;
    let any = 0;
    const offTyped = e.on('a', () => typed++);
    const offAny = e.onAny(() => any++);
    e.emit('a');
    offTyped();
    offAny();
    e.emit('a');
    assert.equal(typed, 1);
    assert.equal(any, 1);
  });

  test('off() removes one listener and leaves the others', () => {
    const e = new Emitter();
    const got = [];
    const f = () => got.push('f');
    e.on('a', f);
    e.on('a', () => got.push('g'));
    e.off('a', f);
    e.off('nothing', f); // unknown types are fine
    e.emit('a');
    assert.deepEqual(got, ['g']);
  });

  test('a listener that unsubscribes itself during emit does not skip the others', () => {
    const e = new Emitter();
    const got = [];
    const off = e.on('a', () => { got.push(1); off(); });
    e.on('a', () => got.push(2));
    e.emit('a');
    e.emit('a');
    assert.deepEqual(got, [1, 2, 2]);
  });

  test('removeAllListeners() silences every listener', () => {
    const e = new Emitter();
    let n = 0;
    e.on('a', () => n++);
    e.onAny(() => n++);
    e.removeAllListeners();
    e.emit('a');
    assert.equal(n, 0);
  });
});
