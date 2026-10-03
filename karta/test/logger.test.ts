import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  insertResult: { data: { id: "run-1" } as { id: string } | null, error: null },
  updateResult: { data: { id: "run-1" } as { id: string } | null, error: null as { message: string } | null },
  updates: vi.fn(),
  filters: vi.fn(),
}));
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: () => {
      const builder = {
        insert: () => builder,
        update: (value: unknown) => { db.updates(value); return builder; },
        select: () => builder,
        eq: (key: string, value: unknown) => { db.filters(key, value); return builder; },
        single: async () => db.insertResult,
        maybeSingle: async () => db.updateResult,
      };
      return builder;
    },
  },
}));
import { startRun, type RunLogHandle } from "../src/engine/logger.js";
const outcome: Parameters<RunLogHandle["finish"]>[0] = {
  status: "success", decision: "décision", toolsUsed: [], resultSummary: "aucune action", mock: true,
};

describe("confirmation du journal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.insertResult = { data: { id: "run-1" }, error: null };
    db.updateResult = { data: { id: "run-1" }, error: null };
  });

  it("clôture uniquement un journal encore running et confirme une ligne", async () => {
    const run = await startRun("u1", "legal", { type: "manual", source: "test" }, "live");
    await run.finish(outcome);
    expect(db.filters).toHaveBeenCalledWith("id", "run-1");
    expect(db.filters).toHaveBeenCalledWith("status", "running");
    await expect(run.finish(outcome)).rejects.toThrow("clôture déjà tentée");
    expect(db.updates).toHaveBeenCalledTimes(1);
  });

  it("ne confond pas zéro ligne et écriture confirmée", async () => {
    db.updateResult.data = null;
    const run = await startRun("u1", "legal", { type: "manual", source: "test" }, "live");
    await expect(run.finish(outcome)).rejects.toThrow("absent ou déjà clôturé");
  });

  it("ne réécrit pas après une réponse perdue potentiellement appliquée", async () => {
    db.updateResult = { data: null, error: { message: "réponse perdue" } };
    const run = await startRun("u1", "legal", { type: "manual", source: "test" }, "live");
    await expect(run.finish(outcome)).rejects.toThrow("réponse perdue");
    await expect(run.finish(outcome)).rejects.toThrow("clôture déjà tentée");
    expect(db.updates).toHaveBeenCalledTimes(1);
  });

  it("refuse une insertion dont l'identifiant est absent", async () => {
    db.insertResult.data = null;
    await expect(startRun("u1", "legal", { type: "manual", source: "test" }, "live")).rejects.toThrow("non confirmé");
    expect(db.updates).not.toHaveBeenCalled();
  });
});
