import type { AgentTrigger, AgentType } from "./types.js";

// One bounded, server-owned origin. These facts never authorize an action.
export const MAX_DELEGATION_REASON_LENGTH = 2_000;
export const MAX_TRIGGER_SOURCE_LENGTH = 200;
export const MAX_EXECUTION_TRIGGER_BYTES = 16_384;
export const CORE_DELEGATION_AGENTS: readonly string[] = ["email", "compta", "legal", "partner"];
export const MAX_DELEGATION_DEPTH = 3;
const CONTEXT_ERROR = "Contexte de reprise indisponible : vérifier l’état et les autorisations avant toute action";

/** Invalid origin is deterministic; a retry cannot establish new authority. */
export class ExecutionOriginError extends Error {
  constructor() { super(CONTEXT_ERROR); this.name = "ExecutionOriginError"; }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(CONTEXT_ERROR);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(CONTEXT_ERROR);
  return value as Record<string, unknown>;
}

/** Refuse accessors rather than invoking a getter while validating server data. */
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(CONTEXT_ERROR);
  return descriptor.value;
}

function optionalOwn(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error(CONTEXT_ERROR);
  return descriptor.value;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !allowed.includes(key) || !descriptor?.enumerable || !("value" in descriptor)) throw new Error(CONTEXT_ERROR);
  }
}

function executionTrigger(value: unknown, agentType: AgentType, strict: boolean): AgentTrigger | undefined {
  if (value === null || value === undefined) return undefined;
  const envelope = record(value);
  if (strict) knownKeys(envelope, ["type", "source", "payload"]);
  const type = own(envelope, "type");
  if (type !== "manual" && type !== "cron" && type !== "webhook" && type !== "delegation") throw new Error(CONTEXT_ERROR);
  const source = own(envelope, "source");
  if (typeof source !== "string" || !source.trim() || source.length > MAX_TRIGGER_SOURCE_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(source) || source === "approval-resume") throw new Error(CONTEXT_ERROR);
  let snapshot: AgentTrigger = { type, source };
  if (type === "delegation") {
    if (!CORE_DELEGATION_AGENTS.includes(source)) throw new Error(CONTEXT_ERROR);
    const payload = record(own(envelope, "payload"));
    if (strict) knownKeys(payload, ["reason", "kartaDelegation"]);
    const reason = own(payload, "reason");
    if (typeof reason !== "string" || !reason.trim() || reason.length > MAX_DELEGATION_REASON_LENGTH || reason.includes("\0")) throw new Error(CONTEXT_ERROR);
    const safePayload: Record<string, unknown> = { reason };
    const rawTrace = optionalOwn(payload, "kartaDelegation");
    if (rawTrace !== undefined) {
      const trace = record(rawTrace);
      if (strict) knownKeys(trace, ["depth", "lineage"]);
      const depth = own(trace, "depth");
      const lineage = own(trace, "lineage");
      if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > MAX_DELEGATION_DEPTH ||
          !Array.isArray(lineage) || Object.getPrototypeOf(lineage) !== Array.prototype ||
          lineage.length !== (depth as number) + 1 || lineage.length > MAX_DELEGATION_DEPTH + 1 ||
          Reflect.ownKeys(lineage).length !== lineage.length + 1) throw new Error(CONTEXT_ERROR);
      const safeLineage: string[] = [];
      for (let i = 0; i < lineage.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(lineage, String(i));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
            typeof descriptor.value !== "string" || !CORE_DELEGATION_AGENTS.includes(descriptor.value)) throw new Error(CONTEXT_ERROR);
        safeLineage.push(descriptor.value);
      }
      if (new Set(safeLineage).size !== safeLineage.length || safeLineage.at(-1) !== agentType || safeLineage.at(-2) !== source) throw new Error(CONTEXT_ERROR);
      safePayload.kartaDelegation = { depth, lineage: safeLineage };
    } else if (strict && Object.hasOwn(payload, "kartaDelegation")) {
      throw new Error(CONTEXT_ERROR);
    }
    snapshot = { type, source, payload: safePayload };
  } else if (strict && Object.hasOwn(envelope, "payload")) {
    throw new Error(CONTEXT_ERROR);
  }
  if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_EXECUTION_TRIGGER_BYTES) throw new Error(CONTEXT_ERROR);
  return snapshot;
}

/** Copy only the known original origin, never a queue payload or resume wrapper. */
export function snapshotAgentExecutionTrigger(trigger: AgentTrigger | undefined, agentType: AgentType): AgentTrigger | undefined {
  try { return executionTrigger(trigger, agentType, false); }
  catch { throw new ExecutionOriginError(); }
}

/** Persisted non-null origins must satisfy exactly the server snapshot format. */
export function restoreAgentExecutionTrigger(value: unknown, agentType: AgentType): AgentTrigger | undefined {
  try { return executionTrigger(value, agentType, true); }
  catch { throw new ExecutionOriginError(); }
}
