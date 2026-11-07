// How the game was started. The Quest app (quest-app/, Meta's immersive PWA mode) opens the site with
// ?app: it has no 2D panel, so the game must enter VR by itself right after loading (src/app/main.js).
// In a browser the flag is harmless: without a user gesture the session request fails and the title
// screen shows as usual.
export function launchedAsApp(search = globalThis.location?.search ?? '') {
  return new URLSearchParams(search).has('app');
}
