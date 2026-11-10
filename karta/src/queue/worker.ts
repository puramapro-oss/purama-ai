import { Worker, UnrecoverableError, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { runAgentCycle } from "../engine/loop.js";
import { CustomAgentAuthorizationError, resolveAgentDefinition } from "../engine/resolveDefinition.js";
import type { AgentDefinition } from "../engine/types.js";
import type { AgentCycleJobData } from "./queues.js";

export function startAgentCycleWorker(): Worker<AgentCycleJobData> {
  const worker = new Worker<AgentCycleJobData>(
    "karta-agent-cycle",
    async (job: Job<AgentCycleJobData>) => {
      let definition: AgentDefinition;
      try {
        definition = await resolveAgentDefinition(job.data.agentType, job.data.userId);
      } catch (error) {
        if (error instanceof CustomAgentAuthorizationError) {
          throw new UnrecoverableError("Agent non autorisé pour cette exécution");
        }
        // Keep transient pre-execution failures retryable without logging
        // provider content in the worker's failed event.
        throw new Error("Vérification de l’agent temporairement indisponible");
      }
      const result = await runAgentCycle(job.data.userId, definition, job.data.trigger, `queue:${job.id}:${job.timestamp}`);
      if (result.status === "error") {
        if (result.retryable !== true) throw new UnrecoverableError(result.errorMessage ?? "Résultat à vérifier avant reprise");
        throw new Error(result.errorMessage ?? "échec inconnu du cycle agent");
      }
      return result;
    },
    { connection: redisConnection, concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} (${job?.name}) échoué après ${job?.attemptsMade} tentative(s): ${err.message}`);
  });

  return worker;
}
