import { once } from "node:events";
import { createServer, request, type Server, type IncomingHttpHeaders, type ClientRequest } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { handlePublicApiRequest, isPublicApiPath } from "../src/api/public-api-routes.js";
import type { PublicApiGrant, PublicApiRuntime } from "../src/api/public-api-runtime.js";
import type { ConsultationCatalog, ConsultationInput, ConsultationOperation } from "../src/api/consultation-contract.js";

const key = `iao_sk_11111111-1111-4111-8111-111111111111.${"a".repeat(43)}`;
const operationId = "22222222-2222-4222-8222-222222222222";
const grant: PublicApiGrant = {
  keyId: "11111111-1111-4111-8111-111111111111", projectId: "33333333-3333-4333-8333-333333333333",
  userId: "44444444-4444-4444-8444-444444444444", allowedModels: ["qualified-model"], maxOperationCostMicros: 100,
};
const input: ConsultationInput = { operationId, question: "Question privée", preferences: { model: "qualified-model" } };
const catalog: ConsultationCatalog = {
  available: true, reason: "ready", models: [{ model: "qualified-model", provider: "openai", maxOutputTokens: 1024,
    reflections: ["standard"], speeds: ["standard"], profiles: [{ reflection: "standard", speed: "standard",
      research: { maxSearches: 0, maxPages: 0, maxReviewers: 0, maxRounds: 1, concurrency: 1 } }] }],
  research: { search: false, scrape: false },
};
const operation: ConsultationOperation = { operationId, status: "running", cancelRequested: false, result: null };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function runtime() {
  return {
    authenticate: vi.fn<PublicApiRuntime["authenticate"]>(async candidate => {
      if (candidate !== key) throw Object.assign(new Error("secret credential detail"), { code: "IAO_API_UNAUTHORIZED" });
      return structuredClone(grant);
    }),
    catalog: vi.fn<PublicApiRuntime["catalog"]>(async () => structuredClone(catalog)),
    operation: vi.fn<PublicApiRuntime["operation"]>(async () => structuredClone(operation)),
  };
}
async function listen(host?: PublicApiRuntime, options: { ready?: () => Promise<boolean>; lifetime?: AbortSignal } = {}) {
  const active = new Set<Promise<void>>();
  const server = createServer((req, res) => {
    const work = handlePublicApiRequest(req, res, new URL(req.url!, "http://localhost"), host,
      options.ready ?? (async () => true), options.lifetime);
    active.add(work);
    void work.finally(() => active.delete(work));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Promise.allSettled(active);
  });
  return server;
}
interface Response { status: number; headers: IncomingHttpHeaders; body: Record<string, unknown>; text: string }
function call(server: Server, options: {
  path?: string; method?: string; body?: unknown; raw?: Buffer | string; auth?: string | null;
  headers?: Record<string, string | string[]>; partial?: boolean; chunked?: boolean;
} = {}) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback port missing");
  const path = options.path ?? "/v1/iao/consultations";
  const method = options.method ?? "POST";
  const raw = options.raw !== undefined ? options.raw : options.body !== undefined ? JSON.stringify(options.body)
    : method === "POST" && path === "/v1/iao/consultations" ? JSON.stringify(input) : "";
  let client!: ClientRequest;
  const outcome = new Promise<Response>((resolve, reject) => {
    client = request({ host: "127.0.0.1", port: address.port, path, method, agent: false,
      headers: {
        ...(options.auth === null ? {} : { Authorization: `Bearer ${options.auth ?? key}` }),
        ...(raw.length ? { "Content-Type": "application/json", ...(options.chunked
          ? { "Transfer-Encoding": "chunked" } : { "Content-Length": String(Buffer.byteLength(raw)) }) } : {}),
        ...options.headers,
      },
    }, response => {
      let text = "";
      response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.once("error", reject);
      response.once("end", () => {
        try { resolve({ status: response.statusCode!, headers: response.headers, body: JSON.parse(text), text }); }
        catch (error) { reject(error); }
      });
    });
    client.once("error", reject);
    if (options.partial) client.flushHeaders();
    else client.end(raw || undefined);
  });
  // Disconnect scenarios attach their rejection assertion after the socket closes.
  void outcome.catch(() => undefined);
  cleanup.push(() => { client.destroy(); });
  return { client, outcome, raw };
}

it("reserves only the complete public namespace", () => {
  for (const path of ["/v1/iao", "/v1/iao/", "/v1/iao/models", "/v1/iao/unknown"]) expect(isPublicApiPath(path)).toBe(true);
  for (const path of ["/v1/iaox", "/consultations/owner", "/v1/iao-other"]) expect(isPublicApiPath(path)).toBe(false);
});

