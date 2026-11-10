import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHmac } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import OpenTimestamps from 'opentimestamps';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PendingAttestation } = require('opentimestamps/src/notary.js');
const { RemoteCalendar } = require('opentimestamps/src/calendar.js');
const functionsRoot = fileURLToPath(new URL('../supabase/functions/', import.meta.url));
const contractId = '00000000-0000-4000-8000-000000000001';
const serviceKey = 'test-service-never-live';
const webhookSecret = 'test-webhook-never-live';
const docusealToken = 'test-docuseal-never-live';
const docusealOrigin = 'https://docuseal.example.invalid';
const defaultPdfUrl = 'https://files.example.invalid/signed.pdf';

for (const authorization of [null, 'Bearer wrong', `Bearer ${webhookSecret}x`, `Bearer ${webhookSecret.slice(0, -1)}x`]) {
  test(`unauthorized webhook never reads body: ${authorization}`, async () => {
    const h = await harness({}, 'contracts-webhook');
    let reads = 0;
    let controller;
    const body = new ReadableStream({
      start(value) { controller = value; },
      pull() { reads++; },
    }, { highWaterMark: 0 });
    const headers = new Headers();
    if (authorization !== null) headers.set('Authorization', authorization);
    const req = new Request('https://edge.example.invalid/webhook', {
      method: 'POST', headers, body, duplex: 'half',
    });
    let timer;
    try {
      const response = await Promise.race([h.handler(req), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Invalid bearer waited for request body')), 250);
      })]);
      assert.equal(response.status, 401);
      assert.equal(reads, 0);
      assert.equal(req.bodyUsed, false);
      assert.equal(h.calls.clients.length, 0);
      noStampEffects(h.calls);
    } finally {
      clearTimeout(timer);
      controller.close();
    }
  });
}

