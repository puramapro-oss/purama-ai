import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AnyToolDefinition } from "../src/engine/types.js";
import type { ModelExecutionCapability } from "../src/claude/execution-profile.js";

const h = vi.hoisted(() => ({ config: {
  anthropicApiKey: "programmatic-fixture-key", anthropicModelMain: "fixture-main", anthropicModelFast: "fixture-fast",
  anthropicTimeoutMs: 1000, anthropicPromptCache: "off", anthropicProgrammaticReads: "on" as unknown,
} }));
vi.mock("../src/config.js", () => ({ config: h.config }));
// Actual SDK request construction, headers, response parsing and retry policy.
// Only HTTP is replaced. No account, real model, or hosted Python is exercised.
import { createRealClaudeClient } from "../src/claude/real.js";
import { MAX_PROGRAMMATIC_CALLS, MAX_PROGRAMMATIC_RESULT_BYTES, MAX_PROGRAMMATIC_TOTAL_RESULT_BYTES } from "../src/claude/programmatic.js";
import { MAX_PROGRAMMATIC_RESPONSES } from "../src/claude/usage.js";

type Json = Record<string, unknown>;
const network = vi.fn<typeof fetch>();
const usage = vi.fn();
const execute = vi.fn<(call: { id: string; tool: string; params: Json }, signal: AbortSignal) => Promise<string>>();
const beforeRequest = vi.fn<(signal: AbortSignal) => Promise<void>>();
const toolHandler = vi.fn();
const catalog = (qualified = true): ModelExecutionCapability[] => ["fixture-main", "fixture-fast"].map(model => ({
  model, reasoning: "none", maxOutputTokens: 16_384, ...(qualified ? { programmaticToolCalling: true as const } : {}),
}));
const readTool = (extra: Partial<AnyToolDefinition> = {}): AnyToolDefinition => ({
  name: "web_search", description: "Return JSON search rows.", sensitive: false, programmaticRead: true,
  inputSchema: { type: "object", properties: {
    query: { type: "string", minLength: 1, maxLength: 100 }, limit: { type: "integer", minimum: 1, maximum: 10 },
  }, required: ["query"], additionalProperties: false }, execute: toolHandler, ...extra,
});
const input = (extra: Partial<ClaudeDecideInput> = {}): ClaudeDecideInput => ({
  systemPrompt: "PRIVATE_ROLE", context: { private: "PRIVATE_CONTEXT" }, agentType: "custom:fixture", tools: [readTool()],
  programmaticReads: { toolNames: ["web_search"], beforeRequest, execute }, onUsage: usage, ...extra,
});
const container = (id = "container_1") => ({ id, expires_at: new Date(Date.now() + 60_000).toISOString() });
const serverCall = (id = "srvtoolu_1") => ({
  type: "server_tool_use", id, name: "code_execution", input: { code: "rows = await web_search({'query': 'region'})\nprint(rows)" },
});
const call = (id = "toolu_1", query = "region", caller: unknown = { type: "code_execution_20260120", tool_id: "srvtoolu_1" }) => ({
  type: "tool_use", id, name: "web_search", input: { query }, ...(caller === undefined ? {} : { caller }),
});
const serverResult = (id = "srvtoolu_1", extra: Json = {}) => ({
  type: "code_execution_tool_result", tool_use_id: id,
  content: { type: "code_execution_result", stdout: "Only the useful result.", stderr: "", return_code: 0, content: [], ...extra },
});
const message = (id: string, content: unknown[], stop = "tool_use", extra: Json = {}) => ({
  id, type: "message", role: "assistant", model: "fixture-main", content, stop_reason: stop, stop_sequence: null,
  container: container(), usage: { input_tokens: 20, output_tokens: 5, server_tool_use: { code_execution_requests: 1 } }, ...extra,
});
const paused = (blocks = [serverCall(), call()]): Json => message("msg_1", blocks);
const finished = (id = "msg_2"): Json => message(id, [serverResult(), { type: "text", text: "Conclusion vérifiée." }], "end_turn");
const direct = (id = "msg_direct", model = "fixture-main") => message(id, [{ type: "text", text: "Décision directe." }], "end_turn", { container: null, model });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "retry-after-ms": "1" },
});
function respond(...values: Json[]) {
  for (const value of values) network.mockResolvedValueOnce(json(value));
}
function requests() {
  return network.mock.calls.map(([url, init]) => ({
    url: String(url), headers: new Headers(init?.headers), signal: init?.signal,
    body: JSON.parse(String(init?.body)) as { model: string; max_tokens: number; system: unknown; container?: string;
      tools: Json[]; messages: Array<{ role: string; content: unknown }>; thinking?: unknown; output_config?: unknown },
  }));
}
const client = (models = catalog()) => createRealClaudeClient({ modelCatalog: models });
async function failure(task: Promise<unknown>): Promise<Error> {
  return task.then(() => { throw new Error("Expected rejection"); }, reason => {
    expect(reason).toBeInstanceOf(Error); return reason as Error;
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", network);
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined); vi.stubEnv("ANTHROPIC_LOG", "off");
  vi.stubEnv("KARTA_MODEL_PROFILES_JSON", undefined);
  h.config.anthropicProgrammaticReads = "on"; h.config.anthropicTimeoutMs = 1000;
  network.mockReset(); usage.mockReset(); execute.mockReset(); beforeRequest.mockReset(); toolHandler.mockReset();
  beforeRequest.mockResolvedValue(); execute.mockResolvedValue('[{"id":"row_1","amount":42}]');
  network.mockRejectedValue(new Error("UNEXPECTED_PRIVATE_NETWORK_REQUEST"));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("qualified programmatic reads through the real Anthropic SDK", () => {
  it("executes two reads through KARTA, preserves protocol history, and returns only the final decision", async () => {
    const first = paused([serverCall(), call("toolu_a", "West"), call("toolu_b", "East")]);
    respond(first, finished());
    const result = await client().decide(input());
    expect(result).toStrictEqual({ summary: "Conclusion vérifiée.", toolCalls: [], requiresApproval: false, mock: false });
    expect(execute.mock.calls.map(([value]) => value)).toStrictEqual([
      { id: "toolu_a", tool: "web_search", params: { query: "West" } },
      { id: "toolu_b", tool: "web_search", params: { query: "East" } },
    ]);
    expect(toolHandler).not.toHaveBeenCalled();
    expect(beforeRequest).toHaveBeenCalledTimes(2);
    const [initial, continuation] = requests();
    expect(initial.url).toBe("https://api.anthropic.com/v1/messages");
    expect(initial.body.tools).toEqual([
      { type: "code_execution_20260120", name: "code_execution" },
      expect.objectContaining({ name: "web_search", allowed_callers: ["direct", "code_execution_20260120"] }),
    ]);
    expect(initial.body.tools.every(tool => !Object.hasOwn(tool, "strict"))).toBe(true);
    expect(continuation.body.tools).toStrictEqual(initial.body.tools);
    expect(continuation.body.container).toBe("container_1");
    expect(continuation.body.messages[1]).toStrictEqual({ role: "assistant", content: first.content });
    expect(continuation.body.messages[2]).toStrictEqual({ role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_a", content: '[{"id":"row_1","amount":42}]' },
      { type: "tool_result", tool_use_id: "toolu_b", content: '[{"id":"row_1","amount":42}]' },
    ] });
    expect(continuation.body.messages).toHaveLength(3);
    expect(initial.body.model).toBe(continuation.body.model);
    expect(initial.body.max_tokens).toBe(continuation.body.max_tokens);
    expect(JSON.stringify(initial.body)).not.toContain("beforeRequest");
    expect(JSON.stringify(initial.body)).not.toContain("programmaticReads");
    expect(initial.headers.get("x-stainless-retry-count")).toBe("0");
    expect(usage).toHaveBeenCalledTimes(2);
    expect(usage.mock.calls.every(([receipt, detail]) => receipt.requestedModel === "fixture-main"
      && receipt.routeKind === "anthropic" && detail.codeExecutionRequests === 1)).toBe(true);
  });

  it("continues dependent calls without a new server call or loss of caller identity", async () => {
    respond(paused(), message("msg_2", [call("toolu_2", "dependent")]), finished("msg_3"));
    await expect(client().decide(input())).resolves.toMatchObject({ summary: "Conclusion vérifiée." });
    expect(network).toHaveBeenCalledTimes(3); expect(execute).toHaveBeenCalledTimes(2);
    expect(requests()[2].body.messages).toHaveLength(5);
    expect(requests().slice(1).every(request => request.body.container === "container_1")).toBe(true);
  });

  it("handles direct and programmatic reads in the same batch through the same authority", async () => {
    respond(paused([serverCall(), call(), call("toolu_direct", "direct", { type: "direct" })]), finished());
    await client().decide(input());
    expect(execute).toHaveBeenCalledTimes(2);
    expect((requests()[1].body.messages[2].content as Json[]).every(block => block.type === "tool_result")).toBe(true);
  });

  it("allows direct reads and a final answer when the model does not need a sandbox", async () => {
    respond(message("msg_1", [call("toolu_1", "direct", { type: "direct" })], "tool_use", { container: null }), direct("msg_2"));
    await expect(client().decide(input())).resolves.toMatchObject({ summary: "Décision directe.", toolCalls: [] });
    expect(execute).toHaveBeenCalledOnce(); expect(requests()[1].body.container).toBeUndefined();
  });

  it("resumes pause_turn with unchanged assistant content and no artificial user text", async () => {
    const pause = message("msg_pause", [serverCall()], "pause_turn");
    respond(pause, message("msg_calls", [call()]), finished("msg_done"));
    await client().decide(input());
    const continuation = requests()[1].body;
    expect(continuation.messages).toHaveLength(2);
    expect(continuation.messages[1]).toStrictEqual({ role: "assistant", content: pause.content });
    expect(continuation.container).toBe("container_1");
    expect(beforeRequest).toHaveBeenCalledTimes(3); expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps containers, results and duplicate provider ids isolated between concurrent invocations", async () => {
    network.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const owner = String(body.messages[0].content).includes("owner_alpha") ? "alpha" : "beta";
      if (!body.container) return json(message("msg_shared", [serverCall(), call("toolu_shared", owner)], "tool_use", { container: container(`container_${owner}`) }));
      expect(body.container).toBe(`container_${owner}`);
      expect(body.messages.at(-1).content[0].content).toBe(`private_result_${owner}`);
      return json(message("msg_done", [serverResult(), { type: "text", text: `Conclusion ${owner}.` }], "end_turn", { container: container(`container_${owner}`) }));
    });
    const firstExecute = vi.fn().mockResolvedValue("private_result_alpha");
    const secondExecute = vi.fn().mockResolvedValue("private_result_beta");
    const shared = client();
    const results = await Promise.all([
      shared.decide(input({ context: { owner: "owner_alpha" }, programmaticReads: { toolNames: ["web_search"], beforeRequest, execute: firstExecute } })),
      shared.decide(input({ context: { owner: "owner_beta" }, programmaticReads: { toolNames: ["web_search"], beforeRequest, execute: secondExecute } })),
    ]);
    expect(results.map(result => result.summary)).toStrictEqual(["Conclusion alpha.", "Conclusion beta."]);
    expect(firstExecute).toHaveBeenCalledOnce(); expect(secondExecute).toHaveBeenCalledOnce();
    expect(network).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["bash_code_execution", { command: "python analysis.py" }, "bash_code_execution_tool_result",
      { type: "bash_code_execution_result", stdout: "42", stderr: "", return_code: 0, content: [] }],
    ["text_editor_code_execution", { command: "view", path: "/tmp/analysis.py" }, "text_editor_code_execution_tool_result",
      { type: "text_editor_code_execution_view_result", file_type: "text", content: "x = 42", num_lines: 1, start_line: 1, total_lines: 1 }],
    ["text_editor_code_execution", { command: "create", path: "/tmp/analysis.py", file_text: "x = 42" }, "text_editor_code_execution_tool_result",
      { type: "text_editor_code_execution_create_result", is_file_update: false }],
    ["text_editor_code_execution", { command: "str_replace", path: "/tmp/analysis.py", old_str: "42", new_str: "43" }, "text_editor_code_execution_tool_result",
      { type: "text_editor_code_execution_str_replace_result", old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, lines: ["-x = 42", "+x = 43"] }],
  ])("accepts the documented hosted %s result without executing local code", async (name, args, type, result) => {
    respond(message("msg_1", [
      { type: "server_tool_use", id: "srvtoolu_hosted", name, input: args },
      { type, tool_use_id: "srvtoolu_hosted", content: result },
      { type: "text", text: "Calcul terminé." },
    ], "end_turn"));
    await expect(client().decide(input())).resolves.toMatchObject({ summary: "Calcul terminé.", toolCalls: [] });
    expect(execute).not.toHaveBeenCalled(); expect(toolHandler).not.toHaveBeenCalled();
  });

  it("preserves the selected model, reflection options and output ceiling across every continuation", async () => {
    respond(paused(), finished());
    const models: ModelExecutionCapability[] = [{ model: "fixture-main", maxOutputTokens: 16_384,
      reasoning: "adaptive", effortLevels: ["medium", "high", "max"], programmaticToolCalling: true }];
    await client(models).decide(input({ preferences: { model: "fixture-main", reflection: "deep" } }));
    expect(requests().map(({ body }) => ({ model: body.model, max: body.max_tokens, thinking: body.thinking, effort: body.output_config })))
      .toStrictEqual(Array.from({ length: 2 }, () => ({ model: "fixture-main", max: 8192, thinking: { type: "adaptive" }, effort: { effort: "high" } })));
  });

  it("snapshots the full validated batch and bridge callbacks before the first asynchronous read", async () => {
    const second = call("toolu_2", "second");
    respond(paused([serverCall(), call(), second]), finished());
    const value = input();
    const replacement = vi.fn();
    execute.mockImplementationOnce(async () => {
      value.tools[0].inputSchema!.properties.query = { type: "boolean" };
      value.programmaticReads!.execute = replacement;
      value.programmaticReads!.beforeRequest = replacement;
      value.context.private = "REPLACED_PRIVATE_CONTEXT";
      return "first result";
    });
    await client().decide(value);
    expect(execute).toHaveBeenCalledTimes(2); expect(beforeRequest).toHaveBeenCalledTimes(2);
    expect(replacement).not.toHaveBeenCalled();
    expect(execute.mock.calls[1][0].params).toStrictEqual({ query: "second" });
    expect(JSON.stringify(requests()[1].body)).not.toContain("REPLACED_PRIVATE_CONTEXT");
    expect(requests()[1].body.tools).toStrictEqual(requests()[0].body.tools);
  });

  it("never retries a failed HTTP response or falls back after dispatch", async () => {
    network.mockResolvedValueOnce(json({ error: { type: "overloaded_error", message: "PRIVATE_PROVIDER_BODY" } }, 529));
    const error = await failure(client().decide(input()));
    expect(error.message).not.toContain("PRIVATE_PROVIDER_BODY");
    expect(network).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled();
  });
});

