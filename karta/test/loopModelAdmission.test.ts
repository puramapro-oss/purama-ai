import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalContinuation } from "../src/engine/approval-continuation.js";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState, AgentTrigger } from "../src/engine/types.js";

const SECRET = "PRIVATE_MODEL_ADMISSION_CONTEXT_AND_DATABASE_DETAIL";
const userId = "model-admission-user";
const trigger: AgentTrigger = { type: "manual", source: "model-admission-test" };
const h = vi.hoisted(() => ({
  state: {} as AgentState,
  stopped: false,
  existing: undefined as AgentRunResult | undefined,
  global: vi.fn(), stateRead: vi.fn(), client: vi.fn(), decide: vi.fn(), context: vi.fn(),
  resolveDefinition: vi.fn(), continuation: vi.fn(), claim: vi.fn(), peek: vi.fn(), arm: vi.fn(),
  execute: vi.fn(), pending: vi.fn(), finish: vi.fn(), record: vi.fn(), notify: vi.fn(),
}));

// The real cycle owns admission, continuation ordering, privacy and closure.
// Explicit boundary doubles keep all model/provider/queue operations inert.
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: h.client }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: h.global }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.stateRead, recordRunOutcome: h.record,
}));
vi.mock("../src/engine/resolveDefinition.js", async original => ({
  ...await original<typeof import("../src/engine/resolveDefinition.js")>(),
  resolveAgentDefinition: h.resolveDefinition,
}));
vi.mock("../src/engine/approval-continuation.js", async original => ({
  ...await original<typeof import("../src/engine/approval-continuation.js")>(),
  loadApprovalContinuation: h.continuation,
}));
vi.mock("../src/engine/brief.js", () => ({
  claimPendingBrief: h.claim, peekPendingBrief: h.peek, armPendingBrief: h.arm,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "model-admission-run", existingResult: h.existing, finish: h.finish }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { runAgentCycle } = await import("../src/engine/loop.js");
const { CustomAgentAuthorizationError } = await import("../src/engine/resolveDefinition.js");

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function definition(kind: "static" | "brief" | "custom" = "static"): AgentDefinition {
  return {
    type: kind === "brief" ? "newsletter-genie" : kind === "custom" ? "custom:model-admission" : "legal",
    ...(kind === "brief" ? { pendingBriefKey: "pending_brief" } : {}),
    systemPrompt: "Isolated admission regression",
    buildContext: h.context,
    tools: [{ name: "act", description: "inert action", sensitive: false, execute: h.execute }],
  };
}

function cycle(agent = definition(), source = trigger, executionKey: string | undefined = "model-admission-delivery") {
  return runAgentCycle(userId, agent, source, executionKey);
}

async function whileContextWaits(change: () => void, agent = definition(), source = trigger) {
  const entered = gate();
  const released = gate();
  h.context.mockImplementationOnce(async () => {
    entered.resolve();
    await released.promise;
    return { privateContext: SECRET };
  });
  const running = cycle(agent, source);
  await entered.promise;
  change();
  released.resolve();
  return running;
}

function expectNoInference(result: AgentRunResult, status: "cancelled" | "error" = "cancelled") {
  expect(h.client).not.toHaveBeenCalled();
  expect(h.decide).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status, toolsUsed: [], mock: false, retryable: false });
  expect(h.arm).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.pending).not.toHaveBeenCalled();
  expect(h.notify).not.toHaveBeenCalled();
  expect(JSON.stringify([result, h.finish.mock.calls, h.record.mock.calls])).not.toContain(SECRET);
}

const changes = ["global", "disabled", "individual", "simulation"] as const;
function stop(change: typeof changes[number]) {
  if (change === "global") h.stopped = true;
  else if (change === "disabled") h.state.isEnabled = false;
  else if (change === "individual") h.state.killSwitch = true;
  else h.state.simulationMode = true;
}

