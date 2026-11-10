import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState } from "../src/engine/types.js";
import type { JevAdmissionRequest, JevPermit } from "../src/tools/jev.js";
import { JEV_MODEL, type JevRequest, type JevResponse } from "../src/jev/schema.js";

const PRIVATE_MARKER = "PRIVATE_JEV_LOOP_SENTINEL_20261110";
const EPOCH = 1_800_000_000_000;
const h = vi.hoisted(() => ({
  state: {} as AgentState,
  decision: {} as AgentDecision,
  finish: vi.fn(), record: vi.fn(), pending: vi.fn(), notify: vi.fn(),
  buildContext: vi.fn(), decide: vi.fn(), loadState: vi.fn(),
}));

vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.loadState,
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "jev-private-run", finish: h.finish }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));

const { runAgentCycle } = await import("../src/engine/loop.js");
// Exercise the public factory export as well as the real Jev tool and transport.
const { createJevJudgmentTool } = await import("../src/tools/registry.js");

function request(): JevRequest {
  return {
    state: PRIVATE_MARKER,
    questions: {
      category: {
        type: "choice", instructions: "Classify the permitted state",
        criteria: { [PRIVATE_MARKER]: "Private category", other: "Other category" },
      },
    },
  };
}

function response(): JevResponse {
  return {
    model: JEV_MODEL,
    answers: {
      category: {
        type: "choice", choice: PRIVATE_MARKER,
        probabilities: { [PRIVATE_MARKER]: 0.99, other: 0.01 }, confidence: 0.99,
      },
    },
    usage: { input_tokens: 21, output_tokens: 8 },
  };
}

function configuredTool() {
  const authorizeAndReserve = vi.fn(async (admission: JevAdmissionRequest): Promise<JevPermit> => ({
    userId: admission.userId, operationId: admission.operationId,
    requestHash: admission.requestHash, model: JEV_MODEL,
    reservationId: "synthetic-reservation", qualificationRef: "synthetic-test-only",
    validUntilMs: EPOCH + 60_000, signal: new AbortController().signal,
    thresholds: { category: { type: "confidence", minConfidence: 0.8 } },
  }));
  const settle = vi.fn(async () => undefined);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(response()));
  const tool = createJevJudgmentTool({
    enabled: true, apiKey: "synthetic-key", authorizeAndReserve, settle, fetchImpl, now: () => EPOCH,
  });
  return { tool, authorizeAndReserve, settle, fetchImpl };
}

function run(tool: ReturnType<typeof createJevJudgmentTool>) {
  const definition: AgentDefinition = {
    type: "legal", systemPrompt: "test", buildContext: h.buildContext, tools: [tool],
  };
  return runAgentCycle("jev-private-user", definition, { type: "manual", source: "jev-trace-test" }, "jev-private-delivery");
}

function expectPrivateTraceAbsent(result: AgentRunResult): void {
  expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
  for (const [outcome] of h.finish.mock.calls) expect(JSON.stringify(outcome)).not.toContain(PRIVATE_MARKER);
  for (const [notification] of h.notify.mock.calls) expect(JSON.stringify(notification)).not.toContain(PRIVATE_MARKER);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.state = {
    userId: "jev-private-user", agentType: "legal", isEnabled: true,
    autonomyLevel: 3, killSwitch: false, simulationMode: false,
  };
  h.decision = {
    summary: PRIVATE_MARKER,
    toolCalls: [{ tool: "jev_judgment", params: { ...request() } }],
    requiresApproval: false, mock: false,
  };
  h.loadState.mockImplementation(async () => h.state);
  h.decide.mockImplementation(async () => h.decision);
  h.buildContext.mockResolvedValue({ privateContext: PRIVATE_MARKER });
  h.pending.mockResolvedValue("jev-private-pending");
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request in Jev integration test"));
});

afterEach(() => { vi.restoreAllMocks(); });

describe("real Jev tools through the consolidated private agent cycle", () => {
  it("keeps the default factory disabled and protects its failure without sending a request", async () => {
    const tool = createJevJudgmentTool({});
    const execute = vi.spyOn(tool, "execute");
    const result = await run(tool);
    expect(result.status).toBe("error");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "jev_judgment", outcome: "failed", success: false });
    expect(execute).toHaveBeenCalledOnce();
    expect(await execute.mock.results[0].value).toMatchObject({ ok: false, reason: "disabled", providerAttempted: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("preserves authorized private judgments while excluding them from results and finalization traces", async () => {
    const fixture = configuredTool();
    const execute = vi.spyOn(fixture.tool, "execute");
    const params = h.decision.toolCalls[0].params;
    const before = structuredClone(params);
    const result = await run(fixture.tool);
    expect(result.status).toBe("success");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "jev_judgment", outcome: "executed", success: true });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][0]).toBe(params);
    const raw = await execute.mock.results[0].value;
    expect(raw).toMatchObject({ ok: true, decisions: { category: { status: "candidate", answer: { choice: PRIVATE_MARKER } } } });
    expect(fixture.authorizeAndReserve).toHaveBeenCalledOnce();
    expect(fixture.authorizeAndReserve.mock.calls[0][0]).toMatchObject({
      userId: "jev-private-user", operationId: "jev-private-run:0", request: before,
    });
    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fixture.fetchImpl.mock.calls[0][1]?.body))).toEqual({ model: JEV_MODEL, ...before });
    expect(fixture.settle).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
      providerAttempted: true, usageKnown: true, usage: { input_tokens: 21, output_tokens: 8 }, outcome: "received",
    }, expect.any(AbortSignal));
    expect(fixture.settle).toHaveBeenCalledOnce();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(params).toEqual(before);
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("retains the approved payload path and hides it from pending notifications without dispatch", async () => {
    h.state.autonomyLevel = 2;
    const fixture = configuredTool();
    const execute = vi.spyOn(fixture.tool, "execute");
    const params = h.decision.toolCalls[0].params;
    const result = await run(fixture.tool);
    expect(result.status).toBe("awaiting_approval");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "jev_judgment", outcome: "pending", pendingActionId: "jev-private-pending" });
    expect(h.pending).toHaveBeenCalledOnce();
    expect(h.pending.mock.calls[0][0].toolParams).toBe(params);
    expect(JSON.stringify(h.pending.mock.calls[0][0].toolParams)).toContain(PRIVATE_MARKER);
    expect(execute).not.toHaveBeenCalled();
    expect(fixture.authorizeAndReserve).not.toHaveBeenCalled();
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.settle).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });
});
