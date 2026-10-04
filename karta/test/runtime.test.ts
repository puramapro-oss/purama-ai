import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Worker } from "bullmq";
import { KartaRuntime, runRuntime, type RuntimeDependencies } from "../src/runtime.js";

// Exercise the real entry-point wiring without opening Redis, HTTP or DB handles.
const wiring = vi.hoisted(() => ({
  redis: { status: "ready", on: vi.fn(), ping: vi.fn(async () => "PONG"), quit: vi.fn(async () => "OK") },
  queue: { closing: false, on: vi.fn(), waitUntilReady: vi.fn(async () => {}), close: vi.fn(async () => {}) },
  blockingClient: { status: "ready" },
  worker: { closing: false, on: vi.fn(), off: vi.fn(), waitUntilReady: vi.fn(async () => ({ status: "ready" })), close: vi.fn(async () => {}),
    isRunning: vi.fn(() => true), client: Promise.resolve({ status: "ready" }) },
  single: vi.fn(async () => ({ data: { kill_switch: false }, error: null })),
  api: vi.fn(), core: vi.fn(), custom: vi.fn(),
}));
vi.mock("../src/config.js", () => ({ config: { shutdownTimeoutMs: 100, readinessTimeoutMs: 50 } }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: wiring.redis }));
vi.mock("../src/queue/queues.js", () => ({ agentCycleQueue: wiring.queue }));
vi.mock("../src/queue/worker.js", () => ({ startAgentCycleWorker: () => wiring.worker }));
vi.mock("../src/api/server.js", () => ({ startApiServer: wiring.api }));
vi.mock("../src/scheduler/cron.js", () => ({ startSchedulers: wiring.core }));
vi.mock("../src/scheduler/customAgents.js", () => ({ startCustomAgentScheduler: wiring.custom }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  from: () => ({ select: () => ({ eq: () => ({ single: wiring.single }) }) }),
} }));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const events: string[] = [];
  const resource = (name: string) => ({
    ready: Promise.resolve(),
    close: vi.fn(async () => { events.push(`${name}:close`); }),
  });
  const producer = (name: string) => ({
    ready: Promise.resolve(),
    stop: vi.fn(() => { events.push(`${name}:stop`); }),
    drain: vi.fn(async () => { events.push(`${name}:drain`); }),
  });
  const redis = resource("redis"), queue = resource("queue"), worker = resource("worker");
  const api = producer("api"), schedulers = producer("core"), custom = producer("custom");
  const dependencies = {
    redis: vi.fn(async () => redis), queue: vi.fn(async () => queue), worker: vi.fn(async () => worker),
    api: vi.fn(async () => api), schedulers: vi.fn(async () => schedulers), customSchedulers: vi.fn(async () => custom),
    probe: vi.fn(async () => false), shutdownTimeoutMs: 100, readinessTimeoutMs: 50,
  } satisfies RuntimeDependencies;
  return { dependencies, events, redis, queue, worker, api, schedulers, custom,
    runtime: new KartaRuntime(dependencies) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("KARTA runtime ownership", () => {
  it("is unavailable until startup and rechecks state after an awaited probe", async () => {
    const f = fixture();
    expect(await f.runtime.health()).toEqual({ ready: false });
    await f.runtime.start();
    expect(await f.runtime.health()).toEqual({ ready: true, globalKillSwitch: false });
    const probe = deferred<boolean>();
    f.dependencies.probe.mockReturnValueOnce(probe.promise);
    const health = f.runtime.health();
    const stopped = f.runtime.stop();
    probe.resolve(false);
    expect(await health).toEqual({ ready: false });
    expect(await stopped).toBe(0);
  });

  it("fails readiness on dependency error or a hanging probe", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.runtime.start();
    f.dependencies.probe.mockRejectedValueOnce(new Error("DB unavailable"));
    expect(await f.runtime.health()).toEqual({ ready: false });
    f.dependencies.probe.mockReturnValueOnce(new Promise(() => {}));
    const health = f.runtime.health();
    await vi.advanceTimersByTimeAsync(50);
    expect(await health).toEqual({ ready: false });
    await f.runtime.stop();
  });

  it.each(["redis", "queue", "worker", "api", "schedulers", "customSchedulers", "probe"] as const)("rolls back every acquired resource if %s acquisition fails", async (stage) => {
    const f = fixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    f.dependencies[stage].mockRejectedValueOnce(new Error(stage));
    await expect(f.runtime.start()).rejects.toThrow(stage);
    const order = ["redis", "queue", "worker", "api", "schedulers", "customSchedulers", "probe"];
    const acquired = order.indexOf(stage);
    expect(f.redis.close).toHaveBeenCalledTimes(acquired > 0 ? 1 : 0);
    expect(f.queue.close).toHaveBeenCalledTimes(acquired > 1 ? 1 : 0);
    expect(f.worker.close).toHaveBeenCalledTimes(acquired > 2 ? 1 : 0);
    expect(f.api.drain).toHaveBeenCalledTimes(acquired > 3 ? 1 : 0);
    expect(f.schedulers.drain).toHaveBeenCalledTimes(acquired > 4 ? 1 : 0);
    expect(f.custom.drain).toHaveBeenCalledTimes(acquired > 5 ? 1 : 0);
    expect(await f.runtime.stop()).toBe(1);
    expect(f.runtime.state).toBe("failed");
    error.mockRestore();
  });

  it.each(["redis", "queue", "worker", "api", "custom"] as const)("owns %s even when its readiness rejects", async (stage) => {
    const f = fixture();
    f[stage].ready = Promise.reject(new Error(`${stage}:ready`));
    void f[stage].ready.catch(() => {});
    await expect(f.runtime.start()).rejects.toThrow(`${stage}:ready`);
    expect(f.redis.close).toHaveBeenCalledOnce();
    expect(f.queue.close).toHaveBeenCalledOnce();
    expect(f.worker.close).toHaveBeenCalledOnce();
    if (stage === "custom") expect(f.custom.stop).toHaveBeenCalled();
  });

  it("stops producers immediately, then drains callbacks and HTTP before worker/queue/Redis", async () => {
    const f = fixture();
    await f.runtime.start();
    const http = deferred(), callbacks = deferred(), job = deferred();
    f.api.drain.mockImplementation(async () => { await http.promise; f.events.push("http:done"); });
    f.custom.drain.mockImplementation(async () => { await callbacks.promise; f.events.push("callbacks:done"); });
    f.worker.close.mockImplementation(async () => { await job.promise; f.events.push("worker:close"); });
    const stopped = f.runtime.stop();
    expect(f.runtime.state).toBe("stopping");
    expect(f.api.stop).toHaveBeenCalled();
    expect(f.schedulers.stop).toHaveBeenCalled();
    expect(f.custom.stop).toHaveBeenCalled();
    await Promise.resolve();
    expect(f.worker.close).not.toHaveBeenCalled();
    http.resolve(); callbacks.resolve();
    await vi.waitFor(() => expect(f.worker.close).toHaveBeenCalledOnce());
    expect(f.queue.close).not.toHaveBeenCalled();
    expect(f.redis.close).not.toHaveBeenCalled();
    job.resolve();
    expect(await stopped).toBe(0);
    expect(f.events.indexOf("queue:close")).toBeGreaterThan(f.events.indexOf("worker:close"));
    expect(f.events.indexOf("redis:close")).toBeGreaterThan(f.events.indexOf("queue:close"));
  });

  it("owns a late acquisition when shutdown races startup", async () => {
    const f = fixture();
    const acquisition = deferred<typeof f.worker>();
    f.dependencies.worker.mockReturnValueOnce(acquisition.promise);
    const started = f.runtime.start();
    void started.catch(() => {});
    await vi.waitFor(() => expect(f.dependencies.worker).toHaveBeenCalledOnce());
    const stopped = f.runtime.stop();
    expect(f.queue.close).not.toHaveBeenCalled();
    acquisition.resolve(f.worker);
    await expect(started).rejects.toThrow("cancelled");
    expect(await stopped).toBe(0);
    expect(f.worker.close).toHaveBeenCalledOnce();
    expect(f.dependencies.api).not.toHaveBeenCalled();
  });

  it.each(["api", "worker", "queue", "redis"] as const)("reports a %s close rejection without closing dependencies beneath unknown work", async (stage) => {
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await f.runtime.start();
    if (stage === "api") f.api.drain.mockRejectedValueOnce(new Error("close"));
    else f[stage].close.mockRejectedValueOnce(new Error("close"));
    expect(await f.runtime.stop()).toBe(1);
    if (stage === "api") expect(f.worker.close).not.toHaveBeenCalled();
    if (stage === "api" || stage === "worker") expect(f.queue.close).not.toHaveBeenCalled();
    if (stage !== "redis") expect(f.redis.close).not.toHaveBeenCalled();
  });

  it("a real acquisition failure racing a signal still exits with status 1", async () => {
    const f = fixture();
    const acquisition = deferred<typeof f.worker>();
    f.dependencies.worker.mockReturnValueOnce(acquisition.promise);
    const started = f.runtime.start();
    void started.catch(() => {});
    await vi.waitFor(() => expect(f.dependencies.worker).toHaveBeenCalledOnce());
    const stopped = f.runtime.stop();
    acquisition.reject(new Error("worker import failed"));
    await expect(started).rejects.toThrow("worker import failed");
    expect(await stopped).toBe(1);
    expect(f.queue.close).toHaveBeenCalledOnce();
    expect(f.redis.close).toHaveBeenCalledOnce();
  });

  it.each(["custom", "api", "worker", "queue", "redis"] as const)("uses one deadline for a hanging %s drain and repeated signals", async (stage) => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    const listeners = new Map<string, () => void>();
    const host = { on: (signal: string, listener: () => void) => listeners.set(signal, listener), exit: vi.fn() };
    runRuntime(f.runtime, host);
    await f.runtime.start();
    if (stage === "custom" || stage === "api") f[stage].drain.mockReturnValue(new Promise(() => {}));
    else f[stage].close.mockReturnValue(new Promise(() => {}));
    listeners.get("SIGTERM")!(); listeners.get("SIGINT")!(); listeners.get("SIGTERM")!();
    await vi.advanceTimersByTimeAsync(99);
    expect(host.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(host.exit).toHaveBeenCalledOnce();
    expect(host.exit).toHaveBeenCalledWith(1);
    expect(f.runtime.stop()).toBe(f.runtime.stop());
    if (stage === "custom" || stage === "api" || stage === "worker") {
      expect(f.queue.close).not.toHaveBeenCalled();
    }
  });

  it("a startup failure exits once with status 1", async () => {
    const f = fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    f.dependencies.schedulers.mockRejectedValueOnce(new Error("cron"));
    const host = { on: vi.fn(), exit: vi.fn() };
    runRuntime(f.runtime, host);
    await vi.waitFor(() => expect(host.exit).toHaveBeenCalledOnce());
    expect(host.exit).toHaveBeenCalledWith(1);
    expect(f.worker.close).toHaveBeenCalledOnce();
  });

  async function startEntryPoint() {
    vi.resetModules();
    vi.clearAllMocks();
    wiring.worker.on.mockReset();
    wiring.worker.off.mockReset();
    wiring.worker.close.mockReset().mockResolvedValue(undefined);
    wiring.blockingClient.status = "ready";
    wiring.worker.waitUntilReady.mockReset().mockImplementation(async () => wiring.blockingClient);
    const producer = { ready: Promise.resolve(), stop: vi.fn(), drain: vi.fn(async () => {}) };
    wiring.api.mockReturnValue(producer);
    wiring.core.mockReturnValue(producer);
    wiring.custom.mockReturnValue(producer);
    const listeners = new Map<string, () => void>();
    const originalOn = process.on;
    vi.spyOn(process, "on").mockImplementation(function (event, listener) {
      if (event === "SIGTERM" || event === "SIGINT") {
        listeners.set(event, listener as () => void);
        return process;
      }
      return originalOn.call(process, event, listener);
    });
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await import("../src/index.js");
    await vi.waitFor(() => expect(wiring.api).toHaveBeenCalledOnce());
    const runtime = wiring.api.mock.calls[0][0] as KartaRuntime;
    await runtime.start();
    return { runtime, listeners, exit };
  }

  it("entry point owns the existing handles and probes uncached DB, Redis and worker state", async () => {
    const { runtime, listeners, exit } = await startEntryPoint();
    expect(wiring.single).toHaveBeenCalledOnce();
    expect(await runtime.health()).toEqual({ ready: true, globalKillSwitch: false });
    expect(wiring.single).toHaveBeenCalledTimes(2);
    wiring.worker.isRunning.mockReturnValueOnce(false);
    expect(await runtime.health()).toEqual({ ready: false });
    wiring.redis.ping.mockRejectedValueOnce(new Error("Redis lost"));
    expect(await runtime.health()).toEqual({ ready: false });
    // The ordinary worker client and shared Redis stay healthy independently.
    wiring.blockingClient.status = "reconnecting";
    expect(await runtime.health()).toEqual({ ready: false });
    wiring.blockingClient.status = "ready";
    expect(await runtime.health()).toEqual({ ready: true, globalKillSwitch: false });
    wiring.worker.waitUntilReady.mockRejectedValueOnce(new Error("blocking Redis lost"));
    expect(await runtime.health()).toEqual({ ready: false });
    wiring.worker.waitUntilReady.mockReturnValueOnce(new Promise(() => {}));
    expect(await runtime.health()).toEqual({ ready: false });
    listeners.get("SIGTERM")!(); listeners.get("SIGINT")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledOnce());
    expect(exit).toHaveBeenCalledWith(0);
    expect(wiring.worker.close).toHaveBeenCalledOnce();
    expect(wiring.queue.close).toHaveBeenCalledOnce();
    expect(wiring.redis.quit).toHaveBeenCalledOnce();
  });

  it.each(["jobs", "locks", "children", "blocking", "connection"] as const)(
    "fails shutdown when installed BullMQ emits a %s cleanup error while resolving close",
    async (stage) => {
      const { runtime, listeners, exit } = await startEntryPoint();
      vi.spyOn(console, "error").mockImplementation(() => {});
      const failure = new Error(`${stage} cleanup failed`);
      const cleanup = (name: string) => vi.fn(async () => {
        if (name === stage) throw failure;
      });
      // Execute the installed implementation, stubbing only owned resources.
      // No Worker constructor, Redis sockets, jobs, timers or providers are opened.
      const owned = Object.assign(new EventEmitter(), {
        name: "hermetic", opts: {}, id: "hermetic",
        trace: async (_kind: unknown, _operation: unknown, _queue: unknown, callback: () => Promise<void>) => callback(),
        whenCurrentJobsFinished: cleanup("jobs"),
        lockManager: { close: cleanup("locks") },
        childPool: { clean: cleanup("children") },
        blockingConnection: { close: cleanup("blocking") },
        connection: { close: cleanup("connection") },
        closed: false,
      });
      const emitted = vi.fn();
      owned.on("error", emitted);
      wiring.worker.on.mockImplementation((event, listener) => owned.on(event, listener));
      wiring.worker.off.mockImplementation((event, listener) => owned.off(event, listener));
      const closed = vi.fn(async () => { await Worker.prototype.close.call(owned as unknown as Worker); });
      wiring.worker.close.mockImplementation(closed);
      listeners.get("SIGTERM")!();
      listeners.get("SIGINT")!();
      expect(await runtime.stop()).toBe(1);
      expect(await runtime.finished).toBe(1);
      expect(runtime.state).toBe("failed");
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
      expect(closed).toHaveResolvedWith(undefined);
      expect(emitted).toHaveBeenCalledOnce();
      expect(emitted).toHaveBeenCalledWith(failure);
      expect(owned.closed).toBe(true);
      expect(owned.connection.close).toHaveBeenCalledOnce();
      expect(owned.listenerCount("error")).toBe(1);
      expect(wiring.queue.close).not.toHaveBeenCalled();
      expect(wiring.redis.quit).not.toHaveBeenCalled();
    },
  );
});