// Run the complete, actual Edge entry points and local helper modules. Only
// external services and serve() are substituted. No provider request is sent.
async function harness(options = {}, entry = 'contracts-ots-stamp') {
  let handler;
  const calls = { clients: [], auth: [], roles: [], contractReads: [], updates: [], events: [],
    docs: [], pdf: [], digests: [], stamps: [], internal: [], errors: [] };
  const contract = options.contractState ?? (options.noContract ? null : {
    id: contractId, user_id: 'contract-owner', status: options.status ?? 'signed',
    docuseal_submission_id: options.noSubmission ? null : 42,
    ots_stamp_hash: 'old-hash', ots_proof: 'old-proof', ots_verified_at: '2026-10-01T00:00:00Z',
    ots_block_height: 123, ots_btc_timestamp: '2026-10-01T00:00:00Z', ...options.contract,
  });
  const environment = {
    SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    DOCUSEAL_API_URL: docusealOrigin, DOCUSEAL_API_TOKEN: docusealToken,
    DOCUSEAL_WEBHOOK_SECRET: webhookSecret, ...options.env,
  };
  const pdfUrl = options.pdfUrl ?? defaultPdfUrl;
  const createClient = (url, key, settings) => {
    calls.clients.push({ url, key, settings });
    return {
      auth: { getUser: async token => {
        calls.auth.push(token);
        if (options.authThrows) throw new Error('provider-private-auth-detail');
        const id = token === 'admin-token' ? 'server-admin' : token === 'member-token' ? 'ordinary-member' : null;
        return { data: { user: id ? { id, user_metadata: { role: 'admin' } } : null },
          error: options.authError ? { message: 'private-auth-detail' } : null };
      } },
      rpc: async (name, args) => {
        assert.equal(name, 'has_role');
        assert.equal(args._role, 'admin');
        calls.roles.push([['user_id', args._user_id], ['role', args._role]]);
        return {
          data: args._user_id === 'server-admin' && !options.noRole && (options.role ?? 'admin') === 'admin',
          error: options.roleError ? { message: 'private-role-detail' } : null,
        };
      },
      schema(name) {
        assert.equal(name, 'public', 'administrator authority must use public.has_role');
        return { rpc: (rpcName, args) => this.rpc(rpcName, args) };
      },
      from: table => {
        const filters = [];
        let patch;
        const execute = async () => {
          if (table === 'user_roles') {
            calls.roles.push(filters);
            return { data: filters.some(([key, value]) => key === 'user_id' && value === 'server-admin') && !options.noRole
              ? { role: options.role ?? 'admin' } : null, error: options.roleError ? { message: 'private-role-detail' } : null };
          }
          if (table === 'contracts' && patch) {
            calls.updates.push({ filters, patch });
            if (options.updateError) return { data: null, error: { message: 'private-update-detail' } };
            const matches = contract && filters.every(([key, value]) => contract[key] === value);
            if (!matches) return { data: null, error: null };
            Object.assign(contract, patch);
            return { data: { id: contract.id }, error: null };
          }
          if (table === 'contracts') {
            calls.contractReads.push(filters);
            return { data: contract ? { ...contract } : null, error: options.loadError ? { message: 'private-load-detail' } : null };
          }
          if (table === 'contract_signers') {
            const signer = { id: 'fixture-signer', contract_id: contractId, docuseal_submitter_id: 7 };
            return { data: patch ? filters.every(([key, value]) => signer[key] === value) ? { id: signer.id } : null : [{ signed: true }], error: null };
          }
          throw new Error(`Unexpected table: ${table}`);
        };
        const builder = {
          select() { return builder; },
          eq(key, value) { filters.push([key, value]); return builder; },
          update(value) { patch = value; return builder; },
          insert(value) {
            assert.equal(table, 'contract_events');
            calls.events.push(value);
            return Promise.resolve({ error: options.eventError ? { message: 'private-event-detail' } : null });
          },
          maybeSingle: execute,
          then(resolvePromise, rejectPromise) { return execute().then(resolvePromise, rejectPromise); },
        };
        return builder;
      },
    };
  };
  const trackedSubtle = new Proxy(webcrypto.subtle, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (key === 'digest') calls.digests.push({ algorithm: args[0], bytes: args[1].byteLength });
        return Reflect.apply(value, target, args);
      };
    },
  });
  const context = vm.createContext({
    Request, Response, Headers, URL, Uint8Array, TextEncoder, TextDecoder,
    crypto: new Proxy(webcrypto, { get: (target, key) => key === 'subtle' ? trackedSubtle : Reflect.get(target, key, target) }),
    atob, btoa, setTimeout: options.setTimeout ?? setTimeout, clearTimeout,
    performance: options.performance ?? performance, AbortController,
    console: { error: (...args) => calls.errors.push(args), warn() {}, log() {} },
    Deno: { env: { get: key => environment[key] } },
    fetch: async (input, init) => {
      const url = String(input);
      if (url === `${docusealOrigin}/api/submissions/42/documents`) {
        calls.docs.push({ url, init });
        if (options.documentsFetch) return options.documentsFetch(init);
        return Response.json(options.noPdf ? {} : { combined_document_url: pdfUrl });
      }
      if (url === `${docusealOrigin}/api/submissions/42`) {
        calls.docs.push({ url, init });
        return Response.json({ combined_document_url: pdfUrl });
      }
      if (url === 'https://db.example.invalid/functions/v1/contracts-ots-stamp') {
        calls.internal.push({ url, init });
        if (options.internalHandler) return options.internalHandler(new Request(url, init));
        return Response.json({ ok: true });
      }
      if (url !== pdfUrl) throw new Error(`Unexpected network destination: ${url}`);
      calls.pdf.push({ url, init });
      if (options.pdfThrows) throw new Error('provider-private-pdf-detail');
      if (options.cancelDuringFetch) contract.status = 'cancelled';
      if (options.replaceSubmissionDuringFetch) contract.docuseal_submission_id = 99;
      if (options.pdfFetch) return options.pdfFetch(init);
      return new Response(new Uint8Array([37, 80, 68, 70]), { status: options.pdfStatus ?? 200 });
    },
  });
  const external = {
    'https://deno.land/std@0.190.0/http/server.ts': { serve: value => { handler = value; } },
    'npm:@supabase/supabase-js@2.91.0': { createClient },
    'npm:opentimestamps@0.4.9': { default: {
      ...OpenTimestamps,
      stamp: async detached => {
        calls.stamps.push(detached);
        if (options.stampThrows) throw new Error('provider-private-stamp-detail');
        if (options.allCalendarsFail) {
          // Exercise the actual library's soft-failure behavior without network.
          const original = RemoteCalendar.prototype.submit;
          RemoteCalendar.prototype.submit = async () => { throw new Error('calendar unavailable'); };
          try { await OpenTimestamps.stamp(detached); } finally { RemoteCalendar.prototype.submit = original; }
          return;
        }
        detached.timestamp.attestations.push(new PendingAttestation('https://alice.btc.calendar.opentimestamps.org'));
      },
    } },
  };
  const cache = new Map();
  function localModule(file) {
    if (cache.has(file)) return cache.get(file);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const module = new vm.SourceTextModule(code, { context, identifier: file });
    cache.set(file, module);
    return module;
  }
  const module = localModule(resolve(functionsRoot, entry, 'index.ts'));
  await module.link((specifier, parent) => {
    if (external[specifier]) {
      const exports = external[specifier];
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    const file = resolve(dirname(parent.identifier), specifier);
    assert.ok(specifier.startsWith('.') && file.startsWith(functionsRoot), `Unexpected import: ${specifier}`);
    return localModule(file);
  });
  await module.evaluate();
  return { handler, calls, contract };
}

