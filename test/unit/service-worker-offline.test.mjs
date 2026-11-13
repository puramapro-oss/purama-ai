import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
const currentCache = 'purama-offline-v8';
const assets = ['/offline.html', '/offline-workspace.js', '/offline-library-backup.js', '/manifest.json'];
const assetBytes = new Map(assets.map((path) => [
  path, readFileSync(new URL('../../public' + path, import.meta.url)),
]));
const contentTypes = new Map([
  ['/offline.html', 'text/html; charset=utf-8'],
  ['/offline-workspace.js', 'application/javascript; charset=utf-8'],
  ['/offline-library-backup.js', 'application/javascript; charset=utf-8'],
  ['/manifest.json', 'application/json; charset=utf-8'],
]);

function assetResponse(path, options = {}) {
  return new Response(options.body ?? assetBytes.get(path), {
    status: options.status ?? 200,
    headers: { 'Content-Type': options.type ?? contentTypes.get(path) },
  });
}

function requestPath(request) {
  return new URL(typeof request === 'string' ? request : request.url, 'https://purama.test').pathname;
}

function networkResponse(request) {
  const path = requestPath(request);
  return assetBytes.has(path) ? assetResponse(path) : new Response('network');
}

function corruptedBytes(path) {
  const bytes = Buffer.from(assetBytes.get(path));
  bytes[Math.floor(bytes.byteLength / 2)] ^= 1;
  return bytes;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function messagePort() {
  const messages = [];
  // A real MessagePort serializes the worker's message into the receiving realm.
  const postMessage = mock.fn((message) => { messages.push(structuredClone(message)); });
  return { postMessage, messages, last: () => messages.at(-1) };
}

function worker() {
  const handlers = new Map();
  const stored = new Map();
  const put = async (path, response) => {
    // Cache.put consumes the supplied response; matches provide a fresh response.
    const body = await response.arrayBuffer();
    stored.set(path, new Response(body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    }));
  };
  const cache = {
    put: mock.fn(put),
    match: mock.fn(async (path) => stored.get(path)?.clone()),
  };
  const caches = {
    open: mock.fn(async () => cache),
    keys: mock.fn(async () => [currentCache]),
    delete: mock.fn(async () => true),
  };
  const fetch = mock.fn(async (request) => networkResponse(request));
  const self = {
    location: new URL('https://purama.test/sw.js'),
    addEventListener: (name, handler) => handlers.set(name, handler),
    skipWaiting: mock.fn(async () => undefined),
    clients: { claim: mock.fn(async () => undefined) },
  };
  runInNewContext(source, {
    self, caches, fetch, Response, URL, Promise,
    crypto: webcrypto, AbortController, setTimeout, clearTimeout,
  });
  const dispatch = (name, data = {}) => {
    const handler = handlers.get(name);
    assert.equal(typeof handler, 'function', 'Missing ' + name + ' event handler');
    let result;
    handler({
      ...data,
      waitUntil: (task) => { result = task; },
      respondWith: (task) => { result = task; },
    });
    return result;
  };
  return { self, caches, cache, fetch, stored, dispatch };
}

async function statusOf(w) {
  const port = messagePort();
  await w.dispatch('message', { data: { type: 'PURAMA_OFFLINE_STATUS' }, ports: [port] });
  assert.equal(port.postMessage.mock.callCount(), 1);
  return port.last();
}

function expectedStatus(ready) {
  return { type: 'PURAMA_OFFLINE_STATUS', ready, version: currentCache };
}

