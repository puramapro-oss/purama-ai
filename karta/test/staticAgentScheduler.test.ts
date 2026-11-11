import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskContext } from "node-cron";

interface Timer {
  expression: string;
  callback: (context: TaskContext) => unknown;
  stop: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted(() => ({
  tasks: [] as Timer[],
  list: vi.fn(),
  enqueue: vi.fn(),
  report: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: {
    validate: vi.fn(() => true),
    schedule: vi.fn((expression: string, callback: Timer["callback"]) => {
      const task = { expression, callback, stop: vi.fn(), destroy: vi.fn() };
      state.tasks.push(task);
      return task;
    }),
  },
}));
vi.mock("../src/agents/index.js", () => ({ listActiveUserIds: state.list }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: state.enqueue }));
vi.mock("../src/scheduler/dailyReport.js", () => ({ runDailyReport: state.report }));

const instant = "2026-11-10T12:00:00.000Z";
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const load = () => import("../src/scheduler/cron.js");
const context = (date = instant): TaskContext => ({
  date: new Date(date), dateLocalIso: date, triggeredAt: new Date(),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(instant));
  state.tasks.length = 0;
  state.list.mockReset().mockResolvedValue(["user-1"]);
  state.enqueue.mockReset().mockResolvedValue("job-test");
  state.report.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("static-agent scheduler lifecycle", () => {
  it("preserves all sixteen cadences and the current minute delivery identity", async () => {
    const { startSchedulers } = await load();
    const controllers = startSchedulers();
    expect(controllers).toHaveLength(17);
    expect(state.tasks).toHaveLength(17);
    state.tasks[0].callback(context());
    await flush();
    expect(state.enqueue).toHaveBeenCalledWith({
      agentType: "email", userId: "user-1",
      trigger: { type: "cron", source: "Email Agent — Fetch & Process", payload: { slot: "2026-11-10T12:00" } },
    }, { dedupeKey: "cron|email|user-1|2026-11-10T12:00" });
    for (const controller of controllers) controller.stop();
  });

  it("keeps the scheduled slot when the active-user lookup finishes in another minute", async () => {
    const pending = deferred<string[]>();
    state.list.mockReturnValueOnce(pending.promise);
    const { startSchedulers } = await load();
    const controllers = startSchedulers();
    state.tasks[0].callback(context());
    vi.setSystemTime(new Date("2026-11-10T12:01:05.000Z"));
    pending.resolve(["user-1"]);
    await flush();
    expect(state.enqueue.mock.calls[0]?.[1]?.dedupeKey).toBe("cron|email|user-1|2026-11-10T12:00");
    for (const controller of controllers) controller.stop();
  });

  it("does not enqueue when a pending user lookup resolves after stop", async () => {
    const pending = deferred<string[]>();
    state.list.mockReturnValueOnce(pending.promise);
    const { startSchedulers } = await load();
    const controllers = startSchedulers();
    state.tasks[0].callback(context());
    await flush();
    expect(state.list).toHaveBeenCalledTimes(1);
    controllers[0].stop();
    pending.resolve(["user-1"]);
    await flush();
    expect(state.enqueue).not.toHaveBeenCalled();
    for (const controller of controllers) controller.stop();
  });

  it("does not start a second enqueue when stop occurs during the first", async () => {
    const pending = deferred<string>();
    state.list.mockResolvedValueOnce(["user-1", "user-2"]);
    state.enqueue.mockReturnValueOnce(pending.promise);
    const { startSchedulers } = await load();
    const controllers = startSchedulers();
    state.tasks[0].callback(context());
    await flush();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    controllers[0].stop();
    pending.resolve("job-1");
    await flush();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    for (const controller of controllers) controller.stop();
  });

  it("ignores a timer callback that had already been dispatched before destroy", async () => {
    const { startSchedulers } = await load();
    const controllers = startSchedulers();
    const retiredCallback = state.tasks[0].callback;
    controllers[0].destroy();
    retiredCallback(context());
    await flush();
    expect(state.list).not.toHaveBeenCalled();
    expect(state.enqueue).not.toHaveBeenCalled();
    for (const controller of controllers) controller.stop();
  });

  it("keeps provider error details out of the scheduler log and allows the next tick", async () => {
    state.list.mockRejectedValueOnce(new Error("PRIVATE_DATABASE_DETAIL"));
    const { startSchedulers } = await load();
    const controllers = startSchedulers();
    state.tasks[0].callback(context());
    await flush();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("PRIVATE_DATABASE_DETAIL");
    state.tasks[0].callback(context("2026-11-10T12:02:00.000Z"));
    await flush();
    expect(state.enqueue).toHaveBeenCalledTimes(1);
    for (const controller of controllers) controller.stop();
  });
});
