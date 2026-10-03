import { describe, expect, it, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  pending: new Map<string, Row>(), runs: new Map<string, Row>(),
  countError: null as string | null, nullCount: false, failFinalization: false,
  failRunUpdate: false, ambiguousClaim: false, runConflicts: 0,
  afterClaim: null as (() => void) | null,
  beforeRunUpdate: null as (() => Promise<void>) | null,
}));

// Detached reads and filters evaluated at UPDATE time model real concurrent CAS.
function query(table: string) {
  const rows = table === "karta_pending_actions" ? state.pending : table === "karta_runs" ? state.runs : null;
  if (!rows) throw new Error(`table inattendue : ${table}`);
  const filters: Array<{ column: string; value: unknown; kind: "eq" | "in" }> = [];
  let patch: Row | undefined;
  let countRequested = false;
  const matches = (row: Row) => filters.every(({ column, value, kind }) => kind === "in"
    ? (value as unknown[]).includes(row[column])
    : column === "tools_used" ? JSON.stringify(row[column]) === value : row[column] === value);
  const execute = async () => {
    if (patch && table === "karta_runs" && state.beforeRunUpdate) await state.beforeRunUpdate();
    const selected = [...rows.values()].filter(matches);
    if (countRequested) return { data: null, count: state.nullCount ? null : selected.length, error: state.countError ? { message: state.countError } : null };
    if (!patch) return { data: selected.length ? structuredClone(selected[0]) : null, error: null };
    if ((state.failFinalization && table === "karta_pending_actions" && patch.status !== "executing") ||
      (state.failRunUpdate && table === "karta_runs")) return { data: null, error: { message: "journal indisponible" } };
    if (!selected.length) {
      if (table === "karta_runs") state.runConflicts += 1;
      return { data: null, error: null };
    }
    for (const row of selected) rows.set(row.id as string, { ...row, ...structuredClone(patch) });
    if (table === "karta_pending_actions" && patch.status === "executing") {
      state.afterClaim?.();
      if (state.ambiguousClaim) return { data: null, error: { message: "réponse perdue après UPDATE" } };
    }
    return { data: { id: selected[0].id }, error: null };
  };
  const builder = {
    select: (_columns?: string, options?: { count?: string; head?: boolean }) => { countRequested = !!options?.count; return builder; },
    update: (value: Row) => { patch = value; return builder; },
    eq: (column: string, value: unknown) => { filters.push({ column, value, kind: "eq" }); return builder; },
    in: (column: string, value: unknown[]) => { filters.push({ column, value, kind: "in" }); return builder; },
    maybeSingle: execute,
    then: (resolve: (value: Awaited<ReturnType<typeof execute>>) => unknown) => execute().then(resolve),
  };
  return builder;
}
vi.mock("../src/db/supabase.js", () => ({ supabase: { from: (table: string) => query(table) } }));
const executeMock = vi.hoisted(() => vi.fn());
const resolveDefinitionMock = vi.hoisted(() => vi.fn());
const globalStopMock = vi.hoisted(() => vi.fn());
const loadStateMock = vi.hoisted(() => vi.fn());
vi.mock("../src/engine/resolveDefinition.js", () => ({ resolveAgentDefinition: resolveDefinitionMock }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: globalStopMock }));
vi.mock("../src/engine/autonomy.js", () => ({
  loadAgentState: loadStateMock,
  isRunnable: (value: Row) => value.killSwitch ? { ok: false, reason: "kill switch actif" }
    : !value.isEnabled ? { ok: false, reason: "agent désactivé" } : { ok: true },
}));
const { resolvePendingAction } = await import("../src/engine/approval.js");
const tool = {
  name: "supabase_upsert", description: "", sensitive: false,
  inputSchema: { type: "object", properties: { table: { type: "string" } }, required: ["table"], additionalProperties: false },
  parseInput: (input: unknown) => {
    if (!input || typeof input !== "object" || !("table" in input) || typeof input.table !== "string") throw new Error("table invalide");
    return input;
  }, execute: executeMock,
};
function resetState(pendingStatus = "pending") {
  state.pending.clear(); state.runs.clear();
  state.pending.set("pending-1", { id: "pending-1", user_id: "user-1", run_id: "run-1", agent_type: "compta", tool_name: "supabase_upsert", tool_params: { table: "compta_transactions" }, status: pendingStatus });
  state.runs.set("run-1", { id: "run-1", status: "awaiting_approval", tools_used: [{ tool: "supabase_upsert", paramsSummary: "{}", resultSummary: "en attente de validation humaine", success: false, outcome: "awaiting_approval", pendingActionId: "pending-1" }] });
  state.countError = null; state.nullCount = false; state.failFinalization = false;
  state.failRunUpdate = false; state.ambiguousClaim = false; state.afterClaim = null;
  state.beforeRunUpdate = null; state.runConflicts = 0;
  executeMock.mockReset().mockResolvedValue({ ok: true });
  resolveDefinitionMock.mockReset().mockResolvedValue({ type: "compta", systemPrompt: "", buildContext: async () => ({}), tools: [tool] });
  globalStopMock.mockReset().mockResolvedValue(false);
  loadStateMock.mockReset().mockResolvedValue({ userId: "user-1", agentType: "compta", isEnabled: true, autonomyLevel: 1, killSwitch: false, simulationMode: false });
}
function addSecondAction(status = "pending") {
  state.pending.set("pending-2", { ...state.pending.get("pending-1"), id: "pending-2", status });
  const run = state.runs.get("run-1")!;
  const entries = run.tools_used as Row[];
  run.tools_used = [...entries, { ...entries[0], pendingActionId: "pending-2" }];
}

