import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDecision, AgentDefinition, AgentState, AgentTrigger, ToolDefinition } from "../src/engine/types.js";

process.env.KARTA_MOCK_CLAUDE = "true";
process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

const h = vi.hoisted(() => ({
  state: {} as AgentState, globalKill: false, stateError: undefined as Error | undefined,
  decide: vi.fn<() => Promise<AgentDecision>>(), finish: vi.fn(), recordOutcome: vi.fn(),
  createPending: vi.fn(), notify: vi.fn(), globalCheck: vi.fn(), stateRead: vi.fn(),
}));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: true, decide: h.decide }) }));
vi.mock("../src/engine/autonomy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: vi.fn(async () => {
    if (h.stateError) throw h.stateError;
    const snapshot = { ...h.state };
    await h.stateRead();
    return snapshot;
  }),
  recordRunOutcome: h.recordOutcome,
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: h.globalCheck }));
vi.mock("../src/engine/logger.js", () => ({ startRun: vi.fn(async () => ({ runId: "run-1", finish: h.finish })) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.createPending }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
const { runAgentCycle } = await import("../src/engine/loop.js");

function stubTool(name: string, sensitive: boolean, execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    name, description: "test", sensitive, execute,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parseInput: (input: unknown) => {
      if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length) {
        throw new Error("test tool expects an empty object");
      }
      return {};
    },
  };
}
function decision(...names: string[]): AgentDecision {
  return { summary: "Décision de test", toolCalls: names.map((tool) => ({ tool, params: {} })), requiresApproval: false, mock: true };
}
function agent(...tools: ToolDefinition[]): AgentDefinition {
  return { type: "legal", systemPrompt: "test", tools, buildContext: vi.fn(async () => ({})) };
}
const trigger: AgentTrigger = { type: "manual", source: "test" };
const run = (definition: AgentDefinition) => runAgentCycle("user-1", definition, trigger);

