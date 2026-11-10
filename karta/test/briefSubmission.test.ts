import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

// Actual migration SQL in one PostgreSQL/WASM session. These cases prove the
// transaction/state contract, not native multi-connection lock scheduling.
const owner = "00000000-0000-4000-8000-000000000701";
const otherOwner = "00000000-0000-4000-8000-000000000702";
const agent = "newsletter-genie";
const otherAgent = "maitre-des-publicites";
const privateText = "  PRIVATE_SUBMISSION_SENTINEL\nUne mission précise.  ";
let db: PGlite;

type Status = {
  submission_id: string; agent_type: string; state: string; created_at: Date; updated_at: Date;
  attempt_count: number; run_id: string | null; run_status: string | null; run_mode: string | null; run_mock: boolean | null;
};
type Brief = { brief_id: string; brief: string };
const submit = (id: string, text = privateText, userId = owner, agentType = agent) => db.query<Status>(
  "SELECT * FROM purama_ai.karta_submit_brief($1,$2,$3,$4)", [userId, agentType, id, text],
);
const status = async (id: string, userId = owner, agentType = agent) => (await db.query<Status>(
  "SELECT * FROM purama_ai.karta_get_brief_status($1,$2,$3)", [userId, agentType, id],
)).rows;
const list = async (userId = owner, agentType = agent) => (await db.query<Status>(
  "SELECT * FROM purama_ai.karta_list_briefs($1,$2)", [userId, agentType],
)).rows;
const claim = (runId: string, id?: string, userId = owner, agentType = agent) => id === undefined
  ? db.query<Brief>("SELECT * FROM purama_ai.karta_claim_pending_brief($1,$2,$3)", [userId, agentType, runId])
  : db.query<Brief>("SELECT * FROM purama_ai.karta_claim_pending_brief($1,$2,$3,'pending_brief',$4)", [userId, agentType, runId, id]);
const peek = (runId: string, id?: string) => id === undefined
  ? db.query<Brief>("SELECT * FROM purama_ai.karta_peek_pending_brief($1,$2,$3)", [owner, agent, runId])
  : db.query<Brief>("SELECT * FROM purama_ai.karta_peek_pending_brief($1,$2,$3,'pending_brief',$4)", [owner, agent, runId, id]);
