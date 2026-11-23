import { once } from "node:events";
import { Agent, request, type ClientRequest, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoPort, type KartaIaoResult } from "../src/iao/iaoFacade.js";
import { KartaRuntimeIaoPort, type IaoCompletionPort, type SmaranaIaoPort } from "../src/iao/kartaRuntimePort.js";
import type { RuntimeReadiness } from "../src/runtime/lifecycle.js";

vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));

const requestId = "11111111-1111-4111-8111-111111111111";
const operationId = "33333333-3333-4333-8333-333333333333";
const body = { type: "conversation", requestId, conversationId: "conversation", prompt: "test" };
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function identity(): IaoServerIdentity {
  const now = Date.now();
  return { tenantId: "tenant", actorId: "actor", session: {
    tenantId: "tenant", userId: "actor", sessionId: "22222222-2222-4222-8222-222222222222",
    appSlug: "purama-ai", issuedAt: now - 1_000, expiresAt: now + 60_000,
  } };
}
async function listen(facade: IaoFacade, options: {
  authenticate?: (req: IncomingMessage) => Promise<IaoServerIdentity>;
  readiness?: () => Promise<RuntimeReadiness>;
  lifetime?: AbortSignal;
  socketTimeoutMs?: number;
} = {}) {
  const server = startApiServer(options.readiness ?? (async () => ({ ready: true, phase: "ready" })), {
    consultationHost: null, lifetime: options.lifetime,
    iaoRuntime: { facade, authenticator: { authenticate: options.authenticate ?? (async () => identity()) } },
  });
  await once(server, "listening");
  if (options.socketTimeoutMs !== undefined) server.setTimeout(options.socketTimeoutMs);
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await server.drainRequests();
  });
  return server;
}
function call(server: ReturnType<typeof startApiServer>, options: {
  path?: string; method?: string; data?: unknown; agent?: Agent; partial?: boolean;
} = {}) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback test port");
  const raw = JSON.stringify(options.data ?? body);
  let client!: ClientRequest;
  const outcome = new Promise<
    { kind: "response"; status: number; body: Record<string, unknown> } |
    { kind: "error"; code?: string }
  >((resolve, reject) => {
    client = request({ host: "127.0.0.1", port: address.port, path: options.path ?? "/iao/requests",
      method: options.method ?? "POST", agent: options.agent ?? false,
      headers: (options.method ?? "POST") === "POST" ? { "Content-Length": Buffer.byteLength(raw) } : {},
    }, response => {
      let received = "";
      response.setEncoding("utf8").on("data", chunk => { received += chunk; });
      response.once("end", () => {
        try { resolve({ kind: "response", status: response.statusCode!, body: JSON.parse(received) }); }
        catch (error) { reject(error); }
      });
      response.once("error", reject);
    });
    client.once("error", (error: NodeJS.ErrnoException) => resolve({ kind: "error", code: error.code }));
    if (options.partial) client.flushHeaders();
    else client.end((options.method ?? "POST") === "POST" ? raw : undefined);
  });
  cleanup.push(() => { client.destroy(); });
  return { client, outcome, raw };
}

it("extends only after authentication, complete body and final readiness, without changing ingress limits", async () => {
  const authEntered = deferred<void>(), authRelease = deferred<void>();
  const finalProbe = deferred<void>(), probeRelease = deferred<void>();
  const completionEntered = deferred<void>(), completionRelease = deferred<{ text: string; modelVersion: string }>();
  let probes = 0;
  let socket!: Socket;
  const port = new KartaRuntimeIaoPort({
    buildContext: async () => ({ operationId, context: { sources: [] } }), control: vi.fn(),
  }, { complete: async () => { completionEntered.resolve(); return completionRelease.promise; } });
  const facade = new IaoFacade(port);
  const budget = vi.spyOn(facade, "executionBudgetMs");
  const server = await listen(facade, {
    authenticate: async () => { authEntered.resolve(); await authRelease.promise; return identity(); },
    readiness: async () => {
      if (++probes === 2) { finalProbe.resolve(); await probeRelease.promise; }
      return { ready: true, phase: "ready" };
    },
  });
  cleanup.push(() => {
    authRelease.resolve(); probeRelease.resolve();
    completionRelease.resolve({ text: "cleanup", modelVersion: "fixture" });
  });
  server.on("request", req => { socket = req.socket; });
  const active = call(server, { partial: true });
  await authEntered.promise;
  expect(socket.timeout).toBe(15_000);
  expect(budget).not.toHaveBeenCalled();
  authRelease.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(socket.timeout).toBe(15_000);
  expect(budget).not.toHaveBeenCalled();
  active.client.end(active.raw);
  await finalProbe.promise;
  expect(socket.timeout).toBe(15_000);
  expect(budget).not.toHaveBeenCalled();
  probeRelease.resolve();
  await completionEntered.promise;
  expect(socket.timeout).toBe(241_000);
  expect(budget).toHaveBeenCalledExactlyOnceWith("conversation");
  expect([server.timeout, server.requestTimeout, server.headersTimeout]).toEqual([15_000, 15_000, 10_000]);
  completionRelease.resolve({ text: "finished", modelVersion: "fixture" });
  expect(await active.outcome).toMatchObject({ kind: "response", status: 202, body: { status: "verified", preview: "finished" } });
});

