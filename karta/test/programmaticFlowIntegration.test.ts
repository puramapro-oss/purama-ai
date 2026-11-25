import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeClient } from "../src/claude/types.js";
import type { AgentDefinition, AgentState } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  client: undefined as unknown as ClaudeClient,
  definition: undefined as unknown as AgentDefinition,
  stopped: false,
  finish: vi.fn(), record: vi.fn(), rpc: vi.fn(), arm: vi.fn(), claim: vi.fn(), notify: vi.fn(),
}));
vi.mock("../src/config.js", async original => {
  const actual = await original<typeof import("../src/config.js")>();
  return { ...actual, config: { ...actual.config,
    mockClaude: false, anthropicApiKey: "integration-fixture-key", tavilyApiKey: "search-fixture-key",
    anthropicModelMain: "fixture-main", anthropicModelFast: "fixture-fast",
    anthropicTimeoutMs: 1000, anthropicPromptCache: "off", anthropicProgrammaticReads: "on",
  } };
});
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => h.client }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: h.rpc } }));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({
  runId: "00000000-0000-4000-8000-000000000903", finish: h.finish,
}) }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async (userId: string, agentType: AgentState["agentType"]): Promise<AgentState> => ({
    userId, agentType, isEnabled: true, autonomyLevel: 2, simulationMode: false, killSwitch: false,
  }), recordRunOutcome: h.record,
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  resolveAgentDefinition: async () => h.definition,
  CustomAgentAuthorizationError: class CustomAgentAuthorizationError extends Error {},
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: vi.fn() }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/engine/brief.js", () => ({
  claimPendingBrief: h.claim, peekPendingBrief: h.claim, armPendingBrief: h.arm,
}));
vi.mock("../src/engine/approval-continuation.js", () => ({
  loadApprovalContinuation: async () => undefined, APPROVAL_CONTINUATION_GUIDANCE: "",
  ApprovalContinuationError: class ApprovalContinuationError extends Error {},
}));

import { runAgentCycle } from "../src/engine/loop.js";
import { createRealClaudeClient } from "../src/claude/real.js";
import { webSearchTool } from "../src/tools/websearch.js";
import { parsePrivateToolResult } from "../src/knowledge/private-result-view.js";

// Real engine, SDK, transport, tool handler, private projector and UI parser.
// External HTTP and database/identity ports are fixtures: no provider account,
// hosted sandbox or production database is exercised by this test.
const OWNER = "00000000-0000-4000-8000-000000000901";
const AGENT = "00000000-0000-4000-8000-000000000902";
const RUN = "00000000-0000-4000-8000-000000000903";
const RESULT = "00000000-0000-4000-8000-000000000904";
const PRIVATE_REPORT = "SYNTHÈSE_PRIVÉE_INTÉGRALE : comparaison des deux recherches publiques.\nConclusion conservée sans modification.";
const PRIVATE_CONTEXT = "PRIVATE_CONTEXT_MUST_NOT_ENTER_SEARCH_REQUESTS";
type Data = Record<string, unknown>;
interface MessageRequest {
  model: string; max_tokens: number; tools: Data[];
  messages: Array<{ role: string; content: unknown }>;
  container?: string;
}
interface SavedResultArgs {
  p_user_id: string; p_agent_type: string; p_run_id: string;
  p_operation_id: string; p_tool_name: string; p_payload: Data;
}
const inferenceRequests: MessageRequest[] = [];
const searchRequests: Data[] = [];
const providerResponses: Data[] = [];
const network = vi.fn<typeof fetch>();
const reply = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const hostedCall = () => ({ type: "server_tool_use", id: "srvtoolu_flow", name: "code_execution",
  input: { code: "results = await web_search({'query': 'public'})\nprint(results)" } });
const readCall = (id: string, query: string, extra: Data = {}) => ({
  type: "tool_use", id, name: "web_search", input: { query, response_format: "evidence", ...extra },
  caller: { type: "code_execution_20260120", tool_id: "srvtoolu_flow" },
});
const hostedResult = () => ({ type: "code_execution_tool_result", tool_use_id: "srvtoolu_flow",
  content: { type: "code_execution_result", stdout: "Two selected findings.", stderr: "", return_code: 0, content: [] } });
