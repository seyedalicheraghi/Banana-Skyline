#!/usr/bin/env node
// The desktop app (Electron, desktop/main.mjs). Both forms first build dist/ and draw the icons into desktop/build/,
// so the app always shows the current game and the .ico is never a stale binary in git.
//   node scripts/desktop.mjs           run the app from this folder (npm run desktop)
//   node scripts/desktop.mjs --build   package it with electron-builder into desktop/out/ (npm run desktop:build):
//                                      the Windows x64 installer and portable exe unless a platform is given;
//                                      other arguments go to electron-builder (`--build --mac`, `--build --linux`).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build.mjs';
import { iconPng } from './icons.mjs';
import { iconIco } from '../desktop/icon.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = path.join(ROOT, 'desktop', 'build'); // electron-builder's buildResources (desktop/electron-builder.json)
const PLATFORM_FLAG = /^(--?(w|win|windows|m|mac|macos|l|linux))$/;
const require = createRequire(import.meta.url);

/** icon.ico (the Windows exe, installer and taskbar) and icon.png (the window in development, macOS and Linux builds). */
export function writeIcons(dir = RESOURCES) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'icon.ico'), iconIco());
  fs.writeFileSync(path.join(dir, 'icon.png'), iconPng(512));
}

function run(command, args) {
  const r = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const packaging = args.includes('--build');
  try {
    const { files, bytes } = build(path.join(ROOT, 'dist'));
    writeIcons();
    console.log(`Built dist/ (${files.length} files, ${(bytes / 1024).toFixed(0)} KB) and desktop/build/icon.{ico,png}`);
    let status;
    if (packaging) {
      const rest = args.filter((a) => a !== '--build');
      const platform = rest.some((a) => PLATFORM_FLAG.test(a)) ? [] : ['--win', '--x64'];
      status = run(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'desktop/electron-builder.json', ...platform, ...rest]);
    } else {
      status = run(require('electron'), ['.', ...args]); // the electron package resolves to the path of its binary
    }
    process.exit(status);
  } catch (err) {
    console.error(`desktop: ${err.message}`);
    process.exit(1);
  }
}
