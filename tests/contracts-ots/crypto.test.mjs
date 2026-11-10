import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const originalHttpRequest = http.request; const originalHttpsRequest = https.request;
http.request = https.request = () => { throw new Error('Legacy network transport is forbidden in these tests'); };
const library = {
  DetachedTimestampFile: require('opentimestamps/src/detached-timestamp-file.js'),
  Ops: require('opentimestamps/src/ops.js'),
  Context: require('opentimestamps/src/context.js'),
  Timestamp: require('opentimestamps/src/timestamp.js'),
  Notary: require('opentimestamps/src/notary.js'),
};
const source = readFileSync(new URL('../../src/lib/ots-core.ts', import.meta.url), 'utf8');
const emitted = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const core = await import(`data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`);
const client = core.createOtsClient(library);
const fixtures = JSON.parse(readFileSync(new URL('./upstream-fixtures.json', import.meta.url), 'utf8')).fixtures;
const hello = Buffer.from(fixtures.find(x => x.fixture === 'examples/hello-world.txt').base64, 'base64');
const helloProof = Buffer.from(fixtures.find(x => x.fixture === 'examples/hello-world.txt.ots').base64, 'base64');
const helloHash = new Uint8Array(createHash('sha256').update(hello).digest());
// Independent upstream README and test/debug/verify.js constants. This Merkle
// root is never computed from our wrapper or from the proof under test.
const HELLO_BLOCK = { height: 358391, timestamp: 1432827678,
  merkle_root: '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00' };
// Historical public metadata read by the coordinator on 2026-11-10;
// block JSON SHA-256 d144579b3d9ba2a887d9f6e5bfb44bfa14be8a1b9cf686853b57b54c075f24d7.
const BLOCK_HASH = '000000000000000003e892881a8cdcdc117c06d444057c98b6f04a9ee75a2319';
const syntheticHash = new Uint8Array(createHash('sha256').update('synthetic crypto transport fixture').digest());
let calls = [];
const originalFetch = globalThis.fetch;
beforeEach(() => { calls = []; globalThis.fetch = async () => { throw new Error('Unconfigured network port'); }; });
after(() => { globalThis.fetch = originalFetch; http.request = originalHttpRequest; https.request = originalHttpsRequest; });

function detached(attestations = [], hash = syntheticHash) {
  const proof = library.DetachedTimestampFile.fromHash(new library.Ops.OpSHA256(), Array.from(hash));
  proof.timestamp.attestations.push(...attestations);
  return proof;
}
function encoded(proof) { return Buffer.from(proof.serializeToBytes()).toString('base64'); }
function calendarReply(digest, attestations) {
  const stamp = new library.Timestamp(Array.from(digest)); stamp.attestations.push(...attestations);
  const context = new library.Context.StreamSerialization(); stamp.serialize(context);
  return new Uint8Array(context.getOutput());
}
function fixtureTransport(route) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url: String(url), init });
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return route(url, init);
  };
}
function blockResponse(url, block) {
  if (url.pathname === `/api/block-height/${block.height}`) return new Response(BLOCK_HASH);
  if (url.pathname === `/api/block/${BLOCK_HASH}`) return Response.json({ id: BLOCK_HASH, ...block });
  throw new Error('Unexpected block lookup');
}

