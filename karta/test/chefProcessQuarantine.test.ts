import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const user = "00000000-0000-4000-8000-000000002001";
const hash = "a".repeat(64);
let db: PGlite;
let sequence = 0;

beforeAll(async () => {
  db = new PGlite();
  await db.exec([
    "CREATE SCHEMA auth;",
    "CREATE TABLE auth.users(id uuid PRIMARY KEY);",
    "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid';",
    "CREATE SCHEMA purama_ai;",
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;",
    "GRANT USAGE ON SCHEMA purama_ai TO anon, authenticated, service_role;",
  ].join(" "));
  const migrations = [
    "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
    "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
    "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "016_chef_scoped_evidence.sql",
    "017_chef_evidence_generation.sql", "021_chef_budget_admission.sql",
    "022_chef_mission_estimates.sql", "023_chef_process_quarantine.sql",
  ];
  for (const file of migrations) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.chef_process_quarantines, purama_ai.chef_workers, auth.users CASCADE");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [user]);
});

interface Fixture {
  mission: string;
  task: string;
  worker: string;
  repo: string;
  worktree: string | null;
  fencingToken: number;
  attempt: number;
}
async function addMission(repo: string) {
  const id = randomUUID();
  await db.query("INSERT INTO purama_ai.chef_missions " +
    "(id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel) " +
    "VALUES($1,$2,$5,$3,'quarantine fixture',$4,'active',4)", [id, user, hash, repo, id]);
  return id;
}
async function addTask(mission: string, worktree: string | null, scope: string | null) {
  const id = randomUUID();
  await db.query("INSERT INTO purama_ai.chef_tasks " +
    "(id,mission_id,task_key,title,instructions,state,brief_hash,access_mode,worktree,scope_key," +
    "verification_profiles,allowed_paths,estimated_tokens,estimated_cost_micros) " +
    "VALUES($1,$2,$6,'fixture','fixture','ready',$3,'read',$4,$5,ARRAY['unit'],ARRAY['src'],1,1)",
  [id, mission, hash, worktree, scope, id]);
  return id;
}
async function addWorker(repo: string, worktree: string | null) {
  const id = "quarantine-worker-" + ++sequence;
  await db.query("SELECT purama_ai.chef_heartbeat_worker(" +
    "$1,'codex','test','idle',$2,1,NULL,$3,$4,NULL,'{}'::jsonb)", [id, "session-" + id, repo, worktree]);
  return id;
}
async function claim(mission: string, worker: string) {
  return (await db.query<{ id: string; fencing_token: number; attempt: number }>(
    "SELECT id,fencing_token,attempt FROM purama_ai.chef_claim_next_task($1,$2,$3,'codex',300)",
    [mission, worker, "session-" + worker])).rows;
}
async function fixture(options: { repo?: string; worktree?: string | null; scope?: string | null; workerWorktree?: string | null } = {}): Promise<Fixture> {
  const repo = options.repo ?? "repo-source";
  const worktree = options.worktree === undefined ? "/workspace/source" : options.worktree;
  const scope = options.scope === undefined ? "module/source" : options.scope;
  const mission = await addMission(repo);
  const task = await addTask(mission, worktree, scope);
  const worker = await addWorker(repo, options.workerWorktree === undefined ? worktree : options.workerWorktree);
  const [claimed] = await claim(mission, worker);
  expect(claimed.id).toBe(task);
  const fencingToken = Number(claimed.fencing_token);
  const attempt = claimed.attempt;
  await db.query("SELECT purama_ai.chef_transition_task($1,$2,$3,'running')", [task, worker, fencingToken]);
  return { mission, task, worker, repo, worktree, fencingToken, attempt };
}
async function quarantine(source: Fixture, reason = "stop unconfirmed") {
  return (await db.query<{ ok: boolean }>("SELECT purama_ai.chef_quarantine_process($1,$2,$3,$4,$5) AS ok",
    [source.task, source.worker, source.fencingToken, source.attempt, reason])).rows[0].ok;
}
async function block(source: Fixture) {
  return (await db.query<{ ok: boolean }>("SELECT purama_ai.chef_transition_task($1,$2,$3,'blocked_external','stop unconfirmed') AS ok",
    [source.task, source.worker, source.fencingToken])).rows[0].ok;
}
async function candidate(repo: string, worktree: string | null, scope: string | null) {
  const mission = await addMission(repo);
  const task = await addTask(mission, worktree, scope);
  const worker = await addWorker(repo, worktree);
  return { mission, task, worker };
}

