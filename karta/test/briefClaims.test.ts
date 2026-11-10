import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";

// Real PostgreSQL SQL in one PGlite backend. Promise.all exercises serialized
// contenders here; this suite does not certify native multi-session locking.
const owner = "00000000-0000-4000-8000-000000000301";
const otherOwner = "00000000-0000-4000-8000-000000000302";
const agent = "newsletter-genie";
const privateText = "PRIVATE_BRIEF_SQL_SENTINEL";
let db: PGlite;

type BriefRow = { brief_id: string; brief: string };
type Receipt = {
  run_id: string; brief_id: string; payload: string; state: string; attempt_count: number;
  previous_run_id: string | null; transferred_to_run_id: string | null;
};
const claim = (runId: string, userId = owner, agentType = agent, key = "pending_brief") => db.query<BriefRow>(
  "SELECT * FROM purama_ai.karta_claim_pending_brief($1,$2,$3,$4)", [userId, agentType, runId, key],
);
const peek = (runId: string, userId = owner, agentType = agent) => db.query<BriefRow>(
  "SELECT * FROM purama_ai.karta_peek_pending_brief($1,$2,$3)", [userId, agentType, runId],
);
const arm = (runId: string, userId = owner, agentType = agent) => db.query<{ armed: boolean }>(
  "SELECT purama_ai.karta_arm_pending_brief($1,$2,$3) AS armed", [userId, agentType, runId],
);
const receipt = async (runId: string) => (await db.query<Receipt>(
  "SELECT * FROM purama_ai.karta_brief_claims WHERE run_id=$1", [runId],
)).rows[0];
const memories = async () => (await db.query<{ id: string; memory_value: unknown }>(
  "SELECT id,memory_value FROM purama_ai.karta_agent_memory ORDER BY id",
)).rows;

async function run(options: { userId?: string; agentType?: string; mode?: string; status?: string; duration?: number | null } = {}) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms) VALUES($1,$2,$3,'manual',$4,$5,$6)",
    [id, options.userId ?? owner, options.agentType ?? agent, options.mode ?? "live", options.status ?? "running", options.duration ?? null],
  );
  return id;
}

async function seed(value: unknown = privateText, userId = owner, agentType = agent, key = "pending_brief") {
  const id = randomUUID();
  await db.query(
    "INSERT INTO purama_ai.karta_agent_memory(id,user_id,agent_type,memory_key,memory_value) VALUES($1,$2,$3,$4,$5::jsonb)",
    [id, userId, agentType, key, JSON.stringify(value)],
  );
  return id;
}

const tool = (outcome: string, extra: Record<string, unknown> = {}) => ({
  tool: "inert", paramsSummary: "metadata", resultSummary: "metadata", outcome,
  success: outcome === "executed", ...extra,
});

async function finish(runId: string, options: { status?: string; tools?: unknown; mode?: string; mock?: boolean } = {}) {
  await db.query(
    "UPDATE purama_ai.karta_runs SET status=$2,tools_used=$3::jsonb,mode=$4,claude_mock=$5,duration_ms=0,finished_at=now() WHERE id=$1",
    [runId, options.status ?? "success", JSON.stringify(options.tools ?? []), options.mode ?? "live", options.mock ?? false],
  );
}

