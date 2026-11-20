import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AnyToolDefinition } from "../src/engine/types.js";

const h = vi.hoisted(() => ({ config: {
  anthropicApiKey: "prompt-cache-fixture-key",
  anthropicModelMain: "fixture-main", anthropicModelFast: "fixture-fast",
  anthropicTimeoutMs: 1_000,
  anthropicPromptCache: undefined as unknown,
} }));
vi.mock("../src/config.js", () => ({ config: h.config }));
// Keep the actual installed SDK and serialization; replace only HTTP I/O.
import { createRealClaudeClient } from "../src/claude/real.js";
import { ASSISTANT_CORE_POLICY, buildAssistantSystemPrompt } from "../src/claude/assistant-policy.js";

const network = vi.fn<typeof fetch>();
const usage = vi.fn();
const privateRole = "PRIVATE_ROLE: respecte exactement ÉTÉ 東京 😀 et <role_json>.";
const privateContext = "PRIVATE_CONTEXT: ne jamais placer avant le point de cache.";
const localModel = "fixture-local-instance";
const tool: AnyToolDefinition = {
  name: "inert", description: "PRIVATE_TOOL_DESCRIPTION", sensitive: false,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  execute: vi.fn(),
};
interface RequestBody {
  model: string;
  max_tokens: number;
  system: string | Array<{ type: string; text: string; cache_control?: { type: string; ttl: string } }>;
  messages: Array<{ role: string; content: string }>;
  tools: unknown[];
}
const input = (extra: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput => ({
  systemPrompt: privateRole, context: { private: privateContext, exact: [0, false, null, "  intact  "] },
  tools: [], agentType: "cache-fixture", onUsage: usage, ...extra,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "retry-after-ms": "1" },
});
const providerMessage = (model: string, stopReason = "end_turn") => ({
  id: "msg_cache_fixture", type: "message", role: "assistant", model,
  stop_reason: stopReason, stop_sequence: null, content: [{ type: "text", text: "Décision complète." }],
  usage: { input_tokens: 13, output_tokens: 7, cache_read_input_tokens: 1100,
    cache_creation_input_tokens: 22, cache_creation: { ephemeral_5m_input_tokens: 22, ephemeral_1h_input_tokens: 0 } },
});
function requests() {
  return network.mock.calls.map(([url, init]) => ({
    url: String(url), headers: new Headers(init?.headers), signal: init?.signal,
    body: typeof init?.body === "string" ? JSON.parse(init.body) as RequestBody : undefined,
  }));
}
function cachedBlocks(body: RequestBody) {
  expect(Array.isArray(body.system)).toBe(true);
  if (typeof body.system === "string") throw new Error("Expected cached system blocks");
  return body.system;
}

