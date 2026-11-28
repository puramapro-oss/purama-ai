import { supabase } from "../db/supabase.js";
import { notify } from "../engine/notify.js";
import type { AgentType } from "../engine/types.js";
import { routineRuntimeConfig } from "../routines/runtime.js";
import { routineStore } from "../routines/store.js";

interface RunRow {
  user_id: string;
  agent_type: AgentType;
  status: string;
  mode: string;
  claude_mock: boolean;
}

/** Rapport quotidien 8h (cf brief Phase 1) : résumé des 24 dernières heures, par utilisateur. */
export async function runDailyReport(isActive: () => boolean = () => true): Promise<void> {
  if (!isActive()) return;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("karta_runs")
    .select("user_id, agent_type, status, mode, claude_mock")
    .gte("started_at", since);

  if (error) throw new Error("Rapport quotidien : données indisponibles");

  const byUser = groupByUser((data ?? []) as RunRow[]);
  const notificationFailures: unknown[] = [];

  for (const [userId, runs] of byUser) {
    if (!isActive()) return;
    const success = runs.filter((r) => r.status === "success" && r.mode !== "simulation" && !r.claude_mock).length;
    const errors = runs.filter((r) => r.status === "error").length;
    const awaiting = runs.filter((r) => r.status === "awaiting_approval").length;
    const simulated = runs.filter((r) => r.status === "simulated" || (r.status === "success" && (r.mode === "simulation" || r.claude_mock))).length;
    const skipped = runs.filter((r) => r.status === "skipped").length;
    const other = runs.length - success - errors - awaiting - simulated - skipped;

    const byAgent = new Map<string, number>();
    for (const run of runs) byAgent.set(run.agent_type, (byAgent.get(run.agent_type) ?? 0) + 1);
    const agentBreakdown = [...byAgent.entries()].map(([type, count]) => `${type}: ${count}`).join(", ");

    try {
      const preferences = await routineStore.preferences(userId);
      if (!isActive()) return;
      if (preferences?.daily_report_enabled === false) continue;
      // A personalized recurring briefing replaces the legacy generic digest.
      // Its pause never silently turns the old morning message back on.
      if (routineRuntimeConfig().enabled) {
        const routines = await routineStore.list(userId);
        if (!isActive()) return;
        if (routines.some(routine => ["daily", "weekly"].includes(routine.config.schedule.kind))) continue;
      }
      await notify({
        userId,
        agentType: runs[0].agent_type,
        title: "Rapport quotidien de tes agents IA",
        body: `${runs.length} cycle(s) enregistré(s) (${agentBreakdown}). ${success} réussi(s) hors simulation, ${errors} en erreur, ${awaiting} en attente de validation ou de vérification, ${simulated} simulé(s), ${skipped} ignoré(s)${other > 0 ? `, ${other} en cours ou de statut à vérifier` : ""}.`,
        actionType: "daily_report",
        priority: "low",
        channels: preferences?.email_enabled === false ? ["in_app"] : ["in_app", "email"],
      });
    } catch (notificationError) {
      // Une notification déjà partiellement appliquée n'est pas répétée ici.
      // Les autres destinataires doivent néanmoins recevoir leur propre rapport.
      notificationFailures.push(notificationError);
    }
  }
  if (notificationFailures.length > 0) {
    throw new AggregateError(notificationFailures, `${notificationFailures.length}/${byUser.size} rapport(s) non confirmés — vérifier sans renvoi automatique`);
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
