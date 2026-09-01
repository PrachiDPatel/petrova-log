import { auth, db, USERS, NAME_TO_EMAIL, app as firebaseApp, VAPID_KEY, AUTH_PASS } from './firebase-config.js';

import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

// Firestore comes through demo-store.js, not straight from the SDK. With
// DEMO_MODE off it re-exports the real functions unchanged; with it on, writes
// are kept in a per-tab overlay so visitors can use every feature without
// altering the archive. Nothing below this line knows the difference.
import {
  collection, doc, setDoc, getDoc, getDocs, deleteDoc,
  query, where, orderBy, onSnapshot,
  serverTimestamp, Timestamp,
  mountDemoBanner
} from './demo-store.js';

// Copy seal artwork from login buttons into transition cover (avoids duplicating base64)
mountDemoBanner();

document.querySelector('.tc-seal-ryland .tc-seal-art').src =
  document.querySelector('#btn-ryland .seal-art')?.src ?? '';
document.querySelector('.tc-seal-rocky .tc-seal-art').src =
  document.querySelector('#btn-rocky .seal-art')?.src ?? '';

// The sky used to carry a moon whose phase was computed to match the real one.
// It is Earth now, which has no phases from where these two are writing, so the
// calculation and the element it drove are both gone.

// ══════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════
let coverPendingUser = null;  // set by showTransitionCover, cleared on hide

let me           = null;   // Firebase user
let myConfig     = null;   // USERS entry
let letterDate   = null;   // "YYYY-MM-DD" adjusted for 5 AM cutoff
let myLetter     = null;   // today's letter by me  (Firestore data)
let theirLetter  = null;   // today's letter by partner
let partnerUnsub = null;   // Firestore real-time listener

let editingId    = null;   // if editing an existing letter, its doc ID
let allLetters   = [];     // cached for streak calculation

let letterDateOffset = 0;  // days offset from auto-detected date (adjusted via arrows)
let selectedMood     = null;

const MOODS      = ['ecstatic', 'happy', 'eh', 'sad', 'devastated'];
const MOOD_EMOJI = {
  ryland: ['🚀', '🌍', '🧪', '⭐️', '🌑'],
  rocky:  ['⚙️', '💎', '🪨', '🔧', '🌑']
};

function moodEmoji(moodWord, sender) {
  const idx = MOODS.indexOf(moodWord);
  return idx === -1 ? '' : (MOOD_EMOJI[sender]?.[idx] ?? '');
}
function moodLabel(moodWord, sender) {
  const em = moodEmoji(moodWord, sender);
  return em ? `${em} ${moodWord}` : moodWord;
}

function senderTag(email) {
  return email === 'ryland@petrovalog.demo' ? 'ryland' : 'rocky';
}

// Wax-seal icon — AI-generated stamp art per sender (see assets/).
const STAMP_IMG = {
  ryland: `<img class="seal-img" src="assets/stamp-ryland.webp" alt="Ryland's stamp">`,
  rocky:  `<img class="seal-img" src="assets/stamp-rocky.webp" alt="Rocky's stamp">`
};

// Floral-rule divider glyphs — per user, SVG so they render correctly in any font
const RULE_SPARKLE_SVG = `<svg class="rule-star rule-sparkle" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M10 0 C10 8.5 11.5 10 20 10 C11.5 10 10 11.5 10 20 C10 11.5 8.5 10 0 10 C8.5 10 10 8.5 10 0 Z"/></svg>`;
const RULE_BRITTLE_SVG = `<svg class="rule-star rule-brittle" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g transform="translate(10,10) scale(0.25) translate(-40,-40)"><circle cx="40" cy="40" r="5" fill="currentColor" opacity=".9"/><path fill="currentColor" opacity=".85" transform="rotate(0 40 40)" d="M37.5 36 C35.5 27 37 16 40 3 C43 16 44.5 27 42.5 36 Z"/><path fill="currentColor" opacity=".8" transform="rotate(72 40 40)" d="M37.5 36 C35.5 27 37 16 40 3 C43 16 44.5 27 42.5 36 Z"/><path fill="currentColor" opacity=".82" transform="rotate(144 40 40)" d="M37.5 36 C35.5 27 37 16 40 3 C43 16 44.5 27 42.5 36 Z"/><path fill="currentColor" opacity=".78" transform="rotate(216 40 40)" d="M37.5 36 C35.5 27 37 16 40 3 C43 16 44.5 27 42.5 36 Z"/><path fill="currentColor" opacity=".8" transform="rotate(288 40 40)" d="M37.5 36 C35.5 27 37 16 40 3 C43 16 44.5 27 42.5 36 Z"/></g></svg>`;

function updateFloralRules() {
  const glyph = senderTag(me.email) === 'rocky' ? RULE_BRITTLE_SVG : RULE_SPARKLE_SVG;
  document.querySelectorAll('.floral-rule span:not(.rule-line)').forEach(span => {
    span.innerHTML = glyph;
  });
}
function sealGlyph(sender) {
  return STAMP_IMG[sender] ?? STAMP_IMG.rocky;
}

