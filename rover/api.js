// Where the rover is reached from the page. No DOM: tested in Node.
//
// On the PC, server.mjs serves the page and forwards /rover-api/* to the FrodoBots Earth Rovers SDK.
// The Quest app loads the same page from GitHub Pages instead; it reaches that server on the PC through
// `adb reverse tcp:8080 tcp:8080` (USB, or adb over Wi-Fi), as http://localhost:8080.

export const PC_PORT = 8080;
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/** The page's own server when it is on this machine, else the PC's server through adb reverse. */
export function serverBase(loc) {
  if (LOOPBACK.includes(loc.hostname)) return '';
  return `http://localhost:${PC_PORT}`;
}

export function apiBase(loc) {
  return `${serverBase(loc)}/rover-api`;
}

export function logEndpoint(loc) {
  return `${serverBase(loc)}/__log`;
}
