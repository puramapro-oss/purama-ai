import { getClaudeClient } from "../claude/index.js";
import type { ModelUsageReceipt } from "../claude/usage.js";
import { isRunnable, loadAgentState, recordRunOutcome, requiresHumanApproval } from "./autonomy.js";
import { isGlobalKillSwitchActive } from "./killswitch.js";
import { startRun, type RunLogHandle } from "./logger.js";
import { notify } from "./notify.js";
import { createPendingAction } from "./approval.js";
import { armPendingBrief, claimPendingBrief, peekPendingBrief } from "./brief.js";
import { ExecutionOriginError, snapshotAgentExecutionTrigger } from "./execution-origin.js";
import { APPROVAL_CONTINUATION_GUIDANCE, ApprovalContinuationError, loadApprovalContinuation } from "./approval-continuation.js";
import { assertToolResult } from "./tool-result.js";
import { persistPrivateToolResult } from "./private-tool-results.js";
import { validateToolParams } from "./tool-input.js";
import { CustomAgentAuthorizationError, resolveAgentDefinition } from "./resolveDefinition.js";
import { minimizeRunTrace, PRIVATE_TRACE, shouldMinimizeToolTrace, summarizeToolError, summarizeToolParams, summarizeToolResult } from "./tool-trace.js";
import type { AgentDefinition, AgentRunResult, AgentTrigger, ToolCallRecord } from "./types.js";