describe("CHEF durable process quarantine on the full migration chain", () => {
  it("records once before releasing active locks and blocks another mission in the same repo", async () => {
    const source = await fixture();
    expect(await quarantine(source)).toBe(true);
    expect(await quarantine(source, "duplicate report")).toBe(true);
    expect(await block(source)).toBe(true);
    const other = await candidate(source.repo, "/workspace/different-tree", "unrelated/scope");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
    expect((await db.query("SELECT reason,global_scope,historical_claim FROM purama_ai.chef_process_quarantines")).rows)
      .toEqual([{ reason: "stop unconfirmed", global_scope: false, historical_claim: false }]);
    expect((await db.query("SELECT state FROM purama_ai.chef_tasks WHERE id=$1", [other.task])).rows)
      .toEqual([{ state: "ready" }]);
  });

  it.each([
    ["/shared", "/shared/child"], ["/shared/child", "/shared"], ["/shared/x/../child/", "/shared/child/sub"],
  ])("excludes overlapping physical scopes across repositories: %s and %s", async (sourcePath, targetPath) => {
    const source = await fixture({ worktree: sourcePath });
    await quarantine(source); await block(source);
    const other = await candidate("other-repo", targetPath, "independent");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });

  it("excludes hierarchical logical scopes across repositories and worktrees", async () => {
    const source = await fixture({ scope: "deployment/prod" });
    await quarantine(source); await block(source);
    const other = await candidate("other-repo", "/different", "deployment/prod/payments");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });

  it("allows unrelated work and treats percent/underscore as literal path characters", async () => {
    const source = await fixture({ worktree: "/shared%_", scope: "literal%_" });
    await quarantine(source); await block(source);
    const other = await candidate("other-repo", "/sharedXYZ", "literalZZ");
    expect((await claim(other.mission, other.worker)).map((row) => row.id)).toEqual([other.task]);
  });

  it("globally quarantines a run without explicit scope even with a registered fallback cwd", async () => {
    const source = await fixture({ worktree: null, scope: null, workerWorktree: "/runtime/default" });
    await quarantine(source); await block(source);
    expect((await db.query("SELECT global_scope,worktree FROM purama_ai.chef_process_quarantines")).rows)
      .toEqual([{ global_scope: true, worktree: "/runtime/default" }]);
    const other = await candidate("entirely-unrelated", "/elsewhere", "elsewhere");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });

  it("quarantines an expired lease before making it blocked, without automatic reclaim", async () => {
    const source = await fixture();
    await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [source.task]);
    expect((await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1) AS changed", [source.mission])).rows)
      .toEqual([{ changed: 1 }]);
    expect((await db.query("SELECT state,lease_owner,attempt FROM purama_ai.chef_tasks WHERE id=$1", [source.task])).rows)
      .toEqual([{ state: "blocked_external", lease_owner: null, attempt: 1 }]);
    expect((await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [source.mission])).rows)
      .toEqual([{ state: "external_required" }]);
    expect((await db.query("SELECT reason FROM purama_ai.chef_process_quarantines")).rows[0])
      .toMatchObject({ reason: expect.stringMatching(/Lease expirée sans confirmation/) });
    await addTask(source.mission, source.worktree, "other-task");
    const replacement = await addWorker(source.repo, source.worktree);
    await expect(claim(source.mission, replacement)).rejects.toMatchObject({ code: "PCQ01" });
    expect((await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1) AS changed", [source.mission])).rows)
      .toEqual([{ changed: 0 }]);
  });

  it("accepts a current expired claim instead of discarding its incident as stale", async () => {
    const source = await fixture();
    await db.query("UPDATE purama_ai.chef_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [source.task]);
    expect(await quarantine(source)).toBe(true);
    expect(await block(source)).toBe(false);
    const other = await candidate(source.repo, "/new", "new");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });

  it("authenticates the historical claim after reassignment and fails closed globally", async () => {
    const source = await fixture();
    await db.query("SELECT purama_ai.chef_transition_task($1,$2,$3,'retryable')", [source.task, source.worker, source.fencingToken]);
    const replacement = await addWorker(source.repo, source.worktree);
    const [next] = await claim(source.mission, replacement);
    expect(Number(next.fencing_token)).toBe(2);
    expect(await quarantine({ ...source, fencingToken: 999 })).toBe(false);
    expect(await quarantine({ ...source, worker: "foreign-worker" })).toBe(false);
    expect(await quarantine(source)).toBe(true);
    expect((await db.query("SELECT worker_id,fencing_token,attempt,historical_claim,global_scope FROM purama_ai.chef_process_quarantines")).rows)
      .toEqual([{ worker_id: source.worker, fencing_token: 1, attempt: 1, historical_claim: true, global_scope: true }]);
    const other = await candidate("other-repo", "/elsewhere", "elsewhere");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });

  it("never clears protection through unblock, old timestamps, or housekeeping", async () => {
    const source = await fixture();
    await quarantine(source); await block(source);
    await db.query("UPDATE purama_ai.chef_process_quarantines SET created_at=clock_timestamp()-interval '365 days'");
    await db.query("SELECT purama_ai.chef_unblock_task($1,'ordinary unblock')", [source.task]);
    await db.query("SELECT purama_ai.chef_requeue_expired_tasks($1)", [source.mission]);
    const replacement = await addWorker(source.repo, source.worktree);
    await expect(claim(source.mission, replacement)).rejects.toMatchObject({ code: "PCQ01" });
    expect((await db.query("SELECT count(*)::integer AS count FROM purama_ai.chef_process_quarantines")).rows).toEqual([{ count: 1 }]);
  });

  it("preserves the incident and its exclusion after mission/task deletion", async () => {
    const source = await fixture();
    await quarantine(source); await block(source);
    await db.query("DELETE FROM purama_ai.chef_missions WHERE id=$1", [source.mission]);
    expect((await db.query("SELECT task_id,mission_id,reason FROM purama_ai.chef_process_quarantines")).rows)
      .toEqual([{ task_id: source.task, mission_id: source.mission, reason: "stop unconfirmed" }]);
    expect(await quarantine(source)).toBe(true);
    const other = await candidate(source.repo, "/new", "new");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });

  it("rejects lease renewal under quarantine while retaining actual usage accounting", async () => {
    const source = await fixture();
    await quarantine(source);
    await expect(db.query("SELECT purama_ai.chef_renew_task_lease($1,$2,$3,300)", [source.task, source.worker, source.fencingToken]))
      .rejects.toMatchObject({ code: "PCQ01" });
    expect((await db.query("SELECT purama_ai.chef_record_usage('usage-quarantine',$1,$2,$3,'codex','test',1,1,0,1) AS ok",
      [source.mission, source.task, source.worker])).rows).toEqual([{ ok: true }]);
  });

  it("cannot certify a task while its process scope remains quarantined", async () => {
    const source = await fixture();
    await db.query("SELECT purama_ai.chef_transition_task($1,$2,$3,'verifying')", [source.task, source.worker, source.fencingToken]);
    await db.query("INSERT INTO purama_ai.chef_evidence(task_id,kind,payload,worker_id,fencing_token,attempt) " +
      "VALUES($1,'test',jsonb_build_object('ok',true),$2,$3,$4)", [source.task, source.worker, source.fencingToken, source.attempt]);
    await quarantine(source);
    await expect(db.query("SELECT purama_ai.chef_transition_task($1,$2,$3,'verified_done')", [source.task, source.worker, source.fencingToken]))
      .rejects.toMatchObject({ code: "PCQ01" });
  });

  it("keeps quarantine and historical claim evidence inaccessible to authenticated clients", async () => {
    const source = await fixture();
    await db.exec("SET ROLE authenticated");
    try {
      await expect(quarantine(source)).rejects.toThrow(/permission denied/i);
      await expect(db.query("SELECT * FROM purama_ai.chef_process_quarantines")).rejects.toThrow(/permission denied/i);
      await expect(db.query("INSERT INTO purama_ai.chef_events(mission_id,task_id,worker_id,kind,payload) " +
        "VALUES($1,$2,'forged','task_claimed','{}'::jsonb)", [source.mission, source.task])).rejects.toThrow(/permission denied/i);
    } finally { await db.exec("RESET ROLE"); }
    expect((await db.query("SELECT " +
      "has_function_privilege('anon','purama_ai.chef_quarantine_process(uuid,text,bigint,integer,text)','EXECUTE') AS anon," +
      "has_function_privilege('authenticated','purama_ai.chef_quarantine_process(uuid,text,bigint,integer,text)','EXECUTE') AS client," +
      "has_function_privilege('service_role','purama_ai.chef_quarantine_process(uuid,text,bigint,integer,text)','EXECUTE') AS server")).rows)
      .toEqual([{ anon: false, client: false, server: true }]);
  });

  it("cannot certify a mission merely because its quarantined task is optional", async () => {
    const source = await fixture();
    await db.query("UPDATE purama_ai.chef_tasks SET required=false WHERE id=$1", [source.task]);
    await quarantine(source); await block(source);
    await expect(db.query("SELECT purama_ai.chef_try_finish_mission($1)", [source.mission]))
      .rejects.toMatchObject({ code: "PCQ01" });
    expect((await db.query("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [source.mission])).rows)
      .toEqual([{ state: "external_required" }]);
  });

  it("allows the service to persist a quarantine but forbids its automatic removal", async () => {
    const source = await fixture();
    await db.exec("SET ROLE service_role");
    try {
      expect(await quarantine(source)).toBe(true);
      await expect(db.query("DELETE FROM purama_ai.chef_process_quarantines")).rejects.toThrow(/permission denied/i);
      await expect(db.query("UPDATE purama_ai.chef_process_quarantines SET reason='cleared'")).rejects.toThrow(/permission denied/i);
      await expect(db.query("TRUNCATE purama_ai.chef_process_quarantines")).rejects.toThrow(/permission denied/i);
    } finally { await db.exec("RESET ROLE"); }
  });

  it("can reapply the additive migration without clearing an existing quarantine", async () => {
    const source = await fixture();
    await quarantine(source); await block(source);
    await db.exec(await readFile(new URL("../migrations/023_chef_process_quarantine.sql", import.meta.url), "utf8"));
    expect((await db.query("SELECT reason FROM purama_ai.chef_process_quarantines")).rows).toEqual([{ reason: "stop unconfirmed" }]);
    const other = await candidate(source.repo, "/new", "new");
    await expect(claim(other.mission, other.worker)).rejects.toMatchObject({ code: "PCQ01" });
  });
});
