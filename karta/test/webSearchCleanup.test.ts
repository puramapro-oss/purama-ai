import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionContext } from "../src/engine/types.js";

vi.mock("../src/config.js", () => ({ config: { tavilyApiKey: "test-only-tavily" } }));
const { webSearchTool } = await import("../src/tools/websearch.js");

const ctx: ToolExecutionContext = { userId: "user-web", agentType: "legal", mode: "live" };
const fetchMock = vi.fn<typeof fetch>();
const privateDetail = "SENTINEL_PRIVATE_CLEANUP_DETAIL";
const search = () => webSearchTool.execute({ query: "public test query" }, ctx);

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function deferredCancellation() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((success, failure) => { resolve = success; reject = failure; });
  return { cancel: vi.fn(() => pending), resolve, reject };
}

function failingResponse(kind: "oversized" | "HTTP error", cancel: () => Promise<void>) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (kind === "oversized") controller.enqueue(new Uint8Array(1_048_577));
    },
    cancel,
  });
  return { stream, response: new Response(stream, { status: kind === "HTTP error" ? 503 : 200 }) };
}

describe("web_search response cleanup does not block confirmed failures", () => {
  for (const kind of ["oversized", "HTTP error"] as const) {
    it.each(["resolve", "reject"] as const)(`${kind}: settles before a pending cancel later %ss`, async (settlement) => {
      const cleanup = deferredCancellation();
      const { stream, response } = failingResponse(kind, cleanup.cancel);
      fetchMock.mockResolvedValue(response);
      let outcome: { value: unknown } | { error: unknown } | undefined;
      const completed = search().then(
        value => { outcome = { value }; }, error => { outcome = { error }; },
      );
      try {
        // Drain promises without reaching the production 30-second deadline.
        // The old implementation is still waiting on cancel() at this point.
        await vi.advanceTimersByTimeAsync(0);
        expect(outcome).toEqual({ error: expect.any(Error) });
        expect(String(outcome && "error" in outcome ? outcome.error : "")).not.toContain(privateDetail);
        expect(cleanup.cancel).toHaveBeenCalledOnce();
        expect(stream.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
      } finally {
        // Both branches release the fixture even when the pre-fix assertion fails.
        // Late rejection must be handled after the public result has settled.
        if (settlement === "resolve") cleanup.resolve();
        else cleanup.reject(new Error(privateDetail));
        await vi.advanceTimersByTimeAsync(0);
        await completed;
      }
    });

    it(`${kind}: contains an immediately rejected cancellation and releases the body`, async () => {
      const cancel = vi.fn(() => Promise.reject(new Error(privateDetail)));
      const { stream, response } = failingResponse(kind, cancel);
      fetchMock.mockResolvedValue(response);
      const outcome = await search().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toBeInstanceOf(Error);
      expect(String(outcome)).toContain("Tavily");
      expect(String(outcome)).not.toContain(privateDetail);
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  }

  it("keeps a valid successful response and releases its reader without cancellation", async () => {
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(JSON.stringify({ results: [{
      title: "Source", url: "https://example.invalid/source", content: "Public excerpt",
    }] }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); }, cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream));
    await expect(search()).resolves.toEqual({ results: [{
      title: "Source", url: "https://example.invalid/source", snippet: "Public excerpt",
    }] });
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the exact 1 MiB limit without cancelling the completed body", async () => {
    const cancel = vi.fn();
    const overhead = JSON.stringify({ results: [], padding: "" }).length;
    const bytes = new TextEncoder().encode(JSON.stringify({
      results: [], padding: "x".repeat(1_048_576 - overhead),
    }));
    expect(bytes.byteLength).toBe(1_048_576);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes); controller.close(); }, cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream));
    await expect(search()).resolves.toEqual({ results: [] });
    expect(cancel).not.toHaveBeenCalled();
    expect(stream.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the 30-second deadline and releases a stalled reader despite pending cancellation", async () => {
    const cleanup = deferredCancellation();
    const stream = new ReadableStream<Uint8Array>({ cancel: cleanup.cancel });
    fetchMock.mockResolvedValue(new Response(stream));
    let outcome: unknown;
    const completed = search().then(value => { outcome = value; }, error => { outcome = error; });
    try {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(outcome).toBeUndefined();
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await completed;
      expect(outcome).toBeInstanceOf(Error);
      expect(cleanup.cancel).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(stream.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await completed;
    }
  });
});
