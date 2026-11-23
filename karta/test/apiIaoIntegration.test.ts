import { once } from "node:events";
import { request, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.js";
import type { IaoRouteRuntime } from "../src/api/iaoRoutes.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoResult } from "../src/iao/iaoFacade.js";
import { createRuntime, type RuntimeReadiness } from "../src/runtime/lifecycle.js";

const administrative = vi.hoisted(() => ({ approve: vi.fn() }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: administrative.approve }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));

const id = "11111111-1111-4111-8111-111111111111";
const body = { type: "conversation", requestId: id, conversationId: "conversation", prompt: "test" };
const ready = async (): Promise<RuntimeReadiness> => ({ ready: true, phase: "ready" });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

function identity(): IaoServerIdentity {
  const now = Date.now();
  return { tenantId: "tenant", actorId: "actor", session: { tenantId: "tenant", userId: "actor",
    sessionId: "22222222-2222-4222-8222-222222222222", appSlug: "purama-ai", issuedAt: now - 1000, expiresAt: now + 60_000 } };
}

async function listen(iaoRuntime?: IaoRouteRuntime, readiness = ready, lifetime?: AbortSignal) {
  const server = startApiServer(readiness, { iaoRuntime, consultationHost: null, lifetime });
  await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return server;
}

function port(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing loopback test port");
  return address.port;
}

function call(server: Server, path: string, method = "GET", data?: unknown) {
  return new Promise<{ status: number; cache?: string; body: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: port(server), method, path }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", (part: string) => { raw += part; });
      res.once("end", () => resolve({ status: res.statusCode!, cache: res.headers["cache-control"], body: JSON.parse(raw) }));
    });
    req.once("error", reject);
    req.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

it("keeps both IAO submission aliases closed without an injected host", async () => {
  const server = await listen();
  for (const path of ["/iao/requests", "/pura/requests"]) {
    expect(await call(server, path, "POST", body)).toMatchObject({ status: 503, cache: "no-store" });
  }
  expect(await call(server, "/live")).toMatchObject({ status: 200, body: { status: "alive" } });
});

it("authenticates IAO separately from administrative routes for submit, read and cancel", async () => {
  const authenticate = vi.fn(async () => identity());
  const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "preview" }) });
  const server = await listen({ authenticator: { authenticate }, facade });
  expect(await call(server, "/pura/requests", "POST", body)).toMatchObject({ status: 202, cache: "no-store" });
  expect(await call(server, "/iao/requests/" + id)).toMatchObject({ status: 200, cache: "no-store" });
  expect(await call(server, "/iao/requests/" + id + "/cancel", "POST")).toMatchObject({ status: 200, cache: "no-store" });
  expect(await call(server, "/kill-switch/global", "POST", { active: true })).toMatchObject({ status: 401 });
  expect(authenticate).toHaveBeenCalledTimes(3);
});

it("rechecks shutdown after an awaited readiness probe for health and IAO admission", async () => {
  const lifetime = new AbortController();
  const probe = async () => { lifetime.abort(); return ready(); };
  const authenticate = vi.fn(async () => identity());
  const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "unused" }) });
  const server = await listen({ authenticator: { authenticate }, facade }, probe, lifetime.signal);
  expect(await call(server, "/health")).toMatchObject({ status: 503, body: { ready: false, phase: "stopping" } });
  expect(await call(server, "/iao/requests", "POST", body)).toMatchObject({ status: 503, cache: "no-store" });
  expect(authenticate).not.toHaveBeenCalled();
});

it.each(["IAO", "approval"])("drains an admitted %s after its client disconnects before closing the queue", async (operation) => {
  let settle!: (result: KartaIaoResult) => void;
  let entered!: () => void;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const pending = () => { entered(); return new Promise<KartaIaoResult>(resolve => { settle = resolve; }); };
  const facade = new IaoFacade({ prepare: pending });
  administrative.approve.mockImplementation(async () => { await pending(); return { ok: true, resultSummary: "settled" }; });
  const closeQueue = vi.fn(async () => {});
  let server!: ReturnType<typeof startApiServer>;
  const runtime = createRuntime({
    probe: async () => ({ globalKillSwitch: false }),
    startWorker: () => ({ waitUntilReady: async () => {}, close: async () => {} }),
    startHttp: (readiness, lifetime) => server = startApiServer(readiness, {
      lifetime, consultationHost: null, iaoRuntime: { facade, authenticator: { authenticate: async () => identity() } },
    }),
    startSchedulers: () => [], startCustomScheduler: () => ({ stop() {} }), startRelay: () => ({ stop() {} }),
    closeQueue, disconnect() {},
  });
  await runtime.start();
  cleanup.push(async () => { settle?.({ kind: "accepted", preview: "settled" }); await runtime.stop(); });
  const client = request({ host: "127.0.0.1", port: port(server), method: "POST",
    path: operation === "IAO" ? "/iao/requests" : "/pending-actions/abc/approve",
    headers: operation === "approval" ? { authorization: "Bearer test-only-admin" } : {},
  });
  client.on("error", () => {});
  client.end(JSON.stringify(body));
  await admitted;
  const socketClosed = once(server, "close");
  client.destroy();
  const stopped = runtime.stop();
  await socketClosed;
  await new Promise(resolve => setImmediate(resolve));
  expect(closeQueue).not.toHaveBeenCalled();
  settle({ kind: "accepted", preview: "settled" });
  expect(await stopped).toBe(true);
  expect(closeQueue).toHaveBeenCalledOnce();
});

