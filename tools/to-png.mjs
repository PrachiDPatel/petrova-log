#!/usr/bin/env node
/**
 * Convert any image a browser can read into a PNG.
 *
 * The seal pipeline (split-seals → cut → to-webp) works in PNG because that is
 * what tools/png.mjs decodes. Generated art arrives as whatever the generator
 * produced — usually JPEG — so this is the front door.
 *
 * Chromium does the decoding rather than a native image dependency, for the
 * same reason to-webp.mjs uses it: this project already runs Chromium for
 * screenshots, so the decoder was already on the machine.
 *
 *   node tools/to-png.mjs sheet.jpeg sheet.png
 */
import { readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { chromium } from '@playwright/test';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: node tools/to-png.mjs <in.[jpg|jpeg|webp|png]> <out.png>');
  process.exit(1);
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
};
const mime = MIME[extname(input).toLowerCase()];
if (!mime) {
  console.error(`Unsupported input type: ${extname(input)}`);
  process.exit(1);
}

const src = await readFile(input);
const browser = await chromium.launch();
const page = await browser.newPage();

const { dataUrl, width, height } = await page.evaluate(
  async ({ b64, mime }) => {
    const img = new Image();
    img.src = `data:${mime};base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
  },
  { b64: src.toString('base64'), mime }
);

await browser.close();
await writeFile(output, Buffer.from(dataUrl.split(',')[1], 'base64'));
console.log(`${output}: ${width}×${height} PNG (from ${extname(input).slice(1).toUpperCase()})`);
