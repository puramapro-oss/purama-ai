import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IaoFacade, IaoRequestNotFoundError, type IaoRequest, type KartaIaoResult } from "../src/iao/iaoFacade.js";

const REQUEST = "11111111-1111-4111-8111-111111111111";
const PROOF = "22222222-2222-4222-8222-222222222222";
const OTHER_PROOF = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const START = Date.parse("2026-11-24T03:00:00Z");
const CONTROL: IaoRequest = {
  type: "memory-control", requestId: REQUEST, tenantId: "tenant-a", actorId: "actor-a",
  conversationId: "conversation-a", prompt: "", memoryControl: { action: "export", data: {} },
  identity: { tenantId: "tenant-a", actorId: "actor-a", session: {
    sessionId: SESSION, tenantId: "tenant-a", userId: "actor-a", appSlug: "purama-ai",
    issuedAt: START - 1_000, expiresAt: START + 60_000,
  } },
};

function accepted(proofId = PROOF): Extract<KartaIaoResult, { kind: "accepted" }> {
  return { kind: "accepted", evidence: {
    source: "karta", requestId: REQUEST, proofId, completedAt: new Date().toISOString(),
  } };
}

function exportReceipt(proofId = PROOF): Extract<KartaIaoResult, { kind: "accepted" }> {
  return { ...accepted(proofId), memoryControl: {
    action: "export", operationId: proofId, replayed: false, exported: [{ text: "synthetic export" }],
  } };
}

function cancelled(type: IaoRequest["type"] = "conversation") {
  const request: IaoRequest = {
    type, requestId: REQUEST, tenantId: "tenant-a", actorId: "actor-a", conversationId: "conversation-a", prompt: "finish the authorized work",
    identity: { tenantId: "tenant-a", actorId: "actor-a", session: {
      sessionId: SESSION, tenantId: "tenant-a", userId: "actor-a", appSlug: "purama-ai",
      issuedAt: START - 1_000, expiresAt: START + 60_000,
    } },
    ...(type === "memory-control" ? { memoryControl: { action: "export" as const, data: {} } } : {}),
  };
  let finish!: (value: KartaIaoResult) => void;
  const pending = new Promise<KartaIaoResult>(resolve => { finish = resolve; });
  const prepare = vi.fn(() => pending);
  const facade = new IaoFacade({ prepare }, { retentionMs: 1_000 });
  const submitted = facade.submit(request);
  expect(facade.cancel("tenant-a", "actor-a", REQUEST)).toMatchObject({ status: "cancelled", effect: "uncertain" });
  return {
    facade, request, prepare, submitted, finish,
    record: (result: KartaIaoResult) => facade.recordKartaResult("tenant-a", "actor-a", REQUEST, result),
    read: () => facade.get("tenant-a", "actor-a", REQUEST),
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START); });
afterEach(() => vi.useRealTimers());

