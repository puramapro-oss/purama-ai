import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexCliChefDriver } from "../src/chef/codex-cli-driver.js";
import type { ChefDriverRequest } from "../src/chef/driver.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "chef-codex-fixture-"));
  directories.push(directory);
  const cwd = join(directory, "repo");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", cwd], { stdio: "pipe" });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "user.name=CHEF fixture", "-c", "user.email=chef-fixture@example.invalid",
    "commit", "--allow-empty", "-qm", "fixture"], { cwd, stdio: "pipe" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const command = join(directory, "codex-fixture");
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const resultPath = args[args.indexOf("--output-last-message") + 1];
const schemaPath = args[args.indexOf("--output-schema") + 1];
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => prompt += chunk);
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(__dirname, "trace.json"), JSON.stringify({
    args, prompt, schema: JSON.parse(fs.readFileSync(schemaPath, "utf8")),
    secretPresent: Object.hasOwn(process.env, "CHEF_TEST_SECRET"),
    nodeOptionsPresent: Object.hasOwn(process.env, "NODE_OPTIONS"),
  }));
  ${body}
});
`;
  await writeFile(command, script, { mode: 0o700 });
  await chmod(command, 0o700);
  const request: ChefDriverRequest = {
    schemaVersion: 1, missionId: "mission-fixture", taskId: "task-fixture", workerId: "worker-fixture",
    provider: "codex", fencingToken: 1, attempt: 1, briefHash: "a".repeat(64),
    instructions: "Only inspect the scoped code. Literal: $(touch forbidden) and `touch forbidden`.",
    cwd, accessMode: "write", allowedPaths: ["src"],
  };
  const driver = new CodexCliChefDriver({ command, allowedRoots: [cwd], timeoutMs: 5_000 });
  const trace = async () => JSON.parse(await readFile(join(directory, "trace.json"), "utf8")) as {
    args: string[]; prompt: string; schema: Record<string, unknown>; secretPresent: boolean; nodeOptionsPresent: boolean;
  };
  return { directory, cwd, head, command, request, driver, trace };
}

const completed = 'fs.writeFileSync(resultPath, JSON.stringify({status:"completed",summary:"done; claimed SHA is not trusted"}));';
const usage = 'console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:21,output_tokens:7,cached_input_tokens:4}}));';

describe("direct Codex CLI CHEF adapter", () => {
  it.each([
    { mode: "auto", needs: [], selectedIds: [], excludedIds: [], maxSelected: 8 },
    { mode: "manual", needs: [], selectedIds: [], excludedIds: [], maxSelected: 8 },
    { mode: "manual", needs: ["research"], selectedIds: ["review"], excludedIds: [], maxSelected: 8 },
    null,
  ])("blocks unsupported capability choices before any process or Git effect: %j", async selection => {
    const f = await fixture(completed + usage);
    const result = await f.driver.run({
      ...f.request, capabilitySelection: selection as unknown as ChefDriverRequest["capabilitySelection"],
    });
    expect(result).toMatchObject({
      status: "blocked_external", usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
      metadata: { capabilitySelection: { state: "blocked", reason: "capability_adapter_unavailable" } },
    });
    expect(result).not.toHaveProperty("outputSha");
    expect(existsSync(join(f.directory, "trace.json"))).toBe(false);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: f.cwd, encoding: "utf8" }).trim()).toBe(f.head);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.cwd, encoding: "utf8" })).toBe("");
  });

  it("uses the real CLI contract, stdin, a narrow environment and an independently observed Git SHA", async () => {
    const f = await fixture(completed + usage);
    vi.stubEnv("CHEF_TEST_SECRET", "must-not-reach-child");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    const result = await f.driver.run(f.request);
    const trace = await f.trace();
    expect(result).toEqual({
      schemaVersion: 1, status: "completed", summary: "done; claimed SHA is not trusted", outputSha: f.head,
      usage: { inputTokens: 21, outputTokens: 7, cachedInputTokens: 4 },
    });
    expect(result.usage).not.toHaveProperty("costMicros");
    expect(trace.args.slice(0, 7)).toEqual(["exec", "--ignore-user-config", "--ephemeral", "--json", "--color", "never", "--sandbox"]);
    expect(trace.args[trace.args.indexOf("--sandbox") + 1]).toBe("workspace-write");
    expect(trace.args[trace.args.indexOf("--cd") + 1]).toBe(realpathSync(f.cwd));
    expect(trace.args.at(-1)).toBe("-");
    expect(trace.args.some(value => value.startsWith("--dangerously-") || value === "--ignore-rules")).toBe(false);
    expect(trace.prompt).toContain(f.request.instructions);
    expect(trace.prompt).toContain('"allowedPaths":["src"]');
    expect(trace.schema).toMatchObject({ required: ["status", "summary"], additionalProperties: false });
    expect(trace.secretPresent).toBe(false);
    expect(trace.nodeOptionsPresent).toBe(false);
    expect(existsSync(join(f.cwd, "forbidden"))).toBe(false);
    expect(existsSync(dirname(trace.args[trace.args.indexOf("--output-schema") + 1]))).toBe(false);
  });

  it("uses the read-only sandbox for read tasks", async () => {
    const f = await fixture(completed);
    await f.driver.run({ ...f.request, accessMode: "read", allowedPaths: [] });
    const trace = await f.trace();
    expect(trace.args[trace.args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(trace.prompt).toContain('"accessMode":"read"');
  });

  it.each(["blocked_human", "blocked_external", "failed"] as const)("keeps %s distinct from completion", async status => {
    const f = await fixture('fs.writeFileSync(resultPath, JSON.stringify({status:' + JSON.stringify(status) + ',summary:"Needs an existing authorized resource"}));');
    const result = await f.driver.run(f.request);
    expect(result).toEqual({ schemaVersion: 1, status, summary: "Needs an existing authorized resource" });
    expect(result).not.toHaveProperty("outputSha");
    expect(result).not.toHaveProperty("usage");
  });

  it("does not invent usage when the CLI supplies none", async () => {
    const f = await fixture(completed + 'console.log(JSON.stringify({type:"item.completed",item:{text:"21 tokens"}}));');
    const result = await f.driver.run(f.request);
    expect(result.outputSha).toBe(f.head);
    expect(result).not.toHaveProperty("usage");
  });

  it.each([
    { input_tokens: -1, output_tokens: 1 },
    { input_tokens: "21", output_tokens: 7 },
    { input_tokens: 2, output_tokens: 1, cached_input_tokens: 3 },
    { input_tokens: 21 },
  ])("treats malformed CLI counters as unknown: %j", async counters => {
    const f = await fixture(completed + 'console.log(JSON.stringify({type:"turn.completed",usage:' + JSON.stringify(counters) + '}));');
    expect(await f.driver.run(f.request)).not.toHaveProperty("usage");
  });

  it("does not double-count ambiguous repeated completion events", async () => {
    const f = await fixture(completed + usage + usage);
    expect(await f.driver.run(f.request)).not.toHaveProperty("usage");
  });

  it.each([
    '"not JSON"',
    'JSON.stringify({status:"completed",summary:"ok",outputSha:"' + "b".repeat(40) + '"})',
    'JSON.stringify({status:"completed",summary:"ok",usage:{inputTokens:0,outputTokens:0}})',
    'JSON.stringify({status:"complete",summary:"ok"})',
    'JSON.stringify({status:"completed",summary:" "})',
    'JSON.stringify(["completed","ok"])',
  ])("refuses invalid or model-supplied receipt fields: %s", async final => {
    const f = await fixture('fs.writeFileSync(resultPath, ' + final + ');');
    await expect(f.driver.run(f.request)).rejects.toThrow(/Réponse finale Codex/);
    const trace = await f.trace();
    expect(existsSync(dirname(trace.args[trace.args.indexOf("--output-schema") + 1]))).toBe(false);
  });

  it("requires the final message file rather than accepting a log as the result", async () => {
    const f = await fixture('console.log(JSON.stringify({status:"completed",summary:"only a log"}));');
    await expect(f.driver.run(f.request)).rejects.toThrow(/Réponse finale Codex absente/);
  });

  it("refuses a symlink for the final result", async () => {
    const f = await fixture('fs.writeFileSync(path.join(process.cwd(),"fake.json"),JSON.stringify({status:"completed",summary:"ok"})); fs.symlinkSync(path.join(process.cwd(),"fake.json"),resultPath);');
    await expect(f.driver.run(f.request)).rejects.toThrow(/Réponse finale Codex absente/);
  });

  it("reports a failed CLI without echoing its diagnostics", async () => {
    const f = await fixture('console.error("PRIVATE_DIAGNOSTIC"); process.exitCode=17;');
    await expect(f.driver.run(f.request)).rejects.toThrow("CLI Codex échoué (code=17)");
  });

  it("does not accept completion when Git cannot confirm a real revision", async () => {
    const f = await fixture(completed + 'fs.rmSync(path.join(process.cwd(),".git"),{recursive:true,force:true});');
    await expect(f.driver.run(f.request)).rejects.toThrow(/Révision Git Codex non confirmée/);
  });

  it("preserves the primary CLI failure when removal of its private temporary files fails", async () => {
    const f = await fixture('fs.chmodSync(path.dirname(resultPath),0o500); process.exitCode=17;');
    try {
      await expect(f.driver.run(f.request)).rejects.toThrow("CLI Codex échoué (code=17)");
    } finally {
      const trace = await f.trace();
      const temporary = dirname(trace.args[trace.args.indexOf("--output-schema") + 1]);
      if (existsSync(temporary)) {
        await chmod(temporary, 0o700);
        await rm(temporary, { recursive: true, force: true });
      }
    }
  });

  it("rejects an out-of-root cwd and a symlink escape before launch", async () => {
    const f = await fixture(completed);
    const outside = await mkdtemp(join(tmpdir(), "chef-codex-outside-"));
    directories.push(outside);
    await symlink(outside, join(f.cwd, "escape"), "dir");
    await expect(f.driver.run({ ...f.request, cwd: outside })).rejects.toThrow(/hors périmètre/);
    await expect(f.driver.run({ ...f.request, cwd: join(f.cwd, "escape") })).rejects.toThrow(/hors périmètre/);
    expect(existsSync(join(f.directory, "trace.json"))).toBe(false);
  });

  it.each(["../outside", "/etc", "src/../../etc", "src\\file", "src\nfile"])("rejects invalid owned path %s before launch", async path => {
    const f = await fixture(completed);
    await expect(f.driver.run({ ...f.request, allowedPaths: [path] })).rejects.toThrow(/Périmètre/);
    expect(existsSync(join(f.directory, "trace.json"))).toBe(false);
  });

  it("refuses credentials and injection variables in a host environment allowlist", async () => {
    const f = await fixture(completed);
    for (const name of ["OPENAI_API_KEY", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"]) {
      expect(() => new CodexCliChefDriver({ command: f.command, allowedRoots: [f.cwd], envAllowList: [name] })).toThrow(/environnement/);
    }
  });

  it("does not launch an already cancelled request", async () => {
    const f = await fixture(completed);
    const controller = new AbortController();
    controller.abort();
    await expect(f.driver.run(f.request, controller.signal)).rejects.toThrow(/annulé/);
    expect(existsSync(join(f.directory, "trace.json"))).toBe(false);
  });

  it("aborts an actual running fixture, waits for its termination and removes temporary files", async () => {
    const f = await fixture('setInterval(()=>{},1000);');
    const controller = new AbortController();
    const outcome = f.driver.run(f.request, controller.signal).then(
      () => ({ ok: true as const, error: undefined }),
      error => ({ ok: false as const, error: error as Error }),
    );
    const deadline = Date.now() + 15_000; // includes bounded host Git preflight before the fixture starts
    while (!existsSync(join(f.directory, "trace.json")) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(existsSync(join(f.directory, "trace.json"))).toBe(true);
    controller.abort();
    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(result.error?.message).toMatch(/annulé/);
    const trace = await f.trace();
    expect(existsSync(dirname(trace.args[trace.args.indexOf("--output-schema") + 1]))).toBe(false);
  }, 25_000);
});
