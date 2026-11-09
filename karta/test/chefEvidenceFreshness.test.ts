import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000801";
const mission = "00000000-0000-4000-8000-000000000802";
const task = "00000000-0000-4000-8000-000000000803";
const review = "00000000-0000-4000-8000-000000000804";
const requirement = "00000000-0000-4000-8000-000000000805";
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
    "017_chef_evidence_generation.sql",
  ]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec("TRUNCATE purama_ai.chef_evidence, purama_ai.chef_task_requirements, purama_ai.chef_tasks, purama_ai.chef_requirements, purama_ai.chef_missions, auth.users CASCADE");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
  await db.query("INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state) VALUES($1,$2,'b',$3,'goal','repo','active')", [mission, uid, "a".repeat(64)]);
  await db.query("INSERT INTO purama_ai.chef_requirements(id,mission_id,requirement_key,description,critical) VALUES($1,$2,'R1','requirement',false)", [requirement, mission]);
  for (const [id, key] of [[task, "implement"], [review, "review"]]) {
    await db.query(`INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles,attempt,fencing_token,lease_owner,lease_expires_at)
      VALUES($1,$2,$3,$3,$3,'verifying',$4,'read',ARRAY['acceptance'],1,1,'worker',clock_timestamp()+interval '1 hour')`,
    [id, mission, key, "a".repeat(64)]);
    await db.query("INSERT INTO purama_ai.chef_task_requirements(task_id,requirement_id) VALUES($1,$2)", [id, requirement]);
  }
});

async function addProof(
  taskId = task,
  kind = "test",
  payload: object = { ok: true, scopeVersion: 1, requirementKeys: ["R1"] },
  claim: { attempt: number | null; token: number | null; worker: string | null } = { attempt: 1, token: 1, worker: "worker" },
) {
  return db.query("INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload,attempt,fencing_token,worker_id) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7)",
    [taskId, requirement, kind, JSON.stringify(payload), claim.attempt, claim.token, claim.worker]);
}
async function finish(taskId = task, token = 1) {
  return db.query("SELECT purama_ai.chef_transition_task($1,'worker',$2,'verified_done') AS ok", [taskId, token]);
}
async function missing() {
  return (await db.query<{ requirement_key: string }>("SELECT * FROM purama_ai.chef_missing_requirements($1)", [mission])).rows.map(row => row.requirement_key);
}

