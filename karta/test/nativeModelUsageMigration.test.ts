import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { KARTA_CANONICAL_MIGRATIONS } from "./migration-fixtures.js";
import { normalizeConsultationRequest } from "../src/claude/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";
import { normalizeModelUsage, normalizeNativeModelUsage, programmaticUsageEnvelope } from "../src/claude/usage.js";

const OWNER = "00000000-0000-4000-8000-000000000981";
const OTHER = "00000000-0000-4000-8000-000000000982";
const model = "fixture-model";
const plan = resolveModelExecutionPlan({ model }, [{ model, reasoning: "none", maxOutputTokens: 1024 }]);
const legacy = normalizeModelUsage({ model, id: "msg_legacy", usage: {
  input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 4, cache_creation_input_tokens: 2,
} }, model, "https://api.anthropic.com");
const programmatic = programmaticUsageEnvelope([{ receipt: legacy, codeExecutionRequests: 0 }]);
const providers = ["openai", "xai", "google"] as const;
type Provider = typeof providers[number];
const native = (provider: Provider) => normalizeNativeModelUsage(provider === "google"
  ? { modelVersion: "fixture-snapshot", responseId: "fixture_response", usageMetadata: {
    promptTokenCount: 10, candidatesTokenCount: 7, cachedContentTokenCount: 4,
    thoughtsTokenCount: 3, toolUsePromptTokenCount: 2, totalTokenCount: 22,
  } }
  : { model: "fixture-snapshot", id: "fixture_response", usage: {
    input_tokens: 10, output_tokens: 7, total_tokens: provider === "openai" ? 17 : 20,
    input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 3 },
  } }, model, provider);
let db: PGlite;
let migration: string;
async function scalar<T = unknown>(sql: string, args: unknown[] = []): Promise<T> {
  return (await db.query<{ value: T }>(sql, args)).rows[0].value;
}
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const insertRun = (value: unknown, owner = OWNER) => db.query(`INSERT INTO purama_ai.karta_runs
  (id,user_id,agent_type,trigger_type,trigger_source,mode,status,model_usage)
  VALUES($1,$2,'legal','manual','native-usage-fixture','live','success',$3::jsonb) RETURNING model_usage`,
[randomUUID(), owner, value === null ? null : JSON.stringify(value)]);
const call = (provider: string, id = "native-op") => ({ userId: OWNER, operationId: id, callId: `${id}:1`,
  kind: "synthesis", provider, model, inputHash: "a".repeat(64), maxOutputTokens: 1024 });
type Operation = { generation: string; operation: { operationId: string } };
async function provision(cost = 50) {
  return scalar("SELECT purama_ai.model_consultation_provision($1,10000,$2,'2099-01-01T00:00:00Z',4) AS value", [OWNER, cost]);
}
async function begin(provider: string, id = "native-op") {
  const request = normalizeConsultationRequest({ userId: OWNER, operationId: id, question: "Question de test", preferences: { model } });
  const estimates = { policyVersion: "native-fixture-v1", calls: [{ kind: "synthesis", provider, model,
    maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 50 }] };
  const op = await scalar<Operation>("SELECT purama_ai.model_consultation_create($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) AS value",
    [OWNER, id, fingerprint(request), JSON.stringify(request), JSON.stringify(plan), JSON.stringify(estimates)]);
  expect(await scalar("SELECT purama_ai.model_consultation_start($1,$2,$3,$4) AS value", [OWNER, id, fingerprint(request), op.generation])).toBe(true);
  return op;
}
const reserve = (op: Operation, provider: string) => scalar("SELECT purama_ai.model_consultation_reserve($1,$2,$3,$4::jsonb) AS value",
  [OWNER, op.operation.operationId, op.generation, JSON.stringify(call(provider, op.operation.operationId))]);
const settle = (op: Operation, provider: string, usage: unknown) => scalar("SELECT purama_ai.model_consultation_settle($1,$2,$3,$4::jsonb) AS value",
  [OWNER, op.operation.operationId, op.generation, JSON.stringify({ call: call(provider, op.operation.operationId), status: "completed", usage: [usage] })]);
