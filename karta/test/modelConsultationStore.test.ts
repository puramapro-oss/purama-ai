import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConsultationStore, type ConsultationOperation, type ConsultationRpcClient } from "../src/claude/consultation-store.js";
import { normalizeConsultationRequest, type ConsultationCall, type ConsultationResult } from "../src/claude/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";

const OWNER = "00000000-0000-4000-8000-000000000921";
const OTHER = "00000000-0000-4000-8000-000000000922";
const GENERATION = "00000000-0000-4000-8000-000000000923";
const request = () => ({ operationId: "private-op", userId: OWNER, question: "Question privée", preferences: { model: "qualified-model" } });
const plan = resolveModelExecutionPlan({ model: "qualified-model" }, [{ model: "qualified-model", reasoning: "none", maxOutputTokens: 1024 }]);
const estimates = () => ({ policyVersion: "local", calls: [{ kind: "synthesis" as const, provider: "anthropic", model: "qualified-model", maxCalls: 1, maxInputTokens: 300000, maxOutputTokens: 1024, maxCostMicros: 123 }] });
const operation = (state: ConsultationOperation["state"] = "pending"): ConsultationOperation => ({
  operationId: "private-op", state, resourceState: "reserved", cancelRequested: false, result: null,
  createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z",
});
const result = (): ConsultationResult => ({ status: "complete", reason: "completed", plan, answer: "Réponse obtenue", citedSourceIds: [], disagreements: [], uncertainties: [], sources: [], receipts: [], verificationStatus: "unverified" });
const call: ConsultationCall = { userId: OWNER, operationId: "private-op", callId: "private-op:1", provider: "anthropic", kind: "synthesis", model: "qualified-model", inputHash: "a".repeat(64), maxOutputTokens: 1024 };
const hash = () => createHash("sha256").update(JSON.stringify(normalizeConsultationRequest(request()))).digest("hex");
let handler: (name: string, args: Record<string, unknown>) => Promise<unknown>;
let query = vi.fn<(name: string, args: Record<string, unknown>) => Promise<{
  data: unknown; error: { code?: string; message?: string } | null;
}>>();
let client: ConsultationRpcClient;
beforeEach(() => {
  handler = async name => name === "model_consultation_create"
    ? { created: true, generation: GENERATION, operation: operation() }
    : name === "model_consultation_finalize" ? { ...operation("complete"), result: result(), resourceState: "reconciliation_required" }
    : name === "model_consultation_status" || name === "model_consultation_cancel" || name === "model_consultation_resume" ? operation() : true;
  query = vi.fn(async (name: string, args: Record<string, unknown>) => ({ data: await handler(name, args), error: null }));
  client = { rpc: (name, args) => ({ abortSignal: async signal => {
    signal.throwIfAborted();
    return query(name, args);
  } }) };
});
async function begin() {
  const begun = await createConsultationStore({ client }).begin(OWNER, request(), plan, estimates());
  if (!begun.created) throw new Error("Fixture must be newly admitted");
  return begun;
}
const claim = (begun: Awaited<ReturnType<typeof begin>>) => begun.admission.claim({ userId: OWNER, operationId: "private-op", requestHash: hash() }, new AbortController().signal);

