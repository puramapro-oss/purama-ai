import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import { normalizeModelUsage } from "../src/claude/usage.js";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState, AnyToolDefinition } from "../src/engine/types.js";
import type { PrivateToolResultPayload } from "../src/engine/private-tool-results.js";
import { createKnowledgeSearchTool } from "../src/tools/knowledge-search.js";
import { quantumSimulateTool } from "../src/tools/quantum.js";

const OWNER = "00000000-0000-4000-8000-000000000501";
const AGENT = "custom:00000000-0000-4000-8000-000000000502";
const RUN = "00000000-0000-4000-8000-000000000503";
const PENDING = "00000000-0000-4000-8000-000000000504";
const SAVED = "00000000-0000-4000-8000-000000000505";
const PRIVATE_MARKER = "PRIVATE_RESULT_EXECUTION_CANARY_501";
const STAMP = "2026-11-12T12:00:00.000Z";
type ExecutionPath = "cycle" | "approval";
interface StoreArgs {
  p_user_id: string;
  p_agent_type: string;
  p_run_id: string;
  p_operation_id: string;
  p_tool_name: PrivateToolResultPayload["tool_name"];
  p_payload: PrivateToolResultPayload;
}
interface FinalizationArgs {
  p_id: string;
  p_status: "executed" | "failed" | "rejected" | "cancelled";
  p_summary: string;
}

const h = vi.hoisted(() => ({
  state: {} as AgentState,
  decision: {} as AgentDecision,
  definition: {} as AgentDefinition,
  pending: undefined as Record<string, unknown> | undefined,
  existing: undefined as AgentRunResult | undefined,
  claimed: false,
  events: [] as string[],
  rpc: vi.fn(), store: vi.fn(), from: vi.fn(), insert: vi.fn(),
  finish: vi.fn(), record: vi.fn(), notify: vi.fn(), log: vi.fn(),
  execute: vi.fn(), decide: vi.fn(), resolveDefinition: vi.fn(),
  providerFetch: vi.fn<typeof fetch>(),
}));

vi.mock("../src/db/supabase.js", () => ({ supabase: {
  rpc: (...args: unknown[]) => ({ abortSignal: (_signal: AbortSignal) => h.rpc(...args) }),
  from: h.from,
} }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => h.state,
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  resolveAgentDefinition: h.resolveDefinition,
  CustomAgentAuthorizationError: class extends Error {},
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "00000000-0000-4000-8000-000000000503", finish: h.finish, existingResult: h.existing }),
}));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));

// Both engine entry points, tool implementations, projection, persistence,
// validation and trace minimization are real. No provider or database is contacted.
const { runAgentCycle } = await import("../src/engine/loop.js");
const { resolvePendingAction } = await import("../src/engine/approval.js");

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function installTool(tool: AnyToolDefinition, params: Record<string, unknown>): void {
  h.execute.mockImplementation(async (value, context) => {
    h.events.push("execute");
    return tool.execute(value, context);
  });
  h.definition.tools = [{ ...tool, execute: h.execute }];
  h.decision.toolCalls = [{ tool: tool.name, params }];
}

function cycle() {
  return runAgentCycle(OWNER, h.definition, { type: "manual", source: "private-results-test" }, "private-results-delivery");
}

function stores(): StoreArgs[] {
  return h.rpc.mock.calls.filter(([name]) => name === "karta_store_tool_result").map(([, args]) => args);
}

function finalizations(): FinalizationArgs[] {
  return h.rpc.mock.calls.filter(([name]) => name === "karta_finalize_pending_action").map(([, args]) => args);
}

function expectNoPrivateTrace(result: unknown): void {
  expect(JSON.stringify({
    result, journal: h.finish.mock.calls, outcomes: h.record.mock.calls,
    notifications: h.notify.mock.calls, logs: h.log.mock.calls,
    pendingRows: h.insert.mock.calls,
    otherRpc: h.rpc.mock.calls.filter(([name]) => name !== "karta_store_tool_result"),
  })).not.toContain(PRIVATE_MARKER);
  for (const { p_payload: _payload, ...identity } of stores()) {
    expect(JSON.stringify(identity)).not.toContain(PRIVATE_MARKER);
  }
}

