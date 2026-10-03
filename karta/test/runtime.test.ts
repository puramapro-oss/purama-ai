import type { Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ ping: vi.fn(), killSwitch: vi.fn(), schemaError: null as { message: string } | null }));

vi.mock("../src/queue/redis.js", () => ({
  redisConnection: { ping: h.ping },
}));
vi.mock("../src/engine/killswitch.js", () => ({
  isGlobalKillSwitchActive: h.killSwitch,
}));
vi.mock("../src/db/supabase.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({ limit: async () => ({ error: h.schemaError }) }),
    }),
  },
}));

const {
  isRuntimeReady,
  setRuntimeReady,
  shutdownRuntime,
  verifyRuntimeDependencies,
  verifyStartupDependencies,
} = await import("../src/runtime.js");

describe("runtime KARTA", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRuntimeReady(false);
    h.ping.mockResolvedValue("PONG");
    h.killSwitch.mockResolvedValue(false);
    h.schemaError = null;
  });

  it("refuse la readiness tant que Redis ou le schéma KARTA ne répond pas", async () => {
    h.killSwitch.mockRejectedValueOnce(new Error("relation absente"));
    await expect(verifyRuntimeDependencies()).rejects.toThrow("relation absente");

    h.ping.mockResolvedValueOnce("réponse invalide");
    await expect(verifyRuntimeDependencies()).rejects.toThrow(/PONG/);
  });

  it("confirme les deux dépendances sans exposer leur configuration", async () => {
    await expect(verifyRuntimeDependencies()).resolves.toBeUndefined();
    expect(h.ping).toHaveBeenCalledOnce();
    expect(h.killSwitch).toHaveBeenCalledWith({ fresh: true });
  });

  it("refuse le démarrage si une migration KARTA requise manque", async () => {
    h.schemaError = { message: "column claimed_at does not exist" };
    await expect(verifyStartupDependencies()).rejects.toThrow(/Schéma KARTA incomplet/);
  });

  it("retire la readiness, stoppe les producteurs et draine toutes les ressources", async () => {
    const order: string[] = [];
    setRuntimeReady(true);
    const server = {
      close(callback: (error?: Error) => void) {
        order.push("server");
        callback();
      },
    } as unknown as Server;

    await shutdownRuntime({
      server,
      schedulers: [{ stop: () => { order.push("scheduler"); } }],
      worker: { close: async () => { order.push("worker"); } },
      queue: { close: async () => { order.push("queue"); } },
      redis: { quit: async () => { order.push("redis"); return "OK"; } },
    });

    expect(isRuntimeReady()).toBe(false);
    expect(order).toEqual(["scheduler", "server", "worker", "queue", "redis"]);
  });
});
