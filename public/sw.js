// Purama AI — Service Worker
// Handles: install/activate, offline fallback, web push, notification clicks
const CACHE_NAME = 'purama-offline-v8';
const OFFLINE_URL = '/offline.html';
// BEGIN OFFLINE ASSET MANIFEST
// OFFLINE ASSET CACHE VERSION: purama-offline-v8
const OFFLINE_ASSETS = [
  {
    "path": "/offline.html",
    "types": [
      "text/html"
    ],
    "bytes": 17795,
    "sha256": "985933b735663e75c8174041a2ae75ec1de88f759279133293435fdcf14a35ca"
  },
  {
    "path": "/offline-workspace.js",
    "types": [
      "text/javascript",
      "application/javascript",
      "application/ecmascript",
      "text/ecmascript"
    ],
    "bytes": 46034,
    "sha256": "db52a8b8fa63b520bf1b16b415fd23208ba66899f1236897bb31f8a3c7b2dfbb"
  },
  {
    "path": "/offline-library-backup.js",
    "types": [
      "text/javascript",
      "application/javascript",
      "application/ecmascript",
      "text/ecmascript"
    ],
    "bytes": 12784,
    "sha256": "d180b05605564f7e1acab48e2504f46d4fa6c220ad3386edfe36bea39df0d0e4"
  },
  {
    "path": "/manifest.json",
    "types": [
      "application/json",
      "application/manifest+json"
    ],
    "bytes": 1112,
    "sha256": "569bf509b38dd6fcf0e6286efc2cd47f768ee646cae472f4dcc0768aecc9bc24"
  }
];
// END OFFLINE ASSET MANIFEST
const PRECACHE = OFFLINE_ASSETS.map((asset) => asset.path);

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


// Validate the decoded bytes, not just HTTP success: SPA/login fallbacks can be 200.
// The known release size bounds each read, including a response without Content-Length.
async function validOfflineAsset(response, asset) {
  if (!response || !response.ok || response.redirected) return false;
  const mime = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (!asset.types.includes(mime)) return false;
  try {
    const body = response.clone().body;
    if (!body) return false;
    const reader = body.getReader();
    const bytes = new Uint8Array(asset.bytes);
    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > bytes.byteLength) {
        // Do not await cancellation of a tee: its other branch is the cached response.
        void reader.cancel().catch(() => {});
        return false;
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== asset.bytes) return false;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('') === asset.sha256;
  } catch (_) { return false; }
}

async function cacheIsReady(cache) {
  const checks = await Promise.all(OFFLINE_ASSETS.map(async (asset) =>
    validOfflineAsset(await cache.match(asset.path), asset)));
  return OFFLINE_ASSETS.length === 4 && checks.every(Boolean);
}

async function prepareAssets(cache) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // Nothing is written until all responses match this worker's release.
    const responses = await Promise.all(OFFLINE_ASSETS.map(async (asset) => {
      const response = await fetch(new URL(asset.path, self.location.origin).href, {
        cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      if (!await validOfflineAsset(response, asset)) throw new Error('Invalid offline resource: ' + asset.path);
      return response;
    }));
    // Each accepted file has the immutable hash for this cache version. If a put
    // fails, existing valid files remain valid; an incomplete cache is never ready.
    await Promise.all(OFFLINE_ASSETS.map((asset, index) => cache.put(asset.path, responses[index])));
    if (!await cacheIsReady(cache)) throw new Error('Offline cache verification failed');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // A failed preparation must reject installation and leave the old worker usable.
    await prepareAssets(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const obsolete = keys.filter((key) => key !== CACHE_NAME
      && (key === 'purama-v1' || /^purama-(?:static|offline)-v[1-9][0-9]*$/.test(key)));
    await Promise.all(obsolete.map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

// Only the self-contained workspace is cache-first. Other navigations retain
// their existing network-first behavior; authenticated/API responses are not cached.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith((async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(url.pathname);
        const asset = OFFLINE_ASSETS.find((entry) => entry.path === url.pathname);
        if (await validOfflineAsset(cached, asset)) return cached;
      } catch (_) { /* Online access can still work when local cache storage fails. */ }
      return fetch(req);
    })());
    return;
  }
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch (_) {
        try {
          const cache = await caches.open(CACHE_NAME);
          const fallback = await cache.match(OFFLINE_URL);
          if (await cacheIsReady(cache) && fallback) return fallback;
        } catch (_) { /* Report the unavailable fallback below. */ }
        return new Response('Espace hors connexion indisponible. Reconnectez-vous au site pour le préparer.', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
    })());
  }
});

// Readiness checks do not fetch. Re-preparation is an explicit user action and
// also repairs eviction when the active worker's code has not changed.
self.addEventListener('message', (event) => {
  const prepare = event.data?.type === 'PURAMA_OFFLINE_PREPARE';
  if ((!prepare && event.data?.type !== 'PURAMA_OFFLINE_STATUS') || !event.ports?.[0]) return;
  event.waitUntil((async () => {
    let ready = false;
    let refreshed = false;
    try {
      const cache = await caches.open(CACHE_NAME);
      if (prepare) {
        try {
          await prepareAssets(cache);
          refreshed = true;
        } catch (_) { /* Invalid downloads never replace previously verified resources. */ }
      }
      ready = await cacheIsReady(cache);
    } catch (_) { /* Storage failure is reported as unavailable. */ }
    const status = { type: 'PURAMA_OFFLINE_STATUS', ready, version: CACHE_NAME };
    if (prepare) status.refreshed = refreshed;
    event.ports[0].postMessage(status);
  })());
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
