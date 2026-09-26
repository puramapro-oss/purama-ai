import { supabase } from "../db/supabase.js";
import { resolveAgentDefinition } from "./resolveDefinition.js";
import { executeToolStrict } from "./tool-result.js";
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
 * Revendique atomiquement l'action : UPDATE ... WHERE id AND status='pending' RETURNING.
 * PostgREST n'applique l'update QUE si le prédicat tient encore au moment de l'écriture —
 * 2 approbations simultanées ne peuvent PAS toutes deux gagner (l'une obtient la ligne,
 * l'autre 0 ligne). Retourne la ligne claimée, ou null si déjà traitée/en cours/introuvable.
 * Même garde claim-based que le pattern classique des webhooks Stripe (update conditionnel
 * + RETURNING exactement-une-fois).
 */
async function claimPendingAction(id: string): Promise<PendingActionRow | null> {
  const { data, error } = await supabase
    .from("karta_pending_actions")
    .update({ status: "processing", resolved_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (error) throw new Error(`claimPendingAction(${id}): ${error.message}`);
  return data as PendingActionRow | null;
}

/**
 * Approuve ou rejette une action en attente. Approuver l'EXÉCUTE réellement (résout à nouveau
 * l'AgentDefinition — statique ou `custom:*` — et exécute l'outil en mode live via le contrat
 * strict tool-result.ts) ; rejeter la marque simplement comme non exécutée. Dans les deux cas,
 * patche la ligne karta_runs parente (entrée tools_used + statut global une fois toutes les
 * actions du run résolues).
 *
 * Exactement-une-fois : la résolution commence par un CLAIM atomique (status pending →
 * "processing") — un double-clic ou deux requêtes simultanées ne peuvent exécuter l'outil
 * qu'une SEULE fois ; la perdante reçoit "Action déjà traitée". Si le process meurt entre
 * claim et finalisation, la ligne reste "processing" et est réconciliée en "failed" au
 * démarrage suivant du worker (cf reconcileOrphanPendingActions).
 */
export async function resolvePendingAction(id: string, decision: ResolveDecision): Promise<ResolveResult> {
  let pending: PendingActionRow;
  try {
    const claimed = await claimPendingAction(id);
    if (!claimed) {
      // Chemin perdant uniquement (rare) : une lecture pour rendre l'erreur précise —
      // "introuvable" vs "déjà traitée" — sans jamais ré-exécuter quoi que ce soit.
      const { data: existing } = await supabase.from("karta_pending_actions").select("id").eq("id", id).maybeSingle();
      return { ok: false, error: existing ? "Action déjà traitée" : "Action introuvable" };
    }
    pending = claimed;
  } catch (claimError) {
    return { ok: false, error: claimError instanceof Error ? claimError.message : String(claimError) };
  }

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

    // Contrat complet partagé avec le cycle (executeToolStrict, tool-result.ts) : un outil qui
    // retourne {ok:false}/false sans lever est un ÉCHEC d'exécution — avant ce fix il était
    // marqué "executed" (faux succès).
    resultSummary = await executeToolStrict(tool, pending.tool_params, {
      userId: pending.user_id,
      agentType: pending.agent_type as AgentType,
      mode: "live",
    });
    status = "executed";
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

/**
 * Met à jour l'entrée tools_used correspondante dans karta_runs, et clôture le run si c'était la
 * dernière action en attente. Limite connue : lit-modifie-réécrit tout le JSONB tools_used sans
 * verrou — si 2 actions du MÊME run sont résolues en concurrence (2 clics quasi simultanés sur 2
 * actions différentes d'un même run), l'une peut écraser le patch de l'autre. Risque jugé
 * négligeable (résolution humaine, un seul utilisateur, écart de plusieurs secondes en pratique) ;
 * un correctif robuste nécessiterait un writer unique pour karta_runs (fonction Postgres atomique
 * ou passage par logger.ts) — hors scope d'un ajustement ponctuel.
 */
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

/**
 * Réconcilie les actions restées "processing" par un crash du process entre claim atomique et
 * finalisation (fenêtre de quelques secondes). Tout "processing" plus vieux que
 * `orphanAfterMs` est nécessairement orphelin — l'exécution de l'outil, si elle a eu lieu,
 * est déjà passée : on clôture en "failed" honnête ("interrompu") pour que l'action ne reste
 * pas invisible à jamais (le statut "processing" n'est jamais affiché comme traitable).
 * Appelée au démarrage du worker, à côté de reconcileStaleRuns. Retourne le nombre réconcilié.
 */
export async function reconcileOrphanPendingActions(orphanAfterMs: number = 600_000): Promise<number> {
  const orphanBefore = new Date(Date.now() - orphanAfterMs).toISOString();

  const { data, error } = await supabase
    .from("karta_pending_actions")
    .update({
      status: "failed",
      result_summary: "interrompu (worker arrêté pendant la résolution) — réconcilié au redémarrage",
    })
    .eq("status", "processing")
    .lt("resolved_at", orphanBefore)
    .select("id");

  if (error) {
    console.error(`[approval] reconcileOrphanPendingActions: ${error.message}`);
    return 0;
  }

  const reconciled = Array.isArray(data) ? data.length : 0;
  if (reconciled > 0) {
    console.log(`[approval] reconcileOrphanPendingActions: ${reconciled} action(s) "processing" orpheline(s) clôturée(s) en échec`);
  }
  return reconciled;
}
