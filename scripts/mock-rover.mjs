#!/usr/bin/env node
// A stand-in for the EarthRover SDK (port 8000) to try the Rover Cockpit without the rover:
// /feed sends moving test pictures for both cameras, /control prints what it is told, /data makes up telemetry.
// The pictures react to the commands (the stripes scroll with "linear", the marker slides with "angular").
// /status answers like the SDK's (browser, rover link with its delivered count, telemetry age). GET /mock
// switches faults on (0) and off (1), to try the cockpit's warnings:
//   deliver=0  the rover stops confirming commands (the SDK still answers 200),
//   rtm=0      the SDK's link to the rover is down (/control answers 500, like the SDK),
//   freeze=1   the picture freezes but frames keep coming (the SDK re-sends the last picture),
//   ready=0    the SDK's browser is not up yet (/status says so, /feed answers 503 after 5 s).
// Usage: node scripts/mock-rover.mjs [--port 8000] [--no-rear]
import http from 'node:http';
import zlib from 'node:zlib';
import { parseArgs } from 'node:util';

const { values: opts } = parseArgs({ options: { port: { type: 'string' }, 'no-rear': { type: 'boolean', default: false } } });
const PORT = Number(opts.port ?? 8000);
const W = 320;
const H = 180;

let command = { linear: 0, angular: 0, lamp: 0 };
let travelled = 0;
let heading = 0;
let commands = 0;
let delivered = 0;
const mock = { deliver: true, rtm: true, freeze: false, ready: true };
const lastFrame = {};
setInterval(() => {
  travelled += command.linear * 4;
  heading = (heading - command.angular * 6 + 360) % 360;
}, 50);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function png(pixel) {
  const raw = Buffer.alloc(H * (1 + W * 3));
  for (let y = 0; y < H; y++) {
    const row = y * (1 + W * 3) + 1;
    for (let x = 0; x < W; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + x * 3] = r;
      raw[row + x * 3 + 1] = g;
      raw[row + x * 3 + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A road seen from the camera: sky on top, ground stripes that scroll as the rover moves, a heading marker. */
function frame(view) {
  const rear = view === 'rear';
  const dir = rear ? -1 : 1;
  const marker = W / 2 + dir * (((heading + 180) % 360) - 180) * 0.8;
  const lamp = command.lamp ? 40 : 0;
  return png((x, y) => {
    if (Math.abs(x - marker) < 3 && y < 24) return [255, 255, 255];
    if (y < H * 0.45) return rear ? [150 + lamp, 90, 60] : [70, 120 + lamp, 200];
    const depth = (y - H * 0.45) / (H * 0.55);
    const stripe = Math.floor((1 / (depth + 0.08)) * 6 + dir * travelled * 0.2) % 2 === 0;
    const road = Math.abs(x - W / 2) < 20 + depth * 110;
    const base = road ? (stripe ? 70 : 90) : (stripe ? 40 : 55);
    return road ? [base + lamp, base + lamp, base + lamp] : [30, base + 40, 30];
  });
}

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }).end(JSON.stringify(body));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/feed') {
    const view = url.searchParams.get('view') ?? 'front';
    if (view !== 'front' && view !== 'rear') return json(res, 400, { detail: 'Invalid view' });
    if (view === 'rear' && opts['no-rear']) return json(res, 404, { detail: 'Rear camera is not available' });
    const fps = Math.min(30, Math.max(1, Number(url.searchParams.get('fps')) || 15));
    if (!mock.ready) {
      const late = setTimeout(() => json(res, 503, { detail: `${view} camera is not ready` }), 5000);
      res.on('close', () => clearTimeout(late));
      return undefined;
    }
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=frame', 'access-control-allow-origin': '*' });
    const timer = setInterval(() => {
      const image = mock.freeze && lastFrame[view] ? lastFrame[view] : frame(view);
      lastFrame[view] = image;
      res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${image.length}\r\n\r\n`);
      res.write(image);
      res.write('\r\n');
    }, 1000 / fps);
    res.on('close', () => clearInterval(timer));
    return undefined;
  }
  if (req.method === 'GET' && url.pathname === '/data') {
    return json(res, 200, {
      battery: 87, signal_level: 5, orientation: Math.round(heading), lamp: command.lamp, speed: Math.abs(command.linear) * 1.2,
      gps_signal: 31.2, latitude: 37.7749, longitude: -122.4194, vibration: 0.1, timestamp: Date.now() / 1000,
    });
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    return json(res, 200, {
      browser_ready: mock.ready, browser_error: null, mission_started: true, command,
      rtm: mock.ready ? { ready: mock.rtm, dispatched: commands, delivered, failed: commands - delivered, last_error: mock.rtm ? null : 'RTM client is not connected' } : null,
      telemetry_age_s: mock.ready ? 0.4 : null,
      video: { front: { loop_running: true, last_error: null }, rear: opts['no-rear'] ? null : { loop_running: true, last_error: null } },
    });
  }
  if (req.method === 'GET' && url.pathname === '/mock') {
    for (const key of Object.keys(mock)) if (url.searchParams.has(key)) mock[key] = url.searchParams.get(key) !== '0';
    return json(res, 200, mock);
  }
  if (req.method === 'POST' && url.pathname === '/control') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const next = JSON.parse(body).command;
        if (!next) return json(res, 400, { detail: 'Command not provided' });
        if (!mock.rtm || !mock.ready) return json(res, 500, { detail: 'Failed to send control command: RTM client is not connected' });
        const changed = JSON.stringify(next) !== JSON.stringify(command);
        command = { linear: Number(next.linear) || 0, angular: Number(next.angular) || 0, lamp: next.lamp ? 1 : 0 };
        commands++;
        if (mock.deliver && mock.rtm) delivered++;
        if (changed) console.log(`[rover] linear ${command.linear} angular ${command.angular} lamp ${command.lamp}`);
        return json(res, 200, { message: 'Command sent successfully' });
      } catch {
        return json(res, 400, { detail: 'Bad JSON' });
      }
    });
    return undefined;
  }
  return json(res, 404, { detail: 'Not found' });
});

server.listen(PORT, '127.0.0.1', () => console.log(`Mock rover: http://localhost:${PORT}/ (stands in for the EarthRover SDK)`));
