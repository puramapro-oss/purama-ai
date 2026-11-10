import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "../src/engine/types.js";

const PRIVATE_MARKER = "PRIVATE_APPROVAL_TRACE_SENTINEL_9410";
const h = vi.hoisted(() => ({
  claimed: false, stopped: false,
  pending: {} as { id: string; user_id: string; run_id: string; agent_type: string; tool_name: string; tool_params: Record<string, unknown>; status: string },
  parent: {} as Record<string, unknown>,
  tools: [] as AnyToolDefinition[],
  execute: vi.fn(), rpc: vi.fn(), resolveDefinition: vi.fn(), enqueue: vi.fn(), loadState: vi.fn(),
  from: vi.fn(), select: vi.fn(), eq: vi.fn(), parentRead: vi.fn(),
}));

vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: (...args: unknown[]) => {
  const response = Promise.resolve(h.rpc(...args));
  return Object.assign(response, { abortSignal: (_signal: AbortSignal) => response });
}, from: h.from } }));
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: h.resolveDefinition }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", () => ({ loadAgentState: h.loadState, isRunnable: () => ({ ok: true }) }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));

const { resolvePendingAction } = await import("../src/engine/approval.js");

function tool(privateTrace = true): AnyToolDefinition {
  return {
    name: "private_tool", description: "test-only tool", sensitive: true,
    ...(privateTrace ? { tracePolicy: "metadata_only" as const } : {}),
    inputSchema: { type: "object", properties: { payload: { type: "object" } }, required: ["payload"], additionalProperties: false },
    execute: h.execute,
  };
}

function finalizations() {
  return h.rpc.mock.calls.filter(([name]) => name === "karta_finalize_pending_action").map(([, params]) => params);
}

function parentTrace(privateTrace = true) {
  return {
    tool: "private_tool", pendingActionId: "private-pending", outcome: "pending", success: false,
    ...(privateTrace ? { tracePolicy: "metadata_only" } : {}),
  };
}

function expectPrivateTraceAbsent(result: unknown): void {
  expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
  for (const params of finalizations()) expect(JSON.stringify(params)).not.toContain(PRIVATE_MARKER);
  for (const call of h.enqueue.mock.calls) expect(JSON.stringify(call)).not.toContain(PRIVATE_MARKER);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.claimed = false;
  h.stopped = false;
  h.pending = {
    id: "private-pending", user_id: "private-user", run_id: "private-run", agent_type: "legal",
    tool_name: "private_tool", tool_params: { payload: { text: PRIVATE_MARKER } }, status: "executing",
  };
  h.parent = {
    id: "private-run", user_id: "private-user", agent_type: "legal", tools_used: [parentTrace()],
  };
  const parentQuery = { select: h.select, eq: h.eq, maybeSingle: h.parentRead, single: h.parentRead };
  h.from.mockReturnValue(parentQuery);
  h.select.mockReturnValue(parentQuery);
  h.eq.mockReturnValue(parentQuery);
  h.parentRead.mockImplementation(async () => ({ data: h.parent, error: null }));
  h.tools = [tool()];
  h.execute.mockResolvedValue({ ok: true, privateResult: PRIVATE_MARKER });
  h.loadState.mockResolvedValue({ simulationMode: false });
  h.resolveDefinition.mockImplementation(async () => ({ tools: h.tools }));
  h.enqueue.mockResolvedValue("resume-job");
  h.rpc.mockImplementation(async (name: string) => {
    if (name === "karta_claim_pending_action_bounded") {
      if (h.claimed) return { data: [], error: null };
      h.claimed = true;
      return { data: [h.pending], error: null };
    }
    return { data: null, error: null };
  });
});

