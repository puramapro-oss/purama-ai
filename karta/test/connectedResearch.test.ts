import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectedResearchClient, ConnectedResearchError } from "../src/knowledge/connected-research.js";

const TARGET = "https://example.com/article";
const SEARCH = { id: "search-1", results: [{ title: "Article", url: TARGET, snippet: "Unverified source text" }] };
const SCRAPE = { success: true, data: { markdown: "# Article\nText", metadata: { title: "Article", sourceURL: TARGET, url: TARGET, statusCode: 200 } } };
function client(transport: typeof fetch, options = {}) {
  return createConnectedResearchClient({ perplexityApiKey: "test-search-key", firecrawlApiKey: "test-scrape-key", fetch: transport, ...options });
}
function fakeResponse(body: unknown) { return vi.fn(async () => Response.json(body)); }
async function failure(promise: Promise<unknown>, code: string, dispatched: boolean) {
  const error = await promise.catch(e => e);
  expect(error).toBeInstanceOf(ConnectedResearchError);
  expect(error).toMatchObject({ code, requestDispatched: dispatched, message: "Recherche connectée indisponible." });
  expect(String(error)).not.toContain("test-search-key");
  expect(String(error)).not.toContain("test-scrape-key");
}

afterEach(() => vi.useRealTimers());

