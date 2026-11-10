import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState } from "../src/engine/types.js";

const PRIVATE_BRIEF = "PRIVATE_BRIEF_MUST_SURVIVE_20261110";
const userId = "brief-user";
const runId = "brief-run";
const trigger = { type: "manual" as const, source: "brief-lifecycle-test" };
const h = vi.hoisted(() => ({
  state: {} as AgentState, stopped: false,
  existing: undefined as AgentRunResult | undefined,
  decision: {} as AgentDecision, events: [] as string[],
  claim: vi.fn(), peek: vi.fn(), arm: vi.fn(), buildContext: vi.fn(), decide: vi.fn(),
  execute: vi.fn(), finish: vi.fn(), record: vi.fn(), notify: vi.fn(), pending: vi.fn(),
  loadState: vi.fn(), legacyMemory: vi.fn(),
}));

// Real PostgreSQL transitions and RPC idempotency are covered separately.
// These tests exercise the real cycle and action definitions, with explicit
// boundary doubles. No real provider, approval, or database request is made.
vi.mock("../src/engine/brief.js", () => ({
  claimPendingBrief: h.claim, peekPendingBrief: h.peek, armPendingBrief: h.arm,
}));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: h.legacyMemory } }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.loadState, recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "brief-run", finish: h.finish, existingResult: h.existing }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));

const { runAgentCycle } = await import("../src/engine/loop.js");
const {
  campagnesParCourrielAgent, coldOutreachAgent, newsletterGenieAgent,
  maitreDesPublicites, planificateurDAppels, reservationIntelligente,
} = await import("../src/agents/actionAgents.js");

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    type: "newsletter-genie", pendingBriefKey: "pending_brief", systemPrompt: "Test brief lifecycle",
    buildContext: h.buildContext,
    tools: [{
      name: "act", description: "test action", sensitive: false,
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      execute: h.execute,
    }],
    ...overrides,
  };
}

function run(overrides: Partial<AgentDefinition> = {}) {
  return runAgentCycle(userId, definition(overrides), trigger, "brief-delivery");
}

function assertNoPrivateTrace(result: AgentRunResult): void {
  expect(JSON.stringify(result)).not.toContain(PRIVATE_BRIEF);
  for (const [outcome] of h.finish.mock.calls) expect(JSON.stringify(outcome)).not.toContain(PRIVATE_BRIEF);
  for (const [notification] of h.notify.mock.calls) expect(JSON.stringify(notification)).not.toContain(PRIVATE_BRIEF);
}

beforeEach(() => {
  vi.resetAllMocks();
  h.events = []; h.stopped = false; h.existing = undefined;
  h.state = { userId, agentType: "newsletter-genie", autonomyLevel: 3, isEnabled: true, killSwitch: false, simulationMode: false };
  h.decision = { summary: PRIVATE_BRIEF, toolCalls: [{ tool: "act", params: { text: PRIVATE_BRIEF } }], requiresApproval: false, mock: false };
  h.loadState.mockImplementation(async () => ({ ...h.state }));
  h.claim.mockImplementation(async () => { h.events.push("claim"); return { brief: PRIVATE_BRIEF, briefId: "brief-id" }; });
  h.peek.mockImplementation(async () => { h.events.push("peek"); return { brief: PRIVATE_BRIEF, briefId: "brief-id" }; });
  h.arm.mockImplementation(async () => { h.events.push("arm"); });
  h.buildContext.mockImplementation(async (_user, _trigger, prepared) => {
    h.events.push("context");
    return { items: [{ brief: prepared?.pendingBrief }] };
  });
  h.decide.mockImplementation(async () => { h.events.push("decide"); return h.decision; });
  h.execute.mockImplementation(async () => { h.events.push("execute"); return { ok: true, privateOutput: PRIVATE_BRIEF }; });
  h.pending.mockImplementation(async () => { h.events.push("pending"); return "approval-id"; });
  h.finish.mockImplementation(async () => { h.events.push("finish"); });
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
  h.legacyMemory.mockImplementation(() => { throw new Error("Destructive legacy memory access is forbidden in brief cycles"); });
});

