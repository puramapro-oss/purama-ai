import assert from 'node:assert/strict';
import test from 'node:test';
import { customTriggerHarness, deferred, OWNER, OTHER_OWNER, AGENT, OTHER_AGENT, INTENT, TOKEN, ADMIN } from './helpers/custom-trigger-harness.mjs';

const nextIntent = '83000000-0000-4000-8000-000000000002';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const clean = (result, state) => {
  const text = JSON.stringify({ result, logs: state.logs });
  for (const privateValue of ['PRIVATE_', TOKEN, ADMIN]) assert.equal(text.includes(privateValue), false);
};

// Real handler -> real KARTA API -> real queue producer/identity; external ports
// are inert. SQL claim/worker/provider execution is deliberately not asserted.
test('lost acknowledgement retries the same canonical delivery; a new intention gets another delivery', async () => {
  let lose = true;
  const h = customTriggerHarness({ transport: async (url, init, api) => {
    const response = await api(url, init);
    if (lose) { lose = false; throw new Error('PRIVATE_LOST_ACK'); }
    return response;
  } });
  const lost = await h.handler(h.request());
  assert.equal(lost.status, 502);
  clean(await lost.json(), h.state);
  assert.equal(h.state.jobs.size, 1, 'Admission occurred before the acknowledgement was lost');
  const repeated = await h.handler(h.request());
  const receipt = await repeated.json();
  assert.equal(repeated.status, 202);
  assert.equal(receipt.requestId, INTENT);
  assert.equal(receipt.executionKey, `queue:v2:${receipt.jobId}`);
  assert.equal(h.state.jobs.size, 1);
  assert.deepEqual(h.state.internal.map(call => call.headers['Idempotency-Key']), [INTENT, INTENT]);
  const fresh = await h.handler(h.request({ agentId: AGENT, requestId: nextIntent }));
  assert.equal(fresh.status, 202);
  assert.notEqual((await fresh.json()).jobId, receipt.jobId);
  assert.equal(h.state.jobs.size, 2);
});

test('simultaneous deliveries of the same intention retain one canonical queue entry', async () => {
  const h = customTriggerHarness();
  const replies = await Promise.all(Array.from({ length: 6 }, () => h.handler(h.request())));
  assert.ok(replies.every(reply => reply.status === 202));
  const receipts = await Promise.all(replies.map(reply => reply.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.executionKey)).size, 1);
  assert.equal(h.state.jobs.size, 1);
});

test('the same key is independently scoped by account and agent by the real API/queue', async () => {
  const a = customTriggerHarness();
  const b = customTriggerHarness({ identity: OTHER_OWNER,
    rows: new Map([[AGENT, { id: AGENT, user_id: OTHER_OWNER, karta_enabled: true }]]) });
  const results = await Promise.all([
    a.handler(a.request()), a.handler(a.request({ agentId: OTHER_AGENT, requestId: INTENT })), b.handler(b.request()),
  ]);
  const receipts = await Promise.all(results.map(response => response.json()));
  assert.equal(new Set(receipts.map(receipt => receipt.executionKey)).size, 3);
});

test('only POST can admit work; preflight advertises the bounded interface', async () => {
  const h = customTriggerHarness();
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    assert.equal((await h.handler(h.request(undefined, { method }))).status, 405);
  }
  const preflight = await h.handler(h.request(undefined, { method: 'OPTIONS' }));
  assert.equal(preflight.status, 200);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'POST, OPTIONS');
  assert.equal(h.state.auth.length, 0);
  assert.equal(h.state.internal.length, 0);
});

for (const body of [null, [], {}, { agentId: AGENT }, { agentId: AGENT, requestId: '----' },
  { agentId: '-'.repeat(36), requestId: INTENT }, { agentId: AGENT, requestId: INTENT, userId: OTHER_OWNER }, '{invalid']) {
  test(`invalid or unkeyed intention is rejected before forwarding: ${JSON.stringify(body)}`, async () => {
    const h = customTriggerHarness();
    assert.equal((await h.handler(h.request(body))).status, 400);
    assert.equal(h.state.internal.length, 0);
  });
}

