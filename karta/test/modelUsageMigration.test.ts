import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { normalizeModelUsage } from "../src/claude/usage.js";

let db: PGlite;
let migration: string;
const user = "00000000-0000-4000-8000-000000000601";
const other = "00000000-0000-4000-8000-000000000602";
const run = "00000000-0000-4000-8000-000000000611";
const otherRun = "00000000-0000-4000-8000-000000000612";
const receipt = normalizeModelUsage({ id: "msg_sql", model: "fixture-model", usage: {
  input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 10 },
} }, "fixture-model", "https://api.anthropic.com");
const write = (value: unknown) => db.query("UPDATE purama_ai.karta_runs SET model_usage=$2 WHERE id=$1", [run, value === null ? null : JSON.stringify(value)]);
const read = async () => (await db.query<{ model_usage: unknown }>("SELECT model_usage FROM purama_ai.karta_runs WHERE id=$1", [run])).rows[0].model_usage;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE SCHEMA purama_ai; CREATE ROLE authenticated;`);
  await db.exec(await readFile(new URL("../migrations/001_karta_core.sql", import.meta.url), "utf8"));
  await db.exec("GRANT USAGE ON SCHEMA purama_ai,auth TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.karta_runs TO authenticated;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [user, other]);
  await db.query(`INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,trigger_source,mode,status)
    VALUES($1,$2,'legal','manual','history','live','success'),($3,$4,'legal','manual','history','live','success')`, [run,user,otherRun,other]);
  const policyBefore = await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='purama_ai' AND tablename='karta_runs' ORDER BY policyname");
  const privilegesBefore = await db.query("SELECT relrowsecurity,relacl::text FROM pg_class WHERE oid='purama_ai.karta_runs'::regclass");
  migration = await readFile(new URL("../migrations/029_model_usage_receipts.sql", import.meta.url), "utf8");
  await db.exec(migration);
  expect((await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='purama_ai' AND tablename='karta_runs' ORDER BY policyname")).rows).toEqual(policyBefore.rows);
  expect((await db.query("SELECT relrowsecurity,relacl::text FROM pg_class WHERE oid='purama_ai.karta_runs'::regclass")).rows).toEqual(privilegesBefore.rows);
  expect((await db.query("SELECT model_usage FROM purama_ai.karta_runs")).rows).toEqual([{ model_usage: null }, { model_usage: null }]);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec("RESET ROLE"); await write(null); });

describe("provider usage migration on PostgreSQL", () => {
  it("is replayable and preserves existing counters, ownership and business content", async () => {
    await write(receipt);
    const before = (await db.query("SELECT * FROM purama_ai.karta_runs ORDER BY id")).rows;
    await db.exec(migration);
    expect((await db.query("SELECT * FROM purama_ai.karta_runs ORDER BY id")).rows).toEqual(before);
  });

  it("preserves a reported zero separately from unknown cache counters", async () => {
    await write({ ...receipt, inputTokens: 0, cacheCreationInputTokens: null, cacheCreation5mInputTokens: null, cacheCreation1hInputTokens: null });
    expect(await read()).toMatchObject({ inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: null });
  });

  it.each([-1, 0.5, 9007199254740992, "100", true, [], {}])("rejects invalid token count %j without changing the previous receipt", async value => {
    await write(receipt);
    await expect(write({ ...receipt, inputTokens: value })).rejects.toThrow();
    expect(await read()).toEqual(receipt);
  });

  it.each([
    {}, [], { ...receipt, version: 2 }, { ...receipt, apiFormat: "unknown" },
    { ...receipt, routeKind: "free" }, { ...receipt, privatePrompt: "do not store" },
    { ...receipt, responseModel: "user@example.invalid" }, { ...receipt, responseId: "msg_ok\n" },
    { ...receipt, requestedModel: "m".repeat(201) },
  ])("rejects malformed or excessive metadata %j", async value => {
    await expect(write(value)).rejects.toThrow();
    expect(await read()).toBeNull();
  });

  it("keeps tenant reads isolated and blocks user writes even when table privileges are granted", async () => {
    await write(receipt);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec("SET ROLE authenticated");
    try {
      expect((await db.query("SELECT id,model_usage FROM purama_ai.karta_runs ORDER BY id")).rows).toEqual([{ id: run, model_usage: receipt }]);
      expect((await db.query("UPDATE purama_ai.karta_runs SET model_usage=NULL WHERE id=$1 RETURNING id", [run])).rows).toEqual([]);
      await expect(db.query(`INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,trigger_source,mode,status,model_usage)
        VALUES($1,'legal','manual','forged','live','success',$2)`, [user, JSON.stringify(receipt)])).rejects.toThrow();
    } finally { await db.exec("RESET ROLE"); }
    expect(await read()).toEqual(receipt);
    expect((await db.query("SELECT count(*)::int AS n FROM purama_ai.karta_runs")).rows).toEqual([{ n: 2 }]);
  });
});
