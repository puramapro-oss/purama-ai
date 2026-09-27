import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const uid = "00000000-0000-4000-8000-000000000301";
const mission1 = "00000000-0000-4000-8000-000000000302";
const mission2 = "00000000-0000-4000-8000-000000000303";
const taskA = "00000000-0000-4000-8000-000000000304";
const taskB = "00000000-0000-4000-8000-000000000305";
const requirement = "00000000-0000-4000-8000-000000000306";
const hash = "b".repeat(64);
let db: PGlite;
const sequences = new Map<string, number>();
const sessions = new Map<string, string>();

function first<T extends object>(result: { rows: unknown[] }): T {
  return result.rows[0] as T;
}

function sessionFor(worker: string): string {
  const existing = sessions.get(worker);
  if (existing) return existing;
  const value = `session-${worker}-0001`;
  sessions.set(worker, value);
  return value;
}

async function addMission(
  id: string,
  budget?: { tokens?: number; cost?: number },
  repo = "repo"
) {
  await db.query(
    `INSERT INTO purama_ai.chef_missions
      (id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel,token_budget,cost_budget_micros)
     VALUES($1,$2,$3,$4,'goal',$7,'active',4,$5,$6)`,
    [id, uid, "brief-" + id.slice(-3), hash, budget?.tokens ?? null, budget?.cost ?? null, repo]
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
    maxAttempts?: number;
  } = {}
) {
  await db.query(
    `INSERT INTO purama_ai.chef_tasks(
       id,mission_id,task_key,title,instructions,state,brief_hash,worktree,scope_key,access_mode,
       estimated_tokens,estimated_cost_micros,max_attempts
     ) VALUES($1,$2,$3,$3,$3,'ready',$4,$5,$6,$7,$8,$9,$10)`,
    [
      id, mission, key, hash,
      options.worktree ?? null,
      options.scope ?? null,
      options.access ?? "write",
      options.estimatedTokens ?? null,
      options.estimatedCost ?? null,
      options.maxAttempts ?? 3,
    ]
  );
}

async function heartbeat(
  worker: string,
  provider = "codex",
  options: {
    repo?: string;
    worktree?: string | null;
    state?: string;
    session?: string;
    sequence?: number;
  } = {}
) {
  const session = options.session ?? sessionFor(worker);
  const nextSequence = options.sequence ?? ((sequences.get(worker) ?? 0) + 1);
  const result = await db.query(
    "SELECT purama_ai.chef_heartbeat_worker($1,$2,'test',$3,$4,$5,NULL,$6,$7,NULL,'{}'::jsonb) AS accepted",
    [
      worker,
      provider,
      options.state ?? "idle",
      session,
      nextSequence,
      options.repo ?? "repo",
      options.worktree ?? null,
    ]
  );
  if (first<{ accepted: boolean }>(result).accepted) {
    sessions.set(worker, session);
    sequences.set(worker, nextSequence);
  }
  return result;
}

