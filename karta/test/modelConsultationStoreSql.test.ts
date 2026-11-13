import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { CHEF_RECONCILIATION_MIGRATIONS } from "./migration-fixtures.js";
import { normalizeConsultationRequest } from "../src/claude/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";
import { normalizeModelUsage } from "../src/claude/usage.js";

const OWNER = "00000000-0000-4000-8000-000000000901";
const OTHER = "00000000-0000-4000-8000-000000000902";
const plan = resolveModelExecutionPlan({ model: "qualified-model" }, [{ model: "qualified-model", reasoning: "none", maxOutputTokens: 1024 }]);
const estimates = { policyVersion: "local-test-v1", calls: [
  { kind: "synthesis", provider: "anthropic", model: "qualified-model", maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 50 },
] };
const expires = "2099-01-01T00:00:00Z";
let db: PGlite;
type Row = { created: boolean; generation?: string; operation: { operationId: string; state: string; resourceState: string; result: unknown } };
async function scalar<T>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
const request = (operationId = "op-1", question = "Question privée", userId = OWNER) => normalizeConsultationRequest({
  operationId, userId, question, preferences: { model: "qualified-model" },
});
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function provision(tokens = 10000, cost = 100, parallel = 4, user = OWNER) {
  return scalar<string>("SELECT purama_ai.model_consultation_provision($1,$2,$3,$4,$5) AS value", [user, tokens, cost, expires, parallel]);
}
async function begin(id = "op-1", question = "Question privée", user = OWNER): Promise<Row> {
  const r = request(id, question, user);
  return scalar("SELECT purama_ai.model_consultation_create($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) AS value", [user, id, fingerprint(r), JSON.stringify(r), JSON.stringify(plan), JSON.stringify(estimates)]);
}
async function start(row: Row, user = OWNER, generation = row.generation) {
  return scalar<boolean>("SELECT purama_ai.model_consultation_start($1,$2,$3,$4) AS value", [user, row.operation.operationId, fingerprint(request(row.operation.operationId)), generation]);
}
const call = (id = "op-1", number = 1) => ({ operationId: id, userId: OWNER, callId: `${id}:${number}`, kind: "synthesis", provider: "anthropic", model: "qualified-model", inputHash: "a".repeat(64), maxOutputTokens: 1024 });
async function reserve(row: Row, value = call(row.operation.operationId)) {
  return scalar<boolean>("SELECT purama_ai.model_consultation_reserve($1,$2,$3,$4::jsonb) AS value", [OWNER, row.operation.operationId, row.generation, JSON.stringify(value)]);
}
const usage = normalizeModelUsage({ model: "qualified-model", id: "msg_local", usage: { input_tokens: 50, output_tokens: 3,
  cache_read_input_tokens: 20, cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
} }, "qualified-model", "https://api.anthropic.com");
const receipt = (id = "op-1") => ({ call: call(id), status: "completed", usage: [usage] });
async function settle(row: Row, value: unknown = receipt(row.operation.operationId)) {
  return scalar<boolean>("SELECT purama_ai.model_consultation_settle($1,$2,$3,$4::jsonb) AS value", [OWNER, row.operation.operationId, row.generation, JSON.stringify(value)]);
}
const result = (answer = "Réponse privée réellement obtenue") => ({ status: "complete", reason: "completed", plan, answer,
  citedSourceIds: [], disagreements: [], uncertainties: [], sources: [], receipts: [], verificationStatus: "unverified" });
