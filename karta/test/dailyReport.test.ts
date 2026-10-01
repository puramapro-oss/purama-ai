import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ notify: vi.fn(), query: vi.fn() }));
vi.mock("../src/engine/notify.js", () => ({ notify: mocks.notify }));
vi.mock("../src/db/supabase.js", () => ({
  supabase: { from: () => ({ select: () => ({ gte: mocks.query }) }) },
}));
import { runDailyReport } from "../src/scheduler/dailyReport.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.notify.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ data: [
    { user_id: "u1", agent_type: "legal", status: "success", mode: "live" },
    { user_id: "u2", agent_type: "legal", status: "simulated", mode: "simulation" },
  ], error: null });
});

describe("rapports indépendants après confirmation stricte", () => {
  it("poursuit le deuxième destinataire après un échec partiel du premier sans le répéter", async () => {
    mocks.notify.mockRejectedValueOnce(new Error("email non confirmé après notification"));
    await expect(runDailyReport()).rejects.toThrow("1/2 rapport(s) non confirmés");
    expect(mocks.notify).toHaveBeenCalledTimes(2);
    expect(mocks.notify.mock.calls.map(([request]) => request.userId)).toEqual(["u1", "u2"]);
  });

  it("résume séparément le cycle live et la simulation", async () => {
    await expect(runDailyReport()).resolves.toBeUndefined();
    expect(mocks.notify.mock.calls[0][0].body).toContain("1 réussi(s) hors simulation");
    expect(mocks.notify.mock.calls[1][0].body).toContain("0 réussi(s) hors simulation");
    expect(mocks.notify.mock.calls[1][0].body).toContain("1 simulé(s)");
  });

  it("n'envoie aucun bilan à partir d'une lecture DB échouée", async () => {
    mocks.query.mockResolvedValue({ data: null, error: { message: "lecture interrompue" } });
    await expect(runDailyReport()).rejects.toThrow("lecture interrompue");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
