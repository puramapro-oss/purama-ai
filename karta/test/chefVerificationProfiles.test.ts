import { beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseChefControlPlane } from "../src/chef/control-plane.js";
import { createChefMission } from "../src/chef/mission.js";
import type { ChefBrief } from "../src/chef/brief.js";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc } }));

const missionId = "00000000-0000-4000-8000-000000000601";
const claim = { missionId, workerId: "worker", provider: "codex" as const, leaseSeconds: 60 };
const taskRow = {
  id: "00000000-0000-4000-8000-000000000602", mission_id: missionId,
  brief_hash: "a".repeat(64), instructions: "Verify the complete policy", access_mode: "read",
  fencing_token: 1, attempt: 1,
};

function control(defaultVerificationProfiles = ["default"]) {
  return new SupabaseChefControlPlane({ repo: "example/repo", defaultCwd: "/tmp/example", defaultVerificationProfiles });
}

beforeEach(() => rpc.mockReset());

describe("CHEF verification policy at the claim boundary", () => {
  it.each([
    ["unit", " security "], [" security "], ["unit", null], ["unit", ""],
    ["unit", "invalid/profile"], [42], "unit", {},
  ].map(profiles => ({ profiles })))("rejects an invalid explicit policy without silently weakening it: $profiles", async ({ profiles }) => {
    rpc.mockResolvedValue({ data: [{ ...taskRow, verification_profiles: profiles }], error: null });
    await expect(control().claimNext(claim)).rejects.toThrow(/Profils de vérification CHEF invalides/);
  });

  it("preserves every valid explicit profile instead of replacing it with defaults", async () => {
    rpc.mockResolvedValue({ data: [{ ...taskRow, verification_profiles: ["unit", "security"] }], error: null });
    const task = await control().claimNext(claim);
    expect(task?.verificationProfiles).toEqual(["unit", "security"]);
  });

  it.each([undefined, null, []].map(profiles => ({ profiles })))("retains the configured legacy fallback for an absent policy: $profiles", async ({ profiles }) => {
    rpc.mockResolvedValue({ data: [{ ...taskRow, verification_profiles: profiles }], error: null });
    expect((await control(["unit", "security"]).claimNext(claim))?.verificationProfiles).toEqual(["unit", "security"]);
  });

  it("rejects invalid defaults when the fallback is used", async () => {
    rpc.mockResolvedValue({ data: [taskRow], error: null });
    await expect(control(["unit", " security "]).claimNext(claim)).rejects.toThrow(/Profils de vérification CHEF invalides/);
  });

  it("carries the full normalized policy from mission ingestion through a simulated RPC claim", async () => {
    const input: ChefBrief = {
      briefId: "policy-preservation", version: 1, goal: "Keep both checks", repo: "example/repo",
      requirements: [{ key: "R1", description: "All checks run" }],
      tasks: [{ key: "T1", title: "Check", instructions: "Check", accessMode: "read", requirementKeys: [" R1 "], verificationProfiles: ["unit", " security "] }],
    };
    rpc.mockResolvedValueOnce({ data: missionId, error: null });
    const created = await createChefMission(input, { userId: "00000000-0000-4000-8000-000000000603" });
    const sent = rpc.mock.calls[0][1].p_brief as ChefBrief;
    expect(sent.tasks[0].verificationProfiles).toEqual(["security", "unit"]);
    expect(sent.tasks[0].requirementKeys).toEqual(["R1"]);
    rpc.mockResolvedValueOnce({ data: [{ ...taskRow, brief_hash: created.briefHash, verification_profiles: sent.tasks[0].verificationProfiles }], error: null });
    expect((await control().claimNext(claim))?.verificationProfiles).toEqual(["security", "unit"]);
  });
});
