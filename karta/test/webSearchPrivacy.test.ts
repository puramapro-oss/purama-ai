import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState } from "../src/engine/types.js";

const QUERY_MARKER = "WEB_PRIVATE_QUERY_SENTINEL_7241";
const RESULT_MARKER = "WEB_PRIVATE_RESULT_SENTINEL_3859";
const DECISION_MARKER = "WEB_PRIVATE_DECISION_SENTINEL_9163";
const MARKERS = [QUERY_MARKER, RESULT_MARKER, DECISION_MARKER];

const h = vi.hoisted(() => ({
  state: {} as AgentState,
  decision: {} as AgentDecision,
  existing: undefined as AgentRunResult | undefined,
  finish: vi.fn(), record: vi.fn(), notify: vi.fn(), pending: vi.fn(),
  decide: vi.fn(), buildContext: vi.fn(), loadState: vi.fn(),
}));

vi.mock("../src/config.js", async original => ({
  config: { ...(await original<typeof import("../src/config.js")>()).config, tavilyApiKey: "test-only-web-privacy" },
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...(await original<typeof import("../src/engine/autonomy.js")>()),
  loadAgentState: h.loadState,
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "web-private-run", finish: h.finish, existingResult: h.existing }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));

const { config } = await import("../src/config.js");
const { webSearchTool } = await import("../src/tools/websearch.js");
const { resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");
const { runAgentCycle } = await import("../src/engine/loop.js");

const fetchMock = vi.fn<typeof fetch>();
const providerResult = {
  title: RESULT_MARKER,
  url: "https://example.invalid/private-search-result",
  content: "An excerpt returned by the provider.",
};

function run(): Promise<AgentRunResult> {
  // A static agent and a manual trigger deliberately avoid the independent
  // privacy policies already applied to custom agents and delegations.
  const definition: AgentDefinition = {
    type: "legal", systemPrompt: "test-only static search agent",
    buildContext: h.buildContext, tools: [webSearchTool],
  };
  return runAgentCycle("web-private-user", definition,
    { type: "manual", source: "web-privacy-test" }, "web-private-delivery");
}

function expectNoPrivateTrace(result: AgentRunResult): void {
  const observable = [
    result,
    ...h.finish.mock.calls.map(([outcome]) => outcome),
    ...h.notify.mock.calls.map(([notification]) => notification),
  ];
  for (const value of observable) {
    for (const marker of MARKERS) expect(JSON.stringify(value)).not.toContain(marker);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  h.existing = undefined;
  h.state = {
    userId: "web-private-user", agentType: "legal", isEnabled: true,
    autonomyLevel: 3, killSwitch: false, simulationMode: false,
  };
  h.decision = {
    summary: DECISION_MARKER,
    toolCalls: [{ tool: "web_search", params: { query: QUERY_MARKER } }],
    requiresApproval: false, mock: false,
  };
  h.loadState.mockImplementation(async () => h.state);
  h.decide.mockImplementation(async () => h.decision);
  h.buildContext.mockResolvedValue({});
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
  h.pending.mockResolvedValue("web-private-pending");
  config.tavilyApiKey = "test-only-web-privacy";
  fetchMock.mockResolvedValue(Response.json({ results: [providerResult] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("privacy of the real web_search tool in the real KARTA cycle", () => {
  it("keeps the provider request and tool result intact while hiding query, result and decision from traces", async () => {
    const execute = vi.spyOn(webSearchTool, "execute");
    const params = h.decision.toolCalls[0].params;
    Object.freeze(params);

    const result = await run();

    expect(result.status).toBe("success");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "web_search", outcome: "executed", success: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toBe(params);
    expect(execute.mock.calls[0][1]).toMatchObject({
      userId: "web-private-user", operationId: "web-private-run:0", mode: "live",
    });
    expect(await execute.mock.results[0].value).toEqual({ results: [{
      title: providerResult.title, url: providerResult.url, snippet: providerResult.content,
    }] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.tavily.com/search");
    expect(JSON.parse(String(options?.body))).toMatchObject({ query: QUERY_MARKER, max_results: 5 });
    expect(String(options?.body)).not.toContain("web-private-user");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer test-only-web-privacy");
    expect(params).toEqual({ query: QUERY_MARKER });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.notify).not.toHaveBeenCalled();
    expectNoPrivateTrace(result);
  });

  it("retains the exact approval payload but hides it and the decision from the automatic notification", async () => {
    h.decision.requiresApproval = true;
    const params = h.decision.toolCalls[0].params;

    const result = await run();

    expect(result.status).toBe("awaiting_approval");
    expect(result.toolsUsed[0]).toMatchObject({
      tool: "web_search", outcome: "pending", success: false, pendingActionId: "web-private-pending",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.pending).toHaveBeenCalledOnce();
    expect(h.pending.mock.calls[0][0].toolParams).toBe(params);
    expect(h.pending.mock.calls[0][0]).toMatchObject({ userId: "web-private-user", toolName: "web_search" });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      userId: "web-private-user", actionType: "review", channels: ["in_app", "push", "email"],
    });
    expectNoPrivateTrace(result);
  });

  it("minimizes a legacy recorded search without repeating the provider call or rewriting stored history", async () => {
    h.existing = {
      status: "success", decision: DECISION_MARKER, mock: false, retryable: false,
      toolsUsed: [{
        tool: "web_search", paramsSummary: QUERY_MARKER, resultSummary: RESULT_MARKER,
        success: true, outcome: "executed",
      }],
      resultSummary: RESULT_MARKER,
    };
    const before = JSON.stringify(h.existing);

    const result = await run();

    expect(result.status).toBe("success");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "web_search", outcome: "executed", success: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(h.existing)).toBe(before);
    expectNoPrivateTrace(result);
  });

  it.each(["http", "transport"] as const)("does not expose %s failures, the private query or the model decision", async failure => {
    if (failure === "http") fetchMock.mockResolvedValue(new Response(RESULT_MARKER, { status: 503 }));
    else fetchMock.mockRejectedValue(new Error(RESULT_MARKER));

    const result = await run();

    expect(result.status).toBe("error");
    expect(result.retryable).toBe(false);
    expect(result.toolsUsed[0]).toMatchObject({ tool: "web_search", outcome: "failed", success: false });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expectNoPrivateTrace(result);
  });

  it("keeps the same web_search instance in the existing custom-agent registry", () => {
    const registered = resolveCustomAgentTools(["web_search"]);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toBe(webSearchTool);
  });
});
