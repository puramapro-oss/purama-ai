import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Timer {
  expression: string;
  callback: () => unknown;
  stop: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  tasks: [] as Timer[],
  list: vi.fn(),
  enqueue: vi.fn(),
  valid: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: {
    validate: state.valid,
    schedule: vi.fn((expression: string, callback: () => unknown) => {
      const task = { expression, callback, stop: vi.fn(), destroy: vi.fn() };
      state.tasks.push(task);
      return task;
    }),
  },
}));
vi.mock("../src/agents/customAgent.js", () => ({ listKartaEnabledCustomAgents: state.list }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: state.enqueue }));

const agent = {
  id: "agent-test", user_id: "user-test", name: "Agent privé",
  schedule_enabled: true, schedule_cron: "*/10 * * * *",
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
const load = () => import("../src/scheduler/customAgents.js");

beforeEach(() => {
  vi.resetModules();
  state.tasks.length = 0;
  state.list.mockReset().mockResolvedValue([agent]);
  state.enqueue.mockReset().mockResolvedValue("job-test");
  state.valid.mockReset().mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("custom-agent scheduler lifecycle", () => {
  it("keeps the existing durable queue identity on a normal tick", async () => {
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    expect(state.tasks).toHaveLength(2);
    await state.tasks.find(task => task.expression === agent.schedule_cron)!.callback();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    const [data, options] = state.enqueue.mock.calls[0];
    expect(data).toMatchObject({ agentType: "custom:agent-test", userId: "user-test", trigger: { type: "cron" } });
    expect(options.dedupeKey).toBe(`cron|custom:agent-test|user-test|${data.trigger.payload.slot}`);
    controller.stop();
  });

  it("catches a periodic scan failure and allows the next scan to recover", async () => {
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    const interval = state.tasks.find(task => task.expression === "*/5 * * * *")!;
    // An observed rejection tests the scheduler callback without letting a defect
    // terminate the entire runner before the failed assertion is reported.
    const failure = Promise.reject(new Error("PRIVATE_DATABASE_DETAIL"));
    void failure.catch(() => undefined);
    state.list.mockReturnValueOnce(failure);
    const result = interval.callback();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("PRIVATE_DATABASE_DETAIL");
    await interval.callback();
    expect(state.list).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it("also handles the initial failure without detaching a rejected promise", async () => {
    state.list.mockRejectedValueOnce(new Error("PRIVATE_INITIAL_DETAIL"));
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("PRIVATE_INITIAL_DETAIL");
    await state.tasks[0].callback();
    expect(state.tasks).toHaveLength(2);
    controller.stop();
  });

  it("shares an in-flight scan instead of applying out-of-order snapshots", async () => {
    const pending = deferred<typeof agent[]>();
    state.list.mockReturnValue(pending.promise);
    const { refreshCustomAgentSchedules } = await load();
    const first = refreshCustomAgentSchedules();
    const second = refreshCustomAgentSchedules();
    expect(state.list).toHaveBeenCalledTimes(1);
    pending.resolve([agent]);
    await Promise.all([first, second]);
    expect(state.tasks).toHaveLength(1);
  });

  it("destroys all timers on stop and rejects already-queued callbacks", async () => {
    const { startCustomAgentScheduler, refreshCustomAgentSchedules } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    const callbacks = state.tasks.map(task => task.callback);
    controller.stop();
    expect(state.tasks.every(task => task.destroy.mock.calls.length === 1)).toBe(true);
    for (const callback of callbacks) await callback();
    await refreshCustomAgentSchedules();
    expect(state.list).toHaveBeenCalledTimes(1);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it("does not register an agent when a scan resolves after stop", async () => {
    const pending = deferred<typeof agent[]>();
    state.list.mockReturnValue(pending.promise);
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    controller.stop();
    pending.resolve([agent]);
    await flush();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0].destroy).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reuses the active controller if startup is called twice", async () => {
    const { startCustomAgentScheduler } = await load();
    const first = startCustomAgentScheduler();
    const second = startCustomAgentScheduler();
    await flush();
    expect(second).toBe(first);
    expect(state.list).toHaveBeenCalledTimes(1);
    expect(state.tasks).toHaveLength(2);
    first.stop();
  });

  it("isolates restarts from an old scan and an old stop handle", async () => {
    const pending = deferred<typeof agent[]>();
    const newPending = deferred<typeof agent[]>();
    state.list.mockReturnValueOnce(pending.promise).mockReturnValueOnce(newPending.promise);
    const { startCustomAgentScheduler, refreshCustomAgentSchedules } = await load();
    const first = startCustomAgentScheduler();
    first.stop();
    const second = startCustomAgentScheduler();
    await flush();
    expect(state.list).toHaveBeenCalledTimes(2);
    pending.resolve([agent]);
    await flush();
    const joined = refreshCustomAgentSchedules();
    expect(state.list).toHaveBeenCalledTimes(2);
    newPending.resolve([]);
    await joined;
    expect(state.tasks).toHaveLength(2);
    first.stop();
    expect(state.tasks[1].destroy).not.toHaveBeenCalled();
    await state.tasks[0].callback();
    expect(state.list).toHaveBeenCalledTimes(2);
    second.stop();
    expect(state.tasks[1].destroy).toHaveBeenCalledTimes(1);
  });

  it("invalidates retired timer callbacks during reconfiguration", async () => {
    const { startCustomAgentScheduler, refreshCustomAgentSchedules } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    const oldTimer = state.tasks.find(task => task.expression === agent.schedule_cron)!;
    state.list.mockResolvedValue([{ ...agent, schedule_cron: "0 * * * *" }]);
    await refreshCustomAgentSchedules();
    expect(oldTimer.destroy).toHaveBeenCalledTimes(1);
    await oldTimer.callback();
    expect(state.enqueue).not.toHaveBeenCalled();
    await state.tasks.find(task => task.expression === "0 * * * *")!.callback();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("handles a failed enqueue without exposing the provider error", async () => {
    state.enqueue.mockRejectedValue(new Error("PRIVATE_QUEUE_DETAIL"));
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    await expect(state.tasks.find(task => task.expression === agent.schedule_cron)!.callback()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("PRIVATE_QUEUE_DETAIL");
    controller.stop();
  });

  it("keeps callbacks inert even if asynchronous timer destruction fails", async () => {
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    const timer = state.tasks.find(task => task.expression === agent.schedule_cron)!;
    timer.destroy.mockRejectedValue(new Error("PRIVATE_DESTROY_DETAIL"));
    controller.stop();
    await flush();
    await timer.callback();
    expect(state.enqueue).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("PRIVATE_DESTROY_DETAIL");
  });

  it("bounds a stalled scan, aborts its request and ignores its late result after recovery", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = deferred<typeof agent[]>();
    state.list.mockReturnValueOnce(pending.promise).mockResolvedValue([{ ...agent, id: "new-agent" }]);
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    const signal = state.list.mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal.aborted).toBe(true);
    expect(console.error).toHaveBeenCalledTimes(1);
    await state.tasks[0].callback();
    expect(state.list).toHaveBeenCalledTimes(2);
    const recoveredTimer = state.tasks[1];
    pending.resolve([agent]);
    await flush();
    expect(state.tasks).toHaveLength(2);
    expect(recoveredTimer.destroy).not.toHaveBeenCalled();
    await recoveredTimer.callback();
    expect(state.enqueue.mock.calls[0][0].agentType).toBe("custom:new-agent");
    expect(vi.getTimerCount()).toBe(0);
    controller.stop();
  });

  it("keeps existing agent timers usable when a later scan expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await flush();
    const existing = state.tasks.find(task => task.expression === agent.schedule_cron)!;
    const pending = deferred<typeof agent[]>();
    state.list.mockReturnValueOnce(pending.promise);
    const scan = state.tasks[0].callback();
    await vi.advanceTimersByTimeAsync(30_000);
    await scan;
    await existing.callback();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    expect(existing.destroy).not.toHaveBeenCalled();
    pending.resolve([]);
    await flush();
    expect(existing.destroy).not.toHaveBeenCalled();
    controller.stop();
  });
});
