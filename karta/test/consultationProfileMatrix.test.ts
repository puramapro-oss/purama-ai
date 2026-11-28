import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, request, type Server } from "node:http";
import { Readable } from "node:stream";
import { createConsultationSqlFixture } from "./consultationSqlFixture.js";
import { createConsultationStore } from "../src/claude/consultation-store.js";
import { createConsultationHost } from "../src/claude/consultation-host.js";
import type { ConsultationCatalog, ConsultationHost, ConsultationOperation } from "../src/api/consultation-contract.js";
import type { ExecutionSpeed, ReflectionDepth } from "../src/claude/execution-profile.js";

vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));
import { startApiServer } from "../src/api/server.js";

/** Qualification boundary: real loopback HTTP, production catalogue, host,
 * installed SDK and production SQL in PGlite. Only the provider is controlled;
 * these tests do not measure Anthropic availability, intelligence or invoices. */
const owner = "00000000-0000-4000-8000-000000001101";
const stranger = "00000000-0000-4000-8000-000000001102";
const operationId = "00000000-0000-4000-8000-000000001103";
const secondId = "00000000-0000-4000-8000-000000001104";
const key = "profile-fixture-not-a-secret";
const speeds: ExecutionSpeed[] = ["standard", "fast", "ultra_fast"];
const reflections: ReflectionDepth[] = ["auto", "standard", "deep", "maximum"];
type Family = { id: string; reasoning: "none" | "budget" | "adaptive"; cap: number; reflections: ReflectionDepth[] };
const families: Family[] = [
  { id: "qualified-none", reasoning: "none", cap: 1024, reflections: ["auto", "standard"] },
  { id: "qualified-budget", reasoning: "budget", cap: 16384, reflections },
  { id: "qualified-adaptive", reasoning: "adaptive", cap: 16384, reflections },
  { id: "qualified-tiny-budget", reasoning: "budget", cap: 1024, reflections: ["auto", "standard"] },
];
// Independent contract cases, not values obtained from the production resolver.
const profiles = families.flatMap(family => family.reflections.flatMap(reflection => speeds.map(speed => ({ family, reflection, speed }))));
type NativeCall = {
  model: string; max_tokens: number; tools: unknown[]; system: unknown;
  thinking?: { type: string; budget_tokens?: number }; output_config?: { effort: string };
  messages: Array<{ content: string }>;
};
type ReceivedCall = { body: NativeCall; context: Record<string, unknown>; kind: "proposal" | "critique" | "synthesis" };
type ResponseBody = { ok: boolean; catalog?: ConsultationCatalog; operation?: ConsultationOperation; error?: unknown };
let fixture: Awaited<ReturnType<typeof createConsultationSqlFixture>>;
let apiServer: ReturnType<typeof startApiServer>;
let providerServer: Server;
let apiPort: number;
let providerPort: number;
let host: ConsultationHost;
let catalogueFamilies: Family[];
let observed: ReceivedCall[];
let catalogueRequests: number;
let providerGate: Promise<void> | undefined;
let providerEntered: (() => void) | undefined;
let providerFailure: "refusal" | "invalid_json" | "wrong_model" | undefined;
let providerStatus: number;