describe("monotonic receipt knowledge after IAO cancellation", () => {
  it.each(["none", "uncertain", "executed"] as const)("keeps the verified effect when a late blocked callback reports %s", async effect => {
    const run = cancelled();
    const first = run.record(accepted());
    vi.setSystemTime(START + 100);
    run.finish({ kind: "blocked", reason: "late dependency response", effect });
    expect(await run.submitted).toEqual(first);
    expect(run.read()).toMatchObject({ status: "cancelled", effect: "executed", proof: { proofId: PROOF } });
  });

  it("keeps the first proof when the draining port returns a different valid proof", async () => {
    const run = cancelled();
    const first = run.record(accepted());
    vi.setSystemTime(START + 100);
    run.finish(accepted(OTHER_PROOF));
    expect(await run.submitted).toEqual(first);
  });

  it("does not change updatedAt when the same verified callback is replayed", async () => {
    const run = cancelled();
    const receipt = accepted();
    const first = run.record(receipt);
    vi.setSystemTime(START + 100);
    const replay = run.record(receipt);
    run.finish(receipt);
    expect(await run.submitted).toEqual(first);
    expect(replay).toEqual(first);
  });

  it("keeps its proof snapshot if a port later reuses and edits its result object", async () => {
    const run = cancelled();
    const receipt = accepted();
    const first = run.record(receipt);
    Object.assign(receipt.evidence!, { proofId: OTHER_PROOF });
    run.finish({ kind: "accepted", preview: "late preview" });
    expect(await run.submitted).toEqual(first);
  });

  it("allows uncertain to none and then executed when the first valid proof arrives", async () => {
    const run = cancelled();
    expect(run.record({ kind: "blocked", reason: "not dispatched", effect: "none" })).toMatchObject({ effect: "none" });
    vi.setSystemTime(START + 100);
    run.finish(accepted());
    expect(await run.submitted).toMatchObject({ status: "cancelled", effect: "executed", proof: { proofId: PROOF } });
  });

  it("still reports none when the cancelled port establishes that no effect happened", async () => {
    const run = cancelled();
    run.finish({ kind: "blocked", reason: "not dispatched", effect: "none" });
    expect(await run.submitted).toMatchObject({ status: "cancelled", effect: "none" });
  });

  it("does not freeze an uncertain effect on an invalid proof", async () => {
    const run = cancelled();
    expect(run.record(accepted("not-a-receipt"))).toMatchObject({ effect: "uncertain" });
    run.finish(accepted());
    expect(await run.submitted).toMatchObject({ effect: "executed", proof: { proofId: PROOF } });
  });

  it("does not freeze an uncertain effect on an unproven preview", async () => {
    const run = cancelled();
    expect(run.record({ kind: "accepted", preview: "unfinished" })).toMatchObject({ effect: "uncertain" });
    run.finish(accepted());
    expect(await run.submitted).toMatchObject({ effect: "executed", proof: { proofId: PROOF } });
  });

  it("does not freeze a control on a receipt that contradicts its proof", async () => {
    const run = cancelled("memory-control");
    const invalid = { ...exportReceipt(), memoryControl: { ...exportReceipt().memoryControl!, operationId: OTHER_PROOF } };
    expect(run.record(invalid)).toMatchObject({ effect: "uncertain" });
    run.finish(exportReceipt());
    expect(await run.submitted).toMatchObject({ effect: "executed", memoryControl: { operationId: PROOF } });
  });

  it.each(["missing", "wrong-action"] as const)("keeps a cancelled control provisional when its receipt is %s", async failure => {
    const run = cancelled("memory-control");
    const invalid = failure === "missing" ? accepted() : {
      ...accepted(), memoryControl: { action: "update" as const, operationId: PROOF, replayed: false },
    };
    const incomplete = run.record(invalid);
    run.finish(exportReceipt(OTHER_PROOF));
    const completed = await run.submitted;
    expect(incomplete).toMatchObject({ status: "cancelled", effect: "uncertain" });
    expect(incomplete.proof).toBeUndefined();
    expect(incomplete.memoryControl).toBeUndefined();
    expect(completed).toMatchObject({ status: "cancelled", effect: "executed", proof: { proofId: OTHER_PROOF },
      memoryControl: { action: "export", operationId: OTHER_PROOF } });
    expect(completed.memoryControl?.exported).toBeUndefined();
  });

  it.each(["missing", "wrong-action"] as const)("does not verify a normal control when its receipt is %s", async failure => {
    const invalid = failure === "missing" ? accepted() : {
      ...accepted(), memoryControl: { action: "update" as const, operationId: PROOF, replayed: false },
    };
    const facade = new IaoFacade({ prepare: async () => invalid });
    const response = await facade.submit(CONTROL);
    expect(response.status).toBe("blocked");
    expect(response.proof).toBeUndefined();
    expect(response.memoryControl).toBeUndefined();
    // The existing terminal blocked contract is unchanged by a late valid result.
    expect(facade.recordKartaResult("tenant-a", "actor-a", REQUEST, exportReceipt())).toEqual(response);
  });

  it("keeps a normal unproven control preview open until its valid receipt arrives", async () => {
    const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "pending" }) });
    expect(await facade.submit(CONTROL)).toMatchObject({ status: "partial" });
    const response = facade.recordKartaResult("tenant-a", "actor-a", REQUEST, exportReceipt());
    expect(response).toMatchObject({ status: "verified", proof: { proofId: PROOF }, memoryControl: { action: "export" } });
    expect(response.memoryControl?.exported).toEqual([{ text: "synthetic export" }]);
    expect(facade.get("tenant-a", "actor-a", REQUEST).memoryControl?.exported).toBeUndefined();
  });

  it("binds receipt validation to the admitted action when the request object is reused", async () => {
    const run = cancelled("memory-control");
    Object.assign(run.request.memoryControl!, { action: "update" });
    const wrongAction = run.record({ ...accepted(), memoryControl: { action: "update", operationId: PROOF, replayed: false } });
    run.finish(exportReceipt(OTHER_PROOF));
    const result = await run.submitted;
    expect(wrongAction).toMatchObject({ effect: "uncertain" });
    expect(result).toMatchObject({ effect: "executed", memoryControl: { action: "export", operationId: OTHER_PROOF } });
  });

  it("retains a normal verified proof if the port later reuses and edits its result object", async () => {
    const receipt = exportReceipt();
    const facade = new IaoFacade({ prepare: async () => receipt });
    await facade.submit(CONTROL);
    const first = facade.get("tenant-a", "actor-a", REQUEST);
    Object.assign(receipt.evidence!, { proofId: OTHER_PROOF });
    expect(facade.get("tenant-a", "actor-a", REQUEST)).toEqual(first);
  });

  it("retains the first control receipt and never delivers forfeited export content", async () => {
    const run = cancelled("memory-control");
    const first = run.record(exportReceipt());
    vi.setSystemTime(START + 100);
    const replay = run.record(exportReceipt(OTHER_PROOF));
    run.finish(exportReceipt(OTHER_PROOF));
    expect(await run.submitted).toEqual(first);
    expect(replay).toEqual(first);
    expect(first.memoryControl?.exported).toBeUndefined();
    const submittedReplay = await run.facade.submit(run.request);
    expect(submittedReplay.memoryControl).toEqual({ action: "export", operationId: PROOF, replayed: true });
    expect(run.prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps the cancellation lease despite repeated final callbacks", async () => {
    const run = cancelled();
    const receipt = accepted();
    run.record(receipt);
    vi.setSystemTime(START + 900);
    run.record(receipt);
    run.finish(receipt);
    await run.submitted;
    vi.setSystemTime(START + 1_001);
    expect(run.read).toThrow(IaoRequestNotFoundError);
  });

  it("keeps a pending port until it drains without renewing its expired lease", async () => {
    const run = cancelled();
    const receipt = accepted();
    const first = run.record(receipt);
    vi.setSystemTime(START + 1_200);
    expect(run.read()).toEqual(first);
    run.finish(receipt);
    await run.submitted;
    // Respect the lazy sweep interval after the lookup at +1200 ms.
    vi.setSystemTime(START + 1_451);
    expect(run.read).toThrow(IaoRequestNotFoundError);
  });
});
