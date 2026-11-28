import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeConsultationRequest, type ConsultationRequest } from "../src/claude/consultation.js";
import { createConsultationStore } from "../src/claude/consultation-store.js";
import { createConsultationHost } from "../src/claude/consultation-host.js";
import { parseConsultationAction } from "../src/api/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";
import { createConsultationSqlFixture } from "./consultationSqlFixture.js";

const owner = "00000000-0000-4000-8000-000000000971";
const other = "00000000-0000-4000-8000-000000000972";
const operationId = "00000000-0000-4000-8000-000000000973";
const preferences = { model: "qualified-model", reflection: "auto" as const, speed: "standard" as const };
const plan = resolveModelExecutionPlan(preferences, [{ model: preferences.model, reasoning: "none", maxOutputTokens: 1024 }]);
const estimates = { policyVersion: "identity-test", calls: [{ kind: "synthesis" as const, provider: "anthropic", model: preferences.model,
  maxCalls: 1, maxInputTokens: 100, maxOutputTokens: 1024, maxCostMicros: 50 }] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const signal = () => new AbortController().signal;
const request = (): ConsultationRequest => ({ operationId, userId: owner, question: "Même question privée", preferences });
// Exact historical field order, intentionally independent of the current normalizer.
const historicalRequest = (patch: Partial<ConsultationRequest> = {}) => ({ question: "Même question privée", preferences,
  reviewerModels: [], research: { queries: [], urls: [] }, userId: owner, operationId, ...patch });
type IdentityReply = { data: unknown; error: { code?: string } | null };
let fixture: Awaited<ReturnType<typeof createConsultationSqlFixture>>;
let identityReader: ReturnType<typeof vi.fn<(userId: string, id: string, active: AbortSignal) => Promise<IdentityReply>>>;
const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, unknown>>(sql, values);

async function readIdentity(userId: string, id: string, active: AbortSignal): Promise<IdentityReply> {
  active.throwIfAborted();
  const result = await query("SELECT user_id,operation_id,request_hash,request FROM purama_ai.model_consultations WHERE user_id=$1 AND operation_id=$2", [userId, id]);
  active.throwIfAborted();
  return { data: result.rows[0] ?? null, error: null };
}
function store(timeoutMs = 5000) {
  const options = { client: fixture.client, readIdentity: identityReader, timeoutMs };
  return createConsultationStore(options);
}
async function seedLegacy(raw = historicalRequest(), completed = false) {
  const value = (await query("SELECT purama_ai.model_consultation_create($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) AS value",
    [owner, operationId, digest(raw), JSON.stringify(raw), JSON.stringify(plan), JSON.stringify(estimates)])).rows[0].value as { generation: string };
  if (completed) {
    const call = { operationId, userId: owner, callId: operationId + ":1", kind: "synthesis", provider: "anthropic",
      model: preferences.model, inputHash: "a".repeat(64), maxOutputTokens: 1024 };
    await query("SELECT purama_ai.model_consultation_start($1,$2,$3,$4)", [owner, operationId, digest(raw), value.generation]);
    await query("SELECT purama_ai.model_consultation_reserve($1,$2,$3,$4::jsonb)", [owner, operationId, value.generation, JSON.stringify(call)]);
    await query("SELECT purama_ai.model_consultation_settle($1,$2,$3,$4::jsonb)", [owner, operationId, value.generation,
      JSON.stringify({ call, status: "completed", usage: [] })]);
    await query("SELECT purama_ai.model_consultation_finalize($1,$2,$3,$4::jsonb)", [owner, operationId, value.generation,
      JSON.stringify({ status: "complete", reason: "completed", plan, answer: "Réponse historique conservée", citedSourceIds: [],
        disagreements: [], uncertainties: [], sources: [], receipts: [], verificationStatus: "unverified" })]);
  }
  return (await query("SELECT * FROM purama_ai.model_consultations WHERE user_id=$1 AND operation_id=$2", [owner, operationId])).rows[0];
}

beforeAll(async () => { fixture = await createConsultationSqlFixture(); });
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await query("INSERT INTO auth.users VALUES($1),($2)", [owner, other]);
  await fixture.db.exec("SET ROLE service_role");
  await query("SELECT purama_ai.model_consultation_provision($1,100000,1000,'2099-01-01',4)", [owner]);
  identityReader = vi.fn(readIdentity);
});
afterEach(() => vi.useRealTimers());

