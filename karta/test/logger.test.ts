import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";

/** Chaîne update().eq().lt().select() awaitée via then — une seule résolution par test. */
let chainResolution: { data: unknown; error: unknown };

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: vi.fn(() => {
      const builder: Record<string, unknown> = {};
      for (const method of ["eq", "lt", "select", "update"]) {
        builder[method] = vi.fn(() => builder);
      }
      builder.then = (onResolve: (v: typeof chainResolution) => unknown) =>
        Promise.resolve(chainResolution).then(onResolve);
      return builder;
    }),
  },
}));

const { reconcileStaleRuns } = await import("../src/engine/logger.js");

describe("reconcileStaleRuns — clôture des runs orphelins au démarrage (P0 2026-09-26)", () => {
  beforeEach(() => {
    chainResolution = { data: [], error: null };
  });

  it("retourne le nombre de runs 'running' orphelins réconciliés en erreur", async () => {
    chainResolution = { data: [{ id: "r1" }, { id: "r2" }], error: null };
    await expect(reconcileStaleRuns()).resolves.toBe(2);
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