function request(token = 'admin-token', body = { contract_id: contractId }, method = 'POST') {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  return new Request('https://edge.example.invalid/stamp', {
    method, headers, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}
function noStampEffects(calls) {
  for (const name of ['contractReads', 'docs', 'pdf', 'stamps', 'updates', 'events', 'internal']) {
    assert.equal(calls[name].length, 0, `Unexpected ${name}`);
  }
}

for (const token of [null, '', 'invalid-token', `${serviceKey}x`, 'fake.jwt.service_role']) {
  test(`rejects unauthenticated credential ${JSON.stringify(token)} before any contract effects`, async () => {
    const h = await harness();
    assert.equal((await h.handler(request(token))).status, 401);
    noStampEffects(h.calls);
  });
}
test('ordinary user cannot elevate via metadata, body identity or role', async () => {
  const h = await harness();
  const response = await h.handler(request('member-token', { contract_id: contractId, user_id: 'server-admin', role: 'admin' }));
  assert.equal(response.status, 403);
  assert.deepEqual(h.calls.auth, ['member-token']);
  assert.ok(h.calls.roles[0].some(([key, value]) => key === 'user_id' && value === 'ordinary-member'));
  noStampEffects(h.calls);
});
for (const [label, options, status] of [
  ['invalidated user', { authError: true }, 401],
  ['removed role', { noRole: true }, 403],
  ['different role', { role: 'member' }, 403],
  ['role lookup failure', { roleError: true }, 503],
  ['auth provider failure', { authThrows: true }, 503],
  ['missing service configuration', { env: { SUPABASE_SERVICE_ROLE_KEY: '' } }, 503],
  ['missing service URL', { env: { SUPABASE_URL: '' } }, 503],
]) {
  test(`fails closed on ${label}`, async () => {
    const h = await harness(options);
    const response = await h.handler(request());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private-/);
    noStampEffects(h.calls);
  });
}
for (const token of ['admin-token', serviceKey]) {
  test(`allows ${token === serviceKey ? 'exact internal credential' : 'verified current admin'} and clears stale Bitcoin confirmation`, async () => {
    const h = await harness();
    const response = await h.handler(request(token, { contract_id: contractId, actor_id: 'forged' }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(result.pending_bitcoin_confirmation, true);
    assert.equal(h.calls.stamps.length, 1);
    const proof = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(h.contract.ots_proof, 'base64')]);
    assert.equal(Buffer.from(proof.fileDigest()).toString('hex'), result.hash);
    assert.equal(h.contract.ots_verified_at, null);
    assert.equal(h.contract.ots_block_height, null);
    assert.equal(h.contract.ots_btc_timestamp, null);
    assert.equal(h.calls.events.length, 1);
    assert.equal(h.calls.events[0].actor_id, token === serviceKey ? null : 'server-admin');
    assert.equal(h.calls.events[0].actor_type, token === serviceKey ? 'service' : 'user');
    if (token === serviceKey) assert.equal(h.calls.auth.length + h.calls.roles.length, 0);
  });
}
test('handles preflight without data access and refuses unsupported methods', async () => {
  const h = await harness();
  assert.equal((await h.handler(request(null, undefined, 'OPTIONS'))).status, 200);
  assert.equal((await h.handler(request(null, undefined, 'GET'))).status, 405);
  assert.equal(h.calls.clients.length, 0);
});
for (const body of [null, [], {}, { contract_id: 42 }, { contract_id: 'not-a-uuid' }, '{']) {
  test(`rejects malformed input ${JSON.stringify(body)} before contract access`, async () => {
    const h = await harness();
    assert.equal((await h.handler(request('admin-token', body))).status, 400);
    noStampEffects(h.calls);
  });
}
for (const status of ['draft', 'sent', 'opened', 'declined', 'cancelled', 'expired']) {
  test(`refuses stamping a ${status} contract before provider access`, async () => {
    const h = await harness({ status });
    assert.equal((await h.handler(request())).status, 409);
    assert.equal(h.calls.docs.length + h.calls.pdf.length + h.calls.stamps.length + h.calls.updates.length, 0);
  });
}
for (const [label, options, status] of [
  ['missing contract', { noContract: true }, 404],
  ['database read error', { loadError: true }, 500],
  ['missing submission', { noSubmission: true }, 400],
  ['missing signed PDF', { noPdf: true }, 404],
  ['provider PDF error', { pdfStatus: 503 }, 502],
  ['provider PDF exception', { pdfThrows: true }, 500],
  ['provider stamp exception', { stampThrows: true }, 500],
  ['proof write error', { updateError: true }, 500],
  ['audit write error', { eventError: true }, 500],
]) {
  test(`does not report success after ${label}`, async () => {
    const h = await harness(options);
    const response = await h.handler(request());
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /private-/);
  });
}
for (const option of ['cancelDuringFetch', 'replaceSubmissionDuringFetch']) {
  test(`does not overwrite a contract changed during PDF retrieval: ${option}`, async () => {
    const h = await harness({ [option]: true });
    assert.equal((await h.handler(request())).status, 409);
    assert.equal(h.contract.ots_proof, 'old-proof');
    assert.equal(h.calls.events.length, 0);
  });
}
test('does not persist or report a pending proof when every calendar failed', async () => {
  const h = await harness({ allCalendarsFail: true });
  const response = await h.handler(request());
  assert.equal(response.status, 502);
  assert.equal(h.calls.stamps.length, 1);
  assert.equal(h.calls.stamps[0].timestamp.allAttestations().size, 0);
  assert.equal(h.calls.updates.length + h.calls.events.length, 0);
  assert.equal(h.contract.ots_proof, 'old-proof');
});
for (const pdfUrl of [`${docusealOrigin}/signed.pdf`, `${docusealOrigin}.attacker.invalid/signed.pdf`, defaultPdfUrl]) {
  test(`forwards PDF credentials only to the exact configured origin: ${pdfUrl}`, async () => {
    const h = await harness({ pdfUrl });
    assert.equal((await h.handler(request())).status, 200);
    const sent = new Headers(h.calls.pdf[0].init.headers);
    assert.equal(sent.get('X-Auth-Token'), new URL(pdfUrl).origin === docusealOrigin ? docusealToken : null);
    assert.equal(h.calls.pdf[0].init.redirect, 'error');
  });
}
for (const pdfUrl of ['http://files.example.invalid/signed.pdf', 'https://user@files.example.invalid/signed.pdf', 'data:application/pdf;base64,AA==']) {
  test(`rejects unsafe PDF location before fetching: ${pdfUrl}`, async () => {
    const h = await harness({ pdfUrl });
    assert.equal((await h.handler(request())).status, 502);
    assert.equal(h.calls.pdf.length + h.calls.stamps.length, 0);
  });
}

