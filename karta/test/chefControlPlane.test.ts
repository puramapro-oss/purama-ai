import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000201";
const mission = "00000000-0000-4000-8000-000000000202";
const taskA = "00000000-0000-4000-8000-000000000203";
const taskB = "00000000-0000-4000-8000-000000000204";
const taskC = "00000000-0000-4000-8000-000000000205";
const requirement = "00000000-0000-4000-8000-000000000206";
const hash = "a".repeat(64);

let db: PGlite;

function row<T extends object>(result: { rows: unknown[] }): T {
  return result.rows[0] as T;
}

async function heartbeat(worker: string, provider = "codex") {
  await db.query(
    "SELECT purama_ai.chef_heartbeat_worker($1,$2,'test-model','idle',NULL,NULL,'repo',NULL,NULL,'{}'::jsonb)",
    [worker, provider]
  );
}

async function claim(worker: string, provider = "codex") {
  return db.query(
    "SELECT * FROM purama_ai.chef_claim_next_task($1,$2,$3,300)",
    [mission, worker, provider]
  );
}

async function transition(taskId: string, worker: string, token: number, state: string) {
  return db.query(
    "SELECT purama_ai.chef_transition_task($1,$2,$3,$4,NULL,NULL) AS ok",
    [taskId, worker, token, state]
  );
}

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
  await db.exec(await readFile(new URL("../migrations/008_chef_control_plane.sql", import.meta.url), "utf8"));
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE purama_ai.chef_events,
      purama_ai.chef_evidence,
      purama_ai.chef_task_requirements,
      purama_ai.chef_task_dependencies,
      purama_ai.chef_workers,
      purama_ai.chef_tasks,
      purama_ai.chef_requirements,
      purama_ai.chef_missions,
      auth.users CASCADE;
  `);
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [uid]);
  await db.query(
    `INSERT INTO purama_ai.chef_missions
      (id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel)
      VALUES($1,$2,'brief-1',$3,'goal','repo','active',4)`,
    [mission, uid, hash]
  );
});

describe("PURAMA CHEF durable control plane", () => {
  it("claims one task at most once under concurrent workers", async () => {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash)
       VALUES($1,$2,'a','A','do A','ready',$3)`,
      [taskA, mission, hash]
    );
    const workers = Array.from({ length: 12 }, (_, i) => `w-${i}`);
    for (const worker of workers) await heartbeat(worker);

    const results = await Promise.all(workers.map(worker => claim(worker)));
    const claimed = results.filter(result => result.rows.length === 1);
    expect(claimed).toHaveLength(1);

    const task = row<{ state: string; fencing_token: number; attempt: number }>(
      await db.query("SELECT state,fencing_token,attempt FROM purama_ai.chef_tasks WHERE id=$1", [taskA])
    );
    expect(task).toMatchObject({ state: "claimed", fencing_token: 1, attempt: 1 });
  });

  it("never releases a dependent task before its dependency is verified", async () => {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash) VALUES
       ($1,$3,'a','A','do A','ready',$4),
       ($2,$3,'b','B','do B','pending',$4)`,
      [taskA, taskB, mission, hash]
    );
    await db.query(
      "INSERT INTO purama_ai.chef_task_dependencies(task_id,depends_on_task_id) VALUES($1,$2)",
      [taskB, taskA]
    );
    await heartbeat("w-a");
    const first = row<{ fencing_token: number }>(await claim("w-a"));
    expect((await db.query("SELECT state FROM purama_ai.chef_tasks WHERE id=$1", [taskB])).rows[0]).toEqual({ state: "pending" });

    expect(row<{ ok: boolean }>(await transition(taskA, "w-a", first.fencing_token, "running")).ok).toBe(true);
    expect(row<{ ok: boolean }>(await transition(taskA, "w-a", first.fencing_token, "verifying")).ok).toBe(true);
    await db.query(
      "INSERT INTO purama_ai.chef_evidence(task_id,kind,payload) VALUES($1,'test','{}'::jsonb)",
      [taskA]
    );
    expect(row<{ ok: boolean }>(await transition(taskA, "w-a", first.fencing_token, "verified_done")).ok).toBe(true);

    const dependent = row<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_tasks WHERE id=$1", [taskB])
    );
    expect(dependent.state).toBe("ready");
  });

  it("refuses VERIFIED_DONE without evidence", async () => {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash)
       VALUES($1,$2,'a','A','do A','ready',$3)`,
      [taskA, mission, hash]
    );
    await heartbeat("w-a");
    const claimed = row<{ fencing_token: number }>(await claim("w-a"));
    await transition(taskA, "w-a", claimed.fencing_token, "running");
    await transition(taskA, "w-a", claimed.fencing_token, "verifying");

    await expect(transition(taskA, "w-a", claimed.fencing_token, "verified_done"))
      .rejects.toThrow(/requires evidence/);

    expect(row<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_tasks WHERE id=$1", [taskA])
    ).state).toBe("verifying");
  });

  it("fencing token rejects a stale worker after lease expiry and reclaim", async () => {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash)
       VALUES($1,$2,'a','A','do A','ready',$3)`,
      [taskA, mission, hash]
    );
    await heartbeat("old-worker");
    const first = row<{ fencing_token: number }>(await claim("old-worker"));
    await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [taskA]);
    await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1)", [mission]);

    await heartbeat("new-worker");
    const second = row<{ fencing_token: number }>(await claim("new-worker"));
    expect(second.fencing_token).toBeGreaterThan(first.fencing_token);

    expect(row<{ ok: boolean }>(
      await transition(taskA, "old-worker", first.fencing_token, "running")
    ).ok).toBe(false);
    expect(row<{ ok: boolean }>(
      await transition(taskA, "new-worker", second.fencing_token, "running")
    ).ok).toBe(true);
  });

  it("rejects dependency cycles before they enter the DAG", async () => {
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash) VALUES
       ($1,$4,'a','A','A','pending',$5),
       ($2,$4,'b','B','B','pending',$5),
       ($3,$4,'c','C','C','pending',$5)`,
      [taskA, taskB, taskC, mission, hash]
    );
    await db.query("INSERT INTO purama_ai.chef_task_dependencies VALUES($1,$2)", [taskB, taskA]);
    await db.query("INSERT INTO purama_ai.chef_task_dependencies VALUES($1,$2)", [taskC, taskB]);
    await expect(
      db.query("INSERT INTO purama_ai.chef_task_dependencies VALUES($1,$2)", [taskA, taskC])
    ).rejects.toThrow(/cycle/i);
  });

  it("finishes a mission only when required work and requirement evidence are complete", async () => {
    await db.query(
      "INSERT INTO purama_ai.chef_requirements(id,mission_id,requirement_key,description) VALUES($1,$2,'R1','must work')",
      [requirement, mission]
    );
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash)
       VALUES($1,$2,'a','A','do A','ready',$3)`,
      [taskA, mission, hash]
    );
    await db.query(
      "INSERT INTO purama_ai.chef_task_requirements(task_id,requirement_id) VALUES($1,$2)",
      [taskA, requirement]
    );

    expect(row<{ done: boolean }>(
      await db.query("SELECT purama_ai.chef_try_finish_mission($1) AS done", [mission])
    ).done).toBe(false);

    await heartbeat("w-a");
    const claimed = row<{ fencing_token: number }>(await claim("w-a"));
    await transition(taskA, "w-a", claimed.fencing_token, "running");
    await transition(taskA, "w-a", claimed.fencing_token, "verifying");
    await db.query(
      "INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload) VALUES($1,$2,'test','{}'::jsonb)",
      [taskA, requirement]
    );
    await transition(taskA, "w-a", claimed.fencing_token, "verified_done");

    expect(row<{ done: boolean }>(
      await db.query("SELECT purama_ai.chef_try_finish_mission($1) AS done", [mission])
    ).done).toBe(true);
    expect(row<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [mission])
    ).state).toBe("verified_done");
  });

  it("respects mission max_parallel even if many workers are available", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET max_parallel=1 WHERE id=$1", [mission]);
    await db.query(
      `INSERT INTO purama_ai.chef_tasks(id,mission_id,task_key,title,instructions,state,brief_hash) VALUES
       ($1,$3,'a','A','A','ready',$4),
       ($2,$3,'b','B','B','ready',$4)`,
      [taskA, taskB, mission, hash]
    );
    await heartbeat("w-a");
    await heartbeat("w-b");
    expect((await claim("w-a")).rows).toHaveLength(1);
    expect((await claim("w-b")).rows).toHaveLength(0);
  });

  it("keeps the control plane server-only", async () => {
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    try {
      await expect(db.query("SELECT * FROM purama_ai.chef_missions")).rejects.toThrow(/permission denied/);
      await expect(
        db.query("SELECT * FROM purama_ai.chef_claim_next_task($1,'evil','codex',300)", [mission])
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
