import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// Actual migration SQL in a single PGlite backend. These tests prove admission
// and rollback behavior, not native PostgreSQL multi-session locking. No tool
// or provider is invoked: returning an executing row is the dispatch boundary.
const owner = "00000000-0000-4000-8000-000000000501";
const otherOwner = "00000000-0000-4000-8000-000000000502";
const runId = "00000000-0000-4000-8000-000000000503";
const actionId = "00000000-0000-4000-8000-000000000504";
const otherActionId = "00000000-0000-4000-8000-000000000505";
const agent = "newsletter-genie";
const toolName = "inert";
const privatePayload = { text: "PRIVATE_APPROVAL_PARENT_SENTINEL", nested: { keep: true } };
let db: PGlite;
let baselineSql: string;
let guardSql: string;

type ActionRow = {
  id: string; user_id: string; run_id: string; agent_type: string; tool_name: string;
  tool_params: typeof privatePayload; status: string; claimed_at: string | null;
};
const claim = (id = actionId, decision: string | null = "approve") => db.query<ActionRow>(
  "SELECT * FROM purama_ai.karta_claim_pending_action($1,$2)", [id, decision],
);
const action = async () => (await db.query<ActionRow>(
  "SELECT * FROM purama_ai.karta_pending_actions WHERE id=$1", [actionId],
)).rows[0];
const entry = (overrides: Record<string, unknown> = {}) => ({
  tool: toolName, pendingActionId: actionId, success: false, outcome: "pending",
  paramsSummary: "metadata", resultSummary: "metadata", ...overrides,
});