// Small vector motif tucked into a card/letter corner — reuses the same star/crab
// paths drawn for each person's page background, so it's their world, not a sticker.
const SENDER_MOTIF = {
  ryland: `<svg class="sender-motif" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g transform="translate(38,8) scale(2.1)"><path d="M10 0 C10 8.5 11.5 10 20 10 C11.5 10 10 11.5 10 20 C10 11.5 8.5 10 0 10 C8.5 10 10 8.5 10 0 Z" fill="var(--user)" fill-opacity=".9"/></g>
    <g transform="translate(6,40) scale(1.3)"><path d="M10 0 C10 8.5 11.5 10 20 10 C11.5 10 10 11.5 10 20 C10 11.5 8.5 10 0 10 C8.5 10 10 8.5 10 0 Z" fill="var(--user)" fill-opacity=".7"/></g>
    <g transform="translate(52,55) scale(1.6)"><path d="M10 0 C10 8.5 11.5 10 20 10 C11.5 10 10 11.5 10 20 C10 11.5 8.5 10 0 10 C8.5 10 10 8.5 10 0 Z" fill="var(--user)" fill-opacity=".8"/></g>
    <g transform="translate(20,76) scale(1.0)"><path d="M10 0 C10 8.5 11.5 10 20 10 C11.5 10 10 11.5 10 20 C10 11.5 8.5 10 0 10 C8.5 10 10 8.5 10 0 Z" fill="var(--user)" fill-opacity=".6"/></g>
  </svg>`,
  // Erid is a rock. Peaks and boulders, not a brittle star and a crab — those
  // were the ocean fauna of the app this was forked from, and they had been
  // sitting in the corner of every one of Rocky's cards ever since.
  rocky: `<svg class="sender-motif" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g fill="var(--user)" fill-opacity=".72">
      <path d="M4.0 66.0 11.0 62.0 17.0 64.0 24.0 57.0 30.0 59.0 36.0 51.0 41.0 53.0 46.0 43.0 49.0 35.0 52.0 28.0 55.0 34.0 58.0 42.0 62.0 47.0 65.0 43.0 70.0 49.0 75.0 45.0 80.0 51.0 86.0 56.0 92.0 61.0 97.0 65.0 L96.9 65.2 91.7 61.4 85.5 56.6 79.2 51.8 74.7 46.5 69.6 50.9 64.4 45.4 61.6 49.9 55.0 43.6 51.4 35.5 52.7 32.4 52.6 36.4 49.1 44.4 42.8 55.3 37.2 53.1 30.9 60.8 24.6 58.5 17.4 65.1 11.1 62.8 4.2 66.4 Z"/>
    </g>
    <g fill="var(--user)" fill-opacity=".36">
      <path d="M51.4 33.6 L53.0 41.5 L52.1 41.8 L50.5 34.0 Z"/>
      <path d="M54.6 36.4 L57.4 44.0 L56.6 44.3 L53.8 36.8 Z"/>
      <path d="M47.4 40.4 L45.2 46.6 L44.4 46.3 L46.6 40.1 Z"/>
    </g>
    <g fill="var(--user)" fill-opacity=".30">
      <path d="M27 70.5 C29 68.2 32.6 67.8 34.2 69.6 C35.8 71.4 34.4 74.2 31.6 74.6 C28.8 75 25.8 72.8 27 70.5 Z"/>
      <path d="M69 72.5 C70.8 70 74.6 70 76 72.3 C77.3 74.5 75 76.6 72.2 76.2 C69.8 75.8 68 74.2 69 72.5 Z"/>
    </g>
  </svg>`
};
function senderMotif(sender) {
  return SENDER_MOTIF[sender] ?? '';
}

// ══════════════════════════════════════════════════════
//  DATE HELPERS
// ══════════════════════════════════════════════════════

function todayLetterDate() {
  const now = new Date();
  // Before 5 AM counts as the previous calendar day
  if (now.getHours() < 5) now.setDate(now.getDate() - 1);
  // Use local date parts — toISOString() returns UTC which can be the wrong calendar day
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function shiftDate(isoDate, days) {
  if (!days) return isoDate;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const ny = dt.getFullYear();
  const nm = String(dt.getMonth() + 1).padStart(2, '0');
  const nd = String(dt.getDate()).padStart(2, '0');
  return `${ny}-${nm}-${nd}`;
}

function displayDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

function displayMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function minutesLeft(ts) {
  const ms = ts.toDate().getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 60000));
}

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════

onAuthStateChanged(auth, async user => {
  if (user) {
    myConfig = USERS[user.email];
    if (!myConfig) {
      showError('Your email isn\'t configured for this app.');
      await signOut(auth);
      return;
    }
    me = user;
    await boot();
    document.body.dataset.user = myConfig.name.toLowerCase();
    // html sits behind body and can't see body[data-user]'s scoped --bg override
    // (CSS vars only inherit downward), so match it by hand for overscroll bounce.
    document.documentElement.style.backgroundColor =
      myConfig.name.toLowerCase() === 'ryland' ? 'var(--space-1)' : 'var(--space-0)';
    showScreen('app');

    const cover = document.getElementById('transition-cover');
    const authedUser = myConfig.name.toLowerCase();
    // onAuthStateChanged can fire once per intermediate auth state during a
    // fast logout/login switch (old user signed out, new user signed in),
    // and each firing independently reveals its own seal. Comparing against
    // coverPendingUser (set to the exact username by the most recent
    // showTransitionCover call) discards any stale firing whose cycle has
    // since been superseded, instead of animating a seal nobody asked for.
    if (coverPendingUser === authedUser) {
      const user     = authedUser;
      const sealEl   = cover.querySelector(user === 'ryland' ? '.tc-seal-ryland' : '.tc-seal-rocky');
      const ripple   = cover.querySelector('.tc-ripple');

      // Read the person's glow from tokens.css rather than naming them here.
      // These two lines used to hardcode a colour each, and Rocky's was the
      // star white — which is why his brown seal arrived in a grey halo.
      cover.dataset.sender = user;
      const hot = getComputedStyle(cover).getPropertyValue('--user-hot-rgb').trim()
                  || '230 239 228';

      if (sealEl) {
        sealEl.style.filter =
          `drop-shadow(0 0 18px rgb(${hot} / .85)) drop-shadow(0 5px 14px rgba(0,0,0,.65))`;
        sealEl.animate([
          { opacity: 0, transform: 'translateY(-20px) scale(0.72)' },
          { opacity: 1, transform: 'translateY(2px) scale(0.98)', offset: 0.55 },
          { opacity: 1, transform: 'translateY(0) scale(1.025)', offset: 0.75 },
          { opacity: 1, transform: 'translateY(0) scale(1)' }
        ], { duration: 1100, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' });
      }

      if (ripple) {
        ripple.style.border = `2px solid rgb(${hot} / .65)`;
        ripple.animate([
          { transform: 'scale(1)',   opacity: 0.8 },
          { transform: 'scale(2.8)', opacity: 0   }
        ], { duration: 900, easing: 'ease-out', delay: 300, fill: 'forwards' });
      }

      setTimeout(() => hideTransitionCover(), 1100);
    } else {
      hideTransitionCover();
    }
  } else {
    if (partnerUnsub) { partnerUnsub(); partnerUnsub = null; }
    me = myConfig = letterDate = myLetter = theirLetter = null;
    // Body has a background-color transition for smoothing theme switches
    // while logged in — but on logout it makes Ryland's deep ultramarine
    // --bg visibly crossfade out over 0.45s (a "purple flash"). Suspend the
    // transition for this one snap so it's instant, like the html reset below.
    document.body.style.transition = 'none';
    delete document.body.dataset.user;
    document.documentElement.style.backgroundColor = 'var(--space-0)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        document.body.style.transition = '';
      });
    });
    document.getElementById('btn-ryland').disabled = false;
    document.getElementById('btn-rocky').disabled = false;
    showScreen('login');
  }
});