beforeEach(() => {
  network.mockReset(); usage.mockReset();
  h.config.anthropicPromptCache = undefined;
  h.config.anthropicTimeoutMs = 1_000;
  vi.stubGlobal("fetch", network);
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_LOG", "off");
  network.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/api/v1/models")) return json({ models: [{
      key: "fixture-local", type: "llm", format: "gguf", loaded_instances: [{ id: localModel }],
      capabilities: { trained_for_tool_use: true },
    }] });
    const body = JSON.parse(String(init?.body)) as RequestBody;
    return json(providerMessage(body.model));
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("opt-in public prefix cache through the actual Anthropic SDK", () => {
  it.each([undefined, "off"])("preserves the original request with server setting %s", async mode => {
    h.config.anthropicPromptCache = mode;
    const value = input({ context: { requestCacheMode: "5m", private: privateContext } });
    await createRealClaudeClient().decide(value);
    expect(requests()[0].body).toStrictEqual({
      model: "fixture-fast", max_tokens: 1024,
      system: buildAssistantSystemPrompt(value.systemPrompt, "task"),
      messages: [{ role: "user", content: `Contexte actuel:\n${JSON.stringify(value.context)}\n\nDécide quelle(s) action(s) prendre.` }],
      tools: [],
    });
    expect(network).toHaveBeenCalledOnce();
  });

  it.each(["", "true", "1h", "5M", "5m ", null, true, 5, {}, ["5m"]])(
    "rejects invalid server setting %j before any network request", mode => {
      h.config.anthropicPromptCache = mode;
      expect(() => createRealClaudeClient()).toThrow("KARTA_ANTHROPIC_PROMPT_CACHE invalide");
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "https://api.anthropic.com/"])("marks only the public prefix on native endpoint %s", async baseURL => {
    h.config.anthropicPromptCache = "5m";
    vi.stubEnv("ANTHROPIC_BASE_URL", baseURL);
    const value = input();
    const original = JSON.stringify(value.context);
    const result = await createRealClaudeClient().decide(value);
    const request = requests()[0];
    const blocks = cachedBlocks(request.body!);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toStrictEqual({ type: "text", text: `${ASSISTANT_CORE_POLICY}\n\n`,
      cache_control: { type: "ephemeral", ttl: "5m" } });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks.map(block => block.text).join("")).toBe(buildAssistantSystemPrompt(value.systemPrompt, "task"));
    expect(blocks[0].text).not.toContain(privateRole);
    expect(blocks[0].text).not.toContain(privateContext);
    expect(request.body!.messages[0].content).toContain(privateContext);
    expect(JSON.stringify(value.context)).toBe(original);
    expect(request.body).toMatchObject({ model: "fixture-fast", max_tokens: 1024, tools: [] });
    expect(request.headers.get("x-stainless-retry-count")).toBe("0");
    expect(result).toStrictEqual({ summary: "Décision complète.", toolCalls: [], requiresApproval: false, mock: false });
    expect(network).toHaveBeenCalledOnce();
    expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestedModel: "fixture-fast",
      inputTokens: 13, outputTokens: 7, cacheReadInputTokens: 1100, cacheCreationInputTokens: 22,
      cacheCreation5mInputTokens: 22, cacheCreation1hInputTokens: 0, routeKind: "anthropic" }));
  });

  it("keeps an identical public prefix across different private roles and contexts", async () => {
    h.config.anthropicPromptCache = "5m";
    const client = createRealClaudeClient();
    await client.decide(input());
    await client.decide(input({ systemPrompt: "OTHER_PRIVATE_ROLE", context: { private: "OTHER_PRIVATE_CONTEXT" } }));
    expect(cachedBlocks(requests()[0].body!)[0]).toStrictEqual(cachedBlocks(requests()[1].body!)[0]);
    expect(cachedBlocks(requests()[0].body!)[1]).not.toStrictEqual(cachedBlocks(requests()[1].body!)[1]);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(["https://compatible-fixture.invalid", "http://127.0.0.1:11434", "https://api.anthropic.com.fixture.invalid"])(
    "leaves compatible endpoint %s unchanged with opt-in enabled", async baseURL => {
      h.config.anthropicPromptCache = "5m";
      vi.stubEnv("ANTHROPIC_BASE_URL", baseURL);
      await createRealClaudeClient().decide(input());
      expect(requests()[0].url).toBe(`${baseURL}/v1/messages`);
      expect(requests()[0].body!.system).toBe(buildAssistantSystemPrompt(privateRole, "task"));
      expect(JSON.stringify(requests()[0].body)).not.toContain("cache_control");
      expect(usage.mock.calls[0][0].routeKind).toBe("compatible");
      expect(network).toHaveBeenCalledOnce();
    },
  );

  it("honors an explicit native account without adopting an ambient compatible endpoint", async () => {
    h.config.anthropicPromptCache = "5m";
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://compatible-fixture.invalid");
    await createRealClaudeClient({ nativeAnthropicAccount: { apiKey: "explicit-native-fixture" } }).decide(input());
    expect(requests()[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests()[0].headers.get("x-api-key")).toBe("explicit-native-fixture");
    expect(cachedBlocks(requests()[0].body!)[0].cache_control?.ttl).toBe("5m");
    expect(network).toHaveBeenCalledOnce();
  });

  it("keeps the existing LM Studio qualification and request contract without cloud cache fields", async () => {
    h.config.anthropicPromptCache = "5m";
    await createRealClaudeClient({ lmStudio: { model: localModel } }).decide(input());
    expect(requests().map(value => value.url)).toEqual([
      "http://127.0.0.1:1234/api/v1/models", "http://127.0.0.1:1234/v1/messages",
    ]);
    expect(requests()[1].body!.system).toBe(buildAssistantSystemPrompt(privateRole, "task"));
    expect(requests()[1].body!.model).toBe(localModel);
    expect(JSON.stringify(requests()[1].body)).not.toContain("cache_control");
    expect(requests()[1].headers.get("x-api-key")).toBe("lm-studio-local");
  });

  it("does not cache any request containing tools, including private tool descriptions", async () => {
    h.config.anthropicPromptCache = "5m";
    await createRealClaudeClient().decide(input({ tools: [tool] }));
    expect(requests()[0].body!.system).toBe(buildAssistantSystemPrompt(privateRole, "task"));
    expect(requests()[0].body!.tools).toEqual([expect.objectContaining({ name: "inert", description: "PRIVATE_TOOL_DESCRIPTION" })]);
    expect(JSON.stringify(requests()[0].body)).not.toContain("cache_control");
    expect(network).toHaveBeenCalledOnce();
  });

  it.each(["compta", "legal", "custom:fixture"])("preserves the guarded primary model for %s", async agentType => {
    h.config.anthropicPromptCache = "5m";
    await createRealClaudeClient().decide(input({ agentType }));
    expect(requests()[0].body).toMatchObject({ model: "fixture-main", max_tokens: 1024 });
    expect(network).toHaveBeenCalledOnce();
  });

  it("records cache usage before rejecting a truncated decision and does not retry", async () => {
    h.config.anthropicPromptCache = "5m";
    network.mockImplementation(async () => json(providerMessage("fixture-fast", "max_tokens")));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow(/incomplète/);
    expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cacheReadInputTokens: 1100, cacheCreationInputTokens: 22 }));
    expect(network).toHaveBeenCalledOnce();
  });

  it("does not repeat a failed cached request", async () => {
    h.config.anthropicPromptCache = "5m";
    network.mockResolvedValue(json({ type: "error", error: { type: "overloaded_error", message: "fixture" } }, 500));
    await expect(createRealClaudeClient().decide(input())).rejects.toThrow(/indisponible/);
    expect(network).toHaveBeenCalledOnce();
    expect(usage).not.toHaveBeenCalled();
  });

  it("keeps a whole-response deadline with cache enabled and discards a late body", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    h.config.anthropicPromptCache = "5m";
    let finish!: (value: Response) => void;
    let entered!: () => void;
    const requestStarted = new Promise<void>(resolve => { entered = resolve; });
    network.mockImplementation((_url, _init) => { entered(); return new Promise<Response>(resolve => { finish = resolve; }); });
    const outcome = createRealClaudeClient().decide(input()).then(value => ({ value }), error => ({ error }));
    await requestStarted;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await outcome).toMatchObject({ error: expect.any(Error) });
    expect(requests()[0].signal?.aborted).toBe(true);
    expect(usage).not.toHaveBeenCalled();
    finish(json(providerMessage("fixture-fast")));
    await vi.runAllTimersAsync();
    expect(network).toHaveBeenCalledOnce();
    expect(usage).not.toHaveBeenCalled();
  });
});
