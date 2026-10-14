import http from "node:http";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IaoFacade, type IaoRequest } from "../src/iao/iaoFacade.js";
import { KartaRuntimeIaoPort, type IaoCompletionPort, type SmaranaIaoPort } from "../src/iao/kartaRuntimePort.js";
import { LocalComputeFabricProvider } from "../src/integrations/localComputeFabricProvider.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function socketServer(handler: http.RequestListener) {
  // Short path: macOS limits Unix socket addresses to 104 bytes.
  const directory = await mkdtemp(join(tmpdir(), "iao-c-"));
  const socketPath = join(directory, "fabric.sock");
  const server = http.createServer(handler);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

function completionInput(signal?: AbortSignal): Parameters<IaoCompletionPort["complete"]>[0] {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    idempotencyKey: `iao:${"a".repeat(64)}`, payloadDigest: "b".repeat(64),
    message: "Bonjour", context: { sources: [] }, signal,
  };
}

function attestedResponse(input = completionInput(), text = "local answer") {
  return {
    text, engine: "fixture", model: "local", protocol_version: 2,
    idempotency_key: input.idempotencyKey, payload_digest: input.payloadDigest,
    execution: {
      locality: "local_only", paid_fallback_used: false,
      accepted_max_tokens: 1024, accepted_concurrency: 1,
    },
  };
}

function request(): IaoRequest {
  return {
    type: "conversation", requestId: completionInput().requestId,
    tenantId: "tenant-a", actorId: "actor-a", conversationId: "conversation-a", prompt: "Bonjour",
    identity: {
      tenantId: "tenant-a", actorId: "actor-a",
      session: {
        sessionId: "22222222-2222-4222-8222-222222222222", tenantId: "tenant-a", userId: "actor-a",
        appSlug: "purama-ai", issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000,
      },
    },
  };
}

function memory(): SmaranaIaoPort {
  return {
    buildContext: vi.fn(async () => ({
      operationId: "33333333-3333-4333-8333-333333333333", context: { sources: [] },
    })),
    control: vi.fn(),
  };
}

