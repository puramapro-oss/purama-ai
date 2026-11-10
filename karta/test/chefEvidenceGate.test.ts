import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000701";
const mission = "00000000-0000-4000-8000-000000000702";
const implementation = "00000000-0000-4000-8000-000000000703";
const review = "00000000-0000-4000-8000-000000000704";
const requirement = "00000000-0000-4000-8000-000000000705";
const requirement2 = "00000000-0000-4000-8000-000000000706";
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
    "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql",
    "016_chef_scoped_evidence.sql",
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
    [mission, uid, "a".repeat(64)],
  );
  for (const [id, key] of [[requirement, "R1"], [requirement2, "R2"]]) {
    await db.query(
      "INSERT INTO purama_ai.chef_requirements(id,mission_id,requirement_key,description,critical) VALUES($1,$2,$3,$3,false)",
      [id, mission, key],
    );
  }
  for (const [id, key] of [[implementation, "implement"], [review, "review"]]) {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles)
       VALUES($1,$2,$3,$3,$3,'verified_done',$4,'read',ARRAY['acceptance'])`,
      [id, mission, key, "a".repeat(64)],
    );
    for (const requirementId of [requirement, requirement2]) {
      await db.query("INSERT INTO purama_ai.chef_task_requirements(task_id,requirement_id) VALUES($1,$2)", [id, requirementId]);
    }
  }
});

async function addProof(taskId: string, kind: string, payload: object, requirementId: string | null = requirement) {
  await db.query("INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload) VALUES($1,$2,$3,$4::jsonb)",
    [taskId, requirementId, kind, JSON.stringify(payload)]);
}
async function missing() {
  const result = await db.query<{ requirement_key: string }>("SELECT * FROM purama_ai.chef_missing_requirements($1)", [mission]);
  return result.rows.map(row => row.requirement_key);
}
const scoped = (extra: object = {}) => ({ ok: true, scopeVersion: 1, requirementKeys: ["R1"], ...extra });

describe("CHEF latest evidence gates", () => {
  it.each([false, null, "true", undefined])("does not count ok=%j as a successful requirement check", async (ok) => {
    await addProof(implementation, "test", scoped({ ok }));
    expect(await missing()).toEqual(["R1", "R2"]);
  });

  it.each([
    { ok: true },
    scoped({ scopeVersion: "1" }),
    scoped({ requirementKeys: ["R2"] }),
    scoped({ requirementKeys: "R1" }),
  ])("does not grandfather unscoped or mismatched evidence %j", async (payload) => {
    await addProof(implementation, "test", payload);
    expect(await missing()).toEqual(["R1", "R2"]);
  });

  it("counts only R1 after its successful explicit check, leaving R2 and the mission unfinished", async () => {
    await addProof(implementation, "test", scoped());
    expect(await missing()).toEqual(["R2"]);
    const result = await db.query("SELECT purama_ai.chef_try_finish_mission($1) AS done", [mission]);
    expect(result.rows).toEqual([{ done: false }]);
    await addProof(implementation, "test", scoped({ requirementKeys: ["R2"] }), requirement2);
    expect((await db.query("SELECT purama_ai.chef_try_finish_mission($1) AS done", [mission])).rows).toEqual([{ done: true }]);
  });

  it("does not turn a task-only Git receipt into requirement coverage", async () => {
    await addProof(implementation, "receipt", { profile: "git-state", ok: true }, null);
    expect(await missing()).toEqual(["R1", "R2"]);
  });

  it.each(["proof", "review"])("rejects a failed critical %s even when the other check passes", async (failed) => {
    await db.query("UPDATE purama_ai.chef_requirements SET critical=true WHERE id=$1", [requirement]);
    await addProof(implementation, "test", scoped({ ok: failed !== "proof" }));
    await addProof(review, "review", scoped({ ok: failed !== "review" }));
    expect(await missing()).toEqual(["R1", "R2"]);
  });

  it("requires a separate successful review for a critical requirement", async () => {
    await db.query("UPDATE purama_ai.chef_requirements SET critical=true WHERE id=$1", [requirement]);
    await addProof(implementation, "test", scoped());
    await addProof(implementation, "review", scoped());
    expect(await missing()).toEqual(["R1", "R2"]);
    await addProof(review, "review", scoped());
    expect(await missing()).toEqual(["R2"]);
  });

  it.each([false, null, "true", undefined])("refuses task completion with only ok=%j evidence", async (ok) => {
    await db.query("UPDATE purama_ai.chef_tasks SET state='verifying',lease_owner='worker',fencing_token=1,lease_expires_at=now()+interval '1 hour' WHERE id=$1", [implementation]);
    await addProof(implementation, "test", { ok }, null);
    await expect(db.query("SELECT purama_ai.chef_transition_task($1,'worker',1,'verified_done')", [implementation]))
      .rejects.toThrow(/requires.*evidence/i);
    expect((await db.query("SELECT state FROM purama_ai.chef_tasks WHERE id=$1", [implementation])).rows)
      .toEqual([{ state: "verifying" }]);
    await addProof(implementation, "test", { ok: true }, null);
    expect((await db.query("SELECT purama_ai.chef_transition_task($1,'worker',1,'verified_done') AS ok", [implementation])).rows)
      .toEqual([{ ok: true }]);
  });
});
