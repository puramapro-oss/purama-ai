import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition, AgentRunResult, AgentState } from "../src/engine/types.js";
import type { AgentCycleJobData } from "../src/queue/queues.js";

/**
 * Intended destination after impact review: karta/test/.
 * Regression for admission failures that occur before the cycle's execution try.
 *
 * runAgentCycle, resolvePendingAction and the queue worker processor/listener
 * are real. The static agent registry is a fixture; provider, DB, Redis,
 * journal, notifications and effects are inert. No product file is changed.
 * Admission rejection must remain an ordinary thrown failure (existing retry
 * semantics), while its public message and the worker log omit private data.
 */
type TestJob = {
  id: string;
  name: string;
  timestamp: number;
  attemptsMade: number;
  data: AgentCycleJobData;
};
type Processor = (job: TestJob) => Promise<AgentRunResult>;
type FailedListener = (job: TestJob | undefined, error: Error) => void;
type AdmissionPhase = "global-stop-read" | "agent-state-read" | "skipped-outcome-write" | "run-start";

const h = vi.hoisted(() => ({
  definition: null as AgentDefinition | null,
  processor: undefined as Processor | undefined,
  failedListener: undefined as FailedListener | undefined,
  globalStop: vi.fn(),
  loadState: vi.fn(),
  record: vi.fn(),
  startRun: vi.fn(),
  finish: vi.fn(),
  context: vi.fn(),
  decide: vi.fn(),
  execute: vi.fn(),
  notify: vi.fn(),
  enqueue: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      const response = Promise.resolve(h.rpc(...args));
      return Object.assign(response, { abortSignal: (_signal: AbortSignal) => response });
    },
    from: () => { throw new Error("Unexpected table access in admission test"); },
  },
}));
vi.mock("../src/agents/index.js", () => ({
  AGENT_REGISTRY: { get legal() { return h.definition; } },
}));
// Custom-authority resolution has its own suite. The real resolver uses the
// static registry here; an accidental custom branch must fail rather than fetch.
vi.mock("../src/agents/customAgent.js", () => ({
  loadCustomAgent: async () => { throw new Error("Unexpected custom lookup in admission test"); },
  buildCustomAgentDefinition: () => { throw new Error("Unexpected custom build in admission test"); },
}));
vi.mock("../src/engine/autonomy.js", async original => ({
  ...await original<typeof import("../src/engine/autonomy.js")>(),
  loadAgentState: h.loadState,
  recordRunOutcome: h.record,
}));
vi.mock("../src/engine/killswitch.js", () => ({ isGlobalKillSwitchActive: h.globalStop }));
vi.mock("../src/engine/logger.js", () => ({ startRun: h.startRun }));
vi.mock("../src/engine/notify.js", () => ({ notify: h.notify }));
vi.mock("../src/claude/index.js", () => ({ getClaudeClient: () => ({ decide: h.decide, isMock: false }) }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("bullmq", () => ({
  Worker: class {
    constructor(_name: string, processor: Processor, _options: unknown) {
      h.processor = processor;
    }
    on(event: string, listener: FailedListener) {
      if (event === "failed") h.failedListener = listener;
      return this;
    }
  },
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "UnrecoverableError";
    }
  },
}));

import { UnrecoverableError } from "bullmq";
import { runAgentCycle } from "../src/engine/loop.js";
import { resolvePendingAction } from "../src/engine/approval.js";
import { startAgentCycleWorker } from "../src/queue/worker.js";

const PRIVATE_MARKER = "ADMISSION_PRIVATE_DATABASE_SENTINEL_34081";
const owner = "admission-test-owner";
const trigger = { type: "manual" as const, source: "isolated-admission-test" };
const phases: AdmissionPhase[] = [
  "global-stop-read", "agent-state-read", "skipped-outcome-write", "run-start",
];

function liveState(): AgentState {
  return {
    userId: owner, agentType: "legal", isEnabled: true,
    autonomyLevel: 3, killSwitch: false, simulationMode: false,
  };
}

function definition(): AgentDefinition {
  if (!h.definition) throw new Error("Admission fixture not initialized");
  return h.definition;
}

