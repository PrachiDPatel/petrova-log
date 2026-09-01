# Style guide

The rules this codebase is held to, and the check that enforces them.

Written because the same bug kept coming back. Blue from the private app this
was forked from survived three rounds of retheming. Then green survived the
round that removed the blue. Every time the cause was identical — a colour
written down somewhere that editing the palette could not reach.

---

## The one rule

**Every hue lives in `tokens.css`. Nothing else contains a colour.**

Not `styles.css`, not an inline SVG's `fill`, not a string in `app.js`.

Neutral greys and pure black/white are exempt — shadows and scrims are neutral
by nature and routing them through the palette buys nothing.

```bash
node tools/lint-tokens.mjs          # exits non-zero on any violation
node tools/lint-tokens.mjs --list   # every occurrence, not just the first few
```

Run it before every commit that touches presentation. It found 155 violations
the first time it ran, on a codebase that had already been "cleaned up" twice.

---

## Components never name a person

A rule may not say `ryland` or `rocky`. It reads the generic channel:

```css
.thing { color: var(--user); border-color: rgb(var(--user-rgb) / .3); }
```

`tokens.css` points `--user-*` at the right ramp:

| Selector | Means |
|---|---|
| `body[data-user="…"]` | who is signed in — the page's world |
| `[data-sender="…"]` | who wrote *this* letter — a card, an envelope, a seal |

The second is what lets an archive show both people's envelopes in their own
colours on one screen. Before it existed, every card rendered in the *viewer's*
colours, so Rocky's letters were green when Ryland was reading.

**This applies to JavaScript too.** Read the token, don't branch on a name:

```js
const hot = getComputedStyle(el).getPropertyValue('--user-hot-rgb').trim();
el.style.filter = `drop-shadow(0 0 18px rgb(${hot} / .85))`;
```

The transition glow used to be an `if (user === 'ryland')` with a colour on each
branch, and Rocky's was set to the star white — which is why his brown seal
arrived in a grey halo.

---

## The ramps

Each person owns a full ramp, including their **ground**. That last part
matters: the sky was shared and green for a long time, so Rocky's page still
read forest even after every component had been rewired. The components were
fine; the floor underneath them had not moved.

| Token | Ryland | Rocky |
|---|---|---|
| `--user` | forest green | brown |
| `--user-deep` / `--user-mid` / `--user-lt` | darker → lighter | darker → lighter |
| `--user-hot` | what they glow | amber |
| `--user-foot` | how the page bottoms out | warm amber |
| `--space-0…3` | green-black night | brown-black night |
| `--ripple-tile` | orbital arcs | rock strata |

Non-person tokens: `--petrova` (the line's red — the one accent belonging to
neither of them), `--gold`, `--star`, `--paper`, `--ink`, `--astrophage`.

`--star` is a **warm neutral**, not a green-tinted white. It was tinted once,
and since it paints most of the text, it cast green over the entire app.

---

## Adding a third person

1. Add a ramp to `tokens.css` — the same keys as the two above.
2. Add one `body[data-user="…"]` block and one `[data-sender="…"]` block.
3. Nothing else.

If you find yourself editing a component to add someone, the component is
wrong.

---

## Things that are not colour but bite the same way

**Shadows on transparent images.** `box-shadow` traces the *border box*. On a
transparent PNG that means a rectangle or a circle behind artwork that is
neither. Use `filter: drop-shadow()`, which follows the alpha channel. Both the
login seals and the transition seal shipped with this bug.

**`position: fixed` under a transformed ancestor.** A transformed element
becomes the containing block for fixed descendants. Animating `transform` on a
screen therefore drags any fixed scenery inside it and snaps it back when the
animation clears. Screens fade with opacity only.

**Config duplicated in a second file.** `firebase-messaging-sw.js` cannot import
`firebase-config.js`, so it carries its own copy — and once held another
project's real credentials long after everything else had been renamed. The
font `@import` in `styles.css` did the same thing to the `<link>` in
`index.html`. If a value must exist twice, say so at both sites.

---

## Drawing

Generate shapes from a rule; do not hand-author curves. Every representational
thing hand-drawn in this project had to be thrown away, and every generated one
worked first or second try.

- The mountain is a ridgeline of irregular points drawn as a ribbon whose width
  tapers from the summit to nothing at both ends.
- Earth is the graticule computed from the projection — a parallel at latitude
  φ has radius `R·cos φ` and sits `R·sin φ` up the axis.

Check any mark at the size it actually renders. The card motif lives at ~44px;
things that look fine at 260px fall apart there.

---

## Tools

| | |
|---|---|
| `tools/lint-tokens.mjs` | fails on any hardcoded colour |
| `tools/split-seals.mjs` | cuts a sheet of seals into transparent PNGs |
| `tools/to-webp.mjs` | re-encodes them — 82% smaller than PNG for wax texture |
| `tools/cut-seal.mjs` | alpha channel for a single seal, with `--rim` and `--wax` |
| `tools/seal-cutter.html` | the same cutting, interactively |
| `tools/seed.mjs` | writes the demo correspondence via the Admin SDK |
