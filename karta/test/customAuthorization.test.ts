import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomAgentRow } from "../src/agents/customAgent.js";
import type { AgentDecision, AgentRunResult, AgentType, AnyToolDefinition } from "../src/engine/types.js";
import type { AgentCycleJobData } from "../src/queue/queues.js";

/**
 * Consolidation of PR7's customAuthorization.test.ts onto PR14.
 * Intended destination after the required impact review: karta/test/.
 *
 * The real loader/builder/resolver, runAgentCycle, approval implementation and
 * startAgentCycleWorker processor are exercised. Only external state, provider,
 * queue transport, journal and two inert tools are replaced.
 *
 * This suite tests the CURRENT claim/finalize RPC protocol, not SQL atomicity.
 * Keep PR14's PGlite approval tests for the latter. Every live decision below is
 * mock:false; positive tests must actually dispatch an inert effect so a
 * simulation-only path cannot make the denial tests pass accidentally.
 */
type TestJob = {
  id: string;
  timestamp: number;
  data: AgentCycleJobData;
};
type Processor = (job: TestJob) => Promise<AgentRunResult>;
type PendingRow = {
  id: string;
  user_id: string;
  run_id: string;
  agent_type: string;
  tool_name: string;
  tool_params: Record<string, unknown>;
  status: string;
  result_summary?: string;
};

const h = vi.hoisted(() => ({
  row: null as CustomAgentRow | null,
  pending: null as PendingRow | null,
  readError: null as string | null,
  reads: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ name: string; params: Record<string, unknown> }>,
  pendingInserts: [] as Array<Record<string, unknown>>,
  registryTools: [] as AnyToolDefinition[],
  existing: undefined as AgentRunResult | undefined,
  processor: undefined as Processor | undefined,
  decide: vi.fn(),
  probe: vi.fn(),
  second: vi.fn(),
  finish: vi.fn(),
  record: vi.fn(),
  enqueue: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: (table: string) => {
      if (table === "karta_pending_actions") return {
        insert: (value: Record<string, unknown>) => {
          const query = {
            select: () => query,
            single: async () => {
              h.pendingInserts.push(value);
              h.pending = {
                id: "pending-authority-test",
                user_id: String(value.user_id), run_id: String(value.run_id),
                agent_type: String(value.agent_type), tool_name: String(value.tool_name),
                tool_params: value.tool_params as Record<string, unknown>, status: "pending",
              };
              return { data: { id: h.pending.id }, error: null };
            },
          };
          return query;
        },
      };
      if (table === "karta_runs") {
        const query = {
          select: () => query,
          eq: () => query,
          single: async () => ({
            data: { tools_used: h.finish.mock.calls.at(-1)?.[0]?.toolsUsed ?? [
              { tool: "probe", pendingActionId: "pending-authority-test", tracePolicy: "metadata_only" },
            ] },
            error: null,
          }),
        };
        return query;
      }
      if (table !== "creator_agents") throw new Error(`Unexpected table in authority test: ${table}`);
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        maybeSingle: async () => {
          h.reads.push({ ...filters });
          if (h.readError) return { data: null, error: { message: h.readError } };
          const row = h.row;
          if (!row || Object.entries(filters).some(([key, value]) =>
            row[key as keyof CustomAgentRow] !== value
          )) return { data: null, error: null };
          // Each read is a snapshot: mutating the external row cannot mutate an
          // already built definition and accidentally conceal a missing reread.
          return {
            data: { ...row, tools_enabled: row.tools_enabled ? [...row.tools_enabled] : null },
            error: null,
          };
        },
      };
      return query;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      h.rpcCalls.push({ name, params: { ...params } });
      if (name === "karta_claim_pending_action") {
        if (params.p_decision !== "approve" && params.p_decision !== "reject") {
          return { data: null, error: { message: "invalid decision" } };
        }
        if (!h.pending || h.pending.id !== params.p_id || h.pending.status !== "pending") {
          return { data: [], error: null };
        }
        h.pending.status = "executing";
        return { data: [{ ...h.pending, tool_params: { ...h.pending.tool_params } }], error: null };
      }
      if (name === "karta_finalize_pending_action") {
        if (!h.pending || h.pending.id !== params.p_id || h.pending.status !== "executing") {
          return { data: null, error: { message: "action not claimed" } };
        }
        if (!["executed", "failed", "rejected", "cancelled"].includes(String(params.p_status))) {
          return { data: null, error: { message: "invalid final status" } };
        }
        h.pending.status = String(params.p_status);
        h.pending.result_summary = String(params.p_summary);
        return { data: null, error: null };
      }
      throw new Error(`Unexpected RPC in authority test: ${name}`);
    },
  },
}));

vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/tools/customRegistry.js", () => ({
  resolveCustomAgentTools: (names: string[] | null) =>
    h.registryTools.filter(tool => (names ?? []).includes(tool.name)),
}));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: async (userId: string, agentType: AgentType) => ({
    userId, agentType, isEnabled: true, autonomyLevel: 3, killSwitch: false, simulationMode: false,
  }),
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: async () => false }));
vi.mock("../src/engine/logger.js", () => ({
  startRun: async () => ({ runId: "run-authority-test", finish: h.finish, existingResult: h.existing }),
}));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/claude/index.js", () => ({
  getClaudeClient: () => ({ decide: h.decide, isMock: false }),
}));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_name: string, processor: Processor, _options: unknown) {
      h.processor = processor;
    }
    on(_event: string, _listener: unknown) { return this; }
  },
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  },
}));

import { UnrecoverableError } from "bullmq";
import { resolveAgentDefinition } from "../src/engine/resolveDefinition.js";
import { runAgentCycle } from "../src/engine/loop.js";
import { resolvePendingAction } from "../src/engine/approval.js";
import { startAgentCycleWorker } from "../src/queue/worker.js";

const owner = "owner-authority-test";
const otherOwner = "other-authority-test";
const agentType = "custom:custom-authority-test" as const;
const trigger = { type: "manual" as const, source: "isolated-authority-test" };
const pendingId = "pending-authority-test";

function liveDecision(twoTools = false): AgentDecision {
  return {
    summary: "Exercise authorised dispatch to inert tools",
    toolCalls: [
      { tool: "probe", params: {} },
      ...(twoTools ? [{ tool: "second", params: {} }] : []),
    ],
    requiresApproval: false,
    mock: false,
  };
}

function currentRow(): CustomAgentRow {
  if (!h.row) throw new Error("Test row absent");
  return h.row;
}

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function processJob(userId = owner): Promise<AgentRunResult> {
  startAgentCycleWorker();
  if (!h.processor) throw new Error("The real worker did not register its processor");
  return h.processor({
    id: "authority-job",
    timestamp: 123456789,
    data: { userId, agentType, trigger },
  });
}

