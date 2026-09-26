import { getClaudeClient } from "../claude/index.js";
import { isRunnable, loadAgentState, recordRunOutcome, requiresHumanApproval } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { startRun } from "./logger.js";
import { notify } from "./notify.js";
import { createPendingAction } from "./approval.js";
import { executeToolStrict, TimeoutError, withTimeout } from "./tool-result.js";
import type { AgentDefinition, AgentRunResult, AgentTrigger, ToolCallRecord } from "./types.js";

/** Timeout de la décision (Claude/mock). Un provider qui pend figeait le cycle entier ; ici
 * l'échec survient AVANT tout side-effect → le cycle reste rejouable (retry BullMQ sûr). */
const DECIDE_TIMEOUT_MS = 120_000;

/** Timeout de la construction du contexte (requêtes Supabase réelles : mémoire, factures,
 * emails...). Dernière phase non bornée du cycle : un fetch DB qui pend figeait le slot
 * BullMQ ET tenait le verrou anti-double jusqu'à son TTL (600s). 60s couvre les agents cœur
 * (plusieurs requêtes) sans laisser un cycle bloqué à l'infini. Échec avant tout
 * side-effect → cycle rejouable. */
const BUILD_CONTEXT_TIMEOUT_MS = 60_000;

/**
 * Boucle cœur KARTA : déclencheur → contexte → décision (Claude, mock ou réel) → outils → log → notif.
 * Un seul point d'entrée pour les 4 agents cœur — chaque agent ne fournit que sa définition
 * (buildContext, systemPrompt, tools), la boucle gère l'autonomie, le kill switch, le mode
 * simulation et la journalisation immuable de façon identique pour tous.
 */
