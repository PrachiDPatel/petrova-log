/**
 * Demo sandbox.
 *
 * This is a public demo, so two things have to be true at once: a visitor
 * should be able to use every feature — write a letter, edit it, move it,
 * delete it — and none of it may touch the real database, because the next
 * visitor should find the correspondence exactly as it was.
 *
 * So writes are intercepted here and kept in a per-tab overlay instead. The app
 * above this file is unchanged: it calls `setDoc` and `deleteDoc` as always and
 * genuinely cannot tell the difference. Reads merge the overlay over the real
 * Firestore data, so an edited letter reads back edited and a deleted one is
 * gone — for you, in this tab, until you close it.
 *
 * The Firestore rules still refuse every write. That is deliberate belt and
 * braces: this file is a nicety for the visitor's experience, and the rules are
 * the thing that actually protects the data. If this module were removed
 * tomorrow, the demo would get less fun and stay just as safe.
 *
 * To run this app for real people rather than as a demo, set DEMO_MODE to false
 * in firebase-config.js and publish the writable ruleset from the README.
 */
import { DEMO_MODE } from './firebase-config.js';
import {
  collection as fsCollection,
  doc as fsDoc,
  setDoc as fsSetDoc,
  getDoc as fsGetDoc,
  getDocs as fsGetDocs,
  deleteDoc as fsDeleteDoc,
  query as fsQuery,
  where as fsWhere,
  orderBy as fsOrderBy,
  onSnapshot as fsOnSnapshot,
  serverTimestamp as fsServerTimestamp,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

export {
  fsCollection as collection,
  fsOrderBy as orderBy,
  Timestamp,
};

/**
 * `where()` records what it filters on.
 *
 * Firestore has already applied these filters to the real documents by the time
 * a snapshot arrives, but the overlay has not been filtered by anything — so
 * without this, merging put every locally-written letter into every query. That
 * is not hypothetical: it shipped for about ten minutes and made the partner's
 * envelope display the letter you had just written yourself.
 */
export function where(field, op, value) {
  const constraint = fsWhere(field, op, value);
  try {
    Object.defineProperty(constraint, '__spec', {
      value: { field, op, value },
      enumerable: false,
    });
  } catch { /* falls back to no filtering, same as before */ }
  return constraint;
}

/** Does an overlay document satisfy the constraints its query was built with? */
function matches(data, constraints) {
  return constraints.every(({ field, op, value }) => {
    const actual = data?.[field];
    switch (op) {
      case '==':  return actual === value;
      case '!=':  return actual !== value;
      case 'in':  return Array.isArray(value) && value.includes(actual);
      case '>':   return actual > value;
      case '>=':  return actual >= value;
      case '<':   return actual < value;
      case '<=':  return actual <= value;
      // An operator this shim does not model must not silently pass — leaving
      // the document out matches Firestore's own behaviour more closely than
      // letting it through would.
      default:    return false;
    }
  });
}

/**
 * `query()` is wrapped for one reason: to remember which collection it came
 * from. Merging the overlay needs that path, and Firestore does not expose it
 * on a Query — only on internals whose names are free to change between SDK
 * versions. Reading a private field would work today and break silently on an
 * upgrade, with the overlay quietly merging into the wrong collection. Recording
 * it on the way in costs nothing and cannot rot.
 */
export function query(collectionRef, ...constraints) {
  const q = fsQuery(collectionRef, ...constraints);
  try {
    Object.defineProperty(q, '__collectionPath', {
      value: collectionRef?.path ?? null,
      enumerable: false,
    });
    Object.defineProperty(q, '__constraints', {
      value: constraints.map((c) => c.__spec).filter(Boolean),
      enumerable: false,
    });
  } catch {
    /* frozen object — collectionPathOf falls back below */
  }
  return q;
}

// Pass-through when this is a real deployment.
export const doc = fsDoc;

// ── the overlay ─────────────────────────────────────────────────────────────
// sessionStorage, so a refresh keeps your draft but a new visitor — and a new
// tab — starts from the seeded correspondence.

const KEY = 'petrova-demo-overlay';
const listeners = new Set();

const DELETED = '__deleted__';

function load() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

function save(overlay) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(overlay));
  } catch {
    /* private browsing, quota — the demo still works, it just forgets */
  }
  for (const fn of listeners) {
    try { fn(); } catch { /* a broken listener must not break the rest */ }
  }
}

/** Timestamps do not survive JSON, so they travel as a tagged number. */
function encode(value) {
  if (value instanceof Timestamp) return { __ts: value.toMillis() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  }
  return value;
}

