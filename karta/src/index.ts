import { config } from "./config.js";
import { startApiServer } from "./api/server.js";
import { startAgentCycleWorker } from "./queue/worker.js";
import { startSchedulers } from "./scheduler/cron.js";
import { startCustomAgentScheduler } from "./scheduler/customAgents.js";

console.log(`[karta] démarrage — mockClaude=${config.mockClaude} port=${config.port}`);

const worker = startAgentCycleWorker();
const schedulers = startSchedulers();
const customAgentScheduler = startCustomAgentScheduler();
const server = startApiServer();

function shutdown(signal: string): void {
  console.log(`[karta] arrêt (${signal})`);
  for (const task of schedulers) task.stop();
  customAgentScheduler.stop();
  server.close();
  void worker.close().finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
