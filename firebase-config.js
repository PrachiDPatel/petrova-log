import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth }        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFirestore }   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ─────────────────────────────────────────────────────────────────
// 1. Go to https://console.firebase.google.com
// 2. Create a project → Add Web App → copy the config below
// 3. Enable Authentication → Email/Password → add two users (see USERS below)
// 4. Enable Firestore Database (start in production mode)
// 5. Add the security rules from README.md
// ─────────────────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyBg5lWmRpdHrXa0FQ3Evlf774ptkMWR8PQ",
  authDomain:        "petrova-log.firebaseapp.com",
  projectId:         "petrova-log",
  storageBucket:     "petrova-log.firebasestorage.app",
  messagingSenderId: "230144991931",
  appId:             "1:230144991931:web:ccd6ee054426ad186e3f9e"
};

// Name → Firebase email (emails are internal only, never shown)
export const NAME_TO_EMAIL = {
  'ryland': 'ryland@petrovalog.demo',
  'rocky':  'rocky@petrovalog.demo'
};

export const USERS = {
  'ryland@petrovalog.demo': {
    name:         'Ryland',
    partnerEmail: 'rocky@petrovalog.demo'
  },
  'rocky@petrovalog.demo': {
    name:         'Rocky',
    partnerEmail: 'ryland@petrovalog.demo'
  }
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db   = getFirestore(app);
export { app };

// Get this from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
// (optional — push notifications aren't required for the demo to work)
export const VAPID_KEY = 'YOUR_VAPID_KEY';

// Shared sign-in credential — set both Firebase accounts to this password
export const AUTH_PASS = 'astrophage';
