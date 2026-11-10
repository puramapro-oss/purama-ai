import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";
import { createCycleDelivery, CycleDeliveryConflictError, resolveCycleDelivery, type CycleDeliveryMetadata } from "./delivery-identity.js";
import { assertCycleDeliveryCompatible } from "./delivery-guard.js";
import type { AgentTrigger, AgentType } from "../engine/types.js";

export interface AgentCycleJobData {
  agentType: AgentType;
  userId: string;
  trigger: AgentTrigger;
  /** Internal queue identity, generated from a copied request by enqueueAgentCycle. */
  delivery?: CycleDeliveryMetadata;
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

export interface EnqueueAgentCycleOptions {
  /**
   * Stable business identity for deliveries that must not be queued twice.
   * It is hashed because BullMQ custom job ids must not contain its separator characters.
   */
  dedupeKey?: string;
}

export async function enqueueAgentCycle(
  data: AgentCycleJobData,
  options: EnqueueAgentCycleOptions = {}
): Promise<string | undefined> {
  const delivery = createCycleDelivery(data, options.dedupeKey);
  await assertCycleDeliveryCompatible(delivery.data, delivery.identity);
  try {
    const job = await agentCycleQueue.add(
      `${delivery.data.agentType}:${delivery.data.userId}`,
      delivery.data,
      { jobId: delivery.jobId }
    );
    if (job.id !== delivery.jobId) throw new Error();
    if (delivery.identity.kind === "dedupe") {
      // add(existing jobId) can return a Job populated with the attempted data,
      // although Redis retains the first payload. Read the actual stored job.
      const retained = await agentCycleQueue.getJob(delivery.jobId);
      if (!retained) throw new Error();
      const retainedIdentity = resolveCycleDelivery(retained);
      if (retainedIdentity.executionKey !== delivery.identity.executionKey
        || retainedIdentity.fingerprint !== delivery.identity.fingerprint) throw new CycleDeliveryConflictError();
      // A previous job can finish and be removed between the preflight and
      // add(). Do not acknowledge its known result for a changed request.
      await assertCycleDeliveryCompatible(delivery.data, delivery.identity);
    }
    return job.id;
  } catch (error) {
    if (error instanceof CycleDeliveryConflictError) throw error;
    throw new Error("Mise en file non confirmée : vérifier la demande avant toute reprise");
  }
}
