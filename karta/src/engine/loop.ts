import { getClaudeClient } from "../claude/index.js";
import { validateToolInput } from "../tools/validation.js";
import { isRunnable, loadAgentState, recordRunOutcome, requiresHumanApproval } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { startRun, type RunLogHandle } from "./logger.js";
import { notify } from "./notify.js";
import { createPendingAction } from "./approval.js";
import type { AgentDefinition, AgentRunResult, AgentTrigger, ToolCallRecord } from "./types.js";

/** Un bilan explicite ; aucun échec secondaire ne réécrit un historique d'effets vide. */
export async function runAgentCycle(
  userId: string,
  definition: AgentDefinition,
  trigger: AgentTrigger
): Promise<AgentRunResult> {
  const toolsUsed: ToolCallRecord[] = [];
  const warnings: string[] = [];
  let run: RunLogHandle | undefined;
  let decisionSummary = "";
  let mock = false;
  let mode: "simulation" | "live" = "simulation";
  let errorMessage: string | undefined;
  let skippedReason: string | undefined;
  let retrySafe = true;

  try {
    if (await isGlobalKillSwitchActive({ fresh: true })) {
      skippedReason = "kill switch global actif";
    } else {
      // Le chargement peut créer l'état par défaut : une réponse perdue ne prouve pas zéro écriture.
      retrySafe = false;
      const state = await loadAgentState(userId, definition.type);
      const runnable = isRunnable(state);
      if (!runnable.ok) {
        skippedReason = runnable.reason;
      } else {
        mode = state.simulationMode ? "simulation" : "live";
        run = await startRun(userId, definition.type, trigger, mode);
        const context = await definition.buildContext(userId, trigger);
        if (await isGlobalKillSwitchActive({ fresh: true })) {
          throw new Error("kill switch global actif — cycle interrompu avant la décision");
        }
        const decision = await getClaudeClient().decide({
          systemPrompt: definition.systemPrompt,
          context,
          tools: definition.tools,
          agentType: definition.type,
        });
        decisionSummary = decision.summary;
        mock = decision.mock;

        for (const call of decision.toolCalls) {
          const record: ToolCallRecord = {
            tool: call.tool,
            paramsSummary: JSON.stringify(call.params),
            resultSummary: "action non exécutée",
            success: false,
            outcome: "blocked",
          };
          toolsUsed.push(record);
          const tool = definition.tools.find((candidate) => candidate.name === call.tool);
          if (!tool) {
            record.outcome = "failed";
            record.resultSummary = "outil inconnu — ignoré";
            continue;
          }

          try {
            validateToolInput(tool, call.params);
          } catch (validationError) {
            record.outcome = "failed";
            record.resultSummary = `paramètres refusés : ${messageOf(validationError)}`;
            continue;
          }

          // Ces contrôles ne peuvent pas annuler un effet déjà engagé chez un fournisseur.
          const currentState = await loadAgentState(userId, definition.type);
          const currentRunnable = isRunnable(currentState);
          if (!currentRunnable.ok) {
            record.resultSummary = `${currentRunnable.reason} — cycle interrompu`;
            break;
          }
          if (mode === "live" && currentState.simulationMode) {
            record.resultSummary = "mode simulation activé — cycle live interrompu";
            break;
          }
          if (await isGlobalKillSwitchActive({ fresh: true })) {
            record.resultSummary = "kill switch global actif — cycle interrompu";
            break;
          }
          // Ni une hausse d'autonomie ni un changement de mode ne donnent plus de droits au cycle.
          const needsApproval = decision.requiresApproval ||
            requiresHumanApproval(state, tool.sensitive) || requiresHumanApproval(currentState, tool.sensitive);

          if (mode === "simulation") {
            record.outcome = "simulated";
            record.resultSummary = "simulé — aucune action réelle (dry-run)";
            continue;
          }
          if (needsApproval) {
            // Insérer peut réussir malgré une réponse perdue. On ne rejoue jamais ce cycle.
            record.outcome = "unknown";
            record.resultSummary = "enregistrement de l'approbation en cours — résultat à vérifier";
            record.pendingActionId = await createPendingAction({
              userId,
              runId: run.runId,
              agentType: definition.type,
              toolName: tool.name,
              toolParams: call.params,
            });
            record.outcome = "awaiting_approval";
            record.resultSummary = "en attente de validation humaine";
            continue;
          }

          record.outcome = "unknown";
          record.resultSummary = "exécution commencée — résultat à vérifier";
          try {
            const result = await tool.execute(call.params, { userId, agentType: definition.type, mode });
            record.resultSummary = summarize(result);
            record.outcome = "executed";
            record.success = true;
          } catch (toolError) {
            record.resultSummary = `échec ou résultat incertain : ${messageOf(toolError)}`;
            // Une exception réseau n'établit pas si le service a déjà appliqué l'action.
            break;
          }
        }
      }
    }
  } catch (error) {
    errorMessage = messageOf(error);
  }

  const awaitingApproval = toolsUsed.some((tool) => tool.outcome === "awaiting_approval");
  const failed = toolsUsed.some((tool) => ["failed", "blocked", "unknown"].includes(tool.outcome ?? ""));
  const status: AgentRunResult["status"] = errorMessage || failed ? "error" :
    skippedReason ? "skipped" : awaitingApproval ? "awaiting_approval" : mode === "simulation" ? "simulated" : "success";
  const result: AgentRunResult = {
    status,
    decision: skippedReason ? `Cycle ignoré : ${skippedReason}` : decisionSummary,
    toolsUsed,
    resultSummary: skippedReason ?? summarizeToolsUsed(toolsUsed, mode),
    mock,
    retrySafe,
    warnings,
  };
  if (errorMessage || failed) {
    result.errorMessage = errorMessage ?? toolsUsed.find((tool) =>
      ["failed", "blocked", "unknown"].includes(tool.outcome ?? ""))?.resultSummary;
  }

  if (run) {
    try {
      await run.finish(result);
    } catch (journalError) {
      // La requête peut avoir été appliquée : une seconde clôture risquerait d'effacer le bilan.
      const detail = `journal non confirmé : ${messageOf(journalError)}`;
      result.status = "error";
      result.retrySafe = false;
      result.errorMessage = result.errorMessage ? `${result.errorMessage}; ${detail}` : detail;
      warnings.push(detail);
    }
  }

  try {
    await recordRunOutcome(userId, definition.type, result.status);
  } catch (metadataError) {
    const detail = `état récapitulatif non actualisé : ${messageOf(metadataError)}`;
    warnings.push(detail);
    console.error(`[loop] ${detail}`);
  }

  if (awaitingApproval) {
    try {
      await notify({
        userId,
        agentType: definition.type,
        title: `${definition.type} : action en attente de validation`,
        body: decisionSummary,
        actionType: "review",
        actionUrl: "/dashboard/employees",
        priority: "normal",
        channels: ["in_app", "push", "email"],
      });
    } catch (notifyError) {
      const detail = `notification non confirmée : ${messageOf(notifyError)}`;
      warnings.push(detail);
      console.error(`[loop] ${detail}`);
    }
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result.slice(0, 200);
  try {
    return (JSON.stringify(result) ?? "résultat sans représentation JSON").slice(0, 200);
  } catch {
    return "appel terminé — résultat non sérialisable";
  }
}

function summarizeToolsUsed(tools: ToolCallRecord[], mode: "simulation" | "live"): string {
  if (tools.length === 0) return mode === "simulation" ? "simulation — aucune action" : "aucune action";
  const count = (outcome: ToolCallRecord["outcome"]) => tools.filter((tool) => tool.outcome === outcome).length;
  return `${count("executed")}/${tools.length} action(s) exécutée(s), ${count("simulated")} simulée(s), ` +
    `${count("awaiting_approval")} en attente, ${count("failed")} échouée(s), ` +
    `${count("blocked")} bloquée(s), ${count("unknown")} au résultat incertain`;
}
