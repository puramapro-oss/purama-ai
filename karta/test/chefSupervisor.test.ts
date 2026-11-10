import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcessChefDriver } from "../src/chef/driver.js";
import { ChefProcessStopUnconfirmedError } from "../src/chef/process.js";
import type { ChefDriverResponse, ChefWorkerDriver } from "../src/chef/driver.js";
import type { ChefControlPlane, ChefRuntimeTask } from "../src/chef/supervisor.js";
import { runChefWorkerCycle } from "../src/chef/supervisor.js";
import { verifyCommittedGitState } from "../src/chef/git-state.js";
import type { ChefVerificationEvidence, ChefVerificationResult, ChefVerifier } from "../src/chef/verifier.js";

vi.mock("../src/chef/git-state.js", () => ({
  captureCleanGitBaseline: vi.fn(async () => ({ headSha: "a".repeat(40), branch: "main" })),
  verifyCommittedGitState: vi.fn(async () => ({
    kind: "receipt",
    sha256: "9".repeat(64),
    payload: { profile: "git-state", ok: true, headSha: "d".repeat(40), clean: true },
  })),
}));

const hash = "c".repeat(64);
const sha = "d".repeat(40);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyCommittedGitState).mockReset().mockResolvedValue({
    kind: "receipt", sha256: "9".repeat(64),
    payload: { profile: "git-state", ok: true, headSha: sha, clean: true },
  });
});

function makeTask(overrides: Partial<ChefRuntimeTask> = {}): ChefRuntimeTask {
  return {
    id: "task-1",
    missionId: "mission-1",
    briefHash: hash,
    instructions: "implement",
    cwd: process.cwd(),
    accessMode: "write",
    fencingToken: 3,
    attempt: 1,
    verificationProfiles: ["unit"],
    allowedPaths: ["."],
    branch: "main",
    ...overrides,
  };
}

function makeControl(task: ChefRuntimeTask | null) {
  const transitions: string[] = [];
  const evidence: ChefVerificationEvidence[] = [];
  const control: ChefControlPlane = {
    heartbeat: vi.fn(async () => undefined),
    claimNext: vi.fn(async () => task),
    renewLease: vi.fn(async () => true),
    transition: vi.fn(async (input) => { transitions.push(input.target); return true; }),
    addEvidence: vi.fn(async (_task, value) => { evidence.push(value); return true; }),
    recordUsage: vi.fn(async () => true),
    tryFinishMission: vi.fn(async () => true),
  };
  return { control, transitions, evidence };
}

const passingVerifier: ChefVerifier = {
  verify: vi.fn(async (): Promise<ChefVerificationResult> => ({
    ok: true,
    evidence: [{
      kind: "test",
      sha256: "e".repeat(64),
      payload: { profile: "unit", ok: true, exitCode: 0, signal: null, outputBytes: 4 },
    }],
  })),
};

