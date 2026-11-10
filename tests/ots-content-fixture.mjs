import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const primitives = {
  DetachedTimestampFile: require('opentimestamps/src/detached-timestamp-file.js'),
  Ops: require('opentimestamps/src/ops.js'),
  Context: require('opentimestamps/src/context.js'),
  Timestamp: require('opentimestamps/src/timestamp.js'),
  Notary: require('opentimestamps/src/notary.js'),
};
const OpenTimestamps = primitives;
const { PendingAttestation } = primitives.Notary;
const libRoot = fileURLToPath(new URL('../src/lib/', import.meta.url));
const calendar = 'https://alice.btc.calendar.opentimestamps.org';
const pdf = new Uint8Array([37, 80, 68, 70, 0, 128, 255, 10]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Execute the real TypeScript wrapper and bounded transport with the upstream
// proof primitives. Only calendar HTTP is simulated; legacy transport is never loaded.
async function library({ allCalendarsFail = false, withWebCrypto = true, withBuffer = true } = {}) {
  const providerFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    if (url.pathname === '/digest') {
      if (allCalendarsFail) throw new Error('calendar unavailable');
      const timestamp = new primitives.Timestamp(Array.from(init.body));
      timestamp.attestations.push(new PendingAttestation(calendar));
      const output = new primitives.Context.StreamSerialization();
      timestamp.serialize(output);
      return new Response(new Uint8Array(output.getOutput()));
    }
    if (url.pathname.startsWith('/timestamp/')) return new Response(null, { status: 404 });
    throw new Error('Unexpected network destination blocked by the test');
  };
  const context = vm.createContext({
    // Upstream primitives use instanceof Array; keep their realm shared with
    // the wrapper, as in the browser bundle. No proof or assertion is stubbed.
    TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Array, atob, btoa, URL, Response,
    AbortController, performance, setTimeout, clearTimeout, fetch: providerFetch,
    ...(withBuffer ? { Buffer } : {}),
    ...(withWebCrypto ? { crypto: webcrypto } : {}),
  });
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const source = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const module = new vm.SourceTextModule(source, {
      context, identifier: file,
      importModuleDynamically: async specifier => {
        assert.equal(specifier, 'crypto');
        return import('node:crypto');
      },
    });
    cache.set(file, module);
    return module;
  }
  const entry = load(resolve(libRoot, 'docuseal/ots-stamper.ts'));
  await entry.link((specifier, parent) => {
    if (specifier.startsWith('opentimestamps/src/')) {
      const value = require(specifier);
      return new vm.SyntheticModule(['default'], function () { this.setExport('default', value); }, { context });
    }
    assert.ok(specifier.startsWith('.'));
    return load(resolve(dirname(parent.identifier), specifier.endsWith('.ts') ? specifier : `${specifier}.ts`));
  });
  await entry.evaluate();
  return { contracts: entry.namespace, ots: cache.get(resolve(libRoot, 'opentimestamps.ts')).namespace };
}

export { library, OpenTimestamps, PendingAttestation, calendar, pdf, digest };
