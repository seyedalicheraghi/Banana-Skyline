// The app icon, drawn in code like everything else: a banana over a night skyline with the moon.
// The banana stays inside the central 80% circle, so the same picture also works as a maskable icon.
import zlib from 'node:zlib';

const SKY_TOP = [11, 16, 38]; // #0b1026, the page background
const SKY_BOTTOM = [52, 36, 92];
const MOON = [250, 240, 200];
const BUILDINGS = [[27, 33, 74], [36, 30, 70], [22, 40, 72]];
const WINDOW = [255, 214, 120];
const BANANA = [255, 214, 64];
const BANANA_SHADE = [222, 160, 20];
const STEM = [96, 62, 28];

// Skyline in fractions of the icon: [left, right, top]; windows on a fixed grid inside each.
const SKYLINE = [[0, 0.16, 0.74], [0.15, 0.3, 0.66], [0.29, 0.43, 0.78], [0.42, 0.6, 0.7],
  [0.59, 0.72, 0.62], [0.71, 0.86, 0.76], [0.85, 1, 0.68]];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Colour of the picture at (x, y) in 0..1, y down. */
function shade(x, y) {
  let c = mix(SKY_TOP, SKY_BOTTOM, y);
  if (Math.hypot(x - 0.79, y - 0.2) < 0.085) c = MOON;
  SKYLINE.forEach(([l, r, top], i) => {
    if (x < l || x >= r || y < top) return;
    c = BUILDINGS[i % BUILDINGS.length];
    const wx = ((x - l) * 40) % 1;
    const wy = ((y - top) * 40) % 1;
    const lit = (Math.floor((x - l) * 40) * 7 + Math.floor((y - top) * 40) * 3 + i) % 5 < 2;
    if (y > top + 0.03 && x > l + 0.02 && x < r - 0.02 && wx > 0.35 && wy > 0.4 && lit) c = WINDOW;
  });
  // Banana: a thick arc below a centre point, tilted, tapering to a stem at the upper right.
  const tilt = -0.25;
  const dx = x - 0.52;
  const dy = y - 0.2;
  const u = dx * Math.cos(tilt) - dy * Math.sin(tilt);
  const v = dx * Math.sin(tilt) + dy * Math.cos(tilt);
  const angle = Math.atan2(v, u); // 0 = right, PI/2 = straight down
  const t = (angle - 0.55) / (Math.PI - 1.1); // 0..1 along the arc
  if (t >= 0 && t <= 1) {
    const r = Math.hypot(u, v);
    const half = 0.08 * Math.pow(Math.sin(Math.PI * t), 0.55);
    const off = r - 0.35;
    if (Math.abs(off) < half) c = off > half * 0.35 ? BANANA_SHADE : BANANA;
    if (t < 0.06 && Math.abs(off) < 0.022) c = STEM;
  }
  return c;
}

/** RGBA pixels of a size x size icon, 4x4 supersampled. */
export function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const n = 4;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let sum = [0, 0, 0];
      for (let s = 0; s < n * n; s++) {
        const c = shade((i + ((s % n) + 0.5) / n) / size, (j + (Math.floor(s / n) + 0.5) / n) / size);
        sum = sum.map((v, k) => v + c[k]);
      }
      const o = (j * size + i) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = Math.round(sum[k] / (n * n));
      px[o + 3] = 255;
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode RGBA pixels as a PNG file. */
export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const iconPng = (size) => encodePng(size, size, drawIcon(size));
