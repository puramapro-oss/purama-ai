import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
import { bounded } from "../src/runtime/lifecycle.js";
const h = vi.hoisted(() => ({ database: vi.fn(), redis: { status: "ready", ping: vi.fn(), once: vi.fn(), off: vi.fn() } }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { rpc: h.database, from: h.database } }));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: h.redis }));
import { probeRuntime } from "../src/runtime/probe.js";
const responses = new Map<string, { data: unknown; error: unknown }>();
const signals: AbortSignal[] = [];
beforeEach(() => {
  vi.clearAllMocks(); signals.length = 0; responses.clear(); h.redis.status = "ready";
  h.redis.ping.mockResolvedValue("PONG");
  responses.set("karta_approval_outbox_health", { data: { protocol: 1, ready: true }, error: null });
  responses.set("karta_global_state", { data: { kill_switch: false }, error: null });
  responses.set("karta_runs", { data: [], error: null });
  responses.set("karta_pending_actions", { data: [], error: null });
  h.database.mockImplementation((name: string) => {
    const chain = { select: () => chain, eq: () => chain, single: () => chain, limit: () => chain,
      abortSignal: (signal: AbortSignal) => { signals.push(signal); return chain; },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(responses.get(name)).then(resolve) };
    return chain;
  });
});

it("requires the outbox protocol, fresh stop state, origin and fingerprint schema plus Redis", async () => {
  expect(await bounded(probeRuntime, 100)).toEqual({ globalKillSwitch: false });
  expect(h.database.mock.calls.map(call => call[0])).toEqual([
    "karta_approval_outbox_health", "karta_global_state", "karta_runs", "karta_pending_actions",
  ]); expect(signals).toHaveLength(4); expect(signals.every(signal => signal.aborted)).toBe(true);
});
it.each(["karta_approval_outbox_health", "karta_global_state", "karta_runs", "karta_pending_actions"])("fails closed when %s cannot be read", async name => {
  responses.set(name, { data: null, error: { message: "PRIVATE_SECRET" } });
  await expect(bounded(probeRuntime, 100)).rejects.toThrow("Dépendances KARTA indisponibles ou incompatibles");
});
it.each([{ protocol: 0, ready: true }, { protocol: 1, ready: false }, { ready: true }, null])("rejects an unconfirmed protocol %j", async data => {
  responses.set("karta_approval_outbox_health", { data, error: null });
  await expect(bounded(probeRuntime, 100)).rejects.toThrow("Dépendances KARTA");
});
it("does not label a deliberate global stop as a missing dependency", async () => {
  responses.set("karta_global_state", { data: { kill_switch: true }, error: null });
  expect(await bounded(probeRuntime, 100)).toEqual({ globalKillSwitch: true });
});
it("bounds Redis unavailability without submitting commands to its offline queue", async () => {
  h.redis.status = "reconnecting";
  const events = new EventEmitter();
  h.redis.once.mockImplementation((name, listener) => events.once(name, listener));
  h.redis.off.mockImplementation((name, listener) => events.off(name, listener));
  await expect(bounded(probeRuntime, 20)).rejects.toThrow();
  expect(h.redis.ping).not.toHaveBeenCalled(); expect(h.database).not.toHaveBeenCalled();
  expect(events.listenerCount("ready")).toBe(0); expect(events.listenerCount("end")).toBe(0);
});
