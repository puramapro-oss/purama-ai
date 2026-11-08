import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseChefControlPlane } from "../src/chef/control-plane.js";
import { CommandChefVerifier, type ChefVerificationEvidence } from "../src/chef/verifier.js";

const db = vi.hoisted(() => ({
  links: [
    { requirement_id: "r1", requirement: { requirement_key: "R1" } },
    { requirement_id: "r2", requirement: { requirement_key: "R2" } },
  ],
  lookupError: null as { message: string } | null,
  insert: vi.fn(),
  from: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("../src/db/supabase.js", () => ({ supabase: { from: db.from } }));

const control = new SupabaseChefControlPlane({
  repo: "test", defaultCwd: process.cwd(), defaultVerificationProfiles: ["build"],
});
const proof = (extra: Record<string, unknown> = {}): ChefVerificationEvidence => ({
  kind: "build", sha256: "a".repeat(64), payload: { profile: "build", ok: true }, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.lookupError = null;
  db.eq.mockImplementation(async () => ({ data: db.links, error: db.lookupError }));
  db.insert.mockResolvedValue({ error: null });
  db.from.mockImplementation((table: string) => {
    if (table === "chef_task_requirements") return { select: () => ({ eq: db.eq }) };
    if (table === "chef_evidence") return { insert: db.insert };
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe("CHEF explicit evidence scope", () => {
  it("does not fan out a successful generic build to every task requirement", async () => {
    await control.addEvidence("task", proof());
    expect(db.insert).toHaveBeenCalledWith([
      expect.objectContaining({ task_id: "task", requirement_id: null }),
    ]);
  });

  it("keeps a git receipt at task level even if its payload claims a scope", async () => {
    await control.addEvidence("task", proof({
      kind: "receipt", payload: { profile: "git-state", ok: true, scopeVersion: 1, requirementKeys: ["R2"] },
    }));
    expect(db.insert).toHaveBeenCalledWith([
      expect.objectContaining({ requirement_id: null, payload: expect.objectContaining({ requirementKeys: [] }) }),
    ]);
  });

  it("links only the explicitly checked requirement, once", async () => {
    await control.addEvidence("task", proof({ requirementKeys: [" R1 ", "R1"] }));
    expect(db.eq).toHaveBeenCalledWith("task_id", "task");
    expect(db.insert).toHaveBeenCalledWith([
      expect.objectContaining({ requirement_id: null }),
      expect.objectContaining({ requirement_id: "r1", payload: expect.objectContaining({ scopeVersion: 1, requirementKeys: ["R1"] }) }),
    ]);
  });

  it("rejects an unlinked or foreign requirement before any write", async () => {
    await expect(control.addEvidence("task", proof({ requirementKeys: ["R1", "FOREIGN"] })))
      .rejects.toThrow(/exigence.*liée/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("keeps a failed check for audit without linking it to requirements", async () => {
    await control.addEvidence("task", proof({ requirementKeys: ["R1"], payload: { profile: "build", ok: false } }));
    expect(db.insert).toHaveBeenCalledWith([
      expect.objectContaining({ requirement_id: null, payload: expect.objectContaining({ ok: false }) }),
    ]);
  });

  it("does not write when requirement resolution fails", async () => {
    db.lookupError = { message: "offline" };
    await expect(control.addEvidence("task", proof({ requirementKeys: ["R1"] }))).rejects.toThrow(/offline/);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([null, "R1", [null], [""], [" "]])("rejects malformed scope %j", async (requirementKeys) => {
    await expect(control.addEvidence("task", proof({ requirementKeys }))).rejects.toThrow(/exigence/i);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("gets coverage from trusted profile configuration, never process output", async () => {
    const configuredKeys = [" R1 ", "R1"];
    const verifier = new CommandChefVerifier([{
      name: "acceptance", kind: "test", command: process.execPath,
      args: ["-e", "console.log(JSON.stringify({requirementKeys:['R2']}))"],
      ...{ requirementKeys: configuredKeys },
    }], [process.cwd()]);
    configuredKeys.push("R2");
    const result = await verifier.verify(process.cwd(), ["acceptance"]);
    expect(result.ok).toBe(true);
    expect(result.evidence[0]).toMatchObject({ requirementKeys: ["R1"] });
    await control.addEvidence("task", result.evidence[0]);
    expect(db.insert.mock.calls[0][0].map((row: { requirement_id: string | null }) => row.requirement_id))
      .toEqual([null, "r1"]);
  });
});