test('proof primitives import with the existing uuid override without loading request adapters', () => {
  assert.ok(library.Ops.OpSHA256); assert.ok(library.Notary.BitcoinBlockHeaderAttestation);
  assert.equal(Object.keys(require.cache).some(path => /opentimestamps\/src\/(?:calendar|esplora|open-timestamps)\.js$/.test(path)), false);
});
test('the independent upstream hello-world file and .ots retain their published bytes', () => {
  assert.equal(createHash('sha256').update(hello).digest('hex'), '03ba204e50d126e4674c005e04d82e84c21366780af1f43bd54a37816b6ab340');
  assert.equal(createHash('sha256').update(helloProof).digest('hex'), 'be61ecb940db2e4a6f89fbed59c8d4f7f74fa756cbc1fad1ad7aabcb2bf59c30');
});
test('real upstream hello-world proof verifies block358391 against an independent fixed Merkle root', async () => {
  fixtureTransport(url => blockResponse(url, HELLO_BLOCK));
  const result = await client.verifyDigest(helloHash, helloProof.toString('base64'), false);
  assert.deepEqual(result.bitcoin, { height: 358391, timestamp: 1432827678 });
  assert.equal(calls.length, 2);
});
test('a wrong independent block Merkle root is rejected by the upstream attestation verifier', async () => {
  fixtureTransport(url => blockResponse(url, { ...HELLO_BLOCK, merkle_root: 'ab'.repeat(32) }));
  await assert.rejects(client.verifyDigest(helloHash, helloProof.toString('base64'), false), /OTS_INVALID_ATTESTATION/);
});
test('changing the document digest rejects the real proof before any network operation', async () => {
  await assert.rejects(client.verifyDigest(syntheticHash, helloProof.toString('base64'), true), /OTS_HASH_MISMATCH/);
  assert.equal(calls.length, 0);
});
test('real binary empty and unknown-only proofs are not presented as pending', async () => {
  for (const proof of [detached(), detached([new library.Notary.UnknownAttestation([1, 2, 3, 4, 5, 6, 7, 8], [1])])]) {
    await assert.rejects(client.verifyDigest(syntheticHash, encoded(proof), true), /OTS_INVALID_PROOF/);
  }
  assert.equal(calls.length, 0);
});
test('pending proof with only a private calendar is rejected without following its URI', async () => {
  const proof = detached([new library.Notary.PendingAttestation('http://127.0.0.1:5432')]);
  await assert.rejects(client.verifyDigest(syntheticHash, encoded(proof), true), /OTS_INVALID_PROOF/);
  assert.equal(calls.length, 0);
});
test('valid pending proof without an upgrade request makes no calendar call', async () => {
  const proof = detached([new library.Notary.PendingAttestation('https://alice.btc.calendar.opentimestamps.org')]);
  const result = await client.verifyDigest(syntheticHash, encoded(proof), false);
  assert.equal(result.bitcoin, undefined); assert.equal(calls.length, 0);
});
test('one failed calendar cannot prevent the next calendar from confirming the proof', async () => {
  const proof = detached([new library.Notary.PendingAttestation('https://alice.btc.calendar.opentimestamps.org'), new library.Notary.PendingAttestation('https://bob.btc.calendar.opentimestamps.org')]);
  const block = { height: 42, timestamp: 1600000000, merkle_root: Buffer.from(syntheticHash).reverse().toString('hex') };
  fixtureTransport(url => {
    if (url.hostname.startsWith('alice.')) return new Response(null, { status: 503 });
    if (url.hostname.startsWith('bob.')) return new Response(calendarReply(syntheticHash, [new library.Notary.BitcoinBlockHeaderAttestation(42)]));
    return blockResponse(url, block);
  });
  const result = await client.verifyDigest(syntheticHash, encoded(proof), true);
  assert.deepEqual(result.bitcoin, { height: 42, timestamp: 1600000000 }); assert.equal(calls.length, 4);
});
test('all calendar failures return an availability error, not a pending success', async () => {
  const proof = detached([new library.Notary.PendingAttestation('https://alice.btc.calendar.opentimestamps.org')]);
  fixtureTransport(() => new Response(null, { status: 503 }));
  await assert.rejects(client.verifyDigest(syntheticHash, encoded(proof), true), /OTS_CALENDAR_UNAVAILABLE/);
});
test('redirect responses never cause a second destination to be fetched', async () => {
  const proof = detached([new library.Notary.PendingAttestation('https://alice.btc.calendar.opentimestamps.org')]);
  fixtureTransport(() => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:5432' } }));
  await assert.rejects(client.verifyDigest(syntheticHash, encoded(proof), true), /OTS_CALENDAR_UNAVAILABLE/);
  assert.equal(calls.length, 1); assert.ok(calls[0].url.startsWith('https://alice.btc.calendar.opentimestamps.org/'));
});
test('private, lookalike, credential-bearing, path and fragment destinations are refused', () => {
  for (const value of ['http://127.0.0.1', 'https://alice.btc.calendar.opentimestamps.org.attacker.invalid', 'https://user:password@alice.btc.calendar.opentimestamps.org', 'https://alice.btc.calendar.opentimestamps.org/path', 'https://alice.btc.calendar.opentimestamps.org#fragment', 'https://alice.btc.calendar.opentimestamps.org:8443']) {
    assert.throws(() => core.calendarOrigin(value), /OTS_INVALID_CALENDAR/);
  }
});
test('streamed response size is enforced when Content-Length is absent', async () => {
  fixtureTransport(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10001)); controller.close(); } })));
  await assert.rejects(core.readOtsResponse(new URL('https://alice.btc.calendar.opentimestamps.org/timestamp/aa')), /OTS_RESPONSE_TOO_LARGE/);
});
test('input proof size is rejected before the upstream parser or any transport call', async () => {
  await assert.rejects(client.verifyDigest(syntheticHash, 'A'.repeat(1000000), true), /OTS_INVALID_PROOF/); assert.equal(calls.length, 0);
});
test('the total calendar request budget is enforced for real binary proofs', async () => {
  const proof = detached(Array.from({ length: 20 }, (_, i) => new library.Notary.PendingAttestation(`https://fixture${i}.calendar.opentimestamps.org`)));
  fixtureTransport(() => new Response(null, { status: 404 }));
  await assert.rejects(client.verifyDigest(syntheticHash, encoded(proof), true), /OTS_REQUEST_LIMIT/); assert.equal(calls.length, 12);
});
test('real stamping retains upstream nonce and serialization and requires two calendars', async () => {
  fixtureTransport((url, init) => new Response(calendarReply(new Uint8Array(init.body), [new library.Notary.PendingAttestation(url.origin)])));
  const result = await client.stampDigest(syntheticHash);
  const parsed = library.DetachedTimestampFile.deserialize(Buffer.from(result, 'base64'));
  assert.deepEqual(parsed.fileDigest(), Array.from(syntheticHash)); assert.equal(calls.length, 4);
  assert.notDeepEqual(Array.from(calls[0].init.body), Array.from(syntheticHash), 'nonce commitment must differ from the file hash');
});
test('one calendar success is insufficient for a successful stamp', async () => {
  let replies = 0;
  fixtureTransport((url, init) => ++replies === 1 ? new Response(calendarReply(new Uint8Array(init.body), [new library.Notary.PendingAttestation(url.origin)])) : new Response(null, { status: 503 }));
  await assert.rejects(client.stampDigest(syntheticHash), /OTS_CALENDAR_UNAVAILABLE/);
});
