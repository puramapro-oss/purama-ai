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
 * Anti-double-exécution à la SOURCE : un verrou Redis par (agentType, userId), acquis au
 * PROCESSING du job (pas à l'enqueue — un job en attente pendant un backlog ne doit pas être
 * rejeté pour un lock zombie expiré). Sans lui, 3 doublons réels étaient possibles :
 * overlap cron (cycle plus lent que la cadence — ex: répondeur 5min avec decide qui prend 2min),
 * cron + déclenchement manuel simultanés, délégation pendant le cycle planifié. Le worker tourne
 * en concurrency 5 : les 2 cycles tournaient vraiment en parallèle.
 *
 * Acquêteur = processor (worker.ts), libéré dans son finally ; TTL = borne de secours si le
 * process meurt avant la libération (cycle max ~120s decide + 30s/outil → 600s confortable).
 */
const CYCLE_LOCK_TTL_S = 600;

function cycleLockKey(agentType: AgentType, userId: string): string {
  return `karta:cycle-lock:${agentType}:${userId}`;
}

/** SET NX EX atomique — true si le verrou vient d'être acquis, false s'il est déjà tenu. */
export async function tryAcquireCycleLock(agentType: AgentType, userId: string): Promise<boolean> {
  const result = await redisConnection.set(cycleLockKey(agentType, userId), "1", "EX", CYCLE_LOCK_TTL_S, "NX");
  return result === "OK";
}

/** Libère le verrou. Non fatale : en cas d'échec Redis, le TTL (600s) borne la panne. */
export async function releaseCycleLock(agentType: AgentType, userId: string): Promise<void> {
  try {
    await redisConnection.del(cycleLockKey(agentType, userId));
  } catch (err) {
    console.error(`[queue] releaseCycleLock(${agentType}:${userId}) a échoué — TTL de secours actif :`, err);
  }
}