describe("runAgentCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const value of Object.values(h)) {
      if (typeof value === "function") value.mockReset();
    }
    h.state = { userId: "user-1", agentType: "legal", isEnabled: true, autonomyLevel: 2, killSwitch: false, simulationMode: false };
    h.globalKill = false;
    h.stateError = undefined;
    h.globalCheck.mockImplementation(async () => h.globalKill);
    h.decide.mockResolvedValue(decision("action"));
    h.finish.mockResolvedValue(undefined);
    h.recordOutcome.mockResolvedValue(undefined);
    h.createPending.mockResolvedValue("pending-1");
    h.notify.mockResolvedValue(undefined);
  });

  it("exécute un outil non sensible en live au niveau 2", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("success");
    expect(execute).toHaveBeenCalledOnce();
    expect(result.mock).toBe(true);
    expect(result.toolsUsed[0].outcome).toBe("executed");
    expect(result.retrySafe).toBe(false);
    expect(h.globalCheck.mock.calls.every(([options]) => options?.fresh === true)).toBe(true);
  });

  it("conserve l'approbation demandée sans compter une exécution", async () => {
    const execute = vi.fn();
    h.decide.mockResolvedValue({ ...decision("action"), requiresApproval: true });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("awaiting_approval");
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolsUsed[0]).toMatchObject({ pendingActionId: "pending-1", outcome: "awaiting_approval" });
    expect(result.resultSummary).toMatch(/0.*exécut/);
    expect(result.retrySafe).toBe(false);
  });

  it("refuse un outil inconnu avec un statut d'erreur", async () => {
    const result = await run(agent());
    expect(result.status).toBe("error");
    expect(result.toolsUsed[0].success).toBe(false);
    expect(result.toolsUsed[0].resultSummary).toContain("inconnu");
  });

  it("marque l'échec d'un outil sans autoriser une répétition de ses effets possibles", async () => {
    const execute = vi.fn(async () => { throw new Error("réponse perdue après envoi possible"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("error");
    expect(result.retrySafe).toBe(false);
    expect(result.toolsUsed[0].success).toBe(false);
    expect(result.toolsUsed[0].resultSummary).toContain("réponse perdue");
    expect(h.finish).toHaveBeenCalledOnce();
  });

  it("préserve une action réussie quand la suivante échoue", async () => {
    h.decide.mockResolvedValue(decision("first", "second"));
    const first = vi.fn(async () => ({ effect: "created" }));
    const second = vi.fn(async () => { throw new Error("second failed"); });
    const result = await run(agent(stubTool("first", false, first), stubTool("second", false, second)));
    expect(result.status).toBe("error");
    expect(result.retrySafe).toBe(false);
    expect(result.toolsUsed).toHaveLength(2);
    expect(result.toolsUsed[0].outcome).toBe("executed");
    expect(result.toolsUsed[1].success).toBe(false);
    expect(first).toHaveBeenCalledOnce();
  });

  it("préserve les actions en attente même si un autre outil est inconnu", async () => {
    h.decide.mockResolvedValue(decision("action", "missing"));
    const execute = vi.fn();
    const result = await run(agent(stubTool("action", true, execute)));
    expect(result.status).toBe("error");
    expect(result.toolsUsed).toHaveLength(2);
    expect(result.toolsUsed[0]).toMatchObject({ outcome: "awaiting_approval", pendingActionId: "pending-1" });
    expect(execute).not.toHaveBeenCalled();
    expect(result.retrySafe).toBe(false);
  });

  it("ne construit aucun contexte pour un agent désactivé", async () => {
    h.state.isEnabled = false;
    const definition = agent();
    const result = await run(definition);
    expect(result.status).toBe("skipped");
    expect(result.resultSummary).toContain("désactivé");
    expect(definition.buildContext).not.toHaveBeenCalled();
  });

  it("respecte l'arrêt global avant tout", async () => {
    h.globalKill = true;
    const definition = agent();
    const result = await run(definition);
    expect(result.status).toBe("skipped");
    expect(definition.buildContext).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("recontrôle l'arrêt après la construction du contexte", async () => {
    const execute = vi.fn();
    const definition = agent(stubTool("action", false, execute));
    definition.buildContext = async () => { h.globalKill = true; return {}; };
    const result = await run(definition);
    expect(result.status).not.toBe("success");
    expect(h.decide).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("recontrôle l'arrêt activé pendant la décision", async () => {
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.globalKill = true; return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).not.toBe("success");
    expect(execute).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("arrête les actions suivantes lorsque la première active l'arrêt", async () => {
    h.decide.mockResolvedValue(decision("first", "second"));
    const first = vi.fn(async () => { h.globalKill = true; return { ok: true }; });
    const second = vi.fn();
    const result = await run(agent(stubTool("first", false, first), stubTool("second", false, second)));
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(result.toolsUsed[0].outcome).toBe("executed");
    expect(result.status).not.toBe("success");
    expect(result.retrySafe).toBe(false);
  });

  it("refuse une action si l'agent vient d'être désactivé", async () => {
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.state.isEnabled = false; return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).not.toBe("success");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuse une action si la relecture de l'état échoue", async () => {
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.stateError = new Error("state offline"); return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("error");
    expect(execute).not.toHaveBeenCalled();
  });

  it("recontrôle l'arrêt activé pendant la relecture de l'état", async () => {
    const execute = vi.fn();
    h.decide.mockImplementation(async () => {
      h.stateRead.mockImplementation(async () => { h.globalKill = true; });
      return decision("action");
    });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).not.toBe("success");
    expect(execute).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("ne transforme jamais un cycle initialement simulé en action réelle", async () => {
    h.state.simulationMode = true;
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.state.simulationMode = false; return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("simulated");
    expect(execute).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
    expect(result.toolsUsed[0].outcome).toBe("simulated");
  });

  it("respecte un passage au mode simulation pendant un cycle live", async () => {
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.state.simulationMode = true; return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).not.toBe("success");
    expect(execute).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("une hausse d'autonomie ne retire pas l'approbation initiale", async () => {
    h.state.autonomyLevel = 1;
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.state.autonomyLevel = 3; return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("awaiting_approval");
    expect(execute).not.toHaveBeenCalled();
    expect(h.createPending).toHaveBeenCalledOnce();
  });

  it("une baisse d'autonomie ajoute immédiatement l'approbation", async () => {
    h.state.autonomyLevel = 3;
    const execute = vi.fn();
    h.decide.mockImplementation(async () => { h.state.autonomyLevel = 1; return decision("action"); });
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("awaiting_approval");
    expect(execute).not.toHaveBeenCalled();
  });

  it("une panne des métadonnées ne réécrit pas le journal ni les effets réussis", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    h.recordOutcome.mockRejectedValue(new Error("metadata offline"));
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("success");
    expect(result.retrySafe).toBe(false);
    expect(result.decision).toBe("Décision de test");
    expect(result.mock).toBe(true);
    expect(result.toolsUsed[0].outcome).toBe("executed");
    expect(result.warnings?.join(" ")).toContain("metadata offline");
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.finish.mock.calls[0][0].toolsUsed).toEqual(result.toolsUsed);
  });

  it("une clôture ambiguë garde l'historique et interdit la reprise automatique", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    h.finish.mockRejectedValue(new Error("finish response lost"));
    const result = await run(agent(stubTool("action", false, execute)));
    expect(result.status).toBe("error");
    expect(result.retrySafe).toBe(false);
    expect(result.toolsUsed[0].outcome).toBe("executed");
    expect(result.decision).toBe("Décision de test");
    expect(result.mock).toBe(true);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("une création d'approbation ambiguë n'autorise pas sa duplication", async () => {
    const execute = vi.fn();
    h.createPending.mockRejectedValue(new Error("insert response lost"));
    const result = await run(agent(stubTool("action", true, execute)));
    expect(result.status).toBe("error");
    expect(result.retrySafe).toBe(false);
    expect(h.createPending).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuse des paramètres invalides avant exécution ou création d'approbation", async () => {
    const execute = vi.fn();
    h.decide.mockResolvedValue({ ...decision("action"), toolCalls: [{ tool: "action", params: { unexpected: true } }] });
    const result = await run(agent(stubTool("action", true, execute)));
    expect(result.status).toBe("error");
    expect(execute).not.toHaveBeenCalled();
    expect(h.createPending).not.toHaveBeenCalled();
    expect(result.toolsUsed[0].success).toBe(false);
  });
});
