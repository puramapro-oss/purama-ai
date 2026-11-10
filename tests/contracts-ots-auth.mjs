import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import ts from 'typescript';

// Execute the real Edge handlers and shared DocuSeal helper. Only identity,
// database and provider transports are simulated. No real OTS stamp or HTTP
// request is made, and this suite does not qualify cryptographic verification.
const root = fileURLToPath(new URL('../', import.meta.url));
const CONTRACT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const SERVICE = 'fixture-service-credential';
const WEBHOOK = 'fixture-webhook-credential';
const PDF = new Uint8Array([37, 80, 68, 70, 45, 102, 105, 99, 116, 105, 111, 110]);

function harness(kind, options = {}) {
  let handler;
  const calls = { clients: [], auth: [], roles: [], tables: [], writes: [], fetches: [], stamps: [] };
  const env = {
    SUPABASE_URL: 'https://database.example.invalid',
    SUPABASE_ANON_KEY: 'fixture-anon-credential',
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    DOCUSEAL_API_URL: 'https://docuseal.example.invalid',
    DOCUSEAL_API_TOKEN: 'fixture-document-credential',
    DOCUSEAL_WEBHOOK_SECRET: WEBHOOK,
    ...options.env,
  };
  const contract = { id: CONTRACT, user_id: USER, status: kind === 'contracts-webhook' ? 'sent' : 'signed', app_slug: 'fixture',
    template_slug: 'fixture', docuseal_submission_id: 123, ots_stamp_hash: null,
    ots_proof: null, ots_verified_at: null, ots_block_height: null, ots_btc_timestamp: null,
    pdf_original_url: null };
  function createClient(url, credential, config) {
    calls.clients.push({ url, credentialKind: credential === SERVICE ? 'service' : 'other', schema: config?.db?.schema });
    if (!credential) throw new Error('Client credential missing');
    return {
      auth: {
        async getUser(token) {
          calls.auth.push(token);
          if (options.authThrows) throw new Error('simulated identity outage');
          return { data: { user: options.user ? { id: USER } : null },
            error: options.authError ? { message: 'invalid identity' } : null };
        },
      },
      schema(schema) {
        assert.equal(schema, 'public');
        return { rpc: async (name, args) => {
        calls.roles.push({ name, args, schema });
        if (options.roleThrows) throw new Error('simulated role outage');
        return { data: Object.hasOwn(options, 'roleValue') ? options.roleValue : false,
          error: options.roleError ? { message: 'role lookup failed' } : null };
        } };
      },
      from(table) {
        calls.tables.push(table);
        let operation = 'select';
        let value;
        const filters = [];
        let resolved;
        function execute(single = false) {
          if (resolved) return resolved;
          if (operation !== 'select') calls.writes.push({ table, operation, value, filters: [...filters] });
          let data = null;
          if (table === 'contracts') {
            // Model both eq() and is(null) filters before confirming a row.
            // Reads return a snapshot so a later write cannot mutate that snapshot.
            const matches = filters.every(([key, expected]) => contract[key] === expected);
            if (operation === 'select') data = matches ? (single ? { ...contract } : [{ ...contract }]) : (single ? null : []);
            else if (operation === 'update' && matches) {
              Object.assign(contract, value);
              data = { id: CONTRACT };
            }
          } else if (table === 'contract_signers') {
            data = operation === 'select' ? [{ signed: true }]
              : filters.some(([key, val]) => key === 'contract_id' && val === CONTRACT)
                && filters.some(([key, val]) => key === 'docuseal_submitter_id' && val === 456)
                ? { id: 'fixture-signer-456' } : null;
          }
          resolved = Promise.resolve({ data, error: null });
          return resolved;
        }
        const query = {
          select() { return query; },
          eq(key, val) { filters.push([key, val]); return query; },
          is(key, val) { filters.push([key, val]); return query; },
          maybeSingle() { return execute(true); },
          update(row) { operation = 'update'; value = row; return query; },
          insert(row) { operation = 'insert'; value = row; return query; },
          then(accept, reject) { return execute().then(accept, reject); },
        };
        return query;
      },
    };
  }
  const providerFetch = async (url, init = {}) => {
    url = String(url);
    calls.fetches.push({ url, init });
    if (url === 'https://docuseal.example.invalid/api/submissions/123/documents'
      || url === 'https://docuseal.example.invalid/api/submissions/123/documents?merge=true'
      || url === 'https://docuseal.example.invalid/api/submissions/123') {
      return Response.json({ combined_document_url: 'https://docuseal.example.invalid/signed.pdf' });
    }
    if (url === 'https://docuseal.example.invalid/signed.pdf') return new Response(PDF);
    if (url === 'https://database.example.invalid/functions/v1/contracts-ots-stamp') {
      return Response.json({ ok: true, simulated: true });
    }
    throw new Error('Unexpected transport blocked by the test');
  };
  const ots = {
    Ops: { OpSHA256: class {} },
    DetachedTimestampFile: { fromHash(_operation, bytes) {
      return { hash: new Uint8Array(bytes), serializeToBytes: () => new Uint8Array([1, 2, 3]) };
    } },
    async stamp(detached) { calls.stamps.push(detached.hash); },
    async stampDigest(hash) { calls.stamps.push(hash); return 'AQID'; },
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const source = readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText;
    const module = { exports: {} };
    cache.set(file, module.exports);
    const requireModule = (specifier) => {
      if (specifier.includes('/http/server.ts')) return { serve: (value) => { handler = value; } };
      if (specifier.startsWith('npm:@supabase/supabase-js')) return { createClient };
      if (specifier.startsWith('npm:opentimestamps')) return ots;
      if (specifier.endsWith('/ots-library.ts')) return { ots };
      if (specifier.startsWith('.')) return load(resolve(dirname(file), specifier));
      throw new Error('Unexpected import blocked by the test');
    };
    runInNewContext(compiled, { module, exports: module.exports, require: requireModule,
      Deno: { env: { get: (name) => env[name] }, serve: (value) => { handler = value; } },
      fetch: providerFetch, crypto: webcrypto, Request, Response, Headers, URL,
      TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa,
      AbortController, performance, setTimeout, clearTimeout,
      console: { error() {}, warn() {}, log() {} },
    }, { filename: file });
    return module.exports;
  }
  load(resolve(root, `supabase/functions/${kind}/index.ts`));
  assert.equal(typeof handler, 'function');
  return { calls, handler };
}

