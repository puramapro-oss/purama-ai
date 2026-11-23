const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { AuthClient } = require('@supabase/auth-js');

const sourceFile = path.resolve(__dirname, '../lib/auth-refresh.ts');
const moduleBoundary = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
vm.runInThisContext(`(function(module,exports,require){${source}\n})`, { filename: sourceFile })(
  moduleBoundary, moduleBoundary.exports, () => { throw new Error('The lifecycle manager must not import an SDK'); },
);
const { createAuthRefreshManager } = moduleBoundary.exports;

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('constructing and pausing a passive manager never requests a client or starts work', async () => {
  const manager = createAuthRefreshManager();
  await manager.pause(); await manager.pause();
});

test('a pause clears immediately and then clears the ticker created by a delayed old start', async () => {
  const manager = createAuthRefreshManager(); const entered = deferred(); const release = deferred();
  let ticker = false; let stops = 0;
  const port = { async startAutoRefresh() { entered.resolve(); await release.promise; ticker = true; },
    async stopAutoRefresh() { stops++; ticker = false; } };
  const start = manager.activate(port); await entered.promise;
  const paused = manager.pause(); assert.equal(stops, 1);
  release.resolve(); await Promise.all([start, paused]);
  assert.equal(ticker, false); assert.ok(stops >= 2);
});

test('rapid active → passive → active drains every old stop before the newest start', async () => {
  const manager = createAuthRefreshManager(); const entered = deferred(); const release = deferred();
  const calls = []; let ticker = false; let starts = 0;
  const port = { async startAutoRefresh() { calls.push('start'); if (++starts === 1) { entered.resolve(); await release.promise; } ticker = true; },
    async stopAutoRefresh() { calls.push('stop'); ticker = false; } };
  const first = manager.activate(port); await entered.promise;
  const paused = manager.pause(); const latest = manager.activate(port);
  release.resolve(); await Promise.all([first, paused, latest]);
  assert.equal(starts, 2); assert.equal(ticker, true); assert.equal(calls.at(-1), 'start');
  await manager.pause(); assert.equal(ticker, false);
});

test('an activation cancelled before its queued turn never calls the SDK', async () => {
  const manager = createAuthRefreshManager(); let calls = 0;
  const port = { async startAutoRefresh() { calls++; }, async stopAutoRefresh() { calls++; } };
  await Promise.all([manager.activate(port), manager.pause()]);
  assert.equal(calls, 0);
});

test('SDK initialization is drained before starting and a passive route invalidates the delayed start', async () => {
  const manager = createAuthRefreshManager(); const entered = deferred(); const release = deferred();
  let starts = 0;
  const port = { async initialize() { entered.resolve(); await release.promise; },
    async startAutoRefresh() { starts++; }, async stopAutoRefresh() {} };
  const active = manager.activate(port); await entered.promise;
  const paused = manager.pause(); release.resolve(); await Promise.all([active, paused]);
  assert.equal(starts, 0);
});

test('a rejected start is cleaned and does not poison later activations', async () => {
  const manager = createAuthRefreshManager(); let starts = 0; let ticker = false;
  const port = { async startAutoRefresh() { ticker = true; if (++starts === 1) throw new Error('fixture'); },
    async stopAutoRefresh() { ticker = false; } };
  await manager.activate(port); assert.equal(ticker, false);
  await manager.activate(port); assert.equal(ticker, true);
  await manager.pause(); assert.equal(ticker, false);
});

// These tests execute the installed Auth SDK, with only storage/network responses
// and a scheduling barrier controlled. They do not substitute its timer methods.
function sdk(t, options = {}) {
  let fetches = 0;
  const client = new AuthClient({ url: 'https://example.invalid/auth/v1', storageKey: `qa-${t.name}`,
    autoRefreshToken: false, persistSession: false, detectSessionInUrl: false,
    fetch: async () => { fetches++; throw new Error('Unexpected SDK network call'); }, ...options });
  t.after(async () => { await client.dispose(); });
  return { client, fetches: () => fetches };
}

test('installed SDK native=false does not restart its ticker after delayed initialization', { timeout: 5000 }, async t => {
  const entered = deferred(); const release = deferred();
  const { client, fetches } = sdk(t, { persistSession: true, storage: {
    async getItem() { entered.resolve(); await release.promise; return null; }, async setItem() {}, async removeItem() {},
  } });
  await entered.promise; await client.stopAutoRefresh(); release.resolve(); await client.initialize();
  assert.equal(client.autoRefreshTicker, null); assert.equal(client.autoRefreshTickTimeout, null);
  assert.equal(fetches(), 0);
});

test('manager drains the installed SDK internal awaited stop/start race', { timeout: 5000 }, async t => {
  const { client, fetches } = sdk(t); await client.initialize();
  const entered = deferred(); const release = deferred(); const originalStop = client._stopAutoRefresh.bind(client);
  let first = true;
  client._stopAutoRefresh = async () => { if (first) { first = false; entered.resolve(); await release.promise; } return originalStop(); };
  const manager = createAuthRefreshManager(); const active = manager.activate(client); await entered.promise;
  const paused = manager.pause(); release.resolve(); await Promise.all([active, paused]);
  assert.equal(client.autoRefreshTicker, null); assert.equal(client.autoRefreshTickTimeout, null);
  assert.equal(fetches(), 0);
});

test('installed SDK getSession refreshes expired tokens on demand even with native auto-refresh disabled', { timeout: 5000 }, async t => {
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; let requests = 0;
  let value = JSON.stringify({ access_token: 'fixture-old-token', refresh_token: 'fixture-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) - 60, expires_in: 3600, token_type: 'bearer', user: { id: owner } });
  const { client } = sdk(t, { persistSession: true, storage: {
    async getItem() { return value; }, async setItem(_key, next) { value = next; }, async removeItem() { value = null; },
  }, fetch: async url => {
    requests++; assert.match(String(url), /\/token\?grant_type=refresh_token/);
    return new Response(JSON.stringify({ access_token: 'fixture-new-token', refresh_token: 'fixture-new-refresh',
      expires_in: 3600, token_type: 'bearer', user: { id: owner } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  await client.initialize(); assert.equal(requests, 0);
  const result = await client.getSession();
  assert.equal(result.error, null); assert.equal(result.data.session.access_token, 'fixture-new-token');
  assert.equal(requests, 1); assert.equal(client.autoRefreshTicker, null); assert.equal(client.autoRefreshTickTimeout, null);
});
