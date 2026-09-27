import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent, buildCustomAgentDefinition } from "../agents/customAgent.js";
import type { AgentDefinition, AgentType, StaticAgentType } from "./types.js";

/**
 * Résout un AgentType en définition exécutable.
 * Pour un agent dynamique, l'owner attendu est vérifié avant toute exécution :
 * un job forgé ne peut pas faire tourner le prompt/outillage d'un autre utilisateur.
 */
export async function resolveAgentDefinition(agentType: AgentType, expectedUserId?: string): Promise<AgentDefinition> {
  if (agentType.startsWith("custom:")) {
    const agentId = agentType.slice("custom:".length);
    const row = await loadCustomAgent(agentId);
    if (!row) throw new Error(`Agent créé introuvable: ${agentId}`);
    if (!row.karta_enabled || !row.is_active) {
      throw new Error("Agent créé désactivé ou non autorisé pour KARTA");
    }
    if (expectedUserId && row.user_id !== expectedUserId) {
      throw new Error("Propriétaire de l'agent créé incompatible avec l'exécution");
    }
    return buildCustomAgentDefinition(row);
  }

  const definition = AGENT_REGISTRY[agentType as StaticAgentType];
  if (!definition) throw new Error(`Agent statique introuvable: ${agentType}`);
  return definition;
}
