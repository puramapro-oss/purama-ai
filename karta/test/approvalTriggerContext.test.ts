import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDecision, AgentDefinition, AgentTrigger, AgentType } from "../src/engine/types.js";

// Actual SQL claims/finalization, logger, autonomy, cycle, approval and delegation
// run together. Only transport, model, queue and external effects are inert.
const h = vi.hoisted(() => ({
  db: null as PGlite | null,
  definition: null as AgentDefinition | null,
  decision: null as AgentDecision | null,
  decide: vi.fn(), effect: vi.fn(), enqueue: vi.fn(), notify: vi.fn(), buildContext: vi.fn(),
  failInsert: false,
  sqlErrors: [] as string[],
}));
function database(): PGlite {
  if (!h.db) throw new Error("Missing isolated SQL fixture");
  return h.db;
}
function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Invalid fixture SQL identifier");
  return '"' + value + '"';
}
function queryFor(table: string) {
  let columns = "*";
  let operation: "select" | "insert" | "update" = "select";
  let values: Record<string, unknown> = {};
  const filters: Array<{ key: string; value: unknown; isNull?: boolean }> = [];
  const execute = async (required: boolean) => {
    try {
      const selected = columns === "*" ? "*" : columns.split(",").map(identifier).join(",");
      const args: unknown[] = [];
      const bind = (value: unknown) => { args.push(value); return "$" + args.length; };
      const where = filters.map(({ key, value, isNull }) => identifier(key) + (isNull ? " IS NULL" : "=" + bind(value)));
      let sql: string;
      if (operation === "insert") {
        if (h.failInsert) throw new Error("PRIVATE_INSERT_SENTINEL");
        const entries = Object.entries(values);
        sql = `INSERT INTO purama_ai.${identifier(table)} (${entries.map(([key]) => identifier(key)).join(",")}) VALUES (${entries.map(([, value]) => bind(value)).join(",")}) RETURNING ${selected}`;
      } else if (operation === "update") {
        sql = `UPDATE purama_ai.${identifier(table)} SET ${Object.entries(values).map(([key, value]) => identifier(key) + "=" + bind(value)).join(",")} WHERE ${where.join(" AND ") || "true"} RETURNING ${selected}`;
      } else {
        sql = `SELECT ${selected} FROM purama_ai.${identifier(table)} WHERE ${where.join(" AND ") || "true"}`;
      }
      const rows = (await database().query(sql, args)).rows;
      if (rows.length > 1 || (required && rows.length !== 1)) {
        h.sqlErrors.push(`Unexpected ${rows.length} rows for ${operation} ${table}`);
        return { data: null, error: { message: "Fixture cardinality failure" } };
      }
      // PostgREST serializes timestamp columns as JSON strings.
      return { data: rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null, error: null };
    } catch (error) {
      h.sqlErrors.push(error instanceof Error ? error.message : "Unknown fixture SQL error");
      return { data: null, error: { message: "PRIVATE_DATABASE_SENTINEL" } };
    }
  };
  const query = {
    select: (value: string) => { columns = value; return query; },
    insert: (value: Record<string, unknown>) => { operation = "insert"; values = value; return query; },
    update: (value: Record<string, unknown>) => { operation = "update"; values = value; return query; },
    eq: (key: string, value: unknown) => { filters.push({ key, value }); return query; },
    is: (key: string, value: null) => { filters.push({ key, value, isNull: true }); return query; },
    single: () => execute(true), maybeSingle: () => execute(false),
  };
  return query;
}
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from: (table: string) => queryFor(table),
  rpc: async (name: string, params: Record<string, unknown>) => {
    const names: Record<string, string[]> = {
      karta_claim_pending_action: ["p_id", "p_decision"],
      karta_finalize_pending_action: ["p_id", "p_status", "p_summary"],
      karta_record_run_outcome: ["p_user_id", "p_agent_type", "p_status", "p_started_at"],
    };
    const keys = names[name];
    if (!keys) throw new Error("Unexpected fixture RPC");
    try {
      const rows = (await database().query(`SELECT * FROM purama_ai.${identifier(name)}(${keys.map((_, i) => "$" + (i + 1)).join(",")})`, keys.map(key => params[key]))).rows;
      return { data: JSON.parse(JSON.stringify(rows)), error: null };
    } catch { return { data: null, error: { message: "PRIVATE_DATABASE_SENTINEL" } }; }
  },
} }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ isMock: false, decide: h.decide }) }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/engine/resolveDefinition.js", () => ({
  CustomAgentAuthorizationError: class CustomAgentAuthorizationError extends Error {},
  resolveAgentDefinition: async () => h.definition,
}));

import { createPendingAction, resolvePendingAction } from "../src/engine/approval.js";
import { runAgentCycle } from "../src/engine/loop.js";
import { delegateToAgentTool } from "../src/tools/delegate.js";