function decode(value) {
  if (value && typeof value === 'object' && typeof value.__ts === 'number') {
    return Timestamp.fromMillis(value.__ts);
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

function onOverlayChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── the wrappers ────────────────────────────────────────────────────────────

export function serverTimestamp() {
  // In demo mode nothing reaches a server, so a sentinel would never resolve.
  return DEMO_MODE ? Timestamp.now() : fsServerTimestamp();
}

export async function setDoc(ref, data, options) {
  if (!DEMO_MODE) return fsSetDoc(ref, data, options);

  const overlay = load();
  const existing = overlay[ref.path] && overlay[ref.path] !== DELETED
    ? decode(overlay[ref.path])
    : (await fsGetDoc(ref).catch(() => null))?.data() ?? null;

  // `{ merge: true }` has to behave like Firestore's, or editing a letter would
  // silently drop every field the edit did not mention.
  const next = options?.merge && existing ? { ...existing, ...data } : data;

  overlay[ref.path] = encode(next);
  save(overlay);
  notifyWrite();
}

export async function deleteDoc(ref) {
  if (!DEMO_MODE) return fsDeleteDoc(ref);
  const overlay = load();
  overlay[ref.path] = DELETED;
  save(overlay);
  notifyWrite();
}

export async function getDoc(ref) {
  if (!DEMO_MODE) return fsGetDoc(ref);

  const overlay = load();
  const local = overlay[ref.path];

  if (local === DELETED) {
    return { exists: () => false, data: () => undefined, id: ref.id, ref };
  }
  if (local !== undefined) {
    const data = decode(local);
    return { exists: () => true, data: () => data, id: ref.id, ref };
  }
  return fsGetDoc(ref);
}

/** Real documents with the overlay applied over the top. */
function mergeSnapshot(snap, collectionPath, constraints = []) {
  const byId = new Map();
  snap.forEach((d) => byId.set(d.id, d.data()));

  const overlay = load();
  for (const [path, value] of Object.entries(overlay)) {
    if (!path.startsWith(`${collectionPath}/`)) continue;
    const id = path.slice(collectionPath.length + 1);
    if (value === DELETED) { byId.delete(id); continue; }

    // Only if this document would have matched the query. Firestore filtered
    // the real docs; the overlay has to be held to the same test.
    const data = decode(value);
    if (matches(data, constraints)) byId.set(id, data);
  }

  // Every query in this app orders by date descending; re-sort after merging so
  // a letter written today lands at the top rather than wherever the map put it.
  const docs = [...byId.entries()]
    .map(([id, data]) => ({ id, data: () => data }))
    .sort((a, b) => String(b.data().date ?? '').localeCompare(String(a.data().date ?? '')));

  return {
    docs,
    size: docs.length,
    empty: docs.length === 0,
    forEach: (fn) => docs.forEach(fn),
  };
}

/** The collection a ref or query points at — recorded by `query()` above. */
function collectionPathOf(refOrQuery) {
  return refOrQuery?.path ?? refOrQuery?.__collectionPath ?? 'letters';
}

export async function getDocs(q) {
  const snap = await fsGetDocs(q);
  if (!DEMO_MODE) return snap;
  return mergeSnapshot(snap, collectionPathOf(q), q?.__constraints ?? []);
}

export function onSnapshot(q, onNext, onError) {
  if (!DEMO_MODE) return fsOnSnapshot(q, onNext, onError);

  const path = collectionPathOf(q);
  const constraints = q?.__constraints ?? [];
  let last = null;

  const stopFirestore = fsOnSnapshot(
    q,
    (snap) => {
      last = snap;
      onNext(mergeSnapshot(snap, path, constraints));
    },
    onError
  );

  // Writing locally has to look exactly like the server pushing an update, or
  // the page would not refresh until Firestore happened to send something.
  const stopOverlay = onOverlayChange(() => {
    if (last) onNext(mergeSnapshot(last, path, constraints));
  });

  return () => {
    stopFirestore();
    stopOverlay();
  };
}

// ── telling the visitor what just happened ──────────────────────────────────

let toastEl = null;

function notifyWrite() {
  if (!DEMO_MODE) return;
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'demo-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = 'Saved for this visit only — nothing was written to the archive.';
  toastEl.classList.add('is-visible');
  clearTimeout(notifyWrite._t);
  notifyWrite._t = setTimeout(() => toastEl.classList.remove('is-visible'), 4200);
}

/** The standing banner. Says what this is before anyone writes anything. */
export function mountDemoBanner() {
  if (!DEMO_MODE || document.querySelector('.demo-banner')) return;

  const bar = document.createElement('div');
  bar.className = 'demo-banner';

  const text = document.createElement('span');
  text.textContent =
    'Demo — write, edit and delete freely. Your changes live in this tab only and are never saved, so the next visitor finds the letters as they were.';

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'demo-reset';
  reset.textContent = 'Reset';
  reset.title = 'Discard everything you have written this visit';
  reset.addEventListener('click', () => {
    sessionStorage.removeItem(KEY);
    location.reload();
  });

  bar.append(text, reset);
  document.body.appendChild(bar);
  document.body.classList.add('has-demo-banner');
}

export { DEMO_MODE };