function showTransitionCover(user) {
  coverPendingUser = user ?? null;
  const el = document.getElementById('transition-cover');
  // Whose transition this is, so the cover can be their colour. Without it the
  // screen was a neutral near-black for both, and Rocky's brown seal appeared
  // on Ryland's ground.
  if (user) el.dataset.sender = user;
  el.style.transition = 'none';

  // .tc-seal-ryland/.tc-seal-rocky both sit at inset:0 in the same wrapper —
  // if the previous login cycle's seal is still mid-animation or holding its
  // fill:'forwards' visible state (hideTransitionCover's reset runs ~1.6s
  // after a login starts, and logout never touches this at all), a fast
  // logout/login repeat can leave it visible under the new one. Force every
  // seal back to its hidden base state before this cycle's reveal starts.
  el.querySelectorAll('.tc-seal').forEach(s => {
    s.getAnimations().forEach(a => a.cancel());
    s.style.filter = '';
  });
  const rip = el.querySelector('.tc-ripple');
  if (rip) {
    rip.getAnimations().forEach(a => a.cancel());
    rip.style.border = '';
  }

  // No inline background here. It used to branch on the name and paint two
  // hardcoded near-blacks, both of them Ryland's green — and an inline style
  // beats every rule in the stylesheet, so the cover stayed green however the
  // tokens were set. #transition-cover reads --user-* and --space-* from
  // tokens.css, and el.dataset.sender above is what tells it whose they are.
  el.style.opacity = '1';
  el.style.pointerEvents = 'all';
}

function hideTransitionCover() {
  const el = document.getElementById('transition-cover');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.5s ease';
      el.style.opacity = '0';
      el.addEventListener('transitionend', () => {
        el.style.pointerEvents = 'none';
        el.style.transition = '';
        el.style.background = '';
        coverPendingUser = null;
        el.classList.remove('stamp-ready');
        delete el.dataset.stampUser;
        // Reset seal elements so next login starts clean
        el.querySelectorAll('.tc-seal').forEach(s => {
          s.getAnimations().forEach(a => a.cancel());
          s.style.filter  = '';
          s.style.display = '';
        });
        const rip = el.querySelector('.tc-ripple');
        if (rip) {
          rip.getAnimations().forEach(a => a.cancel());
          rip.style.border = '';
        }
      }, { once: true });
    });
  });
}

async function signInAs(name) {
  showTransitionCover(name.toLowerCase());

  const err   = document.getElementById('login-error');
  const btnP  = document.getElementById('btn-ryland');
  const btnO  = document.getElementById('btn-rocky');
  const email = NAME_TO_EMAIL[name];

  err.classList.add('hidden');
  btnP.disabled = true;
  btnO.disabled = true;

  try {
    await setPersistence(auth, browserLocalPersistence);
    await signInWithEmailAndPassword(auth, email, AUTH_PASS);
  } catch (ex) {
    err.textContent = 'Couldn\'t open — let Ryland know.';
    err.classList.remove('hidden');
    btnP.disabled = false;
    btnO.disabled = false;
    hideTransitionCover();
  }
}

document.getElementById('btn-ryland').addEventListener('click', () => signInAs('ryland'));
document.getElementById('btn-rocky').addEventListener('click',  () => signInAs('rocky'));

document.getElementById('logout-btn').addEventListener('click', () => signOut(auth));

// Mobile hamburger + popup menu
const hamburger   = document.getElementById('nav-hamburger');
const appNav      = document.querySelector('.app-nav');
const navBackdrop = document.getElementById('nav-backdrop');

function openMenu() {
  appNav.classList.add('menu-open');
  if (navBackdrop) { navBackdrop.style.display = 'block'; }
}
function closeMenu() {
  appNav.classList.remove('menu-open');
  if (navBackdrop) { navBackdrop.style.display = 'none'; }
}

if (hamburger) {
  hamburger.addEventListener('click', e => {
    e.stopPropagation();
    appNav.classList.contains('menu-open') ? closeMenu() : openMenu();
  });
  document.querySelectorAll('.nav-popup .nav-btn').forEach(btn => {
    btn.addEventListener('click', () => closeMenu());
  });
  document.addEventListener('click', e => {
    if (!appNav.contains(e.target)) closeMenu();
  });
  if (navBackdrop) {
    navBackdrop.addEventListener('click', () => closeMenu());
  }
}
// Popup sign-out button
const popupLogout = document.getElementById('nav-popup-logout');
if (popupLogout) {
  popupLogout.addEventListener('click', () => signOut(auth));
}

// Date adjustment arrows — lightweight refresh, no full re-boot
document.getElementById('date-adj-prev').addEventListener('click', async () => {
  letterDateOffset--;
  myLetter = null; theirLetter = null;
  await refreshDateView();
});
document.getElementById('date-adj-next').addEventListener('click', async () => {
  if (letterDateOffset >= 0) return;
  letterDateOffset++;
  myLetter = null; theirLetter = null;
  await refreshDateView();
});