async function run(mode = "live", userId = owner, agentType = agent) {
  const id = randomUUID();
  await db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode) VALUES($1,$2,$3,'manual',$4)",
    [id, userId, agentType, mode]);
  return id;
}
const finish = (runId: string, status = "error", mode = "live") => db.query(
  "UPDATE purama_ai.karta_runs SET status=$2,mode=$3,duration_ms=1,finished_at=clock_timestamp() WHERE id=$1", [runId, status, mode],
);
async function pending() {
  return (await db.query<{ id: string; memory_value: unknown }>(
    "SELECT id,memory_value FROM purama_ai.karta_agent_memory WHERE memory_key='pending_brief' ORDER BY id",
  )).rows;
}
const claims = async () => (await db.query<{ brief_id: string; state: string; attempt_count: number }>(
  "SELECT brief_id,state,attempt_count FROM purama_ai.karta_brief_claims ORDER BY created_at,run_id",
)).rows;
async function ready(text = privateText) {
  const id = randomUUID(); await submit(id, text);
  const firstRun = await run(); await claim(firstRun, id); await finish(firstRun);
  return { id, firstRun };
}
async function asClient(role = "authenticated", userId = owner) {
  await db.query("SELECT set_config('test.user_id',$1,false)", [userId]);
  await db.exec(`SET ROLE ${role}`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;
    CREATE SCHEMA purama_ai;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai,auth TO service_role,authenticated,anon;
  `);
  for (const file of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql",
    "018_karta_brief_claims.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql", "025_brief_submission.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role; GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.karta_agent_memory TO authenticated; GRANT SELECT ON purama_ai.karta_runs TO authenticated;");
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
  await db.exec("SET ROLE service_role;");
});

describe("durable admission before queue delivery", () => {
  it("preserves the exact text and identity and returns metadata only", async () => {
    const id = randomUUID();
    const result = (await submit(id)).rows;
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ submission_id: id, agent_type: agent, state: "pending", attempt_count: 0, run_id: null });
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
    expect(Object.keys(result[0]).sort()).toEqual([
      "submission_id", "agent_type", "state", "created_at", "updated_at", "attempt_count", "run_id", "run_status", "run_mode", "run_mock",
    ].sort());
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SUBMISSION_SENTINEL");
  });

  it("retries a lost admission response without overwriting the input or timestamp", async () => {
    const id = randomUUID(); const first = (await submit(id)).rows;
    expect((await submit(id)).rows).toEqual(first);
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
  });

  it("retains a stored submission when no queue call succeeds", async () => {
    const id = randomUUID(); await submit(id); // Redis outage: delivery never happens.
    expect(await status(id)).toMatchObject([{ submission_id: id, state: "pending", run_id: null }]);
    await submit(id); const runId = await run();
    expect((await claim(runId, id)).rows).toEqual([{ brief_id: id, brief: privateText }]);
    expect(await status(id)).toMatchObject([{ state: "claimed", run_id: runId }]);
  });

  it.each(["different", privateText.trim()])("rejects reused identity with changed text without exposing it", async text => {
    const id = randomUUID(); await submit(id);
    const error = await submit(id, text).catch(value => value as Error & { code: string });
    expect(error).toMatchObject({ code: "PBR02", message: "Brief submission identity conflict" });
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
  });

  it("returns an explicit occupied slot instead of replacing an earlier submission", async () => {
    const first = randomUUID(); await submit(first);
    await expect(submit(randomUUID(), "second mission")).rejects.toMatchObject({ code: "PBR03" });
    expect(await pending()).toEqual([{ id: first, memory_value: privateText }]);
  });

  it("reconciles submit and claim acknowledgements after input has moved to a receipt", async () => {
    const first = randomUUID(); await submit(first); const firstRun = await run(); await claim(firstRun, first);
    const second = randomUUID(); await submit(second, "second mission");
    expect((await submit(first)).rows).toMatchObject([{ submission_id: first, state: "claimed", run_id: firstRun }]);
    expect((await claim(firstRun, first)).rows).toEqual([{ brief_id: first, brief: privateText }]);
    expect(await pending()).toEqual([{ id: second, memory_value: "second mission" }]);
    expect(await claims()).toHaveLength(1);
  });

  it("keeps identity immutable after safe retries have transferred the receipt", async () => {
    const first = await ready(); const secondRun = await run(); await claim(secondRun, first.id);
    expect((await submit(first.id)).rows).toMatchObject([{ state: "claimed", attempt_count: 2, run_id: secondRun }]);
    await expect(submit(first.id, "changed after transfer")).rejects.toMatchObject({ code: "PBR02" });
    expect(await pending()).toEqual([]);
  });

  it("preserves the admission date through claim, reload and transfer", async () => {
    const id = randomUUID(); await submit(id);
    // A pending input saved before this worker started must retain that date.
    await db.query("UPDATE purama_ai.karta_agent_memory SET updated_at='2025-01-02T03:04:05Z' WHERE id=$1", [id]);
    const original = (await status(id))[0].created_at;
    const firstRun = await run(); await claim(firstRun, id);
    expect((await status(id))[0].created_at).toEqual(original);
    await finish(firstRun); const nextRun = await run(); await claim(nextRun, id);
    expect((await status(id))[0].created_at).toEqual(original);
    expect((await list())[0].created_at).toEqual(original);
    expect((await submit(id)).rows[0].created_at).toEqual(original);
  });

  it.each([{ label: "empty", text: "" }, { label: "Unicode whitespace", text: "\n\t \u00a0\ufeff" },
    { label: "too long", text: "x".repeat(8001) }])("rejects invalid input without creating memory: $label", async ({ text }) => {
    await expect(submit(randomUUID(), text)).rejects.toMatchObject({ code: "PBR01" });
    expect(await pending()).toEqual([]);
  });

  it("accepts the boundary length and refuses unsupported agents", async () => {
    await submit(randomUUID(), "x".repeat(8000));
    await expect(submit(randomUUID(), "irrelevant", owner, "email")).rejects.toMatchObject({ code: "PBR01" });
  });

  it("refuses reused UUIDs across owners and agents both before and after a claim", async () => {
    const id = randomUUID(); await submit(id);
    await expect(submit(id, privateText, otherOwner)).rejects.toMatchObject({ code: "PBR02" });
    await expect(submit(id, privateText, owner, otherAgent)).rejects.toMatchObject({ code: "PBR02" });
    await claim(await run(), id);
    await expect(submit(id, privateText, otherOwner)).rejects.toMatchObject({ code: "PBR02" });
    await expect(submit(id, privateText, owner, otherAgent)).rejects.toMatchObject({ code: "PBR02" });
  });

  it("does not let an ordinary memory UUID collision invalidate a private committed receipt", async () => {
    const first = await ready();
    await asClient("authenticated", otherOwner);
    await db.query("INSERT INTO purama_ai.karta_agent_memory(id,user_id,agent_type,memory_key,memory_value) VALUES($1,$2,$3,'ordinary','\"foreign value\"')", [first.id, otherOwner, agent]);
    await db.exec("RESET ROLE; SET ROLE service_role;");
    expect((await submit(first.id)).rows).toMatchObject([{ submission_id: first.id, state: "ready", run_id: first.firstRun }]);
    expect((await claim(await run(), first.id)).rows).toEqual([{ brief_id: first.id, brief: privateText }]);
    expect((await db.query("SELECT user_id,memory_key,memory_value FROM purama_ai.karta_agent_memory WHERE id=$1", [first.id])).rows)
      .toEqual([{ user_id: otherOwner, memory_key: "ordinary", memory_value: "foreign value" }]);
  });
});

describe("exact input binding and simulation metadata", () => {
  it("claims the requested new brief while leaving an older ready brief untouched", async () => {
    const first = await ready(); const second = randomUUID(); await submit(second, "new mission");
    const secondRun = await run();
    expect((await claim(secondRun, second)).rows).toEqual([{ brief_id: second, brief: "new mission" }]);
    expect(await status(first.id)).toMatchObject([{ state: "ready", attempt_count: 1, run_id: first.firstRun }]);
    expect(await status(second)).toMatchObject([{ state: "claimed", run_id: secondRun }]);
    await expect(claim(secondRun, first.id)).rejects.toThrow("Brief claim unavailable");
  });

  it("does not fall back when an expected identity is unavailable", async () => {
    const first = await ready(); const second = randomUUID(); await submit(second, "new mission");
    expect((await claim(await run(), randomUUID())).rows).toEqual([]);
    expect((await peek(await run("simulation"), randomUUID())).rows).toEqual([]);
    expect(await status(first.id)).toMatchObject([{ state: "ready" }]);
    expect(await pending()).toEqual([{ id: second, memory_value: "new mission" }]);
  });

  it("keeps the legacy default arguments and ready-first scheduling behavior", async () => {
    const first = await ready(); const second = randomUUID(); await submit(second, "new mission");
    expect((await claim(await run())).rows).toEqual([{ brief_id: first.id, brief: privateText }]);
    expect(await pending()).toEqual([{ id: second, memory_value: "new mission" }]);
  });

  it("records a targeted simulation without acquiring or deleting either input", async () => {
    const first = await ready(); const second = randomUUID(); await submit(second, "simulation input");
    const previewRun = await run("simulation");
    expect((await peek(previewRun, second)).rows).toEqual([{ brief_id: second, brief: "simulation input" }]);
    await finish(previewRun, "simulated", "simulation");
    expect(await status(second)).toMatchObject([{
      state: "pending", attempt_count: 0, run_id: previewRun, run_status: "simulated", run_mode: "simulation", run_mock: false,
    }]);
    expect(await status(first.id)).toMatchObject([{ state: "ready", attempt_count: 1 }]);
    expect(await claims()).toHaveLength(1);
    expect(await pending()).toEqual([{ id: second, memory_value: "simulation input" }]);
    expect(JSON.stringify(await list())).not.toContain("simulation input");
  });

  it("never switches an already bound preview run to another input", async () => {
    const first = randomUUID(); await submit(first); const previewRun = await run("simulation");
    await peek(previewRun, first);
    await expect(peek(previewRun, randomUUID())).rejects.toThrow("Brief preview unavailable");
    await claim(await run(), first); const second = randomUUID(); await submit(second, "new mission");
    expect((await peek(previewRun)).rows).toEqual([]);
    expect(await pending()).toEqual([{ id: second, memory_value: "new mission" }]);
  });

  it("uses the current claim owner despite a newer preview and inverted run start times", async () => {
    const first = await ready(); const liveRun = await run(); const previewRun = await run("simulation");
    await db.query("UPDATE purama_ai.karta_runs SET started_at='2001-01-01' WHERE id=$1", [liveRun]);
    await db.query("UPDATE purama_ai.karta_runs SET started_at='2002-01-01' WHERE id=$1", [previewRun]);
    await peek(previewRun, first.id); await finish(previewRun, "simulated", "simulation");
    await claim(liveRun, first.id);
    expect(await status(first.id)).toMatchObject([{ state: "claimed", run_id: liveRun, run_mode: "live" }]);
    await db.query("SELECT purama_ai.karta_arm_pending_brief($1,$2,$3)", [owner, agent, liveRun]);
    await db.query("UPDATE purama_ai.karta_runs SET tools_used='[{\"tool\":\"inert\",\"outcome\":\"executed\",\"success\":true}]' WHERE id=$1", [liveRun]);
    await finish(liveRun, "success");
    expect(await status(first.id)).toMatchObject([{ state: "completed", run_id: liveRun, run_status: "success", run_mode: "live", run_mock: false }]);
  });

  it("does not acquire an input with another owner's parent run", async () => {
    const id = randomUUID(); await submit(id);
    await expect(claim(await run("live", otherOwner), id)).rejects.toThrow("Brief claim unavailable");
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
  });

  it("rolls back association, receipt and deletion together", async () => {
    const id = randomUUID(); await submit(id); const runId = await run();
    await db.exec("BEGIN");
    try { await claim(runId, id); } finally { await db.exec("ROLLBACK"); }
    expect(await claims()).toEqual([]);
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
    expect((await db.query("SELECT brief_id FROM purama_ai.karta_runs WHERE id=$1", [runId])).rows).toEqual([{ brief_id: null }]);
  });

  it("keeps the three-attempt bound for an explicitly targeted submission", async () => {
    const id = randomUUID(); await submit(id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const runId = await run(); await claim(runId, id); await finish(runId);
      expect(await status(id)).toMatchObject([{
        state: attempt < 3 ? "ready" : "reconciliation_required", attempt_count: attempt, run_id: runId,
      }]);
    }
    expect((await claim(await run(), id)).rows).toEqual([]);
    expect((await submit(id)).rows).toMatchObject([{ state: "reconciliation_required", attempt_count: 3 }]);
    expect(await pending()).toEqual([]);
  });
});

describe("private observable status and protected memory namespace", () => {
  it("scopes status and listing by authenticated server identity and agent", async () => {
    const id = randomUUID(); await submit(id);
    expect(await status(id, otherOwner)).toEqual([]);
    expect(await status(id, owner, otherAgent)).toEqual([]);
    expect(await list(otherOwner)).toEqual([]);
    expect(await list(owner, otherAgent)).toEqual([]);
    expect(await status(randomUUID())).toEqual([]);
  });

  it("lists the 20 most recent receipts when no pending slot exists and can read an older one by id", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 22; index++) {
      const id = randomUUID(); ids.push(id); await submit(id, `private mission ${index}`); await claim(await run(), id);
      await db.query("UPDATE purama_ai.karta_brief_claims SET created_at=$2,updated_at=$2 WHERE brief_id=$1", [id, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`]);
      await db.query("UPDATE purama_ai.karta_runs SET started_at=$2 WHERE brief_id=$1", [id, `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`]);
    }
    const rows = await list();
    expect(rows).toHaveLength(20);
    expect(rows.map(row => row.submission_id)).toEqual(ids.slice(2).reverse());
    expect(await status(ids[0])).toMatchObject([{ submission_id: ids[0] }]);
    expect(JSON.stringify(rows)).not.toContain("private mission");
  });

  it("keeps an older pending slot reachable ahead of twenty recently completed receipts", async () => {
    const history: Array<{ id: string; runId: string }> = [];
    for (let index = 0; index < 20; index++) {
      const id = randomUUID(); await submit(id, `historic mission ${index}`);
      const runId = await run(); await claim(runId, id);
      await db.query("SELECT purama_ai.karta_arm_pending_brief($1,$2,$3)", [owner, agent, runId]);
      await db.query("UPDATE purama_ai.karta_runs SET tools_used='[{\"tool\":\"inert\",\"outcome\":\"executed\",\"success\":true}]' WHERE id=$1", [runId]);
      history.push({ id, runId });
    }
    const pendingId = randomUUID(); await submit(pendingId, "still waiting for delivery");
    await db.query("UPDATE purama_ai.karta_agent_memory SET updated_at='2025-01-02T03:04:05Z' WHERE id=$1", [pendingId]);
    for (const item of history) await finish(item.runId, "success");
    const rows = await list();
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ submission_id: pendingId, state: "pending", run_id: null });
    expect(rows.filter(row => row.state === "completed")).toHaveLength(19);
    const excluded = history.find(item => !rows.some(row => row.submission_id === item.id));
    expect(excluded).toBeDefined();
    expect(await status(excluded!.id)).toMatchObject([{ submission_id: excluded!.id, state: "completed" }]);
    expect(await status(pendingId)).toMatchObject([{ submission_id: pendingId, state: "pending" }]);
    expect(JSON.stringify(rows)).not.toContain("still waiting for delivery");
  });

  it.each(["anon", "authenticated"])("denies %s direct execution of all new RPCs", async role => {
    const id = randomUUID(); await submit(id); const runId = await run(); await asClient(role);
    await expect(submit(id)).rejects.toThrow(/permission denied/);
    await expect(status(id)).rejects.toThrow(/permission denied/);
    await expect(list()).rejects.toThrow(/permission denied/);
    await expect(claim(runId, id)).rejects.toThrow(/permission denied/);
    await expect(peek(runId, id)).rejects.toThrow(/permission denied/);
  });

  it("allows owner reads but denies direct insert, update and deletion of pending input", async () => {
    const id = randomUUID(); await submit(id); await asClient();
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
    await expect(db.query("INSERT INTO purama_ai.karta_agent_memory(user_id,agent_type,memory_key,memory_value) VALUES($1,$2,'pending_brief','\"replacement\"')", [owner, otherAgent])).rejects.toThrow(/row-level security/);
    expect((await db.query("UPDATE purama_ai.karta_agent_memory SET memory_value='\"replacement\"' WHERE id=$1 RETURNING id", [id])).rows).toEqual([]);
    expect((await db.query("DELETE FROM purama_ai.karta_agent_memory WHERE id=$1 RETURNING id", [id])).rows).toEqual([]);
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
  });

  it("keeps unrelated owner memory writable without allowing renaming into the protected slot", async () => {
    await asClient();
    const id = randomUUID();
    await db.query("INSERT INTO purama_ai.karta_agent_memory(id,user_id,agent_type,memory_key,memory_value) VALUES($1,$2,$3,'ordinary','\"value\"')", [id, owner, agent]);
    await db.query("UPDATE purama_ai.karta_agent_memory SET memory_value='\"updated\"' WHERE id=$1", [id]);
    await expect(db.query("UPDATE purama_ai.karta_agent_memory SET memory_key='pending_brief' WHERE id=$1", [id])).rejects.toThrow(/row-level security/);
    expect((await db.query("DELETE FROM purama_ai.karta_agent_memory WHERE id=$1 RETURNING id", [id])).rows).toEqual([{ id }]);
  });

  it("does not allow renaming an existing pending input to bypass its protection", async () => {
    const id = randomUUID(); await submit(id); await asClient();
    expect((await db.query("UPDATE purama_ai.karta_agent_memory SET memory_key='ordinary' WHERE id=$1 RETURNING id", [id])).rows).toEqual([]);
    expect(await pending()).toEqual([{ id, memory_value: privateText }]);
  });
});
