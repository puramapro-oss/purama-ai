import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const calendar = new URL('https://alice.btc.calendar.opentimestamps.org/timestamp/aa');
const origin = 'https://docuseal.fixture.invalid';
const never = () => new Promise(() => {});
function deferred() { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

// Real readers and deadline code; only the clock and external HTTP port are
// replaced. The outer guard detects a hung promise, it never grants success.
async function harness(route, { onBinaryCopy } = {}) {
  let clock = 0; let sequence = 0;
  const timers = new Map(); const calls = [];
  const context = vm.createContext({
    URL, Response, Headers, ArrayBuffer, TextDecoder, TextEncoder, AbortController,
    Uint8Array: onBinaryCopy ? class extends Uint8Array {
      constructor(...args) { super(...args); if (args[0] instanceof Uint8Array) onBinaryCopy(); }
    } : Uint8Array,
    atob, btoa, performance: { now: () => clock },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: (input, init) => { calls.push({ url: String(input), init }); return route(input, init); },
  });
  class OtsHttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const javascript = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = new vm.SourceTextModule(javascript, { context, identifier: file }); cache.set(file, module); return module;
  }
  function values(exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  }
  async function entry(path) {
    const module = load(resolve(root, path));
    await module.link((specifier, parent) => {
      if (specifier === './docuseal.ts') return values({ DOCUSEAL_URL: origin, DOCUSEAL_TOKEN: 'fixture-token-never-live' });
      if (specifier === './ots-auth.ts') return values({ OtsHttpError });
      assert.ok(specifier.startsWith('.'), 'all external imports must be explicit fixture ports');
      return load(resolve(dirname(parent.identifier), /\.[cm]?[jt]s$/.test(specifier) ? specifier : `${specifier}.ts`));
    });
    await module.evaluate(); return module.namespace;
  }
  return {
    calls, timers, ots: await entry('src/lib/ots-core.ts'), pdf: await entry('supabase/functions/_shared/ots-pdf.ts'),
    advance(milliseconds, fireTimers = true) {
      clock += milliseconds;
      if (fireTimers) for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); }
    },
  };
}
function response({ status = 200, headers, read, cancel = async () => {}, redirected = false } = {}) {
  const state = { cancels: 0, releases: 0, reads: 0 };
  const stop = () => { state.cancels++; return cancel(); };
  return {
    state, status, ok: status >= 200 && status < 300, redirected, headers: new Headers(headers),
    body: { cancel: stop, getReader: () => ({
      read: () => { state.reads++; return read ? read() : Promise.resolve({ done: true }); },
      cancel: stop, releaseLock: () => { state.releases++; },
    }) },
  };
}
async function observed(promise) {
  let timer;
  try {
    return await Promise.race([
      promise.then(value => ({ value }), error => ({ error })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ unbounded: true }), 60); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function rejects(promise, code) {
  const result = await observed(promise);
  assert.equal(result.unbounded, undefined, 'reader must settle without cooperation from fetch/read/cancel');
  assert.ok(result.error, 'expected a refusal'); assert.match(result.error.message, code);
  return result.error;
}

test('OTS: a non-cooperative fetch settles at the single 10-second deadline', async () => {
  const h = await harness(never); const pending = h.ots.readOtsResponse(calendar); await flush();
  assert.deepEqual([...h.timers.values()].map(timer => timer.due), [10_000]);
  h.advance(10_000); await rejects(pending, /OTS_TIMEOUT/);
  assert.equal(h.calls[0].init.signal.aborted, true); assert.equal(h.timers.size, 0);
});
test('OTS: a non-cooperative body read settles and attempts cancellation', async () => {
  const body = response({ read: never, cancel: never }); const h = await harness(async () => body);
  const pending = h.ots.readOtsResponse(calendar); await flush(); h.advance(10_000);
  await rejects(pending, /OTS_TIMEOUT/); assert.equal(body.state.cancels, 1);
});
test('OTS: pending-proof 404 remains null when cancellation never resolves', async () => {
  const body = response({ status: 404, cancel: never }); const h = await harness(async () => body);
  const result = await observed(h.ots.readOtsResponse(calendar));
  assert.equal(result.unbounded, undefined); assert.equal(result.value, null); assert.equal(body.state.cancels, 1);
});
test('OTS: a 404 cannot return success after synchronous cleanup crosses the deadline', async () => {
  let h; const body = response({ status: 404, cancel: () => { h.advance(10_001, false); return never(); } });
  h = await harness(async () => body); await rejects(h.ots.readOtsResponse(calendar), /OTS_TIMEOUT/);
});
for (const [label, options, code] of [
  ['HTTP refusal', { status: 503 }, /OTS_HTTP_REJECTED/],
  ['declared oversize', { headers: { 'content-length': '10001' } }, /OTS_RESPONSE_TOO_LARGE/],
  ['redirect refusal', { redirected: true }, /OTS_REDIRECT_REJECTED/],
]) {
  test(`OTS: ${label} does not wait for cancellation`, async () => {
    const body = response({ ...options, cancel: never }); const h = await harness(async () => body);
    await rejects(h.ots.readOtsResponse(calendar), code); assert.equal(body.state.cancels, 1);
  });
}
test('OTS: streamed oversize is refused without waiting for reader cancellation', async () => {
  const body = response({ read: async () => ({ value: new Uint8Array(10001), done: false }), cancel: never });
  const h = await harness(async () => body); await rejects(h.ots.readOtsResponse(calendar), /OTS_RESPONSE_TOO_LARGE/);
  assert.equal(body.state.cancels, 1);
});
test('OTS: late fetch completion after timeout is cancelled without changing the refusal', async () => {
  const port = deferred(); const body = response({ cancel: never }); const h = await harness(() => port.promise);
  const pending = h.ots.readOtsResponse(calendar); await flush(); h.advance(10_000); await rejects(pending, /OTS_TIMEOUT/);
  port.resolve(body); await flush(); assert.equal(body.state.cancels, 1); assert.equal(body.state.reads, 0);
});
test('OTS: monotonic deadline rejects a late fetch even when the timer has not run', async () => {
  const body = response({ cancel: never }); let h;
  h = await harness(async () => { h.advance(10_001, false); return body; });
  await rejects(h.ots.readOtsResponse(calendar), /OTS_TIMEOUT/); assert.equal(body.state.cancels, 1);
});
test('OTS: repeated empty chunks cannot starve the monotonic deadline', async () => {
  let h; let reads = 0;
  const body = response({ read: async () => { h.advance(1_000, false); return { value: new Uint8Array(), done: ++reads > 11 }; } });
  h = await harness(async () => body); await rejects(h.ots.readOtsResponse(calendar), /OTS_TIMEOUT/);
  assert.ok(body.state.reads <= 10); assert.equal(body.state.cancels, 1);
});
test('OTS: completion after the deadline is rejected even when it contains no next chunk', async () => {
  let h; const body = response({ read: async () => { h.advance(10_001, false); return { done: true }; } });
  h = await harness(async () => body); await rejects(h.ots.readOtsResponse(calendar), /OTS_TIMEOUT/);
});
test('OTS: a valid response retains its exact bytes and transport restrictions', async () => {
  const bytes = new Uint8Array([0, 128, 255]); const h = await harness(async () => new Response(bytes));
  assert.deepEqual(await h.ots.readOtsResponse(calendar), bytes);
  assert.equal(h.calls[0].init.redirect, 'error'); assert.equal(h.calls[0].init.credentials, 'omit'); assert.equal(h.timers.size, 0);
});

test('PDF: metadata fetch is bounded even when abort is ignored', async () => {
  const h = await harness(never); const pending = h.pdf.signedPdf(42); await flush();
  assert.deepEqual([...h.timers.values()].map(timer => timer.due), [15_000]);
  h.advance(15_000); assert.equal((await rejects(pending, /Signed document unavailable/)).status, 502);
});
test('PDF: body read and non-cooperative cancellation cannot exceed the deadline', async () => {
  const body = response({ read: never, cancel: never }); const h = await harness(async () => body);
  const pending = h.pdf.signedPdf(42); await flush(); h.advance(15_000);
  assert.equal((await rejects(pending, /Signed document unavailable/)).status, 502); assert.equal(body.state.cancels, 1);
});
test('PDF: metadata and document share one deadline without restarting the budget', async () => {
  let h; const body = response({ read: async () => { h.advance(6_000, false); return { done: true }; }, cancel: never });
  h = await harness(async input => {
    if (String(input).includes('/api/')) { h.advance(9_000, false); return Response.json({ combined_document_url: `${origin}/signed.pdf` }); }
    return body;
  });
  assert.equal((await rejects(h.pdf.signedPdf(42), /Signed document unavailable/)).status, 502);
  assert.equal(h.calls.length, 2); assert.equal(body.state.cancels, 1);
});
test('PDF: late metadata fetch after timeout is cancelled without reading it', async () => {
  const port = deferred(); const body = response({ cancel: never }); const h = await harness(() => port.promise);
  const pending = h.pdf.signedPdf(42); await flush(); h.advance(15_000); await rejects(pending, /Signed document unavailable/);
  port.resolve(body); await flush(); assert.equal(body.state.cancels, 1); assert.equal(body.state.reads, 0);
});
for (const [label, options] of [
  ['oversized metadata', { headers: { 'content-length': '64001' } }],
  ['failed metadata', { status: 503 }],
]) {
  test(`PDF: ${label} does not wait for cancellation`, async () => {
    const body = response({ ...options, cancel: never }); const h = await harness(async () => body);
    assert.equal((await rejects(h.pdf.signedPdf(42), /Signed document/)).status, 502); assert.equal(body.state.cancels, 1);
  });
}
test('PDF: exact-origin metadata and complete signed bytes succeed without external network', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 synthetic signed document');
  const h = await harness(async input => String(input).includes('/api/')
    ? Response.json({ id: 42, combined_document_url: `${origin}/signed.pdf` }) : new Response(bytes));
  assert.deepEqual(await h.pdf.signedPdf(42), bytes); assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0);
  for (const call of h.calls) { assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit'); }
});
test('PDF: the final binary copy is included in the total deadline', async () => {
  let h; const bytes = new TextEncoder().encode('%PDF-1.7 synthetic signed document');
  h = await harness(async input => String(input).includes('/api/')
    ? Response.json({ id: 42, combined_document_url: `${origin}/signed.pdf` }) : new Response(bytes),
  { onBinaryCopy: () => h.advance(15_001, false) });
  assert.equal((await rejects(h.pdf.signedPdf(42), /Signed document unavailable/)).status, 502);
});