it.each(["lookup", "cancel"] as const)("preserves authenticated IAO %s after dependency readiness is lost", async operation => {
  let available = true;
  let entered!: () => void;
  let settle!: (result: KartaIaoResult) => void;
  let workSignal: AbortSignal | undefined;
  const admitted = new Promise<void>(resolve => { entered = resolve; });
  const prepare = vi.fn((_request, signal?: AbortSignal) => {
    workSignal = signal;
    entered();
    return new Promise<KartaIaoResult>(resolve => { settle = resolve; });
  });
  const facade = new IaoFacade({ prepare });
  const authenticate = vi.fn(async () => identity());
  const probe = vi.fn(async (): Promise<RuntimeReadiness> => ({ ready: available, phase: "ready" }));
  const server = await listen({ authenticator: { authenticate }, facade }, probe);
  const submitted = call(server, "/iao/requests", "POST", body);
  await admitted;
  available = false;
  probe.mockClear();
  try {
    const result = operation === "lookup"
      ? await call(server, "/iao/requests/" + id)
      : await call(server, "/iao/requests/" + id + "/cancel", "POST");
    expect(result).toMatchObject({ status: 200, cache: "no-store", body: { status: operation === "lookup" ? "draft" : "cancelled" } });
    expect(probe).not.toHaveBeenCalled();
    expect(authenticate).toHaveBeenCalledTimes(2);
    expect(prepare).toHaveBeenCalledOnce();
    expect(workSignal?.aborted).toBe(operation === "cancel");
  } finally {
    settle({ kind: "accepted", preview: "settled" });
    await submitted;
  }
  available = true;
  expect(await call(server, "/iao/requests", "POST", body)).toMatchObject({
    status: 202, body: { status: operation === "lookup" ? "partial" : "cancelled" },
  });
  expect(prepare).toHaveBeenCalledOnce();
});

it.each(["unavailable", "rejecting"] as const)("refuses new IAO work while readiness is %s and admits it after recovery", async mode => {
  let recovered = false;
  const authenticate = vi.fn(async () => identity());
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "ready" }));
  const facade = new IaoFacade({ prepare });
  const probe = async (): Promise<RuntimeReadiness> => {
    if (!recovered && mode === "rejecting") throw new Error("PRIVATE_READINESS_FAILURE");
    return { ready: recovered, phase: "ready" };
  };
  const server = await listen({ authenticator: { authenticate }, facade }, probe);
  for (const path of ["/iao/requests", "/pura/requests"]) {
    expect(await call(server, path, "POST", body)).toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
  }
  expect(authenticate).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  recovered = true;
  expect(await call(server, "/iao/requests", "POST", body)).toMatchObject({ status: 202, body: { preview: "ready" } });
  expect(authenticate).toHaveBeenCalledOnce();
  expect(prepare).toHaveBeenCalledOnce();
});

it.each(["/iao/requests", "/pura/requests"])("rechecks readiness after authentication before admitting %s", async path => {
  let available = true;
  let entered!: () => void;
  let release!: (value: IaoServerIdentity) => void;
  const authenticating = new Promise<void>(resolve => { entered = resolve; });
  const authenticate = vi.fn(() => {
    entered();
    return new Promise<IaoServerIdentity>(resolve => { release = resolve; });
  });
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "must not run" }));
  const facade = new IaoFacade({ prepare });
  const server = await listen({ authenticator: { authenticate }, facade }, async () => ({ ready: available, phase: "ready" }));
  const pending = call(server, path, "POST", body);
  await authenticating;
  available = false;
  release(identity());
  expect(await pending).toMatchObject({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
  expect(prepare).not.toHaveBeenCalled();
});

it("refuses admission when the final readiness check rejects without exposing its error", async () => {
  const probe = vi.fn<() => Promise<RuntimeReadiness>>()
    .mockResolvedValueOnce({ ready: true, phase: "ready" })
    .mockRejectedValue(new Error("PRIVATE_FINAL_READINESS_FAILURE"));
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "must not run" }));
  const facade = new IaoFacade({ prepare });
  const server = await listen({ authenticator: { authenticate: async () => identity() }, facade }, probe);
  const result = await call(server, "/iao/requests", "POST", body);
  expect(result).toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
  expect(probe).toHaveBeenCalledTimes(2);
  expect(prepare).not.toHaveBeenCalled();
});

