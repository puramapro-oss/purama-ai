import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({ simulation: false, stopped: false, decision: { summary: "", toolCalls: [], requiresApproval: false, mock: false } as AgentDecision,
  finish: vi.fn(), record: vi.fn(), pending: vi.fn() }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: async () => h.decision }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", async original => ({ ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({ userId: "qualification-user", agentType: "legal", isEnabled: true, killSwitch: false, simulationMode: h.simulation, autonomyLevel: 2 }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "qualification-run", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { resolutionQualificationTool } = await import("../src/tools/registry.js");
const { CUSTOM_AGENT_TOOL_NAMES, resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");
const { runAgentCycle } = await import("../src/engine/loop.js");
const { assertToolResult } = await import("../src/engine/tool-result.js");
const { persistPrivateToolResult } = await import("../src/engine/private-tool-results.js");

const marker = "PRIVATE_RESOLUTION_SENTINEL_89413";
const input = () => ({ caseId: marker, snapshotRevision: 1, asOf: "2026-11-25T12:00:00Z", domains: ["A", "E", "G"], sources: [],
  dependencies: [], transitions: [], corrections: [], handoffs: [],
  effort: { chosenMinutes: 2, paused: false, maxCalls: 0, maxTrips: 0, steps: [{ id: "short-step", state: "pending", estimatedMinutes: 2, calls: 0, trips: 0 }] },
  occurrence: { requested: "new_episode", current: { episodeId: "episode", beneficiaryId: "beneficiary", objectId: "object", periodId: "period", engagementId: "engagement", territory: "FR", operationId: "operation", payloadHash: "payload" }, attemptLimit: 3, revoked: false },
});
const ctx: ToolExecutionContext = { userId: "qualification-user", agentType: "legal", mode: "live", operationId: "internal-call" };
const definition = (): AgentDefinition => ({ type: "legal", systemPrompt: "Internal deterministic qualification acceptance test", buildContext: async () => ({}), tools: [resolutionQualificationTool] });

beforeEach(() => {
  vi.clearAllMocks(); h.simulation = false; h.stopped = false; h.finish.mockResolvedValue(undefined); h.record.mockResolvedValue(undefined);
  h.decision = { summary: marker, toolCalls: [{ tool: "qualify_resolution", params: input() }], requiresApproval: false, mock: false };
});
afterEach(() => { vi.restoreAllMocks(); });

describe("qualification through existing KARTA entry points", () => {
  it("returns the real qualification through the shared internal registry, with no network or dossier mutation", async () => {
    const network = vi.spyOn(globalThis, "fetch"); const params = input(), before = structuredClone(params);
    const result = await resolutionQualificationTool.execute(params, ctx);
    expect(() => assertToolResult(result)).not.toThrow();
    expect(result).toMatchObject({ qualificationOnly: true, externalFactsVerified: false, permissionsGranted: false, externalActionsPerformed: 0,
      dependencies: { executionPlanCreated: false }, transitions: [], corrections: [], handoffs: [],
      effort: { nextStepId: "short-step", authorizationChanged: false }, occurrence: { assessment: "new_episode_candidate", attemptsCreated: 0 } });
    expect(params).toEqual(before); expect(network).not.toHaveBeenCalled();
  });

  it("defers selectable exposure while private-result delivery has no qualified projection for this tool", async () => {
    expect(CUSTOM_AGENT_TOOL_NAMES).not.toContain("qualify_resolution");
    expect(resolveCustomAgentTools(["qualify_resolution"])).toEqual([]);
    expect(await persistPrivateToolResult({ userId: ctx.userId, agentType: ctx.agentType, runId: "internal", operationId: "internal-call", toolName: "qualify_resolution", result: {} }))
      .toEqual({ status: "not_applicable" });
  });

  it("executes the actual pure tool in the real KARTA loop with substituted model/state ports and private traces", async () => {
    const execute = vi.spyOn(resolutionQualificationTool, "execute"); const network = vi.spyOn(globalThis, "fetch");
    const result = await runAgentCycle(ctx.userId, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe("success"); expect(execute).toHaveBeenCalledOnce();
    const qualification = await execute.mock.results[0].value;
    expect(qualification.externalActionsPerformed).toBe(0); expect(qualification.effort.nextStepId).toBe("short-step");
    expect(result.toolsUsed).toEqual([expect.objectContaining({ tool: "qualify_resolution", outcome: "executed", success: true })]);
    expect(JSON.stringify(result)).not.toContain(marker); expect(JSON.stringify(h.finish.mock.calls)).not.toContain(marker);
    expect(network).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledOnce();
  });

  it.each(["simulation", "global-stop"] as const)("retains the existing %s gate", async gate => {
    h.simulation = gate === "simulation"; h.stopped = gate === "global-stop";
    const execute = vi.spyOn(resolutionQualificationTool, "execute");
    const result = await runAgentCycle(ctx.userId, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe(gate === "simulation" ? "simulated" : "skipped"); expect(execute).not.toHaveBeenCalled();
  });

  it("fails nested false confirmation input without leaking supplied private content", async () => {
    h.decision.toolCalls[0].params.effort = { chosenMinutes: 2, paused: false, steps: [], authorizationGranted: true, secret: marker };
    const result = await runAgentCycle(ctx.userId, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe("error"); expect(result.toolsUsed[0].success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(marker); expect(JSON.stringify(h.finish.mock.calls)).not.toContain(marker);
  });
});
