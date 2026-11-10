import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runChefWorkerCycle, type ChefControlPlane, type ChefRuntimeTask } from "../src/chef/supervisor.js";
import type { ChefWorkerDriver } from "../src/chef/driver.js";
import type { ChefVerifier } from "../src/chef/verifier.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

describe("CHEF Git checks around actual verification", () => {
  it.each(["unchanged", "dirty", "new-commit"] as const)("handles a %s worktree after the verifier", async (change) => {
    const cwd = await mkdtemp(join(tmpdir(), "chef-verification-"));
    dirs.push(cwd);
    await exec("git", ["init", "-b", "main"], { cwd });
    await exec("git", ["config", "user.email", "chef@test.invalid"], { cwd });
    await exec("git", ["config", "user.name", "CHEF Integration Test"], { cwd });
    await writeFile(join(cwd, "result.txt"), "one\n");
    await exec("git", ["add", "result.txt"], { cwd });
    await exec("git", ["commit", "-m", "initial"], { cwd });
    const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
    const task: ChefRuntimeTask = {
      id: "task", missionId: "mission", briefHash: "a".repeat(64), instructions: "check",
      cwd, accessMode: "write", fencingToken: 2, attempt: 1, branch: "main", baseSha: sha,
      verificationProfiles: ["acceptance"], allowedPaths: ["result.txt"],
    };
    const control: ChefControlPlane = {
      heartbeat: vi.fn(async () => undefined), claimNext: vi.fn(async () => task),
      renewLease: vi.fn(async () => true), transition: vi.fn(async () => true),
      addEvidence: vi.fn(async () => true), recordUsage: vi.fn(async () => true),
      tryFinishMission: vi.fn(async () => true),
    };
    const driver: ChefWorkerDriver = {
      provider: "codex", run: async () => ({ schemaVersion: 1, status: "completed", summary: "done", outputSha: sha }),
    };
    const verifier: ChefVerifier = { verify: async () => {
      if (change !== "unchanged") await writeFile(join(cwd, "result.txt"), "changed during verification\n");
      if (change === "new-commit") {
        await exec("git", ["add", "result.txt"], { cwd });
        await exec("git", ["commit", "-m", "changed by verifier"], { cwd });
      }
      return { ok: true, evidence: [{ kind: "test", sha256: "b".repeat(64), payload: { profile: "acceptance", ok: true } }] };
    } };
    const result = await runChefWorkerCycle(control, driver, verifier, { missionId: "mission", workerId: "worker", provider: "codex" });
    if (change === "unchanged") {
      expect(result.state).toBe("verified_done");
      expect(control.addEvidence).toHaveBeenCalledTimes(2);
      expect(vi.mocked(control.addEvidence).mock.calls[0][1].payload).toMatchObject({ headSha: sha, clean: true });
    } else {
      expect(result.state).toBe("retryable");
      expect(control.addEvidence).not.toHaveBeenCalled();
      expect(control.tryFinishMission).not.toHaveBeenCalled();
    }
  });
});
