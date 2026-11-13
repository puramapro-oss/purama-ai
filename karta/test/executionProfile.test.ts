import { describe, expect, it, vi } from "vitest";
import { configuredModelCatalog, normalizeModelCatalog, normalizeModelPreferences, resolveModelExecutionPlan,
  type ModelExecutionCapability } from "../src/claude/execution-profile.js";

const catalog: ModelExecutionCapability[] = [
  { model: "small", reasoning: "none", maxOutputTokens: 1024 },
  { model: "manual", reasoning: "budget", maxOutputTokens: 16_384 },
  { model: "adaptive", reasoning: "adaptive", maxOutputTokens: 32_768, effortLevels: ["low", "medium", "high"] },
];

describe("explicit model execution profiles", () => {
  it("preserves exact selection across every speed and reflection setting", () => {
    for (const speed of ["standard", "fast", "ultra_fast"] as const) {
      for (const reflection of ["auto", "standard", "deep", "maximum"] as const) {
        expect(resolveModelExecutionPlan({ model: "manual", speed, reflection }, catalog).model).toBe("manual");
      }
    }
  });
  it("keeps maximum thinking with ultra-fast; reduces breadth and wait without hiding the conflict", () => {
    const slow = resolveModelExecutionPlan({ model: "manual", reflection: "maximum" }, catalog);
    const fast = resolveModelExecutionPlan({ model: "manual", reflection: "maximum", speed: "ultra_fast" }, catalog);
    expect(fast.providerOptions).toEqual(slow.providerOptions);
    expect(fast.maxOutputTokens).toBe(slow.maxOutputTokens);
    expect(fast.research.maxReviewers).toBe(0);
    expect(fast.research.maxSearches).toBeLessThan(slow.research.maxSearches);
    expect(fast.timeoutMs).toBe(15_000);
  });
  it("maps maximum to the highest qualified provider effort, without inventing max support", () => {
    expect(resolveModelExecutionPlan({ model: "adaptive", reflection: "maximum" }, catalog).providerOptions)
      .toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "high" } });
  });
  it("respects output and transport ceilings independently", () => {
    const plan = resolveModelExecutionPlan({ model: "manual", reflection: "maximum" }, [
      { model: "manual", reasoning: "budget", maxOutputTokens: 4096 },
    ], 5000);
    expect(plan.maxOutputTokens).toBe(4096);
    expect(plan.providerOptions.thinking).toEqual({ type: "enabled", budget_tokens: 3072 });
    expect(plan.timeoutMs).toBe(5000);
  });
  it.each(["unknown", "SMALL", "small "])("does not substitute an unknown exact model %s", model => {
    expect(() => resolveModelExecutionPlan({ model }, catalog)).toThrow();
  });
  it.each(["deep", "maximum"] as const)("rejects unsupported %s reasoning before inference", reflection => {
    expect(() => resolveModelExecutionPlan({ model: "small", reflection }, catalog)).toThrow(/réflexion/);
  });
  it("rejects an insufficient thinking budget", () => {
    expect(() => resolveModelExecutionPlan({ model: "tiny", reflection: "deep" }, [
      { model: "tiny", reasoning: "budget", maxOutputTokens: 1024 },
    ])).toThrow(/Budget/);
  });
  it.each([null, [], {}, { model: "small", apiKey: "secret" }, { model: "small", reflection: null },
    { model: "small", speed: "unlimited" }, { model: "small", reflection: { toString: () => "deep" } }])("rejects malformed preferences without echoing their contents", input => {
      expect(() => normalizeModelPreferences(input)).toThrow("Profil de modèle invalide ou non qualifié");
    });
  it("does not invoke getters or proxies", () => {
    const getter = vi.fn(() => "small");
    expect(() => normalizeModelPreferences(Object.defineProperty({}, "model", { get: getter }))).toThrow();
    expect(() => normalizeModelPreferences(new Proxy({}, { get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("copies the catalogue and preferences", () => {
    const copy = normalizeModelCatalog(catalog);
    copy[2].effortLevels!.push("max");
    expect(catalog[2].effortLevels).not.toContain("max");
    expect(normalizeModelPreferences({ model: "small" })).toEqual({ model: "small", reflection: "auto", speed: "standard" });
  });
  it.each([
    [], [catalog[0], catalog[0]], [{ ...catalog[0], maxOutputTokens: NaN }],
    [{ ...catalog[0], maxOutputTokens: 100_000 }], [{ ...catalog[0], effortLevels: ["max"] }],
    [{ ...catalog[2], effortLevels: ["high", "high"] }], [{ ...catalog[2], effortLevels: [] }],
  ].map(value => ({ value })))("rejects an ambiguous or unbounded catalogue", ({ value }) => expect(() => normalizeModelCatalog(value)).toThrow());
  it("keeps legacy host IDs only, unless exact capabilities are supplied by host", () => {
    expect(configuredModelCatalog("primary", "quick").map(model => model.model)).toEqual(["primary", "quick"]);
    expect(configuredModelCatalog("primary", "primary")).toHaveLength(1);
    expect(configuredModelCatalog("primary", "quick", JSON.stringify(catalog))).toEqual(catalog);
    expect(() => configuredModelCatalog("primary", "quick", "bad json")).toThrow();
  });
});
