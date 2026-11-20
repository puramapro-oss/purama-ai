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