describe("IAO cancellation through the real local Unix transport", () => {
  it("rejects an already cancelled request before creating any HTTP request", async () => {
    const dispatch = vi.spyOn(http, "request");
    const controller = new AbortController();
    controller.abort(new Error("private-cancellation-reason"));
    await expect(new LocalComputeFabricProvider({ socketPath: "/private/tmp/absent-iao.sock" })
      .complete(completionInput(controller.signal))).rejects.toThrow("memory-unavailable:cancelled");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([false, true])("closes an in-flight socket on cancellation (streaming=%s)", async (streaming) => {
    const received = deferred<void>();
    let disconnected = false;
    const socketPath = await socketServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.on("close", () => { disconnected = true; });
        if (streaming) res.write('{"text":"unfinished');
        received.resolve();
      });
    });
    const controller = new AbortController();
    const pending = new LocalComputeFabricProvider({ socketPath, timeoutMs: 2000 })
      .complete(completionInput(controller.signal)).catch((error: unknown) => error);
    await received.promise;
    controller.abort(new Error("private-cancellation-reason"));
    await expect.poll(() => disconnected, { timeout: 500 }).toBe(true);
    expect(await pending).toEqual(new Error("memory-unavailable:cancelled"));
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("stops a cancellable fixture-daemon computation after the client disconnects", async () => {
    const started = deferred<void>();
    let ticks = 0;
    let stopped = false;
    const socketPath = await socketServer((req, res) => {
      req.resume();
      req.on("end", () => {
        const computation = setInterval(() => { ticks++; }, 5);
        res.on("close", () => {
          clearInterval(computation);
          stopped = true;
        });
        started.resolve();
      });
    });
    const controller = new AbortController();
    const pending = new LocalComputeFabricProvider({ socketPath, timeoutMs: 2000 })
      .complete(completionInput(controller.signal)).catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    expect(await pending).toEqual(new Error("memory-unavailable:cancelled"));
    await expect.poll(() => stopped, { timeout: 500 }).toBe(true);
    const ticksAtStop = ticks;
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBe(ticksAtStop);
  });

  it("closes the transport when the shorter KARTA deadline expires", async () => {
    let disconnected = false;
    let calls = 0;
    const socketPath = await socketServer((req, res) => {
      calls++;
      req.resume();
      res.on("close", () => { disconnected = true; });
      res.write(" ");
    });
    const facade = new IaoFacade(new KartaRuntimeIaoPort(memory(),
      new LocalComputeFabricProvider({ socketPath, timeoutMs: 2000 }), 100));
    const input = request();
    expect(await facade.submit(input)).toMatchObject({ status: "blocked", effect: "uncertain" });
    await expect.poll(() => disconnected, { timeout: 500 }).toBe(true);
    expect(await facade.submit(input)).toMatchObject({ status: "blocked", effect: "uncertain" });
    expect(calls).toBe(1);
  });

  it("cancels the full IAO path, fences late output and replays without resending", async () => {
    const received = deferred<http.ServerResponse>();
    let disconnected = false;
    let calls = 0;
    const socketPath = await socketServer((req, res) => {
      calls++;
      req.resume();
      req.on("end", () => {
        res.on("close", () => { disconnected = true; });
        received.resolve(res);
      });
    });
    const facade = new IaoFacade(new KartaRuntimeIaoPort(memory(),
      new LocalComputeFabricProvider({ socketPath, timeoutMs: 2000 })));
    const input = request();
    const pending = facade.submit(input);
    const response = await received.promise;
    expect(() => facade.cancel(input.tenantId, "another-actor", input.requestId)).toThrow("IAO request not found");
    expect(facade.cancel(input.tenantId, input.actorId, input.requestId)).toMatchObject({ status: "cancelled", effect: "uncertain" });
    expect(await pending).toMatchObject({ status: "cancelled", effect: "uncertain" });
    await expect.poll(() => disconnected, { timeout: 500 }).toBe(true);
    response.end(JSON.stringify({ text: "late answer" }));
    const replay = await facade.submit(input);
    expect(replay).toMatchObject({ status: "cancelled", effect: "uncertain" });
    expect(replay.preview).toBeUndefined();
    expect(replay.proof).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("does not dispatch to the fabric after SMARANA denies permission", async () => {
    const dispatch = vi.spyOn(http, "request");
    const smarana = memory();
    smarana.buildContext = vi.fn(async () => { throw new Error("memory-denied:consent"); });
    const facade = new IaoFacade(new KartaRuntimeIaoPort(smarana, new LocalComputeFabricProvider()));
    expect(await facade.submit(request())).toMatchObject({ status: "blocked", blocked: { dependency: "memory-denied:karta-runtime" } });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains scoped identity and fixed local budgets when the caller reconstructs KARTA", async () => {
    const bodies: Record<string, unknown>[] = [];
    const socketPath = await socketServer((req, res) => {
      expect(req.url).toBe("/v1/complete");
      expect(req.method).toBe("POST");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        bodies.push(parsed);
        res.end(JSON.stringify(attestedResponse({
          ...completionInput(),
          idempotencyKey: String(parsed.idempotency_key),
          payloadDigest: String(parsed.payload_digest),
        })));
      });
    });
    const input = request();
    // Client-like extra properties cannot configure the privileged server adapter.
    const supplied = { ...input, socketPath: "https://paid.invalid", max_tokens: 1_000_000, concurrency: 100 };
    for (let attempt = 0; attempt < 2; attempt++) {
      const facade = new IaoFacade(new KartaRuntimeIaoPort(memory(), new LocalComputeFabricProvider({ socketPath })));
      expect(await facade.submit(supplied)).toMatchObject({ status: "verified", preview: "local answer" });
    }
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      idempotency_key: expect.stringMatching(/^iao:[0-9a-f]{64}$/), payload_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      kind: "memory", difficulty: 4, concurrency: 1, max_tokens: 1024,
    });
    expect(JSON.stringify(bodies)).not.toContain("paid.invalid");
    // This proves stable retry identity, not daemon-side durable deduplication.
  });

  it.each([302, 429, 500])("does not redirect, retry or fall back on HTTP %s", async (status) => {
    const dispatch = vi.spyOn(http, "request");
    const socketPath = await socketServer((_req, res) => {
      res.writeHead(status, { location: "https://paid.invalid/v1/complete" });
      res.end(JSON.stringify({ text: "must not accept" }));
    });
    const controller = new AbortController();
    await expect(new LocalComputeFabricProvider({ socketPath }).complete(completionInput(controller.signal)))
      .rejects.toThrow("memory-unavailable:compute-fabric");
    await nextTurn();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ socketPath });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("releases cancellation listeners after success and ignores a later abort", async () => {
    const socketPath = await socketServer((_req, res) => res.end(JSON.stringify(attestedResponse(completionInput(), "done"))));
    const controller = new AbortController();
    const provider = new LocalComputeFabricProvider({ socketPath });
    const result = await provider.complete(completionInput(controller.signal));
    await nextTurn();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    controller.abort();
    expect(result.text).toBe("done");
  });

  it("closes a truncated response without accepting partial output or retrying", async () => {
    const dispatch = vi.spyOn(http, "request");
    const socketPath = await socketServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write('{"text":"partial');
      setImmediate(() => res.destroy());
    });
    const controller = new AbortController();
    await expect(new LocalComputeFabricProvider({ socketPath }).complete(completionInput(controller.signal)))
      .rejects.toThrow("memory-unavailable:compute-fabric");
    await nextTurn();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("handles an abort immediately after dispatch starts without sending a request", async () => {
    let calls = 0;
    const socketPath = await socketServer((_req, res) => { calls++; res.end(JSON.stringify(attestedResponse(completionInput(), "too late"))); });
    const controller = new AbortController();
    const pending = new LocalComputeFabricProvider({ socketPath })
      .complete(completionInput(controller.signal)).catch((error: unknown) => error);
    controller.abort();
    expect(await pending).toEqual(new Error("memory-unavailable:cancelled"));
    await nextTurn();
    expect(calls).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("isolates cancellation between concurrent requests on one provider", async () => {
    const received = deferred<void>();
    let disconnected = false;
    let calls = 0;
    const socketPath = await socketServer((req, res) => {
      calls++;
      req.resume();
      if (calls === 1) {
        res.on("close", () => { disconnected = true; });
        req.on("end", () => received.resolve());
      } else res.end(JSON.stringify(attestedResponse({ ...completionInput(), idempotencyKey: `iao:${"c".repeat(64)}` }, "other request succeeded")));
    });
    const controller = new AbortController();
    const provider = new LocalComputeFabricProvider({ socketPath, timeoutMs: 2000 });
    const interrupted = provider.complete(completionInput(controller.signal)).catch((error: unknown) => error);
    await received.promise;
    const other = provider.complete({ ...completionInput(), idempotencyKey: `iao:${"c".repeat(64)}` });
    controller.abort();
    expect(await interrupted).toEqual(new Error("memory-unavailable:cancelled"));
    expect(await other).toMatchObject({ text: "other request succeeded" });
    await expect.poll(() => disconnected, { timeout: 500 }).toBe(true);
    expect(calls).toBe(2);
  });

  it("keeps the absolute fabric deadline and releases signal listeners on timeout", async () => {
    let disconnected = false;
    const socketPath = await socketServer((req, res) => {
      req.resume();
      const heartbeat = setInterval(() => res.write(" "), 10);
      res.on("close", () => { disconnected = true; clearInterval(heartbeat); });
    });
    const controller = new AbortController();
    await expect(new LocalComputeFabricProvider({ socketPath, timeoutMs: 100 })
      .complete(completionInput(controller.signal))).rejects.toThrow("memory-unavailable:compute-fabric");
    await expect.poll(() => disconnected, { timeout: 500 }).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