describe("durable brief preparation through the real agent cycle", () => {
  it("reserves the exact owner/run/key before context and arms before executing", async () => {
    const result = await run();
    expect(result).toMatchObject({ status: "success", retryable: false });
    expect(h.events).toEqual(["claim", "context", "decide", "arm", "execute", "finish"]);
    expect(h.claim).toHaveBeenCalledWith({ userId, agentType: "newsletter-genie", runId, key: "pending_brief" });
    expect(h.buildContext).toHaveBeenCalledWith(userId, trigger, { pendingBrief: PRIVATE_BRIEF });
    expect(h.arm).toHaveBeenCalledWith({ userId, agentType: "newsletter-genie", runId });
    expect(h.decide.mock.calls[0][0].context).toEqual({ items: [{ brief: PRIVATE_BRIEF }] });
    expect(h.execute.mock.calls[0][0]).toBe(h.decision.toolCalls[0].params);
    expect(h.execute.mock.calls[0][1]).toMatchObject({ userId, agentType: "newsletter-genie", mode: "live", operationId: runId + ":0" });
    assertNoPrivateTrace(result);
  });

  it.each([false, true])("does not spend inference or execute when no brief is available (simulation=%s)", async simulation => {
    h.state.simulationMode = simulation;
    h.claim.mockResolvedValue(null); h.peek.mockResolvedValue(null);
    const result = await run();
    expect(result).toMatchObject({ status: "skipped", toolsUsed: [], retryable: false });
    expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledWith(userId, "newsletter-genie", "skipped", expect.any(String));
    expect(simulation ? h.peek : h.claim).toHaveBeenCalledOnce();
    expect(simulation ? h.claim : h.peek).not.toHaveBeenCalled();
  });

  it("simulation previews the instruction without claiming or arming it", async () => {
    h.state.simulationMode = true; h.decision.requiresApproval = true;
    const result = await run();
    expect(result.status).toBe("simulated");
    expect(h.peek).toHaveBeenCalledWith({ userId, agentType: "newsletter-genie", runId, key: "pending_brief" });
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(result.toolsUsed[0]).toMatchObject({ outcome: "simulated", success: false });
    assertNoPrivateTrace(result);
  });

  it("a mock decision in live mode closes without arming or consuming an action", async () => {
    h.decision.mock = true; h.decision.requiresApproval = true;
    const result = await run();
    expect(result).toMatchObject({ status: "simulated", mock: true });
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: "simulated", mock: true });
  });

  it("does not arm a brief when the model proposes no actions", async () => {
    h.decision.toolCalls = [];
    const result = await run();
    expect(result.status).toBe("skipped");
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(result.toolsUsed).toEqual([]);
    expect(h.finish).toHaveBeenCalledOnce();
    assertNoPrivateTrace(result);
  });

  it.each(["claim", "peek"] as const)("sanitizes a failed %s before inference or effects", async preparation => {
    h.state.simulationMode = preparation === "peek";
    h[preparation].mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await run();
    expect(result.status).toBe("error");
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    assertNoPrivateTrace(result);
  });

  it("closes a context failure without a destructive legacy read or an effect barrier", async () => {
    h.buildContext.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await run();
    expect(result.status).toBe("error");
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.legacyMemory).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: "error", toolsUsed: [] });
    assertNoPrivateTrace(result);
  });

  it("keeps model failures before the effect barrier for durable recovery", async () => {
    h.decide.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await run();
    expect(result).toMatchObject({ status: "error", toolsUsed: [] });
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.legacyMemory).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: "error", toolsUsed: [] });
    assertNoPrivateTrace(result);
  });

  it.each(["unknown", "invalid"])("does not cross the barrier for an %s call", async kind => {
    if (kind === "unknown") h.decision.toolCalls[0].tool = "unknown";
    else h.decision.toolCalls[0].params = { invalid: PRIVATE_BRIEF };
    const result = await run();
    expect(result.status).toBe("error");
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    assertNoPrivateTrace(result);
  });

  it("does not reacquire a historical delivery or expose its old private trace", async () => {
    h.existing = { status: "success", decision: PRIVATE_BRIEF, resultSummary: PRIVATE_BRIEF, toolsUsed: [], mock: false, retryable: false };
    const result = await run();
    expect(result.status).toBe("success");
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    assertNoPrivateTrace(result);
  });

  it("leaves agents without a brief source on their existing execution path", async () => {
    const result = await run({ type: "legal", pendingBriefKey: undefined });
    expect(result.status).toBe("success");
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.peek).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.buildContext).toHaveBeenCalledWith(userId, trigger);
    expect(h.execute).toHaveBeenCalledOnce();
  });
});

