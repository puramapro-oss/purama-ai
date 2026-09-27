export type ChefRisk = "low" | "medium" | "high" | "critical";
export type ChefComplexity = "trivial" | "standard" | "complex" | "expert";
export type ChefModelTier = "fast" | "standard" | "max";

export interface ChefCostRouteInput {
  risk: ChefRisk;
  complexity: ChefComplexity;
  failureCount: number;
  architecture?: boolean;
  securitySensitive?: boolean;
  independentReview?: boolean;
  remainingCostMicros?: number | null;
  estimatedCostMicrosByTier: Record<ChefModelTier, number>;
}

export type ChefCostRoute =
  | { ok: true; tier: ChefModelTier; reason: string }
  | { ok: false; reason: "budget_insufficient"; requiredTier: ChefModelTier; requiredMicros: number; remainingMicros: number };

function requiredTier(input: ChefCostRouteInput): ChefModelTier {
  if (
    input.risk === "critical" ||
    input.complexity === "expert" ||
    input.architecture ||
    input.securitySensitive ||
    input.independentReview ||
    input.failureCount >= 2
  ) return "max";

  if (
    input.risk === "high" ||
    input.complexity === "complex" ||
    input.failureCount === 1
  ) return "standard";

  return "fast";
}

/**
 * Cost never silently downgrades capability. Budget can block a task, but cannot
 * turn a task that requires MAX into STANDARD/FAST.
 */
export function routeChefModel(input: ChefCostRouteInput): ChefCostRoute {
  if (!Number.isInteger(input.failureCount) || input.failureCount < 0) throw new Error("failureCount invalide");

  for (const tier of ["fast", "standard", "max"] as const) {
    const value = input.estimatedCostMicrosByTier[tier];
    if (!Number.isFinite(value) || value < 0) throw new Error(`Coût estimé invalide pour ${tier}`);
  }

  const tier = requiredTier(input);
  const requiredMicros = input.estimatedCostMicrosByTier[tier];
  const remaining = input.remainingCostMicros;

  if (remaining !== undefined && remaining !== null) {
    if (!Number.isFinite(remaining) || remaining < 0) throw new Error("Budget restant invalide");
    if (requiredMicros > remaining) {
      return {
        ok: false,
        reason: "budget_insufficient",
        requiredTier: tier,
        requiredMicros,
        remainingMicros: remaining,
      };
    }
  }

  const reason =
    tier === "max" ? "risque/complexité/revue exige le niveau maximal"
    : tier === "standard" ? "complexité ou reprise exige le niveau standard"
    : "tâche déterministe ou de faible risque";

  return { ok: true, tier, reason };
}
