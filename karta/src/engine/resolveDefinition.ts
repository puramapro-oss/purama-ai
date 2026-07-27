import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent, buildCustomAgentDefinition } from "../agents/customAgent.js";
import type { AgentDefinition, AgentType, StaticAgentType } from "./types.js";

/**
 * Résout un AgentType (statique ou `custom:<id>`) en AgentDefinition exécutable — utilisé par le
 * worker (cycle planifié) ET par le flux d'approbation (reprise d'une action après validation
 * humaine), pour ne jamais dupliquer la logique de branchement statique/dynamique.
 */
export async function resolveAgentDefinition(agentType: AgentType): Promise<AgentDefinition> {
  if (agentType.startsWith("custom:")) {
    const agentId = agentType.slice("custom:".length);
    const row = await loadCustomAgent(agentId);
    if (!row) throw new Error(`Agent créé introuvable: ${agentId}`);
    return buildCustomAgentDefinition(row);
  }
  return AGENT_REGISTRY[agentType as StaticAgentType];
}
