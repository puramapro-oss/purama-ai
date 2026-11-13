import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsultationSqlFixture } from "./consultationSqlFixture.js";
import { createConsultationStore } from "../src/claude/consultation-store.js";
import { createConsultationHost } from "../src/claude/consultation-host.js";
import type { ConsultationInput } from "../src/api/consultation-contract.js";

const user = "00000000-0000-4000-8000-000000000991";
const other = "00000000-0000-4000-8000-000000000992";
const id = "00000000-0000-4000-8000-000000000993";
const request: ConsultationInput = { operationId: id, question: "Question privée de qualification",
  preferences: { model: "qualified-model", reflection: "standard", speed: "standard" } };
const key = "native-account-fixture-not-a-secret";
const policy = { version: "fixture-v1", expiresAt: "2099-01-01T00:00:00Z",
  models: [{ model: "qualified-model", maxInputTokens: 32768, maxOutputTokens: 1024, maxCostMicros: 40 }] };
let fixture: Awaited<ReturnType<typeof createConsultationSqlFixture>>;
const network = vi.fn<typeof fetch>();
const signal = () => new AbortController().signal;
function host() {
  return createConsultationHost({ policyJson: JSON.stringify(policy), apiKey: key, simulation: false,
    store: createConsultationStore({ client: fixture.client }), stopped: async () => false,
    loadCatalog: async () => [{ model: "qualified-model", reasoning: "none", maxOutputTokens: 1024 }] });
}
const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, unknown>>(sql, values);
async function provision() {
  await query("SELECT purama_ai.model_consultation_provision($1,100000,100,'2099-01-01',1)", [user]);
}
function response(): Response {
  return new Response(JSON.stringify({ id: "msg_fixture", type: "message", role: "assistant", model: "qualified-model", stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ answer: "Réponse conservée", citedSourceIds: [], disagreements: [], uncertainties: ["Non vérifié"] }) }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}
beforeAll(async () => { fixture = await createConsultationSqlFixture(); });
afterAll(async () => { await fixture?.close(); });
beforeEach(async () => {
  await fixture.db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await query("INSERT INTO auth.users VALUES($1),($2)", [user, other]);
  await fixture.db.exec("SET ROLE service_role");
  network.mockReset();
  network.mockImplementation(async (url, init) => {
    expect(String(url)).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe(key);
    expect(headers.has("authorization")).toBe(false);
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("qualified-model"); expect(body.max_tokens).toBe(1024); expect(body.tools).toEqual([]);
    return response();
  });
  vi.stubGlobal("fetch", network);
  // An ambient gateway/token must not change a qualified native account.
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://unqualified-gateway.invalid");
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "unqualified-fixture-token");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("host → production store/SQL → installed Anthropic SDK", () => {
  it("persists the response and observed counters, recovers without inference and isolates owners", async () => {
    await provision(); const first = host();
    expect((await first.catalog(user, signal())).available).toBe(true);
    const result = await first.consult(user, request, signal());
    expect(result.status).toBe("reconciliation_required");
    expect(result.result?.status).toBe("complete"); expect(result.result?.answer).toBe("Réponse conservée");
    expect(network).toHaveBeenCalledOnce();
    const ledger = (await query("SELECT actual_input_tokens,actual_output_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0];
    expect(Number(ledger.actual_input_tokens)).toBe(10); expect(Number(ledger.actual_output_tokens)).toBe(5); expect(ledger.actual_cost_micros).toBeNull();
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.model_consultation_calls WHERE state='completed'")).rows[0].count).toBe(1);
    const restarted = host();
    expect(await restarted.consult(user, request, signal())).toEqual(result);
    expect(await restarted.status(user, id, signal())).toEqual(result);
    expect(await restarted.status(other, id, signal())).toBeNull();
    await expect(restarted.consult(user, { ...request, question: "Différente" }, signal())).rejects.toMatchObject({ code: "IAO_CONFLICT" });
    expect(network).toHaveBeenCalledOnce();
    // No synthetic invoice: operator/provider reconciliation fills only the unknown amount.
    await query("SELECT purama_ai.model_consultation_reconcile($1,$2,'fixture-observed-cost',10,5,0,31)", [user, id]);
    expect((await restarted.status(user, id, signal()))?.status).toBe("complete");
    const totals = (await query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE kind='consultation'")).rows[0];
    expect(Number(totals.tokens_used)).toBe(15); expect(Number(totals.cost_used_micros)).toBe(31);
  });
  it("never dispatches or fabricates a grant when owner resources are absent", async () => {
    const instance = host();
    expect((await instance.catalog(user, signal())).reason).toBe("budget_unavailable");
    await expect(instance.consult(user, request, signal())).rejects.toMatchObject({ code: "IAO_BUDGET" });
    expect(network).not.toHaveBeenCalled();
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_missions")).rows[0].count).toBe(0);
  });
  it("persists cancellation before a delayed begin without consuming resources", async () => {
    const first = host();
    expect((await first.cancel(user, id, signal()))?.status).toBe("cancelled");
    await provision();
    expect((await host().consult(user, request, signal())).status).toBe("cancelled");
    expect(network).not.toHaveBeenCalled();
    expect((await query("SELECT count(*)::int AS count FROM purama_ai.chef_budget_reservations")).rows[0].count).toBe(0);
  });
  it("does not retry a refused paid request or release its unknown accounting", async () => {
    await provision();
    network.mockResolvedValue(new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "private provider failure" } }), { status: 400 }));
    const instance = host(); const result = await instance.consult(user, request, signal());
    expect(result.status).toBe("reconciliation_required"); expect(result.result?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private provider failure"); expect(network).toHaveBeenCalledOnce();
    const ledger = (await query("SELECT actual_input_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0];
    expect(ledger.actual_input_tokens).toBeNull(); expect(ledger.actual_cost_micros).toBeNull();
    expect(await host().consult(user, request, signal())).toEqual(result); expect(network).toHaveBeenCalledOnce();
  });
  it("cancels an in-flight SDK request and preserves uncertainty across restart", async () => {
    await provision(); let dispatch!: () => void;
    const dispatched = new Promise<void>(resolve => { dispatch = resolve; });
    network.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      dispatch(); init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const instance = host(); const pending = instance.consult(user, request, signal());
    await dispatched;
    const cancelled = await instance.cancel(user, id, signal()); expect(cancelled?.cancelRequested).toBe(true);
    const final = await pending; expect(final.cancelRequested).toBe(true); expect(final.status).toBe("reconciliation_required");
    expect(network).toHaveBeenCalledOnce();
    expect((await query("SELECT state FROM purama_ai.model_consultation_calls")).rows[0].state).toBe("uncertain");
    expect(await host().status(user, id, signal())).toEqual(final);
    expect(await host().consult(user, request, signal())).toEqual(final); expect(network).toHaveBeenCalledOnce();
  });
});