beforeEach(() => {
  vi.resetAllMocks();
  h.stopped = false; h.existing = undefined;
  h.state = { userId, agentType: "legal", isEnabled: true, killSwitch: false, simulationMode: false, autonomyLevel: 3 };
  // Return a snapshot, as the real state reader does. Mutating a previously
  // returned object would hide a missing authorization re-read in the cycle.
  h.stateRead.mockImplementation(async () => ({ ...h.state }));
  h.global.mockImplementation(async () => h.stopped);
  h.context.mockResolvedValue({ privateContext: SECRET });
  h.resolveDefinition.mockImplementation(async () => definition("custom"));
  h.continuation.mockResolvedValue(undefined);
  h.claim.mockResolvedValue({ brief: SECRET, briefId: "00000000-0000-4000-8000-000000000001" });
  h.peek.mockImplementation(h.claim.getMockImplementation()!);
  h.arm.mockResolvedValue(undefined);
  h.client.mockReturnValue({ isMock: false, decide: h.decide });
  h.decide.mockResolvedValue({
    summary: "Valid inert decision", toolCalls: [{ tool: "act", params: {} }], requiresApproval: false, mock: false,
  } satisfies AgentDecision);
  h.execute.mockResolvedValue({ ok: true });
  h.pending.mockResolvedValue("pending-model-admission");
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.notify.mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe.each(["static", "brief", "custom"] as const)("model admission for %s agents", kind => {
  it.each(changes)("does not send context to the model after a %s stop during context construction", async change => {
    const result = await whileContextWaits(() => stop(change), definition(kind));
    expectNoInference(result);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.record).toHaveBeenCalledWith(userId, definition(kind).type, "cancelled", expect.any(String));
    expect(h.global.mock.calls.every(([fresh]) => fresh === true)).toBe(true);
  });
});

describe("the last asynchronous admission boundaries", () => {
  it("checks a global stop after the final custom-definition read resolves", async () => {
    const entered = gate(); const released = gate();
    h.resolveDefinition.mockImplementationOnce(async () => {
      entered.resolve(); await released.promise; return definition("custom");
    });
    const running = cycle(definition("custom"));
    await entered.promise; h.stopped = true; released.resolve();
    expectNoInference(await running);
    expect(h.resolveDefinition).toHaveBeenCalledOnce();
  });

  it("preserves the existing refusal when custom-agent ownership is revoked", async () => {
    const result = await whileContextWaits(() => {
      h.resolveDefinition.mockRejectedValueOnce(new CustomAgentAuthorizationError());
    }, definition("custom"));
    expectNoInference(result);
  });

  it.each(["executed", "rejected"] as const)("checks the stop after a verified %s approval continuation", async resolution => {
    h.continuation.mockResolvedValue({
      executionTrigger: trigger,
      context: { previousRunId: "parent", pendingActionId: "resolved", resolution,
        resolvedAction: { tool: "old_action", params: {} }, previousActions: [] },
      repeatsResolvedAction: () => false,
    } satisfies ApprovalContinuation);
    const result = await whileContextWaits(() => { h.stopped = true; }, definition(), {
      type: "delegation", source: "approval-resume",
      payload: { previousRunId: "parent", pendingActionId: "resolved", resolution },
    });
    expectNoInference(result);
  });

  it("observes a global stop that arrives while the fresh state read is pending", async () => {
    const entered = gate(); const released = gate();
    h.stateRead.mockImplementationOnce(async () => ({ ...h.state }));
    h.stateRead.mockImplementationOnce(async () => {
      entered.resolve(); await released.promise; return { ...h.state };
    });
    const running = cycle();
    await entered.promise; h.stopped = true; released.resolve();
    expectNoInference(await running);
  });
});

describe.each(["static", "brief"] as const)("unverifiable admission and privacy for %s agents", kind => {
  it.each(["stateRead", "global"] as const)("fails closed without exposing a %s transport diagnostic", async boundary => {
    const agent = definition(kind);
    if (kind === "static") agent.tools = [];
    const result = await whileContextWaits(() => {
      h[boundary].mockRejectedValueOnce(new Error(SECRET));
    }, agent);
    expectNoInference(result, "error");
    expect(h.finish).toHaveBeenCalledOnce();
  });
});

describe("valid paths, simulation and immutable cancellation", () => {
  it.each([false, true])("does not add model-admission reads to an empty brief (simulation=%s)", async simulation => {
    h.state.simulationMode = simulation;
    h.claim.mockResolvedValue(null); h.peek.mockResolvedValue(null);
    expect(await cycle(definition("brief"))).toMatchObject({ status: "skipped", toolsUsed: [] });
    expect(h.context).not.toHaveBeenCalled();
    expect(h.client).not.toHaveBeenCalled();
    expect(h.stateRead).toHaveBeenCalledOnce();
    expect(h.global).toHaveBeenCalledOnce();
    expect(h.resolveDefinition).not.toHaveBeenCalled();
  });

  it.each(["static", "brief", "custom"] as const)("keeps a stable %s request functional with exactly one model call", async kind => {
    const result = await cycle(definition(kind));
    expect(result).toMatchObject({ status: "success", retryable: false });
    expect(h.client).toHaveBeenCalledOnce();
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.execute.mock.calls[0][1].operationId).toBe("model-admission-run:0");
  });

  it("keeps an initially simulated cycle simulated after live mode is enabled", async () => {
    h.state.simulationMode = true;
    const result = await whileContextWaits(() => { h.state.simulationMode = false; });
    expect(result.status).toBe("simulated");
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.arm).not.toHaveBeenCalled();
  });

  it("also prevents a simulated model request after a global stop", async () => {
    h.state.simulationMode = true;
    expectNoInference(await whileContextWaits(() => { h.stopped = true; }));
  });

  it("keeps inference available when lower autonomy requires human approval of the action", async () => {
    const result = await whileContextWaits(() => { h.state.autonomyLevel = 1; });
    expect(result.status).toBe("awaiting_approval");
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.pending).toHaveBeenCalledOnce();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("reconciles the same cancellation after one lost closing acknowledgement", async () => {
    h.finish.mockRejectedValueOnce(new Error(SECRET));
    const result = await whileContextWaits(() => { h.stopped = true; }, definition("brief"));
    expectNoInference(result);
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(h.finish.mock.calls[0][0]).toEqual(h.finish.mock.calls[1][0]);
  });

  it("never turns unconfirmed cancellation into success or permission to retry effects", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.finish.mockRejectedValue(new Error(SECRET));
    const result = await whileContextWaits(() => { h.stopped = true; }, definition("brief"));
    expectNoInference(result, "error");
    expect(h.finish).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SECRET);
  });

  it("preserves a confirmed cancellation when secondary bookkeeping fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.record.mockRejectedValue(new Error(SECRET));
    const result = await whileContextWaits(() => { h.stopped = true; }, definition("brief"));
    expectNoInference(result);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(SECRET);
  });

  it("returns a previously cancelled delivery without rebuilding context or retrying the model", async () => {
    h.existing = { status: "cancelled", decision: "Stopped", toolsUsed: [], resultSummary: "No action", mock: false, retryable: false };
    const result = await cycle();
    expect(result).toEqual(h.existing);
    expectNoInference(result);
    expect(h.context).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.stateRead).toHaveBeenCalledOnce();
    expect(h.global).toHaveBeenCalledOnce();
  });
});
