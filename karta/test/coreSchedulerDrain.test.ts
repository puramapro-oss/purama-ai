import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import { createRuntime } from "../src/runtime/lifecycle.js";

const h = vi.hoisted(() => ({
  rows: [] as Array<{ callback: () => unknown; rawStop: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }>,
  users: vi.fn(), enqueue: vi.fn(), daily: vi.fn(),
  config: { dailyReportCron: "0 8 * * *" },
  scheduleCalls: 0,
  failAtSchedule: 0,
}));
vi.mock("node-cron", () => ({ default: {
  validate: (expression: string) => expression !== "invalid",
  schedule: (expression: string, callback: () => unknown) => {
    h.scheduleCalls++;
    if (expression === "invalid" || h.scheduleCalls === h.failAtSchedule) throw new Error("inert schedule failure");
    const rawStop = vi.fn();
    const destroy = vi.fn();
    h.rows.push({ callback, rawStop, destroy });
    return { stop: rawStop, destroy, start: vi.fn() };
  },
} }));
vi.mock("../src/config.js", () => ({ config: h.config }));
vi.mock("../src/agents/index.js", () => ({ listActiveUserIds: h.users }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: h.enqueue }));
vi.mock("../src/scheduler/dailyReport.js", () => ({ runDailyReport: h.daily }));

import { startSchedulers } from "../src/scheduler/cron.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function observed(promise: Promise<unknown>) {
  const state: { status: "pending" | "resolved" | "rejected"; error?: unknown } = { status: "pending" };
  void promise.then(() => { state.status = "resolved"; }, error => {
    state.status = "rejected"; state.error = error;
  });
  return state;
}

