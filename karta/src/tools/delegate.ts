import { enqueueAgentCycle } from "../queue/queues.js";
import type { AgentType, ToolDefinition } from "../engine/types.js";

const VALID_AGENT_TYPES: AgentType[] = ["email", "compta", "legal", "partner"];

export const delegateToAgentTool: ToolDefinition<{ targetAgent: AgentType; reason: string }, { queued: true }> = {
  name: "delegate_to_agent",
  description: "Délègue une tâche à un autre agent cœur (email, compta, legal, partner) — ex: transmettre un contrat au juridique.",
  sensitive: false,
  async execute(params, ctx) {
    if (!VALID_AGENT_TYPES.includes(params.targetAgent)) {
      throw new Error(`Agent cible invalide: ${params.targetAgent}`);
    }
    await enqueueAgentCycle(
      {
        agentType: params.targetAgent,
        userId: ctx.userId,
        trigger: { type: "delegation", source: ctx.agentType, payload: { reason: params.reason } },
      },
      {
        idempotencyKey: ctx.operationId
          ? `delegate:${ctx.operationId}:${params.targetAgent}`
          : undefined,
      }
    );
    return { queued: true };
  },
};
