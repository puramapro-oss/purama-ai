import { afterAll, afterEach, it, vi } from 'vitest';
import fc from 'fast-check';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const clientUrl = new URL('../../src/lib/sse.ts', import.meta.url).href;
const serverUrl = new URL('../../supabase/functions/_shared/anthropic-stream.ts', import.meta.url).href;
const { parseSSEStream } = await import(clientUrl);
const { streamAnthropicChat } = await import(serverUrl);
const runs = Number(process.env.IAO_PROPERTY_RUNS ?? 200);
const seed = Number(process.env.IAO_PROPERTY_SEED ?? 20260919);
assert(Number.isSafeInteger(runs) && runs > 0 && runs <= 100_000);
assert(Number.isSafeInteger(seed));
const results: object[] = [];
const sourcePaths = ['../src/lib/sse.ts', '../supabase/functions/_shared/anthropic-stream.ts', '../supabase/functions/_shared/sse-data.ts', 'test/generative.test.ts', 'package-lock.json'];
const sourceHashes = Object.fromEntries(sourcePaths.map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]));
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  if (process.env.IAO_PROPERTY_REPORT) writeFileSync(process.env.IAO_PROPERTY_REPORT, JSON.stringify({
    suite: 'iao-stream-contracts', kind: 'generated software inputs, not model benchmarks',
    at: new Date().toISOString(), node: process.version, fastCheck: fc.__version,
    expectedProperties: 4, runsPerProperty: runs, sourceHashes, results,
  }, null, 2) + '\n');
});
function campaign<T>(name: string, id: number, arbitrary: fc.Arbitrary<T>, check: (value: T) => Promise<void>) {
  it(name, async () => {
    const started = performance.now();
    const r = await fc.check(fc.asyncProperty(arbitrary, check), { numRuns: runs, seed: seed + id });
    const error = r.errorInstance instanceof Error ? r.errorInstance.message : r.errorInstance == null ? null : String(r.errorInstance);
    results.push({ name, seed: r.seed, numRuns: r.numRuns, numSkips: r.numSkips,
      failed: r.failed, numShrinks: r.numShrinks, counterexample: r.counterexample,
      counterexamplePath: r.counterexamplePath, error,
      durationMs: Math.round(performance.now() - started) });
    assert(!r.failed, `seed=${r.seed} path=${r.counterexamplePath}: ${error}`);
  }, 240_000);
}
const scenario = fc.record({
  parts: fc.array(fc.string({ unit: 'grapheme', maxLength: 12 }), { minLength: 1, maxLength: 4 }),
  // CR followed immediately by LF is one line ending, not two; exclude that ambiguous pair.
  boundary: fc.constantFrom('\n\n', '\r\r', '\r\n\r\n', '\r\n\n', '\n\r', '\n\r\n'),
  chunk: fc.integer({ min: 1, max: 127 }), space: fc.boolean(), comment: fc.boolean(),
});
type Scenario = typeof scenario extends fc.Arbitrary<infer T> ? T : never;
const encoder = new TextEncoder();
function inputResponse(text: string, size: number) {
  const bytes = encoder.encode(text); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(offset + size, bytes.length);
    controller.enqueue(bytes.subarray(offset, end)); offset = end;
  } }));
}
function frame(data: string, s: Scenario) {
  return (s.comment ? ':keepalive\n' : '') + 'data:' + (s.space ? ' ' : '') + data + s.boundary;
}
function clientWire(s: Scenario) {
  return s.parts.map(content => frame(JSON.stringify({ choices: [{ delta: { content } }] }), s)).join('');
}
const params = { apiKey: 'test-only', model: 'test-only', systemPrompt: 'test', messages: [{ role: 'user', content: 'test' }] };
campaign('browser preserves Unicode through arbitrary valid SSE delimiters and byte chunks', 10, scenario, async s => {
  let rendered = '';
  const value = await parseSSEStream(inputResponse(clientWire(s) + frame('[DONE]', s), s.chunk), (v: string) => { rendered = v; });
  assert.equal(value, s.parts.join(''));
  assert.equal(rendered, value);
});
campaign('provider to browser chain preserves content and confirmed completion', 11, scenario, async s => {
  const wire = s.parts.map(text => frame(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), s)).join('')
    + frame(JSON.stringify({ type: 'message_stop' }), s);
  vi.stubGlobal('fetch', async () => inputResponse(wire, s.chunk));
  const value = await parseSSEStream(await streamAnthropicChat(params), () => {});
  assert.equal(value, s.parts.join(''));
});
campaign('unconfirmed browser responses always reject, including done-shaped text', 12, scenario, async s => {
  const wire = clientWire({ ...s, parts: [...s.parts, '[DONE]'] });
  await assert.rejects(parseSSEStream(inputResponse(wire, s.chunk), () => {}));
});
campaign('provider errors propagate without a false completion', 13, scenario, async s => {
  const wire = s.parts.map(text => frame(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), s)).join('')
    + frame(JSON.stringify({ type: 'error', error: { message: 'synthetic-error' } }), s)
    + frame(JSON.stringify({ type: 'message_stop' }), s);
  vi.stubGlobal('fetch', async () => inputResponse(wire, s.chunk));
  await assert.rejects(parseSSEStream(await streamAnthropicChat(params), () => {}));
});
