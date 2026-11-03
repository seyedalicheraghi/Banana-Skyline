#!/usr/bin/env node
// Open Banana Skyline on a Meta Quest connected by USB:
//   1. find adb and the headset, 2. serve the game on this PC (unless already running),
//   3. `adb reverse` the port so the headset's localhost reaches this PC, 4. open it in Quest Browser.
// Usage: node scripts/quest.mjs [--port 8080] [--serial ID] [--no-launch] [--status] [--dist]
//   --dist serves the build in dist/ (npm run build) on port 8081 instead, to test it before publishing.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { parseArgs } from 'node:util';
import { findAdb } from './adb.mjs';

const { values: opts } = parseArgs({
  options: {
    port: { type: 'string' },
    serial: { type: 'string' },
    'no-launch': { type: 'boolean', default: false },
    status: { type: 'boolean', default: false },
    dist: { type: 'boolean', default: false }, // read by server.mjs from process.argv
  },
});
const PORT = Number(opts.port ?? process.env.PORT ?? (opts.dist ? 8081 : 8080));
const URL = `http://localhost:${PORT}/`; // the game logs back to this terminal from Quest Browser ([headset] lines)
const BROWSER = 'com.oculus.browser';

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
