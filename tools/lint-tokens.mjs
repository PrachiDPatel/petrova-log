#!/usr/bin/env node
/**
 * Fail the build when a colour is written down anywhere but tokens.css.
 *
 * This exists because the same bug kept coming back. Blue from the app this was
 * forked from survived three rounds of retheming; then green survived the round
 * that removed the blue. Every time, the cause was the same — a colour written
 * as a literal in a rule, or worse in an inline SVG or a JavaScript string,
 * where no amount of editing the palette could reach it.
 *
 * A rule nobody can check is a rule that decays. So this is the check.
 *
 *   node tools/lint-tokens.mjs          # report
 *   node tools/lint-tokens.mjs --list   # report every occurrence
 *
 * Exits non-zero when anything is found.
 */
import { readFile } from 'node:fs/promises';

const FILES = ['styles.css', 'index.html', 'app.js', 'demo-store.js'];

/** tokens.css is the one place colour is allowed to be literal. */
const SOURCE_OF_TRUTH = 'tokens.css';

/**
 * Greys and pure black/white are exempt: shadows, scrims and paper are neutral
 * by nature and forcing them through the palette buys nothing. Everything with
 * an actual hue must be a token.
 */
function isNeutral(r, g, b) {
  const max = Math.max(r, g, b);
  const spread = max - Math.min(r, g, b);
  // Relative, not absolute. A flat threshold of 10 called #0a0f0b neutral —
  // spread 5 — when at that darkness it is a decidedly green black, and it was
  // being painted inline over the transition screen where no stylesheet could
  // reach it. Dark colours need a proportionally tighter bar.
  if (max <= 40) return spread <= 2;
  if (max <= 96) return spread <= 5;
  return spread <= 10;
}

// `(?<!&)` keeps HTML numeric entities (&#9776; — the hamburger glyph) from
// reading as hex colours, which is a false positive worth not living with.
const COLOUR = /(?<!&)#[0-9a-fA-F]{3,8}\b|\brgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)|\bhsla?\(/g;

function parse(text) {
  if (text.startsWith('#')) {
    let h = text.slice(1);
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    if (h.length < 6) return null;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const v = text.match(/[\d.]+/g);
  return v && v.length >= 3 ? v.slice(0, 3).map((x) => Math.round(parseFloat(x))) : null;
}

/**
 * A selector that names a person and sets a colour.
 *
 * The first check only sees literals, so a rule like
 *   .archive-card[data-sender="rocky"] .aes-tri-left { background: var(--gold); }
 * passes it — every value is a token. But it hardcodes WHICH person gets WHICH
 * token, which is the same bug one level up, and 21 of these were silently
 * overriding the envelope palette.
 *
 * Layout and visibility keyed to a person are fine; colour is not.
 */
const PAINTS = /(?:^|[;{\s])(?:background|color|border[a-z-]*color|fill|stroke|box-shadow|filter|outline-color)\s*:/;

function personNamedPaint(src) {
  const hits = [];
  const rule = /([^{}]*\[data-(?:user|sender)="[a-z0-9_-]+"\][^{}]*)\{([^}]*)\}/gi;
  for (const m of src.matchAll(rule)) {
    const selector = m[1].trim().split('\n').pop().trim();
    if (selector.startsWith('/*')) continue;
    if (!PAINTS.test(m[2])) continue;
    const line = src.slice(0, m.index).split('\n').length;
    hits.push({ line, selector: selector.slice(0, 72) });
  }
  return hits;
}

const listAll = process.argv.includes('--list');
let total = 0;
const report = [];

for (const file of FILES) {
  let src;
  try {
    src = await readFile(file, 'utf8');
  } catch {
    continue;
  }

  // Block comments are stripped across the whole file first, with newlines
  // kept so reported line numbers still point at the real line. Stripping them
  // per-line only catches single-line ones, and a multi-line comment that
  // documents a colour then reads as a violation.
  const blanked = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const lines = blanked.split('\n');
  const hits = [];

  lines.forEach((line, i) => {
    // A line that is only a comment cannot paint anything.
    const stripped = line.replace(/^\s*(\/\/|\*|<!--).*/, '');
    for (const m of stripped.matchAll(COLOUR)) {
      const rgb = parse(m[0]);
      if (!rgb) {
        hits.push({ line: i + 1, text: m[0], why: 'hsl() — use a token' });
        continue;
      }
      if (isNeutral(...rgb)) continue;
      hits.push({ line: i + 1, text: m[0], why: `rgb(${rgb.join(',')})` });
    }
  });

  if (hits.length) {
    total += hits.length;
    report.push({ file, hits });
  }
}

// Only styles.css is checked for this — tokens.css is where people are named.
let personHits = [];
try {
  personHits = personNamedPaint(await readFile('styles.css', 'utf8'));
} catch { /* no stylesheet, nothing to check */ }

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

if (!total && !personHits.length) {
  console.log(green(`✓ No hardcoded colours outside ${SOURCE_OF_TRUTH}, and no rule paints a named person.`));
  process.exit(0);
}

console.log(red(`✗ ${total} hardcoded colour(s) outside ${SOURCE_OF_TRUTH}:\n`));
for (const { file, hits } of report) {
  console.log(`  ${file} — ${hits.length}`);
  const show = listAll ? hits : hits.slice(0, 8);
  for (const h of show) {
    console.log(dim(`      ${String(h.line).padStart(5)}  ${h.text.padEnd(26)} ${h.why}`));
  }
  if (!listAll && hits.length > show.length) {
    console.log(dim(`      … ${hits.length - show.length} more (run with --list)`));
  }
}
if (personHits.length) {
  console.log(red(`\n✗ ${personHits.length} rule(s) name a person and set a colour:\n`));
  for (const h of (listAll ? personHits : personHits.slice(0, 10))) {
    console.log(dim(`      ${String(h.line).padStart(5)}  ${h.selector}`));
  }
  if (!listAll && personHits.length > 10) {
    console.log(dim(`      … ${personHits.length - 10} more (run with --list)`));
  }
  console.log(
    `\n  These pass the literal check — every value is a token — but they hardcode\n` +
    `  which person gets which token, which is the same bug one level up. Move the\n` +
    `  difference into that person's ramp in ${SOURCE_OF_TRUTH} and let the rule read\n` +
    `  --user-*. Layout and visibility keyed to a person are fine; colour is not.`
  );
}

if (total) {
  console.log(
    `\nEvery hue belongs in ${SOURCE_OF_TRUTH}. Components read --user-* so they\n` +
    `never name a person; neutral greys and pure black/white are exempt.`
  );
}
process.exit(1);
