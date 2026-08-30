#!/usr/bin/env node
/**
 * Seed the demo correspondence.
 *
 * The published rules refuse every write (the sign-in password is public, so
 * anyone could otherwise rewrite the letters). The Admin SDK bypasses rules
 * entirely, which is exactly what seeding needs and exactly why the key it uses
 * is a real secret — see the warning below.
 *
 *   npm install
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 *   node tools/seed.mjs seed-letters.json
 *
 * ⚠️  The service-account JSON grants admin access to the whole Firebase
 *     project. Keep it OUTSIDE this repo. `.gitignore` blocks the usual
 *     filenames, but the only safe place is somewhere else on disk.
 *
 * Document ids are `<date>_<uid>`, matching what app.js writes, so a seeded
 * letter is indistinguishable from a sent one and the "one letter per person
 * per day" check still holds.
 */
import { readFile } from 'node:fs/promises';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const CAST = {
  ryland: { name: 'Ryland', email: 'ryland@petrovalog.demo' },
  rocky:  { name: 'Rocky',  email: 'rocky@petrovalog.demo' },
};

const file = process.argv[2] ?? 'seed-letters.json';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    'GOOGLE_APPLICATION_CREDENTIALS is not set.\n' +
    'Point it at a service-account JSON kept outside this repo:\n' +
    '  export GOOGLE_APPLICATION_CREDENTIALS=~/keys/petrova-admin.json'
  );
  process.exit(1);
}

let letters;
try {
  letters = JSON.parse(await readFile(file, 'utf8'));
} catch (e) {
  console.error(`Could not read ${file}: ${e.message}`);
  console.error('Copy seed-letters.example.json and write your own.');
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });
const db = getFirestore();
const auth = getAuth();

// Resolve each character's real uid once. The document id depends on it, so a
// guessed uid would produce letters the app cannot find.
const uids = {};
for (const [key, who] of Object.entries(CAST)) {
  try {
    uids[key] = (await auth.getUserByEmail(who.email)).uid;
  } catch {
    console.error(
      `No Firebase Auth user for ${who.email}. Create both accounts first ` +
      `(README step 3), then run this again.`
    );
    process.exit(1);
  }
}

const wordCount = (t) => t.trim().split(/\s+/).filter(Boolean).length;

let written = 0;
let skipped = 0;

for (const [i, letter] of letters.entries()) {
  const who = CAST[letter.from];
  if (!who) {
    console.error(`letters[${i}]: "from" must be "ryland" or "rocky", got ${JSON.stringify(letter.from)}`);
    process.exit(1);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(letter.date ?? '')) {
    console.error(`letters[${i}]: "date" must be YYYY-MM-DD, got ${JSON.stringify(letter.date)}`);
    process.exit(1);
  }

  const other = letter.from === 'ryland' ? CAST.rocky : CAST.ryland;
  const uid = uids[letter.from];
  const id = `${letter.date}_${uid}`;

  const existing = await db.collection('letters').doc(id).get();
  if (existing.exists && !process.argv.includes('--overwrite')) {
    console.log(`· skipped ${id} (exists — pass --overwrite to replace)`);
    skipped++;
    continue;
  }

  // Seeded letters are past correspondence: the edit window is already closed,
  // so the demo never shows an "editable for N more minutes" state on them.
  const created = Timestamp.fromDate(new Date(`${letter.date}T20:00:00Z`));

  await db.collection('letters').doc(id).set({
    from:        who.name,
    to:          other.name,
    fromEmail:   who.email,
    fromUid:     uid,
    date:        letter.date,
    content:     letter.content,
    salutation:  letter.salutation ?? '',
    signoffWord: letter.signoffWord ?? 'Onward,',
    signoffName: letter.signoffName ?? who.name,
    wordCount:   wordCount(letter.content),
    mood:        letter.mood ?? null,
    createdAt:   created,
    editableUntil: created,
    lastEdited:  null,
  });

  console.log(`✓ ${id}  ${who.name} → ${other.name}  (${wordCount(letter.content)} words)`);
  written++;
}

console.log(`\n${written} written, ${skipped} skipped.`);
