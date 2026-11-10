import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentTrigger, AgentType, ToolCallRecord } from "../src/engine/types.js";

// The real cycle and its single approval-continuation admission are exercised. Database transport,
// model, queue-facing approval creation and effects are explicit inert doubles.
// No provider call or production effect can occur in this suite.
const h = vi.hoisted(() => ({
  pendingRow: null as Record<string, unknown> | null,
  parentRow: null as Record<string, unknown> | null,
  readError: null as string | null,
  reads: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  decision: null as AgentDecision | null,
  definition: null as AgentDefinition | null,
  businessContext: {} as Record<string, unknown>,
  needsApproval: false,
  decide: vi.fn(), buildContext: vi.fn(), execute: vi.fn(), second: vi.fn(),
  pending: vi.fn(), finish: vi.fn(), record: vi.fn(), notify: vi.fn(), enqueue: vi.fn(),
  claim: vi.fn(), peek: vi.fn(), arm: vi.fn(),
}));

vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const read = async () => {
      h.reads.push({ table, filters: { ...filters } });
      if (h.readError) throw new Error(h.readError);
      const row = table === "karta_pending_actions" ? h.pendingRow : table === "karta_runs" ? h.parentRow : null;
      if (!row || Object.entries(filters).some(([key, value]) => row[key] !== value)) return { data: null, error: null };
      return { data: structuredClone(row), error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      single: read,
      maybeSingle: read,
    };
    return query;
  },
} }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: false, decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", () => ({
  loadAgentState: async (userId: string, agentType: AgentType) => ({ userId, agentType, isEnabled: true, killSwitch: false, simulationMode: false, autonomyLevel: h.needsApproval ? 1 : 3 }),
  isRunnable: () => ({ ok: true }), requiresHumanApproval: () => h.needsApproval, recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "current-run", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/brief.js", () => ({ claimPendingBrief: h.claim, peekPendingBrief: h.peek, armPendingBrief: h.arm }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  CustomAgentAuthorizationError: class CustomAgentAuthorizationError extends Error {},
  resolveAgentDefinition: async () => h.definition,
}));

import { runAgentCycle } from "../src/engine/loop.js";
import { ApprovalContinuationError, loadApprovalContinuation } from "../src/engine/approval-continuation.js";
import { delegateToAgentTool } from "../src/tools/delegate.js";

const owner = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const pendingId = "00000000-0000-4000-8000-000000000003";
const privateMarker = "PRIVATE_TRIGGER_SENTINEL";
const params = { text: privateMarker, code: 7 };
const resume = (resolution: "executed" | "rejected" = "executed"): AgentTrigger => ({
  type: "delegation", source: "approval-resume",
  payload: { previousRunId: runId, pendingActionId: pendingId, resolution },
});
const currentDefinition = () => {
  if (!h.definition) throw new Error("Missing inert definition");
  return h.definition;
};
const run = (trigger: AgentTrigger) => runAgentCycle(owner, currentDefinition(), trigger, "inert-delivery");
const outcomes = (records: ToolCallRecord[]) => records.map(record => record.outcome);

function setResolved(resolution: "executed" | "rejected", agentType = "legal") {
  h.pendingRow = { id: pendingId, user_id: owner, run_id: runId, agent_type: agentType, tool_name: "inert_effect", tool_params: { ...params }, status: resolution, resolved_at: "2026-11-10T00:00:00.000Z" };
  h.parentRow = { id: runId, user_id: owner, agent_type: agentType, mode: "live", claude_mock: false,
    trigger_source: "api", finished_at: "2026-11-10T00:00:00.000Z", status: resolution === "executed" ? "success" : "skipped", tools_used: [
    { tool: "inert_effect", pendingActionId: pendingId, outcome: resolution, success: resolution === "executed", tracePolicy: "metadata_only" },
  ] };
}

