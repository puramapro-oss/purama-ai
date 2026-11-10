import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { AgentDecision, AgentDefinition, AgentTrigger } from "../src/engine/types.js";

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  db: null as PGlite | null, reads: 0, unavailable: false,
  decide: vi.fn(), execute: vi.fn(), next: vi.fn(), finish: vi.fn(), pending: vi.fn(), buildContext: vi.fn(),
}));
function query(table: string) {
  if (!["karta_runs", "karta_pending_actions"].includes(table)) throw new Error("Unexpected table");
  const filters: Array<[string, unknown]> = [];
  const q = {
    select() { return q; },
    eq(column: string, value: unknown) {
      if (!/^[a-z_]+$/.test(column)) throw new Error("Invalid column");
      filters.push([column, value]); return q;
    },
    async single() {
      h.reads++;
      if (h.unavailable) throw new Error("PRIVATE_DATABASE_DIAGNOSTIC");
      const where = filters.map(([column], index) => `"${column}"=$${index + 1}`).join(" AND ");
      try {
        const { rows } = await h.db!.query<Row>(`SELECT * FROM purama_ai.${table} WHERE ${where}`, filters.map(([, value]) => value));
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: "Not exactly one row" } };
      } catch { return { data: null, error: { message: "Query rejected" } }; }
    },
  };
  return q;
}
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: query } }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide }) }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", () => ({
  loadAgentState: async () => ({ simulationMode: false }),
  isRunnable: () => ({ ok: true }), requiresHumanApproval: () => false,
  recordRunOutcome: async () => undefined,
}));
vi.mock("../src/engine/logger.js", () => ({ startRun: async () => ({ runId: "continuation", finish: h.finish }) }));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));
// Loading static definitions may otherwise create the real Redis queue. This
// receipt test owns no transport and must not attempt a network connection.
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
const { runAgentCycle } = await import("../src/engine/loop.js");