export async function runAgentCycle(
  userId: string, definition: AgentDefinition, trigger: AgentTrigger,
  executionKey?: string, executionFingerprint?: string
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
    run = await startRun(userId, definition.type, trigger, mode, executionKey, executionFingerprint);
  } catch {
    // Admission errors remain thrown for the existing queue retry contract.
    // Do not pass raw database/provider content to callers or worker logs.
    throw new Error("Cycle temporairement indisponible : vérifier son état avant toute reprise");
  }
  // Protect context/decision failures before a model has selected any tool.
  let privateTrace = trigger.type === "delegation" || trigger.source === "approval-resume" || definition.pendingBriefKey !== undefined || definition.type.startsWith("custom:") || definition.tools.some(shouldMinimizeToolTrace);
  if (run.existingResult) return minimizeRunTrace(run.existingResult, definition.tools, privateTrace);
  const toolsUsed: ToolCallRecord[] = [];
  let decisionText = "";
  let mock = false;
  let effectStarted = false;
  let finalizedOutcome: AgentRunResult | undefined;
  let completionAttempted = false;
  let briefArmed = false;
  // Kept outside the business result: private-trace minimization must neither
  // erase this server-owned receipt nor expose it in notifications/responses.
  let modelUsage: ModelUsageReceipt | undefined;
  const finishOutcome = async (outcome: AgentRunResult): Promise<AgentRunResult> => {
    completionAttempted = true;
    const storedOutcome = modelUsage ? { ...outcome, modelUsage } : outcome;
    try {
      await run.finish(storedOutcome);
    } catch {
      // Reconcile only this same candidate; never repeat an external action.
      // The logger's conditional write makes this one bounded retry safe.
      await run.finish(storedOutcome);
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
    const continuation = await loadApprovalContinuation(userId, definition.type, trigger);
    // A resolved action does not transfer its original brief to this new run.
    // Preserve the receipt for reconciliation instead of consuming another mission.
    if (continuation && definition.pendingBriefKey !== undefined) throw new ApprovalContinuationError();
    // Capture the original authority facts before mutable business/model context.
    // A historical approval without an origin remains unknown.
    const executionTrigger = continuation ? continuation.executionTrigger
      : snapshotAgentExecutionTrigger(trigger, definition.type);
    const expectedBriefId = requestedBriefId(trigger);
    if (expectedBriefId && definition.pendingBriefKey === undefined) {
      throw new Error("Cet agent ne reçoit pas de mission par ce parcours");
    }
    const brief = definition.pendingBriefKey === undefined ? undefined : await (
      mode === "simulation" ? peekPendingBrief : claimPendingBrief
    )({ userId, agentType: definition.type, runId: run.runId, key: definition.pendingBriefKey,
      ...(expectedBriefId ? { expectedBriefId } : {}) });
    const noBrief = definition.pendingBriefKey !== undefined && brief === null;
    const baseContext = noBrief ? {} : brief
      ? await definition.buildContext(userId, trigger, { pendingBrief: brief.brief })
      : await definition.buildContext(userId, trigger);
    const context = { ...baseContext };
    // Business data may not impersonate the server's execution facts.
    delete context.kartaTrigger;
    delete context.approvalResume;
    if (continuation) context.approvalResume = continuation.context;
    if (executionTrigger?.type === "delegation") {
      context.kartaTrigger = { delegation: {
        source: executionTrigger.source, reason: executionTrigger.payload!.reason,
      } };
    }
    if (!noBrief && definition.type.startsWith("custom:")) {
      try {
        // Admission, continuation and context reads may have awaited since the
        // worker's check. Re-read authority immediately before the model call.
        // This check is not atomic with the subsequent provider request.
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
    if (!noBrief) {
      // Context, brief and ownership reads may have awaited since admission.
      // Inference itself sends data and can incur cost, before any tool runs.
      // Keep this after the custom-definition check and use a fresh global read.
      let modelAllowed: boolean;
      try {
        const latest = await loadAgentState(userId, definition.type);
        const stopped = await isGlobalKillSwitchActive(true);
        modelAllowed = !stopped && isRunnable(latest).ok && !(mode === "live" && latest.simulationMode);
      } catch {
        // Static/public agents also need a safe diagnostic at this boundary.
        throw new Error("Autorisation de l’appel au modèle non vérifiable");
      }
      if (!modelAllowed) {
        return await finishOutcome(minimizeRunTrace({
          status: "cancelled", decision: "Cycle annulé : arrêt ou autorisation modifiée avant l’appel au modèle",
          toolsUsed: [], resultSummary: "Aucune requête au modèle ni action exécutée",
          mock: false, retryable: false,
        }, definition.tools, privateTrace));
      }
    }
    const decision = noBrief ? {
      summary: "Aucune consigne en attente", toolCalls: [], requiresApproval: false, mock: false,
    } : await getClaudeClient().decide({
      systemPrompt: definition.systemPrompt + (continuation ? APPROVAL_CONTINUATION_GUIDANCE : ""),
      context, tools: definition.tools, agentType: definition.type,
      onUsage: receipt => { modelUsage ??= receipt; },
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
      let latest = await loadAgentState(userId, definition.type);
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

      if (continuation?.repeatsResolvedAction(call.tool, call.params)) {
        cancelled = true;
        skipRemaining("Action déjà résolue : aucune nouvelle exécution ni approbation");
        break;
      }

      if (simulation) {
        toolsUsed.push(traceRecord(call, "Simulée : aucune action réelle", "simulated"));
        continue;
      }
      if (brief && !briefArmed) {
        // A lost acknowledgement may still have committed the barrier. Keep
        // the claim out of automatic replay even if this await then fails.
        effectStarted = true;
        await armPendingBrief({ userId, agentType: definition.type, runId: run.runId });
        briefArmed = true;
        // Acquisition/arming adds a database round trip. Respect a stop or a
        // lowered autonomy level that arrived while that write was pending.
        latest = await loadAgentState(userId, definition.type);
        if (await isGlobalKillSwitchActive(true) || !isRunnable(latest).ok || latest.simulationMode) {
          cancelled = true;
          skipRemaining("Action annulée : arrêt ou autorisation modifiée");
          break;
        }
      }
      const needsApproval = decision.requiresApproval || requiresHumanApproval(latest, tool.sensitive);
      if (needsApproval) {
        // Pending approval creation is itself durable work: its response can
        // be lost after commit, so it must not allow an automatic duplicate.
        effectStarted = true;
        const pendingActionId = await createPendingAction({
          userId, runId: run.runId, agentType: definition.type, toolName: tool.name, toolParams: call.params,
          trigger: snapshotAgentExecutionTrigger(executionTrigger, definition.type),
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
          trigger: snapshotAgentExecutionTrigger(executionTrigger, definition.type),
        });
        // A partial result can still contain useful notices. Deliver it privately
        // before checking completion; this does not make the tool successful.
        const delivery = await persistPrivateToolResult({
          userId, agentType: definition.type, runId: run.runId,
          operationId: `${run.runId}:${index}`, toolName: tool.name, result,
        });
        if (delivery.status === "unavailable") {
          throw new Error("Résultat privé indisponible après exécution de l’outil");
        }
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
    // A live brief with no proposed action is still waiting for treatment.
    // Do not label the user's mission successful merely because inference ran.
    const unhandledBrief = Boolean(brief) && !simulation && decision.toolCalls.length === 0;
    const status: AgentRunResult["status"] = noBrief || unhandledBrief ? "skipped" : failed ? "error" : cancelled ? "cancelled" : pending ? "awaiting_approval" : simulation ? "simulated" : "success";
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
    let outcome: AgentRunResult = minimizeRunTrace({
      status: "error", decision: decisionText, toolsUsed, resultSummary: summarizeToolsUsed(toolsUsed),
      errorMessage: summarizeToolError(error, privateTrace, "Erreur du cycle"), mock,
      // A durable execution key is already claimed. No automatic replay of it,
      // even when logging fails after a completed external action.
      // A received provider response must not trigger another inference even
      // for a direct caller that omitted a durable execution key.
      retryable: !(error instanceof ApprovalContinuationError || error instanceof ExecutionOriginError) && !completionAttempted && !effectStarted && !executionKey && modelUsage === undefined && toolsUsed.length === 0,
    }, definition.tools, privateTrace);
    // This fixed server-owned explanation is safe even for private continuations.
    if (error instanceof ApprovalContinuationError || error instanceof ExecutionOriginError) outcome = { ...outcome, errorMessage: error.message };
    if (!completionAttempted) {
      await run.finish(modelUsage ? { ...outcome, modelUsage } : outcome).catch(() => {
        // A durable brief can only become available in the confirmed closing
        // transaction. Never assume that happened after a lost response.
        if (definition.pendingBriefKey !== undefined) outcome.retryable = false;
        console.error("[loop] journalisation indisponible ; reprise automatique interdite");
      });
    } else {
      console.error("[loop] clôture non confirmée après réconciliation ; reprise automatique interdite");
    }
    await recordRunOutcome(userId, definition.type, "error", cycleStartedAt).catch(() => undefined);
    return outcome;
  }
}

function requestedBriefId(trigger: AgentTrigger): string | undefined {
  if (trigger.source !== "brief-api") return undefined;
  const id = trigger.payload?.submissionId;
  if (trigger.type !== "manual" || typeof id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("Identité de mission non vérifiable");
  }
  return id;
}

function summarizeToolsUsed(tools: ToolCallRecord[]): string {
  const count = (outcome: ToolCallRecord["outcome"]) => tools.filter(t => t.outcome === outcome).length;
  return `${count("executed")}/${tools.length} action(s) exécutée(s), ${count("pending")} en attente, ${count("simulated")} simulée(s), ${count("failed")} en échec, ${count("skipped")} ignorée(s)`;
}
