import { describe, expect, it } from "vitest";
import { routeChefModel } from "../src/chef/cost-governor.js";

const costs = { fast: 100, standard: 300, max: 900 };

describe("CHEF cost governor", () => {
  it("utilise le niveau rapide seulement pour une tâche réellement simple et peu risquée", () => {
    expect(routeChefModel({
      risk: "low", complexity: "trivial", failureCount: 0, estimatedCostMicrosByTier: costs,
    })).toMatchObject({ ok: true, tier: "fast" });
  });

  it("escalade après un échec au lieu de répéter la même stratégie faible", () => {
    expect(routeChefModel({
      risk: "medium", complexity: "standard", failureCount: 1, estimatedCostMicrosByTier: costs,
    })).toMatchObject({ ok: true, tier: "standard" });
    expect(routeChefModel({
      risk: "medium", complexity: "standard", failureCount: 2, estimatedCostMicrosByTier: costs,
    })).toMatchObject({ ok: true, tier: "max" });
  });

  it.each([
    { risk: "critical" as const, complexity: "standard" as const },
    { risk: "low" as const, complexity: "expert" as const },
  ])("force le niveau maximal pour les cas critiques/expert: %j", ({ risk, complexity }) => {
    expect(routeChefModel({
      risk, complexity, failureCount: 0, estimatedCostMicrosByTier: costs,
    })).toMatchObject({ ok: true, tier: "max" });
  });

  it("force le niveau maximal pour architecture, sécurité ou revue indépendante", () => {
    for (const extra of [{ architecture: true }, { securitySensitive: true }, { independentReview: true }]) {
      expect(routeChefModel({
        risk: "low", complexity: "trivial", failureCount: 0, estimatedCostMicrosByTier: costs, ...extra,
      })).toMatchObject({ ok: true, tier: "max" });
    }
  });

  it("bloque si le budget ne permet pas le niveau requis au lieu de réduire la puissance", () => {
    expect(routeChefModel({
      risk: "critical",
      complexity: "expert",
      failureCount: 0,
      remainingCostMicros: 500,
      estimatedCostMicrosByTier: costs,
    })).toEqual({
      ok: false,
      reason: "budget_insufficient",
      requiredTier: "max",
      requiredMicros: 900,
      remainingMicros: 500,
    });
  });

  it("refuse des métriques de coût invalides", () => {
    expect(() => routeChefModel({
      risk: "low", complexity: "trivial", failureCount: -1, estimatedCostMicrosByTier: costs,
    })).toThrow();
    expect(() => routeChefModel({
      risk: "low", complexity: "trivial", failureCount: 0,
      estimatedCostMicrosByTier: { ...costs, max: -1 },
    })).toThrow();
  });
});
