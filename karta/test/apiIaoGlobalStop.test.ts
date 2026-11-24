import { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.js";
import { setGlobalKillSwitch } from "../src/engine/killswitch.js";
import { IaoFacade, type IaoServerIdentity, type KartaIaoResult } from "../src/iao/iaoFacade.js";
import type { RuntimeReadiness } from "../src/runtime/lifecycle.js";

vi.mock("../src/config.js", () => ({ config: { port: 0, adminToken: "test-only-admin", mockClaude: true } }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {} }));
vi.mock("../src/queue/queues.js", () => ({ enqueueAgentCycle: vi.fn() }));
vi.mock("../src/agents/index.js", () => ({ AGENT_REGISTRY: {} }));
vi.mock("../src/agents/customAgent.js", () => ({ loadCustomAgent: vi.fn() }));
vi.mock("../src/engine/approval.js", () => ({ resolvePendingAction: vi.fn() }));
vi.mock("../src/engine/killswitch.js", () => ({ setGlobalKillSwitch: vi.fn() }));

const ID = "11111111-1111-4111-8111-111111111111";
const BODY = { type: "conversation" as const, requestId: ID, conversationId: "conversation", prompt: "authorized work" };

function identity(): IaoServerIdentity {
  const now = Date.now();
  return { tenantId: "tenant", actorId: "actor", session: { tenantId: "tenant", userId: "actor",
    sessionId: "22222222-2222-4222-8222-222222222222", appSlug: "purama-ai", issuedAt: now - 1_000, expiresAt: now + 60_000 } };
}

function readiness(stopped: boolean): RuntimeReadiness {
  return { ready: true, phase: "ready", globalKillSwitch: stopped };
}