async function denyOldApproval(): Promise<void> {
  const result = await resolvePendingAction(pendingId, "approve");
  expect(result.ok).toBe(false);
  expect(h.probe).not.toHaveBeenCalled();
  expect(h.second).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
  expect(["failed", "cancelled"]).toContain(h.pending?.status);
  expect(h.rpcCalls.map(call => call.name)).toEqual([
    "karta_claim_pending_action", "karta_finalize_pending_action",
  ]);
  // The same old approval cannot become executable merely by being submitted again.
  expect((await resolvePendingAction(pendingId, "approve")).ok).toBe(false);
  expect(h.rpcCalls.filter(call => call.name === "karta_finalize_pending_action")).toHaveLength(1);
  expect(h.probe).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  h.row = {
    id: "custom-authority-test", user_id: owner, name: "authority test", description: null,
    system_prompt: "Synthetic test instructions", tools_enabled: ["probe", "second"],
    karta_enabled: true, is_active: true, schedule_enabled: false, schedule_cron: null,
  };
  h.pending = {
    id: pendingId, user_id: owner, run_id: "run-authority-test", agent_type: agentType,
    tool_name: "probe", tool_params: {}, status: "pending",
  };
  h.readError = null;
  h.reads = [];
  h.rpcCalls = [];
  h.pendingInserts = [];
  h.registryTools = [
    { name: "probe", description: "inert first effect", sensitive: false, execute: h.probe },
    { name: "second", description: "inert second effect", sensitive: false, execute: h.second },
  ].map(tool => ({
    ...tool,
    // Optional so the 30 authority scenarios retain their original empty params.
    inputSchema: { type: "object", properties: { payload: { type: "string" } }, additionalProperties: false },
  }));
  h.existing = undefined;
  h.processor = undefined;
  h.decide.mockResolvedValue(liveDecision());
  h.probe.mockResolvedValue({ ok: true });
  h.second.mockResolvedValue({ ok: true });
  h.finish.mockResolvedValue(undefined);
  h.record.mockResolvedValue(undefined);
  h.enqueue.mockResolvedValue("inert-resume-job");
  h.notify.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in authority test"); });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("custom resolver binds current authority to the requesting user", () => {
  it("resolves the owned active agent using its actual current tool selection", async () => {
    const definition = await resolveAgentDefinition(agentType, owner);
    expect(definition.type).toBe(agentType);
    expect(definition.tools.map(tool => tool.name)).toEqual(["probe", "second"]);
    expect(h.reads.length).toBeGreaterThan(0);
  });

  it.each(["is_active", "karta_enabled"] as const)("denies when %s is false", async key => {
    currentRow()[key] = false;
    await expect(resolveAgentDefinition(agentType, owner)).rejects.toThrow();
  });

  it("denies an agent belonging to another requesting user", async () => {
    await expect(resolveAgentDefinition(agentType, otherOwner)).rejects.toThrow();
  });

  it.each([undefined, ""])("denies a missing runtime identity (%s)", async missing => {
    // Deliberately exercise runtime callers that do not honour the TypeScript contract.
    const untypedResolver = resolveAgentDefinition as unknown as
      (type: AgentType, userId?: string) => ReturnType<typeof resolveAgentDefinition>;
    await expect(untypedResolver(agentType, missing)).rejects.toThrow();
  });

  it("fails closed on a missing row", async () => {
    h.row = null;
    await expect(resolveAgentDefinition(agentType, owner)).rejects.toThrow();
  });

  it("fails closed on a failed authority read", async () => {
    h.readError = "synthetic authority database unavailable";
    await expect(resolveAgentDefinition(agentType, owner)).rejects.toThrow();
  });
});

