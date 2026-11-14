import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChefDriverRequest } from "../src/chef/driver.js";
import { captureWorkshopHead, commitWorkshopChanges } from "../src/chef/workshop-git.js";

const execute = promisify(execFile);
const roots: string[] = [];
const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1",
};
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "commit.gpgsign=false", "-c", "user.name=Workshop test",
    "-c", "user.email=workshop-test@example.invalid", ...args,
  ], { cwd, env: gitEnv, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
async function fixture(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "chef-workshop-git-test-"));
  roots.push(cwd);
  await git(cwd, "init", "-b", "main");
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "index.ts"), "export const value = 1;\n");
  await writeFile(join(cwd, "src", "remove.ts"), "export const obsolete = true;\n");
  await writeFile(join(cwd, "README.md"), "Fixture owned by this test only.\n");
  await git(cwd, "add", "--", "src", "README.md");
  await git(cwd, "commit", "-m", "Fixture baseline");
  return cwd;
}
function request(cwd: string, patch: Partial<ChefDriverRequest> = {}): ChefDriverRequest {
  return {
    schemaVersion: 1, missionId: "workshop-mission", taskId: "workshop-build",
    workerId: "workshop-worker", provider: "codex", fencingToken: 1, attempt: 1,
    briefHash: "a".repeat(64), instructions: "Update the permitted source files",
    cwd, accessMode: "write", allowedPaths: ["src"], ...patch,
  };
}
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
async function expectUnchanged(cwd: string, head: string, ref: string): Promise<void> {
  expect(await git(cwd, "rev-parse", "HEAD")).toBe(head);
  expect(await git(cwd, "symbolic-ref", "HEAD")).toBe(ref);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe("workshop host Git publication in disposable real repositories", { timeout: 30_000 }, () => {
  it("captures the exact branch and commits only allowed new, modified and removed files", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    expect(initial).toMatchObject({ head: expect.stringMatching(/^[a-f0-9]{40,64}$/), ref: "refs/heads/main" });
    await writeFile(join(cwd, "src", "index.ts"), "export const value = 2;\n");
    await writeFile(join(cwd, "src", "added.ts"), "export const added = true;\n");
    await rm(join(cwd, "src", "remove.ts"));
    const committed = await commitWorkshopChanges(request(cwd), initial);
    expect(committed).toMatch(/^[a-f0-9]{40,64}$/);
    expect(committed).not.toBe(initial.head);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(committed);
    expect(await git(cwd, "rev-parse", "HEAD^")).toBe(initial.head);
    expect(await git(cwd, "symbolic-ref", "HEAD")).toBe(initial.ref);
    expect(await git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect((await git(cwd, "diff", "--name-only", initial.head, committed)).split("\n").sort())
      .toEqual(["src/added.ts", "src/index.ts", "src/remove.ts"]);
    expect(await git(cwd, "show", "HEAD:src/index.ts")).toBe("export const value = 2;");
    expect(await git(cwd, "show", "HEAD:README.md")).toBe("Fixture owned by this test only.");
  });

  it("does not create an empty commit for an unchanged workspace or a read-only task", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    expect(await commitWorkshopChanges(request(cwd), initial)).toBe(initial.head);
    expect(await commitWorkshopChanges(request(cwd, { accessMode: "read" }), initial)).toBe(initial.head);
    await expectUnchanged(cwd, initial.head, initial.ref);
  });

  it.each(["README.md", "src-secret/stolen.ts"])("rejects an out-of-scope path %s without publishing any permitted edits", async path => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    await mkdir(join(cwd, "src-secret"), { recursive: true });
    await writeFile(join(cwd, path), "Do not include this out-of-scope modification.\n");
    await writeFile(join(cwd, "src", "index.ts"), "export const value = 9;\n");
    const indexBefore = await readFile(join(cwd, ".git", "index"));
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    await expectUnchanged(cwd, initial.head, initial.ref);
    expect(await readFile(join(cwd, ".git", "index"))).toEqual(indexBefore);
  });

  it("rejects a write from a read-only task", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    await writeFile(join(cwd, "src", "index.ts"), "Unexpected mutation.\n");
    await expect(commitWorkshopChanges(request(cwd, { accessMode: "read" }), initial)).rejects.toThrow();
    await expectUnchanged(cwd, initial.head, initial.ref);
  });

  it.each(["unstaged", "staged", "untracked"])("refuses an initially dirty %s repository", async kind => {
    const cwd = await fixture();
    const before = await git(cwd, "rev-parse", "HEAD");
    if (kind === "untracked") await writeFile(join(cwd, "src", "untracked.ts"), "untracked\n");
    else {
      await writeFile(join(cwd, "src", "index.ts"), "changed before admission\n");
      if (kind === "staged") await git(cwd, "add", "--", "src/index.ts");
    }
    await expect(captureWorkshopHead(cwd)).rejects.toThrow();
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(before);
  });

  it("rejects a symlink without importing the outside target", async () => {
    const cwd = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "chef-workshop-outside-test-"));
    roots.push(outside);
    const target = join(outside, "private.txt");
    await writeFile(target, "outside bytes remain untouched\n");
    const initial = await captureWorkshopHead(cwd);
    await symlink(target, join(cwd, "src", "shortcut.ts"));
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    await expectUnchanged(cwd, initial.head, initial.ref);
    expect(await readFile(target, "utf8")).toBe("outside bytes remain untouched\n");
  });

  it("rejects a directory replacing a tracked file", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    await rm(join(cwd, "src", "index.ts"));
    await mkdir(join(cwd, "src", "index.ts"));
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    await expectUnchanged(cwd, initial.head, initial.ref);
  });

  it("rejects a changed gitlink instead of flattening a nested repository into a blob", async () => {
    const cwd = await fixture();
    const vendor = join(cwd, "src", "vendor");
    await mkdir(vendor);
    await git(vendor, "init", "-b", "main");
    await writeFile(join(vendor, "library.ts"), "export const vendor = 1;\n");
    await git(vendor, "add", "--", "library.ts");
    await git(vendor, "commit", "-m", "Vendor baseline");
    await git(cwd, "update-index", "--add", "--cacheinfo", "160000", await git(vendor, "rev-parse", "HEAD"), "src/vendor");
    await git(cwd, "commit", "-m", "Fixture gitlink");
    const initial = await captureWorkshopHead(cwd);
    await writeFile(join(vendor, "library.ts"), "export const vendor = 2;\n");
    await git(vendor, "add", "--", "library.ts");
    await git(vendor, "commit", "-m", "Vendor changed");
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    await expectUnchanged(cwd, initial.head, initial.ref);
  });

  it("refuses a concurrent HEAD commit and never overwrites it", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    await writeFile(join(cwd, "README.md"), "Another actor committed this.\n");
    await git(cwd, "add", "--", "README.md");
    await git(cwd, "commit", "-m", "Concurrent change");
    const concurrent = await git(cwd, "rev-parse", "HEAD");
    await writeFile(join(cwd, "src", "index.ts"), "Attempted late model result.\n");
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(concurrent);
  });

  it("refuses a branch switch even when the new branch has the same HEAD SHA", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    await git(cwd, "checkout", "-b", "other-owner");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(initial.head);
    await writeFile(join(cwd, "src", "index.ts"), "Must not commit on another branch.\n");
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    expect(await git(cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/other-owner");
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(initial.head);
    expect(await git(cwd, "rev-parse", initial.ref)).toBe(initial.head);
  });

  it("bypasses commit and reference-transaction hooks configured in the repository", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    const hooks = join(cwd, ".git", "workshop-test-hooks");
    const marker = join(cwd, ".git", "hook-executed");
    await mkdir(hooks);
    for (const name of ["pre-commit", "post-commit", "reference-transaction"]) {
      const path = join(hooks, name);
      await writeFile(path, "#!/bin/sh\nprintf 'executed\\n' >> " + shellQuote(marker) + "\n");
      await chmod(path, 0o755);
    }
    await git(cwd, "config", "core.hooksPath", hooks);
    await writeFile(join(cwd, "src", "index.ts"), "export const value = 3;\n");
    const committed = await commitWorkshopChanges(request(cwd), initial);
    expect(committed).not.toBe(initial.head);
    expect(existsSync(marker)).toBe(false);
    expect(await git(cwd, "rev-parse", "HEAD")).toBe(committed);
  });

  it("never executes an attribute clean filter, including during change discovery", async () => {
    const cwd = await fixture();
    // Register the attribute before the initial snapshot; the executable filter
    // is configured afterward so fixture setup itself cannot run it.
    await writeFile(join(cwd, ".gitattributes"), "src/*.ts filter=workshop-danger\n");
    await git(cwd, "add", "--", ".gitattributes");
    await git(cwd, "commit", "-m", "Fixture attributes");
    const marker = join(cwd, ".git", "filter-executed");
    const filter = join(cwd, ".git", "malicious-filter.sh");
    await writeFile(filter, "#!/bin/sh\nprintf 'executed\\n' >> " + shellQuote(marker) + "\ncat\n");
    await chmod(filter, 0o755);
    const initial = await captureWorkshopHead(cwd);
    await git(cwd, "config", "filter.workshop-danger.clean", shellQuote(filter));
    await git(cwd, "config", "filter.workshop-danger.smudge", shellQuote(filter));
    // Filter-bearing repositories are deliberately unsupported by this trusted
    // adapter; both initial admission and post-model publication must fail closed.
    await expect(captureWorkshopHead(cwd)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    await writeFile(join(cwd, "src", "index.ts"), "export const value = 4;\n");
    await expect(commitWorkshopChanges(request(cwd), initial)).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    await expectUnchanged(cwd, initial.head, initial.ref);
  });

  it("preserves binary bytes without applying attributes or text conversion", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 1, 2, 195, 40, 254, 0]);
    await writeFile(join(cwd, "src", "asset.bin"), bytes);
    const committed = await commitWorkshopChanges(request(cwd), initial);
    const blob = await execute("git", ["show", committed + ":src/asset.bin"], { cwd, env: gitEnv, encoding: "buffer" });
    expect(blob.stdout).toEqual(bytes);
    expect(await readFile(join(cwd, "src", "asset.bin"))).toEqual(bytes);
    expect(await git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("never commits when cancellation is already requested", async () => {
    const cwd = await fixture();
    const initial = await captureWorkshopHead(cwd);
    await writeFile(join(cwd, "src", "index.ts"), "Cancelled result.\n");
    const controller = new AbortController();
    controller.abort();
    await expect(commitWorkshopChanges(request(cwd), initial, controller.signal)).rejects.toThrow(/annul/i);
    await expectUnchanged(cwd, initial.head, initial.ref);
    await expect(captureWorkshopHead(cwd, controller.signal)).rejects.toThrow(/annul/i);
  });
});
