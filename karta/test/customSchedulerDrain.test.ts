import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { TaskContext } from "node-cron";
import { createRuntime } from "../src/runtime/lifecycle.js";

interface Timer {
  expression: string;
  callback: (context: TaskContext) => unknown;
  destroy: ReturnType<typeof vi.fn>;
}
const state = vi.hoisted(() => ({ timers: [] as Timer[], list: vi.fn(), enqueue: vi.fn() }));
vi.mock("node-cron", () => ({ default: {
  validate: () => true,
  schedule: (expression: string, callback: Timer["callback"]) => {
    const timer = { expression, callback, destroy: vi.fn(), stop: vi.fn() };
    state.timers.push(timer);
    return timer;
  },
} }));
vi.mock("../src/agents/customAgent.js", () => ({ listKartaEnabledCustomAgents: state.list }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: state.enqueue }));

const agent = {
  id: "custom-drain", user_id: "user-drain", name: "Agent de test",
  schedule_enabled: true, schedule_cron: "*/10 * * * *",
};
const instant = "2026-11-22T08:00:00.000Z";
const context = (date = instant): TaskContext => ({
  date: new Date(date), dateLocalIso: date, triggeredAt: new Date(),
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function observe(promise: Promise<unknown>) {
  const result = { status: "pending" };
  void promise.then(() => { result.status = "resolved"; }, () => { result.status = "rejected"; });
  return result;
}
const load = () => import("../src/scheduler/customAgents.js");
const scheduledTimer = () => state.timers.find(timer => timer.expression === agent.schedule_cron)!;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
  state.timers.length = 0;
  state.list.mockReset().mockResolvedValue([agent]);
  state.enqueue.mockReset().mockResolvedValue("queued");
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("custom scheduler stable delivery and producer drain", () => {
  it("keeps one scheduled identity when the same tick is dispatched in different minutes", async () => {
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    await scheduledTimer().callback(context());
    vi.setSystemTime(new Date("2026-11-22T08:01:05.000Z"));
    await scheduledTimer().callback(context());
    await controller.stop();
    expect(state.enqueue).toHaveBeenCalledTimes(2);
    expect(state.enqueue.mock.calls.map(call => call[1].dedupeKey)).toEqual([
      "cron|custom:custom-drain|user-drain|2026-11-22T08:00",
      "cron|custom:custom-drain|user-drain|2026-11-22T08:00",
    ]);
    expect(state.enqueue.mock.calls[1][0].trigger.payload.slot).toBe("2026-11-22T08:00");
  });

  it("does not collapse different scheduled ticks when both callbacks arrive in the same minute", async () => {
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    vi.setSystemTime(new Date("2026-11-22T08:20:05.000Z"));
    await scheduledTimer().callback(context());
    await scheduledTimer().callback(context("2026-11-22T08:10:00.000Z"));
    await controller.stop();
    expect(state.enqueue.mock.calls.map(call => call[1].dedupeKey)).toEqual([
      "cron|custom:custom-drain|user-drain|2026-11-22T08:00",
      "cron|custom:custom-drain|user-drain|2026-11-22T08:10",
    ]);
  });

  it("keeps six distinct deliveries for a valid ten-second cron schedule", async () => {
    const cronExpr = "*/10 * * * * *";
    state.list.mockResolvedValue([{ ...agent, schedule_cron: cronExpr }]);
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    const timer = state.timers.find(candidate => candidate.expression === cronExpr)!;
    const seconds = ["00", "10", "20", "30", "40", "50"];
    for (const second of seconds) await timer.callback(context(`2026-11-22T08:00:${second}.000Z`));
    await controller.stop();
    expect(state.enqueue.mock.calls.map(call => call[1].dedupeKey)).toEqual(seconds.map(second =>
      `cron|custom:custom-drain|user-drain|2026-11-22T08:00:${second}`));
    expect(new Set(state.enqueue.mock.calls.map(call => call[1].dedupeKey)).size).toBe(6);
  });

  it("keeps a six-field tick stable when its callback is delayed across a minute boundary", async () => {
    const cronExpr = "  */10   * * * * *  ";
    state.list.mockResolvedValue([{ ...agent, schedule_cron: cronExpr }]);
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    const timer = state.timers.find(candidate => candidate.expression === cronExpr)!;
    await timer.callback(context("2026-11-22T08:00:50.000Z"));
    vi.setSystemTime(new Date("2026-11-22T08:01:10.000Z"));
    await timer.callback(context("2026-11-22T08:00:50.000Z"));
    await controller.stop();
    expect(state.enqueue.mock.calls.map(call => call[1].dedupeKey)).toEqual([
      "cron|custom:custom-drain|user-drain|2026-11-22T08:00:50",
      "cron|custom:custom-drain|user-drain|2026-11-22T08:00:50",
    ]);
  });

  it("waits for an already started enqueue and keeps stop idempotent", async () => {
    const delivery = deferred<string>();
    state.enqueue.mockReturnValueOnce(delivery.promise);
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    const execution = scheduledTimer().callback(context());
    await tick();
    expect(state.enqueue).toHaveBeenCalledOnce();
    const stopping = Promise.resolve(controller.stop());
    const status = observe(stopping);
    const repeated = controller.stop();
    try {
      await tick();
      expect(status.status).toBe("pending");
      expect(repeated).toBe(stopping);
      await scheduledTimer().callback(context("2026-11-22T08:10:00.000Z"));
      expect(state.enqueue).toHaveBeenCalledOnce();
      delivery.resolve("confirmed");
      await execution;
      await stopping;
      expect(status.status).toBe("resolved");
      expect(state.timers.every(timer => timer.destroy.mock.calls.length === 1)).toBe(true);
    } finally { delivery.resolve("confirmed"); await execution; await stopping; }
  });

  it("drains every overlapping callback, including a replaced schedule", async () => {
    const first = deferred<string>(); const second = deferred<string>();
    state.enqueue.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { startCustomAgentScheduler, refreshCustomAgentSchedules } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    const oldTimer = scheduledTimer();
    const oldRun = oldTimer.callback(context());
    state.list.mockResolvedValue([{ ...agent, schedule_cron: "0 * * * *" }]);
    await refreshCustomAgentSchedules();
    const newRun = state.timers.find(timer => timer.expression === "0 * * * *")!.callback(context());
    await tick();
    expect(state.enqueue).toHaveBeenCalledTimes(2);
    const stopping = Promise.resolve(controller.stop()); const status = observe(stopping);
    try {
      first.resolve("first"); await oldRun; await tick();
      expect(status.status).toBe("pending");
      second.resolve("second"); await newRun; await stopping;
      expect(status.status).toBe("resolved");
    } finally { first.resolve("first"); second.resolve("second"); await Promise.all([oldRun, newRun, stopping]); }
  });

  it("keeps an old drain separate from a restarted scheduler", async () => {
    const first = deferred<string>(); const second = deferred<string>();
    state.enqueue.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { startCustomAgentScheduler } = await load();
    const oldController = startCustomAgentScheduler();
    await tick();
    const oldTimer = scheduledTimer();
    const oldRun = oldTimer.callback(context());
    await tick();
    const oldStop = Promise.resolve(oldController.stop()); const oldStatus = observe(oldStop);
    const nextController = startCustomAgentScheduler();
    await tick();
    const nextTimer = state.timers.at(-1)!;
    const nextRun = nextTimer.callback(context("2026-11-22T08:10:00.000Z"));
    await tick();
    try {
      expect(oldStatus.status).toBe("pending");
      first.resolve("old confirmed"); await oldRun; await oldStop;
      expect(nextTimer.destroy).not.toHaveBeenCalled();
      expect(oldController.stop()).toBe(oldStop);
      await oldTimer.callback(context());
      expect(state.enqueue).toHaveBeenCalledTimes(2);
      const nextStop = Promise.resolve(nextController.stop()); const nextStatus = observe(nextStop);
      await tick(); expect(nextStatus.status).toBe("pending");
      second.resolve("next confirmed"); await nextRun; await nextStop;
    } finally { first.resolve("old"); second.resolve("next"); await Promise.all([oldRun, nextRun, oldStop]); await nextController.stop(); }
  });

  it("waits for asynchronous destruction of a timer retired by a rescan", async () => {
    const cleanup = deferred<void>();
    const { startCustomAgentScheduler, refreshCustomAgentSchedules } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    scheduledTimer().destroy.mockReturnValueOnce(cleanup.promise);
    state.list.mockResolvedValue([]);
    await refreshCustomAgentSchedules();
    const stopping = Promise.resolve(controller.stop()); const status = observe(stopping);
    try {
      await tick(); expect(status.status).toBe("pending");
      cleanup.resolve(); await stopping; expect(status.status).toBe("resolved");
    } finally { cleanup.resolve(); await stopping; }
  });

  it.each(["synchronous", "asynchronous"])("reports %s cleanup failure after draining without exposing its details", async (kind) => {
    const delivery = deferred<string>();
    state.enqueue.mockReturnValueOnce(delivery.promise);
    const { startCustomAgentScheduler } = await load();
    const controller = startCustomAgentScheduler();
    await tick();
    const timer = scheduledTimer();
    const execution = timer.callback(context());
    await tick();
    if (kind === "synchronous") timer.destroy.mockImplementation(() => { throw new Error("PRIVATE_CLEANUP_DETAIL"); });
    else timer.destroy.mockRejectedValue(new Error("PRIVATE_CLEANUP_DETAIL"));
    const stopping = Promise.resolve(controller.stop()); const status = observe(stopping);
    try {
      await tick(); expect(status.status).toBe("pending");
      delivery.resolve("confirmed"); await execution;
      await expect(stopping).rejects.toThrow("Arrêt du planificateur personnalisé non confirmé");
      expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("PRIVATE_CLEANUP_DETAIL");
    } finally { delivery.resolve("confirmed"); await execution; await stopping.catch(() => {}); }
  });
});

async function startRuntime(shutdownMs = 500) {
  const { startCustomAgentScheduler } = await load();
  const events: string[] = [];
  const server = {
    listening: true,
    close: (callback: () => void) => { callback(); },
    closeAllConnections: () => {},
  } as unknown as Server;
  const runtime = createRuntime({
    probe: async () => ({ globalKillSwitch: false }), startHttp: () => server,
    startWorker: () => ({ waitUntilReady: async () => {}, close: async () => { events.push("worker-closed"); } }),
    startSchedulers: () => [], startCustomScheduler: startCustomAgentScheduler,
    startRelay: () => ({ stop: () => {} }),
    closeQueue: async () => { events.push("queue-closed"); },
    disconnect: () => { events.push("redis-disconnected"); },
  }, { shutdownMs });
  await runtime.start(); await tick();
  return { runtime, events };
}

describe("custom scheduler through the real runtime lifecycle", () => {
  it("keeps queue resources alive until an admitted producer finishes", async () => {
    const delivery = deferred<string>(); state.enqueue.mockReturnValueOnce(delivery.promise);
    const { runtime, events } = await startRuntime();
    const execution = scheduledTimer().callback(context()); await tick();
    const stopping = runtime.stop();
    try {
      await tick(); expect(events).not.toContain("queue-closed"); expect(events).not.toContain("redis-disconnected");
      delivery.resolve("confirmed"); await execution;
      expect(await stopping).toBe(true);
      expect(events).toContain("queue-closed"); expect(events).toContain("redis-disconnected");
    } finally { delivery.resolve("confirmed"); await execution; await stopping; }
  });

  it("reports an uncooperative enqueue as a failed shutdown at the runtime deadline", async () => {
    const delivery = deferred<string>(); state.enqueue.mockReturnValueOnce(delivery.promise);
    const { runtime, events } = await startRuntime(20);
    const timer = scheduledTimer(); const execution = timer.callback(context()); await tick();
    try {
      expect(await runtime.stop()).toBe(false);
      expect(events).toContain("redis-disconnected");
      await timer.callback(context("2026-11-22T08:10:00.000Z"));
      expect(state.enqueue).toHaveBeenCalledOnce();
    } finally { delivery.resolve("late confirmation"); await execution; await runtime.stop(); }
  });
});
