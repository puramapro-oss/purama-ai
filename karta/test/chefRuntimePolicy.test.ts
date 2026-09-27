import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000401";
const mission = "00000000-0000-4000-8000-000000000402";
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
  for (const file of ["008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql", "011_chef_runtime_policy.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec("TRUNCATE purama_ai.chef_tasks, purama_ai.chef_missions, auth.users CASCADE");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
  await db.query(
    "INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state) VALUES($1,$2,'b',$3,'goal','repo','active')",
    [mission, uid, hash]
  );
});

describe("CHEF runtime task policy", () => {
  it("refuses an unscoped write task", async () => {
    await expect(db.query(
      `INSERT INTO purama_ai.chef_tasks(
        mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles
      ) VALUES($1,'unsafe','unsafe','unsafe','ready',$2,'write',ARRAY['unit'])`,
      [mission, hash]
    )).rejects.toThrow(/chef_write_task_scope_required/);
  });

  it("refuses a task that has no deterministic verification profile", async () => {
    await expect(db.query(
      `INSERT INTO purama_ai.chef_tasks(
        mission_id,task_key,title,instructions,state,brief_hash,access_mode,scope_key
      ) VALUES($1,'unverified','unverified','unverified','ready',$2,'write','repo:src/x')`,
      [mission, hash]
    )).rejects.toThrow(/chef_task_verification_profiles_required/);
  });

  it("permits read-only tasks without a write scope when verification is explicit", async () => {
    await expect(db.query(
      `INSERT INTO purama_ai.chef_tasks(
        mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles
      ) VALUES($1,'read','read','read','ready',$2,'read',ARRAY['review'])`,
      [mission, hash]
    )).resolves.toBeDefined();
  });

  it("permits a scoped write task with explicit verification", async () => {
    await expect(db.query(
      `INSERT INTO purama_ai.chef_tasks(
        mission_id,task_key,title,instructions,state,brief_hash,access_mode,scope_key,verification_profiles
      ) VALUES($1,'safe','safe','safe','ready',$2,'write','repo:src/x',ARRAY['unit','build'])`,
      [mission, hash]
    )).resolves.toBeDefined();
  });
});
