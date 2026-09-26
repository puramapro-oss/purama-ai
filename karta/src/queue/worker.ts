import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { releaseCycleLock, tryAcquireCycleLock } from "./queues.js";
import { runAgentCycle } from "../engine/loop.js";
import { resolveAgentDefinition } from "../engine/resolveDefinition.js";
import { reconcileStaleRuns } from "../engine/logger.js";
import { reconcileOrphanPendingActions } from "../engine/approval.js";
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

/**
 * Traite UN job de cycle : verrou anti-double → résolution → runAgentCycle → libération.
 * Exportée (et pas une closure du Worker) pour être testée unitairement sans instancier BullMQ.
 *
 * Skip silencieux assumé si le verrou est tenu : le doublon (overlap cron, cron+manual,
 * délégation) n'a RIEN à faire — pas de karta_runs (rien ne s'est passé), juste un log. Le
 * cycle légitime en cours porte déjà la vérité.
 */
export async function processAgentCycleJob(data: AgentCycleJobData): Promise<AgentRunResult> {
  if (!(await tryAcquireCycleLock(data.agentType, data.userId))) {
    console.warn(`[worker] cycle ${data.agentType}:${data.userId} (${data.trigger.type}/${data.trigger.source}) SKIPPÉ — un cycle est déjà en cours pour cet agent et cet utilisateur`);
    return {
      status: "success",
      decision: "Cycle ignoré : un cycle est déjà en cours pour cet agent",
      toolsUsed: [],
      resultSummary: "skipped — verrou de cycle détenu par un autre run",
      mock: false,
      sideEffectsCommitted: false,
    };
  }

  try {
    const definition = await resolveAgentDefinition(data.agentType);
    const result = await runAgentCycle(data.userId, definition, data.trigger);
    if (result.status === "error") {
      if (shouldRetryCycle(result)) {
        // Erreur transitoire potentielle (réseau, DB) AVANT tout side-effect → rejeu sûr.
        throw new Error(result.errorMessage ?? "échec inconnu du cycle agent");
      }
      // Side-effects déjà tentés : ne JAMAIS rejouer (anti-double-exécution), cf shouldRetryCycle.
      console.error(
        `[worker] cycle ${data.agentType}:${data.userId} : échec APRÈS side-effects réels — pas de rejeu, cycle laissé en erreur journalisée`
      );
    }
    return result;
  } finally {
    // Libéré même sur throw (rejeu BullMQ après backoff → re-acquisition possible) et même si
    // runAgentCycle a crashé avant son propre catch.
    await releaseCycleLock(data.agentType, data.userId);
  }
}

export function startAgentCycleWorker(): Worker<AgentCycleJobData> {
  // Réconciliation au démarrage du composant qui possède les cycles "running" (et pas au boot
  // du process entier) : tout process qui démarre un worker réconcilie ses runs orphelins —
  // fire-and-forget, non fatale (cf logger.reconcileStaleRuns). Idem pour les actions restées
  // "processing" par un crash entre claim atomique et finalisation (cf approval.ts).
  void reconcileStaleRuns().catch((err: unknown) => console.error("[worker] reconcileStaleRuns a échoué :", err));
  void reconcileOrphanPendingActions().catch((err: unknown) =>
    console.error("[worker] reconcileOrphanPendingActions a échoué :", err)
  );

  const worker = new Worker<AgentCycleJobData>(
    "karta-agent-cycle",
    async (job: Job<AgentCycleJobData>) => processAgentCycleJob(job.data),
    { connection: redisConnection, concurrency: 5 }
  );

  worker.on("failed", (job, err) => {
    console.error(`[worker] job ${job?.id} (${job?.name}) échoué après ${job?.attemptsMade} tentative(s): ${err.message}`);
  });

  return worker;
}