const finalize = (op: Operation) => scalar("SELECT purama_ai.model_consultation_finalize($1,$2,$3,$4::jsonb) AS value",
  [OWNER, op.operation.operationId, op.generation, JSON.stringify({ status: "complete", reason: "completed", plan,
    answer: "Fixture locale", citedSourceIds: [], disagreements: [], uncertainties: [], sources: [], receipts: [], verificationStatus: "unverified" })]);
const reservation = async () => (await db.query(`SELECT actual_input_tokens,actual_output_tokens,actual_cached_input_tokens,
  actual_cost_micros,reserved_tokens,reserved_cost_micros FROM purama_ai.chef_budget_reservations`)).rows[0];

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    GRANT USAGE ON SCHEMA auth,purama_ai TO service_role,authenticated,anon;`);
  // KARTA 004 extends this real application foundation; exercise the complete
  // existing 001..037 chain rather than inventing its creator-agent schema.
  await db.exec(await readFile(new URL("../../supabase/migrations/20260407000000_creator_agent.sql", import.meta.url), "utf8"));
  for (const file of [...KARTA_CANONICAL_MIGRATIONS, "028_private_tool_results.sql", "030_chef_capability_selection.sql", "031_chef_workshop.sql",
    "032_model_consultation.sql", "033_programmatic_model_usage.sql", "034_programmatic_private_reports.sql",
    "035_programmatic_report_brief_completion.sql", "036_resolution_private_results.sql", "037_resolution_unicode_lengths.sql"].sort()) {
    await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  await db.exec("GRANT SELECT,INSERT,UPDATE ON purama_ai.karta_runs TO service_role,authenticated");
  await db.query("INSERT INTO auth.users VALUES($1),($2)", [OWNER, OTHER]);
  await insertRun(null); await insertRun(legacy); await insertRun(programmatic);
  const history = (await db.query("SELECT * FROM purama_ai.karta_runs ORDER BY id")).rows;
  const policies = (await db.query("SELECT * FROM pg_policies WHERE schemaname='purama_ai' ORDER BY tablename,policyname")).rows;
  const tables = (await db.query("SELECT relname,relrowsecurity,relforcerowsecurity,relacl::text FROM pg_class WHERE relnamespace='purama_ai'::regnamespace ORDER BY relname")).rows;
  const acl = (await db.query("SELECT proname,proacl::text,prosecdef FROM pg_proc WHERE pronamespace='purama_ai'::regnamespace ORDER BY oid")).rows;
  const financialDefinitions = (await db.query("SELECT proname,pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='purama_ai'::regnamespace AND proname IN ('model_consultation_reserve','model_consultation_reconcile','model_consultation_provision','model_consultation_create') ORDER BY proname")).rows;
  migration = await readFile(new URL("../migrations/038_native_model_usage.sql", import.meta.url), "utf8");
  await db.exec(migration); await db.exec(migration);
  expect((await db.query("SELECT * FROM purama_ai.karta_runs ORDER BY id")).rows).toEqual(history);
  expect((await db.query("SELECT * FROM pg_policies WHERE schemaname='purama_ai' ORDER BY tablename,policyname")).rows).toEqual(policies);
  expect((await db.query("SELECT relname,relrowsecurity,relforcerowsecurity,relacl::text FROM pg_class WHERE relnamespace='purama_ai'::regnamespace ORDER BY relname")).rows).toEqual(tables);
  expect((await db.query("SELECT proname,proacl::text,prosecdef FROM pg_proc WHERE pronamespace='purama_ai'::regnamespace ORDER BY oid")).rows).toEqual(acl);
  expect((await db.query("SELECT proname,pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='purama_ai'::regnamespace AND proname IN ('model_consultation_reserve','model_consultation_reconcile','model_consultation_provision','model_consultation_create') ORDER BY proname")).rows).toEqual(financialDefinitions);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE auth.users CASCADE");
  await db.query("INSERT INTO auth.users VALUES($1),($2)", [OWNER, OTHER]);
  await db.exec("INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false");
  await db.exec("SET ROLE service_role");
});

describe("native receipts on the existing PostgreSQL authority", () => {
  it.each(providers)("settles and observes %s without cache or reasoning double counting", async provider => {
    const receipt = native(provider);
    expect((await insertRun(receipt)).rows).toEqual([{ model_usage: receipt }]);
    await provision(); const op = await begin(provider);
    expect(await reserve(op, provider)).toBe(true);
    expect(await settle(op, provider, receipt)).toBe(true);
    expect(await settle(op, provider, receipt)).toBe(true);
    expect(await finalize(op)).toMatchObject({ state: "complete", resourceState: "reconciliation_required" });
    await finalize(op);
    expect(await reservation()).toEqual({ actual_input_tokens: provider === "google" ? 12 : 10,
      actual_output_tokens: provider === "openai" ? 7 : 10, actual_cached_input_tokens: 4,
      actual_cost_micros: null, reserved_tokens: 1124, reserved_cost_micros: 50 });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_usage_events")).toBe(1);
    expect(await scalar("SELECT receipt->'usage'->0 AS value FROM purama_ai.model_consultation_calls")).toEqual(receipt);
    await expect(settle(op, provider, { ...receipt, outputTokens: 99 })).rejects.toMatchObject({ code: "PCO01" });
    // The missing invoice still holds the existing financial reservation.
    await expect(begin(provider, "second-op")).rejects.toMatchObject({ code: "PCO02" });
  });

  it("preserves v1 and v2 and keeps native receipts out of v2 programmatic chains", async () => {
    expect((await insertRun(legacy)).rows).toEqual([{ model_usage: legacy }]);
    expect((await insertRun(programmatic)).rows).toEqual([{ model_usage: programmatic }]);
    for (const provider of providers) {
      await expect(insertRun({ ...programmatic, responses: [{ receipt: native(provider), codeExecutionRequests: 0 }] })).rejects.toMatchObject({ code: "23514" });
    }
    await provision(); const op = await begin("anthropic"); await reserve(op, "anthropic");
    await settle(op, "anthropic", legacy); await finalize(op);
    expect(await reservation()).toMatchObject({ actual_input_tokens: 16, actual_output_tokens: 7, actual_cached_input_tokens: 4 });
  });

  it.each([
    {}, [], null, { ...native("openai"), version: 4 }, { ...native("openai"), version: "3" },
    { ...native("openai"), routeKind: "google" }, { ...native("google"), apiFormat: "openai_responses" },
    { ...native("xai"), routeKind: "compatible" }, { ...native("openai"), apiFormat: "anthropic_messages" },
    { ...native("openai"), prompt: "PRIVATE" }, { ...native("openai"), responseId: "fixture\n" },
    { ...native("google"), responseModel: "user@example.invalid" }, { ...native("xai"), requestedModel: "m".repeat(201) },
    { ...native("openai"), inputTokens: -1 }, { ...native("xai"), reasoningOutputTokens: 0.5 },
    { ...native("google"), toolUseInputTokens: "1" }, { ...native("openai"), totalTokens: 9007199254740992 },
    { ...native("openai"), cacheCreationInputTokens: 0 }, { ...native("xai"), toolUseInputTokens: 0 },
    { ...native("openai"), totalTokens: undefined },
  ])("rejects malformed or mismatched native metadata %j", async value => {
    const json = value === null ? null : JSON.stringify(value);
    expect(await scalar("SELECT purama_ai.karta_valid_model_usage_receipt($1::jsonb) AS value", [json])).toBe(false);
    expect(await scalar("SELECT purama_ai.model_consultation_valid_usage($1::jsonb) AS value", [json])).toBe(false);
    if (value !== null) await expect(insertRun(value)).rejects.toMatchObject({ code: "23514" });
  });

  it("binds receipts to the reserved provider and requested model, with no native masquerade", async () => {
    await provision(); const op = await begin("openai");
    expect(await reserve(op, "xai")).toBe(false);
    expect(await reserve(op, "openai")).toBe(true);
    for (const receipt of [native("xai"), native("google"), legacy,
      { ...native("openai"), requestedModel: "different-model" }, { ...native("openai"), requestedModel: null }]) {
      await expect(settle(op, "openai", receipt)).rejects.toThrow(/Invalid provider usage receipt/);
      expect(await scalar("SELECT receipt AS value FROM purama_ai.model_consultation_calls")).toBeNull();
    }
    expect(await settle(op, "openai", native("openai"))).toBe(true);
  });

  it.each(providers)("preserves unknown native usage and does not turn missing dimensions into zero (%s)", async provider => {
    const receipt = normalizeNativeModelUsage({}, model, provider);
    expect((await insertRun(receipt)).rows).toEqual([{ model_usage: receipt }]);
    await provision(); const op = await begin(provider); await reserve(op, provider);
    await settle(op, provider, receipt); await finalize(op);
    expect(await reservation()).toEqual({ actual_input_tokens: null, actual_output_tokens: null,
      actual_cached_input_tokens: null, actual_cost_micros: null, reserved_tokens: 1124, reserved_cost_micros: 50 });
  });

  it.each(providers)("observes an explicit zero token receipt without inventing a free invoice (%s)", async provider => {
    const receipt = { ...native(provider), inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
      reasoningOutputTokens: 0, toolUseInputTokens: provider === "google" ? 0 : null, totalTokens: 0 };
    await provision(); const op = await begin(provider); await reserve(op, provider);
    await settle(op, provider, receipt); await finalize(op);
    expect(await reservation()).toEqual({ actual_input_tokens: 0, actual_output_tokens: 0,
      actual_cached_input_tokens: 0, actual_cost_micros: null, reserved_tokens: 1124, reserved_cost_micros: 50 });
  });

  it("can observe OpenAI's known total inputs and outputs while cache details remain unknown", async () => {
    await provision(); const op = await begin("openai"); await reserve(op, "openai");
    await settle(op, "openai", { ...native("openai"), cacheReadInputTokens: null, reasoningOutputTokens: null });
    await finalize(op);
    expect(await reservation()).toMatchObject({ actual_input_tokens: 10, actual_output_tokens: 7,
      actual_cached_input_tokens: null, actual_cost_micros: null });
  });

  it.each([
    ["xai", { ...native("xai"), reasoningOutputTokens: null }],
    ["google", { ...native("google"), toolUseInputTokens: null }],
    ["google", { ...native("google"), reasoningOutputTokens: null }],
    ["openai", { ...native("openai"), totalTokens: 999 }],
    ["openai", { ...native("openai"), reasoningOutputTokens: 999 }],
    ["xai", { ...native("xai"), cacheReadInputTokens: 999 }],
  ] as const)("retains incomplete or contradictory %s observations without undercharging tokens", async (provider, receipt) => {
    await provision(); const op = await begin(provider); await reserve(op, provider);
    await settle(op, provider, receipt); await finalize(op);
    expect(await scalar("SELECT receipt->'usage'->0 AS value FROM purama_ai.model_consultation_calls")).toEqual(receipt);
    expect(await reservation()).toMatchObject({ actual_input_tokens: null, actual_output_tokens: null,
      actual_cached_input_tokens: null, actual_cost_micros: null });
  });

  it("keeps native consultation RPCs private and the existing run log scoped by owner", async () => {
    await insertRun(native("openai")); await insertRun(native("xai"), OTHER);
    await provision(); const op = await begin("openai"); await reserve(op, "openai");
    await db.exec("RESET ROLE; SET ROLE authenticated");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [OWNER]);
    expect((await db.query("SELECT user_id,model_usage FROM purama_ai.karta_runs")).rows).toEqual([{ user_id: OWNER, model_usage: native("openai") }]);
    await expect(insertRun(native("openai"))).rejects.toMatchObject({ code: "42501" });
    expect((await db.query("UPDATE purama_ai.karta_runs SET model_usage=NULL RETURNING id")).rows).toEqual([]);
    await expect(settle(op, "openai", native("openai"))).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("SELECT * FROM purama_ai.model_consultation_calls")).rejects.toMatchObject({ code: "42501" });
    await expect(scalar("SELECT purama_ai.model_consultation_observe($1,$2) AS value", [OWNER, op.operation.operationId])).rejects.toMatchObject({ code: "42501" });
  });

  it("continues to deny native admission when the existing global kill switch is active", async () => {
    await provision();
    await db.exec("RESET ROLE; UPDATE purama_ai.karta_global_state SET kill_switch=true WHERE id='global'; SET ROLE service_role");
    await expect(begin("openai")).rejects.toMatchObject({ code: "PCO02" });
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.chef_budget_reservations")).toBe(0);
    expect(await scalar("SELECT count(*)::int AS value FROM purama_ai.model_consultation_calls")).toBe(0);
  });
});
