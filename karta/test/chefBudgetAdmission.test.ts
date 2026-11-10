import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const user = "00000000-0000-4000-8000-000000001801";
const mission = "00000000-0000-4000-8000-000000001802";
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
    "008_chef_control_plane.sql", "009_chef_hardening.sql", "010_chef_reliability.sql",
    "011_chef_runtime_policy.sql", "012_chef_mission_ingest.sql", "013_chef_independent_review.sql",
    "014_chef_file_ownership.sql", "015_chef_mission_file_ownership.sql", "016_chef_scoped_evidence.sql",
    "017_chef_evidence_generation.sql",
    ...(process.env.CHEF_BUDGET_BASELINE === "1" ? [] : ["021_chef_budget_admission.sql"]),
  ]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("TRUNCATE purama_ai.chef_workers, auth.users CASCADE");
  await db.query("INSERT INTO auth.users(id) VALUES($1)", [user]);
  await db.query(`INSERT INTO purama_ai.chef_missions
    (id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel,cost_budget_micros)
    VALUES($1,$2,'budget',$3,'goal','repo','active',4,100)`, [mission, user, hash]);
});

async function addTask(key: string, options: {
  cost?: number | string | null; tokens?: number | null; priority?: number;
  provider?: string; worktree?: string; scope?: string;
} = {}) {
  const result = await db.query<{ id: string }>(`INSERT INTO purama_ai.chef_tasks
    (mission_id,task_key,title,instructions,state,brief_hash,access_mode,
     estimated_tokens,estimated_cost_micros,priority,provider,worktree,scope_key,verification_profiles)
    VALUES($1,$2,$2,$2,'ready',$3,'read',$4,$5,$6,$7,$8,$9,ARRAY['acceptance']) RETURNING id`,
  [mission, key, hash, options.tokens ?? null, options.cost ?? null,
    options.priority ?? 0, options.provider ?? "auto", options.worktree ?? null, options.scope ?? null]);
  return result.rows[0].id;
}
async function worker(id: string, provider = "codex", worktree: string | null = null) {
  await db.query(`SELECT purama_ai.chef_heartbeat_worker
    ($1,$2,'test','idle',$3,1,NULL,'repo',$4,NULL,'{}'::jsonb)`,
  [id, provider, `session-${id}`, worktree]);
}
async function claim(id: string, provider = "codex", session = `session-${id}`, lease: number | null = 300) {
  return (await db.query<{ id: string }>(
    "SELECT id FROM purama_ai.chef_claim_next_task($1,$2,$3,$4,$5)",
    [mission, id, session, provider, lease])).rows.map(row => row.id);
}
async function missionState() {
  return (await db.query<{ state: string }>("SELECT state FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows[0].state;
}

describe("CHEF cumulative estimated-budget admission", () => {
  it("reserves 70 before admitting another 70 against a shared budget of 100", async () => {
    const a = await addTask("a", { cost: 70, priority: 2 });
    await addTask("b", { cost: 70 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toEqual([a]);
    expect(await claim("second")).toEqual([]);
    expect(await missionState()).toBe("active");
    expect((await db.query("SELECT kind FROM purama_ai.chef_events WHERE kind='budget_blocked'")).rows).toEqual([]);
  });

  it("admits two estimates that exactly fit the remaining shared budget", async () => {
    const a = await addTask("a", { cost: 70, priority: 2 });
    const b = await addTask("b", { cost: 30 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toEqual([a]);
    expect(await claim("second")).toEqual([b]);
  });

  it("also reserves token estimates when the currency budget is unlimited", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET token_budget=100,cost_budget_micros=NULL WHERE id=$1", [mission]);
    await addTask("a", { tokens: 70 }); await addTask("b", { tokens: 70 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toHaveLength(1);
    expect(await claim("second")).toEqual([]);
  });

  it("requires both the cost and token dimensions to fit", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET token_budget=100 WHERE id=$1", [mission]);
    const a = await addTask("a", { cost: 70, tokens: 20, priority: 2 });
    await addTask("b", { cost: 20, tokens: 90 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toEqual([a]);
    expect(await claim("second")).toEqual([]);
  });

  it("adds already-consumed cost to all active estimates", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET cost_used_micros=20 WHERE id=$1", [mission]);
    const a = await addTask("a", { cost: 60, priority: 2 });
    await addTask("b", { cost: 30 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toEqual([a]);
    expect(await claim("second")).toEqual([]);
  });

  it("selects an affordable task when a higher-priority one does not fit", async () => {
    await addTask("running", { cost: 70, priority: 10 });
    await addTask("expensive", { cost: 70, priority: 9 });
    const cheap = await addTask("cheap", { cost: 30, priority: 1 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toHaveLength(1);
    expect(await claim("second")).toEqual([cheap]);
  });

  it.each(["cost", "tokens"])("refuses an unknown %s estimate under a configured budget", async (dimension) => {
    if (dimension === "tokens") await db.query("UPDATE purama_ai.chef_missions SET token_budget=100,cost_budget_micros=NULL WHERE id=$1", [mission]);
    await addTask("unknown"); await worker("first");
    expect(await claim("first")).toEqual([]);
    expect(await missionState()).toBe("paused");
  });

  it("preserves unbounded legacy missions without estimates", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET cost_budget_micros=NULL WHERE id=$1", [mission]);
    const a = await addTask("unknown"); await worker("first");
    expect(await claim("first")).toEqual([a]);
  });

  it("distinguishes an explicit zero estimate from an absent estimate", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET cost_budget_micros=0,token_budget=0 WHERE id=$1", [mission]);
    const a = await addTask("zero", { cost: 0, tokens: 0 }); await worker("first");
    expect(await claim("first")).toEqual([a]);
  });

  it("does not treat an active legacy task with missing cost as free capacity", async () => {
    const old = await addTask("old");
    await db.query("UPDATE purama_ai.chef_tasks SET state='running' WHERE id=$1", [old]);
    await addTask("new", { cost: 1 }); await worker("first");
    expect(await claim("first")).toEqual([]);
    expect(await missionState()).toBe("active");
  });

  it("keeps the full current estimate despite cumulative usage from an older attempt", async () => {
    const a = await addTask("retry", { cost: 70, priority: 2 });
    await db.query("UPDATE purama_ai.chef_tasks SET attempt=1,cost_used_micros=50 WHERE id=$1", [a]);
    await addTask("other", { cost: 40 });
    await worker("first"); await worker("second");
    expect(await claim("first")).toEqual([a]);
    expect(await claim("second")).toEqual([]);
  });

  it("releases admission capacity after verified completion, retaining actual recorded usage", async () => {
    const a = await addTask("a", { cost: 70, priority: 2 });
    const b = await addTask("b", { cost: 70 });
    await worker("first"); await worker("second");
    await claim("first");
    expect(await claim("second")).toEqual([]);
    await db.query("SELECT purama_ai.chef_transition_task($1,'first',1,'running')", [a]);
    await db.query("SELECT purama_ai.chef_record_usage('usage-budget-a',$1,$2,'first','codex','test',0,0,0,20)", [mission, a]);
    await db.query("SELECT purama_ai.chef_transition_task($1,'first',1,'verifying')", [a]);
    await db.query(`INSERT INTO purama_ai.chef_evidence(task_id,kind,payload,attempt,fencing_token,worker_id)
      VALUES($1,'test','{"ok":true}'::jsonb,1,1,'first')`, [a]);
    await db.query("SELECT purama_ai.chef_transition_task($1,'first',1,'verified_done')", [a]);
    expect(await claim("second")).toEqual([b]);
  });

  it("does not pause affordable work assigned to another provider", async () => {
    await addTask("expensive-codex", { cost: 101, provider: "codex" });
    const b = await addTask("affordable-claude", { cost: 20, provider: "claude" });
    await worker("codex-worker"); await worker("claude-worker", "claude");
    expect(await claim("codex-worker")).toEqual([]);
    expect(await missionState()).toBe("active");
    expect(await claim("claude-worker", "claude")).toEqual([b]);
  });

  it("preserves worker-session, worktree and max_parallel admission restrictions", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET max_parallel=1 WHERE id=$1", [mission]);
    await addTask("foreign-tree", { cost: 1, worktree: "/other", priority: 10 });
    // Keep the expected candidate explicit even when insertion timestamps tie.
    const a = await addTask("local", { cost: 1, worktree: "/mine", priority: 1 });
    await addTask("another", { cost: 1 });
    await worker("first", "codex", "/mine"); await worker("second");
    expect(await claim("first", "codex", "wrong-session")).toEqual([]);
    expect(await claim("first")).toEqual([a]);
    expect(await claim("second")).toEqual([]);
  });

  it("does not overflow bigint while deciding that an estimate exceeds remaining capacity", async () => {
    await db.query("UPDATE purama_ai.chef_missions SET cost_budget_micros=9223372036854775807,cost_used_micros=1 WHERE id=$1", [mission]);
    await addTask("huge", { cost: "9223372036854775807" }); await worker("first");
    expect(await claim("first")).toEqual([]);
  });

  it("rejects a null lease and keeps the claim RPC server-only", async () => {
    await addTask("task", { cost: 1 }); await worker("first");
    await expect(claim("first", "codex", "session-first", null)).rejects.toThrow(/Invalid lease/);
    const grants = await db.query("SELECT has_function_privilege('authenticated','purama_ai.chef_claim_next_task(uuid,text,text,text,integer)','EXECUTE') AS client, has_function_privilege('service_role','purama_ai.chef_claim_next_task(uuid,text,text,text,integer)','EXECUTE') AS server");
    expect(grants.rows).toEqual([{ client: false, server: true }]);
  });

  it("can reapply the additive migration without changing existing claims", async () => {
    const a = await addTask("a", { cost: 70 }); await worker("first");
    expect(await claim("first")).toEqual([a]);
    await db.exec(await readFile(new URL("../migrations/021_chef_budget_admission.sql", import.meta.url), "utf8"));
    expect((await db.query("SELECT state,attempt FROM purama_ai.chef_tasks WHERE id=$1", [a])).rows)
      .toEqual([{ state: "claimed", attempt: 1 }]);
  });
});
