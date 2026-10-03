import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentCycleJobData } from "../src/queue/queues.js";

const h = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("bullmq", () => ({
  Queue: class {
    add = h.add;
  },
}));
vi.mock("../src/queue/redis.js", () => ({ redisConnection: {} }));

const { enqueueAgentCycle, stableDeduplicationId } = await import("../src/queue/queues.js");

const job = (payload: Record<string, unknown> = { a: 1, b: 2 }): AgentCycleJobData => ({
  agentType: "legal",
  userId: "user-1",
  trigger: { type: "manual", source: "test", payload },
});

describe("agent queue — déduplication stable", () => {
  beforeEach(() => h.add.mockReset().mockResolvedValue({ id: "job-1" }));

  it("utilise le mode simple BullMQ avec une clé stable", async () => {
    await enqueueAgentCycle(job());
    expect(h.add).toHaveBeenCalledOnce();
    expect(h.add.mock.calls[0][2]).toEqual({ deduplication: { id: stableDeduplicationId(job()) } });
  });

  it("produit la même clé malgré l'ordre des propriétés JSON", () => {
    expect(stableDeduplicationId(job({ a: 1, b: 2 }))).toBe(stableDeduplicationId(job({ b: 2, a: 1 })));
  });

  it("ne fusionne pas deux intentions différentes", () => {
    expect(stableDeduplicationId(job({ reason: "A" }))).not.toBe(stableDeduplicationId(job({ reason: "B" })));
  });
});
