import { Worker, type Job } from "bullmq";
import { redisConnection } from "./redis.js";
import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent, buildCustomAgentDefinition } from "../agents/customAgent.js";
import { runAgentCycle } from "../engine/loop.js";
import type { AgentCycleJobData } from "./queues.js";
import type { AgentDefinition, StaticAgentType } from "../engine/types.js";

async function resolveDefinition(agentType: AgentCycleJobData["agentType"]): Promise<AgentDefinition> {
  if (agentType.startsWith("custom:")) {
    const agentId = agentType.slice("custom:".length);
    const row = await loadCustomAgent(agentId);
    if (!row) throw new Error(`Agent créé introuvable: ${agentId}`);
    return buildCustomAgentDefinition(row);
  }
  return AGENT_REGISTRY[agentType as StaticAgentType];
}

export function startAgentCycleWorker(): Worker<AgentCycleJobData> {
  const worker = new Worker<AgentCycleJobData>(
    "karta-agent-cycle",
    async (job: Job<AgentCycleJobData>) => {
      const definition = await resolveDefinition(job.data.agentType);
      const result = await runAgentCycle(job.data.userId, definition, job.data.trigger);
      if (result.status === "error") {
        // BullMQ retry (attempts:3, cf queues.ts) — utile si l'erreur est transitoire (réseau, DB).
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
