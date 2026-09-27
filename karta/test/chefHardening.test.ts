import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000301";
const mission1 = "00000000-0000-4000-8000-000000000302";
const mission2 = "00000000-0000-4000-8000-000000000303";
const taskA = "00000000-0000-4000-8000-000000000304";
const taskB = "00000000-0000-4000-8000-000000000305";
const hash = "b".repeat(64);
let db: PGlite;

function first<T extends object>(result: { rows: unknown[] }): T {
  return result.rows[0] as T;
}

async function addMission(id: string, budget?: { tokens?: number; cost?: number }) {
  await db.query(
    `INSERT INTO purama_ai.chef_missions
      (id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel,token_budget,cost_budget_micros)
     VALUES($1,$2,$3,$4,'goal','repo','active',4,$5,$6)`,
    [id, uid, "brief-" + id.slice(-3), hash, budget?.tokens ?? null, budget?.cost ?? null]
  );
}

async function addTask(
  id: string,
  mission: string,
  key: string,
  options: {
    worktree?: string;
    scope?: string;
    access?: "read" | "write";
    estimatedTokens?: number;
    estimatedCost?: number;
  } = {}
) {
  await db.query(
    `INSERT INTO purama_ai.chef_tasks(
       id,mission_id,task_key,title,instructions,state,brief_hash,worktree,scope_key,access_mode,
       estimated_tokens,estimated_cost_micros
     ) VALUES($1,$2,$3,$3,$3,'ready',$4,$5,$6,$7,$8,$9)`,
    [
      id, mission, key, hash,
      options.worktree ?? null,
      options.scope ?? null,
      options.access ?? "write",
      options.estimatedTokens ?? null,
      options.estimatedCost ?? null,
    ]
  );
}

async function heartbeat(worker: string, provider = "codex") {
  await db.query(
    "SELECT purama_ai.chef_heartbeat_worker($1,$2,'test','idle',NULL,NULL,'repo',NULL,NULL,'{}'::jsonb)",
    [worker, provider]
  );
}

async function claim(mission: string, worker: string, provider = "codex") {
  return db.query("SELECT * FROM purama_ai.chef_claim_next_task($1,$2,$3,300)", [mission, worker, provider]);
}

