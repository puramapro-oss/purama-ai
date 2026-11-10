import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import { cases, evaluateCase, CURRENT_SECRET, PREVIOUS_SECRET, NOW } from './cases.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const allowed = new Set([
  'supabase/functions/_shared/docuseal.ts',
  'src/lib/docuseal/cross-app-auth.ts',
  'src/lib/docuseal/types.ts',
].map(path => resolve(root, path)));
const modules = new Map();
let networkCalls = 0;
function load(file) {
  assert.ok(allowed.has(file), 'Only the three application JWT modules may be loaded');
  if (modules.has(file)) return modules.get(file);
  const source = readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
  const module = { exports: {} };
  modules.set(file, module.exports);
  runInNewContext(compiled, {
    module, exports: module.exports,
    require(specifier) {
      if (specifier === 'zod') return { z };
      if (specifier === './types') return load(resolve(dirname(file), 'types.ts'));
      throw new Error('Unexpected module import blocked by JWT test');
    },
    Deno: { env: { get: () => undefined } },
    crypto: webcrypto, Date, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
    fetch: async () => { networkCalls++; throw new Error('Network forbidden in JWT fixture'); },
  }, { filename: file });
  return module.exports;
}

const edge = load(resolve(root, 'supabase/functions/_shared/docuseal.ts'));
const sdk = load(resolve(root, 'src/lib/docuseal/cross-app-auth.ts'));
for (const [name, helper] of [['edge', edge], ['sdk', sdk]]) {
  for (const item of cases) {
    test(`${name}: ${item.name}`, async () => {
      const result = await evaluateCase(helper.verifyCrossAppJwt, item);
      assert.equal(result.accepted, item.accepted, item.name);
      if (item.accepted) {
        assert.equal(result.payload.aud, 'purama-contracts-hub');
        assert.equal(result.payload.app_slug, 'fixture-app');
      }
      assert.equal(networkCalls, 0);
    });
  }
}

for (const validitySeconds of [undefined, 86_400]) {
  test(`real SDK signer roundtrips through both verifiers: ${validitySeconds ?? 'default'} seconds`, async () => {
    const previousNow = Date.now;
    Date.now = () => NOW * 1000;
    try {
      const token = await sdk.signCrossAppJwt({ appSlug: 'fixture-app', secret: CURRENT_SECRET, validitySeconds });
      for (const helper of [sdk, edge]) {
        const payload = await helper.verifyCrossAppJwt(token, [PREVIOUS_SECRET, CURRENT_SECRET]);
        assert.equal(payload.exp - payload.iat, validitySeconds ?? 300);
        assert.equal(payload.iss, 'fixture-app');
        assert.equal(typeof payload.jti, 'string');
      }
      assert.equal(networkCalls, 0);
    } finally {
      Date.now = previousNow;
    }
  });
}
