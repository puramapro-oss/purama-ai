import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandChefVerifier } from "../src/chef/verifier.js";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CHEF deterministic verifier", () => {
  it("never starts a check or produces PASS from an already cancelled signal", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "chef-verify-preabort-"));
    tempDirs.push(cwd);
    const marker = join(cwd, "should-not-exist");
    const verifier = new CommandChefVerifier([{
      name: "unit", kind: "test", command: process.execPath,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
    }], [cwd]);
    const cancel = new AbortController();
    cancel.abort();
    await expect(verifier.verify(cwd, ["unit"], cancel.signal)).rejects.toThrow(/annulée/);
    expect(existsSync(marker)).toBe(false);
  });

  it("fails closed if no verification profile is attached", async () => {
    const verifier = new CommandChefVerifier([], [process.cwd()]);
    await expect(verifier.verify(process.cwd(), [])).resolves.toMatchObject({ ok: false });
  });

  it("records reproducible evidence for a passing deterministic check", async () => {
    const verifier = new CommandChefVerifier([
      { name: "unit", kind: "test", command: process.execPath, args: ["-e", "console.log('PASS')"] },
    ], [process.cwd()]);
    const result = await verifier.verify(process.cwd(), ["unit"]);
    expect(result.ok).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({ kind: "test", payload: { profile: "unit", ok: true, exitCode: 0 } });
    expect(result.evidence[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stops the verification chain at the first failed gate", async () => {
    const verifier = new CommandChefVerifier([
      { name: "red", kind: "test", command: process.execPath, args: ["-e", "process.exit(7)"] },
      { name: "never", kind: "build", command: process.execPath, args: ["-e", "process.exit(0)"] },
    ], [process.cwd()]);
    const result = await verifier.verify(process.cwd(), ["red", "never"]);
    expect(result.ok).toBe(false);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].payload.exitCode).toBe(7);
  });
});
