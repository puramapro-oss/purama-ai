import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCycleJobData } from "../src/queue/queues.js";

vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));
vi.mock("bullmq", () => ({ Queue: class {} }));
import { drainApprovalOutboxOnce, type ApprovalOutboxDependencies } from "../src/queue/approval-outbox.js";

afterEach(() => { vi.restoreAllMocks(); });

function clock() {
  const time = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => time.now);
  return time;
}

const lease = {
  pending_action_id: "00000000-0000-4000-8000-000000000721",
  user_id: "00000000-0000-4000-8000-000000000722",
  parent_run_id: "00000000-0000-4000-8000-000000000723",
  agent_type: "legal", resolution: "executed",
  lease_token: "00000000-0000-4000-8000-000000000724", protocol: 1,
};

type Stage = "claim" | "prepare" | "read" | "add" | "finish";
function fixture(stage: Stage, elapsed: number) {
  const time = clock();
  const advance = (current: Stage) => { if (current === stage) time.now += elapsed; };
  let stored: { id: string; timestamp: number; data: AgentCycleJobData; getState(): Promise<string> } | undefined;
  const rpc = vi.fn<ApprovalOutboxDependencies["rpc"]>(async (name, params) => {
    if (name === "karta_claim_approval_outbox") { advance("claim"); return { data: [lease], error: null }; }
    if (name === "karta_prepare_approval_outbox") { advance("prepare"); return { data: "ready", error: null }; }
    if (params.p_result === "published") advance("finish");
    return { data: true, error: null };
  });
  const queue: ApprovalOutboxDependencies["queue"] = {
    getJob: vi.fn(async () => { advance("read"); return stored; }),
    add: vi.fn(async (_name, data, options) => {
      stored = { id: options.jobId, timestamp: 1, data: structuredClone(data), getState: async () => "waiting" };
      advance("add"); return { id: options.jobId };
    }),
  };
  return { rpc, queue, timeoutMs: 5 };
}

describe("outbox deadlines at the real Promise handoff", () => {
  it.each<Stage>(["claim", "prepare", "read", "add", "finish"])("accepts %s I/O returned before its individual deadline", async stage => {
    const dependencies = fixture(stage, 4);
    expect(await drainApprovalOutboxOnce(dependencies)).toEqual({ claimed: 1, published: 1, received: 0, blocked: 0, retry: 0 });
    expect(dependencies.queue.add).toHaveBeenCalledOnce();
  });

  it.each([5, 6])("rejects a claim returned at %i ms before the timeout callback runs", async elapsed => {
    const dependencies = fixture("claim", elapsed);
    await expect(drainApprovalOutboxOnce(dependencies)).rejects.toThrow("Continuation database unavailable");
    expect(dependencies.queue.add).not.toHaveBeenCalled();
    expect(dependencies.rpc.mock.calls[0][2].aborted).toBe(true);
  });

  it.each<Stage>(["prepare", "read", "add", "finish"])("does not confirm publication after a late %s I/O", async stage => {
    const dependencies = fixture(stage, 5);
    expect(await drainApprovalOutboxOnce(dependencies)).toEqual({ claimed: 1, published: 0, received: 0, blocked: 0, retry: 1 });
    if (stage === "prepare" || stage === "read") expect(dependencies.queue.add).not.toHaveBeenCalled();
    else expect(dependencies.queue.add).toHaveBeenCalledOnce();
    expect(dependencies.rpc.mock.calls.some(([name, params]) => name === "karta_finish_approval_outbox" && params.p_result === "retry")).toBe(true);
  });

  it("rejects a cancelled empty claim during the Promise race handoff", async () => {
    const dependencies = fixture("claim", 0);
    const parent = new AbortController();
    dependencies.rpc.mockImplementation(() => Promise.resolve().then(() => {
      queueMicrotask(() => queueMicrotask(() => parent.abort()));
      return { data: [], error: null };
    }));
    await expect(drainApprovalOutboxOnce({ ...dependencies, signal: parent.signal }))
      .rejects.toThrow("Continuation database unavailable");
    expect(dependencies.queue.add).not.toHaveBeenCalled();
  });

  it("does not invoke the database for an already cancelled parent", async () => {
    const dependencies = fixture("claim", 0);
    const parent = new AbortController(); parent.abort();
    await expect(drainApprovalOutboxOnce({ ...dependencies, signal: parent.signal }))
      .rejects.toThrow("Continuation database unavailable");
    expect(dependencies.rpc).not.toHaveBeenCalled();
    expect(dependencies.queue.add).not.toHaveBeenCalled();
  });

  it("aborts a late rejected claim and preserves a generic outward error", async () => {
    const dependencies = fixture("claim", 0);
    const time = { now: 0 };
    vi.spyOn(performance, "now").mockImplementation(() => time.now);
    dependencies.rpc.mockImplementation(async () => { time.now = 6; throw new Error("PRIVATE_TRANSPORT_DETAIL"); });
    await expect(drainApprovalOutboxOnce(dependencies)).rejects.toThrow("Continuation database unavailable");
    expect(dependencies.rpc.mock.calls[0][2].aborted).toBe(true);
    expect(dependencies.queue.add).not.toHaveBeenCalled();
  });

  it("rejects a real clock overrun before the timer is able to run", async () => {
    const dependencies = fixture("claim", 0);
    vi.restoreAllMocks();
    dependencies.rpc.mockImplementation(async () => {
      const stop = performance.now() + 20;
      while (performance.now() < stop) { /* Deliberately occupies one turn of the event loop. */ }
      return { data: [], error: null };
    });
    await expect(drainApprovalOutboxOnce(dependencies)).rejects.toThrow("Continuation database unavailable");
    expect(dependencies.queue.add).not.toHaveBeenCalled();
  });
});
