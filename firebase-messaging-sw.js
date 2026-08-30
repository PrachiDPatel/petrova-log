importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// A service worker cannot import from firebase-config.js, so the config is
// repeated here. Keep the two in sync — this file is easy to forget, and it is
// the reason a previous copy of this project still carried another project's
// real credentials long after everything else had been renamed.
firebase.initializeApp({
  apiKey:            "AIzaSyBg5lWmRpdHrXa0FQ3Evlf774ptkMWR8PQ",
  authDomain:        "petrova-log.firebaseapp.com",
  projectId:         "petrova-log",
  storageBucket:     "petrova-log.firebasestorage.app",
  messagingSenderId: "230144991931",
  appId:             "1:230144991931:web:ccd6ee054426ad186e3f9e"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification ?? {};
  self.registration.showNotification(title || 'The Petrova Log', {
    body:      body || 'A new entry has arrived 🪶',
    icon:      '/icon.svg',
    badge:     '/icon.svg',
    tag:       'petrova-entry',
    renotify:  true,
    data:      { url: self.location.origin }
  });
});

// Clicking the notification opens / focuses the app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client)
          return client.focus();
      }
      return clients.openWindow(self.location.origin);
    })
  );
});
