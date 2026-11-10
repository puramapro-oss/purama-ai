import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHmac } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OpenTimestamps = {
  DetachedTimestampFile: require('opentimestamps/src/detached-timestamp-file.js'),
  Ops: require('opentimestamps/src/ops.js'),
  Context: require('opentimestamps/src/context.js'),
  Timestamp: require('opentimestamps/src/timestamp.js'),
  Notary: require('opentimestamps/src/notary.js'),
};
const { PendingAttestation } = OpenTimestamps.Notary;
const functionsRoot = fileURLToPath(new URL('../supabase/functions/', import.meta.url));
const contractId = '00000000-0000-4000-8000-000000000001';
const serviceKey = 'test-service-never-live';
const webhookSecret = 'test-webhook-never-live';
const docusealToken = 'test-docuseal-never-live';
const docusealOrigin = 'https://docuseal.example.invalid';
const defaultPdfUrl = `${docusealOrigin}/signed.pdf`;
const foreignPdfUrl = 'https://files.example.invalid/signed.pdf';
const otsCore = fileURLToPath(new URL('../src/lib/ots-core.ts', import.meta.url));

// Run the complete, actual Edge entry points and local helper modules. Only
// external services and serve() are substituted. No provider request is sent.
async function harness(options = {}, entry = 'contracts-ots-stamp') {
  let handler;
  const calls = { clients: [], auth: [], roles: [], contractReads: [], updates: [], events: [],
    docs: [], pdf: [], stamps: [], internal: [], errors: [], signerUpdates: [], signerReads: [], sdk: [], stampRpcs: [] };
  const contract = options.contractState ?? (options.noContract ? null : {
    id: contractId, user_id: 'contract-owner', status: options.status ?? 'signed',
    docuseal_submission_id: options.noSubmission ? null : 42,
    ots_stamp_hash: 'old-hash', ots_proof: 'old-proof', ots_verified_at: '2026-10-01T00:00:00Z',
    ots_block_height: 123, ots_btc_timestamp: '2026-10-01T00:00:00Z', ...options.contract,
  });
  const environment = {
    SUPABASE_URL: 'https://db.example.invalid', SUPABASE_SERVICE_ROLE_KEY: serviceKey,
    SUPABASE_ANON_KEY: 'test-anon-never-live',
    DOCUSEAL_API_URL: docusealOrigin, DOCUSEAL_API_TOKEN: docusealToken,
    DOCUSEAL_WEBHOOK_SECRET: webhookSecret, ...options.env,
  };
  const pdfUrl = options.pdfUrl ?? defaultPdfUrl;
  const createClient = (url, key, settings) => {
    calls.clients.push({ url, key, settings });
    if (options.realSupabase) {
      return createSupabaseClient(url, key, { ...settings, global: { ...settings?.global, fetch: async (input, init = {}) => {
        const target = new URL(typeof input === 'string' ? input : input.url);
        const headers = new Headers(init.headers);
        calls.sdk.push({ path: target.pathname, headers: Object.fromEntries(headers), body: init.body });
        if (target.pathname === '/auth/v1/user') return Response.json({ id: 'server-admin' });
        if (target.pathname === '/rest/v1/rpc/has_role') {
          if (headers.get('content-profile') !== 'public') {
            return Response.json({ code: 'PGRST202', message: 'Function absent from the selected schema' }, { status: 404 });
          }
          assert.deepEqual(JSON.parse(init.body), { _user_id: 'server-admin', _role: 'admin' });
          return Response.json(true);
        }
        if (target.pathname === '/rest/v1/contracts') return Response.json(options.realSupabaseContract ? [contract] : []);
        if (target.pathname === '/rest/v1/rpc/persist_contract_ots_stamp') {
          if (options.rpcMissing) return Response.json({ code: 'PGRST202', message: 'private-schema-cache-detail' }, { status: 404 });
          return Response.json(contract.id);
        }
        throw new Error('Unexpected SDK transport blocked by the test');
      } } });
    }
    const rpc = async (name, args, schema) => {
      assert.equal(name, 'has_role');
      assert.equal(args._role, 'admin');
      calls.roles.push({ name, args, schema });
      if (options.roleThrows) throw new Error('provider-private-role-detail');
      return {
        data: args._user_id === 'server-admin' && !options.noRole && (options.role ?? 'admin') === 'admin',
        error: options.roleError ? { message: 'private-role-detail' } : null,
      };
    };
    return {
      auth: { getUser: async token => {
        calls.auth.push(token);
        if (options.authThrows) throw new Error('provider-private-auth-detail');
        const id = token === 'admin-token' ? 'server-admin' : token === 'member-token' ? 'ordinary-member' : null;
        return { data: { user: id ? { id, user_metadata: { role: 'admin' } } : null },
          error: options.authError ? { message: 'private-auth-detail' } : null };
      } },
      rpc: async (name, args) => {
        if (name !== 'persist_contract_ots_stamp') return rpc(name, args, settings?.db?.schema);
        calls.stampRpcs.push({ name, args, key, settings });
        const filters = [['id', args.p_contract_id], ['user_id', args.p_user_id], ['status', 'signed'],
          ['docuseal_submission_id', args.p_submission_id], ['ots_stamp_hash', args.p_previous_hash], ['ots_proof', args.p_previous_proof]];
        const patch = { ots_stamp_hash: args.p_hash, ots_proof: args.p_proof,
          ots_verified_at: null, ots_block_height: null, ots_btc_timestamp: null };
        calls.updates.push({ filters, patch });
        if (options.updateError || options.eventError) return { data: null, error: { message: 'private-transaction-detail' } };
        if (!contract || !filters.every(([field, value]) => contract[field] === value)) return { data: null, error: null };
        Object.assign(contract, patch);
        calls.events.push({ contract_id: contract.id, event_type: 'ots_stamped',
          payload: { hash: args.p_hash, proof_size: atob(args.p_proof).length },
          actor_id: key === serviceKey ? null : 'server-admin', actor_type: key === serviceKey ? 'service' : 'user' });
        return { data: contract.id, error: null };
      },
      schema: schema => {
        assert.equal(schema, 'public');
        return { rpc: (name, args) => rpc(name, args, schema) };
      },
      from: table => {
        const filters = [];
        let patch;
        const execute = async () => {
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
          if (table === 'contract_signers' && patch) {
            calls.signerUpdates.push({ filters, patch });
            return { data: options.missingSigner ? null : { id: 'fixture-signer' },
              error: options.signerWriteError ? { message: 'private-signer-write-detail' } : null };
          }
          if (table === 'contract_signers') {
            calls.signerReads.push(filters);
            return { data: Object.hasOwn(options, 'signers') ? options.signers : [{ signed: true }],
              error: options.signerReadError ? { message: 'private-signer-read-detail' } : null };
          }
          throw new Error(`Unexpected table: ${table}`);
        };
        const builder = {
          select() { return builder; },
          eq(key, value) { filters.push([key, value]); return builder; },
          is(key, value) { filters.push([key, value]); return builder; },
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
    Request, Response, Headers, URL, Uint8Array, ArrayBuffer, Array, AbortController, TextEncoder, TextDecoder, performance, setTimeout, clearTimeout,
    crypto: webcrypto, atob, btoa,
    console: { error: (...args) => calls.errors.push(args), warn() {}, log() {} },
    Deno: { env: { get: key => environment[key] }, serve: value => { handler = value; } },
    fetch: async (input, init) => {
      const url = String(input);
      if (url === `${docusealOrigin}/api/submissions/42/documents` || url === `${docusealOrigin}/api/submissions/42/documents?merge=true`) {
        calls.docs.push({ url, init });
        return Response.json(options.noPdf ? {} : { combined_document_url: pdfUrl });
      }
      if (url === `${docusealOrigin}/api/submissions/42`) {
        calls.docs.push({ url, init });
        if (options.cancelDuringSubmission) contract.status = 'cancelled';
        if (options.replaceSubmissionDuringSubmission) contract.docuseal_submission_id = 99;
        return Response.json(options.submissionMetadata ?? { combined_document_url: pdfUrl });
      }
      if (url === 'https://db.example.invalid/functions/v1/contracts-ots-stamp') {
        calls.internal.push({ url, init });
        if (options.internalHandler) return options.internalHandler(new Request(url, init));
        return Response.json({ ok: true });
      }
      const target = new URL(url);
      if (['https://a.pool.opentimestamps.org', 'https://b.pool.opentimestamps.org',
        'https://a.pool.eternitywall.com', 'https://ots.btc.catallaxy.com'].includes(target.origin)
        && target.pathname === '/digest') {
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        if (options.allCalendarsFail) throw new Error('calendar unavailable');
        const timestamp = new OpenTimestamps.Timestamp(Array.from(init.body));
        timestamp.attestations.push(new PendingAttestation('https://alice.btc.calendar.opentimestamps.org'));
        const output = new OpenTimestamps.Context.StreamSerialization();
        timestamp.serialize(output);
        return new Response(new Uint8Array(output.getOutput()));
      }
      if (url !== pdfUrl) throw new Error(`Unexpected network destination: ${url}`);
      calls.pdf.push({ url, init });
      if (options.pdfThrows) throw new Error('provider-private-pdf-detail');
      if (options.cancelDuringFetch) contract.status = 'cancelled';
      if (options.replaceSubmissionDuringFetch) contract.docuseal_submission_id = 99;
      return new Response(new TextEncoder().encode("%PDF-1.7 synthetic signed document"), { status: options.pdfStatus ?? 200 });
    },
  });
  const external = {
    'npm:@supabase/supabase-js@2.91.0': { createClient },
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
    if (specifier.startsWith('npm:opentimestamps@0.4.9/src/')) {
      const value = require(specifier.replace('npm:opentimestamps@0.4.9/', 'opentimestamps/'));
      return new vm.SyntheticModule(['default'], function () { this.setExport('default', value); }, { context });
    }
    if (external[specifier]) {
      const exports = external[specifier];
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
      }, { context });
    }
    const file = resolve(dirname(parent.identifier), specifier);
    assert.ok(specifier.startsWith('.') && (file.startsWith(functionsRoot) || file === otsCore), `Unexpected import: ${specifier}`);
    return localModule(file);
  });
  await module.evaluate();
  const library = cache.get(resolve(functionsRoot, '_shared/ots-library.ts'))?.namespace.ots;
  if (library) {
    const stampDigest = library.stampDigest;
    // Observe one logical stamp while executing the real bounded transport and
    // upstream proof primitives. Calendar HTTP alone is synthetic above.
    library.stampDigest = async hash => {
      const index = calls.stamps.push(OpenTimestamps.DetachedTimestampFile.fromHash(
        new OpenTimestamps.Ops.OpSHA256(), Array.from(hash))) - 1;
      if (options.stampThrows) throw new Error('provider-private-stamp-detail');
      const proof = await stampDigest(hash);
      calls.stamps[index] = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(proof, 'base64')]);
      return proof;
    };
  }
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
test('authorization SDK: the real Supabase transport selects public.has_role and keeps contract data in purama_ai', async () => {
  const h = await harness({ realSupabase: true });
  const response = await h.handler(request('admin-token'));
  const role = h.calls.sdk.find(call => call.path === '/rest/v1/rpc/has_role');
  assert.ok(role);
  assert.equal(role.headers['content-profile'], 'public');
  const contract = h.calls.sdk.find(call => call.path === '/rest/v1/contracts');
  assert.ok(contract, 'a verified admin reaches the contract lookup after the public role check');
  assert.equal(contract.headers['accept-profile'], 'purama_ai');
  assert.equal(contract.headers.authorization, 'Bearer admin-token', 'contract reads preserve the verified user RLS identity');
  assert.equal(response.status, 404, 'the inert contract transport deliberately returns no contract');
  assert.equal(h.calls.sdk.length, 3);
  assert.equal(h.calls.docs.length + h.calls.pdf.length + h.calls.stamps.length + h.calls.events.length, 0);
});
test('persistence SDK: one atomic RPC keeps the human JWT and purama_ai schema with every snapshot condition', async () => {
  const h = await harness({ realSupabase: true, realSupabaseContract: true });
  const response = await h.handler(request('admin-token', { contract_id: contractId, actor_id: 'forged' }));
  assert.equal(response.status, 200);
  const mutations = h.calls.sdk.filter(call => call.path === '/rest/v1/rpc/persist_contract_ots_stamp');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].headers['content-profile'], 'purama_ai');
  assert.equal(mutations[0].headers.authorization, 'Bearer admin-token');
  const payload = JSON.parse(mutations[0].body);
  assert.deepEqual(Object.keys(payload).sort(), ['p_contract_id', 'p_hash', 'p_previous_hash', 'p_previous_proof', 'p_proof', 'p_submission_id', 'p_user_id']);
  assert.equal(payload.p_contract_id, contractId); assert.equal(payload.p_user_id, 'contract-owner');
  assert.equal(payload.p_submission_id, 42); assert.equal(payload.p_previous_hash, 'old-hash'); assert.equal(payload.p_previous_proof, 'old-proof');
  assert.match(payload.p_hash, /^[a-f0-9]{64}$/);
  assert.ok(payload.p_proof.length > 0);
  assert.equal(h.calls.sdk.filter(call => call.path === '/rest/v1/contracts').length, 3, 'three authorized snapshots remain');
  assert.equal(h.calls.sdk.filter(call => call.path === '/auth/v1/user').length, 3, 'three identity checks remain');
  assert.equal(h.calls.sdk.some(call => call.path === '/rest/v1/contract_events'), false, 'no separate audit request');
  assert.ok(h.calls.clients.every(client => client.key !== serviceKey), 'human stamp creates no privileged client');
});
test('persistence SDK: missing migration fails closed without a split-write fallback', async () => {
  const h = await harness({ realSupabase: true, realSupabaseContract: true, rpcMissing: true });
  const response = await h.handler(request());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-/);
  assert.equal(h.calls.sdk.filter(call => call.path === '/rest/v1/rpc/persist_contract_ots_stamp').length, 1);
  assert.equal(h.calls.sdk.some(call => call.path === '/rest/v1/contract_events'), false);
  assert.equal(h.calls.updates.length + h.calls.events.length, 0);
});
test('ordinary user cannot elevate via metadata, body identity or role', async () => {
  const h = await harness();
  const response = await h.handler(request('member-token', { contract_id: contractId, user_id: 'server-admin', role: 'admin' }));
  assert.equal(response.status, 403);
  assert.deepEqual(h.calls.auth, ['member-token']);
  assert.equal(h.calls.roles[0].args._user_id, 'ordinary-member');
  noStampEffects(h.calls);
});
for (const [label, options, status] of [
  ['invalidated user', { authError: true }, 401],
  ['removed role', { noRole: true }, 403],
  ['different role', { role: 'member' }, 403],
  ['role lookup failure', { roleError: true }, 503],
  ['auth provider failure', { authThrows: true }, 503],
  ['role provider failure', { roleThrows: true }, 503],
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
    else {
      assert.equal(h.calls.auth.length, 3, 'identity is rechecked after PDF retrieval and before persistence');
      assert.equal(h.calls.roles.length, 3);
      assert.ok(h.calls.roles.every(call => call.schema === 'public'));
    }
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
  ['database read error', { loadError: true }, 503],
  ['missing submission', { noSubmission: true }, 409],
  ['missing signed PDF', { noPdf: true }, 502],
  ['provider PDF error', { pdfStatus: 503 }, 502],
  ['provider PDF exception', { pdfThrows: true }, 502],
  ['provider stamp exception', { stampThrows: true }, 502],
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
for (const pdfUrl of [`${docusealOrigin}/signed.pdf`, `${docusealOrigin}.attacker.invalid/signed.pdf`, foreignPdfUrl]) {
  test(`accepts PDF credentials only at the exact configured origin: ${pdfUrl}`, async () => {
    const h = await harness({ pdfUrl });
    const sameOrigin = new URL(pdfUrl).origin === docusealOrigin;
    assert.equal((await h.handler(request())).status, sameOrigin ? 200 : 502);
    if (sameOrigin) {
      const sent = new Headers(h.calls.pdf[0].init.headers);
      assert.equal(sent.get('X-Auth-Token'), docusealToken);
      assert.equal(h.calls.pdf[0].init.redirect, 'error');
      assert.equal(h.calls.pdf[0].init.credentials, 'omit');
    } else {
      assert.equal(h.calls.pdf.length + h.calls.stamps.length + h.calls.updates.length + h.calls.events.length, 0,
        'foreign and lookalike origins are refused before any document egress');
    }
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

function lifecycleRequest(event_type = 'form.completed') {
  return new Request('https://edge.example.invalid/webhook', {
    method: 'POST', headers: { Authorization: `Bearer ${webhookSecret}` },
    body: JSON.stringify({ event_type, data: { id: 7, submission_id: 42 } }),
  });
}

for (const entry of ['contracts-webhook', 'contracts-ots-stamp']) {
  function input(body, extra = {}) {
    return new Request(`https://edge.example.invalid/${entry}`, {
      method: 'POST', headers: { Authorization: `Bearer ${entry === 'contracts-webhook' ? webhookSecret : serviceKey}` },
      body, ...extra,
    });
  }
  const valid = JSON.stringify(entry === 'contracts-webhook'
    ? { event_type: 'submission.created', data: { id: 42 } }
    : { contract_id: contractId });
  test(`HTTP admission: ${entry} refuses excessive body bytes before contract access`, async () => {
    const h = await harness({}, entry);
    const response = await h.handler(input(valid + ' '.repeat(256 * 1024)));
    assert.equal(response.status, 413);
    noStampEffects(h.calls);
  });
  test(`HTTP admission: ${entry} refuses invalid UTF-8 instead of accepting replacement text`, async () => {
    const h = await harness({}, entry);
    const bytes = new TextEncoder().encode(valid.slice(0, -1) + ',"extra":"X"}');
    bytes[bytes.length - 3] = 0xff;
    const response = await h.handler(input(bytes));
    assert.equal(response.status, 400);
    noStampEffects(h.calls);
  });
  test(`HTTP admission: ${entry} enforces the declared body length`, async () => {
    const h = await harness({}, entry);
    const request = input(valid);
    request.headers.set('content-length', '1');
    assert.equal((await h.handler(request)).status, 400);
    noStampEffects(h.calls);
  });
  test(`HTTP admission: ${entry} refuses pre-aborted bodies`, async () => {
    const h = await harness({}, entry);
    const controller = new AbortController();
    controller.abort();
    assert.equal((await h.handler(input(valid, { signal: controller.signal }))).status, 408);
    noStampEffects(h.calls);
  });
}
test('HTTP admission: an invalid bearer without HMAC never consumes the webhook body', async () => {
  const h = await harness({}, 'contracts-webhook');
  const request = lifecycleRequest();
  request.headers.set('authorization', 'Bearer not-the-provider');
  assert.equal((await h.handler(request)).status, 401);
  assert.equal(request.bodyUsed, false);
  noStampEffects(h.calls);
});
test('HTTP admission: the real webhook deadline resolves a stalled request without late effects', { timeout: 7_000 }, async () => {
  const h = await harness({}, 'contracts-webhook');
  let producer;
  const body = new ReadableStream({ start(controller) { producer = controller; } });
  const request = new Request('https://edge.example.invalid/webhook', {
    method: 'POST', headers: { Authorization: `Bearer ${webhookSecret}` }, body, duplex: 'half',
  });
  const pending = h.handler(request);
  let timer;
  try {
    const response = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve(null), 5_500); })]);
    assert.ok(response instanceof Response, 'the handler must resolve within the configured 5s deadline');
    assert.equal(response.status, 408);
    noStampEffects(h.calls);
  } finally {
    clearTimeout(timer);
    try { producer.close(); } catch { /* Cancelled input has no remaining producer. */ }
    await pending.catch(() => {});
  }
  noStampEffects(h.calls);
});

