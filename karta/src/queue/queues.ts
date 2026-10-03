import { Queue } from "bullmq";
import { createHash } from "node:crypto";
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
  await agentCycleQueue.add(`${data.agentType}:${data.userId}`, data, {
    // BullMQ simple-mode: une seule copie de la même intention peut être active/en attente.
    // La clé est supprimée à la finalisation, donc les futurs cron restent autorisés.
    deduplication: { id: stableDeduplicationId(data) },
  });
}

export function stableDeduplicationId(data: AgentCycleJobData): string {
  return createHash("sha256").update(stableJson(data)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
