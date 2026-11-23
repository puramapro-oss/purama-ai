import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleIaoRoute } from "../src/api/iaoRoutes.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoResult } from "../src/iao/iaoFacade.js";

const id = "11111111-1111-4111-8111-111111111111";
const body = { type: "conversation", requestId: id, conversationId: "conversation", prompt: "test" };

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }); });
afterEach(() => { try { expect(vi.getTimerCount()).toBe(0); } finally { vi.useRealTimers(); } });

function identity(): IaoServerIdentity {
  const now = Date.now();
  return { tenantId: "tenant", actorId: "actor", session: { tenantId: "tenant", userId: "actor",
    sessionId: "22222222-2222-4222-8222-222222222222", appSlug: "purama-ai", issuedAt: now - 1000, expiresAt: now + 60_000 } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function response(): ServerResponse {
  return { setHeader: vi.fn(), setTimeout: vi.fn(), socket: { timeout: 15_000 } } as unknown as ServerResponse;
}

it.each(["readiness", "authentication", "body", "final-readiness"] as const)(
  "expires %s before admission and ignores its late result", async blockedStage => {
    const blocked = deferred<void>();
    const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "must not run" }));
    const facade = new IaoFacade({ prepare });
    const authenticate = vi.fn(async () => {
      if (blockedStage === "authentication") await blocked.promise;
      return identity();
    });
    const readBody = vi.fn(async () => {
      if (blockedStage === "body") await blocked.promise;
      return body;
    });
    let probes = 0;
    const canAdmit = vi.fn(async () => {
      probes++;
      if ((blockedStage === "readiness" && probes === 1) || (blockedStage === "final-readiness" && probes === 2)) await blocked.promise;
      return true;
    });
    const res = response();
    const sendJson = vi.fn();
    let settled = false;
    const pending = handleIaoRoute({ method: "POST", url: "/iao/requests" } as IncomingMessage,
      res, { facade, authenticator: { authenticate } }, readBody, sendJson, { isActive: () => true, canAdmit });
    void pending.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(sendJson).toHaveBeenCalledExactlyOnceWith(res, 503, { error: "IAO runtime unavailable" });
      expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      blocked.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(prepare).not.toHaveBeenCalled();
      expect(sendJson).toHaveBeenCalledOnce();
    } finally {
      blocked.resolve();
      await pending;
    }
  },
);

it.each(["lookup", "cancel"] as const)("expires %s authentication without late facade access", async operation => {
  const claims = identity();
  const facade = new IaoFacade({ prepare: async () => ({ kind: "accepted", preview: "private" }) });
  await facade.submit({ ...body, type: "conversation", tenantId: claims.tenantId, actorId: claims.actorId, identity: claims });
  const access = vi.spyOn(facade, operation === "lookup" ? "get" : "cancel");
  const blocked = deferred<IaoServerIdentity>();
  const res = response();
  const sendJson = vi.fn();
  let settled = false;
  const pending = handleIaoRoute({ method: operation === "lookup" ? "GET" : "POST",
    url: "/iao/requests/" + id + (operation === "cancel" ? "/cancel" : "") } as IncomingMessage,
    res, { facade, authenticator: { authenticate: () => blocked.promise } }, async () => body, sendJson);
  void pending.then(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(true);
    expect(sendJson).toHaveBeenCalledExactlyOnceWith(res, 503, { error: "IAO runtime unavailable" });
    blocked.resolve(identity());
    await vi.advanceTimersByTimeAsync(0);
    expect(access).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledOnce();
  } finally {
    blocked.resolve(identity());
    await pending;
  }
});

it("shares the 15-second admission deadline across successive waits", async () => {
  const pause = () => new Promise<void>(resolve => { setTimeout(resolve, 6_000); });
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "must not run" }));
  const facade = new IaoFacade({ prepare });
  const res = response();
  const sendJson = vi.fn();
  let settled = false;
  const pending = handleIaoRoute({ method: "POST", url: "/pura/requests" } as IncomingMessage, res,
    { facade, authenticator: { authenticate: async () => { await pause(); return identity(); } } },
    async () => { await pause(); return body; }, sendJson,
    { isActive: () => true, canAdmit: async () => { await pause(); return true; } });
  void pending.then(() => { settled = true; });
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    expect(settled).toBe(true);
    expect(sendJson).toHaveBeenCalledExactlyOnceWith(res, 503, { error: "IAO runtime unavailable" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(prepare).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledOnce();
  } finally {
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
  }
});

it("checks the monotonic deadline after synchronous port metadata before dispatch", async () => {
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "must not run" }));
  const facade = new IaoFacade({ prepare, executionBudgetMs: () => { vi.advanceTimersByTime(15_000); return 240_000; } });
  const res = response();
  const sendJson = vi.fn();
  await handleIaoRoute({ method: "POST", url: "/iao/requests" } as IncomingMessage,
    res, { facade, authenticator: { authenticate: async () => identity() } }, async () => body, sendJson);
  expect(sendJson).toHaveBeenCalledExactlyOnceWith(res, 503, { error: "IAO runtime unavailable" });
  expect(prepare).not.toHaveBeenCalled();
});

it("releases admission timers before awaiting work already admitted", async () => {
  const completion = deferred<KartaIaoResult>();
  const prepare = vi.fn((_request: unknown, _signal?: AbortSignal) => completion.promise);
  const facade = new IaoFacade({ prepare, executionBudgetMs: () => 240_000 });
  const res = response();
  const sendJson = vi.fn();
  const pending = handleIaoRoute({ method: "POST", url: "/iao/requests" } as IncomingMessage,
    res, { facade, authenticator: { authenticate: async () => identity() } }, async () => body, sendJson);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendJson).not.toHaveBeenCalled();
    expect(prepare.mock.calls[0]?.[1]?.aborted).toBe(false);
    completion.resolve({ kind: "accepted", preview: "finished" });
    await pending;
    expect(sendJson).toHaveBeenCalledExactlyOnceWith(res, 202, expect.objectContaining({ preview: "finished" }));
  } finally {
    completion.resolve({ kind: "accepted", preview: "finished" });
    await pending;
  }
});
