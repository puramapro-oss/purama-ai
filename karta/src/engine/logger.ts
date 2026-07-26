import { supabase } from "../db/supabase.js";
import type { AgentTrigger, AgentType, ToolCallRecord } from "./types.js";

export interface RunLogHandle {
  runId: string;
  finish: (outcome: {
    status: "success" | "error" | "awaiting_approval";
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
  mode: "simulation" | "live"
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
    })
    .select("id")
    .single();

  if (error) {
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
