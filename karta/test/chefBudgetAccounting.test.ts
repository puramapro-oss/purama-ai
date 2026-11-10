import { afterEach, describe, expect, it, vi } from "vitest";
import { runChefWorkerCycle, type ChefControlPlane, type ChefRuntimeTask } from "../src/chef/supervisor.js";
import type { ChefDriverResponse, ChefWorkerDriver } from "../src/chef/driver.js";
import type { ChefVerifier } from "../src/chef/verifier.js";
import { ChefProcessStopUnconfirmedError } from "../src/chef/process.js";

const task: ChefRuntimeTask = {
  id: "budget-task", missionId: "budget-mission", briefHash: "a".repeat(64), instructions: "Read only",
  cwd: process.cwd(), accessMode: "read", fencingToken: 9, attempt: 2,
  verificationProfiles: ["review"], allowedPaths: [],
};
function fixture(response: ChefDriverResponse, accountingReady = true) {
  const control: ChefControlPlane = {
    heartbeat: vi.fn(async () => undefined), claimNext: vi.fn(async () => task),
    renewLease: vi.fn(async () => true), transition: vi.fn(async () => true),
    addEvidence: vi.fn(async () => true), recordUsage: vi.fn(async () => accountingReady),
    tryFinishMission: vi.fn(async () => true),
  };
  const driver: ChefWorkerDriver = { provider: "codex", run: vi.fn(async () => response) };
  const verifier: ChefVerifier = {
    verify: vi.fn(async () => ({ ok: true, evidence: [{ kind: "review" as const, sha256: "b".repeat(64), payload: { ok: true, profile: "review" }, requirementKeys: [] }] })),
  };
  const run = () => runChefWorkerCycle(control, driver, verifier, {
    missionId: task.missionId, workerId: "budget-worker", provider: "codex", leaseSeconds: 30, renewEveryMs: 1_000,
  });
  return { control, driver, verifier, run };
}
afterEach(() => { vi.useRealTimers(); });

describe("CHEF budget accounting at the worker boundary", () => {
  it("never verifies capped work when all provider usage is missing", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "done" }, false);
    expect(await f.run()).toMatchObject({ state: "blocked_external", taskId: task.id });
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      taskId: task.id, workerId: "budget-worker", attempt: 2, fencingToken: 9,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, costMicros: null,
    }));
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
  });

  it("does not invent a zero cost when only token counts are known", async () => {
    const f = fixture({
      schemaVersion: 1, status: "completed", summary: "done", usage: { inputTokens: 20, outputTokens: 5 },
    }, false);
    expect(await f.run()).toMatchObject({ state: "blocked_external" });
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 20, outputTokens: 5, costMicros: null }));
  });

  it("lets the database explicitly allow unlimited work without falsifying metrics", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "done" });
    expect(await f.run()).toMatchObject({ state: "verified_done" });
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: null, outputTokens: null, costMicros: null }));
  });

  it("holds accounting closed when receipt persistence fails", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "done", usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 } });
    vi.mocked(f.control.recordUsage).mockRejectedValueOnce(new Error("receipt unavailable"));
    expect(await f.run()).toMatchObject({ state: "blocked_external", error: "receipt unavailable" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });

  it("distinguishes an absent cost from an explicitly observed zero in receipt keys", async () => {
    const missing = fixture({ schemaVersion: 1, status: "completed", summary: "done", usage: { inputTokens: 0, outputTokens: 0 } });
    const zero = fixture({ schemaVersion: 1, status: "completed", summary: "done", usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 } });
    await missing.run(); await zero.run();
    const a = vi.mocked(missing.control.recordUsage).mock.calls[0][0].eventKey;
    const b = vi.mocked(zero.control.recordUsage).mock.calls[0][0].eventKey;
    expect(a).not.toBe(b);
    expect(a.length).toBeLessThanOrEqual(256);
  });

  it("settles a known zero when the driver was never started", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    vi.mocked(f.control.claimNext).mockResolvedValueOnce({ ...task, briefHash: "invalid" });
    expect(await f.run()).toMatchObject({ state: "failed" });
    expect(f.driver.run).not.toHaveBeenCalled();
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0 }));
  });

  it("settles zero after a pre-driver heartbeat failure and never calls the provider", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    vi.mocked(f.control.heartbeat).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("heartbeat lost"));
    await expect(f.run()).rejects.toThrow("heartbeat lost");
    expect(f.driver.run).not.toHaveBeenCalled();
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0, costMicros: 0 }));
  });

  it("settles known zero before releasing a claim obtained during shutdown", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    const cancel = new AbortController();
    vi.mocked(f.control.claimNext).mockImplementation(async () => { cancel.abort(); return task; });
    const result = await runChefWorkerCycle(f.control, f.driver, f.verifier, {
      missionId: task.missionId, workerId: "budget-worker", provider: "codex", signal: cancel.signal,
    });
    expect(result).toMatchObject({ state: "retryable" });
    expect(f.driver.run).not.toHaveBeenCalled();
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2, fencingToken: 9, inputTokens: 0, outputTokens: 0, costMicros: 0,
    }));
    expect(vi.mocked(f.control.recordUsage).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(f.control.transition).mock.invocationCallOrder[0]);
  });

  it("retains unknown consumption after shutdown of a driver that already started", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    const cancel = new AbortController();
    vi.mocked(f.driver.run).mockImplementation(async () => {
      cancel.abort();
      throw new Error("process stopped with no provider receipt");
    });
    const result = await runChefWorkerCycle(f.control, f.driver, f.verifier, {
      missionId: task.missionId, workerId: "budget-worker", provider: "codex", signal: cancel.signal,
    });
    expect(result).toMatchObject({ state: "retryable" });
    expect(f.control.recordUsage).not.toHaveBeenCalled();
    expect(f.verifier.verify).not.toHaveBeenCalled();
  });

  it("persists quarantine before releasing an unconfirmed process without settling its cost to zero", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    f.control.quarantineProcess = vi.fn(async () => true);
    vi.mocked(f.driver.run).mockRejectedValueOnce(new ChefProcessStopUnconfirmedError("descendant still alive"));
    expect(await f.run()).toMatchObject({ state: "blocked_external", haltWorker: true });
    expect(f.control.quarantineProcess).toHaveBeenCalledWith(task.id,
      { workerId: "budget-worker", attempt: 2, fencingToken: 9 }, "descendant still alive");
    expect(f.control.recordUsage).not.toHaveBeenCalled();
    const blockedCall = vi.mocked(f.control.transition).mock.calls.findIndex(([input]) => input.target === "blocked_external");
    expect(vi.mocked(f.control.quarantineProcess).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(f.control.transition).mock.invocationCallOrder[blockedCall]);
  });

  it("does not infer zero from a driver exception after execution began", async () => {
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    vi.mocked(f.driver.run).mockRejectedValueOnce(new Error("provider transport failed"));
    expect(await f.run()).toMatchObject({ state: "retryable" });
    expect(f.control.recordUsage).not.toHaveBeenCalled();
  });

  it("records a late receipt for its original claim but cannot finish after losing the lease", async () => {
    vi.useFakeTimers();
    const f = fixture({ schemaVersion: 1, status: "completed", summary: "unused" });
    vi.mocked(f.control.renewLease).mockResolvedValue(false);
    vi.mocked(f.driver.run).mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ schemaVersion: 1, status: "completed", summary: "late", usage: { inputTokens: 10, outputTokens: 3, costMicros: 4 } }), 1_200);
    }));
    const running = f.run();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await running).toMatchObject({ state: "lost_lease" });
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2, fencingToken: 9, costMicros: 4 }));
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
  });
});
