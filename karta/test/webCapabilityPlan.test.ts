import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  MAX_WEB_CONTEXT_AGE_MS, WEB_ACCESS_ACTIONS, WEB_ACCESS_METHODS,
  parseWebAccessIntent, planWebCapabilityAccess,
  type TrustedWebAccessContext, type TrustedWebAccessRoute, type WebAccessAction,
  type WebAccessIntent, type WebAccessMethod,
} from "../src/lib/web-capability-plan.js";

const now = 1_800_000_000_000;
const intent: WebAccessIntent = { serviceId: "provider-a", action: "read", operationId: "operation-1" };
function context(action: WebAccessAction = "read"): TrustedWebAccessContext {
  return {
    binding: { ...intent, action, userId: "tenant-1", accountId: "account-1" },
    observedAtMs: now - 100, validUntilMs: now + 60_000,
    authorization: { state: "granted", expiresAtMs: now + 60_000, allowedActions: [action] },
    account: { state: "connected", challenge: "none" },
    operation: { state: "not_started", receiptVerified: false },
    remainingBudgetMicros: 100, routes: {},
  };
}
function route(ctx: TrustedWebAccessContext, method: WebAccessMethod, changes: Partial<TrustedWebAccessRoute> = {}): void {
  ctx.routes[method] = {
    binding: { ...ctx.binding }, available: true, policy: "allowed", allowedActions: [ctx.binding.action],
    credential: "valid", credentialExpiresAtMs: now + 60_000, checkedAtMs: now - 100,
    validUntilMs: now + 60_000, estimatedCostMicros: 10,
    ...(method === "browser_recipe" ? { recipeValidation: "current" as const } : {}), ...changes,
  };
}
function plan(ctx: unknown, request = intent) { return planWebCapabilityAccess(request, "tenant-1", ctx, now); }

