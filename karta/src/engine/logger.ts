import { supabase } from "../db/supabase.js";
import { isDeepStrictEqual } from "node:util";
import type { AgentTrigger, AgentType, ToolCallRecord, AgentRunResult } from "./types.js";
import type { ModelUsageReceipt } from "../claude/usage.js";

export interface RunLogHandle {
  runId: string;
  existingResult?: AgentRunResult;
  /**
   * First outcome wins. It is copied before the first write; concurrent calls
   * share that write, and a retry only reconciles that same frozen outcome.
   * A successful close is never rewritten, even if a later caller passes a
   * different result after a bookkeeping failure.
   */
  finish: (outcome: {
    status: AgentRunResult["status"];
    decision: string;
    toolsUsed: ToolCallRecord[];
    resultSummary: string;
    errorMessage?: string;
    mock: boolean;
    /** Provider metadata only; omitted means unknown, never a zero-cost claim. */
    modelUsage?: ModelUsageReceipt;
  }) => Promise<void>;
}

/**
 * Ouvre une entrée immuable dans karta_runs (status "running"), retourne un handle
 * pour la clôturer. Aucune UPDATE de contenu métier après clôture — seul le statut/résultat
 * final est écrit une fois (pas de ré-écriture ultérieure), conformément à "logs immuables".
 */
export async function startRun(
  userId: string,
  agentType: AgentType,
  trigger: AgentTrigger,
  mode: "simulation" | "live",
  executionKey?: string,
  executionFingerprint?: string
): Promise<RunLogHandle> {
  if (executionFingerprint !== undefined
    && (!executionKey || !/^[0-9a-f]{64}$/.test(executionFingerprint))) {
    throw new Error("Identité de demande non vérifiable");
  }
  const startedAt = Date.now();

  const { data, error } = await supabase
    .from("karta_runs")
    .insert({
      user_id: userId,
      agent_type: agentType,
      trigger_type: trigger.type,
      trigger_source: trigger.source,
      mode,
      status: "running",
      ...(executionKey ? { execution_key: executionKey } : {}),
      ...(executionFingerprint !== undefined ? { execution_fingerprint: executionFingerprint } : {}),
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505" && executionKey) {
      const prior = await supabase.from("karta_runs").select("*")
        .eq("execution_key", executionKey).eq("user_id", userId).eq("agent_type", agentType).single();
      if (prior.error || !prior.data) throw new Error("Impossible de vérifier l'exécution précédente");
      const row = prior.data;
      if (executionFingerprint !== undefined && row.execution_fingerprint !== executionFingerprint) {
        // A unique key alone cannot prove that a retried request has the same
        // content. Never return an unrelated success or disclose its payload.
        return {
          runId: row.id,
          existingResult: {
            status: "error", decision: "Demande non exécutée", toolsUsed: [],
            resultSummary: "Identité déjà réservée avec un contenu différent ou non vérifiable",
            errorMessage: "Vérifier la demande précédente avant toute nouvelle action",
            mock: false, retryable: false,
          },
          finish: async () => { throw new Error("Une exécution déjà réservée ne doit pas être réécrite"); },
        };
      }
      const known = ["success", "error", "awaiting_approval", "skipped", "cancelled", "simulated", "partial"].includes(row.status);
      return {
        runId: row.id,
        existingResult: {
          status: known ? row.status : "error",
          decision: row.decision ?? "",
          toolsUsed: Array.isArray(row.tools_used) ? row.tools_used : [],
          resultSummary: row.result_summary ?? "Exécution déjà réservée : vérifier son résultat avant toute reprise",
          errorMessage: known ? row.error_message ?? undefined : "Résultat de l'exécution précédente à réconcilier",
          mock: row.claude_mock === true,
          retryable: false,
        },
        finish: async () => { throw new Error("Une exécution déjà réservée ne doit pas être réécrite"); },
      };
    }
    throw new Error(`startRun(${agentType}): ${error.message}`);
  }

  const runId = data.id as string;
  let firstCompletion: CompletionPatch | undefined;
  let finalized = false;
  let inFlight: Promise<void> | undefined;

  return {
    runId,
    finish: (outcome) => {
      if (finalized) return Promise.resolve();
      if (!firstCompletion) {
        firstCompletion = {
          status: outcome.status,
          mode: outcome.status === "simulated" ? "simulation" : mode,
          decision: outcome.decision,
          // Copy the exact JSON sent to PostgreSQL, including omission of
          // undefined optional fields, so a lost acknowledgement can reconcile.
          tools_used: JSON.parse(JSON.stringify(outcome.toolsUsed)) as ToolCallRecord[],
          result_summary: outcome.resultSummary,
          error_message: outcome.errorMessage ?? null,
          claude_mock: outcome.mock,
          model_usage: outcome.modelUsage ? JSON.parse(JSON.stringify(outcome.modelUsage)) as ModelUsageReceipt : null,
          duration_ms: Date.now() - startedAt,
          finished_at: new Date().toISOString(),
        };
      }
      if (inFlight) return inFlight;
      const completion = firstCompletion;
      const attempt = (async () => {
        try {
          const updated = await supabase.from("karta_runs").update(completion)
            .eq("id", runId).eq("user_id", userId).eq("agent_type", agentType)
            .eq("status", "running").is("duration_ms", null)
            .select("id").single();
          if (!updated.error && updated.data?.id === runId) {
            finalized = true;
            return;
          }
        } catch {
          // A transport error does not tell us whether PostgreSQL committed.
        }

        // duration_ms is set by the initial close and is never cleared by the
        // approval finalizer. It keeps this CAS closed when approvals later
        // move the status back to "running". Zero affected rows is not success.
        try {
          const stored = await supabase.from("karta_runs")
            .select("status,mode,decision,tools_used,result_summary,error_message,claude_mock,model_usage,duration_ms,finished_at")
            .eq("id", runId).eq("user_id", userId).eq("agent_type", agentType).single();
          if (!stored.error && matchesCompletion(stored.data, completion)) {
            finalized = true;
            return;
          }
        } catch {
          // Preserve the first payload for an explicit reconciliation retry.
        }
        throw new Error("Clôture du journal non confirmée : vérifier le résultat avant toute reprise");
      })();
      inFlight = attempt;
      // Avoid a floating rejected Promise from finally(); both handlers settle.
      void attempt.then(
        () => { if (inFlight === attempt) inFlight = undefined; },
        () => { if (inFlight === attempt) inFlight = undefined; }
      );
      return attempt;
    },
  };
}

interface CompletionPatch {
  status: AgentRunResult["status"];
  mode: "simulation" | "live";
  decision: string;
  tools_used: ToolCallRecord[];
  result_summary: string;
  error_message: string | null;
  claude_mock: boolean;
  model_usage: ModelUsageReceipt | null;
  duration_ms: number;
  finished_at: string;
}

function matchesCompletion(value: unknown, expected: CompletionPatch): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  return actual.status === expected.status && actual.mode === expected.mode
    && actual.decision === expected.decision && actual.result_summary === expected.result_summary
    && actual.error_message === expected.error_message && actual.claude_mock === expected.claude_mock
    && actual.duration_ms === expected.duration_ms
    && isDeepStrictEqual(actual.model_usage, expected.model_usage)
    && isDeepStrictEqual(actual.tools_used, expected.tools_used)
    && (typeof actual.finished_at === "string" || actual.finished_at instanceof Date)
    && new Date(actual.finished_at).getTime() === new Date(expected.finished_at).getTime();
}
