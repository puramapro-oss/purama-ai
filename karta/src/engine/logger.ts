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

/**
 * Clôture les runs restés "running" alors qu'aucun worker ne les porte plus (crash/redémarrage
 * du process au milieu d'un cycle — le chemin catch de loop.ts n'a pas pu écrire le statut).
 * Appelée au démarrage du worker (cf index.ts) : tout run "running" plus vieux que
 * `staleAfterMs` est nécessairement orphelin, aucun cycle n'a le droit de durer aussi longtemps
 * (décision bornée 120s + outils bornés 30s chacun, cf tool-result.ts / loop.ts).
 * Retourne le nombre de runs réconciliés (0 = rien à faire).
 */
export async function reconcileStaleRuns(staleAfterMs: number = 3_600_000): Promise<number> {
  const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();

  const { data, error } = await supabase
    .from("karta_runs")
    .update({
      status: "error",
      error_message: "interrompu (worker arrêté pendant le cycle) — réconcilié au redémarrage",
      result_summary: "erreur avant complétion du cycle",
      finished_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("created_at", staleBefore)
    .select("id");

  if (error) {
    // Non fatal au démarrage : les runs resteront "running" et seront réconciliés au prochain
    // démarrage — mais il faut que l'échec soit visible dans les logs du container.
    console.error(`[logger] reconcileStaleRuns: ${error.message}`);
    return 0;
  }

  const reconciled = Array.isArray(data) ? data.length : 0;
  if (reconciled > 0) {
    console.log(`[logger] reconcileStaleRuns: ${reconciled} run(s) "running" orphelin(s) réconcilié(s) en erreur`);
  }
  return reconciled;
}
