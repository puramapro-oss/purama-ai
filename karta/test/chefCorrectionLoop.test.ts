import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  runChefWorkerCycle,
  type ChefControlPlane,
  type ChefEvidenceClaim,
  type ChefRuntimeTask,
} from "../src/chef/supervisor.js";
import type { ChefWorkerDriver } from "../src/chef/driver.js";
import { CommandChefVerifier, type ChefVerificationEvidence } from "../src/chef/verifier.js";
import type { ChefVerificationFeedback } from "../src/chef/verification-feedback.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(cwd => rm(cwd, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args,
  ], { cwd, timeout: 10_000 });
  return stdout.trim();
}

async function commitResult(cwd: string, content: string): Promise<string> {
  await writeFile(join(cwd, "result.txt"), content);
  await git(cwd, "add", "--", "result.txt");
  await git(cwd, "commit", "-m", `result: ${content.trim()}`);
  return git(cwd, "rev-parse", "HEAD");
}

interface SavedEvidence {
  taskId: string;
  evidence: ChefVerificationEvidence;
  claim: ChefEvidenceClaim;
}

async function fixture(correction: "fix" | "unchanged" = "fix") {
  const cwd = await mkdtemp(join(tmpdir(), "chef-correction-loop-"));
  directories.push(cwd);
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "chef-correction@test.invalid");
  await git(cwd, "config", "user.name", "CHEF correction fixture");
  await writeFile(join(cwd, "result.txt"), "initial\n");
  await writeFile(join(cwd, "sentinel.txt"), "pre-existing work\n");
  await git(cwd, "add", "--", "result.txt", "sentinel.txt");
  await git(cwd, "commit", "-m", "baseline");
  const initialSha = await git(cwd, "rev-parse", "HEAD");
  const task: ChefRuntimeTask = {
    id: "correction-task", missionId: "correction-mission", briefHash: "a".repeat(64),
    instructions: "Make result.txt contain good while preserving the existing sentinel.txt.",
    cwd, accessMode: "write", fencingToken: 10, attempt: 1, branch: "main",
    baseSha: initialSha, verificationProfiles: ["acceptance"], allowedPaths: ["result.txt"],
  };
  let nextClaim = { ...task };
  const saved: SavedEvidence[] = [];
  const loadVerificationFeedback = vi.fn(async (current: ChefRuntimeTask): Promise<ChefVerificationFeedback | null> => {
    // Exercise the actual feedback emitted by the worker; do not recreate its
    // scope digest, failure projection or generation-binding algorithm here.
    const last = saved.filter(entry => entry.taskId === current.id &&
      entry.evidence.payload.profile === "verification-feedback").at(-1);
    return (last?.evidence.payload.feedback as ChefVerificationFeedback | undefined) ?? null;
  });
  const control: ChefControlPlane = {
    heartbeat: vi.fn(async () => undefined),
    claimNext: vi.fn(async () => ({
      ...nextClaim, allowedPaths: [...nextClaim.allowedPaths],
      verificationProfiles: [...nextClaim.verificationProfiles],
    })),
    renewLease: vi.fn(async () => true),
    transition: vi.fn(async () => true),
    addEvidence: vi.fn<ChefControlPlane["addEvidence"]>(async (taskId, evidence, claim) => {
      saved.push(structuredClone({ taskId, evidence, claim }));
      return true;
    }),
    recordUsage: vi.fn(async () => true),
    quarantineProcess: vi.fn(async () => true),
    tryFinishMission: vi.fn(async () => true),
    // The spread also permits running the behavioral regression before the
    // optional control-plane method has been added to the production interface.
    ...{ loadVerificationFeedback },
  };
  const driver: ChefWorkerDriver = {
    provider: "codex",
    run: vi.fn<ChefWorkerDriver["run"]>(async request => {
      const outputSha = request.attempt === 1
        ? await commitResult(cwd, "bad\n")
        : correction === "fix"
          ? await commitResult(cwd, "good\n")
          : await git(cwd, "rev-parse", "HEAD");
      return {
        schemaVersion: 1, status: "completed", summary: "Fixture worker finished its attempt", outputSha,
        usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      };
    }),
  };
  const verifier = new CommandChefVerifier([{
    name: "acceptance", kind: "test", command: process.execPath, timeoutMs: 10_000,
    args: ["-e", "const fs=require('node:fs');const value=fs.readFileSync('result.txt','utf8');" +
      "if(value!=='good\\n'){console.error('result.txt did not satisfy the content criterion');process.exitCode=7;}"],
  }], [cwd]);
  const verify = vi.spyOn(verifier, "verify");
  const run = () => runChefWorkerCycle(control, driver, verifier, {
    missionId: task.missionId, workerId: "correction-worker", provider: "codex",
  });
  const advance = () => {
    nextClaim = { ...task, attempt: nextClaim.attempt + 1, fencingToken: nextClaim.fencingToken + 1 };
  };
  const feedbackEntries = () => saved.filter(entry => entry.evidence.payload.profile === "verification-feedback");
  return { cwd, initialSha, task, control, driver, verify, run, advance, saved, feedbackEntries, loadVerificationFeedback };
}