describe('offline service worker lifecycle', { timeout: 5000 }, () => {
  it('does not replace the usable worker when a required asset cannot be downloaded', async () => {
    const w = worker();
    w.fetch.mock.mockImplementationOnce(async () => { throw new Error('offline asset unavailable'); });
    await assert.rejects(w.dispatch('install'), /offline asset unavailable/);
    assert.equal(w.cache.put.mock.callCount(), 0);
    assert.equal(w.self.skipWaiting.mock.callCount(), 0);
    assert.equal(w.caches.delete.mock.callCount(), 0);
  });

  it('waits for all verified offline resources before requesting activation', async () => {
    const w = worker();
    const started = deferred();
    const completion = deferred();
    w.fetch.mock.mockImplementation(async (request) => {
      if (requestPath(request) === '/offline-workspace.js') {
        started.resolve();
        await completion.promise;
      }
      return networkResponse(request);
    });
    const install = w.dispatch('install');
    await started.promise;
    assert.deepEqual(w.fetch.mock.calls.map((call) => requestPath(call.arguments[0])), assets);
    assert.equal(w.cache.put.mock.callCount(), 0);
    assert.equal(w.self.skipWaiting.mock.callCount(), 0);
    completion.resolve();
    await install;
    assert.equal(w.cache.put.mock.callCount(), assets.length);
    assert.equal(w.self.skipWaiting.mock.callCount(), 1);
    assert.deepEqual(await statusOf(w), expectedStatus(true));
  });

  it('cleans only old Purama static and offline release caches, preserving unrelated origin data', async () => {
    const w = worker();
    w.caches.keys.mock.mockImplementationOnce(async () => [
      'purama-v1', 'purama-static-v1', 'purama-static-v2', 'purama-offline-v1', 'purama-offline-v2',
      currentCache, 'another-app', 'purama-documents', 'purama-offline-documents',
      'purama-static-documents', 'purama-offline-vnext', 'unrelated-purama-static-v1',
    ]);
    await w.dispatch('activate');
    assert.deepEqual(w.caches.delete.mock.calls.map((call) => call.arguments[0]), [
      'purama-v1', 'purama-static-v1', 'purama-static-v2', 'purama-offline-v1', 'purama-offline-v2',
    ]);
    assert.equal(w.self.clients.claim.mock.callCount(), 1);
  });

  it('serves the prepared workspace and its script without another fetch attempt', async () => {
    const w = worker();
    await w.dispatch('install');
    const preparedFetches = w.fetch.mock.callCount();
    for (const path of assets) {
      const response = await w.dispatch('fetch', {
        request: {
          method: 'GET', mode: path.endsWith('.html') ? 'navigate' : 'cors',
          url: 'https://purama.test' + path + '?launch=1',
        },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), assetBytes.get(path));
    }
    assert.equal(w.fetch.mock.callCount(), preparedFetches);
  });

  it('falls back to the current offline page when navigation loses its connection', async () => {
    const w = worker();
    await w.dispatch('install');
    w.fetch.mock.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    const response = await w.dispatch('fetch', {
      request: { method: 'GET', mode: 'navigate', url: 'https://purama.test/dashboard' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), assetBytes.get('/offline.html'));
    assert.equal(w.caches.open.mock.calls.at(-1).arguments[0], currentCache);
  });

  it('reports unavailable rather than success if the prepared fallback was evicted', async () => {
    const w = worker();
    w.fetch.mock.mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); });
    const response = await w.dispatch('fetch', {
      request: { method: 'GET', mode: 'navigate', url: 'https://purama.test/dashboard' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });

  it('does not intercept API writes or assets belonging to another origin', () => {
    const w = worker();
    assert.equal(w.dispatch('fetch', {
      request: { method: 'POST', mode: 'cors', url: 'https://purama.test/api/send' },
    }), undefined);
    assert.equal(w.dispatch('fetch', {
      request: { method: 'GET', mode: 'cors', url: 'https://other.test/offline-workspace.js' },
    }), undefined);
    assert.equal(w.fetch.mock.callCount(), 0);
  });

  it('reports readiness only when all current assets exist, including after eviction', async () => {
    const w = worker();
    assert.deepEqual(await statusOf(w), expectedStatus(false));
    assert.equal(w.fetch.mock.callCount(), 0);
    await w.dispatch('install');
    const preparedFetches = w.fetch.mock.callCount();
    assert.deepEqual(await statusOf(w), expectedStatus(true));
    for (const path of assets) {
      const previous = w.stored.get(path);
      w.stored.delete(path);
      assert.deepEqual(await statusOf(w), expectedStatus(false), `${path} must be present`);
      w.stored.set(path, previous);
    }
    assert.equal(w.fetch.mock.callCount(), preparedFetches);
  });

  it('reports storage failures through the readiness port instead of claiming success', async () => {
    const w = worker();
    w.caches.open.mock.mockImplementationOnce(async () => { throw new Error('Storage denied'); });
    assert.deepEqual(await statusOf(w), expectedStatus(false));
    assert.equal(w.fetch.mock.callCount(), 0);
  });

  it('repairs an evicted resource only on an explicit preparation message', async () => {
    const w = worker();
    await w.dispatch('install');
    w.stored.delete('/offline-workspace.js');
    assert.deepEqual(await statusOf(w), expectedStatus(false));
    assert.equal(w.fetch.mock.callCount(), assets.length);
    assert.equal(w.cache.put.mock.callCount(), assets.length);
    const port = messagePort();
    await w.dispatch('message', { data: { type: 'PURAMA_OFFLINE_PREPARE' }, ports: [port] });
    assert.equal(w.fetch.mock.callCount(), 2 * assets.length);
    assert.equal(w.cache.put.mock.callCount(), 2 * assets.length);
    assert.deepEqual(port.last(), { ...expectedStatus(true), refreshed: true });
  });

  it('does not erase the last usable cache when explicit preparation fails', async () => {
    const w = worker();
    await w.dispatch('install');
    w.fetch.mock.mockImplementationOnce(async () => { throw new Error('Network lost'); });
    const port = messagePort();
    await w.dispatch('message', { data: { type: 'PURAMA_OFFLINE_PREPARE' }, ports: [port] });
    assert.deepEqual(port.last(), { ...expectedStatus(true), refreshed: false });
    assert.equal(w.cache.put.mock.callCount(), assets.length);
    assert.equal(w.caches.delete.mock.callCount(), 0);
  });

  it('preserves an HTTP 404 navigation response instead of replacing it with an offline success', async () => {
    const w = worker();
    await w.dispatch('install');
    const preparedFetches = w.fetch.mock.callCount();
    const previousMatches = w.cache.match.mock.callCount();
    w.fetch.mock.mockImplementationOnce(async () => new Response('route missing', { status: 404 }));
    const request = { method: 'GET', mode: 'navigate', url: 'https://purama.test/missing-route' };
    const response = await w.dispatch('fetch', { request });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'route missing');
    assert.equal(w.fetch.mock.callCount(), preparedFetches + 1);
    assert.equal(w.fetch.mock.calls.at(-1).arguments[0], request);
    assert.equal(w.cache.match.mock.callCount(), previousMatches);
  });

  it('ignores unexpected messages and messages without a reply port', () => {
    const w = worker();
    const port = messagePort();
    assert.equal(w.dispatch('message', { data: { type: 'UNEXPECTED_MESSAGE' }, ports: [port] }), undefined);
    assert.equal(w.dispatch('message', { ports: [port] }), undefined);
    assert.equal(w.dispatch('message', { data: { type: 'PURAMA_OFFLINE_PREPARE' } }), undefined);
    assert.equal(port.postMessage.mock.callCount(), 0);
    assert.equal(w.caches.open.mock.callCount(), 0);
    assert.equal(w.cache.put.mock.callCount(), 0);
    assert.equal(w.fetch.mock.callCount(), 0);
  });

  it('does not report ready when a required cached response has an unsuccessful status', async () => {
    const w = worker();
    await w.dispatch('install');
    for (const status of [404, 503]) {
      w.stored.set('/offline-workspace.js', assetResponse('/offline-workspace.js', { status }));
      assert.deepEqual(await statusOf(w), expectedStatus(false));
    }
    assert.equal(w.fetch.mock.callCount(), assets.length);
    assert.equal(w.cache.put.mock.callCount(), assets.length);
  });

  it('accepts both standard JSON MIME types for the required web app manifest', async () => {
    for (const type of ['application/json', 'application/manifest+json']) {
      const w = worker();
      w.fetch.mock.mockImplementation(async (request) => requestPath(request) === '/manifest.json'
        ? assetResponse('/manifest.json', { type })
        : networkResponse(request));
      await w.dispatch('install');
      assert.equal(w.cache.put.mock.callCount(), assets.length);
      assert.equal(w.self.skipWaiting.mock.callCount(), 1);
      assert.deepEqual(await statusOf(w), expectedStatus(true));
    }
  });

  it('rejects a login or SPA HTML response with HTTP 200 in place of a required resource', async () => {
    for (const invalidPath of assets) {
      const w = worker();
      w.fetch.mock.mockImplementation(async (request) => requestPath(request) === invalidPath
        ? new Response('<!doctype html><title>Sign in</title>', { headers: { 'Content-Type': 'text/html' } })
        : networkResponse(request));
      await assert.rejects(w.dispatch('install'), /Invalid offline resource/);
      assert.equal(w.cache.put.mock.callCount(), 0);
      assert.equal(w.self.skipWaiting.mock.callCount(), 0);
      assert.deepEqual(await statusOf(w), expectedStatus(false));
    }
  });

  it('rejects altered JavaScript with the expected MIME type and byte length', async () => {
    const w = worker();
    const altered = corruptedBytes('/offline-workspace.js');
    assert.equal(altered.byteLength, assetBytes.get('/offline-workspace.js').byteLength);
    w.fetch.mock.mockImplementation(async (request) => requestPath(request) === '/offline-workspace.js'
      ? assetResponse('/offline-workspace.js', { body: altered })
      : networkResponse(request));
    await assert.rejects(w.dispatch('install'), /Invalid offline resource/);
    assert.equal(w.cache.put.mock.callCount(), 0);
    assert.equal(w.self.skipWaiting.mock.callCount(), 0);
    assert.deepEqual(await statusOf(w), expectedStatus(false));
  });

  it('rejects a truncated resource before writing any cache entry', async () => {
    for (const invalidPath of assets) {
      const w = worker();
      const shortened = assetBytes.get(invalidPath).subarray(0, -1);
      w.fetch.mock.mockImplementation(async (request) => requestPath(request) === invalidPath
        ? assetResponse(invalidPath, { body: shortened })
        : networkResponse(request));
      await assert.rejects(w.dispatch('install'), /Invalid offline resource/);
      assert.equal(w.cache.put.mock.callCount(), 0);
      assert.equal(w.self.skipWaiting.mock.callCount(), 0);
      assert.deepEqual(await statusOf(w), expectedStatus(false));
    }
  });

  it('detects altered cached bytes and refuses to serve them as a prepared offline workspace', async () => {
    const w = worker();
    await w.dispatch('install');
    w.stored.set('/offline-workspace.js', assetResponse('/offline-workspace.js', {
      body: corruptedBytes('/offline-workspace.js'),
    }));
    assert.deepEqual(await statusOf(w), expectedStatus(false));
    assert.equal(w.fetch.mock.callCount(), assets.length);
    w.fetch.mock.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const fallback = await w.dispatch('fetch', {
      request: { method: 'GET', mode: 'navigate', url: 'https://purama.test/dashboard' },
    });
    assert.equal(fallback.status, 503);
    await assert.rejects(w.dispatch('fetch', {
      request: { method: 'GET', mode: 'cors', url: 'https://purama.test/offline-workspace.js' },
    }), /Failed to fetch/);
  });

  it('preserves the verified cache when an explicit repair downloads invalid bytes', async () => {
    const w = worker();
    await w.dispatch('install');
    w.fetch.mock.mockImplementation(async (request) => requestPath(request) === '/offline-workspace.js'
      ? assetResponse('/offline-workspace.js', { body: corruptedBytes('/offline-workspace.js') })
      : networkResponse(request));
    const port = messagePort();
    await w.dispatch('message', { data: { type: 'PURAMA_OFFLINE_PREPARE' }, ports: [port] });
    assert.deepEqual(port.last(), { ...expectedStatus(true), refreshed: false });
    assert.equal(w.cache.put.mock.callCount(), assets.length);
    assert.equal(w.caches.delete.mock.callCount(), 0);
    for (const path of assets) {
      const response = await w.cache.match(path);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), assetBytes.get(path));
    }
  });

  it('does not activate or report ready when the second put fails on an unprepared cache', async () => {
    const w = worker();
    w.cache.put.mock.mockImplementationOnce(async () => { throw new Error('Cache write denied'); }, 1);
    await assert.rejects(w.dispatch('install'), /Cache write denied/);
    // Let any other put finish before checking the final durable state.
    await Promise.allSettled(w.cache.put.mock.calls.map((call) => call.result));
    assert.equal(w.cache.put.mock.callCount(), assets.length);
    assert.equal(w.stored.has('/offline.html'), true);
    assert.equal(w.stored.has('/offline-workspace.js'), false);
    assert.equal(w.self.skipWaiting.mock.callCount(), 0);
    assert.equal(w.caches.delete.mock.callCount(), 0);
    assert.deepEqual(await statusOf(w), expectedStatus(false));
  });
});