function webhookRequest(headers = {}) {
  const body = JSON.stringify({ event_type: 'submission.created', data: { id: 42 } });
  return new Request('https://edge.example.invalid/webhook', { method: 'POST', headers, body });
}
for (const environment of [undefined, 'production', 'staging', 'development', 'local', 'test']) {
  test(`reused webhook guard fails closed without a secret in ${String(environment)}`, async () => {
    const h = await harness({ env: { DOCUSEAL_WEBHOOK_SECRET: '', DENO_ENV: environment } }, 'contracts-webhook');
    assert.equal((await h.handler(webhookRequest())).status, 503);
    noStampEffects(h.calls);
    assert.equal(h.calls.clients.length, 0);
  });
}
test('reused webhook guard rejects an invalid provider credential before privileged reads', async () => {
  const h = await harness({}, 'contracts-webhook');
  assert.equal((await h.handler(webhookRequest({ Authorization: 'Bearer invalid' }))).status, 401);
  noStampEffects(h.calls);
});
for (const transport of ['bearer', 'hmac']) {
  test(`reconciled webhook contract accepts authenticated ${transport} delivery`, async () => {
    const h = await harness({}, 'contracts-webhook');
    const body = JSON.stringify({ event_type: 'submission.created', data: { id: 42 } });
    const headers = transport === 'bearer' ? { Authorization: `Bearer ${webhookSecret}` }
      : { 'x-docuseal-signature': `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}` };
    assert.equal((await h.handler(webhookRequest(headers))).status, 200);
    assert.equal(h.calls.events.length, 1);
    assert.equal(h.calls.internal.length, 0);
  });
}
test('authenticated completion delivers the internal credential to the actual stamp handler', async () => {
  const stamp = await harness({ status: 'sent' });
  let pendingStamp;
  const webhook = await harness({
    contractState: stamp.contract,
    internalHandler: req => { pendingStamp = stamp.handler(req); return pendingStamp; },
  }, 'contracts-webhook');
  const response = await webhook.handler(new Request('https://edge.example.invalid/webhook', {
    method: 'POST', headers: { Authorization: `Bearer ${webhookSecret}` },
    body: JSON.stringify({ event_type: 'form.completed', data: { id: 7, submission_id: 42 } }),
  }));
  assert.equal(response.status, 200);
  assert.equal(webhook.calls.internal.length, 1);
  assert.equal((await pendingStamp).status, 200);
  assert.equal(stamp.contract.status, 'signed');
  assert.equal(stamp.calls.stamps.length, 1);
  assert.equal(stamp.calls.events[0].actor_type, 'service');
  assert.equal(stamp.calls.auth.length + stamp.calls.roles.length, 0);
});