describe("CHEF durable correction loop with a real repository and verifier command", () => {
  it("feeds the observed failed criterion into the next attempt and verifies the corrected commit", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ state: "retryable", taskId: f.task.id });
    const failedSha = await git(f.cwd, "rev-parse", "HEAD");
    expect(failedSha).not.toBe(f.initialSha);
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("bad\n");
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
    expect(f.feedbackEntries()).toHaveLength(1);
    const firstFailure = structuredClone(f.feedbackEntries()[0]);
    expect(firstFailure).toMatchObject({
      taskId: f.task.id,
      claim: { workerId: "correction-worker", attempt: 1, fencingToken: 10 },
      evidence: {
        kind: "other", sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        payload: {
          profile: "verification-feedback", ok: false,
          feedback: {
            schemaVersion: 1, taskId: f.task.id, missionId: f.task.missionId,
            briefHash: f.task.briefHash, attempt: 1, fencingToken: 10, outputSha: failedSha,
            scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            failedProfiles: [{ profile: "acceptance", kind: "test", exitCode: 7 }],
          },
        },
      },
    });

    f.advance();
    expect(await f.run()).toEqual({ state: "verified_done", taskId: f.task.id });
    const finalSha = await git(f.cwd, "rev-parse", "HEAD");
    expect(finalSha).not.toBe(failedSha);
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("good\n");
    expect(await readFile(join(f.cwd, "sentinel.txt"), "utf8")).toBe("pre-existing work\n");
    expect(await git(f.cwd, "diff", "--name-only", f.initialSha, finalSha)).toBe("result.txt");
    expect(await git(f.cwd, "status", "--porcelain=v1")).toBe("");
    expect(f.task.baseSha).toBe(f.initialSha);
    expect(f.loadVerificationFeedback).toHaveBeenCalledWith(expect.objectContaining({
      id: f.task.id, baseSha: f.initialSha, attempt: 2, fencingToken: 11,
    }));
    expect(f.driver.run).toHaveBeenCalledTimes(2);
    const correction = vi.mocked(f.driver.run).mock.calls[1][0];
    expect(correction).toMatchObject({
      taskId: f.task.id, briefHash: f.task.briefHash, attempt: 2, fencingToken: 11,
      baseSha: failedSha, allowedPaths: ["result.txt"], accessMode: "write",
    });
    expect(correction.instructions).toContain(f.task.instructions);
    expect(correction.instructions).toContain("acceptance");
    expect(correction.instructions).toContain(failedSha);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.saved).toContainEqual(expect.objectContaining({
      claim: { workerId: "correction-worker", attempt: 2, fencingToken: 11 },
      evidence: expect.objectContaining({ kind: "test", payload: expect.objectContaining({ profile: "acceptance", ok: true, exitCode: 0 }) }),
    }));
    expect(f.feedbackEntries()[0]).toEqual(firstFailure);
    expect(f.control.transition).toHaveBeenLastCalledWith(expect.objectContaining({ target: "verified_done", outputSha: finalSha }));
    expect(f.control.tryFinishMission).toHaveBeenCalledExactlyOnceWith(f.task.missionId);
  });

  it("blocks a foreign commit between attempts before starting the correction driver", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ state: "retryable" });
    expect(f.feedbackEntries()).toHaveLength(1);
    await writeFile(join(f.cwd, "sentinel.txt"), "another worker's committed work\n");
    await git(f.cwd, "add", "--", "sentinel.txt");
    await git(f.cwd, "commit", "-m", "concurrent independent work");
    const foreignSha = await git(f.cwd, "rev-parse", "HEAD");

    f.advance();
    expect(await f.run()).toMatchObject({ state: "blocked_external", taskId: f.task.id });
    expect(f.driver.run).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
    expect(f.control.recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      attempt: 2, fencingToken: 11, inputTokens: 0, outputTokens: 0, costMicros: 0,
    }));
    expect(await git(f.cwd, "rev-parse", "HEAD")).toBe(foreignSha);
    expect(await readFile(join(f.cwd, "sentinel.txt"), "utf8")).toBe("another worker's committed work\n");
    expect(f.task.baseSha).toBe(f.initialSha);
  });

  it("stops after an unchanged output fails the same observed criterion again", async () => {
    const f = await fixture("unchanged");
    expect(await f.run()).toMatchObject({ state: "retryable" });
    expect(f.feedbackEntries()).toHaveLength(1);
    const failedSha = await git(f.cwd, "rev-parse", "HEAD");

    f.advance();
    expect(await f.run()).toMatchObject({ state: "blocked_human", taskId: f.task.id });
    expect(f.driver.run).toHaveBeenCalledTimes(2);
    expect(f.verify).toHaveBeenCalledTimes(2);
    expect(f.control.transition).toHaveBeenLastCalledWith(expect.objectContaining({ target: "blocked_human" }));
    expect(vi.mocked(f.control.transition).mock.calls.filter(([change]) => change.target === "retryable")).toHaveLength(1);
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
    expect(await git(f.cwd, "rev-parse", "HEAD")).toBe(failedSha);
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("bad\n");
  });

  it("requires explicit recovery after a cancelled generation leaves no current correction checkpoint", async () => {
    const f = await fixture();
    expect(await f.run()).toMatchObject({ state: "retryable" });
    const failedSha = await git(f.cwd, "rev-parse", "HEAD");
    const firstFeedback = structuredClone(f.feedbackEntries()[0]);
    expect(firstFeedback.claim).toMatchObject({ attempt: 1, fencingToken: 10 });

    f.advance();
    const abort = new AbortController();
    const claim = vi.mocked(f.control.claimNext).getMockImplementation();
    if (!claim) throw new Error("Claim fixture implementation missing");
    vi.mocked(f.control.claimNext).mockImplementationOnce(async input => {
      const claimed = await claim(input);
      abort.abort();
      return claimed;
    });
    const cancelledVerifier = {
      verify: vi.fn(async () => { throw new Error("A cycle cancelled before its driver must not verify"); }),
    };
    expect(await runChefWorkerCycle(f.control, f.driver, cancelledVerifier, {
      missionId: f.task.missionId, workerId: "correction-worker", provider: "codex", signal: abort.signal,
    })).toMatchObject({ state: "retryable", taskId: f.task.id });
    expect(f.driver.run).toHaveBeenCalledTimes(1);
    expect(cancelledVerifier.verify).not.toHaveBeenCalled();
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 2, fencingToken: 11, inputTokens: 0, outputTokens: 0, costMicros: 0,
    }));
    expect(f.feedbackEntries()).toEqual([firstFeedback]);
    expect(f.saved.some(entry => entry.claim.attempt === 2)).toBe(false);
    expect(await git(f.cwd, "rev-parse", "HEAD")).toBe(failedSha);

    f.advance();
    // The persistent adapter queries only the immediately previous generation.
    // Attempt 2 produced no checkpoint; attempt 1 must not become a substitute.
    f.loadVerificationFeedback.mockResolvedValueOnce(null);
    expect(await f.run()).toMatchObject({ state: "blocked_external", taskId: f.task.id });
    expect(f.loadVerificationFeedback).toHaveBeenLastCalledWith(expect.objectContaining({
      attempt: 3, fencingToken: 12, baseSha: f.initialSha,
    }));
    expect(f.driver.run).toHaveBeenCalledTimes(1);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
    expect(f.feedbackEntries()).toEqual([firstFeedback]);
    expect(f.control.recordUsage).toHaveBeenLastCalledWith(expect.objectContaining({
      attempt: 3, fencingToken: 12, inputTokens: 0, outputTokens: 0, costMicros: 0,
    }));
    expect(await git(f.cwd, "rev-parse", "HEAD")).toBe(failedSha);
    expect(await git(f.cwd, "status", "--porcelain=v1")).toBe("");
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("bad\n");
    expect(await readFile(join(f.cwd, "sentinel.txt"), "utf8")).toBe("pre-existing work\n");
  });
});
