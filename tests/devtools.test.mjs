import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COCKPIT_ORIGIN, holdLoopbackGrant, loopbackGrant } from '../scripts/devtools.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Waits until `check()` is true (timers are coarse on Windows, so no fixed short waits). */
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A DevTools browser target that answers each Browser.setPermission with `reply(params)`. */
function fakeBrowser(reply = () => ({ result: {} })) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(text) {
      const msg = JSON.parse(text);
      this.sent.push(msg);
      setTimeout(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, ...reply(msg.params) }) }), 0);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      setTimeout(() => this.onclose?.(), 0);
    }
  }
  const fetchImpl = async () => ({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser' }) });
  return { sockets, FakeSocket, fetchImpl };
}

describe('loopbackGrant', () => {
  it('grants loopback-network to the origin with Browser.setPermission', () => {
    assert.deepEqual(loopbackGrant('https://example.github.io'), {
      method: 'Browser.setPermission',
      params: { permission: { name: 'loopback-network' }, setting: 'granted', origin: 'https://example.github.io' },
    });
  });

  it('never uses Browser.grantPermissions, which would deny WebXR', () => {
    assert.notEqual(loopbackGrant(COCKPIT_ORIGIN).method, 'Browser.grantPermissions');
  });
});

describe('holdLoopbackGrant', () => {
  it('grants once the browser target is reachable, and keeps the session open', async () => {
    const { sockets, FakeSocket, fetchImpl } = fakeBrowser();
    let forwards = 0;
    let granted = 0;
    const stop = holdLoopbackGrant({ forward: () => { forwards++; }, retryMs: 5, onGranted: () => { granted++; }, fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => granted === 1, 'the grant');
      await sleep(50);
      assert.equal(sockets.length, 1, 'one session while it stays open');
      assert.equal(forwards, 1);
      assert.equal(sockets[0].sent[0].method, 'Browser.setPermission');
      assert.equal(sockets[0].sent[0].params.origin, COCKPIT_ORIGIN);
    } finally {
      stop();
    }
    await until(() => sockets[0].closed, 'stop() to close the session');
  });

  it('grants again after the session drops (Chromium forgets the override when it closes)', async () => {
    const { sockets, FakeSocket, fetchImpl } = fakeBrowser();
    let granted = 0;
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, onGranted: () => { granted++; }, fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => granted === 1, 'the first grant');
      sockets[0].close(); // the browser restarted
      await until(() => granted === 2, 'the grant after reconnecting');
      assert.equal(sockets.length, 2);
    } finally {
      stop();
    }
    await sleep(60);
    assert.equal(sockets.length, 2, 'no new session after stop()');
  });

  it('keeps retrying while the headset is not allowed yet or the browser is not running', async () => {
    const { sockets, FakeSocket, fetchImpl } = fakeBrowser();
    let attempts = 0;
    let granted = 0;
    const forward = () => {
      attempts++;
      if (attempts < 3) throw new Error('adb: device unauthorized');
    };
    const stop = holdLoopbackGrant({ forward, retryMs: 5, onGranted: () => { granted++; }, fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => granted === 1, 'the grant after two failed attempts');
      assert.equal(attempts, 3);
      assert.equal(sockets.length, 1);
    } finally {
      stop();
    }
  });

  it('repeats the grant while the session is open, reporting only the first answer', async () => {
    const { sockets, FakeSocket, fetchImpl } = fakeBrowser();
    let granted = 0;
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, refreshMs: 10, onGranted: () => { granted++; }, fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => sockets[0]?.sent.length >= 3, 'three grants on one session');
      assert.ok(sockets[0].sent.every(m => m.method === 'Browser.setPermission'));
      assert.deepEqual(sockets[0].sent.map(m => m.id), sockets[0].sent.map((_, i) => i + 1), 'ids increase');
      assert.equal(granted, 1);
    } finally {
      stop();
    }
    await until(() => sockets[0].closed, 'the session to close');
    await sleep(30);
    const after = sockets[0].sent.length;
    await sleep(60);
    assert.equal(sockets[0].sent.length, after, 'no grants after stop()');
  });

  it('reports a refusal from the browser', async () => {
    const { FakeSocket, fetchImpl } = fakeBrowser(() => ({ error: { message: "Permission can't be granted in current context." } }));
    const refusals = [];
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, onRefused: m => refusals.push(m), fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => refusals.length === 1, 'the refusal');
      assert.deepEqual(refusals, ["Permission can't be granted in current context."]);
    } finally {
      stop();
    }
  });

  it('stops holding after a refusal, since it will not change', async () => {
    const { sockets, FakeSocket, fetchImpl } = fakeBrowser(() => ({ error: { message: 'Unknown permission' } }));
    const refusals = [];
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, refreshMs: 10, onRefused: m => refusals.push(m), fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => refusals.length === 1 && sockets[0]?.closed, 'the refusal to close the session');
      await sleep(80);
      assert.equal(sockets.length, 1, 'no new session');
      assert.equal(sockets[0].sent.length, 1, 'no repeated grants');
      assert.equal(refusals.length, 1);
    } finally {
      stop();
    }
  });

  it('says once per outage that it cannot get through, and again after a grant and a new outage', async () => {
    const { sockets, FakeSocket, fetchImpl } = fakeBrowser();
    let cableIn = false;
    const stuck = [];
    let granted = 0;
    const forward = () => { if (!cableIn) throw new Error('adb: device not found'); };
    const stop = holdLoopbackGrant({ forward, retryMs: 5, stuckAfter: 3, onStuck: m => stuck.push(m), onGranted: () => { granted++; }, fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => stuck.length === 1, 'the first stuck report');
      assert.equal(stuck[0], 'adb: device not found');
      await sleep(60);
      assert.equal(stuck.length, 1, 'once per outage');
      cableIn = true;
      await until(() => granted === 1, 'the grant once the cable is in');
      cableIn = false;
      sockets.at(-1).close(); // unplugged: the session drops and the forward fails again
      await until(() => stuck.length === 2, 'a report for the new outage');
    } finally {
      stop();
    }
  });

  it('gives up on a handshake that never completes', async () => {
    const opened = [];
    class SilentSocket { // never opens
      constructor() { opened.push(this); this.closed = false; }
      send() {}
      close() { if (!this.closed) { this.closed = true; setTimeout(() => this.onclose?.(), 0); } }
    }
    const { fetchImpl } = fakeBrowser();
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, openTimeoutMs: 20, fetchImpl, WebSocketImpl: SilentSocket });
    try {
      await until(() => opened.length >= 2, 'a second attempt after the handshake timed out');
      assert.ok(opened[0].closed);
    } finally {
      stop();
    }
  });

  it('opens no session when stopped while asking for the target', async () => {
    const { sockets, FakeSocket } = fakeBrowser();
    let answer;
    const fetchImpl = () => new Promise((resolve) => { answer = resolve; });
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, fetchImpl, WebSocketImpl: FakeSocket });
    await until(() => answer, 'the target request');
    stop();
    answer({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/browser' }) });
    await sleep(60);
    assert.equal(sockets.length, 0);
  });

  it('retries when the browser offers no browser-level target', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { json: async () => ({}) }; };
    const { sockets, FakeSocket } = fakeBrowser();
    const stop = holdLoopbackGrant({ forward: () => {}, retryMs: 5, fetchImpl, WebSocketImpl: FakeSocket });
    try {
      await until(() => calls >= 2, 'a second attempt');
      assert.equal(sockets.length, 0);
    } finally {
      stop();
    }
  });

  it('says so instead of failing when Node.js has no WebSocket client', () => {
    const refusals = [];
    const stop = holdLoopbackGrant({ forward: () => {}, onRefused: m => refusals.push(m), WebSocketImpl: null });
    stop();
    assert.match(refusals[0], /WebSocket/);
  });
});
