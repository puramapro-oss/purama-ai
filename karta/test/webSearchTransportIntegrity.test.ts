import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../src/engine/types.js";

vi.mock("../src/config.js", () => ({ config: { tavilyApiKey: "test-only-transport-integrity" } }));
const { webSearchTool } = await import("../src/tools/websearch.js");
const ctx: ToolExecutionContext = { userId: "transport-user", agentType: "legal", mode: "live" };
const transport = vi.fn<typeof fetch>();
const search = () => webSearchTool.execute({ query: "public query" }, ctx);
const unavailable = "Recherche Tavily indisponible : réponse invalide ou délai dépassé.";

beforeEach(() => {
  transport.mockReset();
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web search parent cancellation", () => {
  it("does not dispatch an already-cancelled request or disclose its reason", async () => {
    const parent = new AbortController();
    parent.abort(new Error("PRIVATE_PARENT_ABORT_REASON"));
    transport.mockResolvedValue(new Response('{"results":[]}'));
    await expect(webSearchTool.execute({ query: "public query" }, { ...ctx, signal: parent.signal }))
      .rejects.toThrow(unavailable);
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([true, false])("settles cancellation with a cooperative=%s header transport and rejects late results", async cooperative => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let release!: (response: Response) => void;
    let providerSignal: AbortSignal | undefined;
    transport.mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
      release = resolve; providerSignal = init!.signal!;
      if (cooperative) providerSignal.addEventListener("abort", () => reject(new Error("PRIVATE_PROVIDER_ABORT")), { once: true });
    }));
    let outcome: unknown;
    const pending = webSearchTool.execute({ query: "public query" }, { ...ctx, signal: parent.signal })
      .then(value => { outcome = value; }, error => { outcome = error; });
    try {
      parent.abort(new Error("PRIVATE_PARENT_ABORT_REASON"));
      await vi.advanceTimersByTimeAsync(0);
      expect(providerSignal?.aborted).toBe(true);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(unavailable);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release(new Response('{"results":[]}'));
      await pending;
    }
    expect((outcome as Error).message).toBe(unavailable);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("removes the parent listener after success without cancelling the completed transport", async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    transport.mockResolvedValue(new Response('{"results":[]}'));
    await expect(webSearchTool.execute({ query: "public query" }, { ...ctx, signal: parent.signal }))
      .resolves.toEqual({ results: [] });
    const listener = add.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(listener).toBeTypeOf("function");
    expect(remove).toHaveBeenCalledWith("abort", listener);
    parent.abort(new Error("PRIVATE_LATE_ABORT"));
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(false);
  });
});

describe("web search byte integrity and terminal deadline", () => {
  it("preserves valid response bytes when the producer reuses its chunk buffer", async () => {
    const fragments = ["{\"resul", "ts\":[]}"];
    const buffer = new Uint8Array(7);
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        buffer.set(new TextEncoder().encode(fragments[index++]));
        controller.enqueue(buffer);
        if (index === fragments.length) controller.close();
      },
    }, { highWaterMark: 0 });
    transport.mockResolvedValue(new Response(stream));

    await expect(search()).resolves.toEqual({ results: [] });
    expect(index).toBe(2);
    expect(transport).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("rejects a response received after the monotonic deadline even when the timer callback has not run", async () => {
    let now = 0;
    let signal: AbortSignal | null | undefined;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"results":[]}'));
      },
      cancel,
    });
    vi.spyOn(performance, "now").mockImplementation(() => now);
    transport.mockImplementation(async (_url, options) => {
      signal = options?.signal;
      now = 30_001;
      return new Response(stream);
    });

    await expect(search()).rejects.toThrow(unavailable);
    expect(transport).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("rejects bytes delivered after expiry during a read without accepting a late result", async () => {
    let now = 0;
    let signal: AbortSignal | null | undefined;
    const cancel = vi.fn();
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        now = 30_001;
        controller.enqueue(new TextEncoder().encode('{"results":[]}'));
      },
      cancel,
    }, { highWaterMark: 0 });
    transport.mockImplementation(async (_url, options) => {
      signal = options?.signal;
      return new Response(stream);
    });

    await expect(search()).rejects.toThrow(unavailable);
    expect(transport).toHaveBeenCalledOnce();
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it.each([
    { deliveryTime: 29_999, succeeds: true },
    { deliveryTime: 30_000, succeeds: false },
    { deliveryTime: 30_001, succeeds: false },
  ])("rechecks the budget when the outer race hands back its result at $deliveryTime ms", async ({ deliveryTime, succeeds }) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    transport.mockResolvedValue(Response.json({ results: [] }));
    const originalRace = Promise.race.bind(Promise);
    const race = vi.spyOn(Promise, "race").mockImplementationOnce(values =>
      originalRace(values).then(value => {
        // Expire inside the actual race's adoption boundary, after request()
        // has checked its result. Do not move the fixture to the caller's
        // continuation after execute() has completed its own final check.
        now = deliveryTime;
        return value;
      }));

    const completed = search();
    if (succeeds) await expect(completed).resolves.toEqual({ results: [] });
    else await expect(completed).rejects.toThrow(unavailable);

    expect(race).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(!succeeds);
    expect(vi.getTimerCount()).toBe(0);
  });

});