// ══════════════════════════════════════════════════════
//  MOOD PICKER
// ══════════════════════════════════════════════════════

function renderMoodPicker() {
  const sender    = senderTag(me.email);
  const container = document.getElementById('mood-pills');
  if (!container) return;
  container.innerHTML = '';
  MOODS.forEach(mood => {
    const btn = document.createElement('button');
    btn.className    = 'mood-pill';
    btn.dataset.mood = mood;
    btn.textContent  = `${moodEmoji(mood, sender)} ${mood}`;
    btn.addEventListener('click', () => {
      container.querySelectorAll('.mood-pill').forEach(p => p.classList.remove('selected'));
      if (selectedMood === mood) {
        selectedMood = null;
      } else {
        selectedMood = mood;
        btn.classList.add('selected');
      }
    });
    container.appendChild(btn);
  });
}

// ══════════════════════════════════════════════════════
//  DATE REFRESH (used by adjustment arrows)
// ══════════════════════════════════════════════════════

async function refreshDateView() {
  letterDate = shiftDate(todayLetterDate(), letterDateOffset);
  document.getElementById('write-date').textContent         = displayDate(letterDate);
  document.getElementById('today-date-display').textContent = displayDate(letterDate);
  document.getElementById('date-adj-next').disabled         = letterDateOffset >= 0;

  // Reset mood picker selection for the new date
  selectedMood = null;
  document.querySelectorAll('.mood-pill.selected').forEach(p => p.classList.remove('selected'));
  const moodWrap = document.getElementById('mood-picker-wrap');

  const myDocId = `${letterDate}_${me.uid}`;
  const mySnap  = await getDoc(doc(db, 'letters', myDocId));
  myLetter = mySnap.exists() ? { id: myDocId, ...mySnap.data() } : null;
  if (moodWrap) moodWrap.classList.toggle('hidden', !!myLetter);

  if (partnerUnsub) partnerUnsub();
  const partnerQuery = query(
    collection(db, 'letters'),
    where('date', '==', letterDate),
    where('fromEmail', '==', myConfig.partnerEmail)
  );
  partnerUnsub = onSnapshot(partnerQuery, snap => {
    theirLetter = snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
    renderMailbox();
  });

  renderMailbox();
}

// ══════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════

async function boot() {
  const partnerName = USERS[myConfig.partnerEmail]?.name ?? 'my friend';

  // Set placeholders for salutation and signoff
  document.getElementById('write-salutation').dataset.placeholder  = `Dear ${partnerName},`;
  document.getElementById('write-signoff-name').dataset.placeholder = myConfig.name;

  // Fix contenteditable browser quirks (registered once per login)
  ['write-salutation', 'write-signoff-word', 'write-signoff-name'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('blur', () => { if (el.innerHTML === '<br>') el.innerHTML = ''; });
  });

  // Build mood picker with this user's emoji set
  renderMoodPicker();
  updateFloralRules();

  // Initial date + content load (shares logic with date-arrow refresh)
  await refreshDateView();

  await renderArchive();
  initNotifications();   // non-blocking — fire and forget
  showView('mailbox');
}

// ══════════════════════════════════════════════════════
//  MAILBOX
// ══════════════════════════════════════════════════════

function renderMailbox() {
  renderMySlot();
  renderPartnerSlot();
}

function renderMySlot() {
  const slot        = document.getElementById('my-slot');
  const partnerName = USERS[myConfig.partnerEmail]?.name ?? 'my friend';

  const mySender = senderTag(me.email);

  if (myLetter) {
    const canEdit = new Date() < myLetter.editableUntil.toDate();
    slot.innerHTML = `
      <div class="env-card" id="my-env-card" data-sender="${mySender}">
        <div class="env-art">
          <div class="env-art-body">
            <div class="env-art-tri-left"></div>
            <div class="env-art-tri-right"></div>
            <div class="env-art-tri-bottom"></div>
          </div>
          <div class="env-art-flap"></div>
          <div class="env-art-seal">${sealGlyph(mySender)}</div>
        </div>
        <p class="env-card-label">Your letter, sent ✓</p>
        ${canEdit ? `<p class="env-card-sub">editable for ${minutesLeft(myLetter.editableUntil)} more min</p>` : ''}
        ${senderMotif(mySender)}
      </div>`;
    document.getElementById('my-env-card').addEventListener('click', () => openLetter(myLetter.id));
  } else {
    slot.innerHTML = `
      <div class="env-card env-empty" id="my-env-card" data-sender="${mySender}">
        <div class="env-art-empty">✒ write</div>
        <p class="env-card-label">You haven't written yet</p>
        <p class="env-card-sub">to ${partnerName}</p>
        ${senderMotif(mySender)}
      </div>`;
    document.getElementById('my-env-card').addEventListener('click', () => showView('write'));
  }
}

function renderPartnerSlot() {
  const slot        = document.getElementById('partner-slot');
  const partnerName = USERS[myConfig.partnerEmail]?.name ?? 'my friend';

  if (theirLetter) {
    const theirSender = senderTag(myConfig.partnerEmail);
    slot.innerHTML = `
      <div class="env-card" id="their-env-card" data-sender="${theirSender}">
        <div class="env-art">
          <div class="env-art-body">
            <div class="env-art-tri-left"></div>
            <div class="env-art-tri-right"></div>
            <div class="env-art-tri-bottom"></div>
          </div>
          <div class="env-art-flap"></div>
          <div class="env-art-seal">${sealGlyph(theirSender)}</div>
        </div>
        <p class="env-card-label">A letter from ${partnerName} 📡</p>
        ${senderMotif(theirSender)}
      </div>`;
    document.getElementById('their-env-card').addEventListener('click', () => openLetter(theirLetter.id));
  } else {
    slot.innerHTML = `
      <div class="env-card env-waiting">
        <div class="waiting-dots"><span></span><span></span><span></span></div>
        <p class="env-card-label">Waiting for ${partnerName}…</p>
      </div>`;
  }
}

