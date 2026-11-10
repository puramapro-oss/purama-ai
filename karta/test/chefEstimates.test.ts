import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { hashChefBrief, normalizeChefBrief, type ChefBrief } from "../src/chef/brief.js";
import { createChefMission } from "../src/chef/mission.js";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc } }));

const uid = "00000000-0000-4000-8000-000000000601";
const missionId = "00000000-0000-4000-8000-000000000602";
// Computed by executing brief.ts from the unchanged base commit 1daf6314.
const legacyHash = "62c06f360859f8533fa837b47e7aa9f92fc77dd5d291d768aa902624e55d205f";
const estimateKeys = ["estimatedTokens", "estimatedCostMicros"] as const;

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

function estimatedBrief(): ChefBrief {
  const value = brief();
  Object.assign(value.tasks[0], { estimatedTokens: 0, estimatedCostMicros: 70 });
  Object.assign(value.tasks[1], { estimatedTokens: 10, estimatedCostMicros: 0 });
  return value;
}

beforeEach(() => { rpc.mockReset().mockResolvedValue({ data: missionId, error: null }); });

describe("CHEF canonical admission estimates", () => {
  it("preserves the exact historical hash and shape when both estimates are absent", () => {
    const value = brief();
    expect(hashChefBrief(value)).toBe(legacyHash);
    value.tasks[0].estimatedTokens = undefined;
    value.tasks[0].estimatedCostMicros = undefined;
    expect(hashChefBrief(value)).toBe(legacyHash);
    for (const task of normalizeChefBrief(value).tasks) {
      expect(task).not.toHaveProperty("estimatedTokens");
      expect(task).not.toHaveProperty("estimatedCostMicros");
    }
  });

  it("keeps explicit zero and makes estimates part of the canonical hash", () => {
    const value = estimatedBrief();
    expect(normalizeChefBrief(value).tasks).toMatchObject([
      { estimatedTokens: 0, estimatedCostMicros: 70 },
      { estimatedTokens: 10, estimatedCostMicros: 0 },
    ]);
    expect(hashChefBrief(value)).not.toBe(legacyHash);
    const firstHash = hashChefBrief(value);
    value.tasks[0].estimatedCostMicros = 71;
    expect(hashChefBrief(value)).not.toBe(firstHash);
    const secondHash = hashChefBrief(value);
    value.tasks.reverse();
    expect(hashChefBrief(value)).toBe(secondHash);
  });

  for (const field of estimateKeys) {
    it.each([null, "1", true, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
      `rejects an invalid ${field}: %s before RPC`, async (invalid) => {
        const value = brief();
        Object.assign(value.tasks[0], { [field]: invalid });
        expect(() => normalizeChefBrief(value)).toThrow(field);
        await expect(createChefMission(value, { userId: uid })).rejects.toThrow(field);
        expect(rpc).not.toHaveBeenCalled();
      },
    );
  }

  it.each([
    ["tokenBudget", "estimatedTokens"],
    ["costBudgetMicros", "estimatedCostMicros"],
  ] as const)("requires the corresponding estimate when %s is zero", async (budget, estimate) => {
    await expect(createChefMission(brief(), { userId: uid, [budget]: 0 })).rejects.toThrow(estimate);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("requires an estimate for every task under the corresponding cap", async () => {
    const value = estimatedBrief();
    delete value.tasks[1].estimatedCostMicros;
    await expect(createChefMission(value, { userId: uid, costBudgetMicros: 100 })).rejects.toThrow(/estimatedCostMicros.*T2/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves the other estimate optional when only one dimension has a cap", async () => {
    const value = brief();
    for (const task of value.tasks) task.estimatedTokens = 0;
    await createChefMission(value, { userId: uid, tokenBudget: 0 });
    expect(rpc).toHaveBeenCalledWith("chef_create_mission", expect.objectContaining({
      p_token_budget: 0, p_cost_budget_micros: null,
      p_brief: expect.objectContaining({ tasks: expect.arrayContaining([expect.objectContaining({ estimatedTokens: 0 })]) }),
    }));
  });
});

describe("CHEF estimate ingestion with real SQL", () => {
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
      "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "022_chef_mission_estimates.sql",
    ]) {
      await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
    }
  });

  afterAll(async () => { await db?.close(); });

  beforeEach(async () => {
    await db.exec("TRUNCATE auth.users CASCADE");
    await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
  });

  async function createRaw(value: unknown, tokenBudget: number | null = null, costBudget: number | null = null, hash = legacyHash) {
    return db.query<{ id: string }>(
      "SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,$4,$5) AS id",
      [uid, JSON.stringify(value), hash, tokenBudget, costBudget],
    );
  }

  async function estimates() {
    return (await db.query(`SELECT task_key, estimated_tokens::text, estimated_cost_micros::text
      FROM purama_ai.chef_tasks ORDER BY task_key`)).rows;
  }

  it("persists the real normalized RPC payload, including zero, with the existing DAG and ownership", async () => {
    rpc.mockImplementation(async (name, args) => {
      expect(name).toBe("chef_create_mission");
      const result = await createRaw(args.p_brief, args.p_token_budget, args.p_cost_budget_micros, args.p_brief_hash);
      return { data: result.rows[0].id, error: null };
    });
    const created = await createChefMission(estimatedBrief(), { userId: uid, tokenBudget: 100, costBudgetMicros: 100 });
    expect(created.missionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await estimates()).toEqual([
      { task_key: "T1", estimated_tokens: "0", estimated_cost_micros: "70" },
      { task_key: "T2", estimated_tokens: "10", estimated_cost_micros: "0" },
    ]);
    expect((await db.query("SELECT task_key,state,allowed_paths FROM purama_ai.chef_tasks ORDER BY task_key")).rows).toEqual([
      { task_key: "T1", state: "ready", allowed_paths: ["src"] },
      { task_key: "T2", state: "pending", allowed_paths: [] },
    ]);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_task_dependencies")).rows[0]).toEqual({ n: 1 });
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_task_requirements")).rows[0]).toEqual({ n: 2 });
  });

  it("preserves unbounded legacy missions and accepts replay of their unchanged hash", async () => {
    const first = await createRaw(brief());
    const replay = await createRaw(brief());
    expect(replay.rows[0].id).toBe(first.rows[0].id);
    expect(await estimates()).toEqual([
      { task_key: "T1", estimated_tokens: null, estimated_cost_micros: null },
      { task_key: "T2", estimated_tokens: null, estimated_cost_micros: null },
    ]);
  });

  it("accepts the largest safe integer without precision loss", async () => {
    const value = estimatedBrief();
    Object.assign(value.tasks[0], { estimatedTokens: Number.MAX_SAFE_INTEGER, estimatedCostMicros: Number.MAX_SAFE_INTEGER });
    await createRaw(normalizeChefBrief(value));
    expect((await estimates())[0]).toMatchObject({
      estimated_tokens: String(Number.MAX_SAFE_INTEGER), estimated_cost_micros: String(Number.MAX_SAFE_INTEGER),
    });
  });

  for (const field of estimateKeys) {
    it.each([null, "1", "NaN", true, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
      `rejects invalid raw SQL ${field}: %s and rolls back the mission`, async (invalid) => {
        const value = brief();
        Object.assign(value.tasks[1], { [field]: invalid });
        await expect(createRaw(value)).rejects.toThrow(/Invalid task estimate/);
        expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows[0]).toEqual({ n: 0 });
        expect(await estimates()).toEqual([]);
      },
    );
  }

  it("enforces missing estimates at SQL ingress for both finite budget dimensions", async () => {
    await expect(createRaw(brief(), 0, null)).rejects.toThrow(/requires estimatedTokens/);
    await expect(createRaw(brief(), null, 0)).rejects.toThrow(/requires estimatedCostMicros/);
    expect(await estimates()).toEqual([]);
  });

  it("allows the uncapped dimension to remain absent in the raw RPC", async () => {
    const value = brief();
    for (const task of value.tasks) task.estimatedCostMicros = 0;
    await createRaw(value, null, 0);
    expect(await estimates()).toEqual([
      { task_key: "T1", estimated_tokens: null, estimated_cost_micros: "0" },
      { task_key: "T2", estimated_tokens: null, estimated_cost_micros: "0" },
    ]);
  });

  it("rejects changed estimates on the same brief version and retains the first mission", async () => {
    const value = estimatedBrief();
    await createRaw(value, 100, 100, hashChefBrief(value));
    value.tasks[0].estimatedCostMicros = 71;
    await expect(createRaw(value, 100, 100, hashChefBrief(value))).rejects.toThrow(/another hash/);
    expect((await estimates())[0]).toMatchObject({ estimated_cost_micros: "70" });
  });

  it("retains the SQL ownership and profile guards introduced before this migration", async () => {
    const noPaths = estimatedBrief();
    delete noPaths.tasks[0].allowedPaths;
    await expect(createRaw(noPaths)).rejects.toThrow(/allowedPaths/);
    const noProfiles = estimatedBrief();
    noProfiles.tasks[0].verificationProfiles = [];
    await expect(createRaw(noProfiles)).rejects.toThrow(/verification profiles/);
    expect(await estimates()).toEqual([]);
  });

  it("retains the server-only RPC permission", async () => {
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    try {
      await expect(createRaw(estimatedBrief())).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
