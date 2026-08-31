# The Petrova Log

> *correspondence across the line*

A two-person letter-writing app, themed after *Project Hail Mary*. Ryland writes
from Earth; Rocky writes from Erid. Each of you writes one letter a day, seals it
with a wax stamp, and it arrives the moment you send it — no waiting for the
other person to write first.

This is a **public demo** of a private app I built for two people. It runs on its
own Firebase project with its own seeded content; the real one shares no data,
no credentials, and no code deployment with it.

**Live demo:** *(add the URL once deployed)*
Sign in as either character with the shared demo password.

---

## What it does

| | |
|---|---|
| **One letter per person per day** | 250-word minimum, so it's a letter and not a text |
| **Sealed and sent** | A wax seal per writer — Earth for Ryland, Erid for Rocky |
| **Instant delivery** | Firestore's `onSnapshot` — the other letter appears as it's sent, no refresh |
| **One-hour edit window** | After that a letter is fixed, and moves to the archive |
| **Late-night cutoff** | Written before 5am local time? It files under the previous day |
| **Archive** | Every past day, browsable |

## How it's built

Static HTML, CSS and JavaScript. No framework, no bundler, no build step — the
deployed site *is* the source. Firebase Authentication and Cloud Firestore are
reached directly from the browser via the client SDK, so there's no backend
server to run.

```
index.html            markup and the login screen
app.js                all behaviour
styles.css            all styling, including the per-writer palettes
firebase-config.js    project config + the two characters
assets/               wax seals and the hero background
functions/notify.js   optional push notifications (Cloudflare Pages Function)
tools/cut-seal.mjs    gives a seal PNG a real alpha channel (see below)
```

**Why Firestore rather than Postgres:** the data model is two users and one
document per person per day, with no joins. Firestore's client SDK plus its
security rules removed the need for a backend entirely, and its real-time
listeners gave live delivery in one line. A relational database would have
bought nothing here and cost a server. Each letter still maps cleanly onto a
single row, so moving to Postgres later would be mechanical.

---

## Running it yourself

### 1. Create a Firebase project

[console.firebase.google.com](https://console.firebase.google.com) → **Create a
project** → **Add a Web App** → copy the config object.

Use a **new, separate project**. Don't point this at anything that holds real
data.

### 2. Fill in `firebase-config.js`

Replace the `YOUR_*` placeholders with your config values.

> The same values also appear in `firebase-messaging-sw.js` — a service worker
> can't import them, so they're duplicated. **Update both.** That file is easy to
> forget: an earlier copy of this project still carried another project's real
> credentials long after everything else had been renamed, which is exactly the
> kind of mistake this note exists to prevent.

### 3. Enable Authentication

**Authentication** → **Get started** → **Email/Password** → Enable.

Create the two demo accounts, both with the same password (`AUTH_PASS` in
`firebase-config.js`):

- `ryland@petrovalog.demo`
- `rocky@petrovalog.demo`

These addresses are deliberately unroutable — `.demo` is not a real TLD, so no
mail can ever reach them. They're identifiers, not inboxes.

### 4. Enable Firestore

**Firestore Database** → **Create database** → **production mode**.

### 5. Publish security rules

**Firestore → Rules.** Publishing replaces the *entire* ruleset — there's no
merging — so paste the whole thing.

**This demo is read-only by design.** The password is public, which means anyone
can sign in; without this, anyone could also rewrite or delete the letters. Reads
are allowed so visitors can browse the correspondence, and writes are refused.

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
      // Anyone signed in as one of the two characters may read.
      allow read: if isCast();

      // Read-only demo: the sign-in password is public, so writes are closed.
      // Seed content with tools/seed.mjs (Admin SDK), which bypasses rules.
      allow create, update, delete: if false;
    }

    match /users/{email} {
      allow read:  if isCast();
      allow write: if false;
    }
  }
}
```

<details>
<summary>Running it as a <em>writable</em> app instead</summary>

If you're forking this for two real people rather than as a public demo, replace
the `letters` block with the rules the private version uses:

```
    match /letters/{letterId} {
      allow read: if isCast();

      allow create: if isCast()
                    && request.auth.uid == request.resource.data.fromUid
                    && request.resource.data.wordCount >= 250;

      // Own letter, inside the edit window, and neither author nor date moves.
      allow update: if isCast()
                    && request.auth.uid == resource.data.fromUid
                    && request.time < resource.data.editableUntil
                    && request.resource.data.fromUid == resource.data.fromUid
                    && request.resource.data.date == resource.data.date;

      allow delete: if isCast()
                    && request.auth.uid == resource.data.fromUid;
    }
```

Change `AUTH_PASS` to something private first, and give each person their own
password rather than sharing one.
</details>

### 6. Demo mode

`firebase-config.js` carries one switch:

```js
export const DEMO_MODE = true;
```

**On** (the public demo): visitors can write, edit, move and delete letters and
see every feature work — but writes are intercepted by `demo-store.js` and kept
in a `sessionStorage` overlay for that tab only. Nothing reaches Firestore, so
the next visitor finds the correspondence exactly as it was. A banner says so up
front, and a toast confirms it on every write.

**Off** (two real people): every wrapper becomes a pass-through and writes go to
the database. Publish the writable ruleset above if you do this — the demo rules
refuse writes regardless of this flag.

The rules and the flag are deliberately independent. `demo-store.js` exists so
the demo is *fun*; the rules are what make it *safe*. Delete the module tomorrow
and the archive is still protected.

The whole thing is one import line in `app.js` — nothing else in the app knows
demo mode exists, so it can be removed without archaeology.

### 7. Seed the demo letters

An empty demo is a bad demo. See `tools/seed.mjs`.

### 8. Deploy

Any static host. For Cloudflare Pages: connect the repo, framework preset
**None**, build command empty, output directory `/`.

Push notifications are optional and need `FIREBASE_SERVICE_ACCOUNT` (a service
account JSON) set as a secret. Skip it and everything else still works.

---

## A note on the seals

The two wax seals are PNGs. They originally shipped as colour-type 2 — RGB with
**no alpha channel at all** — meaning each was an opaque rectangle that CSS
clipped into a circle. Rocky's baked-in background was dark brown so it blended
with the theme; Ryland's was pale cream, so his green wax sat on a visible light
disc. Same CSS, different backgrounds baked into the art, which is why it looked
broken on one seal and fine on the other, and why no amount of CSS fixing helped.

`tools/cut-seal.mjs` fixes this in the pixels: it floods inward from the border
to clear only background actually connected to the edge (so a colour that also
appears inside the wax survives), feathers the boundary, and re-encodes as RGBA.

```bash
node tools/cut-seal.mjs assets/stamp-ryland.png
```

If you replace a seal, run it on the new art and check the output says
`Now RGBA`.

---

## Credits

*Project Hail Mary* is a novel by Andy Weir. Ryland Grace and Rocky are his
characters; this is an unaffiliated fan project, built as a portfolio piece, not
distributed commercially.
