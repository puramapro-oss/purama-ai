import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState, AnyToolDefinition } from "../src/engine/types.js";

const PRIVATE_MARKER = "PRIVATE_LOOP_TRACE_SENTINEL_9407";
const h = vi.hoisted(() => ({
  stopped: false,
  state: {} as AgentState,
  decision: {} as AgentDecision,
  existing: undefined as AgentRunResult | undefined,
  finish: vi.fn(), record: vi.fn(), execute: vi.fn(), legacyExecute: vi.fn(),
  pending: vi.fn(), notify: vi.fn(), buildContext: vi.fn(), decide: vi.fn(), loadState: vi.fn(),
}));

vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.loadState,
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "private-run", finish: h.finish, existingResult: h.existing }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));

const { runAgentCycle } = await import("../src/engine/loop.js");

function tool(name = "private_tool", privateTrace = true): AnyToolDefinition {
  return {
    name, description: "test-only tool", sensitive: true,
    ...(privateTrace ? { tracePolicy: "metadata_only" as const } : {}),
    inputSchema: { type: "object", properties: { payload: { type: "object" } }, required: ["payload"], additionalProperties: false },
    execute: name === "legacy_tool" ? h.legacyExecute : h.execute,
  };
}

function definition(tools: AnyToolDefinition[] = [tool()]): AgentDefinition {
  return { type: "legal", systemPrompt: "test", buildContext: h.buildContext, tools };
}

function run(tools?: AnyToolDefinition[]) {
  return runAgentCycle("private-user", definition(tools), { type: "manual", source: "trace-test" }, "private-delivery");
}

function expectPrivateTraceAbsent(result: AgentRunResult): void {
  expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
  for (const [outcome] of h.finish.mock.calls) expect(JSON.stringify(outcome)).not.toContain(PRIVATE_MARKER);
  for (const [notification] of h.notify.mock.calls) expect(JSON.stringify(notification)).not.toContain(PRIVATE_MARKER);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.stopped = false;
  h.existing = undefined;
  h.state = { userId: "private-user", agentType: "legal", isEnabled: true, autonomyLevel: 3, killSwitch: false, simulationMode: false };
  h.decision = {
    summary: PRIVATE_MARKER,
    toolCalls: [{ tool: "private_tool", params: { payload: { text: PRIVATE_MARKER } } }],
    requiresApproval: false, mock: false,
  };
  h.loadState.mockImplementation(async () => h.state);
  h.decide.mockImplementation(async () => h.decision);
  h.buildContext.mockResolvedValue({ privateContext: PRIVATE_MARKER });
  h.execute.mockResolvedValue({ ok: true, privateResult: PRIVATE_MARKER });
  h.legacyExecute.mockResolvedValue({ ok: true, privateResult: PRIVATE_MARKER });
  h.pending.mockResolvedValue("private-pending");
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
});

