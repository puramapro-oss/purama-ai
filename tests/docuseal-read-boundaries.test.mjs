import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Real shared helper, inert HTTP transport. The manual clock covers both headers
// and streamed bytes without contacting DocuSeal or executing contract writes.
const source = readFileSync(new URL('../supabase/functions/_shared/docuseal.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const encoder = new TextEncoder();
const MAX_BYTES = 1024 * 1024;

function harness(provider, env = {}) {
  let clock = 0, sequence = 0;
  const timers = new Map(), calls = [];
  const exports = {};
  vm.runInNewContext(compiled, {
    exports, URL, Request, Response, Headers, AbortController, TextDecoder, TextEncoder,
    Uint8Array, ArrayBuffer, crypto: globalThis.crypto, atob, btoa,
    Deno: { env: { get: key => ({ DOCUSEAL_API_URL: 'https://docuseal.example.invalid', DOCUSEAL_API_TOKEN: 'fixture-only', ...env })[key] } },
    performance: { now: () => clock },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { callback, due: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (...args) => { calls.push(args); return provider(...args); },
  });
  return {
    api: exports, calls, timers,
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); } },
  };
}

async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
async function resultAfterDeadline(h, pending) {
  const observed = pending.then(value => ({ value }), error => ({ error }));
  await flush();
  h.advance(10_001);
  await flush();
  let timeout;
  try {
    return await Promise.race([observed, new Promise(resolve => { timeout = setTimeout(() => resolve({ unbounded: true }), 30); })]);
  } finally { clearTimeout(timeout); }
}

test('DocuSeal GET: normal JSON is decoded with one authenticated request', async () => {
  const h = harness(() => Response.json({ id: 123, combined_document_url: 'https://docuseal.example.invalid/f.pdf' }));
  const result = await h.api.docusealFetch('GET', '/api/submissions/123');
  assert.equal(result.id, 123);
  assert.equal(h.calls.length, 1);
  assert.equal(String(h.calls[0][0]), 'https://docuseal.example.invalid/api/submissions/123');
  assert.equal(h.calls[0][1].headers['X-Auth-Token'], 'fixture-only');
  assert.equal(h.timers.size, 0);
});

test('DocuSeal GET: redirects and ambient credentials are disabled', async () => {
  const h = harness(() => Response.json({ id: 123 }));
  await h.api.docusealFetch('GET', '/api/submissions/123');
  assert.equal(h.calls[0][1].redirect, 'error');
  assert.equal(h.calls[0][1].credentials, 'omit');
});

test('DocuSeal GET: an absent credential fails before provider contact', async () => {
  const h = harness(() => Response.json({ id: 123 }), { DOCUSEAL_API_TOKEN: '' });
  await assert.rejects(h.api.docusealFetch('GET', '/api/submissions/123'), error => error instanceof h.api.DocusealError && error.status === 503);
  assert.equal(h.calls.length, 0);
});

test('DocuSeal GET: redirected responses are refused even if a transport returns one', async () => {
  const response = Response.json({ id: 123 });
  Object.defineProperty(response, 'redirected', { value: true });
  const h = harness(() => response);
  await assert.rejects(h.api.docusealFetch('GET', '/api/submissions/123'), error => error instanceof h.api.DocusealError && error.status === 502);
});

test('DocuSeal GET: exactly one MiB of decoded JSON is allowed', async () => {
  const h = harness(() => new Response('"' + 'a'.repeat(MAX_BYTES - 2) + '"'));
  const value = await h.api.docusealFetch('GET', '/api/submissions/123');
  assert.equal(value.length, MAX_BYTES - 2);
});

test('DocuSeal GET: streamed JSON beyond one MiB is refused without relying on a header', async () => {
  let cancelled = false;
  const h = harness(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('"' + 'a'.repeat(MAX_BYTES) + '"')); }, cancel() { cancelled = true; } })));
  const result = await resultAfterDeadline(h, h.api.docusealFetch('GET', '/api/submissions/123'));
  assert.ok(result.error instanceof h.api.DocusealError);
  assert.equal(result.error.status, 502);
  assert.equal(cancelled, true);
});

