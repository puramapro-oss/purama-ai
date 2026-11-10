import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
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
const portableFiles = new Set(['ots-core.ts', 'request-deadline.ts'].map(file => fileURLToPath(new URL(`../src/lib/${file}`, import.meta.url))));

// Run the complete, actual Edge entry points and local helper modules. Only
// external services and serve() are substituted. No provider request is sent.
async function harness(options = {}, entry = 'contracts-ots-stamp') {
  let handler;
  const calls = { clients: [], auth: [], roles: [], contractReads: [], updates: [], events: [],
    docs: [], pdf: [], stamps: [], internal: [], errors: [], signerUpdates: [], signerReads: [], sdk: [] };
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
        if (target.pathname === '/rest/v1/contracts') return Response.json([]);
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
        options.onAuthorization?.(calls.auth.length);
        if (options.authThrows) throw new Error('provider-private-auth-detail');
        const id = token === 'admin-token' ? 'server-admin' : token === 'member-token' ? 'ordinary-member' : null;
        return { data: { user: id ? { id, user_metadata: { role: 'admin' } } : null },
          error: options.authError ? { message: 'private-auth-detail' } : null };
      } },
      rpc: (name, args) => rpc(name, args, settings?.db?.schema),
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
            const signer = { id: 'fixture-signer', contract_id: contractId, docuseal_submitter_id: 7 };
            return { data: options.missingSigner || !filters.every(([key, value]) => signer[key] === value) ? null : { id: signer.id },
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
    Request, Response, Headers, URL, Uint8Array, ArrayBuffer, Array, AbortController, TextEncoder, TextDecoder,
    performance: options.performance ?? performance, setTimeout, clearTimeout,
    crypto: options.crypto ?? webcrypto, atob, btoa,
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
      return new Response(options.pdfBytes ?? new TextEncoder().encode("%PDF-1.7 synthetic signed document"), { status: options.pdfStatus ?? 200 });
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
    assert.ok(specifier.startsWith('.') && (file.startsWith(functionsRoot) || portableFiles.has(file)), `Unexpected import: ${specifier}`);
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

export { harness, request, noStampEffects, OpenTimestamps, contractId, serviceKey, webhookSecret, docusealToken, docusealOrigin, defaultPdfUrl, foreignPdfUrl };