function stampRequest(token = 'fixture-user-token', extra = {}) {
  return new Request('https://functions.example.invalid/contracts-ots-stamp', {
    method: 'POST', headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json' },
    body: JSON.stringify({ contract_id: CONTRACT, ...extra }),
  });
}
function webhookRequest(token = WEBHOOK) {
  return new Request('https://functions.example.invalid/contracts-webhook', {
    method: 'POST', headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json' },
    body: JSON.stringify({ event_type: 'form.completed', data: { submission_id: 123, id: 456 } }),
  });
}
function noEffects(h) {
  assert.equal(h.calls.tables.length, 0, 'no contract or event database access');
  assert.equal(h.calls.writes.length, 0, 'no database mutation');
  assert.equal(h.calls.fetches.length, 0, 'no document, OTS or internal HTTP request');
  assert.equal(h.calls.stamps.length, 0, 'no OTS provider invocation');
}

test('stamp: missing bearer is refused before any contract access', async () => {
  const h = harness('contracts-ots-stamp');
  assert.equal((await h.handler(stampRequest(null))).status, 401);
  noEffects(h);
});
test('stamp: an arbitrary bearer cannot reach another contract through service authority', async () => {
  const h = harness('contracts-ots-stamp');
  assert.equal((await h.handler(stampRequest('arbitrary-not-authenticated'))).status, 401);
  noEffects(h);
});
test('stamp: an authenticated ordinary user is not an administrator', async () => {
  const h = harness('contracts-ots-stamp', { user: true });
  assert.equal((await h.handler(stampRequest())).status, 403);
  noEffects(h);
});
test('stamp: body-supplied roles and user IDs never grant authority', async () => {
  const h = harness('contracts-ots-stamp', { user: true });
  assert.equal((await h.handler(stampRequest('fixture-user-token', { user_id: 'other', role: 'admin', admin: true }))).status, 403);
  assert.equal(h.calls.roles.length, 1);
  assert.equal(h.calls.roles[0].name, 'has_role');
  assert.equal(h.calls.roles[0].args._user_id, USER);
  assert.equal(h.calls.roles[0].args._role, 'admin');
  noEffects(h);
});
for (const value of [null, 'true', 1, { admin: true }]) {
  test(`stamp: a non-boolean role result ${JSON.stringify(value)} cannot authorize`, async () => {
    const h = harness('contracts-ots-stamp', { user: true, roleValue: value });
    assert.equal((await h.handler(stampRequest())).status, 403);
    noEffects(h);
  });
}
test('stamp: identity errors cannot authorize even if a user object is present', async () => {
  const h = harness('contracts-ots-stamp', { user: true, roleValue: true, authError: true });
  assert.equal((await h.handler(stampRequest())).status, 401);
  assert.equal(h.calls.roles.length, 0);
  noEffects(h);
});
for (const failure of ['authThrows', 'roleError', 'roleThrows']) {
  test(`stamp: ${failure} fails closed without provider or contract activity`, async () => {
    const h = harness('contracts-ots-stamp', { user: true, roleValue: true, [failure]: true });
    assert.equal((await h.handler(stampRequest())).status, 503);
    noEffects(h);
  });
}
for (const serviceKey of [undefined, '']) {
  test(`stamp: ${serviceKey === undefined ? 'absent' : 'empty'} server credential is a configuration refusal`, async () => {
    const h = harness('contracts-ots-stamp', { env: { SUPABASE_SERVICE_ROLE_KEY: serviceKey } });
    assert.equal((await h.handler(stampRequest())).status, 503);
    assert.equal(h.calls.clients.length, 0);
    noEffects(h);
  });
}
test('stamp: a token that only shares the service credential prefix is refused', async () => {
  const h = harness('contracts-ots-stamp');
  assert.equal((await h.handler(stampRequest(SERVICE + '-not-the-service'))).status, 401);
  noEffects(h);
});
test('stamp: a verified administrator keeps the complete existing stamping path', async () => {
  const h = harness('contracts-ots-stamp', { user: true, roleValue: true });
  const response = await h.handler(stampRequest());
  assert.equal(response.status, 200);
  assert.equal(h.calls.auth.length, 3, 'identity rechecked after PDF retrieval and before persistence');
  assert.equal(h.calls.roles.length, 3, 'administrator role rechecked at all three boundaries');
  assert.ok(h.calls.roles.every(call => call.schema === 'public'), 'every authorization check uses public.has_role');
  assert.equal(h.calls.stamps.length, 1);
  const update = h.calls.writes.find(x => x.table === 'contracts');
  assert.equal(update.value.ots_stamp_hash, createHash('sha256').update(PDF).digest('hex'));
  assert.equal(update.value.ots_proof, 'AQID');
  for (const [field, expected] of [['id', CONTRACT], ['user_id', USER], ['status', 'signed'],
    ['docuseal_submission_id', 123], ['ots_stamp_hash', null], ['ots_proof', null]]) {
    assert.ok(update.filters.some(([name, value]) => name === field && value === expected),
      `proof persistence must retain the original ${field} guard`);
  }
  assert.equal(h.calls.writes.filter(x => x.table === 'contract_events').length, 1);
});
test('stamp: the exact configured service bearer preserves the webhook contract', async () => {
  const h = harness('contracts-ots-stamp', { authThrows: true, roleThrows: true });
  const response = await h.handler(stampRequest(SERVICE));
  assert.equal(response.status, 200);
  assert.equal(h.calls.auth.length, 0);
  assert.equal(h.calls.roles.length, 0);
  assert.equal(h.calls.stamps.length, 1);
});
for (const secret of [undefined, '']) {
  test(`webhook: ${secret === undefined ? 'absent' : 'empty'} shared secret refuses before reading the body or data`, async () => {
    const h = harness('contracts-webhook', { env: { DOCUSEAL_WEBHOOK_SECRET: secret } });
    const request = webhookRequest(null);
    let bodyReads = 0;
    const originalText = request.text.bind(request);
    Object.defineProperty(request, 'text', { value: () => { bodyReads += 1; return originalText(); } });
    assert.equal((await h.handler(request)).status, 503);
    assert.equal(bodyReads, 0);
    noEffects(h);
  });
}
for (const token of [null, 'wrong-webhook-token']) {
  test(`webhook: ${token === null ? 'missing' : 'invalid'} signature refuses without mutation or send`, async () => {
    const h = harness('contracts-webhook');
    assert.equal((await h.handler(webhookRequest(token))).status, 401);
    noEffects(h);
  });
}
test('webhook: a valid configured signature retains its existing service stamping request', async () => {
  const h = harness('contracts-webhook');
  assert.equal((await h.handler(webhookRequest())).status, 200);
  const triggers = h.calls.fetches.filter(x => x.url.endsWith('/contracts-ots-stamp'));
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].init.headers.Authorization === `Bearer ${SERVICE}`, true);
  assert.equal(JSON.parse(triggers[0].init.body).contract_id, CONTRACT);
  assert.equal(h.calls.writes.some(x => x.table === 'contracts' && x.value.status === 'signed'), true);
});
for (const kind of ['contracts-ots-stamp', 'contracts-webhook']) {
  test(`${kind}: preflight and unsupported methods have no effects`, async () => {
    const h = harness(kind, { env: { DOCUSEAL_WEBHOOK_SECRET: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined } });
    assert.equal((await h.handler(new Request('https://example.invalid', { method: 'OPTIONS' }))).status, 200);
    assert.equal((await h.handler(new Request('https://example.invalid', { method: 'GET' }))).status, 405);
    noEffects(h);
  });
}