describe("web capability planning policy", () => {
  it("prefers the authorized API while keeping planning separate from execution and billing", () => {
    const ctx = context();
    for (const method of WEB_ACCESS_METHODS) route(ctx, method);
    const before = JSON.stringify(ctx);
    const result = plan(ctx);
    expect(result).toMatchObject({ phase: "planning", executionPerformed: false, status: "preparation_ready", route: "official_api", planningModelCalls: 0, budgetReservationPerformed: false });
    expect(JSON.stringify(ctx)).toBe(before);
    expect(JSON.stringify(result).slice(0, 200)).toContain('"executionPerformed":false');
    expect(JSON.stringify(result).slice(0, 200)).toContain('"status":"preparation_ready"');
  });

  it.each(["mcp", "webmcp", "browser_recipe"] as const)("can prepare the authorized %s route", method => {
    const ctx = context(); route(ctx, method);
    expect(plan(ctx)).toMatchObject({ route: method, status: "preparation_ready" });
  });

  it("treats adaptive browser support only as preparation and repairs stale recipes without replay", () => {
    const ctx = context(); route(ctx, "browser_recipe", { recipeValidation: "stale" }); route(ctx, "adaptive_browser");
    expect(plan(ctx)).toMatchObject({ route: "adaptive_browser", status: "adaptive_preparation", executionPerformed: false });
    delete ctx.routes.adaptive_browser;
    expect(plan(ctx)).toMatchObject({ route: null, status: "blocked_external" });
  });

  it.each(["missing", "revoked"] as const)("blocks %s grants before reporting prior success", state => {
    const ctx = context(); ctx.authorization.state = state; ctx.operation = { state: "completed", receiptVerified: true };
    expect(plan(ctx)).toMatchObject({ route: null, status: "blocked", reason: `authorization_${state}` });
  });

  it("enforces permission expiry at equality and rejects missing action scope", () => {
    const ctx = context(); route(ctx, "official_api"); ctx.authorization.expiresAtMs = now;
    expect(plan(ctx).reason).toBe("authorization_expired");
    ctx.authorization.expiresAtMs = now + 1; ctx.authorization.allowedActions = ["write"];
    expect(plan(ctx).reason).toBe("action_not_authorized");
  });

  it.each(["userId", "serviceId", "action", "operationId"] as const)("rejects a cross-bound context for %s", field => {
    const ctx = context(); route(ctx, "official_api");
    if (field === "action") ctx.binding.action = "write"; else ctx.binding[field] = "other-identity";
    expect(plan(ctx)).toMatchObject({ route: null, status: "blocked", reason: "context_binding_mismatch" });
  });

  it.each(["userId", "serviceId", "action", "operationId", "accountId"] as const)("binds route credentials to the exact %s", field => {
    const ctx = context(); route(ctx, "official_api"); route(ctx, "browser_recipe");
    const candidate = ctx.routes.official_api!;
    if (field === "action") candidate.binding.action = "write"; else candidate.binding[field] = "other-identity";
    expect(plan(ctx)).toMatchObject({ route: null, status: "blocked", reason: "route_binding_mismatch" });
  });

  it.each(["uncertain", "in_progress", "completed"] as const)("requires reconciliation for unconfirmed %s effects without fallback", state => {
    const ctx = context(); route(ctx, "official_api"); route(ctx, "browser_recipe");
    ctx.operation = { state, receiptVerified: false }; ctx.remainingBudgetMicros = 0;
    expect(plan(ctx)).toMatchObject({ status: "reconciliation_required", route: null, reason: "previous_effect_uncertain" });
  });

  it("reports a verified completed operation without suggesting another operation", () => {
    const ctx = context(); ctx.operation = { state: "completed", receiptVerified: true }; ctx.remainingBudgetMicros = null;
    expect(plan(ctx)).toMatchObject({ status: "already_completed", route: null, executionPerformed: false });
  });

  it("reconciles a verified receipt contradicting a not-started operation", () => {
    const ctx = context(); route(ctx, "official_api"); route(ctx, "browser_recipe");
    ctx.operation = { state: "not_started", receiptVerified: true };
    expect(plan(ctx)).toMatchObject({ status: "reconciliation_required", route: null, reason: "previous_effect_uncertain" });
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid budget %s", value => {
    const ctx = context(); route(ctx, "official_api"); ctx.remainingBudgetMicros = value;
    expect(plan(ctx)).toMatchObject({ status: "blocked_external", route: null, reason: "context_invalid" });
  });

  it("does not treat an unknown budget or cost as zero, and never reserves the estimate", () => {
    const ctx = context(); route(ctx, "official_api"); ctx.remainingBudgetMicros = null;
    expect(plan(ctx).reason).toBe("budget_unknown");
    ctx.remainingBudgetMicros = 100; ctx.routes.official_api!.estimatedCostMicros = null;
    expect(plan(ctx).reason).toBe("execution_cost_unknown");
    ctx.routes.official_api!.estimatedCostMicros = 101;
    expect(plan(ctx).reason).toBe("budget_insufficient");
    ctx.routes.official_api!.estimatedCostMicros = 0; ctx.remainingBudgetMicros = 0;
    expect(plan(ctx)).toMatchObject({ status: "preparation_ready", estimatedExecutionCostMicros: 0, budgetReservationPerformed: false });
    expect(ctx.remainingBudgetMicros).toBe(0);
  });

  it.each(["mfa", "captcha", "kyc"] as const)("requires official human completion for %s", challenge => {
    const ctx = context(); route(ctx, "official_api"); ctx.account.challenge = challenge;
    expect(plan(ctx)).toMatchObject({ status: "blocked_human", route: null, reason: `${challenge}_required` });
  });

  it("does not reuse browser credentials as API authorization or bypass policy refusal", () => {
    const ctx = context(); route(ctx, "official_api", { credential: "missing" }); route(ctx, "browser_recipe");
    expect(plan(ctx)).toMatchObject({ route: "browser_recipe", status: "preparation_ready" });
    ctx.routes.official_api!.policy = "denied"; ctx.routes.official_api!.available = false;
    expect(plan(ctx)).toMatchObject({ status: "blocked", route: null, reason: "route_policy_denied" });
    ctx.routes.official_api!.policy = "allowed";
    expect(plan(ctx).route).toBe("browser_recipe");
  });

  it("can choose a separately authorized route within budget, never an over-budget route", () => {
    const ctx = context(); ctx.remainingBudgetMicros = 10;
    route(ctx, "official_api", { estimatedCostMicros: 11 });
    route(ctx, "mcp", { estimatedCostMicros: 1 });
    expect(plan(ctx)).toMatchObject({ route: "mcp", estimatedExecutionCostMicros: 1, budgetReservationPerformed: false });
    ctx.routes.mcp!.policy = "denied";
    route(ctx, "browser_recipe", { estimatedCostMicros: 0 });
    expect(plan(ctx)).toMatchObject({ route: null, status: "blocked", reason: "route_policy_denied" });
  });

  it.each(["stale", "expired", "unknown_cost"] as const)("can use a fresh authorized alternative after an API %s obstacle", obstacle => {
    const ctx = context(); route(ctx, "official_api"); route(ctx, "mcp");
    if (obstacle === "stale") ctx.routes.official_api!.validUntilMs = now;
    if (obstacle === "expired") ctx.routes.official_api!.credentialExpiresAtMs = now;
    if (obstacle === "unknown_cost") ctx.routes.official_api!.estimatedCostMicros = null;
    expect(plan(ctx)).toMatchObject({ route: "mcp", status: "preparation_ready" });
  });

  it("rejects expired, future or stale snapshots and route credentials", () => {
    const ctx = context(); route(ctx, "official_api");
    ctx.validUntilMs = now;
    expect(plan(ctx).reason).toBe("context_stale");
    ctx.validUntilMs = now + 60_000; ctx.observedAtMs = now + 1;
    expect(plan(ctx).reason).toBe("context_stale");
    ctx.observedAtMs = now - MAX_WEB_CONTEXT_AGE_MS - 1;
    expect(plan(ctx).reason).toBe("context_stale");
    ctx.observedAtMs = now; ctx.routes.official_api!.credentialExpiresAtMs = now;
    expect(plan(ctx).reason).toBe("route_credentials_expired");
    ctx.routes.official_api!.credentialExpiresAtMs = now + 1; ctx.routes.official_api!.validUntilMs = now;
    expect(plan(ctx).reason).toBe("route_stale");
  });

  it("does not mistake a connected account for a missing route scope", () => {
    const ctx = context(); route(ctx, "mcp", { allowedActions: ["write"] }); route(ctx, "browser_recipe");
    expect(plan(ctx)).toMatchObject({ reason: "route_scope_missing", route: null });
  });

  it("reuses an existing account and never proposes a duplicate registration", () => {
    const ctx = context("create_account"); route(ctx, "official_onboarding");
    const request = { ...intent, action: "create_account" as const };
    expect(plan(ctx, request)).toMatchObject({ route: "existing_account", reason: "reuse_existing_account", executionPerformed: false });
    ctx.account.state = "disconnected";
    expect(plan(ctx, request)).toMatchObject({ route: null, status: "blocked_human", reason: "reconnect_existing_account" });
  });

  it.each(["create_account", "create_api_key"] as const)("prepares only the official path for %s", action => {
    const ctx = context(action);
    if (action === "create_account") { ctx.account.state = "missing"; ctx.binding.accountId = null; }
    route(ctx, "official_api"); route(ctx, "adaptive_browser");
    route(ctx, "official_onboarding", { credential: action === "create_account" ? "not_required" : "valid" });
    expect(plan(ctx, { ...intent, action })).toMatchObject({ route: "official_onboarding", status: "preparation_ready", executionPerformed: false });
  });

  it("requires an account for key preparation, but permits an authorized public read route", () => {
    const ctx = context("create_api_key"); ctx.account.state = "missing"; ctx.binding.accountId = null;
    expect(plan(ctx, { ...intent, action: "create_api_key" }).reason).toBe("account_connection_required");
    const publicContext = context(); publicContext.account.state = "missing"; publicContext.binding.accountId = null;
    route(publicContext, "official_api", { credential: "not_required", credentialExpiresAtMs: null });
    expect(plan(publicContext).route).toBe("official_api");
  });

  it("returns no resolver data or secrets in a plan", () => {
    const ctx = context(); route(ctx, "official_api");
    const untrustedExtras = { ...ctx, accessToken: "secret-token", cookies: ["private-cookie"], apiKey: "secret-key" };
    const serialized = JSON.stringify(plan(untrustedExtras));
    expect(serialized).not.toMatch(/secret|cookie|tenant-1|account-1/);
  });

  it("blocks absent or malformed capability context", () => {
    expect(plan(null).reason).toBe("context_missing");
    expect(plan({}).reason).toBe("context_invalid");
    expect(plan(context()).reason).toBe("no_available_route");
    const ctx = context(); route(ctx, "official_api"); ctx.routes.official_api!.estimatedCostMicros = NaN;
    expect(plan(ctx).reason).toBe("context_invalid");
  });

  it("rejects extra authorization fields, exotic objects and unbounded identifiers", () => {
    expect(() => parseWebAccessIntent({ ...intent, authorized: true })).toThrow();
    expect(() => parseWebAccessIntent(Object.assign(Object.create({ authorized: true }), intent))).toThrow();
    expect(() => parseWebAccessIntent({ ...intent, operationId: "x".repeat(201) })).toThrow();
    expect(() => parseWebAccessIntent({ ...intent, serviceId: "https://example.com" })).toThrow();
  });
});