async function pending(runId: string) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,$4,'inert','{}')",
    [id, owner, runId, agent],
  );
  return id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('test.user_id',true),'')::uuid
    $$;
    CREATE SCHEMA purama_ai;
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai,auth TO service_role,authenticated,anon;
  `);
  for (const file of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role; GRANT SELECT ON purama_ai.karta_runs TO authenticated;");
  await db.exec(await readFile(new URL("../migrations/018_karta_brief_claims.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../migrations/019_karta_approval_parent_guard.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../migrations/020_execution_fingerprints.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../migrations/026_pending_action_execution_origin.sql", import.meta.url), "utf8"));
  // Reapplying the additive brief schema must preserve the later guards.
  await db.exec(await readFile(new URL("../migrations/018_karta_brief_claims.sql", import.meta.url), "utf8"));
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
  await db.exec("SET ROLE service_role;");
  // TRUNCATE auth.users CASCADE also empties this table through updated_by.
  // Recreate the isolated fixture explicitly; product stop rules stay intact.
  await db.exec("INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;");
  await db.query(
    "INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,is_enabled,simulation_mode) VALUES($1,$2,true,false)",
    [owner, agent],
  );
});

describe("durable private acquisition — actual migration SQL", () => {
  it("moves a brief atomically and returns the same snapshot after a lost response", async () => {
    const briefId = await seed(); const id = await run();
    await claim(id); // Simulate losing this already committed response.
    const newerId = await seed("newer instruction");
    expect((await claim(id)).rows).toEqual([{ brief_id: briefId, brief: privateText }]);
    expect(await receipt(id)).toMatchObject({ state: "claimed", attempt_count: 1, brief_id: briefId, payload: privateText });
    expect(await memories()).toEqual([{ id: newerId, memory_value: "newer instruction" }]);
  });

  it("gives one input to only one of two serialized contender runs", async () => {
    await seed(); const ids = await Promise.all([run(), run()]);
    const results = await Promise.all(ids.map(id => claim(id)));
    expect(results.map(result => result.rows.length).sort()).toEqual([0, 1]);
    expect((await db.query("SELECT run_id FROM purama_ai.karta_brief_claims")).rows).toHaveLength(1);
    expect(await memories()).toEqual([]);
  });

  it("rolls back the snapshot and deletion together", async () => {
    const briefId = await seed(); const id = await run();
    await db.exec("BEGIN");
    try { await claim(id); } finally { await db.exec("ROLLBACK"); }
    expect(await receipt(id)).toBeUndefined();
    expect(await memories()).toEqual([{ id: briefId, memory_value: privateText }]);
  });

  it("does not delete a new row when its reused identity conflicts with an existing receipt", async () => {
    const briefId = await seed(); const first = await run(); await claim(first);
    await db.query(
      "INSERT INTO purama_ai.karta_agent_memory(id,user_id,agent_type,memory_key,memory_value) VALUES($1,$2,$3,'pending_brief',$4::jsonb)",
      [briefId, owner, agent, JSON.stringify("new input with invalid reused identity")],
    );
    const second = await run();
    await expect(claim(second)).rejects.toThrow(/unique/);
    expect(await receipt(second)).toBeUndefined();
    expect((await memories())[0].memory_value).toBe("new input with invalid reused identity");
    expect((await receipt(first)).payload).toBe(privateText);
  });

  it.each(["", " \t\n\r", "\u00a0\ufeff\u2000", null, { brief: privateText }, [privateText]].map(value => ({ value })))(
    "leaves invalid or blank memory values untouched: %j", async ({ value }) => {
      const briefId = await seed(value); const id = await run();
      expect((await claim(id)).rows).toEqual([]);
      expect(await receipt(id)).toBeUndefined();
      expect(await memories()).toEqual([{ id: briefId, memory_value: value }]);
    },
  );

  it.each(["wrong_user", "wrong_agent", "unknown_run", "simulation", "terminal", "already_closed_running"])(
    "rejects an invalid parent binding: %s", async failure => {
      await seed();
      const id = await run({ mode: failure === "simulation" ? "simulation" : "live", status: failure === "terminal" ? "error" : "running", duration: failure === "already_closed_running" ? 0 : null });
      await expect(claim(failure === "unknown_run" ? randomUUID() : id,
        failure === "wrong_user" ? otherOwner : owner, failure === "wrong_agent" ? "campagnes-par-courriel" : agent)).rejects.toThrow("Brief claim unavailable");
      expect(await receipt(id)).toBeUndefined(); expect(await memories()).toHaveLength(1);
    },
  );

  it("scopes independent inputs by owner, agent and key", async () => {
    await seed(); await seed("other owner", otherOwner); await seed("other agent", owner, "campagnes-par-courriel");
    await seed("other key", owner, agent, "another_key");
    const id = await run({ userId: otherOwner });
    expect((await claim(id, otherOwner)).rows[0].brief).toBe("other owner");
    expect(await memories()).toHaveLength(3);
    await expect(claim(id, otherOwner, agent, "another_key")).rejects.toThrow("Brief claim unavailable");
  });

  it("does not expire or replay an unclosed claim", async () => {
    await seed(); const first = await run(); await claim(first);
    await db.query("UPDATE purama_ai.karta_brief_claims SET created_at='2000-01-01',updated_at='2000-01-01' WHERE run_id=$1", [first]);
    const second = await run(); expect((await claim(second)).rows).toEqual([]);
    expect((await receipt(first)).state).toBe("claimed");
  });
});

describe("read-only simulation and bounded pre-effect recovery", () => {
  it("previews without a snapshot, lock receipt or memory deletion", async () => {
    const briefId = await seed(); const id = await run({ mode: "simulation" });
    expect((await peek(id)).rows).toEqual([{ brief_id: briefId, brief: privateText }]);
    expect((await peek(id)).rows).toEqual([{ brief_id: briefId, brief: privateText }]);
    expect(await receipt(id)).toBeUndefined(); expect(await memories()).toHaveLength(1);
    await expect(peek(await run())).rejects.toThrow("Brief preview unavailable");
  });

  it.each(["error", "skipped", "cancelled", "success"])("makes a confirmed %s with no dispatch recoverable", async status => {
    await seed(); const id = await run(); await claim(id); await finish(id, { status });
    expect((await receipt(id)).state).toBe("ready");
    await expect(claim(id)).rejects.toThrow("Brief claim unavailable");
  });

  it("retains a live claim after a mock decision and counts its acquisition", async () => {
    await seed(); const id = await run(); await claim(id);
    await finish(id, { status: "simulated", mode: "simulation", mock: true, tools: [tool("simulated")] });
    expect(await receipt(id)).toMatchObject({ state: "ready", attempt_count: 1, payload: privateText });
  });

  it("does not confuse validation failure before arming with an attempted effect", async () => {
    await seed(); const id = await run(); await claim(id);
    await finish(id, { status: "error", tools: [tool("failed"), tool("skipped")] });
    expect((await receipt(id)).state).toBe("ready");
  });

  it("transfers the oldest ready input before new memory and keeps both identities", async () => {
    const briefId = await seed(); const first = await run(); await claim(first); await finish(first, { status: "error" });
    const newerId = await seed(privateText); // Identical text is still a new submission.
    const preview = await run({ mode: "simulation" });
    expect((await peek(preview)).rows).toEqual([{ brief_id: briefId, brief: privateText }]);
    expect((await receipt(first)).attempt_count).toBe(1);
    const second = await run(); expect((await claim(second)).rows).toEqual([{ brief_id: briefId, brief: privateText }]);
    expect(await receipt(first)).toMatchObject({ state: "transferred", transferred_to_run_id: second });
    expect(await receipt(second)).toMatchObject({ state: "claimed", attempt_count: 2, previous_run_id: first });
    expect(await memories()).toEqual([{ id: newerId, memory_value: privateText }]);
  });

  it("rolls back a transfer as one transaction", async () => {
    await seed(); const first = await run(); await claim(first); await finish(first, { status: "error" });
    const second = await run(); await db.exec("BEGIN");
    try { await claim(second); } finally { await db.exec("ROLLBACK"); }
    expect(await receipt(first)).toMatchObject({ state: "ready", transferred_to_run_id: null });
    expect(await receipt(second)).toBeUndefined();
  });

  it.each(["error", "skipped"])("caps three live %s attempts, retains the input and accepts an independent new brief", async status => {
    const briefId = await seed(); const ids: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const id = await run(); ids.push(id);
      expect((await claim(id)).rows[0].brief_id).toBe(briefId);
      await finish(id, { status });
      expect(await receipt(id)).toMatchObject({ attempt_count: attempt, state: attempt < 3 ? "ready" : "reconciliation_required", payload: privateText });
    }
    expect((await claim(await run())).rows).toEqual([]);
    const freshId = await seed("independent new mission");
    expect((await claim(await run())).rows).toEqual([{ brief_id: freshId, brief: "independent new mission" }]);
    expect((await receipt(ids[2])).payload).toBe(privateText);
    expect((await db.query("SELECT run_id FROM purama_ai.karta_brief_claims WHERE brief_id=$1", [briefId])).rows).toHaveLength(3);
  });
});

describe("arming and close-trigger authority", () => {
  it("confirms an already committed arm but forbids reacquisition and release", async () => {
    await seed(); const id = await run(); await claim(id);
    await arm(id); // The response can be lost after this database commit.
    expect((await arm(id)).rows).toEqual([{ armed: true }]);
    expect((await receipt(id)).state).toBe("effect_started");
    await expect(claim(id)).rejects.toThrow("Brief claim unavailable");
    await finish(id, { status: "error" });
    expect((await receipt(id)).state).toBe("reconciliation_required");
    expect((await claim(await run())).rows).toEqual([]);
  });

  it.each(["wrong_user", "wrong_agent", "no_claim", "closed"])("does not arm an invalid receipt: %s", async failure => {
    await seed(); const id = await run();
    if (failure !== "no_claim") await claim(id);
    if (failure === "closed") await finish(id, { status: "error" });
    await expect(arm(id, failure === "wrong_user" ? otherOwner : owner,
      failure === "wrong_agent" ? "campagnes-par-courriel" : agent)).rejects.toThrow("Brief action unavailable");
  });

  it("closes an armed live run and its receipt in the same transaction", async () => {
    await seed(); const id = await run(); await claim(id); await arm(id);
    await db.exec("BEGIN");
    try {
      await finish(id, { tools: [tool("executed")] });
      expect((await receipt(id)).state).toBe("completed");
    } finally { await db.exec("ROLLBACK"); }
    expect((await receipt(id)).state).toBe("effect_started");
    expect((await db.query<{ status: string }>("SELECT status FROM purama_ai.karta_runs WHERE id=$1", [id])).rows[0].status).toBe("running");
    await finish(id, { tools: [tool("executed")] });
    expect((await receipt(id)).state).toBe("completed");
    await expect(arm(id)).rejects.toThrow("Brief action unavailable");
  });

  it.each(["error", "cancelled", "partial", "skipped", "success"])("retains an armed %s without confirmed effects for reconciliation", async status => {
    await seed(); const id = await run(); await claim(id); await arm(id); await finish(id, { status });
    expect((await receipt(id)).state).toBe("reconciliation_required");
  });

  it("does not acknowledge partial or simulated evidence as a completed mission", async () => {
    await seed(); const id = await run(); await claim(id); await arm(id);
    await finish(id, { tools: [tool("executed"), tool("skipped")] });
    expect((await receipt(id)).state).toBe("reconciliation_required");
    await seed("second mission"); const second = await run(); await claim(second); await arm(second);
    await finish(second, { status: "simulated", mode: "simulation", mock: true, tools: [tool("simulated")] });
    expect((await receipt(second)).state).toBe("reconciliation_required");
  });

  it.each([[tool("executed")], { outcome: "executed" }, [{ success: true }], [null]].map(tools => ({ tools })))(
    "never releases a claimed input after contradictory or malformed trace evidence: %j", async ({ tools }) => {
      await seed(); const id = await run(); await claim(id); await finish(id, { tools });
      expect((await receipt(id)).state).toBe("reconciliation_required");
    },
  );

  it("does not release an unarmed receipt if an approval row already exists", async () => {
    await seed(); const id = await run(); await claim(id); await pending(id); await finish(id, { status: "error" });
    expect((await receipt(id)).state).toBe("reconciliation_required");
  });

  it("prevents a claimed run from changing its owner or agent", async () => {
    await seed(); const id = await run(); await claim(id);
    await expect(db.query("UPDATE purama_ai.karta_runs SET user_id=$2 WHERE id=$1", [id, otherOwner])).rejects.toThrow("Brief parent mismatch");
    await expect(db.query("UPDATE purama_ai.karta_runs SET agent_type='other-agent' WHERE id=$1", [id])).rejects.toThrow("Brief parent mismatch");
    expect((await receipt(id)).state).toBe("claimed");
  });
});

describe("approval finalization uses the existing transaction and never releases input", () => {
  it.each(["executed", "rejected", "failed", "cancelled"])("follows a persisted %s resolution", async resolution => {
    await seed(); const id = await run(); await claim(id); await arm(id); const actionId = await pending(id);
    await finish(id, { status: "awaiting_approval", tools: [tool("pending", { pendingActionId: actionId })] });
    expect((await receipt(id)).state).toBe("awaiting_approval");
    await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,$2)", [actionId, resolution === "rejected" ? "reject" : "approve"]);
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,$2,'metadata')", [actionId, resolution]);
    expect((await receipt(id)).state).toBe(resolution === "executed" ? "completed" : "reconciliation_required");
    expect((await claim(await run())).rows).toEqual([]);
  });

  it("preserves ownership while the approval finalizer temporarily returns to running", async () => {
    await seed(); const id = await run(); await claim(id); await arm(id);
    const first = await pending(id); const second = await pending(id);
    await finish(id, { status: "awaiting_approval", tools: [tool("pending", { pendingActionId: first }), tool("pending", { pendingActionId: second })] });
    for (const actionId of [first, second]) await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId]);
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,'executed','metadata')", [first]);
    expect((await db.query<{ status: string }>("SELECT status FROM purama_ai.karta_runs WHERE id=$1", [id])).rows[0].status).toBe("running");
    expect((await receipt(id)).state).toBe("awaiting_approval");
    await expect(arm(id)).rejects.toThrow("Brief action unavailable");
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,'executed','metadata')", [second]);
    expect((await receipt(id)).state).toBe("completed");
  });

  it("keeps a partially completed brief after approval instead of replaying its first action", async () => {
    await seed(); const id = await run(); await claim(id); await arm(id); const actionId = await pending(id);
    await finish(id, { status: "awaiting_approval", tools: [tool("pending", { pendingActionId: actionId }), tool("skipped")] });
    await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId]);
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,'executed','metadata')", [actionId]);
    expect(await receipt(id)).toMatchObject({ state: "reconciliation_required", payload: privateText });
  });
});

describe("server-only input storage and static journal boundary", () => {
  it("does not add the raw brief to a SELECT * run journal", async () => {
    await seed(); const id = await run(); await claim(id); await finish(id, { status: "error" });
    await db.query("SELECT set_config('test.user_id',$1,false)", [owner]);
    await db.exec("SET ROLE authenticated");
    try {
      const runs = await db.query("SELECT * FROM purama_ai.karta_runs WHERE id=$1", [id]);
      expect(runs.rows).toHaveLength(1); expect(JSON.stringify(runs.rows)).not.toContain(privateText);
      await expect(db.query("SELECT * FROM purama_ai.karta_brief_claims")).rejects.toThrow(/permission denied/);
      await expect(claim(id)).rejects.toThrow(/permission denied/);
      await expect(peek(id)).rejects.toThrow(/permission denied/);
      await expect(arm(id)).rejects.toThrow(/permission denied/);
    } finally { await db.exec("SET ROLE service_role"); }
  });

  it("denies anonymous access and authenticated mutations while retaining invoker rights", async () => {
    await db.exec("SET ROLE anon");
    try { await expect(db.query("SELECT * FROM purama_ai.karta_brief_claims")).rejects.toThrow(/permission denied/); }
    finally { await db.exec("SET ROLE authenticated"); }
    try { await expect(db.query("UPDATE purama_ai.karta_brief_claims SET state='ready'")).rejects.toThrow(/permission denied/); }
    finally { await db.exec("SET ROLE service_role"); }
    const functions = await db.query<{ prosecdef: boolean; proconfig: string[] }>(
      "SELECT prosecdef,proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='purama_ai' AND p.proname IN ('karta_claim_pending_brief','karta_peek_pending_brief','karta_arm_pending_brief','karta_settle_brief_after_run')",
    );
    expect(functions.rows).toHaveLength(4);
    for (const fn of functions.rows) { expect(fn.prosecdef).toBe(false); expect(fn.proconfig).toEqual(["search_path=pg_catalog"]); }
  });

  it("retains the original receipt after a later conflicting close", async () => {
    await seed(); const id = await run(); await claim(id); await arm(id);
    await finish(id, { tools: [tool("executed")] });
    await finish(id, { status: "error" });
    expect((await receipt(id)).state).toBe("completed");
  });

  it("allows the existing owner deletion cascade to remove transferred private input", async () => {
    await seed(); const first = await run(); await claim(first); await finish(first, { status: "error" });
    const second = await run(); await claim(second);
    await db.exec("RESET ROLE");
    try { await db.query("DELETE FROM auth.users WHERE id=$1", [owner]); }
    finally { await db.exec("SET ROLE service_role"); }
    expect((await db.query("SELECT * FROM purama_ai.karta_brief_claims")).rows).toEqual([]);
  });
});
