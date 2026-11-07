// src/app/launch.js: the Quest app opens the site with ?app (quest-app/twa-manifest.json startUrl).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchedAsApp } from '../src/app/launch.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('launchedAsApp: only the ?app flag counts', () => {
  assert.equal(launchedAsApp('?app'), true);
  assert.equal(launchedAsApp('?app=1&log'), true);
  assert.equal(launchedAsApp(''), false);
  assert.equal(launchedAsApp('?log'), false);
  assert.equal(launchedAsApp('?application'), false);
  assert.equal(launchedAsApp(), false, 'no location in Node');
});

test('the Quest app is an immersive PWA that starts the site with ?app', () => {
  const twa = JSON.parse(fs.readFileSync(path.join(ROOT, 'quest-app', 'twa-manifest.json'), 'utf8'));
  assert.equal(twa.isMetaQuest, true);
  assert.equal(twa.horizonOSAppMode, 'immersive', '2D mode has no immersive WebXR');
  assert.equal(twa.display, 'standalone');
  const start = new URL(twa.startUrl, `https://${twa.host}`);
  assert.equal(launchedAsApp(start.search), true, `startUrl ${twa.startUrl} must carry ?app`);
  assert.ok(start.href.startsWith(twa.fullScopeUrl), 'startUrl inside the scope');
  assert.equal(twa.webManifestUrl, `${twa.fullScopeUrl}manifest.webmanifest`);
});
