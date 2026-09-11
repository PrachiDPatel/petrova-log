# The Petrova Log

A two-person letter-writing app themed after *Project Hail Mary*. Ryland writes
from Earth, Rocky from Erid. One letter each per day, 250 words minimum, sealed
with wax and delivered the instant it's sent.

**[Live demo →](#)** · sign in by clicking a seal, no password

Write, edit and delete freely — the demo keeps your changes in your tab and
never writes them back, so the next visitor finds the letters as they were.

---

## Built with

Static HTML, CSS and JavaScript. No framework, no bundler, no build step — the
deployed files *are* the source. Firebase Auth and Firestore are reached
straight from the browser, so there's no backend.

**Why Firestore over Postgres:** two users, one document per person per day, no
joins. The client SDK plus security rules removed the need for a server
entirely, and real-time listeners gave live delivery in one line. Each letter
still maps onto a single row, so moving to Postgres later would be mechanical.

## One colour file

Every hue lives in `tokens.css`, and a linter fails the build if one appears
anywhere else:

```bash
npm run lint
```

Components read `--user-*` and never name a person, so both writers' envelopes
render in their own colours on the same screen — and changing someone's whole
identity is a handful of lines in one file. [STYLE-GUIDE.md](STYLE-GUIDE.md) has
the rules and the traps that earned them.

---

<details>
<summary><strong>Running it yourself</strong></summary>

### 1. Firebase project

[console.firebase.google.com](https://console.firebase.google.com) → create a
project → add a Web App → copy the config.

Use a **new** project. Don't point this at anything holding real data.

### 2. Config

Paste your values over the `YOUR_*` placeholders in `firebase-config.js`.

> They also appear in `firebase-messaging-sw.js` — a service worker can't import
> them, so they're duplicated. **Update both.** An earlier copy of this project
> carried another project's real credentials there long after everything else
> had been renamed.

### 3. Authentication

**Authentication → Get started → Email/Password → Enable**, then create two
accounts with the same password (`AUTH_PASS` in `firebase-config.js`):

- `ryland@petrovalog.demo`
- `rocky@petrovalog.demo`

`.demo` is unroutable, so these are identifiers rather than inboxes.

### 4. Firestore

**Firestore Database → Create database → production mode.**

### 5. Security rules

**Firestore → Rules.** Publishing replaces the entire ruleset, so paste the whole
thing.

The demo is read-only on purpose: the sign-in password is public, so without
this anyone could rewrite the letters.

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function isCast() {
      return request.auth != null &&
             request.auth.token.email in [
               'ryland@petrovalog.demo',
               'rocky@petrovalog.demo'
             ];
    }

    match /letters/{letterId} {
      allow read: if isCast();
      // Seed with tools/seed.mjs (Admin SDK), which bypasses rules.
      allow create, update, delete: if false;
    }

    match /users/{email} {
      allow read:  if isCast();
      allow write: if false;
    }
  }
}
```

For two real people instead of a demo, swap the `letters` block for:

```
    match /letters/{letterId} {
      allow read: if isCast();

      allow create: if isCast()
                    && request.auth.uid == request.resource.data.fromUid
                    && request.resource.data.wordCount >= 250;

      allow update: if isCast()
                    && request.auth.uid == resource.data.fromUid
                    && request.time < resource.data.editableUntil
                    && request.resource.data.fromUid == resource.data.fromUid
                    && request.resource.data.date == resource.data.date;

      allow delete: if isCast()
                    && request.auth.uid == resource.data.fromUid;
    }
```

Give each person their own password first, and change `AUTH_PASS`.

### 6. Seed and deploy

```bash
npm install
export GOOGLE_APPLICATION_CREDENTIALS=~/keys/service-account.json
npm run seed
```

Then any static host. Cloudflare Pages: connect the repo, framework preset
**None**, build command and output directory both empty.

</details>

<details>
<summary><strong>Demo mode</strong></summary>

`firebase-config.js` carries one switch:

```js
export const DEMO_MODE = true;
```

**On:** visitors use every feature, but writes are intercepted by
`demo-store.js` and kept in a `sessionStorage` overlay for that tab only.
Nothing reaches Firestore.

**Off:** every wrapper becomes a pass-through and writes go to the database.

The flag and the rules are independent on purpose — `demo-store.js` makes the
demo *fun*, the rules make it *safe*. Delete the module and the archive is still
protected. It's one import line in `app.js`; nothing else knows it exists.

</details>

<details>
<summary><strong>Tools</strong></summary>

| | |
|---|---|
| `lint-tokens.mjs` | fails on any hardcoded colour, or any rule that paints a named person |
| `to-png.mjs` | generated art arrives as JPEG; the seal pipeline works in PNG |
| `split-seals.mjs` | cuts a sheet of seals into transparent PNGs |
| `to-webp.mjs` | re-encodes them — 82% smaller than PNG for wax texture |
| `recolor-seal.mjs` | rotates the wax's hue while leaving the gold engraving alone |
| `cut-seal.mjs` | alpha channel for a single seal, with `--rim` and `--wax` |
| `seed.mjs` | writes the demo correspondence via the Admin SDK |

Generating both seals in **one image** is what made them match — one pass means
one lighting direction and one wax texture for free. Matching a second image to
an existing one is the unreliable path.

</details>

---

*Project Hail Mary* is a novel by Andy Weir; Ryland Grace and Rocky are his
characters. Unaffiliated fan project, built as a portfolio piece.
