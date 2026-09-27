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

  it("un outil qui retourne {ok:false} sans lever est un ÉCHEC journalisé (faux succès interdit)", async () => {
    const executed = vi.fn(async () => ({ ok: false, error: "envoi refusé par Gmail" }));
    const definition: AgentDefinition = {
      type: "legal",
      systemPrompt: "test",
      tools: [stubTool("send_notification", false, executed)],
      buildContext: async () => ({ upcomingDeadlines: [{ title: "doc", expires_at: "2026-08-01" }] }),
    };

    const result = await runAgentCycle("user-1", definition, trigger);

    expect(result.status).toBe("success"); // le cycle se termine ; c'est l'OUTIL qui est en échec
    expect(result.toolsUsed[0].success).toBe(false);
    expect(result.toolsUsed[0].resultSummary).toContain("envoi refusé par Gmail");
    expect(result.sideEffectsCommitted).toBe(true); // tentative réelle → pas de rejeu BullMQ possible
  });

  it("un outil qui pend est abandonné en échec timeout au bout de 30s (plus jamais de worker figé)", async () => {
    vi.useFakeTimers();
    try {
      const executed = vi.fn(() => new Promise<never>(() => {})); // pend pour toujours
      const definition: AgentDefinition = {
        type: "legal",
        systemPrompt: "test",
        tools: [stubTool("send_notification", false, executed)],
        buildContext: async () => ({ upcomingDeadlines: [{ title: "doc", expires_at: "2026-08-01" }] }),
      };

      const cycle = runAgentCycle("user-1", definition, trigger);
      await vi.advanceTimersByTimeAsync(30_500);
      const result = await cycle;

      expect(result.status).toBe("success"); // cycle terminé, échec porté par l'outil
      expect(result.toolsUsed[0].success).toBe(false);
      expect(result.toolsUsed[0].resultSummary).toContain("send_notification");
      expect(result.toolsUsed[0].resultSummary).toContain("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("les outils déjà exécutés restent journalisés si l'écriture du journal échoue APRÈS (sideEffectsCommitted=true)", async () => {
    // Cas critique réel : l'outil a agi (side-effect commis) puis karta_runs est injoignable au
    // moment de la clôture → le chemin catch doit préserver la trace de l'outil au lieu de la
    // perdre. (recordRunOutcome/notify sont volontairement non fatals dans loop.ts — le seul
    // échec post-outils qui fait basculer le cycle en erreur est run.finish.)
    vi.resetModules();
    vi.doMock("../src/engine/logger.js", () => ({
      startRun: async () => ({
        runId: "run-err",
        finish: async () => {
          throw new Error("boom écriture karta_runs");
        },
      }),
    }));
    vi.doMock("../src/claude/index.js", () => ({
      getClaudeClient: () => ({
        isMock: true,
        decide: async () => ({
          summary: "notifier l'échéance",
          toolCalls: [{ tool: "send_notification", params: {} }],
          requiresApproval: false,
          mock: true,
        }),
      }),
    }));

    const { runAgentCycle: freshRunAgentCycle } = await import("../src/engine/loop.js");
    const executed = vi.fn(async () => ({ ok: true }));
    const definition: AgentDefinition = {
      type: "legal",
      systemPrompt: "test",
      tools: [stubTool("send_notification", false, executed)],
      buildContext: async () => ({}),
    };

    const result = await freshRunAgentCycle("user-1", definition, trigger);

    expect(result.status).toBe("error");
    expect(result.errorMessage).toContain("boom écriture karta_runs");
    expect(executed).toHaveBeenCalledOnce(); // l'outil a RÉELLEMENT tourné avant l'échec
    expect(result.toolsUsed).toHaveLength(1); // ...et sa trace survit au chemin d'erreur
    expect(result.toolsUsed[0].success).toBe(true);
    expect(result.sideEffectsCommitted).toBe(true); // rejeu BullMQ interdit (doublerait le side-effect)

    vi.doUnmock("../src/engine/logger.js");
    vi.doUnmock("../src/claude/index.js");
  });

  it("un buildContext qui pend est abandonné en timeout 60s — plus de slot worker figé ni verrou détenu jusqu'au TTL", async () => {
    vi.useFakeTimers();
    try {
      const hangingContext = vi.fn(() => new Promise<Record<string, unknown>>(() => {})); // DB injoignable
      const definition: AgentDefinition = {
        type: "legal",
        systemPrompt: "test",
        tools: [],
        buildContext: hangingContext,
      };

      const cycle = runAgentCycle("user-1", definition, trigger);
      await vi.advanceTimersByTimeAsync(60_500);
      const result = await cycle;

      expect(result.status).toBe("error");
      expect(result.errorMessage).toContain("buildContext(legal)");
      expect(result.errorMessage).toContain("timeout");
      expect(result.sideEffectsCommitted).toBe(false); // échec AVANT tout side-effect → rejeu BullMQ sûr
      expect(result.toolsUsed).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("C5 ordering — le reçu (run.finish) est écrit AVANT la notification et le compteur d'issue", async () => {
    // Cœur du contrat receipts (C13) : si le process meurt entre finish et notify, la trace
    // en base existe déjà — jamais l'inverse (une notification sans reçu serait un mensonge).
    const events: string[] = [];
    vi.resetModules();
    vi.doMock("../src/engine/logger.js", () => ({
      startRun: async () => ({
        runId: "run-order",
        finish: async () => {
          events.push("finish");
        },
      }),
    }));
    vi.doMock("../src/engine/notify.js", () => ({
      notify: async () => {
        events.push("notify");
      },
    }));
    vi.doMock("../src/engine/autonomy.js", () => ({
      isRunnable: () => ({ ok: true }),
      loadAgentState: async () => ({ isEnabled: true, autonomyLevel: 2, killSwitch: false, simulationMode: false }),
      requiresHumanApproval: () => false,
      recordRunOutcome: vi.fn(async (_userId: string, _agentType: string, outcome: string) => {
        events.push(`outcome:${outcome}`);
      }),
    }));
    vi.doMock("../src/claude/index.js", () => ({
      getClaudeClient: () => ({
        isMock: true,
        decide: async () => ({
          summary: "action décidée",
          toolCalls: [{ tool: "send_notification", params: {} }],
          requiresApproval: true, // force le chemin awaiting_approval → notify() est appelé
          mock: true,
        }),
      }),
    }));

    const { runAgentCycle: freshRunAgentCycle } = await import("../src/engine/loop.js");
    const executed = vi.fn(async () => ({ ok: true }));
    const definition: AgentDefinition = {
      type: "legal",
      systemPrompt: "test",
      tools: [stubTool("send_notification", false, executed)],
      buildContext: async () => ({}),
    };

    const result = await freshRunAgentCycle("user-1", definition, trigger);

    expect(result.status).toBe("awaiting_approval");
    expect(executed).not.toHaveBeenCalled(); // chemin approbation : l'outil ne tourne JAMAIS
    expect(events).toEqual(["finish", "notify", "outcome:success"]); // ORDRE exact

    vi.doUnmock("../src/engine/logger.js");
    vi.doUnmock("../src/engine/notify.js");
    vi.doUnmock("../src/engine/autonomy.js");
    vi.doUnmock("../src/claude/index.js");
  });

  it("concurrence : deux cycles parallèles ne se contaminent pas (état par invocation, pas par module)", async () => {
    // Régression du bloc central 2026-09-26 : toolsUsed/sideEffectsCommitted vivaient en variables
    // de MODULE — partagées entre les cycles concurrents du worker (concurrency 5). Ici le cycle
    // "legal" échoue à la clôture de son journal après son outil ; le cycle "compta" parallèle
    // doit rester intact.
    vi.resetModules();
    vi.doMock("../src/engine/logger.js", () => ({
      startRun: async (_userId: string, agentType: string) => ({
        runId: `run-${agentType}`,
        finish: async () => {
          if (agentType === "legal") throw new Error("boom écriture karta_runs (legal)");
        },
      }),
    }));
    vi.doMock("../src/claude/index.js", () => ({
      getClaudeClient: () => ({
        isMock: true,
        decide: async ({ agentType }: { agentType: string }) => ({
          summary: "action décidée",
          toolCalls: [{ tool: agentType === "compta" ? "supabase_upsert" : "send_notification", params: {} }],
          requiresApproval: false,
          mock: true,
        }),
      }),
    }));

    const { runAgentCycle: freshRunAgentCycle } = await import("../src/engine/loop.js");
    const legalExecuted = vi.fn(async () => ({ ok: true, draft: "brouillon" }));
    const comptaExecuted = vi.fn(async () => ({ ok: true, rows: 2 }));
    const legalDef: AgentDefinition = {
      type: "legal",
      systemPrompt: "test",
      tools: [stubTool("send_notification", false, legalExecuted)],
      buildContext: async () => ({}),
    };
    const comptaDef: AgentDefinition = {
      type: "compta",
      systemPrompt: "test",
      tools: [stubTool("supabase_upsert", false, comptaExecuted)],
      buildContext: async () => ({}),
    };

    const [legalResult, comptaResult] = await Promise.all([
      freshRunAgentCycle("user-1", legalDef, trigger),
      freshRunAgentCycle("user-2", comptaDef, trigger),
    ]);

    expect(legalResult.status).toBe("error");
    expect(legalResult.toolsUsed).toHaveLength(1);
    expect(legalResult.toolsUsed[0].success).toBe(true);
    expect(legalResult.sideEffectsCommitted).toBe(true);
    expect(comptaResult.status).toBe("success"); // le voisin n'a pas hérité de l'erreur
    expect(comptaResult.toolsUsed).toHaveLength(1);
    expect(comptaResult.toolsUsed[0].success).toBe(true);

    vi.doUnmock("../src/engine/logger.js");
    vi.doUnmock("../src/claude/index.js");
  });
});
