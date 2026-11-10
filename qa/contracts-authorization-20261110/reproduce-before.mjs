// Expected result: two failures demonstrate the unpatched baseline. No network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baseline = '8755a39a3c4a23b64f5b8f0b2909c82d11e732ad';
const require = createRequire(`${root}/package.json`);
const ts = require('typescript');
const file = `${root}/supabase/functions/contracts-ots-stamp/index.ts`;
const code = ts.transpileModule(execFileSync('git', ['show', `${baseline}:supabase/functions/contracts-ots-stamp/index.ts`], { cwd: root, encoding: 'utf8' }), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  fileName: file,
}).outputText;
const contractId = '00000000-0000-4000-8000-000000000001';

async function harness() {
  let handler;
  const calls = { reads: 0, writes: 0, docs: 0, fetches: 0, stamps: 0 };
  const headers = { 'Content-Type': 'application/json' };
  const contract = { id: contractId, status: 'signed', docuseal_submission_id: 42, ots_stamp_hash: null, pdf_original_url: 'https://pdf.example.invalid/signed.pdf' };
  const env = { SUPABASE_URL: 'https://db.example.invalid', SUPABASE_ANON_KEY: 'test-anon', SUPABASE_SERVICE_ROLE_KEY: 'test-service-never-live' };
  const context = vm.createContext({
    Request, Response, Headers, URL, Uint8Array, TextEncoder, TextDecoder,
    crypto: webcrypto, atob, btoa, console,
    Deno: { env: { get: key => env[key] } },
    fetch: async () => { calls.fetches++; return new Response(new Uint8Array([37,80,68,70])); },
  });
  const createClient = () => ({
    auth: { getUser: async token => ({ data: { user: token === 'member-token' ? { id: 'member-id', user_metadata: { role: 'admin' } } : null }, error: null }) },
    rpc: async () => ({ data: false, error: null }),
    from: table => {
      const builder = {
        select() { calls.reads++; return builder; },
        update() { calls.writes++; return builder; },
        insert() { calls.writes++; return Promise.resolve({ error: null }); },
        eq() { return builder; },
        maybeSingle: async () => ({ data: table === 'contracts' ? contract : null, error: null }),
        then: resolve => resolve({ error: null, data: null }),
      };
      return builder;
    },
  });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const modules = {
    'https://deno.land/std@0.190.0/http/server.ts': { serve: fn => { handler = fn; } },
    'npm:@supabase/supabase-js@2.91.0': { createClient },
    'npm:opentimestamps@0.4.9': { default: {
      DetachedTimestampFile: { fromHash: () => ({ serializeToBytes: () => new Uint8Array([1,2,3]) }) },
      Ops: { OpSHA256: class {} }, stamp: async () => { calls.stamps++; },
    } },
    '../_shared/docuseal.ts': {
      CORS_HEADERS: {}, corsResponse: json, errorResponse: (message, status = 400) => json({ error: message }, status),
      DOCUSEAL_URL: 'https://docuseal.example.invalid', DOCUSEAL_TOKEN: 'test-docuseal-never-live',
      docusealFetch: async () => { calls.docs++; return { combined_document_url: 'https://pdf.example.invalid/signed.pdf' }; },
    },
  };
  const module = new vm.SourceTextModule(code, { context, identifier: file });
  await module.link(specifier => {
    const exports = modules[specifier];
    if (!exports) throw new Error(`Unexpected import: ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return { handler, calls };
}

for (const [label, token, expectedStatus] of [
  ['invalid bearer', 'invalid-token', 401],
  ['authenticated non-admin with forged user_metadata', 'member-token', 403],
]) {
  test(`stamp rejects ${label} before privileged reads, PDF fetch and writes`, async () => {
    const { handler, calls } = await harness();
    const response = await handler(new Request('https://edge.example.invalid/contracts-ots-stamp', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contract_id: contractId }),
    }));
    console.log(JSON.stringify({ label, status: response.status, calls }));
    assert.equal(response.status, expectedStatus);
    assert.equal(calls.docs + calls.fetches + calls.stamps + calls.writes, 0);
  });
}
