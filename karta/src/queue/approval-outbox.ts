import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { supabase } from "../db/supabase.js";
import { bounded } from "../runtime/lifecycle.js";
import type { AgentType } from "../engine/types.js";
import { createCycleDelivery, CycleDeliveryConflictError, resolveCycleDelivery } from "./delivery-identity.js";
import { enqueueCycleDelivery, type AgentCycleJobData, type CycleDeliveryQueue } from "./queues.js";

const IO_TIMEOUT_MS = 5_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type RelayJob = NonNullable<Awaited<ReturnType<CycleDeliveryQueue["getJob"]>>> & { getState(): Promise<string> };
export interface ApprovalOutboxDependencies {
  rpc(name: string, params: Record<string, unknown>, signal: AbortSignal): Promise<{ data: unknown; error: unknown }>;
  queue: Omit<CycleDeliveryQueue, "getJob"> & { getJob(id: string): Promise<RelayJob | undefined> };
  signal?: AbortSignal;
  timeoutMs?: number;
}
interface Lease {
  pending_action_id: string; user_id: string; parent_run_id: string; agent_type: AgentType;
  resolution: "executed" | "rejected"; lease_token: string; protocol: 1;
}
type DeliveryResult = "published" | "received" | "blocked" | "retry";
export interface ApprovalOutboxDrainResult {
  claimed: number; published: number; received: number; blocked: number; retry: number;
}
export interface ApprovalOutboxRelayHealth {
  running: boolean; inFlight: boolean; lastSuccessAt: string | null;
  lastError: "database_unavailable" | "relay_unavailable" | null;
}
export interface ApprovalOutboxRelay {
  stop(): Promise<void>;
  getHealth(): ApprovalOutboxRelayHealth;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isLease(value: unknown): value is Lease {
  if (!isRecord(value)) return false;
  return [value.pending_action_id, value.user_id, value.parent_run_id, value.lease_token]
    .every(id => typeof id === "string" && UUID.test(id))
    && typeof value.agent_type === "string" && value.agent_type.length > 0 && value.agent_type.length <= 128
    && (value.resolution === "executed" || value.resolution === "rejected") && value.protocol === 1;
}

/** Share the runtime's monotonic admission and final-handoff checks for each
 * HTTP/Redis wait, including cancellation before the timer callback runs.
 * The private Redis producer also rejects offline commands and has its own
 * command/connect timeouts. Return the guarded Promise without re-adopting it. */
function deadline<T>(operation: (signal: AbortSignal) => Promise<T>, parent?: AbortSignal, ms = IO_TIMEOUT_MS): Promise<T> {
  return bounded(operation, ms, parent);
}

/** One bounded batch. A receipt is an exact SQL run identity, regardless of the
 * run's business status. This module never resolves or executes an approval. */
export async function drainApprovalOutboxOnce(dependencies: ApprovalOutboxDependencies): Promise<ApprovalOutboxDrainResult> {
  const { queue, signal } = dependencies;
  const timeout = dependencies.timeoutMs ?? IO_TIMEOUT_MS;
  const rpc = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
    const result = await deadline(s => dependencies.rpc(name, params, s), signal, timeout);
    if (result.error) throw new Error("Continuation database unavailable");
    return result.data;
  };
  let rows: unknown;
  try { rows = await rpc("karta_claim_approval_outbox", { p_limit: 5 }); }
  catch { throw new Error("Continuation database unavailable"); }
  if (!Array.isArray(rows) || rows.length > 5) throw new Error("Continuation database unavailable");
  const results = await Promise.all(rows.map(async (row: unknown): Promise<DeliveryResult> => {
    if (!isLease(row)) {
      if (isRecord(row) && typeof row.pending_action_id === "string" && UUID.test(row.pending_action_id)
        && typeof row.lease_token === "string" && UUID.test(row.lease_token)) {
        try {
          return await rpc("karta_finish_approval_outbox", { p_id: row.pending_action_id, p_lease: row.lease_token, p_result: "invalid_intent" }) === true
            ? "blocked" : "retry";
        }
        catch { return "retry"; }
      }
      return "retry";
    }
    const data: AgentCycleJobData = { userId: row.user_id, agentType: row.agent_type, trigger: {
      type: "delegation", source: "approval-resume",
      payload: { previousRunId: row.parent_run_id, pendingActionId: row.pending_action_id, resolution: row.resolution },
    } };
    const options = { dedupeKey: `approval-resume|${row.pending_action_id}|${row.resolution}` };
    const delivery = createCycleDelivery(data, options.dedupeKey);
    let prepared: unknown;
    const prepare = async () => {
      prepared = await rpc("karta_prepare_approval_outbox", {
        p_id: row.pending_action_id, p_lease: row.lease_token,
        p_execution_key: delivery.identity.executionKey, p_fingerprint: delivery.identity.fingerprint,
        p_legacy_prefix: delivery.identity.legacyKeyPrefix,
      });
      if (!["ready", "received", "blocked", "stale"].includes(String(prepared))) throw new Error("Continuation database unavailable");
      return prepared;
    };
    const finish = async (result: string) => rpc("karta_finish_approval_outbox", {
      p_id: row.pending_action_id, p_lease: row.lease_token, p_result: result,
    });
    try {
      await prepare();
      if (prepared === "received") return "received";
      if (prepared === "blocked") return "blocked";
      if (prepared !== "ready") return "retry";
      const retained = await deadline(() => queue.getJob(delivery.jobId), signal, timeout);
      if (retained) {
        const identity = resolveCycleDelivery(retained);
        if (identity.executionKey !== delivery.identity.executionKey || identity.fingerprint !== delivery.identity.fingerprint) {
          throw new CycleDeliveryConflictError();
        }
        const state = await deadline(() => retained.getState(), signal, timeout);
        if (state === "failed" || state === "completed") {
          // The worker may have written its journal after our first check.
          const terminalReceipt = await prepare();
          if (terminalReceipt === "received") return "received";
          if (terminalReceipt === "blocked") return "blocked";
          if (terminalReceipt !== "ready") return "retry";
          // Retained terminal jobs are not fresh publications. Never delete or
          // retry one blindly when its business evidence cannot be established.
          return await finish("retained_terminal") === true ? "blocked" : "retry";
        }
      }
      const boundedQueue: CycleDeliveryQueue = {
        add: (name, content, jobOptions) => deadline(() => queue.add(name, content, jobOptions), signal, timeout),
        getJob: id => deadline(() => queue.getJob(id), signal, timeout),
      };
      await enqueueCycleDelivery(boundedQueue, data, options, async (_content, identity) => {
        if (identity.executionKey !== delivery.identity.executionKey || identity.fingerprint !== delivery.identity.fingerprint) {
          throw new CycleDeliveryConflictError();
        }
        await prepare();
        if (prepared !== "ready") throw new CycleDeliveryConflictError();
      });
      return await finish("published") === true ? "published" : "retry";
    } catch (error) {
      if (prepared === "received") return "received";
      if (prepared === "blocked") return "blocked";
      if (prepared === "stale") return "retry";
      const result = error instanceof CycleDeliveryConflictError ? "identity_conflict" : "retry";
      try {
        if (await finish(result) !== true) return "retry";
        return result === "identity_conflict" ? "blocked" : "retry";
      } catch { return "retry"; } // Expiry permits another relay to reconcile.
    }
  }));
  const result: ApprovalOutboxDrainResult = { claimed: rows.length, published: 0, received: 0, blocked: 0, retry: 0 };
  for (const item of results) result[item]++;
  return result;
}

