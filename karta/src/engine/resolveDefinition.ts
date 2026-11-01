import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent, buildCustomAgentDefinition } from "../agents/customAgent.js";
import type { AgentDefinition, AgentType, StaticAgentType } from "./types.js";

/**
 * Résout un AgentType (statique ou `custom:<id>`) en AgentDefinition exécutable — utilisé par le
 * worker (cycle planifié) ET par le flux d'approbation (reprise d'une action après validation
 * humaine), pour ne jamais dupliquer la logique de branchement statique/dynamique.
 */
export async function resolveAgentDefinition(agentType: AgentType, userId: string): Promise<AgentDefinition> {
  if (agentType.startsWith("custom:")) {
    const agentId = agentType.slice("custom:".length);
    const row = await loadCustomAgent(agentId);
    if (!row) throw new Error(`Agent créé introuvable: ${agentId}`);
    if (!userId || row.user_id !== userId) throw new Error("Agent créé non autorisé pour cet utilisateur");
    if (row.is_active !== true || row.karta_enabled !== true) {
      throw new Error("Agent créé désactivé ou exécution KARTA désactivée");
    }
    return buildCustomAgentDefinition(row);
  }
  return AGENT_REGISTRY[agentType as StaticAgentType];
}
