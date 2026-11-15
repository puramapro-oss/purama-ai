import { config } from "./config.js";
import { KartaRuntime, runRuntime } from "./runtime.js";
import type { Worker } from "bullmq";

console.log(`[karta] démarrage — mockClaude=${config.mockClaude} port=${config.port}`);
let worker: Worker | undefined;

// Eager Redis/Queue modules load after signal handlers are installed. Each handle
// is owned before importing the next component, so import failures also roll back.
const runtime = new KartaRuntime({
  shutdownTimeoutMs: config.shutdownTimeoutMs,
  readinessTimeoutMs: config.readinessTimeoutMs,
  async redis() {
    const { redisConnection } = await import("./queue/redis.js");
    redisConnection.on("error", (error) => console.error("[redis] error:", error));
    return { close: () => redisConnection.quit() };
  },
  async queue() {
    const { agentCycleQueue } = await import("./queue/queues.js");
    agentCycleQueue.on("error", (error) => console.error("[queue] error:", error));
    return { ready: agentCycleQueue.waitUntilReady(), close: () => agentCycleQueue.close() };
  },
  async worker() {
    const { startAgentCycleWorker } = await import("./queue/worker.js");
    const owned = startAgentCycleWorker();
    worker = owned;
    owned.on("error", (error) => console.error("[worker] error:", error));
    return {
      ready: owned.waitUntilReady(),
      async close() {
        // BullMQ emits cleanup failures but can still resolve close successfully.
        const errors: Error[] = [];
        const capture = (error: Error) => { errors.push(error); };
        owned.on("error", capture);
        try {
          await owned.close();
          if (errors.length) throw new AggregateError(errors, "KARTA worker cleanup failed");
        } finally {
          owned.off("error", capture);
        }
      },
    };
  },
  async api(owner) {
    const { startApiServer } = await import("./api/server.js");
    return startApiServer(owner);
  },
  async schedulers() {
    const { startSchedulers } = await import("./scheduler/cron.js");
    return startSchedulers();
  },
  async customSchedulers() {
    const { startCustomAgentScheduler } = await import("./scheduler/customAgents.js");
    return startCustomAgentScheduler();
  },
  async probe() {
    const [{ redisConnection }, { agentCycleQueue }, { supabase }] = await Promise.all([
      import("./queue/redis.js"), import("./queue/queues.js"), import("./db/supabase.js"),
    ]);
    if (redisConnection.status !== "ready" || agentCycleQueue.closing || !worker?.isRunning() || worker.closing) {
      throw new Error("KARTA worker/Redis/queue unavailable");
    }
    const [client, blockingClient] = await Promise.all([worker.client, worker.waitUntilReady()]);
    if (client.status !== "ready" || blockingClient.status !== "ready") {
      throw new Error("KARTA worker connection unavailable");
    }
    const [pong, { data, error }] = await Promise.all([
      redisConnection.ping(),
      supabase.from("karta_global_state").select("kill_switch").eq("id", "global").single(),
    ]);
    if (pong !== "PONG" || error || typeof data?.kill_switch !== "boolean") {
      throw new Error("KARTA dependency probe failed");
    }
    return data.kill_switch;
  },
});

runRuntime(runtime, process);
