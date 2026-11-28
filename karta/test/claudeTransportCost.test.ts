import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AnyToolDefinition } from "../src/engine/types.js";

// Keep the real, lockfile-pinned SDK: mocking messages.create would hide its
// automatic HTTP retries. Only configuration and the network boundary are fake.
vi.mock("../src/config.js", () => ({
  config: {
    anthropicApiKey: "karta-transport-fixture-not-a-secret",
    anthropicTimeoutMs: 60_000,
    anthropicModelMain: "fixture-main-model",
    anthropicModelFast: "fixture-fast-model",
  },
}));

import { createRealClaudeClient } from "../src/claude/real.js";
import { buildAssistantSystemPrompt } from "../src/claude/assistant-policy.js";

const transport = vi.fn<typeof fetch>();
const execute = vi.fn();
const tool: AnyToolDefinition = {
  name: "prepare",
  description: "Préparer un résultat de test.",
  sensitive: false,
  inputSchema: {
    type: "object",
    properties: { label: { type: "string", minLength: 1 } },
    required: ["label"],
    additionalProperties: false,
  },
  execute,
};

interface RequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
}

function input(overrides: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput {
  return {
    systemPrompt: "Prépare un résultat en respectant exactement les données.",
    context: { label: "fixture" },
    tools: [tool],
    agentType: "transport-fixture",
    ...overrides,
  };
}

function providerResponse(stopReason = "end_turn", content: unknown[] = [
  { type: "text", text: "Résultat complet." },
]): Response {
  return new Response(JSON.stringify({
    id: "msg_transport_fixture",
    type: "message",
    role: "assistant",
    model: "fixture-response-model",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 22, output_tokens: 4 },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": "req_transport_fixture" },
  });
}

function errorResponse(status: number): Response {
  return new Response(JSON.stringify({
    type: "error", error: { type: "fixture_error", message: "Fixture provider unavailable" },
  }), {
    status,
    // A pre-fix SDK retry should finish quickly, without fake-timer races.
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });
}

function capturedRequest(index = 0) {
  const call = transport.mock.calls[index];
  expect(call).toBeDefined();
  const [resource, init] = call;
  const url = resource instanceof Request ? resource.url : String(resource);
  expect(typeof init?.body).toBe("string");
  return {
    url,
    method: init?.method,
    headers: new Headers(init?.headers),
    body: JSON.parse(init!.body as string) as RequestBody,
  };
}

beforeEach(() => {
  transport.mockReset();
  execute.mockReset();
  // No ambient credential or proxy setting may reach even the intercepted
  // transport. The SDK also reads AUTH_TOKEN and its log setting directly.
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "unused-ambient-fixture-key");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://anthropic-fixture.invalid");
  vi.stubEnv("ANTHROPIC_LOG", "off");
  vi.stubGlobal("fetch", transport);
  transport.mockImplementation(async () => providerResponse());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("real Claude SDK transport cost boundaries", () => {
  it("deduplicates identical definitions after model selection without changing any other request value", async () => {
    const tools = [tool, tool, tool];
    Object.freeze(tools);
    const value = input({ tools });
    await createRealClaudeClient().decide(value);
    const body = capturedRequest().body;
    expect(body).toStrictEqual({
      // Three entries selected the main model before this optimization.
      model: "fixture-main-model",
      max_tokens: 1024,
      system: buildAssistantSystemPrompt(value.systemPrompt, "task"),
      messages: [{ role: "user", content: `Contexte actuel:\n${JSON.stringify(value.context)}\n\nDécide quelle(s) action(s) prendre.` }],
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.inputSchema, strict: true }],
    });
    expect(value.tools).toBe(tools);
    expect(tools).toHaveLength(3);
    expect(tools.every(candidate => candidate === tool)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves distinct tools, schemas and first-occurrence order", async () => {
    const second: AnyToolDefinition = {
      ...tool, name: "review", description: "Vérifier un résultat.", sensitive: true,
      requiresExplicitApproval: true, tracePolicy: "metadata_only",
      inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
    };
    await createRealClaudeClient().decide(input({ tools: [tool, second, tool, second] }));
    expect(capturedRequest().body.tools).toStrictEqual([tool, second].map(candidate => ({
      name: candidate.name, description: candidate.description,
      input_schema: candidate.inputSchema, strict: true,
    })));
    expect(second.sensitive).toBe(true);
    expect(second.requiresExplicitApproval).toBe(true);
    expect(second.tracePolicy).toBe("metadata_only");
  });

  it("preserves the explicit model and deep reasoning profile with repeated definitions", async () => {
    const client = createRealClaudeClient({ modelCatalog: [
      { model: "fixture-response-model", reasoning: "budget", maxOutputTokens: 16_384 },
    ] });
    await client.decide(input({ tools: [tool, tool, tool], preferences: { model: "fixture-response-model", reflection: "deep" } }));
    expect(capturedRequest().body).toMatchObject({
      model: "fixture-response-model", max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 7168 },
    });
    expect(capturedRequest().body.tools).toHaveLength(1);
  });

  it.each([
    { label: "equivalent-looking clone", change: {} },
    { label: "description", change: { description: "Other contract" } },
    { label: "schema", change: { inputSchema: { type: "object", properties: {}, additionalProperties: false } } },
    { label: "sensitivity", change: { sensitive: true } },
    { label: "approval", change: { requiresExplicitApproval: true } },
    { label: "trace policy", change: { tracePolicy: "metadata_only" } },
    { label: "handler", change: { execute: vi.fn() } },
  ] as Array<{ label: string; change: Partial<AnyToolDefinition> }>)("rejects a same-name distinct definition before the network: $label", async ({ change }) => {
    const collision: AnyToolDefinition = { ...tool, ...change };
    await expect(createRealClaudeClient().decide(input({ tools: [tool, collision] }))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    if (change.execute) expect(change.execute).not.toHaveBeenCalled();
  });

  it("rejects ambiguous definitions before even the local model-discovery GET", async () => {
    const client = createRealClaudeClient({ lmStudio: { model: "qwen-fixture" } });
    await expect(client.decide(input({ tools: [tool, { ...tool }] }))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves separate valid actions even when they use the same deduplicated tool", async () => {
    transport.mockImplementation(async () => providerResponse("tool_use", [
      { type: "tool_use", id: "toolu_first", name: "prepare", input: { label: "premier" } },
      { type: "tool_use", id: "toolu_second", name: "prepare", input: { label: "second" } },
    ]));
    await expect(createRealClaudeClient().decide(input({ tools: [tool, tool] }))).resolves.toMatchObject({
      toolCalls: [{ tool: "prepare", params: { label: "premier" } }, { tool: "prepare", params: { label: "second" } }],
      requiresApproval: false, mock: false,
    });
    expect(capturedRequest().body.tools).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([408, 409, 429, 500])("makes one HTTP attempt when the provider returns %i", async status => {
    transport.mockImplementation(async () => errorResponse(status));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(capturedRequest().headers.get("x-stainless-retry-count")).toBe("0");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not repeat a request after an ambiguous connection failure", async () => {
    transport.mockRejectedValue(new TypeError("Fixture connection ended without a response"));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the SDK's existing base URL setting without falling back to a different origin", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://omniroute-fixture.invalid");
    transport.mockImplementation(async () => errorResponse(500));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow();
    expect(transport.mock.calls.length).toBeGreaterThan(0);
    for (let index = 0; index < transport.mock.calls.length; index++) {
      expect(capturedRequest(index).url).toBe("https://omniroute-fixture.invalid/v1/messages");
    }
  });

  it("keeps the default SDK endpoint available when no proxy is configured", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
    await expect(createRealClaudeClient().decide(input())).resolves.toMatchObject({
      summary: "Résultat complet.", toolCalls: [], mock: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(capturedRequest().url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("uses only the explicit fixture API key and sends no ambient bearer credential", async () => {
    await createRealClaudeClient().decide(input());
    const request = capturedRequest();
    expect(request.headers.get("x-api-key")).toBe("karta-transport-fixture-not-a-secret");
    expect(request.headers.has("authorization")).toBe(false);
    expect(request.method).toBe("POST");
  });

  it("sends compact context while preserving every JSON value and leaving the input unchanged", async () => {
    const context = {
      spaces: "  conserver   les espaces  ",
      lines: "première\nseconde\r\n\ttroisième",
      unicode: "Été — 東京 😀",
      timestamp: "2026-11-12T05:30:00.123456+01:00",
      items: [null, true, false, 0, -12.5, "", { exact: "  interne\n  " }],
      nested: { nullable: null, array: ["a", "b"], empty: {} },
    };
    const original = JSON.stringify(context);
    await createRealClaudeClient().decide(input({ context }));
    const content = capturedRequest().body.messages[0].content;
    const prefix = "Contexte actuel:\n";
    const suffix = "\n\nDécide quelle(s) action(s) prendre.";
    expect(content.startsWith(prefix)).toBe(true);
    expect(content.endsWith(suffix)).toBe(true);
    const transmitted = content.slice(prefix.length, -suffix.length);
    expect(JSON.parse(transmitted)).toStrictEqual(context);
    expect(JSON.stringify(context)).toBe(original);
    expect(transmitted).toBe(original);
    expect(Buffer.byteLength(transmitted, "utf8"))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(context, null, 2), "utf8"));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "simple", context: { label: "fixture" }, model: "fixture-fast-model" },
    { label: "large", context: { details: "x".repeat(2_100) }, model: "fixture-main-model" },
  ])("preserves model, output allowance, policy and tool contract for a $label request", async ({ context, model }) => {
    const value = input({ context });
    await createRealClaudeClient().decide(value);
    expect(capturedRequest().body).toStrictEqual({
      model,
      max_tokens: 1024,
      system: buildAssistantSystemPrompt(value.systemPrompt, "task"),
      messages: [{
        role: "user",
        content: `Contexte actuel:\n${JSON.stringify(context)}\n\nDécide quelle(s) action(s) prendre.`,
      }],
      tools: [{
        name: tool.name, description: tool.description,
        input_schema: tool.inputSchema, strict: true,
      }],
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("preserves a valid complete tool decision through the real SDK", async () => {
    transport.mockImplementation(async () => providerResponse("tool_use", [
      { type: "text", text: "Préparation proposée." },
      { type: "tool_use", id: "toolu_fixture", name: "prepare", input: { label: "  résultat exact 😀  " } },
    ]));
    await expect(createRealClaudeClient().decide(input())).resolves.toStrictEqual({
      summary: "Préparation proposée.",
      toolCalls: [{ tool: "prepare", params: { label: "  résultat exact 😀  " } }],
      requiresApproval: false,
      mock: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("still rejects a partial tool response without repeating inference or executing the tool", async () => {
    transport.mockImplementation(async () => providerResponse("max_tokens", [
      { type: "tool_use", id: "toolu_partial", name: "prepare", input: { label: "partial" } },
    ]));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow(/incomplète/);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});