// ══════════════════════════════════════════════════════
//  ARCHIVE
// ══════════════════════════════════════════════════════

async function renderArchive() {
  const container = document.getElementById('archive-list');
  container.innerHTML = '<p class="placeholder-text">Loading…</p>';

  try {
    const snap = await getDocs(
      query(collection(db, 'letters'), orderBy('date', 'desc'))
    );

    if (snap.empty) {
      container.innerHTML = '<p class="placeholder-text">Your correspondence begins here…</p>';
      updateStreak([]);
      return;
    }

    // Cache and group by month → date
    allLetters = [];
    const byMonth = {};
    snap.forEach(d => {
      const data = d.data();
      allLetters.push({ id: d.id, ...data });
      const monthKey = data.date.slice(0, 7);
      if (!byMonth[monthKey]) byMonth[monthKey] = {};
      if (!byMonth[monthKey][data.date]) byMonth[monthKey][data.date] = [];
      byMonth[monthKey][data.date].push({ id: d.id, ...data });
    });

    updateStreak(allLetters);

    container.innerHTML = '';
    const monthKeys = Object.keys(byMonth).sort().reverse();
    monthKeys.forEach((monthKey, i) => {
      const monthLetterCount = Object.values(byMonth[monthKey])
        .reduce((sum, letters) => sum + letters.length, 0);

      const monthEl = document.createElement('details');
      monthEl.className = 'archive-month';
      if (i === 0) monthEl.open = true;
      monthEl.innerHTML = `
        <summary class="archive-month-header">
          <span class="archive-month-name">${displayMonth(monthKey)}</span>
          <span class="archive-month-count">${monthLetterCount} letter${monthLetterCount === 1 ? '' : 's'}</span>
        </summary>
        <div class="archive-month-body"></div>`;
      container.appendChild(monthEl);

      const monthBody = monthEl.querySelector('.archive-month-body');
      Object.keys(byMonth[monthKey]).sort().reverse().forEach(date => {
        const group = document.createElement('div');
        group.className = 'archive-group';
        group.innerHTML = `<p class="archive-group-date">${displayDate(date)}</p>
          <div class="archive-row"></div>`;
        monthBody.appendChild(group);

        const row = group.querySelector('.archive-row');
        byMonth[monthKey][date].forEach(letter => {
          const card = document.createElement('div');
          card.className = 'archive-card';
          // Whose letter this is, so tokens.css can colour it. Without this an
          // archive shows every envelope in the signed-in person's colours,
          // which is how Rocky's cards ended up green.
          card.dataset.sender = senderTag(letter.fromEmail);
          card.innerHTML = `
            <div class="archive-env-small">
              <div class="aes-body">
                <div class="aes-tri-left"></div>
                <div class="aes-tri-right"></div>
                <div class="aes-tri-bottom"></div>
              </div>
              <div class="aes-flap"></div>
              <div class="aes-seal">${sealGlyph(card.dataset.sender)}</div>
            </div>
            <p class="archive-card-name">${letter.from}</p>
            <p class="archive-card-words">${letter.wordCount} words</p>
            <p class="archive-card-mood">${letter.mood ? moodLabel(letter.mood, senderTag(letter.fromEmail)) : '&nbsp;'}</p>
            ${senderMotif(card.dataset.sender)}`;
          card.addEventListener('click', () => openLetter(letter.id));
          row.appendChild(card);
        });
      });
    });
  } catch (ex) {
    console.error(ex);
    container.innerHTML = '<p class="placeholder-text">Could not load archive.</p>';
  }
}

// ══════════════════════════════════════════════════════
//  WRITE
// ══════════════════════════════════════════════════════

const letterBodyEl = document.getElementById('letter-body');
const wcNumEl      = document.getElementById('wc-num');
const wcFillEl     = document.getElementById('wc-fill');
const sendBtn      = document.getElementById('send-btn');

letterBodyEl.addEventListener('input', () => {
  const count = wordCount(letterBodyEl.value);
  wcNumEl.textContent    = count;
  const pct = Math.min(100, (count / 250) * 100);
  wcFillEl.style.width   = pct + '%';
  wcFillEl.className     = 'wc-fill' + (count >= 250 ? ' done' : '');
  sendBtn.disabled       = count < 250;
});

sendBtn.addEventListener('click', handleSend);

function getFieldText(id, placeholder) {
  const el = document.getElementById(id);
  const text = el.innerText.trim();
  return text || placeholder;
}

