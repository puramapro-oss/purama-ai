// Purama AI — Service Worker
// Handles: install/activate, offline fallback, web push, notification clicks
const CACHE_PREFIX = 'purama-static-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const OFFLINE_URL = '/offline.html';
// The previous worker cached "/" with credentials. Retire only that known
// legacy cache; other applications on this origin own their own caches.
const LEGACY_CACHE_NAME = 'purama-v1';
const PRECACHE = [OFFLINE_URL, '/manifest.json'];
const NOTIFICATION_FALLBACK = '/dashboard';
const NOTIFICATION_PAGES = new Set([
  '/notifications',
  '/notification-settings',
  '/my-agents',
  '/mes-connexions',
  '/fiscal',
  '/influenceur/dashboard',
  '/admin/dashboard',
  '/admin/influenceurs',
  '/admin/contracts',
  '/ambassadeur/rejoindre',
]);

// This standalone worker cannot import the application's TypeScript helper.
// Keep its same-origin boundary, then allow only review screens. Notification
// queries and fragments must never carry credentials or execution instructions.
function safeNotificationPath(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || value !== value.trim()) {
    return NOTIFICATION_FALLBACK;
  }
  if (value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) {
    return NOTIFICATION_FALLBACK;
  }
  if (!value.startsWith('/') && !/^https?:\/\//i.test(value)) {
    return NOTIFICATION_FALLBACK;
  }

  try {
    const parsed = new URL(value, self.location.origin);
    if (parsed.origin !== self.location.origin || parsed.username || parsed.password) {
      return NOTIFICATION_FALLBACK;
    }
    const path = parsed.pathname.replace(/\/$/, '');
    if (
      NOTIFICATION_PAGES.has(path) ||
      /^\/dashboard(?:\/[a-zA-Z0-9_-]+)*$/.test(path) ||
      /^\/agent\/[a-zA-Z0-9_-]+$/.test(path)
    ) {
      return path;
    }
  } catch {
    // Malformed, encoded or non-application destinations use the review hub.
  }
  return NOTIFICATION_FALLBACK;
}

function isSameOriginClient(client) {
  try {
    const parsed = new URL(client.url);
    return parsed.origin === self.location.origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

async function openNotificationPage(url) {
  let clientsList = [];
  try {
    clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  } catch {
    // Window enumeration can fail; opening the validated URL is still safe.
  }

  for (const client of clientsList) {
    if (!isSameOriginClient(client) || typeof client.focus !== 'function') continue;
    try {
      if (client.url === url) return await client.focus();
      if (typeof client.navigate !== 'function') continue;
      const navigated = await client.navigate(url);
      if (isSameOriginClient(navigated) && typeof navigated.focus === 'function') {
        return await navigated.focus();
      }
    } catch {
      // A closed window or rejected focus must not prevent another safe attempt.
    }
  }

  try {
    return await self.clients.openWindow(url);
  } catch {
    // Browser activation policies may prevent opening a window. Never retry
    // with an unvalidated payload or execute a notification action instead.
    console.warn('[sw] Unable to open the notification review screen');
    return null;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE.map((path) => new Request(new URL(path, self.location.origin), {
        cache: 'reload',
        credentials: 'omit',
        redirect: 'error',
      })));
      // A failed/offline installation must reject and leave the previous worker
      // in place, instead of activating without a usable offline page.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key === LEGACY_CACHE_NAME || (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME))
        .map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

// Network-first for navigations, with offline fallback
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req).catch(async () => {
      try {
        const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
        if (offline) return offline;
      } catch {
        // Storage can be unavailable or evicted, even after a successful install.
      }
      return new Response('Hors ligne — reconnecte-toi puis réessaie.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    })
  );
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
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};

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
      url: safeNotificationPath(data.action_url),
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
  const url = new URL(safeNotificationPath(data.url), self.location.origin).href;

  // Every click opens the authenticated application. Sensitive actions are
  // deliberately never executed directly from notification payload data.
  event.waitUntil(openNotificationPage(url));
});
