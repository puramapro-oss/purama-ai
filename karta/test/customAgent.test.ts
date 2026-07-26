import { describe, expect, it, vi } from "vitest";

const row = {
  id: "11111111-1111-1111-1111-111111111111",
  user_id: "user-1",
  name: "Relanceur d'impayés",
  description: "Relance mes clients qui n'ont pas payé chaque lundi.",
  system_prompt: "Tu es un agent de relance de paiements.",
  tools_enabled: ["supabase_select", "gmail_create_draft", "outil_inconnu"],
  karta_enabled: true,
  is_active: true,
  schedule_enabled: true,
  schedule_cron: "0 9 * * 1",
};

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
      then: (onResolve: (v: { data: unknown[]; error: null }) => unknown) =>
        Promise.resolve({ data: [row], error: null }).then(onResolve),
    })),
  },
}));

const { loadCustomAgent, listKartaEnabledCustomAgents, buildCustomAgentDefinition } = await import(
  "../src/agents/customAgent.js"
);

describe("customAgent — résolution dynamique des agents créés par les users", () => {
  it("loadCustomAgent charge la ligne creator_agents", async () => {
    const loaded = await loadCustomAgent(row.id);
    expect(loaded?.id).toBe(row.id);
    expect(loaded?.system_prompt).toBe(row.system_prompt);
  });

  it("listKartaEnabledCustomAgents retourne les agents activés en exécution réelle", async () => {
    const agents = await listKartaEnabledCustomAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe(row.id);
  });

  it("buildCustomAgentDefinition construit un AgentDefinition valide", () => {
    const definition = buildCustomAgentDefinition(row);

    expect(definition.type).toBe(`custom:${row.id}`);
    expect(definition.systemPrompt).toBe(row.system_prompt);
    // "outil_inconnu" filtré silencieusement (liste blanche), seuls 2 des 3 outils déclarés existent réellement.
    expect(definition.tools.map((t) => t.name)).toEqual(["supabase_select", "gmail_create_draft"]);
  });

  it("buildContext expose le nom et la description de l'agent au cerveau Claude (mock ou réel)", async () => {
    const definition = buildCustomAgentDefinition(row);
    const context = await definition.buildContext(row.user_id, { type: "manual", source: "test" });

    expect(context).toEqual({
      customAgentName: row.name,
      customAgentDescription: row.description,
    });
  });
});
