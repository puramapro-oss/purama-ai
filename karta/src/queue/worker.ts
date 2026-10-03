import { UnrecoverableError, Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { runAgentCycle } from "../engine/loop.js";
import { resolveAgentDefinition } from "../engine/resolveDefinition.js";
import type { AgentCycleJobData } from "./queues.js";

export function startAgentCycleWorker(): Worker<AgentCycleJobData> {
  const worker = new Worker<AgentCycleJobData>(
    "karta-agent-cycle",
    async (job: Job<AgentCycleJobData>) => {
      const definition = await resolveAgentDefinition(job.data.agentType);
      let result;
      try {
        result = await runAgentCycle(job.data.userId, definition, job.data.trigger);
      } catch (error) {
        // Une exception sans bilan fiable peut survenir après un effet réel.
        throw new UnrecoverableError(error instanceof Error ? error.message : String(error));
      }
      if (result.status === "error") {
        const message = result.errorMessage ?? "échec inconnu du cycle agent";
        if (result.retrySafe === true) throw new Error(message);
        throw new UnrecoverableError(message);
      }
      return result;
    },
    // Une perte de verrou/crash peut suivre un effet : ne pas relancer les jobs ordinaires bloqués.
    { connection: redisConnection, concurrency: 5, maxStalledCount: 0 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} (${job?.name}) échoué après ${job?.attemptsMade} tentative(s): ${err.message}`);
  });

  return worker;
}
