import { once } from "node:events";
import { Agent, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.js";
import { handleIaoRoute } from "../src/api/iaoRoutes.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoPort } from "../src/iao/iaoFacade.js";
import { KartaRuntimeIaoPort, type IaoCompletionPort, type SmaranaIaoPort } from "../src/iao/kartaRuntimePort.js";

vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));

const requestId = "11111111-1111-4111-8111-111111111111";
const proofId = "22222222-2222-4222-8222-222222222222";
const payload = { type: "conversation", requestId, conversationId: "budget", prompt: "Synthetic response" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

function identity(): IaoServerIdentity {
  const now = Date.now();
  return { tenantId: "tenant", actorId: "actor", session: {
    tenantId: "tenant", userId: "actor", sessionId: proofId, appSlug: "purama-ai", issuedAt: now - 1000, expiresAt: now + 60_000,
  } };
}

async function listen(port: KartaIaoPort, timeout?: number) {
  const server = startApiServer(async () => ({ ready: true, phase: "ready" }), {
    iaoRuntime: { facade: new IaoFacade(port), authenticator: { authenticate: async () => identity() } },
    consultationHost: null,
  });
  await once(server, "listening");
  if (timeout !== undefined) server.setTimeout(timeout);
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return server;
}

function call(server: Server, path = "/iao/requests", data: unknown = payload, agent?: Agent) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    const req = request({ host: "127.0.0.1", port: address.port, path, method: data === null ? "GET" : "POST", agent }, res => {
      let raw = "";
      res.setEncoding("utf8").on("data", chunk => { raw += chunk; });
      res.once("error", reject);
      res.once("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(raw) }); } catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.end(data === null ? undefined : JSON.stringify(data));
  });
}

function ports() {
  const buildContext = vi.fn<SmaranaIaoPort["buildContext"]>(async () => ({ operationId: proofId, context: { sources: [] } }));
  const control = vi.fn<SmaranaIaoPort["control"]>(async input => ({ action: input.action, operationId: proofId, replayed: false }));
  const complete = vi.fn<IaoCompletionPort["complete"]>(async () => ({ text: "Synthetic response", modelVersion: "test/local" }));
  return { buildContext, control, complete };
}

describe("IAO HTTP execution budgets with real loopback sockets", () => {
  it("delivers an admitted response beyond the server's default 15-second inactivity limit", async () => {
    const dependencies = ports();
    dependencies.complete.mockImplementation(async () => {
      await pause(15_100);
      return { text: "Synthetic slow response", modelVersion: "test/local" };
    });
    const server = await listen(new KartaRuntimeIaoPort(dependencies, dependencies, 20_000));
    expect(server.timeout).toBe(15_000);
    expect(await call(server)).toMatchObject({ status: 202, body: { status: "verified", preview: "Synthetic slow response" } });
    expect(dependencies.complete).toHaveBeenCalledOnce();
  }, 25_000);

  it("covers both sequential context and completion stages without changing the request-body deadline", async () => {
    const dependencies = ports();
    dependencies.buildContext.mockImplementation(async () => {
      await pause(120); return { operationId: proofId, context: { sources: [] } };
    });
    dependencies.complete.mockImplementation(async () => {
      await pause(120); return { text: "Two bounded stages", modelVersion: "test/local" };
    });
    const server = await listen(new KartaRuntimeIaoPort(dependencies, dependencies, 1000), 50);
    expect(await call(server, "/pura/requests")).toMatchObject({ status: 202, body: { status: "verified", preview: "Two bounded stages" } });
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
    expect(dependencies.buildContext).toHaveBeenCalledOnce();
    expect(dependencies.complete).toHaveBeenCalledOnce();
  });

  it("returns a bounded provider-timeout result instead of losing the connection", async () => {
    const dependencies = ports();
    let signal: AbortSignal | undefined;
    dependencies.complete.mockImplementation(input => { signal = input.signal; return new Promise(() => {}); });
    const server = await listen(new KartaRuntimeIaoPort(dependencies, dependencies, 150), 40);
    expect(await call(server)).toMatchObject({ status: 503, body: { status: "blocked", effect: "uncertain" } });
    expect(signal?.aborted).toBe(true);
    expect(dependencies.complete).toHaveBeenCalledOnce();
  });

  it("delivers a memory-control receipt without invoking completion or repeating the effect", async () => {
    const dependencies = ports();
    dependencies.control.mockImplementation(async input => {
      await pause(120); return { action: input.action, operationId: proofId, replayed: false };
    });
    const server = await listen(new KartaRuntimeIaoPort(dependencies, dependencies, 1000), 50);
    const control = { ...payload, type: "memory-control", memoryControl: { action: "update", data: { value: "synthetic" } } };
    expect(await call(server, "/iao/requests", control)).toMatchObject({ status: 202, body: {
      status: "verified", memoryControl: { action: "update", operationId: proofId },
    } });
    expect(await call(server, "/iao/requests", control)).toMatchObject({ status: 202, body: { status: "verified" } });
    expect(dependencies.control).toHaveBeenCalledOnce();
    expect(dependencies.complete).not.toHaveBeenCalled();
  });

  it("keeps a waiting response cancellable after its original socket deadline", async () => {
    const dependencies = ports();
    let entered!: () => void;
    const running = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    dependencies.complete.mockImplementation(input => {
      signal = input.signal; entered(); return new Promise(() => {});
    });
    const server = await listen(new KartaRuntimeIaoPort(dependencies, dependencies, 2000), 50);
    const submitted = call(server);
    await running;
    await pause(100);
    expect(await call(server, `/iao/requests/${requestId}/cancel`, {})).toMatchObject({ status: 200, body: { status: "cancelled" } });
    expect(await submitted).toMatchObject({ status: 202, body: { status: "cancelled", effect: "uncertain" } });
    expect(signal?.aborted).toBe(true);
  });

  it("restores the regular inactivity limit for the next keep-alive request", async () => {
    const dependencies = ports();
    const server = await listen(new KartaRuntimeIaoPort(dependencies, dependencies, 1000), 75);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(async () => { agent.destroy(); });
    const observed: Array<{ socket: IncomingMessage["socket"]; timeout?: number }> = [];
    server.on("request", req => { observed.push({ socket: req.socket, timeout: req.socket.timeout }); });
    expect((await call(server, "/iao/requests", payload, agent)).status).toBe(202);
    expect((await call(server, "/live", null, agent)).status).toBe(200);
    expect(observed).toHaveLength(2);
    expect(observed[1]?.socket).toBe(observed[0]?.socket);
    expect(observed[1]?.timeout).toBe(75);
  });
});

describe("IAO transport metadata cannot weaken request admission", () => {
  async function route(port: KartaIaoPort, body: Record<string, unknown> = payload, socketTimeout = 15_000) {
    const sink: { status?: number; body?: unknown } = {};
    const setTimeout = vi.fn();
    const res = { setHeader() {}, socket: { timeout: socketTimeout }, setTimeout } as unknown as ServerResponse;
    await handleIaoRoute({ method: "POST", url: "/iao/requests" } as IncomingMessage, res,
      { facade: new IaoFacade(port), authenticator: { authenticate: async () => identity() } },
      async () => body, (_res, status, result) => { sink.status = status; sink.body = result; });
    return { sink, setTimeout };
  }

  it.each([undefined, null, false, "1000", 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_200_001])(
    "ignores invalid execution-budget metadata (%s) without blocking valid work", async invalid => {
      const prepare = vi.fn<KartaIaoPort["prepare"]>(async () => ({ kind: "accepted", preview: "valid" }));
      const { sink, setTimeout } = await route({ prepare, executionBudgetMs: () => invalid as number });
      expect(sink).toMatchObject({ status: 202, body: { preview: "valid" } });
      expect(setTimeout).not.toHaveBeenCalled();
      expect(prepare).toHaveBeenCalledOnce();
    },
  );

  it.each(["absent", "throws", "getter"])("keeps optional budget metadata %s harmless and private", async mode => {
    const prepare = vi.fn<KartaIaoPort["prepare"]>(async () => ({ kind: "accepted", preview: "valid" }));
    const port: KartaIaoPort = { prepare };
    if (mode === "throws") port.executionBudgetMs = () => { throw new Error("PRIVATE_BUDGET_DETAILS"); };
    if (mode === "getter") Object.defineProperty(port, "executionBudgetMs", { get() { throw new Error("PRIVATE_BUDGET_DETAILS"); } });
    const { sink, setTimeout } = await route(port);
    expect(sink).toMatchObject({ status: 202, body: { preview: "valid" } });
    expect(JSON.stringify(sink)).not.toContain("PRIVATE_BUDGET_DETAILS");
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it("preserves an existing longer transport timeout", async () => {
    const { setTimeout } = await route({ prepare: async () => ({ kind: "accepted" }), executionBudgetMs: () => 20_000 }, payload, 45_000);
    expect(setTimeout).toHaveBeenCalledExactlyOnceWith(45_000);
  });

  it("does not consult budget metadata or dispatch for malformed requests", async () => {
    const prepare = vi.fn();
    const executionBudgetMs = vi.fn(() => 20_000);
    const { sink, setTimeout } = await route({ prepare, executionBudgetMs }, { ...payload, type: "unsupported" });
    expect(sink.status).toBe(400);
    expect(executionBudgetMs).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(setTimeout).not.toHaveBeenCalled();
  });

  it.each([100, 120_000, 600_000])("exposes a finite budget for every supported operation at stage limit %s", timeout => {
    const dependencies = ports();
    const facade = new IaoFacade(new KartaRuntimeIaoPort(dependencies, dependencies, timeout));
    expect(facade.executionBudgetMs("conversation")).toBe(timeout * 2);
    expect(facade.executionBudgetMs("memory-control")).toBe(timeout);
  });
});
