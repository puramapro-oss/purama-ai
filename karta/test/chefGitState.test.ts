import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { verifyCommittedGitState } from "../src/chef/git-state.js";

const exec = promisify(execFile);
const dirs: string[] = [];

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "purama-chef-git-"));
  dirs.push(dir);
  await exec("git", ["init", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "chef@test.invalid"], { cwd: dir });
  await exec("git", ["config", "user.name", "PURAMA CHEF Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "one\n");
  await exec("git", ["add", "a.txt"], { cwd: dir });
  await exec("git", ["commit", "-m", "initial"], { cwd: dir });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
  return { dir, sha: stdout.trim() };
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CHEF git state verifier", () => {
  it("accepts an exact clean committed HEAD", async () => {
    const { dir, sha } = await repo();
    const evidence = await verifyCommittedGitState({ cwd: dir, expectedHeadSha: sha, expectedBranch: "main" });
    expect(evidence).toMatchObject({ kind: "receipt", payload: { ok: true, headSha: sha, clean: true, branch: "main" } });
  });

  it("rejects a worker that lies about its output SHA", async () => {
    const { dir } = await repo();
    await expect(verifyCommittedGitState({ cwd: dir, expectedHeadSha: "f".repeat(40) })).rejects.toThrow(/HEAD réel/);
  });

  it("rejects uncommitted or untracked output", async () => {
    const { dir, sha } = await repo();
    await writeFile(join(dir, "uncommitted.txt"), "not committed\n");
    await expect(verifyCommittedGitState({ cwd: dir, expectedHeadSha: sha })).rejects.toThrow(/non propre/);
  });

  it("requires the final HEAD to descend from the assigned base", async () => {
    const { dir, sha: baseSha } = await repo();
    await writeFile(join(dir, "a.txt"), "two\n");
    await exec("git", ["add", "a.txt"], { cwd: dir });
    await exec("git", ["commit", "-m", "second"], { cwd: dir });
    const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: dir });
    const head = stdout.trim();
    await expect(
      verifyCommittedGitState({ cwd: dir, expectedHeadSha: head, baseSha, allowedPaths: ["a.txt"] })
    ).resolves.toBeDefined();
    await expect(
      verifyCommittedGitState({ cwd: dir, expectedHeadSha: head, baseSha: "e".repeat(40), allowedPaths: ["a.txt"] })
    ).rejects.toThrow(/descend pas/);
  });
});