describe("private tool traces through the real approval resolver", () => {
  it("executes with the original authorized payload and minimizes both API and finalization summaries", async () => {
    const params = h.pending.tool_params;
    Object.freeze(params.payload);
    Object.freeze(params);
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0][0]).toBe(params);
    expect(h.execute.mock.calls[0][1]).toMatchObject({ userId: "private-user", operationId: "private-pending", mode: "live" });
    expect(finalizations()).toHaveLength(1);
    expect(finalizations()[0]).toMatchObject({ p_id: "private-pending", p_status: "executed" });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(params).toEqual({ payload: { text: PRIVATE_MARKER } });
    expectPrivateTraceAbsent(result);
  });

  it("keeps legacy summaries unchanged when the definition contains no private tool", async () => {
    h.tools = [tool(false)];
    h.parent.tools_used = [parentTrace(false)];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).toContain(PRIVATE_MARKER);
    expect(finalizations()[0].p_summary).toContain(PRIVATE_MARKER);
  });

  it("retains the original private policy after the tool definition becomes legacy", async () => {
    h.tools = [tool(false)];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(finalizations()[0].p_status).toBe("executed");
    expectPrivateTraceAbsent(result);
  });

  it("retains cycle privacy when the approved legacy call was followed by an unknown tool", async () => {
    h.tools = [tool(false)];
    h.parent.tools_used = [
      parentTrace(),
      { tool: "unknown_tool", tracePolicy: "metadata_only", outcome: "skipped", success: false },
    ];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("protects an old parent whose unknown deferred tool predates the privacy marker", async () => {
    h.tools = [tool(false)];
    h.parent.tools_used = [
      parentTrace(false),
      { tool: PRIVATE_MARKER, outcome: "skipped", success: false, paramsSummary: PRIVATE_MARKER },
    ];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(finalizations()[0].p_status).toBe("executed");
    expectPrivateTraceAbsent(result);
  });

  it.each(["error", "throw", "missing", "malformed", "unmatched"] as const)("uses private summaries when the parent trace is %s without repeating or blocking the claimed action", async failure => {
    h.tools = [tool(false)];
    h.parent.tools_used = [parentTrace(false)];
    if (failure === "error") h.parentRead.mockResolvedValue({ data: null, error: { message: PRIVATE_MARKER } });
    if (failure === "throw") h.parentRead.mockRejectedValue(new Error(PRIVATE_MARKER));
    if (failure === "missing") h.parentRead.mockResolvedValue({ data: null, error: null });
    if (failure === "malformed") h.parent.tools_used = { private: PRIVATE_MARKER };
    if (failure === "unmatched") h.parent.tools_used = [{ ...parentTrace(false), pendingActionId: "different-pending" }];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(finalizations()[0].p_status).toBe("executed");
    expectPrivateTraceAbsent(result);
  });

  it("restricts the parent trace read to the claimed run, user and agent", async () => {
    h.tools = [tool(false)];
    h.parent.tools_used = [parentTrace(false)];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.from).toHaveBeenCalledWith("karta_runs");
    expect(h.eq).toHaveBeenCalledWith("id", h.pending.run_id);
    expect(h.eq).toHaveBeenCalledWith("user_id", h.pending.user_id);
    expect(h.eq).toHaveBeenCalledWith("agent_type", h.pending.agent_type);
  });

  it("protects a legacy action when another tool in its definition requires private traces", async () => {
    h.tools = [tool(false), { ...tool(), name: "another_private_tool" }];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(h.execute).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("minimizes a provider exception while preserving failed status and no continuation", async () => {
    h.execute.mockRejectedValue(new Error(PRIVATE_MARKER));
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(false);
    expect(finalizations()[0].p_status).toBe("failed");
    expect(h.enqueue).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("minimizes a validation error containing a private unknown key", async () => {
    h.pending.tool_params[PRIVATE_MARKER] = "invalid property";
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(false);
    expect(finalizations()[0].p_status).toBe("failed");
    expect(h.execute).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("uses a safe failure when loading the definition fails before privacy can be resolved", async () => {
    h.resolveDefinition.mockRejectedValue(new Error(PRIVATE_MARKER));
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    expect(finalizations()[0].p_status).toBe("failed");
    expectPrivateTraceAbsent(result);
  });

  it("does not include an unknown tool name or parameters in failure summaries", async () => {
    h.pending.tool_name = PRIVATE_MARKER;
    h.tools = [tool(false)];
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    expect(finalizations()[0].p_status).toBe("failed");
    expectPrivateTraceAbsent(result);
  });

  it("rejects without executing or exposing the stored parameters", async () => {
    const result = await resolvePendingAction(h.pending.id, "reject");
    expect(result.ok).toBe(true);
    expect(finalizations()[0].p_status).toBe("rejected");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("cancels a revoked action with no effect or continuation", async () => {
    h.stopped = true;
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(false);
    expect(finalizations()[0].p_status).toBe("cancelled");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("does not repeat an effect after a private finalization failure", async () => {
    h.rpc.mockImplementation(async (name: string) => {
      if (name === "karta_claim_pending_action_bounded") {
        if (h.claimed) return { data: [], error: null };
        h.claimed = true;
        return { data: [h.pending], error: null };
      }
      return { data: null, error: { message: PRIVATE_MARKER } };
    });
    const first = await resolvePendingAction(h.pending.id, "approve");
    const repeated = await resolvePendingAction(h.pending.id, "approve");
    expect(first.ok).toBe(false);
    expect(repeated.ok).toBe(false);
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.enqueue).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(first);
    expectPrivateTraceAbsent(repeated);
  });

  it("minimizes a private result without serializing its getters or cyclic values", async () => {
    const getter = vi.fn(() => { throw new Error(PRIVATE_MARKER); });
    const value: Record<string, unknown> = { ok: true, privateResult: PRIVATE_MARKER, count: 1n };
    value.self = value;
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    h.execute.mockResolvedValue(value);
    const result = await resolvePendingAction(h.pending.id, "approve");
    expect(result.ok).toBe(true);
    expect(finalizations()[0].p_status).toBe("executed");
    expect(getter).not.toHaveBeenCalled();
    expect(value.self).toBe(value);
    expect(value.privateResult).toBe(PRIVATE_MARKER);
    expectPrivateTraceAbsent(result);
  });
});
