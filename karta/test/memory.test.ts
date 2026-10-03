import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ value: null as string | null, deleteCalls: 0 }));

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: () => {
      const builder = {
        delete: () => {
          h.deleteCalls += 1;
          return builder;
        },
        eq: () => builder,
        select: () => builder,
        maybeSingle: async () => {
          const claimed = h.value;
          h.value = null;
          await Promise.resolve();
          return { data: claimed === null ? null : { memory_value: claimed }, error: null };
        },
      };
      return builder;
    },
  },
}));

const { consumeBrief } = await import("../src/engine/memory.js");

describe("consumeBrief — consommation atomique", () => {
  beforeEach(() => {
    h.value = "Créer la campagne d'octobre";
    h.deleteCalls = 0;
  });

  it("ne remet le même brief qu'à un seul cycle concurrent", async () => {
    const results = await Promise.all([
      consumeBrief("user-1", "newsletter-genie"),
      consumeBrief("user-1", "newsletter-genie"),
    ]);

    expect(results.filter(Boolean)).toEqual(["Créer la campagne d'octobre"]);
    expect(results.filter((value) => value === null)).toHaveLength(1);
    expect(h.deleteCalls).toBe(2);
  });
});