for (const failure of ['pdfThrows', 'stampThrows']) {
  test(`provider-private details are absent from response and logs: ${failure}`, async () => {
    const h = await harness({ [failure]: true });
    const response = await h.handler(request());
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-/);
    assert.doesNotMatch(h.calls.errors.map(args => args.map(String).join(' ')).join(' '), /private-/);
  });
}

// Download policy is internal: these are byte counts, never character counts or
// caller-controlled HTTP options. A synthetic clock avoids real 10 s waits.
const pdfByteLimit = 16 * 1024 * 1024;
const metadataByteLimit = 256 * 1024;
function downloadClock() {
  const clock = { value: 0 };
  clock.performance = { now: () => clock.value };
  clock.setTimeout = (callback, delay) => setTimeout(() => {
    clock.value += delay;
    callback();
  }, 1);
  return clock;
}
async function boundedResult(operation) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF download exceeded synthetic test guard')), 300);
    })]);
  } finally { clearTimeout(timer); }
}
function noPdfEffects(h) {
  assert.equal(h.calls.digests.length, 0, 'an incomplete PDF must not be hashed');
  assert.equal(h.calls.stamps.length, 0, 'an incomplete PDF must not be stamped');
  assert.equal(h.calls.updates.length + h.calls.events.length, 0);
  assert.equal(h.contract.ots_proof, 'old-proof');
}
function pdfStream(chunks, { headers = {}, cancel = () => {}, beforeRead = () => {} } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      beforeRead(index);
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 }), { headers });
}

