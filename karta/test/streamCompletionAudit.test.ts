import { afterEach, expect, it, vi } from 'vitest';

const clientUrl = new URL('../../src/lib/sse.ts', import.meta.url).href;
const serverUrl = new URL('../../supabase/functions/_shared/anthropic-stream.ts', import.meta.url).href;
const { parseSSEStream } = await import(clientUrl);
const { streamAnthropicChat } = await import(serverUrl);
const params = { apiKey: 'test-only', model: 'test-only', systemPrompt: 'test',
  messages: [{ role: 'user', content: 'test' }] };
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
const text = frame({ choices: [{ delta: { content: 'partial text' } }] });
const done = 'data: [DONE]\n\n';

afterEach(() => vi.unstubAllGlobals());

it.each(['length', 'content_filter', 'tool_calls', 'function_call', 'unknown', 42])(
  'does not accept finish_reason=%s as a complete text answer', async reason => {
    const wire = text + frame({ choices: [{ delta: {}, finish_reason: reason }] }) + done;
    await expect(parseSSEStream(new Response(wire), () => {})).rejects.toThrow();
  },
);
it.each(['stop', null, undefined])('accepts a completed compatible text stream (%s)', async reason => {
  const wire = text + frame({ choices: [{ delta: {}, finish_reason: reason }] })
    + frame({ choices: [], usage: { completion_tokens: 4 } }) + done;
  expect(await parseSSEStream(new Response(wire), () => {})).toBe('partial text');
});
it('still requires DONE after a normal finish reason', async () => {
  await expect(parseSSEStream(new Response(text
    + frame({ choices: [{ delta: {}, finish_reason: 'stop' }] })), () => {})).rejects.toThrow();
});
it('cancels and releases a rejected stream without rendering its terminal delta', async () => {
  const cancel = vi.fn(); const onDelta = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame({ choices: [
      { delta: { content: 'not a complete answer' }, finish_reason: 'length' },
    ] }) + done));
  }, cancel });
  await expect(parseSSEStream(new Response(body), onDelta)).rejects.toThrow();
  expect(onDelta).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});

it.each(['max_tokens', 'model_context_window_exceeded', 'tool_use', 'pause_turn', 'unknown', 42])(
  'rejects incomplete provider output (%s) through the server/browser chain', async reason => {
    const wire = frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } })
      + frame({ type: 'message_delta', delta: { stop_reason: reason } })
      + frame({ type: 'message_stop' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wire)));
    await expect(parseSSEStream(await streamAnthropicChat(params), () => {})).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it.each(['end_turn', 'stop_sequence', 'refusal', null, undefined])(
  'preserves a terminal provider text response (%s), including refusal text', async reason => {
    const wire = frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'final text' } })
      + frame({ type: 'message_delta', delta: { stop_reason: reason } })
      + frame({ type: 'message_stop' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wire)));
    expect(await parseSSEStream(await streamAnthropicChat(params), () => {})).toBe('final text');
    expect(fetch).toHaveBeenCalledOnce();
  },
);
it('cancels and releases the provider stream after a rejected stop reason', async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(frame({ type: 'message_delta',
      delta: { stop_reason: 'max_tokens' } }) + frame({ type: 'message_stop' })));
  }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  await expect((await streamAnthropicChat(params)).text()).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
});