const owner = "00000000-0000-4000-8000-000000000001";
const otherOwner = "00000000-0000-4000-8000-000000000099";
const marker = "PRIVATE_ORIGIN_SENTINEL";
type Pending = { id: string; run_id: string; execution_trigger: AgentTrigger | null; status: string };
type Queued = { userId: string; agentType: AgentType; trigger: AgentTrigger };
const original = (): AgentTrigger => ({ type: "delegation", source: "partner", payload: {
  reason: marker, kartaDelegation: { depth: 1, lineage: ["partner", "legal"] },
} });
const definition = () => {
  if (!h.definition) throw new Error("Missing inert definition");
  return h.definition;
};
const run = async (trigger: AgentTrigger, key: string) => {
  try { return await runAgentCycle(owner, definition(), trigger, key); }
  catch (error) { throw new Error("Inert SQL fixture admission failed: " + h.sqlErrors.join("; "), { cause: error }); }
};
const queued = (index: number) => structuredClone(h.enqueue.mock.calls[index][0]) as Queued;
const pending = async () => (await database().query<Pending>("SELECT id,run_id,execution_trigger,status FROM purama_ai.karta_pending_actions ORDER BY created_at,id")).rows;

beforeAll(async () => {
  h.db = new PGlite();
  await database().exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT nullif(current_setting(''request.jwt.claim.sub'',true),'''')::uuid'; CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  for (const name of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql", "007_runtime_hardening.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql", "021_pending_action_execution_trigger.sql", "021_pending_action_execution_trigger.sql"]) {
    await database().exec(await readFile(new URL("../migrations/" + name, import.meta.url), "utf8"));
  }
});
afterAll(async () => { await h.db?.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); h.failInsert = false; h.sqlErrors = [];
  await database().exec("TRUNCATE auth.users CASCADE; INSERT INTO purama_ai.karta_global_state(id,kill_switch) VALUES('global',false) ON CONFLICT(id) DO UPDATE SET kill_switch=false;");
  await database().query("INSERT INTO auth.users VALUES ($1),($2)", [owner, otherOwner]);
  await database().query("INSERT INTO purama_ai.karta_agent_state(user_id,agent_type,simulation_mode,autonomy_level) VALUES($1,'legal',false,1),($2,'legal',false,1)", [owner, otherOwner]);
  h.decision = { summary: marker, toolCalls: [{ tool: "inert_effect", params: {} }], requiresApproval: false, mock: false };
  h.decide.mockImplementation(async () => h.decision);
  h.buildContext.mockResolvedValue({ business: "fixture" });
  h.effect.mockResolvedValue({ ok: true, privateResult: marker });
  h.enqueue.mockResolvedValue("inert-queued"); h.notify.mockResolvedValue(undefined);
  h.definition = { type: "legal", systemPrompt: "Inert SQL integration agent", buildContext: h.buildContext, tools: [
    { name: "inert_effect", description: "Inert effect", sensitive: true, execute: h.effect }, delegateToAgentTool,
  ] };
});

describe("durable approval origins with actual SQL and engine modules", () => {
  it("approves a new manual delegation without losing its root", async () => {
    h.decision!.toolCalls = [{ tool: "delegate_to_agent", params: { targetAgent: "compta", reason: marker } }];
    expect((await run({ type: "manual", source: "api", payload: { secret: "NEVER_PERSIST" } }, "manual-root")).status).toBe("awaiting_approval");
    const action = (await pending())[0];
    expect(action.execution_trigger).toEqual({ type: "manual", source: "api" });
    expect((await resolvePendingAction(action.id, "approve")).ok).toBe(true);
    expect(queued(0)).toEqual({ userId: owner, agentType: "compta", trigger: {
      type: "delegation", source: "legal", payload: { reason: marker, kartaDelegation: { depth: 1, lineage: ["legal", "compta"] } },
    } });
    expect(queued(1).trigger.source).toBe("approval-resume");
    expect((await resolvePendingAction(action.id, "approve")).ok).toBe(false);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });

  it("preserves the original lineage across two explicit approvals but refuses the second automatic continuation", async () => {
    const origin = original(); origin.payload!.extraSecret = "NEVER_PERSIST";
    expect((await run(origin, "original-delegated-cycle")).status).toBe("awaiting_approval");
    const first = (await pending())[0];
    expect(first.execution_trigger).toEqual(original());
    expect((await resolvePendingAction(first.id, "approve")).ok).toBe(true);
    expect(h.effect).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({ trigger: original() }));
    const resumeFirst = queued(0);
    expect(JSON.stringify(resumeFirst)).not.toContain(marker);
    h.decision!.toolCalls = [{ tool: "delegate_to_agent", params: { targetAgent: "compta", reason: "Suite de la tâche" } }];
    expect((await run(resumeFirst.trigger, "first-approval-resume")).status).toBe("awaiting_approval");
    expect(h.decide.mock.calls[1][0].context.kartaTrigger.delegation).toEqual({ source: "partner", reason: marker });
    const second = (await pending()).find(action => action.id !== first.id)!;
    expect(second.execution_trigger).toEqual(original());
    expect(JSON.stringify(second.execution_trigger)).not.toMatch(/approval-resume|previousRunId|NEVER_PERSIST/);
    expect((await resolvePendingAction(second.id, "approve")).ok).toBe(true);
    expect(queued(1)).toEqual({ userId: owner, agentType: "compta", trigger: {
      type: "delegation", source: "legal", payload: { reason: "Suite de la tâche", kartaDelegation: { depth: 2, lineage: ["partner", "legal", "compta"] } },
    } });
    const resumed = await run(queued(2).trigger, "second-approval-resume");
    expect(resumed).toMatchObject({ status: "error", retryable: false });
    expect(resumed.toolsUsed).toEqual([]);
    expect(h.decide).toHaveBeenCalledTimes(2);
    expect(h.enqueue).toHaveBeenCalledTimes(3);
    expect(await pending()).toHaveLength(2);
    const traces = await database().query("SELECT decision,tools_used,result_summary,error_message FROM purama_ai.karta_runs");
    expect(JSON.stringify([traces.rows, resumed, h.notify.mock.calls])).not.toMatch(/PRIVATE_ORIGIN_SENTINEL|NEVER_PERSIST/);
  });

  it("refuses a malformed non-null persisted origin before dispatch", async () => {
    await run(original(), "bad-origin");
    const action = (await pending())[0];
    await database().query("UPDATE purama_ai.karta_pending_actions SET execution_trigger=$1 WHERE id=$2", [{ type: "manual", source: "approval-resume", payload: { secret: marker } }, action.id]);
    const result = await resolvePendingAction(action.id, "approve");
    expect(result.ok).toBe(false);
    expect(h.effect).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
    expect((await pending())[0].status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("keeps historical ordinary actions working without fabricating their origin", async () => {
    await run({ type: "manual", source: "api" }, "legacy-effect");
    const action = (await pending())[0];
    await database().query("UPDATE purama_ai.karta_pending_actions SET execution_trigger=NULL WHERE id=$1", [action.id]);
    expect((await resolvePendingAction(action.id, "approve")).ok).toBe(true);
    expect(h.effect.mock.calls[0][1].trigger).toBeUndefined();
  });

  it("does not reset a historical delegation with unknown origin to depth zero", async () => {
    h.decision!.toolCalls = [{ tool: "delegate_to_agent", params: { targetAgent: "compta", reason: "Legacy" } }];
    await run({ type: "manual", source: "api" }, "legacy-delegate");
    const action = (await pending())[0];
    await database().query("UPDATE purama_ai.karta_pending_actions SET execution_trigger=NULL WHERE id=$1", [action.id]);
    expect((await resolvePendingAction(action.id, "approve")).ok).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("refuses another owner's continuation before model use", async () => {
    await run(original(), "owned-origin");
    const action = (await pending())[0];
    await resolvePendingAction(action.id, "approve");
    h.decide.mockClear(); h.buildContext.mockClear();
    const result = await runAgentCycle(otherOwner, definition(), queued(0).trigger, "wrong-owner-resume");
    expect(result.status).toBe("error");
    expect(h.decide).not.toHaveBeenCalled(); expect(h.buildContext).not.toHaveBeenCalled();
    expect(h.effect).toHaveBeenCalledOnce();
  });

  it("retains read-only client access after the additive migration", async () => {
    await run(original(), "rls-origin");
    const action = (await pending())[0];
    await database().exec("GRANT USAGE ON SCHEMA auth,purama_ai TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.karta_pending_actions TO authenticated; SET ROLE authenticated;");
    try {
      await database().query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
      expect((await database().query("SELECT id FROM purama_ai.karta_pending_actions")).rows).toHaveLength(1);
      expect((await database().query("UPDATE purama_ai.karta_pending_actions SET execution_trigger=NULL WHERE id=$1 RETURNING id", [action.id])).rows).toHaveLength(0);
      await database().query("SELECT set_config('request.jwt.claim.sub',$1,false)", [otherOwner]);
      expect((await database().query("SELECT id FROM purama_ai.karta_pending_actions")).rows).toHaveLength(0);
    } finally { await database().exec("RESET ROLE"); }
  });

  it("does not expose insert failures or persist a nested resume wrapper", async () => {
    await run(original(), "insert-error-parent");
    const first = (await pending())[0];
    const input = { userId: owner, agentType: "legal" as const, runId: first.run_id, toolName: "inert_effect", toolParams: {}, trigger: original() };
    h.failInsert = true;
    await expect(createPendingAction(input)).rejects.toThrow(/^Création de l’action indisponible/);
    h.failInsert = false;
    await expect(createPendingAction({ ...input, trigger: { type: "delegation", source: "approval-resume", payload: { reason: marker } } })).rejects.toThrow(/^Contexte de reprise indisponible/);
    expect(await pending()).toHaveLength(1);
  });
});
