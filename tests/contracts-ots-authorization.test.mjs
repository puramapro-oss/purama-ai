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

// Run the complete, actual Edge entry points and local helper modules. Only
// external services and serve() are substituted. No provider request is sent.
async function harness(options = {}, entry = 'contracts-ots-stamp') {
  let handler;
  const calls = { clients: [], auth: [], roles: [], contractReads: [], updates: [], events: [],
    docs: [], pdf: [], stamps: [], internal: [], errors: [] };
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
          if (table === 'contract_signers') return { data: [{ signed: true }], error: null };
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
  const context = vm.createContext({
    Request, Response, Headers, URL, Uint8Array, TextEncoder, TextDecoder,
    crypto: webcrypto, atob, btoa,
    console: { error: (...args) => calls.errors.push(args), warn() {}, log() {} },
    Deno: { env: { get: key => environment[key] } },
    fetch: async (input, init) => {
      const url = String(input);
      if (url === `${docusealOrigin}/api/submissions/42/documents`) {
        calls.docs.push({ url, init });
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
  ['auth provider failure', { authThrows: true }, 500],
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
for (const environment of [undefined, 'production', 'staging']) {
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
  test(`reused webhook guard preserves authenticated ${transport} delivery`, async () => {
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
