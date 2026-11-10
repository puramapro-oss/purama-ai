import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRequestText, RequestBodyError } from './request-body.ts';

const encoder = new TextEncoder();
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } });
  return new Request('https://body.example.invalid', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}
async function refuses(pending: Promise<string>, status: number) {
  await assert.rejects(pending, (error: unknown) => error instanceof RequestBodyError && error.status === status);
}

test('body reader: exact UTF-8 survives chunk boundaries, including the HMAC BOM', async () => {
  const original = '\ufeffContrat signé 🌿';
  const bytes = encoder.encode(original);
  const request = streamed([...bytes].map(byte => new Uint8Array([byte])), { 'content-length': String(bytes.length) });
  assert.equal(await readRequestText(request), original);
  assert.equal(request.body?.locked, false);
});
test('body reader: an empty request returns an empty string', async () => {
  assert.equal(await readRequestText(new Request('https://body.example.invalid', { method: 'POST' })), '');
});
test('body reader: the byte limit permits exactly the maximum', async () => {
  assert.equal(await readRequestText(streamed([encoder.encode('abcd')]), { maxBytes: 4 }), 'abcd');
});
for (const headers of [{}, { 'content-length': '5' }]) {
  test(`body reader: excessive bytes are refused ${JSON.stringify(headers)}`, async () => {
    await refuses(readRequestText(streamed([encoder.encode('abcde')], headers), { maxBytes: 4 }), 413);
  });
}
for (const length of ['-1', '1.5', 'NaN', '1e2', '9007199254740992']) {
  test(`body reader: invalid Content-Length ${length} is refused`, async () => {
    await refuses(readRequestText(streamed([], { 'content-length': length })), 400);
  });
}
for (const [length, text] of [['2', 'abc'], ['4', 'abc'], ['1', '']]) {
  test(`body reader: declared length ${length} must match ${JSON.stringify(text)}`, async () => {
    await refuses(readRequestText(streamed([encoder.encode(text)], { 'content-length': length })), 400);
  });
}
test('body reader: a declared body cannot be absent', async () => {
  await refuses(readRequestText(new Request('https://body.example.invalid', { method: 'POST', headers: { 'content-length': '2' } })), 400);
});
for (const bytes of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
  test(`body reader: invalid UTF-8 ${bytes.join(',')} is refused`, async () => {
    await refuses(readRequestText(streamed([new Uint8Array(bytes)])), 400);
  });
}
test('body reader: empty chunks cannot keep a request alive indefinitely', async () => {
  await refuses(readRequestText(streamed(Array.from({ length: 65 }, () => new Uint8Array()))), 400);
});
test('body reader: an immediately resolving stream still observes the absolute deadline', async () => {
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(encoder.encode('a')); } });
  const request = new Request('https://body.example.invalid', { method: 'POST', body, duplex: 'half' } as RequestInit);
  await refuses(readRequestText(request, { maxBytes: 1_000_000_000, timeoutMs: 5 }), 408);
  assert.equal(request.body?.locked, false);
});
for (const cancellation of ['resolve', 'reject', 'never']) {
  test(`body reader: a stalled read times out even when cancel=${cancellation}`, { timeout: 500 }, async () => {
    let cancelled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => {}); },
      cancel() {
        cancelled += 1;
        if (cancellation === 'reject') return Promise.reject(new Error('private cancellation detail'));
        if (cancellation === 'never') return new Promise<void>(() => {});
      },
    });
    const request = new Request('https://body.example.invalid', { method: 'POST', body, duplex: 'half' } as RequestInit);
    await refuses(readRequestText(request, { timeoutMs: 15 }), 408);
    assert.equal(cancelled, 1);
    assert.equal(request.body?.locked, false);
  });
}
test('body reader: a pre-aborted request is refused and cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const request = new Request('https://body.example.invalid', { method: 'POST', body: 'text', signal: controller.signal });
  await refuses(readRequestText(request), 408);
});
test('body reader: abort during a stalled read cannot wait for the producer', { timeout: 500 }, async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
  const request = new Request('https://body.example.invalid', { method: 'POST', body, signal: controller.signal, duplex: 'half' } as RequestInit);
  const pending = readRequestText(request);
  controller.abort();
  await refuses(pending, 408);
  assert.equal(request.body?.locked, false);
});
test('body reader: read failures are sanitized and locks released', async () => {
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('private producer detail')); } });
  const request = new Request('https://body.example.invalid', { method: 'POST', body, duplex: 'half' } as RequestInit);
  await assert.rejects(readRequestText(request), (error: unknown) => error instanceof RequestBodyError && error.status === 400 && !error.message.includes('private'));
  assert.equal(request.body?.locked, false);
});
for (const limits of [{ maxBytes: 0 }, { maxBytes: Number.NaN }, { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }]) {
  test(`body reader: invalid internal limits ${JSON.stringify(limits)} fail immediately`, async () => {
    await assert.rejects(readRequestText(streamed([]), limits), RangeError);
  });
}
