import { enqueueAgentCycle } from "../queue/queues.js";
import type { AgentType, ToolDefinition } from "../engine/types.js";
import { defineTool, enumSchema, objectSchema, stringSchema } from "./validation.js";

const VALID_AGENT_TYPES: AgentType[] = ["email", "compta", "legal", "partner"];
// Quatre agents cœur distincts : au maximum trois sauts sans revisiter un nœud.
export const MAX_DELEGATION_DEPTH = 3;

interface DelegationTrace {
  depth: number;
  lineage: AgentType[];
}

/**
 * Collaboration inter-agents (cf brief Phase 1) : un agent peut déléguer une tâche à un autre
 * (ex: Partenariat trouve un deal → délègue le contrat au Juridique → qui délègue la facture au Comptable).
 * La délégation passe par la queue (pas d'appel direct) pour garder la même autonomie/logging/kill-switch
 * que n'importe quel autre déclenchement.
 */
export const delegateToAgentTool: ToolDefinition<{ targetAgent: AgentType; reason: string }, { queued: true }> = defineTool({
  name: "delegate_to_agent",
  description: "Délègue une tâche à un autre agent cœur (email, compta, legal, partner) — ex: transmettre un contrat au juridique.",
  sensitive: false,
  input: objectSchema({ targetAgent: enumSchema(["email", "compta", "legal", "partner"]), reason: stringSchema({ maxLength: 10_000, pattern: "\\S" }) }),
  async execute(params, ctx) {
    if (!VALID_AGENT_TYPES.includes(params.targetAgent)) {
      throw new Error(`Agent cible invalide: ${params.targetAgent}`);
    }
    if (params.targetAgent === ctx.agentType) {
      throw new Error("Auto-délégation interdite");
    }

    const trace = readDelegationTrace(ctx.trigger?.payload, ctx.agentType);
    if (trace.depth >= MAX_DELEGATION_DEPTH) {
      throw new Error(`Profondeur maximale de délégation atteinte (${MAX_DELEGATION_DEPTH})`);
    }
    if (trace.lineage.includes(params.targetAgent)) {
      throw new Error(`Cycle de délégation interdit vers ${params.targetAgent}`);
    }

    await enqueueAgentCycle({
      agentType: params.targetAgent,
      userId: ctx.userId,
      trigger: {
        type: "delegation",
        source: ctx.agentType,
        payload: {
          reason: params.reason,
          kartaDelegation: {
            depth: trace.depth + 1,
            lineage: [...trace.lineage, params.targetAgent],
          },
        },
      },
    });
    return { queued: true };
  },
});

function readDelegationTrace(payload: Record<string, unknown> | undefined, currentAgent: AgentType): DelegationTrace {
  const raw = payload?.kartaDelegation;
  if (raw === undefined) return { depth: 0, lineage: [currentAgent] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Trace de délégation invalide");
  }
  const trace = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(trace.depth) || (trace.depth as number) < 0 || (trace.depth as number) > MAX_DELEGATION_DEPTH) {
    throw new Error("Profondeur de délégation invalide");
  }
  if (!Array.isArray(trace.lineage) || trace.lineage.length === 0 || trace.lineage.length > MAX_DELEGATION_DEPTH + 1 ||
      !trace.lineage.every((agent) => typeof agent === "string" && VALID_AGENT_TYPES.includes(agent as AgentType))) {
    throw new Error("Lignée de délégation invalide");
  }
  const lineage = trace.lineage as AgentType[];
  if (lineage.at(-1) !== currentAgent || new Set(lineage).size !== lineage.length || lineage.length !== (trace.depth as number) + 1) {
    throw new Error("Lignée de délégation incohérente");
  }
  return { depth: trace.depth as number, lineage };
}
