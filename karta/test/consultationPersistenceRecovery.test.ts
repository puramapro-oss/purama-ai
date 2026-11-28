import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createConsultationSqlFixture } from "./consultationSqlFixture.js";
import { createConsultationStore, type ConsultationRpcClient } from "../src/claude/consultation-store.js";
import { normalizeConsultationRequest, type ConsultationCall, type ConsultationResult } from "../src/claude/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";
import { normalizeModelUsage } from "../src/claude/usage.js";

const owner = "00000000-0000-4000-8000-000000000971";
const other = "00000000-0000-4000-8000-000000000972";
const request = normalizeConsultationRequest({
  operationId: "lost-sql-ack", userId: owner, question: "Réponse privée à conserver",
  preferences: { model: "qualified-model" },
});
const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
const plan = resolveModelExecutionPlan({ model: "qualified-model" },
  [{ model: "qualified-model", reasoning: "none", maxOutputTokens: 1024 }]);
const estimates = { policyVersion: "ack-loss-fixture-v1", calls: [
  { kind: "synthesis" as const, provider: "anthropic", model: "qualified-model",
    maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 50 },
] };
const call: ConsultationCall = {
  userId: owner, operationId: request.operationId, callId: "lost-sql-ack:1",
  kind: "synthesis", provider: "anthropic", model: "qualified-model",
  inputHash: "a".repeat(64), maxOutputTokens: 1024,
};
const usage = normalizeModelUsage({
  model: "qualified-model", id: "msg_ack_fixture",
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
}, "qualified-model", "https://api.anthropic.com");
const receipt = { call, status: "completed" as const, usage: [usage] };
const result = (): ConsultationResult => ({
  status: "complete", reason: "completed", plan, answer: "Réponse privée sauvegardée",
  citedSourceIds: [], disagreements: [], uncertainties: [], sources: [], receipts: [],
  verificationStatus: "unverified",
});
const signal = () => new AbortController().signal;
let fixture: Awaited<ReturnType<typeof createConsultationSqlFixture>>;
const query = (sql: string, args: unknown[] = []) => fixture.db.query<Record<string, unknown>>(sql, args);
const restored = () => createConsultationStore({ client: fixture.client });

// The actual production RPC commits in PostgreSQL/WASM before the transport
// fails. This deliberately differs from a mock that rejects before any write.
function lostAcknowledgement(rpcName: string) {
  let lost = 0;
  const client: ConsultationRpcClient = {
    rpc(name, args) {
      const pending = fixture.client.rpc(name, args);
      return {
        async abortSignal(abortSignal) {
          const response = await pending.abortSignal(abortSignal);
          if (name === rpcName && lost === 0 && response.error === null) {
            lost++;
            throw new Error("Fixture: SQL committed but acknowledgement was lost");
          }
          return response;
        },
      };
    },
  };
  return { store: createConsultationStore({ client }), losses: () => lost };
}
async function provision() {
  await query("SELECT purama_ai.model_consultation_provision($1,10000,100,'2099-01-01',4)", [owner]);
}
async function begin(store = restored()) {
  const begun = await store.begin(owner, request, plan, estimates);
  if (!begun.created) throw new Error("Fixture must have created one operation");
  return begun;
}
const claim = (begun: Awaited<ReturnType<typeof begin>>) =>
  begun.admission.claim({ userId: owner, operationId: request.operationId, requestHash }, signal());
async function allocationCounts() {
  return (await query(`SELECT
    (SELECT count(*)::int FROM purama_ai.model_consultations) AS operations,
    (SELECT count(*)::int FROM purama_ai.chef_tasks) AS tasks,
    (SELECT count(*)::int FROM purama_ai.chef_budget_reservations) AS reservations,
    (SELECT count(*)::int FROM purama_ai.model_consultation_calls) AS calls`)).rows[0];
}
async function budget() {
  return (await query(`SELECT actual_input_tokens,actual_output_tokens,actual_cost_micros,
    reserved_cost_micros FROM purama_ai.chef_budget_reservations`)).rows[0];
}
async function assertPrivateReadOnlyRecovery(state: string) {
  const restart = restored();
  expect(await restart.resume(owner, request)).toMatchObject({ operationId: request.operationId, state });
  expect(await restart.status(other, request.operationId)).toBeNull();
  const duplicate = await restart.begin(owner, request, plan, estimates);
  expect(duplicate.created).toBe(false);
  expect(duplicate).not.toHaveProperty("admission");
  expect(duplicate.operation.state).toBe(state);
  await expect(restart.resume(owner, { ...request, question: "Contenu discordant" }))
    .rejects.toMatchObject({ code: "conflict" });
}

beforeAll(async () => { fixture = await createConsultationSqlFixture(); });
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await query("INSERT INTO auth.users VALUES($1),($2)", [owner, other]);
  await fixture.db.exec("SET ROLE service_role");
});