/** Injectable lifecycle; the production wrapper below exclusively owns Redis. */
export function createApprovalOutboxRelay(
  dependencies: Omit<ApprovalOutboxDependencies, "signal">,
  close: () => Promise<void>,
  pollIntervalMs = 5_000,
): ApprovalOutboxRelay {
  const controller = new AbortController();
  const health: ApprovalOutboxRelayHealth = { running: true, inFlight: false, lastSuccessAt: null, lastError: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let failures = 0;
  const poll = () => {
    if (!health.running) return;
    health.inFlight = true;
    active = (async () => {
      try {
        const result = await drainApprovalOutboxOnce({ ...dependencies, signal: controller.signal });
        health.lastSuccessAt = new Date().toISOString();
        health.lastError = result.retry > 0 ? "relay_unavailable" : null;
        failures = result.retry > 0 ? Math.min(failures + 1, 5) : 0;
      } catch {
        health.lastError = "database_unavailable";
        failures = Math.min(failures + 1, 5);
      } finally {
        health.inFlight = false;
        if (health.running) {
          timer = setTimeout(poll, Math.min(30_000, pollIntervalMs * 2 ** failures));
          timer.unref();
        }
      }
    })();
  };
  timer = setTimeout(poll, 0);
  timer.unref();
  return {
    getHealth: () => ({ ...health }),
    stop: () => {
      if (stopping) return stopping;
      health.running = false;
      if (timer) clearTimeout(timer);
      controller.abort();
      stopping = (async () => {
        try { await deadline(() => close()); } catch { /* The producer wrapper force-disconnects. */ }
        try { if (active) await deadline(() => active!); } catch { /* Every individual I/O is also bounded. */ }
      })();
      return stopping;
    },
  };
}

export function startApprovalOutboxRelay(): ApprovalOutboxRelay {
  const redis = new Redis(config.redisUrl, { lazyConnect: true, enableOfflineQueue: false,
    maxRetriesPerRequest: 1, commandTimeout: IO_TIMEOUT_MS, connectTimeout: IO_TIMEOUT_MS,
    retryStrategy: times => Math.min(times * 500, 5_000) });
  redis.on("error", () => { /* Health records availability without private transport diagnostics. */ });
  const queue = new Queue<AgentCycleJobData>("karta-agent-cycle", { connection: redis,
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { count: 500 }, removeOnFail: { count: 1000 } } });
  queue.on("error", () => { /* No raw Redis URL or payload is logged. */ });
  return createApprovalOutboxRelay({
    queue,
    rpc: async (name, params, signal) => supabase.rpc(name, params).abortSignal(signal),
  }, async () => {
    try { await deadline(() => queue.close()); }
    finally { redis.disconnect(); }
  });
}
