/**
 * Convert Anthropic SSE to the existing OpenAI-compatible text stream.
 * Only message_stop is a successful completion; HTTP 200 may still contain errors.
 */
export async function streamAnthropicChat(params: {
  apiKey: string; model: string; systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens?: number; signal?: AbortSignal; timeoutMs?: number;
}): Promise<Response> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid stream timeout");
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new Error("AI stream timed out")), timeoutMs);
  const parentAbort = () => abort.abort(params.signal?.reason);
  params.signal?.addEventListener("abort", parentAbort, { once: true });
  if (params.signal?.aborted) parentAbort();
  const cleanup = () => { clearTimeout(timeout); params.signal?.removeEventListener("abort", parentAbort); };
  let upstream: Response;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: abort.signal,
      headers: { "x-api-key": params.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: params.model, max_tokens: params.maxTokens ?? 1024,
        system: params.systemPrompt, messages: params.messages, stream: true,
      }),
    });
  } catch (error) { cleanup(); throw error; }
  if (!upstream.ok || !upstream.body) {
    cleanup();
    await upstream.body?.cancel();
    return new Response(JSON.stringify({ error: "AI provider unavailable" }), {
      status: upstream.ok ? 502 : upstream.status, headers: { "Content-Type": "application/json" },
    });
  }
  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  abort.signal.addEventListener("abort", onAbort, { once: true });
  async function* convert(): AsyncGenerator<Uint8Array> {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    try {
      while (true) {
        abort.signal.throwIfAborted();
        const part = await reader.read();
        abort.signal.throwIfAborted();
        if (part.done) throw new Error("AI stream interrupted before message_stop");
        buffer += decoder.decode(part.value, { stream: true });
        let separator: RegExpExecArray | null;
        while ((separator = /\r\n\r\n|\n\n|\r\r/.exec(buffer))) {
          if (separator.index > 262_144) throw new Error("AI stream event too large");
          const frame = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          const data = frame.split(/\r\n|\r|\n/).filter(line => line.startsWith("data:"))
            .map(line => line.slice(5).replace(/^ /, "")).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (!event || typeof event !== "object" || typeof event.type !== "string") throw new Error("Invalid AI stream event");
          if (event.type === "error") throw new Error("AI provider reported a stream error");
          if (event.type === "message_stop") {
            cleanup();
            await reader.cancel().catch(() => undefined);
            yield encoder.encode("data: [DONE]\n\n");
            return;
          }
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            if (typeof event.delta.text !== "string") throw new Error("Invalid AI text delta");
            if (event.delta.text) yield encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: event.delta.text } }] })}\n\n`);
          }
        }
        if (buffer.length > 262_144) throw new Error("AI stream event too large");
      }
    } finally {
      cleanup();
      abort.signal.removeEventListener("abort", onAbort);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const iterator = convert();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const next = await iterator.next(); if (next.done) controller.close(); else controller.enqueue(next.value); }
      catch (error) { controller.error(error); }
    },
    async cancel(reason) { abort.abort(reason); cleanup(); await iterator.return(undefined); },
  });
  return new Response(body, { status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform" } });
}