function rejectAt(phase: AdmissionPhase): void {
  const failure = new Error(`Database detail for ${phase}: ${PRIVATE_MARKER}`);
  switch (phase) {
    case "global-stop-read":
      h.globalStop.mockRejectedValueOnce(failure);
      break;
    case "agent-state-read":
      h.loadState.mockRejectedValueOnce(failure);
      break;
    case "skipped-outcome-write":
      h.loadState.mockResolvedValueOnce({ ...liveState(), isEnabled: false });
      h.record.mockRejectedValueOnce(failure);
      break;
    case "run-start":
      h.startRun.mockRejectedValueOnce(failure);
      break;
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("An admission failure must still reject; it must not become a returned success or outcome");
}

function expectOrdinarySafeError(error: unknown): asserts error is Error {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(UnrecoverableError);
  if (!(error instanceof Error)) throw new Error("Expected ordinary Error");
  expect(error.message.trim().length).toBeGreaterThan(0);
  expect(error.message).not.toContain(PRIVATE_MARKER);
  expect(String(error)).not.toContain(PRIVATE_MARKER);
}

function expectAdmissionStoppedAt(phase: AdmissionPhase): void {
  expect(h.globalStop).toHaveBeenCalledOnce();
  if (phase === "global-stop-read") expect(h.loadState).not.toHaveBeenCalled();
  else expect(h.loadState).toHaveBeenCalledOnce();
  if (phase === "skipped-outcome-write") {
    expect(h.record).toHaveBeenCalledExactlyOnceWith(owner, "legal", "skipped", expect.any(String));
  } else {
    expect(h.record).not.toHaveBeenCalled();
  }
  if (phase === "run-start") expect(h.startRun).toHaveBeenCalledOnce();
  else expect(h.startRun).not.toHaveBeenCalled();
  expect(h.context).not.toHaveBeenCalled();
  expect(h.decide).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.finish).not.toHaveBeenCalled();
  expect(h.notify).not.toHaveBeenCalled();
  expect(h.enqueue).not.toHaveBeenCalled();
  expect(h.rpc).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  h.processor = undefined;
  h.failedListener = undefined;
  h.globalStop.mockResolvedValue(false);
  h.loadState.mockResolvedValue(liveState());
  h.record.mockResolvedValue(undefined);
  h.startRun.mockResolvedValue({ runId: "admission-test-run", finish: h.finish });
  h.finish.mockResolvedValue(undefined);
  h.context.mockResolvedValue({});
  h.decide.mockResolvedValue({
    summary: "Live positive control", toolCalls: [{ tool: "inert_probe", params: {} }],
    requiresApproval: false, mock: false,
  });
  h.execute.mockResolvedValue({ ok: true });
  h.notify.mockResolvedValue(undefined);
  h.enqueue.mockResolvedValue("inert-resume");
  h.rpc.mockResolvedValue({ data: [], error: null });
  h.definition = {
    type: "legal", systemPrompt: "Isolated admission test", buildContext: h.context,
    tools: [{
      name: "inert_probe", description: "No external effect", sensitive: false,
      tracePolicy: "metadata_only", execute: h.execute,
    }],
  };
  vi.stubGlobal("fetch", async () => { throw new Error("Network forbidden in admission test"); });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("private admission failures through the real runAgentCycle", () => {
  it("positively reaches the provider and inert live tool when admission succeeds", async () => {
    const result = await runAgentCycle(owner, definition(), trigger);
    expect(result).toMatchObject({ status: "success", mock: false });
    expect(result.toolsUsed[0]).toMatchObject({ tool: "inert_probe", outcome: "executed", success: true });
    expect(h.context).toHaveBeenCalledOnce();
    expect(h.decide).toHaveBeenCalledOnce();
    expect(h.execute).toHaveBeenCalledExactlyOnceWith({}, expect.objectContaining({
      userId: owner, mode: "live", operationId: "admission-test-run:0",
    }));
    expect(h.finish).toHaveBeenCalledOnce();
  });

  it.each(phases)("keeps %s failure thrown and retryable, but removes its private message", async phase => {
    rejectAt(phase);
    const error = await rejection(runAgentCycle(owner, definition(), trigger));
    expectAdmissionStoppedAt(phase);
    expectOrdinarySafeError(error);
  });
});

describe("private admission failures through the real worker processor and failed listener", () => {
  it.each(phases)("does not expose %s database details in the failed-job log", async phase => {
    rejectAt(phase);
    startAgentCycleWorker();
    if (!h.processor || !h.failedListener) throw new Error("The real worker did not register its callbacks");
    const job: TestJob = {
      id: "admission-job", name: "legal:admission-test-owner", timestamp: 12345, attemptsMade: 1,
      data: { userId: owner, agentType: "legal", trigger },
    };
    const error = await rejection(h.processor(job));
    expectAdmissionStoppedAt(phase);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected worker Error");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.failedListener(job, error);
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.mock.calls)).not.toContain(PRIVATE_MARKER);
    expectOrdinarySafeError(error);
  });
});

describe("approval admission handles private claim-RPC failures", () => {
  it("returns a generic refusal when the claim RPC rejects instead of leaking the rejected error", async () => {
    h.rpc.mockRejectedValueOnce(new Error(`Claim database transport detail: ${PRIVATE_MARKER}`));

    const result = await resolvePendingAction("admission-test-pending", "approve");

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_MARKER);
    expect(h.rpc).toHaveBeenCalledExactlyOnceWith("karta_claim_pending_action_bounded", {
      p_id: "admission-test-pending", p_decision: "approve",
    });
    expect(h.globalStop).not.toHaveBeenCalled();
    expect(h.loadState).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.decide).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

});
