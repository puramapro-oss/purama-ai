import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIaoRoute, IaoAuthenticationError } from "../src/api/iaoRoutes.js";
import {
  IaoFacade,
  IaoRequestConflictError,
  type IaoRequest,
  type IaoServerIdentity,
  type KartaIaoPort,
} from "../src/iao/iaoFacade.js";
import { KartaRuntimeIaoPort, type IaoCompletionPort, type SmaranaIaoPort } from "../src/iao/kartaRuntimePort.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const RECEIPT_ID = "33333333-3333-4333-8333-333333333333";

function identity(overrides: Partial<IaoServerIdentity> = {}): IaoServerIdentity {
  const now = Date.now();
  return {
    tenantId: "tenant-a",
    actorId: "user-a",
    session: {
      sessionId: SESSION_ID,
      tenantId: "tenant-a",
      userId: "user-a",
      appSlug: "purama-ai",
      issuedAt: now - 1_000,
      expiresAt: now + 60_000,
    },
    ...overrides,
  };
}

function request(overrides: Partial<IaoRequest> = {}): IaoRequest {
  const serverIdentity = identity();
  return {
    type: "conversation",
    requestId: REQUEST_ID,
    tenantId: serverIdentity.tenantId,
    actorId: serverIdentity.actorId,
    conversationId: "conversation-a",
    prompt: "Bonjour",
    identity: serverIdentity,
    ...overrides,
  };
}

function evidence(requestId = REQUEST_ID, proofId = RECEIPT_ID) {
  return { source: "karta" as const, requestId, proofId, completedAt: new Date().toISOString() };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("IAO facade contract", () => {
  it.each([
    { tenantId: "" },
    { actorId: "" },
    { identity: identity({ tenantId: "tenant-b" }) },
    { identity: identity({ actorId: "user-b" }) },
  ])("rejects absent or mismatched server identity before KARTA dispatch", async (overrides) => {
    const karta = { prepare: vi.fn() } satisfies KartaIaoPort;
    await expect(new IaoFacade(karta).submit(request(overrides))).rejects.toThrow("Invalid IAO identity");
    expect(karta.prepare).not.toHaveBeenCalled();
  });

  it("coalesces concurrent duplicate requests and exposes an export exactly once", async () => {
    const pending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const karta = { prepare: vi.fn(() => pending.promise) } satisfies KartaIaoPort;
    const facade = new IaoFacade(karta);
    const input = request({
      type: "memory-control",
      memoryControl: { action: "export", data: {} },
    });
    const first = facade.submit(input);
    const concurrentReplay = facade.submit(input);
    pending.resolve({
      kind: "accepted",
      evidence: evidence(),
      memoryControl: { action: "export", operationId: RECEIPT_ID, replayed: false, exported: [{ private: "one-shot" }] },
    });

    expect((await first).memoryControl?.exported).toEqual([{ private: "one-shot" }]);
    expect(await concurrentReplay).toMatchObject({ status: "verified", memoryControl: { replayed: true } });
    expect((await concurrentReplay).memoryControl?.exported).toBeUndefined();
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).memoryControl?.exported).toBeUndefined();
    expect(karta.prepare).toHaveBeenCalledOnce();
  });

  it("rejects an idempotency key reused with a different payload", async () => {
    const karta = { prepare: vi.fn(async () => ({ kind: "accepted" as const, preview: "ok" })) };
    const facade = new IaoFacade(karta);
    await facade.submit(request());
    await expect(facade.submit(request({ prompt: "different" }))).rejects.toBeInstanceOf(IaoRequestConflictError);
    expect(karta.prepare).toHaveBeenCalledOnce();
  });

  it("replays a completed durable action without repeating its KARTA effect", async () => {
    const karta = { prepare: vi.fn(async () => ({
      kind: "accepted" as const,
      evidence: evidence(),
      memoryControl: { action: "update" as const, operationId: RECEIPT_ID, replayed: false },
    })) } satisfies KartaIaoPort;
    const facade = new IaoFacade(karta);
    const input = request({ type: "memory-control", memoryControl: { action: "update", data: { value: "x" } } });

    expect(await facade.submit(input)).toMatchObject({ status: "verified", memoryControl: { replayed: false } });
    expect(await facade.submit(input)).toMatchObject({ status: "verified", memoryControl: { replayed: true } });
    expect(karta.prepare).toHaveBeenCalledOnce();
  });

  it("fails closed on a missing durable ACK without leaking the internal error", async () => {
    const karta = { prepare: vi.fn(async () => ({
      kind: "accepted" as const,
      evidence: evidence(REQUEST_ID, RECEIPT_ID),
      memoryControl: { action: "update" as const, operationId: "not-a-uuid", replayed: false },
    })) };
    const response = await new IaoFacade(karta).submit(request({
      type: "memory-control", memoryControl: { action: "update", data: { value: "x" } },
    }));
    expect(response).toMatchObject({ status: "blocked", blocked: { reason: "KARTA is unavailable", dependency: "karta-runtime" } });
    expect(JSON.stringify(response)).not.toContain("durable");
    expect(JSON.stringify(response)).not.toContain("not-a-uuid");
  });

  it("keeps verified and blocked states terminal and marks late non-terminal results stale", async () => {
    const facade = new IaoFacade({ prepare: vi.fn(async () => ({ kind: "accepted" as const, preview: "draft" })) });
    const first = await facade.submit(request());
    expect(first.status).toBe("partial");
    await facade.submit(request({ requestId: "44444444-4444-4444-8444-444444444444" }));
    expect(facade.recordKartaResult("tenant-a", REQUEST_ID, { kind: "accepted", evidence: evidence() })).toMatchObject({ status: "partial", stale: true });
    expect(facade.recordKartaResult("tenant-a", REQUEST_ID, { kind: "blocked", reason: "x" })).toMatchObject({ status: "blocked" });
    expect(facade.recordKartaResult("tenant-a", REQUEST_ID, { kind: "accepted", evidence: evidence() })).toMatchObject({ status: "blocked" });
  });
});

