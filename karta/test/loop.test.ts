import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition } from "../src/engine/types.js";
const h = vi.hoisted(() => ({
  stopped: false, enabled: true, simulation: false,
  decision: { summary: "test", toolCalls: [{ tool: "act", params: {} }], requiresApproval: false, mock: false } as AgentDecision,
  finish: vi.fn(), record: vi.fn(), execute: vi.fn(), pending: vi.fn(), existing: undefined as any,
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: async () => h.decision }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({ userId: "u", agentType: "legal", isEnabled: h.enabled, killSwitch: false, simulationMode: h.simulation, autonomyLevel: 2 }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "run", finish: h.finish, existingResult: h.existing }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
const { runAgentCycle } = await import("../src/engine/loop.js");
const definition: AgentDefinition = { type: "legal", systemPrompt: "test", buildContext: async () => ({}),
  tools: [{ name: "act", sensitive: false, description: "", execute: h.execute }] };
const run = () => runAgentCycle("u", definition, { type: "manual", source: "test" }, "durable-test");
beforeEach(() => {
  vi.clearAllMocks(); h.stopped = false; h.enabled = true; h.simulation = false; h.existing = undefined;
  h.finish.mockResolvedValue(undefined); h.record.mockResolvedValue(undefined); h.pending.mockResolvedValue("pending-1");
  h.execute.mockResolvedValue({ ok: true });
  h.decision = { summary: "test", toolCalls: [{ tool: "act", params: {} }], requiresApproval: false, mock: false };
});
describe("cycle outcomes and interruption", () => {
  it("executes a non-sensitive live action", async () => { expect((await run()).status).toBe("success"); expect(h.execute).toHaveBeenCalledOnce(); });
  it("persists an approval without claiming execution", async () => { h.decision.requiresApproval = true; const r = await run(); expect(r.status).toBe("awaiting_approval"); expect(r.toolsUsed[0]).toMatchObject({ pendingActionId: "pending-1", success: false, outcome: "pending" }); expect(h.execute).not.toHaveBeenCalled(); });
  it("fails for an unknown tool", async () => { h.decision.toolCalls[0].tool = "unknown"; expect((await run()).status).toBe("error"); expect(h.execute).not.toHaveBeenCalled(); });
  it("skips a disabled agent", async () => { h.enabled = false; expect((await run()).status).toBe("skipped"); expect(h.execute).not.toHaveBeenCalled(); });
  it("skips under the global stop", async () => { h.stopped = true; expect((await run()).status).toBe("skipped"); expect(h.execute).not.toHaveBeenCalled(); });
  it("observes a stop before the next action", async () => { h.decision.toolCalls.push({ tool: "act", params: {} }); h.execute.mockImplementation(async () => { h.stopped = true; return { ok: true }; }); const r = await run(); expect(r.status).toBe("cancelled"); expect(h.execute).toHaveBeenCalledOnce(); expect(r.toolsUsed.map(t => t.outcome)).toEqual(["executed", "skipped"]); });
  it.each([{ ok: false }, { success: false }, { error: "denied" }])("does not report a failed tool envelope as success: %j", async value => { h.execute.mockResolvedValue(value); h.decision.toolCalls.push({ tool: "act", params: {} }); expect((await run()).status).toBe("error"); expect(h.execute).toHaveBeenCalledOnce(); });
  it("mock decisions never cause real effects or approvals", async () => { h.decision.mock = true; h.decision.requiresApproval = true; expect((await run()).status).toBe("simulated"); expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled(); });
  it("simulation never counts as execution", async () => { h.simulation = true; const r = await run(); expect(r.status).toBe("simulated"); expect(r.toolsUsed[0].success).toBe(false); });
  it("retains evidence and forbids replay after a bookkeeping failure", async () => { h.record.mockRejectedValue(new Error("database unavailable")); const r = await run(); expect(r.status).toBe("error"); expect(r.retryable).toBe(false); expect(r.toolsUsed[0].outcome).toBe("executed"); expect(h.execute).toHaveBeenCalledOnce(); });
  it("does not execute a previously claimed delivery", async () => { h.existing = { status: "error", toolsUsed: [], retryable: false }; expect(await run()).toBe(h.existing); expect(h.execute).not.toHaveBeenCalled(); });
});
