import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunResult } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  run: vi.fn(), resolve: vi.fn(), processor: undefined as undefined | ((job: unknown) => Promise<unknown>),
  options: {} as Record<string, unknown>,
}));
vi.mock("bullmq", () => ({
  UnrecoverableError: class UnrecoverableError extends Error {},
  Worker: class {
    constructor(_name: string, processor: (job: unknown) => Promise<unknown>, options: Record<string, unknown>) {
      h.processor = processor;
      h.options = options;
    }
    on = vi.fn();
  },
}));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("../src/engine/loop.js", () => ({ runAgentCycle: h.run }));
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: h.resolve }));
const { startAgentCycleWorker } = await import("../src/queue/worker.js");
const { UnrecoverableError } = await import("bullmq");
const job = { data: { agentType: "legal", userId: "user-1", trigger: { type: "manual", source: "test" } } };

function result(status: AgentRunResult["status"], retrySafe?: boolean): AgentRunResult {
  return { status, retrySafe, decision: "test", toolsUsed: [], resultSummary: "test", mock: true, errorMessage: "failure" };
}

describe("agent cycle worker retry policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    h.resolve.mockResolvedValue({ type: "legal" });
    startAgentCycleWorker();
  });

  it.each([undefined, false])("interdit la reprise si retrySafe vaut %s", async (retrySafe) => {
    h.run.mockResolvedValue(result("error", retrySafe));
    await expect(h.processor!(job)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.run).toHaveBeenCalledOnce();
  });

  it("autorise la reprise seulement après une classification explicite sans effet", async () => {
    h.run.mockResolvedValue(result("error", true));
    let error: unknown;
    try { await h.processor!(job); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it("ne rejoue pas une exception non classifiée du cycle", async () => {
    h.run.mockRejectedValue(new Error("unexpected after possible effect"));
    await expect(h.processor!(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it("permet une reprise de résolution de définition avant le cycle", async () => {
    h.resolve.mockRejectedValue(new Error("definition unavailable"));
    let error: unknown;
    try { await h.processor!(job); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("désactive la répétition automatique des jobs dont le verrou a expiré", () => {
    expect(h.options.maxStalledCount).toBe(0);
  });

  it.each(["success", "awaiting_approval", "skipped", "simulated"] as const)("rend le résultat %s sans reprise", async (status) => {
    const outcome = result(status, false);
    h.run.mockResolvedValue(outcome);
    await expect(h.processor!(job)).resolves.toBe(outcome);
  });
});
