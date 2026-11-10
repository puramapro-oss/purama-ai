import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://purama.example';
const CURRENT_CACHE = 'purama-static-v2';
const OFFLINE_BODY = '<!doctype html><h1>Tu es hors ligne</h1>';

function createWorker() {
  const handlers = new Map();
  const stores = new Map();
  const calls = {
    fetch: [], deleted: [], matches: [], notifications: [], opened: [], warnings: [],
    lifecycle: [], closed: 0,
  };
  let network = async (request) => {
    const path = new URL(request.url, ORIGIN).pathname;
    return new Response(path === '/offline.html' ? OFFLINE_BODY : '{"name":"Purama"}', {
      headers: { 'Content-Type': path === '/offline.html' ? 'text/html' : 'application/json' },
    });
  };
  const absolute = (request) => new URL(typeof request === 'string' ? request : request.url, ORIGIN).href;
  const fetchMock = async (request) => {
    calls.fetch.push(request);
    return network(request);
  };
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(requests) {
          // Model the observable atomic contract: do not cache a partial batch.
          const batch = await Promise.all(Array.from(requests, async (request) => {
            const response = await fetchMock(request);
            if (!response.ok) throw new TypeError('Precache request failed');
            return [absolute(request), response];
          }));
          for (const [url, response] of batch) entries.set(url, response);
          calls.lifecycle.push('precache-complete');
        },
      };
    },
    async keys() { return Array.from(stores.keys()); },
    async delete(name) {
      calls.deleted.push(name);
      calls.lifecycle.push('delete:' + name);
      return stores.delete(name);
    },
    async match(request, options = {}) {
      calls.matches.push({ url: absolute(request), cacheName: options.cacheName });
      const names = options.cacheName ? [options.cacheName] : Array.from(stores.keys());
      for (const name of names) {
        const response = stores.get(name)?.get(absolute(request));
        if (response) return response.clone();
      }
      return undefined;
    },
  };
  const clients = {
    async claim() { calls.lifecycle.push('claim'); },
    async matchAll() { return []; },
    async openWindow(url) {
      calls.opened.push(url);
      return null;
    },
  };
  const self = {
    location: { origin: ORIGIN },
    clients,
    registration: {
      async showNotification(title, options) {
        calls.notifications.push({ title, options: JSON.parse(JSON.stringify(options)) });
      },
    },
    async skipWaiting() { calls.lifecycle.push('skipWaiting'); },
    addEventListener(type, handler) {
      assert.equal(handlers.has(type), false, 'One handler per event');
      handlers.set(type, handler);
    },
  };
  runInNewContext(source, {
    self, caches, fetch: fetchMock, Request, Response, URL,
    console: { warn: (...args) => calls.warnings.push(args) },
  }, { filename: 'public/sw.js' });

  function dispatch(type, properties = {}) {
    const waits = [];
    let response = null;
    const handler = handlers.get(type);
    assert.ok(handler, 'Worker handles ' + type);
    handler({
      ...properties,
      waitUntil(promise) { waits.push(promise); },
      respondWith(promise) {
        assert.equal(response, null, 'Only one response per fetch');
        response = Promise.resolve(promise);
      },
    });
    return { lifetime: Promise.all(waits), response };
  }
  return {
    calls, caches, clients, stores, dispatch,
    setNetwork(implementation) { network = implementation; },
    seed(name, path, body) {
      if (!stores.has(name)) stores.set(name, new Map());
      stores.get(name).set(absolute(path), new Response(body));
    },
    navigation(path = '/dashboard', extra = {}) {
      return dispatch('fetch', {
        request: { url: new URL(path, ORIGIN).href, mode: 'navigate', method: 'GET', ...extra },
      }).response;
    },
    click(url, action = '', extraData = {}) {
      return dispatch('notificationclick', {
        action,
        notification: {
          data: { url, ...extraData },
          close() { calls.closed += 1; },
        },
      }).lifetime;
    },
    push(payload) {
      return dispatch('push', { data: { json: () => payload } }).lifetime;
    },
  };
}

