import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
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
    AbortController, setTimeout, clearTimeout, fetch: providerFetch,
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
    return load(resolve(dirname(parent.identifier), /\.[cm]?[jt]s$/.test(specifier) ? specifier : `${specifier}.ts`));
  });
  await entry.evaluate();
  return { contracts: entry.namespace, ots: cache.get(resolve(libRoot, 'opentimestamps.ts')).namespace };
}

for (const withWebCrypto of [true, false]) {
  test(`hashContent preserves binary bytes and the view boundary with WebCrypto=${withWebCrypto}`, async () => {
    const { ots } = await library({ withWebCrypto });
    const backing = new Uint8Array([1, ...pdf, 2]);
    const view = backing.subarray(1, -1);
    assert.equal(Buffer.from(await ots.hashContent(view)).toString('hex'), digest(pdf));
    assert.equal(Buffer.from(await ots.hashContent(pdf.buffer)).toString('hex'), digest(pdf));
  });
}
for (const [label, content] of [
  ['Uint8Array view', new Uint8Array([1, ...pdf, 2]).subarray(1, -1)],
  ['ArrayBuffer', pdf.buffer],
]) {
  test(`stampContract hashes the exact PDF bytes for ${label}`, async () => {
    const { contracts } = await library();
    const stamped = await contracts.stampContract(content);
    const proof = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(stamped.proofBase64, 'base64')]);
    assert.equal(stamped.stampHash, digest(pdf));
    assert.equal(Buffer.from(proof.fileDigest()).toString('hex'), digest(pdf));
    assert.ok(proof.timestamp.allAttestations().size > 0);
  });
}
for (const representation of ['Uint8Array', 'ArrayBuffer']) {
  test(`stampContract keeps one ${representation} snapshot if the caller mutates its buffer during hashing`, async () => {
    const { contracts } = await library();
    const input = new Uint8Array(pdf);
    const pending = contracts.stampContract(representation === 'ArrayBuffer' ? input.buffer : input);
    input.fill(0);
    const stamped = await pending;
    const proof = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(stamped.proofBase64, 'base64')]);
    assert.equal(stamped.stampHash, digest(pdf));
    assert.equal(Buffer.from(proof.fileDigest()).toString('hex'), stamped.stampHash);
  });
}
test('hashContent snapshots an ArrayBuffer before awaiting the Node crypto fallback', async () => {
  const { ots } = await library({ withWebCrypto: false });
  const input = new Uint8Array(pdf);
  const pending = ots.hashContent(input.buffer);
  input.fill(0);
  assert.equal(Buffer.from(await pending).toString('hex'), digest(pdf));
});
test('existing UTF-8 string stamping remains byte-compatible', async () => {
  const { ots } = await library();
  const text = 'Contrat signé — café ☀';
  const proof = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(await ots.stampHash(text), 'base64')]);
  assert.equal(Buffer.from(proof.fileDigest()).toString('hex'), digest(Buffer.from(text)));
});
test('browser Base64 encoding preserves the serialized proof without Buffer', async () => {
  const { ots } = await library({ withBuffer: false });
  const encoded = await ots.stampHash('browser contract');
  assert.ok(encoded.length > 0);
  const proof = OpenTimestamps.DetachedTimestampFile.deserialize([...Buffer.from(encoded, 'base64')]);
  assert.equal(Buffer.from(proof.fileDigest()).toString('hex'), digest(Buffer.from('browser contract')));
});
test('contract verification accepts the raw-byte digest produced by the Edge handler', async () => {
  const { contracts } = await library();
  const proof = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(), [...createHash('sha256').update(pdf).digest()],
  );
  proof.timestamp.attestations.push(new PendingAttestation(calendar));
  const encoded = Buffer.from(proof.serializeToBytes()).toString('base64');
  const result = await contracts.verifyContractProof(pdf, encoded);
  assert.equal(result.verified, false);
  assert.equal(result.pending, true);
});
test('contract verification preserves existing proofs of the legacy Base64 text', async () => {
  const { contracts } = await library();
  const legacyText = Buffer.from(pdf).toString('base64');
  const proof = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(), [...createHash('sha256').update(legacyText).digest()],
  );
  proof.timestamp.attestations.push(new PendingAttestation(calendar));
  const encoded = Buffer.from(proof.serializeToBytes()).toString('base64');
  const result = await contracts.verifyContractProof(pdf, encoded);
  assert.equal(result.verified, false);
  assert.equal(result.pending, true);
});
test('legacy verification keeps its ArrayBuffer snapshot across the raw-proof attempt', async () => {
  const { contracts } = await library();
  const proof = OpenTimestamps.DetachedTimestampFile.fromHash(
    new OpenTimestamps.Ops.OpSHA256(), [...createHash('sha256').update(Buffer.from(pdf).toString('base64')).digest()],
  );
  proof.timestamp.attestations.push(new PendingAttestation(calendar));
  const input = new Uint8Array(pdf);
  const pending = contracts.verifyContractProof(input.buffer, Buffer.from(proof.serializeToBytes()).toString('base64'));
  input.fill(0);
  const result = await pending;
  assert.equal(result.verified, false);
  assert.equal(result.pending, true);
});
test('contract verification rejects altered bytes in both raw and legacy formats', async () => {
  const { contracts } = await library();
  const altered = new Uint8Array(pdf);
  altered[4] = 1;
  for (const content of [pdf, Buffer.from(pdf).toString('base64')]) {
    const proof = OpenTimestamps.DetachedTimestampFile.fromHash(
      new OpenTimestamps.Ops.OpSHA256(), [...createHash('sha256').update(content).digest()],
    );
    proof.timestamp.attestations.push(new PendingAttestation(calendar));
    const result = await contracts.verifyContractProof(altered, Buffer.from(proof.serializeToBytes()).toString('base64'));
    assert.equal(result.verified, false);
    assert.equal(result.pending, undefined);
  }
});
for (const name of ['stampHash', 'stampContract']) {
  test(`${name} rejects a receipt when every calendar failed`, async () => {
    const { ots, contracts } = await library({ allCalendarsFail: true });
    await assert.rejects(() => name === 'stampHash' ? ots.stampHash('contract') : contracts.stampContract(pdf), /calendar/i);
  });
}
