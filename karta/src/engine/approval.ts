import { supabase } from "../db/supabase.js";
import { resolveAgentDefinition } from "./resolveDefinition.js";
import { isRunnable, loadAgentState } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { validateToolInput } from "../tools/validation.js";
import type { AgentType, ToolCallRecord } from "./types.js";

interface CreatePendingActionInput {
  userId: string;
  runId: string;
  agentType: AgentType;
  toolName: string;
  toolParams: Record<string, unknown>;
}

/** Journalise une action en attente de validation humaine (mode live, niveau 1 ou outil sensible niveau 2). */
export async function createPendingAction(input: CreatePendingActionInput): Promise<string> {
  const { data, error } = await supabase
    .from("karta_pending_actions")
    .insert({
      user_id: input.userId,
      run_id: input.runId,
      agent_type: input.agentType,
      tool_name: input.toolName,
      tool_params: input.toolParams,
    })
    .select("id")
    .single();

  if (error) throw new Error(`createPendingAction(${input.toolName}): ${error.message}`);
  return data.id as string;
}

interface PendingActionRow {
  id: string;
  user_id: string;
  run_id: string;
  agent_type: string;
  tool_name: string;
  tool_params: Record<string, unknown>;
  status: string;
}

export type ResolveDecision = "approve" | "reject";

export type ResolveResult = { ok: true; resultSummary: string } | { ok: false; error: string };

type FinalStatus = "executed" | "failed" | "rejected" | "blocked" | "unknown";

/**
 * Approuve ou rejette une action en attente. Approuver l'EXÉCUTE réellement (résout à nouveau
 * l'AgentDefinition — statique ou `custom:*` — et appelle tool.execute en mode live) ; rejeter la
 * marque simplement comme non exécutée. Dans les deux cas, patche la ligne karta_runs parente
 * (entrée tools_used + statut global une fois toutes les actions du run résolues).
 */
