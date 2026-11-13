import { createHash } from "node:crypto";
import { parseWebAccessIntent, planWebCapabilityAccess, type WebAccessIntent } from "../lib/web-capability-plan.js";

/** Preferences are not permissions. The host supplies a fresh, trusted snapshot. */
export interface ChefCapabilitySelection {
  mode: "auto" | "manual";
  needs: string[];
  selectedIds: string[];
  excludedIds: string[];
  maxSelected: number;
}

export interface ChefCapabilityBinding {
  userId: string;
  missionId: string;
  taskId: string;
  briefHash: string;
}

export interface ChefCapabilityDescriptor {
  id: string;
  kind: "skill" | "connector";
  version: string;
  provides: string[];
  requires: string[];
  qualified: boolean;
  available: boolean;
  authorized: boolean;
  /** A qualified score supplied by the host; null is unknown, never perfect. */
  quality: number | null;
  /** Complete capability estimate; the web route estimate is also a lower bound. */
  estimatedCostMicros: number | null;
  /** Required for a connector, forbidden for a skill. Contains no credentials. */
  webAccess?: { intent: WebAccessIntent; userId: string; context: unknown };
}

export interface ChefCapabilityContext {
  binding: ChefCapabilityBinding;
  observedAtMs: number;
  validUntilMs: number;
  remainingBudgetMicros: number | null;
  capabilities: ChefCapabilityDescriptor[];
}

export interface ChefCapabilityResolution {
  status: "ready" | "blocked";
  reason: string;
  selected: Array<{ id: string; kind: "skill" | "connector"; version: string }>;
  selectionHash: string;
  estimatedCostMicros: number | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,119}$/;
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000;
// These obstacles concern this candidate's availability, not a refused mandate.
// A separately authorized connector may satisfy the same need. All permission,
// identity, challenge and uncertain-effect results remain terminal.
const RETRYABLE_WEB_OBSTACLES = new Set([
  "context_missing", "context_stale", "budget_unknown", "budget_insufficient",
  "route_stale", "route_credentials_missing", "route_credentials_expired",
  "execution_cost_unknown", "no_available_route", "resolver_unavailable",
  "account_connection_required", "reconnect_existing_account",
  "adaptive_recipe_preparation_only",
]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const amount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableAmount = (value: unknown): value is number | null => value === null || amount(value);
const id = (value: unknown): value is string => typeof value === "string" && ID.test(value);

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.getOwnPropertySymbols(value).length === 0
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(property => "value" in property);
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.getOwnPropertyNames(value).every(key => required.includes(key) || optional.includes(key));
}

function identifiers(value: unknown, label: string, rejectDuplicates = false): string[] {
  if (!Array.isArray(value) || value.length > 32 || !value.every(id)) throw new Error(`${label} invalide`);
  const unique = [...new Set(value)];
  if (rejectDuplicates && unique.length !== value.length) throw new Error(`${label} dupliqué`);
  return unique.sort(compare);
}

export function normalizeChefCapabilitySelection(value: unknown): ChefCapabilitySelection {
  if (!record(value) || !exactKeys(value, ["mode", "needs"], ["selectedIds", "excludedIds", "maxSelected"])
    || (value.mode !== "auto" && value.mode !== "manual")) throw new Error("Sélection de capacités invalide");
  const needs = identifiers(value.needs, "needs");
  const selectedIds = identifiers(value.selectedIds === undefined ? [] : value.selectedIds, "selectedIds");
  const excludedIds = identifiers(value.excludedIds === undefined ? [] : value.excludedIds, "excludedIds");
  const maxSelected = value.maxSelected === undefined ? 8 : value.maxSelected;
  if (!Number.isInteger(maxSelected) || Number(maxSelected) < 1 || Number(maxSelected) > 16
    || (value.mode === "auto" && selectedIds.length > 0)
    || selectedIds.some(selected => excludedIds.includes(selected))) throw new Error("Sélection de capacités incohérente");
  return { mode: value.mode, needs, selectedIds, excludedIds, maxSelected: Number(maxSelected) };
}