describe("consultation recovery after a real SQL commit with a lost transport acknowledgement", () => {
  it("recovers a committed create privately without creating another operation or admission", async () => {
    await provision();
    const lossy = lostAcknowledgement("model_consultation_create");
    await expect(lossy.store.begin(owner, request, plan, estimates))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(lossy.losses()).toBe(1);
    await assertPrivateReadOnlyRecovery("pending");
    expect(await allocationCounts()).toEqual({ operations: 1, tasks: 1, reservations: 1, calls: 0 });
    expect(await budget()).toMatchObject({ actual_input_tokens: null, actual_cost_micros: null });
  });

  it("does not turn a committed start with an unknown acknowledgement into a new provider admission", async () => {
    await provision();
    const lossy = lostAcknowledgement("model_consultation_start");
    const begun = await begin(lossy.store);
    await expect(claim(begun)).rejects.toMatchObject({ code: "unavailable" });
    expect(lossy.losses()).toBe(1);
    expect(await claim(begun)).toBe(false);
    expect(await begun.admission.reserve(call, signal())).toBe(false);
    await assertPrivateReadOnlyRecovery("running");
    expect(await allocationCounts()).toEqual({ operations: 1, tasks: 1, reservations: 1, calls: 0 });
    expect(await budget()).toMatchObject({ actual_input_tokens: null, actual_cost_micros: null });
  });

  it("does not grant a second dispatch after the call reservation committed without its acknowledgement", async () => {
    await provision();
    const lossy = lostAcknowledgement("model_consultation_reserve");
    const begun = await begin(lossy.store);
    expect(await claim(begun)).toBe(true);
    await expect(begun.admission.reserve(call, signal())).rejects.toMatchObject({ code: "unavailable" });
    expect(lossy.losses()).toBe(1);
    expect(await begun.admission.reserve(call, signal())).toBe(false);
    expect(await begun.admission.reserve({ ...call, callId: "lost-sql-ack:2" }, signal())).toBe(false);
    await assertPrivateReadOnlyRecovery("running");
    expect(await allocationCounts()).toEqual({ operations: 1, tasks: 1, reservations: 1, calls: 1 });
    expect((await query("SELECT state,receipt FROM purama_ai.model_consultation_calls")).rows)
      .toEqual([{ state: "reserved", receipt: null }]);
    expect(await budget()).toMatchObject({ actual_input_tokens: null, actual_cost_micros: null });
  });

  it("reconciles the same committed receipt once and rejects a conflicting replacement", async () => {
    await provision();
    const lossy = lostAcknowledgement("model_consultation_settle");
    const begun = await begin(lossy.store);
    expect(await claim(begun)).toBe(true);
    expect(await begun.admission.reserve(call, signal())).toBe(true);
    await expect(begun.admission.settle(receipt)).rejects.toMatchObject({ code: "unavailable" });
    expect(lossy.losses()).toBe(1);
    await begun.admission.settle(receipt);
    await expect(begun.admission.settle({ ...receipt, usage: [{ ...usage, outputTokens: 6 }] }))
      .rejects.toMatchObject({ code: "conflict" });
    const final = await begun.finalize(result());
    expect(final).toMatchObject({ state: "complete", resourceState: "reconciliation_required" });
    expect(await allocationCounts()).toEqual({ operations: 1, tasks: 1, reservations: 1, calls: 1 });
    expect(Number((await budget()).actual_input_tokens)).toBe(10);
    expect(Number((await budget()).actual_output_tokens)).toBe(5);
    expect((await budget()).actual_cost_micros).toBeNull();
    const totals = (await query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions")).rows[0];
    expect(Number(totals.tokens_used)).toBe(15);
    expect(Number(totals.cost_used_micros)).toBe(0);
  });

  it("recovers the exact committed final result without duplicating usage or fabricating a price", async () => {
    await provision();
    const lossy = lostAcknowledgement("model_consultation_finalize");
    const begun = await begin(lossy.store);
    expect(await claim(begun)).toBe(true);
    expect(await begun.admission.reserve(call, signal())).toBe(true);
    await begun.admission.settle(receipt);
    await expect(begun.finalize(result())).rejects.toMatchObject({ code: "unavailable" });
    expect(lossy.losses()).toBe(1);
    const recovered = await begun.finalize(result());
    expect(recovered).toMatchObject({
      state: "complete", resourceState: "reconciliation_required",
      result: { answer: "Réponse privée sauvegardée" },
    });
    expect(await restored().status(owner, request.operationId)).toEqual(recovered);
    await assertPrivateReadOnlyRecovery("complete");
    expect(() => begun.finalize({ ...result(), answer: "Résultat remplacé" })).toThrow(/différent/);
    expect(await allocationCounts()).toEqual({ operations: 1, tasks: 1, reservations: 1, calls: 1 });
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_usage_events")).rows[0].count).toBe(1);
    const totals = (await query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions")).rows[0];
    expect(Number(totals.tokens_used)).toBe(15);
    expect(Number(totals.cost_used_micros)).toBe(0);
    expect((await budget()).actual_cost_micros).toBeNull();
    expect(Number((await budget()).reserved_cost_micros)).toBe(50);
  });

  it("preserves a committed early cancellation after its acknowledgement is lost", async () => {
    const lossy = lostAcknowledgement("model_consultation_cancel");
    await expect(lossy.store.cancel(owner, request.operationId)).rejects.toMatchObject({ code: "unavailable" });
    expect(lossy.losses()).toBe(1);
    const restart = restored();
    const cancelled = await restart.status(owner, request.operationId);
    expect(cancelled).toMatchObject({ state: "cancelled", cancelRequested: true, resourceState: "reconciled" });
    expect(await restart.cancel(owner, request.operationId)).toEqual(cancelled);
    expect(await restart.status(other, request.operationId)).toBeNull();
    const delayed = await restart.begin(owner, request, plan, estimates);
    expect(delayed.created).toBe(false);
    expect(delayed.operation).toEqual(cancelled);
    expect(delayed).not.toHaveProperty("admission");
    expect(await allocationCounts()).toEqual({ operations: 0, tasks: 0, reservations: 0, calls: 0 });
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_missions")).rows[0].count).toBe(0);
  });
});
