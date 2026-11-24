import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { normalizeModelUsage, programmaticUsageEnvelope } from "../src/claude/usage.js";

let db: PGlite;
let migration: string;
const user = "00000000-0000-4000-8000-000000000801";
const other = "00000000-0000-4000-8000-000000000802";
const run = "00000000-0000-4000-8000-000000000811";
const otherRun = "00000000-0000-4000-8000-000000000812";
const receipt = normalizeModelUsage({ id: "msg_first", model: "qualified-model", usage: {
  input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 0,
} }, "qualified-model", "https://api.anthropic.com");
const envelope = programmaticUsageEnvelope([
  { receipt, codeExecutionRequests: 1 },
  { receipt: { ...receipt, responseId: "msg_second", inputTokens: null }, codeExecutionRequests: 0 },
]);
const write = (value: unknown) => db.query("UPDATE purama_ai.karta_runs SET model_usage=$2 WHERE id=$1", [run, value === null ? null : JSON.stringify(value)]);
const read = async () => (await db.query<{ model_usage: unknown }>("SELECT model_usage FROM purama_ai.karta_runs WHERE id=$1", [run])).rows[0].model_usage;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    CREATE SCHEMA purama_ai; CREATE ROLE authenticated;`);
  await db.exec(await readFile(new URL("../migrations/001_karta_core.sql", import.meta.url), "utf8"));
  await db.exec(await readFile(new URL("../migrations/029_model_usage_receipts.sql", import.meta.url), "utf8"));
  await db.exec("GRANT USAGE ON SCHEMA purama_ai,auth TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.karta_runs TO authenticated;");
  await db.query("INSERT INTO auth.users(id) VALUES($1),($2)", [user, other]);
  await db.query(`INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,trigger_source,mode,status,model_usage)
    VALUES($1,$2,'legal','manual','history','live','success',$5),($3,$4,'legal','manual','history','live','success',NULL)`,
  [run,user,otherRun,other,JSON.stringify(receipt)]);
  const policies = await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='purama_ai' AND tablename='karta_runs' ORDER BY policyname");
  const privileges = await db.query("SELECT relrowsecurity,relacl::text FROM pg_class WHERE oid='purama_ai.karta_runs'::regclass");
  migration = await readFile(new URL("../migrations/033_programmatic_model_usage.sql", import.meta.url), "utf8");
  await db.exec(migration);
  expect(await read()).toEqual(receipt);
  expect((await db.query("SELECT policyname,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='purama_ai' AND tablename='karta_runs' ORDER BY policyname")).rows).toEqual(policies.rows);
  expect((await db.query("SELECT relrowsecurity,relacl::text FROM pg_class WHERE oid='purama_ai.karta_runs'::regclass")).rows).toEqual(privileges.rows);
});
afterAll(async () => { await db?.close(); });
beforeEach(async () => { await db.exec("RESET ROLE"); await write(null); });

describe("additive programmatic receipts on PostgreSQL", () => {
  it("preserves v1, null, v2 and replayability without rewriting historical rows", async () => {
    await write(receipt); expect(await read()).toEqual(receipt);
    await write(null); expect(await read()).toBeNull();
    await write(envelope); expect(await read()).toEqual(envelope);
    const rows = (await db.query("SELECT * FROM purama_ai.karta_runs ORDER BY id")).rows;
    await db.exec(migration);
    expect((await db.query("SELECT * FROM purama_ai.karta_runs ORDER BY id")).rows).toEqual(rows);
  });

  it("accepts exactly the bounded chain size without turning unknown counters into zero", async () => {
    const maximum = programmaticUsageEnvelope(Array.from({ length: 8 }, (_, n) => ({ receipt: { ...receipt, responseId: `msg_${n}` }, codeExecutionRequests: null })));
    await write(maximum); expect(await read()).toEqual(maximum);
  });

  it.each([
    { ...envelope, responses: [] }, { ...envelope, responses: Array.from({ length: 9 }, () => envelope.responses[0]) },
    { ...envelope, responses: null }, { ...envelope, responses: {} },
    { ...envelope, version: 3 }, { ...envelope, routeKind: "compatible" },
    { ...envelope, apiFormat: "other" }, { ...envelope, privatePrompt: "PRIVATE" },
    { ...envelope, responses: [{ receipt, codeExecutionRequests: 1, stdout: "PRIVATE" }] },
    { ...envelope, responses: [{ receipt }] }, { ...envelope, responses: [null] },
    { ...envelope, responses: [{ receipt: { ...receipt, version: 2 }, codeExecutionRequests: 1 }] },
    { ...envelope, responses: [{ receipt: { ...receipt, routeKind: "compatible" }, codeExecutionRequests: 1 }] },
    { ...envelope, responses: [{ receipt: { ...receipt, inputTokens: -1 }, codeExecutionRequests: 1 }] },
    { ...envelope, responses: [{ receipt: { ...receipt, prompt: "PRIVATE" }, codeExecutionRequests: 1 }] },
    { ...envelope, responses: [{ receipt: { ...receipt, responseId: "msg_bad\n" }, codeExecutionRequests: 1 }] },
  ])("rejects malformed metadata while preserving the previous complete receipt: %j", async value => {
    await write(envelope);
    await expect(write(value)).rejects.toThrow();
    expect(await read()).toEqual(envelope);
  });

  it.each([-1, 0.5, 9007199254740992, "1", true, [], {}])("rejects an invalid code-execution count %j", async value => {
    await expect(write({ ...envelope, responses: [{ receipt, codeExecutionRequests: value }] })).rejects.toThrow();
    expect(await read()).toBeNull();
  });

  it("keeps users isolated and forbids user-written usage even with table grants", async () => {
    await write(envelope);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec("SET ROLE authenticated");
    try {
      expect((await db.query("SELECT id,model_usage FROM purama_ai.karta_runs ORDER BY id")).rows).toEqual([{ id: run, model_usage: envelope }]);
      expect((await db.query("UPDATE purama_ai.karta_runs SET model_usage=NULL WHERE id=$1 RETURNING id", [run])).rows).toEqual([]);
      await expect(db.query(`INSERT INTO purama_ai.karta_runs(user_id,agent_type,trigger_type,trigger_source,mode,status,model_usage)
        VALUES($1,'legal','manual','forged','live','success',$2)`, [user,JSON.stringify(envelope)])).rejects.toThrow();
    } finally { await db.exec("RESET ROLE"); }
    expect(await read()).toEqual(envelope);
  });
});
