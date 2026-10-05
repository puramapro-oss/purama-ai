import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CustomAgentRow } from "../src/agents/customAgent.js";

/**
 * Faux client Supabase pour simuler les requêtes vers creator_agents.
 */
class FakeSupabaseClient {
  private store = new Map<string, CustomAgentRow>();

  seed(id: string, row: CustomAgentRow) {
    this.store.set(id, row);
  }

  from(_table: string) {
    const self = this;
    return {
      select(_cols: string) {
        return {
          eq(_col: string, val: string) {
            return {
              async maybeSingle() {
                const row = self.store.get(val);
                return { data: row ?? null, error: null };
              },
            };
          },
        };
      },
    };
  }
}

let fakeClient: FakeSupabaseClient;

// Mock du module supabase AVANT tout import
vi.mock("../src/db/supabase.js", () => {
  fakeClient = new FakeSupabaseClient();
  return { supabase: fakeClient };
});

// Import dynamique APRÈS le mock
const { resolveAgentDefinition } = await import("../src/engine/resolveDefinition.js");
const { buildCustomAgentDefinition } = await import("../src/agents/customAgent.js");

describe("resolveAgentDefinition — fail-closed sur statique inconnu, custom invalide/disabled/inactive", () => {
  beforeEach(() => {
    // Reset le store avant chaque test
    fakeClient["store"].clear();
  });
  it("rejette un agent statique inconnu", async () => {
    await expect(resolveAgentDefinition("agent_invente_par_claude" as any)).rejects.toThrow("Agent statique inconnu: agent_invente_par_claude");
  });

  it("rejette un custom introuvable (ID inexistant)", async () => {
    await expect(resolveAgentDefinition("custom:id-inexistant")).rejects.toThrow("Agent créé introuvable: id-inexistant");
  });

  it("rejette un custom avec karta_enabled=false", async () => {
    fakeClient.seed("agent-disabled", {
      id: "agent-disabled",
      user_id: "user1",
      name: "Agent désactivé",
      description: null,
      system_prompt: "Tu es un agent test.",
      tools_enabled: [],
      karta_enabled: false,
      is_active: true,
      schedule_enabled: false,
      schedule_cron: null,
    });

    await expect(resolveAgentDefinition("custom:agent-disabled")).rejects.toThrow("Agent créé désactivé pour KARTA: agent-disabled");
  });

  it("rejette un custom avec is_active=false", async () => {
    fakeClient.seed("agent-inactive", {
      id: "agent-inactive",
      user_id: "user1",
      name: "Agent inactif",
      description: null,
      system_prompt: "Tu es un agent test.",
      tools_enabled: [],
      karta_enabled: true,
      is_active: false,
      schedule_enabled: false,
      schedule_cron: null,
    });

    await expect(resolveAgentDefinition("custom:agent-inactive")).rejects.toThrow("Agent créé inactif (désactivé par son propriétaire): agent-inactive");
  });

  it("résout un custom valide (karta_enabled=true, is_active=true, system_prompt non vide)", async () => {
    fakeClient.seed("agent-valid", {
      id: "agent-valid",
      user_id: "user1",
      name: "Agent valide",
      description: "Description test",
      system_prompt: "Tu es un agent de test fonctionnel.",
      tools_enabled: ["web_search"],
      karta_enabled: true,
      is_active: true,
      schedule_enabled: true,
      schedule_cron: "0 9 * * *",
    });

    const definition = await resolveAgentDefinition("custom:agent-valid" as any);
    expect(definition.type).toBe("custom:agent-valid");
    expect(definition.systemPrompt).toBe("Tu es un agent de test fonctionnel.");
    expect(definition.tools).toHaveLength(1);

    const context = await definition.buildContext("user1", "scheduled_scan" as any);
    expect(context).toEqual({
      customAgentName: "Agent valide",
      customAgentDescription: "Description test",
    });
  });
});

describe("buildCustomAgentDefinition — fail-closed sur system_prompt vide/malformé", () => {
  it("rejette un custom avec system_prompt null", () => {
    const row: CustomAgentRow = {
      id: "agent-null-prompt",
      user_id: "user1",
      name: "Agent prompt null",
      description: null,
      system_prompt: null as any,
      tools_enabled: [],
      karta_enabled: true,
      is_active: true,
      schedule_enabled: false,
      schedule_cron: null,
    };

    expect(() => buildCustomAgentDefinition(row)).toThrow("Agent créé malformé (system_prompt vide): agent-null-prompt");
  });

  it("rejette un custom avec system_prompt vide", () => {
    const row: CustomAgentRow = {
      id: "agent-empty-prompt",
      user_id: "user1",
      name: "Agent prompt vide",
      description: null,
      system_prompt: "",
      tools_enabled: [],
      karta_enabled: true,
      is_active: true,
      schedule_enabled: false,
      schedule_cron: null,
    };

    expect(() => buildCustomAgentDefinition(row)).toThrow("Agent créé malformé (system_prompt vide): agent-empty-prompt");
  });

  it("rejette un custom avec system_prompt whitespace-only", () => {
    const row: CustomAgentRow = {
      id: "agent-whitespace-prompt",
      user_id: "user1",
      name: "Agent prompt whitespace",
      description: null,
      system_prompt: "   \n  \t  ",
      tools_enabled: [],
      karta_enabled: true,
      is_active: true,
      schedule_enabled: false,
      schedule_cron: null,
    };

    expect(() => buildCustomAgentDefinition(row)).toThrow("Agent créé malformé (system_prompt vide): agent-whitespace-prompt");
  });

  it("accepte un custom avec system_prompt valide (non vide)", () => {
    const row: CustomAgentRow = {
      id: "agent-valid-prompt",
      user_id: "user1",
      name: "Agent valide",
      description: "Test",
      system_prompt: "Tu es un agent fonctionnel.",
      tools_enabled: [],
      karta_enabled: true,
      is_active: true,
      schedule_enabled: false,
      schedule_cron: null,
    };

    const definition = buildCustomAgentDefinition(row);
    expect(definition.systemPrompt).toBe("Tu es un agent fonctionnel.");
  });
});