it.each(["/v1/iao/models", "/v1/iao/consultations", "/v1/iao/unknown"])("keeps %s closed without a runtime", async path => {
  const server = await listen();
  expect(await call(server, { path, method: "GET" }).outcome).toMatchObject({ status: 503, body: { code: "IAO_API_UNAVAILABLE" } });
});

it("creates through the service runtime with the external id and a bounded private response", async () => {
  const h = runtime();
  h.operation.mockResolvedValue({ ...operation, providerKey: "private-provider-key", tenantId: grant.userId } as ConsultationOperation);
  const server = await listen(h);
  const response = await call(server).outcome;
  expect(response).toMatchObject({ status: 202, body: { ok: true, operation } });
  expect(response.headers["cache-control"]).toBe("no-store, private");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.text).not.toContain("private-provider-key");
  expect(response.text).not.toContain(grant.userId);
  expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(key, "create", expect.any(AbortSignal));
  expect(h.operation).toHaveBeenCalledExactlyOnceWith(key, grant, operationId, "consult", input, expect.any(AbortSignal));
});

it.each([
  ["/v1/iao/models", "GET", "catalog", "catalog"],
  [`/v1/iao/consultations/${operationId}`, "GET", "read", "status"],
  [`/v1/iao/consultations/${operationId}/cancel`, "POST", "cancel", "cancel"],
] as const)("dispatches %s using its exact permission", async (path, method, scope, action) => {
  const h = runtime();
  const ready = vi.fn(async () => false);
  const server = await listen(h, { ready });
  const result = await call(server, { path, method }).outcome;
  expect(result.status).toBe(action === "catalog" ? 200 : 202);
  expect(h.authenticate).toHaveBeenCalledExactlyOnceWith(key, scope, expect.any(AbortSignal));
  expect(ready).not.toHaveBeenCalled();
  if (action === "catalog") {
    expect(result.body).toEqual({ ok: true, catalog });
    expect(h.catalog).toHaveBeenCalledExactlyOnceWith(key, grant, expect.any(AbortSignal));
    expect(h.operation).not.toHaveBeenCalled();
  } else expect(h.operation).toHaveBeenCalledExactlyOnceWith(key, grant, operationId, action, undefined, expect.any(AbortSignal));
});

it.each([null, "admin-key", "bad key", "a".repeat(170)])("rejects missing or invalid credentials without a runtime operation", async auth => {
  const h = runtime(); const server = await listen(h);
  const result = await call(server, { auth }).outcome;
  expect(result.status).toBe(401);
  expect(result.text).not.toContain("secret credential detail");
  expect(h.operation).not.toHaveBeenCalled();
});

it("rejects duplicate Authorization headers before authentication", async () => {
  const h = runtime(); const server = await listen(h);
  const result = await call(server, { headers: { Authorization: [`Bearer ${key}`, "Bearer administrator-secret"] } }).outcome;
  expect(result.status).toBe(401);
  expect(h.authenticate).not.toHaveBeenCalled();
  expect(h.operation).not.toHaveBeenCalled();
});

it.each([
  { ...input, userId: grant.userId }, { ...input, tenantId: "injected-tenant" },
  { ...input, budget: 1_000_000 }, { ...input, action: "catalog" },
  { ...input, extra: true }, { ...input, preferences: { ...input.preferences, endpoint: "https://malicious.invalid" } },
  { ...input, operationId: "not-a-uuid" }, [], null,
])("rejects requests outside the existing ConsultationInput contract", async body => {
  const h = runtime(); const server = await listen(h);
  const result = await call(server, { raw: JSON.stringify(body) }).outcome;
  expect(result.status).toBe(400);
  expect(h.operation).not.toHaveBeenCalled();
});

it.each([
  { raw: "{", status: 400 },
  { raw: Buffer.from([0xff, 0xfe]), status: 400 },
  { raw: "x".repeat(65_537), status: 413 },
  { raw: JSON.stringify(input), headers: { "Content-Type": "text/plain" }, status: 415 },
  { raw: JSON.stringify(input), headers: { "Content-Type": ["application/json", "application/json"] }, status: 400 },
])("rejects malformed, oversized or wrongly typed bodies", async ({ status, ...options }) => {
  const h = runtime(); const server = await listen(h);
  expect((await call(server, options).outcome).status).toBe(status);
  expect(h.operation).not.toHaveBeenCalled();
});

