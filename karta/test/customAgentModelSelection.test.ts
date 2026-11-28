import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomAgentRow } from "../src/agents/customAgent.js";
import type { AgentDefinition } from "../src/engine/types.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const AGENT = "00000000-0000-4000-8000-000000000002";
const h = vi.hoisted(() => ({
  row: null as CustomAgentRow | null,
  reads: [] as Array<{ selection: string; id: unknown }>,
  decide: vi.fn(), finish: vi.fn(), state: vi.fn(),
}));

// Exercise the actual loader, builder, ownership resolver and run loop. Only
// provider, persistence and runtime boundaries are inert; no paid request.
vi.mock("../src/db/supabase.js", () => ({
  supabase: { from: (table: string) => {
    if (table !== "creator_agents") throw new Error("Unexpected database read");
    let selection = "";
    let id: unknown;
    const query = {
      select: (value: string) => { selection = value; return query; },
      eq: (key: string, value: unknown) => { if (key === "id") id = value; return query; },
      maybeSingle: async () => {
        h.reads.push({ selection, id });
        return { data: h.row?.id === id ? { ...h.row } : null, error: null };
      },
    };
    return query;
  } },
}));
vi.mock("../src/tools/customRegistry.js", () => ({ resolveCustomAgentTools: () => [] }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/claude/index.js", () => ({
  getClaudeClient: () => ({ isMock: false, decide: h.decide }),
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.state,
  recordRunOutcome: async () => {},
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "model-choice-run", finish: h.finish }),
}));
vi.mock("../src/engine/approval-continuation.js", () => ({
  loadApprovalContinuation: async () => undefined,
  APPROVAL_CONTINUATION_GUIDANCE: "",
  ApprovalContinuationError: class extends Error {},
}));
vi.mock("../src/engine/brief.js", () => ({
  claimPendingBrief: vi.fn(), peekPendingBrief: vi.fn(), armPendingBrief: vi.fn(),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: vi.fn() }));
vi.mock("../src/engine/notify.js", () => ({ notify: vi.fn() }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));

const { loadCustomAgent, buildCustomAgentDefinition } = await import("../src/agents/customAgent.js");
const { runAgentCycle } = await import("../src/engine/loop.js");

function row(): CustomAgentRow {
  return {
    id: AGENT, user_id: OWNER, name: "Assistant personnel", description: null,
    system_prompt: "Rédige une réponse utile.", model: "claude-haiku-4-5-20251001",
    tools_enabled: [], karta_enabled: true, is_active: true,
    schedule_enabled: false, schedule_cron: null,
  };
}

function cycle(definition: AgentDefinition) {
  return runAgentCycle(OWNER, definition, { type: "manual", source: "model-choice-test" }, "delivery-model-choice");
}

beforeEach(() => {
  vi.resetAllMocks();
  h.row = row(); h.reads = [];
  h.state.mockImplementation(async () => ({
    userId: OWNER, agentType: `custom:${AGENT}`, isEnabled: true, autonomyLevel: 3,
    killSwitch: false, simulationMode: false,
  }));
  h.decide.mockResolvedValue({ summary: "Réponse", toolCalls: [], requiresApproval: false, mock: false });
  h.finish.mockResolvedValue(undefined);
});

