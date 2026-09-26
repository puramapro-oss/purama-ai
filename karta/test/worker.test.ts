import { describe, expect, it, vi } from "vitest";

process.env.KARTA_MOCK_CLAUDE = "true";
process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.REDIS_URL = "redis://127.0.0.1:6379";

// worker.ts importe redis.ts qui ouvre une connexion ioredis EAGER au niveau module — inutile
// pour tester la pure fn shouldRetryCycle : mock pour ne rien ouvrir.
vi.mock("../src/queue/redis.js", () => ({
  redisConnection: { host: "localhost" },
}));

const { shouldRetryCycle } = await import("../src/queue/worker.js");

/** Builder minimal d'AgentRunResult — seuls status/sideEffectsCommitted comptent ici. */
function runResult(status: "success" | "error" | "awaiting_approval", sideEffectsCommitted: boolean) {
  return {
    status,
    decision: "",
    toolsUsed: [],
    resultSummary: "",
    mock: false,
    sideEffectsCommitted,
  };
}

describe("shouldRetryCycle — anti-double-exécution (P0 2026-09-26)", () => {
  it("erreur AVANT tout side-effect → rejeu BullMQ autorisé (erreur transitoire réseau/DB)", () => {
    expect(shouldRetryCycle(runResult("error", false))).toBe(true);
  });

  it("erreur APRÈS side-effects réels tentés → JAMAIS de rejeu (doublerait l'action dans le monde réel)", () => {
    expect(shouldRetryCycle(runResult("error", true))).toBe(false);
  });

  it("succès et awaiting_approval ne sont jamais rejoués", () => {
    expect(shouldRetryCycle(runResult("success", false))).toBe(false);
    expect(shouldRetryCycle(runResult("success", true))).toBe(false);
    expect(shouldRetryCycle(runResult("awaiting_approval", false))).toBe(false);
  });
});
