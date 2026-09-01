#!/usr/bin/env node
/**
 * Recolour a wax seal, keeping its painting.
 *
 * Regenerating art to change a colour throws away the shading, the lobed edge
 * and the engraving, and gives you a different seal that happens to be the
 * right hue. Rotating hue keeps every brush value exactly where it is and only
 * moves where it sits on the colour wheel — the highlights stay highlights and
 * the lip stays a lip.
 *
 * The engraving is protected by hue: gold sits far from green or blue on the
 * wheel, so shifting only the wax band leaves the line-art untouched. That is
 * also why this works on a seal and would not work on art whose subject shares
 * a hue with its background.
 *
 *   node tools/recolor-seal.mjs in.png out.png --to 212
 *   node tools/recolor-seal.mjs in.png out.png --to 212 --from 120 --spread 55
 *
 * `--to` is the target hue in degrees. Without `--from` the dominant hue among
 * saturated opaque pixels is detected and used.
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
const [input, output] = positional;
if (!input || !output) {
  console.error('usage: node tools/recolor-seal.mjs <in.png> <out.png> --to <hue> [--from <hue>] [--spread <deg>]');
  process.exit(1);
}

const TARGET = opt('to', null);
if (TARGET === null) {
  console.error('--to <hue in degrees> is required');
  process.exit(1);
}
const SPREAD = opt('spread', 60);

// ── colour space ────────────────────────────────────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
}

/** Shortest signed distance between two hues, in degrees. */
function hueDist(a, b) {
  let d = ((a - b + 180) % 360 + 360) % 360 - 180;
  return d;
}

// ── go ──────────────────────────────────────────────────────────────────────
const img = decode(await readFile(input));
const { width, height, rgba } = img;

let FROM = opt('from', null);
if (FROM === null) {
  // The wax is whatever hue dominates the saturated, opaque, mid-tone pixels.
  // Gold engraving is a minority and the rim shadows are too dark to count.
  const bins = new Array(36).fill(0);
  for (let p = 0; p < width * height; p++) {
    if (rgba[p * 4 + 3] < 200) continue;
    const [h, s, l] = rgbToHsl(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
    if (s < 0.18 || l < 0.12 || l > 0.85) continue;
    bins[Math.floor(h / 10) % 36] += 1;
  }
  const best = bins.indexOf(Math.max(...bins));
  FROM = best * 10 + 5;
}

const out = Buffer.from(rgba);
let moved = 0, kept = 0;

for (let p = 0; p < width * height; p++) {
  const a = rgba[p * 4 + 3];
  if (a === 0) continue;

  const [h, s, l] = rgbToHsl(rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]);
  const d = Math.abs(hueDist(h, FROM));

  if (s < 0.06 || d > SPREAD) { kept++; continue; }

  // Feather at the edge of the band so wax that shades toward the engraving
  // does not band abruptly against it.
  const strength = d <= SPREAD * 0.6 ? 1 : 1 - (d - SPREAD * 0.6) / (SPREAD * 0.4);
  const shifted = h + hueDist(TARGET, FROM) * strength;

  const [r, g, b] = hslToRgb(shifted, s, l);
  out[p * 4] = r; out[p * 4 + 1] = g; out[p * 4 + 2] = b;
  moved++;
}

await writeFile(output, encode({ width, height, rgba: out }));
console.log(
  `${output}: hue ${FROM.toFixed(0)}° → ${TARGET}° (band ±${SPREAD}°) — ` +
  `${moved} px moved, ${kept} px left alone (engraving and neutrals)`
);