async function handleSend() {
  const content = letterBodyEl.value.trim();
  if (wordCount(content) < 250) return;

  sendBtn.disabled = true;
  sendBtn.querySelector('.btn-label').textContent = 'Sealing…';

  const partnerName = USERS[myConfig.partnerEmail]?.name ?? 'my friend';
  const salutation  = getFieldText('write-salutation',   `Dear ${partnerName},`);
  const signoffWord = getFieldText('write-signoff-word', 'Onward,');
  const signoffName = getFieldText('write-signoff-name', myConfig.name);

  try {
    if (editingId) {
      // ── UPDATE existing letter ──────────────────
      const ref  = doc(db, 'letters', editingId);
      const snap = await getDoc(ref);
      if (!snap.exists()) { showError('Letter not found.'); return; }

      const editable = snap.data().editableUntil;
      if (new Date() >= editable.toDate()) {
        showError('The edit window has closed.');
        return;
      }

      await setDoc(ref, {
        content,
        wordCount: wordCount(content),
        lastEdited: Timestamp.now()
      }, { merge: true });

      myLetter = { ...myLetter, content, wordCount: wordCount(content) };
      exitEditMode();
    } else {
      // ── SEND new letter ─────────────────────────
      const myDocId = `${letterDate}_${me.uid}`;
      const ref     = doc(db, 'letters', myDocId);
      const existing = await getDoc(ref);
      if (existing.exists()) {
        showError("You've already sent today's letter.");
        sendBtn.disabled = false;
        sendBtn.querySelector('.btn-label').textContent = 'Seal & Send ✦';
        return;
      }

      const now          = Timestamp.now();
      const editableUntil = Timestamp.fromMillis(now.toMillis() + 60 * 60 * 1000);

      await setDoc(ref, {
        from:         myConfig.name,
        to:           partnerName,
        fromEmail:    me.email,
        fromUid:      me.uid,
        date:         letterDate,
        content,
        salutation,
        signoffWord,
        signoffName,
        wordCount:    wordCount(content),
        mood:         selectedMood || null,
        createdAt:    now,
        editableUntil,
        lastEdited:   null
      });

      myLetter = {
        id: myDocId, from: myConfig.name, to: partnerName,
        date: letterDate, content, wordCount: wordCount(content),
        mood: selectedMood || null,
        createdAt: now, editableUntil, lastEdited: null
      };
    }

    // Reset write area
    letterBodyEl.value     = '';
    wcNumEl.textContent    = '0';
    wcFillEl.style.width   = '0%';
    wcFillEl.className     = 'wc-fill';
    sendBtn.disabled       = true;
    sendBtn.querySelector('.btn-label').textContent = 'Seal & Send ✦';
    document.getElementById('write-salutation').innerHTML  = '';
    document.getElementById('write-signoff-word').innerHTML = '';
    document.getElementById('write-signoff-name').innerHTML = '';

    const wasNewLetter = !editingId;
    renderMailbox();
    await renderArchive();
    showSuccessToast();
    showView('mailbox');
    if (wasNewLetter) pushNotifyPartner();  // non-blocking, only on new sends
  } catch (ex) {
    console.error(ex);
    showError('Something went wrong. Please try again.');
    sendBtn.disabled = false;
    sendBtn.querySelector('.btn-label').textContent = 'Seal & Send ✦';
  }
}

// Expose for "Read it ›" link in already-wrote notice
window._viewMyTodayLetter = () => {
  if (myLetter) openLetter(myLetter.id);
};

// ══════════════════════════════════════════════════════
//  READ MODAL
// ══════════════════════════════════════════════════════

async function openLetter(letterId) {
  const snap = await getDoc(doc(db, 'letters', letterId));
  if (!snap.exists()) return;
  const letter = { id: snap.id, ...snap.data() };

  // Letter always looks like whoever wrote it, regardless of who's reading
  const sender = senderTag(letter.fromEmail);
  document.getElementById('modal-read').dataset.sender = sender;
  document.getElementById('read-stamp').innerHTML = senderMotif(sender);
  document.getElementById('env-big-seal').innerHTML = sealGlyph(sender);

  // Populate phase-letter
  document.getElementById('read-date').textContent       = displayDate(letter.date);
  document.getElementById('read-salutation').textContent = letter.salutation  || `Dear ${letter.to},`;
  document.getElementById('read-content').textContent    = letter.content;
  document.getElementById('read-signoff-word').textContent = letter.signoffWord || 'Onward,';
  document.getElementById('read-signoff-name').textContent = letter.signoffName || letter.from;
  document.getElementById('read-wc').textContent         = `${letter.wordCount} words`;

  const readMoodWrap = document.getElementById('read-mood-wrap');
  const readMoodEl   = document.getElementById('read-mood');
  if (letter.mood && readMoodWrap && readMoodEl) {
    readMoodEl.textContent = moodLabel(letter.mood, sender);
    readMoodWrap.classList.remove('hidden');
  } else if (readMoodWrap) {
    readMoodWrap.classList.add('hidden');
  }

  const isMineLetter = letter.fromUid === me.uid;
  const canEdit      = isMineLetter && new Date() < letter.editableUntil.toDate();
  const editBtn      = document.getElementById('edit-btn');
  const editTimer    = document.getElementById('edit-timer');

  if (canEdit) {
    const mins = minutesLeft(letter.editableUntil);
    editTimer.textContent = `${mins} min left to edit`;
    editTimer.classList.remove('hidden');
    editBtn.classList.remove('hidden');
    editBtn.onclick = () => enterEditMode(letter);
  } else {
    editTimer.classList.add('hidden');
    editBtn.classList.add('hidden');
  }

  // Show modal — envelope phase first
  const modal = document.getElementById('modal-read');
  const phaseEnv    = document.getElementById('phase-envelope');
  const phaseLetter = document.getElementById('phase-letter');
  const envBig      = modal.querySelector('.env-big');

  phaseEnv.classList.remove('fading');
  phaseEnv.classList.remove('hidden');
  phaseLetter.classList.add('hidden');
  envBig.classList.remove('opening');

  modal.classList.remove('hidden');

  // Animate flap open
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      envBig.classList.add('opening');
    });
  });

  // After animation: swap phases
  setTimeout(() => {
    phaseEnv.classList.add('fading');
    setTimeout(() => {
      phaseEnv.classList.add('hidden');
      phaseLetter.classList.remove('hidden');
    }, 400);
  }, 1100);
}

function closeModal() {
  const modal = document.getElementById('modal-read');
  modal.classList.add('hidden');
  // Reset
  modal.querySelector('.env-big').classList.remove('opening');
  document.getElementById('phase-envelope').classList.remove('fading', 'hidden');
  document.getElementById('phase-letter').classList.add('hidden');
}

document.getElementById('close-modal-btn').addEventListener('click', closeModal);
document.getElementById('modal-backdrop').addEventListener('click', closeModal);

// ══════════════════════════════════════════════════════
//  SETTINGS (date correction)
// ══════════════════════════════════════════════════════

function openSettings() {
  const modal  = document.getElementById('modal-settings');
  const select = document.getElementById('settings-letter-select');
  const status = document.getElementById('settings-status');

  status.textContent = '';
  status.classList.add('hidden');

  const myLetters = allLetters
    .filter(l => l.fromEmail === me.email)
    .sort((a, b) => b.date.localeCompare(a.date));

  select.innerHTML = '<option value="">— choose a letter —</option>';
  myLetters.forEach(l => {
    const opt = document.createElement('option');
    opt.value         = l.id;
    opt.textContent   = `${displayDate(l.date)}`;
    opt.dataset.date  = l.date;
    select.appendChild(opt);
  });

  select.onchange = () => {
    const opt = select.selectedOptions[0];
    if (opt?.dataset.date) document.getElementById('settings-date-input').value = opt.dataset.date;
  };

  modal.classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('modal-settings').classList.add('hidden');
  showView('mailbox');
}