test('install caches only public static resources without cookies, then skips waiting', async () => {
  const worker = createWorker();
  await worker.dispatch('install').lifetime;
  assert.deepEqual(worker.calls.fetch.map((request) => new URL(request.url).pathname).sort(), [
    '/manifest.json', '/offline.html',
  ]);
  for (const request of worker.calls.fetch) {
    assert.equal(request.method, 'GET');
    assert.equal(request.credentials, 'omit');
    assert.equal(request.cache, 'reload');
    assert.equal(request.redirect, 'error');
  }
  assert.deepEqual(worker.calls.lifecycle, ['precache-complete', 'skipWaiting']);
  assert.deepEqual(Array.from(worker.stores.get(CURRENT_CACHE).keys()).sort(), [
    ORIGIN + '/manifest.json', ORIGIN + '/offline.html',
  ]);
});

test('offline installation rejects without replacing or deleting a previous cache', async () => {
  const worker = createWorker();
  worker.seed('purama-v1', '/offline.html', 'previous fallback');
  worker.setNetwork(async () => { throw new TypeError('Network unavailable'); });
  await assert.rejects(worker.dispatch('install').lifetime, /Network unavailable/);
  assert.equal(worker.calls.lifecycle.includes('skipWaiting'), false);
  assert.equal(worker.calls.lifecycle.includes('claim'), false);
  assert.deepEqual(worker.calls.deleted, []);
  assert.equal(worker.stores.get('purama-v1').size, 1);
});

test('a failed required precache resource does not silently activate a partial installation', async () => {
  const worker = createWorker();
  worker.setNetwork(async (request) => new Response(
    request.url.endsWith('/offline.html') ? OFFLINE_BODY : 'Missing',
    { status: request.url.endsWith('/offline.html') ? 200 : 404 },
  ));
  await assert.rejects(worker.dispatch('install').lifetime, /Precache request failed/);
  assert.equal(worker.stores.get(CURRENT_CACHE).size, 0);
  assert.equal(worker.calls.lifecycle.includes('skipWaiting'), false);
});

test('activate removes only this worker’s old caches and the known legacy cache', async () => {
  const worker = createWorker();
  for (const name of [
    CURRENT_CACHE, 'purama-static-v1', 'purama-v1', 'other-app-v1',
    'purama-another-app-v1', 'unrelated-purama-static-v1',
  ]) worker.seed(name, '/offline.html', name);
  await worker.dispatch('activate').lifetime;
  assert.deepEqual(worker.calls.deleted.sort(), ['purama-static-v1', 'purama-v1']);
  assert.deepEqual(Array.from(worker.stores.keys()).sort(), [
    CURRENT_CACHE, 'other-app-v1', 'purama-another-app-v1', 'unrelated-purama-static-v1',
  ].sort());
  assert.equal(worker.calls.lifecycle.at(-1), 'claim');
});

test('activate waits for cleanup before claiming windows', async () => {
  const worker = createWorker();
  worker.seed('purama-v1', '/offline.html', 'legacy');
  let release;
  worker.caches.delete = () => new Promise((resolve) => { release = resolve; });
  const pending = worker.dispatch('activate').lifetime;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.calls.lifecycle.includes('claim'), false);
  release(true);
  await pending;
  assert.equal(worker.calls.lifecycle.includes('claim'), true);
});

test('successful navigation responses are never written into the static cache', async () => {
  const worker = createWorker();
  await worker.dispatch('install').lifetime;
  worker.setNetwork(async () => new Response('Private dashboard for an authenticated account'));
  const response = await worker.navigation('/dashboard/billing?session=private');
  assert.equal(await response.text(), 'Private dashboard for an authenticated account');
  assert.deepEqual(Array.from(worker.stores.get(CURRENT_CACHE).keys()).sort(), [
    ORIGIN + '/manifest.json', ORIGIN + '/offline.html',
  ]);
  assert.equal(worker.calls.matches.length, 0);
});

test('HTTP errors remain HTTP errors rather than being reported as offline success', async () => {
  const worker = createWorker();
  worker.setNetwork(async () => new Response('Server error', { status: 500 }));
  const response = await worker.navigation();
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Server error');
  assert.equal(worker.calls.matches.length, 0);
});

test('offline navigation reads only this worker’s static fallback', async () => {
  const worker = createWorker();
  worker.seed('another-app', '/offline.html', 'Other application’s private fallback');
  worker.seed(CURRENT_CACHE, '/offline.html', OFFLINE_BODY);
  worker.setNetwork(async () => { throw new TypeError('Offline'); });
  const response = await worker.navigation('/dashboard?token=not-cached');
  assert.equal(await response.text(), OFFLINE_BODY);
  assert.deepEqual(worker.calls.matches, [{ url: ORIGIN + '/offline.html', cacheName: CURRENT_CACHE }]);
});

