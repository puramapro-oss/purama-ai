import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000601";
const mission = "00000000-0000-4000-8000-000000000602";
const implementation = "00000000-0000-4000-8000-000000000603";
const review = "00000000-0000-4000-8000-000000000604";
const requirement = "00000000-0000-4000-8000-000000000605";
const hash = "a".repeat(64);
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
    "008_chef_control_plane.sql",
    "009_chef_hardening.sql",
    "010_chef_reliability.sql",
    "011_chef_runtime_policy.sql",
    "012_chef_mission_ingest.sql",
    "013_chef_independent_review.sql",
  ]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec("TRUNCATE purama_ai.chef_evidence, purama_ai.chef_task_requirements, purama_ai.chef_tasks, purama_ai.chef_requirements, purama_ai.chef_missions, auth.users CASCADE");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
  await db.query(
    "INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state) VALUES($1,$2,'b',$3,'goal','repo','active')",
    [mission, uid, hash]
  );
  await db.query(
    "INSERT INTO purama_ai.chef_requirements(id,mission_id,requirement_key,description,critical) VALUES($1,$2,'R1','critical',true)",
    [requirement, mission]
  );
  for (const [id, key] of [[implementation, "implement"], [review, "review"]] as const) {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(
        id,mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles
      ) VALUES($1,$2,$3,$3,$3,'verified_done',$4,'read',ARRAY['review'])`,
      [id, mission, key, hash]
    );
    await db.query("INSERT INTO purama_ai.chef_task_requirements(task_id,requirement_id) VALUES($1,$2)", [id, requirement]);
  }
});

describe("CHEF independent review gate", () => {
  it("does not accept self-review from the same implementation task", async () => {
    await db.query(
      "INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload) VALUES($1,$2,'test','{}'),($1,$2,'review','{}')",
      [implementation, requirement]
    );
    const missing = await db.query("SELECT * FROM purama_ai.chef_missing_requirements($1)", [mission]);
    expect(missing.rows).toHaveLength(1);
  });

  it("accepts concrete proof and review only when they come from distinct verified tasks", async () => {
    await db.query(
      "INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload) VALUES($1,$3,'test','{}'),($2,$3,'review','{}')",
      [implementation, review, requirement]
    );
    const missing = await db.query("SELECT * FROM purama_ai.chef_missing_requirements($1)", [mission]);
    expect(missing.rows).toHaveLength(0);
  });
});