test('webhook persistence: a failed lookup is never acknowledged as a missing contract', async () => {
  const h = await harness({ loadError: true }, 'contracts-webhook');
  const response = await h.handler(lifecycleRequest('submission.created'));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-/);
  assert.equal(h.calls.events.length + h.calls.updates.length + h.calls.internal.length, 0);
});
for (const contract of [{ id: null }, { status: null }]) {
  test(`webhook persistence: malformed stored state ${JSON.stringify(contract)} fails before any write`, async () => {
    const h = await harness({ contract }, 'contracts-webhook');
    assert.equal((await h.handler(lifecycleRequest())).status, 500);
    assert.equal(h.calls.events.length + h.calls.updates.length + h.calls.internal.length + h.calls.signerUpdates.length, 0);
  });
}
test('webhook persistence: failed signer reads cannot produce a success or a signed contract', async () => {
  const h = await harness({ status: 'sent', signerReadError: true }, 'contracts-webhook');
  const response = await h.handler(lifecycleRequest());
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /private-/);
  assert.equal(h.contract.status, 'sent');
  assert.equal(h.calls.docs.length + h.calls.events.length + h.calls.internal.length, 0);
});
for (const signers of [[], null]) {
  test(`webhook persistence: ${JSON.stringify(signers)} is not proof that all signers signed`, async () => {
    const h = await harness({ status: 'sent', signers }, 'contracts-webhook');
    assert.equal((await h.handler(lifecycleRequest())).status, 409);
    assert.equal(h.contract.status, 'sent');
    assert.equal(h.calls.docs.length + h.calls.updates.length + h.calls.events.length + h.calls.internal.length, 0);
  });
}
for (const signed of [false, 'true', 1, {}, null]) {
  test(`webhook persistence: only boolean true is a completed signature (${JSON.stringify(signed)})`, async () => {
    const h = await harness({ status: 'sent', signers: [{ signed }] }, 'contracts-webhook');
    assert.equal((await h.handler(lifecycleRequest())).status, 200);
    assert.equal(h.contract.status, 'sent');
    assert.equal(h.calls.docs.length + h.calls.updates.length + h.calls.internal.length, 0);
    assert.equal(h.calls.events.length, 1);
    assert.equal(h.calls.events[0].payload.partial, true);
  });
}
for (const event of ['form.viewed', 'form.completed', 'form.declined']) {
  for (const [label, options, expected] of [
    ['write error', { signerWriteError: true }, 500],
    ['missing signer', { missingSigner: true }, 409],
  ]) {
    test(`webhook persistence: ${event} refuses signer ${label} before later effects`, async () => {
      const h = await harness({ status: 'sent', ...options }, 'contracts-webhook');
      const response = await h.handler(lifecycleRequest(event));
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /private-/);
      assert.equal(h.calls.updates.length + h.calls.docs.length + h.calls.events.length + h.calls.internal.length, 0);
    });
  }
  test(`webhook persistence: ${event} limits signer writes to the selected contract`, async () => {
    const h = await harness({ status: 'sent' }, 'contracts-webhook');
    assert.equal((await h.handler(lifecycleRequest(event))).status, 200);
    assert.equal(h.calls.signerUpdates.length, 1);
    assert.ok(h.calls.signerUpdates[0].filters.some(([name, value]) => name === 'contract_id' && value === contractId));
  });
}
for (const event of ['form.viewed', 'form.completed', 'form.declined', 'submission.expired']) {
  test(`webhook persistence: ${event} refuses a failed contract write`, async () => {
    const h = await harness({ status: 'sent', updateError: true }, 'contracts-webhook');
    const response = await h.handler(lifecycleRequest(event));
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-/);
    assert.equal(h.calls.internal.length, 0);
  });
}
for (const event of ['form.viewed', 'form.completed', 'form.declined', 'submission.created', 'submission.expired', 'form.started']) {
  test(`webhook persistence: ${event} refuses a failed audit insert`, async () => {
    const h = await harness({ status: 'sent', eventError: true }, 'contracts-webhook');
    const response = await h.handler(lifecycleRequest(event));
    assert.equal(response.status, 500);
    assert.doesNotMatch(await response.text(), /private-/);
    assert.equal(h.calls.internal.length, 0);
  });
}
test('webhook persistence: failed partial-signature audit insert cannot be acknowledged', async () => {
  const h = await harness({ status: 'sent', signers: [{ signed: false }], eventError: true }, 'contracts-webhook');
  assert.equal((await h.handler(lifecycleRequest())).status, 500);
  assert.equal(h.calls.docs.length + h.calls.updates.length + h.calls.internal.length, 0);
});
for (const option of ['cancelDuringSubmission', 'replaceSubmissionDuringSubmission']) {
  test(`webhook persistence: ${option} prevents a late completion from overwriting the contract`, async () => {
    const h = await harness({ status: 'sent', [option]: true }, 'contracts-webhook');
    assert.equal((await h.handler(lifecycleRequest())).status, 409);
    assert.notEqual(h.contract.status, 'signed');
    assert.equal(h.calls.events.length + h.calls.internal.length, 0);
  });
}
for (const status of ['cancelled', 'declined', 'expired']) {
  test(`webhook persistence: a completed event cannot revive a ${status} contract`, async () => {
    const h = await harness({ status }, 'contracts-webhook');
    assert.equal((await h.handler(lifecycleRequest())).status, 409);
    assert.equal(h.calls.signerUpdates.length + h.calls.docs.length + h.calls.updates.length + h.calls.events.length + h.calls.internal.length, 0);
  });
}
for (const [event, states] of [
  ['form.declined', ['signed', 'cancelled', 'expired']],
  ['submission.expired', ['signed', 'cancelled', 'declined']],
]) {
  for (const status of states) {
    test(`webhook persistence: late ${event} cannot replace terminal state ${status}`, async () => {
      const h = await harness({ status }, 'contracts-webhook');
      assert.equal((await h.handler(lifecycleRequest(event))).status, 409);
      assert.equal(h.contract.status, status);
      assert.equal(h.calls.signerUpdates.length + h.calls.docs.length + h.calls.updates.length + h.calls.events.length + h.calls.internal.length, 0);
    });
  }
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

test('OTS delivery: the real stamper proof-write failure is retryable, never acknowledged', async () => {
  const stamp = await harness({ status: 'sent', updateError: true });
  let pendingStamp;
  const webhook = await harness({ contractState: stamp.contract,
    internalHandler: req => { pendingStamp = stamp.handler(req); return pendingStamp; },
  }, 'contracts-webhook');
  const response = await webhook.handler(lifecycleRequest());
  assert.equal(response.status, 502);
  assert.equal((await pendingStamp).status, 500);
  assert.equal(stamp.calls.updates.length, 1);
  assert.equal(stamp.contract.ots_proof, 'old-proof');
  assert.equal(stamp.calls.events.length, 0);
  assert.equal(stamp.contract.status, 'signed', 'contract writes precede delivery and are not atomic');
  assert.doesNotMatch(await response.text(), /private-|Proof update failed/);
});

test('OTS delivery: retry of an already-signed contract can persist the proof after a failure', async () => {
  const options = { status: 'sent', updateError: true };
  const stamp = await harness(options);
  const webhook = await harness({ contractState: stamp.contract,
    internalHandler: req => stamp.handler(req),
  }, 'contracts-webhook');
  assert.equal((await webhook.handler(lifecycleRequest())).status, 502);
  assert.equal(stamp.contract.status, 'signed');
  options.updateError = false;
  assert.equal((await webhook.handler(lifecycleRequest())).status, 200);
  assert.notEqual(stamp.contract.ots_proof, 'old-proof');
  assert.equal(stamp.calls.events.length, 1);
  assert.equal(webhook.calls.internal.length, 2);
  assert.equal(webhook.calls.events.length, 2, 'delivery retries can duplicate signed audit events');
});

for (const status of [401, 409, 500]) {
  test(`OTS delivery: internal HTTP ${status} becomes a generic retryable failure`, async () => {
    const h = await harness({ status: 'sent', internalHandler: () => new Response('provider-private-detail', { status }) }, 'contracts-webhook');
    const response = await h.handler(lifecycleRequest());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /provider-private-detail/);
    assert.doesNotMatch(JSON.stringify(h.calls.errors), /provider-private-detail/);
  });
}

