// Actual React 19 scheduling, hook, account ledger and synchronization code.
// SQLCipher/native model/Supabase/HTTP are explicit deterministic boundaries.
// These tests do not qualify encryption, model quality or a deployed service.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const React = require('react');
const Renderer = require('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const { act } = React;
const project = path.resolve(__dirname, '..');
const OWNER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const RESOURCE = '20000000-0000-4000-8000-000000000001';
const TIME = Date.parse('2026-11-23T16:00:00.000Z');
const LEASE = 7 * 24 * 60 * 60 * 1000;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const clone = value => JSON.parse(JSON.stringify(value));
const tick = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };
const session = owner => ({ data: { session: { user: { id: owner }, access_token: `fixture-token-${owner}` } }, error: null });
const verified = owner => ({ data: { user: { id: owner } }, error: null });
const record = owner => ({ ownerId: owner, resourceId: RESOURCE, localVersion: 1, serverRevision: 0,
  tombstone: false, syncState: 'pending', updatedAt: new Date(TIME).toISOString(),
  payload: { title: `Fixture ${owner}`, messages: [], draft: `Private draft ${owner}` } });

function environment(t, { owner = OWNER, autoSync = false, platform = 'android' } = {}) {
  const env = {
    now: TIME, focused: true, latest: null, renders: [], modules: new Set(), stores: [], conversations: [],
    rpc: [], sessions: [], users: [], stopRefresh: 0, releases: [], inspect: 0, stateListeners: new Set(),
    timers: new Map(), nextTimer: 0, durable: new Map(), sessionOwner: owner ?? OWNER,
    sessionReplies: [], userReplies: [], openGate: null, closeGate: null, closeFailure: false,
    releaseGate: null, storageWriteGate: null, storageRemoveGate: null, storageWrites: [], storageRemoves: 0,
    raw: owner ? JSON.stringify({ ownerId: owner, verifiedAt: TIME, validUntil: TIME + LEASE, autoSync }) : null,
    tree: null, operation: null,
  };
  const schedule = (kind, callback, duration = 0) => {
    const id = ++env.nextTimer;
    env.timers.set(id, { kind, callback, duration, due: env.now + duration });
    return id;
  };
  const setTimer = (callback, duration) => schedule('timeout', callback, duration);
  const setRepeating = (callback, duration) => schedule('interval', callback, duration);
  class ClockDate extends Date { static now() { return env.now; } }
  const client = { auth: {
    getSession() {
      env.sessions.push({ at: env.now });
      const response = env.sessionReplies.shift();
      return response ? response.promise : Promise.resolve(session(env.sessionOwner));
    },
    getUser(token) {
      env.users.push(token);
      const response = env.userReplies.shift();
      return response ? response.promise : Promise.resolve(verified(env.sessionOwner));
    },
    async stopAutoRefresh() { env.stopRefresh++; },
  } };
  const engine = {
    getState: () => ({ status: 'ready', progress: 1 }),
    subscribe(listener) { const item = { listener }; env.engineListeners.add(item); return () => env.engineListeners.delete(item); },
    async inspect() { env.inspect++; return engine.getState(); },
    async prepare(signal) { if (signal.aborted) throw new Error('Preparation aborted'); },
    cancel() { throw new Error('The hook must not call global cancel'); },
    async release() {
      const operation = env.operation;
      env.releases.push(operation?.ownerId ?? null);
      if (operation) operation.cancelled = true;
      if (env.releaseGate) await env.releaseGate.promise;
    },
  };
  env.engineListeners = new Set();
  const native = {
    async openSmaranaStore(ownerId) {
      const local = env.durable.get(ownerId) ?? record(ownerId);
      env.durable.set(ownerId, clone(local));
      const store = {
        ownerId, closed: false, closes: 0, outbox: [], cursorValue: '0',
        async close() { this.closes++; this.closed = true; }, invalidate() { this.closed = true; },
        async pending() { if (this.closed) throw new Error('Closed store'); return clone(this.outbox); },
        async hasPending() { return this.outbox.length > 0; },
        async acknowledge(result) { this.outbox = this.outbox.filter(row => row.mutationId !== result.mutationId); return true; },
        async cursor() { return this.cursorValue; },
        async ingestPull(page) { this.cursorValue = page.cursor; }, async conflicts() { return []; },
      };
      env.stores.push(store);
      if (env.openGate) await env.openGate.promise;
      return store;
    },
  };
  const createConversation = ({ store }) => {
    const listeners = new Set();
    let closed = false;
    let state = { record: null, conversations: [], draft: '', dirty: false, busy: false, transitioning: false,
      liveText: '', error: null, contextTruncated: false, hasMoreHistory: false };
    const publish = change => { state = { ...state, ...change }; for (const listener of listeners) listener(); };
    const controller = {
      store, closes: 0, stops: 0, flushes: 0,
      getState: () => state,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      publish,
      async open() {
        const value = clone(env.durable.get(store.ownerId));
        publish({ record: value, conversations: [{ ...value, title: value.payload.title }], draft: value.payload.draft });
      },
      async refresh() {},
      setDraft(value) { assert.equal(closed, false); publish({ draft: value, dirty: true }); },
      async flush() {
        this.flushes++;
        if (env.closeFailure) throw new Error('Fixture storage is full');
        if (state.record && state.dirty) {
          const value = { ...state.record, payload: { ...state.record.payload, draft: state.draft } };
          env.durable.set(store.ownerId, clone(value));
          publish({ record: value, dirty: false });
        }
      },
      stop() { this.stops++; if (env.operation?.ownerId === store.ownerId) env.operation.cancelled = true; publish({ busy: false }); },
      async send() { env.operation = { ownerId: store.ownerId, cancelled: false }; publish({ busy: true }); },
      async close() {
        this.closes++; this.stop();
        if (env.closeGate) await env.closeGate.promise;
        await this.flush(); closed = true; listeners.clear();
      },
      invalidate() { closed = true; publish({ record: null, conversations: [], draft: '', dirty: false }); listeners.clear(); },
      async newConversation() {}, async removeConversation() {}, async resolveConflict() {}, async loadMoreHistory() {},
    };
    env.conversations.push(controller);
    return controller;
  };
  const AppState = { currentState: 'active', addEventListener(name, callback) {
    assert.equal(name, 'change'); env.stateListeners.add(callback);
    return { remove: () => env.stateListeners.delete(callback) };
  } };
  const network = async (url, init) => {
    const body = JSON.parse(init.body);
    env.rpc.push({ url, body, token: init.headers.Authorization, signal: init.signal });
    assert.equal(init.headers.Authorization, `Bearer fixture-token-${body.p_expected_owner_id}`, 'a request must use the matching account bearer');
    const data = body.p_mutation ? { status: 'applied', ownerId: body.p_expected_owner_id,
      mutationId: body.p_mutation.mutationId, resourceId: body.p_mutation.resourceId,
      baseRevision: body.p_mutation.baseRevision, revision: body.p_mutation.baseRevision + 1,
      cursor: '1', updatedAt: new Date(TIME).toISOString(), replayed: false }
      : { ownerId: body.p_expected_owner_id, records: [], cursor: body.p_after_cursor, hasMore: false };
    return { ok: true, status: 200, json: async () => data };
  };
  const cache = new Map();
  const mocks = {
    react: React, 'react-native': { AppState, Platform: { OS: platform } },
    '@react-navigation/native': { useIsFocused: () => env.focused },
    '@/lib/supabase': { supabase: client }, '@/lib/smarana-native': native,
    '@/lib/iao-local-engine': { getIaoLocalEngine: () => engine },
    '@/lib/iao-conversation': { createIaoConversation: createConversation },
    'expo-crypto': { randomUUID: () => crypto.randomUUID() },
  };
  function load(file) {
    let resolved = path.resolve(project, file);
    if (!fs.existsSync(resolved)) resolved += '.ts';
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const module = { exports: {} }; cache.set(resolved, module);
    const code = ts.transpileModule(fs.readFileSync(resolved, 'utf8'), {
      fileName: resolved, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const required = name => {
      env.modules.add(name);
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('@/')) return load(name.slice(2));
      if (name.startsWith('.')) return load(path.resolve(path.dirname(resolved), name));
      throw new Error(`Unexpected test dependency ${name}`);
    };
    new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date', 'fetch', 'process', code)(
      required, module, module.exports, setTimer, id => env.timers.delete(id), setRepeating, id => env.timers.delete(id),
      { now: () => env.now }, ClockDate, network,
      { env: { EXPO_PUBLIC_SUPABASE_URL: 'https://fixture.supabase.invalid', EXPO_PUBLIC_SUPABASE_ANON_KEY: 'fixture-public-key' } },
    );
    return module.exports;
  }
  const { createOfflineAccountLedger } = load('lib/offline-account-core.ts');
  const ledger = createOfflineAccountLedger({
    async read() { return env.raw; },
    async write(value) {
      env.storageWrites.push(value);
      if (env.storageWriteGate) await env.storageWriteGate.promise;
      env.raw = value;
    },
    async remove() { env.storageRemoves++; if (env.storageRemoveGate) await env.storageRemoveGate.promise; env.raw = null; },
  }, () => env.now);
  mocks['@/lib/offline-account'] = { offlineAccount: ledger };
  env.ledger = ledger;
  const { usePuramaConversation } = load('hooks/usePuramaConversation.ts');
  function Probe() {
    const value = usePuramaConversation();
    env.latest = value;
    env.renders.push({ owner: value.account?.ownerId ?? null, resourceOwner: value.view.record?.ownerId ?? null,
      draft: value.view.draft, phase: value.phase });
    return React.createElement('probe', { phase: value.phase, owner: value.account?.ownerId });
  }
  env.flush = () => act(async () => { await tick(); });
  env.mount = async (strict = false) => act(async () => {
    env.tree = Renderer.create(strict ? React.createElement(React.StrictMode, null, React.createElement(Probe)) : React.createElement(Probe));
    await tick();
  });
  env.unmount = async () => act(async () => { env.tree?.unmount(); env.tree = null; await tick(); });
  env.focus = async value => act(async () => { env.focused = value; env.tree.update(React.createElement(Probe)); await tick(); });
  env.background = async state => act(async () => {
    AppState.currentState = state;
    for (const listener of env.stateListeners) listener(state);
    await tick();
  });
  env.advance = async milliseconds => act(async () => {
    env.now += milliseconds;
    for (const [id, timer] of [...env.timers]) {
      if (!env.timers.has(id) || timer.due > env.now) continue;
      if (timer.kind === 'timeout') env.timers.delete(id); else timer.due = env.now + timer.duration;
      timer.callback();
    }
    await tick();
  });
  env.changeAccount = async userId => act(async () => {
    await ledger.selectOwner(userId);
    if (userId) { env.sessionOwner = userId; await ledger.rememberVerified(userId, ledger.verificationTicket()); }
    await tick();
  });
  t.after(async () => {
    env.closeFailure = false;
    for (const gate of [env.openGate, env.closeGate, env.releaseGate, env.storageWriteGate, env.storageRemoveGate, ...env.sessionReplies, ...env.userReplies]) gate?.resolve();
    env.openGate = env.closeGate = env.releaseGate = env.storageWriteGate = env.storageRemoveGate = null;
    await env.unmount(); await env.flush();
    env.timers.clear();
  });
  return env;
}

