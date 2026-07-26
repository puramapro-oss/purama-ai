import { enqueueAgentCycle } from "../queue/queues.js";
import type { AgentType, ToolDefinition } from "../engine/types.js";

const VALID_AGENT_TYPES: AgentType[] = ["email", "compta", "legal", "partner"];

/**
 * Collaboration inter-agents (cf brief Phase 1) : un agent peut déléguer une tâche à un autre
 * (ex: Partenariat trouve un deal → délègue le contrat au Juridique → qui délègue la facture au Comptable).
 * La délégation passe par la queue (pas d'appel direct) pour garder la même autonomie/logging/kill-switch
 * que n'importe quel autre déclenchement.
 */
export const delegateToAgentTool: ToolDefinition<{ targetAgent: AgentType; reason: string }, { queued: true }> = {
  name: "delegate_to_agent",
  description: "Délègue une tâche à un autre agent cœur (email, compta, legal, partner) — ex: transmettre un contrat au juridique.",
  sensitive: false,
  async execute(params, ctx) {
    if (!VALID_AGENT_TYPES.includes(params.targetAgent)) {
      throw new Error(`Agent cible invalide: ${params.targetAgent}`);
    }
    await enqueueAgentCycle({
      agentType: params.targetAgent,
      userId: ctx.userId,
      trigger: { type: "delegation", source: ctx.agentType, payload: { reason: params.reason } },
    });
    return { queued: true };
  },
};
