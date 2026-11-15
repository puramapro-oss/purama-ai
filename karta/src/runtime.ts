export interface RuntimeResource {
  ready?: Promise<unknown>;
  close(): Promise<unknown>;
}

export interface RuntimeProducer {
  ready?: Promise<unknown>;
  stop(): void;
  drain(): Promise<unknown>;
}

export interface RuntimeApi extends RuntimeProducer {
  ready: Promise<unknown>;
}

export interface RuntimeDependencies {
  redis(): Promise<RuntimeResource>;
  queue(): Promise<RuntimeResource>;
  worker(): Promise<RuntimeResource>;
  api(runtime: KartaRuntime): Promise<RuntimeApi>;
  schedulers(): Promise<RuntimeProducer>;
  customSchedulers(): Promise<RuntimeProducer>;
  probe(): Promise<boolean>; // uncached DB kill switch + Redis/queue/worker availability
  shutdownTimeoutMs: number;
  readinessTimeoutMs: number;
}

export type RuntimeState = "starting" | "ready" | "stopping" | "stopped" | "failed";

class StartupCancelled extends Error {}

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("KARTA lifecycle timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Owns resources before awaiting readiness, including during partial startup. */
export class KartaRuntime {
  state: RuntimeState = "starting";
  private redis?: RuntimeResource;
  private queue?: RuntimeResource;
  private worker?: RuntimeResource;
  private api?: RuntimeApi;
  private producers: RuntimeProducer[] = [];
  private acquisition?: Promise<void>;
  private startup?: Promise<void>;
  private shutdown?: Promise<number>;
  private failed = false;
  private complete!: (status: number) => void;
  readonly finished = new Promise<number>((resolve) => { this.complete = resolve; });

  constructor(private readonly dependencies: RuntimeDependencies) {}

  start(): Promise<void> {
    if (this.startup) return this.startup;
    if (this.state !== "starting") return Promise.reject(new Error("KARTA already stopped"));
    this.acquisition = this.acquire();
    this.startup = this.acquisition.catch(async (error: unknown) => {
      if (!(error instanceof StartupCancelled)) this.failed = true;
      await this.stop(this.failed ? 1 : 0);
      throw error;
    });
    return this.startup;
  }

  private checkStarting(): void {
    if (this.state !== "starting") throw new StartupCancelled("KARTA startup cancelled");
  }

  private async acquire(): Promise<void> {
    this.redis = await this.dependencies.redis();
    void this.redis.ready?.catch(() => {});
    this.checkStarting();
    this.queue = await this.dependencies.queue();
    void this.queue.ready?.catch(() => {});
    this.checkStarting();
    this.worker = await this.dependencies.worker();
    void this.worker.ready?.catch(() => {});
    this.checkStarting();
    this.api = await this.dependencies.api(this);
    this.checkStarting();
    await bounded(Promise.all([this.redis.ready, this.queue.ready, this.worker.ready, this.api.ready]),
      this.dependencies.readinessTimeoutMs);
    this.checkStarting();
    this.producers.push(await this.dependencies.schedulers());
    this.checkStarting();
    this.producers.push(await this.dependencies.customSchedulers());
    this.checkStarting();
    await bounded(Promise.all(this.producers.map((producer) => producer.ready)),
      this.dependencies.readinessTimeoutMs);
    this.checkStarting();
    await bounded(this.dependencies.probe(), this.dependencies.readinessTimeoutMs);
    this.checkStarting();
    this.state = "ready";
  }

  async health(): Promise<{ ready: boolean; globalKillSwitch?: boolean }> {
    if (this.state !== "ready") return { ready: false };
    try {
      const globalKillSwitch = await bounded(this.dependencies.probe(), this.dependencies.readinessTimeoutMs);
      // A signal can arrive while the dependency probe is awaited.
      return this.state === "ready" ? { ready: true, globalKillSwitch } : { ready: false };
    } catch {
      return { ready: false };
    }
  }

  stop(exitCode = 0): Promise<number> {
    if (exitCode !== 0) this.failed = true;
    if (this.shutdown) return this.shutdown;
    this.state = "stopping"; // synchronous readiness/admission barrier
    this.stopProducers();
    this.shutdown = bounded(this.drain(), this.dependencies.shutdownTimeoutMs)
      .catch((error: unknown) => {
        this.failed = true;
        console.error("[runtime] shutdown failed:", error);
      })
      .then(() => {
        this.state = this.failed ? "failed" : "stopped";
        const status = this.failed ? 1 : 0;
        this.complete(status);
        return status;
      });
    return this.shutdown;
  }

  private stopProducers(): void {
    for (const producer of [...this.producers, ...(this.api ? [this.api] : [])]) {
      try { producer.stop(); } catch (error) {
        this.failed = true;
        console.error("[runtime] producer stop failed:", error);
      }
    }
  }

  private async drain(): Promise<void> {
    // An acquisition already in flight must hand over its handle before rollback.
    await this.acquisition?.catch(() => {});
    this.stopProducers();
    const drains = await Promise.allSettled([
      ...this.producers.map((producer) => Promise.resolve().then(() => producer.drain())),
      ...(this.api ? [Promise.resolve().then(() => this.api!.drain())] : []),
    ]);
    // Never close dependencies beneath callbacks whose settlement is unknown.
    if (drains.some((result) => result.status === "rejected")) {
      throw new Error("KARTA producer/HTTP drain failed");
    }
    await this.worker?.close(); // BullMQ close waits for active jobs, including side effects
    await this.queue?.close();
    await this.redis?.close();
  }
}

/** Registers signals before acquisition and emits exactly one terminal exit status. */
export function runRuntime(runtime: KartaRuntime, host: {
  on(signal: "SIGTERM" | "SIGINT", listener: () => void): unknown;
  exit(code: number): unknown;
}): void {
  void runtime.finished.then((status) => host.exit(status));
  host.on("SIGTERM", () => { void runtime.stop(); });
  host.on("SIGINT", () => { void runtime.stop(); });
  void runtime.start().catch((error: unknown) => {
    console.error("[runtime] startup failed:", error);
    void runtime.stop(runtime.state === "stopped" ? 0 : 1);
  });
}