beforeEach(() => {
  // Exercise the real server request listener without binding a port. No HTTP
  // client, provider, database or network listener is created by this harness.
  vi.spyOn(Server.prototype, "listen").mockImplementation(function (this: Server) { return this; });
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function harness(probe: () => Promise<RuntimeReadiness>, auth = async () => identity()) {
  const prepare = vi.fn(async (): Promise<KartaIaoResult> => ({ kind: "accepted", preview: "retained result" }));
  const facade = new IaoFacade({ prepare });
  const authenticate = vi.fn(auth);
  const server = startApiServer(probe, { consultationHost: null, iaoRuntime: { facade, authenticator: { authenticate } } });
  expect(server.listening).toBe(false);
  return { server, prepare, facade, authenticate };
}

async function call(h: ReturnType<typeof harness>, path: string, method = "POST", body: unknown = BODY,
  headers: Record<string, string> = {}) {
  const req = new IncomingMessage(new Socket());
  req.method = method; req.url = path;
  req.headers = headers;
  if (method === "POST" && !path.endsWith("/cancel") && body !== undefined) req.push(Buffer.from(JSON.stringify(body)));
  // The HTTP parser marks a fully received request complete before EOF. Without
  // this flag IncomingMessage correctly treats synthetic EOF as an aborted body.
  req.complete = true;
  req.push(null);
  const res = new ServerResponse(req);
  const end = vi.spyOn(res, "end");
  h.server.emit("request", req, res);
  await h.server.drainRequests();
  expect(end).toHaveBeenCalledOnce();
  const raw = end.mock.calls[0]?.[0];
  return { status: res.statusCode, cache: res.getHeader("Cache-Control"), body: JSON.parse(String(raw)) as Record<string, unknown> };
}

describe("IAO admission under the existing global stop", () => {
  it.each(["/iao/requests", "/pura/requests"])("refuses new work when the stop is already active on %s", async path => {
    const probe = vi.fn(async () => readiness(true));
    const h = harness(probe);
    expect(await call(h, path)).toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it.each(["/iao/requests", "/pura/requests"])("refuses a stop observed at the final admission probe on %s", async path => {
    const probe = vi.fn<() => Promise<RuntimeReadiness>>()
      .mockResolvedValueOnce(readiness(false)).mockResolvedValue(readiness(true));
    const h = harness(probe);
    expect(await call(h, path)).toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.authenticate).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "missing", state: { ready: true, phase: "ready" } },
    { label: "null", state: { ready: true, phase: "ready", globalKillSwitch: null } },
    { label: "numeric zero", state: { ready: true, phase: "ready", globalKillSwitch: 0 } },
    { label: "string false", state: { ready: true, phase: "ready", globalKillSwitch: "false" } },
  ])("refuses new work when the stop state is $label", async ({ state }) => {
    // Corrupt/older providers must not open admission through falsey coercion.
    const h = harness(async () => state as unknown as RuntimeReadiness);
    expect(await call(h, "/iao/requests")).toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it.each(["/iao/requests", "/pura/requests"])("blocks memory-control at the final stop probe on %s", async path => {
    const probe = vi.fn<() => Promise<RuntimeReadiness>>()
      .mockResolvedValueOnce(readiness(false)).mockResolvedValue(readiness(true));
    const h = harness(probe);
    const memoryBody = { ...BODY, type: "memory-control", prompt: "", memoryControl: { action: "export", data: {} } };
    expect(await call(h, path, "POST", memoryBody))
      .toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.authenticate).toHaveBeenCalledOnce();
  });

  it("allows an authenticated administrator to clear the active global stop", async () => {
    vi.mocked(setGlobalKillSwitch).mockClear();
    const h = harness(async () => readiness(true));
    expect(await call(h, "/kill-switch/global", "POST", { active: false }, { authorization: "Bearer test-only-admin" }))
      .toMatchObject({ status: 200, body: { ok: true, active: false } });
    expect(setGlobalKillSwitch).toHaveBeenCalledExactlyOnceWith(false);
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it("admits work while the global stop is inactive", async () => {
    const h = harness(async () => readiness(false));
    expect(await call(h, "/iao/requests")).toMatchObject({ status: 202, cache: "no-store", body: { preview: "retained result" } });
    expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.authenticate).toHaveBeenCalledTimes(2);
  });

  it("keeps authenticated lookup and cancellation available during the global stop", async () => {
    const probe = vi.fn(async () => readiness(true));
    const h = harness(probe);
    const claims = identity();
    await h.facade.submit({ ...BODY, tenantId: claims.tenantId, actorId: claims.actorId, identity: claims });
    expect(await call(h, "/iao/requests/" + ID, "GET", undefined))
      .toMatchObject({ status: 200, cache: "no-store", body: { status: "partial", preview: "retained result" } });
    expect(await call(h, "/iao/requests/" + ID + "/cancel", "POST", undefined))
      .toMatchObject({ status: 200, cache: "no-store", body: { status: "cancelled" } });
    expect(probe).not.toHaveBeenCalled();
    expect(h.authenticate).toHaveBeenCalledTimes(2);
    expect(h.prepare).toHaveBeenCalledOnce();
  });

  it("reports a deliberate stop as healthy dependencies rather than a dependency outage", async () => {
    const h = harness(async () => readiness(true));
    expect(await call(h, "/health", "GET", undefined))
      .toMatchObject({ status: 200, body: { ready: true, globalKillSwitch: true, status: "ok" } });
    expect(h.prepare).not.toHaveBeenCalled();
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it("keeps the original admission deadline while the final stop probe is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let release!: (state: RuntimeReadiness) => void;
    let entered!: () => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const probe = vi.fn<() => Promise<RuntimeReadiness>>().mockResolvedValueOnce(readiness(false))
      .mockImplementation(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    const h = harness(probe, async () => { vi.advanceTimersByTime(10_000); return identity(); });
    let settled = false;
    const result = call(h, "/iao/requests").then(value => { settled = true; return value; });
    await checking;
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).toBe(false);
      expect(h.prepare).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toEqual({ status: 503, cache: "no-store", body: { error: "IAO runtime unavailable" } });
      release(readiness(true));
      await Promise.resolve();
      expect(h.prepare).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { release(readiness(true)); await result; }
  });
});