test('PDF bounds: preserves raw binary bytes instead of decoding UTF-8', async () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 254, 128, 0, 13, 10]);
  const h = await harness({ pdfFetch: () => pdfStream([bytes.subarray(0, 5), bytes.subarray(5)]) });
  const response = await h.handler(request(serviceKey));
  assert.equal(response.status, 200);
  const expected = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
  assert.equal((await response.json()).hash, expected);
});

test('PDF bounds: fragmented bytes snapshot a reused provider buffer across growth', async () => {
  const expectedBytes = Uint8Array.from({ length: 65_537 }, (_, index) => index % 256);
  const reused = new Uint8Array(1); let offset = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (offset === expectedBytes.length) { controller.close(); return; }
      reused[0] = expectedBytes[offset++];
      controller.enqueue(reused);
    },
  }, { highWaterMark: 0 }));
  const h = await harness({ pdfFetch: () => response });
  const result = await h.handler(request(serviceKey));
  assert.equal(result.status, 200); assert.equal(response.body.locked, false);
  assert.equal((await result.json()).hash, Buffer.from(await webcrypto.subtle.digest('SHA-256', expectedBytes)).toString('hex'));
});

test('PDF bounds: accepts exactly 16 MiB without changing the binary hash', async () => {
  const bytes = new Uint8Array(pdfByteLimit); bytes[0] = 255; bytes[bytes.length - 1] = 128;
  const h = await harness({ pdfFetch: () => pdfStream([bytes], { headers: { 'content-length': String(bytes.length) } }) });
  const response = await h.handler(request(serviceKey));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).hash, Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex'));
});

for (const declared of [false, true]) {
  test(`PDF bounds: rejects PDF bytes above 16 MiB with declared=${declared}`, async () => {
    let cancelled = 0; let reads = 0;
    const response = pdfStream([new Uint8Array(declared ? 1 : pdfByteLimit + 1)], {
      headers: declared ? { 'content-length': String(pdfByteLimit + 1) } : {},
      beforeRead: () => { reads++; }, cancel: () => { cancelled++; },
    });
    const h = await harness({ pdfFetch: () => response });
    assert.equal((await h.handler(request(serviceKey))).status, 502);
    noPdfEffects(h);
    assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
    if (declared) assert.equal(reads, 0, 'oversized declared body must not be read');
  });
}

for (const declared of ['1', '5']) {
  test(`PDF bounds: rejects an incomplete or inconsistent PDF length ${declared}`, async () => {
    const h = await harness({ pdfFetch: () => pdfStream([new Uint8Array([37, 80, 68])], { headers: { 'content-length': declared } }) });
    assert.equal((await h.handler(request(serviceKey))).status, 502);
    noPdfEffects(h);
  });
}

for (const declared of [false, true]) {
  test(`PDF bounds: rejects metadata above 256 KiB with declared=${declared}`, async () => {
    const data = JSON.stringify({ combined_document_url: defaultPdfUrl, padding: declared ? '' : 'x'.repeat(metadataByteLimit) });
    let cancelled = 0;
    const metadata = pdfStream([new TextEncoder().encode(data)], {
      headers: declared ? { 'content-length': String(metadataByteLimit + 1) } : {},
      cancel: () => { cancelled++; },
    });
    const h = await harness({ documentsFetch: () => metadata });
    assert.equal((await h.handler(request(serviceKey))).status, 502);
    assert.equal(h.calls.pdf.length, 0); noPdfEffects(h);
    assert.equal(cancelled, 1); assert.equal(metadata.body.locked, false);
  });
}

