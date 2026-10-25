// Reports what happens in the headset to the terminal on the PC: there is no dev console inside a Quest.
// server.mjs prints every POST /__log. On by default in Quest Browser on localhost (the USB setup);
// add ?log to the URL to turn it on in any browser.
const ENDPOINT = '/__log';
const MAX_ERRORS = 20;
const FPS_EVERY = 10; // seconds

export function remoteLogEnabled(userAgent = navigator.userAgent) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  return local && (/OculusBrowser|Quest/i.test(userAgent) || new URLSearchParams(location.search).has('log'));
}

/**
 * @param {string} [userAgent] the browser's real user agent (the ?emulate runtime replaces navigator's)
 * @returns {{send(msg: string, data?: object): void, frame(dt: number, vr: boolean): void}}
 */
export function createRemoteLog(userAgent) {
  if (!remoteLogEnabled(userAgent)) return { send() {}, frame() {} };

  const queue = [];
  let timer = null;
  let errors = 0;
  const flush = () => {
    timer = null;
    if (!queue.length) return;
    const body = JSON.stringify(queue.splice(0));
    fetch(ENDPOINT, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
  };
  const send = (msg, data) => {
    queue.push({ msg, data });
    if (queue.length > 50) queue.splice(0, queue.length - 50);
    timer ??= setTimeout(flush, 400);
  };
  const error = (kind, data) => {
    if (errors++ < MAX_ERRORS) send(kind, data);
  };

  window.addEventListener('error', (e) => error('error', { message: e.message, at: `${e.filename}:${e.lineno}` }));
  window.addEventListener('unhandledrejection', (e) => error('unhandled', { reason: String(e.reason?.stack ?? e.reason).slice(0, 500) }));
  // Modules report caught failures with console.error (e.g. "[render] ..."), so forward those too.
  const consoleError = console.error.bind(console);
  console.error = (...args) => {
    error('console.error', { text: args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ').slice(0, 500) });
    consoleError(...args);
  };

  let frames = 0;
  let elapsed = 0;
  let worst = 0;
  const frame = (dt, vr) => {
    frames += 1;
    elapsed += dt;
    worst = Math.max(worst, dt);
    if (elapsed >= FPS_EVERY) {
      send('fps', { mode: vr ? 'vr' : '2d', avg: +(frames / elapsed).toFixed(1), worstMs: Math.round(worst * 1000) });
      frames = 0;
      elapsed = 0;
      worst = 0;
    }
  };
  return { send, frame };
}
