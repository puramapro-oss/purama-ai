import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderDeadline, requestProviderJson, type ProviderDeadline } from "../src/tools/provider-http.js";

const url = "https://provider.invalid/action";
const encoder = new TextEncoder();
let deadline: ProviderDeadline;
beforeEach(() => { vi.useFakeTimers(); deadline = createProviderDeadline(100, "Délai fournisseur dépassé"); });
afterEach(() => { deadline.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const request = (maxBytes = 64 * 1024) => requestProviderJson(url, { method: "POST" }, deadline, maxBytes);

describe("provider HTTP total deadline and bounded response", () => {
  it("returns JSON without redirecting or replacing the owner signal", async () => {
    const fetchMock = vi.fn(async () => new Response('[{"submission_id":42}]'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(requestProviderJson(url, { method: "POST", redirect: "follow", signal: new AbortController().signal }, deadline, 1024))
      .resolves.toEqual([{ submission_id: 42 }]);
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({
      signal: deadline.signal, redirect: "error", credentials: "omit",
    }));
    expect(deadline.active()).toBe(true);
  });

  it("keeps one budget across body chunks", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"id":'));
        setTimeout(() => { if (!cancelled) controller.enqueue(encoder.encode("1")); }, 60);
        setTimeout(() => { if (!cancelled) { controller.enqueue(encoder.encode("}")); controller.close(); } }, 120);
      },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)));
    const outcome = request().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(101);
    expect((await outcome)?.message).toBe("Délai fournisseur dépassé");
    expect(cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(20);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("settles even when a stalled reader's cancellation never settles", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ cancel }))));
    const outcome = request().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(101);
    expect((await outcome)?.message).toBe("Délai fournisseur dépassé");
    expect(cancel).toHaveBeenCalledOnce();
    expect(deadline.signal.aborted).toBe(true);
  });

  it("cleans up an uncooperative late fetch without waiting for cancellation", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
    const outcome = request().then(() => null, error => error as Error);
    await vi.advanceTimersByTimeAsync(101);
    expect((await outcome)?.message).toBe("Délai fournisseur dépassé");
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("enforces received bytes even if Content-Length lies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"id":12345}', { headers: { "Content-Length": "1" } })));
    await expect(request(8)).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
  });

  it.each([
    ["malformed JSON", encoder.encode('{"secret":"private-provider-data"')],
    ["invalid UTF-8", new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
  ])("does not echo %s in an error", async (_name, bytes) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes)));
    await expect(request()).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
  });

  it("does not read an HTTP error body", async () => {
    const response = new Response("private-provider-data", { status: 500 });
    const text = vi.spyOn(response, "text");
    const read = vi.spyOn(response.body!, "getReader");
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(request()).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
    expect(text).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses an unexpected redirected response", async () => {
    const response = new Response('{"id":1}');
    Object.defineProperty(response, "redirected", { value: true });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(request()).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
  });

  it("does not expose transport diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-provider-data token=secret"); }));
    await expect(request()).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
  });

  it("bounds a stream of empty chunks", async () => {
    let reads = 0;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array()); }, cancel,
    }))));
    await expect(request()).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
    expect(reads).toBeLessThanOrEqual(66);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds pathological fragmentation independently of the byte limit", async () => {
    let reads = 0;
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array([32])); }, cancel,
    }))));
    await expect(request()).rejects.toThrow("Réponse fournisseur invalide ou indisponible");
    expect(reads).toBeLessThanOrEqual(8194);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects before I/O when monotone time has elapsed without a dispatched timer", async () => {
    deadline.close();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    deadline = createProviderDeadline(100, "Délai fournisseur dépassé");
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    clock.mockReturnValue(1_101);
    await expect(request()).rejects.toThrow("Délai fournisseur dépassé");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a response crossing the monotone deadline before the timer callback", async () => {
    deadline.close();
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    deadline = createProviderDeadline(100, "Délai fournisseur dépassé");
    const response = new Response('{"id":1}');
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn(async () => { clock.mockReturnValue(1_101); return response; }));
    await expect(request()).rejects.toThrow("Délai fournisseur dépassé");
    expect(cancel).toHaveBeenCalled();
  });
});