for (const phase of ['metadata headers', 'PDF headers', 'metadata body', 'PDF body']) {
  test(`PDF bounds: one deadline stops stalled ${phase}`, async () => {
    const clock = downloadClock(); let cancelled = 0; let signal; let response;
    const stall = init => {
      signal = init.signal;
      if (phase.endsWith('headers')) return new Promise(() => {});
      response = new Response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }));
      return response;
    };
    const h = await harness({ performance: clock.performance, setTimeout: clock.setTimeout,
      ...(phase.startsWith('metadata') ? { documentsFetch: stall } : { pdfFetch: stall }),
    });
    assert.equal((await boundedResult(h.handler(request(serviceKey)))).status, 504);
    assert.equal(signal.aborted, true); noPdfEffects(h);
    if (response) { assert.equal(cancelled, 1); assert.equal(response.body.locked, false); }
  });
}

for (const phase of ['metadata headers', 'metadata body', 'PDF headers', 'PDF body', 'PDF end']) {
  test(`PDF bounds: monotonic expiry rejects immediate ${phase} before a delayed timer`, async () => {
    const clock = { value: 0, now() { return this.value; } }; let response; let reads = 0;
    const metadata = JSON.stringify({ combined_document_url: defaultPdfUrl });
    const expire = () => { clock.value = 10_001; };
    const h = await harness({ performance: clock,
      documentsFetch: () => {
        if (phase === 'metadata headers') expire();
        return pdfStream([new TextEncoder().encode(metadata)], { beforeRead: () => { if (phase === 'metadata body') expire(); } });
      },
      pdfFetch: () => {
        if (phase === 'PDF headers') expire();
        response = pdfStream([new Uint8Array([37, 80, 68, 70])], { beforeRead: index => {
          reads++;
          if (phase === 'PDF body' || (phase === 'PDF end' && index === 1)) expire();
        } });
        return response;
      },
    });
    assert.equal((await boundedResult(h.handler(request(serviceKey)))).status, 504);
    noPdfEffects(h);
    if (phase.startsWith('metadata')) assert.equal(h.calls.pdf.length, 0);
    if (phase === 'PDF headers') assert.equal(reads, 0);
    if (response) assert.equal(response.body.locked, false);
  });
}

test('PDF bounds: metadata and PDF consume one budget without resetting it', async () => {
  const clock = { value: 0, now() { return this.value; } };
  const h = await harness({ performance: clock,
    documentsFetch: () => {
      clock.value = 4_000;
      return pdfStream([new TextEncoder().encode(JSON.stringify({ combined_document_url: defaultPdfUrl }))], {
        beforeRead: () => { clock.value = 7_000; },
      });
    },
    pdfFetch: () => {
      clock.value = 8_000;
      return pdfStream([new Uint8Array([37, 80, 68, 70])], { beforeRead: () => { clock.value = 10_001; } });
    },
  });
  assert.equal((await h.handler(request(serviceKey))).status, 504);
  noPdfEffects(h);
});

for (const phase of ['metadata', 'PDF headers', 'PDF body']) {
  test(`PDF bounds: caller cancellation during ${phase} prevents hashing and stamping`, async () => {
    const abort = new AbortController(); let response; let cancelled = 0;
    const h = await harness({
      documentsFetch: () => {
        if (phase === 'metadata') abort.abort();
        return Response.json({ combined_document_url: defaultPdfUrl });
      },
      pdfFetch: () => {
        if (phase === 'PDF headers') abort.abort();
        response = pdfStream([new Uint8Array([37, 80, 68, 70])], {
          beforeRead: () => { if (phase === 'PDF body') abort.abort(); }, cancel: () => { cancelled++; },
        });
        return response;
      },
    });
    assert.equal((await boundedResult(h.handler(new Request(request(serviceKey), { signal: abort.signal })))).status, 503);
    noPdfEffects(h);
    if (phase === 'metadata') assert.equal(h.calls.pdf.length, 0);
    if (response) { assert.equal(cancelled, 1); assert.equal(response.body.locked, false); }
  });
}