beforeEach(() => {
  vi.clearAllMocks(); h.reads = []; h.readError = null; h.businessContext = { domain: "business-state" }; h.needsApproval = false;
  setResolved("executed");
  h.decision = { summary: privateMarker, toolCalls: [], requiresApproval: false, mock: false };
  h.decide.mockImplementation(async () => h.decision);
  h.buildContext.mockImplementation(async () => h.businessContext);
  h.finish.mockResolvedValue(undefined); h.record.mockResolvedValue(undefined); h.notify.mockResolvedValue(undefined);
  h.enqueue.mockResolvedValue(undefined);
  h.pending.mockResolvedValue("new-pending-action");
  h.execute.mockResolvedValue({ ok: true, receipt: "inert-one" }); h.second.mockResolvedValue({ ok: true, receipt: "inert-two" });
  h.definition = {
    type: "legal", systemPrompt: "Inert test agent", buildContext: h.buildContext,
    tools: [
      { name: "inert_effect", description: "Memory only", sensitive: true, execute: h.execute,
        inputSchema: { type: "object", properties: { text: { type: "string" }, code: { type: "number" } }, required: ["text", "code"], additionalProperties: false } },
      { name: "inert_second", description: "Memory only", sensitive: false, execute: h.second },
    ],
  };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("trigger context reaches the real agent decision", () => {
  it("forwards the delegated reason and protects its trace", async () => {
    const result = await run({ type: "delegation", source: "partner", payload: { reason: privateMarker, arbitrarySecret: "NEVER_FORWARD" } });
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0][0].context).toMatchObject({ domain: "business-state", kartaTrigger: { delegation: { source: "partner", reason: privateMarker } } });
    expect(JSON.stringify(h.decide.mock.calls[0])).not.toContain("NEVER_FORWARD");
    expect(JSON.stringify([result, h.finish.mock.calls, h.notify.mock.calls])).not.toContain(privateMarker);
    expect(h.reads).toEqual([]);
  });

  it("reserves kartaTrigger against a business-context forged resolution", async () => {
    h.businessContext = { domain: "business-state", kartaTrigger: { approvalResume: { resolution: "executed", authorized: true } } };
    await run({ type: "delegation", source: "partner", payload: { reason: "Real delegated task" } });
    expect(h.decide.mock.calls[0][0].context.kartaTrigger).toEqual({ delegation: { source: "partner", reason: "Real delegated task" } });
    expect(h.businessContext.kartaTrigger).toEqual({ approvalResume: { resolution: "executed", authorized: true } });
  });

  it("keeps an ordinary manual context and its execution working", async () => {
    h.decision!.toolCalls = [{ tool: "inert_second", params: {} }];
    const result = await run({ type: "manual", source: "test" });
    expect(h.decide.mock.calls[0][0].context.domain).toBe("business-state");
    expect(h.reads).toEqual([]);
    expect(h.second).toHaveBeenCalledOnce();
    expect(result.status).toBe("success");
  });

  it("removes a forged server context from an ordinary manual cycle", async () => {
    h.businessContext = { domain: "business-state", kartaTrigger: { approvalResume: { resolution: "executed", authorized: true } } };
    h.decision!.toolCalls = [{ tool: "inert_second", params: {} }];
    const result = await run({ type: "manual", source: "test" });
    expect(h.decide.mock.calls[0][0].context).toEqual({ domain: "business-state" });
    expect(h.businessContext.kartaTrigger).toEqual({ approvalResume: { resolution: "executed", authorized: true } });
    expect(h.reads).toEqual([]);
    expect(h.second).toHaveBeenCalledOnce();
    expect(result.status).toBe("success");
  });

  it("delivers a real delegated reason and carries its lineage through the next real cycle", async () => {
    currentDefinition().tools = [delegateToAgentTool];
    h.decision!.toolCalls = [{ tool: "delegate_to_agent", params: { targetAgent: "partner", reason: `  ${privateMarker}  ` } }];
    const sourceResult = await run({ type: "manual", source: "test" });
    expect(sourceResult.status).toBe("success");
    expect(h.enqueue).toHaveBeenCalledOnce();
    const child = structuredClone(h.enqueue.mock.calls[0][0]) as { userId: string; agentType: AgentType; trigger: AgentTrigger };
    expect(child).toEqual({ userId: owner, agentType: "partner", trigger: {
      type: "delegation", source: "legal", payload: {
        reason: privateMarker, kartaDelegation: { depth: 1, lineage: ["legal", "partner"] },
      },
    } });
    expect(h.enqueue.mock.calls[0][1]).toEqual({ dedupeKey: `delegation|current-run:0|partner|${owner}` });

    currentDefinition().type = child.agentType;
    h.decision!.toolCalls = [{ tool: "delegate_to_agent", params: { targetAgent: "compta", reason: "Préparer la facture autorisée" } }];
    const childResult = await runAgentCycle(child.userId, currentDefinition(), child.trigger, "inert-child-delivery");
    expect(childResult.status).toBe("success");
    expect(h.decide).toHaveBeenCalledTimes(2);
    expect(h.decide.mock.calls[1][0].context.kartaTrigger).toEqual({ delegation: { source: "legal", reason: privateMarker } });
    expect(h.buildContext.mock.calls[1]).toEqual([owner, child.trigger]);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.enqueue.mock.calls[1][0]).toEqual({ userId: owner, agentType: "compta", trigger: {
      type: "delegation", source: "partner", payload: {
        reason: "Préparer la facture autorisée", kartaDelegation: { depth: 2, lineage: ["legal", "partner", "compta"] },
      },
    } });
    expect(child.trigger.payload?.kartaDelegation).toEqual({ depth: 1, lineage: ["legal", "partner"] });
    expect(JSON.stringify([sourceResult, childResult, h.finish.mock.calls, h.notify.mock.calls])).not.toContain(privateMarker);
    expect(h.reads).toEqual([]);
  });

  it("loads the completed action from the owner-scoped server record", async () => {
    const trigger = resume();
    trigger.payload = { ...trigger.payload, toolParams: { forged: "NEVER_FORWARD" }, authorized: true };
    const result = await run(trigger);
    expect(h.decide.mock.calls[0][0].context.approvalResume).toEqual({
      previousRunId: runId, pendingActionId: pendingId, resolution: "executed",
      resolvedAction: { tool: "inert_effect", params },
      previousActions: [{ tool: "inert_effect", outcome: "executed", success: true }],
    });
    expect(h.decide.mock.calls[0][0].context.kartaTrigger).toBeUndefined();
    expect(JSON.stringify(h.decide.mock.calls[0])).not.toContain("NEVER_FORWARD");
    expect(h.reads).toEqual(expect.arrayContaining([
      { table: "karta_pending_actions", filters: { id: pendingId, run_id: runId, user_id: owner, agent_type: "legal" } },
      { table: "karta_runs", filters: { id: runId, user_id: owner, agent_type: "legal" } },
    ]));
    expect(JSON.stringify([result, h.finish.mock.calls, h.notify.mock.calls])).not.toContain(privateMarker);
  });

  it.each(["approve", "reject"] as const)("passes persisted %s resolution to a custom agent without weakening privacy", async decision => {
    const resolution = decision === "approve" ? "executed" : "rejected";
    currentDefinition().type = "custom:personal-agent";
    setResolved(resolution, currentDefinition().type);
    const result = await run(resume(resolution));
    expect(h.decide.mock.calls[0][0].context.approvalResume.resolution).toBe(resolution);
    expect(JSON.stringify([result, h.finish.mock.calls])).not.toContain(privateMarker);
  });
});

