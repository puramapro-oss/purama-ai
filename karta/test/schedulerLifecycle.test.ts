import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tasks: new Map<string, { stop: ReturnType<typeof vi.fn>; callback: () => void }>(),
  schedule: vi.fn(), users: vi.fn(), agents: vi.fn(), enqueue: vi.fn(), report: vi.fn(),
}));
vi.mock("node-cron", () => ({ default: {
  schedule: mocks.schedule, getTasks: () => mocks.tasks, validate: () => true,
} }));
vi.mock("../src/config.js", () => ({ config: { dailyReportCron: "0 8 * * *" } }));
vi.mock("../src/agents/index.js", () => ({ listActiveUserIds: mocks.users }));
vi.mock("../src/agents/customAgent.js", () => ({ listKartaEnabledCustomAgents: mocks.agents }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: mocks.enqueue }));
vi.mock("../src/scheduler/dailyReport.js", () => ({ runDailyReport: mocks.report }));

import { startSchedulers } from "../src/scheduler/cron.js";
import { startCustomAgentScheduler } from "../src/scheduler/customAgents.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const agent = (id: string) => ({ id, user_id: "user", name: id, schedule_enabled: true, schedule_cron: "* * * * *" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tasks.clear();
  mocks.schedule.mockImplementation((_expression: string, callback: () => void) => {
    const task = { stop: vi.fn(), callback };
    mocks.tasks.set(`${mocks.schedule.mock.calls.length}`, task);
    return task;
  });
  mocks.agents.mockResolvedValue([agent("a"), agent("b")]);
  mocks.users.mockResolvedValue(["first", "second"]);
  mocks.enqueue.mockResolvedValue(undefined);
  mocks.report.mockResolvedValue(undefined);
});

describe("producer lifecycle", () => {
  it("rolls back every static task registered before the daily cron throws", () => {
    const acquired: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const implementation = mocks.schedule.getMockImplementation()!;
    mocks.schedule.mockImplementation((...args: unknown[]) => {
      if (acquired.length === 16) throw new Error("invalid daily cron");
      const task = implementation(...args);
      acquired.push(task);
      return task;
    });
    expect(() => startSchedulers()).toThrow("invalid daily cron");
    expect(acquired).toHaveLength(16);
    for (const task of acquired) expect(task.stop).toHaveBeenCalledOnce();
    expect(mocks.tasks.size).toBe(0);
  });

  it("a stopped core scan cannot enqueue users found after shutdown", async () => {
    const users = deferred<string[]>();
    mocks.users.mockReturnValue(users.promise);
    const scheduler = startSchedulers();
    const callback = [...mocks.tasks.values()][0].callback;
    callback();
    await Promise.resolve();
    scheduler.stop();
    users.resolve(["first"]);
    await scheduler.drain();
    callback();
    await scheduler.drain();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.tasks.size).toBe(0);
  });

  it("settles an already started enqueue and stops before the next user", async () => {
    const enqueue = deferred();
    mocks.enqueue.mockReturnValue(enqueue.promise);
    const scheduler = startSchedulers();
    [...mocks.tasks.values()][0].callback();
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    scheduler.stop();
    const drained = vi.fn();
    const drain = scheduler.drain().then(drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    enqueue.resolve();
    await drain;
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("includes an active daily report in its drain", async () => {
    const report = deferred();
    mocks.report.mockReturnValue(report.promise);
    const scheduler = startSchedulers();
    [...mocks.tasks.values()].at(-1)!.callback();
    await Promise.resolve();
    scheduler.stop();
    const settled = vi.fn();
    const drained = scheduler.drain().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    report.resolve();
    await drained;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("owns all private tasks and forbids late callbacks after stop", async () => {
    const scheduler = startCustomAgentScheduler();
    await scheduler.ready;
    const tasks = [...mocks.tasks.values()];
    expect(tasks).toHaveLength(3);
    scheduler.stop(); scheduler.stop();
    for (const task of tasks) {
      expect(task.stop).toHaveBeenCalledOnce();
      task.callback();
    }
    await scheduler.refresh();
    await scheduler.drain();
    expect(mocks.tasks.size).toBe(0);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.agents).toHaveBeenCalledOnce();
  });

  it("coalesces overlapping scans and discards an awaited snapshot after stop", async () => {
    const scan = deferred<ReturnType<typeof agent>[]>();
    mocks.agents.mockReturnValue(scan.promise);
    const scheduler = startCustomAgentScheduler();
    const first = scheduler.refresh(), second = scheduler.refresh();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(mocks.agents).toHaveBeenCalledOnce();
    scheduler.stop();
    scan.resolve([agent("late")]);
    await scheduler.ready; await scheduler.drain();
    expect(mocks.schedule).toHaveBeenCalledOnce();
    expect(mocks.tasks.size).toBe(0);
  });

  it("rolls back partially registered private crons on startup failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const implementation = mocks.schedule.getMockImplementation()!;
    mocks.schedule.mockImplementation((...args: unknown[]) => {
      if (mocks.schedule.mock.calls.length === 3) throw new Error("private registration");
      return implementation(...args);
    });
    const scheduler = startCustomAgentScheduler();
    await expect(scheduler.ready).rejects.toThrow("private registration");
    const tasks = [...mocks.tasks.values()];
    expect(tasks).toHaveLength(2);
    scheduler.stop(); await scheduler.drain();
    expect(mocks.tasks.size).toBe(0);
    for (const task of tasks) expect(task.stop).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });

  it("waits for a private enqueue already in flight", async () => {
    const enqueue = deferred();
    mocks.enqueue.mockReturnValue(enqueue.promise);
    const scheduler = startCustomAgentScheduler();
    await scheduler.ready;
    [...mocks.tasks.values()][1].callback();
    await Promise.resolve();
    scheduler.stop();
    const settled = vi.fn();
    const drained = scheduler.drain().then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    enqueue.resolve();
    await drained;
    expect(settled).toHaveBeenCalledOnce();
  });

  it("releases disabled private crons during refresh", async () => {
    const scheduler = startCustomAgentScheduler();
    await scheduler.ready;
    const removed = [...mocks.tasks.values()][1];
    mocks.agents.mockResolvedValueOnce([agent("b")]);
    await scheduler.refresh();
    expect(removed.stop).toHaveBeenCalledOnce();
    expect(mocks.tasks.size).toBe(2);
    scheduler.stop(); await scheduler.drain();
  });
});
