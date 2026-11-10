import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCycleJobData } from "../src/queue/queues.js";
import { createCycleDelivery, resolveCycleDelivery } from "../src/queue/delivery-identity.js";

vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("bullmq", () => ({ Queue: class {} }));
import { createApprovalOutboxRelay, drainApprovalOutboxOnce, type ApprovalOutboxDependencies } from "../src/queue/approval-outbox.js";

const actionId = "00000000-0000-4000-8000-000000000721";
const row = () => ({ pending_action_id: actionId, user_id: "00000000-0000-4000-8000-000000000722",
  parent_run_id: "00000000-0000-4000-8000-000000000723", agent_type: "legal", resolution: "executed",
  lease_token: "00000000-0000-4000-8000-000000000724", protocol: 1 });
type StoredJob = { id: string; timestamp: number; data: AgentCycleJobData; state: string };
let jobs: Map<string, StoredJob>;
let preparations: string[];
let claimRows: unknown[];
let addFailure: "offline" | "lost_ack" | "hang" | undefined;
let finishResult: boolean;
let rpc: ReturnType<typeof vi.fn<ApprovalOutboxDependencies["rpc"]>>;
let queue: ApprovalOutboxDependencies["queue"];
const input = (): AgentCycleJobData => ({ userId: row().user_id, agentType: "legal", trigger: {
  type: "delegation", source: "approval-resume",
  payload: { previousRunId: row().parent_run_id, pendingActionId: actionId, resolution: "executed" },
} });
const delivery = () => createCycleDelivery(input(), `approval-resume|${actionId}|executed`);
const drain = () => drainApprovalOutboxOnce({ rpc, queue, timeoutMs: 20 });
const finishes = () => rpc.mock.calls.filter(([name]) => name === "karta_finish_approval_outbox").map(([, args]) => args);

beforeEach(() => {
  jobs = new Map(); preparations = []; claimRows = [row()]; addFailure = undefined; finishResult = true;
  rpc = vi.fn(async (name: string) => ({ data: name === "karta_claim_approval_outbox" ? claimRows
    : name === "karta_prepare_approval_outbox" ? preparations.shift() ?? "ready" : finishResult, error: null }));
  queue = {
    add: vi.fn<ApprovalOutboxDependencies["queue"]["add"]>(async (_name, data, options) => {
      if (addFailure === "hang") return new Promise<{ id?: string }>(() => {});
      if (addFailure === "offline") throw new Error("PRIVATE_REDIS_FAILURE");
      if (!jobs.has(options.jobId)) jobs.set(options.jobId, { id: options.jobId, data: structuredClone(data), timestamp: 1, state: "waiting" });
      if (addFailure === "lost_ack") throw new Error("PRIVATE_LOST_ACK");
      return { id: options.jobId };
    }),
    getJob: vi.fn(async id => {
      const job = jobs.get(id);
      return job ? { ...structuredClone(job), getState: async () => job.state } : undefined;
    }),
  };
});
afterEach(() => { vi.useRealTimers(); });

