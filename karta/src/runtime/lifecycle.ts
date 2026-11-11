import type { Server } from "node:http";

type Stopper = { stop(): void | Promise<void> };
type Worker = { waitUntilReady(): Promise<unknown>; close(force?: boolean): Promise<void> };
type Phase = "starting" | "ready" | "stopping" | "stopped" | "failed";
export interface RuntimeReadiness { ready: boolean; phase: Phase; globalKillSwitch?: boolean }
export interface RuntimeDependencies {
  probe(signal: AbortSignal): Promise<{ globalKillSwitch: boolean }>;
  startWorker(): Worker;
  startHttp(readiness: () => Promise<RuntimeReadiness>): Server;
  startSchedulers(): Stopper[];
  startCustomScheduler(): Stopper;
  startRelay(): Stopper;
  closeQueue(): Promise<void>;
  disconnect(): void;
}

/** The bound covers the whole operation, including transports ignoring abort. */
export async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, ms: number,
  parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const expiresAt = performance.now() + ms;
  const assertCurrent = () => {
    // Promise continuations can run after the budget or cancellation before the
    // timer/rejection wins the race. Recheck at admission and at final handoff.
    if (controller.signal.aborted || parent?.aborted || performance.now() >= expiresAt) {
      controller.abort();
      throw new Error("Runtime operation interrupted");
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    const result = await Promise.race([
      new Promise<never>((_, reject) => {
        cancel = () => { controller.abort(); reject(new Error("Runtime operation interrupted")); };
        if (parent?.aborted) { cancel(); return; }
        parent?.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(cancel, ms);
      }),
      Promise.resolve().then(() => {
        assertCurrent();
        return operation(controller.signal);
      }),
    ]);
    assertCurrent();
    return result;
  } catch (error) {
    assertCurrent();
    throw error;
  } finally {
    clearTimeout(timer);
    if (cancel) parent?.removeEventListener("abort", cancel);
    controller.abort();
  }
}

function listening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { server.off("listening", ready); server.off("error", failed); };
    const ready = () => { clean(); resolve(); };
    const failed = () => { clean(); reject(new Error("HTTP startup failed")); };
    server.once("listening", ready); server.once("error", failed);
  });
}

function drainHttp(server?: Server): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => server.close(error => {
    if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(new Error("HTTP shutdown failed"));
    else resolve();
  }));
}

/** One controller owns startup, ingress, producers, draining and forced cleanup. */
export function createRuntime(deps: RuntimeDependencies, options: { probeMs?: number; shutdownMs?: number } = {}) {
  const lifetime = new AbortController();
  const probeMs = options.probeMs ?? 5_000;
  let phase: Phase = "starting";
  let worker: Worker | undefined;
  let server: Server | undefined;
  const producers: Stopper[] = [];
  let started = false;
  let stopped: Promise<boolean> | undefined;
  let health: Promise<RuntimeReadiness> | undefined;

  async function readiness(): Promise<RuntimeReadiness> {
    if (phase !== "ready") return { ready: false, phase };
    if (!health) health = bounded(signal => deps.probe(signal), probeMs, lifetime.signal)
      .then(result => ({ ...result, ready: phase === "ready", phase }))
      .catch(() => ({ ready: false, phase }))
      .finally(() => { health = undefined; });
    return health;
  }

  function stop(): Promise<boolean> {
    if (stopped) return stopped;
    const startupFailed = phase === "failed";
    phase = "stopping";
    lifetime.abort();
    stopped = (async () => {
      let clean = !startupFailed;
      try {
        await bounded(async () => {
          // Close ingress immediately, but let already accepted requests finish.
          const results = await Promise.allSettled([
            drainHttp(server),
            ...producers.map(producer => Promise.resolve().then(() => producer.stop())),
          ]);
          if (results.some(result => result.status === "rejected")) clean = false;
          try { await worker?.close(); } catch { clean = false; }
          try { await deps.closeQueue(); } catch { clean = false; }
        }, options.shutdownMs ?? 30_000);
      } catch { clean = false; }
      finally {
        if (!clean) {
          try { server?.closeAllConnections(); } catch { /* continue cleanup */ }
          try { void worker?.close(true).catch(() => undefined); } catch { /* continue cleanup */ }
        }
        try { deps.disconnect(); } catch { clean = false; }
        phase = clean ? "stopped" : "failed";
      }
      return clean;
    })();
    return stopped;
  }

  async function start(): Promise<void> {
    if (started || phase !== "starting") throw new Error("Runtime already started or stopped");
    started = true;
    try {
      await bounded(signal => deps.probe(signal), probeMs, lifetime.signal);
      if (lifetime.signal.aborted) throw new Error();
      worker = deps.startWorker();
      await bounded(() => worker!.waitUntilReady(), probeMs, lifetime.signal);
      if (lifetime.signal.aborted) throw new Error();
      server = deps.startHttp(readiness);
      await bounded(() => listening(server!), probeMs, lifetime.signal);
      if (lifetime.signal.aborted) throw new Error();
      producers.push(...deps.startSchedulers());
      producers.push(deps.startCustomScheduler());
      producers.push(deps.startRelay());
      phase = "ready";
    } catch {
      if (!stopped) phase = "failed";
      await stop();
      throw new Error("KARTA startup unavailable");
    }
  }

  return { start, stop, readiness };
}
