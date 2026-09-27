import { createHash } from "node:crypto";
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

export interface EnqueueAgentCycleOptions {
  /**
   * Stable business identity for deliveries that must not be queued twice.
   * It is hashed because BullMQ custom job ids must not contain its separator characters.
   */
  dedupeKey?: string;
}

function jobIdFromDedupeKey(key: string): string {
  return `karta-${createHash("sha256").update(key).digest("hex")}`;
}

export async function enqueueAgentCycle(
  data: AgentCycleJobData,
  options: EnqueueAgentCycleOptions = {}
): Promise<string | undefined> {
  const jobId = options.dedupeKey ? jobIdFromDedupeKey(options.dedupeKey) : undefined;
  const job = await agentCycleQueue.add(
    `${data.agentType}:${data.userId}`,
    data,
    jobId ? { jobId } : undefined
  );
  return job.id;
}
