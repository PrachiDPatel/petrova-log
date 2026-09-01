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
  const dist = (i, r, g, b) =>
    Math.abs(rgba[i] - r) + Math.abs(rgba[i + 1] - g) + Math.abs(rgba[i + 2] - b);

  // The background colour is whatever dominates the border.
  const tally = new Map();
  const edge = [];
  for (let x = 0; x < width; x++) edge.push([x, 0], [x, height - 1]);
  for (let y = 0; y < height; y++) edge.push([0, y], [width - 1, y]);
  for (const [x, y] of edge) {
    const i = idx(x, y);
    const key = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const [best] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const [br, bg, bb] = best.split(',').map(Number);

  // 1. Flood inward from the border. Only background actually connected to the
  //    edge is cleared, so the same colour inside the wax survives.
  const outside = new Uint8Array(width * height);
  const stack = [];
  for (const [x, y] of edge) {
    const p = y * width + x;
    if (!outside[p] && dist(idx(x, y), br, bg, bb) <= tolerance) {
      outside[p] = 1;
      stack.push(p);
    }
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % width, y = (p / width) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const np = ny * width + nx;
      if (outside[np] || dist(idx(nx, ny), br, bg, bb) > tolerance) continue;
      outside[np] = 1;
      stack.push(np);
    }
  }

  // 2. Keep ONLY the largest surviving blob — the seal.
  //
  //    This is the step the first version lacked, and it is what the art
  //    actually needs. One seal shipped with a dashed cut-line drawn around it
  //    by the image generator; the flood flowed around those dashes rather than
  //    through them, leaving a ring of floating specks. The other carried a drop
  //    shadow and a stray sparkle. None of that is the seal, and none of it is
  //    connected to the seal, so a connectivity test removes all of it at once
  //    without knowing anything about what the leftovers were.
  const kept = new Uint8Array(width * height);
  let bestSize = 0, bestLabel = 0;
  const label = new Int32Array(width * height);
  let next = 0;
  for (let p0 = 0; p0 < width * height; p0++) {
    if (outside[p0] || label[p0]) continue;
    next++;
    let size = 0;
    const q = [p0];
    label[p0] = next;
    while (q.length) {
      const p = q.pop();
      size++;
      const x = p % width, y = (p / width) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const np = ny * width + nx;
        if (outside[np] || label[np]) continue;
        label[np] = next;
        q.push(np);
      }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
  }
  let specks = 0;
  for (let p = 0; p < width * height; p++) {
    if (!outside[p] && label[p] === bestLabel) kept[p] = 1;
    else if (!outside[p]) specks++;
  }

  // 3. Anti-alias the rim from neighbourhood coverage.
  //
  //    A hard binary mask leaves a stair-stepped edge, which is exactly what a
  //    cheap cut-out looks like — and the previous attempt derived alpha from
  //    colour distance, which returned full opacity for every edge pixel and so
  //    did nothing at all. Coverage is the honest measure: what fraction of the
  //    pixel's neighbourhood survived is what fraction of the pixel is wax.
  const out = Buffer.from(rgba);
  let cleared = 0, softened = 0;
  for (let p = 0; p < width * height; p++) {
    if (!kept[p]) { out[p * 4 + 3] = 0; cleared++; continue; }

    const x = p % width, y = (p / width) | 0;
    let inside = 0, counted = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        counted++;
        if (kept[ny * width + nx]) inside++;
      }
    }
    if (inside === counted) continue;          // fully interior
    out[p * 4 + 3] = Math.round(255 * (inside / counted));
    softened++;
  }

  return { rgba: out, cleared, specks, softened, background: [br, bg, bb], kept };
}

/**
 * Trim a seal to a wax silhouette.
 *
 * Real sealing wax is pressed, not cut: the edge is a soft lobed blob, never a
 * compass circle. One of these seals is painted that way and the other is a
 * flat disc, and side by side on the login screen the difference reads as two
 * unrelated pieces of art rather than one set.
 *
 * The lobes are a few summed harmonics of the angle — smooth, seamless at the
 * wrap, and deterministic, so re-running produces the same seal. Only ever
 * removes: it cannot invent wax that was not in the source.
 */
function waxify({ width, height, rgba }, amount = 1) {
  // Centre and mean radius of what is currently opaque.
  let sx = 0, sy = 0, n = 0;
  for (let p = 0; p < width * height; p++) {
    if (rgba[p * 4 + 3] < 128) continue;
    sx += p % width; sy += (p / width) | 0; n++;
  }
  if (!n) return { rgba, trimmed: 0 };
  const cx = sx / n, cy = sy / n;
  const radius = Math.sqrt(n / Math.PI);

  const lobes = (t) =>
    1
    + 0.045 * amount * Math.sin(7 * t + 1.1)
    + 0.030 * amount * Math.sin(11 * t + 2.7)
    + 0.020 * amount * Math.sin(5 * t + 0.4)
    + 0.014 * amount * Math.sin(13 * t + 5.2);

  const out = Buffer.from(rgba);
  let trimmed = 0;
  for (let p = 0; p < width * height; p++) {
    if (out[p * 4 + 3] === 0) continue;
    const dx = (p % width) - cx, dy = ((p / width) | 0) - cy;
    const r = Math.hypot(dx, dy);
    const edge = radius * lobes(Math.atan2(dy, dx));

    // One-pixel ramp across the boundary keeps the lobed edge smooth.
    const cover = Math.max(0, Math.min(1, edge - r + 0.5));
    if (cover >= 1) continue;
    const a = Math.round(out[p * 4 + 3] * cover);
    if (a !== out[p * 4 + 3]) { out[p * 4 + 3] = a; trimmed++; }
  }
  return { rgba: out, trimmed };
}

