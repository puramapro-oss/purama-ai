import { describe, expect, it, vi } from "vitest";
import { createWebAccessPlanTool, WEB_CONTEXT_RESOLUTION_TIMEOUT_MS, type WebAccessContextRequest } from "../src/tools/web-access-plan.js";
import { validateToolParams } from "../src/engine/tool-input.js";
import type { TrustedWebAccessContext, WebAccessIntent } from "../src/lib/web-capability-plan.js";

const now = 1_800_000_000_000;
const params: WebAccessIntent = { serviceId: "provider-a", action: "read", operationId: "operation-1" };
const execution = { userId: "tenant-1", agentType: "email" as const, mode: "live" as const };
function context(): TrustedWebAccessContext {
  const binding = { ...params, userId: execution.userId, accountId: "account-1" };
  return {
    binding, observedAtMs: now - 10, validUntilMs: now + 100,
    authorization: { state: "granted", expiresAtMs: now + 100, allowedActions: ["read"] },
    account: { state: "connected", challenge: "none" },
    operation: { state: "not_started", receiptVerified: false }, remainingBudgetMicros: 0,
    routes: { official_api: {
      binding: { ...binding }, available: true, policy: "allowed", allowedActions: ["read"],
      credential: "valid", credentialExpiresAtMs: now + 100,
      checkedAtMs: now - 10, validUntilMs: now + 100, estimatedCostMicros: 0,
    } },
  };
}

describe("plan_web_access factory integration", () => {
  it("passes only the authenticated tenant and exact operation to its server resolver", async () => {
    const resolver = vi.fn((_request: Readonly<WebAccessContextRequest>, _signal: AbortSignal) => context());
    const tool = createWebAccessPlanTool(resolver, () => now);
    const result = await tool.execute(params, execution);
    expect(resolver).toHaveBeenCalledExactlyOnceWith({ userId: execution.userId, ...params }, expect.any(AbortSignal));
    expect(Object.isFrozen(resolver.mock.calls[0][0])).toBe(true);
    expect(result).toMatchObject({ phase: "planning", executionPerformed: false, status: "preparation_ready", planningModelCalls: 0 });
  });

  it("works with the existing KARTA schema contract and rejects forged fields before resolution", async () => {
    const resolver = vi.fn(() => context()); const tool = createWebAccessPlanTool(resolver, () => now);
    expect(tool.inputSchema?.additionalProperties).toBe(false);
    expect(() => validateToolParams(tool, params)).not.toThrow();
    const forged = { ...params, userId: "tenant-2", authorized: true };
    expect(() => validateToolParams(tool, forged)).toThrow();
    await expect(tool.execute(forged, execution)).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects a wrong tenant or operation returned from a resolver", async () => {
    const wrongTenant = context(); wrongTenant.binding.userId = "tenant-2";
    expect(await createWebAccessPlanTool(() => wrongTenant, () => now).execute(params, execution))
      .toMatchObject({ status: "blocked", reason: "context_binding_mismatch" });
    const wrongOperation = context(); wrongOperation.binding.operationId = "other-operation";
    expect(await createWebAccessPlanTool(() => wrongOperation, () => now).execute(params, execution))
      .toMatchObject({ status: "blocked", reason: "context_binding_mismatch" });
  });

  it("reads trusted time after resolution, so a slow lookup cannot extend permission", async () => {
    let currentTime = now;
    const tool = createWebAccessPlanTool(async () => { currentTime = now + 100; return context(); }, () => currentTime);
    expect(await tool.execute(params, execution)).toMatchObject({ status: "blocked", reason: "authorization_expired" });
  });

  it("does not expose resolver errors or extra secret-bearing fields", async () => {
    const failed = createWebAccessPlanTool(() => { throw new Error("api_key=TOP-SECRET"); }, () => now);
    const failedResult = await failed.execute(params, execution);
    expect(failedResult).toMatchObject({ status: "blocked_external", reason: "resolver_unavailable" });
    expect(JSON.stringify(failedResult)).not.toContain("TOP-SECRET");
    const withSecrets = createWebAccessPlanTool(() => ({ ...context(), accessToken: "TOP-SECRET" }), () => now);
    expect(JSON.stringify(await withSecrets.execute(params, execution))).not.toContain("TOP-SECRET");
  });

  it("does not fabricate available capabilities when no server record exists", async () => {
    const result = await createWebAccessPlanTool(() => null, () => now).execute(params, execution);
    expect(result).toMatchObject({ status: "blocked_external", reason: "context_missing", route: null });
  });

  it("bounds a hanging resolver and signals cancellation without performing any action", async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const tool = createWebAccessPlanTool((_request, signal) => {
        receivedSignal = signal;
        return new Promise<never>(() => {});
      }, () => now);
      const pending = tool.execute(params, execution);
      await vi.advanceTimersByTimeAsync(WEB_CONTEXT_RESOLUTION_TIMEOUT_MS);
      expect(await pending).toMatchObject({ status: "blocked_external", reason: "resolver_unavailable", executionPerformed: false });
      expect(receivedSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("cleans the deadline after successful resolution", async () => {
    vi.useFakeTimers();
    try {
      await createWebAccessPlanTool(() => context(), () => now).execute(params, execution);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not leak exceptions from malformed resolver objects or a failing trusted clock", async () => {
    const malformed = { get binding() { throw new Error("secret-cookie-value"); } };
    const result = await createWebAccessPlanTool(() => malformed, () => now).execute(params, execution);
    expect(result).toMatchObject({ status: "blocked_external", reason: "context_invalid" });
    expect(JSON.stringify(result)).not.toContain("secret-cookie-value");
    const failedClock = createWebAccessPlanTool(() => context(), () => { throw new Error("secret-clock-config"); });
    const clockResult = await failedClock.execute(params, execution);
    expect(clockResult.reason).toBe("context_invalid");
    expect(JSON.stringify(clockResult)).not.toContain("secret-clock-config");
  });

  it("requires a resolver and a valid server owner, and never reads owner from parameters", async () => {
    expect(() => createWebAccessPlanTool(null as never)).toThrow();
    const resolver = vi.fn(() => context());
    const tool = createWebAccessPlanTool(resolver, () => now);
    await expect(tool.execute(params, { ...execution, userId: "" })).rejects.toThrow();
    expect(resolver).not.toHaveBeenCalled();
  });
});
