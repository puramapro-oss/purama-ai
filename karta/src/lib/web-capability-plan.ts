/**
 * Deterministic preparation only: no browser, HTTP request, model call, credential
 * storage, authorization grant or budget reservation happens in this module.
 * A plan is not an execution ticket. A future executor must recheck its trusted
 * policy, reserve the real cost and verify the external effect independently.
 */
export const WEB_ACCESS_ACTIONS = ["read", "write", "create_account", "create_api_key"] as const;
export type WebAccessAction = typeof WEB_ACCESS_ACTIONS[number];
export const WEB_ACCESS_METHODS = [
  "official_api", "mcp", "webmcp", "browser_recipe", "adaptive_browser", "official_onboarding",
] as const;
export type WebAccessMethod = typeof WEB_ACCESS_METHODS[number];
export const MAX_WEB_CONTEXT_AGE_MS = 5 * 60_000;

export interface WebAccessIntent {
  serviceId: string;
  action: WebAccessAction;
  operationId: string;
}

export interface WebAccessBinding extends WebAccessIntent {
  userId: string;
  /** Opaque server-side account identity; null only when no account is linked. */
  accountId: string | null;
}

export interface TrustedWebAccessRoute {
  binding: WebAccessBinding;
  available: boolean;
  /** An explicit policy refusal must never trigger fallback to another channel. */
  policy: "allowed" | "denied";
  allowedActions: WebAccessAction[];
  credential: "valid" | "missing" | "expired" | "not_required";
  credentialExpiresAtMs: number | null;
  checkedAtMs: number;
  validUntilMs: number;
  /** null means unknown, not free. Estimate only: the planner reserves nothing. */
  estimatedCostMicros: number | null;
  recipeValidation?: "current" | "stale" | "unvalidated";
}

/**
 * Supplied by trusted server code, never as an LLM tool parameter. The resolver
 * must verify scopes and ownership from canonical records, not a web page or
 * model assertion. No tokens, cookies, URLs or secret values belong here.
 */
export interface TrustedWebAccessContext {
  binding: WebAccessBinding;
  observedAtMs: number;
  validUntilMs: number;
  authorization: {
    state: "granted" | "missing" | "revoked";
    expiresAtMs: number | null;
    allowedActions: WebAccessAction[];
  };
  account: {
    state: "connected" | "disconnected" | "missing";
    challenge: "none" | "mfa" | "captcha" | "kyc";
  };
  operation: {
    state: "not_started" | "in_progress" | "uncertain" | "completed";
    /** True only after independent confirmation of this exact bound operation. */
    receiptVerified: boolean;
  };
  remainingBudgetMicros: number | null;
  routes: Partial<Record<WebAccessMethod, TrustedWebAccessRoute>>;
}

export type WebAccessPlanStatus =
  | "preparation_ready" | "adaptive_preparation" | "blocked"
  | "blocked_human" | "blocked_external" | "reconciliation_required" | "already_completed";

export type WebAccessPlanReason =
  | "context_missing" | "context_invalid" | "context_binding_mismatch" | "context_stale"
  | "authorization_missing" | "authorization_revoked" | "authorization_expired" | "action_not_authorized"
  | "previous_effect_uncertain" | "previous_effect_confirmed" | "budget_unknown" | "budget_insufficient"
  | "mfa_required" | "captcha_required" | "kyc_required" | "reuse_existing_account"
  | "reconnect_existing_account" | "account_connection_required" | "route_policy_denied"
  | "route_binding_mismatch" | "route_scope_missing" | "route_stale" | "route_credentials_missing"
  | "route_credentials_expired" | "execution_cost_unknown" | "no_available_route"
  | "structured_route_prepared" | "validated_recipe_prepared" | "adaptive_recipe_preparation_only"
  | "official_account_preparation_only" | "official_key_preparation_only" | "resolver_unavailable";