async function createApproval(): Promise<void> {
  h.state.autonomyLevel = 1;
  const pending = await cycle();
  expect(pending.status).toBe("awaiting_approval");
  expect(pending.toolsUsed[0]).toMatchObject({ outcome: "pending", success: false, pendingActionId: PENDING });
  expect(h.insert).toHaveBeenCalledOnce();
  expect(h.execute).not.toHaveBeenCalled();
  expect(stores()).toHaveLength(0);
  expect(h.notify).toHaveBeenCalledOnce();
  expectNoPrivateTrace(pending);
  h.state.autonomyLevel = 3;
}

async function executePath(path: ExecutionPath) {
  if (path === "cycle") return cycle();
  await createApproval();
  return resolvePendingAction(PENDING, "approve");
}

function expectSuccessful(path: ExecutionPath, result: unknown): void {
  if (path === "cycle") {
    expect(result).toMatchObject({ status: "success", toolsUsed: [{ outcome: "executed", success: true }] });
  } else {
    expect(result).toMatchObject({ ok: true });
    expect(finalizations()).toEqual([expect.objectContaining({ p_id: PENDING, p_status: "executed" })]);
  }
  expectNoPrivateTrace(result);
}

function expectFailed(path: ExecutionPath, result: unknown): void {
  if (path === "cycle") {
    expect(result).toMatchObject({ status: "error", retryable: false, toolsUsed: [{ outcome: "failed", success: false }] });
  } else {
    expect(result).toMatchObject({ ok: false });
    expect(finalizations()).toEqual([expect.objectContaining({ p_id: PENDING, p_status: "failed" })]);
  }
  expectNoPrivateTrace(result);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.claimed = false;
  h.pending = undefined;
  h.existing = undefined;
  h.events = [];
  for (const method of ["error", "warn", "log", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { h.log(method, ...args); });
  }
  h.state = { userId: OWNER, agentType: AGENT, isEnabled: true, autonomyLevel: 3, killSwitch: false, simulationMode: false };
  h.definition = { type: AGENT, systemPrompt: "test", buildContext: async () => ({ privateContext: PRIVATE_MARKER }), tools: [] };
  h.decision = { summary: PRIVATE_MARKER, toolCalls: [], requiresApproval: false, mock: false };
  h.decide.mockImplementation(async () => h.decision);
  h.resolveDefinition.mockImplementation(async () => h.definition);
  h.finish.mockImplementation(async (result: AgentRunResult) => {
    h.events.push("finish");
    h.existing = result; // Model a durable prior-run receipt on repeated delivery.
  });
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
  h.store.mockResolvedValue({ data: SAVED, error: null });
  h.rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === "karta_store_tool_result") {
      h.events.push("store");
      return h.store(args);
    }
    if (name === "karta_claim_pending_action_bounded") {
      if (h.claimed || !h.pending) return { data: [], error: null };
      h.claimed = true;
      return { data: [{ ...h.pending, status: "executing" }], error: null };
    }
    if (name === "karta_finalize_pending_action") {
      h.events.push("finalize");
      return { data: null, error: null };
    }
    throw new Error("Unexpected RPC in private result execution test");
  });
  h.from.mockImplementation((table: string) => {
    if (table !== "karta_pending_actions") throw new Error("Unexpected table in private result execution test");
    return { insert: h.insert };
  });
  h.insert.mockImplementation((row: Record<string, unknown>) => {
    h.pending = { ...row, id: PENDING, status: "pending" };
    return { select: () => ({ single: async () => ({ data: { id: PENDING }, error: null }) }) };
  });
  h.providerFetch.mockImplementation(async url => {
    if (new URL(String(url)).hostname === "api.crossref.org") {
      return json({ status: "ok", message: { items: [{ DOI: "10.1234/example", title: [PRIVATE_MARKER],
        publisher: "Example Press", type: "journal-article", published: { "date-parts": [[2026, 11]] } }] } });
    }
    return json({ success: 1, search: [{ id: "Q42", label: "Entité publique", description: "Notice de test" }] });
  });
  installTool(createKnowledgeSearchTool({ fetch: h.providerFetch, wallNow: () => Date.parse(STAMP) }),
    { query: "public research", sources: ["crossref", "wikidata"], limit: 2, language: "fr" });
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(["cycle", "approval"] as const)("private tool result delivery through the real %s path", path => {
  it("retains complete source metadata only in the private result RPC before marking the action executed", async () => {
    const result = await executePath(path);
    expectSuccessful(path, result);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.providerFetch).toHaveBeenCalledTimes(2);
    expect(stores()).toHaveLength(1);
    expect(stores()[0]).toMatchObject({
      p_user_id: OWNER, p_agent_type: AGENT, p_run_id: RUN,
      p_operation_id: path === "cycle" ? `${RUN}:0` : PENDING,
      p_tool_name: "knowledge_search", p_payload: { schema_version: 1, status: "complete",
        sources: [{ source: "crossref", native_id: "10.1234/example", label: PRIVATE_MARKER }, { source: "wikidata", native_id: "Q42" }],
        details: { verification_status: "unverified", full_text_retrieved: false, page_read_by_karta: false } },
    });
    expect(h.events.indexOf("execute")).toBeLessThan(h.events.indexOf("store"));
    expect(h.events.indexOf("store")).toBeLessThan(h.events.lastIndexOf(path === "cycle" ? "finish" : "finalize"));
    expect(h.execute.mock.calls[0][1]).toMatchObject({ mode: "live", operationId: stores()[0].p_operation_id });
  });

  it("retains usable partial metadata while keeping the tool and run unsuccessful", async () => {
    const normalFetch = h.providerFetch.getMockImplementation()!;
    h.providerFetch.mockImplementation(async (url, options) => new URL(String(url)).hostname === "www.wikidata.org"
      ? new Response(null, { status: 503 }) : normalFetch(url, options));
    const result = await executePath(path);
    expectFailed(path, result);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.providerFetch).toHaveBeenCalledTimes(2);
    expect(stores()).toHaveLength(1);
    expect(stores()[0].p_payload).toMatchObject({ status: "partial",
      sources: [{ source: "crossref", label: PRIVATE_MARKER }],
      details: { source_outcomes: [
        { source: "crossref", status: "ok", result_count: 1 },
        { source: "wikidata", status: "rate_limited", result_count: 0 },
      ] },
    });
    expect(h.events.indexOf("store")).toBeLessThan(h.events.lastIndexOf(path === "cycle" ? "finish" : "finalize"));
  });

  it("retains model usage after a storage refusal and never replays the completed provider call on repeated delivery", async () => {
    const receipt = normalizeModelUsage({ id: "msg_private_sink", model: "fixture-model-v1",
      usage: { input_tokens: 123, output_tokens: 7, cache_read_input_tokens: 0 },
    }, "fixture-model", "https://api.anthropic.com");
    h.decide.mockImplementation(async (input: ClaudeDecideInput) => {
      input.onUsage?.(receipt);
      return h.decision;
    });
    h.store.mockResolvedValue({ data: null, error: { code: "42501", message: PRIVATE_MARKER, details: PRIVATE_MARKER } });
    const result = await executePath(path);
    expectFailed(path, result);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0][0]).toMatchObject({
      status: path === "cycle" ? "error" : "awaiting_approval", retryable: false, modelUsage: receipt,
    });
    expect(h.finish.mock.calls[0][0].modelUsage).toStrictEqual(receipt);
    expect(result).not.toHaveProperty("modelUsage");
    const repeated = path === "cycle" ? await cycle() : await resolvePendingAction(PENDING, "approve");
    if (path === "cycle") expect(repeated).toMatchObject({ status: "error", retryable: false });
    else expect(repeated).toMatchObject({ ok: false });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.providerFetch).toHaveBeenCalledTimes(2);
    expect(stores()).toHaveLength(1);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0][0].modelUsage).toStrictEqual(receipt);
    expect(repeated).not.toHaveProperty("modelUsage");
    expect(stores()[0].p_payload).not.toHaveProperty("modelUsage");
    expectNoPrivateTrace(repeated);
  });

  it("reconciles a lost storage acknowledgement using the same snapshot without rerunning the tool", async () => {
    h.store.mockRejectedValueOnce(new Error(PRIVATE_MARKER));
    const result = await executePath(path);
    expectSuccessful(path, result);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.providerFetch).toHaveBeenCalledTimes(2);
    expect(stores()).toHaveLength(2);
    expect(stores()[1]).toEqual(stores()[0]);
    expect(JSON.stringify(stores()[0].p_payload)).toContain(PRIVATE_MARKER);
  });

  it("retains a real local quantum calculation with its classical limits and no provider call", async () => {
    installTool(quantumSimulateTool, { qubits: 2, gates: [{ gate: "H", target: 0 }, { gate: "CX", control: 0, target: 1 }], shots: 100, seed: 7 });
    const result = await executePath(path);
    expectSuccessful(path, result);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.providerFetch).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(1);
    expect(stores()[0].p_payload).toMatchObject({ tool_name: "quantum_simulate", status: "complete", sources: [],
      details: { qubits: 2, gate_count: 2, shots: 100, execution_kind: "local_simulator", backend_kind: "classical_statevector",
        physical_quantum_hardware: false, quantum_advantage_demonstrated: false, external_api_calls: 0 } });
    const probabilities = stores()[0].p_payload.details.probabilities;
    if (!Array.isArray(probabilities)) throw new Error("Stored quantum probabilities must be an array");
    expect(probabilities[0]).toBeCloseTo(0.5, 10);
    expect(probabilities[3]).toBeCloseTo(0.5, 10);
  });

  it("does not publish a tool response that explicitly reports non-execution", async () => {
    h.execute.mockResolvedValue({ ok: false, status: "not_executed", message: PRIVATE_MARKER });
    const result = await executePath(path);
    expectFailed(path, result);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.providerFetch).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(0);
  });
});

