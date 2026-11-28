import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IaoFacade, IaoRequestNotFoundError, type IaoRequest, type KartaIaoResult } from "../src/iao/iaoFacade.js";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const PROOF = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const START = Date.parse("2026-11-24T01:00:00Z");

function request(requestId: string, actorId = "actor-a"): IaoRequest {
  return {
    type: "conversation", requestId, tenantId: "tenant-a", actorId,
    conversationId: "shared-conversation", prompt: "complete this request",
    identity: { tenantId: "tenant-a", actorId, session: {
      sessionId: SESSION, tenantId: "tenant-a", userId: actorId, appSlug: "purama-ai",
      issuedAt: START - 1_000, expiresAt: START + 60_000,
    } },
  };
}

function result(requestId: string): KartaIaoResult {
  return { kind: "accepted", preview: requestId === OLD ? "older result" : "newer result",
    evidence: { source: "karta", requestId, proofId: PROOF, completedAt: new Date().toISOString() } };
}

function deferred() {
  let resolve!: (value: KartaIaoResult) => void;
  const promise = new Promise<KartaIaoResult>(yes => { resolve = yes; });
  return { resolve, promise };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => { vi.useRealTimers(); });

describe("retention of completed results that became stale", () => {
  it("expires the completed older result while preserving the more recently completed result", async () => {
    const old = deferred(); const newer = deferred();
    const facade = new IaoFacade({ prepare: input => input.requestId === OLD ? old.promise : newer.promise }, { retentionMs: 1_000 });
    const oldWork = facade.submit(request(OLD));
    const newWork = facade.submit(request(NEW));
    old.resolve(result(OLD));
    expect(await oldWork).toMatchObject({ status: "partial", stale: true, preview: "older result" });
    vi.setSystemTime(START + 600);
    newer.resolve(result(NEW)); await newWork;
    vi.setSystemTime(START + 1_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
    expect(facade.get("tenant-a", "actor-a", NEW)).toMatchObject({ status: "verified", stale: false, preview: "newer result" });
  });

  it("evicts the completed stale entry before the current result under capacity pressure", async () => {
    const old = deferred();
    const facade = new IaoFacade({ prepare: input => input.requestId === OLD ? old.promise : Promise.resolve(result(NEW)) },
      { retentionMs: 60_000, maxRequests: 1 });
    const oldWork = facade.submit(request(OLD));
    await facade.submit(request(NEW));
    old.resolve(result(OLD)); await oldWork;
    expect(facade.get("tenant-a", "actor-a", NEW)).toMatchObject({ status: "verified", stale: false });
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("keeps a genuinely unfinished partial result eligible for a later KARTA receipt", async () => {
    const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "awaiting proof" }) },
      { retentionMs: 1_000, maxRequests: 1 });
    await facade.submit(request(OLD));
    await facade.submit(request(NEW));
    vi.setSystemTime(START + 2_000);
    expect(facade.get("tenant-a", "actor-a", OLD)).toMatchObject({ status: "partial", preview: "awaiting proof" });
    expect(facade.recordKartaResult("tenant-a", "actor-a", OLD, result(OLD))).toMatchObject({ status: "partial", stale: true });
    vi.setSystemTime(START + 3_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
    expect(facade.get("tenant-a", "actor-a", NEW).status).toBe("partial");
  });

  it("never evicts a request whose port is still running, even after a stale receipt", async () => {
    const old = deferred();
    const facade = new IaoFacade({ prepare: input => input.requestId === OLD ? old.promise : Promise.resolve(result(NEW)) },
      { retentionMs: 1_000, maxRequests: 1 });
    const oldWork = facade.submit(request(OLD));
    await facade.submit(request(NEW));
    facade.recordKartaResult("tenant-a", "actor-a", OLD, result(OLD));
    vi.setSystemTime(START + 2_000);
    expect(facade.get("tenant-a", "actor-a", OLD)).toMatchObject({ status: "partial", stale: true });
    old.resolve(result(OLD)); await oldWork;
    vi.setSystemTime(START + 3_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("preserves single delivery of a stale export and discards it after its completed lease", async () => {
    const old = deferred();
    const prepare = vi.fn((input: IaoRequest) => input.requestId === OLD ? old.promise : Promise.resolve(result(NEW)));
    const facade = new IaoFacade({ prepare }, { retentionMs: 1_000 });
    const input: IaoRequest = { ...request(OLD), type: "memory-control", memoryControl: { action: "export", data: {} } };
    const work = facade.submit(input);
    await facade.submit(request(NEW));
    old.resolve({ ...result(OLD), kind: "accepted", memoryControl: { action: "export", operationId: PROOF, replayed: false,
      exported: [{ private: "one delivery only" }] } });
    expect((await work).memoryControl?.exported).toEqual([{ private: "one delivery only" }]);
    expect(facade.get("tenant-a", "actor-a", OLD).memoryControl?.exported).toBeUndefined();
    const replay = await facade.submit(input);
    expect(replay).toMatchObject({ status: "partial", stale: true, memoryControl: { replayed: true } });
    expect(replay.proof).toBeUndefined();
    expect(replay.memoryControl?.exported).toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(2);
    vi.setSystemTime(START + 1_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("does not make another actor's completed result stale", async () => {
    const old = deferred();
    const facade = new IaoFacade({ prepare: input => input.actorId === "actor-a" ? old.promise : Promise.resolve(result(NEW)) });
    const oldWork = facade.submit(request(OLD));
    await facade.submit(request(NEW, "actor-b"));
    old.resolve(result(OLD));
    expect(await oldWork).toMatchObject({ status: "verified", stale: false, preview: "older result" });
    expect(() => facade.get("tenant-a", "actor-b", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("expires a stale final receipt even when it contains no preview", async () => {
    const old = deferred();
    const facade = new IaoFacade({ prepare: input => input.requestId === OLD ? old.promise : Promise.resolve(result(NEW)) },
      { retentionMs: 1_000 });
    const oldWork = facade.submit(request(OLD));
    await facade.submit(request(NEW));
    old.resolve({ kind: "accepted", evidence: { source: "karta", requestId: OLD, proofId: PROOF, completedAt: new Date().toISOString() } });
    expect(await oldWork).toMatchObject({ status: "partial", stale: true });
    vi.setSystemTime(START + 1_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });
});