describe("consultation request identity across serialization and legacy receipts", () => {
  it("gives equivalent optional fields and JSON property orders one identity after the real HTTP parser", () => {
    const variants = [
      { action: "consult", operationId, question: request().question, preferences: { model: preferences.model } },
      { action: "consult", operationId, question: request().question, preferences, reviewerModels: [] },
      { action: "consult", operationId, question: request().question, preferences, research: { queries: [], urls: [] } },
      { research: { urls: [], queries: [] }, reviewerModels: [], preferences: { speed: "standard", reflection: "auto", model: preferences.model },
        question: request().question, operationId, action: "consult" },
    ];
    const fingerprints = variants.map(raw => {
      const parsed = parseConsultationAction(raw);
      if (parsed.action !== "consult") throw new Error("Expected consultation");
      const { action: _action, ...input } = parsed;
      return digest(normalizeConsultationRequest({ ...input, userId: owner }));
    });
    expect(new Set(fingerprints).size).toBe(1);
    expect(digest(normalizeConsultationRequest(request()))).toBe(fingerprints[0]);
  });

  it("coalesces concurrent fresh equivalent submissions without a second reservation", async () => {
    const instance = store();
    const rows = await Promise.all([
      instance.begin(owner, request(), plan, estimates),
      instance.begin(owner, historicalRequest(), plan, estimates),
    ]);
    expect(rows.filter(row => row.created)).toHaveLength(1);
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_budget_reservations")).rows[0].count).toBe(1);
    expect(identityReader).not.toHaveBeenCalled();
  });

  it.each([false, true])("recovers a legacy receipt without changing its evidence or reopening its work (completed=%s)", async completed => {
    const original = await seedLegacy(historicalRequest(), completed);
    const instance = store();
    const recovered = await instance.resume(owner, request());
    expect(recovered?.state).toBe(completed ? "complete" : "pending");
    expect(recovered?.result?.answer ?? null).toBe(completed ? "Réponse historique conservée" : null);
    const duplicate = await instance.begin(owner, request(), plan, estimates);
    expect(duplicate.created).toBe(false);
    expect(duplicate).not.toHaveProperty("admission");
    expect(duplicate.operation).toEqual(recovered);
    expect((await query("SELECT * FROM purama_ai.model_consultations WHERE user_id=$1 AND operation_id=$2", [owner, operationId])).rows[0]).toEqual(original);
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_budget_reservations")).rows[0].count).toBe(1);
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.model_consultation_calls")).rows[0].count).toBe(completed ? 1 : 0);
  });

  it("returns the historical result before authorizing or constructing a provider client", async () => {
    await seedLegacy(historicalRequest(), true);
    const stopped = vi.fn(async () => false);
    const createClient = vi.fn(() => { throw new Error("No provider may be constructed during recovery"); });
    const host = createConsultationHost({ store: store(), stopped, createClient, simulation: false, apiKey: "fixture-only",
      policyJson: JSON.stringify({ version: "fixture", expiresAt: "2099-01-01T00:00:00Z", models: [{ model: preferences.model,
        maxInputTokens: 32768, maxOutputTokens: 1024, maxCostMicros: 50 }] }) });
    const { userId: _userId, ...input } = request();
    const received = await host.consult(owner, input, signal());
    expect(received.result?.answer).toBe("Réponse historique conservée");
    expect(createClient).not.toHaveBeenCalled(); expect(stopped).not.toHaveBeenCalled();
    expect(JSON.stringify(received)).not.toContain("request_hash");
    expect(JSON.stringify(received)).not.toContain("Même question privée");
  });

  it("uses the installed Supabase SDK to read only the owner's exact legacy identity", async () => {
    const legacy = historicalRequest();
    const received = { operationId, state: "complete", resourceState: "reconciled", cancelRequested: false,
      result: null, createdAt: "2026-11-25T00:00:00Z", updatedAt: "2026-11-25T00:00:00Z" };
    let rpcCalls = 0;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://example.invalid");
      if (url.pathname === "/rest/v1/rpc/model_consultation_resume") {
        rpcCalls++;
        const body = JSON.parse(String(init?.body));
        expect(body.p_user_id).toBe(owner); expect(body.p_operation_id).toBe(operationId);
        if (rpcCalls === 1) return Response.json({ code: "PCO01", message: "Fixture conflict" }, { status: 409 });
        expect(body.p_request_hash).toBe(digest(legacy)); expect(body.p_request).toEqual(legacy);
        return Response.json(received);
      }
      expect(init?.method).toBe("GET");
      expect(url.pathname).toBe("/rest/v1/model_consultations");
      expect(Object.fromEntries(url.searchParams)).toEqual({ select: "user_id,operation_id,request_hash,request",
        user_id: "eq." + owner, operation_id: "eq." + operationId });
      return Response.json([{ user_id: owner, operation_id: operationId, request_hash: digest(legacy), request: legacy }]);
    });
    try {
      expect(await createConsultationStore().resume(owner, request())).toEqual(received);
      expect(network).toHaveBeenCalledTimes(3);
      expect(rpcCalls).toBe(2);
    } finally { network.mockRestore(); }
  });

  it.each([
    { question: "Autre question" }, { preferences: { ...preferences, model: "other-model" } },
    { preferences: { ...preferences, reflection: "standard" as const } },
    { preferences: { ...preferences, speed: "fast" as const } }, { reviewerModels: ["reviewer-one"] },
    { research: { queries: ["other query"], urls: [] } }, { research: { queries: [], urls: ["https://example.com/other"] } },
  ])("keeps a real request change conflicting (%#)", async patch => {
    await seedLegacy();
    await expect(store().resume(owner, { ...request(), ...patch })).rejects.toMatchObject({ code: "conflict" });
    await expect(store().begin(owner, { ...request(), ...patch }, plan, estimates)).rejects.toMatchObject({ code: "conflict" });
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_budget_reservations")).rows[0].count).toBe(1);
  });

  it.each(["reviewerModels", "queries", "urls"] as const)("preserves meaningful %s ordering", async field => {
    const original = historicalRequest({ reviewerModels: ["a", "b"], research: { queries: ["one", "two"], urls: ["https://example.com/one", "https://example.com/two"] } });
    await seedLegacy(original);
    const changed = structuredClone(original);
    if (field === "reviewerModels") changed.reviewerModels.reverse(); else changed.research[field].reverse();
    await expect(store().resume(owner, changed)).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not read another owner's legacy identity", async () => {
    await seedLegacy();
    expect(await store().resume(other, { ...request(), userId: other })).toBeNull();
    expect(identityReader).not.toHaveBeenCalled();
  });

  it.each(["foreign-owner", "foreign-operation", "missing-owner", "extra-key", "invalid-hash", "constructor", "null"])(
    "rejects invalid or mis-scoped identity readback %s", async variant => {
      const original = await seedLegacy();
      const row: Record<string, unknown> = { user_id: owner, operation_id: operationId, request_hash: original.request_hash, request: original.request };
      if (variant === "foreign-owner") row.user_id = other;
      if (variant === "foreign-operation") row.operation_id = "different";
      if (variant === "missing-owner") delete row.user_id;
      if (variant === "extra-key") row.undeclared = "private";
      if (variant === "invalid-hash") row.request_hash = "x".repeat(64);
      if (variant === "constructor") row.request = { ...(row.request as object), constructor: "unexpected" };
      identityReader.mockResolvedValue({ data: variant === "null" ? null : row, error: null });
      await expect(store().resume(owner, request())).rejects.toThrow();
      expect((await query("SELECT count(*)::int AS count FROM purama_ai.model_consultation_calls")).rows[0].count).toBe(0);
    });

  it("rejects an accessor without invoking it", async () => {
    const original = await seedLegacy(); const getter = vi.fn(() => original.request);
    const row = { user_id: owner, operation_id: operationId, request_hash: original.request_hash };
    Object.defineProperty(row, "request", { enumerable: true, get: getter });
    identityReader.mockResolvedValue({ data: row, error: null });
    await expect(store().resume(owner, request())).rejects.toThrow(); expect(getter).not.toHaveBeenCalled();
  });

  it("refuses a failed identity read without disclosing database details", async () => {
    await seedLegacy();
    identityReader.mockResolvedValue({ data: null, error: { code: "PRIVATE_ERROR" } });
    await expect(store().resume(owner, request())).rejects.toMatchObject({ code: "unavailable" });
  });

  it("cannot use a late identity read after caller cancellation", async () => {
    await seedLegacy(); const controller = new AbortController();
    const originalRead = await readIdentity(owner, operationId, signal());
    let release!: (value: IdentityReply) => void;
    identityReader.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = store().resume(owner, request(), controller.signal).then(value => ({ value }), error => ({ error }));
    try { await vi.waitFor(() => expect(identityReader).toHaveBeenCalled()); }
    finally { controller.abort(); await pending; }
    expect(await pending).toHaveProperty("error");
    release(originalRead); await new Promise<void>(resolve => setImmediate(resolve));
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.model_consultation_calls")).rows[0].count).toBe(0);
  });

  it("bounds a stalled legacy identity lookup", async () => {
    await seedLegacy(); identityReader.mockImplementation(() => new Promise(() => undefined));
    await expect(store(100).resume(owner, request())).rejects.toMatchObject({ code: "unavailable" });
  });
});
