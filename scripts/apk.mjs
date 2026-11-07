#!/usr/bin/env node
// Builds the Quest app and installs it on a headset connected by USB. The app is an Android package (a
// Trusted Web Activity) that opens the game published by `npm run deploy`; Meta's Bubblewrap generates
// its project from quest-app/twa-manifest.json, which holds the address. It only has to be rebuilt when
// that address, the name, the icon or the signing key change; game updates arrive with `npm run deploy`.
// Needs, once: npm install -g @meta-quest/bubblewrap-cli@1.24.1, then `bubblewrap doctor` (it offers to
// install a JDK 17 and the Android SDK). The first run creates the signing key in quest-app/.
// Usage: node scripts/apk.mjs [--serial ID] [--no-install]
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { findAdb } from './adb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'quest-app');
const MANIFEST = path.join(APP, 'twa-manifest.json');
const SIGNING = path.join(APP, 'signing.json'); // keystore passwords; private, like the keystore
const APK = path.join(APP, 'app-release-signed.apk');
const BUILD_TOOLS = '34.0.0'; // what Bubblewrap 1.24 uses

const { values: opts } = parseArgs({
  options: {
    serial: { type: 'string' },
    'no-install': { type: 'boolean', default: false },
  },
});

function fail(lines) {
  console.error([].concat(lines).join('\n'));
  process.exit(1);
}

function findBubblewrap() {
  const rel = path.join('@meta-quest', 'bubblewrap-cli', 'bin', 'bubblewrap.js');
  const candidates = [
    process.env.BUBBLEWRAP_CLI,
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', rel), // npm -g on Windows
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', rel), // npm -g on macOS/Linux
  ];
  return candidates.find(c => c && fs.existsSync(c))
    ?? fail(['Bubblewrap is not installed. Install it once with:', '  npm install -g @meta-quest/bubblewrap-cli@1.24.1', 'then run `bubblewrap doctor` and let it install the JDK and Android SDK.']);
}

function bubblewrapConfig() {
  const file = path.join(os.homedir(), '.bubblewrap', 'config.json');
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (!config.jdkPath || !config.androidSdkPath) fail(['Bubblewrap has no JDK or Android SDK yet: run `bubblewrap doctor` once and let it install them.']);
  return config;
}

