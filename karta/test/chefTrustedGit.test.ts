import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTrustedGit } from "../src/chef/trusted-git.js";
import { captureWorkshopHead, commitWorkshopChanges } from "../src/chef/workshop-git.js";
import { captureCleanGitBaseline, verifyCommittedGitState } from "../src/chef/git-state.js";
import { buildWorkshopArtifact } from "../src/chef/workshop-artifact.js";
import { preflightWorkshopProject } from "../src/chef/workshop-runtime.js";
import type { WorkshopProject } from "../src/chef/workshop-config.js";
import type { ChefDriverRequest } from "../src/chef/driver.js";

const exec = promisify(execFile);
const roots: string[] = [];
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "chef-trusted-git-")));
  roots.push(root);
  const cwd = join(root, "repo");
  await mkdir(join(cwd, "bin"), { recursive: true });
  const realGit = await resolveTrustedGit(cwd);
  const safePath = [dirname(realGit), "/usr/bin", "/bin"].join(delimiter);
  const marker = join(root, "UNTRUSTED_GIT_EXECUTED");
  const fakeGit = "#!/bin/sh\nprintf invoked > " + quote(marker) + "\nexit 78\n";
  await writeFile(join(cwd, "git"), fakeGit, { mode: 0o700 });
  await writeFile(join(cwd, "bin/git"), fakeGit, { mode: 0o700 });
  await writeFile(join(cwd, "index.html"), "<h1>Original</h1>\n");
  const env = { PATH: safePath, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => exec(realGit, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture",
    "-c", "user.email=fixture@localhost", ...args], { cwd, env });
  await git("init", "-q", "-b", "main");
  await git("add", "--all");
  await git("commit", "-qm", "fixture");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  const codex = join(root, "codex");
  await writeFile(codex, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.1.0\\n"; elif [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; else exit 77; fi\n', { mode: 0o700 });
  const project: WorkshopProject = {
    id: "trusted-test", name: "Trusted test", userIds: ["00000000-0000-4000-8000-000000000001"],
    repo: "fixture/repo", workdir: cwd, allowedPaths: ["index.html"], previewEntry: "index.html",
    maxParallel: 1, tokenBudget: 9000, estimatedTokensPerTask: 1000, codexCommand: codex,
    implementationProfiles: ["test"], reviewProfiles: ["review"],
    verificationProfiles: [
      { name: "test", kind: "test", command: "/usr/bin/true", requirementKeys: ["PRODUCT", "QUALITY"] },
      { name: "review", kind: "review", command: "/usr/bin/true", requirementKeys: ["PRODUCT", "QUALITY"] },
    ],
  };
  const request: ChefDriverRequest = { schemaVersion: 1, missionId: "mission", taskId: "task", workerId: "worker",
    provider: "codex", fencingToken: 1, attempt: 1, briefHash: "a".repeat(64), instructions: "Update only index.html",
    cwd, accessMode: "write", allowedPaths: ["index.html"] };
  return { root, cwd, realGit, safePath, marker, sha, project, request };
}

describe("trusted absolute Git resolution at every execution boundary", { timeout: 30_000 }, () => {
  it.each([".", "", "bin"])("never executes a project Git selected by relative/empty PATH entry %j", async entry => {
    const f = await fixture();
    vi.stubEnv("PATH", entry + delimiter + f.safePath);
    expect(await resolveTrustedGit(f.cwd)).toBe(f.realGit);
    const initial = await captureWorkshopHead(f.cwd);
    expect((await captureCleanGitBaseline({ cwd: f.cwd })).headSha).toBe(f.sha);
    await writeFile(join(f.cwd, "index.html"), "<h1>Verified result</h1>\n");
    const outputSha = await commitWorkshopChanges(f.request, initial);
    await expect(verifyCommittedGitState({ cwd: f.cwd, expectedHeadSha: outputSha, baseSha: f.sha, allowedPaths: ["index.html"] })).resolves.toMatchObject({ payload: { clean: true } });
    expect((await buildWorkshopArtifact(f.project, "mission", outputSha)).preview?.content).toBe("<h1>Verified result</h1>\n");
    await expect(preflightWorkshopProject(f.project, new AbortController().signal)).resolves.toMatchObject({ cwd: f.cwd });
    expect(existsSync(f.marker)).toBe(false);
  });

  it("refuses an absolute project binary for all Git entry points without invoking it", async () => {
    const f = await fixture();
    const initial = await captureWorkshopHead(f.cwd);
    vi.stubEnv("PATH", f.cwd + delimiter + f.safePath);
    for (const operation of [
      () => resolveTrustedGit(f.cwd),
      () => captureWorkshopHead(f.cwd),
      () => commitWorkshopChanges(f.request, initial),
      () => captureCleanGitBaseline({ cwd: f.cwd }),
      () => verifyCommittedGitState({ cwd: f.cwd, expectedHeadSha: f.sha }),
      () => buildWorkshopArtifact(f.project, "mission", f.sha),
    ]) await expect(operation()).rejects.toThrow(/Git modifiable/);
    await expect(preflightWorkshopProject(f.project, new AbortController().signal)).rejects.toMatchObject({ code: "WORKSHOP_PREFLIGHT" });
    expect(existsSync(f.marker)).toBe(false);
  });

  it("rejects an external PATH symlink that resolves into the generated project", async () => {
    const f = await fixture();
    const shim = join(f.root, "shim");
    await mkdir(shim); await symlink(join(f.cwd, "git"), join(shim, "git"));
    vi.stubEnv("PATH", shim + delimiter + f.safePath);
    await expect(captureWorkshopHead(f.cwd)).rejects.toThrow(/Git modifiable/);
    expect(existsSync(f.marker)).toBe(false);
  });

  it("pins the real executable instead of retaining a PATH symlink that can be retargeted", async () => {
    const f = await fixture();
    const shim = join(f.root, "shim");
    await mkdir(shim); await symlink(f.realGit, join(shim, "git"));
    const selected = await resolveTrustedGit(f.cwd, shim + delimiter + f.safePath);
    expect(selected).toBe(f.realGit);
    await rm(join(shim, "git")); await symlink(join(f.cwd, "git"), join(shim, "git"));
    expect((await exec(selected, ["--version"])).stdout).toMatch(/^git version /);
    expect(existsSync(f.marker)).toBe(false);
  });

  it("fails closed when no absolute trusted search directory exists", async () => {
    const f = await fixture();
    await expect(resolveTrustedGit(f.cwd, [".", "", "bin"].join(delimiter))).rejects.toThrow(/de confiance indisponible/);
    expect(existsSync(f.marker)).toBe(false);
  });
});
