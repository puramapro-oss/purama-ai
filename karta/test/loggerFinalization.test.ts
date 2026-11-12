import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRunResult } from "../src/engine/types.js";
import { normalizeModelUsage } from "../src/claude/usage.js";

type Row = Record<string, unknown>;
type QueryResult = { data: Row | null; error: { message: string; code?: string } | null };
const h = vi.hoisted(() => ({
  db: null as PGlite | null,
  updateAttempts: 0,
  changedRows: 0,
  failBeforeWrite: 0,
  loseWriteAck: 0,
  failRead: 0,
  beforeUpdate: undefined as (() => Promise<void>) | undefined,
}));

// The adapter translates the real Supabase query shape into real PostgreSQL
// statements. PostgreSQL, rather than an in-memory imitation, evaluates the CAS.
function query(table: string) {
  if (table !== "karta_runs") throw new Error("Unexpected table in logger test");
  let inserted: Row | undefined;
  let patch: Row | undefined;
  let requireSingle = false;
  const filters: Array<{ key: string; value: unknown; isNull: boolean }> = [];
  const identifier = (value: string) => {
    if (!/^[a-z_]+$/.test(value)) throw new Error("Invalid test column");
    return `"${value}"`;
  };
  const parameter = (value: unknown) => value && typeof value === "object" ? JSON.stringify(value) : value;
  const execute = async (): Promise<QueryResult> => {
    if (!h.db) throw new Error("Test database not initialized");
    const parameters: unknown[] = [];
    const bind = (value: unknown) => { parameters.push(parameter(value)); return `$${parameters.length}`; };
    const where = () => filters.map(filter => filter.isNull
      ? `${identifier(filter.key)} IS NULL`
      : `${identifier(filter.key)} = ${bind(filter.value)}`).join(" AND ");
    try {
      let sql: string;
      if (inserted) {
        const entries = Object.entries(inserted);
        sql = `INSERT INTO purama_ai.karta_runs (${entries.map(([key]) => identifier(key)).join(",")}) VALUES (${entries.map(([, value]) => bind(value)).join(",")}) RETURNING *`;
      } else if (patch) {
        h.updateAttempts++;
        const hook = h.beforeUpdate;
        h.beforeUpdate = undefined;
        await hook?.();
        if (h.failBeforeWrite > 0) { h.failBeforeWrite--; return { data: null, error: { message: "Simulated transport failure before write" } }; }
        const assignments = Object.entries(patch).map(([key, value]) => `${identifier(key)} = ${bind(value)}`);
        sql = `UPDATE purama_ai.karta_runs SET ${assignments.join(",")} WHERE ${where()} RETURNING *`;
      } else {
        if (h.failRead > 0) { h.failRead--; return { data: null, error: { message: "Simulated reconciliation read failure" } }; }
        sql = `SELECT * FROM purama_ai.karta_runs WHERE ${where()}`;
      }
      const result = await h.db.query<Row>(sql, parameters);
      if (patch) {
        h.changedRows += result.rows.length;
        if (h.loseWriteAck > 0) { h.loseWriteAck--; return { data: null, error: { message: "Simulated lost acknowledgement" } }; }
      }
      return requireSingle && result.rows.length !== 1
        ? { data: null, error: { code: "PGRST116", message: "Expected exactly one row" } }
        : { data: result.rows[0] ?? null, error: null };
    } catch {
      return { data: null, error: { message: "Test PostgreSQL query rejected" } };
    }
  };
  const q = {
    insert(value: Row) { inserted = value; return q; },
    update(value: Row) { patch = value; return q; },
    select() { return q; },
    eq(key: string, value: unknown) { filters.push({ key, value, isNull: false }); return q; },
    is(key: string, value: unknown) {
      if (value !== null) throw new Error("Only IS NULL is needed in this test");
      filters.push({ key, value, isNull: true }); return q;
    },
    single() { requireSingle = true; return execute(); },
    then: ((resolve, reject) => execute().then(resolve, reject)) as PromiseLike<QueryResult>["then"],
  };
  return q;
}

vi.mock("../src/db/supabase.js", () => ({ supabase: { from: (table: string) => query(table) } }));
const { startRun } = await import("../src/engine/logger.js");

const user = "00000000-0000-4000-8000-000000000021";
const otherUser = "00000000-0000-4000-8000-000000000022";
const trigger = { type: "manual" as const, source: "finalization-test" };
const result = (): AgentRunResult => ({
  status: "success", decision: "Action checked", mock: false,
  toolsUsed: [{ tool: "act", paramsSummary: "metadata", resultSummary: "receipt", success: true, outcome: "executed" }],
  resultSummary: "One action executed",
});
const conflictingResult = (): AgentRunResult => ({ ...result(), status: "error", decision: "Later failure", errorMessage: "Bookkeeping failed" });
const start = () => startRun(user, "legal", trigger, "live", "single-delivery");
const usageReceipt = normalizeModelUsage({ id: "msg_journal", model: "actual-model", usage: {
  input_tokens: 120, output_tokens: 8, cache_read_input_tokens: 400,
} }, "requested-model", "https://compatible.invalid");
async function row(id: string): Promise<Row> {
  return (await h.db!.query<Row>("SELECT * FROM purama_ai.karta_runs WHERE id = $1", [id])).rows[0];
}

beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai;");
  await h.db.exec(await readFile(new URL("../migrations/001_karta_core.sql", import.meta.url), "utf8"));
  await h.db.exec(await readFile(new URL("../migrations/028_model_usage_receipts.sql", import.meta.url), "utf8"));
  await h.db.exec("ALTER TABLE purama_ai.karta_runs ADD COLUMN execution_key text UNIQUE;");
});
afterAll(async () => { await h.db?.close(); });
beforeEach(async () => {
  h.updateAttempts = 0; h.changedRows = 0; h.failBeforeWrite = 0; h.loseWriteAck = 0; h.failRead = 0; h.beforeUpdate = undefined;
  await h.db!.exec("TRUNCATE auth.users CASCADE;");
  await h.db!.query("INSERT INTO auth.users(id) VALUES ($1), ($2)", [user, otherUser]);
});

describe("immutable run finalization with real PostgreSQL predicates", () => {
  it("stores usage once on the existing run and leaves its public replay contract unchanged", async () => {
    const run = await start();
    await run.finish({ ...result(), modelUsage: usageReceipt });
    expect(await row(run.runId)).toMatchObject({ user_id: user, agent_type: "legal", model_usage: usageReceipt });
    const repeated = await start();
    expect(repeated.existingResult).toMatchObject({ status: "success", retryable: false });
    expect(repeated.existingResult).not.toHaveProperty("modelUsage");
    expect(h.changedRows).toBe(1);
  });

  it("leaves absent provider usage NULL instead of claiming zero tokens", async () => {
    const run = await start();
    await run.finish(result());
    expect((await row(run.runId)).model_usage).toBeNull();
  });

  it("freezes the first usage payload across caller mutation and concurrent closes", async () => {
    const run = await start();
    let release!: () => void;
    h.beforeUpdate = () => new Promise<void>(resolve => { release = resolve; });
    const mutable = { ...usageReceipt };
    const first = run.finish({ ...result(), modelUsage: mutable });
    mutable.inputTokens = 999;
    const second = run.finish({ ...result(), modelUsage: mutable });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await Promise.all([first, second]);
    expect((await row(run.runId)).model_usage).toEqual(usageReceipt);
    expect(h.changedRows).toBe(1);
  });

  it("reconciles a committed usage receipt after its acknowledgement is lost", async () => {
    const run = await start();
    h.loseWriteAck = 1;
    await expect(run.finish({ ...result(), modelUsage: usageReceipt })).resolves.toBeUndefined();
    expect((await row(run.runId)).model_usage).toEqual(usageReceipt);
    expect(h.changedRows).toBe(1);
  });

  it("refuses reconciliation when another receipt differs despite equal business fields", async () => {
    const run = await start();
    h.loseWriteAck = 1; h.failRead = 1;
    await expect(run.finish({ ...result(), modelUsage: usageReceipt })).rejects.toThrow();
    const conflicting = { ...usageReceipt, outputTokens: 99 };
    await h.db!.query("UPDATE purama_ai.karta_runs SET model_usage=$2 WHERE id=$1", [run.runId, JSON.stringify(conflicting)]);
    await expect(run.finish({ ...result(), modelUsage: usageReceipt })).rejects.toThrow(/non confirmée/);
    expect((await row(run.runId)).model_usage).toEqual(conflicting);
    expect(h.changedRows).toBe(1);
  });

  it("retries only the frozen first receipt after a failure before the database write", async () => {
    const run = await start();
    h.failBeforeWrite = 1;
    await expect(run.finish({ ...result(), modelUsage: usageReceipt })).rejects.toThrow();
    await run.finish({ ...conflictingResult(), modelUsage: { ...usageReceipt, outputTokens: 99 } });
    expect(await row(run.runId)).toMatchObject({ status: "success", model_usage: usageReceipt });
    expect(h.changedRows).toBe(1);
  });

  it("keeps the first committed outcome when finish is called again with another result", async () => {
    const run = await start();
    await run.finish(result());
    await run.finish(conflictingResult());
    expect(await row(run.runId)).toMatchObject({ status: "success", decision: "Action checked", error_message: null });
    expect(h.changedRows).toBe(1);
  });

  it("coalesces concurrent calls around the first outcome", async () => {
    const run = await start();
    let release!: () => void;
    h.beforeUpdate = () => new Promise<void>(resolve => { release = resolve; });
    const first = run.finish(result());
    const second = run.finish(conflictingResult());
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await Promise.all([first, second]);
    expect(await row(run.runId)).toMatchObject({ status: "success", decision: "Action checked" });
    expect(h.changedRows).toBe(1);
  });

  it("copies the first payload before callers can mutate it", async () => {
    const run = await start();
    let release!: () => void;
    h.beforeUpdate = () => new Promise<void>(resolve => { release = resolve; });
    const outcome = result();
    const finishing = run.finish(outcome);
    outcome.toolsUsed[0].outcome = "failed";
    outcome.toolsUsed[0].resultSummary = "Mutated after dispatch";
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await finishing;
    expect((await row(run.runId)).tools_used).toMatchObject([{ outcome: "executed", resultSummary: "receipt" }]);
  });

  it("reconciles a lost acknowledgement against the exact stored outcome", async () => {
    const run = await start();
    h.loseWriteAck = 1;
    await expect(run.finish(result())).resolves.toBeUndefined();
    expect(await row(run.runId)).toMatchObject({ status: "success" });
    expect(h.changedRows).toBe(1);
  });

  it("compares the JSON representation when an optional field is explicitly undefined", async () => {
    const run = await start();
    const outcome = result();
    outcome.toolsUsed[0].pendingActionId = undefined;
    h.loseWriteAck = 1;
    await expect(run.finish(outcome)).resolves.toBeUndefined();
    expect(await row(run.runId)).toMatchObject({ status: "success" });
    expect(h.changedRows).toBe(1);
  });

  it("retries only the first outcome after a write failed before reaching PostgreSQL", async () => {
    const run = await start();
    h.failBeforeWrite = 1;
    await expect(run.finish(result())).rejects.toThrow();
    await run.finish(conflictingResult());
    expect(await row(run.runId)).toMatchObject({ status: "success", decision: "Action checked", error_message: null });
    expect(h.changedRows).toBe(1);
  });

  it("keeps an applied outcome when both its acknowledgement and the first read are lost", async () => {
    const run = await start();
    h.loseWriteAck = 1;
    h.failRead = 1;
    await expect(run.finish(result())).rejects.toThrow();
    await run.finish(conflictingResult());
    expect(await row(run.runId)).toMatchObject({ status: "success", decision: "Action checked" });
    expect(h.changedRows).toBe(1);
  });

  it("cannot overwrite a journal advanced by approvals even if its status becomes running again", async () => {
    const run = await start();
    h.loseWriteAck = 1; h.failRead = 1;
    const pending: AgentRunResult = { ...result(), status: "awaiting_approval", toolsUsed: [{ tool: "act", paramsSummary: "metadata", resultSummary: "Waiting", success: false, outcome: "pending", pendingActionId: "approval-1" }] };
    await expect(run.finish(pending)).rejects.toThrow();
    const advanced = [{ ...pending.toolsUsed[0], outcome: "executed", success: true, resultSummary: "Provider receipt" }];
    await h.db!.query("UPDATE purama_ai.karta_runs SET status='running', finished_at=NULL, tools_used=$2, result_summary='Approval advanced' WHERE id=$1", [run.runId, JSON.stringify(advanced)]);
    await expect(run.finish(conflictingResult())).rejects.toThrow();
    expect(await row(run.runId)).toMatchObject({ status: "running", result_summary: "Approval advanced", tools_used: advanced });
    expect(h.changedRows).toBe(1);
  });

  it("does not rewrite another finalizer's conflicting terminal result", async () => {
    const run = await start();
    await h.db!.query("UPDATE purama_ai.karta_runs SET status='cancelled', decision='Other finalizer', duration_ms=12 WHERE id=$1", [run.runId]);
    await expect(run.finish(result())).rejects.toThrow();
    expect(await row(run.runId)).toMatchObject({ status: "cancelled", decision: "Other finalizer" });
    expect(h.changedRows).toBe(0);
  });

  it("does not claim a successful finish if the journal row has disappeared", async () => {
    const run = await start();
    await h.db!.query("DELETE FROM purama_ai.karta_runs WHERE id=$1", [run.runId]);
    await expect(run.finish(result())).rejects.toThrow();
    expect(h.changedRows).toBe(0);
  });

  it("binds the finalization to the original owner and agent", async () => {
    const run = await start();
    await h.db!.query("UPDATE purama_ai.karta_runs SET user_id=$2, agent_type='email' WHERE id=$1", [run.runId, otherUser]);
    await expect(run.finish(result())).rejects.toThrow();
    expect(await row(run.runId)).toMatchObject({ user_id: otherUser, agent_type: "email", status: "running" });
    expect(h.changedRows).toBe(0);
  });
});
