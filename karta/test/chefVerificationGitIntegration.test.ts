import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function fixture(accessMode: "read" | "write") {
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
    cwd, accessMode, fencingToken: 2, attempt: 1, branch: "main", baseSha: sha,
    verificationProfiles: ["acceptance"], allowedPaths: accessMode === "write" ? ["result.txt"] : [],
  };
  const control: ChefControlPlane = {
    heartbeat: vi.fn(async () => undefined), claimNext: vi.fn(async () => task),
    renewLease: vi.fn(async () => true), transition: vi.fn(async () => true),
    addEvidence: vi.fn(async () => true), recordUsage: vi.fn(async () => true),
    quarantineProcess: vi.fn(async () => true), tryFinishMission: vi.fn(async () => true),
  };
  const driver: ChefWorkerDriver = {
    provider: "codex", run: vi.fn<ChefWorkerDriver["run"]>(async () => ({
      schemaVersion: 1, status: "completed", summary: "done",
      // A read driver need not supply a SHA: the supervisor captures it independently.
      ...(accessMode === "write" ? { outputSha: sha } : {}),
    })),
  };
  const verifier: ChefVerifier = { verify: vi.fn<ChefVerifier["verify"]>(async () => ({
    ok: true, evidence: [{ kind: "test", sha256: "b".repeat(64), payload: { profile: "acceptance", ok: true } }],
  })) };
  const run = () => runChefWorkerCycle(control, driver, verifier, { missionId: "mission", workerId: "worker", provider: "codex" });
  return { cwd, sha, task, control, driver, verifier, run };
}

async function changeTree(cwd: string, change: string) {
  if (change === "dirty" || change === "new-commit") await writeFile(join(cwd, "result.txt"), "changed during verification\n");
  if (change === "untracked") await writeFile(join(cwd, "extra.txt"), "untracked\n");
  if (change === "new-commit") {
    await exec("git", ["add", "result.txt"], { cwd });
    await exec("git", ["commit", "-m", "changed by verifier"], { cwd });
  }
  if (change === "new-branch") await exec("git", ["switch", "-c", "unexpected-branch"], { cwd });
}

describe.each(["read", "write"] as const)("CHEF Git checks around actual %s verification", (accessMode) => {
  it.each(["unchanged", "dirty", "new-commit", "untracked", "new-branch"] as const)("handles a %s worktree after the verifier", async (change) => {
    const f = await fixture(accessMode);
    vi.mocked(f.verifier.verify).mockImplementation(async () => {
      await changeTree(f.cwd, change);
      return { ok: true, evidence: [{ kind: "test", sha256: "b".repeat(64), payload: { profile: "acceptance", ok: true } }] };
    });
    const result = await f.run();
    if (change === "unchanged") {
      expect(result.state).toBe("verified_done");
      expect(f.control.addEvidence).toHaveBeenCalledTimes(2);
      expect(vi.mocked(f.control.addEvidence).mock.calls[0][1].payload).toMatchObject({ headSha: f.sha, clean: true });
      expect(f.control.transition).toHaveBeenLastCalledWith(expect.objectContaining({ target: "verified_done", outputSha: f.sha }));
    } else {
      expect(result.state).toBe(accessMode === "read" ? "blocked_external" : "retryable");
      expect(f.control.addEvidence).not.toHaveBeenCalled();
      expect(f.control.tryFinishMission).not.toHaveBeenCalled();
      expect(vi.mocked(f.control.transition).mock.calls.some(([input]) => input.target === "verified_done")).toBe(false);
      // The failed verifier's evidence is retained on disk, never reverted automatically.
      if (change === "dirty" || change === "new-commit") expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toContain("changed during verification");
      if (change === "untracked") expect(await readFile(join(f.cwd, "extra.txt"), "utf8")).toBe("untracked\n");
    }
    // All mock verifier promises have settled; mutation alone is not an uncertain process.
    expect(f.control.quarantineProcess).not.toHaveBeenCalled();
  });
});

describe("CHEF independent read revision", () => {
  it.each(["dirty", "new-commit"] as const)("refuses a read driver that leaves a %s tree before verification", async (change) => {
    const f = await fixture("read");
    vi.mocked(f.driver.run).mockImplementation(async () => {
      await changeTree(f.cwd, change);
      return { schemaVersion: 1, status: "completed", summary: "claims success" };
    });
    expect(await f.run()).toMatchObject({ state: "blocked_external" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.control.addEvidence).not.toHaveBeenCalled();
    expect(f.control.tryFinishMission).not.toHaveBeenCalled();
  });

  it("blocks a foreign initial WIP before starting the read driver and records known zero usage", async () => {
    const f = await fixture("read");
    await writeFile(join(f.cwd, "result.txt"), "foreign WIP\n");
    expect(await f.run()).toMatchObject({ state: "blocked_human", error: "Worktree contient déjà du WIP non attribué" });
    expect(f.driver.run).not.toHaveBeenCalled();
    expect(f.control.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 0, outputTokens: 0, costMicros: 0 }));
    expect(await readFile(join(f.cwd, "result.txt"), "utf8")).toBe("foreign WIP\n");
  });

  it("does not trust a read driver's different SHA even when the repository remains clean", async () => {
    const f = await fixture("read");
    vi.mocked(f.driver.run).mockResolvedValue({ schemaVersion: 1, status: "completed", summary: "done", outputSha: "f".repeat(40) });
    expect(await f.run()).toMatchObject({ state: "blocked_external", error: "Révision déclarée différente de la base de lecture" });
    expect(f.verifier.verify).not.toHaveBeenCalled();
    expect(f.control.addEvidence).not.toHaveBeenCalled();
  });
});
