import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChefDriverResponse, ChefWorkerDriver } from "../src/chef/driver.js";
import { runChefWorkerCycle } from "../src/chef/supervisor.js";
import type { ChefControlPlane, ChefRuntimeTask } from "../src/chef/supervisor.js";
import type { ChefVerificationResult, ChefVerifier } from "../src/chef/verifier.js";

// These cases isolate accounting/cancellation; real Git mutations are exercised in
// chefVerificationGitIntegration.test.ts with private temporary repositories.
vi.mock("../src/chef/git-state.js", () => ({
  captureCleanGitBaseline: vi.fn(async () => ({ headSha: "a".repeat(40) })),
  verifyCommittedGitState: vi.fn(async () => ({
    kind: "receipt", sha256: "9".repeat(64),
    payload: { profile: "git-state", ok: true, headSha: "a".repeat(40), clean: true },
  })),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("CHEF cancellation while persisting the last proof", () => {
  it("does not finalize after heartbeat failure aborts an awaiting proof write", async () => {
    vi.useFakeTimers();
    const proofStarted = deferred<void>();
    const proofResponse = deferred<boolean>();
    let proofPending = false;
    let observedSignal: AbortSignal | undefined;
    const transitions: string[] = [];
    const task: ChefRuntimeTask = {
      id: "task-cancel-last-proof",
      missionId: "mission-cancel-last-proof",
      briefHash: "c".repeat(64),
      instructions: "Read-only deterministic check",
      cwd: process.cwd(),
      accessMode: "read",
      fencingToken: 3,
      attempt: 1,
      verificationProfiles: ["unit"],
      allowedPaths: ["."],
    };
    const control: ChefControlPlane = {
      heartbeat: vi.fn(async () => {
        // Initial heartbeats succeed. Only the renewal heartbeat occurs while
        // addEvidence is awaiting its reply, and fails transiently.
        if (proofPending) throw new Error("Transient renewal heartbeat failure");
      }),
      claimNext: vi.fn(async () => task),
      // The remote claim remains valid: the local heartbeat failure, not a
      // revoked fencing token, is what aborts this cycle.
      renewLease: vi.fn(async () => true),
      transition: vi.fn(async (input) => {
        transitions.push(input.target);
        return true;
      }),
      addEvidence: vi.fn(async () => {
        proofPending = true;
        proofStarted.resolve(undefined);
        const accepted = await proofResponse.promise;
        proofPending = false;
        return accepted;
      }),
      recordUsage: vi.fn(async () => true),
      tryFinishMission: vi.fn(async () => true),
    };
    const driver: ChefWorkerDriver = {
      provider: "codex",
      run: vi.fn(async (): Promise<ChefDriverResponse> => ({
        schemaVersion: 1,
        status: "completed",
        summary: "Read-only work complete",
      })),
    };
    const verifier: ChefVerifier = {
      verify: vi.fn(async (_cwd, _profiles, signal): Promise<ChefVerificationResult> => {
        observedSignal = signal;
        return {
          ok: true,
          evidence: [{
            kind: "test",
            sha256: "e".repeat(64),
            payload: { profile: "unit", ok: true, exitCode: 0 },
          }],
        };
      }),
    };

    const cycle = runChefWorkerCycle(control, driver, verifier, {
      missionId: task.missionId,
      workerId: "worker-cancel-last-proof",
      provider: "codex",
      leaseSeconds: 30,
      renewEveryMs: 1_000,
    });
    await proofStarted.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const abortedBeforeProofResponse = observedSignal?.aborted;

    // The pending write can legitimately confirm success after cancellation.
    // That confirmation must not authorize a subsequent final transition.
    proofResponse.resolve(true);
    const result = await cycle;

    expect(control.renewLease).toHaveBeenCalledOnce();
    expect(abortedBeforeProofResponse).toBe(true);
    expect(control.addEvidence).toHaveBeenCalledOnce();
    expect.soft(result.state).toBe("lost_lease");
    expect.soft(transitions).not.toContain("verified_done");
    expect.soft(control.tryFinishMission).not.toHaveBeenCalled();
  });
});