test('missing or inaccessible offline storage produces an explicit non-cacheable 503', async (t) => {
  for (const failedStorage of [false, true]) {
    await t.test(failedStorage ? 'storage rejects' : 'own cache missing', async () => {
      const worker = createWorker();
      worker.seed('another-app', '/offline.html', 'Must not use this fallback');
      worker.setNetwork(async () => { throw new TypeError('Offline'); });
      if (failedStorage) worker.caches.match = async () => { throw new Error('Storage unavailable'); };
      const response = await worker.navigation();
      assert.equal(response.status, 503);
      assert.match(await response.text(), /Hors ligne/);
      assert.match(response.headers.get('Content-Type'), /^text\/plain/);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    });
  }
});

test('non-navigation, non-GET and other-origin requests are not intercepted', () => {
  const worker = createWorker();
  assert.equal(worker.navigation('/api/data', { mode: 'cors' }), null);
  assert.equal(worker.navigation('/dashboard', { method: 'POST' }), null);
  assert.equal(worker.navigation('https://elsewhere.example/dashboard'), null);
  assert.equal(worker.calls.fetch.length, 0);
});

test('push sanitizes destinations, strips URL state and exposes only review actions', async () => {
  const worker = createWorker();
  for (const actionType of ['approve_declaration', 'approve_draft', 'review']) {
    await worker.push({
      title: 'À vérifier',
      action_type: actionType,
      action_url: '/dashboard/compta-agent/declarations?approve=true&token=secret#session',
      action_payload: { token: 'private', approve: true },
    });
  }
  for (const { options } of worker.calls.notifications) {
    assert.equal(options.data.url, '/dashboard/compta-agent/declarations');
    assert.equal(Object.hasOwn(options.data, 'action_payload'), false);
    assert.equal(options.actions.length, 1);
    assert.equal(options.actions[0].action, 'review');
  }
  assert.equal(worker.calls.fetch.length, 0);
});

test('null, array and invalid JSON push payloads cannot crash the notification handler', async () => {
  const worker = createWorker();
  for (const payload of [null, [], 42, 'unexpected']) await worker.push(payload);
  await worker.dispatch('push', {
    data: {
      json() { throw new SyntaxError('Invalid JSON'); },
      text() { return 'Plain-text notification'; },
    },
  }).lifetime;
  assert.equal(worker.calls.notifications.length, 5);
  for (const { options } of worker.calls.notifications) {
    assert.equal(options.data.url, '/dashboard');
  }
  assert.equal(worker.calls.notifications.at(-1).options.body, 'Plain-text notification');
});

test('malicious and non-UI notification destinations fall back to the same-origin dashboard', async () => {
  const destinations = [
    'https://elsewhere.example/dashboard',
    '//elsewhere.example/dashboard',
    '//purama.example/dashboard',
    'https://purama.example@elsewhere.example/dashboard',
    'https://user:password@purama.example/dashboard',
    'http://purama.example/dashboard',
    'javascript:alert(1)',
    'data:text/html,untrusted',
    '/\\elsewhere.example/dashboard',
    '/%2Felsewhere.example',
    '/%252Felsewhere.example',
    '/dashboard/%5celsewhere',
    '/dashboard/%00',
    '/dashboard\n/billing',
    ' /dashboard',
    '/api/agent/approve',
    '/dashboard/../../api/agent/approve',
    '/oauth/callback?code=unexpected',
    '/go/untrusted',
    '/logout',
    undefined,
    {},
  ];
  for (const destination of destinations) {
    const worker = createWorker();
    await worker.click(destination, 'approve', { action_payload: { approve: true } });
    assert.deepEqual(worker.calls.opened, [ORIGIN + '/dashboard']);
    assert.equal(worker.calls.fetch.length, 0);
    assert.equal(worker.calls.closed, 1);
  }
});

test('supported review destinations retain the route but never query credentials or fragments', async () => {
  for (const path of [
    '/dashboard', '/dashboard/compta-agent/declarations', '/notifications',
    '/influenceur/dashboard', '/admin/contracts', '/agent/email-agent',
  ]) {
    const worker = createWorker();
    await worker.click(ORIGIN + path + '?token=private&next=https://elsewhere.example#session');
    assert.deepEqual(worker.calls.opened, [ORIGIN + path]);
  }
});

