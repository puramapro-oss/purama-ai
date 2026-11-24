import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { normalizeModelUsage, programmaticUsageEnvelope } from "../src/claude/usage.js";
import { projectPrivateToolResult } from "../src/engine/private-tool-results.js";

// Actual migrations/RPC/trigger in one PostgreSQL backend. This covers durable
// state transitions, not native multi-session locking or a provider sandbox.
const OWNER = "00000000-0000-4000-8000-000000000951";
const OTHER_OWNER = "00000000-0000-4000-8000-000000000952";
const AGENT = "00000000-0000-4000-8000-000000000953";
const OTHER_AGENT = "00000000-0000-4000-8000-000000000954";
const TYPE = `custom:${AGENT}`;
const PRIVATE = "PRIVATE_COMPLETED_REPORT_AND_BRIEF";
const singleReceipt = normalizeModelUsage({ id: "msg_brief_final", model: "fixture-main", usage: {
  input_tokens: 7, output_tokens: 3,
} }, "fixture-main", "https://api.anthropic.com");
const usage = programmaticUsageEnvelope([{ receipt: singleReceipt, codeExecutionRequests: 0 }]);
let db: PGlite;
let migration: string;

async function seed(options: { owner?: string; agent?: string; arm?: boolean } = {}) {
  const owner = options.owner ?? OWNER;
  const agent = options.agent ?? AGENT;
  const type = `custom:${agent}`;
  const runId = randomUUID();
  const briefId = randomUUID();
  await db.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,claude_mock) VALUES($1,$2,$3,'manual','live','running',false)", [runId, owner, type]);
  await db.query("INSERT INTO purama_ai.karta_agent_memory(id,user_id,agent_type,memory_key,memory_value) VALUES($1,$2,$3,'pending_brief',$4::jsonb)", [briefId, owner, type, JSON.stringify(PRIVATE)]);
  await db.query("SELECT * FROM purama_ai.karta_claim_pending_brief($1,$2,$3,'pending_brief')", [owner, type, runId]);
  if (options.arm !== false) await db.query("SELECT purama_ai.karta_arm_pending_brief($1,$2,$3)", [owner, type, runId]);
  return { runId, briefId, owner, agent, type };
}
type Mission = Awaited<ReturnType<typeof seed>>;
async function store(mission: Mission, reads: string[] = []) {
  const payload = projectPrivateToolResult("programmatic_report", { summary: PRIVATE, read_tools: reads });
  expect(payload).not.toBeNull();
  return (await db.query<{ id: string }>("SELECT purama_ai.karta_store_tool_result($1,$2,$3,$4,'programmatic_report',$5::jsonb) AS id", [
    mission.owner, mission.type, mission.runId, `${mission.runId}:0`, JSON.stringify(payload),
  ])).rows[0].id;
}
async function finish(mission: Mission, options: {
  status?: string; tools?: unknown; mode?: string; mock?: boolean; usage?: unknown; finished?: boolean;
} = {}) {
  const modelUsage = Object.hasOwn(options, "usage") ? options.usage : usage;
  await db.query(`UPDATE purama_ai.karta_runs SET status=$2,tools_used=$3::jsonb,mode=$4,claude_mock=$5,
    model_usage=$6::jsonb,duration_ms=1,finished_at=CASE WHEN $7::boolean THEN now() ELSE NULL END WHERE id=$1`, [
    mission.runId, options.status ?? "success", JSON.stringify(options.tools ?? []), options.mode ?? "live",
    options.mock ?? false, modelUsage === null ? null : JSON.stringify(modelUsage), options.finished !== false,
  ]);
}
const state = async (mission: Mission) => (await db.query<{ state: string }>("SELECT state FROM purama_ai.karta_brief_claims WHERE run_id=$1", [mission.runId])).rows[0].state;
const action = (outcome: string) => ({ tool: "web_search", paramsSummary: "metadata", resultSummary: "metadata", outcome, success: outcome === "executed" });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;
    CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA purama_ai,auth TO anon,authenticated,service_role;
    CREATE TABLE purama_ai.creator_agents(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
      is_active boolean DEFAULT true,karta_enabled boolean DEFAULT true,tools_enabled text[] DEFAULT '{}');
    ALTER TABLE purama_ai.creator_agents ENABLE ROW LEVEL SECURITY;
    CREATE POLICY owner_read ON purama_ai.creator_agents FOR SELECT TO authenticated USING(user_id=auth.uid());`);
  for (const name of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  await db.exec("GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA purama_ai TO service_role; GRANT SELECT ON ALL TABLES IN SCHEMA purama_ai TO authenticated;");
  for (const name of ["018_karta_brief_claims.sql", "028_private_tool_results.sql", "029_model_usage_receipts.sql", "033_programmatic_model_usage.sql", "034_programmatic_private_reports.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const before = await db.query("SELECT oid,prosecdef,proconfig,proacl::text FROM pg_proc WHERE oid='purama_ai.karta_settle_brief_after_run()'::regprocedure");
  const trigger = await db.query("SELECT oid,tgfoid,tgtype,tgenabled,tgattr::text FROM pg_trigger WHERE tgname='karta_settle_brief_after_run'");
  migration = await readFile(new URL("../migrations/035_programmatic_report_brief_completion.sql", import.meta.url), "utf8");
  await db.exec(migration);
  expect((await db.query("SELECT oid,prosecdef,proconfig,proacl::text FROM pg_proc WHERE oid='purama_ai.karta_settle_brief_after_run()'::regprocedure")).rows).toEqual(before.rows);
  expect((await db.query("SELECT oid,tgfoid,tgtype,tgenabled,tgattr::text FROM pg_trigger WHERE tgname='karta_settle_brief_after_run'")).rows).toEqual(trigger.rows);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [OWNER, OTHER_OWNER]);
  await db.query("INSERT INTO purama_ai.creator_agents(id,user_id,tools_enabled) VALUES($1,$2,ARRAY['web_search']),($3,$4,ARRAY['web_search'])", [AGENT, OWNER, OTHER_AGENT, OTHER_OWNER]);
  await db.exec("SET ROLE service_role; INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;");
  await db.query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,is_enabled,simulation_mode) VALUES($1,$2,true,false),($3,$4,true,false)", [OWNER, TYPE, OTHER_OWNER, `custom:${OTHER_AGENT}`]);
});

describe("durable completion of a private report without fabricated tool actions", () => {
  it("completes an armed live brief after a stored no-read report and native usage", async () => {
    const mission = await seed(); const resultId = await store(mission);
    await finish(mission);
    expect(await state(mission)).toBe("completed");
    expect((await db.query("SELECT tools_used FROM purama_ai.karta_runs WHERE id=$1", [mission.runId])).rows).toEqual([{ tools_used: [] }]);
    expect((await db.query("SELECT id,payload->>'summary' AS summary FROM purama_ai.karta_tool_results WHERE run_id=$1", [mission.runId])).rows).toEqual([{ id: resultId, summary: PRIVATE }]);
    // Migrations run as the schema owner; the service role deliberately cannot
    // replace functions or widen their grants.
    await db.exec("RESET ROLE");
    await db.exec(migration);
    await db.exec("SET ROLE service_role");
    expect(await state(mission)).toBe("completed");
    expect(await store(mission)).toBe(resultId); // Identical lost-ack reconciliation, no second result.
  });

  it.each(["no report", "another run", "another owner", "v1 usage", "no usage", "declared unread tool", "mock", "simulation", "error", "unfinished", "failed action", "invalid trace", "pending approval"])(
    "keeps reconciliation required for %s", async scenario => {
      const mission = await seed();
      if (scenario === "another run") await store(await seed());
      else if (scenario === "another owner") await store(await seed({ owner: OTHER_OWNER, agent: OTHER_AGENT }));
      else if (scenario !== "no report") await store(mission, scenario === "declared unread tool" ? ["web_search"] : []);
      const options: Parameters<typeof finish>[1] = {};
      if (scenario === "v1 usage") options.usage = singleReceipt;
      if (scenario === "no usage") options.usage = null;
      if (scenario === "mock") options.mock = true;
      if (scenario === "simulation") options.mode = "simulation";
      if (scenario === "error") options.status = "error";
      if (scenario === "unfinished") options.finished = false;
      if (scenario === "failed action") options.tools = [action("failed")];
      if (scenario === "invalid trace") options.tools = [{ success: true }];
      if (scenario === "pending approval") await db.query("INSERT INTO purama_ai.karta_pending_actions(user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,'web_search','{}')", [OWNER, mission.runId, TYPE]);
      await finish(mission, options);
      expect(await state(mission)).toBe("reconciliation_required");
    },
  );

  it("never returns an unarmed but already delivered report to automatic ready state", async () => {
    const mission = await seed({ arm: false }); await store(mission); await finish(mission);
    expect(await state(mission)).toBe("reconciliation_required");
  });

  it("preserves historical no-effect recovery when no report or action was delivered", async () => {
    const mission = await seed({ arm: false }); await finish(mission, { status: "error", usage: null });
    expect(await state(mission)).toBe("ready");
  });

  it("preserves completion through the existing executed-action trace", async () => {
    const mission = await seed(); await finish(mission, { tools: [action("executed")], usage: singleReceipt });
    expect(await state(mission)).toBe("completed");
  });

  it("does not recreate an owner-deleted report or reopen its completed brief", async () => {
    const mission = await seed(); const id = await store(mission); await finish(mission);
    await db.query("SELECT set_config('test.user_id',$1,false)", [OWNER]);
    await db.exec("SET ROLE authenticated");
    expect((await db.query("DELETE FROM purama_ai.karta_tool_results WHERE id=$1 RETURNING id", [id])).rows).toEqual([{ id }]);
    await db.exec("SET ROLE service_role");
    await expect(store(mission)).rejects.toThrow("Private result unavailable");
    await finish(mission);
    expect(await state(mission)).toBe("completed");
  });
});
