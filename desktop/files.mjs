// What the app:// scheme of the desktop app serves: files of the build (dist/) and nothing else. Plain Node, no
// Electron, so the tests exercise the path mapping and the responses directly; desktop/main.mjs wraps serve()
// in a Response.
import fs from 'node:fs/promises';
import path from 'node:path';

export const ORIGIN = 'app://game'; // a standard scheme needs a host, and the game is the only thing served

// Chromium only runs module scripts with a JavaScript type, so the types come from this table, not from guessing.
export const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
};

export const contentType = (file) => TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

/**
 * The file under `root` that a request for `url` (an app:// URL, or just its path) asks for: `/` is index.html
 * and the query string is ignored. URL parsing already folds `..` segments, encoded or not, so what has to be
 * caught here is what survives it: `..` behind a percent-encoded slash or backslash, drive letters. Those, a
 * null byte, and anything that cannot be decoded give null.
 */
export function filePath(url, root) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, `${ORIGIN}/`).pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0')) return null;
  const rel = pathname.replace(/^[/\\]+/, '') || 'index.html';
  const base = path.resolve(root);
  const full = path.resolve(base, rel);
  const inside = path.relative(base, full);
  if (!inside || inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return null;
  return full;
}

const NOT_FOUND = Object.freeze({ status: 404, headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8' }), body: 'Not found' });

/**
 * Status, headers and body for an app:// request: the file with its type, or 404 (also for directories and for
 * anything outside the build).
 */
export async function serve(url, root) {
  const file = filePath(url, root);
  if (!file) return NOT_FOUND;
  let body;
  try {
    body = await fs.readFile(file); // a directory fails here as well
  } catch {
    return NOT_FOUND;
  }
  return {
    status: 200,
    headers: { 'content-type': contentType(file), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body,
  };
}