describe("approval — atomic claims and concurrent journal", () => {
  beforeEach(() => resetState());
  it("executes a validated approval once and records success", async () => {
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(true);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith({ table: "compta_transactions" }, { userId: "user-1", agentType: "compta", mode: "live" });
    expect(state.pending.get("pending-1")?.status).toBe("executed");
    expect(state.runs.get("run-1")?.status).toBe("success");
    expect(globalStopMock).toHaveBeenCalledWith({ fresh: true });
  });
  it("rejects without executing and records rejection separately", async () => {
    expect((await resolvePendingAction("pending-1", "reject")).ok).toBe(true);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending.get("pending-1")?.status).toBe("rejected");
    expect((state.runs.get("run-1")?.tools_used as Row[])[0]).toMatchObject({ success: false, outcome: "rejected" });
    expect(state.runs.get("run-1")?.status).toBe("success");
  });
  it("rejects malformed persisted input before claiming or executing", async () => {
    state.pending.get("pending-1")!.tool_params = {};
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending.get("pending-1")?.status).toBe("pending");
  });
  it("allows only one of two simultaneous approvals to invoke the tool", async () => {
    const results = await Promise.all([resolvePendingAction("pending-1", "approve"), resolvePendingAction("pending-1", "approve")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
  it("a winning rejection prevents an approval paused before its claim", async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    resolveDefinitionMock.mockImplementationOnce(async () => { entered(); await wait; return { tools: [tool] }; });
    const approving = resolvePendingAction("pending-1", "approve");
    await ready;
    expect((await resolvePendingAction("pending-1", "reject")).ok).toBe(true);
    release();
    expect((await approving).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending.get("pending-1")?.status).toBe("rejected");
  });
  it("does not let rejection overwrite an execution already claimed", async () => {
    let release!: () => void; let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    executeMock.mockImplementationOnce(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return "sent"; });
    const approving = resolvePendingAction("pending-1", "approve");
    await ready;
    expect((await resolvePendingAction("pending-1", "reject")).ok).toBe(false);
    release();
    expect((await approving).ok).toBe(true);
    expect(state.pending.get("pending-1")?.status).toBe("executed");
  });
  it("keeps ambiguous execution failure unknown and prohibits replay", async () => {
    executeMock.mockRejectedValue(new Error("response lost"));
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(state.pending.get("pending-1")?.status).toBe("unknown");
    expect(state.runs.get("run-1")?.status).toBe("awaiting_approval");
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
  it("does not replay after pending finalization fails", async () => {
    state.failFinalization = true;
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(state.pending.get("pending-1")?.status).toBe("executing");
    state.failFinalization = false;
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
  it("surfaces parent journal failure without replaying the recorded effect", async () => {
    state.failRunUpdate = true;
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(state.pending.get("pending-1")?.status).toBe("executed");
    state.failRunUpdate = false;
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
  it("does not execute or reset a claim whose response was lost", async () => {
    state.ambiguousClaim = true;
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(state.pending.get("pending-1")?.status).toBe("executing");
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });
  it.each(["error", "null"])("does not close a run when the remaining count is %s", async (failure) => {
    if (failure === "error") state.countError = "count unavailable"; else state.nullCount = true;
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(state.runs.get("run-1")?.status).toBe("awaiting_approval");
    expect((state.runs.get("run-1")?.tools_used as Row[])[0].outcome).toBe("executed");
  });
  it("merges concurrent parent updates instead of losing one", async () => {
    addSecondAction();
    let arrived = 0; let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    state.beforeRunUpdate = async () => { arrived += 1; if (arrived === 2) release(); if (arrived <= 2) await wait; };
    const results = await Promise.all([resolvePendingAction("pending-1", "approve"), resolvePendingAction("pending-2", "approve")]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(state.runConflicts).toBeGreaterThanOrEqual(1);
    expect((state.runs.get("run-1")?.tools_used as Row[]).map((entry) => entry.outcome)).toEqual(["executed", "executed"]);
    expect(state.runs.get("run-1")?.status).toBe("success");
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
  it.each(["pending", "executing", "unknown"])("does not close a run with another %s action", async (status) => {
    addSecondAction(status);
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(true);
    expect(state.runs.get("run-1")?.status).toBe("awaiting_approval");
  });
  it("preserves an earlier cycle error while resolving an approval", async () => {
    state.runs.get("run-1")!.status = "error";
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(true);
    expect(state.runs.get("run-1")?.status).toBe("error");
    expect(state.runs.get("run-1")?.result_summary).toBe("Actions : executed=1");
  });
  it("refuses execution while the parent cycle still writes its journal", async () => {
    state.runs.get("run-1")!.status = "running";
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending.get("pending-1")?.status).toBe("pending");
  });
  it("reads a fresh global stop before claiming", async () => {
    globalStopMock.mockResolvedValue(true);
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(globalStopMock).toHaveBeenCalledWith({ fresh: true });
    expect(executeMock).not.toHaveBeenCalled();
  });
  it("checks the stop again after claiming execution", async () => {
    state.afterClaim = () => { globalStopMock.mockResolvedValue(true); };
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
    expect(state.pending.get("pending-1")?.status).toBe("blocked");
    expect(state.runs.get("run-1")?.status).toBe("error");
  });
  it.each([{ isEnabled: false }, { killSwitch: true }, { simulationMode: true }])("blocks execution for current agent state %j", async (patch) => {
    loadStateMock.mockResolvedValue({ userId: "user-1", agentType: "compta", isEnabled: true, autonomyLevel: 1, killSwitch: false, simulationMode: false, ...patch });
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });
  it("refuses an already resolved action", async () => {
    resetState("executed");
    expect((await resolvePendingAction("pending-1", "approve")).ok).toBe(false);
    expect(executeMock).not.toHaveBeenCalled();
  });
});