describe("approval outbox relay with real canonical delivery helpers and inert transports", () => {
  it("publishes the unchanged minimal v2 content and records publication, not receipt", async () => {
    expect(await drain()).toEqual({ claimed: 1, published: 1, received: 0, blocked: 0, retry: 0 });
    const expected = delivery();
    expect(jobs.get(expected.jobId)?.data).toEqual(expected.data);
    expect(resolveCycleDelivery(jobs.get(expected.jobId)!)).toEqual(expected.identity);
    expect(finishes()).toEqual([{ p_id: actionId, p_lease: row().lease_token, p_result: "published" }]);
  });

  it.each(["offline", "lost_ack"] as const)("recovers after %s with the same job identity and fingerprint", async failure => {
    addFailure = failure;
    expect((await drain()).retry).toBe(1);
    const firstBinding = rpc.mock.calls.find(([name]) => name === "karta_prepare_approval_outbox")![1];
    addFailure = undefined;
    claimRows = [{ ...row(), lease_token: "00000000-0000-4000-8000-000000000725" }];
    expect((await drain()).published).toBe(1);
    const bindings = rpc.mock.calls.filter(([name]) => name === "karta_prepare_approval_outbox").map(([, args]) => args);
    for (const binding of bindings) {
      expect(binding.p_execution_key).toBe(firstBinding.p_execution_key);
      expect(binding.p_fingerprint).toBe(firstBinding.p_fingerprint);
    }
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify(finishes())).not.toContain("PRIVATE_");
  });

  it("republishes after Redis loss while keeping the durable business identity", async () => {
    await drain();
    const first = structuredClone(jobs.get(delivery().jobId));
    jobs.clear();
    expect((await drain()).published).toBe(1);
    expect(jobs.get(delivery().jobId)).toEqual(first);
  });

  it("stops publication when SQL already proves receipt, independently of business success", async () => {
    preparations = ["received"];
    expect(await drain()).toEqual({ claimed: 1, published: 0, received: 1, blocked: 0, retry: 0 });
    expect(queue.add).not.toHaveBeenCalled(); expect(finishes()).toEqual([]);
  });

  it.each(["failed", "completed"])("quarantines a retained %s job without a matching journal", async state => {
    const current = delivery();
    jobs.set(current.jobId, { id: current.jobId, timestamp: 1, data: current.data, state });
    expect((await drain()).blocked).toBe(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(finishes()[0].p_result).toBe("retained_terminal");
  });

  it("checks receipt again when a retained job finished during the first database read", async () => {
    const current = delivery();
    jobs.set(current.jobId, { id: current.jobId, timestamp: 1, data: current.data, state: "failed" });
    preparations = ["ready", "received"];
    expect((await drain()).received).toBe(1);
    expect(finishes()).toEqual([]); expect(queue.add).not.toHaveBeenCalled();
  });

  it("never accepts a changed retained payload under the same id", async () => {
    const current = delivery();
    jobs.set(current.jobId, { id: current.jobId, timestamp: 1,
      data: { ...current.data, trigger: { ...current.data.trigger, payload: { private: "PRIVATE_CONFLICT" } } }, state: "waiting" });
    expect((await drain()).blocked).toBe(1);
    expect(finishes()[0].p_result).toBe("identity_conflict");
    expect(queue.add).not.toHaveBeenCalled(); expect(JSON.stringify(finishes())).not.toContain("PRIVATE_CONFLICT");
  });

  it.each(["blocked", "stale"])("does not publish a %s lease", async prepared => {
    preparations = [prepared];
    const result = await drain();
    expect(result[prepared === "blocked" ? "blocked" : "retry"]).toBe(1);
    expect(queue.add).not.toHaveBeenCalled(); expect(finishes()).toEqual([]);
  });

  it("handles receipt observed by the canonical publisher's final compatibility check", async () => {
    preparations = ["ready", "ready", "received"];
    expect((await drain()).received).toBe(1);
    expect(finishes()).toEqual([]);
  });

  it("does not count a stale finish acknowledgement as confirmed publication", async () => {
    finishResult = false;
    expect((await drain()).retry).toBe(1);
  });

  it.each([true, false])("requires an actual quarantine acknowledgement for malformed intents: %s", async acknowledged => {
    claimRows = [{ ...row(), resolution: "unrecognized" }];
    finishResult = acknowledged;
    const result = await drain();
    expect(result[acknowledged ? "blocked" : "retry"]).toBe(1);
    expect(finishes()[0].p_result).toBe("invalid_intent");
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("bounds a stalled publication and leaves only a retry of the intent", async () => {
    addFailure = "hang";
    expect((await drain()).retry).toBe(1);
    expect(finishes()[0].p_result).toBe("retry");
  });

  it("aborts a stalled database operation with a generic error", async () => {
    rpc.mockImplementation(async () => new Promise(() => {}));
    await expect(drain()).rejects.toThrow("Continuation database unavailable");
    expect(rpc.mock.calls[0][2].aborted).toBe(true);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("keeps polling non-overlapping and aborts the current batch before closing", async () => {
    vi.useFakeTimers();
    rpc.mockImplementation(async () => new Promise(() => {}));
    const close = vi.fn(async () => {});
    const relay = createApprovalOutboxRelay({ rpc, queue, timeoutMs: 1_000 }, close, 10);
    await vi.advanceTimersByTimeAsync(100);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(relay.getHealth()).toMatchObject({ running: true, inFlight: true });
    const stopping = relay.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(rpc).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledOnce();
    expect(relay.getHealth()).toMatchObject({ running: false, inFlight: false });
    await relay.stop(); expect(close).toHaveBeenCalledOnce();
  });
});