async function seed(options: {
  parentUser?: string; parentAgent?: string; parentStatus?: string;
  duration?: number | null; tools?: unknown;
} = {}) {
  await db.query(
    `INSERT INTO purama_ai.karta_runs
      (id,user_id,agent_type,trigger_type,mode,status,duration_ms,finished_at,tools_used)
      VALUES($1,$2,$3,'manual','live',$4,$5,now(),$6::jsonb)`,
    [runId, options.parentUser ?? owner, options.parentAgent ?? agent,
      options.parentStatus ?? "awaiting_approval", options.duration === undefined ? 0 : options.duration,
      JSON.stringify(options.tools === undefined ? [entry()] : options.tools)],
  );
  await db.query(
    `INSERT INTO purama_ai.karta_pending_actions
      (id,user_id,run_id,agent_type,tool_name,tool_params)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
    [actionId, owner, runId, agent, toolName, JSON.stringify(privatePayload)],
  );
}

async function expectBlocked(decision: string | null = "approve", error = "Action journal unavailable") {
  await expect(claim(actionId, decision)).rejects.toThrow(error);
  expect(await action()).toMatchObject({ status: "pending", claimed_at: null, tool_params: privatePayload });
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
  for (const file of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql"]) {
    await db.exec(await readFile(new URL("../migrations/" + file, import.meta.url), "utf8"));
  }
  baselineSql = await readFile(new URL("../migrations/006_execution_claims.sql", import.meta.url), "utf8");
  guardSql = await readFile(new URL("../migrations/019_karta_approval_parent_guard.sql", import.meta.url), "utf8");
  await db.exec(baselineSql);
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role;");
});

afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, otherOwner]);
  await db.exec(`INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false)
    ON CONFLICT(id) DO UPDATE SET kill_switch=false;`);
  await db.query(
    "INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,is_enabled,simulation_mode) VALUES($1,$2,true,false)",
    [owner, agent],
  );
});

describe("baseline 006 without the parent guard", () => {
  it("admits an orphan approval before its unchanged finalizer discovers the absent journal entry", async () => {
    // Explicitly restore 006, so this proof does not depend on test ordering.
    await db.exec(baselineSql);
    await db.exec("SET ROLE service_role;");
    await seed({ parentStatus: "error", tools: [] });
    const admitted = await claim();
    expect(admitted.rows).toHaveLength(1);
    expect(admitted.rows[0]).toMatchObject({ id: actionId, status: "executing", tool_params: privatePayload });
    await expect(db.query(
      "SELECT purama_ai.karta_finalize_pending_action($1,'executed','metadata')", [actionId],
    )).rejects.toThrow("Action missing from parent journal");
    expect(await action()).toMatchObject({ status: "executing", tool_params: privatePayload });
  });
});

describe("019 checks the parent before approval admission", () => {
  beforeEach(async () => {
    await db.exec(guardSql);
    await db.exec("SET ROLE service_role;");
  });

  it.each(["approve", "reject"])("refuses an orphan before %s can change it to executing", async decision => {
    await seed({ parentStatus: "error", tools: [] });
    await expectBlocked(decision);
  });

  it("returns no work for an unknown approval", async () => {
    expect((await claim(otherActionId)).rows).toEqual([]);
  });

  it.each(["owner", "agent", "running", "unconfirmed"])("refuses an invalid parent binding or closure: %s", async invalid => {
    await seed({
      parentUser: invalid === "owner" ? otherOwner : owner,
      parentAgent: invalid === "agent" ? "campagnes-par-courriel" : agent,
      parentStatus: invalid === "running" ? "running" : "awaiting_approval",
      duration: invalid === "unconfirmed" ? null : 0,
    });
    await expectBlocked("approve", "Cycle not ready");
  });

  it.each(["approve", "reject"])("refuses a malformed negative duration before %s", async decision => {
    await seed({ duration: -1 });
    await expectBlocked(decision, "Cycle not ready");
  });

  it.each(["simulation", "mock"])("does not execute a %s parent when the agent is now live", async source => {
    await seed();
    await db.query("UPDATE purama_ai.karta_runs SET mode=$2,claude_mock=$3 WHERE id=$1",
      [runId, source === "simulation" ? "simulation" : "live", source === "mock"]);
    await expectBlocked("approve", "Cycle cannot execute");
  });

  it.each(["simulation", "mock"])("still permits rejection of a valid %s parent", async source => {
    await seed();
    await db.query("UPDATE purama_ai.karta_runs SET mode=$2,claude_mock=$3 WHERE id=$1",
      [runId, source === "simulation" ? "simulation" : "live", source === "mock"]);
    expect((await claim(actionId, "reject")).rows).toHaveLength(1);
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,'rejected','metadata')", [actionId]);
    expect(await action()).toMatchObject({ status: "rejected", tool_params: privatePayload });
  });

  it("refuses a missing parent even in a legacy fixture without the foreign key", async () => {
    await seed();
    await db.exec("RESET ROLE; BEGIN;");
    try {
      // Only this transaction simulates a corrupt/legacy parentless row. The
      // actual schema and original fixture are restored by the rollback.
      await db.exec("ALTER TABLE purama_ai.karta_pending_actions DROP CONSTRAINT karta_pending_actions_run_id_fkey;");
      await db.query("DELETE FROM purama_ai.karta_runs WHERE id=$1", [runId]);
      await db.exec("SET LOCAL ROLE service_role;");
      await expect(claim()).rejects.toThrow("Cycle not ready");
    } finally {
      await db.exec("ROLLBACK; SET ROLE service_role;");
    }
    expect(await action()).toMatchObject({ status: "pending", claimed_at: null });
  });

  it.each([
    "null", "object", "string", "null_entry", "scalar_entry", "missing_entry",
    "other_id", "other_tool", "true_success", "string_success", "missing_success",
    "wrong_outcome", "missing_outcome", "duplicate", "mixed_duplicate", "mixed_malformed",
  ])("fails closed for a malformed or ambiguous journal: %s", async invalid => {
    const traces: Record<string, unknown> = {
      null: null, object: {}, string: "PRIVATE_APPROVAL_PARENT_SENTINEL",
      null_entry: [null], scalar_entry: [7], missing_entry: [{}],
      other_id: [entry({ pendingActionId: otherActionId })],
      other_tool: [entry({ tool: "different_tool" })],
      true_success: [entry({ success: true })],
      string_success: [entry({ success: "false" })],
      missing_success: [entry({ success: undefined })],
      wrong_outcome: [entry({ outcome: "executed" })],
      missing_outcome: [entry({ outcome: undefined })],
      duplicate: [entry(), entry()],
      mixed_duplicate: [entry(), entry({ tool: "different_tool" })],
      mixed_malformed: [entry(), null],
    };
    await seed({ tools: traces[invalid] });
    await expectBlocked();
  });

  it.each(["approve", "reject"])("admits and finalizes a valid %s using the unchanged 006 finalizer", async decision => {
    await seed();
    const admitted = await claim(actionId, decision);
    expect(admitted.rows).toHaveLength(1);
    expect(admitted.rows[0]).toMatchObject({ id: actionId, status: "executing", tool_params: privatePayload });
    expect(admitted.rows[0].claimed_at).not.toBeNull();
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,$2,'metadata')",
      [actionId, decision === "approve" ? "executed" : "rejected"]);
    expect(await action()).toMatchObject({
      status: decision === "approve" ? "executed" : "rejected", tool_params: privatePayload,
    });
    const parent = (await db.query<{ status: string }>("SELECT status FROM purama_ai.karta_runs WHERE id=$1", [runId])).rows[0];
    expect(parent.status).toBe(decision === "approve" ? "success" : "skipped");
  });

  it("admits the next approval after partial resolution clears finished_at but preserves the initial closure", async () => {
    await seed({ tools: [entry(), entry({ pendingActionId: otherActionId })] });
    await db.query(
      `INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [otherActionId, owner, runId, agent, toolName, JSON.stringify(privatePayload)],
    );
    expect((await claim()).rows).toHaveLength(1);
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,'executed','metadata')", [actionId]);
    const parent = (await db.query<{ status: string; duration_ms: number; finished_at: string | null }>(
      "SELECT status,duration_ms,finished_at FROM purama_ai.karta_runs WHERE id=$1", [runId],
    )).rows[0];
    expect(parent).toMatchObject({ status: "awaiting_approval", duration_ms: 0, finished_at: null });
    expect((await claim(otherActionId)).rows).toHaveLength(1);
    await db.query("SELECT purama_ai.karta_finalize_pending_action($1,'executed','metadata')", [otherActionId]);
    expect((await db.query<{ status: string }>("SELECT status FROM purama_ai.karta_runs WHERE id=$1", [runId])).rows[0].status).toBe("success");
  });

  it("accepts the metadata-only privacy marker and preserves the exact approval payload", async () => {
    await seed({ tools: [
      { tool: "prior_tool", outcome: "executed", success: true },
      entry({ tracePolicy: "metadata_only" }),
    ] });
    const admitted = await claim();
    expect(admitted.rows).toHaveLength(1);
    expect(admitted.rows[0].tool_params).toEqual(privatePayload);
    expect((await action()).tool_params).toEqual(privatePayload);
  });

  it("does not claim an already admitted approval twice or reset its claim timestamp", async () => {
    await seed();
    const first = (await claim()).rows[0];
    expect((await claim()).rows).toEqual([]);
    expect(await action()).toMatchObject({ status: "executing", claimed_at: first.claimed_at, tool_params: privatePayload });
  });

  it.each(["global", "global_missing", "disabled", "kill_switch", "simulation", "agent_missing"])(
    "preserves the existing approve stop: %s", async stop => {
      await seed();
      if (stop === "global") await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=true WHERE id='global';");
      else if (stop === "global_missing") await db.exec("DELETE FROM purama_ai.karta_global_state;");
      else if (stop === "agent_missing") await db.exec("DELETE FROM purama_ai.karta_agent_state;");
      else if (stop === "disabled") await db.exec("UPDATE purama_ai.karta_agent_state SET is_enabled=false;");
      else if (stop === "kill_switch") await db.exec("UPDATE purama_ai.karta_agent_state SET kill_switch=true;");
      else await db.exec("UPDATE purama_ai.karta_agent_state SET simulation_mode=true;");
      await expectBlocked("approve", stop.startsWith("global") ? "Global stop active" : "Agent cannot execute");
    },
  );

  it("allows rejection of a valid journal entry while the agent and global switch are stopped", async () => {
    await seed();
    await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=true; UPDATE purama_ai.karta_agent_state SET is_enabled=false,kill_switch=true,simulation_mode=true;");
    expect((await claim(actionId, "reject")).rows).toHaveLength(1);
    expect(await action()).toMatchObject({ status: "executing", tool_params: privatePayload });
  });

  it.each([null, "", "execute"])("refuses an invalid decision before admission: %j", async decision => {
    await seed();
    await expectBlocked(decision, "Invalid decision");
  });

  it.each(["anon", "authenticated"])("does not expose approval admission to %s", async role => {
    await seed();
    await db.exec("RESET ROLE; SET ROLE " + role + ";");
    try {
      await expect(claim()).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE; SET ROLE service_role;");
    }
    expect(await action()).toMatchObject({ status: "pending", claimed_at: null });
  });
});
