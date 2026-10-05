import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent, buildCustomAgentDefinition } from "../agents/customAgent.js";
import type { AgentDefinition, AgentType, StaticAgentType } from "./types.js";

/**
 * Résout un AgentType (statique ou `custom:<id>`) en AgentDefinition exécutable — utilisé par le
 * worker (cycle planifié) ET par le flux d'approbation (reprise d'une action après validation
 * humaine), pour ne jamais dupliquer la logique de branchement statique/dynamique.
 *
 * Fail-closed : rejette statique inconnu, custom introuvable/malformé, disabled ou inactive.
 */
export async function resolveAgentDefinition(agentType: AgentType): Promise<AgentDefinition> {
  if (agentType.startsWith("custom:")) {
    const agentId = agentType.slice("custom:".length);
    const row = await loadCustomAgent(agentId);
    if (!row) throw new Error(`Agent créé introuvable: ${agentId}`);

    // Fail-closed : un agent custom disabled ou inactif ne doit JAMAIS s'exécuter
    if (!row.karta_enabled) throw new Error(`Agent créé désactivé pour KARTA: ${agentId}`);
    if (!row.is_active) throw new Error(`Agent créé inactif (désactivé par son propriétaire): ${agentId}`);

    return buildCustomAgentDefinition(row);
  }

  // Fail-closed : un AgentType statique inconnu doit échouer explicitement, jamais retourner undefined
  const definition = AGENT_REGISTRY[agentType as StaticAgentType];
  if (!definition) throw new Error(`Agent statique inconnu: ${agentType}`);

  return definition;
}