it.each(["absent", "invalid", "short"] as const)("preserves the default socket deadline for %s execution metadata", async mode => {
  const entered = deferred<void>(), release = deferred<KartaIaoResult>();
  const port: KartaIaoPort = { prepare: async () => { entered.resolve(); return release.promise; } };
  if (mode !== "absent") port.executionBudgetMs = () => mode === "invalid" ? Infinity : 100;
  const server = await listen(new IaoFacade(port));
  cleanup.push(() => { release.resolve({ kind: "accepted", preview: "cleanup" }); });
  let socket!: Socket;
  server.on("request", req => { socket = req.socket; });
  const active = call(server);
  await entered.promise;
  expect(socket.timeout).toBe(15_000);
  release.resolve({ kind: "accepted", preview: "finished" });
  expect(await active.outcome).toMatchObject({ kind: "response", status: 202 });
});

it.each(["returns", "throws"] as const)("rejects admission when budget metadata aborts runtime lifetime then %s", async mode => {
  const lifetime = new AbortController();
  const prepare = vi.fn(async () => ({ kind: "accepted" as const, preview: "must not execute" }));
  const facade = new IaoFacade({ prepare, executionBudgetMs() {
    lifetime.abort();
    if (mode === "throws") throw new Error("metadata interrupted");
    return 240_000;
  } });
  const server = await listen(facade, { lifetime: lifetime.signal });
  expect(await call(server).outcome).toMatchObject({ kind: "response", status: 503 });
  expect(prepare).not.toHaveBeenCalled();
});

it("delivers a verified HTTP response after two sequential IAO stages totaling 16 seconds", async () => {
  const contextEntered = deferred<void>(), contextRelease = deferred<void>();
  const entered = deferred<void>(), release = deferred<{ text: string; modelVersion: string }>();
  let signal: AbortSignal | undefined;
  let socket!: Socket;
  const buildContext = vi.fn<SmaranaIaoPort["buildContext"]>(async () => {
    contextEntered.resolve(); await contextRelease.promise;
    return { operationId, context: { sources: [] } };
  });
  const complete = vi.fn<IaoCompletionPort["complete"]>(async input => {
    signal = input.signal; entered.resolve(); return release.promise;
  });
  const facade = new IaoFacade(new KartaRuntimeIaoPort({ buildContext, control: vi.fn() }, { complete }, 12_000));
  const server = await listen(facade);
  cleanup.push(() => {
    contextRelease.resolve(); release.resolve({ text: "cleanup", modelVersion: "fixture" });
  });
  const timedOut = vi.fn();
  server.on("timeout", timedOut);
  server.on("request", req => { socket = req.socket; });
  const startedAt = performance.now();
  const active = call(server);
  await contextEntered.promise;
  expect(socket.timeout).toBe(25_000);
  // Real sockets and two 8-second stages cover both the old 15-second cutoff
  // and a transport incorrectly bounded to just one 12-second stage plus margin.
  await pause(8_000);
  contextRelease.resolve();
  await entered.promise;
  await pause(8_000);
  expect(socket.destroyed).toBe(false);
  expect(signal?.aborted).toBe(false);
  expect(facade.get("tenant", "actor", requestId).status).toBe("draft");
  release.resolve({ text: "finished after 16 seconds", modelVersion: "fixture" });
  expect(await active.outcome).toMatchObject({ kind: "response", status: 202, body: {
    status: "verified", preview: "finished after 16 seconds", proof: { source: "karta", requestId, proofId: operationId },
  } });
  const elapsedMs = performance.now() - startedAt;
  expect(elapsedMs).toBeGreaterThanOrEqual(16_000);
  expect(elapsedMs).toBeLessThan(30_000);
  expect(timedOut).not.toHaveBeenCalled();
  expect(buildContext).toHaveBeenCalledOnce();
  expect(complete).toHaveBeenCalledOnce();
  expect([server.timeout, server.requestTimeout, server.headersTimeout]).toEqual([15_000, 15_000, 10_000]);
}, 35_000);

