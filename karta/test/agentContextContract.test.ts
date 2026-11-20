import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentTrigger } from "../src/engine/types.js";

type QueryResult = { data: unknown; error: unknown };
type QueryCall = { table: string; operations: Array<[string, ...unknown[]]>; started: boolean };

const h = vi.hoisted(() => ({
  calls: [] as QueryCall[],
  responses: new Map<string, () => QueryResult | Promise<QueryResult>>(),
  client: vi.fn(), decide: vi.fn(), finish: vi.fn(), record: vi.fn(), pending: vi.fn(),
}));

// Preserve the lazy/thenable query boundary: constructing a builder is not
// proof that its request has started. No database or provider is contacted.
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from(table: string) {
    const record: QueryCall = { table, operations: [], started: false };
    h.calls.push(record);
    const builder = {
      select(...args: unknown[]) { record.operations.push(["select", ...args]); return builder; },
      eq(...args: unknown[]) { record.operations.push(["eq", ...args]); return builder; },
      lte(...args: unknown[]) { record.operations.push(["lte", ...args]); return builder; },
      in(...args: unknown[]) { record.operations.push(["in", ...args]); return builder; },
      limit(...args: unknown[]) { record.operations.push(["limit", ...args]); return builder; },
      order(...args: unknown[]) { record.operations.push(["order", ...args]); return builder; },
      maybeSingle() { record.operations.push(["maybeSingle"]); return builder; },
      then(resolve: (value: QueryResult) => unknown, reject: (reason: unknown) => unknown) {
        record.started = true;
        return Promise.resolve().then(() => {
          const response = h.responses.get(table);
          if (!response) throw new Error(`Unexpected inert query: ${table}`);
          return response();
        }).then(resolve, reject);
      },
    };
    return builder;
  },
} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: h.client }));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async (userId: string, agentType: string) => ({
    userId, agentType, isEnabled: true, killSwitch: false, simulationMode: false, autonomyLevel: 3,
  }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/approval-continuation.js", async original => ({
  ...await original<typeof import("../src/engine/approval-continuation.js")>(),
  loadApprovalContinuation: async () => undefined,
}));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "context-contract-run", finish: h.finish }),
}));
vi.mock("../src/engine/approval.js", () => ({ createPendingAction: h.pending }));
vi.mock("../src/engine/notify.js", () => ({ notify: async () => undefined }));

const { legalAgent } = await import("../src/agents/legalAgent.js");
const { comptaAgent } = await import("../src/agents/comptaAgent.js");
const { partnerAgent } = await import("../src/agents/partnerAgent.js");
const { runAgentCycle } = await import("../src/engine/loop.js");

const USER = "context-contract-owner";
const PRIVATE_ERROR = "PRIVATE_DATABASE_RESPONSE_must_not_escape";
const trigger: AgentTrigger = { type: "manual", source: "context-contract-test" };
const specs = [
  {
    agent: legalAgent,
    configTable: "legal_agent_config",
    config: { is_active: true, expertise_areas: ["commercial"], auto_veille: true },
    tables: ["legal_documents", "legal_impayes"],
    rows: [[{ id: "document-1", title: "Contrat", expires_at: "2026-12-01" }],
      [{ id: "invoice-1", debtor_name: "Client", amount: 100, due_date: "2026-11-01", status: "overdue" }]],
    emptyKey: "upcomingDeadlines",
    fields: { expertiseAreas: ["commercial"], autoVeille: true },
    limits: [10, 10],
  },
  {
    agent: comptaAgent,
    configTable: "compta_agent_config",
    config: { is_active: true, company_name: "Example", fiscal_regime: "test", tva_regime: "test" },
    tables: ["compta_transactions", "compta_invoices"],
    rows: [[{ id: "transaction-1", description: "Vente", amount: 100, date: "2026-11-01" }],
      [{ id: "invoice-2", invoice_number: "F2", counterpart_name: "Client", total_ht: 100 }]],
    emptyKey: "pendingDeclarations",
    fields: { companyName: "Example", fiscalRegime: "test", tvaRegime: "test" },
    limits: [20, 10],
  },
  {
    agent: partnerAgent,
    configTable: "partner_agent_config",
    config: { is_active: true, target_niches: ["test"], daily_outreach_limit: 7 },
    tables: ["partner_prospects"],
    rows: [[{ id: "prospect-1", name: "Example", email: "example@example.invalid", niche: "test", ai_score: 50 }]],
    emptyKey: "newProspects",
    fields: { targetNiches: ["test"], dailyOutreachLimit: 7 },
    limits: [7],
  },
] as const;

