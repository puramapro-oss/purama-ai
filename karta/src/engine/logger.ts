import { supabase } from "../db/supabase.js";
import type { AgentRunResult, AgentTrigger, AgentType, ToolCallRecord } from "./types.js";

export interface RunLogHandle {
  runId: string;
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
 * Ouvre un journal de cycle. La boucle le clôture une seule fois ; la résolution des
 * approbations peut ensuite mettre à jour les résultats des actions correspondantes.
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

  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    throw new Error(`startRun(${agentType}): identifiant du journal non confirmé`);
  }
  const runId = data.id;
  let finishAttempted = false;

  return {
    runId,
    finish: async (outcome) => {
      if (finishAttempted) throw new Error(`startRun(${agentType}).finish: clôture déjà tentée`);
      finishAttempted = true;
      const { data: updated, error: updateError } = await supabase
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
        .eq("id", runId)
        .eq("status", "running")
        .select("id")
        .maybeSingle();

      if (updateError) {
        throw new Error(`startRun(${agentType}).finish: ${updateError.message}`);
      }
      if (!updated) throw new Error(`startRun(${agentType}).finish: journal absent ou déjà clôturé`);
    },
  };
}
