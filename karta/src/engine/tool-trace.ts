import type { AgentRunResult, AnyToolDefinition, ToolCallRecord } from "./types.js";

/** These strings contain no model, request or provider content. */
export const PRIVATE_TRACE = Object.freeze({
  params: "Paramètres non conservés dans les traces",
  result: "Contenu du résultat non conservé dans les traces",
  decision: "Contenu de la décision non conservé dans les traces",
  error: "Détail de l’erreur non conservé dans les traces ; vérifier l’état de l’action",
  unknownTool: "unknown_tool",
});

/** An unknown tool is never a safe source of telemetry, including its name. */
export function shouldMinimizeToolTrace(tool: AnyToolDefinition | undefined): boolean {
  return !tool || tool.tracePolicy === "metadata_only";
}

export function summarizeToolParams(params: unknown, privateTrace: boolean): string {
  if (privateTrace) return PRIVATE_TRACE.params;
  try { return JSON.stringify(params) ?? "Paramètres absents"; }
  catch { return "Paramètres non sérialisables"; }
}

export function summarizeToolResult(result: unknown, privateTrace: boolean): string {
  if (privateTrace) return PRIVATE_TRACE.result;
  if (result === undefined || result === null) return "ok";
  if (typeof result === "string") return result.slice(0, 200);
  try { return JSON.stringify(result)?.slice(0, 200) ?? "Résultat non sérialisable"; }
  catch { return "Résultat non sérialisable"; }
}

export function summarizeToolError(error: unknown, privateTrace: boolean, fallback: string): string {
  if (privateTrace) return PRIVATE_TRACE.error;
  return error instanceof Error ? error.message : fallback;
}

function metadataResultSummary(outcome: ToolCallRecord["outcome"]): string {
  switch (outcome) {
    case "executed": return "Action exécutée ; contenu du résultat non conservé";
    case "failed": return "Action en échec ; détail non conservé";
    case "pending": return "En attente de validation humaine";
    case "simulated": return "Simulée : aucune action réelle";
    case "skipped": return "Action non exécutée";
    case "rejected": return "Action rejetée";
    default: return PRIVATE_TRACE.result;
  }
}

/**
 * Minimize a run before it leaves the engine, including an idempotent replay of
 * an older journal. Do not rewrite stored history or mutate business payloads.
 * Known tool names, outcomes and server-created approval IDs remain available.
 */
export function minimizeRunTrace(
  result: AgentRunResult,
  tools: readonly AnyToolDefinition[],
  force = false,
): AgentRunResult {
  const records = Array.isArray(result.toolsUsed) ? result.toolsUsed : [];
  const privateTrace = force || tools.some(shouldMinimizeToolTrace) ||
    records.some(record => record?.tracePolicy === "metadata_only" ||
      shouldMinimizeToolTrace(tools.find(tool => tool.name === record?.tool)));
  if (!privateTrace) return result;

  const outcomes: readonly ToolCallRecord["outcome"][] = [
    "executed", "failed", "pending", "simulated", "skipped", "rejected",
  ];
  const safeRecords = records.map((record): ToolCallRecord => {
    const known = tools.find(tool => tool.name === record?.tool);
    const outcome = outcomes.includes(record?.outcome) ? record.outcome : undefined;
    return {
      tool: known?.name ?? PRIVATE_TRACE.unknownTool,
      tracePolicy: "metadata_only",
      paramsSummary: PRIVATE_TRACE.params,
      resultSummary: metadataResultSummary(outcome),
      success: record?.success === true,
      ...(outcome ? { outcome } : {}),
      ...(typeof record?.pendingActionId === "string" ? { pendingActionId: record.pendingActionId } : {}),
    };
  });
  // Migration 006 also recognizes pre-outcome records by success, provided
  // they are not waiting on an approval. Preserve that historical evidence.
  const count = (outcome: ToolCallRecord["outcome"]) => safeRecords.filter(record =>
    record.outcome === outcome || (!record.outcome && !record.pendingActionId &&
      ((outcome === "executed" && record.success) || (outcome === "failed" && !record.success)))
  ).length;
  return {
    status: result.status,
    decision: PRIVATE_TRACE.decision,
    toolsUsed: safeRecords,
    resultSummary: `${count("executed")}/${safeRecords.length} action(s) exécutée(s), ${count("pending")} en attente, ${count("simulated")} simulée(s), ${count("failed")} en échec, ${count("skipped")} ignorée(s)`,
    ...(result.errorMessage !== undefined ? { errorMessage: PRIVATE_TRACE.error } : {}),
    mock: result.mock === true,
    ...(typeof result.retryable === "boolean" ? { retryable: result.retryable } : {}),
  };
}
