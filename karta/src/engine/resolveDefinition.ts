import { AGENT_REGISTRY } from "../agents/index.js";
import { loadCustomAgent, buildCustomAgentDefinition, type CustomAgentRow } from "../agents/customAgent.js";
import type { AgentDefinition, AgentType, StaticAgentType } from "./types.js";

/** A confirmed refusal is terminal for the old job; a failed read is not. */
export class CustomAgentAuthorizationError extends Error {
  constructor() {
    super("Agent personnalisé indisponible ou non autorisé pour cette exécution");
    this.name = "CustomAgentAuthorizationError";
  }
}

/**
 * Résout un AgentType (statique ou `custom:<id>`) en AgentDefinition exécutable — utilisé par le
 * worker (cycle planifié) ET par le flux d'approbation (reprise d'une action après validation
 * humaine), pour ne jamais dupliquer la logique de branchement statique/dynamique.
 */
export async function resolveAgentDefinition(agentType: AgentType, userId: string): Promise<AgentDefinition> {
  if (agentType.startsWith("custom:")) {
    if (!userId) throw new CustomAgentAuthorizationError();
    const agentId = agentType.slice("custom:".length);
    let row: CustomAgentRow | null;
    try {
      row = await loadCustomAgent(agentId);
    } catch {
      // Provider errors may contain private data. No effect has started, so a
      // worker may retry this temporary failure without treating it as consent.
      throw new Error("Vérification de l’agent temporairement indisponible");
    }
    if (!row || row.user_id !== userId || row.is_active !== true || row.karta_enabled !== true) {
      throw new CustomAgentAuthorizationError();
    }
    return buildCustomAgentDefinition(row);
  }
  return AGENT_REGISTRY[agentType as StaticAgentType];
}
