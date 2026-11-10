import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({ finish: vi.fn(), record: vi.fn(), notify: vi.fn() }));
vi.mock("../src/config.js", async (original) => ({
  config: { ...(await original<typeof import("../src/config.js")>()).config, tavilyApiKey: "test-only-tavily" },
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: async () => ({
  summary: "Recherche demandée", toolCalls: [{ tool: "web_search", params: { query: "test query" } }],
  requiresApproval: false, mock: false,
}) }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async (original) => ({
  ...(await original<typeof import("../src/engine/autonomy.js")>()),
  loadAgentState: async () => ({ userId: "user-web", agentType: "legal", isEnabled: true,
    killSwitch: false, simulationMode: false, autonomyLevel: 3 }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "run-web", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: vi.fn() }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));

const { config } = await import("../src/config.js");
const { webSearchTool } = await import("../src/tools/websearch.js");
const { resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");
const { runAgentCycle } = await import("../src/engine/loop.js");

const ctx: ToolExecutionContext = { userId: "user-web", agentType: "legal", mode: "live" };
const validResult = { title: "Source", url: "https://example.invalid/source", content: "Extrait vérifiable" };
const privateDetail = "SENTINEL_PRIVATE_PROVIDER_DETAIL";
const fetchMock = vi.fn<typeof fetch>();
const search = () => webSearchTool.execute({ query: "test query" }, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  config.tavilyApiKey = "test-only-tavily";
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ results: [validResult] }));
  vi.stubGlobal("fetch", fetchMock);
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Tavily response contract at the real web_search tool", () => {
  it("keeps the existing title/url/snippet contract for valid sources", async () => {
    expect(await search()).toEqual({ results: [{
      title: validResult.title, url: validResult.url, snippet: validResult.content,
    }] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-only-tavily");
    expect(JSON.parse(String(options?.body))).toEqual({ query: "test query", max_results: 5 });
    expect(String(options?.body)).not.toContain("test-only-tavily");
  });

  it("accepts an explicitly empty result list", async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [] }));
    await expect(search()).resolves.toEqual({ results: [] });
  });

  it("accepts documented optional metadata without forwarding it blindly", async () => {
    fetchMock.mockResolvedValue(Response.json({
      query: "test query", images: [], answer: null, response_time: 0.1, request_id: "request-test",
      results: [{ ...validResult, score: 0.8, raw_content: null, published_date: null,
        favicon: "https://example.invalid/favicon.ico", images: [], id: "source-test" }],
    }));
    await expect(search()).resolves.toEqual({ results: [{
      title: validResult.title, url: validResult.url, snippet: validResult.content,
    }] });
  });

  it("accepts empty string titles and snippets without inventing replacement text", async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ title: "", url: "http://example.invalid/", content: "" }] }));
    await expect(search()).resolves.toEqual({ results: [{ title: "", url: "http://example.invalid/", snippet: "" }] });
  });

  it("does not call the provider without a configured key", async () => {
    config.tavilyApiKey = "";
    await expect(search()).rejects.toThrow("TAVILY_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing results", {}], ["null envelope", null], ["array envelope", []],
    ["string envelope", "provider text"], ["null results", { results: null }],
    ["object results", { results: {} }], ["null item", { results: [null] }],
    ["array item", { results: [[]] }],
    ["missing title", { results: [{ url: validResult.url, content: "excerpt" }] }],
    ["numeric title", { results: [{ ...validResult, title: 17 }] }],
    ["missing URL", { results: [{ title: "Source", content: "excerpt" }] }],
    ["numeric URL", { results: [{ ...validResult, url: 17 }] }],
    ["missing snippet", { results: [{ title: "Source", url: validResult.url }] }],
    ["null snippet", { results: [{ ...validResult, content: null }] }],
  ])("rejects %s instead of claiming successful search", async (_name, body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    await expect(search()).rejects.toThrow(/Tavily/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    "javascript:alert(1)", "data:text/plain,hello", "file:///private/data", "/relative/path", "",
    "https://name:password@example.invalid/", "https://example.invalid/\nsecret",
  ])("rejects unsafe or ambiguous source URL %s", async (url) => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ ...validResult, url }] }));
    await expect(search()).rejects.toThrow(/Tavily/);
  });

  it("rejects the complete response when a later result is malformed", async () => {
    fetchMock.mockResolvedValue(Response.json({ results: [validResult, { ...validResult, content: false }] }));
    await expect(search()).rejects.toThrow(/Tavily/);
  });

  it("rejects more results than the five requested", async () => {
    fetchMock.mockResolvedValue(Response.json({ results: Array.from({ length: 6 }, () => validResult) }));
    await expect(search()).rejects.toThrow(/Tavily/);
  });

  it.each([
    ["title", "x".repeat(4_097)], ["url", "https://example.invalid/" + "x".repeat(8_192)],
    ["content", "x".repeat(100_001)],
  ])("rejects an oversized %s without silently truncating evidence", async (key, value) => {
    fetchMock.mockResolvedValue(Response.json({ results: [{ ...validResult, [key]: value }] }));
    await expect(search()).rejects.toThrow(/Tavily/);
  });

  it("stops an oversized response stream and cancels its reader", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(JSON.stringify({ results: [], extra: "x".repeat(1_048_576) }));
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes);
      controller.enqueue(new Uint8Array([32]));
      controller.close();
    }, cancel });
    fetchMock.mockResolvedValue(new Response(stream));
    const outcome = await search().catch((error: Error) => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("does not disclose an HTTP error body or retry the request", async () => {
    fetchMock.mockResolvedValue(new Response(privateDetail, { status: 503 }));
    const error = await search().catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateDetail);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not disclose a thrown transport error", async () => {
    fetchMock.mockRejectedValue(new Error(privateDetail));
    const error = await search().catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateDetail);
  });

  it("does not disclose malformed JSON contents", async () => {
    fetchMock.mockResolvedValue(new Response(privateDetail));
    const error = await search().catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateDetail);
  });

  it("does not disclose a failing body stream", async () => {
    fetchMock.mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.error(new Error(privateDetail)); },
    })));
    const error = await search().catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(privateDetail);
  });

  it("bounds a stalled transport even when the double ignores cancellation", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url, options) => { signal = options?.signal; return new Promise(() => undefined); });
    let failure: unknown;
    void search().catch((error: unknown) => { failure = error; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(failure).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds and releases a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValue(new Response(stream));
    let failure: unknown;
    void search().catch((error: unknown) => { failure = error; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(failure).toBeInstanceOf(Error);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("is the same validated tool resolved by the existing custom registry", () => {
    expect(resolveCustomAgentTools(["web_search"])).toEqual([webSearchTool]);
  });

  it.each([{}, { results: [] }])("keeps malformed and genuinely empty searches distinct in the real KARTA loop: %j", async (body) => {
    fetchMock.mockResolvedValue(Response.json(body));
    const definition: AgentDefinition = { type: "legal", systemPrompt: "test",
      buildContext: async () => ({}), tools: [webSearchTool] };
    const result = await runAgentCycle("user-web", definition, { type: "manual", source: "test" });
    const validEmpty = "results" in body;
    expect(result.status).toBe(validEmpty ? "success" : "error");
    expect(result.toolsUsed[0].success).toBe(validEmpty);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledOnce();
  });
});
