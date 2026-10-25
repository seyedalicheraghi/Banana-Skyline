#!/usr/bin/env node
// Open Banana Skyline on a Meta Quest connected by USB:
//   1. find adb and the headset, 2. serve the game on this PC (unless already running),
//   3. `adb reverse` the port so the headset's localhost reaches this PC, 4. open it in Quest Browser.
// Usage: node scripts/quest.mjs [--port 8080] [--serial ID] [--no-launch] [--status]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.PORT || '8080' },
    serial: { type: 'string' },
    'no-launch': { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
  },
});
const PORT = Number(opts.port);
const URL = `http://localhost:${PORT}/`; // the game logs back to this terminal from Quest Browser ([headset] lines)
const BROWSER = 'com.oculus.browser';

function findAdb() {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', exe),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', exe),
  ];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    const winget = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const dir of fs.readdirSync(winget)) {
        if (dir.startsWith('Google.PlatformTools')) candidates.push(path.join(winget, dir, 'platform-tools', exe));
      }
    } catch { /* winget not used */ }
    candidates.push(path.join(local, 'Android', 'Sdk', 'platform-tools', exe));
  } else {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', exe));
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', exe));
  }
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return exe; // hope it is on PATH
}

const ADB = findAdb();

function adb(args, { quiet = false } = {}) {
  const full = opts.serial ? ['-s', opts.serial, ...args] : args;
  try {
    return execFileSync(ADB, full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (quiet) return null;
    const msg = (err.stderr || err.stdout || err.message || '').toString().trim();
    throw new Error(`adb ${full.join(' ')} failed: ${msg}`);
  }
}

function devices() {
  const out = adb(['devices', '-l']);
  return out.split(/\r?\n/).slice(1).filter(Boolean).map((line) => {
    const [serial, state, ...rest] = line.trim().split(/\s+/);
    const info = Object.fromEntries(rest.map(kv => kv.split(':')).filter(p => p.length === 2));
    return { serial, state, model: info.model ?? '', product: info.product ?? '' };
  });
}

function serverUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function fail(lines) {
  console.error(lines.join('\n'));
  process.exit(1);
}

let list;
try {
  list = devices();
} catch (err) {
  fail([`Could not run adb (${ADB}).`, err.message, 'Install it with: winget install Google.PlatformTools']);
}

if (!opts.serial) {
  const ready = list.filter(d => d.state === 'device');
  if (ready.length === 1) opts.serial = ready[0].serial;
  else if (ready.length > 1) fail(['Several devices are connected; pick one with --serial:', ...ready.map(d => `  ${d.serial}  ${d.model}`)]);
}
const device = list.find(d => d.serial === opts.serial);

if (!device) {
  if (list.some(d => d.state === 'unauthorized')) {
    fail([
      'The headset is connected but has not allowed this PC yet.',
      'Put the headset on and choose "Allow" (tick "Always allow from this computer") on the USB debugging prompt, then run this again.',
    ]);
  }
  fail([
    'No Meta Quest found over USB.',
    '  1. Turn on Developer Mode: Meta Horizon phone app > Devices > your headset > Headset settings > Developer Mode.',
    '  2. Restart the headset, then connect it to this PC with a USB-C data cable.',
    '  3. In the headset, allow USB debugging for this computer.',
    `Then run: node scripts/quest.mjs   (adb: ${ADB})`,
  ]);
}
if (device.state !== 'device') fail([`Device ${device.serial} is "${device.state}". Reconnect the cable and allow USB debugging in the headset.`]);

const model = adb(['shell', 'getprop', 'ro.product.model'], { quiet: true }) || device.model;
const os_ = adb(['shell', 'getprop', 'ro.build.version.release'], { quiet: true });
const battery = (adb(['shell', 'dumpsys', 'battery'], { quiet: true }) ?? '').match(/level:\s*(\d+)/)?.[1];
console.log(`Headset: ${model} (${device.serial}), Android ${os_ ?? '?'}${battery ? `, battery ${battery}%` : ''}`);
if (opts.status) process.exit(0);

if (!(await serverUp())) {
  process.env.PORT = String(PORT);
  await import('../server.mjs'); // starts listening and keeps this process alive
  console.log('Started the game server here; leave this window open while you play.');
} else {
  console.log(`Game server already running on port ${PORT}.`);
}

adb(['reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
console.log(`Headset localhost:${PORT} now reaches this PC.`);

if (!opts['no-launch']) {
  adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', URL, BROWSER]);
  console.log(`Opened ${URL} in Quest Browser. Put the headset on and press "Play in VR".`);
}