async function transition(task: string, worker: string, token: number, state: string) {
  return db.query(
    "SELECT purama_ai.chef_transition_task($1,$2,$3,$4,NULL,NULL) AS ok",
    [task, worker, token, state]
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
  for (const file of ["008_chef_control_plane.sql", "009_chef_hardening.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE purama_ai.chef_usage_events,
      purama_ai.chef_events,
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
});

describe("PURAMA CHEF operational hardening", () => {
  it("allows only one writer for the same worktree across missions", async () => {
    await addMission(mission1);
    await addMission(mission2);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/shared" });
    await addTask(taskB, mission2, "b", { worktree: "/tmp/shared" });
    await heartbeat("w1");
    await heartbeat("w2");

    const [one, two] = await Promise.all([claim(mission1, "w1"), claim(mission2, "w2")]);
    expect(one.rows.length + two.rows.length).toBe(1);
    const active = await db.query(
      "SELECT count(*)::int AS count FROM purama_ai.chef_tasks WHERE worktree='/tmp/shared' AND state IN ('claimed','running','verifying')"
    );
    expect(first<{ count: number }>(active).count).toBe(1);
  });

  it("allows only one writer for the same logical scope even on different worktrees", async () => {
    await addMission(mission1);
    await addMission(mission2);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/a", scope: "src/payments" });
    await addTask(taskB, mission2, "b", { worktree: "/tmp/b", scope: "src/payments" });
    await heartbeat("w1");
    await heartbeat("w2");

    const [one, two] = await Promise.all([claim(mission1, "w1"), claim(mission2, "w2")]);
    expect(one.rows.length + two.rows.length).toBe(1);
  });

  it("permits parallel read-only work in the same worktree", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/shared", access: "read" });
    await addTask(taskB, mission1, "b", { worktree: "/tmp/shared", access: "read" });
    await heartbeat("w1");
    await heartbeat("w2");

    expect((await claim(mission1, "w1")).rows).toHaveLength(1);
    expect((await claim(mission1, "w2")).rows).toHaveLength(1);
  });

  it("a worker cannot claim a second task while it still owns one", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a");
    await addTask(taskB, mission1, "b");
    await heartbeat("w1");

    expect((await claim(mission1, "w1")).rows).toHaveLength(1);
    expect((await claim(mission1, "w1")).rows).toHaveLength(0);
  });

  it("marks stale workers offline and refuses them new work", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a");
    await heartbeat("w1");
    await db.query(
      "UPDATE purama_ai.chef_workers SET heartbeat_at=now()-interval '10 minutes' WHERE worker_id='w1'"
    );

    const marked = await db.query("SELECT purama_ai.chef_mark_stale_workers(120) AS count");
    expect(first<{ count: number }>(marked).count).toBe(1);
    expect((await claim(mission1, "w1")).rows).toHaveLength(0);
    expect(first<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_workers WHERE worker_id='w1'")
    ).state).toBe("offline");
  });

  it("pauses instead of silently downgrading when the estimated budget is insufficient", async () => {
    await addMission(mission1, { tokens: 100, cost: 1_000 });
    await addTask(taskA, mission1, "a", { estimatedTokens: 101, estimatedCost: 900 });
    await heartbeat("w1");

    expect((await claim(mission1, "w1")).rows).toHaveLength(0);
    expect(first<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [mission1])
    ).state).toBe("paused");
  });

  it("records usage idempotently and never double-charges a replayed event", async () => {
    await addMission(mission1, { tokens: 10_000, cost: 1_000_000 });
    await addTask(taskA, mission1, "a");

    const sql = `SELECT purama_ai.chef_record_usage(
      'usage-event-0001',$1,$2,'w1','codex','model',100,50,25,1200
    ) AS inserted`;
    expect(first<{ inserted: boolean }>(await db.query(sql, [mission1, taskA])).inserted).toBe(true);
    expect(first<{ inserted: boolean }>(await db.query(sql, [mission1, taskA])).inserted).toBe(false);

    const totals = first<{ tokens_used: number; cost_used_micros: number }>(
      await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE id=$1", [mission1])
    );
    expect(Number(totals.tokens_used)).toBe(150);
    expect(Number(totals.cost_used_micros)).toBe(1200);
  });

  it("pauses a mission if actual usage crosses a hard budget", async () => {
    await addMission(mission1, { tokens: 100 });
    await addTask(taskA, mission1, "a");

    await db.query(
      `SELECT purama_ai.chef_record_usage(
        'usage-event-0002',$1,$2,'w1','codex','model',80,30,0,0
      )`,
      [mission1, taskA]
    );
    expect(first<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [mission1])
    ).state).toBe("paused");
  });

  it("continues unrelated ready work while another task needs a human", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a");
    await addTask(taskB, mission1, "b");
    await heartbeat("w1");
    await heartbeat("w2");

    const claimed = first<{ id: string; fencing_token: number }>(await claim(mission1, "w1"));
    await transition(claimed.id, "w1", claimed.fencing_token, "running");
    expect(first<{ ok: boolean }>(
      await transition(claimed.id, "w1", claimed.fencing_token, "blocked_human")
    ).ok).toBe(true);

    expect(first<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [mission1])
    ).state).toBe("human_required");

    expect((await claim(mission1, "w2")).rows).toHaveLength(1);
  });

  it("keeps hardening RPCs inaccessible to authenticated clients", async () => {
    await addMission(mission1);
    await db.exec("GRANT USAGE ON SCHEMA purama_ai TO authenticated; SET ROLE authenticated");
    try {
      await expect(db.query("SELECT purama_ai.chef_mark_stale_workers(120)")).rejects.toThrow(/permission denied/);
      await expect(
        db.query(
          "SELECT purama_ai.chef_record_usage('usage-event-0003',$1,NULL,NULL,'codex','model',1,1,0,0)",
          [mission1]
        )
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
