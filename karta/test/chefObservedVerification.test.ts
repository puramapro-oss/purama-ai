import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { CommandChefVerifier } from "../src/chef/verifier.js";
import type { ChefObservationProfile } from "../src/chef/observations.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const observed = (id = "voice", modality = "audio", extra: Record<string, unknown> = {}) => ({
  id, modality, status: "pass", coverage: "full", method: "fixture-inspector", summary: "Expected fixture content observed", ...extra,
});
async function fixture(overrides: Record<string, unknown> = {}, code = "", profileExtra: Record<string, unknown> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "chef-observed-"));
  directories.push(cwd);
  await writeFile(join(cwd, "result.txt"), "fixture output\n");
  const artifactSha256 = createHash("sha256").update("fixture output\n").digest("hex");
  const report = { schemaVersion: 1, artifactSha256, observations: [observed()], ...overrides };
  const script = `const fs=require('node:fs');const report=JSON.parse(process.argv[1]);${code};console.log(JSON.stringify(report));`;
  const observation: ChefObservationProfile = { artifactPath: "result.txt", checks: [{ id: "voice", modality: "audio", coverage: "full" }] };
  const profile = { name: "inspect", kind: "review" as const, command: process.execPath,
    args: ["-e", script, JSON.stringify(report)], observation, ...profileExtra };
  return { cwd, profile, observation, artifactSha256, verifier: new CommandChefVerifier([profile], [cwd]) };
}

describe("CHEF observed final artifact", () => {
  it("binds an executed observation to the actual artifact and configured checks", async () => {
    const f = await fixture();
    const result = await f.verifier.verify(f.cwd, ["inspect"]);
    expect(result.ok).toBe(true);
    expect(result.evidence[0].payload.observation).toMatchObject({
      artifactPath: "result.txt", artifactSha256: f.artifactSha256,
      observations: [{ id: "voice", modality: "audio", status: "pass", coverage: "full" }],
    });
  });

  it.each([
    ["missing audio observation", { observations: [] }],
    ["wrong modality", { observations: [observed("voice", "metadata")] }],
    ["unobserved audio", { observations: [observed("voice", "audio", { status: "not_tested", coverage: "none" })] }],
    ["observed defect", { observations: [observed("voice", "audio", { status: "fail", summary: "Fixture voice criterion failed" })] }],
    ["sample instead of full coverage", { observations: [observed("voice", "audio", { coverage: "sample" })] }],
    ["no coverage", { observations: [observed("voice", "audio", { coverage: "none" })] }],
    ["duplicate observations", { observations: [observed(), observed()] }],
    ["unknown check", { observations: [observed("other")] }],
    ["stale artifact hash", { artifactSha256: "f".repeat(64) }],
    ["unversioned report", { schemaVersion: 99 }],
    ["empty observation method", { observations: [observed("voice", "audio", { method: "" })] }],
  ])("refuses command exit zero with %s", async (_label, report) => {
    const f = await fixture(report as Record<string, unknown>);
    expect((await f.verifier.verify(f.cwd, ["inspect"])).ok).toBe(false);
  });

  it("refuses an artifact modified during the observation", async () => {
    const f = await fixture({}, "fs.writeFileSync('result.txt','changed during observation')");
    expect((await f.verifier.verify(f.cwd, ["inspect"])).ok).toBe(false);
  });

  it.each(["rewrite", "delete"])("invalidates an earlier observation when a later profile can %s its artifact", async change => {
    const f = await fixture();
    const later = { name: "later", kind: "build" as const, command: process.execPath,
      args: ["-e", change === "rewrite"
        ? "require('node:fs').writeFileSync('result.txt','new unobserved export')"
        : "require('node:fs').unlinkSync('result.txt')"] };
    const verifier = new CommandChefVerifier([f.profile, later], [f.cwd]);
    const result = await verifier.verify(f.cwd, ["inspect", "later"]);
    expect(result.ok).toBe(false);
    expect(result.evidence.find(e => e.payload.profile === "inspect")?.payload)
      .toMatchObject({ ok: false, observationError: "artifact_changed_after_observation" });
  });

  it("keeps an earlier observation valid when later checks leave the artifact unchanged", async () => {
    const f = await fixture();
    const later = { name: "later", kind: "test" as const, command: process.execPath,
      args: ["-e", "if(!require('node:fs').existsSync('result.txt'))process.exit(1)"] };
    expect((await new CommandChefVerifier([f.profile, later], [f.cwd])
      .verify(f.cwd, ["inspect", "later"])).ok).toBe(true);
  });

  it("does not upgrade a failed process from a positive observation report", async () => {
    const f = await fixture({}, "process.exitCode=4");
    expect((await f.verifier.verify(f.cwd, ["inspect"])).ok).toBe(false);
  });

  it("requires every configured modality on the same artifact", async () => {
    const f = await fixture({ observations: [observed("frame", "visual")] }, "", {
      observation: { artifactPath: "result.txt", checks: [
        { id: "frame", modality: "visual", coverage: "sample" },
        { id: "voice", modality: "audio", coverage: "full" },
      ] },
    });
    expect((await f.verifier.verify(f.cwd, ["inspect"])).ok).toBe(false);
  });

  it("retains sampled coverage without presenting it as full coverage", async () => {
    const f = await fixture({ observations: [observed("frame", "visual", { coverage: "sample" })] }, "", {
      observation: { artifactPath: "result.txt", checks: [{ id: "frame", modality: "visual", coverage: "sample" }] },
    });
    const result = await f.verifier.verify(f.cwd, ["inspect"]);
    expect(result.ok).toBe(true);
    expect(result.evidence[0].payload.observation).toMatchObject({ observations: [{ coverage: "sample" }] });
  });

  it("does not accept a different artifact through a symlink", async () => {
    const f = await fixture();
    await symlink("result.txt", join(f.cwd, "linked.txt"));
    const profile = { ...f.profile, observation: { ...f.observation, artifactPath: "linked.txt" } };
    const result = await new CommandChefVerifier([profile], [f.cwd]).verify(f.cwd, ["inspect"]);
    expect(result.ok).toBe(false);
  });

  it("fails closed for a missing final artifact", async () => {
    const f = await fixture();
    const profile = { ...f.profile, observation: { ...f.observation, artifactPath: "missing.txt" } };
    expect((await new CommandChefVerifier([profile], [f.cwd]).verify(f.cwd, ["inspect"])).ok).toBe(false);
  });

  it("enforces the configured artifact read budget", async () => {
    const f = await fixture();
    const profile = { ...f.profile, observation: { ...f.observation, maxArtifactBytes: 3 } };
    expect((await new CommandChefVerifier([profile], [f.cwd]).verify(f.cwd, ["inspect"])).ok).toBe(false);
  });

  it("snapshots configured observation requirements before a caller can mutate them", async () => {
    const f = await fixture();
    f.observation.checks.push({ id: "late", modality: "visual", coverage: "full" });
    expect((await f.verifier.verify(f.cwd, ["inspect"])).ok).toBe(true);
  });

  it("keeps ordinary command logs out of model-facing observation data", async () => {
    const profile = { name: "unit", kind: "test" as const, command: process.execPath,
      args: ["-e", "console.log('private-fixture-log')"] };
    const result = await new CommandChefVerifier([profile], [process.cwd()]).verify(process.cwd(), ["unit"]);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain("private-fixture-log");
    expect(result.evidence[0].payload.observation).toBeUndefined();
  });
});
