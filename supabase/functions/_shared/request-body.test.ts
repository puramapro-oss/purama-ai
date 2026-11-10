import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBoundedBytes, readRequestText, RequestBodyError } from './request-body.ts';

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
for (const interruption of ['abort', 'deadline']) {
  test(`body reader: final handoff honors ${interruption} before returning text`, async t => {
    let clock = 0;
    t.mock.method(performance, 'now', () => clock);
    const controller = new AbortController();
    let reads = 0;
    let interrupted = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        if (reads++ === 0) { stream.enqueue(encoder.encode('complete body')); return; }
        // The final read completes first. Interruption runs while consume() is
        // handing its result through the race to the public reader.
        queueMicrotask(() => queueMicrotask(() => {
          interrupted = true;
          if (interruption === 'abort') controller.abort();
          else clock = 5_001;
        }));
        stream.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request('https://body.example.invalid', {
      method: 'POST', body, signal: controller.signal, duplex: 'half',
    } as RequestInit);
    await refuses(readRequestText(request), 408);
    assert.equal(interrupted, true);
    assert.equal(request.body?.locked, false);
  });
}
test('body reader: read failures are sanitized and locks released', async () => {
  const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('private producer detail')); } });
  const request = new Request('https://body.example.invalid', { method: 'POST', body, duplex: 'half' } as RequestInit);
  await assert.rejects(readRequestText(request), (error: unknown) => error instanceof RequestBodyError && error.status === 400 && !error.message.includes('private'));
  assert.equal(request.body?.locked, false);
});
for (const adapter of ['text', 'bytes'] as const) {
  for (const interruption of ['none', 'deadline', 'abort-handoff'] as const) {
    test(`body reader: rejected read ${adapter} preserves ${interruption} priority`, async t => {
      let clock = 0;
      t.mock.method(performance, 'now', () => clock);
      const controller = new AbortController();
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(stream) {
          reads += 1;
          if (interruption === 'deadline') clock = 5_001;
          stream.error(new Error('private producer detail'));
          if (interruption === 'abort-handoff') queueMicrotask(() => controller.abort());
        },
      }, { highWaterMark: 0 });
      const request = new Request('https://body.example.invalid', {
        method: 'POST', body, signal: controller.signal, duplex: 'half',
      } as RequestInit);
      const pending = adapter === 'text'
        ? readRequestText(request, { maxBytes: 4_096, timeoutMs: 5_000 })
        : readBoundedBytes(request, { maxBytes: 4_096, deadline: 5_000 });
      await assert.rejects(pending, (error: unknown) => error instanceof RequestBodyError
        && error.status === (interruption === 'none' ? 400 : 408)
        && !error.message.includes('private'));
      assert.equal(reads, 1);
      assert.equal(request.body?.locked, false);
      assert.equal(controller.signal.aborted, interruption === 'abort-handoff');
    });
  }
}
for (const limits of [{ maxBytes: 0 }, { maxBytes: Number.NaN }, { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }]) {
  test(`body reader: invalid internal limits ${JSON.stringify(limits)} fail immediately`, async () => {
    await assert.rejects(readRequestText(streamed([]), limits), RangeError);
  });
}
