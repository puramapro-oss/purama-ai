import { describe, expect, it } from "vitest";
import {
  normalizeChefCapabilitySelection, resolveChefCapabilities,
  type ChefCapabilityBinding, type ChefCapabilityContext, type ChefCapabilityDescriptor,
} from "../src/chef/capability-selection.js";
import type { TrustedWebAccessContext } from "../src/lib/web-capability-plan.js";

const NOW = 2_000_000;
const binding: ChefCapabilityBinding = { userId: "user-1", missionId: "mission-1", taskId: "task-1", briefHash: "a".repeat(64) };
const auto = (needs = ["code"], extra = {}) => normalizeChefCapabilitySelection({ mode: "auto", needs, ...extra });
const manual = (selectedIds: string[], needs = ["code"], extra = {}) =>
  normalizeChefCapabilitySelection({ mode: "manual", needs, selectedIds, ...extra });
const skill = (id: string, extra: Partial<ChefCapabilityDescriptor> = {}): ChefCapabilityDescriptor => ({
  id, kind: "skill", version: "1.0.0", provides: ["code"], requires: [],
  qualified: true, available: true, authorized: true, quality: 0.8, estimatedCostMicros: 10,
  ...extra,
});
const snapshot = (capabilities: ChefCapabilityDescriptor[], extra: Partial<ChefCapabilityContext> = {}): ChefCapabilityContext => ({
  binding, observedAtMs: NOW - 100, validUntilMs: NOW + 1000,
  remainingBudgetMicros: 100, capabilities, ...extra,
});
const resolve = (capabilities: ChefCapabilityDescriptor[], selection = auto(), extra: Partial<ChefCapabilityContext> = {}) =>
  resolveChefCapabilities(selection, snapshot(capabilities, extra), binding, NOW);
const selectedIds = (result: ReturnType<typeof resolve>) => result.selected.map(selected => selected.id);

function connector(id = "docs", changes: Partial<TrustedWebAccessContext> = {}): ChefCapabilityDescriptor {
  const intent = { serviceId: "documentation", action: "read" as const, operationId: `${binding.taskId}:${id}` };
  const webBinding = { ...intent, userId: "user-1", accountId: null };
  const context: TrustedWebAccessContext = {
    binding: webBinding, observedAtMs: NOW - 100, validUntilMs: NOW + 1000,
    authorization: { state: "granted", expiresAtMs: NOW + 1000, allowedActions: ["read"] },
    account: { state: "missing", challenge: "none" },
    operation: { state: "not_started", receiptVerified: false }, remainingBudgetMicros: 100,
    routes: { official_api: {
      binding: webBinding, available: true, policy: "allowed", allowedActions: ["read"],
      credential: "not_required", credentialExpiresAtMs: null, checkedAtMs: NOW - 100,
      validUntilMs: NOW + 1000, estimatedCostMicros: 5,
    } },
    ...changes,
  };
  return skill(id, { kind: "connector", webAccess: { intent, userId: "user-1", context } });
}

describe("CHEF selection preferences", () => {
  it("canonicalizes a bounded preference without mutating it", () => {
    const input = { mode: "manual", needs: ["review", "code", "code"], selectedIds: ["b", "a", "a"], excludedIds: ["z", "y"] };
    expect(normalizeChefCapabilitySelection(input)).toEqual({
      mode: "manual", needs: ["code", "review"], selectedIds: ["a", "b"], excludedIds: ["y", "z"], maxSelected: 8,
    });
    expect(input.needs).toEqual(["review", "code", "code"]);
  });

  it("accepts an explicit task without capability requirements", () => {
    expect(resolve([], auto([]))).toMatchObject({ status: "ready", selected: [], estimatedCostMicros: 0 });
  });

  it.each([
    null, [], {}, { mode: "auto" }, { mode: "manual", needs: null },
    { mode: "automatic", needs: [] }, { mode: "auto", needs: [], injected: true },
    { mode: "auto", needs: [" code"] }, { mode: "auto", needs: ["../code"] },
    { mode: "auto", needs: Array(33).fill("code") },
    { mode: "auto", needs: [], maxSelected: 0 }, { mode: "auto", needs: [], maxSelected: 17 },
    { mode: "auto", needs: [], maxSelected: 1.2 }, { mode: "auto", needs: [], maxSelected: null },
    { mode: "auto", needs: [], selectedIds: ["a"] },
    { mode: "manual", needs: [], selectedIds: null },
    { mode: "manual", needs: [], selectedIds: ["a"], excludedIds: ["a"] },
  ])("rejects malformed or contradictory preferences %#", input => {
    expect(() => normalizeChefCapabilitySelection(input)).toThrow();
  });
});

