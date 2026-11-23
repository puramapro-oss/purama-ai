const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OWNER, OTHER, RESOURCE, uuid, snapshot, tick, deferred, fixture, ack } = require('./helpers/smarana.cjs');

const credentials = { ownerId: OWNER, accessToken: 'synthetic-token', anonKey: 'synthetic-public-key', url: 'https://project.example' };
const response = data => ({ ok: true, status: 200, json: async () => data });
const empty = cursor => ({ ownerId: OWNER, records: [], cursor, hasMore: false });
async function syncFixture(t, options = {}) {
  const f = await fixture(t);
  const states = [], requests = [];
  const deps = {
    store: f.store,
    credentials: async () => credentials,
    allowed: () => true,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      return response(body.p_mutation ? ack(body.p_mutation) : empty(body.p_after_cursor));
    },
    onState: (state, message) => states.push({ state, message }),
    ...options,
  };
  const { createSmaranaSync } = f.load('lib/smarana-sync.ts');
  const sync = createSmaranaSync(deps);
  t.after(() => sync.stop());
  return { ...f, deps, sync, states, requests };
}

test('strict local policy performs no credentials, queue dispatch or network access', async t => {
  const f = await syncFixture(t, { allowed: () => false, credentials: async () => { throw new Error('Forbidden auth'); } });
  const created = await f.store.create(snapshot(), RESOURCE);
  await f.sync.run();
  assert.deepEqual(f.requests, []);
  assert.equal(f.states.at(-1).state, 'paused');
  await f.store.tombstone(RESOURCE, created.localVersion);
  assert.equal((await f.store.pending())[0].tombstone, true);
});

test('sync transmits only canonical data mutations and durably records exact receipts', async t => {
  const f = await syncFixture(t);
  await f.store.create(snapshot('À retrouver après reconnexion'), RESOURCE);
  await f.sync.run();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url, 'https://project.example/rest/v1/rpc/smarana_apply');
  assert.equal(f.requests[1].url, 'https://project.example/rest/v1/rpc/smarana_pull');
  assert.equal(f.requests[0].body.p_expected_owner_id, OWNER);
  assert.equal(f.requests[0].init.headers['Content-Profile'], 'purama_ai');
  assert.equal(f.requests[0].init.redirect, 'error');
  assert.equal(f.requests[0].body.p_mutation.payload.messages[0].content, 'À retrouver après reconnexion');
  assert.equal((await f.store.read(RESOURCE)).syncState, 'synced');
  assert.equal(f.states.at(-1).state, 'synced');
});

test('credentials for a different owner are rejected before any dispatch or request', async t => {
  const f = await syncFixture(t, { credentials: async () => ({ ...credentials, ownerId: OTHER }) });
  const created = await f.store.create(snapshot(), RESOURCE);
  await f.sync.run();
  assert.deepEqual(f.requests, []);
  await f.store.tombstone(RESOURCE, created.localVersion);
  assert.equal((await f.store.pending())[0].tombstone, true);
  assert.equal(f.states.at(-1).state, 'pending');
});

test('an acknowledgement for another operation leaves the exact sent mutation pending', async t => {
  const f = await syncFixture(t);
  await f.store.create(snapshot(), RESOURCE);
  let sent;
  f.deps.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).p_mutation;
    return response({ ...ack(sent), mutationId: uuid() });
  };
  await f.sync.run();
  assert.deepEqual(await f.store.pending(), [sent]);
  assert.equal((await f.store.read(RESOURCE)).syncState, 'pending');
  assert.match(f.states.at(-1).message, /accusé/);
});

test('stopping an in-flight request fences a late receipt and leaves it retryable', async t => {
  const f = await syncFixture(t);
  await f.store.create(snapshot(), RESOURCE);
  const started = deferred(), network = deferred();
  let sent;
  f.deps.fetch = async (_url, init) => { sent = JSON.parse(init.body).p_mutation; started.resolve(); return network.promise; };
  const running = f.sync.run();
  await started.promise;
  f.sync.stop();
  network.resolve(response(ack(sent)));
  await running;
  assert.deepEqual(await f.store.pending(), [sent]);
  assert.equal(f.states.at(-1).state, 'paused');
});

test('the final status check never claims a newly created, never-sent snapshot', async t => {
  const f = await syncFixture(t);
  f.deps.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(!body.p_mutation);
    await f.store.create(snapshot('Créé pendant la lecture distante'), RESOURCE);
    return response(empty(body.p_after_cursor));
  };
  await f.sync.run();
  const created = await f.store.read(RESOURCE);
  await f.store.tombstone(RESOURCE, created.localVersion);
  const pending = await f.store.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tombstone, true);
  assert.equal(pending[0].payload, null);
});

test('stop during the final local inspection cannot publish a stale synced state', async t => {
  const f = await syncFixture(t);
  const entered = deferred(), release = deferred();
  let pulled = false;
  const pending = f.store.pending.bind(f.store);
  const hasPending = f.store.hasPending.bind(f.store);
  f.store.pending = async limit => { if (pulled && limit === 1) { entered.resolve(); await release.promise; } return pending(limit); };
  f.store.hasPending = async () => { entered.resolve(); await release.promise; return hasPending(); };
  f.deps.fetch = async (_url, init) => { pulled = true; return response(empty(JSON.parse(init.body).p_after_cursor)); };
  const running = f.sync.run();
  await entered.promise;
  f.sync.stop();
  release.resolve();
  await running;
  assert.equal(f.states.at(-1).state, 'paused');
});

test('round timeout settles even when a fetch implementation ignores AbortSignal', async t => {
  const f = await syncFixture(t);
  const entered = deferred(), network = deferred();
  f.deps.fetch = async () => { entered.resolve(); return network.promise; };
  let settled = false;
  const running = f.sync.run().then(() => { settled = true; });
  await entered.promise;
  await f.clock.advance(30_000);
  const settledAtDeadline = settled;
  network.resolve(response(empty('0')));
  await running;
  assert.equal(settledAtDeadline, true);
  assert.equal(f.states.at(-1).state, 'pending');
});

test('stopping live authentication prevents its eventual credentials from sending data', async t => {
  const f = await syncFixture(t);
  const auth = deferred(), entered = deferred();
  f.deps.credentials = async () => { entered.resolve(); return auth.promise; };
  const running = f.sync.run();
  await entered.promise;
  f.sync.stop();
  await running;
  auth.resolve(credentials);
  await tick();
  assert.deepEqual(f.requests, []);
  assert.equal(f.states.at(-1).state, 'paused');
});

test('a round dispatches at most twenty writes and leaves remaining work pending', async t => {
  const f = await syncFixture(t);
  for (let i = 0; i < 21; i++) await f.store.create(snapshot(`Conversation ${i}`));
  await f.sync.run();
  assert.equal(f.requests.filter(request => request.body.p_mutation).length, 20);
  assert.equal(f.states.at(-1).state, 'pending');
  assert.equal(await f.store.hasPending(), true);
});