describe("bounded generated policy inputs (not an AI or website benchmark)", () => {
  it("1000 varied contexts cannot execute or reserve funds; uncertainty cannot become fallback", () => {
    fc.assert(fc.property(fc.record({
      action: fc.constantFrom(...WEB_ACCESS_ACTIONS), method: fc.constantFrom(...WEB_ACCESS_METHODS),
      available: fc.boolean(), denied: fc.boolean(), cost: fc.integer({ min: 0, max: 200 }),
      budget: fc.integer({ min: 0, max: 200 }), uncertain: fc.boolean(), revoked: fc.boolean(),
      age: fc.integer({ min: 0, max: 400_000 }),
    }), variation => {
      const ctx = context(variation.action);
      ctx.remainingBudgetMicros = variation.budget;
      ctx.observedAtMs = now - variation.age;
      ctx.authorization.state = variation.revoked ? "revoked" : "granted";
      ctx.operation.state = variation.uncertain ? "uncertain" : "not_started";
      route(ctx, variation.method, { available: variation.available, policy: variation.denied ? "denied" : "allowed", estimatedCostMicros: variation.cost });
      const before = JSON.stringify(ctx);
      const result = plan(ctx, { ...intent, action: variation.action });
      expect(result.executionPerformed).toBe(false);
      expect(result.budgetReservationPerformed).toBe(false);
      expect(result.planningModelCalls).toBe(0);
      if (result.estimatedExecutionCostMicros !== null) {
        expect(result.estimatedExecutionCostMicros).toBeLessThanOrEqual(variation.budget);
      }
      expect(JSON.stringify(ctx)).toBe(before);
      if (variation.revoked) expect(result.status).toBe("blocked");
      if (variation.uncertain && !variation.revoked && variation.age <= MAX_WEB_CONTEXT_AGE_MS) {
        expect(result.status).toBe("reconciliation_required"); expect(result.route).toBeNull();
      }
    }), { numRuns: 1000, seed: 20261101 });
  });

  it("1000 forged policy fields cannot enter the intention contract", () => {
    fc.assert(fc.property(
      fc.constantFrom("authorized", "userId", "accountId", "budget", "apiKey", "routes", "policy", "credential"),
      fc.jsonValue(), (key, forgedValue) => {
        expect(() => parseWebAccessIntent({ ...intent, [key]: forgedValue })).toThrow();
      },
    ), { numRuns: 1000, seed: 20261102 });
  });
});