describe("real queue worker passes the job user to custom resolution", () => {
  it("positively dispatches an owned live job, not a simulated decision", async () => {
    const result = await processJob();
    expect(result).toMatchObject({ status: "success", mock: false });
    expect(result.toolsUsed[0]).toMatchObject({ success: true, outcome: "executed" });
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.probe).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({
      userId: owner, agentType, mode: "live", operationId: "run-authority-test:0",
    }));
  });

  it.each(["is_active", "karta_enabled"] as const)("terminally refuses a queued job after %s is revoked", async key => {
    currentRow()[key] = false;
    await expect(processJob()).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("terminally refuses a job owned by somebody else before asking the provider", async () => {
    await expect(processJob(otherOwner)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("keeps a transient authority read failure retryable without dispatching an effect", async () => {
    h.readError = "synthetic retryable authority outage";
    let failure: unknown;
    try {
      await processJob();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(UnrecoverableError);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

type Mutation = "is_active" | "karta_enabled" | "owner" | "tool";
function revoke(kind: Mutation, toolToRemove = "probe"): void {
  const row = currentRow();
  if (kind === "owner") row.user_id = otherOwner;
  else if (kind === "tool") row.tools_enabled = (row.tools_enabled ?? []).filter(name => name !== toolToRemove);
  else row[kind] = false;
}

describe("real loop revalidates custom authority after reasoning and before every effect", () => {
  it.each(["is_active", "karta_enabled", "owner", "tool"] as const)(
    "refuses the first effect when %s changes while the provider is reasoning", async kind => {
      const definition = await resolveAgentDefinition(agentType, owner);
      const entered = latch();
      const resume = latch();
      h.decide.mockImplementationOnce(async () => {
        entered.release();
        await resume.promise;
        return liveDecision();
      });
      const running = runAgentCycle(owner, definition, trigger);
      await entered.promise;
      const readsBeforeRevocation = h.reads.length;
      revoke(kind);
      resume.release();
      const result = await running;
      expect(["error", "cancelled", "skipped"]).toContain(result.status);
      expect(result.mock).toBe(false);
      expect(result.retryable).not.toBe(true);
      expect(h.reads.length).toBeGreaterThan(readsBeforeRevocation);
      expect(h.probe).not.toHaveBeenCalled();
      expect(h.second).not.toHaveBeenCalled();
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  );

  it("does not fall back to the old definition when the fresh read fails after reasoning", async () => {
    const definition = await resolveAgentDefinition(agentType, owner);
    const entered = latch();
    const resume = latch();
    h.decide.mockImplementationOnce(async () => {
      entered.release();
      await resume.promise;
      return liveDecision();
    });
    const running = runAgentCycle(owner, definition, trigger);
    await entered.promise;
    h.readError = "synthetic fresh read failure";
    resume.release();
    const result = await running;
    expect(["error", "cancelled", "skipped"]).toContain(result.status);
    expect(result.mock).toBe(false);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.second).not.toHaveBeenCalled();
  });

  it.each(["is_active", "karta_enabled", "owner", "tool"] as const)(
    "retains the first result but refuses the second effect after %s changes", async kind => {
      const definition = await resolveAgentDefinition(agentType, owner);
      h.decide.mockResolvedValue(liveDecision(true));
      let readsAtFirstEffect = 0;
      h.probe.mockImplementationOnce(async () => {
        readsAtFirstEffect = h.reads.length;
        revoke(kind, "second");
        return { ok: true, receipt: "inert-first-result" };
      });
      const result = await runAgentCycle(owner, definition, trigger);
      expect(["error", "cancelled", "skipped", "partial"]).toContain(result.status);
      expect(result.mock).toBe(false);
      expect(result.retryable).toBe(false);
      expect(result.toolsUsed[0]).toMatchObject({ tool: "probe", success: true, outcome: "executed" });
      expect(h.probe).toHaveBeenCalledOnce();
      expect(h.second).not.toHaveBeenCalled();
      expect(h.reads.length).toBeGreaterThan(readsAtFirstEffect);
      expect(h.decide).toHaveBeenCalledOnce();
      expect(h.enqueue).not.toHaveBeenCalled();
    }
  );

  it("refuses the second effect when the authority service fails after the first", async () => {
    const definition = await resolveAgentDefinition(agentType, owner);
    h.decide.mockResolvedValue(liveDecision(true));
    h.probe.mockImplementationOnce(async () => {
      h.readError = "synthetic outage after the first effect";
      return { ok: true };
    });
    const result = await runAgentCycle(owner, definition, trigger);
    expect(["error", "cancelled", "skipped", "partial"]).toContain(result.status);
    expect(result.retryable).toBe(false);
    expect(result.toolsUsed[0]).toMatchObject({ tool: "probe", success: true, outcome: "executed" });
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.second).not.toHaveBeenCalled();
  });

  it("positively executes both still-authorised tools with distinct effect identities", async () => {
    const definition = await resolveAgentDefinition(agentType, owner);
    h.decide.mockResolvedValue(liveDecision(true));
    const result = await runAgentCycle(owner, definition, trigger);
    expect(result).toMatchObject({ status: "success", mock: false });
    expect(result.toolsUsed.map(tool => tool.outcome)).toEqual(["executed", "executed"]);
    expect(h.probe).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({
      userId: owner, mode: "live", operationId: "run-authority-test:0",
    }));
    expect(h.second).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({
      userId: owner, mode: "live", operationId: "run-authority-test:1",
    }));
  });
});

describe("real approval binds the pending user and current custom authority", () => {
  it("positively executes an authorised pending action and resumes only once", async () => {
    expect((await resolvePendingAction(pendingId, "approve")).ok).toBe(true);
    expect(h.pending?.status).toBe("executed");
    expect(h.probe).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({
      userId: owner, agentType, mode: "live", operationId: pendingId,
    }));
    expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: owner, agentType, trigger: expect.objectContaining({ source: "approval-resume" }) }),
      expect.objectContaining({ dedupeKey: `approval-resume|${pendingId}|executed` })
    );
    expect(h.rpcCalls.map(call => call.name)).toEqual([
      "karta_claim_pending_action", "karta_finalize_pending_action",
    ]);
    expect((await resolvePendingAction(pendingId, "approve")).ok).toBe(false);
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.enqueue).toHaveBeenCalledOnce();
  });

  it.each(["is_active", "karta_enabled", "owner", "tool"] as const)(
    "does not reuse an old pending mandate after %s is revoked", async kind => {
      // Establish that the old definition was allowed before the authority changed.
      await resolveAgentDefinition(agentType, owner);
      revoke(kind);
      await denyOldApproval();
    }
  );

  it("uses pending.user_id rather than the creator's owner when resolving authority", async () => {
    if (!h.pending) throw new Error("Test pending action absent");
    h.pending.user_id = otherOwner;
    await denyOldApproval();
  });

  it("does not execute or replan an old pending action when its fresh read fails", async () => {
    await resolveAgentDefinition(agentType, owner);
    h.readError = "synthetic approval authority outage";
    await denyOldApproval();
  });
});

