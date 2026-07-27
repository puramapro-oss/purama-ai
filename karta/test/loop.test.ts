import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentTrigger, ToolDefinition } from "../src/engine/types.js";

process.env.KARTA_MOCK_CLAUDE = "true";
process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.ANTHROPIC_MODEL_MAIN = "claude-sonnet-4-6";
process.env.ANTHROPIC_MODEL_FAST = "claude-haiku-4-5-20251001";
process.env.REDIS_URL = "redis://127.0.0.1:6379";

/** Builder chaînable minimal : chaque méthode "filtre" renvoie this, thenable direct pour
 * les updates/inserts awaités sans terminal, et single()/maybeSingle() configurables par table. */
function makeBuilder(resolved: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "lte", "in", "order", "limit", "update", "insert", "upsert"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(async () => resolved);
  builder.maybeSingle = vi.fn(async () => resolved);
  builder.then = (onResolve: (v: typeof resolved) => unknown) => Promise.resolve(resolved).then(onResolve);
  return builder;
}

const tableResolutions: Record<string, { data: unknown; error: unknown }> = {
  karta_global_state: { data: { kill_switch: false }, error: null },
  karta_agent_state: { data: { is_enabled: true, autonomy_level: 2, kill_switch: false, simulation_mode: false }, error: null },
  karta_runs: { data: { id: "run-1" }, error: null },
  karta_pending_actions: { data: { id: "pending-1" }, error: null },
  agent_notifications: { data: null, error: null },
};

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn((table: string) => makeBuilder(tableResolutions[table] ?? { data: null, error: null })),
  },
}));

const { runAgentCycle } = await import("../src/engine/loop.js");

function stubTool(name: string, sensitive: boolean, execute: ToolDefinition["execute"]): ToolDefinition {
  return { name, description: "test", sensitive, execute };
}

const trigger: AgentTrigger = { type: "manual", source: "test" };

describe("runAgentCycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("exécute un outil non sensible directement en mode live niveau 2 (decision.requiresApproval=false)", async () => {
    const executed = vi.fn(async () => ({ ok: true }));
    const definition: AgentDefinition = {
      type: "legal",
      systemPrompt: "test",
      tools: [stubTool("send_notification", false, executed)],
      buildContext: async () => ({ upcomingDeadlines: [{ title: "doc", expires_at: "2026-08-01" }] }),
    };

    const result = await runAgentCycle("user-1", definition, trigger);

    expect(result.status).toBe("success");
    expect(executed).toHaveBeenCalledOnce();
    expect(result.mock).toBe(true); // KARTA_MOCK_CLAUDE=true dans ce test
  });

  it("un outil sensible en attente d'approbation n'est jamais exécuté (autonomie niveau 2)", async () => {
    const executed = vi.fn(async () => ({ ok: true }));
    const definition: AgentDefinition = {
      type: "email",
      systemPrompt: "test",
      tools: [stubTool("gmail_create_draft", false, executed)], // decision.requiresApproval=true côté mock email
      buildContext: async () => ({ newEmails: [{ subject: "Q", from: "a@b.com", threadId: "t1" }] }),
    };

    const result = await runAgentCycle("user-1", definition, trigger);

    expect(result.status).toBe("awaiting_approval");
    expect(executed).not.toHaveBeenCalled();
    // Fix bloquant QA 2026-07-27 : l'action doit être journalisée dans karta_pending_actions
    // (id retourné par l'insert mocké) pour pouvoir être réellement exécutée après approbation.
    expect(result.toolsUsed[0].pendingActionId).toBe("pending-1");
  });

  it("ne casse pas si l'outil décidé par Claude n'existe pas dans la définition de l'agent", async () => {
    vi.resetModules();
    vi.doMock("../src/claude/index.js", () => ({
      getClaudeClient: () => ({
        isMock: true,
        decide: async () => ({
          summary: "test",
          toolCalls: [{ tool: "outil_qui_nexiste_pas", params: {} }],
          requiresApproval: false,
          mock: true,
        }),
      }),
    }));

    const { runAgentCycle: freshRunAgentCycle } = await import("../src/engine/loop.js");
    const definition: AgentDefinition = {
      type: "email",
      systemPrompt: "test",
      tools: [],
      buildContext: async () => ({}),
    };

    const result = await freshRunAgentCycle("user-1", definition, trigger);
    expect(result.status).toBe("success");
    expect(result.toolsUsed[0].success).toBe(false);
    expect(result.toolsUsed[0].resultSummary).toContain("inconnu");

    vi.doUnmock("../src/claude/index.js");
  });

  it("ne fait rien de plus qu'un skip si l'agent est désactivé", async () => {
    tableResolutions.karta_agent_state = {
      data: { is_enabled: false, autonomy_level: 1, kill_switch: false, simulation_mode: true },
      error: null,
    };

    const buildContext = vi.fn(async () => ({}));
    const definition: AgentDefinition = { type: "compta", systemPrompt: "test", tools: [], buildContext };

    const result = await runAgentCycle("user-1", definition, trigger);

    expect(result.resultSummary).toContain("désactivé");
    expect(buildContext).not.toHaveBeenCalled(); // le cycle s'arrête avant même de construire le contexte

    tableResolutions.karta_agent_state = { data: { is_enabled: true, autonomy_level: 2, kill_switch: false, simulation_mode: false }, error: null };
  });

  it("respecte le kill switch global avant tout", async () => {
    // isGlobalKillSwitchActive() cache 5s côté module (cf killswitch.ts) — reset le registre de
    // modules pour repartir d'un cache vierge, sinon ce test hériterait du "false" mis en cache
    // par les tests précédents dans ce même fichier.
    vi.resetModules();
    tableResolutions.karta_global_state = { data: { kill_switch: true }, error: null };

    const { runAgentCycle: freshRunAgentCycle } = await import("../src/engine/loop.js");
    const buildContext = vi.fn(async () => ({}));
    const definition: AgentDefinition = { type: "legal", systemPrompt: "test", tools: [], buildContext };

    const result = await freshRunAgentCycle("user-1", definition, trigger);

    expect(result.resultSummary).toContain("kill switch global");
    expect(buildContext).not.toHaveBeenCalled();

    tableResolutions.karta_global_state = { data: { kill_switch: false }, error: null };
  });
});
