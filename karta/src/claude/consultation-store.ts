import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { supabase } from "../db/supabase.js";
import { bounded } from "../runtime/lifecycle.js";
import { normalizeConsultationRequest, type ConsultationCall, type ConsultationDependencies,
  type ConsultationRequest, type ConsultationResult } from "./consultation.js";
import type { ModelExecutionPlan } from "./execution-profile.js";

export interface ConsultationCallEstimate {
  kind: ConsultationCall["kind"];
  provider: string;
  model?: string;
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Qualified host ceiling, never a provider receipt or an invoice. */
  maxCostMicros: number;
}
export interface ConsultationEstimates { policyVersion: string; calls: ConsultationCallEstimate[] }
export interface ConsultationOperation {
  operationId: string;
  state: "pending" | "running" | "complete" | "partial" | "failed" | "cancelled" | "interrupted";
  resourceState: "reserved" | "reconciliation_required" | "reconciled";
  cancelRequested: boolean;
  result: ConsultationResult | null;
  createdAt: string;
  updatedAt: string;
}
export interface ConsultationRpcClient {
  rpc(name: string, args: Record<string, unknown>): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { code?: string } | null }>;
  };
}
export class ConsultationStoreError extends Error {
  constructor(readonly code: "conflict" | "budget_unavailable" | "unavailable" | "invalid") {
    super(code === "conflict" ? "Cette demande existe avec un contenu différent."
      : code === "budget_unavailable" ? "Les ressources autorisées pour cette consultation sont indisponibles."
      : code === "invalid" ? "La demande de consultation est invalide."
      : "Le suivi durable de la consultation est temporairement indisponible.");
    this.name = "ConsultationStoreError";
  }
}
export type ConsultationBeginResult = { created: false; operation: ConsultationOperation } | {
  created: true;
  operation: ConsultationOperation;
  admission: ConsultationDependencies["admission"];
  finalize(result: ConsultationResult): Promise<ConsultationOperation>;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$(?![\s\S])/i;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$(?![\s\S])/;
const invalid = (): never => { throw new ConsultationStoreError("invalid"); };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Snapshot before any await. Persistence accepts JSON data, not behavior. */
function snapshot<T>(value: T, maximum = 2_097_152): T {
  let nodes = 0;
  const seen = new Set<object>();
  const copy = (input: unknown, depth: number): unknown => {
    if (++nodes > 30_000 || depth > 24) return invalid();
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : invalid();
    if (!input || typeof input !== "object" || isProxy(input) || seen.has(input)) return invalid();
    seen.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.getPrototypeOf(input) !== Array.prototype || input.length > 10_000 || Reflect.ownKeys(input).length !== input.length + 1) return invalid();
        return Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          return descriptor && "value" in descriptor ? copy(descriptor.value, depth + 1) : invalid();
        });
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) return invalid();
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
        if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) return invalid();
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally { seen.delete(input); }
  };
  const result = copy(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > maximum) return invalid();
  return result as T;
}
function identity(userId: string, operationId: string) {
  if (typeof userId !== "string" || !UUID.test(userId) || typeof operationId !== "string" || !ID.test(operationId)) return invalid();
  return { p_user_id: userId, p_operation_id: operationId };
}
function operation(value: unknown, expectedId: string): ConsultationOperation | null {
  if (value === null) return null;
  const row = snapshot(value) as Partial<ConsultationOperation>;
  if (!row || typeof row !== "object" || Array.isArray(row) || row.operationId !== expectedId
    || Object.keys(row).length !== 7
    || !["pending", "running", "complete", "partial", "failed", "cancelled", "interrupted"].includes(row.state ?? "")
    || !["reserved", "reconciliation_required", "reconciled"].includes(row.resourceState ?? "")
    || typeof row.cancelRequested !== "boolean"
    || typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt))
    || typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt))
    || (row.result !== null && (!row.result || typeof row.result !== "object" || Array.isArray(row.result)))) {
    throw new ConsultationStoreError("unavailable");
  }
  return row as ConsultationOperation;
}

/** Server-only adapter. A lost acknowledgement is never retried into execution.
 * SQL owns allocation and call uniqueness; the host owns provider qualification. */
