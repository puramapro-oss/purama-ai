import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { IaoFacade, IaoRequestNotFoundError, type IaoRequest, type KartaIaoResult } from "../src/iao/iaoFacade.js";

const OLD = "11111111-1111-4111-8111-111111111111";
const NEW = "22222222-2222-4222-8222-222222222222";
const PROOF = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const START = Date.parse("2026-11-24T01:00:00Z");

function request(requestId: string): IaoRequest {
  return {
    type: "conversation", requestId, tenantId: "tenant-a", actorId: "actor-a",
    conversationId: "shared-conversation", prompt: "complete the authorized work",
    identity: { tenantId: "tenant-a", actorId: "actor-a", session: {
      sessionId: SESSION, tenantId: "tenant-a", userId: "actor-a", appSlug: "purama-ai",
      issuedAt: START - 1_000, expiresAt: START + 60_000,
    } },
  };
}

function completed(requestId = OLD): Extract<KartaIaoResult, { kind: "accepted" }> {
  return { kind: "accepted", preview: "completed result", evidence: {
    source: "karta", requestId, proofId: PROOF, completedAt: new Date().toISOString(),
  } };
}

function deferred() {
  let resolve!: (value: KartaIaoResult) => void;
  const promise = new Promise<KartaIaoResult>(yes => { resolve = yes; });
  return { resolve, promise };
}

async function staleWork(input = request(OLD), receipt = completed()) {
  const old = deferred();
  let signal: AbortSignal | undefined;
  const facade = new IaoFacade({ prepare: (current, currentSignal) => {
    if (current.requestId === OLD) { signal = currentSignal; return old.promise; }
    return Promise.resolve(completed(NEW));
  } }, { retentionMs: 1_000 });
  const work = facade.submit(input);
  await facade.submit(request(NEW));
  old.resolve(receipt);
  const first = await work;
  expect(first).toMatchObject({ status: "partial", stale: true });
  expect(first.proof).toBeUndefined();
  return { facade, first, receipt, signal };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

describe("immutability of internally completed stale IAO work", () => {
  it("does not renew the original lease when the same final receipt is repeated", async () => {
    const { facade, first, receipt } = await staleWork();
    vi.setSystemTime(START + 900);
    const repeated = facade.recordKartaResult("tenant-a", "actor-a", OLD, receipt);
    vi.setSystemTime(START + 1_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
    expect(repeated).toEqual(first);
  });

  it("ignores a later preview instead of replacing an already completed stale result", async () => {
    const { facade, first } = await staleWork();
    vi.setSystemTime(START + 900);
    expect(facade.recordKartaResult("tenant-a", "actor-a", OLD, { kind: "accepted", preview: "unverified replacement" }))
      .toEqual(first);
    vi.setSystemTime(START + 1_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("does not replace completed work with a later blocked result", async () => {
    const { facade, first } = await staleWork();
    vi.setSystemTime(START + 900);
    expect(facade.recordKartaResult("tenant-a", "actor-a", OLD, { kind: "blocked", reason: "late failure", effect: "none" }))
      .toEqual(first);
    vi.setSystemTime(START + 1_001);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("returns completed stale work unchanged on cancel without signalling an uncertain effect", async () => {
    const { facade, first, signal } = await staleWork();
    vi.setSystemTime(START + 900);
    expect(facade.cancel("tenant-a", "actor-a", OLD)).toEqual(first);
    expect(signal?.aborted).toBe(false);
    // cancel performed a sweep at +900; allow its 250 ms lazy interval to pass.
    vi.setSystemTime(START + 1_151);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
  });

  it("also treats a stale proof-only result as internally completed", async () => {
    const receipt = completed();
    delete (receipt as { preview?: string }).preview;
    const { facade, first } = await staleWork(request(OLD), receipt);
    vi.setSystemTime(START + 900);
    expect(facade.recordKartaResult("tenant-a", "actor-a", OLD, { kind: "accepted", preview: "late preview" }))
      .toEqual(first);
    expect(facade.cancel("tenant-a", "actor-a", OLD)).toEqual(first);
  });

  it("does not redeliver a completed stale export through a repeated final callback", async () => {
    const input: IaoRequest = { ...request(OLD), type: "memory-control", memoryControl: { action: "export", data: {} } };
    const receipt = { ...completed(), memoryControl: { action: "export" as const, operationId: PROOF, replayed: false,
      exported: [{ private: "one delivery only" }] } };
    const { facade, first } = await staleWork(input, receipt);
    expect(first.memoryControl?.exported).toEqual([{ private: "one delivery only" }]);
    const stored = facade.get("tenant-a", "actor-a", OLD);
    vi.setSystemTime(START + 900);
    expect(facade.recordKartaResult("tenant-a", "actor-a", OLD, receipt)).toEqual(stored);
    expect(facade.cancel("tenant-a", "actor-a", OLD)).toEqual(stored);
  });

  it("protects a draining port without renewing the completed lease when it finally returns", async () => {
    const old = deferred();
    const facade = new IaoFacade({ prepare: current => current.requestId === OLD ? old.promise : Promise.resolve(completed(NEW)) },
      { retentionMs: 1_000 });
    const work = facade.submit(request(OLD));
    await facade.submit(request(NEW));
    const receipt = completed();
    const first = facade.recordKartaResult("tenant-a", "actor-a", OLD, receipt);
    vi.setSystemTime(START + 2_000);
    expect(facade.get("tenant-a", "actor-a", OLD)).toEqual(first);
    old.resolve(receipt);
    const drained = await work;
    // Leave the documented lazy-sweep interval after the preceding lookup.
    vi.setSystemTime(START + 2_251);
    expect(() => facade.get("tenant-a", "actor-a", OLD)).toThrow(IaoRequestNotFoundError);
    expect(drained).toEqual(first);
  });

  it("still cancels genuinely pending work and refines its effect when a valid receipt arrives", async () => {
    const old = deferred();
    let signal: AbortSignal | undefined;
    const facade = new IaoFacade({ prepare: (_input, currentSignal) => { signal = currentSignal; return old.promise; } });
    const work = facade.submit(request(OLD));
    expect(facade.cancel("tenant-a", "actor-a", OLD)).toMatchObject({ status: "cancelled", effect: "uncertain" });
    expect(signal?.aborted).toBe(true);
    old.resolve(completed());
    expect(await work).toMatchObject({ status: "cancelled", effect: "executed", proof: { proofId: PROOF } });
  });

  it("keeps a preview without a final proof open to its later completion", async () => {
    const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "work in progress" }) }, { retentionMs: 1_000 });
    await facade.submit(request(OLD));
    vi.setSystemTime(START + 2_000);
    expect(facade.get("tenant-a", "actor-a", OLD)).toMatchObject({ status: "partial", stale: false });
    expect(facade.recordKartaResult("tenant-a", "actor-a", OLD, completed())).toMatchObject({ status: "verified", stale: false });
  });
});
