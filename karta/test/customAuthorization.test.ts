import { beforeEach, describe, expect, it, vi } from "vitest";

// Real custom-agent loader/builder, resolver, worker, loop and approval code.
// Only external state/provider, locks and the inert test tool are substituted.
const deps = vi.hoisted(() => ({
  row: { id: "custom-audit", user_id: "owner", name: "audit", description: null,
    system_prompt: "audit", tools_enabled: ["probe"], karta_enabled: true,
    is_active: true, schedule_enabled: false, schedule_cron: null },
  execute: vi.fn(async () => ({ ok: true })), decide: vi.fn(),
  pending: { id: "pending-audit", user_id: "owner", run_id: "run-audit",
    agent_type: "custom:custom-audit", tool_name: "probe", tool_params: {}, status: "pending" },
}));

vi.mock("../src/db/supabase.js", () => ({ supabase: { from: (table: string) => {
  if (table === "creator_agents") {
    const b = { select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: { ...deps.row, tools_enabled: [...deps.row.tools_enabled] }, error: null }) };
    return b;
  }
  if (table === "karta_pending_actions") return {
    update: (patch: Record<string, unknown>) => {
      const b = { eq: () => b, select: () => b,
        maybeSingle: async () => {
          if (deps.pending.status !== "pending") return { data: null, error: null };
          Object.assign(deps.pending, patch);
          return { data: { ...deps.pending }, error: null };
        },
        then: (resolve: (value: unknown) => unknown) => {
          Object.assign(deps.pending, patch);
          return Promise.resolve({ error: null }).then(resolve);
        } };
      return b;
    },
  };
  if (table === "karta_runs") {
    const b = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: null }) };
    return b;
  }
  throw new Error(`Unexpected DB table: ${table}`);
} } }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/tools/customRegistry.js", () => ({
  resolveCustomAgentTools: (names: string[]) => names.includes("probe")
    ? [{ name: "probe", description: "inert probe", sensitive: false, execute: deps.execute }] : [],
}));
vi.mock("../src/engine/autonomy.js", async (original) => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async () => ({ userId: "owner", agentType: "custom:custom-audit",
    isEnabled: true, autonomyLevel: 3, killSwitch: false, simulationMode: false }),
  recordRunOutcome: async () => {},
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "run-audit", finish: async () => {} }), reconcileStaleRuns: async () => 0 }));
vi.mock("../src/engine/run-lock.js", () => ({ withRunSerialization: async (_id: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => {} }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: deps.decide, isMock: true }) }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("../src/queue/cycle-lock.js", () => ({ tryAcquireCycleLock: async () => ({ token: "inert" }), releaseCycleLock: async () => {} }));

import { resolveAgentDefinition } from "../src/engine/resolveDefinition.js";
import { runAgentCycle } from "../src/engine/loop.js";
import { resolvePendingAction } from "../src/engine/approval.js";
import { processAgentCycleJob } from "../src/queue/worker.js";

const type = "custom:custom-audit" as const;
const trigger = { type: "manual" as const, source: "local-audit" };
const decision = { summary: "test", toolCalls: [{ tool: "probe", params: {} }], requiresApproval: false, mock: true };
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(deps.row, { user_id: "owner", is_active: true, karta_enabled: true, tools_enabled: ["probe"] });
  deps.pending.status = "pending";
  deps.decide.mockResolvedValue(decision);
});

describe("current creator-agent authority", () => {
  it("still runs an enabled owned custom agent", async () => {
    const result = await processAgentCycleJob({ userId: "owner", agentType: type, trigger });
    expect(result.status).toBe("success");
    expect(deps.execute).toHaveBeenCalledOnce();
  });

  it.each(["is_active", "karta_enabled"] as const)("blocks a queued job after %s becomes false", async (key) => {
    deps.row[key] = false;
    await expect(processAgentCycleJob({ userId: "owner", agentType: type, trigger })).rejects.toThrow();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each(["is_active", "karta_enabled"] as const)("blocks an old approval after %s becomes false", async (key) => {
    deps.row[key] = false;
    await resolvePendingAction("pending-audit", "approve");
    expect(deps.pending.status).toBe("failed");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it.each(["is_active", "karta_enabled"] as const)("blocks dispatch if %s changes during the provider decision", async (key) => {
    const definition = await resolveAgentDefinition(type, "owner");
    deps.decide.mockImplementation(async () => { deps.row[key] = false; return decision; });
    const result = await runAgentCycle("owner", definition, trigger);
    expect(result.status).toBe("error");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not execute an initially allowed tool removed during the decision", async () => {
    const definition = await resolveAgentDefinition(type, "owner");
    deps.decide.mockImplementation(async () => { deps.row.tools_enabled = []; return decision; });
    await runAgentCycle("owner", definition, trigger);
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not run another owner's custom agent from a queued job", async () => {
    await expect(processAgentCycleJob({ userId: "another-owner", agentType: type, trigger })).rejects.toThrow();
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("does not approve another owner's custom agent", async () => {
    deps.row.user_id = "another-owner";
    await resolvePendingAction("pending-audit", "approve");
    expect(deps.pending.status).toBe("failed");
    expect(deps.execute).not.toHaveBeenCalled();
  });

  it("blocks dispatch after ownership changes during the decision", async () => {
    const definition = await resolveAgentDefinition(type, "owner");
    deps.decide.mockImplementation(async () => { deps.row.user_id = "another-owner"; return decision; });
    await runAgentCycle("owner", definition, trigger);
    expect(deps.execute).not.toHaveBeenCalled();
  });
});
