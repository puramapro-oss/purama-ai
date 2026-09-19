import { supabase } from "../db/supabase.js";
import type { AgentTrigger, AgentType, ToolCallRecord, AgentRunResult } from "./types.js";

export interface RunLogHandle {
  runId: string;
  existingResult?: AgentRunResult;
  finish: (outcome: {
    status: AgentRunResult["status"];
    decision: string;
    toolsUsed: ToolCallRecord[];
    resultSummary: string;
    errorMessage?: string;
    mock: boolean;
  }) => Promise<void>;
}

/**
 * Ouvre une entrée immuable dans karta_runs (status "running"), retourne un handle
 * pour la clôturer. Aucune UPDATE de contenu métier après clôture — seul le statut/résultat
 * final est écrit une fois (pas de ré-écriture ultérieure), conformément à "logs immuables".
 */
export async function startRun(
  userId: string,
  agentType: AgentType,
  trigger: AgentTrigger,
  mode: "simulation" | "live",
  executionKey?: string
): Promise<RunLogHandle> {
  const startedAt = Date.now();

  const { data, error } = await supabase
    .from("karta_runs")
    .insert({
      user_id: userId,
      agent_type: agentType,
      trigger_type: trigger.type,
      trigger_source: trigger.source,
      mode,
      status: "running",
      ...(executionKey ? { execution_key: executionKey } : {}),
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505" && executionKey) {
      const prior = await supabase.from("karta_runs").select("*")
        .eq("execution_key", executionKey).eq("user_id", userId).eq("agent_type", agentType).single();
      if (prior.error || !prior.data) throw new Error("Impossible de vérifier l'exécution précédente");
      const row = prior.data;
      const known = ["success", "error", "awaiting_approval", "skipped", "cancelled", "simulated", "partial"].includes(row.status);
      return {
        runId: row.id,
        existingResult: {
          status: known ? row.status : "error",
          decision: row.decision ?? "",
          toolsUsed: Array.isArray(row.tools_used) ? row.tools_used : [],
          resultSummary: row.result_summary ?? "Exécution déjà réservée : vérifier son résultat avant toute reprise",
          errorMessage: known ? row.error_message : "Résultat de l'exécution précédente à réconcilier",
          mock: row.claude_mock === true,
          retryable: false,
        },
        finish: async () => { throw new Error("Une exécution déjà réservée ne doit pas être réécrite"); },
      };
    }
    throw new Error(`startRun(${agentType}): ${error.message}`);
  }

  const runId = data.id as string;

  return {
    runId,
    finish: async (outcome) => {
      const { error: updateError } = await supabase
        .from("karta_runs")
        .update({
          status: outcome.status,
          mode: outcome.status === "simulated" ? "simulation" : mode,
          decision: outcome.decision,
          tools_used: outcome.toolsUsed,
          result_summary: outcome.resultSummary,
          error_message: outcome.errorMessage ?? null,
          claude_mock: outcome.mock,
          duration_ms: Date.now() - startedAt,
          finished_at: new Date().toISOString(),
        })
        .eq("id", runId);

      if (updateError) {
        throw new Error(`startRun(${agentType}).finish: ${updateError.message}`);
      }
    },
  };
}
