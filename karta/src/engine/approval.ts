import { supabase } from "../db/supabase.js";
import { resolveAgentDefinition } from "./resolveDefinition.js";
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

type FinalStatus = "executed" | "failed" | "rejected";

/**
 * Approuve ou rejette une action en attente. Approuver l'EXÉCUTE réellement (résout à nouveau
 * l'AgentDefinition — statique ou `custom:*` — et appelle tool.execute en mode live) ; rejeter la
 * marque simplement comme non exécutée. Dans les deux cas, patche la ligne karta_runs parente
 * (entrée tools_used + statut global une fois toutes les actions du run résolues).
 */
export async function resolvePendingAction(id: string, decision: ResolveDecision): Promise<ResolveResult> {
  const { data, error: loadError } = await supabase.from("karta_pending_actions").select("*").eq("id", id).maybeSingle();

  if (loadError) return { ok: false, error: loadError.message };
  const pending = data as PendingActionRow | null;
  if (!pending) return { ok: false, error: "Action introuvable" };
  if (pending.status !== "pending") return { ok: false, error: "Action déjà traitée" };

  if (decision === "reject") {
    const resultSummary = "Rejetée par l'utilisateur — aucune action effectuée";
    await finalizePendingAction(pending, "rejected", resultSummary);
    return { ok: true, resultSummary };
  }

  let status: FinalStatus;
  let resultSummary: string;

  try {
    const definition = await resolveAgentDefinition(pending.agent_type as AgentType);
    const tool = definition.tools.find((t) => t.name === pending.tool_name);
    if (!tool) throw new Error(`Outil "${pending.tool_name}" introuvable pour cet agent`);

    const result = await tool.execute(pending.tool_params, {
      userId: pending.user_id,
      agentType: pending.agent_type as AgentType,
      mode: "live",
    });
    status = "executed";
    resultSummary = summarize(result);
  } catch (toolError) {
    status = "failed";
    resultSummary = toolError instanceof Error ? toolError.message : String(toolError);
  }

  await finalizePendingAction(pending, status, resultSummary);
  return { ok: true, resultSummary };
}

async function finalizePendingAction(pending: PendingActionRow, status: FinalStatus, resultSummary: string): Promise<void> {
  const { error } = await supabase
    .from("karta_pending_actions")
    .update({ status, result_summary: resultSummary, resolved_at: new Date().toISOString() })
    .eq("id", pending.id);
  if (error) throw new Error(`finalizePendingAction(${pending.id}): ${error.message}`);

  await patchParentRun(pending, status, resultSummary);
}

/** Met à jour l'entrée tools_used correspondante dans karta_runs, et clôture le run si c'était la dernière action en attente. */
async function patchParentRun(pending: PendingActionRow, status: FinalStatus, resultSummary: string): Promise<void> {
  const { data: run, error: runError } = await supabase
    .from("karta_runs")
    .select("tools_used")
    .eq("id", pending.run_id)
    .maybeSingle();

  if (runError || !run) return; // run introuvable — l'action reste correctement résolue dans tous les cas

  const toolsUsed = (Array.isArray(run.tools_used) ? run.tools_used : []) as ToolCallRecord[];
  const patched = toolsUsed.map((t) =>
    t.pendingActionId === pending.id
      ? {
          ...t,
          resultSummary:
            status === "rejected" ? "rejetée par l'utilisateur" : status === "executed" ? resultSummary : `échec après approbation : ${resultSummary}`,
          success: status !== "failed",
        }
      : t
  );

  const { count } = await supabase
    .from("karta_pending_actions")
    .select("id", { count: "exact", head: true })
    .eq("run_id", pending.run_id)
    .eq("status", "pending");

  const updates: Record<string, unknown> = { tools_used: patched };
  if (!count) {
    const anyFailed = patched.some((t) => !t.success);
    updates.status = anyFailed ? "error" : "success";
  }

  await supabase.from("karta_runs").update(updates).eq("id", pending.run_id);
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