async function saveSettings() {
  const select    = document.getElementById('settings-letter-select');
  const dateInput = document.getElementById('settings-date-input');
  const status    = document.getElementById('settings-status');
  const saveBtn   = document.getElementById('settings-save-btn');

  const letterId = select.value;
  const newDate  = dateInput.value;
  const oldDate  = select.selectedOptions[0]?.dataset.date;

  status.classList.remove('hidden');
  if (!letterId || !newDate) { status.textContent = 'Please select a letter and a date.'; return; }
  if (newDate === oldDate)   { status.textContent = 'Date is already ' + displayDate(newDate) + '.'; return; }

  // ── Phase 2: confirm code + delete (only reached after phase 1 succeeded) ──
  const pending = JSON.parse(localStorage.getItem('pending_delete') ?? 'null');
  if (pending && pending.letterId === letterId) {
    const codeInput = document.getElementById('settings-confirm-code');
    if (!codeInput) { renderConfirmStep(pending); return; }

    if (codeInput.value.trim().toUpperCase() !== pending.code) {
      status.textContent = 'Code does not match. Check your email.';
      return;
    }

    saveBtn.disabled = true;
    status.textContent = 'Verifying backup before deletion…';

    try {
      // Re-verify both docs exist before any delete
      const [newSnap, oldSnap] = await Promise.all([
        getDoc(doc(db, 'letters', pending.newDocId)),
        getDoc(doc(db, 'letters', letterId))
      ]);

      if (!newSnap.exists()) {
        throw new Error('Backup copy not found in Firestore — old record is safe. Try moving the letter again.');
      }
      if (!oldSnap.exists()) {
        // Old doc was already removed externally — nothing to delete
        localStorage.removeItem('pending_delete');
        status.textContent = '✓ Old record was already removed — letter lives under ' + displayDate(pending.newDate);
        await renderArchive(); renderMailbox();
        return;
      }

      const nd = newSnap.data();
      const od = oldSnap.data();

      if (nd.fromUid !== od.fromUid || nd.content !== od.content) {
        throw new Error('Content mismatch between backup and original — aborting. Old record is safe.');
      }
      if (nd.date !== pending.newDate) {
        throw new Error('Backup has wrong date field — aborting. Old record is safe.');
      }

      // All checks passed — safe to delete
      await deleteDoc(doc(db, 'letters', letterId));

      localStorage.removeItem('pending_delete');
      status.textContent = '✓ Done — letter is now under ' + displayDate(pending.newDate);
      await renderArchive();
      renderMailbox();
      setTimeout(openSettings, 1400);
    } catch (err) {
      // Never clear pending_delete on error — user can retry safely
      status.textContent = err.code === 'permission-denied'
        ? 'Permission denied — add the delete rule to Firestore first (see README).'
        : err.message;
    } finally {
      saveBtn.disabled = false;
    }
    return;
  }

  // ── Phase 1: create backup copy, verify it, then gate on email code ──
  saveBtn.disabled = true;
  status.textContent = 'Reading original…';

  try {
    const oldSnap = await getDoc(doc(db, 'letters', letterId));
    if (!oldSnap.exists()) throw new Error('Original letter not found.');

    const oldData  = oldSnap.data();
    const newDocId = `${newDate}_${oldData.fromUid}`;

    // Never silently overwrite a letter that already exists on the target date
    const targetSnap = await getDoc(doc(db, 'letters', newDocId));
    if (targetSnap.exists()) {
      throw new Error(`A letter already exists under ${displayDate(newDate)} — choose a different date.`);
    }

    status.textContent = 'Creating backup under new date…';
    await setDoc(doc(db, 'letters', newDocId), { ...oldData, date: newDate });

    // Immediately read back to confirm the write persisted
    status.textContent = 'Verifying backup was written…';
    const verifySnap = await getDoc(doc(db, 'letters', newDocId));
    if (!verifySnap.exists()) {
      throw new Error('Backup write did not persist — aborting. Original is untouched.');
    }
    const vd = verifySnap.data();
    if (vd.content !== oldData.content || vd.fromUid !== oldData.fromUid) {
      throw new Error('Backup content mismatch after write — aborting. Original is untouched.');
    }

    // Backup verified — generate code and open email for authorisation
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    localStorage.setItem('pending_delete', JSON.stringify({ letterId, newDate, newDocId, code }));

    const subj = encodeURIComponent(`Confirm entry move: ${displayDate(oldDate)} → ${displayDate(newDate)}`);
    const body = encodeURIComponent(
      `I authorise moving my entry from ${displayDate(oldDate)} to ${displayDate(newDate)}.\n\nConfirmation code: ${code}\n\nEnter this code in the Petrova Log settings to permanently remove the old record.\n\n(If you did not request this, the original entry is safe — just ignore this email.)`
    );
    // Public demo note: the actual delete this authorises is blocked by
    // Firestore rules regardless (no allow-delete rule on the demo project),
    // so a visitor completing this flow gets a permission error at the final
    // step rather than actually removing seed content. Point this at
    // whatever inbox you want the confirmation email to land in.
    window.open(`mailto:you@example.com?subject=${subj}&body=${body}`, '_blank');

    renderConfirmStep({ letterId, newDate, newDocId, code });
  } catch (err) {
    status.textContent = err.message;
    saveBtn.disabled = false;
  }
}