describe("CHEF automatic and manual selection", () => {
  it("prefers coverage, then quality, then cost, then stable ID", () => {
    const capabilities = [
      skill("only-code", { quality: 1, estimatedCostMicros: 0 }),
      skill("both-low", { provides: ["code", "review"], quality: 0.7, estimatedCostMicros: 0 }),
      skill("both-expensive", { provides: ["code", "review"], estimatedCostMicros: 90 }),
      skill("z-both", { provides: ["code", "review"] }),
      skill("a-both", { provides: ["code", "review"] }),
    ];
    expect(selectedIds(resolve(capabilities, auto(["code", "review"])))).toEqual(["a-both"]);
  });

  it("includes and charges each dependency once", () => {
    const capabilities = [
      skill("toolchain", { provides: [], estimatedCostMicros: 4 }),
      skill("writer", { requires: ["toolchain"], estimatedCostMicros: 5 }),
      skill("reviewer", { provides: ["review"], requires: ["toolchain"], estimatedCostMicros: 6 }),
    ];
    expect(resolve(capabilities, auto(["code", "review"]))).toMatchObject({
      status: "ready", estimatedCostMicros: 15,
      selected: [{ id: "reviewer" }, { id: "toolchain" }, { id: "writer" }],
    });
  });

  it("preserves a manual choice even when another candidate scores better", () => {
    const result = resolve([skill("chosen", { quality: 0.1 }), skill("better", { quality: 1 })], manual(["chosen"]));
    expect(selectedIds(result)).toEqual(["chosen"]);
    expect(result.reason).toBe("manual_selection");
  });

  it("never silently adds dependencies or substitutes a manual choice", () => {
    expect(resolve([skill("base"), skill("chosen", { requires: ["base"] })], manual(["chosen"])))
      .toMatchObject({ status: "blocked", reason: "manual_dependency_missing", selected: [] });
    expect(resolve([skill("better")], manual(["missing"])))
      .toMatchObject({ status: "blocked", reason: "capability_unknown", selected: [] });
  });

  it("enforces exclusions on dependency closures", () => {
    expect(resolve([skill("base"), skill("chosen", { requires: ["base"] })], auto(["code"], { excludedIds: ["base"] })))
      .toMatchObject({ status: "blocked", reason: "capability_excluded", selected: [] });
  });

  it.each(["qualified", "available", "authorized"] as const)("does not select an unavailable %s candidate", field => {
    expect(selectedIds(resolve([skill("forbidden", { [field]: false, quality: 1 }), skill("allowed")]))).toEqual(["allowed"]);
    expect(resolve([skill("forbidden", { [field]: false })], manual(["forbidden"])))
      .toMatchObject({ status: "blocked", reason: "capability_unavailable", selected: [] });
  });

  it("does not rank unknown quality as perfect", () => {
    expect(selectedIds(resolve([skill("unknown", { quality: null, estimatedCostMicros: 0 }), skill("known", { quality: 0 })]))).toEqual(["known"]);
  });

  it("returns no usable partial selection when a need cannot be covered", () => {
    expect(resolve([skill("code")], auto(["code", "unavailable"])))
      .toMatchObject({ status: "blocked", selected: [], estimatedCostMicros: null });
    expect(resolve([skill("code")], manual(["code"], ["code", "unavailable"])))
      .toMatchObject({ status: "blocked", reason: "needs_uncovered", selected: [] });
  });

  it("enforces a limit including dependencies", () => {
    const capabilities = [skill("base", { provides: [] }), skill("writer", { requires: ["base"] })];
    expect(resolve(capabilities, auto(["code"], { maxSelected: 1 }))).toMatchObject({ status: "blocked", reason: "selection_limit" });
    expect(resolve(capabilities, manual(["base", "writer"], ["code"], { maxSelected: 1 })))
      .toMatchObject({ status: "blocked", reason: "selection_limit", selected: [] });
  });

  it("is stable under permutations and hashes the exact selected versions and costs", () => {
    const a = skill("a", { provides: ["review", "code"] });
    const b = skill("b", { provides: ["code", "review"] });
    const first = resolve([a, b], auto(["review", "code"]));
    const second = resolve([b, a], auto(["code", "review"]));
    expect(first).toEqual(second);
    expect(first.selectionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(resolve([{ ...a, version: "2.0.0" }, b], auto(["code", "review"])).selectionHash).not.toBe(first.selectionHash);
    expect(resolve([{ ...a, estimatedCostMicros: 9 }, b], auto(["code", "review"])).selectionHash).not.toBe(first.selectionHash);
  });
});

describe("CHEF snapshot and budget boundaries", () => {
  it("rejects missing, stale, future and mismatched snapshots", () => {
    expect(resolveChefCapabilities(auto(), null, binding, NOW).reason).toBe("context_missing");
    for (const extra of [
      { observedAtMs: NOW - 1000, validUntilMs: NOW },
      { observedAtMs: NOW + 1, validUntilMs: NOW + 100 },
    ]) expect(resolve([skill("a")], auto(), extra).reason).toBe("context_stale");
    for (const field of ["userId", "missionId", "taskId", "briefHash"] as const) {
      const other = { ...binding, [field]: field === "briefHash" ? "b".repeat(64) : "other" };
      expect(resolve([skill("a")], auto(), { binding: other }).reason).toBe("context_binding_mismatch");
    }
  });

  it("rejects invalid records, duplicate IDs, dependency refs and cycles", () => {
    const cases = [
      snapshot([skill("a"), skill("a")]),
      snapshot([skill("a", { requires: ["missing"] })]),
      snapshot([skill("a", { requires: ["b"] }), skill("b", { requires: ["a"] })]),
      snapshot([skill("a", { requires: ["a"] })]),
      snapshot([skill("a", { provides: ["code", "code"] })]),
      snapshot([skill("a", { version: "../bad" })]),
      snapshot([skill("a", { quality: NaN })]),
      snapshot([skill("a", { quality: 1.1 })]),
      snapshot([skill("a", { estimatedCostMicros: -1 })]),
      snapshot([skill("a")], { validUntilMs: NOW + 300_001 }),
      { ...snapshot([skill("a")]), grant: true },
      snapshot([ { ...skill("a"), secret: "should-not-be-consumed" } as ChefCapabilityDescriptor ]),
      snapshot(Array.from({ length: 129 }, (_, i) => skill(`cap-${i}`))),
    ];
    for (const value of cases) expect(resolveChefCapabilities(auto(), value, binding, NOW))
      .toMatchObject({ status: "blocked", selected: [], estimatedCostMicros: null });
  });

  it("keeps missing costs and missing budgets unknown", () => {
    expect(resolve([skill("a", { estimatedCostMicros: null })])).toMatchObject({ status: "blocked", reason: "capability_cost_unknown", estimatedCostMicros: null });
    expect(resolve([skill("a")], auto(), { remainingBudgetMicros: null })).toMatchObject({ status: "blocked", reason: "budget_unknown" });
    expect(selectedIds(resolve([skill("unknown", { estimatedCostMicros: null, quality: 1 }), skill("known")]))).toEqual(["known"]);
  });

  it("uses only affordable choices and checks aggregate dependency cost", () => {
    expect(selectedIds(resolve([skill("premium", { quality: 1, estimatedCostMicros: 101 }), skill("affordable")]))).toEqual(["affordable"]);
    expect(resolve([skill("base", { provides: [], estimatedCostMicros: 60 }), skill("a", { requires: ["base"], estimatedCostMicros: 60 })]))
      .toMatchObject({ status: "blocked", reason: "budget_insufficient", selected: [] });
  });

  it("fails closed on unsafe cost aggregation and invalid call bindings", () => {
    expect(resolve([skill("a", { provides: ["a"], estimatedCostMicros: Number.MAX_SAFE_INTEGER }),
      skill("b", { provides: ["b"], estimatedCostMicros: 1 })], auto(["a", "b"]), { remainingBudgetMicros: Number.MAX_SAFE_INTEGER }))
      .toMatchObject({ status: "blocked", selected: [] });
    expect(resolveChefCapabilities(auto(), snapshot([]), { ...binding, briefHash: "bad" }, NOW).reason).toBe("binding_invalid");
    expect(resolveChefCapabilities(auto(), snapshot([]), binding, NaN).reason).toBe("binding_invalid");
  });

  it("does not evaluate getter-based snapshots", () => {
    let calls = 0;
    const value = { ...snapshot([]), get capabilities() { calls++; return []; } };
    expect(resolveChefCapabilities(auto([]), value, binding, NOW).reason).toBe("context_invalid");
    expect(calls).toBe(0);
  });
});

describe("CHEF connector selection reuses the web planner", () => {
  it("accepts a qualified structured route and accounts for its cost floor", () => {
    const candidate = connector();
    candidate.estimatedCostMicros = 1;
    expect(resolve([candidate])).toMatchObject({ status: "ready", estimatedCostMicros: 5,
      selected: [{ id: "docs", kind: "connector", version: "1.0.0" }] });
  });

  it("accepts a current validated browser recipe", () => {
    const candidate = connector();
    const web = candidate.webAccess!.context as TrustedWebAccessContext;
    web.routes = { browser_recipe: { ...web.routes.official_api!, recipeValidation: "current" } };
    expect(resolve([candidate]).status).toBe("ready");
  });

  it.each([
    { authorization: { state: "revoked", expiresAtMs: NOW + 1000, allowedActions: ["read"] } },
    { operation: { state: "uncertain", receiptVerified: false } },
    { operation: { state: "completed", receiptVerified: true } },
    { account: { state: "missing", challenge: "mfa" } },
  ] as Partial<TrustedWebAccessContext>[])("does not bypass a web refusal with another candidate %#", changes => {
    expect(resolve([skill("a-alternative", { quality: 1 }), connector("z-web", changes)]))
      .toMatchObject({ status: "blocked", selected: [] });
  });

  it("does not downgrade an explicit API denial to MCP", () => {
    const candidate = connector();
    const web = candidate.webAccess!.context as TrustedWebAccessContext;
    web.routes.mcp = { ...web.routes.official_api! };
    web.routes.official_api!.policy = "denied";
    expect(resolve([candidate])).toMatchObject({ status: "blocked", reason: "connector_route_policy_denied", selected: [] });
  });

  it("uses a separately authorized connector when the preferred credentials have expired", () => {
    const expired = connector("a-expired");
    const web = expired.webAccess!.context as TrustedWebAccessContext;
    web.routes.official_api!.credential = "expired";
    expired.quality = 1;
    const valid = connector("b-valid");
    expect(selectedIds(resolve([expired, valid]))).toEqual(["b-valid"]);
    expect(resolve([expired, valid], manual(["a-expired"])))
      .toMatchObject({ status: "blocked", reason: "connector_route_credentials_expired", selected: [] });
  });

  it.each(["context_stale", "route_stale", "route_credentials_missing", "execution_cost_unknown", "no_available_route"])(
    "can select another authorized connector after %s", obstacle => {
      const candidate = connector("a-unavailable");
      const web = candidate.webAccess!.context as TrustedWebAccessContext;
      if (obstacle === "context_stale") web.validUntilMs = NOW;
      if (obstacle === "route_stale") web.routes.official_api!.validUntilMs = NOW;
      if (obstacle === "route_credentials_missing") web.routes.official_api!.credential = "missing";
      if (obstacle === "execution_cost_unknown") web.routes.official_api!.estimatedCostMicros = null;
      if (obstacle === "no_available_route") web.routes = {};
      expect(selectedIds(resolve([candidate, connector("b-valid")]))).toEqual(["b-valid"]);
    },
  );

  it("rejects a coherent foreign-owner connector and hashes the canonical owner", () => {
    const candidate = connector();
    const web = candidate.webAccess!.context as TrustedWebAccessContext;
    candidate.webAccess!.userId = "another-owner";
    web.binding.userId = "another-owner";
    web.routes.official_api!.binding.userId = "another-owner";
    expect(resolve([candidate])).toMatchObject({ status: "blocked", reason: "context_binding_mismatch", selected: [] });
    const otherBinding = { ...binding, userId: "another-owner" };
    const foreignSnapshot = snapshot([candidate], { binding: otherBinding });
    expect(resolveChefCapabilities(auto(), foreignSnapshot, binding, NOW).reason).toBe("context_binding_mismatch");
    const first = resolve([skill("a")]);
    const second = resolveChefCapabilities(auto(), snapshot([skill("a")], { binding: otherBinding }), otherBinding, NOW);
    expect(second.status).toBe("ready");
    expect(second.selectionHash).not.toBe(first.selectionHash);
  });

  it("does not hide a web denial behind an unknown dependency cost", () => {
    const candidate = connector("z-web", { authorization: { state: "revoked", expiresAtMs: NOW + 1000, allowedActions: ["read"] } });
    candidate.requires = ["a-base"];
    expect(resolve([skill("alternative"), skill("a-base", { provides: [], estimatedCostMicros: null }), candidate]))
      .toMatchObject({ status: "blocked", reason: "connector_authorization_revoked", selected: [] });
  });

  it("rejects an adaptive browser proposal, missing web context and forged task IDs", () => {
    const candidate = connector();
    const web = candidate.webAccess!.context as TrustedWebAccessContext;
    web.routes = { adaptive_browser: { ...web.routes.official_api! } };
    expect(resolve([candidate])).toMatchObject({ status: "blocked", reason: "connector_adaptive_recipe_preparation_only" });
    candidate.webAccess!.context = null;
    expect(resolve([candidate]).reason).toBe("connector_context_missing");
    candidate.webAccess!.intent.operationId = "another-task:docs";
    expect(resolve([candidate]).reason).toBe("context_binding_mismatch");
  });

  it("requires a connector web contract and forbids one on a skill", () => {
    expect(resolve([skill("a", { kind: "connector" })]).reason).toBe("context_invalid");
    expect(resolve([skill("a", { webAccess: connector().webAccess })]).reason).toBe("context_invalid");
  });

  it("does not let an unrelated denied connector block a code-only task", () => {
    const candidate = connector("mail", { authorization: { state: "revoked", expiresAtMs: NOW + 1000, allowedActions: ["read"] } });
    candidate.provides = ["mail"];
    expect(selectedIds(resolve([skill("code"), candidate]))).toEqual(["code"]);
  });
});
