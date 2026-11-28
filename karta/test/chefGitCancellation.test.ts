import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChefDriverRequest, ChefDriverResponse, ChefWorkerDriver } from "../src/chef/driver.js";
import { captureCleanGitBaseline, verifyCommittedGitState } from "../src/chef/git-state.js";
import { runChefWorkerCycle } from "../src/chef/supervisor.js";
import type { ChefControlPlane, ChefRuntimeTask } from "../src/chef/supervisor.js";
import type { ChefVerificationEvidence, ChefVerificationResult, ChefVerifier } from "../src/chef/verifier.js";

vi.mock("../src/chef/git-state.js", () => ({
  captureCleanGitBaseline: vi.fn(),
  verifyCommittedGitState: vi.fn(),
}));

const baseSha = "a".repeat(40);
const outputSha = "d".repeat(40);

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((complete, fail) => {
    resolve = () => complete();
    reject = fail;
  });
  return { promise, resolve, reject };
}

type Boundary = "first_git" | "final_git" | "verifying_transition" | "verifying_heartbeat";

function fixture(boundary: Boundary) {
  const entered = deferred();
  const release = deferred();
  let waitingAtBoundary = false;
  let verifyingHeartbeatPaused = false;
  let gitChecks = 0;
  let renewalHeartbeatFailures = 0;
  let workerSignal: AbortSignal | undefined;
  const transitionsAfterAbort: string[] = [];
  const heartbeatsAfterAbort: string[] = [];
  const task: ChefRuntimeTask = {
    id: "task-git-cancellation",
    missionId: "mission-git-cancellation",
    briefHash: "c".repeat(64),
    instructions: "Verify the assigned committed work",
    cwd: process.cwd(),
    accessMode: "write",
    fencingToken: 3,
    attempt: 1,
    branch: "main",
    baseSha,
    verificationProfiles: ["unit"],
    allowedPaths: ["."],
  };
  const gitEvidence: ChefVerificationEvidence = {
    kind: "receipt",
    sha256: "9".repeat(64),
    payload: { profile: "git-state", ok: true, headSha: outputSha, clean: true },
  };

  const pause = async () => {
    waitingAtBoundary = true;
    entered.resolve();
    try {
      await release.promise;
    } finally {
      waitingAtBoundary = false;
    }
  };

  vi.mocked(verifyCommittedGitState).mockImplementation(async () => {
    gitChecks += 1;
    if ((boundary === "first_git" && gitChecks === 1)
      || (boundary === "final_git" && gitChecks === 2)) {
      await pause();
    }
    return gitEvidence;
  });

  const control: ChefControlPlane = {
    heartbeat: vi.fn(async (input) => {
      if (workerSignal?.aborted) heartbeatsAfterAbort.push(input.state);
      if (waitingAtBoundary) {
        // A renewal heartbeat fails while the selected operation is awaiting
        // its response. Initial heartbeats and later replies remain valid.
        renewalHeartbeatFailures += 1;
        throw new Error("Transient renewal heartbeat failure");
      }
      if (boundary === "verifying_heartbeat" && input.state === "verifying" && !verifyingHeartbeatPaused) {
        verifyingHeartbeatPaused = true;
        await pause();
      }
    }),
    claimNext: vi.fn(async () => task),
    // A successful renewal followed by a transport error on the heartbeat can
    // cancel the local cycle while its remote fencing token is still valid.
    renewLease: vi.fn(async () => true),
    transition: vi.fn(async (input) => {
      if (workerSignal?.aborted) transitionsAfterAbort.push(input.target);
      if (boundary === "verifying_transition" && input.target === "verifying") await pause();
      return true;
    }),
    addEvidence: vi.fn(async () => true),
    recordUsage: vi.fn(async () => true),
    tryFinishMission: vi.fn(async () => true),
  };
  const driver: ChefWorkerDriver = {
    provider: "codex",
    run: vi.fn(async (_request: ChefDriverRequest, signal?: AbortSignal): Promise<ChefDriverResponse> => {
      workerSignal = signal;
      return {
        schemaVersion: 1,
        status: "completed",
        summary: "Work committed",
        outputSha,
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costMicros: 1 },
      };
    }),
  };
  const verifier: ChefVerifier = {
    // The mock records dispatch independently of a concrete verifier's own
    // abort protection: a known cancelled supervisor must not dispatch it.
    verify: vi.fn(async (): Promise<ChefVerificationResult> => ({
      ok: true,
      evidence: [{
        kind: "test",
        sha256: "e".repeat(64),
        payload: { profile: "unit", ok: true, exitCode: 0 },
      }],
    })),
  };

  return {
    entered,
    release,
    control,
    verifier,
    transitionsAfterAbort,
    heartbeatsAfterAbort,
    get signal() { return workerSignal; },
    get renewalHeartbeatFailures() { return renewalHeartbeatFailures; },
    run: () => runChefWorkerCycle(control, driver, verifier, {
      missionId: task.missionId,
      workerId: "worker-git-cancellation",
      provider: "codex",
      leaseSeconds: 30,
      renewEveryMs: 1_000,
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(captureCleanGitBaseline).mockReset().mockResolvedValue({ headSha: baseSha, branch: "main" });
  vi.mocked(verifyCommittedGitState).mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("CHEF cancellation at Git and verification-entry boundaries", () => {
  const cases: Array<{ name: string; boundary: Boundary; rejectReply: boolean; verifierCalls: number }> = [
    { name: "first Git check rejects after cancellation", boundary: "first_git", rejectReply: true, verifierCalls: 0 },
    { name: "first Git check succeeds after cancellation", boundary: "first_git", rejectReply: false, verifierCalls: 0 },
    { name: "final Git check rejects after cancellation", boundary: "final_git", rejectReply: true, verifierCalls: 1 },
    { name: "verifying transition acknowledges after cancellation", boundary: "verifying_transition", rejectReply: false, verifierCalls: 0 },
    { name: "verifying heartbeat acknowledges after cancellation", boundary: "verifying_heartbeat", rejectReply: false, verifierCalls: 0 },
  ];

  it.each(cases)("$name", async ({ boundary, rejectReply, verifierCalls }) => {
    const f = fixture(boundary);
    const running = f.run();
    await f.entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const abortedBeforeReply = f.signal?.aborted;

    // The already submitted operation can settle after the local cancellation.
    // Its late reply must not authorize any further supervisor action.
    if (rejectReply) f.release.reject(new Error("Git response failed after cancellation"));
    else f.release.resolve();
    const result = await running;

    expect(f.control.renewLease).toHaveBeenCalledOnce();
    expect(f.renewalHeartbeatFailures).toBe(1);
    expect(abortedBeforeReply).toBe(true);
    expect(f.control.recordUsage).toHaveBeenCalledOnce();
    expect.soft(result.state).toBe("lost_lease");
    expect.soft(f.transitionsAfterAbort).toEqual([]);
    expect.soft(f.heartbeatsAfterAbort).toEqual([]);
    expect.soft(f.verifier.verify).toHaveBeenCalledTimes(verifierCalls);
    expect.soft(f.control.addEvidence).not.toHaveBeenCalled();
    expect.soft(f.control.tryFinishMission).not.toHaveBeenCalled();
  });
});
