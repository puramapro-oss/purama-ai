import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000501";
const hash = "a".repeat(64);
let db: PGlite;

const brief = {
  briefId: "brief-x",
  version: 1,
  goal: "Build X",
  repo: "puramapro-oss/x",
  requirements: [
    { key: "R1", description: "Implement X", critical: true },
    { key: "R2", description: "Verify X", critical: true },
  ],
  tasks: [
    {
      key: "T1", title: "Implement", instructions: "Implement X", requirementKeys: ["R1"],
      provider: "codex", accessMode: "write", scopeKey: "puramapro-oss/x:src/x",
      verificationProfiles: ["unit", "typecheck"], maxAttempts: 3,
    },
    {
      key: "T2", title: "Review", instructions: "Review X", requirementKeys: ["R2"],
      provider: "claude", accessMode: "read", dependsOn: ["T1"],
      verificationProfiles: ["review"], maxAttempts: 2,
    },
  ],
};

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
    "008_chef_control_plane.sql",
    "009_chef_hardening.sql",
    "010_chef_reliability.sql", "011_chef_runtime_policy.sql",
    "012_chef_mission_ingest.sql",
  ]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec(`
    TRUNCATE purama_ai.chef_usage_events, purama_ai.chef_events, purama_ai.chef_evidence,
      purama_ai.chef_task_requirements, purama_ai.chef_task_dependencies, purama_ai.chef_workers,
      purama_ai.chef_tasks, purama_ai.chef_requirements, purama_ai.chef_missions, auth.users CASCADE;
  `);
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
});

async function create(value = brief, valueHash = hash) {
  return db.query(
    "SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,4,NULL,NULL) AS id",
    [uid, JSON.stringify(value), valueHash]
  );
}

describe("CHEF atomic mission ingestion", () => {
  it("creates the canonical mission, DAG and requirement links atomically", async () => {
    const created = await create();
    expect((created.rows[0] as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/i);

    const mission = (await db.query("SELECT state FROM purama_ai.chef_missions")).rows[0] as { state: string };
    expect(mission.state).toBe("active");

    const tasks = await db.query("SELECT task_key,state,verification_profiles FROM purama_ai.chef_tasks ORDER BY task_key");
    expect(tasks.rows).toMatchObject([
      { task_key: "T1", state: "ready", verification_profiles: ["unit", "typecheck"] },
      { task_key: "T2", state: "pending", verification_profiles: ["review"] },
    ]);

    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_task_dependencies")).rows[0]).toMatchObject({ n: 1 });
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_task_requirements")).rows[0]).toMatchObject({ n: 2 });
  });

  it("is idempotent for the same brief version and hash", async () => {
    const first = (await create()).rows[0] as { id: string };
    const second = (await create()).rows[0] as { id: string };
    expect(second.id).toBe(first.id);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows[0]).toMatchObject({ n: 1 });
  });

  it("rejects reusing the same brief version with different content hash", async () => {
    await create();
    await expect(create(brief, "b".repeat(64))).rejects.toThrow(/another hash/);
  });

  it("rolls the whole mission back if a dependency is unknown", async () => {
    const broken = structuredClone(brief);
    broken.tasks[1].dependsOn = ["MISSING"];
    await expect(create(broken)).rejects.toThrow(/Unknown dependency/);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows[0]).toMatchObject({ n: 0 });
  });

  it("keeps mission creation server-only", async () => {
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    try {
      await expect(create()).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
