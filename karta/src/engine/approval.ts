import { supabase } from "../db/supabase.js";
import { resolveAgentDefinition } from "./resolveDefinition.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { isRunnable, loadAgentState } from "./autonomy.js";
import { assertToolResult } from "./tool-result.js";
import { validateToolParams } from "./tool-input.js";
import { shouldMinimizeToolTrace, summarizeToolError, summarizeToolResult } from "./tool-trace.js";
import { enqueueAgentCycle } from "../queue/queues.js";
import { restoreAgentExecutionTrigger, snapshotAgentExecutionTrigger } from "./trigger-context.js";
import type { AgentTrigger, AgentType } from "./types.js";

interface CreatePendingActionInput {
  userId: string; runId: string; agentType: AgentType; toolName: string; toolParams: Record<string, unknown>;
  trigger?: AgentTrigger;
}

export async function createPendingAction(input: CreatePendingActionInput): Promise<string> {
  const executionTrigger = snapshotAgentExecutionTrigger(input.trigger, input.agentType);
  try {
    const { data, error } = await supabase.from("karta_pending_actions").insert({
      user_id: input.userId, run_id: input.runId, agent_type: input.agentType, tool_name: input.toolName, tool_params: input.toolParams,
      execution_trigger: executionTrigger ?? null,
    }).select("id").single();
    if (error || !data || typeof data.id !== "string") throw new Error();
    return data.id;
  } catch {
    throw new Error("Création de l’action indisponible : vérifier son état avant toute reprise");
  }
}

interface PendingActionRow {
  id: string; user_id: string; run_id: string; agent_type: string; tool_name: string; tool_params: Record<string, unknown>; status: string;
  execution_trigger?: unknown;
}
export type ResolveDecision = "approve" | "reject";
export type ResolveResult = { ok: true; resultSummary: string } | { ok: false; error: string };
type FinalStatus = "executed" | "failed" | "rejected" | "cancelled";

export async function resolvePendingAction(id: string, decision: ResolveDecision): Promise<ResolveResult> {
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Décision invalide" };
  // Durable compare-and-set in PostgreSQL, before any external effect. Missing
  // migration, duplicate request or uncertain prior attempt all fail closed.
  let claimed: { data: unknown; error: unknown };
  try {
    claimed = await supabase.rpc("karta_claim_pending_action", { p_id: id, p_decision: decision });
  } catch {
    // A transport rejection gives no proof of whether the claim committed.
    // Report the same safe refusal and never dispatch or reset it to pending.
    return { ok: false, error: "Action indisponible : vérifier l'état du cycle et les autorisations" };
  }
  if (claimed.error) return { ok: false, error: "Action indisponible : vérifier l'état du cycle et les autorisations" };
  const pending = (Array.isArray(claimed.data) ? claimed.data[0] : claimed.data) as PendingActionRow | undefined;
  if (!pending) return { ok: false, error: "Action déjà traitée ou en cours : vérifier son résultat avant de la répéter" };

  let status: FinalStatus = decision === "reject" ? "rejected" : "failed";
  let resultSummary = "Rejetée par l'utilisateur : aucune action effectuée";
  // Definition/admission failures have no established safe trace policy.
  let privateTrace = true;
  if (decision === "approve") {
    try {
      const executionTrigger = restoreAgentExecutionTrigger(pending.execution_trigger, pending.agent_type as AgentType);
      const state = await loadAgentState(pending.user_id, pending.agent_type as AgentType);
      if (await isGlobalKillSwitchActive(true) || !isRunnable(state).ok || state.simulationMode) {
        status = "cancelled";
        resultSummary = "Action annulée : arrêt ou autorisation modifiée";
      } else {
        const definition = await resolveAgentDefinition(pending.agent_type as AgentType, pending.user_id);
        const tool = definition.tools.find(t => t.name === pending.tool_name);
        privateTrace = executionTrigger?.type === "delegation" || definition.tools.some(shouldMinimizeToolTrace) || shouldMinimizeToolTrace(tool) ||
          await parentRequiresPrivateTrace(pending, definition.tools);
        if (!tool) throw new Error("Outil introuvable pour cet agent");
        validateToolParams(tool, pending.tool_params);
        // Recheck after definition loading, immediately before dispatch.
        const latest = await loadAgentState(pending.user_id, pending.agent_type as AgentType);
        if (await isGlobalKillSwitchActive(true) || !isRunnable(latest).ok || latest.simulationMode) {
          status = "cancelled";
          resultSummary = "Action annulée : arrêt ou autorisation modifiée";
        } else {
          const result = await tool.execute(pending.tool_params, {
            userId: pending.user_id, agentType: pending.agent_type as AgentType, mode: "live", trigger: executionTrigger, operationId: pending.id,
          });
          assertToolResult(result);
          status = "executed";
          resultSummary = summarizeToolResult(result, privateTrace);
        }
      }
    } catch (error) {
      status = "failed";
      resultSummary = summarizeToolError(error, privateTrace, "Échec de l'outil");
    }
  }
  try {
    await finalizePendingAction(pending, status, resultSummary);
  } catch {
    // The durable executing claim remains: never reset it to pending. The action
    // may already exist at the provider, so a retry must only reconcile evidence.
    return { ok: false, error: "Résultat non confirmé dans le journal : vérifier l'action avant toute reprise" };
  }

  if (status === "executed" || status === "rejected") {
    try {
      await enqueueAgentCycle(
        {
          agentType: pending.agent_type as AgentType,
          userId: pending.user_id,
          trigger: {
            type: "delegation",
            source: "approval-resume",
            payload: { previousRunId: pending.run_id, pendingActionId: pending.id, resolution: status },
          },
        },
        { dedupeKey: `approval-resume|${pending.id}|${status}` }
      );
    } catch {
      return {
        ok: false,
        error: "Action traitée mais reprise du cycle non planifiée : relancer le cycle sans répéter l'action",
      };
    }
  }

  return status === "executed" || status === "rejected"
    ? { ok: true, resultSummary }
    : { ok: false, error: resultSummary };
}

/** Preserve the original cycle's privacy even if its tool definition changed.
 * An unreadable/ambiguous trace may reduce diagnostics, never privacy. */
async function parentRequiresPrivateTrace(pending: PendingActionRow, tools: readonly { name: string }[]): Promise<boolean> {
  try {
    const { data, error } = await supabase.from("karta_runs").select("tools_used")
      .eq("id", pending.run_id).eq("user_id", pending.user_id).eq("agent_type", pending.agent_type).single();
    if (error || !data || !Array.isArray(data.tools_used)) return true;
    let matchingAction = false;
    for (const entry of data.tools_used as unknown[]) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
      const record = entry as Record<string, unknown>;
      if (record.tracePolicy !== undefined || !tools.some(tool => tool.name === record.tool)) return true;
      if (record.pendingActionId === pending.id) {
        if (matchingAction || record.tool !== pending.tool_name) return true;
        matchingAction = true;
      }
    }
    return !matchingAction;
  } catch {
    return true;
  }
}

async function finalizePendingAction(pending: PendingActionRow, status: FinalStatus, resultSummary: string): Promise<void> {
  // Resolving the action and patching the parent's JSON happen in one transaction.
  const { error } = await supabase.rpc("karta_finalize_pending_action", {
    p_id: pending.id, p_status: status, p_summary: resultSummary.slice(0, 500),
  });
  if (error) throw new Error("Finalisation indisponible");
}