describe("programmatic route qualification", () => {
  it.each([undefined, "off"])("keeps the strict direct request with setting %s", async mode => {
    h.config.anthropicProgrammaticReads = mode;
    respond(direct());
    await client().decide(input());
    expect(requests()[0].body.tools).toEqual([expect.objectContaining({ name: "web_search", strict: true })]);
    expect(beforeRequest).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(usage.mock.calls[0]).toHaveLength(1);
  });
  it.each(["", "ON", "on ", true, null, 1, {}, ["on"]])("rejects invalid server setting %j before HTTP", setting => {
    h.config.anthropicProgrammaticReads = setting;
    expect(() => client()).toThrow("KARTA_ANTHROPIC_PROGRAMMATIC_READS invalide");
    expect(network).not.toHaveBeenCalled();
  });
  it.each([
    ["unqualified model", () => input(), () => catalog(false)],
    ["missing bridge", () => input({ programmaticReads: undefined }), () => catalog()],
    ["partial bridge", () => input({ programmaticReads: { toolNames: [], execute, beforeRequest } }), () => catalog()],
    ["extra bridge name", () => input({ programmaticReads: { toolNames: ["web_search", "other"], execute, beforeRequest } }), () => catalog()],
    ["duplicate bridge name", () => input({ programmaticReads: { toolNames: ["web_search", "web_search"], execute, beforeRequest } }), () => catalog()],
    ["sensitive tool", () => input({ tools: [readTool({ sensitive: true })] }), () => catalog()],
    ["approval tool", () => input({ tools: [readTool({ requiresExplicitApproval: true })] }), () => catalog()],
    ["unqualified tool", () => input({ tools: [readTool({ programmaticRead: undefined })] }), () => catalog()],
    ["empty catalogue", () => input({ tools: [], programmaticReads: { toolNames: [], execute, beforeRequest } }), () => catalog()],
  ] as const)("preserves direct mode for %s", async (_name, makeInput, makeCatalog) => {
    respond(direct()); await client(makeCatalog()).decide(makeInput());
    expect(requests()[0].body.tools.every(tool => tool.type !== "code_execution_20260120" && tool.strict === true)).toBe(true);
    expect(beforeRequest).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it.each(["https://gateway-fixture.invalid", "http://127.0.0.1:11434", "https://api.anthropic.com.fixture.invalid"])(
    "does not enable hosted execution on compatible route %s", async baseURL => {
      vi.stubEnv("ANTHROPIC_BASE_URL", baseURL); respond(direct()); await client().decide(input());
      expect(requests()[0].body.tools).toEqual([expect.objectContaining({ strict: true })]);
      expect(beforeRequest).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    },
  );
  it("uses the native account endpoint even when a compatible override exists", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://gateway-fixture.invalid"); respond(paused(), finished());
    await createRealClaudeClient({ modelCatalog: catalog(), nativeAnthropicAccount: { apiKey: "native-fixture-key" } }).decide(input());
    expect(requests().every(request => request.url === "https://api.anthropic.com/v1/messages"
      && request.headers.get("x-api-key") === "native-fixture-key")).toBe(true);
  });
  it("rejects a programmatic caller unexpectedly returned on the direct route", async () => {
    h.config.anthropicProgrammaticReads = "off"; respond(message("msg_direct", [call()]));
    await expect(client().decide(input())).rejects.toThrow("provenance d’outil non prise en charge");
    expect(execute).not.toHaveBeenCalled(); expect(usage).toHaveBeenCalledOnce();
  });
});

describe("whole-response preflight and protocol integrity", () => {
  it.each(["max_tokens", "refusal", "stop_sequence", "model_context_window_exceeded", null, "unknown"])(
    "retains usage but executes nothing for stop reason %s", async stop => {
      respond({ ...paused(), stop_reason: stop });
      await expect(client().decide(input())).rejects.toThrow("aucune décision disponible");
      expect(usage).toHaveBeenCalledOnce(); expect(execute).not.toHaveBeenCalled(); expect(network).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ["unknown tool", { ...call("toolu_bad"), name: "write_database" }],
    ["missing required parameter", { ...call("toolu_bad"), input: {} }],
    ["incorrect parameter type", { ...call("toolu_bad"), input: { query: 3 } }],
    ["additional parameter", { ...call("toolu_bad"), input: { query: "ok", unauthorized: true } }],
    ["invalid bounded value", { ...call("toolu_bad"), input: { query: "ok", limit: 11 } }],
    ["null input", { ...call("toolu_bad"), input: null }],
    ["duplicate call id", call()],
    ["call id ending in newline", { ...call("toolu_bad"), id: "toolu_bad\n" }],
    ["unknown caller", call("toolu_bad", "q", { type: "unexpected" })],
    ["unknown parent", call("toolu_bad", "q", { type: "code_execution_20260120", tool_id: "srvtoolu_unknown" })],
    ["missing parent", call("toolu_bad", "q", { type: "code_execution_20260120" })],
    ["extra caller field", call("toolu_bad", "q", { type: "direct", tool_id: "srvtoolu_1" })],
    ["unknown content", { type: "mcp_tool_use", id: "other" }],
  ])("rejects the entire batch for %s before the valid first call", async (_label, bad) => {
    respond(paused([serverCall(), call(), bad as ReturnType<typeof call>]));
    await expect(client().decide(input())).rejects.toThrow("aucune décision disponible");
    expect(execute).not.toHaveBeenCalled(); expect(network).toHaveBeenCalledOnce(); expect(usage).toHaveBeenCalledOnce();
  });
  it.each([
    ["absent", undefined], ["null", null], ["invalid id", { id: "bad id", expires_at: "2099-01-01T00:00:00Z" }],
    ["expired", { id: "container_1", expires_at: "2000-01-01T00:00:00Z" }],
    ["invalid expiry", { id: "container_1", expires_at: "invalid" }],
    ["container id ending in newline", { id: "container_1\n", expires_at: "2099-01-01T00:00:00Z" }],
  ])("rejects a programmatic call with %s container", async (_label, value) => {
    respond({ ...paused(), container: value });
    await expect(client().decide(input())).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ["changed container", () => ({ ...finished(), container: container("container_other") })],
    ["missing container", () => ({ ...finished(), container: null })],
    ["changed model", () => ({ ...finished(), model: "different-model" })],
    ["duplicate response", () => ({ ...finished(), id: "msg_1" })],
    ["duplicate tool", () => message("msg_2", [call()])],
    ["missing server result", () => message("msg_2", [{ type: "text", text: "Pretend done" }], "end_turn")],
    ["empty conclusion", () => message("msg_2", [serverResult()], "end_turn")],
  ] as const)("does not produce a successful decision for %s", async (_label, malformed) => {
    respond(paused(), malformed());
    await expect(client().decide(input())).rejects.toThrow("aucune décision disponible");
    expect(execute).toHaveBeenCalledOnce(); expect(network).toHaveBeenCalledTimes(2); expect(usage).toHaveBeenCalledTimes(2);
  });
  it.each([
    { return_code: 1, stderr: "PRIVATE_ERROR" },
    { return_code: 0, stderr: "TimeoutError: pending call timed out" },
    { type: "code_execution_tool_result_error", error_code: "execution_time_exceeded" },
    { content: [{ type: "code_execution_output", file_id: "unqualified_artifact" }] },
  ])("does not present erroneous or unqualified sandbox output as success: %j", async result => {
    respond(paused(), message("msg_2", [call("toolu_new"), serverResult("srvtoolu_1", result)]));
    const error = await failure(client().decide(input()));
    expect(error.message).not.toContain("PRIVATE_ERROR");
    expect(execute).toHaveBeenCalledOnce(); expect(network).toHaveBeenCalledTimes(2);
  });
});

describe("bounded execution and interruption", () => {
  it("stops at the response budget without executing an unfinishable final batch", async () => {
    respond(message("msg_0", [serverCall()], "pause_turn"));
    for (let i = 1; i < MAX_PROGRAMMATIC_RESPONSES - 1; i++) respond(message(`msg_${i}`, [], "pause_turn"));
    respond(message("msg_last", [call()]));
    await expect(client().decide(input())).rejects.toThrow();
    expect(network).toHaveBeenCalledTimes(MAX_PROGRAMMATIC_RESPONSES);
    expect(usage).toHaveBeenCalledTimes(MAX_PROGRAMMATIC_RESPONSES); expect(execute).not.toHaveBeenCalled();
  });
  it("rejects an over-budget call batch before any read", async () => {
    respond(paused([serverCall(), ...Array.from({ length: MAX_PROGRAMMATIC_CALLS + 1 }, (_, i) => call(`toolu_${i}`, `q${i}`))]));
    await expect(client().decide(input())).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
  });
  it("accepts the exact read-call budget and verifies the final response", async () => {
    respond(paused([serverCall(), ...Array.from({ length: MAX_PROGRAMMATIC_CALLS }, (_, i) => call(`toolu_${i}`, `q${i}`))]), finished());
    await client().decide(input()); expect(execute).toHaveBeenCalledTimes(MAX_PROGRAMMATIC_CALLS);
  });
  it("rejects oversized tool output without silent truncation or another provider request", async () => {
    respond(paused()); execute.mockResolvedValue("é".repeat(MAX_PROGRAMMATIC_RESULT_BYTES / 2 + 1));
    await expect(client().decide(input())).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  });
  it("enforces the cumulative output limit across otherwise valid individual reads", async () => {
    const count = MAX_PROGRAMMATIC_TOTAL_RESULT_BYTES / MAX_PROGRAMMATIC_RESULT_BYTES + 1;
    respond(paused([serverCall(), ...Array.from({ length: count }, (_, i) => call(`toolu_${i}`, `q${i}`))]));
    execute.mockResolvedValue("x".repeat(MAX_PROGRAMMATIC_RESULT_BYTES));
    await expect(client().decide(input())).rejects.toThrow();
    expect(network).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledTimes(count);
  });
  it("checks admission again before continuation and keeps private errors out of the result", async () => {
    respond(paused()); beforeRequest.mockResolvedValueOnce().mockRejectedValueOnce(new Error("PRIVATE_REVOKED_POLICY"));
    const error = await failure(client().decide(input()));
    expect(error.message).not.toContain("PRIVATE_REVOKED_POLICY");
    expect(beforeRequest).toHaveBeenCalledTimes(2); expect(network).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  });
  it("does not send anything after a pre-cancelled invocation", async () => {
    const controller = new AbortController(); controller.abort("PRIVATE_ABORT");
    await expect(client().decide(input({ signal: controller.signal }))).rejects.toThrow("annulé");
    expect(network).not.toHaveBeenCalled(); expect(beforeRequest).not.toHaveBeenCalled();
  });
  it("does not continue after cancellation during a read", async () => {
    const controller = new AbortController(); respond(paused());
    execute.mockImplementation(async () => { controller.abort("PRIVATE_ABORT"); return "late result"; });
    const error = await failure(client().decide(input({ signal: controller.signal })));
    expect(error.message).not.toContain("PRIVATE_ABORT");
    expect(network).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  });
  it("bounds the whole continuation chain instead of resetting the deadline per request", async () => {
    vi.useFakeTimers(); respond(paused(), finished());
    beforeRequest.mockImplementation(() => new Promise(resolve => { setTimeout(resolve, 600); }));
    const task = client().decide(input());
    const rejected = expect(task).rejects.toThrow("délai dépassé");
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    await vi.advanceTimersByTimeAsync(300);
    expect(network).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce();
  });
});
