import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState } from "../src/engine/types.js";
import type { ModelUsageReceipt } from "../src/claude/usage.js";

const h = vi.hoisted(() => ({ state: {} as AgentState, decision: {} as AgentDecision,
  existing: undefined as AgentRunResult | undefined, noBrief: false,
  finish: vi.fn(), decide: vi.fn(), start: vi.fn(), execute: vi.fn(), record: vi.fn(), pending: vi.fn(),
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: false, decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => h.state, recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: h.start }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
vi.mock("../src/engine/brief.js", () => ({ claimPendingBrief: async () => null, peekPendingBrief: async () => null, armPendingBrief: async () => undefined }));
const { runAgentCycle } = await import("../src/engine/loop.js");

const receipt: ModelUsageReceipt = Object.freeze({ version: 1, apiFormat: "anthropic_messages", routeKind: "compatible",
  requestedModel: "fixture-model", responseModel: "fixture-model-v1", responseId: "msg_receipt",
  inputTokens: 120, outputTokens: 8, cacheReadInputTokens: null, cacheCreationInputTokens: null,
  cacheCreation5mInputTokens: null, cacheCreation1hInputTokens: null,
});
type ObservedInput = ClaudeDecideInput & { onUsage?: (usage: ModelUsageReceipt) => void };
function definition(): AgentDefinition {
  return { type: "legal", systemPrompt: "fixture", buildContext: async () => ({
    userId: "forged-user", modelUsage: { inputTokens: 0 }, privateText: "PRIVATE_BUSINESS_CONTENT",
  }), ...(h.noBrief ? { pendingBriefKey: "fixture" } : {}), tools: [{
    name: "fixture_tool", sensitive: true, tracePolicy: "metadata_only", description: "fixture",
    execute: h.execute,
  }] };
}
const run = () => runAgentCycle("server-user", definition(), { type: "manual", source: "usage-fixture",
  payload: { modelUsage: { inputTokens: 0 }, userId: "forged-user" } }, "delivery-one");
beforeEach(() => {
  vi.resetAllMocks(); h.existing = undefined; h.noBrief = false;
  h.state = { userId: "server-user", agentType: "legal", isEnabled: true, autonomyLevel: 3, simulationMode: false, killSwitch: false };
  h.decision = { summary: "PRIVATE_BUSINESS_CONTENT", toolCalls: [{ tool: "fixture_tool", params: {} }], requiresApproval: false, mock: false };
  h.start.mockImplementation(async () => ({ runId: "server-run", existingResult: h.existing, finish: h.finish }));
  h.decide.mockImplementation(async (input: ObservedInput) => { input.onUsage?.(receipt); return h.decision; });
  h.finish.mockResolvedValue(undefined); h.execute.mockResolvedValue({ ok: true }); h.pending.mockResolvedValue("approval-one");
  h.record.mockResolvedValue(undefined);
});

describe("model usage attached to the server-owned KARTA run", () => {
  it.each(["success", "awaiting_approval", "simulated", "error"] as const)("stores the receipt for %s while keeping the public trace private", async status => {
    if (status === "awaiting_approval") h.state.autonomyLevel = 1;
    if (status === "simulated") h.state.simulationMode = true;
    if (status === "error") h.execute.mockRejectedValue(new Error("PRIVATE_BUSINESS_CONTENT"));
    const result = await run();
    expect(result.status).toBe(status);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0][0].modelUsage).toStrictEqual(receipt);
    expect(h.start.mock.calls[0][0]).toBe("server-user");
    expect(JSON.stringify(h.finish.mock.calls)).not.toContain("PRIVATE_BUSINESS_CONTENT");
    expect(JSON.stringify(h.finish.mock.calls)).not.toContain("forged-user");
    expect(result).not.toHaveProperty("modelUsage");
    expect(h.decide).toHaveBeenCalledOnce();
  });

  it("keeps provider counters when decision validation throws before any tool", async () => {
    h.decide.mockImplementation(async (input: ObservedInput) => { input.onUsage?.(receipt); throw new Error("incomplete decision"); });
    const result = await run();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.finish.mock.calls[0][0].modelUsage).toStrictEqual(receipt);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("preserves received consumption when a stop arrives before the first tool", async () => {
    h.decide.mockImplementation(async (input: ObservedInput) => {
      input.onUsage?.(receipt);
      h.state.killSwitch = true;
      return h.decision;
    });

    const result = await run();

    expect(result).toMatchObject({ status: "cancelled", retryable: false });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0][0].modelUsage).toStrictEqual(receipt);
    expect(h.finish.mock.calls[0][0].modelUsage.inputTokens).toBe(120);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
  });

  it("keeps consumption unknown when the transport fails before a receipt", async () => {
    h.decide.mockRejectedValue(new Error("connection lost"));
    await run();
    expect(h.finish.mock.calls[0][0]).not.toHaveProperty("modelUsage");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["no brief", "mock"])("does not fabricate a provider receipt for %s", async scenario => {
    if (scenario === "no brief") h.noBrief = true;
    else h.decide.mockResolvedValue({ ...h.decision, mock: true });
    await run();
    expect(h.finish.mock.calls[0][0]).not.toHaveProperty("modelUsage");
    if (h.noBrief) expect(h.decide).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("reconciles the same receipt after a lost journal acknowledgement without another inference", async () => {
    h.finish.mockRejectedValueOnce(new Error("lost acknowledgement")).mockResolvedValueOnce(undefined);
    expect((await run()).status).toBe("success");
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[0][0].modelUsage).toStrictEqual(receipt);
    expect(h.finish.mock.calls[1][0]).toStrictEqual(h.finish.mock.calls[0][0]);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
  });

  it("keeps the first receipt when both closes after an executed action remain unconfirmed", async () => {
    h.finish.mockRejectedValue(new Error("journal unavailable"));

    const result = await run();

    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: "success", modelUsage: receipt });
    expect(h.finish.mock.calls[1][0]).toStrictEqual(h.finish.mock.calls[0][0]);
    expect(h.finish.mock.calls[0][0].modelUsage.outputTokens).toBe(8);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.pending).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("modelUsage");
  });

  it("keeps the receipt after a rejected decision even when closing its error fails", async () => {
    h.decide.mockImplementation(async (input: ObservedInput) => {
      input.onUsage?.(receipt);
      throw new Error("incomplete decision");
    });
    h.finish.mockRejectedValue(new Error("journal unavailable"));

    const result = await run();

    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: "error", modelUsage: receipt });
    expect(h.finish.mock.calls[0][0].modelUsage.inputTokens).toBe(120);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty("modelUsage");
  });

  it("does not call the provider or rewrite usage on an existing delivery", async () => {
    h.existing = { status: "success", decision: "done", toolsUsed: [], resultSummary: "done", mock: false, retryable: false };
    await run();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("does not offer automatic inference replay after a receipt without a durable key", async () => {
    h.decide.mockImplementation(async (input: ObservedInput) => { input.onUsage?.(receipt); throw new Error("incomplete decision"); });
    const result = await runAgentCycle("server-user", definition(), { type: "manual", source: "usage-fixture" });
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.finish.mock.calls[0][0].modelUsage).toEqual(receipt);
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });
});
