// Banana Skyline as a desktop app: one window showing the static build (dist/, from scripts/build.mjs).
// Chromium gets the build through the privileged app:// scheme rather than file://, because file:// has no
// origin: module scripts and the import map are refused and localStorage (the preferences) is unavailable.
// The window is the whole app: no menu bar, no new windows, no navigation anywhere else, no network, and no
// Node in the page. VR is not offered: Electron has no OpenXR, so WebXR reports no immersive-vr support and the
// game hides its Play in VR button.
import { app, BrowserWindow, Menu, protocol, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORIGIN, serve } from './files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist'); // in the packaged app: inside resources/app.asar
const DEV_ICON = path.join(HERE, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'); // the packaged exe carries its own
const BACKGROUND = '#0b1026'; // the page background, so a resize never flashes white
const PAGE_SCHEMES = new Set(['app:', 'data:', 'blob:', 'devtools:']); // the game needs nothing else; http(s) and file are refused

// Before ready. standard: URLs resolve like http, so the import map's "./lib/..." and relative imports work and
// the origin is app://game; secure: a secure context, as on https; supportFetchAPI: fetch() may use the scheme.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 360,
    backgroundColor: BACKGROUND,
    title: 'Banana Skyline',
    icon: !app.isPackaged && fs.existsSync(DEV_ICON) ? DEV_ICON : undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${ORIGIN}/`)) event.preventDefault();
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  win.loadURL(`${ORIGIN}/`);
  return win;
}

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null); // macOS keeps its app menu (Quit, Hide, ...)
  protocol.handle('app', async (request) => {
    const { status, headers, body } = await serve(request.url, DIST);
    return new Response(body, { status, headers });
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !PAGE_SCHEMES.has(details.url.slice(0, details.url.indexOf(':') + 1)) });
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