test('OTS delivery: a rejected internal transport becomes a generic retryable failure', async () => {
  const h = await harness({ status: 'sent', internalHandler: () => Promise.reject(new Error('provider-private-detail')) }, 'contracts-webhook');
  const response = await h.handler(lifecycleRequest());
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /provider-private-detail/);
  assert.doesNotMatch(JSON.stringify(h.calls.errors), /provider-private-detail/);
});

test('OTS delivery: a transport ignoring abort settles within the real delivery deadline', { timeout: 18_000 }, async () => {
  const h = await harness({ status: 'sent', internalHandler: () => new Promise(() => {}) }, 'contracts-webhook');
  const started = performance.now();
  const response = await h.handler(lifecycleRequest());
  assert.equal(response.status, 504);
  assert.ok(performance.now() - started < 17_000);
  assert.equal(h.calls.internal[0].init.signal.aborted, true);
});

test('OTS delivery: every completed contract requests stamping even without metadata PDF URL', async () => {
  const h = await harness({ status: 'sent', submissionMetadata: {} }, 'contracts-webhook');
  assert.equal((await h.handler(lifecycleRequest())).status, 200);
  assert.equal(h.calls.internal.length, 1, 'the stamper resolves its own signed document URL');
});

for (const header of ['', 'wrong', 'sha256=wrong', 'g'.repeat(64), '0'.repeat(63), '0'.repeat(65)]) {
  test(`HMAC admission: malformed header ${JSON.stringify(header)} cannot consume a stalled body`, async () => {
    const h = await harness({}, 'contracts-webhook');
    let reads = 0;
    const stream = new ReadableStream({ pull() { reads++; } }, { highWaterMark: 0 });
    const req = new Request('https://edge.example.invalid/webhook', {
      method: 'POST', headers: { 'x-docuseal-signature': header }, body: stream, duplex: 'half',
    });
    let timer;
    try {
      const response = await Promise.race([h.handler(req), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Malformed signature consumed request body')), 250);
      })]);
      assert.equal(response.status, 401); assert.equal(reads, 0); assert.equal(req.bodyUsed, false);
      assert.equal(h.calls.clients.length, 0); noStampEffects(h.calls);
    } finally { clearTimeout(timer); await req.body?.cancel(); }
  });
}
