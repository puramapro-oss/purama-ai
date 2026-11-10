import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTrigger, AgentType } from "../src/engine/types.js";

const h = vi.hoisted(() => ({
  pending: null as Record<string, unknown> | null,
  parent: null as Record<string, unknown> | null,
  failure: null as "throw" | "error" | null,
  reads: [] as Array<{ table: string; columns: string; filters: Record<string, unknown> }>,
}));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from: (table: string) => {
    let columns = "";
    const filters: Record<string, unknown> = {};
    const query = {
      select: (value: string) => { columns = value; return query; },
      eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      maybeSingle: async () => {
        h.reads.push({ table, columns, filters: { ...filters } });
        if (h.failure === "throw") throw new Error("PRIVATE_DATABASE_SENTINEL");
        if (h.failure === "error") return { data: null, error: { message: "PRIVATE_DATABASE_SENTINEL" } };
        // Deliberately return even a mismatching row: the resolver must verify
        // the returned identities as well as send every scoped query filter.
        return { data: table === "karta_pending_actions" ? h.pending : table === "karta_runs" ? h.parent : null, error: null };
      },
    };
    return query;
  },
} }));

import { MAX_APPROVAL_CONTEXT_BYTES, MAX_DELEGATION_REASON_LENGTH, prepareAgentTriggerContext, restoreAgentExecutionTrigger, snapshotAgentExecutionTrigger } from "../src/engine/trigger-context.js";

const userId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const actionId = "00000000-0000-4000-8000-000000000003";
const agentType: AgentType = "legal";
const privateValue = "PRIVATE_APPROVAL_SENTINEL";
const originalParams = { text: privateValue, nested: { a: 1, b: [true, null, "value"] } };
const trigger = (resolution: "executed" | "rejected" = "executed"): AgentTrigger => ({
  type: "delegation", source: "approval-resume",
  payload: { previousRunId: runId, pendingActionId: actionId, resolution },
});

function resetRows(resolution: "executed" | "rejected" = "executed") {
  h.pending = { id: actionId, run_id: runId, user_id: userId, agent_type: agentType, tool_name: "inert_effect", tool_params: structuredClone(originalParams), status: resolution, resolved_at: "2026-11-10T00:00:00.000Z" };
  h.parent = { id: runId, user_id: userId, agent_type: agentType, mode: "live", claude_mock: false, status: resolution === "executed" ? "success" : "skipped", tools_used: [
    { tool: "inert_effect", pendingActionId: actionId, outcome: resolution, success: resolution === "executed", tracePolicy: "metadata_only" },
  ] };
}
const prepare = (value = trigger()) => prepareAgentTriggerContext(userId, agentType, value);
const expectSafeRejection = async (work: Promise<unknown>) => {
  try { await work; throw new Error("Unexpected acceptance"); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^Contexte de reprise indisponible/);
    expect((error as Error).message).not.toMatch(/PRIVATE_|Bearer|refresh_token/);
  }
};

beforeEach(() => { h.reads = []; h.failure = null; resetRows(); });

