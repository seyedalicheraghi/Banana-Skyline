// Service worker of the built game: scripts/build.mjs writes dist/sw.js from this file, filling in
// VERSION (a hash of the build) and FILES (every file of the build). Installing caches all of them, so
// the game starts with no network; a new build has a new VERSION, replaces the cache and is used from
// the next launch on.
const VERSION = 'dev';
const FILES = [];
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