describe("KARTA IAO adapter", () => {
  it("uses SMARANA's durable receipt, then computes only from its authorized context", async () => {
    const smarana = {
      buildContext: vi.fn(async () => ({ operationId: RECEIPT_ID, context: { sources: [] } })),
      control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const completion = { complete: vi.fn(async () => ({ text: "réponse", modelVersion: "local/test" })) } satisfies IaoCompletionPort;
    const result = await new KartaRuntimeIaoPort(smarana, completion).prepare(request());
    expect(result).toMatchObject({ kind: "accepted", preview: "réponse", evidence: { proofId: RECEIPT_ID } });
    expect(smarana.buildContext).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: REQUEST_ID, tenantId: "tenant-a", actorId: "user-a" }));
    expect(completion.complete).toHaveBeenCalledWith(expect.objectContaining({ requestId: REQUEST_ID, message: "Bonjour" }));
  });

  it("fails closed on missing ACK and provider timeout with generic dependencies", async () => {
    vi.useFakeTimers();
    const missingAck = new KartaRuntimeIaoPort({
      buildContext: vi.fn(async () => ({ operationId: "missing", context: { sources: [] } })), control: vi.fn(),
    }, { complete: vi.fn(async () => { throw new Error("must not run"); }) }, 100);
    await expect(missingAck.prepare(request())).resolves.toEqual({ kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:karta-runtime" });

    const hanging = new KartaRuntimeIaoPort({
      buildContext: vi.fn(async () => ({ operationId: RECEIPT_ID, context: { sources: [] } })), control: vi.fn(),
    }, { complete: vi.fn(() => new Promise<{ text: string; modelVersion: string }>(() => {})) }, 100);
    const pending = hanging.prepare(request());
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:karta-runtime" });
  });
});

describe("IAO HTTP contract", () => {
  function responseSink() {
    const state: { status?: number; body?: unknown } = {};
    return {
      state,
      res: { writeHead(status: number) { state.status = status; }, end(body: string) { state.body = JSON.parse(body); } } as unknown as ServerResponse,
      sendJson(res: ServerResponse, status: number, body: unknown) { res.writeHead(status); res.end(JSON.stringify(body)); },
    };
  }

  it("rejects unknown request types and unexpected client identity fields", async () => {
    const facade = new IaoFacade({ prepare: vi.fn() });
    for (const body of [
      { type: "execute", requestId: REQUEST_ID, conversationId: "c", prompt: "x" },
      { type: "conversation", requestId: REQUEST_ID, conversationId: "c", prompt: "x", tenantId: "tenant-b" },
      { type: "conversation", requestId: REQUEST_ID, conversationId: "c", prompt: "   " },
    ]) {
      const sink = responseSink();
      await handleIaoRoute({ method: "POST", url: "/iao/requests" } as IncomingMessage, sink.res,
        { facade, authenticator: { authenticate: async () => identity() } }, async () => body, sink.sendJson);
      expect(sink.state.status).toBe(400);
    }
  });

  it("returns generic authentication and lookup errors without cross-tenant disclosure", async () => {
    const facade = new IaoFacade({ prepare: vi.fn(async () => ({ kind: "accepted" as const, preview: "ok" })) });
    await facade.submit(request());
    const denied = responseSink();
    await handleIaoRoute({ method: "GET", url: `/iao/requests/${REQUEST_ID}` } as IncomingMessage, denied.res,
      { facade, authenticator: { authenticate: async () => { throw new IaoAuthenticationError(); } } }, async () => ({}), denied.sendJson);
    expect(denied.state).toEqual({ status: 401, body: { error: "IAO authentication required" } });

    const foreign = responseSink();
    await handleIaoRoute({ method: "GET", url: `/iao/requests/${REQUEST_ID}` } as IncomingMessage, foreign.res,
      { facade, authenticator: { authenticate: async () => identity({ tenantId: "tenant-b", actorId: "user-b" }) } }, async () => ({}), foreign.sendJson);
    expect(foreign.state).toEqual({ status: 404, body: { error: "IAO request not found" } });
  });
});
