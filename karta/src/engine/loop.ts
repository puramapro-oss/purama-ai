import { getClaudeClient } from "../claude/index.js";
import { isRunnable, loadAgentState, recordRunOutcome, requiresHumanApproval } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { startRun, type RunLogHandle } from "./logger.js";
import { notify } from "./notify.js";
import { createPendingAction } from "./approval.js";
import { assertToolResult } from "./tool-result.js";
import { validateToolParams } from "./tool-input.js";
import { CustomAgentAuthorizationError, resolveAgentDefinition } from "./resolveDefinition.js";
import { minimizeRunTrace, PRIVATE_TRACE, shouldMinimizeToolTrace, summarizeToolError, summarizeToolParams, summarizeToolResult } from "./tool-trace.js";
import type { AgentDefinition, AgentRunResult, AgentTrigger, ToolCallRecord } from "./types.js";

export async function runAgentCycle(
  userId: string, definition: AgentDefinition, trigger: AgentTrigger, executionKey?: string
): Promise<AgentRunResult> {
  const cycleStartedAt = new Date().toISOString();

  let mode: "simulation" | "live";
  let run: RunLogHandle;
  try {
    if (await isGlobalKillSwitchActive(true)) {
      return { status: "skipped", decision: "Cycle ignoré : arrêt global actif", toolsUsed: [], resultSummary: "Aucune action exécutée", mock: false };
    }
    const state = await loadAgentState(userId, definition.type);
    const runnable = isRunnable(state);
    if (!runnable.ok) {
      await recordRunOutcome(userId, definition.type, "skipped", cycleStartedAt);
      return { status: "skipped", decision: runnable.reason, toolsUsed: [], resultSummary: "Aucune action exécutée", mock: false };
    }
    mode = state.simulationMode ? "simulation" : "live";
    run = await startRun(userId, definition.type, trigger, mode, executionKey);
  } catch {
    // Admission errors remain thrown for the existing queue retry contract.
    // Do not pass raw database/provider content to callers or worker logs.
    throw new Error("Cycle temporairement indisponible : vérifier son état avant toute reprise");
  }
  // Protect context/decision failures before a model has selected any tool.
  let privateTrace = definition.type.startsWith("custom:") || definition.tools.some(shouldMinimizeToolTrace);
  if (run.existingResult) return minimizeRunTrace(run.existingResult, definition.tools, privateTrace);
  const toolsUsed: ToolCallRecord[] = [];
  let decisionText = "";
  let mock = false;
  let effectStarted = false;
  let finalizedOutcome: AgentRunResult | undefined;
  let completionAttempted = false;
  const finishOutcome = async (outcome: AgentRunResult): Promise<AgentRunResult> => {
    completionAttempted = true;
    try {
      await run.finish(outcome);
    } catch {
      // Reconcile only this same candidate; never repeat an external action.
      // The logger's conditional write makes this one bounded retry safe.
      await run.finish(outcome);
    }
    finalizedOutcome = outcome;
    if (outcome.status === "awaiting_approval") {
      try {
        await notify({
          userId, agentType: definition.type, title: `${definition.type} : action en attente de validation`,
          body: decisionText, actionType: "review", actionUrl: "/dashboard/employees", priority: "normal",
          channels: ["in_app", "push", "email"],
        });
      } catch { console.error("[loop] notification indisponible ; action conservée en attente"); }
    }
    await recordRunOutcome(userId, definition.type, outcome.status, cycleStartedAt);
    return outcome;
  };

  try {
    const context = await definition.buildContext(userId, trigger);
    if (definition.type.startsWith("custom:")) {
      try {
        // startRun and buildContext may have awaited after worker admission.
        // This is the last authority read before invoking the model; it is
        // deliberately not described as atomic with the provider request.
        await resolveAgentDefinition(definition.type, userId);
      } catch (error) {
        if (!(error instanceof CustomAgentAuthorizationError)) throw error;
        return await finishOutcome(minimizeRunTrace({
          status: "cancelled", decision: "Cycle annulé : autorisation modifiée avant l’appel au modèle",
          toolsUsed: [], resultSummary: "Aucune requête au modèle ni action exécutée",
          mock: false, retryable: false,
        }, definition.tools, true));
      }
    }
    const decision = await getClaudeClient().decide({
      systemPrompt: definition.systemPrompt, context, tools: definition.tools, agentType: definition.type,
    });
    // One private/unknown call protects the entire decision, including earlier
    // and deferred calls where the model could repeat the same private content.
    privateTrace ||= decision.toolCalls.some(call =>
      shouldMinimizeToolTrace(definition.tools.find(tool => tool.name === call.tool)));
    decisionText = privateTrace ? PRIVATE_TRACE.decision : decision.summary;
    mock = decision.mock;
    const simulation = mode === "simulation" || mock;
    let cancelled = false;
    let failed = false;
    const traceRecord = (
      call: typeof decision.toolCalls[number],
      resultSummary: string,
      outcome: NonNullable<ToolCallRecord["outcome"]>,
      pendingActionId?: string,
    ): ToolCallRecord => ({
      tool: definition.tools.find(tool => tool.name === call.tool)?.name ?? PRIVATE_TRACE.unknownTool,
      paramsSummary: summarizeToolParams(call.params, privateTrace),
      resultSummary,
      success: outcome === "executed",
      outcome,
      ...(pendingActionId ? { pendingActionId } : {}),
    });

    for (let index = 0; index < decision.toolCalls.length; index++) {
      const call = decision.toolCalls[index];
      const skipRemaining = (reason: string) => {
        for (const skipped of decision.toolCalls.slice(index)) toolsUsed.push(traceRecord(skipped, reason, "skipped"));
      };
      let tool = definition.tools.find(t => t.name === call.tool);
      if (definition.type.startsWith("custom:")) {
        try {
          const current = await resolveAgentDefinition(definition.type, userId);
          const authorizedTool = current.tools.find(t => t.name === call.tool);
          if (!authorizedTool) {
            cancelled = true;
            skipRemaining("Droits de l’agent modifiés : action non exécutée");
            break;
          }
          // A newly granted tool was not part of the original decision contract.
          // Existing tools use their freshly resolved schema/approval policy.
          if (tool) tool = authorizedTool;
        } catch (error) {
          if (error instanceof CustomAgentAuthorizationError) {
            cancelled = true;
            skipRemaining("Droits de l’agent modifiés : action non exécutée");
          } else {
            failed = true;
            skipRemaining("Autorisations non vérifiables : action non exécutée");
          }
          break;
        }
      }
      // The fresh definition read must precede the final stop/state checks.
      const latest = await loadAgentState(userId, definition.type);
      if (await isGlobalKillSwitchActive(true) || !isRunnable(latest).ok || (mode === "live" && latest.simulationMode)) {
        cancelled = true;
        skipRemaining("Action annulée : arrêt ou autorisation modifiée");
        break;
      }
      if (!tool) {
        toolsUsed.push(traceRecord(call, "Outil inconnu", "failed"));
        failed = true;
        for (const skipped of decision.toolCalls.slice(index + 1)) toolsUsed.push(traceRecord(skipped, "Non exécutée après un échec", "skipped"));
        break;
      }
      try {
        validateToolParams(tool, call.params);
      } catch (validationError) {
        toolsUsed.push(traceRecord(call, summarizeToolError(validationError, privateTrace, "Paramètres invalides"), "failed"));
        failed = true;
        for (const skipped of decision.toolCalls.slice(index + 1)) toolsUsed.push(
          traceRecord(skipped, "Non exécutée après une validation de paramètres échouée", "skipped"));
        break;
      }

      const needsApproval = decision.requiresApproval || requiresHumanApproval(latest, tool.sensitive);
      if (simulation) {
        toolsUsed.push(traceRecord(call, "Simulée : aucune action réelle", "simulated"));
        continue;
      }
      if (needsApproval) {
        const pendingActionId = await createPendingAction({
          userId, runId: run.runId, agentType: definition.type, toolName: tool.name, toolParams: call.params,
        });
        toolsUsed.push(traceRecord(call, "En attente de validation humaine", "pending", pendingActionId));
        for (const deferred of decision.toolCalls.slice(index + 1)) {
          toolsUsed.push(traceRecord(deferred, "Différée : le cycle sera recalculé après résolution de l'approbation", "skipped"));
        }
        break;
      }
      try {
        effectStarted = true;
        const result = await tool.execute(call.params, {
          userId, agentType: definition.type, mode: "live", operationId: `${run.runId}:${index}`,
        });
        assertToolResult(result);
        toolsUsed.push(traceRecord(call, summarizeToolResult(result, privateTrace), "executed"));
      } catch (error) {
        toolsUsed.push(traceRecord(call, summarizeToolError(error, privateTrace, "Échec de l'outil"), "failed"));
        failed = true;
        for (const skipped of decision.toolCalls.slice(index + 1)) toolsUsed.push(traceRecord(skipped, "Non exécutée après un échec", "skipped"));
        break;
      }
    }
    const pending = toolsUsed.some(t => t.outcome === "pending");
    const status: AgentRunResult["status"] = failed ? "error" : cancelled ? "cancelled" : pending ? "awaiting_approval" : simulation ? "simulated" : "success";
    const outcome: AgentRunResult = minimizeRunTrace({
      status, decision: decisionText, toolsUsed, resultSummary: summarizeToolsUsed(toolsUsed), mock,
      retryable: false,
      ...(failed ? { errorMessage: "Un outil a échoué ; vérifier les effets avant toute reprise" } : {}),
    }, definition.tools, privateTrace);
    return await finishOutcome(outcome);
  } catch (error) {
    if (finalizedOutcome) {
      // The durable result is already known. A secondary state/statistics
      // failure must neither overwrite it nor replay a completed action.
      console.error("[loop] suivi secondaire indisponible ; résultat final conservé");
      return finalizedOutcome;
    }
    const outcome: AgentRunResult = minimizeRunTrace({
      status: "error", decision: decisionText, toolsUsed, resultSummary: summarizeToolsUsed(toolsUsed),
      errorMessage: summarizeToolError(error, privateTrace, "Erreur du cycle"), mock,
      // A durable execution key is already claimed. No automatic replay of it,
      // even when logging fails after a completed external action.
      retryable: !completionAttempted && !effectStarted && !executionKey && toolsUsed.length === 0,
    }, definition.tools, privateTrace);
    if (!completionAttempted) {
      await run.finish(outcome).catch(() => console.error("[loop] journalisation indisponible ; reprise automatique interdite"));
    } else {
      console.error("[loop] clôture non confirmée après réconciliation ; reprise automatique interdite");
    }
    await recordRunOutcome(userId, definition.type, "error", cycleStartedAt).catch(() => undefined);
    return outcome;
  }
}

function summarizeToolsUsed(tools: ToolCallRecord[]): string {
  const count = (outcome: ToolCallRecord["outcome"]) => tools.filter(t => t.outcome === outcome).length;
  return `${count("executed")}/${tools.length} action(s) exécutée(s), ${count("pending")} en attente, ${count("simulated")} simulée(s), ${count("failed")} en échec, ${count("skipped")} ignorée(s)`;
}