export async function resolvePendingAction(id: string, decision: ResolveDecision): Promise<ResolveResult> {
  try {
    if (decision !== "approve" && decision !== "reject") return { ok: false, error: "Décision invalide" };
    const { data, error: loadError } = await supabase.from("karta_pending_actions").select("*").eq("id", id).maybeSingle();
    if (loadError) return { ok: false, error: loadError.message };
    const pending = data as PendingActionRow | null;
    if (!pending) return { ok: false, error: "Action introuvable" };
    if (pending.status !== "pending") return { ok: false, error: "Action déjà prise en charge ou résolue ; aucune réexécution" };

    // A cycle may publish its pending rows before finish() publishes the run journal.
    // Never execute against a journal that its original writer can still overwrite.
    await loadApprovalRun(pending);
    if (decision === "reject") {
      const resultSummary = "Rejetée par l'utilisateur — aucune action effectuée";
      await finalizePendingAction(pending, "rejected", resultSummary, "pending");
      return { ok: true, resultSummary };
    }

    const definition = await resolveAgentDefinition(pending.agent_type as AgentType);
    const tool = definition.tools.find((t) => t.name === pending.tool_name);
    if (!tool) throw new Error(`Outil "${pending.tool_name}" introuvable pour cet agent`);
    const params = validateToolInput(tool, pending.tool_params);
    await assertLiveApprovalAllowed(pending);

    // The database compare-and-set is the execution claim. A lost response must
    // never be repaired by putting the row back into pending.
    const { data: claimed, error: claimError } = await supabase
      .from("karta_pending_actions")
      .update({ status: "executing" })
      .eq("id", pending.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError) throw new Error(`Prise en charge non confirmée : ${claimError.message}`);
    if (!claimed) return { ok: false, error: "Action déjà prise en charge ou résolue ; aucune réexécution" };

    let invoked = false;
    let status: FinalStatus;
    let resultSummary: string;
    try {
      await assertLiveApprovalAllowed(pending);
      invoked = true;
      const result = await tool.execute(params, {
        userId: pending.user_id,
        agentType: pending.agent_type as AgentType,
        mode: "live",
      });
      status = "executed";
      resultSummary = summarize(result);
    } catch (toolError) {
      // A rejected promise can follow a remote effect whose response was lost.
      status = invoked ? "unknown" : "blocked";
      resultSummary = `${invoked ? "Résultat inconnu après appel ; vérification manuelle nécessaire, sans réexécution" : "Action bloquée avant exécution"} : ${errorText(toolError)}`;
    }

    try {
      await finalizePendingAction(pending, status, resultSummary, "executing");
    } catch (journalError) {
      return { ok: false, error: `${resultSummary}. Journal non confirmé : ${errorText(journalError)}. Ne pas répéter l'action ; vérifier son état.` };
    }
    return status === "executed" ? { ok: true, resultSummary } : { ok: false, error: resultSummary };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

async function assertLiveApprovalAllowed(pending: PendingActionRow): Promise<void> {
  const state = await loadAgentState(pending.user_id, pending.agent_type as AgentType);
  const runnable = isRunnable(state);
  if (!runnable.ok) throw new Error(runnable.reason);
  if (state.simulationMode) throw new Error("Agent en simulation : exécution réelle interdite");
  if (await isGlobalKillSwitchActive({ fresh: true })) throw new Error("Arrêt global actif");
}

async function loadApprovalRun(pending: PendingActionRow): Promise<{ status: string; tools_used: ToolCallRecord[] }> {
  const { data, error } = await supabase.from("karta_runs").select("status,tools_used").eq("id", pending.run_id).maybeSingle();
  if (error) throw new Error(`Lecture du journal : ${error.message}`);
  if (!data || typeof data.status !== "string" || !Array.isArray(data.tools_used)) throw new Error("Journal parent absent ou invalide");
  if (data.status === "running") throw new Error("Cycle encore en cours : attendre la fin de son journal avant validation");
  if (!data.tools_used.some((entry: ToolCallRecord) => entry.pendingActionId === pending.id)) {
    throw new Error("Action absente du journal parent : exécution refusée");
  }
  return data as { status: string; tools_used: ToolCallRecord[] };
}

async function finalizePendingAction(
  pending: PendingActionRow,
  status: FinalStatus,
  resultSummary: string,
  expectedStatus: "pending" | "executing"
): Promise<void> {
  const { data, error } = await supabase
    .from("karta_pending_actions")
    .update({ status, result_summary: resultSummary, resolved_at: new Date().toISOString() })
    .eq("id", pending.id)
    .eq("status", expectedStatus)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`finalizePendingAction(${pending.id}): ${error.message}`);
  if (!data) throw new Error("État de l'action modifié concurremment ; aucun écrasement");
  await patchParentRun(pending, status, resultSummary);
}

/**
 * The old JSONB and status form the journal compare-and-set. Only this metadata
 * update is retried after conflicts; the tool is never invoked here.
 */
async function patchParentRun(pending: PendingActionRow, status: FinalStatus, resultSummary: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const run = await loadApprovalRun(pending);
    const patched = run.tools_used.map((entry) => entry.pendingActionId === pending.id
      ? { ...entry, resultSummary, success: status === "executed", outcome: status }
      : entry);
    const { count, error: countError } = await supabase
      .from("karta_pending_actions")
      .select("id", { count: "exact", head: true })
      .eq("run_id", pending.run_id)
      .in("status", ["pending", "executing", "unknown"]);

    const countReliable = !countError && typeof count === "number" && Number.isInteger(count) && count >= 0;
    const journalStillUnresolved = patched.some((entry) => entry.outcome === "awaiting_approval" || entry.outcome === "unknown" ||
      (entry.pendingActionId && entry.outcome === undefined));
    const counts = new Map<string, number>();
    for (const entry of patched) {
      const outcome = entry.outcome ?? (entry.pendingActionId ? "awaiting_approval" : entry.success ? "executed" : "failed");
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
    }
    const updates: Record<string, unknown> = {
      tools_used: patched,
      result_summary: `Actions : ${[...counts].map(([outcome, count]) => `${outcome}=${count}`).join(", ")}`,
    };
    if (countReliable) {
      updates.status = run.status === "error" ? "error" : count > 0 || journalStillUnresolved
        ? "awaiting_approval"
        : patched.some((entry) => entry.outcome === "failed" || entry.outcome === "blocked" || (!entry.success && entry.outcome !== "rejected" && entry.outcome !== "simulated"))
          ? "error" : "success";
    }

    const { data: updated, error: updateError } = await supabase
      .from("karta_runs")
      .update(updates)
      .eq("id", pending.run_id)
      .eq("status", run.status)
      .eq("tools_used", JSON.stringify(run.tools_used))
      .select("id")
      .maybeSingle();
    if (updateError) throw new Error(`Écriture du journal parent : ${updateError.message}`);
    if (!updated) continue;
    if (!countReliable) throw new Error(`Comptage des actions non confirmé : ${countError?.message ?? "compte absent ou invalide"}`);
    return;
  }
  throw new Error("Journal parent modifié concurremment ; réconciliation nécessaire sans réexécution");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result.slice(0, 200);
  try {
    return JSON.stringify(result).slice(0, 200);
  } catch {
    return "ok";
  }
}
