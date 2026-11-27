import { describe, expect, it, vi } from "vitest";
import { normalizeModelUsage, normalizeNativeModelUsage, programmaticUsageEnvelope } from "../src/claude/usage.js";

const providers = ["openai", "xai", "google"] as const;
const counters = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens",
  "cacheCreation5mInputTokens", "cacheCreation1hInputTokens", "reasoningOutputTokens", "toolUseInputTokens", "totalTokens"] as const;
const responses = (provider: typeof providers[number], count: unknown) => provider === "google"
  ? { modelVersion: "fixture-snapshot", responseId: "response_fixture", usageMetadata: {
    promptTokenCount: count, candidatesTokenCount: count, cachedContentTokenCount: count,
    thoughtsTokenCount: count, toolUsePromptTokenCount: count, totalTokenCount: count,
  } }
  : { model: "fixture-snapshot", id: "response_fixture", usage: {
    input_tokens: count, output_tokens: count, total_tokens: count,
    input_tokens_details: { cached_tokens: count }, output_tokens_details: { reasoning_tokens: count },
  } };

describe("native provider usage observations", () => {
  it("records OpenAI reasoning and cache subsets without adding either again", () => {
    const response = { id: "resp_openai", model: "fixture-snapshot", usage: {
      input_tokens: 100, output_tokens: 30, total_tokens: 130,
      input_tokens_details: { cached_tokens: 25 }, output_tokens_details: { reasoning_tokens: 20 },
    } };
    expect(normalizeNativeModelUsage(response, "fixture-model", "openai")).toEqual({
      version: 3, apiFormat: "openai_responses", routeKind: "openai", requestedModel: "fixture-model",
      responseModel: "fixture-snapshot", responseId: "resp_openai", inputTokens: 100, outputTokens: 30,
      cacheReadInputTokens: 25, cacheCreationInputTokens: null, cacheCreation5mInputTokens: null,
      cacheCreation1hInputTokens: null, reasoningOutputTokens: 20, toolUseInputTokens: null, totalTokens: 130,
    });
  });

  it("keeps xAI visible output distinct from its additional reasoning tokens", () => {
    const receipt = normalizeNativeModelUsage({ id: "resp_xai", model: "fixture-model", usage: {
      input_tokens: 32, output_tokens: 9, total_tokens: 151,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 110 },
    } }, "fixture-model", "xai");
    expect(receipt).toMatchObject({ apiFormat: "xai_responses", routeKind: "xai", inputTokens: 32,
      outputTokens: 9, reasoningOutputTokens: 110, totalTokens: 151, cacheReadInputTokens: 0 });
  });

  it("preserves every separate Gemini input, thought, candidate and total counter", () => {
    const receipt = normalizeNativeModelUsage({ modelVersion: "fixture-snapshot", responseId: "gemini_fixture", usageMetadata: {
      promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 8,
      thoughtsTokenCount: 30, toolUsePromptTokenCount: 5, totalTokenCount: 143,
    } }, "fixture-model", "google");
    expect(receipt).toMatchObject({ apiFormat: "gemini_generate_content", routeKind: "google", inputTokens: 100,
      outputTokens: 8, cacheReadInputTokens: 40, reasoningOutputTokens: 30, toolUseInputTokens: 5, totalTokens: 143,
      responseModel: "fixture-snapshot", responseId: "gemini_fixture" });
  });

  it.each(providers)("preserves zero and leaves absent or unsupported counters unknown (%s)", provider => {
    const zero = normalizeNativeModelUsage(responses(provider, 0), "fixture-model", provider);
    expect(zero.inputTokens).toBe(0);
    expect(zero.outputTokens).toBe(0);
    expect(zero.reasoningOutputTokens).toBe(0);
    expect(zero.totalTokens).toBe(0);
    expect(zero.cacheReadInputTokens).toBe(0);
    expect(zero.cacheCreationInputTokens).toBeNull();
    expect(zero.cacheCreation5mInputTokens).toBeNull();
    expect(zero.cacheCreation1hInputTokens).toBeNull();
    expect(zero.toolUseInputTokens).toBe(provider === "google" ? 0 : null);
    const missing = normalizeNativeModelUsage({}, "fixture-model", provider);
    for (const key of counters) expect(missing[key]).toBeNull();
    expect(missing.responseId).toBeNull();
    expect(missing.responseModel).toBeNull();
  });

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "0", true, [], {}, undefined, null])("rejects malformed counters %j", value => {
    for (const provider of providers) {
      const receipt = normalizeNativeModelUsage(responses(provider, value), "fixture-model", provider);
      for (const key of counters) expect(receipt[key]).toBeNull();
    }
  });

  it.each(providers)("records contradictory observations without synthesizing corrected totals (%s)", provider => {
    const receipt = normalizeNativeModelUsage(responses(provider, 12), "fixture-model", provider);
    expect(receipt.inputTokens).toBe(12);
    expect(receipt.outputTokens).toBe(12);
    expect(receipt.totalTokens).toBe(12);
    const noTotal = provider === "google"
      ? { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, thoughtsTokenCount: 5 } }
      : { usage: { input_tokens: 3, output_tokens: 4, output_tokens_details: { reasoning_tokens: 5 } } };
    expect(normalizeNativeModelUsage(noTotal, "fixture-model", provider).totalTokens).toBeNull();
  });

  it.each(providers)("keeps only immutable allowlisted metadata (%s)", provider => {
    const trap = vi.fn(() => { throw new Error("Private field accessed"); });
    const response = responses(provider, 3);
    for (const key of ["output", "candidates", "reasoning", "headers", "metadata", "api_key"]) {
      Object.defineProperty(response, key, { enumerable: true, get: trap });
    }
    const receipt = normalizeNativeModelUsage(response, "fixture-model", provider);
    expect(Object.keys(receipt).sort()).toEqual(["version", "apiFormat", "routeKind", "requestedModel", "responseModel", "responseId", ...counters].sort());
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Reflect.set(receipt, "inputTokens", 999)).toBe(false);
    expect(trap).not.toHaveBeenCalled();
  });

  it.each(providers)("ignores inherited fields, accessors and proxies without executing them (%s)", provider => {
    const trap = vi.fn(() => { throw new Error("Untrusted object evaluated"); });
    const usage = Object.create({ input_tokens: 999, promptTokenCount: 999 });
    for (const key of ["output_tokens", "candidatesTokenCount", "input_tokens_details", "thoughtsTokenCount"]) {
      Object.defineProperty(usage, key, { enumerable: true, get: trap });
    }
    const response = provider === "google" ? { usageMetadata: usage } : { usage };
    for (const candidate of [response, new Proxy(responses(provider, 0), { getOwnPropertyDescriptor: trap }),
      provider === "google" ? { usageMetadata: new Proxy({}, { getOwnPropertyDescriptor: trap }) }
        : { usage: new Proxy({}, { getOwnPropertyDescriptor: trap }) }]) {
      const receipt = normalizeNativeModelUsage(candidate, "fixture-model", provider);
      for (const key of counters) expect(receipt[key]).toBeNull();
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("validates identifiers and never imports an Anthropic receipt as a native receipt", () => {
    const receipt = normalizeNativeModelUsage({ model: "model\n", id: "user@example.invalid",
      usage: { input_tokens: 2, cache_read_input_tokens: 99, cache_creation_input_tokens: 77 },
    }, "m".repeat(201), "openai");
    expect(receipt.requestedModel).toBeNull();
    expect(receipt.responseModel).toBeNull();
    expect(receipt.responseId).toBeNull();
    expect(receipt.cacheReadInputTokens).toBeNull();
    expect(receipt.cacheCreationInputTokens).toBeNull();
  });

  it("keeps v1 byte shape and refuses native receipts inside a v2 programmatic chain", () => {
    const legacy = normalizeModelUsage({}, "fixture-model", "https://api.anthropic.com");
    expect(legacy.version).toBe(1);
    expect(Object.keys(legacy)).not.toContain("totalTokens");
    expect(programmaticUsageEnvelope([{ receipt: legacy, codeExecutionRequests: 0 }]).version).toBe(2);
    for (const provider of providers) {
      expect(() => programmaticUsageEnvelope([{ receipt: normalizeNativeModelUsage({}, "fixture-model", provider), codeExecutionRequests: 0 }])).toThrow(/programmatique/);
    }
  });
});
