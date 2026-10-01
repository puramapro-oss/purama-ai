import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ row: undefined as unknown, error: null as { message: string } | null }));
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: () => {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: database.row, error: database.error }),
      };
      return builder;
    },
  },
}));

import { loadAgentState } from "../src/engine/autonomy.js";

describe("frontière des autorisations stockées", () => {
  beforeEach(() => {
    database.error = null;
    database.row = { is_enabled: true, autonomy_level: 2, kill_switch: false, simulation_mode: false };
  });

  it("accepte un état explicitement typé", async () => {
    await expect(loadAgentState("u1", "legal")).resolves.toEqual({
      userId: "u1", agentType: "legal", isEnabled: true, autonomyLevel: 2, killSwitch: false, simulationMode: false,
    });
  });

  it.each([
    { autonomy_level: 0 }, { autonomy_level: 4 }, { autonomy_level: "3" },
    { is_enabled: "true" }, { kill_switch: null }, { simulation_mode: undefined },
  ])("refuse un état ambigu au lieu d'élargir les droits : %j", async (invalid) => {
    database.row = { ...(database.row as Record<string, unknown>), ...invalid };
    await expect(loadAgentState("u1", "legal")).rejects.toThrow("état invalide");
  });

  it("ne transforme pas une erreur DB en autorisation", async () => {
    database.error = { message: "lecture interrompue" };
    await expect(loadAgentState("u1", "legal")).rejects.toThrow("lecture interrompue");
  });
});