test('opening an offline account with synchronization disabled reads locally and never initializes Supabase', async t => {
  const env = environment(t);
  await env.mount(); await env.flush();
  assert.equal(env.latest.phase, 'ready'); assert.equal(env.latest.account.ownerId, OWNER);
  assert.equal(env.latest.view.draft, `Private draft ${OWNER}`);
  assert.equal(env.sessions.length, 0); assert.equal(env.rpc.length, 0);
  assert.equal(env.modules.has('@/lib/supabase'), false);
});

test('two reconciliations during native opening coalesce without closing the newly opened store', async t => {
  const env = environment(t);
  env.openGate = deferred();
  await env.mount(); await env.flush();
  assert.equal(env.stores.length, 1);
  let first, second;
  await act(async () => { first = env.latest.retry(); second = env.latest.retry(); await tick(); });
  env.openGate.resolve(); env.openGate = null;
  await act(async () => { await Promise.all([first, second]); await tick(); });
  assert.equal(env.latest.phase, 'ready'); assert.equal(env.stores.length, 1); assert.equal(env.stores[0].closes, 0);
});

test('A to B clears the old view immediately and a late SDK session never pairs B bearer with A data', async t => {
  const env = environment(t, { autoSync: true });
  const sessionA = deferred(); env.sessionReplies.push(sessionA);
  await env.mount(); await env.flush();
  assert.equal(env.latest.account.ownerId, OWNER); assert.equal(env.sessions.length, 1);
  const boundary = env.renders.length;
  env.storageRemoveGate = deferred();
  let changing;
  await act(async () => { changing = env.ledger.selectOwner(OTHER); await tick(); });
  assert.equal(env.latest.account, null); assert.equal(env.latest.view.record, null);
  const removal = env.storageRemoveGate; env.storageRemoveGate = null; removal.resolve();
  await changing;
  env.sessionOwner = OTHER;
  await act(async () => { await env.ledger.rememberVerified(OTHER, env.ledger.verificationTicket()); await tick(); });
  sessionA.resolve(session(OTHER)); await env.flush();
  assert.equal(env.latest.account.ownerId, OTHER);
  assert(env.renders.slice(boundary).every(render => render.resourceOwner !== OWNER));
  assert(env.rpc.length > 0); assert(env.rpc.every(request => request.body.p_expected_owner_id === OTHER));
  assert.equal(env.stores[0].closed, true);
});