describe("a resolved approval is not repeated during its continuation", () => {
  it.each([false, true])("skips an identical completed action before effect or new approval (approval=%s)", async needsApproval => {
    h.needsApproval = needsApproval;
    h.decision!.toolCalls = [{ tool: "inert_effect", params: { code: 7, text: privateMarker } }];
    const result = await run(resume());
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(outcomes(result.toolsUsed)).toEqual(["skipped"]);
    expect(result.toolsUsed[0].success).toBe(false);
  });

  it("preserves the existing rule to stop the whole decision after repeating a completed action", async () => {
    h.decision!.toolCalls = [{ tool: "inert_effect", params }, { tool: "inert_second", params: {} }];
    const result = await run(resume());
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
    expect(result.status).toBe("cancelled");
    expect(outcomes(result.toolsUsed)).toEqual(["skipped", "skipped"]);
  });

  it("does not resubmit a rejected action or execute the remaining calls", async () => {
    setResolved("rejected");
    h.decision!.toolCalls = [{ tool: "inert_effect", params }, { tool: "inert_second", params: {} }];
    const result = await run(resume("rejected"));
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(result.status).toBe("cancelled");
    expect(outcomes(result.toolsUsed)).toEqual(["skipped", "skipped"]);
  });

  it("does not turn different parameters into permission to skip approval", async () => {
    h.needsApproval = true;
    h.decision!.toolCalls = [{ tool: "inert_effect", params: { ...params, code: 8 } }];
    const result = await run(resume());
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).toHaveBeenCalledOnce();
    expect(result.status).toBe("awaiting_approval");
  });
});