it("bounds slow authentication to 15 seconds on the same keep-alive connection", async () => {
  const authEntered = deferred<void>(), authRelease = deferred<void>();
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const complete = vi.fn(async () => ({ text: "finished", modelVersion: "fixture" }));
  const facade = new IaoFacade(new KartaRuntimeIaoPort({
    buildContext: async () => ({ operationId, context: { sources: [] } }), control: vi.fn(),
  }, { complete }));
  const sockets: Socket[] = [];
  const initialTimeouts: (number | undefined)[] = [];
  let connections = 0;
  const server = await listen(facade, { authenticate: async req => {
    if (req.method === "GET") { authEntered.resolve(); await authRelease.promise; }
    return identity();
  } });
  cleanup.push(() => { authRelease.resolve(); agent.destroy(); });
  server.on("connection", () => { connections++; });
  server.on("request", req => { sockets.push(req.socket); initialTimeouts.push(req.socket.timeout); });
  expect(await call(server, { agent }).outcome).toMatchObject({ kind: "response", status: 202 });
  expect(await call(server, { agent, method: "GET", path: "/live" }).outcome).toMatchObject({ kind: "response", status: 200 });
  const startedAt = performance.now();
  const next = call(server, { agent, method: "GET", path: "/iao/requests/" + requestId });
  await authEntered.promise;
  expect(connections).toBe(1);
  expect(sockets).toHaveLength(3);
  expect(sockets[1]).toBe(sockets[0]);
  expect(sockets[2]).toBe(sockets[0]);
  expect(initialTimeouts).toEqual([15_000, 15_000, 15_000]);
  expect(sockets[2]!.timeout).toBe(15_000);
  const outcome = await next.outcome;
  // The per-request admission deadline and the restored socket deadline are
  // both 15 seconds; either can win without extending unauthenticated work.
  if (outcome.kind === "error") expect(outcome.code).toBe("ECONNRESET");
  else expect(outcome).toEqual({ kind: "response", status: 503, body: { error: "IAO runtime unavailable" } });
  expect(performance.now() - startedAt).toBeGreaterThanOrEqual(14_500);
  expect(performance.now() - startedAt).toBeLessThan(20_000);
  expect(complete).toHaveBeenCalledOnce();
}, 22_000);

it("keeps an admitted task tracked after its client disconnects with an extended response budget", async () => {
  const entered = deferred<void>(), release = deferred<{ text: string; modelVersion: string }>();
  let signal: AbortSignal | undefined;
  const facade = new IaoFacade(new KartaRuntimeIaoPort({
    buildContext: async () => ({ operationId, context: { sources: [] } }), control: vi.fn(),
  }, { complete: async input => { signal = input.signal; entered.resolve(); return release.promise; } }));
  const server = await listen(facade);
  cleanup.push(() => { release.resolve({ text: "cleanup", modelVersion: "fixture" }); });
  const active = call(server);
  await entered.promise;
  active.client.destroy();
  expect(await active.outcome).toMatchObject({ kind: "error" });
  expect(signal?.aborted).toBe(false);
  expect(facade.get("tenant", "actor", requestId).status).toBe("draft");
  let drained = false;
  const draining = server.drainRequests().then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(drained).toBe(false);
  release.resolve({ text: "finished", modelVersion: "fixture" });
  await draining;
  expect(facade.get("tenant", "actor", requestId)).toMatchObject({ status: "verified", preview: "finished" });
});

