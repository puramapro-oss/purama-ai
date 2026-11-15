import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handler: undefined as ((req: IncomingMessage, res: ServerResponse) => void) | undefined,
  enqueue: vi.fn(), close: vi.fn(), approve: vi.fn(),
}));
vi.mock("node:http", async () => {
  const { EventEmitter } = await import("node:events");
  return { createServer: (handler: typeof mocks.handler) => {
    mocks.handler = handler;
    const server = new EventEmitter();
    return Object.assign(server, {
      listen: (_port: number, callback: () => void) => { queueMicrotask(callback); },
      close: (callback: () => void) => { mocks.close(); queueMicrotask(callback); },
      closeIdleConnections: vi.fn(),
    });
  } };
});
vi.mock("../src/config.js", () => ({ config: { port: 4100, mockClaude: true, adminToken: "test-only" } }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: mocks.enqueue }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: { legal: {} } }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: mocks.approve }));

import { startApiServer } from "../src/api/server.js";
import type { IaoRouteRuntime } from "../src/api/iaoRoutes.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoResult } from "../src/iao/iaoFacade.js";
import { KartaRuntime } from "../src/runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture(iaoRuntime?: IaoRouteRuntime) {
  const closeQueue = vi.fn(async () => {});
  const probe = vi.fn(async () => false);
  const producer = { stop() {}, async drain() {} };
  const runtime = new KartaRuntime({
    redis: async () => ({ close: async () => {} }),
    queue: async () => ({ close: closeQueue }),
    worker: async () => ({ close: async () => {} }),
    api: async () => api,
    schedulers: async () => producer, customSchedulers: async () => producer,
    probe, shutdownTimeoutMs: 1000, readinessTimeoutMs: 50,
  });
  const api = startApiServer(runtime, { iaoRuntime });
  return { runtime, api, probe, closeQueue };
}

function request(path = "/health", method = "GET") {
  const done = deferred<{ status: number; body: Record<string, unknown> }>();
  let status = 0;
  const res = {
    headersSent: false, destroyed: false,
    setHeader: vi.fn(),
    writeHead(code: number) { status = code; },
    end(body: string) { done.resolve({ status, body: JSON.parse(body) }); },
  } as unknown as ServerResponse;
  const req = { url: path, method, headers: { authorization: "Bearer test-only" } } as IncomingMessage;
  mocks.handler!(req, res);
  return { response: done.promise, res };
}

beforeEach(() => { vi.clearAllMocks(); mocks.enqueue.mockResolvedValue(undefined); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("HTTP lifecycle admission and readiness", () => {
  it("returns 503 at startup and 200 only after dependency readiness (kill switch may be active)", async () => {
    const f = fixture();
    expect((await request().response).status).toBe(503);
    await f.runtime.start();
    f.probe.mockResolvedValue(true);
    const response = await request().response;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: "ok", mockClaude: true, globalKillSwitch: true });
    await f.runtime.stop();
  });

  it("returns 503 on dependency failure, without leaking dependency errors", async () => {
    const f = fixture();
    await f.runtime.start();
    f.probe.mockRejectedValue(new Error("private dependency detail"));
    const response = await request().response;
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("private");
    await f.runtime.stop();
  });

  it("returns 503 when shutdown races an awaited successful probe", async () => {
    const f = fixture();
    await f.runtime.start();
    const probe = deferred<boolean>();
    f.probe.mockReturnValueOnce(probe.promise);
    const response = request().response;
    const stopped = f.runtime.stop();
    probe.resolve(false);
    expect((await response).status).toBe(503);
    expect(await stopped).toBe(0);
  });

  it("bounds a hanging health probe", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    await f.runtime.start();
    f.probe.mockReturnValueOnce(new Promise(() => {}));
    const response = request().response;
    await vi.advanceTimersByTimeAsync(50);
    expect((await response).status).toBe(503);
    const stopped = f.runtime.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(await stopped).toBe(0);
  });

  it("checks readiness again immediately before writing HTTP 200", async () => {
    const f = fixture();
    await f.runtime.start();
    // The health result is already settled, but its HTTP continuation has not run.
    vi.spyOn(f.runtime, "health").mockResolvedValueOnce({ ready: true, globalKillSwitch: false });
    const response = request().response;
    const stopped = f.runtime.stop();
    expect((await response).status).toBe(503);
    expect(await stopped).toBe(0);
  });

  it("rejects new work on startup and shutdown while preserving an admitted trigger", async () => {
    const f = fixture();
    expect((await request("/trigger/legal/abc", "POST").response).status).toBe(503);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    await f.runtime.start();
    const enqueue = deferred();
    mocks.enqueue.mockReturnValueOnce(enqueue.promise);
    const active = request("/trigger/legal/abc", "POST").response;
    expect(mocks.enqueue).toHaveBeenCalledOnce();
    const stopped = f.runtime.stop();
    expect((await request("/trigger/legal/abc", "POST").response).status).toBe(503);
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(f.closeQueue).not.toHaveBeenCalled();
    enqueue.resolve();
    expect((await active).status).toBe(202);
    expect(await stopped).toBe(0);
    expect(f.closeQueue).toHaveBeenCalledOnce();
  });

  it("waits for active approval side effects even after a client disconnects", async () => {
    const f = fixture();
    await f.runtime.start();
    const approved = deferred<{ ok: boolean; resultSummary: string }>();
    mocks.approve.mockReturnValueOnce(approved.promise);
    const active = request("/pending-actions/abc/approve", "POST");
    active.res.destroyed = true;
    const stopped = f.runtime.stop();
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
    expect(f.closeQueue).not.toHaveBeenCalled();
    approved.resolve({ ok: true, resultSummary: "done" });
    expect(await stopped).toBe(0);
    expect(f.closeQueue).toHaveBeenCalledOnce();
  });
});

describe("HTTP routing of IAO cancellation", () => {
  const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
  function serverIdentity(): IaoServerIdentity {
    const now = Date.now();
    return {
      tenantId: "tenant-a", actorId: "user-a",
      session: { sessionId: "22222222-2222-4222-8222-222222222222", tenantId: "tenant-a", userId: "user-a", appSlug: "purama-ai", issuedAt: now - 1_000, expiresAt: now + 60_000 },
    };
  }

  it("routes POST /iao/requests/:id/cancel to the IAO handler ahead of admin authorization", async () => {
    const unavailable = fixture();
    await unavailable.runtime.start();
    const unavailableRequest = request(`/iao/requests/${REQUEST_ID}/cancel`, "POST");
    expect(await unavailableRequest.response).toEqual({ status: 503, body: { error: "IAO runtime unavailable" } });
    expect(unavailableRequest.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");

    const facade = new IaoFacade({ prepare: vi.fn(() => new Promise<KartaIaoResult>(() => {})) });
    const f = fixture({ facade, authenticator: { authenticate: async () => serverIdentity() } });
    await f.runtime.start();
    void facade.submit({ type: "conversation", requestId: REQUEST_ID, tenantId: "tenant-a", actorId: "user-a", conversationId: "c", prompt: "x", identity: serverIdentity() });
    const cancellation = request(`/iao/requests/${REQUEST_ID}/cancel`, "POST");
    const cancelled = await cancellation.response;
    expect(cancellation.res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", effect: "uncertain" });
    expect((await request(`/iao/requests/${REQUEST_ID}`, "GET").response).body).toMatchObject({ status: "cancelled" });
    expect((await request("/iao/requests/unknown/cancel", "POST").response).status).toBe(404);
    expect((await request("/iao/requests/x/cancel/extra", "POST").response).status).toBe(404);
  });
});