it.each([
  ["/v1/iao/models", "GET"], [`/v1/iao/consultations/${operationId}`, "GET"],
  [`/v1/iao/consultations/${operationId}/cancel`, "POST"],
] as const)("requires an empty body for %s", async (path, method) => {
  const h = runtime(); const server = await listen(h);
  expect((await call(server, { path, method, raw: "{}" }).outcome).status).toBe(400);
  expect(h.operation).not.toHaveBeenCalled(); expect(h.catalog).not.toHaveBeenCalled();
});

it("rejects query parameters, unknown paths and wrong methods with their Allow header", async () => {
  const h = runtime(); const server = await listen(h);
  expect((await call(server, { path: "/v1/iao/models?key=secret", method: "GET" }).outcome).status).toBe(400);
  expect((await call(server, { path: "/v1/iao/unknown", method: "GET" }).outcome).status).toBe(404);
  const result = await call(server, { path: "/v1/iao/models", method: "POST" }).outcome;
  expect(result.status).toBe(405); expect(result.headers.allow).toBe("GET");
  expect(h.authenticate).not.toHaveBeenCalled();
});

it.each([false, "reject"] as const)("admits no creation when readiness is %s", async value => {
  const h = runtime();
  const server = await listen(h, { ready: async () => { if (value === "reject") throw new Error("private database failure"); return value; } });
  const result = await call(server).outcome;
  expect(result.status).toBe(503); expect(result.text).not.toContain("private database failure");
  expect(h.operation).not.toHaveBeenCalled();
});

it("checks readiness after authentication and the complete body", async () => {
  const h = runtime(); const authenticated = deferred<void>();
  h.authenticate.mockImplementation(async () => { authenticated.resolve(); return grant; });
  let available = true; const ready = vi.fn(async () => available);
  const server = await listen(h, { ready });
  const active = call(server, { partial: true });
  await authenticated.promise;
  expect(ready).not.toHaveBeenCalled(); expect(h.operation).not.toHaveBeenCalled();
  available = false; active.client.end(active.raw);
  expect((await active.outcome).status).toBe(503);
  expect(ready).toHaveBeenCalledOnce(); expect(h.operation).not.toHaveBeenCalled();
});

it.each(["before", "during_auth", "during_readiness"] as const)("prevents new effects when lifetime stops %s", async stage => {
  const h = runtime(); const lifetime = new AbortController();
  if (stage === "before") lifetime.abort();
  h.authenticate.mockImplementation(async () => { if (stage === "during_auth") lifetime.abort(); return grant; });
  const server = await listen(h, { lifetime: lifetime.signal, ready: async () => { if (stage === "during_readiness") lifetime.abort(); return true; } });
  expect((await call(server).outcome).status).toBe(503);
  expect(h.operation).not.toHaveBeenCalled();
});

it("never executes after a client disconnects during authentication", async () => {
  const h = runtime(); const entered = deferred<void>(); const release = deferred<PublicApiGrant>();
  h.authenticate.mockImplementation(async () => { entered.resolve(); return release.promise; });
  const server = await listen(h); const disconnected = deferred<void>();
  server.once("request", (_req, res) => { res.once("close", () => disconnected.resolve()); });
  const active = call(server);
  await entered.promise; active.client.destroy(); await expect(active.outcome).rejects.toBeDefined();
  await disconnected.promise;
  release.resolve(grant);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(h.operation).not.toHaveBeenCalled();
});

it("applies one ten-second admission deadline even if authentication ignores cancellation", async () => {
  const h = runtime(); const entered = deferred<void>(); const release = deferred<PublicApiGrant>();
  const clock = performance.now.bind(performance); let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock() + elapsed);
  h.authenticate.mockImplementation(async () => { entered.resolve(); return release.promise; });
  const server = await listen(h); const active = call(server);
  await entered.promise; elapsed = 10_001; release.resolve(grant);
  expect(await active.outcome).toMatchObject({ status: 504, body: { code: "IAO_API_TIMEOUT" } });
  expect(h.operation).not.toHaveBeenCalled();
});

it("propagates shutdown cancellation into an admitted operation", async () => {
  const h = runtime(); const lifetime = new AbortController(); const entered = deferred<AbortSignal>();
  h.operation.mockImplementation(async (_key, _grant, _id, _action, _input, signal) => {
    entered.resolve(signal); return new Promise(() => undefined);
  });
  const server = await listen(h, { lifetime: lifetime.signal }); const active = call(server);
  const signal = await entered.promise; expect(signal.aborted).toBe(false); lifetime.abort();
  expect((await active.outcome).status).toBe(503); expect(signal.aborted).toBe(true);
});