it("returns a bounded provider-timeout result instead of losing the connection", async () => {
  let signal: AbortSignal | undefined;
  const complete = vi.fn<IaoCompletionPort["complete"]>(input => {
    signal = input.signal; return new Promise(() => {});
  });
  const facade = new IaoFacade(new KartaRuntimeIaoPort({
    buildContext: async () => ({ operationId, context: { sources: [] } }), control: vi.fn(),
  }, { complete }, 150));
  const server = await listen(facade, { socketTimeoutMs: 40 });
  expect(await call(server).outcome).toMatchObject({ kind: "response", status: 503,
    body: { status: "blocked", effect: "uncertain" } });
  expect(signal?.aborted).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
});

it("delivers a memory-control receipt once when replayed across the submission aliases", async () => {
  const control = vi.fn<SmaranaIaoPort["control"]>(async input => {
    await pause(120); return { action: input.action, operationId, replayed: false };
  });
  const complete = vi.fn<IaoCompletionPort["complete"]>();
  const buildContext = vi.fn<SmaranaIaoPort["buildContext"]>();
  const facade = new IaoFacade(new KartaRuntimeIaoPort({ buildContext, control }, { complete }, 1_000));
  const server = await listen(facade, { socketTimeoutMs: 50 });
  const data = { ...body, type: "memory-control", memoryControl: { action: "update", data: { value: "synthetic" } } };
  expect(await call(server, { path: "/pura/requests", data }).outcome).toMatchObject({ kind: "response", status: 202, body: {
    status: "verified", memoryControl: { action: "update", operationId },
  } });
  expect(await call(server, { path: "/iao/requests", data }).outcome).toMatchObject({ kind: "response", status: 202,
    body: { status: "verified" } });
  expect(control).toHaveBeenCalledOnce();
  expect(buildContext).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});

it("keeps a waiting response explicitly cancellable after its original socket deadline", async () => {
  const entered = deferred<void>();
  let signal: AbortSignal | undefined;
  const complete = vi.fn<IaoCompletionPort["complete"]>(input => {
    signal = input.signal; entered.resolve(); return new Promise(() => {});
  });
  const facade = new IaoFacade(new KartaRuntimeIaoPort({
    buildContext: async () => ({ operationId, context: { sources: [] } }), control: vi.fn(),
  }, { complete }, 2_000));
  const server = await listen(facade, { socketTimeoutMs: 50 });
  const submitted = call(server);
  await entered.promise;
  await pause(100);
  expect(await call(server, { path: `/iao/requests/${requestId}/cancel`, data: {} }).outcome)
    .toMatchObject({ kind: "response", status: 200, body: { status: "cancelled" } });
  expect(await submitted.outcome).toMatchObject({ kind: "response", status: 202,
    body: { status: "cancelled", effect: "uncertain" } });
  expect(signal?.aborted).toBe(true);
  expect(complete).toHaveBeenCalledOnce();
});

it("preserves an existing longer transport timeout", async () => {
  const entered = deferred<void>(), release = deferred<KartaIaoResult>();
  const facade = new IaoFacade({ executionBudgetMs: () => 20_000,
    prepare: async () => { entered.resolve(); return release.promise; } });
  const server = await listen(facade, { socketTimeoutMs: 45_000 });
  cleanup.push(() => { release.resolve({ kind: "accepted", preview: "cleanup" }); });
  let socket!: Socket;
  server.on("request", req => { socket = req.socket; });
  const submitted = call(server);
  await entered.promise;
  expect(socket.timeout).toBe(45_000);
  release.resolve({ kind: "accepted", preview: "finished" });
  expect(await submitted.outcome).toMatchObject({ kind: "response", status: 202, body: { preview: "finished" } });
});

it("does not consult budget metadata or dispatch for malformed requests", async () => {
  const prepare = vi.fn<KartaIaoPort["prepare"]>();
  const executionBudgetMs = vi.fn(() => 20_000);
  const server = await listen(new IaoFacade({ prepare, executionBudgetMs }));
  let timeoutCalls: unknown[][] | undefined;
  server.on("request", (_req, res) => { timeoutCalls = vi.spyOn(res, "setTimeout").mock.calls; });
  expect(await call(server, { data: { ...body, type: "unsupported" } }).outcome).toMatchObject({ kind: "response", status: 400 });
  expect(executionBudgetMs).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(timeoutCalls).toEqual([]);
});
