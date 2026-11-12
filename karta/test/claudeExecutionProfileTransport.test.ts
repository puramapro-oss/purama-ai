import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { ModelExecutionCapability, ModelExecutionPlan } from "../src/claude/execution-profile.js";

// Real lockfile-pinned SDK and provider serialization; only configuration and
// fetch are fixtures. The intercepted transport cannot use real credentials.
vi.mock("../src/config.js", () => ({ config: {
  anthropicApiKey: "execution-profile-fixture-not-a-secret", anthropicTimeoutMs: 60_000,
  anthropicModelMain: "fixture-main", anthropicModelFast: "fixture-fast",
} }));
import { createRealClaudeClient } from "../src/claude/real.js";

const transport = vi.fn<typeof fetch>();
function catalog(): ModelExecutionCapability[] {
  return [
    { model: "fixture-budget", reasoning: "budget", maxOutputTokens: 16_384 },
    { model: "fixture-adaptive", reasoning: "adaptive", maxOutputTokens: 16_384, effortLevels: ["low", "medium", "high", "max"] },
    { model: "fixture-no-thinking", reasoning: "none", maxOutputTokens: 1024 },
    { model: "fixture-small-budget", reasoning: "budget", maxOutputTokens: 1024 },
  ];
}
function input(overrides: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput {
  return {
    systemPrompt: "Évalue les sources fournies.", context: { data: "fixture" }, tools: [],
    agentType: "custom:fixture", preferences: { model: "fixture-budget", reflection: "deep" },
    ...overrides,
  };
}
function response(stopReason = "end_turn", model = "fixture-budget") {
  return Response.json({
    id: "msg_profile_fixture", type: "message", role: "assistant", model,
    content: [{ type: "text", text: "Résultat préparé." }], stop_reason: stopReason,
    stop_sequence: null, usage: { input_tokens: 12, output_tokens: 30 },
  }, { headers: { "request-id": "request_profile_fixture" } });
}
function body(index = 0): Record<string, unknown> {
  const [url, init] = transport.mock.calls[index];
  expect(String(url)).toBe("https://execution-profile-fixture.invalid/v1/messages");
  expect(new Headers(init?.headers).get("x-api-key")).toBe("execution-profile-fixture-not-a-secret");
  expect(new Headers(init?.headers).has("authorization")).toBe(false);
  expect(typeof init?.body).toBe("string");
  return JSON.parse(init!.body as string) as Record<string, unknown>;
}

beforeEach(() => {
  transport.mockReset();
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("ANTHROPIC_API_KEY", "unused-ambient-fixture");
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://execution-profile-fixture.invalid");
  vi.stubEnv("ANTHROPIC_LOG", "off");
  vi.stubEnv("KARTA_MODEL_PROFILES_JSON", undefined);
  vi.stubGlobal("fetch", transport);
  transport.mockImplementation(async (_url, init) => response("end_turn", JSON.parse(init!.body as string).model));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("execution profiles through the actual Anthropic SDK", () => {
  it("rejects a provider model substitution after preserving its usage receipt", async () => {
    transport.mockImplementation(async () => response("end_turn", "different-model"));
    const usage = vi.fn();
    await expect(createRealClaudeClient({ modelCatalog: catalog() }).decide(input({ onUsage: usage })))
      .rejects.toThrow(/modèle choisi/);
    expect(usage).toHaveBeenCalledWith(expect.objectContaining({ requestedModel: "fixture-budget", responseModel: "different-model" }));
    expect(transport).toHaveBeenCalledOnce();
  });
  it("sends the exact model, output allowance and native thinking budget", async () => {
    await createRealClaudeClient({ modelCatalog: catalog() }).decide(input());
    expect(transport).toHaveBeenCalledOnce();
    expect(body()).toMatchObject({
      model: "fixture-budget", max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 7168 },
    });
    expect(body()).not.toHaveProperty("output_config");
    expect(body()).not.toHaveProperty("temperature");
  });

  it("forwards adaptive thinking and the qualified maximum effort through the pinned SDK", async () => {
    await createRealClaudeClient({ modelCatalog: catalog() }).decide(input({
      preferences: { model: "fixture-adaptive", reflection: "maximum" },
    }));
    expect(body()).toMatchObject({
      model: "fixture-adaptive", max_tokens: 16_384, thinking: { type: "adaptive" }, output_config: { effort: "max" },
    });
  });

  it("does not downgrade explicit maximum reflection when ultra-fast is selected", async () => {
    let effective: ModelExecutionPlan | undefined;
    await createRealClaudeClient({ modelCatalog: catalog() }).decide(input({
      preferences: { model: "fixture-adaptive", reflection: "maximum", speed: "ultra_fast" },
      onExecutionPlan: plan => { effective = plan; },
    }));
    expect(body()).toMatchObject({ model: "fixture-adaptive", output_config: { effort: "max" }, max_tokens: 16_384 });
    expect(effective).toMatchObject({ reflection: "maximum", speed: "ultra_fast", timeoutMs: 15_000 });
    expect(effective?.research.maxReviewers).toBe(0);
  });

  it("keeps callback mutations separate from the qualified provider request", async () => {
    await createRealClaudeClient({ modelCatalog: catalog() }).decide(input({
      onExecutionPlan: plan => {
        plan.model = "unqualified-destination";
        plan.maxOutputTokens = 99_999;
        plan.timeoutMs = 1;
        plan.providerOptions.thinking = { type: "enabled", budget_tokens: 99_998 };
        plan.providerOptions.output_config = { effort: "max" };
        plan.research.maxReviewers = 99;
      },
    }));
    expect(transport).toHaveBeenCalledOnce();
    expect(body()).toMatchObject({ model: "fixture-budget", max_tokens: 8192, thinking: { type: "enabled", budget_tokens: 7168 } });
    expect(body()).not.toHaveProperty("output_config");
  });

  it.each([
    { model: "unqualified-model", reflection: "standard" as const },
    { model: "fixture-no-thinking", reflection: "deep" as const },
    { model: "fixture-small-budget", reflection: "maximum" as const },
  ])("refuses $model / $reflection before sending data", async preferences => {
    const observed = vi.fn();
    await expect(createRealClaudeClient({ modelCatalog: catalog() }).decide(input({ preferences, onExecutionPlan: observed }))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
  });

  it("rejects a cancelled call before reporting a plan or reading model context", async () => {
    const controller = new AbortController(); controller.abort();
    const observed = vi.fn(); const contextRead = vi.fn();
    const value = input({ signal: controller.signal, onExecutionPlan: observed });
    Object.defineProperty(value, "context", { get: contextRead });
    await expect(createRealClaudeClient({ modelCatalog: catalog() }).decide(value)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
    expect(contextRead).not.toHaveBeenCalled();
  });

  it("observes cancellation from the plan callback before provider transport", async () => {
    const controller = new AbortController();
    await expect(createRealClaudeClient({ modelCatalog: catalog() }).decide(input({
      signal: controller.signal, onExecutionPlan: () => controller.abort(),
    }))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not retry or change model after a provider refusal", async () => {
    transport.mockImplementation(async () => Response.json({ error: { type: "rate_limit_error", message: "fixture" } }, {
      status: 429, headers: { "retry-after-ms": "1" },
    }));
    await expect(createRealClaudeClient({ modelCatalog: catalog() }).decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
    expect(body().model).toBe("fixture-budget");
  });

  it("records reported usage and rejects an incomplete answer without another request", async () => {
    transport.mockImplementation(async () => response("max_tokens"));
    const onUsage = vi.fn();
    await expect(createRealClaudeClient({ modelCatalog: catalog() }).decide(input({ onUsage }))).rejects.toThrow(/incomplète/);
    expect(transport).toHaveBeenCalledOnce();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestedModel: "fixture-budget", inputTokens: 12, outputTokens: 30 }));
  });

  it("preserves the legacy no-preference request contract", async () => {
    await createRealClaudeClient().decide(input({ preferences: undefined, agentType: "newsletter-genie" }));
    expect(body()).toMatchObject({ model: "fixture-fast", max_tokens: 1024 });
    expect(body()).not.toHaveProperty("thinking");
    expect(body()).not.toHaveProperty("output_config");
  });

  it("keeps the qualified catalogue stable after client construction", async () => {
    const supplied = catalog();
    const client = createRealClaudeClient({ modelCatalog: supplied });
    supplied[0].model = "unqualified-model";
    supplied[1].effortLevels!.push("xhigh");
    await client.decide(input());
    expect(body().model).toBe("fixture-budget");
    expect(transport).toHaveBeenCalledOnce();
  });
});
