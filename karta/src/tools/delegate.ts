import { enqueueAgentCycle } from "../queue/queues.js";
import { CORE_DELEGATION_AGENTS, MAX_DELEGATION_DEPTH, MAX_DELEGATION_REASON_LENGTH } from "../engine/execution-origin.js";
import type { AgentTrigger, AgentType, ToolDefinition } from "../engine/types.js";

const VALID_AGENT_TYPES = CORE_DELEGATION_AGENTS;
export { MAX_DELEGATION_DEPTH };

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
export const delegateToAgentTool: ToolDefinition<{ targetAgent: AgentType; reason: string }, { queued: true }> = {
  name: "delegate_to_agent",
  description: "Délègue une tâche à un autre agent cœur (email, compta, legal, partner) — ex: transmettre un contrat au juridique.",
  sensitive: false,
  tracePolicy: "metadata_only",
  inputSchema: {
    type: "object",
    properties: {
      targetAgent: { type: "string", enum: [...VALID_AGENT_TYPES] },
      reason: { type: "string", minLength: 1, maxLength: MAX_DELEGATION_REASON_LENGTH },
    },
    required: ["targetAgent", "reason"],
    additionalProperties: false,
  },
  async execute(params, ctx) {
    if (ctx.mode !== "live") throw new Error("Délégation réelle interdite en simulation");
    if (!VALID_AGENT_TYPES.includes(params.targetAgent)) {
      throw new Error(`Agent cible invalide: ${params.targetAgent}`);
    }
    if (!VALID_AGENT_TYPES.includes(ctx.agentType)) throw new Error("Agent source de délégation invalide");
    if (typeof params.reason !== "string" || !params.reason.trim() || params.reason.length > MAX_DELEGATION_REASON_LENGTH || params.reason.includes("\0")) {
      throw new Error("Motif de délégation invalide");
    }
    if (params.targetAgent === ctx.agentType) throw new Error("Auto-délégation interdite");
    const trace = readDelegationTrace(ctx.trigger, ctx.agentType);
    if (trace.depth >= MAX_DELEGATION_DEPTH) {
      throw new Error(`Profondeur maximale de délégation atteinte (${MAX_DELEGATION_DEPTH})`);
    }
    if (trace.lineage.includes(params.targetAgent)) {
      throw new Error(`Cycle de délégation interdit vers ${params.targetAgent}`);
    }
    await enqueueAgentCycle(
      {
        agentType: params.targetAgent,
        userId: ctx.userId,
        trigger: {
          type: "delegation",
          source: ctx.agentType,
          payload: {
            reason: params.reason.trim(),
            kartaDelegation: { depth: trace.depth + 1, lineage: [...trace.lineage, params.targetAgent] },
          },
        },
      },
      ctx.operationId
        ? { dedupeKey: `delegation|${ctx.operationId}|${params.targetAgent}|${ctx.userId}` }
        : undefined
    );
    return { queued: true };
  },
};

function readDelegationTrace(trigger: AgentTrigger | undefined, currentAgent: AgentType): DelegationTrace {
  // A legacy approval has no origin. It must not silently start a fresh chain.
  if (!trigger) throw new Error("Contexte de délégation absent : nouvelle mission explicite requise");
  const raw = trigger.payload?.kartaDelegation;
  if (raw === undefined) {
    if (trigger.type === "delegation") throw new Error("Trace de délégation absente : reprise à réconcilier");
    return { depth: 0, lineage: [currentAgent] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Trace de délégation invalide");
  const trace = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(trace.depth) || (trace.depth as number) < 0 || (trace.depth as number) > MAX_DELEGATION_DEPTH) {
    throw new Error("Profondeur de délégation invalide");
  }
  if (!Array.isArray(trace.lineage) || trace.lineage.length === 0 || trace.lineage.length > MAX_DELEGATION_DEPTH + 1 ||
      !trace.lineage.every(agent => typeof agent === "string" && VALID_AGENT_TYPES.includes(agent as AgentType))) {
    throw new Error("Lignée de délégation invalide");
  }
  const lineage = trace.lineage as AgentType[];
  if (lineage.at(-1) !== currentAgent || new Set(lineage).size !== lineage.length || lineage.length !== (trace.depth as number) + 1) {
    throw new Error("Lignée de délégation incohérente");
  }
  return { depth: trace.depth as number, lineage };
}
