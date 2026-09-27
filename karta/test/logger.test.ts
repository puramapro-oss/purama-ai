import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

/** Résolution de la chaîne update().eq().lt().select() awaitée — ET capture des filtres :
 * sans eux, une mutation retirant .eq("status","running") laissait les tests VERTS alors
 * que la prod aurait clôturé en erreur TOUT run de plus d'1h, y compris terminés
 * (faux vert prouvé par mutation M6, reliability lab 2026-09-27). */
let chainResolution: { data: unknown; error: unknown };
const capturedFilters: { eq: Array<[string, unknown]>; lt: Array<[string, unknown]>; patch: Record<string, unknown> | null } = {
  eq: [],
  lt: [],
  patch: null,
};

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn(() => {
      const builder: Record<string, unknown> = {};
      for (const method of ["eq", "lt", "select", "update"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.eq = vi.fn((col: string, val: unknown) => {
        capturedFilters.eq.push([col, val]);
        return builder;
      });
      builder.lt = vi.fn((col: string, val: unknown) => {
        capturedFilters.lt.push([col, val]);
        return builder;
      });
      builder.update = vi.fn((patch: Record<string, unknown>) => {
        capturedFilters.patch = patch;
        return builder;
      });
      builder.then = (onResolve: (v: typeof chainResolution) => unknown) =>
        Promise.resolve(chainResolution).then(onResolve);
      return builder;
    }),
  },
}));

const { reconcileStaleRuns } = await import("../src/engine/logger.js");

function resetCapture() {
  capturedFilters.eq = [];
  capturedFilters.lt = [];
  capturedFilters.patch = null;
}

describe("reconcileStaleRuns — clôture des runs orphelins au démarrage (P0 2026-09-26)", () => {
  beforeEach(() => {
    chainResolution = { data: [], error: null };
    resetCapture();
  });

  it("retourne le nombre de runs 'running' orphelins réconciliés en erreur", async () => {
    chainResolution = { data: [{ id: "r1" }, { id: "r2" }], error: null };
    await expect(reconcileStaleRuns()).resolves.toBe(2);
  });

  it("PRÉDICATS — ne réconcilie QUE les 'running' plus vieux que la fenêtre (1h par défaut)", async () => {
    const before = Date.now();
    await reconcileStaleRuns();
    const after = Date.now();

    expect(capturedFilters.eq).toContainEqual(["status", "running"]); // jamais les terminés
    const ltCall = capturedFilters.lt.find(([col]) => col === "created_at");
    expect(ltCall).toBeDefined();
    const cutoff = new Date(String(ltCall![1])).getTime();
    // Fenêtre par défaut 1h : le cutoff doit être ~now-3600s (tolérance d'exécution du test)
    expect(cutoff).toBeGreaterThan(before - 3_600_000 - 5_000);
    expect(cutoff).toBeLessThan(after - 3_600_000 + 5_000);
    expect(capturedFilters.patch).toMatchObject({ status: "error" }); // clôture en erreur, jamais en succès
  });

  it("retourne 0 (et ne lève pas) quand il n'y a rien à réconcilier", async () => {
    await expect(reconcileStaleRuns()).resolves.toBe(0);
  });

  it("un échec DB est non fatal : loggé, retourne 0, n'empêche pas le boot", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    chainResolution = { data: null, error: { message: "connection refused" } };
    await expect(reconcileStaleRuns()).resolves.toBe(0);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("reconcileStaleRuns"));
    spy.mockRestore();
  });
});
