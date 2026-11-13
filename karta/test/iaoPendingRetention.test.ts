import { afterEach, describe, expect, it, vi } from "vitest";
import { IaoFacade, type IaoRequest, type KartaIaoPort, type KartaIaoResult } from "../src/iao/iaoFacade.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
function request(requestId = A): IaoRequest {
  return {
    type: "conversation", requestId, tenantId: "tenant-a", actorId: "actor-a",
    conversationId: requestId, prompt: "test",
    identity: {
      tenantId: "tenant-a", actorId: "actor-a",
      session: {
        sessionId: "33333333-3333-4333-8333-333333333333", tenantId: "tenant-a",
        userId: "actor-a", appSlug: "purama-ai", issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 60000,
      },
    },
  };
}
const blocked: KartaIaoResult = { kind: "blocked", reason: "No effect", effect: "none" };
function harness() {
  const releases: Array<() => void> = [];
  const prepare = vi.fn(() => new Promise<KartaIaoResult>((resolve) => releases.push(() => resolve(blocked))));
  return { prepare, drain: () => releases.forEach((release) => release()) };
}
afterEach(() => { vi.useRealTimers(); });

describe("IAO pending cancellation retention", () => {
  it.each(["retention", "capacity"] as const)("keeps cancelled work and its idempotency key until drain under %s pressure", async (pressure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T12:00:00Z"));
    const port = harness();
    const facade = new IaoFacade(port satisfies KartaIaoPort, { retentionMs: 1000, maxRequests: 1 });
    const input = request();
    const work = [facade.submit(input)];
    facade.cancel("tenant-a", "actor-a", A);
    try {
      if (pressure === "retention") vi.setSystemTime(Date.now() + 1500);
      else work.push(facade.submit(request(B)));
      expect(facade.get("tenant-a", "actor-a", A)).toMatchObject({ status: "cancelled", effect: "uncertain" });
      const replay = facade.submit(input);
      work.push(replay);
      expect(port.prepare.mock.calls).toHaveLength(pressure === "retention" ? 1 : 2);
      port.drain();
      await Promise.all(work);
      expect(await replay).toMatchObject({ status: "cancelled", effect: "none" });
      // Once prepare has drained, ordinary terminal eviction must resume.
      vi.setSystemTime(Date.now() + 1500);
      expect(() => facade.get("tenant-a", "actor-a", A)).toThrow("IAO request not found");
    } finally {
      port.drain();
      await Promise.all(work);
    }
  });

  it("keeps non-cancelled pending requests under retention and capacity pressure", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const port = harness();
    const facade = new IaoFacade(port, { retentionMs: 1000, maxRequests: 1 });
    const work = [facade.submit(request()), facade.submit(request(B))];
    try {
      vi.setSystemTime(Date.now() + 1500);
      expect(facade.get("tenant-a", "actor-a", A).status).toBe("draft");
      expect(facade.get("tenant-a", "actor-a", B).status).toBe("draft");
      expect(port.prepare).toHaveBeenCalledTimes(2);
    } finally {
      port.drain();
      await Promise.all(work);
    }
  });

  it("still evicts a drained terminal request to satisfy capacity before retention", async () => {
    const port = harness();
    const facade = new IaoFacade(port, { retentionMs: 60000, maxRequests: 1 });
    const first = facade.submit(request());
    port.drain();
    await first;
    const second = facade.submit(request(B));
    try {
      expect(() => facade.get("tenant-a", "actor-a", A)).toThrow("IAO request not found");
      expect(facade.get("tenant-a", "actor-a", B).status).toBe("draft");
    } finally {
      port.drain();
      await second;
    }
  });
});
