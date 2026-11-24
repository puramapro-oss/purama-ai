import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleIaoRoute, IaoAuthenticationError } from "../src/api/iaoRoutes.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoResult } from "../src/iao/iaoFacade.js";

const ID = "11111111-1111-4111-8111-111111111111";
const BODY = { type: "conversation", requestId: ID, conversationId: "conversation", prompt: "perform the authorized request" };

function identity(): IaoServerIdentity {
  return { tenantId: "tenant-a", actorId: "actor-a", session: { sessionId: "22222222-2222-4222-8222-222222222222",
    tenantId: "tenant-a", userId: "actor-a", appSlug: "purama-ai", issuedAt: Date.now() - 1_000, expiresAt: Date.now() + 60_000 } };
}

function harness(url = "/iao/requests") {
  const req = { method: "POST", url, aborted: false } as IncomingMessage;
  const res = { setHeader: vi.fn(), setTimeout: vi.fn(), socket: { timeout: 15_000 } } as unknown as ServerResponse;
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "authorized result" }));
  return { req, res, prepare, facade: new IaoFacade({ prepare }), send: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

afterEach(() => { vi.useRealTimers(); });

describe("current IAO authorization at dispatch", () => {
  it.each(["/iao/requests", "/pura/requests"])("rejects a session revoked while reading the body on %s", async url => {
    const h = harness(url); const trusted = identity(); let revoked = false;
    const authenticate = vi.fn(async () => { if (revoked) throw new IaoAuthenticationError(); return trusted; });
    await handleIaoRoute(h.req, h.res, { facade: h.facade, authenticator: { authenticate } },
      async () => { revoked = true; return BODY; }, h.send,
      { isActive: () => true, canAdmit: async () => true });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(h.res, 401, { error: "IAO authentication required" });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it.each(["/iao/requests", "/pura/requests"])("rejects revocation during the final readiness wait on %s", async url => {
    const h = harness(url); const trusted = identity(); let revoked = false; let probes = 0;
    const authenticate = vi.fn(async () => { if (revoked) throw new IaoAuthenticationError(); return trusted; });
    await handleIaoRoute(h.req, h.res, { facade: h.facade, authenticator: { authenticate } }, async () => BODY, h.send,
      { isActive: () => true, canAdmit: async () => { if (++probes === 2) revoked = true; return true; } });
    expect(h.send).toHaveBeenCalledExactlyOnceWith(h.res, 401, { error: "IAO authentication required" });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it.each(["tenant", "actor", "session"] as const)("does not rebind a validated request to a changed %s", async field => {
    const h = harness(); const trusted = identity();
    const changed: IaoServerIdentity = field === "tenant"
      ? { ...trusted, tenantId: "tenant-b", session: { ...trusted.session, tenantId: "tenant-b" } }
      : field === "actor" ? { ...trusted, actorId: "actor-b", session: { ...trusted.session, userId: "actor-b" } }
        : { ...trusted, session: { ...trusted.session, sessionId: "33333333-3333-4333-8333-333333333333" } };
    let read = false;
    await handleIaoRoute(h.req, h.res, { facade: h.facade, authenticator: { authenticate: async () => read ? changed : trusted } },
      async () => { read = true; return BODY; }, h.send);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(h.res, 401, { error: "IAO authentication required" });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("retains the same admission deadline when final authentication stalls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const h = harness(); const trusted = identity(); const finalAuth = deferred<IaoServerIdentity>(); let read = false;
    const work = handleIaoRoute(h.req, h.res, { facade: h.facade, authenticator: { authenticate: async () => read ? finalAuth.promise : trusted } },
      async () => { vi.advanceTimersByTime(10_000); read = true; return BODY; }, h.send);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(h.prepare).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(h.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(h.send).toHaveBeenCalledExactlyOnceWith(h.res, 503, { error: "IAO runtime unavailable" });
      finalAuth.resolve(trusted); await work;
      expect(h.prepare).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { finalAuth.resolve(trusted); await work; }
  });

  it("does not dispatch after the client disconnects during final authentication", async () => {
    const h = harness(); const trusted = identity(); let read = false;
    await handleIaoRoute(h.req, h.res, { facade: h.facade, authenticator: { authenticate: async () => {
      if (read) h.req.aborted = true;
      return trusted;
    } } }, async () => { read = true; return BODY; }, h.send);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(h.res, 503, { error: "IAO runtime unavailable" });
    expect(h.prepare).not.toHaveBeenCalled();
  });

  it("preserves an unchanged authorized request and releases admission timers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const h = harness(); const trusted = identity();
    await handleIaoRoute(h.req, h.res, { facade: h.facade, authenticator: { authenticate: async () => trusted } },
      async () => BODY, h.send, { isActive: () => true, canAdmit: async () => true });
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.send).toHaveBeenCalledExactlyOnceWith(h.res, 202, expect.objectContaining({ preview: "authorized result" }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