describe("connected research request and evidence contracts", () => {
  it("calls the official Perplexity Search API once with bounded explicit fields and host credentials", async () => {
    const fetcher = fakeResponse(SEARCH);
    const result = await client(fetcher).search("Sources scientifiques", { limit: 3 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.perplexity.ai/search");
    expect(request).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store" });
    expect(request.headers).toMatchObject({ Authorization: "Bearer test-search-key" });
    expect(JSON.parse(request.body as string)).toEqual({ query: "Sources scientifiques", max_results: 3, max_tokens: 10_000, max_tokens_per_page: 2_000 });
    expect(result).toMatchObject({ provider: "perplexity", providerRequestId: "search-1", verificationStatus: "unverified", independentlyVerified: false, costMicros: null });
    expect(result.sources).toEqual([{ sourceId: `${result.retrievalId}:1`, url: TARGET, title: "Article", text: "Unverified source text", contentKind: "search_excerpt" }]);
    expect(JSON.stringify(result)).not.toContain("test-search-key");
  });

  it("uses a single Firecrawl markdown request without cookies, actions, parsers or enhanced proxy retries", async () => {
    const fetcher = fakeResponse(SCRAPE);
    const result = await client(fetcher).scrape(TARGET);
    const [url, request] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.firecrawl.dev/v2/scrape");
    expect(request.headers).toMatchObject({ Authorization: "Bearer test-scrape-key" });
    expect(JSON.parse(request.body as string)).toEqual({ url: TARGET, formats: ["markdown"], onlyMainContent: true, timeout: 30_000,
      maxAge: 0, storeInCache: false, parsers: [], proxy: "basic", skipTlsVerification: false });
    expect(result).toMatchObject({ provider: "firecrawl", verificationStatus: "unverified", sourceTextTrust: "untrusted_data", independentlyVerified: false });
    expect(result.sources[0]).toMatchObject({ url: TARGET, text: "# Article\nText", contentKind: "page_markdown" });
  });

  it("does not invent a final redirected URL when Firecrawl omits it", async () => {
    const value = structuredClone(SCRAPE);
    delete (value.data.metadata as Partial<typeof value.data.metadata>).url;
    expect((await client(fakeResponse(value)).scrape(TARGET)).sources[0].url).toBe(TARGET);
  });

  it("keeps conflicting excerpts for one URL and generates retrieval-local identities", async () => {
    const fetcher = fakeResponse({ ...SEARCH, results: [...SEARCH.results, { ...SEARCH.results[0], snippet: "Contradictory evidence" }] });
    const c = client(fetcher);
    const first = await c.search("Question");
    const second = await c.search("Question");
    expect(first.sources).toHaveLength(2);
    expect(first.sources[1].sourceId).not.toBe(first.sources[0].sourceId);
    expect(first.retrievalId).not.toBe(second.retrievalId);
  });

  it("accepts an empty search without claiming evidence", async () => {
    expect((await client(fakeResponse({ results: [], id: "empty" })).search("Nothing")).sources).toEqual([]);
  });
});

describe("untrusted input never adds a destination or authority", () => {
  it.each([
    "http://example.com", "https://user:password@example.com", "https://example.com:8443", "https://127.1", "https://0x7f000001",
    "https://2130706433", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://10.0.0.1", "https://8.8.8.8",
    "https://localhost", "https://machine.local", "https://corp.internal", "https://thing.lan", "https://metadata.google.internal",
    " https://example.com", "https://example.com\n", "https://example.com./", "https://example.com/#private",
    "https://example.com/?access_token=secret", "https://example.com/?X-Amz-Signature=secret", "https://example.com/?password=secret",
    "file:///etc/passwd", "https://example.com\\@localhost",
  ])("refuses private, ambiguous or credential-bearing scrape target %s", async url => {
    const fetcher = fakeResponse(SCRAPE);
    await failure(client(fetcher).scrape(url), "input_invalid", false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([0, -1, 21, 1.5, NaN, null, "5"])("rejects malformed result limit %s", async limit => {
    const fetcher = fakeResponse(SEARCH);
    await failure(client(fetcher).search("Question", { limit } as never), "input_invalid", false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["", " ", "x".repeat(4_001), "text\u0000text"])("rejects empty or oversized query", async query => {
    const fetcher = fakeResponse(SEARCH);
    await failure(client(fetcher).search(query), "input_invalid", false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unknown call fields and getters without evaluating them", async () => {
    const fetcher = fakeResponse(SEARCH);
    const c = client(fetcher);
    await failure(c.search("Question", { url: "https://other.example" } as never), "input_invalid", false);
    const getter = vi.fn(() => 2);
    await failure(c.search("Question", Object.defineProperty({}, "limit", { get: getter })), "input_invalid", false);
    expect(getter).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not evaluate proxy options or accept user-specified API origins", () => {
    const getter = vi.fn();
    expect(() => createConnectedResearchClient(new Proxy({}, { get: getter }))).toThrow(ConnectedResearchError);
    expect(getter).not.toHaveBeenCalled();
    expect(() => createConnectedResearchClient({ baseUrl: "https://evil.example" } as never)).toThrow(ConnectedResearchError);
  });

  it.each([{ timeoutMs: 0 }, { timeoutMs: 60_001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 2_097_153 },
    { perplexityApiKey: "key\r\nInjected:yes" }, { perplexityApiKey: "key\n" }, { perplexityApiKey: "key\r" }])(
    "rejects malformed host transport configuration", options => {
      expect(() => client(fakeResponse(SEARCH), options)).toThrow(ConnectedResearchError);
    });

  it("keeps keys separate and unavailable providers fail without transport", async () => {
    const fetcher = fakeResponse(SEARCH);
    const c = createConnectedResearchClient({ perplexityApiKey: "search-only", fetch: fetcher });
    await failure(c.scrape(TARGET), "not_configured", false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["request-1\n", "request-1\r", ""])("does not retain malformed provider request identifiers", async id => {
    const result = await client(fakeResponse({ ...SEARCH, id })).search("Question");
    expect(result.providerRequestId).toBeNull();
  });

  it("snapshots host key configuration instead of consulting mutable options on later calls", async () => {
    const fetcher = fakeResponse(SEARCH);
    const options = { perplexityApiKey: "first", fetch: fetcher };
    const c = createConnectedResearchClient(options);
    options.perplexityApiKey = "second";
    await c.search("Question");
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: "Bearer first" });
  });
});

describe("provider output, failures and resource bounds", () => {
  it.each([301, 302, 401, 402, 429, 500])("does not retry HTTP %s or surface its body", async status => {
    const fetcher = vi.fn(async () => new Response("provider details test-search-key", { status }));
    await failure(client(fetcher).search("Question"), "unavailable", true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {}, { results: "invalid" }, { results: [{ ...SEARCH.results[0], url: "https://127.0.0.1" }] },
    { results: [{ ...SEARCH.results[0], snippet: "x".repeat(200_001) }] },
    { results: [{ ...SEARCH.results[0], title: null }] }, { results: Array(6).fill(SEARCH.results[0]) },
  ])("rejects invalid or oversized search results without partial acceptance", async body => {
    await failure(client(fakeResponse(body)).search("Question"), "unavailable", true);
  });

  it.each([
    { success: false, data: SCRAPE.data },
    { success: true, data: { ...SCRAPE.data, warning: "truncated" } },
    { success: true, data: { ...SCRAPE.data, markdown: "" } },
    { success: true, data: { ...SCRAPE.data, metadata: { ...SCRAPE.data.metadata, statusCode: 403 } } },
    { success: true, data: { ...SCRAPE.data, metadata: { ...SCRAPE.data.metadata, sourceURL: "https://other.example.com/" } } },
    { success: true, data: { ...SCRAPE.data, metadata: { ...SCRAPE.data.metadata, url: "https://other.example.com/" } } },
    { success: true, data: { ...SCRAPE.data, metadata: { ...SCRAPE.data.metadata, url: "https://127.0.0.1/" } } },
    { success: true, data: { ...SCRAPE.data, metadata: { ...SCRAPE.data.metadata, error: "access denied" } } },
  ])("rejects partial, redirected or erroneous scrape responses", async body => {
    await failure(client(fakeResponse(body)).scrape(TARGET), "unavailable", true);
  });

  it("rejects redirects or changed API response origins even with plausible JSON", async () => {
    for (const overrides of [{ redirected: true }, { url: "https://other.example.com/" }]) {
      const response = Response.json(SEARCH);
      for (const [key, value] of Object.entries(overrides)) Object.defineProperty(response, key, { value });
      await failure(client(vi.fn(async () => response)).search("Question"), "unavailable", true);
    }
  });

  it.each([
    () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify(SEARCH), { headers: { "content-type": "text/html" } }),
    () => new Response(new Uint8Array([255]), { headers: { "content-type": "application/json" } }),
    () => new Response(JSON.stringify(SEARCH), { headers: { "content-type": "application/json", "content-length": "99999999" } }),
  ])("rejects malformed bytes, content types and declared oversize", async factory => {
    await failure(client(vi.fn(async () => factory())).search("Question"), "unavailable", true);
  });

  it("caps actual streaming bytes independently of Content-Length and cancels excess", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(1_025))); }, cancel,
    }), { headers: { "content-type": "application/json" } });
    await failure(client(vi.fn(async () => response), { maxResponseBytes: 1_024 }).search("Question"), "unavailable", true);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects pre-cancelled requests before any paid request", async () => {
    const fetcher = fakeResponse(SEARCH);
    await failure(client(fetcher).search("Question", { signal: AbortSignal.abort("private reason") }), "cancelled", false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds a stalled body and propagates cancellation to its reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
    const result = failure(client(fetcher, { timeoutMs: 1_000 }).search("Question"), "unavailable", true);
    await vi.advanceTimersByTimeAsync(1_001);
    await result;
    expect(cancel).toHaveBeenCalled();
  });

  it("does not start overlapping calls after a non-cooperative request times out", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const c = client(fetcher, { timeoutMs: 1_000 });
    const first = failure(c.search("First"), "unavailable", true);
    await vi.advanceTimersByTimeAsync(1_001);
    await first;
    await failure(c.search("Second"), "busy", false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalled();
  });

  it("aborts cooperative work and sanitizes the caller's abort reason", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn((_url: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("private test-search-key")));
    }));
    const first = failure(client(fetcher).search("Question", { signal: controller.signal }), "cancelled", true);
    await Promise.resolve();
    controller.abort("private test-search-key");
    await first;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
