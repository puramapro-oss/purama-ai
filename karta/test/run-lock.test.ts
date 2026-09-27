import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.REDIS_URL = "redis://127.0.0.1:6379";

/** État du Redis mocké : verrous avec expirations + mode panne. */
const redisState = {
  /** Map key → {holdTime, ttlMs}. Les locks expirent après ttlMs depuis holdTime. */
  locks: new Map<string, { holdTime: number; ttlMs: number }>(),
  failSet: false,
  /** true → set() ne settle JAMAIS (offline queue ioredis, maxRetriesPerRequest: null). */
  hangSet: false,
  /** true → del() throw. */
  failDel: false,
  /** Simulated current time for TTL expiration (avanceTimersByTime). */
  currentTime: Date.now(),
};

/** Helper: vérifier si un verrou a expiré. */
function isLockExpired(key: string): boolean {
  const lock = redisState.locks.get(key);
  if (!lock) return true; // pas de verrou = "expiré" (réacquérable)
  return redisState.currentTime >= lock.holdTime + lock.ttlMs;
}

vi.mock("../src/queue/redis.js", () => ({
  redisConnection: {
    set: vi.fn((key: string, _v: string, _px: string, ttl: number, nx: string) => {
      if (redisState.hangSet) return new Promise<null>(() => {}); // pend pour toujours
      return Promise.resolve().then(() => {
        if (redisState.failSet) throw new Error("ECONNREFUSED simulé");
        if (nx !== "NX") return "OK";
        // NX : seulement si la clé n'existe pas OU a expiré
        if (redisState.locks.has(key) && !isLockExpired(key)) return null;
        redisState.locks.set(key, { holdTime: redisState.currentTime, ttlMs: ttl });
        return "OK";
      });
    }),
    del: vi.fn(async (key: string) => {
      if (redisState.failDel) throw new Error("DEL failed");
      redisState.locks.delete(key);
    }),
  },
}));

const { withRunSerialization } = await import("../src/engine/run-lock.js");
const { redisConnection } = await import("../src/queue/redis.js");

describe("withRunSerialization — sérialisation opportuniste des patchs d'un même run (sous-lot 8)", () => {
  beforeEach(() => {
    redisState.locks.clear();
    redisState.failSet = false;
    redisState.hangSet = false;
    redisState.failDel = false;
    redisState.currentTime = Date.now();
    vi.mocked(redisConnection.set).mockClear();
    vi.mocked(redisConnection.del).mockClear();
  });

  it("verrou libre → fn exécutée, verrou posé puis retiré", async () => {
    const result = await withRunSerialization("run-1", async () => 42);

    expect(result).toBe(42);
    expect(redisState.locks.has("karta:run-lock:run-1")).toBe(false); // libéré au finally
    expect(redisConnection.del).toHaveBeenCalledWith("karta:run-lock:run-1");
  });

  it("verrou tenu par un autre → attend sa libération puis exécute (jamais en parallèle)", async () => {
    // Simulate another lock holder
    redisState.locks.set("karta:run-lock:run-1", { holdTime: redisState.currentTime, ttlMs: 10_000 });
    vi.useFakeTimers();

    // Libère le verrou "de l'extérieur" après 150ms de polling (3 polls de 50ms)
    setTimeout(() => {
      redisState.locks.delete("karta:run-lock:run-1");
    }, 150);

    const started = withRunSerialization("run-1", async () => "ok");
    await vi.advanceTimersByTimeAsync(200);
    await expect(started).resolves.toBe("ok");
    expect(redisConnection.set).toHaveBeenCalled(); // a réessayé jusqu'à gagner
    vi.useRealTimers();
  });

  it("budget d'attente épuisé → fn exécutée SANS verrou (best-effort : jamais bloquer l'humain)", async () => {
    // Simulate another lock holder that never releases
    redisState.locks.set("karta:run-lock:run-1", { holdTime: redisState.currentTime, ttlMs: 10_000 });
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
    expect(redisState.locks.has("karta:run-lock:run-1")).toBe(false);
  });

  describe("RESILIENCE — crash du process + recovery (P0 IAO sous-lot 8)", () => {
    it("del() échoue → l'erreur est swallowée, fn retourne son résultat normalement", async () => {
      redisState.failDel = true;
      const result = await withRunSerialization("run-3", async () => 42);

      expect(result).toBe(42); // result est retourné MALGRÉ l'erreur de del
      expect(redisConnection.del).toHaveBeenCalledWith("karta:run-lock:run-3");
    });

    it("fn complète normalement + del() appelé dans finally (no-crash path)", async () => {
      // Test que finally s'exécute pour success
      const result = await withRunSerialization("run-5", async () => "success");
      expect(result).toBe("success");
      expect(redisConnection.del).toHaveBeenCalledWith("karta:run-lock:run-5");
      expect(redisState.locks.has("karta:run-lock:run-5")).toBe(false);
    });

    it("fn lève exception → del() quand même appelé dans finally (crash-safe path)", async () => {
      const result = withRunSerialization("run-6", async () => {
        throw new Error("patch error");
      });
      await expect(result).rejects.toThrow("patch error");
      expect(redisConnection.del).toHaveBeenCalledWith("karta:run-lock:run-6");
      expect(redisState.locks.has("karta:run-lock:run-6")).toBe(false);
    });

    it("verrou zombie (pas libéré) → après expiration TTL, peut être réacquis (process restart)", async () => {
      const lockKey = "karta:run-lock:run-8";
      const now = redisState.currentTime;

      // Simuler un verrou tenu depuis longtemps (comme si un process avait crashé)
      redisState.locks.set(lockKey, { holdTime: now, ttlMs: 10_000 });

      // Un nouveau process (ou le même au redémarrage) essaie d'acquérir
      // → isLockExpired retourne false (lock holdTime + 10s > currentTime)
      expect(isLockExpired(lockKey)).toBe(false);

      // Le nouveau process ne peut pas acquérir (budget timeout dégradation)
      const result = await withRunSerialization("run-8", async () => "fallback");
      expect(result).toBe("fallback");

      // Simuler le passage du temps : le TTL expire
      redisState.currentTime = now + 10_000; // T = now + 10s

      // Maintenant le verrou est considéré comme expiré
      expect(isLockExpired(lockKey)).toBe(true);

      // Le nouveau process peut réacquérir
      const result2 = await withRunSerialization("run-8", async () => "acquired after expiry");
      expect(result2).toBe("acquired after expiry");
      expect(redisState.locks.has(lockKey)).toBe(false); // libéré au finally
    });

    it("verrou expiré mais encore présent dans la map → SETEX NX remplace", async () => {
      const lockKey = "karta:run-lock:run-9";
      const holdTime = 100;

      // Simuler un verrou "mort" (expiré mais toujours dans la map)
      redisState.locks.set(lockKey, { holdTime, ttlMs: 10_000 });
      redisState.currentTime = holdTime + 10_000 + 1; // Bien au-delà de l'expiration

      // isLockExpired doit retourner true
      expect(isLockExpired(lockKey)).toBe(true);

      // Un nouveau set doit réussir (NX check passe car verrou expiré)
      const result = await withRunSerialization("run-9", async () => "new process wins");
      expect(result).toBe("new process wins");
      // La nouvelle entrée de verrou remplace l'ancienne
      expect(redisState.locks.has(lockKey)).toBe(false); // libéré au finally
    });
  });
});
