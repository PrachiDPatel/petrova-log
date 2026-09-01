#!/usr/bin/env node
/**
 * Re-encode a transparent PNG as WebP.
 *
 * The seals are photographic wax texture with an alpha channel, which is close
 * to the worst case for PNG: it stores that texture losslessly and the file
 * lands around 330 KB each. Two of those on a login screen is most of a
 * megabyte before a single letter has loaded, on a public demo, for two images
 * displayed at 110 px.
 *
 * WebP handles exactly this — lossy colour, lossless alpha — and every browser
 * has supported it for years. There is no encoder in Node's standard library,
 * but Chromium has one and this project already runs Chromium for screenshots,
 * so the canvas does the work rather than adding a native dependency.
 *
 *   node tools/to-webp.mjs assets/stamp-ryland.png [quality 0.92]
 */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const [file, q] = process.argv.slice(2);
if (!file) {
  console.error('usage: node tools/to-webp.mjs <file.png> [quality]');
  process.exit(1);
}
const quality = Number(q) || 0.92;

const png = await readFile(file);
const before = png.length;

const browser = await chromium.launch();
const page = await browser.newPage();

const dataUrl = await page.evaluate(
  async ({ b64, quality }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', quality);
  },
  { b64: png.toString('base64'), quality }
);

await browser.close();

if (!dataUrl.startsWith('data:image/webp')) {
  console.error('Chromium did not produce WebP — refusing to write a mislabelled file.');
  process.exit(1);
}

const out = file.replace(/\.png$/i, '.webp');
const bytes = Buffer.from(dataUrl.split(',')[1], 'base64');
await writeFile(out, bytes);

const pct = (100 - (bytes.length / before) * 100).toFixed(0);
console.log(
  `${out}: ${(bytes.length / 1024).toFixed(0)} KB ` +
  `(was ${(before / 1024).toFixed(0)} KB as PNG — ${pct}% smaller), quality ${quality}`
);
