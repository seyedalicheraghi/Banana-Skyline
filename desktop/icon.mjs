// The Windows icon (.ico) of the desktop app, written at build time from the same drawing as every other icon
// (scripts/icons.mjs): a binary in git would go stale the moment the picture changes.
import { drawIcon, encodePng } from '../scripts/icons.mjs';

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]; // title bar, taskbar, Explorer views, Start menu, high DPI
export const PNG_FROM = 128; // Windows stores the big entries as PNG; the small ones stay classic DIBs for the oldest readers

/** An uncompressed entry: BITMAPINFOHEADER, BGRA rows bottom-up, then a 1-bit AND mask (all opaque: the alpha channel does the work). */
export function dibEntry(size, rgba) {
  const stride = size * 4;
  const maskStride = Math.ceil(size / 32) * 4; // mask rows are padded to 32 bits
  const out = Buffer.alloc(40 + stride * size + maskStride * size);
  out.writeUInt32LE(40, 0); // header size
  out.writeInt32LE(size, 4); // width
  out.writeInt32LE(size * 2, 8); // height counts the colour bitmap and the mask
  out.writeUInt16LE(1, 12); // planes
  out.writeUInt16LE(32, 14); // bits per pixel
  out.writeUInt32LE(0, 16); // BI_RGB, no compression
  out.writeUInt32LE(stride * size + maskStride * size, 20); // image size; resolution and palette fields stay 0
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * stride; // bottom row first
    const dst = 40 + y * stride;
    for (let x = 0; x < size; x++) {
      out[dst + x * 4] = rgba[src + x * 4 + 2];
      out[dst + x * 4 + 1] = rgba[src + x * 4 + 1];
      out[dst + x * 4 + 2] = rgba[src + x * 4];
      out[dst + x * 4 + 3] = rgba[src + x * 4 + 3];
    }
  }
  return out;
}

/** An .ico file of `entries` ([{ size, data }], data a PNG or a dibEntry) in the ICONDIR / ICONDIRENTRY layout. */
export function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1: icon
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size === 256 ? 0 : size; // 0 stands for 256
    dir[o + 1] = size === 256 ? 0 : size;
    dir[o + 2] = 0; // palette colours: none, 32-bit
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.data)]);
}

/** The app icon as a Windows .ico holding every size in `sizes`. */
export function iconIco(sizes = ICO_SIZES) {
  return encodeIco(sizes.map((size) => {
    const rgba = drawIcon(size);
    return { size, data: size >= PNG_FROM ? encodePng(size, size, rgba) : dibEntry(size, rgba) };
  }));
}