export function createConsultationStore(options: { client?: ConsultationRpcClient; timeoutMs?: number } = {}) {
  const client = options.client ?? supabase as unknown as ConsultationRpcClient;
  const timeout = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000) return invalid();
  async function rpc(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    try {
      return await bounded(async scoped => {
        const response = await client.rpc(name, args).abortSignal(scoped);
        if (response.error) throw new ConsultationStoreError(response.error.code === "PCO01" ? "conflict"
          : response.error.code === "PCO02" ? "budget_unavailable" : "unavailable");
        return response.data;
      }, timeout, signal);
    } catch (error) {
      if (error instanceof ConsultationStoreError) throw error;
      throw new ConsultationStoreError("unavailable");
    }
  }
  function requestSnapshot(userId: string, raw: ConsultationRequest) {
    const request = normalizeConsultationRequest(raw);
    identity(userId, request.operationId);
    if (request.userId !== userId) return invalid();
    return { request, requestHash: hash(request) };
  }
  return {
    async availability(userId: string, signal?: AbortSignal): Promise<boolean> {
      identity(userId, "availability");
      const available = await rpc("model_consultation_availability", { p_user_id: userId }, signal);
      if (typeof available !== "boolean") throw new ConsultationStoreError("unavailable");
      return available;
    },
    async status(userId: string, operationId: string, signal?: AbortSignal): Promise<ConsultationOperation | null> {
      return operation(await rpc("model_consultation_status", identity(userId, operationId), signal), operationId);
    },
    async resume(userId: string, raw: ConsultationRequest, signal?: AbortSignal): Promise<ConsultationOperation | null> {
      const { request, requestHash } = requestSnapshot(userId, raw);
      return operation(await rpc("model_consultation_resume", { ...identity(userId, request.operationId),
        p_request_hash: requestHash, p_request: request }, signal), request.operationId);
    },
    async cancel(userId: string, operationId: string, signal?: AbortSignal): Promise<ConsultationOperation | null> {
      return operation(await rpc("model_consultation_cancel", identity(userId, operationId), signal), operationId);
    },
    async begin(userId: string, raw: ConsultationRequest, rawPlan: ModelExecutionPlan,
      rawEstimates: ConsultationEstimates, signal?: AbortSignal): Promise<ConsultationBeginResult> {
      signal?.throwIfAborted();
      const { request, requestHash } = requestSnapshot(userId, raw);
      const plan = snapshot(rawPlan, 16_384);
      const estimates = snapshot(rawEstimates, 32_768);
      const args = identity(userId, request.operationId);
      const response = snapshot(await rpc("model_consultation_create", { ...args, p_request_hash: requestHash,
        p_request: request, p_plan: plan, p_estimates: estimates }, signal)) as Record<string, unknown>;
      if (!response || typeof response.created !== "boolean") throw new ConsultationStoreError("unavailable");
      const status = operation(response.operation, request.operationId);
      if (!status) throw new ConsultationStoreError("unavailable");
      if (!response.created) return { created: false, operation: status };
      const generation = response.generation;
      if (typeof generation !== "string" || !UUID.test(generation) || status.state !== "pending") throw new ConsultationStoreError("unavailable");
      const binding = { ...args, p_generation: generation };
      let claimed = false;
      let claimAttempted = false;
      let finalized: ConsultationResult | undefined;
      let finalizing: Promise<ConsultationOperation> | undefined;
      const admission: ConsultationDependencies["admission"] = {
        async claim(input, callSignal) {
          if (claimAttempted) return false;
          const value = snapshot(input, 1024);
          if (!value || value.userId !== userId || value.operationId !== request.operationId || value.requestHash !== requestHash) return false;
          claimAttempted = true;
          const accepted = await rpc("model_consultation_start", { ...binding, p_request_hash: requestHash }, callSignal);
          if (typeof accepted !== "boolean") throw new ConsultationStoreError("unavailable");
          claimed = accepted;
          return accepted;
        },
        async reserve(call, callSignal) {
          if (!claimed || finalized) return false;
          const value = snapshot(call, 4096);
          if (!value || value.userId !== userId || value.operationId !== request.operationId) return false;
          const accepted = await rpc("model_consultation_reserve", { ...binding, p_call: value }, callSignal);
          if (typeof accepted !== "boolean") throw new ConsultationStoreError("unavailable");
          return accepted;
        },
        async settle(receipt) {
          if (!claimed) return invalid();
          const value = snapshot(receipt, 8192);
          if (!value?.call || value.call.userId !== userId || value.call.operationId !== request.operationId) return invalid();
          const accepted = await rpc("model_consultation_settle", { ...binding, p_receipt: value });
          if (accepted !== true) throw new ConsultationStoreError("unavailable");
        },
      };
      return { created: true, operation: status, admission,
        finalize(result) {
          const candidate = snapshot(result);
          if (finalized && JSON.stringify(finalized) !== JSON.stringify(candidate)) throw new ConsultationStoreError("conflict");
          finalized ??= candidate;
          if (finalizing) return finalizing;
          const persisted = rpc("model_consultation_finalize", { ...binding, p_result: finalized }).then(value => {
            const final = operation(value, request.operationId);
            if (!final) throw new ConsultationStoreError("unavailable");
            return final;
          });
          finalizing = persisted;
          // A failed acknowledgement may reconcile exactly this same result.
          // The consultation and its provider calls are never rerun here.
          void persisted.catch(() => { if (finalizing === persisted) finalizing = undefined; });
          return persisted;
        },
      };
    },
  };
}
