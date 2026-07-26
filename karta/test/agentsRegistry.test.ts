import { describe, expect, it, vi } from "vitest";

const fromCalls: Array<{ table: string; eqCalls: Array<[string, unknown]> }> = [];

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const record = { table, eqCalls: [] as Array<[string, unknown]> };
      fromCalls.push(record);
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((col: string, val: unknown) => {
          record.eqCalls.push([col, val]);
          return builder;
        }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [{ user_id: "u1" }], error: null }).then(resolve),
      };
      return builder;
    }),
  },
}));

const { listActiveUserIds, AGENT_REGISTRY } = await import("../src/agents/index.js");

describe("listActiveUserIds", () => {
  it("interroge la table de config dédiée pour un agent cœur (compta)", async () => {
    fromCalls.length = 0;
    const result = await listActiveUserIds("compta");
    expect(fromCalls[0].table).toBe("compta_agent_config");
    expect(fromCalls[0].eqCalls).toContainEqual(["is_active", true]);
    expect(result).toEqual(["u1"]);
  });

  it("interroge karta_agent_state pour un agent action (crm-intelligent)", async () => {
    fromCalls.length = 0;
    await listActiveUserIds("crm-intelligent");
    expect(fromCalls[0].table).toBe("karta_agent_state");
    expect(fromCalls[0].eqCalls).toContainEqual(["agent_type", "crm-intelligent"]);
    expect(fromCalls[0].eqCalls).toContainEqual(["is_enabled", true]);
  });
});

describe("AGENT_REGISTRY", () => {
  it("contient les 4 agents cœur + les 12 agents action (16 au total)", () => {
    expect(Object.keys(AGENT_REGISTRY)).toHaveLength(16);
  });

  it("chaque agent a un systemPrompt non vide et au moins un outil", () => {
    for (const [type, def] of Object.entries(AGENT_REGISTRY)) {
      expect(def.systemPrompt.length, `${type} systemPrompt`).toBeGreaterThan(20);
      expect(def.tools.length, `${type} tools`).toBeGreaterThan(0);
    }
  });
});
