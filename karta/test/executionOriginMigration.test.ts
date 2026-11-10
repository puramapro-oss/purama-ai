import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { KARTA_CANONICAL_MIGRATIONS, KARTA_COMMON_MIGRATIONS, KARTA_PR33_ADDITIONS } from "./migration-fixtures.js";

// One isolated database avoids retaining several WASM instances. Every case
// recreates its schemas; no deployed database or external transport is used.
let db: PGlite;
let originSql: string;
const owner = "00000000-0000-4000-8000-000000000901";
const foreignOwner = "00000000-0000-4000-8000-000000000902";
const runId = "00000000-0000-4000-8000-000000000903";
const actionId = "00000000-0000-4000-8000-000000000904";
const origin = { type: "delegation", source: "partner", payload: {
  reason: "upgrade fixture", kartaDelegation: { depth: 1, lineage: ["partner", "legal"] },
} };
const minimal = ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql", "019_karta_approval_parent_guard.sql"];

async function apply(names: readonly string[]) {
  for (const name of names) await db.exec(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
}

async function initialize(names: readonly string[]) {
  await db.exec(`
    RESET ROLE;
    DROP SCHEMA IF EXISTS auth,purama_ai,public CASCADE;
    CREATE SCHEMA public; CREATE SCHEMA purama_ai; CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql
      AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid';
  `);
  await db.exec(await readFile(new URL("../../supabase/migrations/20260407000000_creator_agent.sql", import.meta.url), "utf8"));
  await apply(names);
}

async function seedApproval(savedOrigin?: typeof origin) {
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [owner, foreignOwner]);
  await db.query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,is_enabled,simulation_mode) VALUES($1,'legal',true,false)", [owner]);
  await db.exec("UPDATE purama_ai.karta_global_state SET kill_switch=false WHERE id='global'");
  await db.query(`INSERT INTO purama_ai.karta_runs
    (id,user_id,agent_type,trigger_type,trigger_source,mode,status,duration_ms,claude_mock,tools_used)
    VALUES($1,$2,'legal','manual','fixture','live','awaiting_approval',1,false,$3)`,
  [runId, owner, JSON.stringify([{ tool: "inert", pendingActionId: actionId, outcome: "pending", success: false }])]);
  await db.query(`INSERT INTO purama_ai.karta_pending_actions
    (id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,'legal','inert','{}')`, [actionId, owner, runId]);
  if (savedOrigin) await db.query("UPDATE purama_ai.karta_pending_actions SET execution_trigger=$1 WHERE id=$2", [savedOrigin, actionId]);
}

async function authoritySnapshot() {
  return (await db.query(`SELECT
    c.relrowsecurity, c.relforcerowsecurity, c.relacl::text,
    (SELECT jsonb_agg(jsonb_build_object('name',p.polname,'roles',p.polroles::text,
      'command',p.polcmd,'using',pg_get_expr(p.polqual,p.polrelid),
      'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname)
      FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
    p.proretset,p.prorettype=c.reltype AS returns_owned_row,p.proacl::text AS claim_acl,
    pg_get_functiondef(p.oid) AS claim_body
    FROM pg_class c JOIN pg_proc p
      ON p.oid='purama_ai.karta_claim_pending_action(uuid,text)'::regprocedure
    WHERE c.oid='purama_ai.karta_pending_actions'::regclass`)).rows;
}

async function expectOwnedClaim(savedOrigin: typeof origin | null) {
  // Authenticated users receive no new claim capability from the added column.
  await db.exec("SET ROLE authenticated");
  try {
    await expect(db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId]))
      .rejects.toThrow(/permission denied/);
  } finally { await db.exec("RESET ROLE"); }
  const claimed = (await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId])).rows;
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({ id: actionId, user_id: owner, run_id: runId,
    status: "executing", execution_trigger: savedOrigin });
  expect((await db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [actionId])).rows).toEqual([]);

  const foreignAction = "00000000-0000-4000-8000-000000000905";
  await db.query(`INSERT INTO purama_ai.karta_pending_actions
    (id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,'legal','inert','{}')`, [foreignAction, foreignOwner, runId]);
  await expect(db.query("SELECT * FROM purama_ai.karta_claim_pending_action($1,'approve')", [foreignAction]))
    .rejects.toThrow(/Cycle not ready/);
  expect((await db.query("SELECT user_id,status FROM purama_ai.karta_pending_actions WHERE id=$1", [foreignAction])).rows)
    .toEqual([{ user_id: foreignOwner, status: "pending" }]);
}