async function finalize(row: Row, value = result()) {
  return scalar<Record<string, unknown>>("SELECT purama_ai.model_consultation_finalize($1,$2,$3,$4::jsonb) AS value", [OWNER, row.operation.operationId, row.generation, JSON.stringify(value)]);
}
const status = (id = "op-1", user = OWNER) => scalar<Record<string, unknown> | null>("SELECT purama_ai.model_consultation_status($1,$2) AS value", [user, id]);
const cancel = (id = "op-1", user = OWNER) => scalar<Record<string, unknown> | null>("SELECT purama_ai.model_consultation_cancel($1,$2) AS value", [user, id]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA auth,purama_ai TO service_role,authenticated,anon;`);
  for (const file of [...CHEF_RECONCILIATION_MIGRATIONS, "030_chef_capability_selection.sql"]) {
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const before = await scalar<string>("SELECT pg_get_functiondef('purama_ai.chef_claim_next_task(uuid,text,text,text,integer)'::regprocedure) AS value");
  await db.exec(await readFile(new URL("../migrations/031_model_consultation.sql", import.meta.url), "utf8"));
  expect(await scalar("SELECT pg_get_functiondef('purama_ai.chef_claim_next_task(uuid,text,text,text,integer)'::regprocedure) AS value")).toBe(before);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await db.query("INSERT INTO auth.users VALUES($1),($2)", [OWNER, OTHER]);
  await db.exec("SET ROLE service_role");
});

describe("consultation SQL authority on the existing CHEF ledger", () => {
  it("never completes an unused consultation resource through code-mission housekeeping", async () => {
    const mission = await provision();
    expect(await scalar("SELECT purama_ai.chef_try_finish_mission($1) AS value", [mission])).toBe(false);
    expect((await db.query("SELECT state,finished_at FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows).toEqual([
      { state: "active", finished_at: null },
    ]);
    expect(await scalar("SELECT purama_ai.model_consultation_availability($1) AS value", [OWNER])).toBe(true);
    expect((await begin()).created).toBe(true);
  });

  it("preserves code-mission completion only after its required tasks finish", async () => {
    const mission = await scalar<string>(`INSERT INTO purama_ai.chef_missions(user_id,brief_id,brief_hash,goal,repo,state)
      VALUES($1,'completion-regression',$2,'Existing code completion','fixture-repo','active') RETURNING id AS value`, [OWNER, "a".repeat(64)]);
    const task = await scalar<string>(`INSERT INTO purama_ai.chef_tasks(mission_id,task_key,title,instructions,brief_hash,state,verification_profiles,access_mode)
      VALUES($1,'required-task','Review','Review code',$2,'pending',ARRAY['review'],'read') RETURNING id AS value`, [mission, "a".repeat(64)]);
    expect(await scalar("SELECT purama_ai.chef_try_finish_mission($1) AS value", [mission])).toBe(false);
    await db.query("UPDATE purama_ai.chef_tasks SET state='verified_done' WHERE id=$1", [task]);
    expect(await scalar("SELECT purama_ai.chef_try_finish_mission($1) AS value", [mission])).toBe(true);
    expect((await db.query("SELECT kind,state,finished_at IS NOT NULL AS finished FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows).toEqual([
      { kind: "code", state: "verified_done", finished: true },
    ]);
    expect(await scalar("SELECT purama_ai.chef_try_finish_mission($1) AS value", [mission])).toBe(false);
  });

  it.each(["code-first", "resource-first"] as const)("keeps resource grants outside the code-brief namespace (%s)", async order => {
    const brief = { briefId: "model-consultation-resources", version: 1, repo: "fixture-repo", goal: "Valid user-selected brief identifier",
      requirements: [{ key: "R1", description: "Review", critical: false }], tasks: [{ key: "T1", title: "Review", instructions: "Review code",
        accessMode: "read", provider: "codex", requirementKeys: ["R1"], verificationProfiles: ["review"], estimatedTokens: 20, estimatedCostMicros: 10 }] };
    const createCodeMission = () => scalar<string>("SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,1,100,50) AS value", [OWNER, JSON.stringify(brief), fingerprint(brief)]);
    let mission: string;
    let resource: string;
    if (order === "code-first") { mission = await createCodeMission(); resource = await provision(); }
    else { resource = await provision(); mission = await createCodeMission(); }
    expect(mission).not.toBe(resource);
    expect(await createCodeMission()).toBe(mission);
    expect(await provision()).toBe(resource);
    expect((await db.query("SELECT kind,brief_id,repo FROM purama_ai.chef_missions ORDER BY kind")).rows).toEqual([
      { kind: "code", brief_id: brief.briefId, repo: "fixture-repo" },
      { kind: "consultation", brief_id: null, repo: null },
    ]);
    await expect(db.query("UPDATE purama_ai.chef_missions SET brief_id=NULL WHERE id=$1", [mission])).rejects.toMatchObject({ code: "23514" });
    await expect(db.query("UPDATE purama_ai.chef_missions SET brief_id='code-brief' WHERE id=$1", [resource])).rejects.toMatchObject({ code: "23514" });
  });

  it("preserves real legacy code mission ingestion, admission and reconciliation after migration 031", async () => {
    const brief = { briefId: "legacy-code", version: 1, repo: "fixture-repo", goal: "Existing code path",
      requirements: [{ key: "R1", description: "Review", critical: false }], tasks: [{ key: "T1", title: "Review", instructions: "Review code",
        accessMode: "read", provider: "codex", requirementKeys: ["R1"], verificationProfiles: ["review"], estimatedTokens: 20, estimatedCostMicros: 10 }] };
    const mission = await scalar<string>("SELECT purama_ai.chef_create_mission($1,$2::jsonb,$3,1,100,50) AS value", [OWNER, JSON.stringify(brief), fingerprint(brief)]);
    expect((await db.query("SELECT kind,repo FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows).toEqual([{ kind: "code", repo: "fixture-repo" }]);
    await db.query("SELECT purama_ai.chef_heartbeat_worker('existing-worker','codex','fixture-model','idle','existing-session',1,NULL,'fixture-repo',NULL,NULL,'{}')");
    const task = (await db.query<{ id: string; attempt: number; fencing_token: number }>("SELECT * FROM purama_ai.chef_claim_next_task($1,'existing-worker','existing-session','codex',300)", [mission])).rows[0];
    expect(task).toBeDefined();
    expect(await scalar("SELECT purama_ai.chef_record_claim_usage('legacy-code-final',$1,$2,'existing-worker','codex','fixture-model',5,2,0,3,$3,$4) AS value", [mission, task.id, task.attempt, task.fencing_token])).toBe(true);
    expect((await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE id=$1", [mission])).rows).toEqual([{ tokens_used: 7, cost_used_micros: 3 }]);
  });

  it("requires an explicit finite grant and does not allocate one on demand", async () => {
    expect(await scalar("SELECT purama_ai.model_consultation_availability($1) AS value", [OWNER])).toBe(false);
    await expect(begin()).rejects.toMatchObject({ code: "PCO02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_missions")).toBe(0);
    const id = await provision();
    expect(await provision()).toBe(id);
    await expect(provision(20000)).rejects.toMatchObject({ code: "PCO01" });
    expect((await db.query("SELECT kind,repo,token_budget,cost_budget_micros FROM purama_ai.chef_missions")).rows).toEqual([
      { kind: "consultation", repo: null, token_budget: 10000, cost_budget_micros: 100 },
    ]);
    expect(await scalar("SELECT purama_ai.model_consultation_availability($1) AS value", [OWNER])).toBe(true);
  });

  it("coalesces concurrent duplicate submissions and refuses a changed request", async () => {
    await provision();
    const rows = await Promise.all([begin(), begin()]);
    expect(rows.filter(row => row.created)).toHaveLength(1);
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(1);
    await expect(begin("op-1", "Autre question")).rejects.toMatchObject({ code: "PCO01" });
    const value = request();
    expect(await scalar("SELECT purama_ai.model_consultation_resume($1,$2,$3,$4::jsonb) AS value", [OWNER, "op-1", fingerprint(value), JSON.stringify(value)])).toMatchObject({ state: "pending" });
    await expect(scalar("SELECT purama_ai.model_consultation_resume($1,$2,$3,$4::jsonb) AS value", [OWNER, "op-1", "b".repeat(64), JSON.stringify(value)])).rejects.toMatchObject({ code: "PCO01" });
  });

  it("serializes competing envelopes against shared totals", async () => {
    await provision(10000, 50);
    const attempts = await Promise.allSettled([begin("op-a"), begin("op-b")]);
    expect(attempts.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(value => value.status === "rejected")).toHaveLength(1);
    expect(await scalar("SELECT sum(reserved_cost_micros)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(50);
  });

  it("binds owner, generation and exact route; starts and reserves only once", async () => {
    await provision(); const row = await begin();
    expect(await status("op-1", OTHER)).toBeNull();
    expect(await start(row, OTHER)).toBe(false);
    expect(await start(row, OWNER, randomUUID())).toBe(false);
    expect(await start(row)).toBe(true);
    expect(await start(row)).toBe(false);
    expect(await reserve(row, { ...call(), maxOutputTokens: 2048 })).toBe(false);
    expect(await reserve(row)).toBe(true);
    expect(await reserve(row)).toBe(false);
    expect(await reserve(row, call("op-1", 2))).toBe(false);
    await expect(reserve(row, { ...call("op-1", 3), userId: OTHER })).rejects.toThrow();
    await expect(db.query("UPDATE purama_ai.chef_tasks SET state='ready' WHERE id=(SELECT task_id FROM purama_ai.model_consultations WHERE operation_id='op-1')")).rejects.toThrow(/code worker/);
  });

  it("persists useful output while unknown cost keeps its original reservation", async () => {
    await provision(); const row = await begin(); await start(row); await reserve(row);
    expect(await settle(row)).toBe(true); expect(await settle(row)).toBe(true);
    const final = await finalize(row);
    expect(final).toMatchObject({ state: "complete", resourceState: "reconciliation_required", result: result() });
    expect(await finalize(row)).toEqual(final);
    expect((await db.query("SELECT actual_input_tokens,actual_output_tokens,actual_cached_input_tokens,actual_cost_micros,reserved_cost_micros FROM purama_ai.chef_budget_reservations")).rows).toEqual([
      { actual_input_tokens: 80, actual_output_tokens: 3, actual_cached_input_tokens: 20, actual_cost_micros: null, reserved_cost_micros: 50 },
    ]);
    expect((await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions")).rows).toEqual([{ tokens_used: 83, cost_used_micros: 0 }]);
    await expect(finalize(row, result("Faux remplacement"))).rejects.toMatchObject({ code: "PCO01" });
    expect(await status("op-1", OTHER)).toBeNull();
  });

  it("rejects a conflicting provider receipt and reconciles actual costs once", async () => {
    await provision(); const row = await begin(); await start(row); await reserve(row); await settle(row); await finalize(row);
    await expect(settle(row, { ...receipt(), usage: [{ ...usage, outputTokens: 99 }] })).rejects.toMatchObject({ code: "PCO01" });
    const reconcile = () => scalar("SELECT purama_ai.model_consultation_reconcile($1,$2,'invoice-local',80,3,20,37) AS value", [OWNER, "op-1"]);
    expect(await reconcile()).toMatchObject({ resourceState: "reconciled", result: result() });
    await reconcile();
    expect((await db.query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions")).rows).toEqual([{ tokens_used: 83, cost_used_micros: 37 }]);
    await expect(scalar("SELECT purama_ai.model_consultation_reconcile($1,$2,'different',80,3,20,1) AS value", [OWNER, "op-1"])).rejects.toMatchObject({ code: "PCO01" });
  });

  it("never converts an absent receipt or interrupted dispatch into zero", async () => {
    await provision(); const row = await begin(); await start(row); await reserve(row);
    expect(await cancel()).toMatchObject({ state: "cancelled", resourceState: "reconciliation_required" });
    expect(await reserve(row, call("op-1", 2))).toBe(false);
    expect((await db.query("SELECT actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows).toEqual([{ actual_input_tokens: null, actual_cost_micros: null }]);
    expect(await start(row)).toBe(false);
    expect((await begin()).created).toBe(false);
    // A late receipt is retained for the same generation, never a new dispatch.
    await settle(row);
    expect(await finalize(row)).toMatchObject({ state: "cancelled", resourceState: "reconciliation_required" });
  });

  it("handles cancel-before-begin without creating a fake mission or envelope", async () => {
    expect(await cancel()).toMatchObject({ state: "cancelled", result: null, resourceState: "reconciled" });
    expect(await status()).toMatchObject({ state: "cancelled" });
    expect((await begin()).operation.state).toBe("cancelled");
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(0);
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_missions")).toBe(0);
  });

  it("handles begin-before-cancel with proven no-dispatch zero and no restart", async () => {
    await provision(); const row = await begin();
    expect(await cancel()).toMatchObject({ state: "cancelled", resourceState: "reconciled" });
    expect(await start(row)).toBe(false);
    expect((await begin()).created).toBe(false);
    expect((await db.query("SELECT actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows).toEqual([{ actual_input_tokens: 0, actual_cost_micros: 0 }]);
  });

  it("expires grants and operations without allowing replay or releasing unknown funds", async () => {
    const mission = await provision(); const row = await begin(); await start(row); await reserve(row);
    await db.exec("RESET ROLE");
    await db.query("UPDATE purama_ai.model_consultations SET deadline_at=now()-interval '1 minute' WHERE operation_id='op-1'");
    await db.query("UPDATE purama_ai.chef_missions SET consultation_expires_at=now()-interval '1 minute' WHERE id=$1", [mission]);
    await db.exec("SET ROLE service_role");
    expect(await status()).toMatchObject({ state: "interrupted", resourceState: "reconciliation_required" });
    expect(await scalar("SELECT purama_ai.model_consultation_availability($1) AS value", [OWNER])).toBe(false);
    expect(await reserve(row, call("op-1", 2))).toBe(false);
    await expect(begin("op-2")).rejects.toMatchObject({ code: "PCO02" });
  });

  it("keeps all raw requests, results, resource provisioning and RPCs server-only", async () => {
    await provision(); await begin();
    await db.exec("RESET ROLE; SET ROLE authenticated");
    for (const table of ["model_consultations", "model_consultation_calls", "model_consultation_cancellations"]) {
      await expect(db.query(`SELECT * FROM purama_ai.${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(status()).rejects.toMatchObject({ code: "42501" });
    await expect(cancel()).rejects.toMatchObject({ code: "42501" });
    await expect(provision()).rejects.toMatchObject({ code: "42501" });
  });

  it("rechecks an installed global stop inside SQL before dispatch, while allowing cancellation", async () => {
    await provision(); const row = await begin(); await start(row);
    await db.exec("RESET ROLE; CREATE TABLE purama_ai.karta_global_state(id text PRIMARY KEY,kill_switch boolean NOT NULL); INSERT INTO purama_ai.karta_global_state VALUES('global',true); GRANT SELECT ON purama_ai.karta_global_state TO service_role; SET ROLE service_role;");
    try {
      expect(await scalar("SELECT purama_ai.model_consultation_availability($1) AS value", [OWNER])).toBe(false);
      expect(await reserve(row)).toBe(false);
      await expect(begin("op-stopped")).rejects.toMatchObject({ code: "PCO02" });
      expect(await cancel()).toMatchObject({ state: "cancelled", resourceState: "reconciled" });
    } finally { await db.exec("RESET ROLE; DROP TABLE purama_ai.karta_global_state; SET ROLE service_role"); }
  });
});
