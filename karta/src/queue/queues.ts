import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import type { AgentTrigger, AgentType } from "../engine/types.js";

export interface AgentCycleJobData {
  agentType: AgentType;
  userId: string;
  trigger: AgentTrigger;
}

export interface EnqueueAgentCycleOptions {
  /**
   * Identité métier stable. Deux appels avec la même clé produisent le même
   * jobId BullMQ et la même execution_key KARTA, même après nettoyage du job.
   */
  idempotencyKey?: string;
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

function jobIdForKey(key: string): string {
  return `idem-${createHash("sha256").update(key).digest("hex")}`;
}

export async function enqueueAgentCycle(
  data: AgentCycleJobData,
  options: EnqueueAgentCycleOptions = {}
): Promise<void> {
  const jobId = options.idempotencyKey ? jobIdForKey(options.idempotencyKey) : undefined;
  await agentCycleQueue.add(`${data.agentType}:${data.userId}`, data, jobId ? { jobId } : undefined);
}