function localHttp(port: number, path: string, init: RequestInit = {}): Promise<Response> {
  if (port !== apiPort && port !== providerPort) throw new Error("Only explicit loopback test servers are permitted");
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers).entries()), signal: init.signal ?? undefined,
    }, res => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      resolve(new Response(Readable.toWeb(res) as never, { status: res.statusCode!, headers }));
    });
    req.on("error", reject); req.end(init.body as string | undefined);
  });
}
const query = (sql: string, values: unknown[] = []) => fixture.db.query<Record<string, unknown>>(sql, values);
async function api(body: unknown, userId = owner) {
  const response = await localHttp(apiPort, `/consultations/${userId}`, { method: "POST", headers: { Authorization: "Bearer test-only-admin", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { response, body: await response.json() as ResponseBody };
}
function input(patch: Record<string, unknown> = {}) {
  return { action: "consult", operationId, question: "Question de qualification du transport", preferences: { model: "qualified-budget", reflection: "standard", speed: "standard" }, ...patch };
}
async function provision(tokens = 10_000_000, cost = 10_000_000, userId = owner) {
  await query("SELECT purama_ai.model_consultation_provision($1,$2,$3,'2099-01-01',8)", [userId, tokens, cost]);
}
function makeHost(maxInputTokens = 131072) {
  return createConsultationHost({ apiKey: key, simulation: false, stopped: async () => false,
    policyJson: JSON.stringify({ version: "profile-qualification-v1", expiresAt: "2099-01-01T00:00:00Z", models: catalogueFamilies.map(f => ({ model: f.id, maxInputTokens, maxOutputTokens: f.cap, maxCostMicros: 50 })) }),
    store: createConsultationStore({ client: fixture.client }),
  });
}
function nativeCatalogue(family: Family) {
  const thinking = family.reasoning === "none" ? null : { supported: true, types: { [family.reasoning === "adaptive" ? "adaptive" : "enabled"]: { supported: true } } };
  return { id: family.id, type: "model", display_name: family.id, created_at: "2026-01-01T00:00:00Z", lifecycle: "active", max_tokens: family.cap,
    capabilities: { thinking, ...(family.reasoning === "adaptive" ? { effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, max: { supported: true } } } : {}) } };
}
function providerReply(call: ReceivedCall) {
  const text = providerFailure === "invalid_json" ? "not a conclusion object" : call.kind === "synthesis"
    ? JSON.stringify({ answer: "Conclusion contrôlée du fournisseur simulé", citedSourceIds: [], disagreements: [], uncertainties: ["Qualité du modèle non mesurée"] })
    : `Avis contrôlé de ${call.body.model}`;
  return { id: `msg_controlled_${observed.length}`, type: "message", role: "assistant", model: providerFailure === "wrong_model" ? "unrequested-model" : call.body.model,
    stop_reason: providerFailure === "refusal" ? "refusal" : "end_turn", content: [{ type: "text", text }],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } };
}
async function assertSingleLedger(calls: number) {
  const counts = (await query("SELECT (SELECT count(*)::int FROM purama_ai.model_consultations) AS operations, (SELECT count(*)::int FROM purama_ai.chef_budget_reservations) AS reservations, (SELECT count(*)::int FROM purama_ai.model_consultation_calls) AS calls")).rows[0];
  expect(counts).toEqual({ operations: 1, reservations: 1, calls });
  const ledger = (await query("SELECT actual_input_tokens,actual_output_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0];
  expect(Number(ledger.actual_input_tokens)).toBe(calls * 10); expect(Number(ledger.actual_output_tokens)).toBe(calls * 5);
  expect(ledger.actual_cost_micros).toBeNull();
}
async function assertNoAllocation() {
  expect(observed).toHaveLength(0);
  const counts = (await query("SELECT (SELECT count(*)::int FROM purama_ai.model_consultations) AS operations, (SELECT count(*)::int FROM purama_ai.chef_budget_reservations) AS reservations, (SELECT count(*)::int FROM purama_ai.model_consultation_calls) AS calls")).rows[0];
  expect(counts).toEqual({ operations: 0, reservations: 0, calls: 0 });
}

beforeAll(async () => {
  fixture = await createConsultationSqlFixture();
  providerServer = createServer((req, res) => {
    void (async () => {
      expect(req.headers["x-api-key"]).toBe(key); expect(req.headers.authorization).toBeUndefined();
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/v1/models?limit=1000") {
        catalogueRequests++; res.end(JSON.stringify({ data: catalogueFamilies.map(nativeCatalogue), has_more: false })); return;
      }
      if (req.method !== "POST" || req.url !== "/v1/messages") throw new Error("Unexpected controlled provider route");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as NativeCall;
      const content = body.messages[0].content;
      const prefix = "Contexte actuel:\n"; const suffix = "\n\nDécide quelle(s) action(s) prendre.";
      expect(content.startsWith(prefix) && content.endsWith(suffix)).toBe(true);
      const context = JSON.parse(content.slice(prefix.length, -suffix.length)) as Record<string, unknown>;
      const synthesis = JSON.stringify(body.system).includes("Retourne uniquement");
      const call: ReceivedCall = { body, context, kind: synthesis ? "synthesis" : "opinions" in context ? "critique" : "proposal" };
      observed.push(call); providerEntered?.(); await providerGate;
      res.statusCode = providerStatus;
      res.end(JSON.stringify(providerStatus === 200 ? providerReply(call) : { type: "error", error: { type: "rate_limit_error", message: "Controlled rejection" } }));
    })().catch(error => { res.statusCode = 500; res.end(JSON.stringify({ fixtureError: String(error) })); });
  });
  await new Promise<void>(resolve => providerServer.listen(0, "127.0.0.1", resolve));
  providerPort = (providerServer.address() as { port: number }).port;
  apiServer = startApiServer(async () => ({ ready: true, phase: "ready" }), { consultationHost: {
    catalog: (...args) => host.catalog(...args), consult: (...args) => host.consult(...args), status: (...args) => host.status(...args), cancel: (...args) => host.cancel(...args),
  } });
  await new Promise<void>(resolve => apiServer.once("listening", resolve)); apiPort = (apiServer.address() as { port: number }).port;
});
beforeEach(async () => {
  await fixture.db.exec("RESET ROLE; TRUNCATE auth.users CASCADE;");
  await query("INSERT INTO auth.users VALUES($1),($2)", [owner, stranger]); await fixture.db.exec("SET ROLE service_role");
  catalogueFamilies = families; observed = []; catalogueRequests = 0; providerGate = undefined; providerEntered = undefined; providerFailure = undefined; providerStatus = 200;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    if (target.origin !== "https://api.anthropic.com" || !["/v1/models", "/v1/messages"].includes(target.pathname)) throw new Error("Unexpected external destination");
    return localHttp(providerPort, target.pathname + target.search, init);
  });
  // Deliberately invalid ambient overrides may never receive a native-account call.
  vi.stubEnv("ANTHROPIC_BASE_URL", "https://unqualified.invalid"); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "unqualified-token");
  host = makeHost();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  apiServer?.closeAllConnections(); providerServer?.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => apiServer?.close(() => resolve())), new Promise<void>(resolve => providerServer?.close(() => resolve()))]);
  await fixture?.close();
});

