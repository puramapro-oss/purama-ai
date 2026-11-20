import { afterEach, expect, it, vi } from "vitest";
import { createServer, request, type Server, type ServerResponse } from "node:http";
import { createRuntime, type RuntimeDependencies } from "../src/runtime/lifecycle.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: { probeMs?: number; shutdownMs?: number } = {}) {
  const worker = { waitUntilReady: vi.fn(async () => undefined), close: vi.fn(async (_force?: boolean) => undefined) };
  const cron = { stop: vi.fn(async () => undefined) };
  const custom = { stop: vi.fn(async () => undefined) };
  const relay = { stop: vi.fn(async (): Promise<void> => undefined) };
  let server: Server;
  let respond = (_req: unknown, res: ServerResponse) => { res.end("ok"); };
  const deps: RuntimeDependencies = {
    probe: vi.fn(async () => ({ globalKillSwitch: false })),
    startWorker: vi.fn(() => worker),
    startHttp: vi.fn(() => { server = createServer((req, res) => respond(req, res)).listen(0, "127.0.0.1"); return server; }),
    startSchedulers: vi.fn(() => [cron]), startCustomScheduler: vi.fn(() => custom), startRelay: vi.fn(() => relay),
    closeQueue: vi.fn(async () => undefined), disconnect: vi.fn(),
  };
  const runtime = createRuntime(deps, options);
  cleanups.push(() => runtime.stop());
  return { deps, worker, cron, custom, relay, runtime, server: () => server,
    respond: (handler: typeof respond) => { respond = handler; } };
}

it("does not start consumers or producers before the dependency probe succeeds", async () => {
  const f = fixture(); const ready = deferred<{ globalKillSwitch: boolean }>();
  vi.mocked(f.deps.probe).mockReturnValue(ready.promise);
  const starting = f.runtime.start();
  await Promise.resolve();
  expect(f.deps.startWorker).not.toHaveBeenCalled();
  expect(await f.runtime.readiness()).toEqual({ ready: false, phase: "starting" });
  ready.resolve({ globalKillSwitch: false }); await starting;
  expect(f.deps.startWorker).toHaveBeenCalledOnce(); expect(f.deps.startRelay).toHaveBeenCalledOnce();
});

it("fails closed before any execution if the schema/Redis probe rejects", async () => {
  const f = fixture(); vi.mocked(f.deps.probe).mockRejectedValue(new Error("PRIVATE_transport"));
  await expect(f.runtime.start()).rejects.toThrow("KARTA startup unavailable");
  expect(f.deps.startWorker).not.toHaveBeenCalled(); expect(f.deps.startHttp).not.toHaveBeenCalled();
  expect(f.deps.disconnect).toHaveBeenCalledOnce();
  expect(await f.runtime.readiness()).toEqual({ ready: false, phase: "failed" });
});

it("never starts late resources after a signal during an uncooperative startup probe", async () => {
  const f = fixture(); const ready = deferred<{ globalKillSwitch: boolean }>();
  vi.mocked(f.deps.probe).mockReturnValue(ready.promise);
  const starting = f.runtime.start(); const rejection = expect(starting).rejects.toThrow("startup unavailable");
  await Promise.resolve(); await f.runtime.stop();
  ready.resolve({ globalKillSwitch: false }); await rejection;
  expect(f.deps.startWorker).not.toHaveBeenCalled(); expect(f.deps.startRelay).not.toHaveBeenCalled();
});

it("drains a real in-flight HTTP response before closing the queue", async () => {
  const f = fixture(); const arrived = deferred<ServerResponse>();
  f.respond((_req, res) => { arrived.resolve(res); }); await f.runtime.start();
  const completed = new Promise<void>((resolve, reject) => {
    const req = request({ port: (f.server().address() as { port: number }).port, host: "127.0.0.1" }, res => {
      res.resume(); res.on("end", resolve);
    }); req.on("error", reject); req.end();
  });
  const response = await arrived.promise;
  const stopping = f.runtime.stop();
  expect(stopping).toBe(f.runtime.stop());
  await new Promise(resolve => setImmediate(resolve));
  expect(f.deps.closeQueue).not.toHaveBeenCalled();
  expect(await f.runtime.readiness()).toEqual({ ready: false, phase: "stopping" });
  response.end("finished"); await completed;
  expect(await stopping).toBe(true); expect(f.worker.close).toHaveBeenCalledWith();
  expect(f.deps.closeQueue).toHaveBeenCalledOnce(); expect(f.deps.disconnect).toHaveBeenCalledOnce();
});

it("waits for all scheduler/relay stops before closing the worker", async () => {
  const f = fixture(); const stopped = deferred<void>(); await f.runtime.start();
  f.relay.stop.mockReturnValue(stopped.promise);
  const stopping = f.runtime.stop(); await new Promise(resolve => setImmediate(resolve));
  expect(f.worker.close).not.toHaveBeenCalled(); stopped.resolve();
  expect(await stopping).toBe(true); expect(f.custom.stop).toHaveBeenCalledOnce();
});

it("returns failure and still closes the queue when worker shutdown rejects", async () => {
  const f = fixture(); await f.runtime.start(); f.worker.close.mockRejectedValue(new Error("PRIVATE_worker"));
  expect(await f.runtime.stop()).toBe(false); expect(f.deps.closeQueue).toHaveBeenCalledOnce();
  expect(f.deps.disconnect).toHaveBeenCalledOnce(); expect((await f.runtime.readiness()).phase).toBe("failed");
});

it("bounds an uncooperative drain and disconnects retained resources", async () => {
  const f = fixture({ shutdownMs: 20 }); await f.runtime.start();
  f.relay.stop.mockReturnValue(new Promise(() => undefined));
  expect(await f.runtime.stop()).toBe(false); expect(f.worker.close).toHaveBeenCalledWith(true);
  expect(f.deps.disconnect).toHaveBeenCalledOnce();
});

it("does not report ready on a dependency failure after startup, and recovers on the next probe", async () => {
  const f = fixture(); await f.runtime.start();
  vi.mocked(f.deps.probe).mockRejectedValueOnce(new Error("PRIVATE_database"));
  expect(await f.runtime.readiness()).toEqual({ ready: false, phase: "ready" });
  expect(await f.runtime.readiness()).toEqual({ ready: true, phase: "ready", globalKillSwitch: false });
});

it("coalesces concurrent health probes and bounds a stalled dependency", async () => {
  const f = fixture({ probeMs: 20 }); await f.runtime.start();
  vi.mocked(f.deps.probe).mockClear().mockReturnValue(new Promise(() => undefined));
  const results = await Promise.all([f.runtime.readiness(), f.runtime.readiness(), f.runtime.readiness()]);
  expect(results.every(result => !result.ready)).toBe(true); expect(f.deps.probe).toHaveBeenCalledOnce();
});

it("cleans up an already-created worker after HTTP bind failure", async () => {
  const f = fixture(); const occupied = createServer().listen(0, "127.0.0.1");
  await new Promise<void>(resolve => occupied.once("listening", resolve));
  vi.mocked(f.deps.startHttp).mockImplementation(() => createServer().listen((occupied.address() as { port: number }).port, "127.0.0.1"));
  try {
    await expect(f.runtime.start()).rejects.toThrow("startup unavailable");
    expect(f.worker.close).toHaveBeenCalled(); expect(f.deps.startRelay).not.toHaveBeenCalled();
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});