it.each([
  ["IAO_API_FORBIDDEN", 403], ["IAO_API_RATE_LIMIT", 429], ["IAO_API_LIMIT", 429],
  ["IAO_CONFLICT", 409], ["IAO_BUDGET", 429], ["unrecognized-secret-code", 503],
] as const)("maps %s without exposing raw runtime errors or credentials", async (code, status) => {
  const h = runtime();
  h.operation.mockRejectedValue(Object.assign(new Error(`private message ${key}`), { code, status: 200, providerKey: "provider-secret" }));
  const server = await listen(h); const result = await call(server).outcome;
  expect(result.status).toBe(status); expect(result.text).not.toContain(key);
  expect(result.text).not.toContain("private message"); expect(result.text).not.toContain("provider-secret");
  if (status === 503) expect(result.text).not.toContain(code);
});

it("returns 404 for an absent operation and rejects a mismatched operation identity", async () => {
  const h = runtime(); h.operation.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...operation, operationId: grant.userId });
  const server = await listen(h);
  expect((await call(server, { method: "GET", path: `/v1/iao/consultations/${operationId}` }).outcome).status).toBe(404);
  expect((await call(server).outcome).status).toBe(502);
});

it("rejects malformed catalog responses through the existing projection", async () => {
  const h = runtime(); h.catalog.mockResolvedValue({ ...catalog, available: true, models: [] });
  const server = await listen(h);
  expect((await call(server, { method: "GET", path: "/v1/iao/models" }).outcome).status).toBe(502);
});

it("fails closed when an authentication adapter supplies no grant", async () => {
  const h = runtime(); h.authenticate.mockResolvedValue(undefined as unknown as PublicApiGrant);
  const server = await listen(h);
  expect((await call(server).outcome).status).toBe(503);
  expect(h.operation).not.toHaveBeenCalled();
});

it("enforces the body byte ceiling for chunked requests as well", async () => {
  const h = runtime(); const server = await listen(h);
  expect((await call(server, { raw: "é".repeat(33_000), chunked: true }).outcome).status).toBe(413);
  expect(h.operation).not.toHaveBeenCalled();
});

it("refuses chunked bodies on read routes", async () => {
  const h = runtime(); const server = await listen(h);
  expect((await call(server, { path: "/v1/iao/models", method: "GET", raw: "{}", chunked: true }).outcome).status).toBe(400);
  expect(h.catalog).not.toHaveBeenCalled();
});

it.each(["running", "complete"] as const)("keeps %s answer content private from a cancel-only key", async status => {
  const h = runtime();
  h.authenticate.mockImplementation(async (_key, scope) => {
    if (scope !== "cancel") throw Object.assign(new Error("private authorization detail"), { code: "IAO_API_FORBIDDEN" });
    return grant;
  });
  const sensitive: ConsultationOperation = {
    operationId, status, cancelRequested: status === "running", result: {
      status: "complete", reason: "completed", answer: "never-expose-answer", citedSourceIds: ["private-source"],
      disagreements: ["never-expose-disagreement"], uncertainties: ["never-expose-uncertainty"], verificationStatus: "unverified",
      plan: { model: "qualified-model", reflection: "standard", speed: "standard", maxOutputTokens: 1024,
        timeoutMs: 1000, research: catalog.models[0].profiles[0].research },
      sources: [{ id: "private-source", provider: "research", retrievedAt: "2026-11-28T00:00:00Z",
        url: "https://example.invalid/never-expose-url", title: "never-expose-title", text: "never-expose-source",
        contentKind: "search_excerpt", verificationStatus: "unverified", truncated: false }],
    },
  };
  h.operation.mockResolvedValue(sensitive);
  const server = await listen(h);
  const cancelled = await call(server, { path: `/v1/iao/consultations/${operationId}/cancel`, method: "POST" }).outcome;
  expect(cancelled.status).toBe(status === "running" ? 202 : 200);
  expect(cancelled.body).toEqual({ ok: true, operation: { operationId, status, cancelRequested: sensitive.cancelRequested } });
  expect(cancelled.text).not.toContain("never-expose");
  expect(cancelled.text).not.toContain("result");
  expect((await call(server, { path: `/v1/iao/consultations/${operationId}`, method: "GET" }).outcome).status).toBe(403);
  expect(h.operation).toHaveBeenCalledOnce();
});
