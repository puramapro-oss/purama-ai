import { constants, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  normalizeChefCapabilitySelection, resolveChefCapabilities,
  type ChefCapabilityBinding, type ChefCapabilitySelection,
} from "./capability-selection.js";

export type ChefCapabilityResolver = (
  binding: Readonly<ChefCapabilityBinding>, signal: AbortSignal,
) => Promise<unknown> | unknown;

export interface ChefCapabilityRuntime {
  /** Operator attestation that the adapter implements this protocol, not an LLM claim. */
  adapterProtocol: 1;
  resolveContext: ChefCapabilityResolver;
  now?: () => number;
}

export interface ChefCapabilityPlan {
  protocolVersion: 1;
  selectionHash: string;
  selected: Array<{ id: string; kind: "skill" | "connector"; version: string }>;
  estimatedCostMicros: number;
  execution?: { workerId: string; attempt: number; fencingToken: number };
}

/** A receipt for an earlier worker generation cannot acknowledge this dispatch. */
export function bindChefCapabilityPlan(
  plan: ChefCapabilityPlan, execution: { workerId: string; attempt: number; fencingToken: number },
): ChefCapabilityPlan {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(execution.workerId)
    || !Number.isSafeInteger(execution.attempt) || execution.attempt < 1
    || !Number.isSafeInteger(execution.fencingToken) || execution.fencingToken < 1) {
    throw new Error("Génération des capacités invalide");
  }
  const generation = { workerId: execution.workerId, attempt: execution.attempt, fencingToken: execution.fencingToken };
  return { ...plan, execution: generation, selectionHash: createHash("sha256").update(JSON.stringify({
    protocolVersion: 1, selectionHash: plan.selectionHash, execution: generation,
  })).digest("hex") };
}

export type ChefCapabilityPreparation =
  | { ready: true; selection: ChefCapabilitySelection; plan: ChefCapabilityPlan }
  | { ready: false; reason: string };

/** Read-only, bounded resolution before the coding process starts. Never echo resolver errors. */
export async function prepareChefCapabilities(
  selection: ChefCapabilitySelection, binding: ChefCapabilityBinding,
  runtime: ChefCapabilityRuntime | undefined, signal?: AbortSignal,
): Promise<ChefCapabilityPreparation> {
  if (signal?.aborted) return { ready: false, reason: "cancelled" };
  if (runtime?.adapterProtocol !== 1 || typeof runtime.resolveContext !== "function") {
    return { ready: false, reason: "capability_adapter_unavailable" };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    const normalized = normalizeChefCapabilitySelection(selection);
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => { controller.abort(); reject(new Error("cancelled")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, 5_000);
    });
    const context = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return runtime.resolveContext(Object.freeze({ ...binding }), controller.signal);
      }),
      deadline,
    ]);
    if (signal?.aborted) return { ready: false, reason: "cancelled" };
    // Freshness is checked after resolution, never against the request-start time.
    const resolved = resolveChefCapabilities(normalized, context, binding, (runtime.now ?? Date.now)());
    if (resolved.status !== "ready" || resolved.estimatedCostMicros === null) {
      return { ready: false, reason: resolved.reason };
    }
    return { ready: true, selection: normalized, plan: {
      protocolVersion: 1, selectionHash: resolved.selectionHash,
      selected: resolved.selected, estimatedCostMicros: resolved.estimatedCostMicros,
    } };
  } catch {
    return { ready: false, reason: signal?.aborted ? "cancelled" : "capability_context_unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

/** An adapter acknowledgment is a protocol check, not independent proof of sandbox enforcement. */
export function hasChefCapabilityReceipt(value: unknown, plan: ChefCapabilityPlan): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.selectionHash !== plan.selectionHash || !Array.isArray(receipt.appliedIds)) return false;
  const expected = plan.selected.map(item => item.id).sort();
  if (receipt.appliedIds.length !== expected.length || receipt.appliedIds.some(id => typeof id !== "string")) return false;
  return [...receipt.appliedIds].sort().every((id, index) => id === expected[index]);
}

/** A name beginning with two dots is still a child unless it is the parent segment. */
export function resolveTrustedChefCapabilityContextPath(path: string, allowedRoots: string[]): string {
  if (!isAbsolute(path)) throw new Error("Chemin de contexte CHEF non absolu");
  const canonical = realpathSync(path);
  for (const root of allowedRoots) {
    const rel = relative(realpathSync(root), canonical);
    const outside = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    if (!outside) throw new Error("Le contexte de capacités doit rester hors des espaces de travail des agents");
  }
  return canonical;
}

/**
 * Optional operator-managed snapshot transport for the existing CHEF daemon.
 * The file must be outside model-writable worktrees. It contains no credentials.
 * The trusted host publishes fresh contexts bound to exact task/mission/hash;
 * this reader does not discover connections or invent permissions.
 */
export function createFileChefCapabilityResolver(path: string): ChefCapabilityResolver {
  if (!isAbsolute(path)) throw new Error("Chemin du contexte de capacités non absolu");
  return async (binding, signal) => {
    signal.throwIfAborted();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      const maxBytes = 1024 * 1024;
      if (!stat.isFile() || stat.size > maxBytes) throw new Error("Contexte trop volumineux");
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        signal.throwIfAborted();
        const result = await file.read(buffer, size, buffer.length - size, size);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      signal.throwIfAborted();
      if (size > maxBytes) throw new Error("Contexte trop volumineux");
      const envelope = JSON.parse(buffer.subarray(0, size).toString("utf8"));
      if (!envelope || envelope.schemaVersion !== 1 || !Array.isArray(envelope.contexts)
        || envelope.contexts.length > 128) throw new Error("Enveloppe de capacités invalide");
      const matching = envelope.contexts.filter((context: { binding?: ChefCapabilityBinding } | null) =>
        context?.binding?.userId === binding.userId && context.binding.taskId === binding.taskId && context.binding.missionId === binding.missionId
        && context.binding.briefHash === binding.briefHash);
      if (matching.length !== 1) throw new Error("Contexte de capacités absent ou ambigu");
      return matching[0];
    } finally { await file.close(); }
  };
}
