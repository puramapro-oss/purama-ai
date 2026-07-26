import { supabase } from "../db/supabase.js";
import { notify } from "../engine/notify.js";
import type { AgentType } from "../engine/types.js";

interface RunRow {
  user_id: string;
  agent_type: AgentType;
  status: string;
  mode: string;
}

/** Rapport quotidien 8h (cf brief Phase 1) : résumé des 24 dernières heures, par utilisateur. */
export async function runDailyReport(): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("karta_runs")
    .select("user_id, agent_type, status, mode")
    .gte("started_at", since);

  if (error) throw new Error(`runDailyReport: ${error.message}`);

  const byUser = groupByUser((data ?? []) as RunRow[]);

  for (const [userId, runs] of byUser) {
    const success = runs.filter((r) => r.status === "success").length;
    const errors = runs.filter((r) => r.status === "error").length;
    const awaiting = runs.filter((r) => r.status === "awaiting_approval").length;
    const simulated = runs.filter((r) => r.mode === "simulation").length;

    const byAgent = new Map<string, number>();
    for (const run of runs) byAgent.set(run.agent_type, (byAgent.get(run.agent_type) ?? 0) + 1);
    const agentBreakdown = [...byAgent.entries()].map(([type, count]) => `${type}: ${count}`).join(", ");

    await notify({
      userId,
      agentType: runs[0].agent_type,
      title: "Rapport quotidien de tes agents IA",
      body: `${runs.length} cycle(s) exécuté(s) (${agentBreakdown}). ${success} réussi(s), ${errors} en erreur, ${awaiting} en attente de validation${simulated > 0 ? `, ${simulated} en mode simulation` : ""}.`,
      actionType: "daily_report",
      priority: "low",
      channels: ["in_app", "email"],
    });
  }
}

function groupByUser(runs: RunRow[]): Map<string, RunRow[]> {
  const map = new Map<string, RunRow[]>();
  for (const run of runs) {
    const existing = map.get(run.user_id) ?? [];
    existing.push(run);
    map.set(run.user_id, existing);
  }
  return map;
}