describe("bounded trigger data without fabricated access rights", () => {
  it.each(["manual", "cron", "webhook"] as const)("does not copy arbitrary %s payload into the model", async type => {
    const context = await prepare({ type, source: "test", payload: { reason: privateValue, authorized: true, refresh_token: "NEVER_FORWARD" } });
    expect(context.modelContext).toBeUndefined();
    expect(context.privateTrace).toBe(false);
    expect(context.guardToolCall("inert_effect", originalParams)).toBeNull();
    expect(h.reads).toEqual([]);
  });

  it("forwards only the bounded source and delegated reason", async () => {
    const result = await prepare({ type: "delegation", source: "partner", payload: { reason: "Review this contract\nwith its attachments", authorized: true, refresh_token: "NEVER_FORWARD" } });
    expect(result.modelContext).toEqual({ delegation: { source: "partner", reason: "Review this contract\nwith its attachments" } });
    expect(result.privateTrace).toBe(true);
    expect(result.guardToolCall("inert_effect", originalParams)).toBeNull();
    expect(h.reads).toEqual([]);
  });

  it.each(["", "   ", "x".repeat(MAX_DELEGATION_REASON_LENGTH + 1), "contains\0null"])("refuses invalid reason %j", async reason => {
    await expectSafeRejection(prepare({ type: "delegation", source: "partner", payload: { reason } }));
    expect(h.reads).toEqual([]);
  });

  it.each(["", "x".repeat(201), "partner\nBearer", " partner"])("refuses an invalid delegated source", async source => {
    await expectSafeRejection(prepare({ type: "delegation", source, payload: { reason: "Task" } }));
  });

  it("does not invoke a reason getter", async () => {
    const getter = vi.fn(() => { throw new Error(privateValue); });
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "reason", { enumerable: true, get: getter });
    await expectSafeRejection(prepare({ type: "delegation", source: "partner", payload }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not accept an approval marker on an ordinary trigger", async () => {
    await expectSafeRejection(prepare({ ...trigger(), type: "manual" }));
    expect(h.reads).toEqual([]);
  });
});

describe("persisted approval evidence is scoped and internally consistent", () => {
  it("reads both action and parent with all identity filters", async () => {
    const result = await prepare();
    expect(h.reads.map(({ table, filters }) => ({ table, filters }))).toEqual([
      { table: "karta_pending_actions", filters: { id: actionId, run_id: runId, user_id: userId, agent_type: agentType } },
      { table: "karta_runs", filters: { id: runId, user_id: userId, agent_type: agentType } },
    ]);
    expect(result.modelContext).toEqual({ approvalResume: { previousRunId: runId, pendingActionId: actionId, resolution: "executed", toolName: "inert_effect", toolParams: originalParams } });
    expect(result.privateTrace).toBe(true);
  });

  it.each(["id", "user_id", "run_id", "agent_type"])("refuses a returned action with mismatched %s even if transport ignores filters", async field => {
    h.pending![field] = "different-id";
    await expectSafeRejection(prepare());
  });

  it.each(["id", "user_id", "agent_type"])("refuses a returned parent with mismatched %s", async field => {
    h.parent![field] = "different-id";
    await expectSafeRejection(prepare());
  });

  it.each(["pending", "executing", "failed", "cancelled", "rejected"])("refuses payload claiming execution over actual %s state", async status => {
    h.pending!.status = status;
    await expectSafeRejection(prepare());
  });

  it.each(["running", "awaiting_approval", "simulated", "cancelled", "error", "skipped"])("refuses unresolved or contradictory parent status %s", async status => {
    h.parent!.status = status;
    await expectSafeRejection(prepare());
  });

  it.each(["executed", "rejected"] as const)("accepts a closed partial parent with a matching %s record", async resolution => {
    resetRows(resolution); h.parent!.status = "partial";
    expect((await prepare(trigger(resolution))).guardToolCall("inert_effect", originalParams)).toBe(resolution === "executed" ? "already_executed" : "rejected");
  });

  it.each(["missing", "duplicate", "wrong_tool", "wrong_outcome", "wrong_success", "simulation", "mock", "missing_resolution_time"])("refuses %s proof", async kind => {
    const records = h.parent!.tools_used as Array<Record<string, unknown>>;
    if (kind === "missing") h.parent!.tools_used = [];
    if (kind === "duplicate") h.parent!.tools_used = [records[0], { ...records[0] }];
    if (kind === "wrong_tool") records[0].tool = "other_tool";
    if (kind === "wrong_outcome") records[0].outcome = "rejected";
    if (kind === "wrong_success") records[0].success = false;
    if (kind === "simulation") h.parent!.mode = "simulation";
    if (kind === "mock") h.parent!.claude_mock = true;
    if (kind === "missing_resolution_time") h.pending!.resolved_at = null;
    await expectSafeRejection(prepare());
  });

  it.each(["throw", "error"] as const)("hides provider content from a %s failure", async failure => {
    h.failure = failure;
    await expectSafeRejection(prepare());
  });

  it.each(["previousRunId", "pendingActionId"])("bounds and validates correlation field %s before querying", async field => {
    const value = trigger(); value.payload![field] = "x".repeat(201);
    await expectSafeRejection(prepare(value));
    expect(h.reads).toEqual([]);
  });
});

describe("canonical exact-action replay guard", () => {
  it("ignores object-key ordering while preserving values and array order", async () => {
    const result = await prepare();
    expect(result.guardToolCall("inert_effect", { nested: { b: [true, null, "value"], a: 1 }, text: privateValue })).toBe("already_executed");
    expect(result.guardToolCall("inert_effect", { nested: { b: [null, true, "value"], a: 1 }, text: privateValue })).toBeNull();
    expect(result.guardToolCall("other_tool", originalParams)).toBeNull();
    expect(result.guardToolCall("inert_effect", { ...originalParams, text: "A different action" })).toBeNull();
  });

  it("blocks a rejected exact action without turning that fact into a permission", async () => {
    resetRows("rejected");
    const result = await prepare(trigger("rejected"));
    expect(result.guardToolCall("inert_effect", originalParams)).toBe("rejected");
    expect(result.guardToolCall("other_tool", originalParams)).toBeNull();
  });

  it("keeps its snapshot if source rows or the model-facing copy are later mutated", async () => {
    const result = await prepare();
    (h.pending!.tool_params as Record<string, unknown>).text = "changed-database-double";
    result.modelContext!.approvalResume!.toolParams.text = "changed-model-copy";
    result.modelContext!.approvalResume!.toolName = "changed-model-name";
    result.modelContext!.approvalResume!.resolution = "rejected";
    expect(result.guardToolCall("inert_effect", originalParams)).toBe("already_executed");
  });

  it.each(["undefined", "NaN", "bigint", "function", "sparse", "cycle", "date", "symbol", "nonenumerable", "oversized", "deep"])("refuses non-JSON or unbounded persisted params: %s", async kind => {
    const value: Record<string, unknown> = {};
    if (kind === "undefined") value.value = undefined;
    if (kind === "NaN") value.value = NaN;
    if (kind === "bigint") value.value = 1n;
    if (kind === "function") value.value = () => 1;
    if (kind === "sparse") value.value = new Array(2);
    if (kind === "cycle") value.value = value;
    if (kind === "date") value.value = new Date();
    if (kind === "symbol") Object.defineProperty(value, Symbol("private"), { enumerable: true, value: 1 });
    if (kind === "nonenumerable") Object.defineProperty(value, "hidden", { value: 1 });
    if (kind === "oversized") value.value = "x".repeat(MAX_APPROVAL_CONTEXT_BYTES);
    if (kind === "deep") { let nested: Record<string, unknown> = value; for (let i = 0; i < 20; i++) { const next = {}; nested.next = next; nested = next; } }
    h.pending!.tool_params = value;
    await expectSafeRejection(prepare());
  });

  it("does not invoke toJSON or property accessors", async () => {
    const getter = vi.fn(() => privateValue);
    const toJSON = vi.fn(() => ({}));
    const value = { toJSON };
    Object.defineProperty(value, "secret", { enumerable: true, get: getter });
    h.pending!.tool_params = value;
    await expectSafeRejection(prepare());
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("fails closed if the model supplies a non-JSON candidate for the same tool", async () => {
    const context = await prepare();
    expect(() => context.guardToolCall("inert_effect", { undefinedField: undefined })).toThrow(/^Contexte de reprise indisponible/);
  });
});

describe("minimal durable execution origin", () => {
  const delegated = (): AgentTrigger => ({ type: "delegation", source: "partner", payload: {
    reason: privateValue, kartaDelegation: { depth: 1, lineage: ["partner", "legal"] },
  } });

  it("keeps a normal source with reasonable punctuation but removes arbitrary payload", async () => {
    const input: AgentTrigger = { type: "cron", source: "Legal Agent — Veille Juridique", payload: { slot: "private", authorized: true } };
    const prepared = await prepare(input);
    expect(prepared.executionTrigger).toEqual({ type: "cron", source: input.source });
    expect(snapshotAgentExecutionTrigger(input, agentType)).toEqual(prepared.executionTrigger);
    expect(prepared.modelContext).toBeUndefined();
  });

  it("copies only bounded delegation fields and detaches the lineage from its input", () => {
    const input = delegated();
    input.payload!.secret = "NEVER_PERSIST";
    const copy = snapshotAgentExecutionTrigger(input, agentType)!;
    expect(copy).toEqual(delegated());
    ((input.payload!.kartaDelegation as { lineage: string[] }).lineage)[0] = "email";
    expect(copy).toEqual(delegated());
    expect(restoreAgentExecutionTrigger(copy, agentType)).toEqual(delegated());
  });

  it("restores the database origin and reason, ignoring a forged origin in the resume payload", async () => {
    h.pending!.execution_trigger = delegated();
    const resumed = trigger();
    resumed.payload!.execution_trigger = { type: "manual", source: "NEVER_FORWARD" };
    const context = await prepare(resumed);
    expect(context.executionTrigger).toEqual(delegated());
    expect(context.modelContext!.delegation).toEqual({ source: "partner", reason: privateValue });
    expect(JSON.stringify(context)).not.toContain("NEVER_FORWARD");
  });

  it.each([null, undefined])("keeps a historical unknown origin unknown (%s)", async origin => {
    h.pending!.execution_trigger = origin;
    const context = await prepare();
    expect(context.executionTrigger).toBeUndefined();
    expect(context.modelContext!.delegation).toBeUndefined();
  });

  it("keeps a legacy delegated reason without fabricating a lineage", () => {
    const input: AgentTrigger = { type: "delegation", source: "partner", payload: { reason: privateValue } };
    expect(restoreAgentExecutionTrigger(snapshotAgentExecutionTrigger(input, agentType), agentType)).toEqual(input);
  });

  it.each(["wrapper", "payload", "unknown_type", "wrong_source", "wrong_target", "cycle", "depth", "extra", "secret", "oversized_source"])("refuses malformed persisted origin: %s", async kind => {
    let value: unknown = delegated();
    if (kind === "wrapper") value = trigger();
    if (kind === "payload") value = { type: "manual", source: "api", payload: { authorized: true } };
    if (kind === "unknown_type") value = { type: "unknown", source: "api" };
    if (kind === "wrong_source") value = { ...delegated(), source: "compta" };
    if (kind === "wrong_target") (value as AgentTrigger).payload!.kartaDelegation = { depth: 1, lineage: ["partner", "compta"] };
    if (kind === "cycle") (value as AgentTrigger).payload!.kartaDelegation = { depth: 2, lineage: ["legal", "partner", "legal"] };
    if (kind === "depth") (value as AgentTrigger).payload!.kartaDelegation = { depth: 0, lineage: ["legal"] };
    if (kind === "extra") value = { ...delegated(), authorized: true };
    if (kind === "secret") (value as AgentTrigger).payload!.refresh_token = "NEVER_FORWARD";
    if (kind === "oversized_source") value = { type: "manual", source: "x".repeat(201) };
    h.pending!.execution_trigger = value;
    await expectSafeRejection(prepare());
  });
});
