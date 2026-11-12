import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const owner = "00000000-0000-4000-8000-000000003101";
const other = "00000000-0000-4000-8000-000000003102";
const instance = "00000000-0000-4000-8000-000000003103";
const secondInstance = "00000000-0000-4000-8000-000000003104";
const configHash = "a".repeat(64);
const requestHash = "b".repeat(64);
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec([
    "CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);",
    "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';",
    "CREATE SCHEMA purama_ai;",
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    "GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;",
  ].join(" "));
  for (const file of [
    "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
    "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
    "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "016_chef_scoped_evidence.sql",
    "017_chef_evidence_generation.sql", "021_chef_budget_admission.sql", "022_chef_mission_estimates.sql",
    "023_chef_process_quarantine.sql", "024_chef_claim_budget_reconciliation.sql", "030_chef_workshop.sql",
  ]) await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.chef_workshop_runtimes, purama_ai.chef_process_quarantines, purama_ai.chef_workers, auth.users CASCADE");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, other]);
});

async function heartbeat(id = instance, online = true, project = "example", hash = configHash) {
  return (await db.query<{ ok: boolean }>(
    "SELECT purama_ai.chef_workshop_heartbeat($1,$2,$3,$4) AS ok", [project, id, hash, online])).rows[0].ok;
}
function brief(requestId: string, project: string) {
  return {
    briefId: "workshop:" + project + ":" + requestId, version: 1, goal: "Build a tested project", repo: "owner/" + project,
    requirements: [{ key: "PRODUCT", description: "Working product", critical: true }],
    tasks: [
      { key: "build", title: "Build", instructions: "Build and test", provider: "codex", accessMode: "write",
        scopeKey: "workshop:" + project, worktree: "/workshop/" + project, allowedPaths: ["src"],
        requirementKeys: ["PRODUCT"], verificationProfiles: ["unit"], estimatedTokens: 10, maxAttempts: 3 },
      { key: "review", title: "Review", instructions: "Review independently", provider: "codex", accessMode: "read",
        worktree: "/workshop/" + project, requirementKeys: ["PRODUCT"], verificationProfiles: ["review"],
        dependsOn: ["build"], estimatedTokens: 10, maxAttempts: 3 },
    ],
  };
}
async function submit(options: { requestId?: string; project?: string; user?: string; hash?: string; runtimeHash?: string } = {}) {
  const id = options.requestId ?? randomUUID();
  const project = options.project ?? "example";
  const value = brief(id, project);
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return (await db.query<{ id: string }>(
    "SELECT purama_ai.chef_workshop_submit($1,$2,$3,$4,$5,$6::jsonb,$7,2,100,NULL) AS id",
    [options.user ?? owner, project, id, options.hash ?? requestHash, options.runtimeHash ?? configHash, JSON.stringify(value), hash],
  )).rows[0].id;
}
async function cancel(id: string, user = owner) {
  return (await db.query<{ ok: boolean }>("SELECT purama_ai.chef_workshop_cancel($1,$2) AS ok", [user,id])).rows[0].ok;
}
async function finishCancel(id: string) {
  return (await db.query<{ ok: boolean }>("SELECT purama_ai.chef_workshop_finish_cancel($1) AS ok", [id])).rows[0].ok;
}
async function openRun() {
  await heartbeat();
  return submit();
}
async function claimed(mission: string) {
  const worker = "test-" + randomUUID();
  const session = "session-" + worker;
  await db.query("SELECT purama_ai.chef_heartbeat_worker($1,'codex','test','idle',$2,1,NULL,'owner/example','/workshop/example',NULL,'{}'::jsonb)", [worker,session]);
  const task = (await db.query<{ id: string; fencing_token: number; attempt: number }>(
    "SELECT id,fencing_token,attempt FROM purama_ai.chef_claim_next_task($1,$2,$3,'codex',300)",
    [mission,worker,session])).rows[0];
  expect(task?.id).toBeTruthy();
  return { ...task, worker, session };
}
async function transition(task: Awaited<ReturnType<typeof claimed>>, target = "retryable") {
  return (await db.query<{ ok: boolean }>("SELECT purama_ai.chef_transition_task($1,$2,$3,$4) AS ok",
    [task.id,task.worker,task.fencing_token,target])).rows[0].ok;
}
async function runRows() {
  return (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM purama_ai.chef_workshop_runs")).rows[0].n;
}

describe("workshop durable admission", () => {
  it("requires an online, matching and fresh consumer before creating a mission", async () => {
    await expect(submit()).rejects.toMatchObject({ code: "PW503" });
    expect(await runRows()).toBe(0);
    await heartbeat();
    await expect(submit({ runtimeHash: "c".repeat(64) })).rejects.toMatchObject({ code: "PW503" });
    await heartbeat(instance, false);
    await expect(submit()).rejects.toMatchObject({ code: "PW503" });
    await heartbeat();
    await db.exec("UPDATE purama_ai.chef_workshop_runtimes SET heartbeat_at=clock_timestamp()-interval '21 seconds'");
    await expect(submit()).rejects.toMatchObject({ code: "PW503" });
    expect(await runRows()).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_missions")).rows).toEqual([{ n: 0 }]);
  });

  it("persists one canonical mission and survives retries even when the consumer goes offline", async () => {
    await heartbeat();
    const requestId = randomUUID();
    const id = await submit({requestId});
    await heartbeat(instance, false);
    expect(await submit({requestId})).toBe(id);
    expect(await runRows()).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_tasks")).rows).toEqual([{ n: 2 }]);
  });

  it("rejects reusing an idempotency key for different content or a different project", async () => {
    await heartbeat();
    const requestId = randomUUID();
    await submit({requestId});
    await expect(submit({requestId,hash:"c".repeat(64)})).rejects.toMatchObject({ code: "PW409" });
    await expect(submit({requestId,project:"different"})).rejects.toMatchObject({ code: "PW409" });
    expect(await runRows()).toBe(1);
  });

  it("scopes idempotency to the user and permits independent authorized projects", async () => {
    await heartbeat();
    await heartbeat(instance,true,"second");
    const requestId = randomUUID();
    const first = await submit({requestId});
    const second = await submit({requestId,project:"second",user:other});
    expect(second).not.toBe(first);
    expect(await runRows()).toBe(2);
  });

  it("admits only one unfinished mission per registered workspace", async () => {
    const first = await openRun();
    await expect(submit()).rejects.toMatchObject({ code: "PW423" });
    await expect(submit({user:other})).rejects.toMatchObject({ code: "PW423" });
    expect(await runRows()).toBe(1);
    expect((await db.query("SELECT mission_id FROM purama_ai.chef_workshop_runs")).rows).toEqual([{ mission_id:first }]);
  });

  it("releases a never-started cancelled mission and permits the next admission", async () => {
    const first = await openRun();
    expect(await cancel(first)).toBe(true);
    expect(await finishCancel(first)).toBe(true);
    const next = await submit();
    expect(next).not.toBe(first);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_workshop_runs WHERE finished_at IS NULL")).rows).toEqual([{ n:1 }]);
  });

  it("enforces a durable per-user hourly start quota while keeping cancel and idempotent replay available", async () => {
    await heartbeat();
    const ids: { mission: string; requestId: string }[] = [];
    for (let i=0; i<10; i++) {
      const requestId = randomUUID();
      const mission = await submit({requestId});
      ids.push({mission,requestId});
      expect(await cancel(mission)).toBe(true);
      expect(await finishCancel(mission)).toBe(true);
    }
    await expect(submit()).rejects.toMatchObject({ code: "PW429" });
    expect(await submit({requestId:ids[0].requestId})).toBe(ids[0].mission);
    expect(await cancel(ids[0].mission)).toBe(true);
    expect(await runRows()).toBe(10);
    await db.exec("UPDATE purama_ai.chef_workshop_runs SET created_at=clock_timestamp()-interval '61 minutes'");
    expect(await submit()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("executes the intended admission/cancellation flow with service_role permissions", async () => {
    await db.exec("SET ROLE service_role");
    try {
      expect(await heartbeat()).toBe(true);
      const id = await submit();
      expect(await cancel(id)).toBe(true);
      expect(await finishCancel(id)).toBe(true);
      expect(await runRows()).toBe(1);
    } finally { await db.exec("RESET ROLE"); }
  });

  it("keeps server-only admission, runtime registration and history inaccessible to ordinary users", async () => {
    await heartbeat();
    await db.exec("SET ROLE authenticated");
    try {
      await expect(submit()).rejects.toMatchObject({ code:"42501" });
      await expect(heartbeat()).rejects.toMatchObject({ code:"42501" });
      await expect(db.query("SELECT * FROM purama_ai.chef_workshop_runs")).rejects.toMatchObject({ code:"42501" });
    } finally { await db.exec("RESET ROLE"); }
  });
});

describe("workshop runtime lease", () => {
  it("rejects a second live instance and does not allow it to switch the owner offline", async () => {
    expect(await heartbeat()).toBe(true);
    expect(await heartbeat(secondInstance)).toBe(false);
    expect(await heartbeat(secondInstance,false)).toBe(false);
    expect((await db.query("SELECT instance_id,online FROM purama_ai.chef_workshop_runtimes")).rows).toEqual([{instance_id:instance,online:true}]);
  });
  it("allows takeover only after expiry and rejects late heartbeats from the old owner", async () => {
    await heartbeat();
    await db.exec("UPDATE purama_ai.chef_workshop_runtimes SET heartbeat_at=clock_timestamp()-interval '61 seconds'");
    expect(await heartbeat(secondInstance)).toBe(true);
    expect(await heartbeat(instance)).toBe(false);
    expect(await heartbeat(instance,false)).toBe(false);
    expect(await heartbeat(secondInstance,false)).toBe(true);
  });
});

describe("workshop cancellation and retained process scopes", () => {
  it("does not reveal or mutate another user's mission through cancellation", async () => {
    const id = await openRun();
    expect(await cancel(id,other)).toBe(false);
    expect(await cancel(randomUUID(),other)).toBe(false);
    expect((await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1",[id])).rows).toEqual([{ state:"active" }]);
    expect((await db.query("SELECT cancel_requested_at FROM purama_ai.chef_workshop_runs")).rows).toEqual([{ cancel_requested_at:null }]);
  });

  it("keeps an active generation, lease and reservation intact when stop is requested", async () => {
    const id = await openRun();
    const task = await claimed(id);
    expect(await transition(task,"running")).toBe(true);
    expect(await cancel(id)).toBe(true);
    expect(await finishCancel(id)).toBe(false);
    expect((await db.query("SELECT state,lease_owner,fencing_token,attempt FROM purama_ai.chef_tasks WHERE id=$1",[task.id])).rows)
      .toMatchObject([{state:"running",lease_owner:task.worker,fencing_token:task.fencing_token,attempt:task.attempt}]);
    expect((await db.query("SELECT finished_at FROM purama_ai.chef_workshop_runs")).rows).toEqual([{finished_at:null}]);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_budget_reservations WHERE task_id=$1",[task.id])).rows).toEqual([{n:1}]);
    expect((await db.query("SELECT id FROM purama_ai.chef_claim_next_task($1,$2,$3,'codex',300)",[id,task.worker,task.session])).rows).toEqual([]);
  });

  it("finalizes only after the same generation records an authorized non-active transition", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await transition(task,"running");
    await cancel(id);
    expect(await transition(task)).toBe(true);
    expect(await finishCancel(id)).toBe(true);
    expect((await db.query("SELECT state FROM purama_ai.chef_tasks WHERE id=$1",[task.id])).rows).toEqual([{state:"cancelled"}]);
    expect((await db.query("SELECT finished_at IS NOT NULL AS done FROM purama_ai.chef_workshop_runs")).rows).toEqual([{done:true}]);
    expect(await submit()).not.toBe(id);
  });

  it("retains a persistent quarantine even after a stop-unconfirmed task leaves active state", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await cancel(id);
    expect((await db.query<{ok:boolean}>("SELECT purama_ai.chef_quarantine_process($1,$2,$3,$4,'stop not confirmed') AS ok",
      [task.id,task.worker,task.fencing_token,task.attempt])).rows[0].ok).toBe(true);
    expect(await transition(task,"blocked_external")).toBe(true);
    expect(await finishCancel(id)).toBe(false);
    await expect(submit()).rejects.toMatchObject({code:"PW423"});
  });

  it("does not mistake an expired lease for proof that the underlying process stopped", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await cancel(id);
    await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[task.id]);
    await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1)",[id]);
    expect(await finishCancel(id)).toBe(false);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.chef_process_quarantines WHERE mission_id=$1",[id])).rows).toEqual([{n:1}]);
  });

  it("rejects a non-active row with no authenticated stop event for its recorded generation", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await cancel(id);
    // Simulates imported/history-repaired state: a state label cannot substitute for a stop receipt.
    await db.query("UPDATE purama_ai.chef_tasks SET state='retryable',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[task.id]);
    expect(await finishCancel(id)).toBe(false);
    await expect(submit()).rejects.toMatchObject({code:"PW423"});
  });

  it("refuses a fabricated attempted task with no matching claim journal", async () => {
    const id = await openRun();
    await cancel(id);
    await db.query("UPDATE purama_ai.chef_tasks SET state='retryable',attempt=1,fencing_token=1 WHERE mission_id=$1 AND task_key='build'",[id]);
    expect(await finishCancel(id)).toBe(false);
  });

  it("requires the latest task fencing generation to be represented in the claim journal", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await transition(task);
    await db.query("UPDATE purama_ai.chef_tasks SET fencing_token=fencing_token+1 WHERE id=$1",[task.id]);
    await cancel(id);
    expect(await finishCancel(id)).toBe(false);
  });

  it("checks every historical generation rather than only the newest successful stop", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await transition(task);
    await db.query("INSERT INTO purama_ai.chef_events(mission_id,task_id,worker_id,kind,payload) VALUES($1,$2,'old-worker','task_claimed',$3::jsonb)",
      [id,task.id,JSON.stringify({fencing_token:99,attempt:99,session_id:"historical"})]);
    await cancel(id);
    expect(await finishCancel(id)).toBe(false);
  });

  it("requires the stop receipt worker and fencing token to match the claim", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await cancel(id);
    await db.query("UPDATE purama_ai.chef_tasks SET state='retryable',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[task.id]);
    await db.query("INSERT INTO purama_ai.chef_events(mission_id,task_id,worker_id,kind,payload) VALUES($1,$2,'different-worker','task_transition',$3::jsonb)",
      [id,task.id,JSON.stringify({from:"running",to:"retryable",fencing_token:task.fencing_token})]);
    expect(await finishCancel(id)).toBe(false);
  });

  it("does not release a failed project's slot when an old process has no authenticated stop proof", async () => {
    const id = await openRun();
    const task = await claimed(id);
    await db.query("UPDATE purama_ai.chef_tasks SET state='failed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[task.id]);
    await db.query("UPDATE purama_ai.chef_missions SET state='failed',finished_at=clock_timestamp() WHERE id=$1",[id]);
    await expect(submit()).rejects.toMatchObject({code:"PW423"});
    expect(await runRows()).toBe(1);
  });
});