async function claim(mission: string, worker: string, provider = "codex", session?: string) {
  return db.query(
    "SELECT * FROM purama_ai.chef_claim_next_task($1,$2,$3,$4,300)",
    [mission, worker, session ?? sessionFor(worker), provider]
  );
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
  for (const file of ["008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  sequences.clear();
  sessions.clear();
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
  it("serializes every task sharing the same moving worktree", async () => {
    await addMission(mission1);
    await addMission(mission2);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/shared", access: "read" });
    await addTask(taskB, mission2, "b", { worktree: "/tmp/shared", access: "write" });
    await heartbeat("w1", "codex", { worktree: "/tmp/shared" });
    await heartbeat("w2", "codex", { worktree: "/tmp/shared" });

    const [one, two] = await Promise.all([claim(mission1, "w1"), claim(mission2, "w2")]);
    expect(one.rows.length + two.rows.length).toBe(1);
  });

  it("serializes the same logical scope even on different worktrees", async () => {
    await addMission(mission1);
    await addMission(mission2);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/a", scope: "repo::src/payments" });
    await addTask(taskB, mission2, "b", { worktree: "/tmp/b", scope: "repo::src/payments" });
    await heartbeat("w1", "codex", { worktree: "/tmp/a" });
    await heartbeat("w2", "codex", { worktree: "/tmp/b" });

    const [one, two] = await Promise.all([claim(mission1, "w1"), claim(mission2, "w2")]);
    expect(one.rows.length + two.rows.length).toBe(1);
  });

  it("allows safe parallel reads only from distinct snapshots/worktrees", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/snapshot-a", access: "read" });
    await addTask(taskB, mission1, "b", { worktree: "/tmp/snapshot-b", access: "read" });
    await heartbeat("w1", "codex", { worktree: "/tmp/snapshot-a" });
    await heartbeat("w2", "codex", { worktree: "/tmp/snapshot-b" });

    expect((await claim(mission1, "w1")).rows).toHaveLength(1);
    expect((await claim(mission1, "w2")).rows).toHaveLength(1);
  });

  it("refuses a task if worker repository/worktree does not match", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a", { worktree: "/tmp/a" });
    await heartbeat("w1", "codex", { repo: "wrong-repo", worktree: "/tmp/a" });
    expect((await claim(mission1, "w1")).rows).toHaveLength(0);

    await db.query("UPDATE purama_ai.chef_workers SET heartbeat_at=now()-interval '3 minutes', state='offline' WHERE worker_id='w1'");
    await heartbeat("w1", "codex", { repo: "repo", worktree: "/tmp/b", session: "session-w1-0002", sequence: 1 });
    expect((await claim(mission1, "w1")).rows).toHaveLength(0);
  });

  it("rejects stale or resurrected worker sessions", async () => {
    await heartbeat("w1");
    const duplicate = await heartbeat("w1", "codex", { sequence: 1 });
    expect(first<{ accepted: boolean }>(duplicate).accepted).toBe(false);

    await db.query("UPDATE purama_ai.chef_workers SET heartbeat_at=now()-interval '3 minutes', state='offline' WHERE worker_id='w1'");
    await heartbeat("w1", "codex", { session: "session-w1-0002", sequence: 1 });

    await expect(
      heartbeat("w1", "codex", { session: "session-w1-0001", sequence: 2 })
    ).rejects.toThrow(/session conflict/i);
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
  });

  it("does not consume the final attempt while waiting for a human", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a", { maxAttempts: 1 });
    await heartbeat("w1");

    const claimed = first<{ id: string; fencing_token: number; attempt: number }>(await claim(mission1, "w1"));
    expect(claimed.attempt).toBe(1);
    await transition(taskA, "w1", claimed.fencing_token, "running");
    await transition(taskA, "w1", claimed.fencing_token, "blocked_human");

    expect(first<{ ok: boolean }>(
      await db.query("SELECT purama_ai.chef_unblock_task($1,'approved') AS ok", [taskA])
    ).ok).toBe(true);

    const task = first<{ state: string; attempt: number }>(
      await db.query("SELECT state,attempt FROM purama_ai.chef_tasks WHERE id=$1", [taskA])
    );
    expect(task).toMatchObject({ state: "ready", attempt: 0 });

    await heartbeat("w1", "codex", { state: "idle" });
    expect((await claim(mission1, "w1")).rows).toHaveLength(1);
  });

  it("fails the mission when the final required attempt dies by lease expiry", async () => {
    await addMission(mission1);
    await addTask(taskA, mission1, "a", { maxAttempts: 1 });
    await heartbeat("w1");
    await claim(mission1, "w1");
    await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [taskA]);

    expect(first<{ count: number }>(
      await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1) AS count", [mission1])
    ).count).toBe(1);

    expect(first<{ state: string }>(
      await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [mission1])
    ).state).toBe("failed");
  });

  it("requires direct proof plus independent review for critical requirements", async () => {
    await addMission(mission1);
    await db.query(
      "INSERT INTO purama_ai.chef_requirements(id,mission_id,requirement_key,description,critical) VALUES($1,$2,'R1','critical',true)",
      [requirement, mission1]
    );
    await addTask(taskA, mission1, "a");
    await db.query(
      "INSERT INTO purama_ai.chef_task_requirements(task_id,requirement_id) VALUES($1,$2)",
      [taskA, requirement]
    );
    await heartbeat("w1");
    const claimed = first<{ fencing_token: number }>(await claim(mission1, "w1"));
    await transition(taskA, "w1", claimed.fencing_token, "running");
    await transition(taskA, "w1", claimed.fencing_token, "verifying");
    await db.query(
      "INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload) VALUES($1,$2,'test','{}'::jsonb)",
      [taskA, requirement]
    );

    await expect(transition(taskA, "w1", claimed.fencing_token, "verified_done"))
      .rejects.toThrow(/review/i);

    await db.query(
      "INSERT INTO purama_ai.chef_evidence(task_id,requirement_id,kind,payload) VALUES($1,$2,'review','{}'::jsonb)",
      [taskA, requirement]
    );
    expect(first<{ ok: boolean }>(
      await transition(taskA, "w1", claimed.fencing_token, "verified_done")
    ).ok).toBe(true);
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

    expect((await claim(mission1, "w2")).rows).toHaveLength(1);
  });

  it("keeps hardening RPCs and audit history inaccessible to authenticated clients", async () => {
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
      await expect(db.query("UPDATE purama_ai.chef_events SET kind='tampered'")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
});
