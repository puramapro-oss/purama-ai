import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessChefDriver, assertAllowedCwd, validateDriverResponse } from "../src/chef/driver.js";

const hash = "a".repeat(64);
const sha = "b".repeat(40);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function request(cwd = process.cwd()) {
  return {
    schemaVersion: 1 as const,
    missionId: "m1",
    taskId: "t1",
    workerId: "w1",
    provider: "codex" as const,
    fencingToken: 1,
    attempt: 1,
    briefHash: hash,
    instructions: "Do the task",
    cwd,
    accessMode: "write" as const,
    allowedPaths: ["."],
  };
}

describe("CHEF process driver", () => {
  it("never permits a cwd outside trusted roots", () => {
    expect(() => assertAllowedCwd("/etc", [process.cwd()])).toThrow(/hors périmètre/);
  });

  it("rejects a symlink that lexically lives under a trusted root but escapes outside it", async () => {
    const trusted = await mkdtemp(join(tmpdir(), "chef-trusted-"));
    const outside = await mkdtemp(join(tmpdir(), "chef-outside-"));
    tempDirs.push(trusted, outside);
    const link = join(trusted, "escape");
    await symlink(outside, link, "dir");
    expect(() => assertAllowedCwd(link, [trusted])).toThrow(/hors périmètre/);
  });

  it("rejects malformed worker responses", () => {
    expect(() => validateDriverResponse({ schemaVersion: 1, status: "completed", summary: "" })).toThrow();
    expect(() => validateDriverResponse({ schemaVersion: 1, status: "completed", summary: "ok", outputSha: "bad" })).toThrow();
    expect(() => validateDriverResponse({ schemaVersion: 1, status: "completed", summary: "ok", usage: { inputTokens: -1, outputTokens: 0 } })).toThrow();
  });

  it("sends model instructions over stdin and accepts only a strict JSON result", async () => {
    const script = [
      "let s='';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data',d=>s+=d);",
      "process.stdin.on('end',()=>{",
      " const r=JSON.parse(s);",
      " console.log('worker-log');",
      " console.log(JSON.stringify({schemaVersion:1,status:'completed',summary:r.instructions,outputSha:'" + sha + "',usage:{inputTokens:10,outputTokens:4,cachedInputTokens:2,costMicros:50,model:'test'}}));",
      "});",
    ].join("");

    const driver = new ProcessChefDriver({
      provider: "codex",
      command: process.execPath,
      args: ["-e", script],
      allowedRoots: [process.cwd()],
      timeoutMs: 5_000,
    });

    const result = await driver.run(request());
    expect(result).toMatchObject({ status: "completed", summary: "Do the task", outputSha: sha });
    expect(result.usage).toMatchObject({ inputTokens: 10, outputTokens: 4 });
  });

  it("fails closed when a worker exits without a valid JSON result", async () => {
    const driver = new ProcessChefDriver({
      provider: "codex",
      command: process.execPath,
      args: ["-e", "console.log('only logs')"],
      allowedRoots: [process.cwd()],
      timeoutMs: 5_000,
    });
    await expect(driver.run(request())).rejects.toThrow(/sans réponse JSON/);
  });
});
