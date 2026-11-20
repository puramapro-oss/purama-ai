import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import ts from "typescript";
import type { ConsultationHost, ConsultationOperation, ConsultationCatalog } from "../src/api/consultation-contract.js";
import { runModelConsultation, type ConsultationDependencies, type ConsultationResult } from "../src/claude/consultation.js";
import { resolveModelExecutionPlan } from "../src/claude/execution-profile.js";
import { normalizeModelUsage } from "../src/claude/usage.js";
import type { ClaudeDecideInput } from "../src/claude/types.js";
import type { AgentDecision } from "../src/engine/types.js";

vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));
import { startApiServer } from "../src/api/server.js";

type OperationResponse = { ok: true; operation: ConsultationOperation };

const owner = "00000000-0000-4000-8000-000000000001";
const stranger = "00000000-0000-4000-8000-000000000002";
const operationId = "10000000-0000-4000-8000-000000000001";
const selectedModel = "qualified-primary";
const selected = { model: selectedModel, reflection: "standard" as const, speed: "standard" as const };
const capability = { model: selectedModel, reasoning: "none" as const, maxOutputTokens: 1024 };
const plan = resolveModelExecutionPlan(selected, [capability]);
const modelCatalog: ConsultationCatalog = { available: true, reason: "ready", models: [{ model: selectedModel, provider: "anthropic", reflections: ["standard"], speeds: ["standard"],
  maxOutputTokens: 1024, profiles: [{ reflection: "standard", speed: "standard", research: plan.research }] }], research: { search: true, scrape: true } };
