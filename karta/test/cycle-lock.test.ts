import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.REDIS_URL = "redis://127.0.0.1:6379";

/** Mini-Redis : valeurs par clé (le token), exécution du compare-and-del du module. */
const store = new Map<string, string>();

vi.mock("../src/queue/redis.js", () => ({
  redisConnection: {
    set: vi.fn(async (key: string, value: string, _ex: string, _ttlS: number, nx: string) => {
      if (nx === "NX" && store.has(key)) return null;
      store.set(key, value);
      return "OK";
    }),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, token: string) => {
      // Exécute la sémantique du script Lua du module (compare-and-del) :
      if (store.get(key) === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  },
}));

const { tryAcquireCycleLock, releaseCycleLock } = await import("../src/queue/cycle-lock.js");
const { redisConnection } = await import("../src/queue/redis.js");

describe("cycle-lock — owner-token compare-and-del (sous-lot 9)", () => {
  beforeEach(() => {
    store.clear();
    vi.mocked(redisConnection.set).mockClear();
    vi.mocked(redisConnection.eval).mockClear();
  });

  it("acquisition libre → handle avec token unique, SET NX EX 600", async () => {
    const handle = await tryAcquireCycleLock("legal", "user-1");

    expect(handle).not.toBeNull();
    expect(handle!.token).toMatch(/^[0-9a-f-]{36}$/); // UUID — preuve d'ownership
    expect(handle).toMatchObject({ agentType: "legal", userId: "user-1" });
    expect(redisConnection.set).toHaveBeenCalledWith("karta:cycle-lock:legal:user-1", handle!.token, "EX", 600, "NX");
  });

  it("verrou déjà tenu → null (pas de handle)", async () => {
    await tryAcquireCycleLock("legal", "user-1");
    await expect(tryAcquireCycleLock("legal", "user-1")).resolves.toBeNull();
  });

  it("release du propriétaire → verrou détruit", async () => {
    const handle = await tryAcquireCycleLock("legal", "user-1");
    expect(handle).not.toBeNull();
    await releaseCycleLock(handle!);

    expect(store.has("karta:cycle-lock:legal:user-1")).toBe(false);
  });

  it("CAD — un cycle ayant DÉPASSÉ le TTL ne peut PAS libérer le verrou de son successeur", async () => {
    const expired = await tryAcquireCycleLock("legal", "user-1"); // cycle lent (>600s)
    // Le TTL expire, un successeur acquiert (nouveau token) :
    store.delete("karta:cycle-lock:legal:user-1");
    await tryAcquireCycleLock("legal", "user-1");

    // Le finally du PREMIER cycle tente son release — compare-and-del :
    await releaseCycleLock(expired!);

    // Le verrou du successeur est INTACT (avant le CAD : DEL inconditionnel le détruisait
    // → 3e admission possible).
    expect(store.has("karta:cycle-lock:legal:user-1")).toBe(true);
  });

  it("release sur échec Redis → non fatale (logguée, TTL de secours)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(redisConnection.eval).mockRejectedValueOnce(new Error("EVALREFUSED") as never);
    const handle = await tryAcquireCycleLock("legal", "user-1");
    expect(handle).not.toBeNull();

    await expect(releaseCycleLock(handle!)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("releaseCycleLock"), expect.any(Error));
    err.mockRestore();
  });
});
