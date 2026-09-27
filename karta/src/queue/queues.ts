import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import type { AgentTrigger, AgentType } from "../engine/types.js";

export interface AgentCycleJobData {
  agentType: AgentType;
  userId: string;
  trigger: AgentTrigger;
}

export const agentCycleQueue = new Queue<AgentCycleJobData>("karta-agent-cycle", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

export async function enqueueAgentCycle(data: AgentCycleJobData): Promise<void> {
  await agentCycleQueue.add(`${data.agentType}:${data.userId}`, data);
}

/**
 * Anti-double-exécution à la SOURCE : verrou Redis par (agentType, userId), acquis au
 * PROCESSING du job (pas à l'enqueue — un job en attente pendant un backlog ne doit pas être
 * rejeté pour un lock zombie expiré). Sans lui, 3 doublons réels étaient possibles :
 * overlap cron (cycle plus lent que la cadence — ex: répondeur 5min avec decide qui prend 2min),
 * cron + déclenchement manuel simultanés, délégation pendant le cycle planifié. Le worker tourne
 * en concurrency 5 : les 2 cycles tournaient vraiment en parallèle.
 *
 * Depuis le sous-lot 9, le mécanisme vit intégralement dans queue/cycle-lock.ts (importé
 * directement par worker.ts — testable sans construire la Queue) et est durci d'un
 * owner-token : le release ne détruit le verrou que s'il appartient ENCORE au handle
 * (compare-and-del Lua) — un cycle dépassant le TTL ne peut plus libérer le verrou d'un
 * successeur.
 */