const input = (patch: Record<string, unknown> = {}) => ({ action: "consult", operationId, question: "Question privée", preferences: selected, ...patch });
function publicResult(result: ConsultationResult): NonNullable<ConsultationOperation["result"]> {
  return { ...result, sources: result.sources.map(source => ({ ...source, truncated: false })) };
}
function harness() {
  const operations = new Map<string, { hash: string; operation: ConsultationOperation; controller: AbortController }>();
  const state = { decide: undefined as ((input: ClaudeDecideInput) => Promise<AgentDecision>) | undefined, ready: true };
  const reserve = vi.fn(async () => true); const settle = vi.fn(async () => {});
  const decide = vi.fn(async (input: ClaudeDecideInput): Promise<AgentDecision> => {
    input.onUsage?.(normalizeModelUsage({ id: `response-${decide.mock.calls.length}`, model: selectedModel,
      usage: { input_tokens: 10, output_tokens: 5 } }, selectedModel, "https://api.anthropic.com"));
    if (state.decide) return state.decide(input);
    return { summary: input.systemPrompt.includes("Retourne uniquement")
      ? JSON.stringify({ answer: "Réponse privée", citedSourceIds: (input.context.sources as Array<{ id: string }>).map(source => source.id), disagreements: [], uncertainties: ["Sources non vérifiées"] })
      : "Avis privé", toolCalls: [], requiresApproval: false, mock: false };
  });
  const search = vi.fn(async (_query: string) => ({ provider: "perplexity" as const, retrievalId: "r1", retrievedAt: "2026-11-13T00:00:00Z", providerRequestId: null,
    verificationStatus: "unverified" as const, sourceTextTrust: "untrusted_data" as const, independentlyVerified: false as const, costMicros: null,
    sources: [{ sourceId: "provider-1", url: "https://example.com/article", title: "Source privée", text: "Extrait non vérifié", contentKind: "search_excerpt" as const }] }));
  const host: ConsultationHost = {
    catalog: vi.fn(async () => structuredClone(modelCatalog)),
    consult: vi.fn(async (userId, data, signal) => {
      const key = `${userId}:${data.operationId}`; const hash = JSON.stringify(data); const previous = operations.get(key);
      if (previous) {
        if (previous.hash !== hash) throw Object.assign(new Error("private ledger detail"), { code: "IAO_CONFLICT" });
        return structuredClone(previous.operation);
      }
      const controller = new AbortController(); const cancel = () => controller.abort(); signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      const operation: ConsultationOperation = { operationId: data.operationId, status: "running", cancelRequested: false, result: null };
      operations.set(key, { hash, operation, controller });
      const dependencies: ConsultationDependencies = { catalog: [capability], models: [{ model: selectedModel, provider: "anthropic", client: { isMock: false, decide } }],
        research: { search, scrape: vi.fn() }, admission: { claim: async () => true, reserve, settle } };
      try {
        const result = await runModelConsultation({ ...data, userId }, dependencies, controller.signal);
        operation.status = operation.cancelRequested ? "cancelled" : result.reason === "interrupted" ? "reconciliation_required" : result.status;
        operation.result = publicResult(result); return structuredClone(operation);
      } finally { signal.removeEventListener("abort", cancel); }
    }),
    status: vi.fn(async (userId, id) => structuredClone(operations.get(`${userId}:${id}`)?.operation ?? null)),
    cancel: vi.fn(async (userId, id) => {
      const existing = operations.get(`${userId}:${id}`); if (!existing) return null;
      existing.operation.cancelRequested = true; existing.controller.abort(); return structuredClone(existing.operation);
    }),
  };
  return { host, state, decide, search, reserve, settle, operations };
}
let h: ReturnType<typeof harness>;
let server: ReturnType<typeof startApiServer>;
let port: number;
beforeAll(async () => {
  h = harness();
  server = startApiServer(async () => ({ ready: h.state.ready, phase: "ready" }), { consultationHost: {
    catalog: (...args) => h.host.catalog(...args), consult: (...args) => h.host.consult(...args), status: (...args) => h.host.status(...args), cancel: (...args) => h.host.cancel(...args),
  } });
  await new Promise<void>(resolve => server.once("listening", resolve)); port = (server.address() as { port: number }).port;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => { h = harness(); });
afterEach(() => vi.useRealTimers());

/** Real loopback sockets; only external auth/model/provider boundaries are replaced. */
function httpFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(input); if (target.hostname !== "127.0.0.1" || Number(target.port) !== port) return reject(new Error("Unexpected non-local transport"));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const req = request(target, { method: init.method, headers, signal: init.signal ?? undefined }, res => {
      const outputHeaders = new Headers(); for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) outputHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      resolve(new Response(Readable.toWeb(res) as never, { status: res.statusCode!, headers: outputHeaders }));
    });
    req.on("error", reject); req.end(init.body as string | undefined);
  });
}
async function api(body: unknown, authorization = "Bearer test-only-admin", userId = owner) {
  return httpFetch(`http://127.0.0.1:${port}/consultations/${userId}`, { method: "POST", headers: { Authorization: authorization, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const deadlineModule = await import(new URL("../../supabase/functions/_shared/request-deadline.ts", import.meta.url).href);
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const handlerCode = compile("../../supabase/functions/iao-consultation/handler.ts");
const indexCode = compile("../../supabase/functions/iao-consultation/index.ts");
function edge() {
  const state = { auth: { data: { user: { id: owner, is_anonymous: false } }, error: null } as { data: { user: { id: string; is_anonymous?: boolean } | null }; error: unknown }, allowed: true,
    env: { SUPABASE_URL: "https://auth.example.invalid", SUPABASE_ANON_KEY: "public-key", KARTA_INTERNAL_URL: `http://127.0.0.1:${port}`, KARTA_ADMIN_TOKEN: "test-only-admin" } as Record<string, string | undefined> };
  const getUser = vi.fn(async (_token: string) => state.auth);
  const createClient = vi.fn(() => ({ auth: { getUser } }));
  const rateLimit = vi.fn((_key: string, _max: number, _window: number) => ({ allowed: state.allowed }));
  const fetch = vi.fn(httpFetch);
  const handlerExports: Record<string, unknown> = {};
  new Function("require", "exports", handlerCode)((name: string) => {
    if (name === "../_shared/request-deadline.ts") return deadlineModule; throw new Error(`Unexpected import ${name}`);
  }, handlerExports);
  let handle: ((request: Request) => Promise<Response>) | undefined;
  new Function("require", "exports", "Deno", "fetch", indexCode)((name: string) => {
    if (name === "npm:@supabase/supabase-js@2.91.0") return { createClient };
    if (name === "../_shared/rate-limit.ts") return { rateLimit };
    if (name === "./handler.ts") return handlerExports; throw new Error(`Unexpected import ${name}`);
  }, {}, { env: { get: (name: string) => state.env[name] }, serve: (value: typeof handle) => { handle = value; } }, fetch);
  if (!handle) throw new Error("Missing endpoint");
  return { handle, state, getUser, createClient, rateLimit, fetch };
}
function browser(body: unknown, authorization: string | null = "Bearer real-user-jwt", signal?: AbortSignal) {
  const headers = new Headers({ "Content-Type": "application/json" }); if (authorization !== null) headers.set("Authorization", authorization);
  return new Request("https://edge.example.invalid/iao-consultation", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), signal });
}

describe("private consultation HTTP and Edge route", () => {
  it("authenticates the user JWT then traverses the real HTTP server and runtime", async () => {
    const e = edge();
    const response = await e.handle(browser(input({ research: { queries: ["explicit public query"], urls: [] } })));
    expect(response.status).toBe(200); const body = await response.json() as OperationResponse;
    expect(body.operation).toMatchObject({ operationId, status: "complete", result: { answer: "Réponse privée", verificationStatus: "unverified", citedSourceIds: ["S1"] } });
    expect(e.getUser).toHaveBeenCalledExactlyOnceWith("real-user-jwt");
    expect(e.fetch).toHaveBeenCalledOnce();
    expect(e.fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:${port}/consultations/${owner}`);
    const init = e.fetch.mock.calls[0][1]; expect(init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-only-admin");
    expect(JSON.stringify(init)).not.toContain("real-user-jwt");
    expect(h.decide).toHaveBeenCalledOnce(); expect(h.reserve).toHaveBeenCalledTimes(2); expect(h.settle).toHaveBeenCalledTimes(2);
    expect(h.search.mock.calls[0]?.[0]).toBe("explicit public query");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body.operation.result).not.toHaveProperty("receipts"); expect(body.operation.result?.plan).not.toHaveProperty("providerOptions");
  });

  it("returns a catalog without launching a model or research call", async () => {
    const e = edge(); const response = await e.handle(browser({ action: "catalog" }));
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true, catalog: modelCatalog });
    expect(h.decide).not.toHaveBeenCalled(); expect(h.search).not.toHaveBeenCalled();
  });

  it.each([null, "Basic bad", "Bearer ", "Bearer a b"])("refuses malformed browser authentication %s", async authorization => {
    const e = edge(); expect((await e.handle(browser({ action: "catalog" }, authorization))).status).toBe(401);
    expect(e.getUser).not.toHaveBeenCalled(); expect(e.fetch).not.toHaveBeenCalled();
  });

  it.each([null, { id: owner, is_anonymous: true }, { id: "bad", is_anonymous: false }])("refuses missing, anonymous or invalid accounts (%#)", async user => {
    const e = edge(); e.state.auth.data.user = user;
    expect((await e.handle(browser({ action: "catalog" }))).status).toBe(401); expect(e.fetch).not.toHaveBeenCalled();
  });

  it("rejects a wrong administrative token before inspecting the consultation", async () => {
    expect((await api(input(), "Bearer browser-jwt")).status).toBe(401); expect(h.host.consult).not.toHaveBeenCalled();
  });

  it.each(["userId", "budget", "apiKey", "provider", "endpoint"])("rejects client authority field %s at both boundaries", async field => {
    const e = edge(); const body = input({ [field]: "forged" });
    expect((await e.handle(browser(body))).status).toBe(400); expect(e.fetch).not.toHaveBeenCalled();
    expect((await api(body)).status).toBe(400); expect(h.host.consult).not.toHaveBeenCalled();
  });

  it.each([input({ operationId: "bad" }), input({ preferences: { ...selected, temperature: 1 } }), input({ preferences: { ...selected, reflection: "invented" } }),
    input({ reviewerModels: [selectedModel] }), input({ research: { queries: [], urls: ["https://user:pass@example.com"] } }),
    input({ research: { queries: [], urls: ["http://example.com"] } }), input({ question: "x".repeat(8001) }), { action: "catalog", userId: owner }])("rejects malformed consultation data (%#)", async body => {
    const e = edge(); expect((await e.handle(browser(body))).status).toBe(400); expect((await api(body)).status).toBe(400);
    expect(h.decide).not.toHaveBeenCalled(); expect(e.fetch).not.toHaveBeenCalled();
  });

  it("reuses a completed idempotency key, exposes status privately, and refuses a conflicting request", async () => {
    const e = edge(); const first = await (await e.handle(browser(input()))).json();
    const duplicate = await (await e.handle(browser(input()))).json(); expect(duplicate).toEqual(first); expect(h.decide).toHaveBeenCalledOnce();
    expect(await (await e.handle(browser({ action: "status", operationId }))).json()).toEqual(first);
    const conflict = await e.handle(browser(input({ question: "Different question" }))); expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("private ledger detail"); expect(h.decide).toHaveBeenCalledOnce();
    e.state.auth.data.user = { id: stranger, is_anonymous: false };
    expect((await e.handle(browser({ action: "status", operationId }))).status).toBe(404);
    expect((await e.handle(browser({ action: "cancel", operationId }))).status).toBe(404);
    expect(h.decide).toHaveBeenCalledOnce();
  });

  it("keeps catalog, status and cancellation available during a queue outage but admits no new work", async () => {
    await api(input()); h.state.ready = false;
    expect((await api({ action: "catalog" })).status).toBe(200);
    expect((await api({ action: "status", operationId })).status).toBe(200);
    expect((await api({ action: "cancel", operationId })).status).toBe(200);
    expect((await api(input({ operationId: stranger }))).status).toBe(503);
    expect(h.decide).toHaveBeenCalledOnce();
  });

  it("cancels a running operation explicitly without launching a later synthesis", async () => {
    const e = edge(); let release!: (value: AgentDecision) => void;
    h.state.decide = () => new Promise(resolve => { release = resolve; });
    const running = e.handle(browser(input()));
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalledOnce());
    const status = await e.handle(browser({ action: "status", operationId })); expect(status.status).toBe(202);
    const cancellation = await e.handle(browser({ action: "cancel", operationId }));
    expect((await cancellation.json() as OperationResponse).operation.cancelRequested).toBe(true);
    const final = await running; expect((await final.json() as OperationResponse).operation.status).toBe("cancelled");
    release({ summary: "late private output", toolCalls: [], mock: false, requiresApproval: false });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(h.decide).toHaveBeenCalledOnce();
    expect((await (await e.handle(browser({ action: "status", operationId }))).text())).not.toContain("late private output");
  });

  it("propagates disconnect through Edge and HTTP without treating the completed request body as cancellation", async () => {
    const e = edge(); const controller = new AbortController(); let release!: (value: AgentDecision) => void;
    h.state.decide = () => new Promise(resolve => { release = resolve; });
    const pending = e.handle(browser(input(), "Bearer user-jwt", controller.signal));
    await vi.waitFor(() => expect(h.decide).toHaveBeenCalledOnce()); controller.abort();
    expect((await pending).status).toBe(499);
    await vi.waitFor(() => expect(h.operations.get(`${owner}:${operationId}`)?.operation.status).toBe("reconciliation_required"));
    release({ summary: "late", toolCalls: [], mock: false, requiresApproval: false });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(h.decide).toHaveBeenCalledOnce();
  });

  it("bounds auth waiting even when the auth transport ignores cancellation", async () => {
    vi.useFakeTimers(); const e = edge(); e.getUser.mockImplementation(() => new Promise(() => {}));
    const pending = e.handle(browser({ action: "catalog" })); await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).status).toBe(504); expect(e.fetch).not.toHaveBeenCalled();
  });

  it("bounds upstream waiting and disposes a late body without replaying the request", async () => {
    vi.useFakeTimers(); const e = edge(); let release!: (value: Response) => void;
    e.fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = e.handle(browser({ action: "catalog" })); await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).status).toBe(504); expect(e.fetch).toHaveBeenCalledOnce();
    const cancelled = vi.fn(); release(new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(1); expect(cancelled).toHaveBeenCalledOnce();
    expect(h.decide).not.toHaveBeenCalled();
  });

  it("does not report a complete operation without its validated result", async () => {
    const e = edge(); vi.mocked(h.host.consult).mockResolvedValue({ operationId, status: "complete", cancelRequested: false, result: null });
    const response = await e.handle(browser(input())); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('"complete"');
  });

  it.each([true, false])("cancels oversized provider response bodies (declared=%s)", async declared => {
    const e = edge(); const cancelled = vi.fn();
    e.fetch.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(524_289)); }, cancel: cancelled,
    }), { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": "524289" } : {}) } }));
    expect((await e.handle(browser({ action: "catalog" }))).status).toBe(503);
    expect(cancelled).toHaveBeenCalledOnce(); expect(e.fetch).toHaveBeenCalledOnce();
  });

  it("rejects a non-JSON upstream body and releases it", async () => {
    const e = edge(); const cancelled = vi.fn();
    e.fetch.mockImplementation(async () => new Response(new ReadableStream({ cancel: cancelled }), { headers: { "Content-Type": "text/html" } }));
    expect((await e.handle(browser({ action: "catalog" }))).status).toBe(503); expect(cancelled).toHaveBeenCalledOnce();
  });

  it("preserves Unicode through the actual HTTP runtime and bounded proxy response", async () => {
    const e = edge(); const answer = "漢🌍".repeat(6000);
    h.state.decide = async () => ({ summary: JSON.stringify({ answer, citedSourceIds: [], disagreements: [], uncertainties: [] }), toolCalls: [], requiresApproval: false, mock: false });
    const response = await e.handle(browser(input())); expect(response.status).toBe(200);
    const wire = await response.text(); expect(Buffer.byteLength(wire, "utf8")).toBeGreaterThan(wire.length);
    expect((JSON.parse(wire) as OperationResponse).operation.result?.answer).toBe(answer);
  });

  it.each([70_000, 140_000])("bounds UTF-8 response bytes, not JavaScript string length (%s Unicode pairs)", async count => {
    const e = edge(); const wire = JSON.stringify({ ok: true, catalog: modelCatalog, privateExtra: "🌍".repeat(count) });
    expect(wire.length).toBeLessThan(524_288);
    expect(Buffer.byteLength(wire, "utf8") > 524_288).toBe(count === 140_000);
    e.fetch.mockImplementation(async () => new Response(wire, { headers: { "Content-Type": "application/json" } }));
    const response = await e.handle(browser({ action: "catalog" })); expect(response.status).toBe(count === 140_000 ? 503 : 200);
    expect(await response.text()).not.toContain("privateExtra"); expect(e.fetch).toHaveBeenCalledOnce();
  });

  it("refuses a projected API result whose Unicode envelope exceeds the private response bound", async () => {
    const e = edge(); const oversized: ConsultationOperation = { operationId, status: "complete", cancelRequested: false, result: {
      status: "complete", reason: "completed", plan, answer: "漢".repeat(32000), citedSourceIds: [], sources: [], verificationStatus: "unverified",
      disagreements: Array.from({ length: 32 }, () => "漢".repeat(2000)), uncertainties: Array.from({ length: 32 }, () => "漢".repeat(2000)),
    } };
    // JSON strings containing escaped controls expand further than their JS length.
    oversized.result!.uncertainties = Array.from({ length: 32 }, () => "\u0001".repeat(2000));
    expect(JSON.stringify(oversized).length).toBeLessThan(524_288);
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(524_288);
    vi.mocked(h.host.status).mockResolvedValue(oversized);
    const response = await e.handle(browser({ action: "status", operationId })); expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("漢"); expect(h.decide).not.toHaveBeenCalled();
  });

  it("refuses auth errors even when a stale user object is returned", async () => {
    const e = edge(); e.state.auth.error = new Error("private auth detail");
    expect((await e.handle(browser({ action: "catalog" }))).status).toBe(401); expect(e.fetch).not.toHaveBeenCalled();
  });

  it("uses separate read and cancel throttles derived from the verified account", async () => {
    const e = edge(); await e.handle(browser({ action: "catalog" })); await e.handle(browser({ action: "cancel", operationId }));
    expect(e.rateLimit.mock.calls.map(call => call[0])).toEqual([`iao-consultation:read:${owner}`, `iao-consultation:cancel:${owner}`]);
    e.state.allowed = false; expect((await e.handle(browser(input()))).status).toBe(429); expect(h.decide).not.toHaveBeenCalled();
  });

  it("overrides the short server socket timeout only for the bounded consultation", async () => {
    const e = edge(); let release!: (value: AgentDecision) => void; let socket: import("node:net").Socket | undefined;
    server.once("request", req => { socket = req.socket; }); h.state.decide = () => new Promise(resolve => { release = resolve; });
    const pending = e.handle(browser(input())); await vi.waitFor(() => expect(h.decide).toHaveBeenCalledOnce());
    expect(socket?.timeout).toBe(140_000);
    release({ summary: JSON.stringify({ answer: "Terminé", citedSourceIds: [], disagreements: [], uncertainties: [] }), toolCalls: [], requiresApproval: false, mock: false });
    expect((await pending).status).toBe(200);
  });

  it("does not forward a request cancelled before auth", async () => {
    const e = edge(); const controller = new AbortController(); controller.abort();
    expect((await e.handle(browser(input(), "Bearer jwt", controller.signal))).status).toBe(499); expect(e.getUser).not.toHaveBeenCalled();
  });

  it("rejects oversized input before forwarding", async () => {
    const e = edge(); const body = JSON.stringify(input({ question: "x".repeat(70000) }));
    expect((await e.handle(browser(body))).status).toBe(413); expect(e.fetch).not.toHaveBeenCalled();
    const response = await httpFetch(`http://127.0.0.1:${port}/consultations/${owner}`, { method: "POST", headers: {
      Authorization: "Bearer test-only-admin", "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(body)),
    }, body }); expect(response.status).toBe(413); expect(h.host.consult).not.toHaveBeenCalled();
  });

  it("bounds an oversized chunked API body without relying on Content-Length", async () => {
    const response = await httpFetch(`http://127.0.0.1:${port}/consultations/${owner}`, { method: "POST", headers: {
      Authorization: "Bearer test-only-admin", "Content-Type": "application/json", "Transfer-Encoding": "chunked",
    }, body: JSON.stringify(input({ question: "x".repeat(70000) })) });
    expect(response.status).toBe(413); expect(h.host.consult).not.toHaveBeenCalled();
  });

  it("handles a disconnect during the body without a late unhandled stream error", async () => {
    await new Promise<void>(resolve => {
      const outgoing = request({ hostname: "127.0.0.1", port, path: `/consultations/${owner}`, method: "POST", headers: {
        Authorization: "Bearer test-only-admin", "Content-Type": "application/json", "Transfer-Encoding": "chunked",
      } });
      outgoing.on("error", () => {}); outgoing.once("close", resolve);
      server.once("request", incoming => incoming.once("data", () => outgoing.destroy()));
      outgoing.write('{"action":"consult",');
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.host.consult).not.toHaveBeenCalled(); expect((await api({ action: "catalog" })).status).toBe(200);
  });

  it("projects fields instead of exposing host extras or receipts", async () => {
    const e = edge(); vi.mocked(h.host.catalog).mockResolvedValue({ ...modelCatalog, internalPrompt: "PRIVATE_SECRET" } as ConsultationCatalog);
    expect(await (await e.handle(browser({ action: "catalog" }))).text()).not.toContain("PRIVATE_SECRET");
    const result = await (await e.handle(browser(input()))).text(); expect(result).not.toContain("receipts"); expect(result).not.toContain("inputHash");
  });

  it.each(["SUPABASE_URL", "SUPABASE_ANON_KEY", "KARTA_INTERNAL_URL", "KARTA_ADMIN_TOKEN"])("fails closed when %s is absent", async key => {
    const e = edge(); delete e.state.env[key]; expect((await e.handle(browser({ action: "catalog" }))).status).toBe(503); expect(e.fetch).not.toHaveBeenCalled();
  });

  it("sanitizes upstream provider and database errors", async () => {
    const e = edge(); vi.mocked(h.host.consult).mockRejectedValue(new Error("SECRET provider credential database row"));
    const response = await e.handle(browser(input())); expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/SECRET|credential|database row/);
  });

  it.each(["{truncated", JSON.stringify({ ok: true, catalog: { ...modelCatalog, models: [{ ...modelCatalog.models[0], profiles: [] }] } }), JSON.stringify({ ok: true, operation: { operationId: stranger, status: "complete", cancelRequested: false, result: null } })])("rejects malformed upstream JSON or private response identity (%#)", async value => {
    const e = edge(); e.fetch.mockImplementation(async () => new Response(value, { headers: { "Content-Type": "application/json" } }));
    expect((await e.handle(browser({ action: "status", operationId }))).status).toBe(503); expect(h.decide).not.toHaveBeenCalled();
  });
});