describe("CHEF evidence generation", () => {
  it("refuses completion when only a prior attempt has successful evidence", async () => {
    await addProof();
    await db.query("UPDATE purama_ai.chef_tasks SET attempt=2,fencing_token=2 WHERE id=$1", [task]);
    await expect(finish(task, 2)).rejects.toThrow(/requires.*evidence/i);
  });

  it("does not cover an updated task generation with its previous proof", async () => {
    await addProof();
    await db.query("UPDATE purama_ai.chef_tasks SET state='verified_done',lease_owner=NULL,lease_expires_at=NULL,attempt=2,fencing_token=2 WHERE id=$1", [task]);
    expect(await missing()).toEqual(["R1"]);
  });

  it("accepts a fresh proof and preserves coverage after the lease owner is cleared", async () => {
    await addProof();
    expect((await finish()).rows).toEqual([{ ok: true }]);
    expect((await db.query("SELECT lease_owner,lease_expires_at FROM purama_ai.chef_tasks WHERE id=$1", [task])).rows)
      .toEqual([{ lease_owner: null, lease_expires_at: null }]);
    expect(await missing()).toEqual([]);
  });

  it.each([
    { attempt: 1, token: 0, worker: "worker" },
    { attempt: 2, token: 1, worker: "worker" },
    { attempt: 1, token: 1, worker: "other" },
    { attempt: null, token: 1, worker: "worker" },
    { attempt: 1, token: null, worker: "worker" },
    { attempt: 1, token: 1, worker: null },
  ])("rejects stale or missing claim metadata %j atomically", async (claim) => {
    await expect(addProof(task, "test", { ok: true }, claim)).rejects.toMatchObject({ code: "PCE01" });
    expect((await db.query("SELECT id FROM purama_ai.chef_evidence")).rows).toHaveLength(0);
  });

  it.each(["claimed", "retryable", "blocked_external", "verified_done", "cancelled", "failed"])(
    "rejects proof writes after task state becomes %s", async (state) => {
      await db.query("UPDATE purama_ai.chef_tasks SET state=$2 WHERE id=$1", [task, state]);
      await expect(addProof()).rejects.toMatchObject({ code: "PCE01" });
    });

  it("uses the actual clock even within a transaction started before expiry", async () => {
    await db.exec("BEGIN");
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1", [task]);
      expect((await db.query("SELECT lease_expires_at > now() AS old_clock_would_accept FROM purama_ai.chef_tasks WHERE id=$1", [task])).rows)
        .toEqual([{ old_clock_would_accept: true }]);
      await expect(addProof()).rejects.toMatchObject({ code: "PCE01" });
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("also refuses completion after expiry inside an older transaction", async () => {
    await db.exec("BEGIN");
    try {
      await addProof();
      await new Promise(resolve => setTimeout(resolve, 20));
      await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1", [task]);
      expect((await finish()).rows).toEqual([{ ok: false }]);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("does not revive an expired lease through a transaction started earlier", async () => {
    await db.exec("BEGIN");
    try {
      await new Promise(resolve => setTimeout(resolve, 20));
      await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1", [task]);
      expect((await db.query("SELECT purama_ai.chef_renew_task_lease($1,'worker',1,300) AS ok", [task])).rows)
        .toEqual([{ ok: false }]);
    } finally {
      await db.exec("ROLLBACK");
    }
  });

  it("renews a live lease only for its current owner and token", async () => {
    expect((await db.query("SELECT purama_ai.chef_renew_task_lease($1,'worker',1,300) AS ok", [task])).rows)
      .toEqual([{ ok: true }]);
    expect((await db.query("SELECT purama_ai.chef_renew_task_lease($1,'worker',2,300) AS ok", [task])).rows)
      .toEqual([{ ok: false }]);
    expect((await db.query("SELECT purama_ai.chef_renew_task_lease($1,'other',1,300) AS ok", [task])).rows)
      .toEqual([{ ok: false }]);
  });

  it.each(["transition", "renew"]) ("rejects a NULL token for %s even when the worker matches", async (operation) => {
    await addProof();
    const sql = operation === "transition"
      ? "SELECT purama_ai.chef_transition_task($1,'worker',NULL,'verified_done') AS ok"
      : "SELECT purama_ai.chef_renew_task_lease($1,'worker',NULL,300) AS ok";
    expect((await db.query(sql, [task])).rows).toEqual([{ ok: false }]);
  });

  it("does not accept a NULL worker even on a task with no lease owner", async () => {
    await db.query("UPDATE purama_ai.chef_tasks SET state='claimed',lease_owner=NULL WHERE id=$1", [task]);
    expect((await db.query("SELECT purama_ai.chef_renew_task_lease($1,NULL,1,300) AS ok", [task])).rows)
      .toEqual([{ ok: false }]);
    expect((await db.query("SELECT purama_ai.chef_transition_task($1,NULL,1,'running') AS ok", [task])).rows)
      .toEqual([{ ok: false }]);
  });

  it("rejects a NULL renewal duration instead of erasing the lease", async () => {
    await expect(db.query("SELECT purama_ai.chef_renew_task_lease($1,'worker',1,NULL)", [task]))
      .rejects.toThrow(/Invalid lease/);
  });

  it("rejects an old token even when the attempt number is reused after unblocking", async () => {
    await addProof();
    await db.query("UPDATE purama_ai.chef_tasks SET state='blocked_external' WHERE id=$1", [task]);
    await db.query("SELECT purama_ai.chef_unblock_task($1)", [task]);
    await db.query("UPDATE purama_ai.chef_tasks SET state='verifying',attempt=1,fencing_token=2 WHERE id=$1", [task]);
    await expect(finish(task, 2)).rejects.toThrow(/requires.*evidence/i);
    await expect(addProof()).rejects.toMatchObject({ code: "PCE01" });
    await addProof(task, "test", { ok: true, scopeVersion: 1, requirementKeys: ["R1"] }, { attempt: 1, token: 2, worker: "worker" });
    expect((await finish(task, 2)).rows).toEqual([{ ok: true }]);
  });

  it("keeps historical proof rows while a fresh check completes the new generation", async () => {
    await addProof();
    await db.query("UPDATE purama_ai.chef_tasks SET attempt=2,fencing_token=2 WHERE id=$1", [task]);
    await addProof(task, "test", { ok: true, scopeVersion: 1, requirementKeys: ["R1"] }, { attempt: 2, token: 2, worker: "worker" });
    expect((await finish(task, 2)).rows).toEqual([{ ok: true }]);
    expect(await missing()).toEqual([]);
    expect((await db.query("SELECT attempt FROM purama_ai.chef_evidence ORDER BY attempt")).rows)
      .toEqual([{ attempt: 1 }, { attempt: 2 }]);
  });

  it("requires a fresh independent review for the critical review task's current generation", async () => {
    await db.query("UPDATE purama_ai.chef_requirements SET critical=true WHERE id=$1", [requirement]);
    await addProof();
    await addProof(review, "review");
    await finish();
    await db.query("UPDATE purama_ai.chef_tasks SET state='verified_done',attempt=2,fencing_token=2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [review]);
    expect(await missing()).toEqual(["R1"]);
    await db.query("UPDATE purama_ai.chef_tasks SET state='verifying',lease_owner='worker',lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [review]);
    await addProof(review, "review", { ok: true, scopeVersion: 1, requirementKeys: ["R1"] }, { attempt: 2, token: 2, worker: "worker" });
    await finish(review, 2);
    expect(await missing()).toEqual([]);
  });

  it.each([
    { ok: false, scopeVersion: 1, requirementKeys: ["R1"] },
    { ok: true, scopeVersion: 1, requirementKeys: ["OTHER"] },
  ])("does not let freshness bypass success or scope checks %j", async (payload) => {
    await addProof(task, "test", payload);
    await db.query("UPDATE purama_ai.chef_tasks SET state='verified_done',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1", [task]);
    expect(await missing()).toEqual(["R1"]);
  });

  it("applies the claim trigger to direct service-role inserts", async () => {
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO service_role; SET ROLE service_role");
    try {
      await expect(addProof(task, "test", { ok: true }, { attempt: 2, token: 1, worker: "worker" }))
        .rejects.toMatchObject({ code: "PCE01" });
      await addProof();
    } finally {
      await db.exec("RESET ROLE");
    }
    expect((await db.query("SELECT id FROM purama_ai.chef_evidence")).rows).toHaveLength(1);
  });

  it("rolls back every row of a batch when one row carries a stale claim", async () => {
    await expect(db.query(`INSERT INTO purama_ai.chef_evidence(task_id,kind,payload,attempt,fencing_token,worker_id)
      VALUES($1,'test','{"ok":true}',1,1,'worker'),($1,'test','{"ok":true}',1,2,'worker')`, [task]))
      .rejects.toMatchObject({ code: "PCE01" });
    expect((await db.query("SELECT id FROM purama_ai.chef_evidence")).rows).toHaveLength(0);
  });

  it("preserves pre-migration rows without certifying them as current evidence", async () => {
    const legacy = new PGlite();
    try {
      await legacy.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';
        CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;`);
      for (const file of [
        "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
        "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
        "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "016_chef_scoped_evidence.sql",
      ]) {
        await legacy.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
      }
      await legacy.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
      await legacy.query("INSERT INTO purama_ai.chef_missions(id,user_id,brief_id,brief_hash,goal,repo,state) VALUES($1,$2,'legacy',$3,'goal','repo','active')", [mission, uid, "a".repeat(64)]);
      await legacy.query("INSERT INTO purama_ai.chef_requirements(id,mission_id,requirement_key,description,critical) VALUES($1,$2,'R1','legacy',false)", [requirement, mission]);
      await legacy.query("INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash,attempt,fencing_token,access_mode,verification_profiles) VALUES($1,$2,'legacy','legacy','legacy','verified_done',$3,1,1,'read',ARRAY['acceptance'])", [task, mission, "a".repeat(64)]);
      await legacy.query("INSERT INTO purama_ai.chef_task_requirements VALUES($1,$2)", [task, requirement]);
      await legacy.query(`INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload)
        VALUES($1,$2,'test','{"ok":true,"scopeVersion":1,"requirementKeys":["R1"]}')`, [task, requirement]);
      expect((await legacy.query("SELECT * FROM purama_ai.chef_missing_requirements($1)", [mission])).rows).toHaveLength(0);
      await legacy.exec(await readFile(new URL("../migrations/017_chef_evidence_generation.sql", import.meta.url), "utf8"));
      expect((await legacy.query("SELECT attempt,fencing_token,worker_id FROM purama_ai.chef_evidence")).rows)
        .toEqual([{ attempt: null, fencing_token: null, worker_id: null }]);
      expect((await legacy.query("SELECT * FROM purama_ai.chef_missing_requirements($1)", [mission])).rows).toHaveLength(1);
      await legacy.query("UPDATE purama_ai.chef_tasks SET state='verifying',lease_owner='worker',lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1", [task]);
      await expect(legacy.query("SELECT purama_ai.chef_transition_task($1,'worker',1,'verified_done')", [task]))
        .rejects.toThrow(/requires.*evidence/i);
    } finally {
      await legacy.close();
    }
  });
});
