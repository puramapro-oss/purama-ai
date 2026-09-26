import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.REDIS_URL = "redis://127.0.0.1:6379";

/** État du Redis mocké : verrou courant + mode panne. */
const redisState = {
  heldKey: null as string | null,
  failSet: false,
  /** true → set() ne settle JAMAIS (offline queue ioredis, maxRetriesPerRequest: null). */
  hangSet: false,
};

vi.mock("../src/queue/redis.js", () => ({
  redisConnection: {
    set: vi.fn((key: string, _v: string, _px: string, _ttl: number, nx: string) => {
      if (redisState.hangSet) return new Promise<null>(() => {}); // pend pour toujours
      return Promise.resolve().then(() => {
        if (redisState.failSet) throw new Error("ECONNREFUSED simulé");
        if (nx !== "NX") return "OK";
        if (redisState.heldKey === key) return null;
        redisState.heldKey = key;
        return "OK";
      });
    }),
    del: vi.fn(async (key: string) => {
      if (redisState.heldKey === key) redisState.heldKey = null;
    }),
  },
}));

const { withRunSerialization } = await import("../src/engine/run-lock.js");
const { redisConnection } = await import("../src/queue/redis.js");

describe("withRunSerialization — sérialisation opportuniste des patchs d'un même run (sous-lot 8)", () => {
  beforeEach(() => {
    redisState.heldKey = null;
    redisState.failSet = false;
    redisState.hangSet = false;
    vi.mocked(redisConnection.set).mockClear();
    vi.mocked(redisConnection.del).mockClear();
  });

  it("verrou libre → fn exécutée, verrou posé puis retiré", async () => {
    const result = await withRunSerialization("run-1", async () => 42);

    expect(result).toBe(42);
    expect(redisState.heldKey).toBeNull(); // libéré au finally
    expect(redisConnection.del).toHaveBeenCalledWith("karta:run-lock:run-1");
  });

  it("verrou tenu par un autre → attend sa libération puis exécute (jamais en parallèle)", async () => {
    redisState.heldKey = "karta:run-lock:run-1"; // un concurrent détient le verrou
    vi.useFakeTimers();

    // Libère le verrou "de l'extérieur" après 150ms de polling (3 polls de 50ms)
    setTimeout(() => {
      redisState.heldKey = null;
    }, 150);

    const started = withRunSerialization("run-1", async () => "ok");
    await vi.advanceTimersByTimeAsync(200);
    await expect(started).resolves.toBe("ok");
    expect(redisConnection.set).toHaveBeenCalled(); // a réessayé jusqu'à gagner
    vi.useRealTimers();
  });

  it("budget d'attente épuisé → fn exécutée SANS verrou (best-effort : jamais bloquer l'humain)", async () => {
    redisState.heldKey = "karta:run-lock:run-1"; // jamais libéré
    vi.useFakeTimers();

    const started = withRunSerialization("run-1", async () => "display quand même");
    await vi.advanceTimersByTimeAsync(2_500); // budget 2s dépassé
    await expect(started).resolves.toBe("display quand même");
    expect(redisConnection.del).not.toHaveBeenCalled(); // on ne libère JAMAIS le verrou d'autrui
    vi.useRealTimers();
  });

  it("Redis down (set throw) → dégradation : fn exécutée sans verrou, aucune erreur remontée", async () => {
    redisState.failSet = true;
    await expect(withRunSerialization("run-1", async () => "fallback")).resolves.toBe("fallback");
    expect(redisConnection.del).not.toHaveBeenCalled();
  });

  it("Redis OUTAGE (set ne settle JAMAIS — offline queue ioredis maxRetriesPerRequest:null) → fn exécutée quand même, le clic humain ne pend pas", async () => {
    // Réalité ioredis sur connexion perdue : PAS de throw, une promesse qui pend indéfiniment.
    // Sans deadline côté run-lock, le budget 2s ne démarre même pas (il ne compte que les
    // sleeps) et resolvePendingAction — un clic humain — pendrait pour toujours.
    redisState.hangSet = true;
    vi.useFakeTimers();
    try {
      const started = withRunSerialization("run-1", async () => "outage: display quand même");
      // Avance par tranches : les retries créent de NOUVEAUX timers (deadline op 300ms à
      // chaque tentative) que advanceTimersByTimeAsync ne chaîne pas au-delà du cran donné.
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(100); // 3s au total > budget 2s
      }
      await expect(started).resolves.toBe("outage: display quand même");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fn qui throw → verrou quand même libéré (pas de zombie jusqu'au TTL)", async () => {
    await expect(
      withRunSerialization("run-1", async () => {
        throw new Error("boom patch");
      })
    ).rejects.toThrow("boom patch");
    expect(redisState.heldKey).toBeNull();
  });
});
