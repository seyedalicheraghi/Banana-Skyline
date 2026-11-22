// DevTools over adb for the headset's browser engine (Quest Browser, which also runs the Rover Cockpit app).
// The app is a public site (GitHub Pages) that fetches the headset's own localhost (adb reverse to this PC).
// Chromium's Local Network Access allows that only after the user grants the "loopback-network" permission,
// and an immersive app cannot show that prompt. A DevTools permission override grants it without one (works on
// Quest Browser 157). When a DevTools session that set an override closes, Chromium clears every DevTools
// override in that browser (including other sessions' grants), so holdLoopbackGrant keeps its session open,
// repeats the grant every `refreshMs` and grants again after every reconnect, for as long as this process runs.

export const COCKPIT_ORIGIN = 'https://seyedalicheraghi.github.io';
export const DEVTOOLS_SOCKET = 'localabstract:chrome_devtools_remote';
export const DEVTOOLS_PORT = 9223; // this PC's end of the adb forward

/**
 * The DevTools command that lets `origin` reach loopback. Browser.setPermission, never
 * Browser.grantPermissions: that one denies every permission it does not list, WebXR included.
 */
export function loopbackGrant(origin) {
  return { method: 'Browser.setPermission', params: { permission: { name: 'loopback-network' }, setting: 'granted', origin } };
}

/**
 * Keeps `origin` allowed to reach the headset's localhost. `forward()` runs before every session (set up the adb
 * forward to the browser's DevTools socket there, and anything else a reconnected cable needs); it throws until
 * the headset is connected and allowed. Until then, and whenever the browser is not running or the session drops,
 * this retries every `retryMs`.
 * - onGranted(): the first grant of each session.
 * - onStuck(message): once per outage, after `stuckAfter` attempts in a row failed before a grant.
 * - onRefused(message): the browser answered the grant with an error; holding stops, since it will not change.
 * Returns stop().
 */
export function holdLoopbackGrant({
  forward, origin = COCKPIT_ORIGIN, port = DEVTOOLS_PORT,
  retryMs = 3000, refreshMs = 2000, openTimeoutMs = 5000, stuckAfter = 5,
  onGranted = () => {}, onStuck = () => {}, onRefused = () => {},
  fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket,
}) {
  if (typeof WebSocketImpl !== 'function') {
    onRefused('this Node.js has no WebSocket client (use Node.js 22 or newer)');
    return () => {};
  }
  let stopped = false;
  let socket = null;
  let wake = null;
  let failures = 0;
  let stuckSaid = false;
  const pause = ms => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const stop = () => {
    stopped = true;
    socket?.close();
    wake?.();
  };

  /** One DevTools session; resolves when it ends. Throws if it never got a grant answered. */
  async function session() {
    forward();
    const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    const { webSocketDebuggerUrl } = await res.json();
    if (!webSocketDebuggerUrl) throw new Error('no browser-level DevTools target');
    if (stopped) return;
    let answered = false;
    await new Promise((resolve) => {
      const ws = new WebSocketImpl(webSocketDebuggerUrl);
      socket = ws;
      let id = 0;
      let refresh = null;
      const opening = setTimeout(() => ws.close(), openTimeoutMs); // a peer that never answers the handshake
      const grant = () => ws.send(JSON.stringify({ id: ++id, ...loopbackGrant(origin) }));
      ws.onopen = () => {
        clearTimeout(opening);
        grant();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (typeof msg.id !== 'number' || answered) return; // each session's first answer only
        answered = true;
        if (msg.error) {
          onRefused(msg.error.message);
          stop();
        } else {
          failures = 0;
          stuckSaid = false;
          refresh = setInterval(grant, refreshMs); // another session closing may have cleared it
          onGranted();
        }
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        clearTimeout(opening);
        clearInterval(refresh);
        if (socket === ws) socket = null;
        resolve();
      };
    });
    if (!answered && !stopped) throw new Error('the browser closed the DevTools session before answering');
  }

  (async () => {
    while (!stopped) {
      try {
        await session();
      } catch (err) {
        // headset not allowed or unplugged, browser not running, or the session dropped: try again
        failures++;
        if (failures >= stuckAfter && !stuckSaid && !stopped) {
          stuckSaid = true;
          onStuck(err?.message ?? String(err));
        }
      }
      if (!stopped) await pause(retryMs);
    }
  })();

  return stop;
}
