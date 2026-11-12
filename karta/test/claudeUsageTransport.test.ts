import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { ModelUsageReceipt } from "../src/claude/usage.js";

vi.mock("../src/config.js", () => ({ config: {
  anthropicApiKey: "usage-fixture-not-a-secret",
  anthropicModelMain: "fixture-main", anthropicModelFast: "fixture-fast",
} }));
import { createRealClaudeClient } from "../src/claude/real.js";

const network = vi.fn<typeof fetch>();
const observed = vi.fn<(receipt: ModelUsageReceipt) => void>();
const input = (): ClaudeDecideInput & { onUsage: typeof observed } => ({
  systemPrompt: "Réponds sans action.", context: { private: "PRIVATE_CONTEXT" },
  tools: [], agentType: "usage-fixture", onUsage: observed,
});
function response(stop = "end_turn", content: unknown = [{ type: "text", text: "PRIVATE_OUTPUT" }], usage: unknown = {
  input_tokens: 120, output_tokens: 7, cache_read_input_tokens: 900,
  cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
}): Response {
  return new Response(JSON.stringify({ id: "msg_usage_fixture", type: "message", role: "assistant",
    model: "fixture-actual", stop_reason: stop, content, usage,
  }), { status: 200, headers: { "content-type": "application/json", "request-id": "req_private_header" } });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", network);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "unused-fixture-key");
  vi.stubEnv("ANTHROPIC_LOG", "off");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://compatible-fixture.invalid");
  network.mockImplementation(async () => response());
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("provider usage through the real installed SDK", () => {
  it("reports bounded counters without changing the accepted decision or issuing another request", async () => {
    const result = await createRealClaudeClient().decide(input());
    expect(result).toStrictEqual({ summary: "PRIVATE_OUTPUT", toolCalls: [], requiresApproval: false, mock: false });
    expect(observed).toHaveBeenCalledExactlyOnceWith({ version: 1, apiFormat: "anthropic_messages", routeKind: "compatible",
      requestedModel: "fixture-fast", responseModel: "fixture-actual", responseId: "msg_usage_fixture",
      inputTokens: 120, outputTokens: 7, cacheReadInputTokens: 900, cacheCreationInputTokens: 30,
      cacheCreation5mInputTokens: 20, cacheCreation1hInputTokens: 10,
    });
    expect(network).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(observed.mock.calls);
    for (const secret of ["PRIVATE_CONTEXT", "PRIVATE_OUTPUT", "req_private_header", "compatible-fixture.invalid"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each(["max_tokens", "refusal", "pause_turn", "unknown"])("retains usage before rejecting %s", async reason => {
    network.mockImplementation(async () => response(reason));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0]).toMatchObject({ inputTokens: 120, outputTokens: 7 });
    expect(network).toHaveBeenCalledOnce();
  });

  it("retains usage even when the response content fails local validation", async () => {
    network.mockImplementation(async () => response("end_turn", null));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow(/contenu absent/);
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0].inputTokens).toBe(120);
  });

  it("keeps omitted usage unknown without rejecting an otherwise complete compatible response", async () => {
    network.mockImplementation(async () => response("end_turn", undefined, null));
    await expect(createRealClaudeClient().decide(input())).resolves.toMatchObject({ mock: false });
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0]).toMatchObject({ inputTokens: null, outputTokens: null, cacheReadInputTokens: null });
  });

  it("does not invent a receipt or repeat inference after a connection failure", async () => {
    network.mockRejectedValue(new TypeError("lost response"));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
  });

  it("distinguishes the native endpoint without storing its URL", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
    await createRealClaudeClient().decide(input());
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0][0].routeKind).toBe("anthropic");
  });
});
