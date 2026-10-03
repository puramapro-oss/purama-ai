import { config } from "./config.js";
import { startApiServer } from "./api/server.js";
import { startAgentCycleWorker } from "./queue/worker.js";
import { startSchedulers } from "./scheduler/cron.js";
import { startCustomAgentScheduler } from "./scheduler/customAgents.js";
import { agentCycleQueue } from "./queue/queues.js";
import { redisConnection } from "./queue/redis.js";
import { setRuntimeReady, shutdownRuntime, verifyStartupDependencies } from "./runtime.js";

async function main(): Promise<void> {
  console.log(`[karta] démarrage — aiProvider=${config.aiProvider} port=${config.port}`);
  await verifyStartupDependencies();

  const server = await startApiServer();
  const worker = startAgentCycleWorker();
  const schedulers = startSchedulers();
  const customAgentScheduler = startCustomAgentScheduler();
  setRuntimeReady(true);
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: string): void => {
    if (shutdownPromise) return;
    console.log(`[karta] arrêt (${signal})`);
    shutdownPromise = shutdownRuntime({
      server,
      worker,
      queue: agentCycleQueue,
      redis: redisConnection,
      schedulers: [...schedulers, customAgentScheduler],
    });
    void shutdownPromise.then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("[karta] arrêt incomplet:", error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

void main().catch(async (error: unknown) => {
  setRuntimeReady(false);
  console.error("[karta] démarrage refusé:", error instanceof Error ? error.message : String(error));
  await Promise.allSettled([agentCycleQueue.close(), redisConnection.quit()]);
  process.exit(1);
});
