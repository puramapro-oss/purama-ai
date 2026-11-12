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
    expect(facade.recordKartaResult("tenant-a", "user-a", REQUEST_ID, { kind: "accepted", evidence: evidence() })).toMatchObject({ status: "partial", stale: true });
    expect(facade.recordKartaResult("tenant-a", "user-a", REQUEST_ID, { kind: "blocked", reason: "x" })).toMatchObject({ status: "blocked" });
    expect(facade.recordKartaResult("tenant-a", "user-a", REQUEST_ID, { kind: "accepted", evidence: evidence() })).toMatchObject({ status: "blocked" });
  });

  it("isolates conversation freshness between actors in the same tenant", async () => {
    const facade = new IaoFacade({ prepare: vi.fn(async () => ({ kind: "accepted" as const, preview: "draft" })) });
    await facade.submit(request());
    const actorBIdentity = identity({
      actorId: "user-b",
      session: { ...identity().session, userId: "user-b" },
    });
    await facade.submit(request({
      requestId: "44444444-4444-4444-8444-444444444444",
      actorId: "user-b",
      identity: actorBIdentity,
    }));

    expect(facade.recordKartaResult("tenant-a", "user-a", REQUEST_ID, { kind: "accepted", evidence: evidence() }))
      .toMatchObject({ status: "verified", stale: false });
  });

  it("marks a late initial result stale when a newer request finishes first", async () => {
    const firstPending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const newerId = "44444444-4444-4444-8444-444444444444";
    const karta = { prepare: vi.fn((input: IaoRequest) => input.requestId === REQUEST_ID
      ? firstPending.promise
      : Promise.resolve({ kind: "accepted" as const, preview: "new", evidence: evidence(newerId) })) } satisfies KartaIaoPort;
    const facade = new IaoFacade(karta);

    const first = facade.submit(request());
    await expect(facade.submit(request({ requestId: newerId })))
      .resolves.toMatchObject({ status: "verified", stale: false, preview: "new" });
    firstPending.resolve({ kind: "accepted", preview: "old", evidence: evidence() });

    await expect(first).resolves.toMatchObject({ status: "partial", stale: true, preview: "old" });
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).proof).toBeUndefined();
  });

  it("marks a late initial failure stale when a newer request finishes first", async () => {
    const firstPending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const newerId = "44444444-4444-4444-8444-444444444444";
    const karta = { prepare: vi.fn((input: IaoRequest) => input.requestId === REQUEST_ID
      ? firstPending.promise
      : Promise.resolve({ kind: "accepted" as const, preview: "new", evidence: evidence(newerId) })) } satisfies KartaIaoPort;
    const facade = new IaoFacade(karta);

    const first = facade.submit(request());
    await facade.submit(request({ requestId: newerId }));
    firstPending.resolve(Promise.reject(new Error("provider failed")));

    await expect(first).resolves.toMatchObject({ status: "blocked", stale: true });
  });

  it("isolates idempotency keys between actors in the same tenant", async () => {
    const karta = { prepare: vi.fn(async () => ({ kind: "accepted" as const, preview: "draft" })) };
    const facade = new IaoFacade(karta);
    await facade.submit(request());
    const actorBIdentity = identity({
      actorId: "user-b",
      session: { ...identity().session, userId: "user-b" },
    });

    await expect(facade.submit(request({ actorId: "user-b", identity: actorBIdentity })))
      .resolves.toMatchObject({ status: "partial", requestId: REQUEST_ID });
    expect(karta.prepare).toHaveBeenCalledTimes(2);
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
    expect(smarana.buildContext).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^iao:[0-9a-f]{64}$/),
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/), tenantId: "tenant-a", actorId: "user-a",
    }));
    expect(completion.complete).toHaveBeenCalledWith(expect.objectContaining({
      requestId: REQUEST_ID, idempotencyKey: expect.stringMatching(/^iao:[0-9a-f]{64}$/),
      payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/), message: "Bonjour",
    }));
  });

  it("preserves a scoped completion idempotency key across facade reconstruction", async () => {
    const smarana = {
      buildContext: vi.fn(async () => ({ operationId: RECEIPT_ID, context: { sources: [] } })),
      control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const seen = new Set<string>();
    let computes = 0;
    const keys: string[] = [];
    const completion = { complete: vi.fn(async (input: Parameters<IaoCompletionPort["complete"]>[0]) => {
      keys.push(input.idempotencyKey);
      if (!seen.has(input.idempotencyKey)) { seen.add(input.idempotencyKey); computes += 1; }
      return { text: "réponse", modelVersion: "local/test" };
    }) } satisfies IaoCompletionPort;

    await new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request());
    await new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request());
    const actorBIdentity = identity({ actorId: "user-b", session: { ...identity().session, userId: "user-b" } });
    await new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request({ actorId: "user-b", identity: actorBIdentity }));

    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(computes).toBe(2);
  });

  it("fails closed on a conflicting payload after facade reconstruction", async () => {
    const smarana = {
      buildContext: vi.fn(async () => ({ operationId: RECEIPT_ID, context: { sources: [] } })),
      control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const durableDigests = new Map<string, string>();
    const completion = { complete: vi.fn(async (input: Parameters<IaoCompletionPort["complete"]>[0]) => {
      const known = durableDigests.get(input.idempotencyKey);
      if (known && known !== input.payloadDigest) throw new Error("memory-denied:compute-fabric-conflict");
      durableDigests.set(input.idempotencyKey, input.payloadDigest);
      return { text: `answer:${input.message}`, modelVersion: "local/test" };
    }) } satisfies IaoCompletionPort;

    const first = await new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request({ prompt: "alpha" }));
    const conflicting = await new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request({ prompt: "beta" }));

    expect(first).toMatchObject({ status: "verified", preview: "answer:alpha" });
    expect(conflicting).toMatchObject({
      status: "blocked", blocked: { reason: "KARTA request denied", dependency: "memory-denied:karta-runtime" },
    });
    expect(completion.complete).toHaveBeenCalledTimes(2);
  });

  it("fails closed before effects when a reconstructed SMARANA context payload conflicts", async () => {
    const durableDigests = new Map<string, string>();
    let effects = 0;
    const smarana = {
      buildContext: vi.fn(async (input: Parameters<SmaranaIaoPort["buildContext"]>[0]) => {
        const known = durableDigests.get(input.idempotencyKey);
        if (known && known !== input.payloadDigest) throw new Error("memory-denied:smarana-conflict");
        if (!known) { durableDigests.set(input.idempotencyKey, input.payloadDigest); effects += 1; }
        return { operationId: RECEIPT_ID, context: { sources: [] } };
      }),
      control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const completion = { complete: vi.fn(async () => ({ text: "ok", modelVersion: "local/test" })) } satisfies IaoCompletionPort;

    await expect(new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request({ prompt: "alpha" })))
      .resolves.toMatchObject({ status: "verified" });
    await expect(new IaoFacade(new KartaRuntimeIaoPort(smarana, completion)).submit(request({ prompt: "beta" })))
      .resolves.toMatchObject({ status: "blocked", blocked: { dependency: "memory-denied:karta-runtime" } });
    expect(effects).toBe(1);
    expect(completion.complete).toHaveBeenCalledTimes(1);
  });

  it("fails closed before effects when reconstructed SMARANA control data conflicts", async () => {
    const durableDigests = new Map<string, string>();
    let effects = 0;
    const smarana = {
      buildContext: vi.fn(),
      control: vi.fn(async (input: Parameters<SmaranaIaoPort["control"]>[0]) => {
        const known = durableDigests.get(input.idempotencyKey);
        if (known && known !== input.payloadDigest) throw new Error("memory-denied:smarana-conflict");
        if (!known) { durableDigests.set(input.idempotencyKey, input.payloadDigest); effects += 1; }
        return { action: input.action, operationId: RECEIPT_ID, replayed: known !== undefined };
      }),
    } satisfies SmaranaIaoPort;
    const first = request({ type: "memory-control", memoryControl: { action: "update", data: { value: "alpha" } } });
    const conflicting = request({ type: "memory-control", memoryControl: { action: "update", data: { value: "beta" } } });

    await expect(new IaoFacade(new KartaRuntimeIaoPort(smarana, { complete: vi.fn() })).submit(first))
      .resolves.toMatchObject({ status: "verified" });
    await expect(new IaoFacade(new KartaRuntimeIaoPort(smarana, { complete: vi.fn() })).submit(conflicting))
      .resolves.toMatchObject({ status: "blocked", blocked: { dependency: "memory-denied:karta-runtime" } });
    expect(effects).toBe(1);
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
    await expect(pending).resolves.toEqual({ kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:karta-runtime", effect: "uncertain" });
  });

  it("reports no effect when the context stage times out, and aborts the port on timeout", async () => {
    vi.useFakeTimers();
    const seen: AbortSignal[] = [];
    const port = new KartaRuntimeIaoPort({
      buildContext: vi.fn((input: Parameters<SmaranaIaoPort["buildContext"]>[0]) => { seen.push(input.signal!); return new Promise<never>(() => {}); }),
      control: vi.fn(),
    }, { complete: vi.fn(async () => { throw new Error("must not run"); }) }, 100);
    const pending = port.prepare(request());
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:karta-runtime", effect: "none" });
    expect(seen[0]?.aborted).toBe(true);
  });

  it("reports an uncertain effect when a durable control is cancelled mid-flight and forwards the abort", async () => {
    const seen: AbortSignal[] = [];
    const entered = deferred<void>();
    const port = new KartaRuntimeIaoPort({
      buildContext: vi.fn(),
      control: vi.fn((input: Parameters<SmaranaIaoPort["control"]>[0]) => {
        seen.push(input.signal!);
        entered.resolve();
        return new Promise<never>(() => {});
      }),
    }, { complete: vi.fn() }, 1_000);
    const controller = new AbortController();
    const pending = port.prepare(request({ type: "memory-control", memoryControl: { action: "update", data: { value: "x" } } }), controller.signal);
    await entered.promise;
    expect(seen[0]?.aborted).toBe(false);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:karta-runtime", effect: "uncertain" });
    expect(seen[0]?.aborted).toBe(true);
  });

  it("rejects immediately without dispatch when the signal is already aborted", async () => {
    const smarana = { buildContext: vi.fn(), control: vi.fn() } satisfies SmaranaIaoPort;
    const controller = new AbortController();
    controller.abort();
    await expect(new KartaRuntimeIaoPort(smarana, { complete: vi.fn() }).prepare(request(), controller.signal))
      .resolves.toMatchObject({ kind: "blocked", effect: "none" });
    expect(smarana.buildContext).not.toHaveBeenCalled();
  });

  it.each(["conversation", "memory-control"] as const)("never dispatches %s cancelled before the first microtask", async (type) => {
    const smarana = { buildContext: vi.fn(), control: vi.fn() } satisfies SmaranaIaoPort;
    const completion = { complete: vi.fn() } satisfies IaoCompletionPort;
    const controller = new AbortController();
    const pending = new KartaRuntimeIaoPort(smarana, completion).prepare(request({
      type, ...(type === "memory-control" ? { memoryControl: { action: "update" as const, data: { value: "x" } } } : {}),
    }), controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "blocked", effect: "none", dependency: "memory-unavailable:karta-runtime" });
    expect(smarana.buildContext).not.toHaveBeenCalled();
    expect(smarana.control).not.toHaveBeenCalled();
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it("reports no effect and never dispatches an already cancelled durable control", async () => {
    const smarana = { buildContext: vi.fn(), control: vi.fn() } satisfies SmaranaIaoPort;
    const completion = { complete: vi.fn() } satisfies IaoCompletionPort;
    const controller = new AbortController();
    controller.abort();
    await expect(new KartaRuntimeIaoPort(smarana, completion).prepare(request({
      type: "memory-control", memoryControl: { action: "update", data: { value: "x" } },
    }), controller.signal)).resolves.toMatchObject({ kind: "blocked", effect: "none" });
    expect(smarana.control).not.toHaveBeenCalled();
    expect(smarana.buildContext).not.toHaveBeenCalled();
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it("never dispatches completion when context returns after cancellation", async () => {
    const controller = new AbortController();
    const smarana = {
      buildContext: vi.fn(async () => {
        controller.abort();
        return { operationId: RECEIPT_ID, context: { sources: [] } };
      }), control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const completion = { complete: vi.fn() } satisfies IaoCompletionPort;
    await expect(new KartaRuntimeIaoPort(smarana, completion).prepare(request(), controller.signal))
      .resolves.toMatchObject({ kind: "blocked", effect: "none" });
    expect(smarana.buildContext).toHaveBeenCalledOnce();
    expect(completion.complete).not.toHaveBeenCalled();
  });

  it("keeps completion uncertain when cancelled after its actual dispatch", async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    let seen: AbortSignal | undefined;
    const smarana = {
      buildContext: vi.fn(async () => ({ operationId: RECEIPT_ID, context: { sources: [] } })), control: vi.fn(),
    } satisfies SmaranaIaoPort;
    const completion = { complete: vi.fn((input: Parameters<IaoCompletionPort["complete"]>[0]) => {
      seen = input.signal;
      entered.resolve();
      return new Promise<never>(() => {});
    }) } satisfies IaoCompletionPort;
    const pending = new KartaRuntimeIaoPort(smarana, completion).prepare(request(), controller.signal);
    await entered.promise;
    expect(seen?.aborted).toBe(false);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ kind: "blocked", effect: "uncertain" });
    expect(seen?.aborted).toBe(true);
    expect(completion.complete).toHaveBeenCalledOnce();
  });

  it.each([
    { action: "update", operationId: RECEIPT_ID, replayed: false, status: "failed" },
    { action: "update", operationId: RECEIPT_ID, replayed: false, internal: "private-stack-token" },
    { action: "update", operationId: RECEIPT_ID, replayed: "false" },
    { action: "export", operationId: RECEIPT_ID, replayed: true, exported: [{ pii: "secret" }] },
    { action: "export", operationId: RECEIPT_ID, replayed: false, exported: Array.from({ length: 1_001 }, () => null) },
  ])("rejects malformed SMARANA receipts without exposing their content", async (malformed) => {
    const smarana = {
      buildContext: vi.fn(),
      control: vi.fn(async () => malformed as unknown as Awaited<ReturnType<SmaranaIaoPort["control"]>>),
    } satisfies SmaranaIaoPort;
    const action = malformed.action === "export" ? "export" : "update";
    const response = await new IaoFacade(new KartaRuntimeIaoPort(smarana, { complete: vi.fn() })).submit(request({
      type: "memory-control", memoryControl: { action, data: {} },
    }));

    expect(response).toMatchObject({ status: "blocked", blocked: { reason: "KARTA is unavailable" } });
    expect(JSON.stringify(response)).not.toContain("private-stack-token");
    expect(JSON.stringify(response)).not.toContain("secret");
    expect(response.memoryControl).toBeUndefined();
  });

  it("does not redeliver a compliant export after facade reconstruction", async () => {
    let calls = 0;
    const smarana = {
      buildContext: vi.fn(),
      control: vi.fn(async () => ({
        action: "export" as const, operationId: RECEIPT_ID, replayed: calls++ > 0,
        ...(calls === 1 ? { exported: [{ pii: "one-shot" }] } : {}),
      })),
    } satisfies SmaranaIaoPort;
    const input = request({ type: "memory-control", memoryControl: { action: "export", data: {} } });

    const first = await new IaoFacade(new KartaRuntimeIaoPort(smarana, { complete: vi.fn() })).submit(input);
    const replayed = await new IaoFacade(new KartaRuntimeIaoPort(smarana, { complete: vi.fn() })).submit(input);

    expect(first.memoryControl?.exported).toEqual([{ pii: "one-shot" }]);
    expect(replayed).toMatchObject({ status: "verified", memoryControl: { replayed: true } });
    expect(replayed.memoryControl?.exported).toBeUndefined();
  });
});

describe("IAO HTTP contract", () => {
  function responseSink() {
    const state: { status?: number; body?: unknown } = {};
    return {
      state,
      res: { setHeader() {}, writeHead(status: number) { state.status = status; }, end(body: string) { state.body = JSON.parse(body); } } as unknown as ServerResponse,
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
      { facade, authenticator: { authenticate: async () => identity({ tenantId: "tenant-b", actorId: "user-b", session: { ...identity().session, tenantId: "tenant-b", userId: "user-b" } }) } }, async () => ({}), foreign.sendJson);
    expect(foreign.state).toEqual({ status: 404, body: { error: "IAO request not found" } });
  });

  it("cancels through POST /iao/requests/:id/cancel scoped to the authenticated actor", async () => {
    const pending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const facade = new IaoFacade({ prepare: vi.fn(() => pending.promise) });
    const submitted = facade.submit(request());
    const own = responseSink();
    await handleIaoRoute({ method: "POST", url: `/iao/requests/${REQUEST_ID}/cancel` } as IncomingMessage, own.res,
      { facade, authenticator: { authenticate: async () => identity() } }, async () => ({}), own.sendJson);
    expect(own.state.status).toBe(200);
    expect(own.state.body).toMatchObject({ status: "cancelled", effect: "uncertain" });

    const foreign = responseSink();
    await handleIaoRoute({ method: "POST", url: `/iao/requests/${REQUEST_ID}/cancel` } as IncomingMessage, foreign.res,
      { facade, authenticator: { authenticate: async () => identity({ actorId: "user-b", session: { ...identity().session, userId: "user-b" } }) } }, async () => ({}), foreign.sendJson);
    expect(foreign.state).toEqual({ status: 404, body: { error: "IAO request not found" } });
    pending.resolve({ kind: "accepted", preview: "late" });
    await expect(submitted).resolves.toMatchObject({ status: "cancelled" });
  });
});