describe("saved task-execution preferences", () => {
  it("selects and uses the freshest saved reflection and speed at model admission", async () => {
    h.row!.execution_preferences = { reflection: "standard", speed: "standard" };
    const stored = await loadCustomAgent(AGENT);
    const stale = buildCustomAgentDefinition(stored!);
    stale.buildContext = async () => {
      h.row!.execution_preferences = { reflection: "maximum", speed: "ultra_fast" };
      return {};
    };
    expect((await cycle(stale)).status).toBe("success");
    expect(h.reads.every(read => read.selection.split(", ").includes("execution_preferences"))).toBe(true);
    expect(h.decide.mock.calls[0][0].preferences).toEqual({
      model: "claude-haiku-4-5-20251001", reflection: "maximum", speed: "ultra_fast",
    });
    expect(stale.modelPreferences?.reflection).toBe("standard");
  });

  it.each([
    { label: "null", value: null },
    { label: "present undefined", value: undefined },
    { label: "array", value: [] },
    { label: "empty", value: {} },
    { label: "missing field", value: { reflection: "deep" } },
    { label: "null enum", value: { reflection: "deep", speed: null } },
    { label: "invalid enum", value: { reflection: "unlimited", speed: "fast" } },
    { label: "extra field", value: { reflection: "deep", speed: "fast", model: "other" } },
    { label: "accessor", value: { get reflection() { throw new Error("must not run"); }, speed: "fast" } },
  ])("refuses malformed stored preferences ($label) without invoking a model", async ({ value }) => {
    const stale = buildCustomAgentDefinition(h.row!);
    stale.buildContext = async () => { h.row!.execution_preferences = value; return {}; };
    expect((await cycle(stale)).status).toBe("error");
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("rejects saved preferences without an explicit stored model", () => {
    delete h.row!.model;
    h.row!.execution_preferences = { reflection: "auto", speed: "standard" };
    expect(() => buildCustomAgentDefinition(h.row!)).toThrow("Profil de modèle");
  });

  it("takes a snapshot of valid persisted values", () => {
    const stored = { reflection: "deep", speed: "fast" };
    h.row!.execution_preferences = stored;
    const definition = buildCustomAgentDefinition(h.row!);
    stored.reflection = "standard";
    expect(definition.modelPreferences).toEqual({ model: h.row!.model, reflection: "deep", speed: "fast" });
  });
});

describe("custom-agent model choice reaches the existing execution path", () => {
  it("selects the existing model column and forwards its value after a fresh ownership check", async () => {
    const stored = await loadCustomAgent(AGENT);
    const result = await cycle(buildCustomAgentDefinition(stored!));
    expect(result.status).toBe("success");
    expect(h.reads).toHaveLength(2);
    expect(h.reads.every(read => read.selection.split(", ").includes("model"))).toBe(true);
    expect(h.decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      agentType: `custom:${AGENT}`, preferences: { model: "claude-haiku-4-5-20251001" },
    }));
  });

  it("uses a model changed while context was being prepared", async () => {
    const stale = buildCustomAgentDefinition(h.row!);
    stale.buildContext = async () => {
      h.row = { ...h.row!, model: "claude-sonnet-4-20250514" };
      return {};
    };
    await cycle(stale);
    expect(h.decide.mock.calls[0][0].preferences).toEqual({ model: "claude-sonnet-4-20250514" });
    expect(stale.modelPreferences).toEqual({ model: "claude-haiku-4-5-20251001" });
  });

  it("does not send stale preferences when a legacy refreshed row has no model", async () => {
    const stale = buildCustomAgentDefinition(h.row!);
    stale.buildContext = async () => { delete h.row!.model; return {}; };
    await cycle(stale);
    expect(h.decide.mock.calls[0][0]).not.toHaveProperty("preferences");
  });

  it("preserves the legacy no-preference shape when the stored field is absent", async () => {
    delete h.row!.model;
    const definition = buildCustomAgentDefinition(h.row!);
    expect(definition).not.toHaveProperty("modelPreferences");
    await cycle(definition);
    expect(h.decide.mock.calls[0][0]).not.toHaveProperty("preferences");
  });

  it("does not treat an invalid explicit choice as permission to silently use the default", async () => {
    h.row!.model = "";
    // Validation belongs to the model client's qualified catalogue. This path
    // must preserve even invalid explicit input for that boundary to reject.
    await cycle(buildCustomAgentDefinition(h.row!));
    expect(h.decide.mock.calls[0][0].preferences).toEqual({ model: "" });
  });

  it("ignores model settings injected in ordinary business context", async () => {
    const definition = buildCustomAgentDefinition(h.row!);
    definition.buildContext = async () => ({ modelPreferences: { model: "other-destination" }, model: "other" });
    await cycle(definition);
    expect(h.decide.mock.calls[0][0].preferences).toEqual({ model: "claude-haiku-4-5-20251001" });
  });

  it("does not invoke a provider if ownership changes during context preparation", async () => {
    const stale = buildCustomAgentDefinition(h.row!);
    stale.buildContext = async () => { h.row!.user_id = "another-owner"; return {}; };
    expect((await cycle(stale)).status).toBe("cancelled");
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("does not invoke a provider if the custom agent is removed during context preparation", async () => {
    const stale = buildCustomAgentDefinition(h.row!);
    stale.buildContext = async () => { h.row = null; return {}; };
    expect((await cycle(stale)).status).toBe("cancelled");
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("preserves explicit static-agent settings without reading a custom account", async () => {
    const definition: AgentDefinition = {
      type: "newsletter-genie", systemPrompt: "Résume", tools: [], buildContext: async () => ({}),
      modelPreferences: { model: "primary", reflection: "deep", speed: "fast" },
    };
    await cycle(definition);
    expect(h.reads).toHaveLength(0);
    expect(h.decide.mock.calls[0][0].preferences).toEqual(definition.modelPreferences);
  });
});