for (const [label, options, status] of [
  ['foreign owner', { rows: new Map([[AGENT, { id: AGENT, user_id: OTHER_OWNER, karta_enabled: true }]]) }, 403],
  ['disabled agent', { rows: new Map([[AGENT, { id: AGENT, user_id: OWNER, karta_enabled: false }]]) }, 400],
  ['missing agent', { rows: new Map() }, 404],
  ['database failure', { query: async () => ({ data: null, error: { message: 'PRIVATE_DATABASE' } }) }, 503],
  ['invalid auth', { auth: async () => ({ data: { user: null }, error: { message: 'PRIVATE_AUTH' } }) }, 401],
  ['rate limit', { rateLimit: () => ({ allowed: false }) }, 429],
]) {
  test(`authorization/admission stays closed for ${label}`, async () => {
    const h = customTriggerHarness(options);
    const response = await h.handler(h.request());
    assert.equal(response.status, status);
    clean(await response.json(), h.state);
    assert.equal(h.state.internal.length, 0);
  });
}

test('the verified token, schema, row and configured server URL bind the dispatch', async () => {
  const rateCalls = [];
  const h = customTriggerHarness({ rateLimit: (...args) => { rateCalls.push(args); return { allowed: true }; } });
  const response = await h.handler(h.request());
  assert.equal(response.status, 202);
  assert.deepEqual(h.state.auth, [TOKEN]);
  assert.equal(h.state.clients[0].db.schema, 'purama_ai');
  assert.equal(h.state.clients[0].global.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(h.state.queries[0].id, AGENT);
  assert.deepEqual(rateCalls, [[`karta-trigger-custom:${OWNER}`, 10, 3_600_000]]);
  assert.equal(h.state.internal[0].url, `https://karta.example.invalid/trigger-custom/${AGENT}/owner/${OWNER}`);
  assert.equal(h.state.internal[0].headers.Authorization, `Bearer ${ADMIN}`);
  assert.equal(h.state.internal[0].redirect, 'error');
  assert.equal(h.state.internal[0].signal.aborted, true, 'The lifetime closes after receipt delivery');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

for (const url of ['ftp://example.invalid', 'https://private-user:PRIVATE_PASSWORD@example.invalid',
  'https://example.invalid?token=PRIVATE_SECRET', 'https://example.invalid/#private', 'not a url', undefined]) {
  test(`invalid internal URL cannot dispatch: ${String(url)}`, async () => {
    const h = customTriggerHarness({ env: { KARTA_INTERNAL_URL: url } });
    const response = await h.handler(h.request());
    assert.equal(response.status, 503);
    clean(await response.json(), h.state);
    assert.equal(h.state.internal.length, 0);
  });
}

for (const status of [200, 301, 302, 307, 308, 400, 401, 403, 404, 409, 429, 500, 503]) {
  test(`internal HTTP ${status} never becomes a successful or leaking acknowledgement`, async () => {
    const h = customTriggerHarness({ transport: async () => new Response('PRIVATE_UPSTREAM_BODY', {
      status, headers: { Location: 'https://private.example.invalid/' },
    }) });
    const response = await h.handler(h.request());
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.queued, undefined);
    clean(result, h.state);
    assert.equal(h.state.internal.length, 1);
  });
}

test('a valid canonical receipt projects only known metadata', async () => {
  const h = customTriggerHarness({ transport: async (url, init, api) => {
    const receipt = await (await api(url, init)).json();
    return Response.json({ ...receipt, token: ADMIN, raw: 'PRIVATE_PROVIDER', userId: OWNER }, { status: 202 });
  } });
  const response = await h.handler(h.request());
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['executionKey', 'jobId', 'ok', 'queued', 'requestId']);
  clean(result, h.state);
});

for (const receipt of [{ ok: true }, { ok: false, queued: true }, { ok: true, queued: false },
  { ok: true, queued: true, jobId: 'legacy-job', executionKey: 'queue:old' },
  { ok: true, queued: true, jobId: `karta-v2-dedupe-${'a'.repeat(64)}`, executionKey: 'wrong' }]) {
  test(`incomplete or conflicting receipt cannot confirm admission: ${JSON.stringify(receipt)}`, async () => {
    const h = customTriggerHarness({ transport: async () => Response.json(receipt, { status: 202 }) });
    assert.equal((await h.handler(h.request())).status, 502);
  });
}

test('streamed and declared excessive input is refused before any internal call', async () => {
  for (const headers of [{}, { 'Content-Length': '4097' }]) {
    const h = customTriggerHarness();
    const response = await h.handler(h.request('x'.repeat(4097), { headers }));
    assert.equal(response.status, 413);
    assert.equal(h.state.internal.length, 0);
  }
});

test('decoded response bytes are bounded even with a small encoded Content-Length', async () => {
  const h = customTriggerHarness({ transport: async () => new Response(' '.repeat(16_385), {
    status: 202, headers: { 'Content-Length': '1', 'Content-Encoding': 'gzip' },
  }) });
  assert.equal((await h.handler(h.request())).status, 502);
});

for (const phase of ['auth', 'ownership', 'input', 'fetch', 'response']) {
  test(`the total deadline bounds a stalled ${phase}, even when cancellation is ignored`, async () => {
    const pending = deferred();
    let cancelled = 0;
    const stream = () => new ReadableStream({ pull: () => pending.promise, cancel: () => { cancelled++; return new Promise(() => {}); } });
    const options = { fakeClock: true };
    if (phase === 'auth') options.auth = () => pending.promise;
    if (phase === 'ownership') options.query = () => pending.promise;
    if (phase === 'fetch') options.transport = () => pending.promise;
    if (phase === 'response') options.transport = async () => new Response(stream(), { status: 202 });
    const h = customTriggerHarness(options);
    const request = phase === 'input' ? h.request(stream(), { duplex: 'half' }) : h.request();
    const result = h.handler(request);
    await flush();
    h.advance(10_001);
    const response = await result;
    assert.equal(response.status, 504);
    if (['auth', 'ownership', 'input'].includes(phase)) assert.equal(h.state.internal.length, 0);
    if (phase === 'input' || phase === 'response') assert.equal(cancelled, 1);
    assert.equal(h.state.timers.size, 0);
    if (phase === 'fetch') {
      const lateBody = new ReadableStream({ cancel() { cancelled++; } });
      pending.resolve(new Response(lateBody, { status: 202 }));
      await flush();
      assert.equal(cancelled, 1, 'A response arriving after timeout is discarded');
    }
    clean(await response.json(), h.state);
  });
}

for (const phase of ['before', 'auth', 'ownership', 'fetch', 'response']) {
  test(`cancellation at ${phase} never authorizes a new dispatch`, async () => {
    const waiting = deferred();
    const controller = new AbortController();
    const options = {};
    if (phase === 'auth') options.auth = () => waiting.promise;
    if (phase === 'ownership') options.query = () => waiting.promise;
    if (phase === 'fetch') options.transport = () => waiting.promise;
    if (phase === 'response') options.transport = async () => new Response(new ReadableStream({ pull: () => waiting.promise }), { status: 202 });
    if (phase === 'before') controller.abort();
    const h = customTriggerHarness(options);
    const pending = h.handler(h.request(undefined, { signal: controller.signal }));
    await flush();
    controller.abort();
    assert.equal((await pending).status, 499);
    if (['before', 'auth', 'ownership'].includes(phase)) assert.equal(h.state.internal.length, 0);
  });
}
