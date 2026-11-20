import { afterEach, expect, it, vi } from "vitest";
import { bounded, createRuntime, type RuntimeDependencies } from "../src/runtime/lifecycle.js";

afterEach(() => { vi.restoreAllMocks(); });

function clock() {
  const value = { now: 0 };
  vi.spyOn(performance, "now").mockImplementation(() => value.now);
  return value;
}

it("preserves a result handed back before the monotonic deadline", async () => {
  const time = clock();
  await expect(bounded(async () => { time.now = 4; return "ready"; }, 5)).resolves.toBe("ready");
});

it.each([5, 6])("rejects a resolution at monotonic time %i before the timer runs", async elapsed => {
  const time = clock();
  await expect(bounded(async () => { time.now = elapsed; return "late"; }, 5))
    .rejects.toThrow("Runtime operation interrupted");
});

it("classifies a rejection after the deadline as interruption", async () => {
  const time = clock();
  await expect(bounded(async () => { time.now = 6; throw new Error("private transport detail"); }, 5))
    .rejects.toThrow("Runtime operation interrupted");
});

it("preserves the original rejection before the deadline", async () => {
  const time = clock();
  const failure = new Error("early failure");
  await expect(bounded(async () => { time.now = 4; throw failure; }, 5)).rejects.toBe(failure);
});

it("rejects parent cancellation during the final Promise handoff", async () => {
  const parent = new AbortController();
  await expect(bounded(() => Promise.resolve().then(() => {
    queueMicrotask(() => queueMicrotask(() => parent.abort()));
    return "stale";
  }), 1_000, parent.signal)).rejects.toThrow("Runtime operation interrupted");
});

it("never invokes an operation for an already cancelled parent", async () => {
  const parent = new AbortController(); parent.abort();
  const operation = vi.fn(async () => "must not run");
  await expect(bounded(operation, 1_000, parent.signal)).rejects.toThrow("Runtime operation interrupted");
  expect(operation).not.toHaveBeenCalled();
});

it("does not start a worker from a dependency probe completed after its budget", async () => {
  const time = clock();
  const deps: RuntimeDependencies = {
    probe: vi.fn(async () => { time.now = 6; return { globalKillSwitch: false }; }),
    startWorker: vi.fn(() => ({ waitUntilReady: async () => undefined, close: async () => undefined })),
    startHttp: vi.fn(() => { throw new Error("HTTP must not start"); }),
    startSchedulers: vi.fn(() => []), startCustomScheduler: vi.fn(() => ({ stop() {} })),
    startRelay: vi.fn(() => ({ stop() {} })), closeQueue: vi.fn(async () => undefined),
    disconnect: vi.fn(),
  };
  const runtime = createRuntime(deps, { probeMs: 5 });
  await expect(runtime.start()).rejects.toThrow("KARTA startup unavailable");
  expect(deps.startWorker).not.toHaveBeenCalled();
  expect(deps.startHttp).not.toHaveBeenCalled();
  expect(deps.disconnect).toHaveBeenCalledOnce();
  expect(await runtime.readiness()).toEqual({ ready: false, phase: "failed" });
});

it("reports an incomplete drain when the final queue closure finishes after its budget", async () => {
  const time = clock();
  const deps: RuntimeDependencies = {
    probe: vi.fn(async () => ({ globalKillSwitch: false })),
    startWorker: vi.fn(() => { throw new Error("not started"); }),
    startHttp: vi.fn(() => { throw new Error("not started"); }),
    startSchedulers: vi.fn(() => []), startCustomScheduler: vi.fn(() => ({ stop() {} })),
    startRelay: vi.fn(() => ({ stop() {} })),
    closeQueue: vi.fn(async () => { time.now = 6; }), disconnect: vi.fn(),
  };
  const runtime = createRuntime(deps, { shutdownMs: 5 });
  expect(await runtime.stop()).toBe(false);
  expect(deps.closeQueue).toHaveBeenCalledOnce();
  expect(deps.disconnect).toHaveBeenCalledOnce();
  expect(await runtime.readiness()).toEqual({ ready: false, phase: "failed" });
});
