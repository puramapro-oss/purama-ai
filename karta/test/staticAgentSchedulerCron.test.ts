import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The actual node-cron lifecycle runs here; database, queue and report effects
// remain inert. Its clock is fixed so unrelated scheduled ticks cannot race us.
const state = vi.hoisted(() => ({ list: vi.fn(), enqueue: vi.fn(), report: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ listActiveUserIds: state.list }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: state.enqueue }));
vi.mock("../src/scheduler/dailyReport.js", () => ({ runDailyReport: state.report }));

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-10T12:00:00.000Z"));
  state.list.mockReset().mockResolvedValue(["user-1"]);
  state.enqueue.mockReset().mockResolvedValue("job-test");
  state.report.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  const { default: cron } = await import("node-cron");
  for (const task of cron.getTasks().values()) await task.destroy();
  vi.useRealTimers();
});

describe("static-agent scheduler with actual node-cron", () => {
  it("invalidates a real executing callback before its database read completes", async () => {
    const pending = deferred<string[]>();
    state.list.mockReturnValueOnce(pending.promise);
    const { default: cron } = await import("node-cron");
    const { startSchedulers } = await import("../src/scheduler/cron.js");
    const controllers = startSchedulers();
    const task = [...cron.getTasks().values()].find(candidate => candidate.getPattern() === "*/2 * * * *")!;
    const execution = task.execute();
    try {
      await flush();
      expect(state.list).toHaveBeenCalledTimes(1);
      controllers[0].stop();
      pending.resolve(["user-1"]);
      await execution;
      await flush();
      expect(state.enqueue).not.toHaveBeenCalled();
    } finally {
      pending.resolve([]);
      await execution;
      for (const controller of controllers) controller.stop();
    }
  });

  it("keeps the real execution unfinished while its active-user lookup is pending", async () => {
    const pending = deferred<string[]>();
    state.list.mockReturnValueOnce(pending.promise);
    const { default: cron } = await import("node-cron");
    const { startSchedulers } = await import("../src/scheduler/cron.js");
    const controllers = startSchedulers();
    const task = [...cron.getTasks().values()].find(candidate => candidate.getPattern() === "*/2 * * * *")!;
    const execution = task.execute();
    let finished = false;
    void execution.then(() => { finished = true; });
    try {
      await flush();
      expect(state.list).toHaveBeenCalledTimes(1);
      expect(finished).toBe(false);
      pending.resolve(["user-1"]);
      await execution;
      expect(state.enqueue).toHaveBeenCalledTimes(1);
      expect(finished).toBe(true);
    } finally {
      pending.resolve([]);
      await execution;
      for (const controller of controllers) controller.stop();
    }
  });

  it("removes every retired timer from the actual node-cron registry", async () => {
    const { default: cron } = await import("node-cron");
    const { startSchedulers } = await import("../src/scheduler/cron.js");
    const controllers = startSchedulers();
    const tasks = [...cron.getTasks().values()];
    expect(tasks).toHaveLength(17);
    for (const controller of controllers) controller.stop();
    await flush();
    expect(cron.getTasks().size).toBe(0);
    expect(tasks.every(task => task.getStatus() === "destroyed")).toBe(true);
  });
});
