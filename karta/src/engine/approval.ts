import { supabase } from "../db/supabase.js";
import { resolveAgentDefinition } from "./resolveDefinition.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { isRunnable, loadAgentState } from "./autonomy.js";
import { assertToolResult } from "./tool-result.js";
import type { AgentType } from "./types.js";

interface CreatePendingActionInput {
  userId: string; runId: string; agentType: AgentType; toolName: string; toolParams: Record<string, unknown>;
}

export async function createPendingAction(input: CreatePendingActionInput): Promise<string> {
  const { data, error } = await supabase.from("karta_pending_actions").insert({
    user_id: input.userId, run_id: input.runId, agent_type: input.agentType, tool_name: input.toolName, tool_params: input.toolParams,
  }).select("id").single();
  if (error) throw new Error(`createPendingAction(${input.toolName}): ${error.message}`);
  return data.id as string;
}

interface PendingActionRow {
  id: string; user_id: string; run_id: string; agent_type: string; tool_name: string; tool_params: Record<string, unknown>; status: string;
}
export type ResolveDecision = "approve" | "reject";
export type ResolveResult = { ok: true; resultSummary: string } | { ok: false; error: string };
type FinalStatus = "executed" | "failed" | "rejected" | "cancelled";

export async function resolvePendingAction(id: string, decision: ResolveDecision): Promise<ResolveResult> {
  if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Décision invalide" };
  // Durable compare-and-set in PostgreSQL, before any external effect. Missing
  // migration, duplicate request or uncertain prior attempt all fail closed.
  const claimed = await supabase.rpc("karta_claim_pending_action", { p_id: id, p_decision: decision });
  if (claimed.error) return { ok: false, error: "Action indisponible : vérifier l'état du cycle et les autorisations" };
  const pending = (Array.isArray(claimed.data) ? claimed.data[0] : claimed.data) as PendingActionRow | undefined;
  if (!pending) return { ok: false, error: "Action déjà traitée ou en cours : vérifier son résultat avant de la répéter" };

  let status: FinalStatus = decision === "reject" ? "rejected" : "failed";
  let resultSummary = "Rejetée par l'utilisateur : aucune action effectuée";
  if (decision === "approve") {
    try {
      const state = await loadAgentState(pending.user_id, pending.agent_type as AgentType);
      if (await isGlobalKillSwitchActive(true) || !isRunnable(state).ok || state.simulationMode) {
        status = "cancelled";
        resultSummary = "Action annulée : arrêt ou autorisation modifiée";
      } else {
        const definition = await resolveAgentDefinition(pending.agent_type as AgentType);
        const tool = definition.tools.find(t => t.name === pending.tool_name);
        if (!tool) throw new Error("Outil introuvable pour cet agent");
        // Recheck after definition loading, immediately before dispatch.
        const latest = await loadAgentState(pending.user_id, pending.agent_type as AgentType);
        if (await isGlobalKillSwitchActive(true) || !isRunnable(latest).ok || latest.simulationMode) {
          status = "cancelled";
          resultSummary = "Action annulée : arrêt ou autorisation modifiée";
        } else {
          const result = await tool.execute(pending.tool_params, {
            userId: pending.user_id, agentType: pending.agent_type as AgentType, mode: "live", operationId: pending.id,
          });
          assertToolResult(result);
          status = "executed";
          resultSummary = summarize(result);
        }
      }
    } catch (error) {
      status = "failed";
      resultSummary = error instanceof Error ? error.message : "Échec de l'outil";
    }
  }
  try {
    await finalizePendingAction(pending, status, resultSummary);
  } catch {
    // The durable executing claim remains: never reset it to pending. The action
    // may already exist at the provider, so a retry must only reconcile evidence.
    return { ok: false, error: "Résultat non confirmé dans le journal : vérifier l'action avant toute reprise" };
  }
  return status === "executed" || status === "rejected"
    ? { ok: true, resultSummary }
    : { ok: false, error: resultSummary };
}

async function finalizePendingAction(pending: PendingActionRow, status: FinalStatus, resultSummary: string): Promise<void> {
  // Resolving the action and patching the parent's JSON happen in one transaction.
  const { error } = await supabase.rpc("karta_finalize_pending_action", {
    p_id: pending.id, p_status: status, p_summary: resultSummary.slice(0, 500),
  });
  if (error) throw new Error("Finalisation indisponible");
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result.slice(0, 200);
  try { return JSON.stringify(result).slice(0, 200); } catch { return "Résultat non sérialisable"; }
}