function build(agent: AgentDefinition) { return agent.buildContext(USER, trigger); }
function resolved(table: string, data: unknown, error: unknown = null) {
  h.responses.set(table, () => ({ data, error }));
}
function fail(table: string, mode: "resolved" | "rejected") {
  if (mode === "resolved") resolved(table, null, { message: PRIVATE_ERROR, details: PRIVATE_ERROR });
  else h.responses.set(table, () => Promise.reject(new Error(PRIVATE_ERROR)));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0; h.responses.clear();
  for (const spec of specs) {
    resolved(spec.configTable, spec.config);
    spec.tables.forEach((table, index) => resolved(table, spec.rows[index]));
  }
  h.client.mockReturnValue({ isMock: false, decide: h.decide });
  h.decide.mockResolvedValue({ summary: "Complete inert decision", toolCalls: [], requiresApproval: false, mock: false });
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
});

describe.each(specs)("$agent.type business context", spec => {
  it("preserves complete data, owner scoping and query limits", async () => {
    expect(await build(spec.agent)).toEqual({ ...spec.fields, [spec.emptyKey]: spec.rows.flat() });
    expect(h.calls.map(call => call.table)).toEqual([spec.configTable, ...spec.tables]);
    for (const call of h.calls) {
      expect(call.operations).toContainEqual(["eq", "user_id", USER]);
      expect(call.started).toBe(true);
    }
    expect(h.calls[0].operations).toContainEqual(["maybeSingle"]);
    spec.tables.forEach((table, index) => {
      expect(h.calls.find(call => call.table === table)?.operations).toContainEqual(["limit", spec.limits[index]]);
    });
    if (spec.agent.type === "legal") {
      expect(h.calls[1].operations.find(op => op[0] === "lte")).toEqual(["lte", "expires_at", expect.any(String)]);
      expect(h.calls[2].operations).toContainEqual(["in", "status", ["overdue", "reminder_1", "reminder_2"]]);
    } else if (spec.agent.type === "compta") {
      expect(h.calls[1].operations).toContainEqual(["eq", "user_validated", false]);
      expect(h.calls[2].operations).toContainEqual(["eq", "status", "draft"]);
    } else {
      expect(h.calls[1].operations).toContainEqual(["eq", "status", "identified"]);
      expect(h.calls[1].operations).toContainEqual(["order", "ai_score", { ascending: false }]);
    }
  });

  it.each([null, { is_active: false }])("keeps absent/inactive configuration distinct from read errors (%j)", async config => {
    resolved(spec.configTable, config);
    expect(await build(spec.agent)).toEqual({ [spec.emptyKey]: [], reason: `${spec.configTable} inactif ou absent` });
    expect(h.calls).toHaveLength(1);
  });

  it("accepts legitimately empty data when the reads succeeded", async () => {
    for (const table of spec.tables) resolved(table, null);
    expect(await build(spec.agent)).toEqual({ ...spec.fields, [spec.emptyKey]: [] });
  });

  describe.each(["resolved", "rejected"] as const)("%s database failure", mode => {
    it.each([spec.configTable, ...spec.tables])("rejects incomplete context without leaking the response from %s", async table => {
      fail(table, mode);
      const error = await build(spec.agent).then(() => undefined, reason => reason);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(PRIVATE_ERROR);
      if (table === spec.configTable) expect(h.calls).toHaveLength(1);
    });
  });

  it("prevents inference and action approval in the real cycle after a failed context read", async () => {
    fail(spec.tables[0], "resolved");
    const result = await runAgentCycle(USER, spec.agent, trigger, "context-contract-delivery");
    expect(result).toMatchObject({ status: "error", toolsUsed: [], retryable: false });
    expect(h.client).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.pending).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    expect(JSON.stringify([result, h.finish.mock.calls, h.record.mock.calls])).not.toContain(PRIVATE_ERROR);
  });
});

describe.each(specs.slice(0, 2))("$agent.type independent context reads", spec => {
  it("starts both lazy requests before either result is available, then waits for both", async () => {
    let releaseFirst!: (value: QueryResult) => void;
    let releaseSecond!: (value: QueryResult) => void;
    const first = new Promise<QueryResult>(resolve => { releaseFirst = resolve; });
    const second = new Promise<QueryResult>(resolve => { releaseSecond = resolve; });
    h.responses.set(spec.tables[0], () => first);
    h.responses.set(spec.tables[1]!, () => second);
    let settled = false;
    const pending = build(spec.agent).finally(() => { settled = true; });
    try {
      // Drain only local microtasks, independent of wall-clock speed.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(h.calls.filter(call => call.started).map(call => call.table)).toEqual([
        spec.configTable, ...spec.tables,
      ]);
      expect(settled).toBe(false);
      releaseFirst({ data: spec.rows[0], error: null });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      releaseFirst({ data: spec.rows[0], error: null });
      releaseSecond({ data: spec.rows[1], error: null });
      await pending;
    }
  });
});
