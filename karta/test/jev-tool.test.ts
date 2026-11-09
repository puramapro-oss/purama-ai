import { afterEach, describe, expect, it, vi } from "vitest";
import { createJevJudgmentTool, JEV_SETTLEMENT_TIMEOUT_MS, JEV_TOOL_TIMEOUT_MS, type JevAdmissionRequest, type JevPermit, type JevToolOptions } from "../src/tools/jev.js";
import { JEV_MODEL, type JevRequest, type JevResponse } from "../src/jev/schema.js";
import { validateToolParams } from "../src/engine/tool-input.js";
import { assertToolResult } from "../src/engine/tool-result.js";

const epoch = 1_800_000_000_000;
const execution = { userId: "tenant-1", agentType: "email" as const, mode: "live" as const, operationId: "run-1:0" };
const params: JevRequest = {
  state: "Le client demande un renseignement.",
  questions: {
    relevant: { type: "noul", instructions: "Ce texte concerne-t-il le service ?" },
    category: { type: "choice", instructions: "Quelle catégorie ?", criteria: { support: "Assistance", other: "Autre" } },
    priority: { type: "score", instructions: "Quelle priorité ?", criteria: ["Basse", "Haute"] },
  },
};
function response(): JevResponse {
  return {
    model: JEV_MODEL,
    answers: {
      relevant: { type: "noul", noul: 0.95 },
      category: { type: "choice", choice: "support", probabilities: { support: 0.9, other: 0.1 }, confidence: 0.9 },
      priority: { type: "score", score: 0.2, probabilities: { "0": 0.8, "1": 0.2 }, legend: { "0": "Basse", "1": "Haute" }, confidence: 0.9 },
    },
    usage: { input_tokens: 123, output_tokens: 12 },
  };
}
function permit(request: JevAdmissionRequest, signal = new AbortController().signal): JevPermit {
  return {
    userId: request.userId, operationId: request.operationId, requestHash: request.requestHash, model: JEV_MODEL,
    reservationId: "reservation-1", qualificationRef: "synthetic-test-only", validUntilMs: epoch + 60_000, signal,
    thresholds: {
      relevant: { type: "noul", negativeMax: 0.2, positiveMin: 0.8 },
      category: { type: "confidence", minConfidence: 0.8 },
      priority: { type: "confidence", minConfidence: 0.8 },
    },
  };
}
function setup(overrides: JevToolOptions = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(response()));
  const authorizeAndReserve = vi.fn(async (request: JevAdmissionRequest) => permit(request));
  const settle = vi.fn(async () => undefined);
  const tool = createJevJudgmentTool({ enabled: true, apiKey: "synthetic-key", fetchImpl, authorizeAndReserve, settle, now: () => epoch, ...overrides });
  return { tool, fetchImpl, authorizeAndReserve, settle };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("optional Jev KARTA tool", () => {
  it.each([undefined, false, "true", 1])("requires explicit boolean activation (%j)", async enabled => {
    const h = setup({ enabled: enabled as boolean });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "disabled", providerAttempted: false });
    expect(h.authorizeAndReserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ apiKey: undefined }, { apiKey: "secret\nheader" }, { authorizeAndReserve: undefined }, { settle: undefined }])("requires server configuration %j", async overrides => {
    const h = setup(overrides);
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "not_configured" });
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.authorizeAndReserve).not.toHaveBeenCalled();
  });

  it("does not authorize or send simulation work", async () => {
    const h = setup();
    expect(await h.tool.execute(params, { ...execution, mode: "simulation" })).toMatchObject({ reason: "simulation", providerAttempted: false });
    expect(h.authorizeAndReserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("requires a stable operation and refuses forged model-side rights before admission", async () => {
    const h = setup();
    expect(await h.tool.execute(params, { ...execution, operationId: undefined })).toMatchObject({ reason: "invalid_context" });
    const forged = { ...params, userId: "tenant-2", authorized: true, thresholds: { relevant: 0 } };
    expect(() => validateToolParams(h.tool, forged)).toThrow();
    expect(await h.tool.execute(forged, execution)).toMatchObject({ reason: "invalid_request" });
    expect(h.authorizeAndReserve).not.toHaveBeenCalled(); expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("binds immutable input to the authenticated tenant and reconciles observed usage once", async () => {
    const h = setup(); const before = structuredClone(params);
    expect(() => validateToolParams(h.tool, params)).not.toThrow();
    const result = await h.tool.execute(params, execution);
    expect(result).toMatchObject({ ok: true, status: "judgment_received", model: JEV_MODEL, decisions: { relevant: { status: "candidate" } } });
    expect(() => assertToolResult(result)).not.toThrow();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1); expect(h.settle).toHaveBeenCalledTimes(1);
    const admission = h.authorizeAndReserve.mock.calls[0][0];
    expect(admission).toMatchObject({ userId: execution.userId, operationId: execution.operationId, model: JEV_MODEL });
    expect(admission.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(admission)).toBe(true); expect(Object.isFrozen(admission.request.questions.category)).toBe(true);
    expect(h.settle).toHaveBeenCalledWith(admission, expect.any(Object), {
      providerAttempted: true, usageKnown: true, usage: { input_tokens: 123, output_tokens: 12 }, outcome: "received",
    }, expect.any(AbortSignal));
    const sent = JSON.parse(String(h.fetchImpl.mock.calls[0][1]?.body));
    expect(sent).toEqual({ model: JEV_MODEL, ...params });
    expect(sent.userId).toBeUndefined(); expect(params).toEqual(before);
  });

  it.each(["userId", "operationId", "requestHash", "model", "qualificationRef", "reservationId"] as const)("rejects a mismatched or missing permit %s", async field => {
    const h = setup({ authorizeAndReserve: async request => ({ ...permit(request), [field]: field.endsWith("Ref") || field.endsWith("Id") && field === "reservationId" ? "" : "wrong-binding" }) as JevPermit });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "invalid_permit", providerAttempted: false });
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
  });

  it("requires qualified policies for every question and does not accept a generic threshold", async () => {
    const h = setup({ authorizeAndReserve: async request => ({ ...permit(request), thresholds: { relevant: { type: "confidence", minConfidence: 0 } } }) });
    expect(await h.tool.execute(params, execution)).toMatchObject({ reason: "invalid_permit" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("returns abstention using server thresholds without changing them during a request", async () => {
    let granted: JevPermit;
    const raw = response();
    raw.answers.relevant = { type: "noul", noul: 0.5 };
    raw.answers.category = { type: "choice", choice: "support", probabilities: { support: 0.6, other: 0.4 }, confidence: 0.4 };
    const h = setup({
      authorizeAndReserve: async request => (granted = permit(request)),
      fetchImpl: async () => { granted.thresholds.category = { type: "confidence", minConfidence: 0 }; return Response.json(raw); },
    });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: true, decisions: {
      relevant: { status: "abstain" }, category: { status: "abstain" }, priority: { status: "candidate" },
    } });
  });

  it("does not dispatch with an expired permit and records that no attempt started", async () => {
    const h = setup({ authorizeAndReserve: async request => ({ ...permit(request), validUntilMs: epoch }) });
    expect(await h.tool.execute(params, execution)).toMatchObject({ reason: "authorization_expired", providerAttempted: false });
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.settle).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { providerAttempted: false, usageKnown: false, outcome: "not_dispatched" }, expect.any(AbortSignal));
  });

  it("rechecks expiry after a provider response while retaining its cost receipt", async () => {
    let time = epoch;
    const h = setup({ now: () => time, fetchImpl: async () => { time += 60_000; return Response.json(response()); } });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "authorization_expired", providerAttempted: true, usageKnown: true });
    expect(h.settle).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), expect.objectContaining({ usageKnown: true, outcome: "received" }), expect.any(AbortSignal));
  });

  it("honors a revoked permit before sending anything", async () => {
    const controller = new AbortController(); controller.abort(new Error("private-revocation"));
    const h = setup({ authorizeAndReserve: async request => permit(request, controller.signal) });
    const result = await h.tool.execute(params, execution);
    expect(result).toMatchObject({ reason: "cancelled", providerAttempted: false });
    expect(JSON.stringify(result)).not.toContain("private-revocation"); expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("cancels an in-flight provider and keeps its usage unknown instead of refunding it", async () => {
    const controller = new AbortController(); let started!: () => void;
    const called = new Promise<void>(resolve => { started = resolve; });
    let complete!: (response: Response) => void;
    const h = setup({ authorizeAndReserve: async request => permit(request, controller.signal), fetchImpl: async () => { started(); return new Promise<Response>(resolve => { complete = resolve; }); } });
    const pending = h.tool.execute(params, execution); await called; controller.abort();
    expect(await pending).toMatchObject({ reason: "cancelled", providerAttempted: true, usageKnown: false });
    expect(h.settle).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), { providerAttempted: true, usageKnown: false, outcome: "failed" }, expect.any(AbortSignal));
    complete(Response.json(response())); await Promise.resolve();
  });

  it("handles synchronous revocation from a transport without an unhandled rejection", async () => {
    const controller = new AbortController();
    const h = setup({ authorizeAndReserve: async request => permit(request, controller.signal), fetchImpl: async () => { controller.abort(); throw new Error("private-network-detail"); } });
    const result = await h.tool.execute(params, execution);
    expect(result).toMatchObject({ reason: "cancelled", providerAttempted: true });
    expect(JSON.stringify(result)).not.toContain("private-network-detail");
  });

  it("bounds a stalled admission and never starts a late provider call", async () => {
    vi.useFakeTimers(); let admissionSignal: AbortSignal | undefined;
    let finishAdmission!: () => void;
    const h = setup({ authorizeAndReserve: async (request, signal) => {
      admissionSignal = signal;
      return new Promise<JevPermit>(resolve => { finishAdmission = () => resolve(permit(request)); });
    } });
    const pending = h.tool.execute(params, execution);
    await vi.advanceTimersByTimeAsync(JEV_TOOL_TIMEOUT_MS);
    expect(await pending).toMatchObject({ reason: "deadline", providerAttempted: false });
    expect(admissionSignal?.aborted).toBe(true); expect(h.fetchImpl).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    finishAdmission(); await vi.advanceTimersByTimeAsync(0);
    expect(h.fetchImpl).not.toHaveBeenCalled(); expect(h.settle).not.toHaveBeenCalled();
  });

  it("keeps the original lease and revocation signal when the returned permit is mutated", async () => {
    const controller = new AbortController(); let granted: JevPermit;
    const h = setup({
      authorizeAndReserve: async request => (granted = permit(request, controller.signal)),
      fetchImpl: async () => {
        granted.signal = new AbortController().signal;
        granted.validUntilMs = epoch + 3_600_000;
        controller.abort();
        return Response.json(response());
      },
    });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "cancelled", providerAttempted: true });
    expect(h.settle).toHaveBeenCalledTimes(1);
  });

  it("expires a short lease during a hanging provider call and clears both timers", async () => {
    vi.useFakeTimers(); let transportSignal: AbortSignal | undefined;
    const h = setup({
      authorizeAndReserve: async request => ({ ...permit(request), validUntilMs: epoch + 500 }),
      fetchImpl: async (_url, options) => { transportSignal = options?.signal as AbortSignal; return new Promise<never>(() => {}); },
    });
    const pending = h.tool.execute(params, execution);
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toMatchObject({ ok: false, reason: "cancelled", providerAttempted: true, usageKnown: false });
    expect(transportSignal?.aborted).toBe(true); expect(h.settle).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an uncooperative fetch and settles an ambiguous attempt exactly once", async () => {
    vi.useFakeTimers(); let transportSignal: AbortSignal | undefined;
    const h = setup({ fetchImpl: async (_url, options) => { transportSignal = options?.signal as AbortSignal; return new Promise<never>(() => {}); } });
    const pending = h.tool.execute(params, execution);
    await vi.advanceTimersByTimeAsync(JEV_TOOL_TIMEOUT_MS);
    expect(await pending).toMatchObject({ reason: "deadline", providerAttempted: true, usageKnown: false });
    expect(transportSignal?.aborted).toBe(true); expect(h.settle).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry or expose provider error bodies when credits are exhausted", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("secret-provider-detail", { status: 402 }));
    const h = setup({ fetchImpl });
    const result = await h.tool.execute(params, execution);
    expect(result).toMatchObject({ ok: false, reason: "credits", providerAttempted: true, usageKnown: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(h.settle).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("secret-provider-detail");
  });

  it("reports accounting failure instead of returning an unrecorded judgment as success", async () => {
    const h = setup({ settle: async () => { throw new Error("secret-ledger-detail"); } });
    const result = await h.tool.execute(params, execution);
    expect(result).toMatchObject({ ok: false, reason: "accounting_unconfirmed", providerAttempted: true, usageKnown: true });
    expect(() => assertToolResult(result)).toThrow(); expect(JSON.stringify(result)).not.toContain("secret-ledger-detail");
  });

  it("bounds cleanup separately and removes all timers", async () => {
    vi.useFakeTimers(); const h = setup({ settle: async () => new Promise<never>(() => {}) });
    const pending = h.tool.execute(params, execution);
    await vi.advanceTimersByTimeAsync(JEV_SETTLEMENT_TIMEOUT_MS);
    expect(await pending).toMatchObject({ reason: "accounting_unconfirmed", usageKnown: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("withholds the candidate if permission is revoked during reconciliation", async () => {
    const controller = new AbortController();
    const settle = vi.fn(async () => { controller.abort(); });
    const h = setup({ authorizeAndReserve: async request => permit(request, controller.signal), settle });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "cancelled", providerAttempted: true, usageKnown: true });
    expect(settle).toHaveBeenCalledTimes(1); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("withholds the candidate if the lease expires during reconciliation", async () => {
    let time = epoch;
    const settle = vi.fn(async () => { time += 60_000; });
    const h = setup({ now: () => time, settle });
    expect(await h.tool.execute(params, execution)).toMatchObject({ ok: false, reason: "authorization_expired", providerAttempted: true, usageKnown: true });
    expect(settle).toHaveBeenCalledTimes(1); expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sanitizes admission errors and does not dispatch after denial", async () => {
    const failed = setup({ authorizeAndReserve: async () => { throw new Error("secret-authorization-detail"); } });
    const result = await failed.tool.execute(params, execution);
    expect(result).toMatchObject({ reason: "admission_unavailable", providerAttempted: false });
    expect(JSON.stringify(result)).not.toContain("secret-authorization-detail"); expect(failed.fetchImpl).not.toHaveBeenCalled();
    const denied = setup({ authorizeAndReserve: async () => null });
    expect(await denied.tool.execute(params, execution)).toMatchObject({ reason: "not_authorized" });
    expect(denied.fetchImpl).not.toHaveBeenCalled();
  });
});
