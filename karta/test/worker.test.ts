import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.KARTA_MOCK_CLAUDE = "true";
process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
process.env.REDIS_URL = "redis://127.0.0.1:6379";

// worker.ts importe redis.ts qui ouvre une connexion ioredis EAGER au niveau module — inutile
// pour tester shouldRetryCycle/processAgentCycleJob : mock pour ne rien ouvrir.
vi.mock("../src/queue/redis.js", () => ({
  redisConnection: { host: "localhost" },
}));

// Le verrou vit dans queues.ts, qui construit aussi une vraie Queue BullMQ à l'import —
// mock du module entier : worker.ts n'en consomme que le verrou (le type AgentCycleJobData
// est effacé à la compilation).
vi.mock("../src/queue/queues.js", () => ({
  tryAcquireCycleLock: vi.fn(),
  releaseCycleLock: vi.fn(),
}));

vi.mock("../src/engine/loop.js", () => ({
  runAgentCycle: vi.fn(),
}));

vi.mock("../src/engine/resolveDefinition.js", () => ({
  resolveAgentDefinition: vi.fn(),
}));

vi.mock("../src/engine/logger.js", () => ({
  reconcileStaleRuns: vi.fn(async () => 0),
}));

const { shouldRetryCycle, processAgentCycleJob } = await import("../src/queue/worker.js");
const { tryAcquireCycleLock, releaseCycleLock } = await import("../src/queue/queues.js");
const { runAgentCycle } = await import("../src/engine/loop.js");

/** Builder minimal d'AgentRunResult — seuls status/sideEffectsCommitted comptent ici.
 * Générique sur le status pour que les littéraux conservent leur type exact (0 cast). */
function runResult<S extends "success" | "error" | "awaiting_approval">(
  status: S,
  sideEffectsCommitted: boolean
) {
  return {
    status,
    decision: "",
    toolsUsed: [],
    resultSummary: "",
    mock: false,
    sideEffectsCommitted,
  };
}

const job = { agentType: "legal", userId: "user-1", trigger: { type: "cron", source: "test" } } as const;

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

describe("processAgentCycleJob — verrou anti-double par (agentType, userId)", () => {
  beforeEach(() => {
    // mockClear obligatoire : les espions sont partagés entre les tests du fichier, sans reset
    // l'appel du test précédent ferait échouer les `not.toHaveBeenCalled()` du suivant.
    vi.mocked(tryAcquireCycleLock).mockClear();
    vi.mocked(tryAcquireCycleLock).mockResolvedValue(true);
    vi.mocked(releaseCycleLock).mockClear();
    vi.mocked(runAgentCycle).mockClear();
    vi.mocked(runAgentCycle).mockResolvedValue(runResult("success", false));
  });

  it("verrou libre → cycle exécuté puis verrou libéré", async () => {
    const result = await processAgentCycleJob(job);

    expect(result.status).toBe("success");
    expect(runAgentCycle).toHaveBeenCalledOnce();
    expect(releaseCycleLock).toHaveBeenCalledWith("legal", "user-1");
  });

  it("verrou déjà tenu (overlap cron / cron+manual / délégation) → cycle SKIPPÉ, aucun run, aucun side-effect", async () => {
    vi.mocked(tryAcquireCycleLock).mockResolvedValue(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await processAgentCycleJob(job);

    expect(result.status).toBe("success"); // pas une erreur : un doublon n'a rien à faire
    expect(result.sideEffectsCommitted).toBe(false);
    expect(result.resultSummary).toContain("verrou");
    expect(runAgentCycle).not.toHaveBeenCalled();
    expect(releaseCycleLock).not.toHaveBeenCalled(); // on ne libère JAMAIS le verrou d'autrui
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SKIPPÉ"));
    warn.mockRestore();
  });

  it("erreur du cycle SANS side-effects → throw (rejeu BullMQ) MAIS verrou libéré quand même", async () => {
    vi.mocked(runAgentCycle).mockResolvedValue(runResult("error", false));

    await expect(processAgentCycleJob(job)).rejects.toThrow();
    expect(releaseCycleLock).toHaveBeenCalledWith("legal", "user-1"); // finally
  });

  it("erreur APRÈS side-effects → résultat retourné sans throw (pas de rejeu), verrou libéré", async () => {
    vi.mocked(runAgentCycle).mockResolvedValue(runResult("error", true));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await processAgentCycleJob(job);

    expect(result.status).toBe("error");
    expect(result.sideEffectsCommitted).toBe(true);
    expect(releaseCycleLock).toHaveBeenCalledWith("legal", "user-1");
    err.mockRestore();
  });

  it("crash brutal de runAgentCycle → verrou libéré par le finally (pas de zombie jusqu'au TTL)", async () => {
    vi.mocked(runAgentCycle).mockRejectedValue(new Error("boom runtime"));

    await expect(processAgentCycleJob(job)).rejects.toThrow("boom runtime");
    expect(releaseCycleLock).toHaveBeenCalledWith("legal", "user-1");
  });
});