test('other-origin and malformed windows are never navigated or focused', async () => {
  const worker = createWorker();
  worker.clients.matchAll = async () => ['https://elsewhere.example/dashboard', 'not a URL'].map((url) => ({
    url,
    async navigate() { assert.fail('Must not navigate this window'); },
    async focus() { assert.fail('Must not focus this window'); },
  }));
  await worker.click('/notifications');
  assert.deepEqual(worker.calls.opened, [ORIGIN + '/notifications']);
});

test('an existing same-origin window already on the destination is focused without navigating', async () => {
  const worker = createWorker();
  let focused = 0;
  const client = {
    url: ORIGIN + '/notifications',
    async navigate() { assert.fail('Do not reload the current destination'); },
    async focus() { focused += 1; return client; },
  };
  worker.clients.matchAll = async () => [client];
  await worker.click('/notifications');
  assert.equal(focused, 1);
  assert.deepEqual(worker.calls.opened, []);
});

test('navigation is awaited and the returned same-origin client is focused', async () => {
  const worker = createWorker();
  let release;
  let focused = false;
  const navigated = {
    url: ORIGIN + '/notifications',
    async focus() { focused = true; return navigated; },
  };
  worker.clients.matchAll = async () => [{
    url: ORIGIN + '/dashboard',
    async focus() { assert.fail('Must focus the client returned by navigate'); },
    navigate(url) {
      assert.equal(url, ORIGIN + '/notifications');
      return new Promise((resolve) => { release = resolve; });
    },
  }];
  const pending = worker.click('/notifications');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(focused, false);
  release(navigated);
  await pending;
  assert.equal(focused, true);
  assert.deepEqual(worker.calls.opened, []);
});

test('a rejected navigation or focus falls back to opening only the validated route', async (t) => {
  for (const failure of ['navigate', 'focus']) {
    await t.test(failure, async () => {
      const worker = createWorker();
      const client = {
        url: ORIGIN + '/dashboard',
        async navigate(url) {
          if (failure === 'navigate') throw new Error('Window closed');
          return { ...client, url };
        },
        async focus() { throw new Error('Focus denied'); },
      };
      worker.clients.matchAll = async () => [client];
      await worker.click('/notifications?next=https://elsewhere.example');
      assert.deepEqual(worker.calls.opened, [ORIGIN + '/notifications']);
    });
  }
});

test('a failed window does not prevent focusing another usable same-origin window', async () => {
  const worker = createWorker();
  let focused = false;
  const usable = {
    url: ORIGIN + '/notifications',
    async focus() { focused = true; return usable; },
  };
  worker.clients.matchAll = async () => [{
    url: ORIGIN + '/dashboard',
    async focus() { assert.fail('Navigation failed'); },
    async navigate() { throw new Error('Window disappeared'); },
  }, usable];
  await worker.click('/notifications');
  assert.equal(focused, true);
  assert.deepEqual(worker.calls.opened, []);
});

test('null or other-origin navigation results are never focused', async () => {
  for (const result of [null, {
    url: 'https://elsewhere.example',
    async focus() { assert.fail('Must not focus a redirected external window'); },
  }]) {
    const worker = createWorker();
    worker.clients.matchAll = async () => [{
      url: ORIGIN + '/dashboard',
      async focus() { assert.fail('Must not focus the original window'); },
      async navigate() { return result; },
    }];
    await worker.click('/notifications');
    assert.deepEqual(worker.calls.opened, [ORIGIN + '/notifications']);
  }
});

test('window enumeration or opening failure settles safely without executing notification actions', async () => {
  const worker = createWorker();
  worker.clients.matchAll = async () => { throw new Error('Enumeration unavailable'); };
  worker.clients.openWindow = async (url) => {
    worker.calls.opened.push(url);
    throw new Error('Browser denied opening');
  };
  await assert.doesNotReject(worker.click('/dashboard', 'approve', {
    action_type: 'approve_declaration',
    action_payload: { declaration_id: 'private', approved: true },
  }));
  assert.deepEqual(worker.calls.opened, [ORIGIN + '/dashboard']);
  assert.equal(worker.calls.fetch.length, 0);
  assert.equal(worker.calls.warnings.length, 1);
});