describe("private results require an executed action", () => {
  it.each(["simulation", "mock", "autonomy", "model_approval"] as const)("does not execute or save an action gated by %s", async gate => {
    if (gate === "simulation") h.state.simulationMode = true;
    if (gate === "mock") h.decision.mock = true;
    if (gate === "autonomy") h.state.autonomyLevel = 1;
    if (gate === "model_approval") h.decision.requiresApproval = true;
    const result = await cycle();
    const awaitingApproval = gate === "autonomy" || gate === "model_approval";
    expect(result.status).toBe(awaitingApproval ? "awaiting_approval" : "simulated");
    expect(result.toolsUsed[0]).toMatchObject({ outcome: awaitingApproval ? "pending" : "simulated", success: false });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.providerFetch).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(0);
    expect(h.insert).toHaveBeenCalledTimes(awaitingApproval ? 1 : 0);
    expect(h.notify).toHaveBeenCalledTimes(awaitingApproval ? 1 : 0);
    expectNoPrivateTrace(result);
  });

  it.each(["simulation", "reject"] as const)("does not save an action cancelled by %s after approval creation", async gate => {
    await createApproval();
    if (gate === "simulation") h.state.simulationMode = true;
    const result = await resolvePendingAction(PENDING, gate === "reject" ? "reject" : "approve");
    expect(finalizations()).toEqual([expect.objectContaining({ p_status: gate === "reject" ? "rejected" : "cancelled" })]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.providerFetch).not.toHaveBeenCalled();
    expect(stores()).toHaveLength(0);
    expectNoPrivateTrace(result);
  });
});
