import { supabase } from "../db/supabase.js";
import type { AgentTrigger, AgentType } from "./types.js";

export const MAX_DELEGATION_REASON_LENGTH = 2_000;
export const MAX_TRIGGER_SOURCE_LENGTH = 200;
export const MAX_APPROVAL_CONTEXT_BYTES = 65_536;
export const MAX_EXECUTION_TRIGGER_BYTES = 16_384;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const CORE_DELEGATION_AGENTS = ["email", "compta", "legal", "partner"];
const MAX_EXECUTION_DELEGATION_DEPTH = 3;
const CONTEXT_ERROR = "Contexte de reprise indisponible : vérifier l’état et les autorisations avant toute action";

export type ResolvedActionGuard = "already_executed" | "rejected" | null;
type Resolution = "executed" | "rejected";

export interface AgentTriggerModelContext {
  delegation?: { source: string; reason: string };
  approvalResume?: {
    previousRunId: string;
    pendingActionId: string;
    resolution: Resolution;
    toolName: string;
    toolParams: Record<string, unknown>;
  };
}

export interface PreparedAgentTriggerContext {
  /** Data for the model, never an execution permission or a replacement brief. */
  modelContext?: AgentTriggerModelContext;
  /** Original bounded server origin; absent for historical approvals. */
  executionTrigger?: AgentTrigger;
  /** Trigger data must not be copied into legacy decision/error/tool traces. */
  privateTrace: boolean;
  /** Exact JSON action guard for this immediate continuation only. */
  guardToolCall(toolName: string, params: unknown): ResolvedActionGuard;
}

const emptyContext = (): PreparedAgentTriggerContext => ({ privateTrace: false, guardToolCall: () => null });

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

function identifier(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) throw new Error(CONTEXT_ERROR);
  return value;
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
      if (!Number.isSafeInteger(depth) || (depth as number) < 1 || (depth as number) > MAX_EXECUTION_DELEGATION_DEPTH ||
          !Array.isArray(lineage) || Object.getPrototypeOf(lineage) !== Array.prototype ||
          lineage.length !== (depth as number) + 1 || lineage.length > MAX_EXECUTION_DELEGATION_DEPTH + 1 ||
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
  catch { throw new Error(CONTEXT_ERROR); }
}

/** Persisted non-null origins must satisfy exactly the server snapshot format. */
export function restoreAgentExecutionTrigger(value: unknown, agentType: AgentType): AgentTrigger | undefined {
  try { return executionTrigger(value, agentType, true); }
  catch { throw new Error(CONTEXT_ERROR); }
}

/**
 * Canonical JSON, with explicit size/depth/node limits. It never invokes toJSON
 * or getters, and never silently drops undefined, sparse elements or extra
 * properties. Key order is not a business difference; array order remains one.
 */
function canonicalParams(value: unknown): string {
  record(value);
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const part = (text: string): string => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_APPROVAL_CONTEXT_BYTES) throw new Error(CONTEXT_ERROR);
    return text;
  };
  const quote = (text: string): string => {
    if (text.length > MAX_APPROVAL_CONTEXT_BYTES) throw new Error(CONTEXT_ERROR);
    return part(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error(CONTEXT_ERROR);
    if (item === null) return part("null");
    if (typeof item === "string") return quote(item);
    if (typeof item === "boolean") return part(String(item));
    if (typeof item === "number" && Number.isFinite(item)) return part(JSON.stringify(item));
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error(CONTEXT_ERROR);
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || item.length > MAX_JSON_NODES ||
            Reflect.ownKeys(item).length !== item.length + 1) throw new Error(CONTEXT_ERROR);
        const entries: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(CONTEXT_ERROR);
          entries.push(visit(descriptor.value, depth + 1));
        }
        part(",".repeat(Math.max(0, entries.length - 1)));
        return part("[") + entries.join(",") + part("]");
      }
      const object = record(item);
      const keys = Reflect.ownKeys(object);
      if (keys.some(key => typeof key !== "string")) throw new Error(CONTEXT_ERROR);
      const entries: string[] = [];
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(CONTEXT_ERROR);
        entries.push(quote(key) + part(":") + visit(descriptor.value, depth + 1));
      }
      // Charge each separator (including large objects) exactly once.
      part(",".repeat(Math.max(0, entries.length - 1)));
      return part("{") + entries.join(",") + part("}");
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

function matches(row: Record<string, unknown>, fields: Record<string, string>): boolean {
  return Object.entries(fields).every(([key, expected]) => own(row, key) === expected);
}