function keytool(config, args, password) {
  const exe = path.join(config.jdkPath, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  return execFileSync(exe, args, { encoding: 'utf8', env: { ...process.env, BANANA_KEY_PASS: password }, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The signing key's passwords, creating the key on first use. */
function signingKey(config, manifest) {
  const keystore = path.resolve(APP, manifest.signingKey.path);
  if (fs.existsSync(keystore) !== fs.existsSync(SIGNING)) {
    fail([`Found only one of ${keystore} and ${SIGNING}; both are needed to sign the app.`,
      'Restore the missing one from your backup (or delete both to create a new key, then uninstall the old app first).']);
  }
  if (!fs.existsSync(keystore)) {
    const password = crypto.randomBytes(18).toString('base64url');
    keytool(config, ['-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', manifest.signingKey.alias,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', `CN=${manifest.name}`,
      '-storepass:env', 'BANANA_KEY_PASS', '-keypass:env', 'BANANA_KEY_PASS'], password);
    fs.writeFileSync(SIGNING, `${JSON.stringify({ keystorePassword: password, keyPassword: password }, null, 2)}\n`);
    console.log(`Created the signing key ${path.relative(ROOT, keystore)} (passwords in ${path.relative(ROOT, SIGNING)}).`);
    console.log('Back up both files: updates to the installed app must be signed with the same key.');
  }
  return JSON.parse(fs.readFileSync(SIGNING, 'utf8'));
}

/** SHA-256 fingerprint of the signing certificate, as AA:BB:... */
function fingerprint(config, manifest, passwords) {
  const out = keytool(config, ['-list', '-v', '-keystore', path.resolve(APP, manifest.signingKey.path), '-alias', manifest.signingKey.alias,
    '-storepass:env', 'BANANA_KEY_PASS'], passwords.keystorePassword);
  return /SHA256:\s*([0-9A-F:]{95})/.exec(out)?.[1] ?? fail(['Could not read the SHA-256 fingerprint from keytool:', out]);
}

/** The Digital Asset Links file the site publishes to vouch for the app; an immersive app needs it to launch. */
function assetLinks(packageId, fingerprints) {
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: packageId, sha256_cert_fingerprints: fingerprints },
  }];
}

async function checkAssetLinks(manifest) {
  const url = `https://${manifest.host}/.well-known/assetlinks.json`;
  try {
    const res = await fetch(url);
    const links = res.ok ? await res.json() : [];
    const ok = links.some(l => l.target?.package_name === manifest.packageId
      && manifest.fingerprints.every(f => l.target.sha256_cert_fingerprints?.includes(f.value)));
    if (ok) return console.log(`${url} vouches for this app.`);
  } catch { /* reported below */ }
  console.log(`${url} does not list this app (package and signing key).`);
  console.log(manifest.horizonOSAppMode === 'immersive'
    ? 'An immersive app does not launch until it does: publish quest-app/assetlinks.json at that address (see README).'
    : 'The app opens with a browser bar at the top until it does: publish quest-app/assetlinks.json at that address (see README).');
}

function run(what, cmd, args, { shell = false, env } = {}) {
  // A .bat file needs a shell (Node refuses to spawn one directly); `shell` passes one command line.
  const r = shell ? spawnSync([cmd, ...args].join(' '), { cwd: APP, stdio: 'inherit', env, shell: true })
    : spawnSync(cmd, args, { cwd: APP, stdio: 'inherit', env });
  if (r.status !== 0) fail(`${what} failed (exit ${r.status ?? r.error?.message}).`);
}

/**
 * The APK steps of `bubblewrap build`, which cannot start gradlew.bat on Windows with current Node.js
 * (spawn EINVAL, the CVE-2024-27980 fix): Gradle, zipalign, then apksigner with the passwords passed
 * through the environment instead of the command line.
 */
function buildApk(config, manifest, passwords) {
  const win = process.platform === 'win32';
  const sdk = config.androidSdkPath;
  const tools = path.join(sdk, 'build-tools', BUILD_TOOLS);
  const javaHome = fs.existsSync(path.join(config.jdkPath, 'Contents', 'Home')) ? path.join(config.jdkPath, 'Contents', 'Home') : config.jdkPath;
  const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };
  if (!fs.existsSync(tools)) {
    console.log(`Installing the Android SDK build tools ${BUILD_TOOLS}: answer y to accept the Android SDK license.`);
    const sdkmanager = ['tools/bin/sdkmanager', 'cmdline-tools/latest/bin/sdkmanager', 'bin/sdkmanager']
      .map(p => path.join(sdk, p) + (win ? '.bat' : '')).find(p => fs.existsSync(p)) ?? fail(`No sdkmanager in ${sdk}.`);
    run('sdkmanager', `"${sdkmanager}"`, [`"build-tools;${BUILD_TOOLS}"`, `"--sdk_root=${sdk}"`], { shell: true, env });
  }
  run('Gradle', win ? `"${path.join(APP, 'gradlew.bat')}"` : path.join(APP, 'gradlew'), ['assembleRelease', '--stacktrace'], { shell: win, env });
  const aligned = path.join(APP, 'app-release-unsigned-aligned.apk');
  run('zipalign', path.join(tools, win ? 'zipalign.exe' : 'zipalign'), ['-p', '-f', '4', path.join(APP, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk'), aligned], { env });
  run('apksigner', path.join(javaHome, 'bin', win ? 'java.exe' : 'java'), ['-jar', path.join(tools, 'lib', 'apksigner.jar'), 'sign',
    '--ks', path.resolve(APP, manifest.signingKey.path), '--ks-key-alias', manifest.signingKey.alias,
    '--ks-pass', 'env:BANANA_KS_PASS', '--key-pass', 'env:BANANA_KEY_PASS', '--out', APK, aligned],
  { env: { ...env, BANANA_KS_PASS: passwords.keystorePassword, BANANA_KEY_PASS: passwords.keyPassword } });
}

const cli = findBubblewrap();
const config = bubblewrapConfig();
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const passwords = signingKey(config, manifest);

// Keep the key's fingerprint and the asset links file in step with the key.
const fp = fingerprint(config, manifest, passwords);
if (!manifest.fingerprints.some(f => f.value === fp)) {
  manifest.fingerprints = [{ name: 'signing key', value: fp }];
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}
fs.writeFileSync(path.join(APP, 'assetlinks.json'), `${JSON.stringify(assetLinks(manifest.packageId, [fp]), null, 2)}\n`);

run('bubblewrap update', process.execPath, [cli, 'update', '--skipVersionUpgrade']); // regenerates the Android project
buildApk(config, manifest, passwords);
console.log(`Built ${path.relative(ROOT, APK)} (${(fs.statSync(APK).size / 1024).toFixed(0)} KB) for https://${manifest.host}${manifest.startUrl}`);
await checkAssetLinks(manifest);

if (!opts['no-install']) {
  const adb = (args) => execFileSync(findAdb(), [...(opts.serial ? ['-s', opts.serial] : []), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    adb(['install', '-r', APK]);
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message).toString().trim();
    if (/UPDATE_INCOMPATIBLE|signatures do not match/i.test(msg)) {
      fail(['The headset has this app signed with a different key. Uninstall it first (this clears its settings):',
        `  adb uninstall ${manifest.packageId}`, msg]);
    }
    fail([`adb install failed. Is the headset connected? (npm run quest -- --status)`, msg]);
  }
  adb(['shell', 'am', 'start', '-n', `${manifest.packageId}/.LauncherActivity`]);
  console.log(`Installed and started ${manifest.packageId}. In the headset: Library > Unknown Sources > ${manifest.launcherName}.`);
}
