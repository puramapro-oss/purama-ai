import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as contracts from "../src/routines/contracts.js";
import type { RoutineInput } from "../src/routines/contracts.js";

type Handler = (request: Request) => Promise<Response>;
interface RoutineProxyDependencies {
  env(name: string): string | undefined;
  authenticate(token: string, signal: AbortSignal): Promise<{ id: string; is_anonymous?: boolean } | null>;
  rateLimit(key: string, max: number, windowMs: number): { allowed: boolean };
  fetch(input: string, init: RequestInit): Promise<Response>;
}
const compile = (path: string) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function loadEdgeModule(path: string, dependencies: Record<string, unknown> = {}) {
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", compile(path))((name: string) => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    throw new Error("Unexpected Edge import: " + name);
  }, exports);
  return exports;
}
// Execute the real Deno sources without pulling their DOM types or .ts import
// conventions into KARTA's Node compilation. Only the external services are doubles.
const handlerExports = loadEdgeModule("../../supabase/functions/iao-routines/handler.ts", {
  "../../../karta/src/routines/contracts.ts": contracts,
  "../_shared/request-body.ts": loadEdgeModule("../../supabase/functions/_shared/request-body.ts"),
  "../_shared/request-deadline.ts": loadEdgeModule("../../supabase/functions/_shared/request-deadline.ts"),
});
if (typeof handlerExports.createIaoRoutinesHandler !== "function") throw new Error("Missing routines handler export");
const createIaoRoutinesHandler = handlerExports.createIaoRoutinesHandler as (deps: RoutineProxyDependencies) => Handler;
const indexCode = compile("../../supabase/functions/iao-routines/index.ts");

const OWNER = "84000000-0000-4000-8000-000000000001";
const OTHER = "84000000-0000-4000-8000-000000000002";
const ID = "94000000-0000-4000-8000-000000000001";
const OCCURRENCE = "94000000-0000-4000-8000-000000000003";
const COMMAND = "94000000-0000-4000-8000-000000000004";
const ORIGIN = "https://iao.example.invalid";
const AT = "2026-11-28T09:00:00.000Z";
const NEXT = "2026-11-29T09:00:00.000Z";
const config = (): RoutineInput => ({ name: "Bilan du matin", instruction: "Présente les résultats et les blocages.", enabled: true,
  schedule: { kind: "daily", time: "08:30", timezone: "Europe/Paris" }, channels: ["in_app"], deliveryMode: "parallel",
  agentTypes: [], length: "standard", quietHours: null, pausedUntil: null, onlyIfNew: true, maxCallMinutes: 2, monthlyCallMinutes: 30 });
const routine = (extra = {}) => ({ id: ID, userId: OWNER, revision: 1, config: config(), createdAt: AT, updatedAt: AT, lastOccurrenceAt: null, ...extra });
const occurrence = (extra = {}) => ({ id: OCCURRENCE, routineId: ID, scheduledAt: AT, status: "pending", report: null, deliveries: [], ...extra });
const listing = (extra = {}) => ({ ok: true, routines: [routine()], history: [], commands: [],
  capabilities: { routines: true, calls: false, verifiedPhone: null, phoneBlockedReason: "Un numéro vérifié est nécessaire.",
    voiceCommands: "confirmation_required", email: true, push: true, agents: [{ type: "email", name: "Courrier" }] }, ...extra });
const save = () => ({ action: "save", id: ID, expectedRevision: 0, config: config() });
const run = () => ({ action: "run-now", id: ID, expectedRevision: 1, requestId: OCCURRENCE });