test('queued UI callbacks from A cannot edit, cancel, pause or approve navigation for B', async t => {
  const env = environment(t);
  await env.mount(); await env.flush();
  const previous = env.latest;
  await env.changeAccount(OTHER); await env.flush();
  assert.equal(env.latest.account.ownerId, OTHER);
  const draft = env.latest.view.draft;
  assert.equal(env.latest.account.autoSync, true);
  env.operation = { ownerId: OTHER, cancelled: false };
  await act(async () => {
    previous.setDraft('Queued input from A');
    previous.stop();
    await previous.setAutoSync(false);
    await tick();
  });
  assert.equal(env.latest.view.draft, draft);
  assert.equal(env.operation.cancelled, false);
  assert.equal(env.latest.account.autoSync, true);
  await act(async () => {
    await assert.rejects(previous.prepareToLeave(), /interrompue/);
    await tick();
  });
  assert.equal(env.conversations.at(-1).closes, 0);
});

test('pause and background abort a pending authentication round and foreground preserves no-sync', async t => {
  const env = environment(t, { autoSync: true });
  const waiting = deferred(); env.sessionReplies.push(waiting);
  await env.mount(); await env.flush();
  await act(async () => { await env.latest.setAutoSync(false); await tick(); });
  await env.background('background'); waiting.resolve(session(OWNER)); await env.flush();
  await env.background('active'); await env.advance(30_000);
  assert.equal(env.latest.account.autoSync, false); assert.equal(env.rpc.length, 0);
  assert.equal(env.sessions.length, 1, 'the paused native route must not renew sessions in the background');
  await act(async () => { await env.latest.setAutoSync(true); await tick(); });
  assert(env.rpc.length > 0); assert.equal(env.latest.account.autoSync, true);
});