describe("durable consultation store adapter", () => {
  it("checks availability without creating operations or grants", async () => {
    expect(await createConsultationStore({ client }).availability(OWNER)).toBe(true);
    expect(query).toHaveBeenCalledExactlyOnceWith("model_consultation_availability", { p_user_id: OWNER });
  });
  it("scopes status and cancellation to the authenticated owner", async () => {
    const store = createConsultationStore({ client });
    await store.status(OWNER, "private-op"); await store.cancel(OWNER, "private-op");
    expect(query.mock.calls).toEqual([
      ["model_consultation_status", { p_user_id: OWNER, p_operation_id: "private-op" }],
      ["model_consultation_cancel", { p_user_id: OWNER, p_operation_id: "private-op" }],
    ]);
  });
  it("resumes using exactly the normalized claim identity without opening an admission", async () => {
    await createConsultationStore({ client }).resume(OWNER, request());
    expect(query).toHaveBeenCalledExactlyOnceWith("model_consultation_resume", {
      p_user_id: OWNER, p_operation_id: "private-op", p_request_hash: hash(), p_request: normalizeConsultationRequest(request()),
    });
  });
  it("keeps an existing operation read-only even when a duplicate submit returns it", async () => {
    handler = async () => ({ created: false, operation: operation("running") });
    const existing = await createConsultationStore({ client }).begin(OWNER, request(), plan, estimates());
    expect(existing.created).toBe(false);
    expect(existing).not.toHaveProperty("admission");
    expect(query).toHaveBeenCalledOnce();
  });
  it("rejects an impersonated user before SQL and a pre-aborted request before any RPC", async () => {
    const store = createConsultationStore({ client });
    await expect(store.begin(OTHER, request(), plan, estimates())).rejects.toMatchObject({ code: "invalid" });
    const controller = new AbortController(); controller.abort();
    await expect(store.begin(OWNER, request(), plan, estimates(), controller.signal)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it("snapshots the request, plan and host estimate before the first await", async () => {
    const raw = request(); const chosen = structuredClone(plan); const caps = estimates();
    const pending = createConsultationStore({ client }).begin(OWNER, raw, chosen, caps);
    raw.question = "INJECTED"; chosen.maxOutputTokens = 1; caps.calls[0].maxCostMicros = 0;
    await pending;
    expect(query.mock.calls[0][1]).toMatchObject({ p_request: { question: "Question privée" }, p_plan: { maxOutputTokens: 1024 }, p_estimates: { calls: [{ maxCostMicros: 123 }] } });
  });
  it("refuses executable accessors in trusted-port data without invoking them", async () => {
    const getter = vi.fn(() => "policy");
    const value = Object.defineProperty(estimates(), "policyVersion", { enumerable: true, get: getter });
    await expect(createConsultationStore({ client }).begin(OWNER, request(), plan, value)).rejects.toMatchObject({ code: "invalid" });
    expect(getter).not.toHaveBeenCalled(); expect(query).not.toHaveBeenCalled();
  });
  it("permits one exact claim and denies callbacks for another operation", async () => {
    const begun = await begin();
    expect(await begun.admission.reserve(call, new AbortController().signal)).toBe(false);
    expect(await begun.admission.claim({ userId: OTHER, operationId: "private-op", requestHash: hash() }, new AbortController().signal)).toBe(false);
    expect(await claim(begun)).toBe(true); expect(await claim(begun)).toBe(false);
    expect(await begun.admission.reserve({ ...call, operationId: "other" }, new AbortController().signal)).toBe(false);
    expect(await begun.admission.reserve(call, new AbortController().signal)).toBe(true);
    expect(query.mock.calls.map(value => value[0])).toEqual(["model_consultation_create", "model_consultation_start", "model_consultation_reserve"]);
  });
  it("does not retry a lost start acknowledgement into a paid call", async () => {
    const begun = await begin();
    handler = async () => { throw new Error("lost response"); };
    await expect(claim(begun)).rejects.toMatchObject({ code: "unavailable" });
    expect(await claim(begun)).toBe(false);
    expect(await begun.admission.reserve(call, new AbortController().signal)).toBe(false);
    expect(query.mock.calls.filter(value => value[0] === "model_consultation_start")).toHaveLength(1);
  });
  it("settles uncertainty through a separate cleanup request and preserves null usage", async () => {
    const begun = await begin(); await claim(begun);
    await begun.admission.settle({ call, status: "uncertain", usage: [] });
    expect(query.mock.calls.at(-1)).toEqual(["model_consultation_settle", {
      p_user_id: OWNER, p_operation_id: "private-op", p_generation: GENERATION,
      p_receipt: { call, status: "uncertain", usage: [] },
    }]);
  });
  it("finalizes one immutable result and allows only that result's acknowledgement to reconcile", async () => {
    const begun = await begin(); await claim(begun);
    const original = result();
    const pending = begun.finalize(original); original.answer = "MUTATED";
    expect(begun.finalize(result())).toBe(pending);
    const stored = await pending;
    expect(stored).toMatchObject({ state: "complete", resourceState: "reconciliation_required", result: { answer: "Réponse obtenue" } });
    expect(query.mock.calls.at(-1)?.[1]).toMatchObject({ p_result: { answer: "Réponse obtenue" } });
    expect(() => begun.finalize({ ...result(), answer: "DIFFERENT" })).toThrow(/différent/);
    expect(await begun.admission.reserve(call, new AbortController().signal)).toBe(false);
  });
  it("maps SQL conflicts and missing budgets without exposing raw database messages", async () => {
    for (const [sql, expected] of [["PCO01", "conflict"], ["PCO02", "budget_unavailable"], ["PGRST202", "unavailable"]]) {
      query.mockResolvedValueOnce({ data: null, error: { code: sql, message: "PRIVATE SQL DETAIL" } });
      await expect(createConsultationStore({ client }).begin(OWNER, request(), plan, estimates())).rejects.toMatchObject({ code: expected });
    }
  });
  it("rejects a response for another operation and never leaks its result", async () => {
    handler = async () => ({ ...operation(), operationId: "foreign-operation", result: result() });
    await expect(createConsultationStore({ client }).status(OWNER, "private-op")).rejects.toMatchObject({ code: "unavailable" });
  });
});