/**
 * Press a raised rim into a flat seal.
 *
 * A real wax seal has a lip: the stamp displaces wax outward, so the edge sits
 * proud of the engraved face and catches the light on one side while falling
 * into shadow on the other. One of these seals is painted that way; the other
 * was drawn as a flat disc with the device running straight to the edge, which
 * is why they read as unrelated even once both were cut correctly.
 *
 * So the rim is shaded into the pixels rather than drawn as a CSS ring — a ring
 * in CSS traces the border box, not the artwork, which is the exact bug that
 * put a pale disc behind both seals in the first place.
 *
 * Colours are derived from the seal's own average, so this works on any art
 * without being told what colour the wax is.
 */
function pressRim({ width, height, rgba }, widthFrac = 0.16) {
  let sx = 0, sy = 0, n = 0, sr = 0, sg = 0, sb = 0;
  for (let p = 0; p < width * height; p++) {
    if (rgba[p * 4 + 3] < 128) continue;
    sx += p % width; sy += (p / width) | 0; n++;
    sr += rgba[p * 4]; sg += rgba[p * 4 + 1]; sb += rgba[p * 4 + 2];
  }
  if (!n) return { rgba, rimmed: 0 };

  const cx = sx / n, cy = sy / n;
  const radius = Math.sqrt(n / Math.PI);
  const inner = radius * (1 - widthFrac);

  // Light from the upper left, as in the painted seal.
  const lx = -0.62, ly = -0.78;

  const out = Buffer.from(rgba);
  let rimmed = 0;
  for (let p = 0; p < width * height; p++) {
    if (out[p * 4 + 3] === 0) continue;
    const dx = (p % width) - cx, dy = ((p / width) | 0) - cy;
    const r = Math.hypot(dx, dy);
    if (r <= inner) continue;

    // 0 at the inner lip, 1 at the outer edge.
    let t = Math.min(1, (r - inner) / Math.max(1e-6, radius - inner));
    t = t * t * (3 - 2 * t);                    // smoothstep, so no hard seam

    // Surface normal on a rounded lip points outward; how much it faces the
    // light decides whether this part of the rim brightens or falls away.
    const lambert = r > 0 ? (dx / r) * lx + (dy / r) * ly : 0;

    // Sit the rim darker than the face, then modulate along the light.
    const shade = (1 - 0.30 * t) + 0.34 * t * lambert;

    for (let c = 0; c < 3; c++) {
      out[p * 4 + c] = Math.max(0, Math.min(255, Math.round(out[p * 4 + c] * shade)));
    }
    rimmed++;
  }
  return { rgba: out, rimmed };
}

const args = process.argv.slice(2);
const waxIdx = args.indexOf('--wax');
const waxAmount = waxIdx >= 0 ? Number(args[waxIdx + 1]) || 1 : 0;
const rimIdx = args.indexOf('--rim');
const rimWidth = rimIdx >= 0 ? Number(args[rimIdx + 1]) || 0.16 : 0;
// Drop the flag and, only when the flag is actually present, its value.
// (`waxIdx + 1` is 0 when the flag is absent, which previously ate the
// filename — the first positional argument.)
const skip = new Set();
if (waxIdx >= 0) { skip.add(waxIdx); skip.add(waxIdx + 1); }
if (rimIdx >= 0) { skip.add(rimIdx); skip.add(rimIdx + 1); }
const [file, tol] = args.filter((a, i) => !skip.has(i) && !a.startsWith('--'));
if (!file) {
  console.error('usage: node tools/cut-seal.mjs <file.png> [tolerance]');
  process.exit(1);
}
const tolerance = Number(tol) || 110;

const buf = await readFile(file);
const img = decode(buf);
let { rgba, cleared, specks, softened, background } = cutBackground(img, tolerance);

let rimmed = 0;
if (rimWidth > 0) {
  ({ rgba, rimmed } = pressRim({ width: img.width, height: img.height, rgba }, rimWidth));
}

let trimmed = 0;
if (waxAmount > 0) {
  ({ rgba, trimmed } = waxify({ width: img.width, height: img.height, rgba }, waxAmount));
}

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
  `cleared ${cleared} px (${pct}%), discarded ${specks} px not connected to the seal, ` +
  `softened ${softened} edge px` +
  (rimmed ? `, pressed a rim into ${rimmed} px` : '') +
  (trimmed ? `, waxed ${trimmed} px into a lobed edge` : '') + `. Now RGBA.`
);
