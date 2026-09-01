#!/usr/bin/env node
/**
 * Split a sheet of seals into individual transparent PNGs.
 *
 * Generating both seals in one image is what finally made them match — one
 * pass means one lighting direction, one wax texture, one rendering style, for
 * free. Matching a second image to an existing one is the unreliable path.
 *
 * So this takes that sheet, finds each seal, and cuts it out square and
 * centred. Seals come back in left-to-right order.
 *
 *   node tools/split-seals.mjs sheet.png out-a.png out-b.png [--tol 150] [--size 512]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { decode, encode } from './png.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const positional = args.filter((a, i) =>
  !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--'))
);
const [input, ...outputs] = positional;
const TOL = opt('tol', 150);
const SIZE = opt('size', 512);

if (!input || !outputs.length) {
  console.error('usage: node tools/split-seals.mjs <sheet.png> <out1.png> [out2.png ...] [--tol 150] [--size 512]');
  process.exit(1);
}

const img = decode(await readFile(input));
const { width, height, rgba } = img;
const at = (x, y) => (y * width + x) * 4;

// ── background, from the border ─────────────────────────────────────────────
const tally = new Map();
const border = [];
for (let x = 0; x < width; x++) border.push([x, 0], [x, height - 1]);
for (let y = 0; y < height; y++) border.push([0, y], [width - 1, y]);
for (const [x, y] of border) {
  const i = at(x, y);
  const k = `${rgba[i]},${rgba[i + 1]},${rgba[i + 2]}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}
const [bgKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
const [br, bg, bb] = bgKey.split(',').map(Number);
const dist = (i) =>
  Math.abs(rgba[i] - br) + Math.abs(rgba[i + 1] - bg) + Math.abs(rgba[i + 2] - bb);

// A generous tolerance on purpose: the sheet's soft drop shadows are grey on
// grey, so a tight threshold leaves each seal sitting in a grey smudge. The
// seals themselves are strongly coloured and nowhere near the ground.
const outside = new Uint8Array(width * height);
const stack = [];
const seed = (x, y) => {
  const p = y * width + x;
  if (!outside[p] && dist(at(x, y)) <= TOL) { outside[p] = 1; stack.push(p); }
};
for (const [x, y] of border) seed(x, y);
while (stack.length) {
  const p = stack.pop();
  const x = p % width, y = (p / width) | 0;
  if (x > 0) seed(x - 1, y);
  if (x < width - 1) seed(x + 1, y);
  if (y > 0) seed(x, y - 1);
  if (y < height - 1) seed(x, y + 1);
}

// ── find each seal ──────────────────────────────────────────────────────────
const label = new Int32Array(width * height);
const blobs = [];
for (let p0 = 0; p0 < width * height; p0++) {
  if (outside[p0] || label[p0]) continue;
  const id = blobs.length + 1;
  let size = 0, minX = width, maxX = 0, minY = height, maxY = 0;
  const q = [p0];
  label[p0] = id;
  while (q.length) {
    const p = q.pop();
    const x = p % width, y = (p / width) | 0;
    size++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const push = (nx, ny) => {
      const np = ny * width + nx;
      if (outside[np] || label[np]) return;
      label[np] = id;
      q.push(np);
    };
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  blobs.push({ id, size, minX, maxX, minY, maxY });
}

const seals = blobs
  .filter((b) => b.size > (width * height) / 400)   // ignore specks
  .sort((a, b) => b.size - a.size)
  .slice(0, outputs.length)
  .sort((a, b) => a.minX - b.minX);                 // left to right

if (seals.length < outputs.length) {
  console.error(`Found ${seals.length} seal(s) but ${outputs.length} output(s) were named.`);
  process.exit(1);
}

// ── crop each one square and centred ────────────────────────────────────────
for (const [n, seal] of seals.entries()) {
  const w = seal.maxX - seal.minX + 1;
  const h = seal.maxY - seal.minY + 1;
  const side = Math.max(w, h);
  const pad = Math.round(side * 0.04);              // a little air, so the
  const box = side + pad * 2;                       // rim is never clipped
  const cx = (seal.minX + seal.maxX) / 2;
  const cy = (seal.minY + seal.maxY) / 2;
  const x0 = Math.round(cx - box / 2);
  const y0 = Math.round(cy - box / 2);

  // Nearest-neighbour would alias the rim; sample a box per output pixel so
  // the downscale stays smooth and the alpha edge averages properly.
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const scale = box / SIZE;
  const step = Math.max(1, Math.floor(scale));

  for (let oy = 0; oy < SIZE; oy++) {
    for (let ox = 0; ox < SIZE; ox++) {
      let r = 0, g = 0, b = 0, a = 0, count = 0;
      const sx0 = x0 + ox * scale;
      const sy0 = y0 + oy * scale;
      for (let dy = 0; dy < scale; dy += step) {
        for (let dx = 0; dx < scale; dx += step) {
          const sx = Math.round(sx0 + dx), sy = Math.round(sy0 + dy);
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) { count++; continue; }
          const p = sy * width + sx;
          count++;
          // Only this seal counts as opaque: a neighbouring seal that strays
          // into the crop box must not bleed into it.
          if (outside[p] || label[p] !== seal.id) continue;
          const i = p * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
          a += 255;
        }
      }
      const o = (oy * SIZE + ox) * 4;
      const solid = a / 255;
      if (solid === 0) { out[o + 3] = 0; continue; }
      out[o]     = Math.round(r / solid);
      out[o + 1] = Math.round(g / solid);
      out[o + 2] = Math.round(b / solid);
      out[o + 3] = Math.round(a / count);            // coverage → anti-aliased rim
    }
  }

  await writeFile(outputs[n], encode({ width: SIZE, height: SIZE, rgba: out }));
  console.log(
    `${outputs[n]}: ${SIZE}×${SIZE} from a ${w}×${h} seal at (${seal.minX},${seal.minY})`
  );
}

console.log(`background rgb(${br},${bg},${bb}), tolerance ${TOL}`);
