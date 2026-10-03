import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleProvider } from "../src/inference/openaiCompatible.js";
import { withOptInFallback } from "../src/inference/fallback.js";
import type { InferenceInput, InferenceProvider } from "../src/inference/types.js";

const input: InferenceInput = {
  agentType: "legal",
  systemPrompt: "Choisis un outil.",
  context: { item: "test" },
  tools: [{
    name: "notify",
    description: "Notifier",
    sensitive: false,
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    parseInput: (value: unknown) => value as Record<string, unknown>,
    execute: async () => ({ ok: true }),
  }],
};

function response(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI-compatible inference provider", () => {
  it("traduit les appels d'outils sans donner de droits supplementaires", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { model: string; tools: unknown[] };
      expect(request.model).toBe("fast-local");
      expect(request.tools).toHaveLength(1);
      return response(200, { choices: [{ message: {
        content: "Action proposee",
        tool_calls: [{ function: { name: "notify", arguments: '{"message":"bonjour"}' } }],
      } }] });
    });
    const provider = createOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1/",
      modelMain: "main-local",
      modelFast: "fast-local",
      timeoutMs: 5_000,
      maxRetries: 0,
      fetchImpl,
    });

    await expect(provider.decide(input)).resolves.toMatchObject({
      summary: "Action proposee",
      requiresApproval: false,
      mock: false,
      toolCalls: [{ tool: "notify", params: { message: "bonjour" } }],
    });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:11434/v1/chat/completions", expect.any(Object));
  });

  it("borne les retries aux erreurs transitoires", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(503, "temporaire"))
      .mockResolvedValueOnce(response(200, { choices: [{ message: { content: "ok" } }] }));
    const provider = createOpenAICompatibleProvider({
      baseUrl: "https://provider.invalid/v1",
      modelMain: "model",
      timeoutMs: 5_000,
      maxRetries: 1,
      fetchImpl,
    });
    await expect(provider.decide(input)).resolves.toMatchObject({ summary: "ok" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const unauthorized = vi.fn<typeof fetch>(async () => response(401, "non autorise"));
    const noRetry = createOpenAICompatibleProvider({
      baseUrl: "https://provider.invalid/v1", modelMain: "model", timeoutMs: 5_000, maxRetries: 2,
      fetchImpl: unauthorized,
    });
    await expect(noRetry.decide(input)).rejects.toThrow(/401/);
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("refuse une configuration non bornee ou incomplete", () => {
    expect(() => createOpenAICompatibleProvider({
      baseUrl: "", modelMain: "model", timeoutMs: 5_000, maxRetries: 0,
    })).toThrow(/AI_BASE_URL/);
    expect(() => createOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1", modelMain: "", timeoutMs: 5_000, maxRetries: 0,
    })).toThrow(/AI_MODEL_MAIN/);
    expect(() => createOpenAICompatibleProvider({
      baseUrl: "http://127.0.0.1:11434/v1", modelMain: "model", timeoutMs: 5_000, maxRetries: 3,
    })).toThrow(/AI_MAX_RETRIES/);
  });
});

describe("opt-in fallback", () => {
  const failing: InferenceProvider = { isMock: false, decide: vi.fn(async () => { throw new Error("primary down"); }) };
  const fallback: InferenceProvider = {
    isMock: true,
    decide: vi.fn(async () => ({ summary: "fallback", toolCalls: [], requiresApproval: false, mock: true })),
  };

  it("ne bascule que lorsqu'un fallback est explicitement fourni", async () => {
    await expect(withOptInFallback(failing).decide(input)).rejects.toThrow("primary down");
    await expect(withOptInFallback(failing, fallback).decide(input)).resolves.toMatchObject({ summary: "fallback" });
  });
});
