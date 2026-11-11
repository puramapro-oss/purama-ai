import { config } from "./config.js";
import { validateRuntimeConfig } from "./runtime/config.js";
import { createRuntime } from "./runtime/lifecycle.js";

async function main(): Promise<void> {
  validateRuntimeConfig(config);
  const [api, workers, cron, custom, outbox, queues, redis, probe] = await Promise.all([
    import("./api/server.js"), import("./queue/worker.js"), import("./scheduler/cron.js"),
    import("./scheduler/customAgents.js"), import("./queue/approval-outbox.js"),
    import("./queue/queues.js"), import("./queue/redis.js"), import("./runtime/probe.js"),
  ]);
  redis.redisConnection.on("error", () => console.error("[karta] Redis temporairement indisponible"));
  queues.agentCycleQueue.on("error", () => console.error("[karta] file temporairement indisponible"));
  const runtime = createRuntime({
    probe: probe.probeRuntime,
    startHttp: api.startApiServer,
    startWorker: () => {
      const worker = workers.startAgentCycleWorker();
      worker.on("error", () => console.error("[karta] worker temporairement indisponible"));
      return worker;
    },
    startSchedulers: cron.startSchedulers,
    startCustomScheduler: custom.startCustomAgentScheduler,
    startRelay: outbox.startApprovalOutboxRelay,
    closeQueue: () => queues.agentCycleQueue.close(),
    disconnect: () => {
      void queues.agentCycleQueue.disconnect().catch(() => undefined);
      redis.redisConnection.disconnect();
    },
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.stop().then(clean => process.exit(clean ? 0 : 1));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  try {
    await runtime.start();
    console.log(`[karta] prêt — mockClaude=${config.mockClaude} port=${config.port}`);
  } catch {
    if (shuttingDown) return;
    throw new Error("KARTA startup unavailable");
  }
}

void main().catch(() => {
  console.error("[karta] démarrage refusé : configuration ou dépendances indisponibles");
  process.exit(1);
});