describe("IAO cancellation and leases", () => {
  it("cancels a pending request, aborts KARTA, and stays terminal when the late result lands", async () => {
    const pending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const signals: AbortSignal[] = [];
    const facade = new IaoFacade({ prepare: vi.fn((_input: IaoRequest, signal?: AbortSignal) => { signals.push(signal!); return pending.promise; }) });
    const submitted = facade.submit(request());

    const cancelled = facade.cancel("tenant-a", "user-a", REQUEST_ID);
    expect(cancelled).toMatchObject({ status: "cancelled", effect: "uncertain" });
    expect(signals[0]?.aborted).toBe(true);
    expect(facade.cancel("tenant-a", "user-a", REQUEST_ID)).toMatchObject({ status: "cancelled", effect: "uncertain" });

    pending.resolve({ kind: "accepted", preview: "late", evidence: evidence() });
    const late = await submitted;
    expect(late).toMatchObject({ status: "cancelled", effect: "executed", proof: { proofId: RECEIPT_ID } });
    expect(late.preview).toBeUndefined();
    expect(facade.get("tenant-a", "user-a", REQUEST_ID)).toMatchObject({ status: "cancelled", effect: "executed" });
  });

  it("refines the effect to none when KARTA confirms the interruption happened before any effect", async () => {
    const pending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const facade = new IaoFacade({ prepare: vi.fn(() => pending.promise) });
    const submitted = facade.submit(request());
    facade.cancel("tenant-a", "user-a", REQUEST_ID);
    pending.resolve({ kind: "blocked", reason: "KARTA is unavailable", dependency: "memory-unavailable:cancelled", effect: "none" });
    await expect(submitted).resolves.toMatchObject({ status: "cancelled", effect: "none" });
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).blocked).toBeUndefined();
  });

  it("records a late durable receipt on a cancelled control without redelivering export content", async () => {
    const pending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const facade = new IaoFacade({ prepare: vi.fn(() => pending.promise) });
    const submitted = facade.submit(request({ type: "memory-control", memoryControl: { action: "export", data: {} } }));
    facade.cancel("tenant-a", "user-a", REQUEST_ID);
    pending.resolve({
      kind: "accepted", evidence: evidence(),
      memoryControl: { action: "export", operationId: RECEIPT_ID, replayed: false, exported: [{ private: "forfeited" }] },
    });
    const late = await submitted;
    expect(late).toMatchObject({ status: "cancelled", effect: "executed", memoryControl: { action: "export", operationId: RECEIPT_ID } });
    expect(JSON.stringify(late)).not.toContain("forfeited");
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).memoryControl?.exported).toBeUndefined();
  });

  it("keeps verified and blocked requests immutable under cancel", async () => {
    const facade = new IaoFacade({ prepare: vi.fn(async () => ({ kind: "accepted" as const, preview: "ok", evidence: evidence() })) });
    await facade.submit(request());
    expect(facade.cancel("tenant-a", "user-a", REQUEST_ID)).toMatchObject({ status: "verified", proof: { proofId: RECEIPT_ID } });
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).effect).toBeUndefined();
  });

  it("surfaces timeout effect knowledge on blocked responses", async () => {
    const facade = new IaoFacade({ prepare: vi.fn(async () => ({
      kind: "blocked" as const, reason: "KARTA is unavailable", dependency: "memory-unavailable:timeout", effect: "uncertain" as const,
    })) });
    await expect(facade.submit(request({ type: "memory-control", memoryControl: { action: "update", data: {} } })))
      .resolves.toMatchObject({ status: "blocked", effect: "uncertain", blocked: { dependency: "memory-unavailable:karta-runtime" } });
  });

  it("stamps updatedAt as an ISO timestamp that moves on every transition", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T00:00:00.000Z") });
    const pending = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const facade = new IaoFacade({ prepare: vi.fn(() => pending.promise) });
    const submitted = facade.submit(request());
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).updatedAt).toBe("2026-10-12T00:00:00.000Z");
    vi.setSystemTime(new Date("2026-10-12T00:00:05.000Z"));
    pending.resolve({ kind: "accepted", preview: "ok", evidence: evidence() });
    expect((await submitted).updatedAt).toBe("2026-10-12T00:00:05.000Z");
  });

  it("evicts terminal requests after retention but never a pending one", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-12T00:00:00.000Z") });
    const hanging = deferred<Awaited<ReturnType<KartaIaoPort["prepare"]>>>();
    const pendingId = "44444444-4444-4444-8444-444444444444";
    const karta = { prepare: vi.fn((input: IaoRequest) => input.requestId === pendingId
      ? hanging.promise
      : Promise.resolve({ kind: "accepted" as const, preview: "ok", evidence: evidence() })) } satisfies KartaIaoPort;
    const facade = new IaoFacade(karta, { retentionMs: 1_000 });
    await facade.submit(request());
    void facade.submit(request({ requestId: pendingId, identity: identity({ session: { ...identity().session, issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 10 * 60_000 } }) }));
    expect(facade.get("tenant-a", "user-a", REQUEST_ID).status).toBe("verified");

    vi.setSystemTime(new Date("2026-10-12T00:00:01.500Z"));
    expect(() => facade.get("tenant-a", "user-a", REQUEST_ID)).toThrow("IAO request not found");
    expect(facade.get("tenant-a", "user-a", pendingId).status).toBe("draft");
    expect(karta.prepare).toHaveBeenCalledTimes(2);

    await expect(facade.submit(request())).resolves.toMatchObject({ status: "verified" });
    expect(karta.prepare).toHaveBeenCalledTimes(3);
    hanging.resolve({ kind: "accepted", preview: "done" });
  });

  it("bounds retained requests by evicting the oldest terminal entries first", async () => {
    const facade = new IaoFacade({ prepare: vi.fn(async (input: IaoRequest) => ({ kind: "accepted" as const, preview: "ok", evidence: evidence(input.requestId) })) }, { maxRequests: 2 });
    const ids = ["11111111-1111-4111-8111-111111111111", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
    for (const requestId of ids) await facade.submit(request({ requestId }));
    expect(() => facade.get("tenant-a", "user-a", ids[0]!)).toThrow("IAO request not found");
    expect(facade.get("tenant-a", "user-a", ids[2]!).status).toBe("verified");
  });

  it("rejects out-of-range lease options", () => {
    expect(() => new IaoFacade({ prepare: vi.fn() }, { retentionMs: 10 })).toThrow("Invalid IAO facade options");
    expect(() => new IaoFacade({ prepare: vi.fn() }, { maxRequests: 0 })).toThrow("Invalid IAO facade options");
  });
});