describe("effect barrier and immutable completion", () => {
  it("also forbids automatic replay after ambiguous approval creation in a legacy non-brief agent", async () => {
    h.decision.requiresApproval = true;
    h.pending.mockRejectedValue(new Error("Approval write acknowledgement lost"));
    const result = await runAgentCycle(userId, definition({ type: "legal", pendingBriefKey: undefined }), trigger);
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.pending).toHaveBeenCalledOnce();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("arms durably before creating an approval while retaining original execution data", async () => {
    h.decision.requiresApproval = true;
    const result = await run();
    expect(result.status).toBe("awaiting_approval");
    expect(h.events).toEqual(["claim", "context", "decide", "arm", "pending", "finish"]);
    expect(h.pending).toHaveBeenCalledWith({ userId, runId, agentType: "newsletter-genie", toolName: "act", toolParams: h.decision.toolCalls[0].params });
    expect(result.toolsUsed[0]).toMatchObject({ pendingActionId: "approval-id", tracePolicy: "metadata_only", outcome: "pending" });
    expect(h.execute).not.toHaveBeenCalled();
    assertNoPrivateTrace(result);
  });

  it.each([false, true])("an unconfirmed arm prevents effects and automatic retry (approval=%s)", async approval => {
    h.decision.requiresApproval = approval;
    h.arm.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await runAgentCycle(userId, definition(), trigger);
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.arm).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    assertNoPrivateTrace(result);
  });

  it.each(["global", "disabled", "killSwitch", "simulation"] as const)(
    "checks a %s stop while the barrier was being persisted", async change => {
      h.arm.mockImplementation(async () => {
        h.events.push("arm");
        if (change === "global") h.stopped = true;
        else if (change === "disabled") h.state.isEnabled = false;
        else if (change === "killSwitch") h.state.killSwitch = true;
        else h.state.simulationMode = true;
      });
      const result = await run();
      expect(result.status).toBe("cancelled");
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.pending).not.toHaveBeenCalled();
      expect(h.arm).toHaveBeenCalledOnce();
    });

  it("recomputes approval when autonomy is lowered while the barrier is persisted", async () => {
    h.arm.mockImplementation(async () => { h.events.push("arm"); h.state.autonomyLevel = 1; });
    const result = await run();
    expect(result.status).toBe("awaiting_approval");
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).toHaveBeenCalledOnce();
  });

  it("arms once before two tools while keeping distinct provider operation identities", async () => {
    h.decision.toolCalls.push({ tool: "act", params: { text: PRIVATE_BRIEF } });
    const result = await run();
    expect(result.status).toBe("success");
    expect(h.arm).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(h.execute.mock.calls.map(call => call[1].operationId)).toEqual([runId + ":0", runId + ":1"]);
    expect(h.events.indexOf("arm")).toBeLessThan(h.events.indexOf("execute"));
    assertNoPrivateTrace(result);
  });

  it("does not replay an effect after a lost completion acknowledgement", async () => {
    h.finish.mockRejectedValueOnce(new Error(PRIVATE_BRIEF));
    const result = await run();
    expect(result).toMatchObject({ status: "success", retryable: false });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[1][0]).toEqual(h.finish.mock.calls[0][0]);
    expect(h.claim).toHaveBeenCalledOnce();
    expect(h.arm).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    assertNoPrivateTrace(result);
  });

  it("does not replay an effect when closure remains ambiguous", async () => {
    h.finish.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await run();
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.arm).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    assertNoPrivateTrace(result);
  });

  it("forbids automatic retry if an inference failure cannot be durably closed", async () => {
    h.decide.mockRejectedValue(new Error(PRIVATE_BRIEF));
    h.finish.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await runAgentCycle(userId, definition(), trigger);
    expect(result).toMatchObject({ status: "error", retryable: false, toolsUsed: [] });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    assertNoPrivateTrace(result);
  });

  it("preserves confirmed success when secondary bookkeeping fails", async () => {
    h.record.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await run();
    expect(result).toMatchObject({ status: "success", retryable: false });
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.arm).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    assertNoPrivateTrace(result);
  });
});

describe("actual brief-driven action agents", () => {
  it.each([
    campagnesParCourrielAgent, coldOutreachAgent, newsletterGenieAgent,
    maitreDesPublicites, planificateurDAppels, reservationIntelligente,
  ])("$type consumes only the prepared context, never the legacy memory reader", async agent => {
    expect(agent.pendingBriefKey).toBe("pending_brief");
    expect(await agent.buildContext(userId, trigger, { pendingBrief: PRIVATE_BRIEF })).toEqual({ items: [{ brief: PRIVATE_BRIEF }] });
    expect(await agent.buildContext(userId, trigger)).toMatchObject({ items: [] });
    expect(h.legacyMemory).not.toHaveBeenCalled();
  });

  it("routes the real newsletter definition through the durable claim before inference failure", async () => {
    h.decide.mockRejectedValue(new Error(PRIVATE_BRIEF));
    const result = await runAgentCycle(userId, newsletterGenieAgent, trigger, "real-newsletter-delivery");
    expect(result.status).toBe("error");
    expect(h.claim).toHaveBeenCalledWith({ userId, agentType: "newsletter-genie", runId, key: "pending_brief" });
    expect(h.decide.mock.calls[0][0].context).toEqual({ items: [{ brief: PRIVATE_BRIEF }] });
    expect(h.arm).not.toHaveBeenCalled();
    expect(h.legacyMemory).not.toHaveBeenCalled();
    expect(h.finish.mock.calls[0][0]).toMatchObject({ status: "error", toolsUsed: [] });
    assertNoPrivateTrace(result);
  });
});