async function loadResolvedAction(
  userId: string, agentType: AgentType, payload: Record<string, unknown>,
): Promise<{ model: NonNullable<AgentTriggerModelContext["approvalResume"]>; canonical: string; executionTrigger?: AgentTrigger }> {
  identifier(userId);
  identifier(agentType);
  const previousRunId = identifier(own(payload, "previousRunId"));
  const pendingActionId = identifier(own(payload, "pendingActionId"));
  const expectedResolution = own(payload, "resolution");
  if (expectedResolution !== "executed" && expectedResolution !== "rejected") throw new Error(CONTEXT_ERROR);

  const pendingRead = await supabase.from("karta_pending_actions")
    .select("id,user_id,run_id,agent_type,tool_name,tool_params,status,resolved_at,execution_trigger")
    .eq("id", pendingActionId).eq("run_id", previousRunId)
    .eq("user_id", userId).eq("agent_type", agentType).maybeSingle();
  if (pendingRead.error) throw new Error(CONTEXT_ERROR);
  const pending = record(pendingRead.data);
  if (!matches(pending, { id: pendingActionId, user_id: userId, run_id: previousRunId, agent_type: agentType })) throw new Error(CONTEXT_ERROR);
  const resolution = own(pending, "status");
  // The payload is only a correlation hint. Contradictory or unresolved state
  // never becomes permission to retry an operation.
  if ((resolution !== "executed" && resolution !== "rejected") || resolution !== expectedResolution) throw new Error(CONTEXT_ERROR);
  const resolvedAt = own(pending, "resolved_at");
  if (typeof resolvedAt !== "string" || resolvedAt.length > 64 || !Number.isFinite(Date.parse(resolvedAt))) throw new Error(CONTEXT_ERROR);
  const toolName = identifier(own(pending, "tool_name"), 128);
  const canonical = canonicalParams(own(pending, "tool_params"));
  const origin = restoreAgentExecutionTrigger(optionalOwn(pending, "execution_trigger"), agentType);

  const parentRead = await supabase.from("karta_runs")
    .select("id,user_id,agent_type,status,mode,claude_mock,tools_used")
    .eq("id", previousRunId).eq("user_id", userId).eq("agent_type", agentType).maybeSingle();
  if (parentRead.error) throw new Error(CONTEXT_ERROR);
  const parent = record(parentRead.data);
  if (!matches(parent, { id: previousRunId, user_id: userId, agent_type: agentType, mode: "live" }) || own(parent, "claude_mock") !== false) throw new Error(CONTEXT_ERROR);
  const allowedStatuses = resolution === "executed" ? ["success", "partial"] : ["skipped", "partial"];
  const parentStatus = own(parent, "status");
  if (typeof parentStatus !== "string" || !allowedStatuses.includes(parentStatus)) throw new Error(CONTEXT_ERROR);
  const records = own(parent, "tools_used");
  if (!Array.isArray(records) || records.length > 256) throw new Error(CONTEXT_ERROR);
  let matching = 0;
  for (const entry of records) {
    const action = record(entry);
    const id = Object.getOwnPropertyDescriptor(action, "pendingActionId");
    if (id && !("value" in id)) throw new Error(CONTEXT_ERROR);
    if (id?.value !== pendingActionId) continue;
    matching++;
    if (own(action, "tool") !== toolName || own(action, "outcome") !== resolution || own(action, "success") !== (resolution === "executed")) throw new Error(CONTEXT_ERROR);
  }
  if (matching !== 1) throw new Error(CONTEXT_ERROR);

  return { model: { previousRunId, pendingActionId, resolution, toolName, toolParams: JSON.parse(canonical) as Record<string, unknown> }, canonical, executionTrigger: origin };
}

/**
 * Build only the supported trigger facts. Normal triggers do not copy arbitrary
 * payloads. Approval evidence is reloaded with every ownership boundary, never
 * reconstructed from a model statement, a queue flag, or a redacted trace.
 *
 * This does not recover the original task brief, guarantee semantic duplicate
 * detection, or authorize new effects. The usual current-authority, tool-schema
 * and approval checks must still run for every other action.
 */
export async function prepareAgentTriggerContext(
  userId: string, agentType: AgentType, trigger: AgentTrigger,
): Promise<PreparedAgentTriggerContext> {
  try {
    const envelope = record(trigger);
    const type = own(envelope, "type");
    const source = own(envelope, "source");
    if (source === "approval-resume") {
      if (type !== "delegation") throw new Error(CONTEXT_ERROR);
      const resolved = await loadResolvedAction(userId, agentType, record(own(envelope, "payload")));
      // Keep the comparison snapshot separate from the model's mutable input.
      const resolvedToolName = resolved.model.toolName;
      const resolution = resolved.model.resolution;
      const origin = resolved.executionTrigger;
      const delegatedOrigin = origin?.type === "delegation"
        ? { source: origin.source, reason: origin.payload!.reason as string } : undefined;
      return {
        modelContext: { approvalResume: resolved.model, ...(delegatedOrigin ? { delegation: delegatedOrigin } : {}) },
        executionTrigger: origin, privateTrace: true,
        guardToolCall(toolName, params) {
          if (toolName !== resolvedToolName) return null;
          try {
            if (canonicalParams(params) !== resolved.canonical) return null;
            return resolution === "executed" ? "already_executed" : "rejected";
          } catch { throw new Error(CONTEXT_ERROR); }
        },
      };
    }
    const origin = snapshotAgentExecutionTrigger(trigger, agentType)!;
    if (type !== "delegation") return { ...emptyContext(), executionTrigger: origin };
    return { modelContext: { delegation: { source: origin.source, reason: origin.payload!.reason as string } }, executionTrigger: origin, privateTrace: true, guardToolCall: () => null };
  } catch {
    // Transport/database/parser messages may contain private text or secrets.
    throw new Error(CONTEXT_ERROR);
  }
}