const user = "00000000-0000-4000-8000-000000000061";
const otherUser = "00000000-0000-4000-8000-000000000062";
const parentId = "00000000-0000-4000-8000-000000000063";
const pendingId = "00000000-0000-4000-8000-000000000064";
const secret = "PRIVATE_APPROVAL_CONTEXT";
const params = { recipient: secret, amount: 17 };
const trigger = (resolution: "executed" | "rejected" = "executed"): AgentTrigger => ({
  type: "delegation", source: "approval-resume", payload: { previousRunId: parentId, pendingActionId: pendingId, resolution },
});
const definition: AgentDefinition = {
  type: "legal", systemPrompt: "Agent system contract", buildContext: h.buildContext,
  tools: [
    { name: "act", sensitive: false, description: "", execute: h.execute,
      inputSchema: { type: "object", properties: { recipient: { type: "string" }, amount: { type: "number" } }, required: ["recipient", "amount"], additionalProperties: false } },
    { name: "next", sensitive: false, description: "", execute: h.next },
  ],
};
function decision(tool = "next", toolParams: Record<string, unknown> = {}): AgentDecision {
  return { summary: secret, toolCalls: [{ tool, params: toolParams }], requiresApproval: false, mock: false };
}
const run = (value = trigger(), userId = user, agent = definition) => runAgentCycle(userId, agent, value);
async function resolve(status: "executed" | "rejected") {
  await h.db!.query("UPDATE purama_ai.karta_pending_actions SET status='executing', resolved_at=NULL WHERE id=$1", [pendingId]);
  await h.db!.query("UPDATE purama_ai.karta_runs SET status='awaiting_approval', finished_at=NULL, tools_used=$2 WHERE id=$1", [parentId, JSON.stringify([
    { tool: "act", paramsSummary: secret, resultSummary: secret, success: false, outcome: "pending", pendingActionId: pendingId },
    { tool: "next", paramsSummary: secret, resultSummary: secret, success: false, outcome: "skipped" },
  ])]);
  await h.db!.query("SELECT purama_ai.karta_finalize_pending_action($1,$2,$3)", [pendingId, status, secret]);
}
beforeAll(async () => {
  h.db = new PGlite();
  await h.db.exec("CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'; CREATE SCHEMA purama_ai; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
  for (const name of ["001_karta_core.sql", "002_karta_global_kill_switch.sql", "005_karta_pending_actions.sql", "006_execution_claims.sql", "019_karta_approval_parent_guard.sql", "020_execution_fingerprints.sql"])
    await h.db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
});
afterAll(async () => { await h.db?.close(); });
beforeEach(async () => {
  vi.clearAllMocks(); h.reads = 0; h.unavailable = false;
  h.decide.mockResolvedValue(decision()); h.execute.mockResolvedValue({ ok: true }); h.next.mockResolvedValue({ ok: true });
  h.buildContext.mockResolvedValue({ objective: "Finish remaining work" });
  h.finish.mockResolvedValue(undefined); h.pending.mockResolvedValue("another-approval");
  await h.db!.exec("TRUNCATE auth.users CASCADE;");
  await h.db!.query("INSERT INTO auth.users(id) VALUES($1),($2)", [user, otherUser]);
  await h.db!.query("INSERT INTO purama_ai.karta_runs(id,user_id,agent_type,trigger_type,mode,status,duration_ms) VALUES($1,$2,'legal','manual','live','awaiting_approval',1)", [parentId, user]);
  await h.db!.query("INSERT INTO purama_ai.karta_pending_actions(id,user_id,run_id,agent_type,tool_name,tool_params) VALUES($1,$2,$3,'legal','act',$4)", [pendingId, user, parentId, JSON.stringify(params)]);
  await resolve("executed");
});

describe("verified approval continuation through the real loop and SQL-finalized receipts", () => {
  it("supplies the verified receipt and remaining steps to the model without replaying the effect", async () => {
    const result = await run();
    expect(h.decide.mock.calls[0][0].context).toMatchObject({
      objective: "Finish remaining work",
      approvalResume: { previousRunId: parentId, pendingActionId: pendingId, resolution: "executed", resolvedAction: { tool: "act", params } },
    });
    expect(h.decide.mock.calls[0][0].systemPrompt).toContain("Agent system contract");
    expect(result.status).toBe("success"); expect(h.next).toHaveBeenCalledOnce(); expect(h.execute).not.toHaveBeenCalled();
  });
  it.each(["executed", "rejected"] as const)("blocks an exact %s action if the model requests it again", async resolution => {
    await resolve(resolution);
    h.decide.mockResolvedValue(decision("act", { amount: 17, recipient: secret }));
    const result = await run(trigger(resolution));
    expect(result).toMatchObject({ status: "cancelled", retryable: false });
    expect(h.execute).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
    expect(result.toolsUsed).toMatchObject([{ outcome: "skipped", success: false }]);
  });
  it("does not create a second approval for the resolved action", async () => {
    h.decide.mockResolvedValue({ ...decision("act", params), requiresApproval: true });
    expect((await run()).status).toBe("cancelled"); expect(h.pending).not.toHaveBeenCalled();
  });
  it("keeps the guard independent of model-context mutation", async () => {
    h.decide.mockImplementation(async input => {
      if (input.context.approvalResume) input.context.approvalResume.resolvedAction.params.recipient = "changed-by-model";
      return decision("act", params);
    });
    expect((await run()).status).toBe("cancelled"); expect(h.execute).not.toHaveBeenCalled();
  });
  it("uses parameters from the owned receipt rather than extra trigger content", async () => {
    const value = trigger(); value.payload!.resolvedAction = { tool: "act", params: { recipient: "forged", amount: 2 } };
    await run(value);
    expect(h.decide.mock.calls[0][0].context.approvalResume.resolvedAction.params).toEqual(params);
  });
  it("keeps private receipt/model content out of returned and persisted traces", async () => {
    await run();
    expect(JSON.stringify(h.finish.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(await run())).not.toContain(secret);
    const previous = h.decide.mock.calls[0][0].context.approvalResume.previousActions;
    expect(JSON.stringify(previous)).not.toContain(secret);
  });
  it("protects a no-tool continuation response", async () => {
    h.decide.mockResolvedValue({ ...decision(), toolCalls: [] });
    const result = await run(); expect(result.status).toBe("success"); expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("allows a genuinely fresh manual request and does not load continuation receipts", async () => {
    h.decide.mockResolvedValue(decision("act", params));
    expect((await run({ type: "manual", source: "user" })).status).toBe("success");
    expect(h.execute).toHaveBeenCalledOnce(); expect(h.reads).toBe(0);
    expect(h.decide.mock.calls[0][0].context).toEqual({ objective: "Finish remaining work" });
  });
  it.each([false, true])("forbids replay after an uncertain approval insert, even when closing fails: %s", async closingFails => {
    h.decide.mockResolvedValue({ ...decision(), requiresApproval: true });
    h.pending.mockRejectedValue(new Error("Approval acknowledgement lost"));
    if (closingFails) h.finish.mockRejectedValue(new Error("Journal acknowledgement lost"));
    const result = await run({ type: "manual", source: "fresh-request" });
    expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.pending).toHaveBeenCalledOnce(); expect(h.next).not.toHaveBeenCalled();
  });
  it.each([
    { type: "manual", source: "approval-resume", payload: trigger().payload },
    { type: "delegation", source: "approval-resume" },
    { ...trigger(), payload: { ...trigger().payload, resolution: "failed" } },
    { ...trigger(), payload: { ...trigger().payload, previousRunId: "malformed" } },
    { ...trigger(), payload: { ...trigger().payload, pendingActionId: "malformed" } },
  ] as AgentTrigger[])("refuses malformed or unconfirmed continuation data %j", async value => {
    const result = await run(value); expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.decide).not.toHaveBeenCalled(); expect(h.next).not.toHaveBeenCalled();
  });
  it("does not load another user's receipt", async () => {
    expect((await run(trigger(), otherUser)).status).toBe("error"); expect(h.decide).not.toHaveBeenCalled();
  });
  it("does not load another agent's receipt", async () => {
    expect((await run(trigger(), user, { ...definition, type: "compta" })).status).toBe("error"); expect(h.decide).not.toHaveBeenCalled();
  });
  it.each([
    "UPDATE purama_ai.karta_pending_actions SET status='pending', resolved_at=NULL",
    "UPDATE purama_ai.karta_pending_actions SET resolved_at=NULL",
    "UPDATE purama_ai.karta_pending_actions SET agent_type='compta'",
    "UPDATE purama_ai.karta_pending_actions SET tool_name='other'",
    "UPDATE purama_ai.karta_runs SET user_id='00000000-0000-4000-8000-000000000062'",
    "UPDATE purama_ai.karta_runs SET agent_type='compta'",
    "UPDATE purama_ai.karta_runs SET status='running', finished_at=NULL",
    "UPDATE purama_ai.karta_runs SET status='awaiting_approval', finished_at=NULL",
    "UPDATE purama_ai.karta_runs SET tools_used='[]'",
    "UPDATE purama_ai.karta_runs SET tools_used=tools_used || tools_used",
    "UPDATE purama_ai.karta_runs SET mode='simulation'",
  ])("refuses inconsistent or unfinished durable evidence: %s", async sql => {
    await h.db!.exec(sql);
    const result = await run(); expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.decide).not.toHaveBeenCalled(); expect(h.execute).not.toHaveBeenCalled(); expect(h.next).not.toHaveBeenCalled();
  });
  it("does not accept a forged resolution even for the right action", async () => {
    expect((await run(trigger("rejected"))).status).toBe("error"); expect(h.decide).not.toHaveBeenCalled();
  });
  it.each([
    { tool: "earlier", outcome: "executed", success: true },
    { tool: "earlier", success: true },
    { tool: "earlier", outcome: "failed", success: false },
    { tool: "earlier", outcome: "skipped", success: true },
    { tool: "earlier", outcome: "pending", success: false, pendingActionId: "other-approval" },
    { tool: "earlier", outcome: "rejected", success: false, pendingActionId: "other-approval" },
  ])("does not guess whether another historical action can be repeated: %j", async entry => {
    await h.db!.query("UPDATE purama_ai.karta_runs SET tools_used=tools_used || $1::jsonb", [JSON.stringify([entry])]);
    const result = await run(); expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.buildContext).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled(); expect(h.next).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
    expect(result.errorMessage).toContain("Reprise automatique suspendue");
  });
  it("stops a second-generation continuation whose earlier ancestry was not recorded", async () => {
    await h.db!.exec("UPDATE purama_ai.karta_runs SET trigger_source='approval-resume'");
    const result = await run(); expect(result).toMatchObject({ status: "error", retryable: false });
    expect(h.buildContext).not.toHaveBeenCalled(); expect(h.decide).not.toHaveBeenCalled(); expect(h.pending).not.toHaveBeenCalled();
  });
  it("refuses an unavailable receipt without exposing database diagnostics or retrying effects", async () => {
    h.unavailable = true;
    const result = await run(); expect(result).toMatchObject({ status: "error", retryable: false });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_DATABASE_DIAGNOSTIC"); expect(h.decide).not.toHaveBeenCalled();
  });
});
