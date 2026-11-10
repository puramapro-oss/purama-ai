import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";

type Handler = (request: Request) => Promise<Response>;
type ModuleExports = Record<string, unknown>;
const root = new URL("../../supabase/functions/", import.meta.url);
function compile(path: string) {
  return ts.transpileModule(readFileSync(new URL(path, root), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
function evaluate(compiled: string, require: (name: string) => unknown): ModuleExports {
  const exports: ModuleExports = {};
  new Function("require", "exports", compiled)(require, exports);
  return exports;
}
// Execute the real shared validation with its actual installed Zod dependency.
// Deno's npm: spelling is the only substituted module-loading boundary.
const validation = evaluate(compile("_shared/validation.ts"), name => {
  if (name === "npm:zod@4.6.7") return { z };
  throw new Error(`Unexpected validation import: ${name}`);
});
const schema = validation.KartaTriggerSchema as z.ZodType;
const agents = validation.KARTA_BRIEF_AGENT_TYPES as readonly string[];
const endpoint = compile("karta-trigger/index.ts");
const limiterSource = compile("_shared/rate-limit.ts");
const owner = "00000000-0000-4000-8000-000000000001";
const submissionId = "abcdef01-0000-4000-8000-000000000011";
const requestId = "abcdef02-0000-4000-8000-000000000012";
const agentType = "campagnes-par-courriel";
const submit = { action: "submit-brief", agentType, submissionId, requestId, brief: "Préparer une campagne" };
const mission = {
  submissionId, agentType, state: "pending", createdAt: "2026-11-10T05:00:00.000Z",
  updatedAt: "2026-11-10T05:00:00.000Z", attemptCount: 0, run: null,
};
const accepted = { ok: true, accepted: true, mission, dispatch: { state: "queued", executionKey: "queue:v2:test" } };

function harness() {
  const events: string[] = [];
  const state = {
    env: { SUPABASE_URL: "https://db.example.invalid", SUPABASE_ANON_KEY: "test-public-key",
      KARTA_INTERNAL_URL: "http://internal.example.invalid", KARTA_ADMIN_TOKEN: "test-admin-secret" } as Record<string, string | undefined>,
    auth: { data: { user: { id: owner } }, error: null } as { data: unknown; error: unknown },
  };
  const getUser = vi.fn(async (_token: string) => { events.push("auth"); return state.auth; });
  const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({ auth: { getUser } }));
  // Use a fresh copy of the actual limiter to prove the two quota buckets.
  const limitModule = evaluate(limiterSource, () => { throw new Error("Unexpected limiter import"); });
  const realLimit = limitModule.rateLimit as (key: string, max: number, window: number) => { allowed: boolean; remaining: number };
  const rateLimit = vi.fn((key: string, max: number, window: number) => { events.push("limit"); return realLimit(key, max, window); });
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => { events.push("fetch"); return Response.json(accepted, { status: 202 }); });
  const error = vi.fn();
  let handler: Handler | undefined;
  const require = (name: string) => {
    if (name === "npm:@supabase/supabase-js@2.91.0") return { createClient };
    if (name === "../_shared/rate-limit.ts") return { rateLimit };
    if (name === "../_shared/validation.ts") return validation;
    throw new Error(`Unexpected endpoint import: ${name}`);
  };
  // Execute the whole production endpoint, replacing auth and HTTP services only.
  new Function("require", "exports", "Deno", "fetch", "console", endpoint)(require, {}, {
    serve: (fn: Handler) => { handler = fn; }, env: { get: (name: string) => state.env[name] },
  }, fetch, { error });
  if (!handler) throw new Error("The endpoint did not register its handler");
  return { handle: handler, state, getUser, createClient, rateLimit, fetch, error, events };
}
function request(body: unknown = submit, authorization: string | null = "Bearer user-token", signal?: AbortSignal) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (authorization !== null) headers.set("Authorization", authorization);
  return new Request("https://edge.example.invalid/karta-trigger", {
    method: "POST", headers, signal, body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function response(h: ReturnType<typeof harness>, body: unknown, status = 200) {
  h.fetch.mockImplementation(async () => Response.json(body, { status }));
}
afterEach(() => vi.useRealTimers());

describe("KARTA request contracts", () => {
  it.each(agents)("admits and trims briefs only for supported agent %s", agent => {
    expect(schema.parse({ ...submit, agentType: agent, brief: "  Mission utile \n" })).toMatchObject({ brief: "Mission utile" });
  });
  it("preserves legacy triggers and canonicalizes optional request identity", () => {
    expect(schema.parse({ agentType: "facture-pro" })).toEqual({ agentType: "facture-pro" });
    expect(schema.parse({ agentType, requestId: requestId.toUpperCase() })).toEqual({ agentType, requestId });
    expect(schema.parse({ ...submit, submissionId: submissionId.toUpperCase(), requestId: requestId.toUpperCase() })).toMatchObject({ submissionId, requestId });
  });
  it.each(["", " \n\t ", "x".repeat(8001), "😀".repeat(4001)])("rejects empty or excessive UTF-16 briefs (%#)", brief => {
    expect(schema.safeParse({ ...submit, brief }).success).toBe(false);
  });
  it.each(["x".repeat(8000), "界".repeat(8000), "😀".repeat(4000)])("accepts the bounded Unicode brief boundary (%#)", brief => {
    expect(schema.safeParse({ ...submit, brief }).success).toBe(true);
  });
  it.each([
    { ...submit, userId: owner }, { ...submit, executionKey: "forged" }, { ...submit, tools: [] },
    { ...submit, agentType: "facture-pro" }, { ...submit, submissionId: "not-uuid" },
    { ...submit, requestId: undefined }, { ...submit, requestId: "../../account" },
    { action: "retry-brief", agentType, submissionId, requestId, brief: "replacement" },
    { action: "brief-status", agentType, submissionId, userId: owner },
    { action: "list-briefs", agentType, requestId }, { agentType, action: "trigger" },
    { agentType, brief: "silent brief" }, { agentType, userId: owner },
  ])("rejects extra, forged or incomplete variants (%#)", body => {
    expect(schema.safeParse(body).success).toBe(false);
  });
});

describe("KARTA authenticated edge proxy", () => {
  it("handles preflight and refuses unsupported methods before authentication", async () => {
    const h = harness();
    const preflight = await h.handle(new Request("https://edge.example.invalid", { method: "OPTIONS" }));
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect((await h.handle(new Request("https://edge.example.invalid"))).status).toBe(405);
    expect(h.getUser).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([null, "", "Basic token", "Bearer ", "Bearer two tokens"])("rejects malformed authentication %j", async authorization => {
    const h = harness();
    expect((await h.handle(request(submit, authorization))).status).toBe(401);
    expect(h.createClient).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each([
    { data: { user: null }, error: null }, { data: { user: { id: owner } }, error: { message: "secret" } },
    { data: { user: { id: "../../someone-else" } }, error: null },
  ])("requires an authenticated canonical account (%#)", async auth => {
    const h = harness(); h.state.auth = auth;
    expect((await h.handle(request())).status).toBe(401);
    expect(h.getUser).toHaveBeenCalledExactlyOnceWith("user-token");
    expect(h.rateLimit).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("authenticates before validation and admits only the verified owner's route", async () => {
    const h = harness();
    expect((await h.handle(request({ ...submit, userId: "forged" }))).status).toBe(400);
    expect(h.events).toEqual(["auth"]);
    const result = await h.handle(request({ ...submit, brief: "  Mission privée  " }));
    expect(result.status).toBe(202);
    expect(h.fetch).toHaveBeenCalledOnce();
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe(`http://internal.example.invalid/trigger/${agentType}/${owner}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-admin-secret");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(requestId);
    expect(JSON.parse(init?.body as string)).toEqual({ action: "submit-brief", submissionId, brief: "Mission privée" });
    expect(JSON.stringify(init)).not.toContain("user-token");
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(h.events).toEqual(["auth", "auth", "limit", "fetch"]);
  });
  it("forwards retry identity without adding or replacing any brief", async () => {
    const h = harness();
    expect((await h.handle(request({ action: "retry-brief", agentType, submissionId, requestId }))).status).toBe(202);
    expect(JSON.parse(h.fetch.mock.calls[0][1]?.body as string)).toEqual({ action: "retry-brief", submissionId });
    expect(new Headers(h.fetch.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe(requestId);
  });
  it("keeps legacy trigger body absent, while projecting its queue receipt", async () => {
    const h = harness(); response(h, { ok: true, queued: true, jobId: "job-1", executionKey: "queue:v2:test", secret: "PRIVATE" }, 202);
    const result = await h.handle(request({ agentType: "facture-pro", requestId }));
    expect(await result.json()).toEqual({ ok: true, queued: true, jobId: "job-1", executionKey: "queue:v2:test" });
    expect(h.fetch.mock.calls[0][1]?.body).toBeUndefined();
    expect(new Headers(h.fetch.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe(requestId);
  });
  it.each(["list-briefs", "brief-status"])("uses owner-scoped GET for %s without consuming a mutation", async action => {
    const h = harness(); response(h, action === "list-briefs" ? { ok: true, missions: [mission] } : { ok: true, mission: null });
    const body = action === "list-briefs" ? { action, agentType } : { action, agentType, submissionId };
    expect((await h.handle(request(body))).status).toBe(200);
    expect(h.rateLimit).toHaveBeenCalledExactlyOnceWith(`karta-trigger-read:${owner}`, 120, 60_000);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe(`http://internal.example.invalid/briefs/${agentType}/${owner}${action === "brief-status" ? `?submissionId=${submissionId}` : ""}`);
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
  });
  it("bounds reads at 120/min independently of the ten manual mutations/hour", async () => {
    const h = harness(); response(h, { ok: true, missions: [] });
    for (let i = 0; i < 120; i++) expect((await h.handle(request({ action: "list-briefs", agentType }))).status).toBe(200);
    expect((await h.handle(request({ action: "list-briefs", agentType }))).status).toBe(429);
    response(h, accepted, 202);
    for (let i = 0; i < 10; i++) expect((await h.handle(request())).status).toBe(202);
    expect((await h.handle(request())).status).toBe(429);
    expect(h.fetch).toHaveBeenCalledTimes(130);
  });
  it.each([null, [], {}, "{broken", { ...submit, requestId: undefined }])("refuses invalid bodies without internal calls (%#)", async body => {
    const h = harness(); expect((await h.handle(request(body))).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("bounds raw bytes even without a Content-Length header or after a false small value", async () => {
    const h = harness(); const input = request("x".repeat(65_537));
    input.headers.set("Content-Length", "1");
    expect((await h.handle(input)).status).toBe(413);
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("cancels a chunked oversized request before parsing it", async () => {
    const h = harness(); const cancel = vi.fn(); let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(32_768)); }, cancel,
    });
    const input = new Request("https://edge.example.invalid", {
      method: "POST", headers: { Authorization: "Bearer user-token" }, body: stream, duplex: "half",
    } as RequestInit);
    expect((await h.handle(input)).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce(); expect(chunks).toBeLessThan(6); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["SUPABASE_URL", "SUPABASE_ANON_KEY", "KARTA_INTERNAL_URL", "KARTA_ADMIN_TOKEN"])("fails closed without %s", async key => {
    const h = harness(); delete h.state.env[key];
    expect((await h.handle(request())).status).toBe(503); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["file:///secret", "https://user:password@internal.invalid", "https://internal.invalid?token=secret"])("rejects unsafe server URL configuration (%#)", async url => {
    const h = harness(); h.state.env.KARTA_INTERNAL_URL = url;
    const result = await h.handle(request());
    expect(result.status).toBe(503); expect(await result.text()).not.toContain("secret"); expect(h.fetch).not.toHaveBeenCalled();
  });
  it("projects nested mission metadata without leaking server fields or claiming completion", async () => {
    const h = harness(); response(h, { ...accepted, secret: "PRIVATE", mission: { ...mission, brief: "PRIVATE", userId: "PRIVATE",
      run: { id: submissionId, status: "running", mode: "live", mock: false, tool_params: "PRIVATE" } },
      dispatch: { state: "unconfirmed", internalError: "PRIVATE" } }, 202);
    const result = await (await h.handle(request())).json();
    expect(result).toEqual({ ok: true, accepted: true,
      mission: { ...mission, run: { id: submissionId, status: "running", mode: "live", mock: false } }, dispatch: { state: "unconfirmed" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result).toHaveProperty("mission.state", "pending");
  });
  it.each([
    { ...accepted, ok: false }, { ...accepted, accepted: false }, { ...accepted, mission: null },
    { ...accepted, mission: { ...mission, agentType: "newsletter-genie" } },
    { ...accepted, mission: { ...mission, submissionId: requestId } },
    { ...accepted, mission: { ...mission, state: "perfect" } },
    { ...accepted, mission: { ...mission, attemptCount: 4 } },
    { ...accepted, mission: { ...mission, createdAt: "not-a-date" } },
    { ...accepted, mission: { ...mission, run: undefined } },
    { ...accepted, mission: { ...mission, run: { id: requestId, status: "success", mode: "live", mock: "false" } } },
    { ...accepted, dispatch: { state: "completed" } },
    { ...accepted, dispatch: { state: "queued", executionKey: "\nPRIVATE" } },
  ])("refuses forged or incoherent upstream mission receipts (%#)", async body => {
    const h = harness(); response(h, body, 202);
    const result = await h.handle(request()); expect(result.status).toBe(502);
    expect(await result.json()).not.toHaveProperty("accepted", true);
  });
  it.each([
    { ok: true, missions: [mission, mission] }, { ok: true, missions: Array.from({ length: 21 }, () => mission) },
    { ok: true, missions: [{ ...mission, agentType: "newsletter-genie" }] }, { ok: true, missions: null },
  ])("rejects ambiguous, excessive or cross-agent lists (%#)", async body => {
    const h = harness(); response(h, body);
    expect((await h.handle(request({ action: "list-briefs", agentType }))).status).toBe(502);
  });
  it.each([
    ["BRIEF_BUSY", 409], ["BRIEF_CONFLICT", 409], ["BRIEF_NOT_FOUND", 404], ["BRIEF_INVALID", 400], ["BRIEF_UNAVAILABLE", 503],
  ] as const)("preserves known safe code %s and never its private diagnostic", async (code, status) => {
    const h = harness(); response(h, { code, error: "PRIVATE SQL/provider/body", brief: "PRIVATE" }, status);
    const result = await h.handle(request()); expect(result.status).toBe(status);
    const data = await result.json(); expect(data).toHaveProperty("code", code); expect(JSON.stringify(data)).not.toContain("PRIVATE");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("PRIVATE");
  });
  it.each([
    [{ code: "BRIEF_BUSY", error: "PRIVATE" }, 500], [{ code: "constructor", error: "PRIVATE" }, 409],
    [{ code: "OTHER", error: "PRIVATE" }, 409],
  ] as const)("does not trust unrecognized or mismatched upstream errors (%#)", async (body, status) => {
    const h = harness(); response(h, body, status);
    const result = await h.handle(request()); expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("PRIVATE"); expect(JSON.stringify(h.error.mock.calls)).not.toContain("PRIVATE");
  });
  it.each(["PRIVATE invalid JSON", "x".repeat(65_537)])("bounds and validates upstream body without logging it (%#)", async body => {
    const h = harness(); h.fetch.mockImplementation(async () => new Response(body));
    const result = await h.handle(request()); expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("PRIVATE"); expect(JSON.stringify(h.error.mock.calls)).not.toContain("PRIVATE");
  });
  it("does no work for a cancelled request, including no authentication", async () => {
    const h = harness(); const controller = new AbortController(); controller.abort();
    expect((await h.handle(request(submit, "Bearer token", controller.signal))).status).toBe(499);
    expect(h.getUser).not.toHaveBeenCalled(); expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(["caller", "timeout"] as const)("aborts an in-flight request on %s without replay", async mode => {
    if (mode === "timeout") vi.useFakeTimers();
    const h = harness(); const controller = new AbortController();
    let started!: () => void; const requestStarted = new Promise<void>(resolve => { started = resolve; });
    h.fetch.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      started(); init?.signal?.addEventListener("abort", () => reject(new Error("PRIVATE transport")), { once: true });
    }));
    const pending = h.handle(request(submit, "Bearer token", controller.signal));
    await requestStarted;
    if (mode === "caller") controller.abort(); else await vi.advanceTimersByTimeAsync(10_001);
    const result = await pending; expect(result.status).toBe(mode === "caller" ? 499 : 504);
    expect(h.fetch).toHaveBeenCalledOnce(); expect(h.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(await result.text()).not.toContain("PRIVATE");
    if (mode === "timeout") expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps the deadline active while reading a stalled upstream body", async () => {
    vi.useFakeTimers(); const h = harness(); const cancel = vi.fn();
    let started!: () => void; const bodyStarted = new Promise<void>(resolve => { started = resolve; });
    h.fetch.mockImplementation(async () => new Response(new ReadableStream({ pull() { started(); }, cancel })));
    const pending = h.handle(request()); await bodyStarted; await vi.advanceTimersByTimeAsync(10_001);
    expect((await pending).status).toBe(504); expect(cancel).toHaveBeenCalledOnce(); expect(h.fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
