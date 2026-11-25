import { getClaudeClient } from "../claude/index.js";
import { config } from "../config.js";
import { bounded } from "../runtime/lifecycle.js";
import { programmaticUsageEnvelope, type ModelUsageReceipt, type RunModelUsageEnvelope } from "../claude/usage.js";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";
import type { ClaudeDecideInput } from "../claude/types.js";
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
import { validateProgrammaticToolParams, validateToolParams } from "./tool-input.js";
import { CustomAgentAuthorizationError, resolveAgentDefinition } from "./resolveDefinition.js";
import { minimizeRunTrace, PRIVATE_TRACE, shouldMinimizeToolTrace, summarizeToolError, summarizeToolParams, summarizeToolResult } from "./tool-trace.js";
import type { AgentDecision, AgentDefinition, AgentRunResult, AgentState, AgentTrigger, AnyToolDefinition, ToolCallRecord } from "./types.js";

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
  let briefArming: Promise<void> | undefined;
  // Kept outside the business result: private-trace minimization must neither
  // erase this server-owned receipt nor expose it in notifications/responses.
  let modelUsage: RunModelUsageEnvelope | undefined;
  let programmaticRequestAdmitted = false;
  let closeProgrammaticReads = () => {};
  const finishOutcome = async (outcome: AgentRunResult): Promise<AgentRunResult> => {
    closeProgrammaticReads();
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
      ? await definition.buildContext(userId, trigger, {
        pendingBrief: brief.brief,
        // Use the server's selection setting without instantiating a model
        // client before the fresh authorization gate below.
        executionMode: mode === "simulation" || config.mockClaude !== false ? "simulation" : "live",
      })
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
    // A custom definition can be stale after context preparation. Only the
    // freshly authorized row below may supply its explicit model preference.
    let modelPreferences = definition.type.startsWith("custom:") ? undefined : definition.modelPreferences;
    if (!noBrief && definition.type.startsWith("custom:")) {
      try {
        // Admission, continuation and context reads may have awaited since the
        // worker's check. Re-read authority immediately before the model call.
        // This check is not atomic with the subsequent provider request.
        const currentDefinition = await resolveAgentDefinition(definition.type, userId);
        if (!currentDefinition || currentDefinition.type !== definition.type) throw new CustomAgentAuthorizationError();
        modelPreferences = currentDefinition.modelPreferences === undefined
          ? undefined : { ...currentDefinition.modelPreferences };
      } catch (error) {
        if (!(error instanceof CustomAgentAuthorizationError)) throw error;
        return await finishOutcome(minimizeRunTrace({
          status: "cancelled", decision: "Cycle annulé : autorisation modifiée avant l’appel au modèle",
          toolsUsed: [], resultSummary: "Aucune requête au modèle ni action exécutée",
          mock: false, retryable: false,
        }, definition.tools, true));
      }
    }
    let modelState: AgentState | undefined;
    if (!noBrief) {
      // Context, brief and ownership reads may have awaited since admission.
      // Inference itself sends data and can incur cost, before any tool runs.
      // Keep this after the custom-definition check and use a fresh global read.
      let modelAllowed: boolean;
      try {
        const latest = await loadAgentState(userId, definition.type);
        const stopped = await isGlobalKillSwitchActive(true);
        modelState = latest;
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
    type Call = AgentDecision["toolCalls"][number];
    type CallOutcome = { kind: "executed"; result: unknown }
      | { kind: "simulated" }
      | { kind: "failed" | "cancelled" | "pending"; reason: string; includeCurrent?: boolean };
    type ReadInvocation = { call: Call; recorded: boolean; started: boolean; settled: boolean };
    let nextOperation = 0;
    let programmaticOpen = true;
    let programmaticFailed = false;
    let successfulReads = 0;
    let resultBytes = 0;
    const invocations = new Map<string, ReadInvocation>();
    const usageResponses: Array<{ receipt: ModelUsageReceipt; codeExecutionRequests: number | null }> = [];
    const readError = () => new Error("Lecture programmatique interrompue ou non autorisée : aucune continuation disponible");
    const traceRecord = (
      call: Call,
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
    const assertReadActive = (signal: AbortSignal) => {
      if (!programmaticOpen || programmaticFailed || completionAttempted || signal.aborted) throw readError();
    };
    closeProgrammaticReads = () => {
      if (!programmaticOpen) return;
      programmaticOpen = false;
      // An ignored abort can leave an external read in flight. Close its
      // observation now; late fulfillment cannot mutate the immutable journal.
      for (const invocation of invocations.values()) {
        if (!invocation.recorded) {
          toolsUsed.push(traceRecord(invocation.call,
            invocation.started ? "Lecture interrompue : résultat non confirmé" : "Lecture non exécutée : cycle terminé",
            invocation.started ? "failed" : "skipped"));
          invocation.recorded = true;
        }
      }
    };
    const qualifiedRead = (tool: AnyToolDefinition) => (tool.name === "knowledge_search" || tool.name === "web_search")
      && Object.hasOwn(tool, "programmaticRead") && tool.programmaticRead === true
      && tool.sensitive === false && tool.requiresExplicitApproval === undefined;
    // Snapshot the server catalogue, not a provider/model-supplied list.
    const readTools = new Map(definition.tools.map(tool => [tool.name, tool]));
    const client = noBrief ? undefined : getClaudeClient();
    const ownerUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
    // The existing private product-result store and reader are custom-agent
    // scoped. Never activate a route whose final answer cannot be delivered.
    const canDeliverReport = definition.type.startsWith("custom:")
      && ownerUuid.test(definition.type.slice("custom:".length))
      && ownerUuid.test(userId) && ownerUuid.test(run.runId);
    const readEligible = canDeliverReport && config.anthropicProgrammaticReads === "on" && config.mockClaude === false
      && client?.isMock === false && mode === "live" && (modelState?.autonomyLevel ?? 0) >= 2
      && definition.tools.length > 0 && definition.tools.every(qualifiedRead)
      && readTools.size === definition.tools.length;
    const originalReadContracts = new Map((readEligible ? [...readTools] : []).map(([name, tool]) => [name, {
      execute: tool.execute, schema: structuredClone(tool.inputSchema), tracePolicy: tool.tracePolicy,
    }]));
    const originalPreferences = !readEligible || modelPreferences === undefined ? undefined : structuredClone(modelPreferences);
    const assertReadDefinition = (current: AgentDefinition | undefined): AgentDefinition => {
      if (!current || current.type !== definition.type
        || !isDeepStrictEqual(current.modelPreferences, originalPreferences)
        || current.tools.length !== definition.tools.length
        || current.tools.some(tool => {
          const original = originalReadContracts.get(tool.name);
          return !original || !qualifiedRead(tool) || tool.execute !== original.execute
            || !isDeepStrictEqual(tool.inputSchema, original.schema) || tool.tracePolicy !== original.tracePolicy;
        }) || new Set(current.tools.map(tool => tool.name)).size !== readTools.size) throw readError();
      return current;
    };
    const verifyReadDefinition = async (signal: AbortSignal): Promise<AgentDefinition> => {
      assertReadActive(signal);
      const current = definition.type.startsWith("custom:")
        ? await resolveAgentDefinition(definition.type, userId) : definition;
      assertReadActive(signal);
      return assertReadDefinition(current);
    };
    const beforeReadRequest = async (signal: AbortSignal): Promise<void> => {
      // Activation happens only when the qualified native transport asks for
      // this bridge. Merely offering it cannot change the direct route's trace.
      privateTrace = true;
      try {
        const current = await verifyReadDefinition(signal);
        assertReadActive(signal);
        const latest = await loadAgentState(userId, definition.type);
        assertReadActive(signal);
        const stopped = await isGlobalKillSwitchActive(true);
        assertReadActive(signal);
        if (stopped || !isRunnable(latest).ok || latest.simulationMode || latest.autonomyLevel < 2) throw readError();
        assertReadDefinition(current);
        // Admission can be followed by a billed request whose response is lost.
        // An absent usage receipt does not make automatic replay safe.
        programmaticRequestAdmitted = true;
      } catch {
        programmaticFailed = true;
        throw readError();
      }
    };

    /** One execution authority for direct and programmatic calls. PTC adds
     * read-only admission, but cannot bypass the existing tool/brief gates. */
    const executeCall = async (call: Call, options: {
      simulation: boolean; requiresApproval: boolean;
      read?: { signal: AbortSignal; invocation: ReadInvocation };
    }): Promise<CallOutcome> => {
      const active = () => { if (options.read) assertReadActive(options.read.signal); };
      const record = (summary: string, outcome: NonNullable<ToolCallRecord["outcome"]>, pendingId?: string) => {
        active();
        toolsUsed.push(traceRecord(call, summary, outcome, pendingId));
        if (options.read) options.read.invocation.recorded = true;
      };
      active();
      const ordinal = nextOperation++;
      let tool = definition.tools.find(t => t.name === call.tool);
      let currentReadDefinition: AgentDefinition | undefined;
      if (options.read) {
        currentReadDefinition = await verifyReadDefinition(options.read.signal);
        active();
        tool = currentReadDefinition.tools.find(candidate => candidate.name === call.tool);
      } else if (definition.type.startsWith("custom:")) {
        try {
          const current = await resolveAgentDefinition(definition.type, userId);
          const authorizedTool = current.tools.find(candidate => candidate.name === call.tool);
          if (!authorizedTool) return { kind: "cancelled", reason: "Droits de l’agent modifiés : action non exécutée", includeCurrent: true };
          if (tool) tool = authorizedTool;
        } catch (error) {
          return { kind: error instanceof CustomAgentAuthorizationError ? "cancelled" : "failed",
            reason: error instanceof CustomAgentAuthorizationError
              ? "Droits de l’agent modifiés : action non exécutée" : "Autorisations non vérifiables : action non exécutée",
            includeCurrent: true };
        }
      }
      // Fresh definition resolution must precede final state/stop reads.
      let latest = await loadAgentState(userId, definition.type);
      active();
      const stopped = await isGlobalKillSwitchActive(true);
      active();
      if (stopped || !isRunnable(latest).ok || (mode === "live" && latest.simulationMode)
        || (options.read && latest.autonomyLevel < 2)) {
        return { kind: "cancelled", reason: "Action annulée : arrêt ou autorisation modifiée", includeCurrent: true };
      }
      if (!tool) {
        record("Outil inconnu", "failed");
        return { kind: "failed", reason: "Non exécutée après un échec" };
      }
      try {
        if (options.read) {
          if (!qualifiedRead(tool)) throw readError();
          validateProgrammaticToolParams(tool, call.params);
        } else validateToolParams(tool, call.params);
      } catch (validationError) {
        record(summarizeToolError(validationError, privateTrace, "Paramètres invalides"), "failed");
        return { kind: "failed", reason: "Non exécutée après une validation de paramètres échouée" };
      }
      if (continuation?.repeatsResolvedAction(call.tool, call.params)) {
        return { kind: "cancelled", reason: "Action déjà résolue : aucune nouvelle exécution ni approbation", includeCurrent: true };
      }
      if (options.simulation) {
        if (options.read) throw readError();
        record("Simulée : aucune action réelle", "simulated");
        return { kind: "simulated" };
      }
      if (brief && !briefArmed) {
        effectStarted = true;
        briefArming ??= armPendingBrief({ userId, agentType: definition.type, runId: run.runId });
        await briefArming;
        active();
        briefArmed = true;
        latest = await loadAgentState(userId, definition.type);
        active();
        const stoppedAfterArm = await isGlobalKillSwitchActive(true);
        active();
        if (stoppedAfterArm || !isRunnable(latest).ok || latest.simulationMode
          || (options.read && latest.autonomyLevel < 2)) {
          return { kind: "cancelled", reason: "Action annulée : arrêt ou autorisation modifiée", includeCurrent: true };
        }
      }
      const needsApproval = tool.requiresExplicitApproval || options.requiresApproval || requiresHumanApproval(latest, tool.sensitive);
      if (needsApproval) {
        if (options.read) throw readError();
        // Native PTC returns no deferred direct calls. Keep alternate clients
        // from creating an approval parent with already executed PTC reads:
        // the durable approval-resume contract cannot replay that ancestry.
        if (invocations.size > 0) return { kind: "cancelled",
          reason: "Action annulée : validation humaine requise après une lecture programmatique", includeCurrent: true };
        effectStarted = true;
        const pendingActionId = await createPendingAction({
          userId, runId: run.runId, agentType: definition.type, toolName: tool.name, toolParams: call.params,
          trigger: snapshotAgentExecutionTrigger(executionTrigger, definition.type),
        });
        record("En attente de validation humaine", "pending", pendingActionId);
        return { kind: "pending", reason: "Différée : le cycle sera recalculé après résolution de l'approbation" };
      }
      try {
        active();
        if (options.read) {
          // State/stop/brief checks awaited after the original qualification.
          // Recheck the same server-owned contracts synchronously and pin the
          // handler before invoking it; mutable objects cannot substitute code.
          assertReadDefinition(currentReadDefinition);
          if (tool.name !== call.tool || tool.execute !== originalReadContracts.get(call.tool)?.execute) throw readError();
        }
        const handler = tool.execute;
        effectStarted = true;
        if (options.read) options.read.invocation.started = true;
        const result = await handler.call(tool, call.params, {
          userId, agentType: definition.type, mode: "live", operationId: `${run.runId}:${ordinal}`,
          trigger: snapshotAgentExecutionTrigger(executionTrigger, definition.type),
        });
        active();
        // Preserve useful partial notices privately before asserting success.
        const delivery = await persistPrivateToolResult({
          userId, agentType: definition.type, runId: run.runId,
          operationId: `${run.runId}:${ordinal}`, toolName: tool.name, result,
        });
        active();
        if (delivery.status === "unavailable") throw new Error("Résultat privé indisponible après exécution de l’outil");
        assertToolResult(result);
        if (options.read) {
          await beforeReadRequest(options.read.signal);
          active();
        }
        record(summarizeToolResult(result, privateTrace), "executed");
        return { kind: "executed", result };
      } catch (error) {
        active();
        record(summarizeToolError(error, privateTrace, "Échec de l'outil"), "failed");
        return { kind: "failed", reason: "Non exécutée après un échec" };
      }
    };
    const programmaticReads: ClaudeDecideInput["programmaticReads"] = readEligible ? {
      toolNames: Object.freeze([...readTools.keys()]),
      beforeRequest: beforeReadRequest,
      execute: async (call, signal) => {
        privateTrace = true;
        let invocation: ReadInvocation | undefined;
        try {
          assertReadActive(signal);
          if (typeof call.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$(?![\s\S])/.test(call.id)
            || invocations.has(call.id) || invocations.size >= 16) throw readError();
          const tool = readTools.get(call.tool);
          if (!tool) throw readError();
          // Validate inert input before snapshotting and before any await.
          validateProgrammaticToolParams(tool, call.params);
          const captured: Call = { tool: tool.name, params: structuredClone(call.params) };
          invocation = { call: captured, recorded: false, started: false, settled: false };
          invocations.set(call.id, invocation);
          const outcome = await executeCall(captured, { simulation: false, requiresApproval: false,
            read: { signal, invocation } });
          assertReadActive(signal);
          if (outcome.kind !== "executed") {
            if ("includeCurrent" in outcome && outcome.includeCurrent && !invocation.recorded) {
              toolsUsed.push(traceRecord(captured, outcome.reason, "skipped"));
              invocation.recorded = true;
            }
            throw readError();
          }
          const text = serializeProgrammaticResult(outcome.result);
          const bytes = Buffer.byteLength(text, "utf8");
          if (resultBytes + bytes > 262_144) throw readError();
          resultBytes += bytes;
          successfulReads++;
          invocation.settled = true;
          return text;
        } catch {
          if (programmaticOpen) {
            programmaticFailed = true;
            if (invocation) invocation.settled = true;
          }
          throw readError();
        }
      },
    } : undefined;
    let decision: AgentDecision;
    try {
      decision = noBrief ? {
        summary: "Aucune consigne en attente", toolCalls: [], requiresApproval: false, mock: false,
      } : await client!.decide({
        systemPrompt: definition.systemPrompt + (continuation ? APPROVAL_CONTINUATION_GUIDANCE : ""),
        context, tools: definition.tools, agentType: definition.type,
        ...(modelPreferences !== undefined ? { preferences: modelPreferences } : {}),
        ...(programmaticReads ? { programmaticReads } : {}),
        onUsage: (receipt, programmatic) => {
          if (!programmaticOpen) return;
          if (programmatic) {
            privateTrace = true;
            usageResponses.push({ receipt, codeExecutionRequests: programmatic.codeExecutionRequests });
            modelUsage = programmaticUsageEnvelope(usageResponses);
          } else modelUsage ??= receipt;
        },
      });
      if (programmaticFailed || [...invocations.values()].some(invocation => !invocation.settled)) throw readError();
      if ((programmaticRequestAdmitted || invocations.size > 0) && decision.mock) throw readError();
    } finally {
      closeProgrammaticReads();
    }
    let programmaticReportStored = false;
    if (programmaticRequestAdmitted) {
      // The native continuation returns a conclusion, never deferred actions.
      // A callback-only fixture or an unqualified provider is not proof of a
      // completed hosted conversation and cannot manufacture a product report.
      if (!programmaticReads || !canDeliverReport || decision.mock || decision.requiresApproval
        || decision.toolCalls.length !== 0 || typeof decision.summary !== "string" || !decision.summary.trim()
        || !modelUsage || modelUsage.version !== 2 || modelUsage.routeKind !== "anthropic"
        || modelUsage.responses.length === 0
        || modelUsage.responses.some(response => response.receipt.routeKind !== "anthropic")) throw readError();
      const report = {
        summary: decision.summary,
        read_tools: [...new Set(toolsUsed.filter(record => record.outcome === "executed").map(record => record.tool))],
      };
      const reportError = () => new Error("Rapport privé indisponible : livraison non confirmée");
      const expiresAt = performance.now() + 5000;
      // The transport's signal has already ended. A separate bounded delivery
      // protects the product result without restarting inference or its reads.
      await bounded(async signal => {
        const active = () => {
          if (signal.aborted || performance.now() >= expiresAt || completionAttempted || finalizedOutcome) throw reportError();
        };
        const authorizeDelivery = async () => {
          active();
          const current = await resolveAgentDefinition(definition.type, userId);
          active();
          assertReadDefinition(current);
          const latest = await loadAgentState(userId, definition.type);
          active();
          const stopped = await isGlobalKillSwitchActive(true);
          active();
          if (stopped || !isRunnable(latest).ok || latest.simulationMode || latest.autonomyLevel < 2) throw reportError();
          assertReadDefinition(current);
        };
        await authorizeDelivery();
        active();
        if (brief && !briefArmed) {
          effectStarted = true;
          briefArming ??= armPendingBrief({ userId, agentType: definition.type, runId: run.runId });
          await briefArming;
          active();
          briefArmed = true;
          await authorizeDelivery();
          active();
        }
        effectStarted = true;
        const delivery = await persistPrivateToolResult({
          userId, agentType: definition.type, runId: run.runId,
          operationId: `${run.runId}:${nextOperation++}`, toolName: "programmatic_report", result: report,
        });
        active();
        if (delivery.status !== "stored") throw reportError();
      }, 5000);
      programmaticReportStored = true;
    } else if (modelUsage?.version === 2) {
      throw readError();
    }
    privateTrace ||= decision.toolCalls.some(call =>
      shouldMinimizeToolTrace(definition.tools.find(tool => tool.name === call.tool)));
    decisionText = privateTrace ? PRIVATE_TRACE.decision : decision.summary;
    mock = decision.mock;
    const simulation = mode === "simulation" || mock;
    let cancelled = false;
    let failed = false;
    for (let index = 0; index < decision.toolCalls.length; index++) {
      const outcome = await executeCall(decision.toolCalls[index], {
        simulation, requiresApproval: decision.requiresApproval,
      });
      if (outcome.kind === "executed" || outcome.kind === "simulated") continue;
      cancelled ||= outcome.kind === "cancelled";
      failed ||= outcome.kind === "failed";
      for (const skipped of decision.toolCalls.slice(index + (outcome.includeCurrent ? 0 : 1))) {
        toolsUsed.push(traceRecord(skipped, outcome.reason, "skipped"));
      }
      break;
    }
    const pending = toolsUsed.some(t => t.outcome === "pending");
    // A live brief with no proposed action is still waiting for treatment.
    // Do not label the user's mission successful merely because inference ran.
    const unhandledBrief = Boolean(brief) && !simulation && decision.toolCalls.length === 0 && successfulReads === 0 && !programmaticReportStored;
    const status: AgentRunResult["status"] = noBrief || unhandledBrief ? "skipped" : failed ? "error" : cancelled ? "cancelled" : pending ? "awaiting_approval" : simulation ? "simulated" : "success";
    const outcome: AgentRunResult = minimizeRunTrace({
      status, decision: decisionText, toolsUsed, resultSummary: summarizeToolsUsed(toolsUsed), mock,
      retryable: false,
      ...(failed ? { errorMessage: "Un outil a échoué ; vérifier les effets avant toute reprise" } : {}),
    }, definition.tools, privateTrace);
    return await finishOutcome(outcome);
  } catch (error) {
    closeProgrammaticReads();
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
      retryable: !(error instanceof ApprovalContinuationError || error instanceof ExecutionOriginError) && !completionAttempted && !effectStarted && !programmaticRequestAdmitted && !executionKey && modelUsage === undefined && toolsUsed.length === 0,
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

/** Complete inert JSON only: never run tool-result accessors/toJSON, silently
 * truncate evidence, or let one read allocate an unbounded provider message. */
function serializeProgrammaticResult(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const invalid = (): never => { throw new Error("Résultat programmatique indisponible ou trop volumineux"); };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 16_384 || depth > 32) return invalid();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : invalid();
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      if (bytes > 65_536) return invalid();
      return item;
    }
    if (typeof item !== "object" || isProxy(item) || seen.has(item)) return invalid();
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Reflect.ownKeys(item);
    if (keys.length > 16_384) return invalid();
    seen.add(item);
    try {
      if (Array.isArray(item)) {
        const length = Object.getOwnPropertyDescriptor(item, "length")?.value as unknown;
        if (typeof length !== "number" || length > 16_384 || keys.length !== length + 1) return invalid();
        return Array.from({ length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
          if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
          return visit(descriptor.value, depth + 1);
        });
      }
      const output: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (typeof key !== "string") return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
        bytes += Buffer.byteLength(key, "utf8");
        if (bytes > 65_536) return invalid();
        output[key] = visit(descriptor.value, depth + 1);
      }
      return output;
    } finally { seen.delete(item); }
  };
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text, "utf8") > 65_536) return invalid();
  return text;
}
