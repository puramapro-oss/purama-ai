import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { hashChefBrief, normalizeChefBrief, type ChefBrief } from "../src/chef/brief.js";
import { normalizeChefCapabilitySelection } from "../src/chef/capability-selection.js";
import { createChefMission } from "../src/chef/mission.js";
import { SupabaseChefControlPlane } from "../src/chef/control-plane.js";

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc, from } }));

const uid = "00000000-0000-4000-8000-000000000601";
// Historical fixture also exercised by chefEstimates.test.ts before capability selection existed.
const legacyHash = "62c06f360859f8533fa837b47e7aa9f92fc77dd5d291d768aa902624e55d205f";

function brief(): ChefBrief {
  return {
    briefId: "brief-estimates", version: 1, goal: "Build bounded work", repo: "puramapro-oss/example",
    requirements: [{ key: "R1", description: "Implement and verify" }],
    tasks: [
      {
        key: "T1", title: "Implement", instructions: "Implement safely", requirementKeys: ["R1"],
        provider: "codex", accessMode: "write", scopeKey: "example:src", allowedPaths: ["src"],
        verificationProfiles: ["unit"],
      },
      {
        key: "T2", title: "Review", instructions: "Review independently", requirementKeys: ["R1"],
        provider: "claude", accessMode: "read", dependsOn: ["T1"], verificationProfiles: ["review"],
      },
    ],
  };
}

function selectedBrief(): ChefBrief {
  const value = brief();
  value.tasks[0].capabilitySelection = normalizeChefCapabilitySelection({
    mode: "auto", needs: ["code.typescript", "test.unit"], excludedIds: ["unqualified"],
  });
  value.tasks[1].capabilitySelection = normalizeChefCapabilitySelection({
    mode: "manual", needs: ["review"], selectedIds: ["reviewer"], maxSelected: 2,
  });
  return value;
}

beforeEach(() => { rpc.mockReset(); from.mockReset(); });

