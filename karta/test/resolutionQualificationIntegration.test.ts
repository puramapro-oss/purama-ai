import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, ToolExecutionContext } from "../src/engine/types.js";

const h = vi.hoisted(() => ({ simulation: false, stopped: false, decision: { summary: "", toolCalls: [], requiresApproval: false, mock: false } as AgentDecision,
  owner: "00000000-0000-4000-8000-000000000611", agentType: "custom:00000000-0000-4000-8000-000000000612" as const,
  run: "00000000-0000-4000-8000-000000000613", saved: "00000000-0000-4000-8000-000000000614",
  events: [] as string[], finish: vi.fn(), record: vi.fn(), pending: vi.fn(), rpc: vi.fn(), from: vi.fn(), resolve: vi.fn(), decide: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  rpc: (name: string, args: unknown) => ({ abortSignal: (signal: AbortSignal) => h.rpc(name, args, signal) }),
  from: h.from,
} }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => h.stopped }));
vi.mock("../src/engine/autonomy.js", async original => ({ ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({ userId: h.owner, agentType: h.agentType, isEnabled: true, killSwitch: false, simulationMode: h.simulation, autonomyLevel: 2 }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  resolveAgentDefinition: h.resolve, CustomAgentAuthorizationError: class extends Error {},
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: h.run, finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { resolutionQualificationTool } = await import("../src/tools/registry.js");
const { CUSTOM_AGENT_TOOL_NAMES, resolveCustomAgentTools } = await import("../src/tools/customRegistry.js");
const { runAgentCycle } = await import("../src/engine/loop.js");
const { assertToolResult } = await import("../src/engine/tool-result.js");

const marker = "PRIVATE_RESOLUTION_SENTINEL_89413";
const input = () => ({ caseId: marker, snapshotRevision: 1, asOf: "2026-11-25T12:00:00Z", domains: ["A", "E", "G"], sources: [],
  dependencies: [], transitions: [], corrections: [], handoffs: [],
  effort: { chosenMinutes: 2, paused: false, maxCalls: 0, maxTrips: 0, steps: [{ id: "short-step", state: "pending", estimatedMinutes: 2, calls: 0, trips: 0 }] },
  occurrence: { requested: "new_episode", current: { episodeId: "episode", beneficiaryId: "beneficiary", objectId: "object", periodId: "period", engagementId: "engagement", territory: "FR", operationId: "operation", payloadHash: "payload" }, attemptLimit: 3, revoked: false },
});
const ctx: ToolExecutionContext = { userId: h.owner, agentType: h.agentType, mode: "live", operationId: `${h.run}:0` };
const definition = (): AgentDefinition => ({ type: h.agentType, systemPrompt: "Private deterministic qualification acceptance test", buildContext: async () => ({}), tools: resolveCustomAgentTools(["qualify_resolution"]) });

function expectPrivateTraces(result: unknown) {
  expect(JSON.stringify({ result, finish: h.finish.mock.calls, record: h.record.mock.calls, pending: h.pending.mock.calls })).not.toContain(marker);
}

beforeEach(() => {
  vi.clearAllMocks(); h.simulation = false; h.stopped = false; h.events = []; h.record.mockResolvedValue(undefined);
  h.finish.mockImplementation(async () => { h.events.push("finish"); });
  h.resolve.mockReset().mockImplementation(async (type, owner) => type === h.agentType && owner === h.owner ? definition() : undefined);
  h.decide.mockReset().mockImplementation(async () => h.decision);
  h.rpc.mockReset().mockImplementation(async () => { h.events.push("store"); return { data: h.saved, error: null }; });
  h.from.mockReset().mockImplementation(() => { throw new Error("Unexpected database access in controlled qualification test"); });
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

  it("exposes one explicitly selected capability through the existing custom registry without changing empty selections", () => {
    expect(CUSTOM_AGENT_TOOL_NAMES.filter(name => name === "qualify_resolution")).toHaveLength(1);
    expect(resolveCustomAgentTools(["qualify_resolution", "qualify_resolution"])).toEqual([resolutionQualificationTool]);
    expect(resolveCustomAgentTools([])).toEqual([]);
  });

  it("executes and delivers the real qualification for its freshly authorized custom-agent owner before success", async () => {
    const execute = vi.spyOn(resolutionQualificationTool, "execute"); const network = vi.spyOn(globalThis, "fetch");
    const result = await runAgentCycle(ctx.userId, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe("success"); expect(execute).toHaveBeenCalledOnce();
    const qualification = await execute.mock.results[0].value;
    expect(qualification.externalActionsPerformed).toBe(0); expect(qualification.effort.nextStepId).toBe("short-step");
    expect(result.toolsUsed).toEqual([expect.objectContaining({ tool: "qualify_resolution", outcome: "executed", success: true })]);
    expect(h.resolve).toHaveBeenCalledWith(h.agentType, h.owner);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("karta_store_tool_result", expect.objectContaining({
      p_user_id: h.owner, p_agent_type: h.agentType, p_run_id: h.run, p_operation_id: `${h.run}:0`, p_tool_name: "qualify_resolution",
      p_payload: expect.objectContaining({ tool_name: "qualify_resolution", status: "complete", sources: [], details: expect.objectContaining({
        verification_status: "unverified", qualification_only: true, external_facts_verified: false, permissions_granted: false,
        external_actions_performed: 0, snapshot: { caseId: marker, snapshotRevision: 1, asOf: "2026-11-25T12:00:00Z" },
      }) }),
    }), expect.any(AbortSignal));
    expect(h.rpc.mock.calls[0][1].p_payload.details.sections.map((section: { id: string }) => section.id))
      .toEqual(["dependencies", "transitions", "effort", "corrections", "occurrence", "handoffs"]);
    expect(h.events).toEqual(["store", "finish"]);
    expectPrivateTraces(result);
    expect(network).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled(); expect(h.finish).toHaveBeenCalledOnce();
  });

  it("reconciles a lost acknowledgement with the same private projection without executing the qualifier twice", async () => {
    h.rpc.mockRejectedValueOnce(new Error(marker));
    const execute = vi.spyOn(resolutionQualificationTool, "execute");
    const result = await runAgentCycle(h.owner, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe("success"); expect(execute).toHaveBeenCalledOnce();
    expect(h.rpc).toHaveBeenCalledTimes(2);
    expect(h.rpc.mock.calls[1].slice(0, 2)).toEqual(h.rpc.mock.calls[0].slice(0, 2));
    expectPrivateTraces(result);
  });

  it("reports a confirmed delivery refusal as an error without leaking the dossier or retrying the tool", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: marker, details: marker } });
    const execute = vi.spyOn(resolutionQualificationTool, "execute");
    const result = await runAgentCycle(h.owner, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(execute).toHaveBeenCalledOnce(); expect(h.rpc).toHaveBeenCalledOnce();
    expectPrivateTraces(result);
  });

  it("cancels a revoked custom-agent ownership before model inference, qualification or private delivery", async () => {
    h.resolve.mockResolvedValue(undefined);
    const execute = vi.spyOn(resolutionQualificationTool, "execute");
    const result = await runAgentCycle(h.owner, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe("cancelled");
    expect(h.decide).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect(h.rpc).not.toHaveBeenCalled();
    expectPrivateTraces(result);
  });

  it.each(["simulation", "global-stop", "mock"] as const)("retains the existing %s gate without creating a private result", async gate => {
    h.simulation = gate === "simulation"; h.stopped = gate === "global-stop";
    h.decision.mock = gate === "mock";
    const execute = vi.spyOn(resolutionQualificationTool, "execute");
    const result = await runAgentCycle(ctx.userId, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe(gate === "global-stop" ? "skipped" : "simulated"); expect(execute).not.toHaveBeenCalled();
    expect(h.rpc).not.toHaveBeenCalled(); expectPrivateTraces(result);
  });

  it("fails nested false confirmation input without leaking supplied private content", async () => {
    h.decision.toolCalls[0].params.effort = { chosenMinutes: 2, paused: false, steps: [], authorizationGranted: true, secret: marker };
    const result = await runAgentCycle(ctx.userId, definition(), { type: "manual", source: "resolution-qualification-test" });
    expect(result.status).toBe("error"); expect(result.toolsUsed[0].success).toBe(false);
    expect(h.rpc).not.toHaveBeenCalled(); expectPrivateTraces(result);
  });
});
