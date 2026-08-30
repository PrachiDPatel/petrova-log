#!/usr/bin/env node
/**
 * Give a seal PNG a real alpha channel.
 *
 * Both stamps shipped as colour-type 2 (RGB, no alpha): opaque rectangles that
 * CSS clipped into circles. Rocky's baked-in background was dark brown so it
 * blended with the theme; Ryland's was pale, so his green wax sat on a visible
 * light disc. Same CSS, different backgrounds baked into the art — which is why
 * it looked wrong on one seal and fine on the other, and why no amount of CSS
 * fixing helped.
 *
 * The fix is a flood fill inward from the border, not a circular mask: it only
 * clears background that is actually connected to the edge, so a colour that
 * also appears inside the wax survives. Edge pixels get partial alpha so the
 * result does not look cut out with scissors.
 *
 *   node tools/cut-seal.mjs assets/stamp-ryland.png [tolerance]
 *
 * Writes in place after saving <name>.orig.png once.
 */
import { readFile, writeFile, access } from 'node:fs/promises';
import { deflateSync, inflateSync } from 'node:zlib';

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

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ── decode ──────────────────────────────────────────────────────────────────
function decode(buf) {
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

function encode({ width, height, rgba }) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none. Simple and lossless.
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA — the whole point
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── the actual work ─────────────────────────────────────────────────────────
function cutBackground({ width, height, rgba }, tolerance) {
  const idx = (x, y) => (y * width + x) * 4;
  const near = (i, r, g, b) =>
    Math.abs(rgba[i] - r) + Math.abs(rgba[i + 1] - g) + Math.abs(rgba[i + 2] - b) <= tolerance;

  // The background colour is whatever dominates the border.
  const tally = new Map();
  const edge = [];
  for (let x = 0; x < width; x++) { edge.push([x, 0], [x, height - 1]); }
  for (let y = 0; y < height; y++) { edge.push([0, y], [width - 1, y]); }
  for (const [x, y] of edge) {
    const i = idx(x, y);
    const key = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const [br, bg, bb] = best.split(',').map(Number);

  // Flood inward from every border pixel that matches. Only background actually
  // connected to the edge is cleared, so the same colour inside the wax stays.
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (const [x, y] of edge) {
    const p = y * width + x;
    if (!seen[p] && near(idx(x, y), br, bg, bb)) { seen[p] = 1; stack.push(p); }
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p / width) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (seen[np] || !near(idx(nx, ny), br, bg, bb)) continue;
      seen[np] = 1;
      stack.push(np);
    }
  }

  for (let p = 0; p < width * height; p++) if (seen[p]) rgba[p * 4 + 3] = 0;

  // Feather: a kept pixel touching a cleared one goes half-transparent, so the
  // edge reads as wax rather than as something cut out with scissors.
  const copy = Buffer.from(rgba);
  let cleared = 0, feathered = 0;
  for (let p = 0; p < width * height; p++) {
    if (seen[p]) { cleared++; continue; }
    const x = p % width, y = (p / width) | 0;
    let touching = 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (seen[ny * width + nx]) touching++;
    }
    if (touching) { copy[p * 4 + 3] = 140; feathered++; }
  }
  return { rgba: copy, cleared, feathered, background: [br, bg, bb] };
}

const [file, tol] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/cut-seal.mjs <file.png> [tolerance]');
  process.exit(1);
}
const tolerance = Number(tol) || 60;

const buf = await readFile(file);
const img = decode(buf);
const { rgba, cleared, feathered, background } = cutBackground(img, tolerance);

const backup = file.replace(/\.png$/, '.orig.png');
try {
  await access(backup);
} catch {
  await writeFile(backup, buf); // keep the original exactly once
}

await writeFile(file, encode({ width: img.width, height: img.height, rgba }));

const pct = ((cleared / (img.width * img.height)) * 100).toFixed(1);
console.log(
  `${file}: ${img.width}×${img.height}, background rgb(${background.join(',')}) — ` +
  `cleared ${cleared} px (${pct}%), feathered ${feathered}. Now RGBA.`
);