describe("CHEF capability choices in canonical briefs", () => {
  it("preserves the exact legacy hash and omits absent fields", () => {
    const value = brief();
    expect(hashChefBrief(value)).toBe(legacyHash);
    value.tasks[0].capabilitySelection = undefined;
    expect(hashChefBrief(value)).toBe(legacyHash);
    expect(normalizeChefBrief(value).tasks[0]).not.toHaveProperty("capabilitySelection");
  });

  it("includes canonical choices in the hash, independent of array ordering and duplicates", () => {
    const value = selectedBrief();
    const hash = hashChefBrief(value);
    expect(hash).not.toBe(legacyHash);
    value.tasks[0].capabilitySelection!.needs = ["test.unit", "code.typescript", "test.unit"];
    expect(hashChefBrief(value)).toBe(hash);
    value.tasks[0].capabilitySelection!.maxSelected = 2;
    expect(hashChefBrief(value)).not.toBe(hash);
  });

  it("rejects malformed choices before creating a mission", async () => {
    const value = brief();
    Object.assign(value.tasks[0], { capabilitySelection: { mode: "auto", needs: [], authorized: true } });
    await expect(createChefMission(value, { userId: uid })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("CHEF persisted capability choices with real SQL", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
      CREATE SCHEMA purama_ai;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role BYPASSRLS;
    `);
    for (const file of [
      "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
      "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
      "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "016_chef_scoped_evidence.sql",
      "017_chef_evidence_generation.sql", "021_chef_budget_admission.sql", "022_chef_mission_estimates.sql",
      "023_chef_process_quarantine.sql", "024_chef_claim_budget_reconciliation.sql", "030_chef_capability_selection.sql",
    ]) await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  });

  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.exec("TRUNCATE auth.users CASCADE");
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (!["chef_create_mission", "chef_heartbeat_worker", "chef_claim_next_task",
        "chef_transition_task", "chef_record_claim_usage"].includes(name)) throw new Error(`Unexpected RPC: ${name}`);
      const entries = Object.entries(args);
      const parameters = entries.map(([key], index) => `${key} => $${index + 1}`).join(",");
      try {
        const result = await db.query<Record<string, unknown>>(`SELECT * FROM purama_ai.${name}(${parameters})`,
          entries.map(([, value]) => value !== null && typeof value === "object" ? JSON.stringify(value) : value));
        return { data: name === "chef_claim_next_task" ? result.rows : result.rows[0]?.[name], error: null };
      } catch (error) { return { data: null, error: { message: (error as Error).message } }; }
    });
    from.mockImplementation((table: string) => {
      expect(table).toBe("chef_missions");
      let missionId: string;
      const query = {
        select(columns: string) { expect(columns).toBe("user_id"); return query; },
        eq(column: string, value: string) { expect(column).toBe("id"); missionId = value; return query; },
        async single() {
          const result = await db.query<{ user_id: string }>(
            "SELECT user_id FROM purama_ai.chef_missions WHERE id=$1", [missionId]);
          return { data: result.rows[0] ?? null, error: null };
        },
      };
      return query;
    });
  });

  async function createRaw(value: unknown, hash = legacyHash) {
    return db.query<{ id: string }>("SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,NULL,NULL) AS id",
      [uid, JSON.stringify(value), hash]);
  }
  async function selections() {
    return (await db.query("SELECT task_key,capability_selection FROM purama_ai.chef_tasks ORDER BY task_key")).rows;
  }

  it("round-trips normalized preferences through the real creation RPC and claim adapter", async () => {
    const value = selectedBrief();
    const created = await createChefMission(value, { userId: uid });
    expect(await selections()).toEqual(value.tasks.map(task => ({ task_key: task.key, capability_selection: task.capabilitySelection })));
    const control = new SupabaseChefControlPlane({
      repo: value.repo, defaultCwd: "/tmp/chef-selection", defaultVerificationProfiles: ["unit"],
    });
    await control.heartbeat({ workerId: "selection-worker", provider: "codex", state: "idle" });
    const first = await control.claimNext({ missionId: created.missionId, workerId: "selection-worker", provider: "codex", leaseSeconds: 300 });
    expect(first).toMatchObject({ userId: uid, capabilitySelection: value.tasks[0].capabilitySelection, briefHash: created.briefHash, attempt: 1 });
    expect(first).not.toBeNull();

    // A confirmed pre-execution retry conserves choices across a new fenced claim.
    expect(await control.recordUsage({
      eventKey: "selection-no-execution-1", missionId: created.missionId, taskId: first!.id,
      workerId: "selection-worker", provider: "codex", attempt: first!.attempt, fencingToken: first!.fencingToken,
      inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costMicros: 0,
    })).toBe(true);
    expect(await control.transition({ taskId: first!.id, workerId: "selection-worker", fencingToken: first!.fencingToken, target: "retryable" })).toBe(true);
    await control.heartbeat({ workerId: "selection-worker", provider: "codex", state: "idle" });
    const resumed = await control.claimNext({ missionId: created.missionId, workerId: "selection-worker", provider: "codex", leaseSeconds: 300 });
    expect(resumed).toMatchObject({ id: first!.id, userId: uid, capabilitySelection: first!.capabilitySelection, attempt: 2 });
    expect(resumed!.fencingToken).toBeGreaterThan(first!.fencingToken);
  });

  it("normalizes direct SQL input identically without inventing a default for legacy tasks", async () => {
    const value = brief();
    const selection = { mode: "manual", needs: ["z", "A", "z"], selectedIds: ["reviewer", "reviewer"] };
    Object.assign(value.tasks[1], { capabilitySelection: selection });
    await createRaw(value);
    expect(await selections()).toEqual([
      { task_key: "T1", capability_selection: null },
      { task_key: "T2", capability_selection: normalizeChefCapabilitySelection(selection) },
    ]);
  });

  it("replays the same mission without duplicate tasks and refuses changed choices even with a reused hash", async () => {
    const value = selectedBrief();
    const first = await createRaw(value, hashChefBrief(value));
    expect((await createRaw(value, hashChefBrief(value))).rows[0].id).toBe(first.rows[0].id);
    expect(await selections()).toHaveLength(2);
    value.tasks[0].capabilitySelection!.maxSelected = 3;
    await expect(createRaw(value, hashChefBrief(value))).rejects.toThrow(/another hash/);
    await expect(createRaw(value, hashChefBrief(selectedBrief()))).rejects.toThrow(/differs/);
    expect((await selections())[0]).toMatchObject({ capability_selection: { maxSelected: 8 } });
  });

  it.each([
    null, {}, [], { mode: "smart", needs: [] }, { mode: "auto" }, { mode: "auto", needs: null },
    { mode: "auto", needs: [" bad"] }, { mode: "auto", needs: [1] }, { mode: "auto", needs: ["a".repeat(121)] },
    { mode: "auto", needs: Array(33).fill("same") }, { mode: "auto", needs: [], selectedIds: ["x"] },
    { mode: "manual", needs: [], selectedIds: ["x"], excludedIds: ["x"] },
    { mode: "manual", needs: [], selectedIds: null }, { mode: "auto", needs: [], maxSelected: 0 },
    { mode: "auto", needs: [], maxSelected: 17 }, { mode: "auto", needs: [], maxSelected: 1.5 },
    { mode: "auto", needs: [], maxSelected: "8" }, { mode: "auto", needs: [], authorized: true },
  ])("rejects malformed raw preferences %j atomically", async (invalid) => {
    const value = brief();
    Object.assign(value.tasks[1], { capabilitySelection: invalid });
    await expect(createRaw(value)).rejects.toThrow(/capability selection/);
    expect(await selections()).toEqual([]);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows[0]).toEqual({ n: 0 });
  });

  it("retains the write ownership, dependency, estimate and service-only protections", async () => {
    const noPaths = selectedBrief();
    noPaths.tasks[0].allowedPaths = [];
    await expect(createRaw(noPaths)).rejects.toThrow(/allowedPaths/);
    const unknownDependency = selectedBrief();
    unknownDependency.tasks[1].dependsOn = ["missing"];
    await expect(createRaw(unknownDependency)).rejects.toThrow(/Unknown dependency/);
    const noEstimate = selectedBrief();
    await expect(db.query("SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,100,NULL)",
      [uid, JSON.stringify(noEstimate), legacyHash])).rejects.toThrow(/estimatedTokens/);
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    try { await expect(createRaw(selectedBrief())).rejects.toThrow(/permission denied/); }
    finally { await db.exec("RESET ROLE"); }
    expect(await selections()).toEqual([]);
  });

  it("rejects corrupted persisted choices in the claim adapter before returning a runnable task", async () => {
    rpc.mockResolvedValue({ data: [{ id: "task", mission_id: "mission", brief_hash: "a".repeat(64), instructions: "Do work",
      access_mode: "read", fencing_token: 1, attempt: 1, verification_profiles: ["unit"],
      capability_selection: { mode: "auto", needs: [], approved: true } }], error: null });
    const control = new SupabaseChefControlPlane({ repo: "repo", defaultCwd: "/tmp", defaultVerificationProfiles: ["unit"] });
    await expect(control.claimNext({ missionId: "mission", workerId: "worker", provider: "codex", leaseSeconds: 300 })).rejects.toThrow();
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, error: null },
    { data: {}, error: null },
    { data: { user_id: "not-a-uuid" }, error: null },
    { data: null, error: { message: "Owner lookup unavailable" } },
  ])("blocks a selected task when its canonical owner is unavailable or invalid: %j", async (owner) => {
    rpc.mockResolvedValue({ data: [{ id: "task", mission_id: "mission", brief_hash: "a".repeat(64), instructions: "Do work",
      access_mode: "read", fencing_token: 1, attempt: 1, verification_profiles: ["unit"],
      user_id: uid, capability_selection: { mode: "auto", needs: [] } }], error: null });
    const query = { select: () => query, eq: () => query, single: async () => owner };
    from.mockReturnValue(query);
    const control = new SupabaseChefControlPlane({ repo: "repo", defaultCwd: "/tmp", defaultVerificationProfiles: ["unit"] });
    await expect(control.claimNext({ missionId: "mission", workerId: "worker", provider: "codex", leaseSeconds: 300 })).rejects.toThrow();
    expect(from).toHaveBeenCalledWith("chef_missions");
  });

  it("does not add an owner lookup to legacy tasks without a selection contract", async () => {
    rpc.mockResolvedValue({ data: [{ id: "task", mission_id: "mission", brief_hash: "a".repeat(64), instructions: "Do work",
      access_mode: "read", fencing_token: 1, attempt: 1, verification_profiles: ["unit"], capability_selection: null }], error: null });
    const control = new SupabaseChefControlPlane({ repo: "repo", defaultCwd: "/tmp", defaultVerificationProfiles: ["unit"] });
    const task = await control.claimNext({ missionId: "mission", workerId: "worker", provider: "codex", leaseSeconds: 300 });
    expect(task).not.toHaveProperty("userId");
    expect(task).not.toHaveProperty("capabilitySelection");
    expect(from).not.toHaveBeenCalled();
  });
});