export interface WebAccessPlan {
  // Keep these fields first: legacy KARTA logs retain only the first 200 characters.
  phase: "planning";
  executionPerformed: false;
  status: WebAccessPlanStatus;
  route: WebAccessMethod | "existing_account" | null;
  reason: WebAccessPlanReason;
  budgetReservationPerformed: false;
  planningModelCalls: 0;
  estimatedExecutionCostMicros: number | null;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function amount(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function nullableAmount(value: unknown): boolean { return value === null || amount(value); }
function choice<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}
function actions(value: unknown): value is WebAccessAction[] {
  return Array.isArray(value) && value.length <= WEB_ACCESS_ACTIONS.length
    && value.every(item => choice(item, WEB_ACCESS_ACTIONS)) && new Set(value).size === value.length;
}
function binding(value: unknown): value is WebAccessBinding {
  return record(value) && id(value.userId) && id(value.serviceId) && id(value.operationId)
    && choice(value.action, WEB_ACCESS_ACTIONS) && (value.accountId === null || id(value.accountId));
}

/** Strictly rejects forged policy/credentials/owner fields before any resolution. */
export function parseWebAccessIntent(value: unknown): WebAccessIntent {
  if (!record(value) || Object.keys(value).length !== 3
    || !Object.hasOwn(value, "serviceId") || !Object.hasOwn(value, "action") || !Object.hasOwn(value, "operationId")
    || !id(value.serviceId) || !id(value.operationId) || !choice(value.action, WEB_ACCESS_ACTIONS)) {
    throw new Error("Intention web invalide : serviceId, action et operationId uniquement");
  }
  return { serviceId: value.serviceId, action: value.action, operationId: value.operationId };
}

export function isWebAccessUserId(value: unknown): value is string { return id(value); }

function validContext(value: unknown): value is TrustedWebAccessContext {
  if (!record(value) || !binding(value.binding) || !amount(value.observedAtMs) || !amount(value.validUntilMs)
    || value.validUntilMs <= value.observedAtMs || !nullableAmount(value.remainingBudgetMicros)
    || !record(value.authorization) || !record(value.account) || !record(value.operation) || !record(value.routes)) return false;
  const authorization = value.authorization;
  if (!choice(authorization.state, ["granted", "missing", "revoked"])
    || !nullableAmount(authorization.expiresAtMs) || !actions(authorization.allowedActions)) return false;
  if (!choice(value.account.state, ["connected", "disconnected", "missing"])
    || !choice(value.account.challenge, ["none", "mfa", "captcha", "kyc"])) return false;
  if ((value.account.state === "missing") !== (value.binding.accountId === null)) return false;
  if (!choice(value.operation.state, ["not_started", "in_progress", "uncertain", "completed"])
    || typeof value.operation.receiptVerified !== "boolean") return false;
  if (Object.keys(value.routes).length > WEB_ACCESS_METHODS.length) return false;
  for (const [method, route] of Object.entries(value.routes)) {
    if (!choice(method, WEB_ACCESS_METHODS) || !record(route) || !binding(route.binding)
      || typeof route.available !== "boolean" || !choice(route.policy, ["allowed", "denied"])
      || !actions(route.allowedActions) || !choice(route.credential, ["valid", "missing", "expired", "not_required"])
      || !nullableAmount(route.credentialExpiresAtMs) || !amount(route.checkedAtMs) || !amount(route.validUntilMs)
      || route.validUntilMs <= route.checkedAtMs || !nullableAmount(route.estimatedCostMicros)) return false;
    if (method === "browser_recipe" && !choice(route.recipeValidation, ["current", "stale", "unvalidated"])) return false;
  }
  return true;
}

function matches(left: WebAccessBinding, right: WebAccessBinding): boolean {
  return left.userId === right.userId && left.serviceId === right.serviceId && left.action === right.action
    && left.operationId === right.operationId && left.accountId === right.accountId;
}

function fresh(observedAtMs: number, validUntilMs: number, nowMs: number): boolean {
  return observedAtMs <= nowMs && nowMs < validUntilMs && nowMs - observedAtMs <= MAX_WEB_CONTEXT_AGE_MS;
}

export function webAccessPlanResult(
  status: WebAccessPlanStatus, reason: WebAccessPlanReason,
  route: WebAccessPlan["route"] = null, estimatedExecutionCostMicros: number | null = null,
): WebAccessPlan {
  return {
    phase: "planning", executionPerformed: false, status, route, reason,
    budgetReservationPerformed: false, planningModelCalls: 0, estimatedExecutionCostMicros,
  };
}

/** Pure policy evaluation. All time comes from the caller's trusted clock. */
export function planWebCapabilityAccess(
  rawIntent: WebAccessIntent, userId: string, suppliedContext: unknown, nowMs: number,
): WebAccessPlan {
  const intent = parseWebAccessIntent(rawIntent);
  if (!id(userId) || !amount(nowMs)) throw new Error("Contexte d'appel web invalide");
  if (suppliedContext === null || suppliedContext === undefined) return webAccessPlanResult("blocked_external", "context_missing");
  if (!validContext(suppliedContext)) return webAccessPlanResult("blocked_external", "context_invalid");
  const context = suppliedContext;
  if (context.binding.userId !== userId || context.binding.serviceId !== intent.serviceId
    || context.binding.action !== intent.action || context.binding.operationId !== intent.operationId) {
    return webAccessPlanResult("blocked", "context_binding_mismatch");
  }
  if (context.authorization.state === "revoked") return webAccessPlanResult("blocked", "authorization_revoked");
  if (context.authorization.state !== "granted") return webAccessPlanResult("blocked", "authorization_missing");
  if (context.authorization.expiresAtMs === null || context.authorization.expiresAtMs <= nowMs) {
    return webAccessPlanResult("blocked", "authorization_expired");
  }
  if (!context.authorization.allowedActions.includes(intent.action)) return webAccessPlanResult("blocked", "action_not_authorized");
  if (!fresh(context.observedAtMs, context.validUntilMs, nowMs)) return webAccessPlanResult("blocked_external", "context_stale");

  if (context.operation.state === "uncertain" || context.operation.state === "in_progress"
    || (context.operation.state === "not_started" && context.operation.receiptVerified)
    || (context.operation.state === "completed" && !context.operation.receiptVerified)) {
    return webAccessPlanResult("reconciliation_required", "previous_effect_uncertain");
  }
  if (context.operation.state === "completed") return webAccessPlanResult("already_completed", "previous_effect_confirmed");
  if (context.remainingBudgetMicros === null) return webAccessPlanResult("blocked_external", "budget_unknown");
  const challenge = context.account.challenge;
  if (challenge !== "none") return webAccessPlanResult("blocked_human", `${challenge}_required`);

  if (intent.action === "create_account" && context.binding.accountId !== null) {
    return context.account.state === "connected"
      ? webAccessPlanResult("preparation_ready", "reuse_existing_account", "existing_account", 0)
      : webAccessPlanResult("blocked_human", "reconnect_existing_account");
  }
  if (intent.action === "create_api_key" && context.account.state !== "connected") {
    return webAccessPlanResult("blocked_human", "account_connection_required");
  }

  const methods: readonly WebAccessMethod[] = intent.action === "create_account" || intent.action === "create_api_key"
    ? ["official_onboarding"] : ["official_api", "mcp", "webmcp", "browser_recipe", "adaptive_browser"];
  // Technical/price obstacles do not grant access, but may leave an independently
  // authorized alternative usable. Preserve the first diagnostic if none works.
  // Explicit denials, missing action scope and identity mismatches remain terminal.
  let firstObstacle: WebAccessPlan | undefined;
  for (const method of methods) {
    const route = context.routes[method];
    if (!route) continue;
    if (route.policy === "denied") return webAccessPlanResult("blocked", "route_policy_denied");
    if (!route.available) continue;
    if (!matches(route.binding, context.binding)) return webAccessPlanResult("blocked", "route_binding_mismatch");
    if (!route.allowedActions.includes(intent.action)) return webAccessPlanResult("blocked", "route_scope_missing");
    if (!fresh(route.checkedAtMs, route.validUntilMs, nowMs)) {
      firstObstacle ??= webAccessPlanResult("blocked_external", "route_stale");
      continue;
    }
    if (route.credential === "missing") {
      firstObstacle ??= webAccessPlanResult("blocked_human", "route_credentials_missing");
      continue;
    }
    if (route.credential === "expired" || (route.credential === "valid"
      && (route.credentialExpiresAtMs === null || route.credentialExpiresAtMs <= nowMs))) {
      firstObstacle ??= webAccessPlanResult("blocked_human", "route_credentials_expired");
      continue;
    }
    if (route.credential === "valid" && context.account.state !== "connected") {
      firstObstacle ??= webAccessPlanResult("blocked_human", "account_connection_required");
      continue;
    }
    if (method === "browser_recipe" && route.recipeValidation !== "current") continue;
    if (route.estimatedCostMicros === null) {
      firstObstacle ??= webAccessPlanResult("blocked_external", "execution_cost_unknown");
      continue;
    }
    if (route.estimatedCostMicros > context.remainingBudgetMicros) {
      firstObstacle ??= webAccessPlanResult("blocked", "budget_insufficient");
      continue;
    }
    if (method === "official_onboarding") {
      return webAccessPlanResult("preparation_ready", intent.action === "create_account"
        ? "official_account_preparation_only" : "official_key_preparation_only", method, route.estimatedCostMicros);
    }
    if (method === "adaptive_browser") {
      return webAccessPlanResult("adaptive_preparation", "adaptive_recipe_preparation_only", method, route.estimatedCostMicros);
    }
    return webAccessPlanResult("preparation_ready", method === "browser_recipe"
      ? "validated_recipe_prepared" : "structured_route_prepared", method, route.estimatedCostMicros);
  }
  return firstObstacle ?? webAccessPlanResult("blocked_external", "no_available_route");
}