function validBinding(value: unknown): value is ChefCapabilityBinding {
  return record(value) && exactKeys(value, ["userId", "missionId", "taskId", "briefHash"])
    && id(value.userId) && id(value.missionId) && id(value.taskId)
    && typeof value.briefHash === "string" && /^[a-f0-9]{64}$/.test(value.briefHash);
}

function parseContext(value: unknown): ChefCapabilityContext {
  if (!record(value) || !exactKeys(value, ["binding", "observedAtMs", "validUntilMs", "remainingBudgetMicros", "capabilities"])
    || !validBinding(value.binding) || !amount(value.observedAtMs) || !amount(value.validUntilMs)
    || value.validUntilMs <= value.observedAtMs || value.validUntilMs - value.observedAtMs > MAX_SNAPSHOT_AGE_MS
    || !nullableAmount(value.remainingBudgetMicros) || !Array.isArray(value.capabilities)
    || value.capabilities.length > 128) throw new Error("context_invalid");
  const capabilities: ChefCapabilityDescriptor[] = [];
  const seen = new Set<string>();
  for (const candidate of value.capabilities) {
    if (!record(candidate) || !exactKeys(candidate,
      ["id", "kind", "version", "provides", "requires", "qualified", "available", "authorized", "quality", "estimatedCostMicros"],
      candidate.kind === "connector" ? ["webAccess"] : [])
      || !id(candidate.id) || seen.has(candidate.id)
      || (candidate.kind !== "skill" && candidate.kind !== "connector")
      || typeof candidate.version !== "string" || !VERSION.test(candidate.version)
      || typeof candidate.qualified !== "boolean" || typeof candidate.available !== "boolean" || typeof candidate.authorized !== "boolean"
      || !(candidate.quality === null || (typeof candidate.quality === "number" && Number.isFinite(candidate.quality)
        && candidate.quality >= 0 && candidate.quality <= 1))
      || !nullableAmount(candidate.estimatedCostMicros)) throw new Error("context_invalid");
    const provides = identifiers(candidate.provides, "provides", true);
    const requires = identifiers(candidate.requires, "requires", true);
    let webAccess: ChefCapabilityDescriptor["webAccess"];
    if (candidate.kind === "connector") {
      const access = candidate.webAccess;
      if (!record(access) || !exactKeys(access, ["intent", "userId", "context"])
        || typeof access.userId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(access.userId)) {
        throw new Error("context_invalid");
      }
      if (access.userId !== value.binding.userId) throw new Error("context_binding_mismatch");
      const intent = parseWebAccessIntent(access.intent);
      const operationId = `${value.binding.taskId}:${candidate.id}`;
      // Long task/capability IDs may use an opaque operation ID supplied by the
      // trusted resolver. The complete snapshot still binds it to this task.
      if (operationId.length <= 200 && intent.operationId !== operationId) throw new Error("context_binding_mismatch");
      webAccess = { intent, userId: access.userId, context: access.context };
    }
    seen.add(candidate.id);
    capabilities.push({
      id: candidate.id, kind: candidate.kind, version: candidate.version, provides, requires,
      qualified: candidate.qualified, available: candidate.available, authorized: candidate.authorized,
      quality: candidate.quality as number | null, estimatedCostMicros: candidate.estimatedCostMicros,
      ...(webAccess ? { webAccess } : {}),
    });
  }
  const byId = new Map(capabilities.map(capability => [capability.id, capability]));
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (active.has(key)) throw new Error("dependency_cycle");
    const capability = byId.get(key);
    if (!capability) throw new Error("dependency_unknown");
    active.add(key);
    for (const dependency of capability.requires) visit(dependency);
    active.delete(key);
    visited.add(key);
  };
  for (const capability of capabilities) visit(capability.id);
  return { binding: { ...value.binding }, observedAtMs: value.observedAtMs,
    validUntilMs: value.validUntilMs, remainingBudgetMicros: value.remainingBudgetMicros, capabilities };
}