it.each(["readiness", "lifetime"] as const)("rechecks %s after a partially received IAO body", async changed => {
  let available = true;
  let entered!: () => void;
  const authenticated = new Promise<void>(resolve => { entered = resolve; });
  const lifetime = new AbortController();
  const authenticate = async () => { entered(); return identity(); };
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "must not run" }));
  const facade = new IaoFacade({ prepare });
  const server = await listen({ authenticator: { authenticate }, facade }, async () => ({ ready: available, phase: "ready" }), lifetime.signal);
  const encoded = JSON.stringify(body);
  const split = Math.floor(encoded.length / 2);
  let client!: ReturnType<typeof request>;
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    client = request({ host: "127.0.0.1", port: port(server), method: "POST", path: "/iao/requests",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) },
    }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", (part: string) => { raw += part; });
      res.once("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
    });
    client.once("error", reject);
  });
  client.write(encoded.slice(0, split));
  await authenticated;
  await new Promise(resolve => setImmediate(resolve));
  if (changed === "readiness") available = false;
  else lifetime.abort();
  client.end(encoded.slice(split));
  expect(await response).toEqual({ status: 503, body: { error: "IAO runtime unavailable" } });
  expect(prepare).not.toHaveBeenCalled();
});

it.each(["lookup", "cancel", "submit"] as const)("rechecks shutdown after IAO %s authentication before accessing the facade", async operation => {
  const lifetime = new AbortController();
  const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "retained" }) });
  const claims = identity();
  await facade.submit({ ...body, type: "conversation", tenantId: claims.tenantId, actorId: claims.actorId, identity: claims });
  const observed = vi.spyOn(facade, operation === "lookup" ? "get" : operation);
  let entered!: () => void;
  let release!: (value: IaoServerIdentity) => void;
  const authenticating = new Promise<void>(resolve => { entered = resolve; });
  const authenticate = () => { entered(); return new Promise<IaoServerIdentity>(resolve => { release = resolve; }); };
  const server = await listen({ authenticator: { authenticate }, facade }, ready, lifetime.signal);
  const path = operation === "submit" ? "/iao/requests" : "/iao/requests/" + id + (operation === "cancel" ? "/cancel" : "");
  const pending = call(server, path, operation === "lookup" ? "GET" : "POST", operation === "submit" ? body : undefined);
  await authenticating;
  lifetime.abort();
  release(identity());
  expect(await pending).toMatchObject({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
  expect(observed).not.toHaveBeenCalled();
});

it("keeps IAO reads and cancellation isolated and authenticated during a dependency outage", async () => {
  const claims = identity();
  const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "private" }) });
  await facade.submit({ ...body, type: "conversation", tenantId: claims.tenantId, actorId: claims.actorId, identity: claims });
  let current = claims;
  const authenticate = vi.fn(async () => current);
  const server = await listen({ authenticator: { authenticate }, facade }, async () => ({ ready: false, phase: "ready" }));
  const cases = [
    { claims: { ...claims, actorId: "other", session: { ...claims.session, userId: "other" } }, status: 404 },
    { claims: { ...claims, tenantId: "other", session: { ...claims.session, tenantId: "other" } }, status: 404 },
    { claims: { ...claims, session: { ...claims.session, expiresAt: Date.now() - 1 } }, status: 401 },
  ];
  for (const testCase of cases) {
    current = testCase.claims;
    for (const operation of ["lookup", "cancel"]) {
      const path = "/iao/requests/" + id + (operation === "cancel" ? "/cancel" : "");
      const result = await call(server, path, operation === "lookup" ? "GET" : "POST");
      expect(result.status).toBe(testCase.status);
      expect(result.cache).toBe("no-store");
      expect(JSON.stringify(result.body)).not.toContain("private");
    }
  }
  expect(authenticate).toHaveBeenCalledTimes(6);
  expect(facade.get(claims.tenantId, claims.actorId, id).status).toBe("partial");
});

it("keeps every IAO operation closed when the lifecycle readiness provider is absent", async () => {
  const authenticate = vi.fn(async () => identity());
  const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "unused" }) });
  const server = startApiServer(undefined, { consultationHost: null, iaoRuntime: { facade, authenticator: { authenticate } } });
  await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  for (const [path, method, data] of [
    ["/iao/requests", "POST", body], ["/pura/requests", "POST", body],
    ["/iao/requests/" + id, "GET", undefined], ["/iao/requests/" + id + "/cancel", "POST", undefined],
  ] as const) {
    expect(await call(server, path, method, data)).toMatchObject({ status: 503, cache: "no-store" });
  }
  expect(authenticate).not.toHaveBeenCalled();
});
