// Purama AI — Service Worker
// Handles: install/activate, offline fallback, web push, notification clicks
const CACHE_NAME = 'purama-v1';
const OFFLINE_URL = '/offline.html';
const PRECACHE = ['/', '/offline.html', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for navigations, with offline fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || new Response('Hors ligne', { status: 503 })))
    );
  }
});

// =============================================================
// Push notifications
// =============================================================
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Purama', body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Purama AI';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [100, 50, 100],
    tag: data.tag || data.action_type || 'purama',
    renotify: true,
    requireInteraction: data.priority === 'urgent' || data.priority === 'high',
    data: {
      url: data.action_url || '/dashboard',
      action_type: data.action_type,
    },
    actions: [],
  };

  // Contextual actions per agent type
  if (data.action_type === 'approve_declaration') {
    // A service worker has no trustworthy Supabase user session to authorize
    // a sensitive mutation. Approval must happen in the authenticated UI.
    options.actions = [{ action: 'review', title: '👁 Valider dans Purama' }];
  } else if (data.action_type === 'approve_draft') {
    options.actions = [{ action: 'review', title: '👁 Vérifier dans Purama' }];
  } else if (data.action_type === 'review') {
    options.actions = [{ action: 'review', title: '👁 Voir' }];
  }

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/dashboard';

  // Every click opens the authenticated application. Sensitive actions are
  // deliberately never executed directly from notification payload data.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        if ('focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