beforeEach(() => {
  h.rows.length = 0;
  h.scheduleCalls = 0; h.failAtSchedule = 0;
  h.config.dailyReportCron = "0 8 * * *";
  h.users.mockReset().mockResolvedValue(["user-a", "user-b"]);
  h.enqueue.mockReset().mockResolvedValue("queued");
  h.daily.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe("core scheduler shutdown", () => {
  it("keeps ordinary scheduling functional with a stable per-user delivery key", async () => {
    startSchedulers();
    await h.rows[0].callback(); await tick();
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    const [first, options] = h.enqueue.mock.calls[0];
    expect(first).toMatchObject({ agentType: "email", userId: "user-a", trigger: { type: "cron" } });
    expect(options.dedupeKey).toBe(`cron|email|user-a|${first.trigger.payload.slot}`);
    expect(h.enqueue.mock.calls[1][0].trigger.payload.slot).toBe(first.trigger.payload.slot);
  });

  it("rejects timer callbacks already dispatched before stop but invoked afterward", async () => {
    const tasks = startSchedulers();
    await tasks[0].stop();
    await h.rows[0].callback(); await tick();
    expect(h.users).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("waits for a suspended user scan and never publishes its late result", async () => {
    const scan = deferred<string[]>(); h.users.mockReturnValue(scan.promise);
    const tasks = startSchedulers(); void h.rows[0].callback(); await tick();
    const stopping = Promise.resolve(tasks[0].stop()); const state = observed(stopping);
    try {
      await tick(); expect(state.status).toBe("pending");
      scan.resolve(["late-user"]); await stopping; await tick();
      expect(h.enqueue).not.toHaveBeenCalled();
    } finally { scan.resolve([]); await tick(); }
  });

  it("drains an already started enqueue and cancels the remaining users", async () => {
    const delivery = deferred<string>(); h.enqueue.mockReturnValueOnce(delivery.promise);
    const tasks = startSchedulers(); void h.rows[0].callback(); await tick();
    expect(h.enqueue).toHaveBeenCalledOnce();
    const stopping = Promise.resolve(tasks[0].stop()); const state = observed(stopping);
    try {
      await tick(); expect(state.status).toBe("pending");
      delivery.resolve("confirmed"); await stopping; await tick();
      expect(h.enqueue).toHaveBeenCalledOnce();
    } finally { delivery.resolve("confirmed"); await tick(); }
  });

  it("drains all overlapping callbacks instead of only the latest one", async () => {
    h.users.mockResolvedValue(["user-a"]);
    const first = deferred<string>(); const second = deferred<string>();
    h.enqueue.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const tasks = startSchedulers(); void h.rows[0].callback(); void h.rows[0].callback(); await tick();
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    const stopping = Promise.resolve(tasks[0].stop()); const state = observed(stopping);
    try {
      first.resolve("first"); await tick(); expect(state.status).toBe("pending");
      second.resolve("second"); await stopping; expect(state.status).toBe("resolved");
    } finally { first.resolve("first"); second.resolve("second"); await tick(); }
  });

  it("makes stop idempotent and stops the underlying timer only once", async () => {
    const tasks = startSchedulers();
    const first = tasks[0].stop(); const second = tasks[0].stop();
    expect(first).toBe(second); await first;
    expect(h.rows[0].rawStop).toHaveBeenCalledOnce();
  });

  it("preserves individual stop without stopping the other schedules", async () => {
    const tasks = startSchedulers(); await tasks[0].stop();
    await h.rows[1].callback(); await tick();
    expect(h.users).toHaveBeenCalledWith("compta");
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.rows[1].rawStop).not.toHaveBeenCalled();
  });

  it("rejects an invalid daily report expression before creating any timer", () => {
    h.config.dailyReportCron = "invalid";
    expect(() => startSchedulers()).toThrow();
    expect(h.rows).toHaveLength(0);
    expect(h.scheduleCalls).toBe(0);
  });

  it("retires every partially created timer if a later schedule creation throws", async () => {
    h.failAtSchedule = 3;
    expect(() => startSchedulers()).toThrow();
    expect(h.rows).toHaveLength(2);
    await tick();
    for (const row of h.rows) {
      expect(row.rawStop).toHaveBeenCalledOnce();
      expect(row.destroy).toHaveBeenCalledOnce();
      await row.callback();
    }
    await tick();
    expect(h.users).not.toHaveBeenCalled(); expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("waits for a daily report already in progress", async () => {
    const report = deferred<void>(); h.daily.mockReturnValue(report.promise);
    const tasks = startSchedulers(); void h.rows.at(-1)!.callback(); await tick();
    const stopping = Promise.resolve(tasks.at(-1)!.stop()); const state = observed(stopping);
    try {
      await tick(); expect(state.status).toBe("pending");
      report.resolve(); await stopping; expect(state.status).toBe("resolved");
    } finally { report.resolve(); await tick(); }
  });

  it("never starts a daily report from a stale callback after stop", async () => {
    const tasks = startSchedulers(); await tasks.at(-1)!.stop();
    await h.rows.at(-1)!.callback(); await tick();
    expect(h.daily).not.toHaveBeenCalled();
  });

  it("settles failed work without detaching an unhandled rejection", async () => {
    h.enqueue.mockRejectedValue(new Error("inert transport failure"));
    h.daily.mockRejectedValue(new Error("inert report failure"));
    const tasks = startSchedulers();
    void h.rows[0].callback(); void h.rows.at(-1)!.callback(); await tick();
    await Promise.all(tasks.map(task => task.stop()));
    expect(h.enqueue).toHaveBeenCalledOnce(); expect(h.daily).toHaveBeenCalledOnce();
  });

  it("still drains existing work when stopping the underlying timer rejects", async () => {
    const scan = deferred<string[]>(); h.users.mockReturnValue(scan.promise);
    const tasks = startSchedulers(); void h.rows[0].callback(); await tick();
    h.rows[0].rawStop.mockRejectedValueOnce(new Error("inert timer failure"));
    const stopping = Promise.resolve(tasks[0].stop()); const state = observed(stopping);
    try {
      await tick(); expect(state.status).toBe("pending");
      scan.resolve(["late-user"]); await expect(stopping).rejects.toThrow();
      expect(h.enqueue).not.toHaveBeenCalled();
    } finally { scan.resolve([]); await tick(); }
  });
});

function runtimeFixture(shutdownMs = 500) {
  const events: string[] = [];
  const server = {
    listening: true,
    close: (callback: () => void) => { events.push("http-closed"); callback(); },
    closeAllConnections: () => {},
  } as unknown as Server;
  const runtime = createRuntime({
    probe: async () => ({ globalKillSwitch: false }),
    startHttp: () => server,
    startWorker: () => ({ waitUntilReady: async () => {}, close: async (force?: boolean) => {
      events.push(force ? "worker-forced" : "worker-closed");
    } }),
    startSchedulers,
    startCustomScheduler: () => ({ stop: () => {} }),
    startRelay: () => ({ stop: () => {} }),
    closeQueue: async () => { events.push("queue-closed"); },
    disconnect: () => { events.push("redis-disconnected"); },
  }, { shutdownMs });
  return { runtime, events };
}

describe("real core scheduler through runtime lifecycle", () => {
  it("cannot report a clean stop before a suspended producer is drained", async () => {
    const scan = deferred<string[]>(); h.users.mockReturnValue(scan.promise);
    const { runtime, events } = runtimeFixture(); await runtime.start();
    void h.rows[0].callback(); await tick();
    const stopping = runtime.stop();
    try {
      await tick(); expect(events).not.toContain("queue-closed");
      scan.resolve(["late-user"]); expect(await stopping).toBe(true); await tick();
      expect(h.enqueue).not.toHaveBeenCalled();
      expect(events).toContain("redis-disconnected");
    } finally { scan.resolve([]); await stopping; }
  });

  it("reports an uncooperative scan as failed at the global deadline and blocks its late publication", async () => {
    const scan = deferred<string[]>(); h.users.mockReturnValue(scan.promise);
    const { runtime, events } = runtimeFixture(20); await runtime.start();
    void h.rows[0].callback(); await tick();
    try {
      expect(await runtime.stop()).toBe(false);
      expect(events).toContain("redis-disconnected");
      scan.resolve(["late-user"]); await tick();
      expect(h.enqueue).not.toHaveBeenCalled();
    } finally { scan.resolve([]); await runtime.stop(); await tick(); }
  });
});
