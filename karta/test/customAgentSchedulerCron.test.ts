import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use the real node-cron implementation; only database and queue effects are inert.
const state = vi.hoisted(() => ({ list: vi.fn(), enqueue: vi.fn() }));
vi.mock("../src/agents/customAgent.js", () => ({ listKartaEnabledCustomAgents: state.list }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: state.enqueue }));

const agent = {
  id: "agent-cron-test", user_id: "user-test", name: "Timer test",
  schedule_enabled: true, schedule_cron: "0 0 1 1 *",
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  vi.resetModules();
  state.list.mockReset().mockResolvedValue([agent]);
  state.enqueue.mockReset().mockResolvedValue("job-test");
});
afterEach(async () => {
  const { default: cron } = await import("node-cron");
  for (const task of cron.getTasks().values()) await task.destroy();
});

describe("custom-agent scheduler with real node-cron", () => {
  it("removes the scan and agent timers from the real registry on stop", async () => {
    const { default: cron } = await import("node-cron");
    const { startCustomAgentScheduler } = await import("../src/scheduler/customAgents.js");
    expect(cron.getTasks().size).toBe(0);
    const controller = startCustomAgentScheduler();
    await flush();
    const tasks = [...cron.getTasks().values()];
    expect(tasks).toHaveLength(2);
    controller.stop();
    await flush();
    expect(cron.getTasks().size).toBe(0);
    expect(tasks.every(task => task.getStatus() === "destroyed")).toBe(true);
    expect(state.enqueue).not.toHaveBeenCalled();
  });

  it("destroys a retired real timer while keeping its replacement and the scan", async () => {
    const { default: cron } = await import("node-cron");
    const { startCustomAgentScheduler, refreshCustomAgentSchedules } = await import("../src/scheduler/customAgents.js");
    const controller = startCustomAgentScheduler();
    await flush();
    const previous = [...cron.getTasks().values()].find(task => task.getPattern() === agent.schedule_cron)!;
    state.list.mockResolvedValue([{ ...agent, schedule_cron: "0 0 2 1 *" }]);
    await refreshCustomAgentSchedules();
    expect(previous.getStatus()).toBe("destroyed");
    expect(cron.getTasks().size).toBe(2);
    controller.destroy();
    await flush();
    expect(cron.getTasks().size).toBe(0);
  });

  it("does not recreate real timers when a database scan completes after stop", async () => {
    let resolve!: (value: typeof agent[]) => void;
    state.list.mockReturnValue(new Promise<typeof agent[]>(done => { resolve = done; }));
    const { default: cron } = await import("node-cron");
    const { startCustomAgentScheduler } = await import("../src/scheduler/customAgents.js");
    const controller = startCustomAgentScheduler();
    expect(cron.getTasks().size).toBe(1);
    controller.stop();
    resolve([agent]);
    await flush();
    expect(cron.getTasks().size).toBe(0);
    expect(state.enqueue).not.toHaveBeenCalled();
  });
});