test('the exact seven-day expiry closes the visible account and refuses further local input or RPCs', async t => {
  const env = environment(t);
  await env.mount(); await env.flush();
  const old = env.conversations[0];
  await env.advance(LEASE);
  assert.equal(env.latest.account, null); assert.equal(env.latest.view.record, null); assert.equal(env.latest.phase, 'account');
  env.latest.setDraft('Must not be accepted'); await env.flush();
  assert.equal(env.rpc.length, 0); assert.notEqual(old.getState().draft, 'Must not be accepted');
  assert.equal(JSON.parse(env.raw).revoked, true);
});

test('getSession and getUser each respect the single 30-second verification deadline and ignore late success', async t => {
  for (const stage of ['session', 'user']) {
    await t.test(stage, async child => {
      const env = environment(child, { owner: null });
      const waiting = deferred();
      (stage === 'session' ? env.sessionReplies : env.userReplies).push(waiting);
      await env.mount();
      let checking;
      await act(async () => { checking = env.latest.verifyAccount(); await tick(); });
      assert.equal(env.latest.preparing, true);
      await env.advance(30_000); await checking; await env.flush();
      assert.equal(env.latest.preparing, false); assert(env.latest.error); assert.equal(env.raw, null);
      waiting.resolve(stage === 'session' ? session(OWNER) : verified(OWNER)); await env.flush();
      assert.equal(env.raw, null);
      if (stage === 'session') assert.equal(env.users.length, 0);
    });
  }
});