describe("private tool traces through the real agent cycle", () => {
  it("protects a disabled tool result through the real cycle without sending any request", async () => {
    const disabledTool = tool();
    const execute = vi.spyOn(disabledTool, "execute");
    h.execute.mockResolvedValue({ ok: false, reason: "disabled", providerAttempted: false });
    const network = vi.spyOn(globalThis, "fetch");
    try {
      const result = await run([disabledTool]);
      expect(result.status).toBe("error");
      expect(result.toolsUsed[0]).toMatchObject({ tool: "private_tool", outcome: "failed", success: false });
      expect(execute).toHaveBeenCalledOnce();
      expect(await execute.mock.results[0].value).toMatchObject({ ok: false, reason: "disabled", providerAttempted: false });
      expect(network).not.toHaveBeenCalled();
      expectPrivateTraceAbsent(result);
    } finally {
      execute.mockRestore();
      network.mockRestore();
    }
  });

  it("preserves execution arguments and successful evidence while minimizing the returned and stored trace", async () => {
    const params = h.decision.toolCalls[0].params;
    Object.freeze(params.payload);
    Object.freeze(params);
    const result = await run();
    expect(result.status).toBe("success");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "private_tool", outcome: "executed", success: true });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0][0]).toBe(params);
    expect(h.execute.mock.calls[0][1]).toMatchObject({ userId: "private-user", operationId: "private-run:0", mode: "live" });
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
    expect(params).toEqual({ payload: { text: PRIVATE_MARKER } });
  });

  it("preserves legacy traces when no protected tool or unknown call is involved", async () => {
    h.decision.toolCalls[0].tool = "legacy_tool";
    const result = await run([tool("legacy_tool", false)]);
    expect(result.status).toBe("success");
    expect(result.decision).toBe(PRIVATE_MARKER);
    expect(result.toolsUsed[0].paramsSummary).toContain(PRIVATE_MARKER);
    expect(result.toolsUsed[0].resultSummary).toContain(PRIVATE_MARKER);
    expect(h.legacyExecute).toHaveBeenCalledOnce();
  });

  it("protects a cycle even when its protected tool is not selected", async () => {
    h.decision.toolCalls = [{ tool: "legacy_tool", params: { payload: { text: PRIVATE_MARKER } } }];
    const result = await run([tool(), tool("legacy_tool", false)]);
    expect(result.status).toBe("success");
    expect(h.legacyExecute).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("protects every trace of a mixed cycle before the protected call is reached", async () => {
    h.decision.toolCalls.unshift({ tool: "legacy_tool", params: { payload: { text: PRIVATE_MARKER } } });
    const result = await run([tool(), tool("legacy_tool", false)]);
    expect(result.status).toBe("success");
    expect(result.toolsUsed.map(item => item.outcome)).toEqual(["executed", "executed"]);
    expect(h.legacyExecute).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("minimizes provider exceptions while preserving failure and preventing a later action", async () => {
    h.execute.mockRejectedValue(new Error(PRIVATE_MARKER));
    h.decision.toolCalls.push({ tool: "legacy_tool", params: { payload: { text: PRIVATE_MARKER } } });
    const result = await run([tool(), tool("legacy_tool", false)]);
    expect(result.status).toBe("error");
    expect(result.retryable).toBe(false);
    expect(result.toolsUsed.map(item => item.outcome)).toEqual(["failed", "skipped"]);
    expect(h.legacyExecute).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("does not leak a private unknown parameter name from local validation", async () => {
    h.decision.toolCalls[0].params[PRIVATE_MARKER] = "invalid property";
    const result = await run();
    expect(result.status).toBe("error");
    expect(result.toolsUsed[0].outcome).toBe("failed");
    expect(h.execute).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it.each(["simulation", "mock"] as const)("minimizes %s traces without executing or creating an approval", async mode => {
    if (mode === "simulation") h.state.simulationMode = true;
    else h.decision.mock = true;
    h.decision.requiresApproval = true;
    const result = await run();
    expect(result.status).toBe("simulated");
    expect(result.toolsUsed[0]).toMatchObject({ success: false, outcome: "simulated" });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("retains the exact approval payload but minimizes pending, deferred and notification traces", async () => {
    h.state.autonomyLevel = 2;
    const params = h.decision.toolCalls[0].params;
    h.decision.toolCalls.push({ tool: "legacy_tool", params: { payload: { text: PRIVATE_MARKER } } });
    const result = await run([tool(), tool("legacy_tool", false)]);
    expect(result.status).toBe("awaiting_approval");
    expect(result.toolsUsed.map(item => item.outcome)).toEqual(["pending", "skipped"]);
    expect(result.toolsUsed[0].pendingActionId).toBe("private-pending");
    expect(h.pending).toHaveBeenCalledOnce();
    expect(h.pending.mock.calls[0][0].toolParams).toBe(params);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.legacyExecute).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0][0]).toMatchObject({ actionType: "review", channels: ["in_app", "push", "email"] });
    expectPrivateTraceAbsent(result);
  });

  it("minimizes cancelled remaining calls without replaying the completed action", async () => {
    h.execute.mockImplementation(async () => { h.stopped = true; return { ok: true, privateResult: PRIVATE_MARKER }; });
    h.decision.toolCalls.push({ tool: "private_tool", params: { payload: { text: PRIVATE_MARKER } } });
    const result = await run();
    expect(result.status).toBe("cancelled");
    expect(result.toolsUsed.map(item => item.outcome)).toEqual(["executed", "skipped"]);
    expect(h.execute).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("does not echo an unknown tool name or any earlier legacy trace", async () => {
    h.decision.toolCalls = [
      { tool: "legacy_tool", params: { payload: { text: PRIVATE_MARKER } } },
      { tool: PRIVATE_MARKER, params: { payload: { text: PRIVATE_MARKER } } },
    ];
    const result = await run([tool("legacy_tool", false)]);
    expect(result.status).toBe("error");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "legacy_tool", outcome: "executed" });
    expect(result.toolsUsed[1]).toMatchObject({ tool: "unknown_tool", outcome: "failed" });
    expect(h.legacyExecute).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it.each(["context", "decision"] as const)("protects private %s exceptions before tool selection", async failure => {
    if (failure === "context") h.buildContext.mockRejectedValue(new Error(PRIVATE_MARKER));
    else h.decide.mockRejectedValue(new Error(PRIVATE_MARKER));
    const result = await run();
    expect(result.status).toBe("error");
    expect(h.execute).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("retains executed evidence and forbids replay after bookkeeping fails", async () => {
    h.record.mockRejectedValue(new Error(PRIVATE_MARKER));
    const result = await run();
    expect(result.status).toBe("success");
    expect(result.retryable).toBe(false);
    expect(result.toolsUsed[0]).toMatchObject({ outcome: "executed", success: true });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it.each(["cyclic", "bigint", "getter"] as const)("does not serialize a private nested %s parameter for observability", async kind => {
    const getter = vi.fn(() => { throw new Error(PRIVATE_MARKER); });
    const payload: Record<string, unknown> = { text: PRIVATE_MARKER };
    if (kind === "cyclic") payload.self = payload;
    if (kind === "bigint") payload.counter = 1n;
    if (kind === "getter") Object.defineProperty(payload, "secret", { enumerable: true, get: getter });
    h.decision.toolCalls[0].params = { payload };
    const result = await run();
    expect(result.status).toBe("success");
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0][0]).toBe(h.decision.toolCalls[0].params);
    expect(getter).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("does not serialize a private tool result or mutate it", async () => {
    const getter = vi.fn(() => { throw new Error(PRIVATE_MARKER); });
    const value: Record<string, unknown> = { ok: true, privateResult: PRIVATE_MARKER, count: 1n };
    value.self = value;
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    h.execute.mockResolvedValue(value);
    const result = await run();
    expect(result.status).toBe("success");
    expect(value.self).toBe(value);
    expect(value.privateResult).toBe(PRIVATE_MARKER);
    expect(getter).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it.each(["known", "unknown"] as const)("minimizes a prior %s tool result without rewriting history or re-executing it", async kind => {
    const prior: AgentRunResult = {
      status: "error", decision: PRIVATE_MARKER,
      toolsUsed: [{ tool: kind === "known" ? "private_tool" : PRIVATE_MARKER, paramsSummary: PRIVATE_MARKER, resultSummary: PRIVATE_MARKER, success: true, outcome: "executed", pendingActionId: "prior-pending" }],
      resultSummary: PRIVATE_MARKER, errorMessage: PRIVATE_MARKER, mock: false, retryable: false,
    };
    h.existing = prior;
    const result = await run(kind === "known" ? undefined : [tool("legacy_tool", false)]);
    expect(result.status).toBe("error");
    expect(result.retryable).toBe(false);
    expect(result.toolsUsed[0]).toMatchObject({ tool: kind === "known" ? "private_tool" : "unknown_tool", success: true, outcome: "executed", pendingActionId: "prior-pending" });
    expect(result).not.toBe(prior);
    expect(prior.decision).toBe(PRIVATE_MARKER);
    expect(prior.toolsUsed[0].paramsSummary).toBe(PRIVATE_MARKER);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("preserves the legacy executed count when an old successful trace has no detailed outcome", async () => {
    h.existing = {
      status: "success", decision: PRIVATE_MARKER,
      toolsUsed: [{ tool: "private_tool", paramsSummary: PRIVATE_MARKER, resultSummary: PRIVATE_MARKER, success: true }],
      resultSummary: PRIVATE_MARKER, mock: false, retryable: false,
    };
    const result = await run();
    expect(result.status).toBe("success");
    expect(result.toolsUsed[0].success).toBe(true);
    expect(result.resultSummary).toContain("1/1 action(s) exécutée(s)");
    expect(result.resultSummary).not.toContain("0/1 action(s) exécutée(s)");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });
});
