import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AnyToolDefinition } from "../src/engine/types.js";

vi.mock("../src/config.js", () => ({ config: {
  anthropicApiKey: "fixture-cloud-key-must-not-leave",
  anthropicTimeoutMs: 60_000,
  anthropicModelMain: "fixture-cloud-main",
  anthropicModelFast: "fixture-cloud-fast",
} }));
import { createRealClaudeClient } from "../src/claude/real.js";

const model = "qwen3-4b-instruct-2507-heretic";
const origin = "http://127.0.0.1:1234";
const transport = vi.fn<typeof fetch>();
const execute = vi.fn();
const tool: AnyToolDefinition = {
  name: "prepare", description: "Préparer une donnée synthétique", sensitive: false,
  inputSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false },
  execute,
};
const input = (extra: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput => ({
  agentType: "local-fixture", systemPrompt: "Réponds en français.",
  context: { label: "Été à Frasne" }, tools: [], ...extra,
});
const entry = (extra: Record<string, unknown> = {}) => ({
  key: "publisher/download-key", type: "llm", format: "gguf",
  loaded_instances: [{ id: model }], capabilities: { trained_for_tool_use: true }, ...extra,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const decision = (extra: Record<string, unknown> = {}) => ({
  id: "msg_local_fixture", type: "message", role: "assistant", model,
  content: [{ type: "text", text: "Bonjour depuis IAO." }], stop_reason: "end_turn",
  stop_sequence: null, usage: { input_tokens: 21, output_tokens: 6 }, ...extra,
});
const client = (options: { baseURL?: string; apiKey?: string; model?: string } = {}) =>
  createRealClaudeClient({ lmStudio: { model, ...options } });
const calls = () => transport.mock.calls.map(([url, init]) => ({
  url: String(url), init, headers: new Headers(init?.headers),
  body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
}));

beforeEach(() => {
  transport.mockReset(); execute.mockReset();
  vi.stubGlobal("fetch", transport);
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://ambient-cloud.invalid");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fixture-ambient-cloud-token");
  vi.stubEnv("ANTHROPIC_LOG", "debug");
  transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
    ? json({ models: [entry()] }) : json(decision()));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("LM Studio through the existing KARTA Messages client", () => {
  it("checks the loaded instance before a prompt, fixes the model and keeps real usage receipts", async () => {
    const usage = vi.fn();
    const result = await client().decide(input({ onUsage: usage }));
    expect(result).toMatchObject({ summary: "Bonjour depuis IAO.", toolCalls: [], mock: false });
    expect(calls().map(call => call.url)).toEqual([`${origin}/api/v1/models`, `${origin}/v1/messages`]);
    expect(calls()[0].init?.body).toBeUndefined();
    expect(calls()[1].body).toMatchObject({ model, max_tokens: 1024 });
    expect(calls()[1].body.messages[0].content).toContain("Été à Frasne");
    expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      routeKind: "compatible", requestedModel: model, responseModel: model, inputTokens: 21, outputTokens: 6,
    }));
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([undefined, "fixture-local-token"])("isolates all ambient cloud credentials with local token %s", async token => {
    await client({ apiKey: token }).decide(input());
    const [inventory, inference] = calls();
    expect(inventory.headers.get("authorization")).toBe(token ? `Bearer ${token}` : null);
    expect(inference.headers.get("authorization")).toBeNull();
    expect(inference.headers.get("x-api-key")).toBe(token ?? "lm-studio-local");
    for (const call of calls()) {
      expect(call.init).toMatchObject({ redirect: "error", credentials: "omit", cache: "no-store" });
      expect([...call.headers.values()].join(" ")).not.toContain("fixture-cloud");
      expect([...call.headers.values()].join(" ")).not.toContain("fixture-ambient");
    }
  });

  it("uses an explicit loaded model for complex or sensitive requests without changing tool permissions", async () => {
    await client().decide(input({ agentType: "custom:fixture", tools: [{ ...tool, sensitive: true }] }));
    expect(calls()[1].body.model).toBe(model);
    expect(calls()[1].body.tools).toEqual([expect.objectContaining({ name: "prepare", strict: true })]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    {}, { models: [] }, { models: [entry({ loaded_instances: [] })] },
    { models: [entry({ loaded_instances: [{ id: "other-model" }] })] },
    { models: [entry({ loaded_instances: [{ id: model }, { id: model }] })] },
    { models: [entry(), entry()] }, { models: [entry({ type: "embedding" })] },
    { models: [entry({ format: null })] }, { models: [entry({ remote_host: "https://cloud.invalid" })] },
    { models: [entry({ remote_model: "cloud-model" })] },
  ])("does not send a prompt to an absent, ambiguous or nonlocal model: %j", async inventory => {
    transport.mockResolvedValueOnce(json(inventory));
    await expect(client().decide(input())).rejects.toThrow("aucune décision disponible");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("requires reported tool support only when tools are requested", async () => {
    transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
      ? json({ models: [entry({ capabilities: {} })] }) : json(decision()));
    await expect(client().decide(input({ tools: [tool] }))).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(client().decide(input())).resolves.toMatchObject({ mock: false });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each(["mlx", "gguf"])("supports the installed %s format", async format => {
    transport.mockResolvedValueOnce(json({ models: [entry({ format })] }));
    await expect(client().decide(input())).resolves.toMatchObject({ mock: false });
  });

  it.each([
    "https://remote.invalid", "http://192.168.1.10:1234", "http://0.0.0.0:1234",
    "http://localhost.evil.invalid:1234", "http://user:password@localhost:1234",
    "http://localhost:1234/v1", "http://localhost:1234?secret=fixture", "http://localhost:1234#fragment", "invalid",
  ])("rejects a nonlocal or ambiguous endpoint before I/O: %s", baseURL => {
    expect(() => client({ baseURL })).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("normalizes localhost without DNS resolution", async () => {
    await client({ baseURL: "http://localhost:1234/" }).decide(input());
    expect(calls().every(call => call.url.startsWith(origin))).toBe(true);
  });

  it.each(["", "model\n", "../model", "model?key=secret", "x".repeat(201)])("rejects invalid model ids %j", id => {
    expect(() => client({ model: id })).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["", "token\n", "bad token"])("rejects malformed local tokens", token => {
    expect(() => client({ apiKey: token })).toThrow();
  });

  it.each([301, 302, 307, 401, 500])("makes no fallback or retry for inventory HTTP %i", async status => {
    transport.mockResolvedValueOnce(json({ error: "private-fixture-error" }, status));
    await expect(client().decide(input())).rejects.toThrow("aucune décision disponible");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not retry an inference or expose its private error", async () => {
    transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
      ? json({ models: [entry()] }) : json({ error: "private-fixture-error" }, 500));
    await expect(client().decide(input())).rejects.toThrow(/^Réponse du modèle indisponible ou délai dépassé : aucune décision disponible$/);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rejects redirected bodies even when a transport returns them", async () => {
    const redirected = json({ models: [entry()] });
    Object.defineProperty(redirected, "redirected", { value: true });
    transport.mockResolvedValueOnce(redirected);
    await expect(client().decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("bounds the inventory body before JSON parsing or inference", async () => {
    transport.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(client().decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never connects for a pre-cancelled request", async () => {
    const controller = new AbortController(); controller.abort("private-fixture-reason");
    await expect(client().decide(input({ signal: controller.signal }))).rejects.toThrow("annulé");
    expect(transport).not.toHaveBeenCalled();
  });

  it("discards a late inventory after cancellation without sending the prompt", async () => {
    let resolve!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const controller = new AbortController();
    const pending = client().decide(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow("annulé");
    resolve(json({ models: [entry()] }));
    await new Promise(done => setTimeout(done, 0));
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(client().decide(input())).resolves.toMatchObject({ mock: false });
  });

  it("bounds concurrency across client instances and releases the slot on failure", async () => {
    let reject!: (error: Error) => void;
    transport.mockImplementationOnce(() => new Promise<Response>((_done, fail) => { reject = fail; }));
    const first = client().decide(input());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await expect(client().decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    reject(new Error("fixture")); await expect(first).rejects.toThrow();
    await expect(client().decide(input())).resolves.toMatchObject({ mock: false });
  });

  it("retains stop-reason validation and usage for a truncated local decision", async () => {
    const usage = vi.fn();
    transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
      ? json({ models: [entry()] }) : json(decision({ stop_reason: "max_tokens" })));
    await expect(client().decide(input({ onUsage: usage }))).rejects.toThrow("incomplète");
    expect(usage).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["inventory", "inference"])("cancels a stalled %s body and holds admission until the transport settles", async phase => {
    const controller = new AbortController();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stalled = new Response(new ReadableStream<Uint8Array>({ start(value) { streamController = value; } }));
    const target = phase === "inventory" ? "/api/v1/models" : "/v1/messages";
    transport.mockImplementation(async url => String(url).endsWith(target) ? stalled : json({ models: [entry()] }));
    const first = client().decide(input({ signal: controller.signal }));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(phase === "inventory" ? 1 : 2));
    controller.abort();
    await expect(first).rejects.toThrow("annulé");
    const count = transport.mock.calls.length;
    await expect(client().decide(input())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(count);
    streamController.close();
    await new Promise(done => setTimeout(done, 0));
    transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
      ? json({ models: [entry()] }) : json(decision()));
    await expect(client().decide(input())).resolves.toMatchObject({ mock: false });
  });

  it.each([302, 307])("rejects inference redirect %i without another destination", async status => {
    transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
      ? json({ models: [entry()] }) : json({}, status));
    await expect(client().decide(input())).rejects.toThrow();
    expect(calls().map(call => call.url)).toEqual([`${origin}/api/v1/models`, `${origin}/v1/messages`]);
  });

  it("validates every tool before exposing actions, including local-model mistakes", async () => {
    transport.mockImplementation(async url => String(url).endsWith("/api/v1/models")
      ? json({ models: [entry()] }) : json(decision({ stop_reason: "tool_use", content: [
        { type: "tool_use", id: "first", name: "prepare", input: { label: "valid" } },
        { type: "tool_use", id: "second", name: "prepare", input: { label: 42 } },
      ] })));
    await expect(client().decide(input({ tools: [tool] }))).rejects.toThrow("non conformes");
    expect(execute).not.toHaveBeenCalled();
  });
});
