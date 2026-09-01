import { deflateSync, inflateSync } from 'node:zlib';

/**
 * A minimal PNG codec — decode to RGBA, encode from RGBA.
 *
 * Extracted so cut-seal.mjs and graft-seal.mjs share one implementation. Two
 * copies of scanline unfiltering is two places for a subtle bug to live, and
 * this project has already been bitten twice by config duplicated into a second
 * file that then drifted.
 *
 * 8-bit RGB and RGBA only, which is what the seal art is.
 */

// ── CRC32, as the PNG spec defines it ───────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── decode ──────────────────────────────────────────────────────────────────
export function decode(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const depth = buf[24];
  const colour = buf[25];
  if (depth !== 8 || (colour !== 2 && colour !== 6)) {
    throw new Error(`Only 8-bit RGB or RGBA supported; got depth ${depth}, colour type ${colour}.`);
  }
  const channels = colour === 6 ? 4 : 3;

  const idat = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters. Each row starts with a filter-type byte.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }

  // Normalise to RGBA so the rest of the script has one shape to think about.
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    rgba[i * 4] = out[j];
    rgba[i * 4 + 1] = out[j + 1];
    rgba[i * 4 + 2] = out[j + 2];
    rgba[i * 4 + 3] = channels === 4 ? out[j + 3] : 255;
  }
  return { width, height, rgba };
}

// ── encode ──────────────────────────────────────────────────────────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * Adaptive scanline filtering.
 *
 * PNG lets each row pick one of five filters, and the choice is what makes the
 * deflate that follows actually work. Writing filter 0 on every row is correct
 * but barely compresses: it shipped a 512x512 seal at 390 KB, when the same
 * image with per-row filtering is a fraction of that. The heuristic is the one
 * from the PNG spec — pick the filter whose output has the smallest sum of
 * absolute values, since bytes near zero are what deflate collapses.
 */
function filterScanline(cur, prev, bpp, out) {
  const len = cur.length;
  const candidates = [];

  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let type = 0; type < 5; type++) {
    const buf = Buffer.alloc(len);
    let score = 0;
    for (let i = 0; i < len; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (type === 0) v = cur[i];
      else if (type === 1) v = cur[i] - a;
      else if (type === 2) v = cur[i] - b;
      else if (type === 3) v = cur[i] - ((a + b) >> 1);
      else v = cur[i] - paeth(a, b, c);
      v &= 0xff;
      buf[i] = v;
      score += v < 128 ? v : 256 - v;   // signed distance from zero
    }
    candidates.push({ type, buf, score });
  }

  const best = candidates.reduce((m, c) => (c.score < m.score ? c : m));
  out.type = best.type;
  return best.buf;
}

export function encode({ width, height, rgba }) {
  const stride = width * 4;
  const bpp = 4;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : null;
    const pick = {};
    const filtered = filterScanline(cur, prev, bpp, pick);
    raw[y * (stride + 1)] = pick.type;
    filtered.copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
