import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { runAgentCycle } from "../engine/loop.js";
import { resolveAgentDefinition } from "../engine/resolveDefinition.js";
import { reconcileStaleRuns } from "../engine/logger.js";
import type { AgentCycleJobData } from "./queues.js";
import type { AgentRunResult } from "../engine/types.js";

/**
 * Un cycle en erreur ne doit être rejoué par BullMQ (attempts:3, cf queues.ts) QUE s'il n'a
 * tenté AUCUNE exécution réelle d'outil : un rejeu après side-effects déjà tentés (email parti,
 * ligne insérée...) doublerait l'action dans le monde réel. Le cycle est déjà journalisé
 * "error" dans karta_runs — on le laisse tel quel, la main revient à l'humain ou au cron suivant.
 */
export function shouldRetryCycle(result: AgentRunResult): boolean {
  return result.status === "error" && !result.sideEffectsCommitted;
}

export function startAgentCycleWorker(): Worker<AgentCycleJobData> {
  // Réconciliation au démarrage du composant qui possède les cycles "running" (et pas au boot
  // du process entier) : tout process qui démarre un worker réconcilie ses runs orphelins —
  // fire-and-forget, non fatale (cf logger.reconcileStaleRuns).
  void reconcileStaleRuns().catch((err: unknown) => console.error("[worker] reconcileStaleRuns a échoué :", err));

  const worker = new Worker<AgentCycleJobData>(
    "karta-agent-cycle",
    async (job: Job<AgentCycleJobData>) => {
      const definition = await resolveAgentDefinition(job.data.agentType);
      const result = await runAgentCycle(job.data.userId, definition, job.data.trigger);
      if (result.status === "error") {
        if (shouldRetryCycle(result)) {
          // Erreur transitoire potentielle (réseau, DB) AVANT tout side-effect → rejeu sûr.
          throw new Error(result.errorMessage ?? "échec inconnu du cycle agent");
        }
        // Side-effects déjà tentés : ne JAMAIS rejouer (anti-double-exécution), cf shouldRetryCycle.
        console.error(
          `[worker] job ${job.id} (${job.data.agentType}) : échec APRÈS side-effects réels — pas de rejeu, cycle laissé en erreur journalisée`
        );
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
