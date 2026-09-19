import { getClaudeClient } from "../claude/index.js";
import { isRunnable, loadAgentState, recordRunOutcome, requiresHumanApproval } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { startRun } from "./logger.js";
import { notify } from "./notify.js";
import { createPendingAction } from "./approval.js";
import { assertToolResult } from "./tool-result.js";
import type { AgentDefinition, AgentRunResult, AgentTrigger, ToolCallRecord } from "./types.js";

export async function runAgentCycle(
  userId: string, definition: AgentDefinition, trigger: AgentTrigger, executionKey?: string
): Promise<AgentRunResult> {
  if (await isGlobalKillSwitchActive(true)) {
    return { status: "skipped", decision: "Cycle ignoré : arrêt global actif", toolsUsed: [], resultSummary: "Aucune action exécutée", mock: false };
  }
  const state = await loadAgentState(userId, definition.type);
  const runnable = isRunnable(state);
  if (!runnable.ok) {
    await recordRunOutcome(userId, definition.type, "skipped");
    return { status: "skipped", decision: runnable.reason, toolsUsed: [], resultSummary: "Aucune action exécutée", mock: false };
  }
  const mode = state.simulationMode ? "simulation" : "live";
  const run = await startRun(userId, definition.type, trigger, mode, executionKey);
  if (run.existingResult) return run.existingResult;
  const toolsUsed: ToolCallRecord[] = [];
  let decisionText = "";
  let mock = false;
  let effectStarted = false;

  try {
    const context = await definition.buildContext(userId, trigger);
    const decision = await getClaudeClient().decide({
      systemPrompt: definition.systemPrompt, context, tools: definition.tools, agentType: definition.type,
    });
    decisionText = decision.summary;
    mock = decision.mock;
    const simulation = mode === "simulation" || mock;
    let cancelled = false;
    let failed = false;

    for (let index = 0; index < decision.toolCalls.length; index++) {
      const call = decision.toolCalls[index];
      const skipRemaining = (reason: string) => {
        for (const skipped of decision.toolCalls.slice(index)) toolsUsed.push({
          tool: skipped.tool, paramsSummary: JSON.stringify(skipped.params), resultSummary: reason, success: false, outcome: "skipped",
        });
      };
      const latest = await loadAgentState(userId, definition.type);
      if (await isGlobalKillSwitchActive(true) || !isRunnable(latest).ok || (mode === "live" && latest.simulationMode)) {
        cancelled = true;
        skipRemaining("Action annulée : arrêt ou autorisation modifiée");
        break;
      }
      const tool = definition.tools.find(t => t.name === call.tool);
      if (!tool) {
        toolsUsed.push({ tool: call.tool, paramsSummary: JSON.stringify(call.params), resultSummary: "Outil inconnu", success: false, outcome: "failed" });
        failed = true;
        for (const skipped of decision.toolCalls.slice(index + 1)) toolsUsed.push({
          tool: skipped.tool, paramsSummary: JSON.stringify(skipped.params), resultSummary: "Non exécutée après un échec", success: false, outcome: "skipped",
        });
        break;
      }
      const needsApproval = decision.requiresApproval || requiresHumanApproval(latest, tool.sensitive);
      if (simulation || needsApproval) {
        const pendingActionId = !simulation ? await createPendingAction({
          userId, runId: run.runId, agentType: definition.type, toolName: tool.name, toolParams: call.params,
        }) : undefined;
        toolsUsed.push({
          tool: tool.name, paramsSummary: JSON.stringify(call.params),
          resultSummary: simulation ? "Simulée : aucune action réelle" : "En attente de validation humaine",
          success: false, outcome: simulation ? "simulated" : "pending", pendingActionId,
        });
        continue;
      }
      try {
        effectStarted = true;
        const result = await tool.execute(call.params, {
          userId, agentType: definition.type, mode: "live", operationId: `${run.runId}:${index}`,
        });
        assertToolResult(result);
        toolsUsed.push({ tool: tool.name, paramsSummary: JSON.stringify(call.params), resultSummary: summarize(result), success: true, outcome: "executed" });
      } catch (error) {
        toolsUsed.push({ tool: tool.name, paramsSummary: JSON.stringify(call.params), resultSummary: error instanceof Error ? error.message : "Échec de l'outil", success: false, outcome: "failed" });
        failed = true;
        for (const skipped of decision.toolCalls.slice(index + 1)) toolsUsed.push({
          tool: skipped.tool, paramsSummary: JSON.stringify(skipped.params), resultSummary: "Non exécutée après un échec", success: false, outcome: "skipped",
        });
        break;
      }
    }
    const pending = toolsUsed.some(t => t.outcome === "pending");
    const status: AgentRunResult["status"] = failed ? "error" : cancelled ? "cancelled" : pending ? "awaiting_approval" : simulation ? "simulated" : "success";
    const outcome: AgentRunResult = {
      status, decision: decisionText, toolsUsed, resultSummary: summarizeToolsUsed(toolsUsed), mock,
      retryable: false,
      ...(failed ? { errorMessage: "Un outil a échoué ; vérifier les effets avant toute reprise" } : {}),
    };
    await run.finish(outcome);
    if (pending) {
      try {
        await notify({
          userId, agentType: definition.type, title: `${definition.type} : action en attente de validation`,
          body: decisionText, actionType: "review", actionUrl: "/dashboard/employees", priority: "normal",
          channels: ["in_app", "push", "email"],
        });
      } catch { console.error("[loop] notification indisponible ; action conservée en attente"); }
    }
    await recordRunOutcome(userId, definition.type, status);
    return outcome;
  } catch (error) {
    const outcome: AgentRunResult = {
      status: "error", decision: decisionText, toolsUsed, resultSummary: summarizeToolsUsed(toolsUsed),
      errorMessage: error instanceof Error ? error.message : "Erreur du cycle", mock,
      // A durable execution key is already claimed. No automatic replay of it,
      // even when logging fails after a completed external action.
      retryable: !effectStarted && !executionKey && toolsUsed.length === 0,
    };
    await run.finish(outcome).catch(() => console.error("[loop] journalisation indisponible ; reprise automatique interdite"));
    await recordRunOutcome(userId, definition.type, "error").catch(() => undefined);
    return outcome;
  }
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result.slice(0, 200);
  try { return JSON.stringify(result).slice(0, 200); } catch { return "Résultat non sérialisable"; }
}

function summarizeToolsUsed(tools: ToolCallRecord[]): string {
  const count = (outcome: ToolCallRecord["outcome"]) => tools.filter(t => t.outcome === outcome).length;
  return `${count("executed")}/${tools.length} action(s) exécutée(s), ${count("pending")} en attente, ${count("simulated")} simulée(s), ${count("failed")} en échec, ${count("skipped")} ignorée(s)`;
}