export async function runAgentCycle(
  userId: string,
  definition: AgentDefinition,
  trigger: AgentTrigger
): Promise<AgentRunResult> {
  if (await isGlobalKillSwitchActive()) {
    return {
      status: "success",
      decision: "Cycle ignoré : kill switch global actif",
      toolsUsed: [],
      resultSummary: "kill switch global actif",
      mock: false,
      sideEffectsCommitted: false,
    };
  }

  const state = await loadAgentState(userId, definition.type);

  const runnable = isRunnable(state);
  if (!runnable.ok) {
    await recordRunOutcome(userId, definition.type, "skipped");
    return {
      status: "success",
      decision: `Cycle ignoré : ${runnable.reason}`,
      toolsUsed: [],
      resultSummary: runnable.reason,
      mock: false,
      sideEffectsCommitted: false,
    };
  }

  const mode: "simulation" | "live" = state.simulationMode ? "simulation" : "live";
  const run = await startRun(userId, definition.type, trigger, mode);
  const claude = getClaudeClient();

  // Portée FONCTION (pas module) : le worker tourne en concurrency 5 — des variables de module
  // seraient partagées entre cycles concurrents et contamineraient le chemin d'erreur d'un cycle
  // par les outils d'un autre. Déclarées AVANT le try : le catch doit y accéder.
  const toolsUsed: ToolCallRecord[] = [];
  /** Toute tentative d'exécution réelle (mode live) est un side-effect POTENTIEL : un throw
   * au milieu d'un envoi/insert peut avoir déjà agi côté monde réel. Compté AVANT l'await. */
  let sideEffectsCommitted = false;

  try {
    const context = await withTimeout(
      definition.buildContext(userId, trigger),
      `buildContext(${definition.type})`,
      BUILD_CONTEXT_TIMEOUT_MS,
      (label, ms) => new TimeoutError(label, ms)
    );

    const decision = await withTimeout(
      claude.decide({
        systemPrompt: definition.systemPrompt,
        context,
        tools: definition.tools,
        agentType: definition.type,
      }),
      `decide(${definition.type})`,
      DECIDE_TIMEOUT_MS,
      (label, ms) => new TimeoutError(label, ms)
    );

    for (const call of decision.toolCalls) {
      const tool = definition.tools.find((t) => t.name === call.tool);
      if (!tool) {
        toolsUsed.push({
          tool: call.tool,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: "outil inconnu — ignoré",
          success: false,
        });
        continue;
      }

      const needsApproval = decision.requiresApproval || requiresHumanApproval(state, tool.sensitive);

      if (needsApproval || mode === "simulation") {
        let pendingActionId: string | undefined;
        // Un dry-run de simulation n'a rien à approuver plus tard (rien ne serait jamais exécuté) ;
        // en mode live, on journalise l'action pour pouvoir réellement l'exécuter après validation
        // humaine (cf engine/approval.ts) — sans cette ligne, l'action reste bloquée pour toujours.
        if (needsApproval && mode === "live") {
          pendingActionId = await createPendingAction({
            userId,
            runId: run.runId,
            agentType: definition.type,
            toolName: tool.name,
            toolParams: call.params,
          });
        }
        toolsUsed.push({
          tool: tool.name,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: mode === "simulation" ? "simulé — aucune action réelle (dry-run)" : "en attente de validation humaine",
          success: true,
          pendingActionId,
        });
        continue;
      }

      if (mode === "live") sideEffectsCommitted = true; // potentiel, dès la tentative
      try {
        // Contrat complet (timeout + cast + faux succès interdits + résumé) : executeToolStrict,
        // unique point d'exécution — partagé avec engine/approval.ts.
        const resultSummary = await executeToolStrict(tool, call.params, {
          userId,
          agentType: definition.type,
          mode,
        });
        toolsUsed.push({
          tool: tool.name,
          paramsSummary: JSON.stringify(call.params),
          resultSummary,
          success: true,
        });
      } catch (toolError) {
        toolsUsed.push({
          tool: tool.name,
          paramsSummary: JSON.stringify(call.params),
          resultSummary: toolError instanceof Error ? toolError.message : String(toolError),
          success: false,
        });
      }
    }

    // Dérivable : une action n'attend la validation humaine QUE si un pendingActionId a été
    // journalisé pour elle en mode live (cf branche needsApproval ci-dessus).
    const awaitingApproval = toolsUsed.some((t) => t.pendingActionId);
    const status = awaitingApproval ? "awaiting_approval" : "success";
    const resultSummary = summarizeToolsUsed(toolsUsed, mode);

    await run.finish({
      status,
      decision: decision.summary,
      toolsUsed,
      resultSummary,
      mock: decision.mock,
    });

    if (awaitingApproval) {
      // Un échec d'envoi (push/email down) ne doit jamais faire échouer le cycle : l'action de
      // l'agent est déjà journalisée en attente d'approbation, c'est ce qui compte.
      // Décision humaine requise : seul cas où on sort du silence (push + email), cf brief §UX/Simplicité.
      await notify({
        userId,
        agentType: definition.type,
        title: `${definition.type} : action en attente de validation`,
        body: decision.summary,
        actionType: "review",
        actionUrl: "/dashboard/employees",
        priority: "normal",
        channels: ["in_app", "push", "email"],
      }).catch((notifyError: unknown) => console.error(`[loop] notify(${definition.type}) a échoué :`, notifyError));
    }

    // Un échec d'enregistrement du compteur d'issue (karta_agent_memory) ne doit pas faire
    // basculer en erreur un cycle déjà terminé, journalisé et notifié — l'outil / l'action
    // a réellement eu lieu, le dire "error" mentirait sur ce qui s'est passé.
    await recordRunOutcome(userId, definition.type, "success").catch((outcomeError: unknown) =>
      console.error(`[loop] recordRunOutcome(${definition.type}, success) a échoué :`, outcomeError)
    );

    return { status, decision: decision.summary, toolsUsed, resultSummary, mock: decision.mock, sideEffectsCommitted };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Les outils déjà exécutés restent journalisés (et visibles au retour) même si le cycle
    // échoue après coup — les perdre, c'est perdre la trace de side-effects réellement commis.
    const resultSummary = `erreur après ${toolsUsed.length} outil(s) traité(s)`;
    await run.finish({
      status: "error",
      decision: "",
      toolsUsed,
      resultSummary,
      errorMessage,
      mock: false,
    }).catch((finishError: unknown) => {
      // Le run reste "running" en base — réconcilié en "error (interrompu)" au prochain
      // démarrage du worker (cf logger.reconcileStaleRuns). Ne jamais masquer l'erreur d'origine.
      console.error(`[loop] finish(${definition.type}) a échoué après une erreur de cycle :`, finishError);
    });

    await recordRunOutcome(userId, definition.type, "error").catch((outcomeError: unknown) =>
      console.error(`[loop] recordRunOutcome(${definition.type}) a échoué :`, outcomeError)
    );

    return {
      status: "error",
      decision: "",
      toolsUsed,
      resultSummary,
      errorMessage,
      mock: false,
      sideEffectsCommitted,
    };
  }
}

function summarizeToolsUsed(tools: ToolCallRecord[], mode: "simulation" | "live"): string {
  if (tools.length === 0) return "aucune action";
  const done = tools.filter((t) => t.success).length;
  return `${done}/${tools.length} action(s) ${mode === "simulation" ? "simulée(s)" : "exécutée(s)"}`;
}