const message = (id: string, content: unknown[], stop: string): Data => ({
  id, type: "message", role: "assistant", model: "fixture-main", content,
  stop_reason: stop, stop_sequence: null,
  container: { id: "container_flow", expires_at: new Date(Date.now() + 60_000).toISOString() },
  usage: { input_tokens: 30, output_tokens: 10, server_tool_use: { code_execution_requests: 1 } },
});
const finalMessage = () => message("msg_flow_final", [hostedResult(), { type: "text", text: PRIVATE_REPORT }], "end_turn");
const twoReads = () => message("msg_flow_reads", [hostedCall(), readCall("toolu_west", "West"), readCall("toolu_east", "East")], "tool_use");
const cycle = () => runAgentCycle(OWNER, h.definition, { type: "manual", source: "integration-fixture" });
const savedArgs = (): SavedResultArgs[] => h.rpc.mock.calls.map(([, args]) => args as SavedResultArgs);

beforeEach(() => {
  vi.resetAllMocks(); h.stopped = false;
  inferenceRequests.length = 0; searchRequests.length = 0; providerResponses.length = 0;
  vi.stubGlobal("fetch", network);
  vi.stubEnv("ANTHROPIC_BASE_URL", undefined); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", undefined);
  vi.stubEnv("KARTA_MODEL_PROFILES_JSON", undefined); vi.stubEnv("ANTHROPIC_LOG", "off");
  h.definition = { type: `custom:${AGENT}`, systemPrompt: "Compare public references.",
    modelPreferences: { model: "fixture-main" },
    buildContext: async () => ({ privateContext: PRIVATE_CONTEXT, userId: "forged-owner" }), tools: [webSearchTool] };
  h.client = createRealClaudeClient({ modelCatalog: ["fixture-main", "fixture-fast"].map(model => ({
    model, reasoning: "none", maxOutputTokens: 16_384, programmaticToolCalling: true,
  })) });
  h.finish.mockResolvedValue(undefined); h.record.mockResolvedValue(undefined); h.arm.mockResolvedValue(undefined);
  h.claim.mockResolvedValue({ brief: "Compare public references.", briefId: "00000000-0000-4000-8000-000000000905" });
  h.rpc.mockImplementation(() => ({ abortSignal: vi.fn().mockResolvedValue({ data: RESULT, error: null }) }));
  network.mockImplementation(async (url, init) => {
    const destination = String(url);
    const body = JSON.parse(String(init?.body)) as Data;
    if (destination === "https://api.anthropic.com/v1/messages") {
      inferenceRequests.push(body as unknown as MessageRequest);
      const response = providerResponses.shift();
      if (!response) throw new Error("Unexpected inference request");
      return reply(response);
    }
    if (destination === "https://api.tavily.com/search") {
      searchRequests.push(body);
      expect(JSON.stringify(body)).not.toContain(PRIVATE_CONTEXT);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer search-fixture-key");
      return reply({ request_id: `search-${searchRequests.length}`, usage: { credits: 1 }, results: [
        { title: `Public ${String(body.query)}`, url: `https://example.org/${String(body.query).toLowerCase()}`,
          content: `Source excerpt ${String(body.query)}`, published_date: "2026-11-24" },
      ] });
    }
    throw new Error("Unexpected network destination");
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("programmatic research delivery across the existing layers", () => {
  it("delivers the complete final report to the owner's existing private result view", async () => {
    providerResponses.push(twoReads(), finalMessage());
    const result = await cycle();
    expect(result.status).toBe("success");
    expect(inferenceRequests).toHaveLength(2); expect(searchRequests).toHaveLength(2);
    expect(searchRequests.map(request => request.query)).toEqual(["West", "East"]);
    expect(inferenceRequests[0].model).toBe("fixture-main");
    expect(inferenceRequests[1].model).toBe(inferenceRequests[0].model);
    expect(inferenceRequests[1].max_tokens).toBe(inferenceRequests[0].max_tokens);
    const replies = inferenceRequests[1].messages.at(-1)?.content as Array<{ type: string; content: string }>;
    expect(replies).toHaveLength(2);
    expect(JSON.parse(replies[0].content)).toMatchObject({ results: [{ title: "Public West" }],
      evidence: { provider: "tavily", verification_status: "unverified", page_read_by_karta: false } });
    const [stored] = savedArgs();
    expect(savedArgs()).toHaveLength(1);
    expect(stored).toMatchObject({ p_user_id: OWNER, p_agent_type: `custom:${AGENT}`,
      p_run_id: RUN, p_operation_id: `${RUN}:2`, p_tool_name: "programmatic_report",
      p_payload: { summary: PRIVATE_REPORT, sources: [], details: {
        content_kind: "model_generated_report", verification_status: "unverified", report_truncated: false, read_tools: ["web_search"],
      } } });
    const row = { id: RESULT, user_id: OWNER, creator_agent_id: AGENT, run_id: RUN,
      tool_name: stored.p_tool_name, payload: stored.p_payload, created_at: new Date().toISOString() };
    expect(parsePrivateToolResult(row, OWNER, AGENT)?.payload.summary).toBe(PRIVATE_REPORT);
    expect(parsePrivateToolResult(row, "00000000-0000-4000-8000-000000000999", AGENT)).toBeNull();
    expect(result.toolsUsed.map(tool => tool.tool)).toEqual(["web_search", "web_search"]);
    expect(h.finish.mock.calls[0][0]).toMatchObject({ modelUsage: { version: 2, responses: [
      { receipt: { requestedModel: "fixture-main", responseId: "msg_flow_reads" }, codeExecutionRequests: 1 },
      { receipt: { requestedModel: "fixture-main", responseId: "msg_flow_final" }, codeExecutionRequests: 1 },
    ] } });
    expect(JSON.stringify([result, h.finish.mock.calls, h.record.mock.calls, h.notify.mock.calls])).not.toContain(PRIVATE_REPORT);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("rejects an invalid later call before either public search is sent", async () => {
    providerResponses.push(message("msg_flow_reads", [hostedCall(), readCall("toolu_first", "West"),
      readCall("toolu_invalid", "East", { user_id: "forged-owner" })], "tool_use"));
    const result = await cycle();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(inferenceRequests).toHaveLength(1); expect(searchRequests).toHaveLength(0);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0][0].modelUsage.responses).toHaveLength(1);
  });

  it("stops the chain after a stop switch changes during a real search response", async () => {
    providerResponses.push(twoReads(), finalMessage());
    const original = network.getMockImplementation()!;
    network.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url) === "https://api.tavily.com/search") h.stopped = true;
      return response;
    });
    const result = await cycle();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(inferenceRequests).toHaveLength(1); expect(searchRequests).toHaveLength(1);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("does not report success or repeat inference when private delivery is refused", async () => {
    providerResponses.push(twoReads(), finalMessage());
    h.rpc.mockImplementation(() => ({ abortSignal: vi.fn().mockResolvedValue({ data: null,
      error: { code: "P0001", message: PRIVATE_REPORT } }) }));
    const result = await cycle();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(inferenceRequests).toHaveLength(2); expect(searchRequests).toHaveLength(2);
    expect(h.rpc).toHaveBeenCalledOnce();
    expect(JSON.stringify([result, h.finish.mock.calls])).not.toContain(PRIVATE_REPORT);
  });

  it("reconciles a lost storage acknowledgement with the exact same report and operation", async () => {
    providerResponses.push(twoReads(), finalMessage());
    h.rpc.mockImplementationOnce(() => ({ abortSignal: vi.fn().mockRejectedValue(new Error("Lost database acknowledgement")) }));
    expect((await cycle()).status).toBe("success");
    expect(savedArgs()).toHaveLength(2); expect(savedArgs()[1]).toEqual(savedArgs()[0]);
    expect(inferenceRequests).toHaveLength(2); expect(searchRequests).toHaveLength(2);
  });

  it("delivers a no-read final report and consumes its brief without inventing tool evidence", async () => {
    h.definition.pendingBriefKey = "research_brief";
    providerResponses.push(message("msg_no_read", [hostedCall(), hostedResult(), { type: "text", text: PRIVATE_REPORT }], "end_turn"));
    const result = await cycle();
    expect(result.status).toBe("success"); expect(result.toolsUsed).toEqual([]);
    expect(h.arm).toHaveBeenCalledOnce(); expect(searchRequests).toHaveLength(0);
    expect(savedArgs()[0]).toMatchObject({ p_operation_id: `${RUN}:0`, p_payload: {
      summary: PRIVATE_REPORT, details: { read_tools: [] },
    } });
  });
});