function harness() {
  const events: string[] = [];
  const env: Record<string, string | undefined> = { CORS_ALLOWED_ORIGIN: ORIGIN,
    KARTA_INTERNAL_URL: "http://internal.example.invalid/api/", KARTA_ADMIN_TOKEN: "synthetic-internal-secret" };
  const authenticate = vi.fn<RoutineProxyDependencies["authenticate"]>(async () => { events.push("auth"); return { id: OWNER }; });
  const rateLimit = vi.fn<RoutineProxyDependencies["rateLimit"]>(() => { events.push("limit"); return { allowed: true }; });
  const fetch = vi.fn<RoutineProxyDependencies["fetch"]>(async (_url, init) => {
    events.push("relay");
    const input = JSON.parse(String(init.body));
    const result = input.action === "list" ? listing()
      : input.action === "preview" ? { ok: true, occurrences: [AT, NEXT] }
        : input.action === "save" ? { ok: true, routine: routine({ revision: input.expectedRevision + 1, config: input.config }) }
          : input.action === "pause" ? { ok: true, routine: routine({ revision: input.expectedRevision + 1,
            config: { ...config(), pausedUntil: input.pausedUntil, ...(input.enabled === undefined ? {} : { enabled: input.enabled }) } }) }
            : input.action === "pause-all" ? { ok: true, updatedCount: 1 }
              : input.action === "cancel" ? { ok: true, cancelled: true, occurrenceId: input.occurrenceId }
                : { ok: true, occurrence: occurrence() };
    return Response.json(result, { status: input.action === "run-now" ? 202 : 200 });
  });
  const handle = createIaoRoutinesHandler({ env: key => env[key], authenticate, rateLimit, fetch });
  return { handle, env, authenticate, rateLimit, fetch, events };
}
function request(body: unknown = { action: "list" }, options: { authorization?: string | null; origin?: string | null; signal?: AbortSignal } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.authorization !== null) headers.set("Authorization", options.authorization ?? "Bearer synthetic-user-session");
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);
  return new Request("https://edge.example.invalid/iao-routines", {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), signal: options.signal,
  });
}
function fakeTimers() { vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] }); }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("IAO routines authenticated proxy", () => {
  it("uses Supabase getUser with the exact bearer for both mutation checks", async () => {
    const env: Record<string, string> = { CORS_ALLOWED_ORIGIN: ORIGIN, SUPABASE_URL: "https://auth.example.invalid",
      SUPABASE_ANON_KEY: "synthetic-public-key", KARTA_INTERNAL_URL: "http://internal.example.invalid", KARTA_ADMIN_TOKEN: "synthetic-internal-secret" };
    const getUser = vi.fn(async () => ({ data: { user: { id: OWNER } }, error: null }));
    const createClient = vi.fn((_url: string, _key: string, _options: unknown) => ({ auth: { getUser } }));
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json({ ok: true, routine: routine() }));
    let handle: ((request: Request) => Promise<Response>) | undefined;
    new Function("require", "exports", "Deno", "fetch", indexCode)((name: string) => {
      if (name === "npm:@supabase/supabase-js@2.119.2") return { createClient };
      if (name === "./handler.ts") return { createIaoRoutinesHandler };
      if (name === "../_shared/rate-limit.ts") return { rateLimit: () => ({ allowed: true }) };
      throw new Error("Unexpected import: " + name);
    }, {}, { env: { get: (key: string) => env[key] }, serve: (handler: typeof handle) => { handle = handler; } }, fetch);
    expect(handle).toBeTypeOf("function");
    const result = await handle!(request(save()));
    expect(result.status).toBe(200);
    expect(getUser).toHaveBeenNthCalledWith(1, "synthetic-user-session");
    expect(getUser).toHaveBeenNthCalledWith(2, "synthetic-user-session");
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient.mock.calls[0][2]).toMatchObject({ auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: expect.any(Function) } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic-internal-secret");
  });

  it("answers an allowed preflight without accessing authentication or KARTA", async () => {
    const h = harness();
    const response = await h.handle(new Request("https://edge.example.invalid", { method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } }));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["https://attacker.example.invalid", "null", `${ORIGIN}.attacker.example.invalid`])("rejects foreign origin %s before reading identity", async origin => {
    const h = harness();
    const response = await h.handle(request(save(), { origin }));
    expect(response.status).toBe(403);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
    expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("requires bearer authentication even without an Origin header", async () => {
    const h = harness();
    expect((await h.handle(request(undefined, { authorization: null, origin: null }))).status).toBe(401);
    expect((await h.handle(request(undefined, { origin: null }))).status).toBe(200);
    expect(h.authenticate).toHaveBeenCalledTimes(1);
  });

  it.each(["*", "http://iao.example.invalid", `${ORIGIN}/`, `https://user:pass@iao.example.invalid`, `${ORIGIN},https://elsewhere.invalid`])("fails closed on an invalid allowed origin: %s", async value => {
    const h = harness(); h.env.CORS_ALLOWED_ORIGIN = value;
    expect((await h.handle(request())).status).toBe(503);
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it("reuses the configured app origin when no CORS override is provided", async () => {
    const h = harness(); delete h.env.CORS_ALLOWED_ORIGIN; h.env.APP_URL = `${ORIGIN}/dashboard`;
    expect((await h.handle(request())).headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    delete h.env.APP_URL;
    expect((await h.handle(request(undefined, { origin: "https://purama-ai.purama.dev" }))).status).toBe(200);
  });

  it("rejects unsupported methods and preflight methods before service access", async () => {
    const h = harness();
    expect((await h.handle(new Request("https://edge.example.invalid", { headers: { Origin: ORIGIN } }))).status).toBe(405);
    expect((await h.handle(new Request("https://edge.example.invalid", { method: "OPTIONS",
      headers: { Origin: ORIGIN, "Access-Control-Request-Method": "DELETE" } }))).status).toBe(405);
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it.each([null, "Basic token", "Bearer two tokens", `Bearer ${"x".repeat(8200)}`])("rejects malformed credentials %#", async authorization => {
    const h = harness();
    expect((await h.handle(request(undefined, { authorization }))).status).toBe(401);
    expect(h.authenticate).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([null, { id: "../other" }, { id: OWNER, is_anonymous: true }])("requires a verified non-anonymous UUID owner %#", async user => {
    const h = harness(); h.authenticate.mockResolvedValue(user);
    expect((await h.handle(request())).status).toBe(401);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("derives the route from authentication, normalizes the body and excludes browser credentials", async () => {
    const h = harness();
    const response = await h.handle(request({ ...save(), id: ID.toUpperCase(), config: { ...config(), name: "  Bilan du matin  " } }));
    expect(response.status).toBe(200);
    expect(h.events).toEqual(["auth", "limit", "auth", "relay"]);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe(`http://internal.example.invalid/api/routines/${OWNER}`);
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(JSON.parse(String(init.body))).toEqual(save());
    expect(JSON.stringify(init)).not.toContain("synthetic-user-session");
    expect(new Headers(init.headers).get("Origin")).toBeNull();
    expect(response.headers.get("Vary")).toContain("Authorization");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it.each([
    { action: "list", userId: OTHER }, { action: "pause-all", userId: OTHER },
    { ...save(), userId: OTHER }, { ...save(), expectedRevision: -1 }, { ...save(), id: "../other" },
    { action: "pause", id: ID, expectedRevision: 1, enabled: false },
    { action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: "false" },
    { ...run(), requestId: undefined }, { ...run(), phone: "+33111111111" },
    { action: "cancel", occurrenceId: OCCURRENCE, providerId: "injected" },
    { action: "preview", config: config(), force: true }, { action: "confirm-command", id: COMMAND },
  ])("rejects absent, extra and invalid operation fields before relay %#", async body => {
    const h = harness();
    expect((await h.handle(request(body))).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.authenticate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { channels: ["call", "call"] }, { maxCallMinutes: 11 }, { quietHours: { start: "22:00", end: "22:00" } },
    { schedule: { kind: "daily", time: "25:00", timezone: "Europe/Paris" } },
    { schedule: { kind: "once", at: "2026-02-30T09:00:00Z", timezone: "Europe/Paris" } },
    { agentTypes: ["unknown-agent"] }, { instruction: "x\u0000y" },
  ])("uses the canonical routine schema instead of a permissive copy %#", async patch => {
    const h = harness();
    expect((await h.handle(request({ ...save(), config: { ...config(), ...patch } }))).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([null, { id: OTHER }, { id: OWNER, is_anonymous: true }])("refuses a mutation when revalidation no longer confirms the original account %#", async current => {
    const h = harness(); h.authenticate.mockResolvedValueOnce({ id: OWNER }).mockResolvedValueOnce(current);
    expect((await h.handle(request(save()))).status).toBe(401);
    expect(h.authenticate).toHaveBeenCalledTimes(2);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("performs one identity check for a read and a second check for every mutation", async () => {
    const h = harness();
    for (const action of [{ action: "list" }, { action: "preview", config: config() }]) {
      h.authenticate.mockClear(); expect((await h.handle(request(action))).status).toBe(200); expect(h.authenticate).toHaveBeenCalledTimes(1);
    }
    for (const action of [save(), run(), { action: "pause-all" }, { action: "cancel", occurrenceId: OCCURRENCE },
      { action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: false }]) {
      h.authenticate.mockClear(); expect((await h.handle(request(action))).ok).toBe(true); expect(h.authenticate).toHaveBeenCalledTimes(2);
    }
  });

  it("does not let a busy execution bucket consume cancellation or listing", async () => {
    const h = harness();
    h.rateLimit.mockImplementation(key => ({ allowed: !key.includes(":run:") }));
    expect((await h.handle(request(run()))).status).toBe(429);
    expect((await h.handle(request({ action: "cancel", occurrenceId: OCCURRENCE }))).status).toBe(200);
    expect((await h.handle(request())).status).toBe(200);
    expect(h.rateLimit).toHaveBeenCalledWith(`iao-routines:run:${OWNER}`, 10, 3_600_000);
    expect(h.rateLimit).toHaveBeenCalledWith(`iao-routines:stop:${OWNER}`, 120, 60_000);
    expect(h.rateLimit).toHaveBeenCalledWith(`iao-routines:read:${OWNER}`, 120, 60_000);
  });

  it.each(["", "ftp://internal.example.invalid", "https://user:secret@internal.example.invalid", "https://internal.example.invalid?redirect=x", "https://internal.example.invalid#fragment"])("refuses unsafe relay configuration %s", async endpoint => {
    const h = harness(); h.env.KARTA_INTERNAL_URL = endpoint;
    expect((await h.handle(request(save()))).status).toBe(503);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not forward unparseable JSON, invalid UTF-8 or oversized bytes", async () => {
    const h = harness();
    expect((await h.handle(request("{broken"))).status).toBe(400);
    const utf8 = new Request("https://edge.example.invalid", { method: "POST", headers: request().headers, body: new Uint8Array([0xc0, 0xaf]) });
    expect((await h.handle(utf8)).status).toBe(400);
    expect((await h.handle(request("x".repeat(65_537)))).status).toBe(413);
    const mismatch = request(); mismatch.headers.set("Content-Length", "1");
    expect((await h.handle(mismatch)).status).toBe(400);
    const plain = request(); plain.headers.set("Content-Type", "text/plain");
    expect((await h.handle(plain)).status).toBe(400);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("cancels a request stream that does not finish, without ever relaying a mutation", async () => {
    fakeTimers(); const h = harness(); const cancel = vi.fn();
    let started!: () => void; const reading = new Promise<void>(resolve => { started = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull() { started(); return new Promise(() => {}); }, cancel });
    const input = new Request("https://edge.example.invalid", { method: "POST", headers: request().headers, body: stream, duplex: "half" } as RequestInit);
    const pending = h.handle(input); await reading;
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await pending).status).toBe(504);
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out non-cooperative authentication and rejects its late result", async () => {
    fakeTimers(); const h = harness();
    let release!: (user: { id: string }) => void;
    h.authenticate.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = h.handle(request(save()));
    await vi.advanceTimersByTimeAsync(3_001);
    expect((await pending).status).toBe(504);
    release({ id: OWNER }); await Promise.resolve();
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.authenticate.mock.calls[0][1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels before relay if the browser aborts during revalidation", async () => {
    const h = harness(); const controller = new AbortController();
    h.authenticate.mockResolvedValueOnce({ id: OWNER }).mockImplementationOnce(async () => { controller.abort(); return { id: OWNER }; });
    expect((await h.handle(request(save(), { signal: controller.signal }))).status).toBe(499);
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("IAO routines public receipts and uncertain transport", () => {
  it("projects only public account data, report text and delivery status", async () => {
    const h = harness();
    h.fetch.mockResolvedValue(Response.json(listing({ secret: "PRIVATE", routines: [{ ...routine(), admin: "PRIVATE" }],
      history: [occurrence({ report: { title: "Résultat", body: "Le travail est terminé.", evidence: "PRIVATE" },
        deliveries: [{ channel: "call", status: "accepted", providerId: "PRIVATE", details: { transcript: "PRIVATE" } }] })],
      commands: [{ id: COMMAND, occurrenceId: OCCURRENCE, instruction: "Prépare une proposition.", status: "pending_confirmation", createdAt: AT, privateTool: "PRIVATE" }] })));
    const response = await h.handle(request()); const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(body).toEqual(listing({
      history: [occurrence({ report: { title: "Résultat", body: "Le travail est terminé." },
        deliveries: [{ channel: "call", status: "accepted" }] })],
      commands: [{ id: COMMAND, occurrenceId: OCCURRENCE, instruction: "Prépare une proposition.",
        status: "pending_confirmation", createdAt: AT }],
    }));
  });

  it.each([
    { routines: [routine({ userId: OTHER })] }, { routines: [routine(), routine()] },
    { history: [occurrence({ userId: OTHER })] }, { history: [occurrence({ deliveries: [{ channel: "call", status: "heard" }] })] },
    { capabilities: { ...listing().capabilities, calls: true, verifiedPhone: null } },
    { commands: [{ id: COMMAND, occurrenceId: OCCURRENCE, instruction: "Exécute tout", status: "executed", createdAt: AT }] },
  ])("refuses foreign or unsupported public claims %#", async patch => {
    const h = harness(); h.fetch.mockResolvedValue(Response.json(listing(patch)));
    expect((await h.handle(request())).status).toBe(502);
  });

  it("accepts identical saves and pauses without inventing a revision increment", async () => {
    const h = harness(); h.fetch.mockResolvedValueOnce(Response.json({ ok: true, routine: routine() }));
    const saved = await h.handle(request({ ...save(), expectedRevision: 1 }));
    expect(saved.status).toBe(200); expect(await saved.json()).toMatchObject({ ok: true, routine: { revision: 1 } });
    h.fetch.mockResolvedValueOnce(Response.json({ ok: true, routine: routine({ config: { ...config(), enabled: false } }) }));
    const paused = await h.handle(request({ action: "pause", id: ID, expectedRevision: 1, enabled: false, pausedUntil: null }));
    expect(paused.status).toBe(200); expect(await paused.json()).toMatchObject({ ok: true, routine: { revision: 1 } });
  });

  it.each([{ id: OTHER }, { revision: 2 }, { config: { ...config(), instruction: "Une autre instruction" } }])("rejects a creation receipt inconsistent with the request %#", async patch => {
    const h = harness(); h.fetch.mockResolvedValue(Response.json({ ok: true, routine: routine(patch) }));
    expect((await h.handle(request(save()))).status).toBe(502);
  });

  it("refuses a no-op acknowledgement when the requested pause did not apply", async () => {
    const h = harness(); h.fetch.mockResolvedValue(Response.json({ ok: true, routine: routine() }));
    expect((await h.handle(request({ action: "pause", id: ID, expectedRevision: 1, pausedUntil: null, enabled: false }))).status).toBe(502);
  });

  it.each([[NEXT, AT], [AT, AT], ["2026-02-30T09:00:00Z"]].map(occurrences => [occurrences]))("refuses invalid or unordered preview dates %#", async occurrences => {
    const h = harness(); h.fetch.mockResolvedValue(Response.json({ ok: true, occurrences }));
    expect((await h.handle(request({ action: "preview", config: config() }))).status).toBe(502);
  });

  it("preserves pending execution and explains the limit of cancellation", async () => {
    const h = harness();
    const result = await h.handle(request(run()));
    expect(result.status).toBe(202);
    expect(await result.json()).toMatchObject({ ok: true, occurrence: { status: "pending" } });
    const cancelled = await h.handle(request({ action: "cancel", occurrenceId: OCCURRENCE }));
    expect(await cancelled.json()).toMatchObject({ ok: true, cancelled: true, occurrenceId: OCCURRENCE,
      warning: expect.stringContaining("Un appel déjà transmis peut continuer") });
  });

  it.each([400, 403, 404, 409, 413, 429, 503])("maps an upstream rejection without exposing its body (%s)", async status => {
    const h = harness(); h.fetch.mockResolvedValue(new Response("PRIVATE token=secret", { status }));
    const response = await h.handle(request(run()));
    expect(response.status).toBe(status); expect(await response.text()).not.toContain("PRIVATE");
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("never retries an uncertain mutation with another identity", async () => {
    const h = harness(); h.fetch.mockRejectedValue(new Error("PRIVATE provider diagnostic"));
    const response = await h.handle(request(run()));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "ROUTINE_UNCONFIRMED" });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(String(h.fetch.mock.calls[0][1].body)).requestId).toBe(OCCURRENCE);
  });

  it("rejects redirects even if a non-compliant fetch implementation returns them", async () => {
    const h = harness(); h.fetch.mockResolvedValue(Response.redirect("https://attacker.example.invalid", 307));
    expect((await h.handle(request(run()))).status).toBe(502);
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch.mock.calls[0][1].redirect).toBe("error");
  });

  it("cancels a response stream above the byte ceiling", async () => {
    const h = harness(); const cancel = vi.fn(); let chunks = 0;
    h.fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(1_048_576)); }, cancel,
    }), { headers: { "Content-Type": "application/json" } }));
    expect((await h.handle(request())).status).toBe(502);
    expect(cancel).toHaveBeenCalledOnce(); expect(chunks).toBeLessThan(8);
  });

  it("enforces a total deadline including authentication and closes a late response", async () => {
    fakeTimers(); const h = harness();
    h.authenticate.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ id: OWNER }), 2_000)));
    let started!: () => void; const relayed = new Promise<void>(resolve => { started = resolve; });
    let release!: (response: Response) => void;
    h.fetch.mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
    const pending = h.handle(request(run()));
    await vi.advanceTimersByTimeAsync(4_001); await relayed;
    await vi.advanceTimersByTimeAsync(6_000);
    expect((await pending).status).toBe(504);
    const cancel = vi.fn();
    release(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "application/json" } }));
    await Promise.resolve(); await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.fetch.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