/** Pure, deterministic preparation. It neither grants rights nor invokes skills,
 * connects accounts, reserves money or executes tools. The host must enforce the
 * selected version/allowlist at invocation and revalidate before an external effect.
 * Automatic coverage is greedy and bounded; it is not a global optimum guarantee. */
export function resolveChefCapabilities(
  selection: ChefCapabilitySelection,
  suppliedContext: unknown,
  expectedBinding: ChefCapabilityBinding,
  nowMs: number,
): ChefCapabilityResolution {
  let preferences: ChefCapabilitySelection | null = null;
  let binding: ChefCapabilityBinding | null = null;
  const result = (status: "ready" | "blocked", reason: string,
    selected: ChefCapabilityResolution["selected"] = [], estimatedCostMicros: number | null = null): ChefCapabilityResolution => ({
    status, reason, selected, estimatedCostMicros,
    selectionHash: createHash("sha256").update(JSON.stringify({
      schemaVersion: 1, binding, preferences, selected, estimatedCostMicros,
    })).digest("hex"),
  });
  try { preferences = normalizeChefCapabilitySelection(selection); }
  catch { return result("blocked", "selection_invalid"); }
  if (!validBinding(expectedBinding) || !amount(nowMs)) return result("blocked", "binding_invalid");
  binding = { userId: expectedBinding.userId, missionId: expectedBinding.missionId, taskId: expectedBinding.taskId, briefHash: expectedBinding.briefHash };
  if (suppliedContext === null || suppliedContext === undefined) return result("blocked", "context_missing");
  let context: ChefCapabilityContext;
  try { context = parseContext(suppliedContext); }
  catch (error) {
    const reason = error instanceof Error && ["dependency_cycle", "dependency_unknown", "context_binding_mismatch"].includes(error.message)
      ? error.message : "context_invalid";
    return result("blocked", reason);
  }
  if (context.binding.userId !== binding.userId || context.binding.missionId !== binding.missionId || context.binding.taskId !== binding.taskId
    || context.binding.briefHash !== binding.briefHash) return result("blocked", "context_binding_mismatch");
  if (context.observedAtMs > nowMs || context.validUntilMs <= nowMs
    || nowMs - context.observedAtMs > MAX_SNAPSHOT_AGE_MS) return result("blocked", "context_stale");
  if (context.remainingBudgetMicros === null) return result("blocked", "budget_unknown");
  const budget = context.remainingBudgetMicros;
  const byId = new Map(context.capabilities.map(capability => [capability.id, capability]));
  const excluded = new Set(preferences.excludedIds);
  const needs = new Set(preferences.needs);
  const closure = (key: string, target = new Set<string>()): Set<string> => {
    if (target.has(key)) return target;
    target.add(key);
    for (const dependency of byId.get(key)!.requires) closure(dependency, target);
    return target;
  };
  const costs = new Map<string, number>();
  const webCosts = new Map<string, number>();
  type Evaluation = { ok: true } | { ok: false; reason: string; terminal: boolean };
  const evaluate = (keys: Set<string>): Evaluation => {
    for (const key of [...keys].sort(compare)) {
      const capability = byId.get(key)!;
      if (excluded.has(key)) return { ok: false, reason: "capability_excluded", terminal: false };
      if (!capability.qualified || !capability.available || !capability.authorized) {
        return { ok: false, reason: "capability_unavailable", terminal: false };
      }
    }
    // Check all web decisions before rejecting an unknown skill cost. Otherwise
    // an earlier cheap/unknown dependency could hide a terminal permission denial
    // and allow another candidate to bypass it.
    for (const key of [...keys].sort(compare)) {
      const capability = byId.get(key)!;
      if (capability.kind === "connector" && !webCosts.has(key)) {
        const access = capability.webAccess!;
        let webPlan;
        try { webPlan = planWebCapabilityAccess(access.intent, access.userId, access.context, nowMs); }
        catch { return { ok: false, reason: "connector_context_invalid", terminal: true }; }
        if (webPlan.status !== "preparation_ready"
          || !["structured_route_prepared", "validated_recipe_prepared"].includes(webPlan.reason)) {
          return { ok: false, reason: `connector_${webPlan.reason}`, terminal: !RETRYABLE_WEB_OBSTACLES.has(webPlan.reason) };
        }
        if (webPlan.estimatedExecutionCostMicros === null) return { ok: false, reason: "capability_cost_unknown", terminal: true };
        webCosts.set(key, webPlan.estimatedExecutionCostMicros);
      }
    }
    for (const key of [...keys].sort(compare)) {
      if (costs.has(key)) continue;
      const capability = byId.get(key)!;
      if (capability.estimatedCostMicros === null) return { ok: false, reason: "capability_cost_unknown", terminal: false };
      costs.set(key, Math.max(capability.estimatedCostMicros, webCosts.get(key) ?? 0));
    }
    return { ok: true };
  };
  const totalCost = (keys: Set<string>): number => [...keys].reduce((sum, key) => sum + costs.get(key)!, 0);
  const coverage = (keys: Set<string>): Set<string> => new Set([...keys].flatMap(key => byId.get(key)!.provides).filter(need => needs.has(need)));
  let chosen = new Set<string>();
  if (preferences.mode === "manual") {
    if (preferences.selectedIds.some(key => !byId.has(key))) return result("blocked", "capability_unknown");
    chosen = new Set(preferences.selectedIds);
    if ([...chosen].some(key => byId.get(key)!.requires.some(dependency => !chosen.has(dependency)))) {
      return result("blocked", "manual_dependency_missing");
    }
    const evaluation = evaluate(chosen);
    if (!evaluation.ok) return result("blocked", evaluation.reason);
  } else {
    const candidates: Array<{ id: string; keys: Set<string> }> = [];
    let obstacle = "needs_uncovered";
    for (const capability of [...context.capabilities].sort((a, b) => compare(a.id, b.id))) {
      if (!capability.provides.some(need => needs.has(need)) || excluded.has(capability.id)) continue;
      const keys = closure(capability.id);
      const evaluation = evaluate(keys);
      if (!evaluation.ok) {
        if (evaluation.terminal) return result("blocked", evaluation.reason);
        if (obstacle === "needs_uncovered") obstacle = evaluation.reason;
        continue;
      }
      candidates.push({ id: capability.id, keys });
    }
    while (coverage(chosen).size < needs.size) {
      const covered = coverage(chosen);
      const options = candidates.flatMap(candidate => {
        const combined = new Set([...chosen, ...candidate.keys]);
        const gain = [...coverage(combined)].filter(need => !covered.has(need)).length;
        if (gain === 0) return [];
        if (combined.size > preferences!.maxSelected) { obstacle = "selection_limit"; return []; }
        const cost = totalCost(combined);
        if (!Number.isSafeInteger(cost) || cost > budget) { obstacle = "budget_insufficient"; return []; }
        const quality = Math.min(...[...candidate.keys].filter(key => !chosen.has(key)).map(key => byId.get(key)!.quality ?? -1));
        return [{ ...candidate, combined, gain, quality, cost }];
      }).sort((a, b) => b.gain - a.gain || b.quality - a.quality || a.cost - b.cost || compare(a.id, b.id));
      if (options.length === 0) return result("blocked", obstacle);
      chosen = options[0].combined;
    }
  }
  if (chosen.size > preferences.maxSelected) return result("blocked", "selection_limit");
  if (coverage(chosen).size !== needs.size) return result("blocked", "needs_uncovered");
  const cost = totalCost(chosen);
  if (!Number.isSafeInteger(cost) || cost > budget) return result("blocked", "budget_insufficient");
  const selected = [...chosen].sort(compare).map(key => {
    const capability = byId.get(key)!;
    return { id: capability.id, kind: capability.kind, version: capability.version };
  });
  return result("ready", preferences.mode === "auto" ? "automatic_selection" : "manual_selection", selected, cost);
}