function renderConfirmStep({ letterId, newDate, newDocId, code: _code }) {
  const form = document.querySelector('.settings-form');
  form.innerHTML = `
    <p class="settings-label" style="opacity:.8;letter-spacing:.05rem;text-transform:none;font-size:.82rem;line-height:1.5;">
      Backup created under ${displayDate(newDate)} and verified in Firestore.<br>
      Your email client has opened with a pre-filled confirmation.<br>
      Send it, then enter the code from that email below.
    </p>
    <label class="settings-label" for="settings-confirm-code">Confirmation code from email</label>
    <input id="settings-confirm-code" class="settings-date-input"
           placeholder="6-character code" maxlength="6"
           autocapitalize="characters" spellcheck="false">
    <p id="settings-status" class="settings-status hidden"></p>
    <button id="settings-save-btn" class="btn-wax settings-save">Confirm &amp; delete old record</button>
  `;
  document.getElementById('settings-save-btn').addEventListener('click', saveSettings);
}

document.getElementById('nav-settings-btn').addEventListener('click', openSettings);
document.getElementById('close-settings-btn').addEventListener('click', closeSettings);
document.getElementById('settings-backdrop').addEventListener('click', closeSettings);
document.getElementById('settings-save-btn').addEventListener('click', saveSettings);

// ══════════════════════════════════════════════════════
//  EDIT MODE
// ══════════════════════════════════════════════════════

function enterEditMode(letter) {
  closeModal();
  editingId = letter.id;

  letterBodyEl.value = letter.content;
  letterBodyEl.dispatchEvent(new Event('input'));

  const partnerName = USERS[myConfig.partnerEmail]?.name ?? 'my friend';
  const sal = document.getElementById('write-salutation');
  const sw  = document.getElementById('write-signoff-word');
  const sn  = document.getElementById('write-signoff-name');
  sal.textContent = letter.salutation  !== `Dear ${partnerName},` ? (letter.salutation || '')  : '';
  sw.textContent  = letter.signoffWord !== 'Onward,'              ? (letter.signoffWord || '') : '';
  sn.textContent  = letter.signoffName !== myConfig.name          ? (letter.signoffName || '') : '';

  sendBtn.querySelector('.btn-label').textContent = 'Update Letter ✦';

  document.getElementById('mood-picker-wrap')?.classList.add('hidden');
  showView('write');
}

function exitEditMode() {
  editingId = null;
  sendBtn.querySelector('.btn-label').textContent = 'Seal & Send ✦';
}

// ══════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById(`view-${name}`)?.classList.remove('hidden');
  document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add('active');

  // Write view guard
  if (name === 'write') {
    const notice = document.getElementById('already-wrote-notice');
    const paper  = document.getElementById('paper-write');
    if (myLetter && !editingId) {
      notice.classList.remove('hidden');
      paper.classList.add('hidden');
    } else {
      notice.classList.add('hidden');
      paper.classList.remove('hidden');
    }
  }
}

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

function showScreen(name) {
  document.getElementById('screen-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('screen-app').classList.toggle('hidden',   name !== 'app');
}

// ══════════════════════════════════════════════════════
//  STREAKS
// ══════════════════════════════════════════════════════

function updateStreak(letters) {
  const streakEl = document.getElementById('streak-display');
  const countEl  = document.getElementById('streak-count');

  // Build set of dates where both users wrote
  const byDate = {};
  letters.forEach(l => {
    if (!byDate[l.date]) byDate[l.date] = new Set();
    byDate[l.date].add(l.fromEmail);
  });

  const email1 = me.email;
  const email2 = myConfig.partnerEmail;
  const completeDates = new Set(
    Object.keys(byDate).filter(d => byDate[d].has(email1) && byDate[d].has(email2))
  );

  // Count consecutive days ending at today's letter date
  let streak = 0;
  let check  = letterDate;
  while (completeDates.has(check)) {
    streak++;
    const d = new Date(check + 'T12:00:00');
    d.setDate(d.getDate() - 1);
    check = d.toISOString().split('T')[0];
  }

  if (streak >= 2) {
    countEl.textContent = streak;
    streakEl.classList.remove('hidden');
  } else {
    streakEl.classList.add('hidden');
  }
}

// ══════════════════════════════════════════════════════
//  NOTIFICATIONS (FCM)
// ══════════════════════════════════════════════════════

let fcmMessaging  = null;
let partnerFcmToken = null;

async function initNotifications() {
  if (!('serviceWorker' in navigator) || !('Notification' in window)) return;

  try {
    const { getMessaging, getToken, onMessage, isSupported } = await import(
      'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js'
    );
    if (!await isSupported()) return;

    const swReg = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    fcmMessaging = getMessaging(firebaseApp);

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const token = await getToken(fcmMessaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: swReg
    });

    // Save my token to Firestore (keyed by email)
    await setDoc(doc(db, 'users', me.email), { fcmToken: token }, { merge: true });

    // Pre-fetch partner's token
    const partnerSnap = await getDoc(doc(db, 'users', myConfig.partnerEmail));
    if (partnerSnap.exists()) partnerFcmToken = partnerSnap.data().fcmToken ?? null;

    // Handle foreground messages (app is open)
    onMessage(fcmMessaging, payload => {
      const body = payload.notification?.body ?? 'A new letter arrived 🪶';
      showInAppNotification(body);
    });
  } catch (err) {
    console.log('Notifications unavailable:', err.message);
  }
}

async function pushNotifyPartner() {
  // Refresh partner token in case they just logged in
  try {
    const snap = await getDoc(doc(db, 'users', myConfig.partnerEmail));
    if (snap.exists()) partnerFcmToken = snap.data().fcmToken ?? null;
  } catch { return; }

  if (!partnerFcmToken) return;

  try {
    await fetch('/notify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ token: partnerFcmToken, senderName: myConfig.name })
    });
  } catch (err) {
    console.log('Push notify failed silently:', err.message);
  }
}

function showInAppNotification(body) {
  const el = document.createElement('div');
  el.className = 'toast toast-success';
  el.style.cssText = 'position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);z-index:900;';
  el.textContent = body;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ══════════════════════════════════════════════════════
//  TOASTS
// ══════════════════════════════════════════════════════

function showError(msg) {
  const el = document.getElementById('toast-error');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 4500);
}

function showSuccessToast() {
  const el = document.getElementById('toast-success');
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

