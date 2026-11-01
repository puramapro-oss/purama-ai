import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentState, ToolExecutionContext } from "../src/engine/types.js";

// Exercise the real loop and tool executor. Only persistence/provider/external
// services are substituted; no network, physical device or real account is used.
const deps = vi.hoisted(() => ({
  decide: vi.fn(), state: vi.fn(), kill: vi.fn(), pending: vi.fn(),
}));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: () => { throw new Error("Unexpected DB access"); } } }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: deps.decide, isMock: true }) }));
vi.mock("../src/engine/autonomy.js", async (original) => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: deps.state, recordRunOutcome: vi.fn(async () => {}),
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: deps.kill }));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "audit", finish: async () => {} }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: deps.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => {} }));

import { runAgentCycle } from "../src/engine/loop.js";
import { executeToolStrict, ToolTimeoutError } from "../src/engine/tool-result.js";
import { robotSimulateSessionTool } from "../src/tools/robotics.js";

const initial: AgentState = {
  userId: "audit-owner", agentType: "legal", isEnabled: true,
  autonomyLevel: 3, killSwitch: false, simulationMode: false,
};
const trigger = { type: "manual" as const, source: "local-audit" };
const decision = {
  summary: "local audit", toolCalls: [{ tool: "probe", params: {} }],
  requiresApproval: false, mock: true,
};
function definition(execute: () => Promise<unknown>): AgentDefinition {
  return { type: "legal", systemPrompt: "test", buildContext: async () => ({}),
    tools: [{ name: "probe", description: "local inert probe", sensitive: true, execute }] };
}
beforeEach(() => {
  vi.resetAllMocks();
  deps.state.mockImplementation(async () => ({ ...initial }));
  deps.kill.mockResolvedValue(false);
  deps.pending.mockResolvedValue("approval-audit");
  deps.decide.mockResolvedValue(decision);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("permission changes during a real KARTA cycle", () => {
  it.each([
    ["agent disabled", { isEnabled: false }],
    ["agent kill switch", { killSwitch: true }],
    ["simulation enabled", { simulationMode: true }],
    ["autonomy reduced", { autonomyLevel: 1 as const }],
  ])("does not execute after %s during provider decision", async (_label, change) => {
    const execute = vi.fn(async () => ({ ok: true }));
    deps.decide.mockImplementation(async () => {
      deps.state.mockResolvedValue({ ...initial, ...change });
      return decision;
    });
    await runAgentCycle(initial.userId, definition(execute), trigger);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute if the global stop changes during provider decision", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    deps.decide.mockImplementation(async () => {
      deps.kill.mockResolvedValue(true);
      return decision;
    });
    await runAgentCycle(initial.userId, definition(execute), trigger);
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not execute the next tool after revocation by the first tool", async () => {
    const execute = vi.fn(async () => {
      deps.state.mockResolvedValue({ ...initial, isEnabled: false });
      return { ok: true };
    });
    deps.decide.mockResolvedValue({ ...decision, toolCalls: [decision.toolCalls[0], decision.toolCalls[0]] });
    await runAgentCycle(initial.userId, definition(execute), trigger);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a second tool after the first one times out", async () => {
    vi.useFakeTimers();
    const execute = vi.fn(() => new Promise<never>(() => {}));
    deps.decide.mockResolvedValue({ ...decision, toolCalls: [decision.toolCalls[0], decision.toolCalls[0]] });
    const pending = runAgentCycle(initial.userId, definition(execute), trigger);
    await vi.advanceTimersByTimeAsync(30_001);
    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("error");
    expect(result.sideEffectsCommitted).toBe(true);
    expect(result.toolsUsed).toHaveLength(1);
    expect(result.toolsUsed[0].success).toBe(false);
  });

  it("does not dispatch when permission refresh fails", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    deps.decide.mockImplementation(async () => {
      deps.state.mockRejectedValue(new Error("permission service unavailable"));
      return decision;
    });
    const result = await runAgentCycle(initial.userId, definition(execute), trigger);
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("error");
  });

  it("does not escalate an in-flight cycle when autonomy increases", async () => {
    deps.state.mockResolvedValue({ ...initial, autonomyLevel: 1 });
    const execute = vi.fn(async () => ({ ok: true }));
    deps.decide.mockImplementation(async () => {
      deps.state.mockResolvedValue({ ...initial, autonomyLevel: 3 });
      return decision;
    });
    const result = await runAgentCycle(initial.userId, definition(execute), trigger);
    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe("awaiting_approval");
  });
});

it("cancels a cooperative operation when its executor reports timeout", async () => {
  vi.useFakeTimers();
  let lateEffects = 0;
  const tool = {
    name: "delayed-probe", description: "inert delayed counter", sensitive: true,
    execute: async (_params: Record<string, unknown>, ctx: ToolExecutionContext) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { lateEffects += 1; resolve(); }, 40_000);
      // Optional structural read permits testing the old context, which has no
      // signal, as well as a future cancellation-aware context.
      const signal = (ctx as ToolExecutionContext & { signal?: AbortSignal }).signal;
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }),
  };
  const pending = executeToolStrict(tool, {}, { userId: initial.userId, agentType: "legal", mode: "live" })
    .then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(await pending).toBeInstanceOf(ToolTimeoutError);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(lateEffects).toBe(0);
});

it("does not start an operation with a pre-aborted parent signal", async () => {
  const parent = new AbortController();
  parent.abort(new Error("revoked"));
  const execute = vi.fn(async () => ({ ok: true }));
  await expect(executeToolStrict(definition(execute).tools[0], {}, {
    userId: initial.userId, agentType: "legal", mode: "live", signal: parent.signal,
  })).rejects.toThrow("revoked");
  expect(execute).not.toHaveBeenCalled();
});

it("propagates a parent cancellation and removes its listener", async () => {
  const parent = new AbortController();
  const remove = vi.spyOn(parent.signal, "removeEventListener");
  let observed: AbortSignal | undefined;
  const execute = vi.fn(async (_: unknown, ctx: ToolExecutionContext) => {
    observed = ctx.signal;
    return new Promise<never>(() => {});
  });
  const pending = executeToolStrict({ name: "probe", description: "inert", sensitive: false, execute }, {}, {
    userId: initial.userId, agentType: "legal", mode: "live", signal: parent.signal,
  }).then(() => null, (error: unknown) => error);
  await Promise.resolve();
  parent.abort(new Error("revoked during operation"));
  expect(await pending).toEqual(new Error("revoked during operation"));
  expect(observed?.aborted).toBe(true);
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("does not claim that a non-cooperative operation stopped", async () => {
  vi.useFakeTimers();
  let effects = 0;
  const execute = async () => new Promise<void>((resolve) => {
    setTimeout(() => { effects += 1; resolve(); }, 40_000);
  });
  const pending = executeToolStrict(definition(execute).tools[0], {}, {
    userId: initial.userId, agentType: "legal", mode: "live",
  }).then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(String(await pending)).toContain("non confirmé");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(effects).toBe(1); // demonstrates the limit; not a physical stop test
});

it("forwards cancellation through the real robot tool to the simulator", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await robotSimulateSessionTool.execute({
    version: 1, sessionId: "cancellation-audit", targetId: "purama-simulator", expiresAt: Date.now() + 60_000,
    steps: [{ id: "pause", kind: "pause", durationMs: 1_000 }],
  }, { userId: "cancellation-audit-owner", agentType: "legal", mode: "live", signal: controller.signal });
  expect(result).toMatchObject({ ok: false, status: "cancelled", physicalActions: 0, events: [] });
});
