// Service worker of the built game: scripts/build.mjs writes dist/sw.js from this file, filling in
// VERSION (a hash of the build) and FILES (every file of the build). Installing caches all of them, so
// the game starts with no network; a new build has a new VERSION, replaces the cache and is used from
// the next launch on.
const VERSION = '6886d4462f61';
const FILES = [
  "./",
  "assets/icon-192.png",
  "assets/icon-512.png",
  "index.html",
  "lib/three/build/three.core.js",
  "lib/three/build/three.module.js",
  "manifest.webmanifest",
  "src/app/main.js",
  "src/app/prefs.js",
  "src/app/remote-log.js",
  "src/audio/engine.js",
  "src/audio/loops.js",
  "src/audio/music.js",
  "src/audio/recipes.js",
  "src/audio/sfx.js",
  "src/core/ai.js",
  "src/core/city.js",
  "src/core/constants.js",
  "src/core/events.js",
  "src/core/game.js",
  "src/core/physics.js",
  "src/core/rng.js",
  "src/render/aim.js",
  "src/render/backdrop.js",
  "src/render/banana.js",
  "src/render/camera.js",
  "src/render/city-view.js",
  "src/render/effects.js",
  "src/render/monkey.js",
  "src/render/roof.js",
  "src/render/sky.js",
  "src/render/themes.js",
  "src/render/util.js",
  "src/render/view.js",
  "src/render/wind.js",
  "src/ui/dom.js",
  "src/ui/hud.js",
  "src/ui/input.js",
  "src/ui/menus.js",
  "src/ui/settings.js",
  "src/ui/toasts.js",
  "src/ui/ui.css",
  "src/ui/ui.js",
  "src/xr/hands.js",
  "src/xr/menu.js",
  "src/xr/panels.js",
  "src/xr/pointer.js",
  "src/xr/props.js",
  "src/xr/rig.js",
  "src/xr/state.js",
  "src/xr/throw.js",
  "src/xr/xr.js"
];
const PREFIX = 'banana-skyline-';
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (event) => {
  // cache: 'reload' skips the HTTP cache, so a new build never caches an old copy of a file.
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE)
    .then((cache) => cache.match(req, { ignoreSearch: true }))
    .then((hit) => hit ?? fetch(req)));
});