for (const cancellation of ['pending', 'rejected']) {
  test(`PDF bounds: ${cancellation} stream cancellation cannot delay a timeout`, async () => {
    const clock = downloadClock(); let cancelled = 0;
    const response = new Response(new ReadableStream({ cancel() {
      cancelled++;
      return cancellation === 'pending' ? new Promise(() => {}) : Promise.reject(new Error('private-cancel-detail'));
    } }, { highWaterMark: 0 }));
    const h = await harness({ performance: clock.performance, setTimeout: clock.setTimeout, pdfFetch: () => response });
    const result = await boundedResult(h.handler(request(serviceKey)));
    assert.equal(result.status, 504); noPdfEffects(h);
    assert.equal(cancelled, 1); assert.equal(response.body.locked, false);
    assert.doesNotMatch(await result.text(), /private-/);
  });
}

test('PDF bounds: a response arriving after timeout is cancelled without late effects', async () => {
  const clock = downloadClock(); let resolveLate; let cancelled = 0;
  const h = await harness({ performance: clock.performance, setTimeout: clock.setTimeout,
    pdfFetch: () => new Promise(resolve => { resolveLate = resolve; }),
  });
  assert.equal((await boundedResult(h.handler(request(serviceKey)))).status, 504);
  const response = new Response(new ReadableStream({ cancel() { cancelled++; } }, { highWaterMark: 0 }));
  resolveLate(response);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1); assert.equal(response.body.locked, false); noPdfEffects(h);
});

for (const phase of ['metadata', 'PDF']) {
  test(`PDF bounds: decoded ${phase} is not rejected by an oversized encoded length`, async () => {
    const decoded = phase === 'metadata'
      ? new TextEncoder().encode(JSON.stringify({ combined_document_url: defaultPdfUrl }))
      : new Uint8Array([37, 80, 68, 70, 255]);
    const response = pdfStream([decoded], { headers: { 'content-encoding': 'gzip', 'content-length': String(pdfByteLimit + 1) } });
    const h = await harness(phase === 'metadata' ? { documentsFetch: () => response } : { pdfFetch: () => response });
    assert.equal((await h.handler(request(serviceKey))).status, 200);
    assert.equal(h.calls.stamps.length, 1); assert.equal(response.body.locked, false);
  });
  test(`PDF bounds: decoded ${phase} is not compared to its encoded Content-Length`, async () => {
    const decoded = phase === 'metadata'
      ? new TextEncoder().encode(JSON.stringify({ combined_document_url: defaultPdfUrl }))
      : new Uint8Array([37, 80, 68, 70, 255, 0, 128]);
    const response = pdfStream([decoded], { headers: { 'content-encoding': 'gzip', 'content-length': '3' } });
    const h = await harness(phase === 'metadata' ? { documentsFetch: () => response } : { pdfFetch: () => response });
    assert.equal((await h.handler(request(serviceKey))).status, 200);
    assert.equal(h.calls.stamps.length, 1); assert.equal(response.body.locked, false);
  });
  test(`PDF bounds: decoded ${phase} still obeys its byte cap`, async () => {
    const decoded = phase === 'metadata'
      ? new TextEncoder().encode(JSON.stringify({ combined_document_url: defaultPdfUrl, padding: 'x'.repeat(metadataByteLimit) }))
      : new Uint8Array(pdfByteLimit + 1);
    const response = pdfStream([decoded], { headers: { 'content-encoding': 'br', 'content-length': '3' } });
    const h = await harness(phase === 'metadata' ? { documentsFetch: () => response } : { pdfFetch: () => response });
    assert.equal((await h.handler(request(serviceKey))).status, 502); noPdfEffects(h);
    assert.equal(response.body.locked, false);
  });
}