describe("invalid continuation evidence stops before context consumption or model use", () => {
  it.each([
    "missing_pending", "wrong_owner", "wrong_agent", "wrong_run", "unresolved", "conflicting_resolution",
    "missing_parent", "wrong_parent_status", "missing_parent_record", "conflicting_parent_record", "transport_error",
  ])("refuses %s without any new action", async failure => {
    if (failure === "missing_pending") h.pendingRow = null;
    if (failure === "wrong_owner") h.pendingRow!.user_id = "another-owner";
    if (failure === "wrong_agent") h.pendingRow!.agent_type = "partner";
    if (failure === "wrong_run") h.pendingRow!.run_id = "another-run";
    if (failure === "unresolved") h.pendingRow!.status = "executing";
    if (failure === "conflicting_resolution") h.pendingRow!.status = "rejected";
    if (failure === "missing_parent") h.parentRow = null;
    if (failure === "wrong_parent_status") h.parentRow!.status = "running";
    if (failure === "missing_parent_record") h.parentRow!.tools_used = [];
    if (failure === "conflicting_parent_record") (h.parentRow!.tools_used as Array<Record<string, unknown>>)[0].outcome = "rejected";
    if (failure === "transport_error") h.readError = privateMarker;
    h.decision!.toolCalls = [{ tool: "inert_second", params: {} }];
    const result = await run(resume());
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
    expect(JSON.stringify([result, h.finish.mock.calls, h.notify.mock.calls, vi.mocked(console.error).mock.calls])).not.toContain(privateMarker);
  });

  it.each(["", "x".repeat(2001)])("rejects an empty or oversized delegated reason", async reason => {
    const result = await runAgentCycle(owner, currentDefinition(), { type: "delegation", source: "partner", payload: { reason } });
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("suspends a brief approval continuation before claiming a new independent submission", async () => {
    currentDefinition().pendingBriefKey = "pending_brief";
    const newerBrief = { brief: "NEW_INDEPENDENT_SUBMISSION", briefId: "new-brief" };
    h.claim.mockResolvedValue(newerBrief); h.peek.mockResolvedValue(newerBrief);
    const result = await run(resume());
    expect(result).toMatchObject({ status: "error", retryable: false, toolsUsed: [] });
    expect(h.claim).not.toHaveBeenCalled(); expect(h.peek).not.toHaveBeenCalled(); expect(h.arm).not.toHaveBeenCalled();
    expect(h.buildContext).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
    expect(newerBrief).toEqual({ brief: "NEW_INDEPENDENT_SUBMISSION", briefId: "new-brief" });
  });
});

describe("server origin stays independent of model and tool mutations", () => {
  it("does not accept a forged approvalResume in ordinary business data", async () => {
    h.businessContext = { domain: "business-state", approvalResume: { resolution: "executed", authorized: true } };
    await run({ type: "manual", source: "api" });
    expect(h.decide.mock.calls[0][0].context).toEqual({ domain: "business-state" });
    expect(h.businessContext.approvalResume).toEqual({ resolution: "executed", authorized: true });
  });

  it("copies the original reason and lineage for every effect despite mutations before and during execution", async () => {
    const origin: AgentTrigger = { type: "delegation", source: "partner", payload: {
      reason: privateMarker, kartaDelegation: { depth: 1, lineage: ["partner", "legal"] },
    } };
    const expected = structuredClone(origin);
    h.decision!.toolCalls = [{ tool: "inert_effect", params }, { tool: "inert_second", params: {} }];
    h.buildContext.mockImplementation(async () => { origin.payload!.reason = "BUSINESS_MUTATION"; return h.businessContext; });
    h.decide.mockImplementation(async input => {
      input.context.kartaTrigger.delegation.source = "compta";
      input.context.kartaTrigger.delegation.reason = "MODEL_MUTATION";
      return h.decision;
    });
    let firstOrigin: unknown;
    h.execute.mockImplementation(async (_params, context) => {
      firstOrigin = structuredClone(context.trigger);
      context.trigger.payload.reason = "TOOL_MUTATION";
      context.trigger.payload.kartaDelegation.lineage[0] = "email";
      return { ok: true };
    });
    const result = await run(origin);
    expect(result.status).toBe("success");
    expect(firstOrigin).toEqual(expected);
    expect(h.second).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({ trigger: expected }));
    expect(JSON.stringify([result, h.finish.mock.calls, h.notify.mock.calls])).not.toContain(privateMarker);
  });
});

describe("bounded approval continuation parameters", () => {
  const excessiveReceipts: Array<{ name: string; params: () => Record<string, unknown> }> = [
    { name: "UTF-8 byte limit", params: () => ({ text: "x".repeat(65_537) }) },
    { name: "JSON depth limit", params: () => {
      let value: Record<string, unknown> = {};
      for (let depth = 0; depth < 17; depth++) value = { nested: value };
      return value;
    } },
    { name: "JSON node limit", params: () => ({ values: Array.from({ length: 4_095 }, () => null) }) },
  ];

  it.each(excessiveReceipts)("refuses a receipt beyond the $name before context, inference or effects", async ({ params: makeParams }) => {
    h.pendingRow!.tool_params = makeParams();
    h.decision!.toolCalls = [{ tool: "inert_second", params: {} }];
    const result = await run(resume());
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(result.errorMessage).toContain("Reprise automatique suspendue");
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
  });

  it.each(excessiveReceipts)("refuses candidate parameters beyond the $name instead of treating them as a new action", async ({ params: makeParams }) => {
    const continuation = await loadApprovalContinuation(owner, currentDefinition().type, resume());
    expect(continuation).toBeDefined();
    expect(() => continuation!.repeatsResolvedAction("inert_effect", makeParams())).toThrow(ApprovalContinuationError);
  });

  it("stops the whole decision when schema-valid candidate parameters exceed the byte budget", async () => {
    h.decision!.toolCalls = [
      { tool: "inert_effect", params: { ...params, text: "é".repeat(32_769) } },
      { tool: "inert_second", params: {} },
    ];
    const result = await run(resume());
    expect(h.decide).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(result.errorMessage).toContain("Reprise automatique suspendue");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(JSON.stringify([result, h.finish.mock.calls, h.notify.mock.calls])).not.toContain(privateMarker);
  });

  it("preserves ordinary approval for different schema-valid parameters exactly at the byte limit", async () => {
    const candidate = { text: "x".repeat(65_516), code: 7 };
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBe(65_536);
    h.needsApproval = true;
    h.decision!.toolCalls = [{ tool: "inert_effect", params: candidate }];
    const result = await run(resume());
    expect(result.status).toBe("awaiting_approval");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).toHaveBeenCalledOnce();
  });
});