test('a verification from a blurred lifetime cannot grant access or finish the newer lifetime’s progress', async t => {
  const env = environment(t, { owner: null });
  const oldUser = deferred(), newUser = deferred(); env.userReplies.push(oldUser, newUser);
  await env.mount();
  let first, second;
  await act(async () => { first = env.latest.verifyAccount(); await tick(); });
  await env.focus(false); await env.focus(true);
  await act(async () => { second = env.latest.verifyAccount(); await tick(); });
  oldUser.resolve(verified(OWNER)); await first; await env.flush();
  assert.equal(env.raw, null); assert.equal(env.latest.preparing, true);
  newUser.resolve(verified(OWNER)); await act(async () => { await second; await tick(); });
  assert.equal(env.latest.phase, 'ready'); assert.equal(env.latest.account.ownerId, OWNER); assert.equal(env.latest.preparing, false);
});

test('unmount during a protected verification write removes the late grant before a remount can read it', async t => {
  const env = environment(t, { owner: null });
  env.storageWriteGate = deferred();
  await env.mount();
  let checking;
  await act(async () => { checking = env.latest.verifyAccount(); await tick(); });
  assert.equal(env.storageWrites.length, 1);
  await env.unmount();
  const release = env.storageWriteGate; env.storageWriteGate = null; release.resolve();
  await checking; await env.mount(); await env.flush();
  assert.equal(env.raw, null); assert.equal(env.latest.phase, 'account'); assert.equal(env.stores.length, 0);
});

test('failed prepareToLeave keeps the route state and store available for a successful save retry', async t => {
  const env = environment(t);
  await env.mount(); await env.flush();
  await act(async () => { env.latest.setDraft('Retryable unsaved draft'); await tick(); });
  env.closeFailure = true;
  await act(async () => { await assert.rejects(env.latest.prepareToLeave(), /storage is full/); await tick(); });
  assert.equal(env.latest.view.dirty, true); assert.equal(env.latest.view.draft, 'Retryable unsaved draft');
  assert.equal(env.stores[0].closes, 0); assert.equal(env.releases.length, 0);
  env.closeFailure = false;
  await act(async () => { await env.latest.prepareToLeave(); await tick(); });
  assert.equal(env.durable.get(OWNER).payload.draft, 'Retryable unsaved draft');
});

test('an unmounted failed save is retained and drained before the next screen opens a database', async t => {
  const env = environment(t);
  await env.mount(); await env.flush();
  await act(async () => { env.latest.setDraft('Kept across unmount'); await tick(); });
  env.closeFailure = true; await env.unmount(); await env.mount(); await env.flush();
  assert.equal(env.stores[0].closes, 0); assert.equal(env.stores.length, 1); assert.equal(env.latest.phase, 'error');
  env.closeFailure = false;
  await act(async () => { await env.latest.retry(); await tick(); });
  assert.equal(env.stores.length, 2); assert.equal(env.stores[0].closed, true);
  assert.equal(env.latest.view.draft, 'Kept across unmount');
});

test('old cleanup completes before remount and can never release the newer account’s generation', async t => {
  const env = environment(t);
  await env.mount(); await env.flush();
  env.operation = { ownerId: OWNER, cancelled: false };
  env.closeGate = deferred(); env.releaseGate = deferred();
  await env.unmount();
  await env.changeAccount(OTHER); await env.mount(); await env.flush();
  assert.equal(env.stores.length, 1, 'the new vault waits for the old durable drain');
  assert.deepEqual(env.releases, [OWNER], 'release captures the old operation at detach, not later');
  const closeGate = env.closeGate; env.closeGate = null; closeGate.resolve(); await env.flush();
  assert.equal(env.stores.length, 1, 'native release is still unsettled');
  const releaseGate = env.releaseGate; env.releaseGate = null; releaseGate.resolve(); await env.flush();
  assert.equal(env.latest.account.ownerId, OTHER);
  env.operation = { ownerId: OTHER, cancelled: false };
  await env.flush();
  assert.equal(env.operation.cancelled, false); assert.deepEqual(env.releases, [OWNER]);
});

test('StrictMode setup-cleanup-setup exposes only the current lifetime without losing its data', async t => {
  const env = environment(t);
  await env.mount(true); await env.flush();
  assert.equal(env.latest.phase, 'ready'); assert.equal(env.latest.view.record.ownerId, OWNER);
  assert.equal(env.latest.view.draft, `Private draft ${OWNER}`);
  assert(env.stores.filter(store => !store.closed).length === 1);
  assert.equal(env.rpc.length, 0);
});