const PRIVATE_MARKER = "CUSTOM_AGENT_PRIVATE_SENTINEL_62814";

function expectPrivateTraceAbsent(value: unknown): void {
  expect(JSON.stringify(value)).not.toContain(PRIVATE_MARKER);
  for (const [outcome] of h.finish.mock.calls) {
    expect(JSON.stringify(outcome)).not.toContain(PRIVATE_MARKER);
  }
  for (const [notification] of h.notify.mock.calls) {
    expect(JSON.stringify(notification)).not.toContain(PRIVATE_MARKER);
  }
  for (const call of h.rpcCalls.filter(call => call.name === "karta_finalize_pending_action")) {
    expect(JSON.stringify(call.params)).not.toContain(PRIVATE_MARKER);
  }
}

function privateDecision(requiresApproval = false): AgentDecision {
  return {
    summary: `Private reasoning: ${PRIVATE_MARKER}`,
    toolCalls: [{ tool: "probe", params: { payload: PRIVATE_MARKER } }],
    requiresApproval,
    mock: false,
  };
}

describe("custom agents enable metadata-only traces by default without changing business payloads", () => {
  it("copies registry tools before applying the default privacy policy", async () => {
    for (const tool of h.registryTools) Object.freeze(tool);
    const originals = [...h.registryTools];
    const definition = await resolveAgentDefinition(agentType, owner);
    expect(definition.tools).toHaveLength(2);
    for (const [index, tool] of definition.tools.entries()) {
      expect(tool).toMatchObject({ name: originals[index].name, tracePolicy: "metadata_only" });
      expect(tool).not.toBe(originals[index]);
      expect(tool.execute).toBe(originals[index].execute);
      expect(originals[index]).not.toHaveProperty("tracePolicy");
    }
  });

  it("keeps live parameters and results intact while protecting context, decision and execution traces", async () => {
    currentRow().name = `Private context ${PRIVATE_MARKER}`;
    currentRow().description = PRIVATE_MARKER;
    currentRow().system_prompt = `Private configured prompt ${PRIVATE_MARKER}`;
    const definition = await resolveAgentDefinition(agentType, owner);
    const decision = privateDecision();
    const params = Object.freeze(decision.toolCalls[0].params);
    const rawResult = Object.freeze({ ok: true, privateResult: PRIVATE_MARKER });
    h.decide.mockResolvedValue(decision);
    h.probe.mockResolvedValue(rawResult);

    const result = await runAgentCycle(owner, definition, trigger);

    expect(result).toMatchObject({ status: "success", mock: false });
    expect(result.toolsUsed[0]).toMatchObject({ tool: "probe", outcome: "executed", success: true });
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0][0]).toMatchObject({
      systemPrompt: `Private configured prompt ${PRIVATE_MARKER}`,
      context: { customAgentName: `Private context ${PRIVATE_MARKER}`, customAgentDescription: PRIVATE_MARKER },
    });
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.probe.mock.calls[0][0]).toBe(params);
    expect(h.probe.mock.calls[0][1]).toMatchObject({ userId: owner, mode: "live" });
    expect(await h.probe.mock.results[0].value).toBe(rawResult);
    expect(params).toEqual({ payload: PRIVATE_MARKER });
    expect(rawResult.privateResult).toBe(PRIVATE_MARKER);
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("retains an approval's raw payload while minimizing the notification, journal and resolved result", async () => {
    currentRow().description = PRIVATE_MARKER;
    const definition = await resolveAgentDefinition(agentType, owner);
    const decision = privateDecision(true);
    const params = Object.freeze(decision.toolCalls[0].params);
    h.decide.mockResolvedValue(decision);
    h.probe.mockResolvedValue({ ok: true, privateResult: PRIVATE_MARKER });

    const waiting = await runAgentCycle(owner, definition, trigger);

    expect(waiting.status).toBe("awaiting_approval");
    expect(waiting.toolsUsed[0]).toMatchObject({ outcome: "pending", pendingActionId: pendingId, success: false });
    expect(h.pendingInserts).toHaveLength(1);
    expect(h.pendingInserts[0]).toMatchObject({ tool_params: params, user_id: owner, tool_name: "probe" });
    expect(h.pending?.tool_params).toEqual({ payload: PRIVATE_MARKER });
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.notify.mock.calls[0][0]).toMatchObject({ actionType: "review", channels: ["in_app", "push", "email"] });
    expectPrivateTraceAbsent(waiting);

    const approved = await resolvePendingAction(pendingId, "approve");

    expect(approved.ok).toBe(true);
    expect(h.probe).toHaveBeenCalledExactlyOnceWith(params, expect.objectContaining({
      userId: owner, mode: "live", operationId: pendingId,
    }));
    expect(h.pending?.status).toBe("executed");
    expect(h.enqueue).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(approved);
    expect(params).toEqual({ payload: PRIVATE_MARKER });
  });

  it("protects a private custom decision even when the agent has no tools", async () => {
    currentRow().tools_enabled = [];
    currentRow().description = PRIVATE_MARKER;
    const definition = await resolveAgentDefinition(agentType, owner);
    h.decide.mockResolvedValue({ ...privateDecision(), toolCalls: [] });

    const result = await runAgentCycle(owner, definition, trigger);

    expect(result).toMatchObject({ status: "success", mock: false, toolsUsed: [] });
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.decide.mock.calls[0][0].context.customAgentDescription).toBe(PRIVATE_MARKER);
    expect(h.finish).toHaveBeenCalledOnce();
    expect(h.probe).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });

  it("protects private provider errors before tool selection for a tool-less custom agent", async () => {
    currentRow().tools_enabled = [];
    const definition = await resolveAgentDefinition(agentType, owner);
    h.decide.mockRejectedValue(new Error(PRIVATE_MARKER));

    const result = await runAgentCycle(owner, definition, trigger);

    expect(result.status).toBe("error");
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("protects a private tool failure without converting it into success", async () => {
    const definition = await resolveAgentDefinition(agentType, owner);
    const decision = privateDecision();
    h.decide.mockResolvedValue(decision);
    h.probe.mockRejectedValue(new Error(PRIVATE_MARKER));

    const result = await runAgentCycle(owner, definition, trigger);

    expect(result.status).toBe("error");
    expect(result.toolsUsed[0]).toMatchObject({ tool: "probe", outcome: "failed", success: false });
    expect(h.probe).toHaveBeenCalledOnce();
    expect(h.probe.mock.calls[0][0]).toBe(decision.toolCalls[0].params);
    expect(h.finish).toHaveBeenCalledOnce();
    expectPrivateTraceAbsent(result);
  });

  it("minimizes a prior private custom result without replay or rewriting the old object", async () => {
    currentRow().tools_enabled = [];
    const definition = await resolveAgentDefinition(agentType, owner);
    const prior: AgentRunResult = {
      status: "success", decision: PRIVATE_MARKER, toolsUsed: [],
      resultSummary: PRIVATE_MARKER, mock: false, retryable: false,
    };
    h.existing = prior;

    const result = await runAgentCycle(owner, definition, trigger, "existing-custom-delivery");

    expect(result).toMatchObject({ status: "success", mock: false, toolsUsed: [] });
    expect(result).not.toBe(prior);
    expect(prior.decision).toBe(PRIVATE_MARKER);
    expect(prior.resultSummary).toBe(PRIVATE_MARKER);
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expectPrivateTraceAbsent(result);
  });
});
