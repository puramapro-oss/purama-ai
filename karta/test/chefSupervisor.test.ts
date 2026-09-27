import { describe, expect, it, vi } from "vitest";
import type { ChefDriverResponse, ChefWorkerDriver } from "../src/chef/driver.js";
import type { ChefControlPlane, ChefRuntimeTask } from "../src/chef/supervisor.js";
import { runChefWorkerCycle } from "../src/chef/supervisor.js";
import type { ChefVerificationResult, ChefVerifier } from "../src/chef/verifier.js";

const hash = "c".repeat(64);
const sha = "d".repeat(40);

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
    ...overrides,
  };
}

function makeControl(task: ChefRuntimeTask | null) {
  const transitions: string[] = [];
  const evidence: unknown[] = [];
  const control: ChefControlPlane = {
    heartbeat: vi.fn(async () => undefined),
    claimNext: vi.fn(async () => task),
    renewLease: vi.fn(async () => true),
    transition: vi.fn(async (input) => { transitions.push(input.target); return true; }),
    addEvidence: vi.fn(async (_task, value) => { evidence.push(value); }),
    recordUsage: vi.fn(async () => undefined),
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
    expect(evidence).toHaveLength(1);
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
