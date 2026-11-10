import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentRunResult } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  pending: false,
  noCalls: false,
  record: vi.fn(),
  finish: vi.fn(),
  notify: vi.fn(),
  execute: vi.fn(),
  stored: undefined as AgentRunResult | undefined,
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: async () => ({
  summary: "A checked action", toolCalls: h.noCalls ? [] : [{ tool: "act", params: {} }], requiresApproval: h.pending, mock: false,
}) }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", () => ({
  loadAgentState: async () => ({ userId: "u", agentType: "legal", isEnabled: true, killSwitch: false, simulationMode: false, autonomyLevel: 3 }),
  isRunnable: () => ({ ok: true }), requiresHumanApproval: () => false, recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "run", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: async () => "approval-1" }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
const { runAgentCycle } = await import("../src/engine/loop.js");
const definition: AgentDefinition = {
  type: "legal", systemPrompt: "test", buildContext: async () => ({}),
  tools: [{ name: "act", description: "test", sensitive: false, execute: h.execute }],
};
const run = () => runAgentCycle("u", definition, { type: "manual", source: "test" }, "single-delivery");

beforeEach(() => {
  vi.clearAllMocks(); h.pending = false; h.noCalls = false; h.stored = undefined;
  h.finish.mockImplementation(async (outcome: AgentRunResult) => { h.stored = structuredClone(outcome); });
  h.execute.mockResolvedValue({ ok: true });
  h.notify.mockResolvedValue(undefined);
  h.record.mockRejectedValue(new Error("Secondary state store unavailable"));
});

describe("a committed cycle remains final when secondary bookkeeping fails", () => {
  it("preserves a newer approval resolution that occurs during notification", async () => {
    h.pending = true;
    h.notify.mockImplementation(async () => {
      if (!h.stored) throw new Error("Missing committed journal");
      h.stored.status = "success";
      h.stored.toolsUsed[0] = { ...h.stored.toolsUsed[0], success: true, outcome: "executed", resultSummary: "Provider receipt" };
    });
    const outcome = await run();
    expect(outcome).toMatchObject({ status: "awaiting_approval", retryable: false });
    expect(h.stored).toMatchObject({ status: "success", toolsUsed: [{ pendingActionId: "approval-1", outcome: "executed", success: true, resultSummary: "Provider receipt" }] });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.record).toHaveBeenCalledOnce();
  });
});

describe("bounded reconciliation of the first cycle outcome", () => {
  it("forbids automatic replay without tools or an execution key after an uncertain close", async () => {
    h.noCalls = true;
    h.record.mockResolvedValue(undefined);
    h.finish.mockRejectedValue(new Error("Journal remains unavailable"));
    const outcome = await runAgentCycle("u", definition, { type: "manual", source: "test" });
    expect(outcome).toMatchObject({ status: "error", retryable: false, toolsUsed: [] });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[1][0]).toEqual(h.finish.mock.calls[0][0]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it.each([
    { pending: false, status: "success", executions: 1, notifications: 0 },
    { pending: true, status: "awaiting_approval", executions: 0, notifications: 1 },
  ] as const)("returns and follows up the confirmed $status outcome after one lost acknowledgement", async scenario => {
    h.pending = scenario.pending;
    h.record.mockResolvedValue(undefined);
    let firstCandidate: AgentRunResult | undefined;
    h.finish.mockImplementation(async (candidate: AgentRunResult) => {
      firstCandidate ??= structuredClone(candidate);
      // Match logger's first-outcome-wins contract: a lost acknowledgement
      // cannot turn the next finish(error) into a replacement database result.
      h.stored = structuredClone(firstCandidate);
      if (h.finish.mock.calls.length === 1) throw new Error("Lost write acknowledgement");
    });

    const outcome = await run();

    expect(outcome).toMatchObject({ status: scenario.status, retryable: false });
    expect(h.stored).toMatchObject({ status: scenario.status });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[1][0]).toEqual(h.finish.mock.calls[0][0]);
    expect(h.execute).toHaveBeenCalledTimes(scenario.executions);
    expect(h.notify).toHaveBeenCalledTimes(scenario.notifications);
    expect(h.record).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledWith("u", "legal", scenario.status, expect.any(String));
  });

  it.each([
    { pending: false, candidateStatus: "success", executions: 1 },
    { pending: true, candidateStatus: "awaiting_approval", executions: 0 },
  ] as const)("stops after two unconfirmed closes of $candidateStatus without replaying effects", async scenario => {
    h.pending = scenario.pending;
    h.record.mockResolvedValue(undefined);
    h.finish.mockRejectedValue(new Error("Journal remains unavailable"));

    const outcome = await run();

    expect(outcome).toMatchObject({ status: "error", retryable: false });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: scenario.candidateStatus });
    expect(h.finish.mock.calls[1][0]).toEqual(h.finish.mock.calls[0][0]);
    expect(h.execute).toHaveBeenCalledTimes(scenario.executions);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.stored).toBeUndefined();
  });
});
