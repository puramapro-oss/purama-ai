import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentState } from "../src/engine/types.js";

// External state, provider and persistence are mocked. The agent builder, registry,
// engine loop, result contract, robot tools, validator and simulator below are real.
const deps = vi.hoisted(() => ({
  decide: vi.fn(), finish: vi.fn(async () => {}), loadState: vi.fn(), killSwitch: vi.fn(), pending: vi.fn(), notify: vi.fn(async () => {}),
}));
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: vi.fn((table: string) => {
  if (table !== "creator_agents") throw new Error("Unexpected DB access");
  const builder = { select: () => builder, eq: () => builder,
    maybeSingle: async () => ({ data: { ...row, tools_enabled: [...row.tools_enabled] }, error: null }) };
  return builder;
}) } }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: true, decide: deps.decide }) }));
vi.mock("../src/engine/autonomy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: deps.loadState, recordRunOutcome: vi.fn(async () => {}),
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: deps.killSwitch }));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "test-run", finish: deps.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: deps.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: deps.notify }));

import { runAgentCycle } from "../src/engine/loop.js";
import { buildCustomAgentDefinition } from "../src/agents/customAgent.js";
import { executeToolStrict } from "../src/engine/tool-result.js";
import { robotCatalogTool } from "../src/tools/robotics.js";

const row = {
  id: "robotics", user_id: "owner", name: "PURAMA — séances robotiques", description: null,
  system_prompt: "Décris une simulation comme telle. Ne prétends jamais avoir connecté un robot.",
  tools_enabled: ["robot_catalog", "robot_plan_session", "robot_simulate_session", "robot_motor_command"],
  karta_enabled: true, is_active: true, schedule_enabled: false, schedule_cron: null,
};
const definition = buildCustomAgentDefinition(row);
const state: AgentState = {
  userId: "owner", agentType: "custom:robotics", isEnabled: true,
  autonomyLevel: 2, killSwitch: false, simulationMode: false,
};
const trigger = { type: "manual" as const, source: "test" };
let sequence = 0;
function params(targetId = "purama-simulator") {
  return {
    version: 1, sessionId: `integration-${++sequence}`, targetId, expiresAt: Date.now() + 60_000,
    steps: [{ id: "welcome", kind: "speech", text: "Vous pouvez interrompre la séance.", durationMs: 1_000 }],
  };
}
function decision(tool: string, input: Record<string, unknown>, requiresApproval = false): AgentDecision {
  return { summary: "Préparer une séance PURAMA", toolCalls: [{ tool, params: input }], requiresApproval, mock: true };
}

beforeEach(() => {
  vi.clearAllMocks();
  row.tools_enabled = ["robot_catalog", "robot_plan_session", "robot_simulate_session", "robot_motor_command"];
  deps.loadState.mockResolvedValue({ ...state });
  deps.killSwitch.mockResolvedValue(false);
  deps.pending.mockResolvedValue("pending");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected external network access"); }));
});
afterEach(() => vi.unstubAllGlobals());

describe("robotics — real KARTA integration", () => {
  it("resolves only the three supported robot tools through the custom-agent builder", () => {
    expect(definition.tools.map((tool) => tool.name)).toEqual(["robot_catalog", "robot_plan_session", "robot_simulate_session"]);
  });

  it("executes the software simulator through the live engine and journals its true status", async () => {
    deps.decide.mockResolvedValue(decision("robot_simulate_session", params()));
    const result = await runAgentCycle("owner", definition, trigger);
    expect(result.status).toBe("success");
    expect(result.toolsUsed[0].success).toBe(true);
    expect(result.toolsUsed[0].resultSummary).toContain('"execution":"simulation"');
    expect(result.toolsUsed[0].resultSummary).toContain('"physicalActions":0');
    expect(deps.finish).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("records unsupported Optimus planning as a tool failure, never robot success", async () => {
    deps.decide.mockResolvedValue(decision("robot_plan_session", params("tesla-optimus")));
    const result = await runAgentCycle("owner", definition, trigger);
    expect(result.toolsUsed[0].success).toBe(false);
    expect(result.toolsUsed[0].resultSummary).toContain("aucune commande matérielle");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not turn a simulation request into hardware control even in live mode", async () => {
    deps.decide.mockResolvedValue(decision("robot_simulate_session", params("unitree-g1-edu")));
    const result = await runAgentCycle("owner", definition, trigger);
    expect(result.toolsUsed[0].success).toBe(false);
    expect(result.toolsUsed[0].resultSummary).toContain("adaptateur matériel");
  });

  it("preserves KARTA's global dry run and human approval behavior", async () => {
    const input = params();
    deps.decide.mockResolvedValue(decision("robot_simulate_session", input));
    deps.loadState.mockResolvedValue({ ...state, simulationMode: true });
    const dryRun = await runAgentCycle("owner", definition, trigger);
    expect(dryRun.toolsUsed[0].resultSummary).toContain("dry-run");
    expect(deps.pending).not.toHaveBeenCalled();

    deps.loadState.mockResolvedValue({ ...state });
    deps.decide.mockResolvedValue(decision("robot_simulate_session", input, true));
    const approval = await runAgentCycle("owner", definition, trigger);
    expect(approval.status).toBe("awaiting_approval");
    expect(deps.pending).toHaveBeenCalledOnce();
    expect(approval.toolsUsed[0].resultSummary).toContain("validation humaine");
  });

  it("honors the existing kill switch before robot decisions", async () => {
    deps.killSwitch.mockResolvedValue(true);
    const result = await runAgentCycle("owner", definition, trigger);
    expect(result.toolsUsed).toHaveLength(0);
    expect(deps.decide).not.toHaveBeenCalled();
  });

  it("honors a robot tool removed from creator_agents while the provider decides", async () => {
    deps.decide.mockImplementation(async () => {
      row.tools_enabled = [];
      return decision("robot_simulate_session", params());
    });
    const result = await runAgentCycle("owner", definition, trigger);
    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("révoqué");
    expect(result.toolsUsed).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the not-connected label in KARTA's 200-character catalog summary", async () => {
    const result = await executeToolStrict(robotCatalogTool, { targetId: "tesla-optimus" }, {
      userId: "owner", agentType: "custom:robotics", mode: "live",
    });
    expect(result).toContain('"hardwareControlAvailable":false');
    await expect(executeToolStrict(robotCatalogTool, { endpoint: "https://arbitrary.invalid" }, {
      userId: "owner", agentType: "custom:robotics", mode: "live",
    })).rejects.toThrow("targetId");
  });
});
