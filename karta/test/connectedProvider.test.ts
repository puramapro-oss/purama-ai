import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectedModelClient } from "../src/claude/connected-provider.js";
import type { ConnectedModelLimit, ModelProvider } from "../src/claude/model-catalog.js";
import type { ModelExecutionCapability } from "../src/claude/execution-profile.js";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AnyToolDefinition } from "../src/engine/types.js";

const native = ["openai", "xai", "google"] as const;
const input = (model = "exact-model", patch: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput => ({
  systemPrompt: "Aide à vérifier la décision.", context: { question: "Vérification" }, tools: [], agentType: "test",
  preferences: { model, reflection: "standard", speed: "standard" }, ...patch,
});
const reply = (provider: ModelProvider, patch = {}): Record<string, unknown> => provider === "google" ? {
  modelVersion: "exact-model", responseId: "response_1",
  candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "Conclusion vérifiable." }] } }],
  usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 4, candidatesTokenCount: 6,
    thoughtsTokenCount: 2, toolUsePromptTokenCount: 0, totalTokenCount: 20 }, ...patch,
} : {
  model: "exact-model", id: "response_1", status: "completed", error: null, incomplete_details: null,
  output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Conclusion vérifiable." }] }],
  usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens: 6,
    output_tokens_details: { reasoning_tokens: 2 }, total_tokens: provider === "xai" ? 20 : 18 }, ...patch,
};
function client(provider: typeof native[number], response: Record<string, unknown> = reply(provider), options: {
  limits?: Partial<ConnectedModelLimit>; capability?: Partial<ModelExecutionCapability>; timeoutMs?: number;
  transport?: typeof fetch;
} = {}) {
  const transport = options.transport ?? vi.fn<typeof fetch>(async () => Response.json(response));
  const model = options.limits?.model ?? "exact-model";
  return { transport, service: createConnectedModelClient({
    apiKeys: { [provider]: `private-${provider}` },
    allowed: [{ provider, model, maxOutputTokens: 16_384, ...options.limits }],
    modelCatalog: [{ model, maxOutputTokens: 16_384, reasoning: "none", ...options.capability }],
    fetch: transport, timeoutMs: options.timeoutMs,
  }) };
}
const tool = { name: "read_record", description: "Lecture autorisée en aval", sensitive: false,
  inputSchema: { type: "object", properties: { id: { type: "integer", minimum: 1 },
    filter: { type: "object", properties: { exact: { type: "boolean" } }, required: ["exact"], additionalProperties: false } },
    required: ["id"], additionalProperties: false },
  execute: vi.fn(),
} as unknown as AnyToolDefinition;
const functionReply = (provider: typeof native[number], args: unknown, name = "read_record") =>
  provider === "google" ? reply(provider, { candidates: [{ finishReason: "STOP", content: { role: "model",
    parts: [{ functionCall: { id: "call_1", name, args } }] } }] })
    : reply(provider, { output: [{ type: "function_call", call_id: "call_1", name, arguments: JSON.stringify(args) }] });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("native IAO connected decision adapters", () => {
  it.each(native)("selects the exact %s account, endpoint and normalized receipt", async provider => {
    const { service, transport } = client(provider);
    const onUsage = vi.fn(), onExecutionPlan = vi.fn();
    expect(await service.decide(input("exact-model", { onUsage, onExecutionPlan }))).toMatchObject({
      summary: "Conclusion vérifiable.", mock: false, toolCalls: [], requiresApproval: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(transport).mock.calls[0];
    expect(url).toBe(provider === "google" ? "https://generativelanguage.googleapis.com/v1beta/models/exact-model:generateContent"
      : provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.x.ai/v1/responses");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit" });
    const headers = new Headers(init?.headers);
    expect(headers.get(provider === "google" ? "x-goog-api-key" : "authorization"))
      .toBe(provider === "google" ? "private-google" : `Bearer private-${provider}`);
    expect(headers.has(provider === "google" ? "authorization" : "x-goog-api-key")).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(JSON.stringify(body)).not.toContain(`private-${provider}`);
    expect(body).not.toHaveProperty("output_config");
    expect(body).not.toHaveProperty("thinking");
    if (provider !== "google") expect(body).toMatchObject({ model: "exact-model", store: false, max_output_tokens: 1024 });
    expect(onExecutionPlan).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ version: 3, routeKind: provider,
      requestedModel: "exact-model", responseModel: "exact-model", responseId: "response_1", inputTokens: 12,
      outputTokens: 6, cacheReadInputTokens: 4, reasoningOutputTokens: 2 }));
  });

  it.each(native)("records a billed %s mismatch before rejecting it, without retry", async provider => {
    const { service, transport } = client(provider, reply(provider, provider === "google"
      ? { modelVersion: "unapproved-model" } : { model: "unapproved-model" }));
    const onUsage = vi.fn();
    await expect(service.decide(input("exact-model", { onUsage }))).rejects.toThrow("confirmé le modèle");
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ responseModel: "unapproved-model" }));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(native)("accepts only host-qualified %s snapshot aliases", async provider => {
    const { service } = client(provider, reply(provider, provider === "google"
      ? { modelVersion: "model-snapshot-2026" } : { model: "model-snapshot-2026" }), {
      limits: { responseModels: ["model-snapshot-2026"] },
    });
    await expect(service.decide(input())).resolves.toHaveProperty("summary", "Conclusion vérifiable.");
  });

  it("recognizes Google's documented models/ resource prefix without accepting arbitrary aliases", async () => {
    const { service, transport } = client("google", reply("google"), { limits: { model: "models/exact-model" } });
    await expect(service.decide(input("models/exact-model"))).resolves.toHaveProperty("mock", false);
    expect(vi.mocked(transport).mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/exact-model:generateContent");
  });

  it.each(native)("maps qualified %s reflection to its native parameters", async provider => {
    const profile = { reasoning: "adaptive", effortLevels: ["low", "medium", "high"] } as const;
    const { service, transport } = client(provider, reply(provider), {
      limits: { ...profile, effortLevels: [...profile.effortLevels] },
      capability: { ...profile, effortLevels: [...profile.effortLevels] },
    });
    await service.decide(input("exact-model", { preferences: { model: "exact-model", reflection: "deep" } }));
    const body = JSON.parse(String(vi.mocked(transport).mock.calls[0][1]?.body));
    expect(provider === "google" ? body.generationConfig.thinkingConfig : body.reasoning)
      .toEqual(provider === "google" ? { thinkingLevel: "HIGH" } : { effort: "high" });
    expect(provider === "google" ? body.generationConfig.maxOutputTokens : body.max_output_tokens).toBe(8192);
  });

  it("maps only qualified Gemini budget thinking to a numeric native budget", async () => {
    const { service, transport } = client("google", reply("google"), {
      limits: { reasoning: "budget" }, capability: { reasoning: "budget" },
    });
    await service.decide(input("exact-model", { preferences: { model: "exact-model", reflection: "deep" } }));
    expect(JSON.parse(String(vi.mocked(transport).mock.calls[0][1]?.body)).generationConfig.thinkingConfig)
      .toEqual({ thinkingBudget: 7168 });
  });

  it.each(native)("validates all %s tool arguments without executing a handler", async provider => {
    const { service } = client(provider, functionReply(provider, { id: 3, filter: { exact: true } }));
    const value = await service.decide(input("exact-model", { tools: [tool, tool] }));
    expect(value.toolCalls).toEqual([{ tool: "read_record", params: { id: 3, filter: { exact: true } } }]);
    expect(tool.execute).not.toHaveBeenCalled();
    for (const args of [null, {}, { id: 0 }, { id: 3, filter: { exact: "false" } }, { id: 3, extra: true }]) {
      const rejected = client(provider, functionReply(provider, args));
      await expect(rejected.service.decide(input("exact-model", { tools: [tool] }))).rejects.toThrow("aucune action");
    }
  });

  it.each(native)("rejects ambiguous %s tool names before sending a request", async provider => {
    const { service, transport } = client(provider);
    await expect(service.decide(input("exact-model", { tools: [tool, { ...tool }] }))).rejects.toThrow("ambigu");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["openai", "xai"] as const)("rejects every incomplete/refused %s response but records its usage", async provider => {
    const bad = [
      { status: "incomplete" }, { status: "in_progress" }, { status: "failed" },
      { error: { message: "private error" } }, { incomplete_details: { reason: "max_output_tokens" } },
      { output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] },
      { output: [{ type: "web_search_call", status: "completed" }] }, { output: [] },
      { output: [{ type: "function_call", call_id: "a", name: "read_record", arguments: "{" }] },
      { output: [{ type: "function_call", call_id: "a", name: "read_record", arguments: '{"id":1}' },
        { type: "function_call", call_id: "a", name: "read_record", arguments: '{"id":2}' }] },
    ];
    for (const patch of bad) {
      const { service, transport } = client(provider, reply(provider, patch));
      const onUsage = vi.fn();
      await expect(service.decide(input("exact-model", { tools: [tool], onUsage }))).rejects.toThrow("aucune action");
      expect(onUsage).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects blocked/truncated/ambiguous Gemini candidates and unsupported modalities", async () => {
    const bad = [
      { error: { message: "provider error" } }, { promptFeedback: "SAFETY" },
      { promptFeedback: { blockReason: "SAFETY" } }, { candidates: [] },
      { candidates: [{ finishReason: "MAX_TOKENS", content: { role: "model", parts: [{ text: "partial" }] } }] },
      { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ inlineData: { data: "..." } }] } }] },
      { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ text: "thinking only", thought: true }] } }] },
    ];
    for (const patch of bad) {
      const { service } = client("google", reply("google", patch));
      const onUsage = vi.fn();
      await expect(service.decide(input("exact-model", { onUsage }))).rejects.toThrow("aucune action");
      expect(onUsage).toHaveBeenCalledTimes(1);
    }
  });

  it("does not expose Google's thought parts or opaque signatures as an answer", async () => {
    const { service } = client("google", reply("google", { candidates: [{ finishReason: "STOP", content: {
      role: "model", parts: [{ thought: true, text: "private reasoning" }, { text: "Final answer", thoughtSignature: "opaque" }],
    } }] }));
    expect((await service.decide(input())).summary).toBe("Final answer");
  });

  it("rejects malformed thought flags and signatures instead of exposing reasoning as final text", async () => {
    for (const part of [{ thought: "true", text: "private reasoning" }, { thoughtSignature: {}, text: "text" },
      { thought: true, text: "private reasoning", inlineData: { data: "..." } }]) {
      const { service } = client("google", reply("google", { candidates: [{ finishReason: "STOP", content: {
        role: "model", parts: [part, { text: "final" }],
      } }] }));
      await expect(service.decide(input())).rejects.toThrow("aucune action");
    }
  });

  it.each(native)("refuses %s capabilities beyond the host's qualified profile before any network", provider => {
    expect(() => client(provider, reply(provider), {
      capability: { reasoning: "adaptive", effortLevels: ["high"] },
    })).toThrow("non qualifié");
    expect(() => client(provider, reply(provider), {
      limits: { reasoning: "adaptive", effortLevels: ["low"] },
      capability: { reasoning: "adaptive", effortLevels: ["low", "high"] },
    })).toThrow("non qualifié");
    expect(() => client(provider, reply(provider), {
      capability: { programmaticToolCalling: true },
    })).toThrow("non qualifié");
  });

  it("does not infer or fall back to a model when selection is absent or unqualified", async () => {
    const { service, transport } = client("openai");
    await expect(service.decide(input("exact-model", { preferences: undefined }))).rejects.toThrow("Sélection");
    await expect(service.decide(input("other-model"))).rejects.toThrow("non qualifié");
    await expect(service.decide(input("exact-model", { preferences: { model: "exact-model", reflection: "deep" } })))
      .rejects.toThrow("réflexion approfondie");
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts before network without exposing the caller's abort reason", async () => {
    const { service, transport } = client("openai");
    const controller = new AbortController(); controller.abort("private cancellation");
    await expect(service.decide(input("exact-model", { signal: controller.signal }))).rejects.toThrow("annulé");
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds a stalled response body and never retries an ambiguous paid request", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const transport = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const { service } = client("xai", {}, { transport, timeoutMs: 1000 });
    const onUsage = vi.fn();
    const pending = expect(service.decide(input("exact-model", { onUsage }))).rejects.toThrow("délai dépassé");
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(onUsage).not.toHaveBeenCalled();
  });
});
