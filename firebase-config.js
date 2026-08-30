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
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.firebasestorage.app",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
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