describe("actual advertised profiles through internal HTTP, SQL and installed SDK", () => {
  it("publishes exactly the supported 36 profiles, without dispatching inference", async () => {
    await provision(); const { response, body } = await api({ action: "catalog" });
    expect(response.status).toBe(200); expect(body.catalog?.reason).toBe("ready"); expect(body.catalog?.models).toHaveLength(4);
    const actual = body.catalog!.models.flatMap(m => m.profiles.map(p => `${m.model}/${p.reflection}/${p.speed}`)).sort();
    expect(actual).toEqual(profiles.map(p => `${p.family.id}/${p.reflection}/${p.speed}`).sort()); expect(actual).toHaveLength(36);
    expect(catalogueRequests).toBe(1); await assertNoAllocation();
  });

  it.each(profiles)("executes $family.id/$reflection/$speed with exact provider parameters and one durable reservation", async ({ family, reflection, speed }) => {
    await provision(); const preferences = { model: family.id, reflection, speed };
    const first = await api(input({ preferences }));
    expect(first.response.status).toBe(200);
    const output = reflection === "maximum" ? 16384 : reflection === "deep" ? 8192 : 1024;
    expect(first.body.operation).toMatchObject({ status: "reconciliation_required", result: { status: "complete", reason: "completed", verificationStatus: "unverified",
      answer: "Conclusion contrôlée du fournisseur simulé", plan: { model: family.id, reflection: reflection === "auto" ? "standard" : reflection, speed,
        maxOutputTokens: Math.min(output, family.cap), timeoutMs: speed === "ultra_fast" ? 15000 : speed === "fast" ? 30000 : 60000 } } });
    expect(observed).toHaveLength(1); expect(observed[0].kind).toBe("synthesis");
    expect(observed[0].body).toMatchObject({ model: family.id, max_tokens: Math.min(output, family.cap), tools: [] });
    if (family.reasoning === "adaptive") {
      expect(observed[0].body.thinking).toEqual({ type: "adaptive" });
      expect(observed[0].body.output_config).toEqual({ effort: reflection === "maximum" ? "max" : reflection === "deep" ? "high" : "medium" });
    } else if (family.reasoning === "budget" && ["deep", "maximum"].includes(reflection)) {
      expect(observed[0].body.thinking).toEqual({ type: "enabled", budget_tokens: output - 1024 });
    } else expect(observed[0].body.thinking).toBeUndefined();
    expect(first.body.operation?.result).not.toHaveProperty("receipts"); expect(first.body.operation?.result?.plan).not.toHaveProperty("providerOptions");
    host = makeHost(); // A fresh host instance must recover persisted identity, not repeat inference.
    expect((await api(input({ preferences }))).body).toEqual(first.body);
    expect((await api({ action: "status", operationId })).body).toEqual(first.body);
    expect(observed).toHaveLength(1); expect(catalogueRequests).toBe(1); await assertSingleLedger(1);
  });

  it.each(["qualified-none", "qualified-tiny-budget"])("rejects unsupported maximum reflection for %s before allocation", async model => {
    await provision(); expect((await api(input({ preferences: { model, reflection: "maximum", speed: "standard" } }))).response.status).toBe(400);
    await assertNoAllocation();
  });

  it.each([
    { reflection: "standard", speed: "standard", count: 1, proposals: 2, critiques: 0, total: 3 },
    { reflection: "deep", speed: "fast", count: 2, proposals: 3, critiques: 2, total: 6 },
    { reflection: "maximum", speed: "standard", count: 3, proposals: 4, critiques: 3, total: 8 },
  ])("runs $count reviewers at $reflection/$speed and accounts for exactly $total calls", async sample => {
    catalogueFamilies = [...families, { ...families[1], id: "qualified-peer-one" }, { ...families[2], id: "qualified-peer-two" }]; host = makeHost(); await provision();
    const reviewerModels = ["qualified-adaptive", "qualified-peer-one", "qualified-peer-two"].slice(0, sample.count);
    const { response, body } = await api(input({ preferences: { model: "qualified-budget", reflection: sample.reflection, speed: sample.speed }, reviewerModels }));
    expect(response.status).toBe(200); expect(body.operation?.result?.status).toBe("complete");
    expect(observed).toHaveLength(sample.total); expect(observed.filter(c => c.kind === "proposal")).toHaveLength(sample.proposals);
    expect(observed.filter(c => c.kind === "critique")).toHaveLength(sample.critiques); expect(observed.filter(c => c.kind === "synthesis")).toHaveLength(1);
    expect(observed.at(-1)?.body.model).toBe("qualified-budget");
    const calls = (await query("SELECT call_spec->>'kind' AS kind,call_spec->>'model' AS model,state FROM purama_ai.model_consultation_calls")).rows;
    expect(calls.every(c => c.state === "completed")).toBe(true); expect(calls.map(c => `${c.kind}:${c.model}`).sort()).toEqual(observed.map(c => `${c.kind}:${c.body.model}`).sort());
    await assertSingleLedger(sample.total);
  });

  it("rejects a reviewer in ultra-fast mode without silently dropping it or spending", async () => {
    await provision(); expect((await api(input({ preferences: { model: "qualified-budget", reflection: "maximum", speed: "ultra_fast" }, reviewerModels: ["qualified-adaptive"] }))).response.status).toBe(400);
    await assertNoAllocation();
  });
});