for (const declared of [String(MAX_BYTES + 1), '-1', '1.5', 'garbage']) {
  test(`DocuSeal GET: unsafe Content-Length ${declared} is refused`, async () => {
    const h = harness(() => new Response('{}', { headers: { 'content-length': declared } }));
    await assert.rejects(h.api.docusealFetch('GET', '/api/submissions/123'), error => error instanceof h.api.DocusealError && error.status === 502);
  });
}

test('DocuSeal GET: compressed wire length need not equal decoded JSON length', async () => {
  const h = harness(() => new Response('{"value":"decoded"}', { headers: { 'content-length': '4', 'content-encoding': 'gzip' } }));
  assert.equal((await h.api.docusealFetch('GET', '/api/submissions/123')).value, 'decoded');
});

test('DocuSeal GET: malformed JSON is a provider error', async () => {
  const h = harness(() => new Response('<html>unavailable</html>'));
  await assert.rejects(h.api.docusealFetch('GET', '/api/submissions/123'), error => error instanceof h.api.DocusealError && error.status === 502);
});

test('DocuSeal GET: invalid UTF-8 is refused instead of silently repaired', async () => {
  const h = harness(() => new Response(new Uint8Array([34, 0xff, 34])));
  await assert.rejects(h.api.docusealFetch('GET', '/api/submissions/123'), error => error instanceof h.api.DocusealError && error.status === 502);
});

test('DocuSeal GET: an unresolved fetch obeys the whole-operation deadline without retry', async () => {
  const h = harness(() => new Promise(() => {}));
  const result = await resultAfterDeadline(h, h.api.docusealFetch('GET', '/api/submissions/123'));
  assert.ok(result.error instanceof h.api.DocusealError);
  assert.equal(result.error.status, 504);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][1].signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('DocuSeal GET: a stalled body and a stalled cancellation cannot delay the error', async () => {
  let cancelled = false;
  const h = harness(() => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } })));
  const result = await resultAfterDeadline(h, h.api.docusealFetch('GET', '/api/submissions/123'));
  assert.ok(result.error instanceof h.api.DocusealError);
  assert.equal(result.error.status, 504);
  assert.equal(cancelled, true);
  assert.equal(h.timers.size, 0);
});

test('DocuSeal GET: empty chunks cannot starve a request indefinitely', { timeout: 1000 }, async () => {
  let cancelled = false, chunks = 0;
  const h = harness(() => new Response(new ReadableStream({ pull(controller) {
    if (chunks++ < 65) controller.enqueue(new Uint8Array());
    else { controller.enqueue(encoder.encode('{}')); controller.close(); }
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 })));
  const pending = h.api.docusealFetch('GET', '/api/submissions/123');
  // The fixture is finite even for the original implementation; the native test
  // timeout avoids depending on VM microtask scheduling. The manual clock stays
  // unchanged, so only the empty-fragment bound can reject this response.
  const result = await pending.then(value => ({ value }), error => ({ error }));
  assert.ok(result.error instanceof h.api.DocusealError);
  assert.equal(result.error.status, 502);
  assert.equal(cancelled, true);
});

test('DocuSeal GET: no-content response retains the existing empty-object result', async () => {
  const h = harness(() => new Response(null, { status: 204 }));
  assert.deepEqual(Object.keys(await h.api.docusealFetch('GET', '/api/submissions/123')), []);
  assert.equal(h.timers.size, 0);
});

for (const [name, body, expected] of [['JSON', '{"message":"denied"}', { message: 'denied' }], ['text', 'upstream unavailable', 'upstream unavailable']]) {
  test(`DocuSeal GET: ${name} error body is consumed once and preserves HTTP status`, async () => {
    const h = harness(() => new Response(body, { status: 401 }));
    await assert.rejects(h.api.docusealFetch('GET', '/api/submissions/123'), error => {
      assert.ok(error instanceof h.api.DocusealError);
      assert.equal(error.status, 401);
      assert.equal(JSON.stringify(error.body), JSON.stringify(expected));
      return true;
    });
  });
}

for (const method of ['POST', 'DELETE']) {
  test(`DocuSeal ${method}: existing write transport is not retried or reinterpreted`, async () => {
    const h = harness(() => method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 123 }));
    await h.api.docusealFetch(method, '/api/submissions', method === 'POST' ? { template_id: 1 } : undefined);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0][1].method, method);
    assert.equal(h.calls[0][1].body, method === 'POST' ? '{"template_id":1}' : undefined);
    assert.equal(h.calls[0][1].signal, undefined);
  });
}
