import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  initialReads: 0,
  initialReadWaiters: [] as Array<() => void>,
  upsertOptions: [] as unknown[],
}));

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: () => {
      let operation: "select" | "upsert" = "select";
      const builder = {
        select: () => builder,
        eq: () => builder,
        upsert: (_row: unknown, options: unknown) => {
          operation = "upsert";
          h.upsertOptions.push(options);
          return builder;
        },
        maybeSingle: async () => {
          if (operation === "select" && h.initialReads < 2) {
            h.initialReads += 1;
            await new Promise<void>((resolve) => {
              h.initialReadWaiters.push(resolve);
              if (h.initialReadWaiters.length === 2) {
                for (const release of h.initialReadWaiters.splice(0)) release();
              }
            });
            return { data: null, error: null };
          }
          if (operation === "upsert") {
            if (h.row) return { data: null, error: null };
            h.row = {
              is_enabled: true,
              autonomy_level: 1,
              kill_switch: false,
              simulation_mode: true,
            };
            return { data: h.row, error: null };
          }
          return { data: h.row, error: null };
        },
      };
      return builder;
    },
  },
}));

const { loadAgentState } = await import("../src/engine/autonomy.js");

describe("loadAgentState — création concurrente", () => {
  it("retourne le même état aux deux concurrents sans écraser le gagnant", async () => {
    const [first, second] = await Promise.all([
      loadAgentState("user-1", "legal"),
      loadAgentState("user-1", "legal"),
    ]);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      userId: "user-1",
      agentType: "legal",
      autonomyLevel: 1,
      simulationMode: true,
    });
    expect(h.upsertOptions).toEqual([
      { onConflict: "user_id,agent_type", ignoreDuplicates: true },
      { onConflict: "user_id,agent_type", ignoreDuplicates: true },
    ]);
  });
});