describe("CHEF autonomous worker cycle", () => {
  it("does not claim work after an already requested daemon shutdown", async () => {
    const { control } = makeControl(makeTask());
    const cancel = new AbortController();
    cancel.abort();
    const driver: ChefWorkerDriver = { provider: "codex", run: vi.fn() };
    const result = await runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex", signal: cancel.signal,
    });
    expect(result.state).toBe("idle");
    expect(control.claimNext).not.toHaveBeenCalled();
    expect(driver.run).not.toHaveBeenCalled();
  });

  it("releases a claim obtained during shutdown without starting its worker", async () => {
    const { control, transitions } = makeControl(makeTask());
    const cancel = new AbortController();
    vi.mocked(control.claimNext).mockImplementation(async () => { cancel.abort(); return makeTask(); });
    const driver: ChefWorkerDriver = { provider: "codex", run: vi.fn() };
    const result = await runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex", signal: cancel.signal,
    });
    expect(result.state).toBe("retryable");
    expect(transitions).toEqual(["retryable"]);
    expect(driver.run).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("propagates shutdown to a running real process before releasing the task", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chef-cycle-stop-"));
    tempDirs.push(cwd);
    const ready = join(cwd, "ready");
    const stopped = join(cwd, "stopped");
    const script = `const fs=require('node:fs');
      process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)});
      fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
    const driver = new ProcessChefDriver({
      provider: "codex", command: process.execPath, args: ["-e", script], allowedRoots: [cwd], timeoutMs: 5_000,
    });
    const { control, transitions } = makeControl(makeTask({ cwd, accessMode: "read" }));
    const cancel = new AbortController();
    const pending = runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex", signal: cancel.signal,
    });
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
    cancel.abort();
    const result = await pending;
    expect(result.state).toBe("retryable");
    expect(existsSync(stopped)).toBe(true);
    expect(transitions).toEqual(["running", "retryable"]);
    expect(passingVerifier.verify).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("waits for a timed-out worker to finish before the retryable transition", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chef-cycle-timeout-"));
    tempDirs.push(cwd);
    const lastEffect = join(cwd, "last-effect");
    const script = `process.on('SIGTERM',()=>{});
      setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(lastEffect)},'finished');process.exit(0);},900);`;
    const driver = new ProcessChefDriver({
      provider: "codex", command: process.execPath, args: ["-e", script], allowedRoots: [cwd], timeoutMs: 500,
    });
    const { control } = makeControl(makeTask({ cwd, accessMode: "read" }));
    let effectPresentAtRetry = false;
    vi.mocked(control.transition).mockImplementation(async (input) => {
      if (input.target === "retryable") effectPresentAtRetry = existsSync(lastEffect);
      return true;
    });
    const result = await runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    });
    expect(result).toMatchObject({ state: "retryable", error: "Worker CHEF expiré" });
    expect(effectPresentAtRetry).toBe(true);
    expect(passingVerifier.verify).not.toHaveBeenCalled();
  });

  it.each(["driver", "verifier"] as const)("blocks and halts when %s cannot confirm process termination", async (source) => {
    const { control, transitions } = makeControl(makeTask({ accessMode: "read" }));
    control.quarantineProcess = vi.fn(async () => true);
    const error = new ChefProcessStopUnconfirmedError("arrêt du groupe non confirmé");
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async () => {
        if (source === "driver") throw error;
        return { schemaVersion: 1, status: "completed", summary: "done" } as ChefDriverResponse;
      }),
    };
    const verifier: ChefVerifier = { verify: vi.fn(async () => { throw error; }) };
    const result = await runChefWorkerCycle(control, driver, verifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    });
    expect(result).toMatchObject({ state: "blocked_external", haltWorker: true, error: error.message });
    expect(control.quarantineProcess).toHaveBeenCalledWith("task-1", { workerId: "worker-1", fencingToken: 3, attempt: 1 }, error.message);
    expect(control.transition).toHaveBeenLastCalledWith(expect.objectContaining({ target: "blocked_external", error: error.message }));
    const blockIndex = vi.mocked(control.transition).mock.calls.findIndex(([input]) => input.target === "blocked_external");
    expect(vi.mocked(control.quarantineProcess).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(control.transition).mock.invocationCallOrder[blockIndex]);
    expect(transitions).not.toContain("retryable");
    expect(transitions).not.toContain("verified_done");
    expect(control.tryFinishMission).not.toHaveBeenCalled();
  });

  it("preserves the unsafe-stop error if the durable block cannot be recorded", async () => {
    const { control, transitions } = makeControl(makeTask({ accessMode: "read" }));
    control.quarantineProcess = vi.fn(async () => true);
    vi.mocked(control.transition).mockImplementation(async (input) => {
      transitions.push(input.target);
      if (input.target === "blocked_external") throw new Error("database unavailable");
      return true;
    });
    const driver: ChefWorkerDriver = {
      provider: "codex", run: vi.fn(async () => { throw new ChefProcessStopUnconfirmedError("arrêt non confirmé"); }),
    };
    await expect(runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    })).rejects.toThrow(ChefProcessStopUnconfirmedError);
    expect(transitions).not.toContain("retryable");
    expect(transitions).not.toContain("verified_done");
  });

  it.each(["unavailable", "refused", "offline"] as const)("does not release task exclusion when quarantine persistence is %s", async (failure) => {
    const { control, transitions } = makeControl(makeTask({ accessMode: "read" }));
    if (failure !== "unavailable") {
      control.quarantineProcess = vi.fn(async () => {
        if (failure === "offline") throw new Error("database unavailable");
        return false;
      });
    }
    const driver: ChefWorkerDriver = {
      provider: "codex", run: vi.fn(async () => { throw new ChefProcessStopUnconfirmedError("arrêt non confirmé"); }),
    };
    await expect(runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    })).rejects.toThrow(/quarantaine durable/);
    expect(transitions).toEqual(["running"]);
    expect(control.tryFinishMission).not.toHaveBeenCalled();
  });

  it("stamps every proof with the original claim rather than a refreshed generation", async () => {
    const { control } = makeControl(makeTask());
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "completed", summary: "done", outputSha: sha })),
    };
    await runChefWorkerCycle(control, driver, passingVerifier, { missionId: "mission-1", workerId: "worker-1", provider: "codex" });
    expect(control.addEvidence).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(control.addEvidence).mock.calls) {
      expect(call).toEqual(["task-1", expect.any(Object), { workerId: "worker-1", attempt: 1, fencingToken: 3 }]);
    }
  });

  it.each([1, 2])("stops when proof write %i loses the lease", async (rejectedCall) => {
    const { control, transitions } = makeControl(makeTask());
    vi.mocked(control.addEvidence).mockResolvedValueOnce(rejectedCall !== 1).mockResolvedValueOnce(false);
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "completed", summary: "done", outputSha: sha })),
    };
    const result = await runChefWorkerCycle(control, driver, passingVerifier, { missionId: "mission-1", workerId: "worker-1", provider: "codex" });
    expect(result.state).toBe("lost_lease");
    expect(control.addEvidence).toHaveBeenCalledTimes(rejectedCall);
    expect(transitions).not.toContain("verified_done");
    expect(control.tryFinishMission).not.toHaveBeenCalled();
  });

  it("refuses to persist passing proofs if the final Git check detects a changed tree", async () => {
    const { control, transitions, evidence } = makeControl(makeTask());
    vi.mocked(verifyCommittedGitState).mockResolvedValueOnce({
      kind: "receipt", sha256: "9".repeat(64), payload: { profile: "git-state", ok: true, headSha: sha },
    }).mockRejectedValueOnce(new Error("HEAD réel différent après vérification"));
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "completed", summary: "done", outputSha: sha })),
    };
    const result = await runChefWorkerCycle(control, driver, passingVerifier, { missionId: "mission-1", workerId: "worker-1", provider: "codex" });
    expect(result.state).toBe("retryable");
    expect(transitions).not.toContain("verified_done");
    expect(evidence).toHaveLength(0);
  });

  it("surfaces an evidence storage outage without declaring completion", async () => {
    const { control, transitions } = makeControl(makeTask());
    vi.mocked(control.addEvidence).mockRejectedValueOnce(new Error("evidence database offline"));
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "completed", summary: "done", outputSha: sha })),
    };
    await expect(runChefWorkerCycle(control, driver, passingVerifier, { missionId: "mission-1", workerId: "worker-1", provider: "codex" }))
      .rejects.toThrow(/database offline/);
    expect(transitions).not.toContain("verified_done");
    expect(control.addEvidence).toHaveBeenCalledOnce();
    expect(control.tryFinishMission).not.toHaveBeenCalled();
  });

  it("does not trust worker done text: it verifies before VERIFIED_DONE", async () => {
    const task = makeTask();
    const { control, transitions, evidence } = makeControl(task);
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({
        schemaVersion: 1,
        status: "completed",
        summary: "done",
        outputSha: sha,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, costMicros: 500, model: "test" },
      })),
    };

    const result = await runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex", renewEveryMs: 60_000,
    });

    expect(result).toMatchObject({ state: "verified_done", taskId: "task-1" });
    expect(transitions).toEqual(["running", "verifying", "verified_done"]);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((entry) => entry.kind)).toEqual(["receipt", "test"]);
    expect(control.recordUsage).toHaveBeenCalledOnce();
    expect(control.tryFinishMission).toHaveBeenCalledWith("mission-1");
  });

  it("refuses a write task that reports completion without a commit/output SHA", async () => {
    const task = makeTask();
    const { control, transitions } = makeControl(task);
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "completed", summary: "done" })),
    };
    const result = await runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    });
    expect(result.state).toBe("retryable");
    expect(transitions).toEqual(["running", "retryable"]);
  });

  it("never runs verification when human approval is required", async () => {
    const task = makeTask();
    const { control, transitions } = makeControl(task);
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "blocked_human", summary: "secret required" })),
    };
    const verifier: ChefVerifier = { verify: vi.fn() };
    const result = await runChefWorkerCycle(control, driver, verifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    });
    expect(result.state).toBe("blocked_human");
    expect(transitions).toEqual(["running", "blocked_human"]);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("returns idle without launching a provider when no task is ready", async () => {
    const { control } = makeControl(null);
    const driver: ChefWorkerDriver = { provider: "codex", run: vi.fn() };
    const result = await runChefWorkerCycle(control, driver, passingVerifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    });
    expect(result.state).toBe("idle");
    expect(driver.run).not.toHaveBeenCalled();
  });

  it("routes failed verification back to retryable instead of false PASS", async () => {
    const task = makeTask();
    const { control, transitions } = makeControl(task);
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({ schemaVersion: 1, status: "completed", summary: "done", outputSha: sha })),
    };
    const verifier: ChefVerifier = {
      verify: vi.fn(async (): Promise<ChefVerificationResult> => ({
        ok: false,
        error: "tests red",
        evidence: [{
          kind: "test",
          sha256: "f".repeat(64),
          payload: { profile: "unit", ok: false, exitCode: 1, signal: null, outputBytes: 6 },
        }],
      })),
    };
    const result = await runChefWorkerCycle(control, driver, verifier, {
      missionId: "mission-1", workerId: "worker-1", provider: "codex",
    });
    expect(result.state).toBe("retryable");
    expect(transitions).toEqual(["running", "verifying", "retryable"]);
  });
});