describe("composition boundaries and durable recovery", () => {
  it.each([false, true])("excludes @revision before public catalogue and direct-host allocation (mixed catalogue: %s)", async mixed => {
    const model = "publisher/model@revision";
    catalogueFamilies = [...(mixed ? [families[1]] : []), { ...families[1], id: model }]; host = makeHost(); await provision();
    const preferences = { model, reflection: "standard" as const, speed: "standard" as const };
    const catalog = await api({ action: "catalog" });
    expect(catalog.response.status).toBe(200);
    expect(catalog.body.catalog).toMatchObject({ available: mixed, reason: mixed ? "ready" : "model_unavailable" });
    expect(catalog.body.catalog?.models.map(candidate => candidate.model)).toEqual(mixed ? [families[1].id] : []);
    expect((await api(input({ preferences }))).response.status).toBe(400);
    // A direct host caller cannot bypass the native qualification by omitting
    // the HTTP boundary, or obtain an implicit substitute for its exact choice.
    const direct = { operationId, question: "Question de qualification du transport", preferences };
    await expect(host.consult(owner, direct, new AbortController().signal)).rejects.toMatchObject({ code: "IAO_INVALID" });
    if (mixed) await expect(host.consult(owner, { ...direct, preferences: { ...preferences, model: families[1].id }, reviewerModels: [model] }, new AbortController().signal))
      .rejects.toMatchObject({ code: "IAO_INVALID" });
    await assertNoAllocation();
    if (mixed) {
      const valid = await api(input({ preferences: { ...preferences, model: families[1].id } }));
      expect(valid.response.status).toBe(200); expect(valid.body.operation?.result?.status).toBe("complete");
      expect(observed).toHaveLength(1); expect(observed[0].body.model).toBe(families[1].id); await assertSingleLedger(1);
    }
  });

  it.each([
    { label: "one character", question: "Q" }, { label: "1000 characters", question: "Q".repeat(1000) },
    { label: "4000 characters", question: "Q".repeat(4000) }, { label: "8000 character limit", question: "Q".repeat(8000) },
    { label: "8000 CJK characters", question: "界".repeat(8000) }, { label: "4000 supplementary Unicode codepoints", question: "🛩".repeat(4000) },
  ])("preserves $label through HTTP, SDK serialization, SQL and restart", async ({ question }) => {
    await provision(); const original = await api(input({ question })); expect(original.response.status).toBe(200); expect(original.body.operation?.result?.status).toBe("complete");
    expect(observed[0].context.question).toBe(question);
    expect((await query("SELECT request->>'question' AS question FROM purama_ai.model_consultations")).rows[0].question).toBe(question);
    host = makeHost(); expect((await api(input({ question }))).body).toEqual(original.body); expect(observed).toHaveLength(1); await assertSingleLedger(1);
  });

  it("rejects one character above the request limit before catalogue, allocation or inference", async () => {
    await provision(); expect((await api(input({ question: "界".repeat(8001) }))).response.status).toBe(400);
    expect(catalogueRequests).toBe(0); await assertNoAllocation();
  });

  it("records the configured context-byte ceiling without dispatch or invented expenditure", async () => {
    await provision(); host = makeHost(32768);
    // Accepted request characters do not guarantee that the selected operator
    // context budget can hold their encoded bytes. No task-completion claim.
    const question = "界".repeat(8000); const first = await api(input({ question }));
    expect(first.response.status).toBe(200); expect(first.body.operation).toMatchObject({ status: "failed", result: { status: "failed", reason: "interrupted", answer: null } });
    expect(observed).toHaveLength(0);
    const usage = (await query("SELECT actual_input_tokens,actual_output_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0];
    expect(Object.values(usage).every(value => value !== null)).toBe(true);
    expect(Number(usage.actual_input_tokens)).toBe(0); expect(Number(usage.actual_output_tokens)).toBe(0); expect(Number(usage.actual_cost_micros)).toBe(0);
    host = makeHost(32768); expect((await api(input({ question }))).body).toEqual(first.body); expect(observed).toHaveLength(0);
    expect((await query("SELECT count(*)::int AS calls FROM purama_ai.model_consultation_calls")).rows[0].calls).toBe(0);
  });

  it.each(["absent", "expired", "inactive", "insufficient_tokens", "insufficient_cost"])("enforces %s owner resources before provider inference", async state => {
    if (state !== "absent") await provision(state === "insufficient_tokens" ? 1 : 10_000_000, state === "insufficient_cost" ? 1 : 10_000_000);
    if (state === "expired") await query("UPDATE purama_ai.chef_missions SET consultation_expires_at='2000-01-01' WHERE user_id=$1", [owner]);
    if (state === "inactive") await query("UPDATE purama_ai.chef_missions SET state='cancelled' WHERE user_id=$1", [owner]);
    const result = await api(input()); expect(result.response.status).toBe(429); await assertNoAllocation();
  });

  it("isolates a different owner even with the same operation identifier", async () => {
    await provision(); const first = await api(input()); expect(first.body.operation?.result?.status).toBe("complete");
    expect((await api({ action: "status", operationId }, stranger)).response.status).toBe(404);
    expect((await api(input(), stranger)).response.status).toBe(429); expect(observed).toHaveLength(1); await assertSingleLedger(1);
  });

  it("coalesces overlapping duplicate HTTP requests into one provider call and durable reservation", async () => {
    await provision(); let release!: () => void; providerGate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { providerEntered = resolve; });
    const first = api(input());
    try {
      await entered; const duplicate = await api(input());
      expect(duplicate.response.status).toBe(202); expect(duplicate.body.operation?.status).toBe("running");
      expect((await api(input({ question: "Conflicting private request" }))).response.status).toBe(409);
      expect(observed).toHaveLength(1);
    } finally { release(); }
    const finished = await first; expect(finished.body.operation?.result?.status).toBe("complete");
    expect((await api(input())).body).toEqual(finished.body); await assertSingleLedger(1);
    // The provider did not supply a price. This is an explicit test-operator observation, not an inferred invoice.
    await query("SELECT purama_ai.model_consultation_reconcile($1,$2,'controlled-cost-observation',10,5,0,31)", [owner, operationId]);
    await query("SELECT purama_ai.model_consultation_reconcile($1,$2,'controlled-cost-observation',10,5,0,31)", [owner, operationId]);
    expect((await api({ action: "status", operationId })).body.operation?.status).toBe("complete");
    const totals = (await query("SELECT tokens_used,cost_used_micros FROM purama_ai.chef_missions WHERE user_id=$1", [owner])).rows[0];
    expect(Number(totals.tokens_used)).toBe(15); expect(Number(totals.cost_used_micros)).toBe(31); expect(observed).toHaveLength(1);
  });

  it.each(["refusal", "invalid_json", "wrong_model"] as const)("persists a %s failure without repeating paid inference on recovery", async failure => {
    await provision(); providerFailure = failure; const first = await api(input({ preferences: { model: "qualified-adaptive", reflection: "maximum", speed: "fast" } }));
    expect(first.response.status).toBe(200); expect(first.body.operation).toMatchObject({ status: "reconciliation_required", result: { status: "failed", answer: null } });
    host = makeHost(); expect((await api(input({ preferences: { model: "qualified-adaptive", reflection: "maximum", speed: "fast" } }))).body).toEqual(first.body);
    expect(observed).toHaveLength(1); await assertSingleLedger(1);
  });

  it("does not retry a provider 429 or pretend unknown token/cost usage is zero", async () => {
    await provision(); providerStatus = 429; const first = await api(input());
    expect(first.response.status).toBe(200); expect(first.body.operation).toMatchObject({ status: "reconciliation_required", result: { status: "failed", answer: null } });
    expect((await api(input())).body).toEqual(first.body); expect(observed).toHaveLength(1);
    const usage = (await query("SELECT actual_input_tokens,actual_output_tokens,actual_cost_micros FROM purama_ai.chef_budget_reservations")).rows[0];
    expect(usage).toEqual({ actual_input_tokens: null, actual_output_tokens: null, actual_cost_micros: null });
  });

  it("keeps previous output and accounting when the next operation selects a different model", async () => {
    await provision(); const first = await api(input()); const second = await api(input({ operationId: secondId, preferences: { model: "qualified-adaptive", reflection: "maximum", speed: "ultra_fast" } }));
    expect(first.body.operation?.result?.status).toBe("complete"); expect(second.body.operation?.result?.status).toBe("complete");
    host = makeHost(); expect((await api({ action: "status", operationId })).body).toEqual(first.body); expect((await api({ action: "status", operationId: secondId })).body).toEqual(second.body);
    expect(observed.map(c => c.body.model)).toEqual(["qualified-budget", "qualified-adaptive"]);
    const counts = (await query("SELECT (SELECT count(*)::int FROM purama_ai.model_consultations) AS operations,(SELECT count(*)::int FROM purama_ai.chef_budget_reservations) AS reservations")).rows[0];
    expect(counts).toEqual({ operations: 2, reservations: 2 });
  });
});