async function legacySql(name: string, sha256: string) {
  const sql = await readFile(new URL("./fixtures/aether-a40fbd1/" + name, import.meta.url), "utf8");
  expect(createHash("sha256").update(sql).digest("hex")).toBe(sha256);
  return sql;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  originSql = await readFile(new URL("../migrations/026_pending_action_execution_origin.sql", import.meta.url), "utf8");
});
afterAll(async () => { await db?.close(); });

describe("canonical 026 origin migration and historical upgrades", () => {
  it("applies the exact fresh canonical schema and returns the extended owned row from the real claim", async () => {
    await initialize(KARTA_CANONICAL_MIGRATIONS);
    await seedApproval(origin);
    const authority = await authoritySnapshot();
    await db.exec(originSql);
    expect(await authoritySnapshot()).toEqual(authority);
    await expectOwnedClaim(origin);
    await expect(db.query("UPDATE purama_ai.karta_pending_actions SET execution_trigger='[]' WHERE id=$1", [actionId]))
      .rejects.toThrow(/execution_trigger_shape/);
    await expect(db.query("UPDATE purama_ai.karta_pending_actions SET execution_trigger=$1 WHERE id=$2", [{ reason: "x".repeat(16384) }, actionId]))
      .rejects.toThrow(/execution_trigger_shape/);
  }, 30_000);

  it("upgrades PR33 without inventing legacy origins or changing RLS, grants or the claim body", async () => {
    await initialize([...KARTA_COMMON_MIGRATIONS, ...KARTA_PR33_ADDITIONS]);
    await seedApproval();
    const rows = (await db.query<Record<string, unknown>>("SELECT * FROM purama_ai.karta_pending_actions")).rows;
    const authority = await authoritySnapshot();
    await db.exec(originSql);
    await db.exec(originSql);
    expect(await authoritySnapshot()).toEqual(authority);
    expect((await db.query("SELECT * FROM purama_ai.karta_pending_actions")).rows)
      .toEqual(rows.map(row => ({ ...row, execution_trigger: null })));
    await expectOwnedClaim(null);
  }, 30_000);

  it("recognizes exact Aether origins and preserves its reservation through canonical 021--026", async () => {
    await initialize(KARTA_COMMON_MIGRATIONS);
    await db.exec(await legacySql("021_pending_action_execution_trigger.sql", "7a7f231fafdcd47acc6ee1200d4522bb45784ec90b31379f364e323edaa7da8c"));
    await db.exec(await legacySql("022_chef_budget_reservations.sql", "d552aa820f62e753d83ab4f9e3aab4265f09c86a9f66cacab9ba6627dd9f32af"));
    await seedApproval(origin);
    const authority = await authoritySnapshot();
    const mission = "00000000-0000-4000-8000-000000000910";
    await db.query(`INSERT INTO purama_ai.chef_missions
      (id,user_id,brief_id,brief_hash,goal,repo,state,max_parallel,token_budget,cost_budget_micros)
      VALUES($1,$2,'aether-upgrade',repeat('a',64),'Review','repo','active',4,100,100)`, [mission, owner]);
    await db.query(`INSERT INTO purama_ai.chef_tasks
      (mission_id,task_key,title,instructions,state,brief_hash,access_mode,verification_profiles,estimated_tokens,estimated_cost_micros,priority)
      VALUES($1,'first','First','Review','ready',repeat('a',64),'read',ARRAY['review'],70,70,10),
            ($1,'second','Second','Review','ready',repeat('a',64),'read',ARRAY['review'],70,70,0)`, [mission]);
    await db.exec("SELECT purama_ai.chef_heartbeat_worker('old-worker','codex','fixture','idle','session-old-worker',1,NULL,'repo',NULL,NULL,'{}')");
    const first = (await db.query<{ id: string; attempt: number; fencing_token: number }>(
      "SELECT id,attempt,fencing_token FROM purama_ai.chef_claim_next_task($1,'old-worker','session-old-worker','codex',300)", [mission])).rows[0];
    expect(first).toBeDefined();
    const reservations = (await db.query("SELECT * FROM purama_ai.chef_budget_reservations")).rows;

    await apply(KARTA_PR33_ADDITIONS);
    await db.exec(originSql);
    await db.exec(originSql);
    expect(await authoritySnapshot()).toEqual(authority);
    expect((await db.query("SELECT * FROM purama_ai.chef_budget_reservations")).rows).toEqual(reservations);
    expect((await db.query("SELECT execution_trigger FROM purama_ai.karta_pending_actions WHERE id=$1", [actionId])).rows)
      .toEqual([{ execution_trigger: origin }]);
    await db.exec("SELECT purama_ai.chef_heartbeat_worker('new-worker','codex','fixture','idle','session-new-worker',1,NULL,'repo',NULL,NULL,'{}')");
    expect((await db.query("SELECT id FROM purama_ai.chef_claim_next_task($1,'new-worker','session-new-worker','codex',300)", [mission])).rows).toEqual([]);
    const receipt = [mission, first.id, first.attempt, first.fencing_token];
    await db.query("SELECT purama_ai.chef_record_claim_usage('upgrade-receipt',$1,$2,'old-worker','codex','fixture',20,0,0,20,$3,$4)", receipt);
    await db.query("SELECT purama_ai.chef_record_claim_usage('upgrade-receipt-copy',$1,$2,'old-worker','codex','fixture',20,0,0,20,$3,$4)", receipt);
    expect((await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows)
      .toEqual([{ tokens_used: 20, cost_used_micros: 20 }]);
    expect((await db.query("SELECT task_key FROM purama_ai.chef_claim_next_task($1,'new-worker','session-new-worker','codex',300)", [mission])).rows)
      .toEqual([{ task_key: "second" }]);
    await expectOwnedClaim(origin);
  }, 30_000);

  it.each([
    ["text column", "ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN execution_trigger text", /unknown execution_trigger column/],
    ["invented default", "ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN execution_trigger jsonb DEFAULT '{}'", /unknown execution_trigger column/],
    ["missing constraint", "ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN execution_trigger jsonb", /no recognized shape constraint/],
    ["weak shape", "ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN execution_trigger jsonb; ALTER TABLE purama_ai.karta_pending_actions ADD CONSTRAINT karta_pending_actions_execution_trigger_shape CHECK(execution_trigger IS NULL OR jsonb_typeof(execution_trigger)='object')", /shape differs/],
    ["unvalidated shape", "ALTER TABLE purama_ai.karta_pending_actions ADD COLUMN execution_trigger jsonb; ALTER TABLE purama_ai.karta_pending_actions ADD CONSTRAINT karta_pending_actions_execution_trigger_shape CHECK(execution_trigger IS NULL OR (jsonb_typeof(execution_trigger)='object' AND octet_length(execution_trigger::text)<=16384)) NOT VALID", /unknown execution_trigger constraint/],
    ["disabled RLS", "ALTER TABLE purama_ai.karta_pending_actions DISABLE ROW LEVEL SECURITY", /protected pending action table prerequisite/],
    ["missing claim", "DROP FUNCTION purama_ai.karta_claim_pending_action(uuid,text)", /SETOF claim prerequisite/],
  ] as const)("rejects %s transactionally without replacing the unknown schema", async (_label, change, message) => {
    await initialize(minimal);
    await seedApproval();
    await db.exec(change);
    const before = (await db.query("SELECT * FROM purama_ai.karta_pending_actions")).rows;
    const columns = (await db.query("SELECT attname,atttypid,attnotnull,atthasdef FROM pg_attribute WHERE attrelid='purama_ai.karta_pending_actions'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows;
    await expect(db.exec(originSql)).rejects.toThrow(message);
    await db.exec("ROLLBACK");
    expect((await db.query("SELECT * FROM purama_ai.karta_pending_actions")).rows).toEqual(before);
    expect((await db.query("SELECT attname,atttypid,attnotnull,atthasdef FROM pg_attribute WHERE attrelid='purama_ai.karta_pending_actions'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum")).rows).toEqual(columns);
  }, 30_000);
});
