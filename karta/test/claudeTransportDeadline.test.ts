import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../src/engine/types.js";

const PRIVATE = "PRIVATE_TRANSPORT_CONTENT_MUST_NOT_ESCAPE";
const h = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(), execute: vi.fn(), finish: vi.fn(), record: vi.fn(), pending: vi.fn(), notify: vi.fn(),
}));
// Exercise the installed SDK, its retry policy and its real Response parser.
// Only the network and durable/external engine boundaries are replaced.
vi.mock("../src/config.js", async original => {
  const actual = await original<typeof import("../src/config.js")>();
  return { ...actual, config: { ...actual.config, mockClaude: false,
    anthropicApiKey: "inert-transport-test-key", anthropicTimeoutMs: 1_000,
    anthropicModelMain: "transport-main", anthropicModelFast: "transport-fast" } };
});
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({ userId: "transport-user", agentType: "legal", isEnabled: true,
    killSwitch: false, simulationMode: false, autonomyLevel: 3 }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "transport-run", finish: h.finish }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { createRealClaudeClient } = await import("../src/claude/real.js");
const { config } = await import("../src/config.js");
const { runAgentCycle } = await import("../src/engine/loop.js");
const definition: AgentDefinition = {
  type: "legal", systemPrompt: "Choose an inert test action.", buildContext: async () => ({}),
  tools: [{ name: "act", description: "Inert action", sensitive: false, execute: h.execute,
    inputSchema: { type: "object", properties: { label: { type: "string", minLength: 1 } },
      required: ["label"], additionalProperties: false } }],
};
const input = { systemPrompt: definition.systemPrompt, context: { privateContext: PRIVATE },
  tools: definition.tools, agentType: definition.type };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function message(toolCalls = false) {
  return { id: "msg_inert", type: "message", role: "assistant", model: "inert-model",
    stop_reason: toolCalls ? "tool_use" : "end_turn", stop_sequence: null,
    content: toolCalls ? [
      { type: "text", text: "Prepare, then verify." },
      { type: "tool_use", id: "toolu_1", name: "act", input: { label: "prepare" } },
      { type: "tool_use", id: "toolu_2", name: "act", input: { label: "verify" } },
    ] : [{ type: "text", text: "No action needed." }], usage: { input_tokens: 12, output_tokens: 24 } };
}
function response(body: unknown = message(), status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function observe<T>(promise: Promise<T>) {
  return promise.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
}
function expectSafeFailure(result: { ok: boolean; error?: unknown }) {
  expect(result.ok).toBe(false);
  expect(result.error).toBeInstanceOf(Error);
  expect(String(result.error)).not.toContain(PRIVATE);
}
function hangingBody(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { response: new Response(stream, { status, headers: { "content-type": "application/json" } }),
    finish(body: unknown) { controller.enqueue(new TextEncoder().encode(JSON.stringify(body))); controller.close(); } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.clearAllMocks();
  h.fetch.mockReset();
  h.fetch.mockResolvedValue(response());
  vi.stubGlobal("fetch", h.fetch);
  vi.stubEnv("ANTHROPIC_LOG", "debug");
  for (const level of ["debug", "info", "warn", "error", "log"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
  config.anthropicTimeoutMs = 1_000;
  h.execute.mockResolvedValue({ ok: true });
  h.finish.mockResolvedValue(undefined); h.record.mockResolvedValue(undefined);
  h.pending.mockResolvedValue("pending-transport"); h.notify.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("real SDK transport deadline", () => {
  it.each([408, 409, 429, 500])("HTTP %i makes exactly one provider attempt and exposes no provider body", async status => {
    const onUsage = vi.fn();
    h.fetch.mockImplementation(async () => response({ type: "error", error: { type: "api_error", message: PRIVATE } }, status));
    const result = observe(createRealClaudeClient().decide({ ...input, onUsage }));
    await vi.runAllTimersAsync();
    expect.soft(h.fetch).toHaveBeenCalledOnce();
    expectSafeFailure(await result);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not inspect context or send a pre-cancelled request, and hides its private cancellation reason", async () => {
    const readContext = vi.fn(() => PRIVATE); const onUsage = vi.fn();
    const context = { get privateContext() { return readContext(); } };
    const parent = new AbortController(); parent.abort(new Error(PRIVATE));
    // A non-sensitive agent forces selectModel to inspect context if admission is bypassed.
    const result = await observe(createRealClaudeClient().decide({ ...input,
      agentType: "transport-basic", context, signal: parent.signal, onUsage }));
    expect(readContext).not.toHaveBeenCalled();
    expect.soft(h.fetch).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
    expectSafeFailure(result);
  });

  it("sanitizes a synchronous routing failure without a provider attempt or a receipt", async () => {
    const readContext = vi.fn(() => { throw new Error(PRIVATE); }); const onUsage = vi.fn();
    const context = { get privateContext() { return readContext(); } };
    const result = await observe(createRealClaudeClient().decide({ ...input,
      agentType: "transport-basic", context, onUsage }));
    expect(readContext).toHaveBeenCalledOnce();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(onUsage).not.toHaveBeenCalled();
    expectSafeFailure(result);
  });

  it("bounds an uncooperative fetch and ignores its later response", async () => {
    const onUsage = vi.fn();
    const entered = deferred<void>(); const network = deferred<Response>();
    let signal: AbortSignal | undefined | null;
    h.fetch.mockImplementation((_url, options) => { signal = options?.signal; entered.resolve(); return network.promise; });
    const result = observe(createRealClaudeClient().decide({ ...input, onUsage }));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expectSafeFailure(await result);
    expect(signal?.aborted).toBe(true);
    expect(onUsage).not.toHaveBeenCalled();
    network.resolve(response(message(true)));
    await vi.runAllTimersAsync();
    expectSafeFailure(await result);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([200, 429])("bounds the whole HTTP %i body after headers have arrived", async status => {
    const onUsage = vi.fn();
    const body = hangingBody(status); const entered = deferred<void>();
    let signal: AbortSignal | undefined | null;
    h.fetch.mockImplementation(async (_url, options) => { signal = options?.signal; entered.resolve(); return body.response; });
    const result = observe(createRealClaudeClient().decide({ ...input, onUsage }));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    expectSafeFailure(await result);
    expect(signal?.aborted).toBe(true);
    expect(onUsage).not.toHaveBeenCalled();
    body.finish(status === 200 ? message(true) : { error: { message: PRIVATE } });
    await vi.runAllTimersAsync();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("cancels a pending body promptly without waiting for the deadline", async () => {
    const onUsage = vi.fn();
    const parent = new AbortController(); const body = hangingBody(); const entered = deferred<void>();
    let signal: AbortSignal | undefined | null;
    h.fetch.mockImplementation(async (_url, options) => { signal = options?.signal; entered.resolve(); return body.response; });
    const result = observe(createRealClaudeClient().decide({ ...input, signal: parent.signal, onUsage }));
    await entered.promise;
    parent.abort(new Error(PRIVATE));
    expectSafeFailure(await result);
    expect(signal?.aborted).toBe(true);
    expect(performance.now()).toBe(0);
    expect(onUsage).not.toHaveBeenCalled();
    body.finish(message());
    await vi.runAllTimersAsync();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("rejects a late handoff even before the deadline timer gets CPU time", async () => {
    const onUsage = vi.fn();
    const entered = deferred<void>(); const network = deferred<Response>();
    h.fetch.mockImplementation(() => { entered.resolve(); return network.promise; });
    const result = observe(createRealClaudeClient().decide({ ...input, onUsage }));
    await entered.promise;
    vi.spyOn(performance, "now").mockReturnValue(1_001);
    network.resolve(response());
    expectSafeFailure(await result);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("does not retry a connection failure or return its private cause", async () => {
    const onUsage = vi.fn();
    h.fetch.mockRejectedValue(new Error(PRIVATE));
    const result = observe(createRealClaudeClient().decide({ ...input, onUsage }));
    await vi.runAllTimersAsync();
    expectSafeFailure(await result);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("isolates cancellation and receipts between simultaneous requests on the same client", async () => {
    const successfulUsage = vi.fn(); const cancelledUsage = vi.fn();
    const parent = new AbortController(); const entered = deferred<void>();
    const left = deferred<Response>(); const right = deferred<Response>();
    const signals: Array<AbortSignal | undefined | null> = [];
    h.fetch.mockImplementation((_url, options) => {
      signals.push(options?.signal); if (signals.length === 2) entered.resolve();
      return signals.length === 1 ? left.promise : right.promise;
    });
    const client = createRealClaudeClient();
    const successful = observe(client.decide({ ...input, onUsage: successfulUsage }));
    const cancelled = observe(client.decide({ ...input, agentType: "transport-basic",
      signal: parent.signal, onUsage: cancelledUsage }));
    await entered.promise; parent.abort(new Error(PRIVATE));
    expectSafeFailure(await cancelled);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(true);
    expect(successfulUsage).not.toHaveBeenCalled();
    expect(cancelledUsage).not.toHaveBeenCalled();
    left.resolve(response({ ...message(), id: "msg_successful", model: "served-successful",
      usage: { input_tokens: 34, output_tokens: 56 } }));
    const result = await successful;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary).toBe("No action needed.");
    expect(successfulUsage).toHaveBeenCalledOnce();
    expect(successfulUsage).toHaveBeenCalledWith(expect.objectContaining({
      requestedModel: "transport-main", responseModel: "served-successful",
      responseId: "msg_successful", inputTokens: 34, outputTokens: 56,
    }));
    right.resolve(response({ ...message(), id: "msg_cancelled", model: "served-cancelled",
      usage: { input_tokens: 78, output_tokens: 90 } }));
    await vi.runAllTimersAsync();
    expect(cancelledUsage).not.toHaveBeenCalled();
    expect(successfulUsage).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves a complete decision and tool order without logging private content in SDK debug mode", async () => {
    const onUsage = vi.fn();
    h.fetch.mockResolvedValue(response(message(true)));
    const result = await createRealClaudeClient().decide({ ...input, onUsage });
    expect(result).toMatchObject({ summary: "Prepare, then verify.", mock: false,
      toolCalls: [{ tool: "act", params: { label: "prepare" } }, { tool: "act", params: { label: "verify" } }] });
    expect(onUsage).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ requestedModel: "transport-main",
      responseModel: "inert-model", responseId: "msg_inert", inputTokens: 12, outputTokens: 24 }));
    const logs = [console.debug, console.info, console.warn, console.error, console.log].map(method => vi.mocked(method).mock.calls);
    expect(JSON.stringify([logs, onUsage.mock.calls])).not.toContain(PRIVATE);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it.each([0, 999, 1_000.5, 120_001, NaN, Infinity])("rejects invalid timeout %s before any provider attempt", timeout => {
    config.anthropicTimeoutMs = timeout;
    expect(() => createRealClaudeClient()).toThrow();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("real SDK transport through the real KARTA cycle", () => {
  it("keeps a timed-out durable cycle closed when a valid tool decision arrives late", async () => {
    const entered = deferred<void>(); const network = deferred<Response>();
    h.fetch.mockImplementation(() => { entered.resolve(); return network.promise; });
    const running = runAgentCycle("transport-user", definition, { type: "manual", source: "transport-test" }, "transport-delivery-key");
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await running;
    expect(result).toMatchObject({ status: "error", retryable: false, toolsUsed: [] });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledWith(expect.objectContaining({ status: "error", retryable: false, toolsUsed: [] }));
    network.resolve(response(message(true)));
    await vi.runAllTimersAsync();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0]?.[0].modelUsage).toBeUndefined();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(JSON.stringify([result, h.finish.mock.calls, h.record.mock.calls])).not.toContain(PRIVATE);
  });
});
