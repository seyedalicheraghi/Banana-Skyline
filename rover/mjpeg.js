// Incremental parser for a multipart/x-mixed-replace stream (the EarthRover SDK's /feed): feed it the
// bytes as they arrive, get back every complete image. No DOM, so it runs in Node tests too.

const CRLF2 = [13, 10, 13, 10];
const MAX_BUFFER = 8 * 1024 * 1024; // a stream that never completes a part is dropped, not grown forever

function indexOf(buf, pattern, from = 0) {
  outer: for (let i = from; i <= buf.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) if (buf[i + j] !== pattern[j]) continue outer;
    return i;
  }
  return -1;
}

export class MjpegParser {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  /** @param {Uint8Array} chunk @returns {{type: string, data: Uint8Array}[]} the parts completed by this chunk */
  push(chunk) {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    const parts = [];
    for (;;) {
      const headEnd = indexOf(this.buf, CRLF2);
      if (headEnd < 0) break;
      const head = new TextDecoder('latin1').decode(this.buf.subarray(0, headEnd));
      const length = Number(head.match(/content-length:\s*(\d+)/i)?.[1]);
      const type = head.match(/content-type:\s*([^\r\n;]+)/i)?.[1].trim() ?? 'image/jpeg';
      const start = headEnd + 4;
      let end;
      if (Number.isFinite(length)) {
        end = start + length;
        if (this.buf.length < end) break;
      } else {
        // No length: the image runs to the next boundary line.
        end = indexOf(this.buf, [13, 10, 45, 45], start);
        if (end < 0) break;
      }
      if (end > start) parts.push({ type, data: this.buf.slice(start, end) });
      this.buf = this.buf.subarray(end);
    }
    if (this.buf.length > MAX_BUFFER) this.buf = new Uint8Array(0);
    return parts;
  }
}
