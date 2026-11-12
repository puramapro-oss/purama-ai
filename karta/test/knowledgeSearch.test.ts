import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertToolResult } from "../src/engine/tool-result.js";
import type { ToolExecutionContext } from "../src/engine/types.js";
import { copyKnowledgeParams } from "../src/knowledge/public-search.js";
import { createKnowledgeSearchTool, knowledgeSearchTool } from "../src/tools/knowledge-search.js";

const ctx: ToolExecutionContext = { userId: "user-a", agentType: "email", mode: "live" };
const crossrefItem = { DOI: "10.1234/Example", title: ["Quantum results"], publisher: "Example Press", type: "journal-article", published: { "date-parts": [[2026, 11]] } };
const wikidataItem = { id: "Q17995793", label: "quantum computing", description: "study of a model of computation", display: { label: { language: "en", value: "quantum computing" } } };
const json = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), { ...init, headers: { "content-type": "application/json", ...init.headers } });
const crossref = (items: unknown[] = [crossrefItem]) => json({ status: "ok", message: { items } });
const wikidata = (items: unknown[] = [wikidataItem]) => json({ success: 1, search: items });
const request = { query: "quantum computing", sources: ["crossref", "wikidata"] as ("crossref" | "wikidata")[], limit: 2, language: "en" as const };
const oneSource = { query: "quantum computing", sources: ["crossref"] as "crossref"[] };

function tool(fetch: typeof globalThis.fetch, timeoutMs = 15_000) {
  return createKnowledgeSearchTool({ fetch, timeoutMs, monotonicNow: () => Date.now(), wallNow: () => Date.now() });
}
const workingFetch = () => vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => new URL(String(url)).hostname === "api.crossref.org" ? crossref() : wikidata());

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("knowledge_search provenance and engine outcomes", () => {
  it("retrieves only bounded metadata at fixed endpoints without redirects or credentials", async () => {
    const fetch = workingFetch();
    const result = await tool(fetch).execute(request, ctx);
    expect(result).toMatchObject({ ok: true, status: "complete", evidence: { verification_status: "unverified", scope: "selected_public_sources", content_kind: "metadata_only", page_read_by_karta: false, full_text_retrieved: false } });
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({ canonical_id: "doi:10.1234/example", provider_published_date: "2026-11", content_license: null, metadata_license: null, provider_ranks: [1] });
    expect(result.results[1]).toMatchObject({ canonical_id: "wikidata:Q17995793", provider_published_date: null, language: "en", metadata_license: "CC0-1.0" });
    expect(() => assertToolResult(result)).not.toThrow();
    for (const [url, init] of fetch.mock.calls) {
      const parsed = new URL(String(url));
      expect(["api.crossref.org", "www.wikidata.org"]).toContain(parsed.hostname);
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toContain("https://github.com/puramapro-oss/purama-ai");
      expect(headers.has("authorization")).toBe(false);
      expect(parsed.searchParams.has("mailto")).toBe(false);
      expect(init?.body).toBeUndefined();
    }
    expect(knowledgeSearchTool.tracePolicy).toBe("metadata_only");
  });

  it("does not fetch in simulation, and does not let the engine report it executed", async () => {
    const fetch = workingFetch();
    const result = await tool(fetch).execute(request, { ...ctx, mode: "simulation" });
    expect(result).toMatchObject({ ok: false, status: "not_executed", results: [] });
    expect(result.evidence.sources.map(source => source.status)).toEqual(["not_executed", "not_executed"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => assertToolResult(result)).toThrow();
  });

  it("preserves usable partial metadata while failing closed for the engine", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
      if (new URL(String(url)).hostname === "api.crossref.org") throw new Error("secret-provider-body");
      return wikidata();
    });
    const result = await tool(fetch).execute(request, ctx);
    expect(result).toMatchObject({ ok: false, status: "partial" });
    expect(result.results).toHaveLength(1);
    expect(result.evidence.sources.map(source => source.status)).toEqual(["unavailable", "ok"]);
    expect(result.message).toContain("PARTIEL");
    expect(JSON.stringify(result)).not.toContain("secret-provider-body");
    expect(() => assertToolResult(result)).toThrow();
  });

  it("distinguishes complete empty search from total unavailability", async () => {
    const emptyFetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => new URL(String(url)).hostname === "api.crossref.org" ? crossref([]) : wikidata([]));
    const empty = await tool(emptyFetch).execute(request, ctx);
    expect(empty).toMatchObject({ ok: true, status: "empty", results: [] });
    expect(empty.evidence.sources.map(source => source.status)).toEqual(["empty", "empty"]);
    expect(() => assertToolResult(empty)).not.toThrow();
    const failed = await tool(vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("private query"))).execute(request, ctx);
    expect(failed).toMatchObject({ ok: false, status: "failed", results: [] });
    expect(JSON.stringify(failed)).not.toContain("private query");
    expect(() => assertToolResult(failed)).toThrow();
  });

  it("preserves date precision and rejects impossible or invented publication dates", async () => {
    const dates = [[2026], [2024, 2, 29], [2026, 2, 29], [2026, 13], []];
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(crossref(dates.map((date, index) => ({ ...crossrefItem, DOI: `10.1234/test${index}`, published: { "date-parts": [date] } }))));
    const result = await tool(fetch).execute({ ...oneSource, limit: 5 }, ctx);
    expect(result.results.map(hit => hit.provider_published_date)).toEqual(["2026", "2024-02-29", null, null, null]);
    expect(result.results.every(hit => hit.retrieved_at === "2026-11-12T12:00:00.000Z")).toBe(true);
  });

  it("ignores provider navigation URLs, abstracts and full text rather than following them", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(crossref([{ ...crossrefItem, URL: "http://127.0.0.1/private", abstract: "private-abstract", full_text: "secret-text" }]));
    const result = await tool(fetch).execute(oneSource, ctx);
    expect(result.results[0].url).toBe("https://doi.org/10.1234/example");
    expect(JSON.stringify(result)).not.toMatch(/private-abstract|127\.0\.0\.1|secret-text/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("groups exact duplicate identifiers but keeps conflicting metadata visible", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(crossref([crossrefItem, { ...crossrefItem }, { ...crossrefItem, title: ["Different title"] }]));
    const result = await tool(fetch).execute({ ...oneSource, limit: 3 }, ctx);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].provider_ranks).toEqual([1, 2]);
    expect(result.results[1].title).toBe("Different title");
    expect(result.evidence.sources[0].duplicate_results_removed).toBe(1);
  });
});

describe("knowledge_search snapshots and admission", () => {
  const invalid: unknown[] = [null, [], {}, { ...oneSource, query: " " }, { ...oneSource, query: "x".repeat(1001) },
    { ...oneSource, query: "x\u0000y" }, { ...oneSource, query: 42 }, { ...oneSource, sources: [] },
    { ...oneSource, sources: ["crossref", "crossref"] }, { ...oneSource, sources: ["unknown"] },
    { ...oneSource, sources: "crossref" }, { ...oneSource, limit: NaN }, { ...oneSource, limit: Infinity },
    { ...oneSource, limit: 0 }, { ...oneSource, limit: 6 }, { ...oneSource, limit: 1.5 }, { ...oneSource, language: "xx" },
    { ...oneSource, apiKey: "private" }, { ...oneSource, limit: undefined }, { ...oneSource, limit: null },
    Object.assign(Object.create({ inherited: true }), oneSource),
  ];
  it.each(invalid.map((value, index) => [index, value] as const))("rejects invalid request %s before network", async (_index, value) => {
    const fetch = workingFetch();
    await expect(tool(fetch).execute(value as never, ctx)).rejects.toThrow("Paramètres de recherche de connaissances invalides.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not invoke object or array getters or proxy traps", async () => {
    const getter = vi.fn(() => "private");
    const object = Object.defineProperty({ sources: ["crossref"] }, "query", { get: getter, enumerable: true });
    const sources = Object.defineProperty(new Array(1), "0", { get: getter, enumerable: true });
    const ownKeys = vi.fn(() => ["query", "sources"]);
    const proxy = new Proxy(oneSource, { ownKeys });
    const fetch = workingFetch();
    for (const value of [object, { ...oneSource, sources }, proxy]) {
      await expect(tool(fetch).execute(value as never, ctx)).rejects.toThrow("invalides");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(ownKeys).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects hidden, symbolic, sparse and custom-array properties", () => {
    const hidden = Object.defineProperty({ ...oneSource }, "query", { value: "query", enumerable: false });
    const symbolic = { ...oneSource, [Symbol("private")]: true };
    const sparse = { ...oneSource, sources: new Array(1) };
    const extra = { ...oneSource, sources: Object.assign(["crossref"], { extra: true }) };
    class Sources extends Array<string> {}
    const inherited = { ...oneSource, sources: new Sources("crossref") };
    for (const value of [hidden, symbolic, sparse, extra, inherited]) expect(() => copyKnowledgeParams(value)).toThrow("invalides");
  });

  it("copies all parameters before either provider can mutate the caller object", async () => {
    const mutable = { ...request, sources: [...request.sources] };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => {
      mutable.query = "secret mutation";
      mutable.sources.splice(0, 2);
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get(parsed.hostname === "api.crossref.org" ? "query" : "search")).toBe("quantum computing");
      return parsed.hostname === "api.crossref.org" ? crossref() : wikidata();
    });
    const result = await tool(fetch).execute(mutable, ctx);
    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.evidence.selected_sources).toEqual(["crossref", "wikidata"]);
  });

  it("enforces one in-flight request and a post-response cooldown with no hidden queue", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const shared = tool(fetch);
    const first = shared.execute(oneSource, ctx);
    const busy = await shared.execute(oneSource, { ...ctx, userId: "user-b" });
    expect(busy.evidence.sources[0].status).toBe("busy");
    expect(fetch).toHaveBeenCalledTimes(1);
    resolve(crossref());
    expect((await first).ok).toBe(true);
    expect((await shared.execute(oneSource, ctx)).evidence.sources[0].status).toBe("rate_limited");
    await vi.advanceTimersByTimeAsync(1_100);
    fetch.mockResolvedValue(crossref());
    expect((await shared.execute(oneSource, ctx)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["2", "Thu, 12 Nov 2026 12:00:02 GMT"])("honors Retry-After %s without automatic retries", async retry => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 429, headers: { "retry-after": retry } }));
    const shared = tool(fetch);
    const limited = await shared.execute(oneSource, ctx);
    expect(limited.evidence.sources[0]).toMatchObject({ status: "rate_limited", retry_after_ms: 2000 });
    expect(cancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_999);
    expect((await shared.execute(oneSource, ctx)).ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    fetch.mockResolvedValue(crossref());
    expect((await shared.execute(oneSource, ctx)).ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("recognizes Wikidata maxlag even with HTTP 200", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json({ error: { code: "maxlag", info: "private diagnostics" } }, { headers: { "retry-after": "5" } }));
    const result = await tool(fetch).execute({ ...oneSource, sources: ["wikidata"] }, ctx);
    expect(result.evidence.sources[0]).toMatchObject({ status: "rate_limited", retry_after_ms: 5000 });
    expect(JSON.stringify(result)).not.toContain("private diagnostics");
  });
});

describe("knowledge_search transport boundaries", () => {
  it.each([
    { elapsed: 1_999, success: true },
    { elapsed: 2_000, success: false },
    { elapsed: 2_001, success: false },
  ])("rechecks the deadline after Promise.race adopts a result at $elapsed ms", async ({ elapsed, success }) => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(crossref([]));
    const shared = createKnowledgeSearchTool({ fetch, timeoutMs: 2_000, monotonicNow: () => now });
    const originalRace = Promise.race.bind(Promise);
    const race = vi.spyOn(Promise, "race").mockImplementationOnce(values => originalRace(values).then(value => {
      now = elapsed;
      return value;
    }));
    const result = await shared.execute(oneSource, ctx);
    expect(result.ok).toBe(success);
    expect(result.evidence.sources[0].status).toBe(success ? "empty" : "timeout");
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(!success);
    expect(race).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled body and cancels its reader", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); }, cancel,
    }), { headers: { "content-type": "application/json" } }));
    const pending = tool(fetch, 100).execute(oneSource, ctx);
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).evidence.sources[0].status).toBe("timeout");
    expect(cancel).toHaveBeenCalled();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("holds admission after a non-cooperative fetch times out and cancels its late response", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise<Response>(done => { resolve = done; }));
    const shared = tool(fetch, 100);
    const first = shared.execute(oneSource, ctx);
    await vi.advanceTimersByTimeAsync(100);
    expect((await first).evidence.sources[0].status).toBe("timeout");
    expect((await shared.execute(oneSource, ctx)).evidence.sources[0].status).toBe("busy");
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized stream and cancels it without waiting for its producer", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(524_289)); }, cancel,
    }), { headers: { "content-type": "application/json" } }));
    const result = await tool(fetch).execute(oneSource, ctx);
    expect(result.evidence.sources[0].status).toBe("invalid_response");
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    () => new Response("not JSON", { headers: { "content-type": "application/json" } }),
    () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    () => new Response("{}", { headers: { "content-type": "text/html" } }),
    () => crossref([{ ...crossrefItem, DOI: "http://127.0.0.1/private" }]),
    () => crossref([crossrefItem, crossrefItem, crossrefItem, crossrefItem]),
    () => json({ status: "ok", error: "not a successful response", message: { items: [crossrefItem] } }),
  ])("rejects malformed metadata or transport #%#", async response => {
    const result = await tool(vi.fn<typeof globalThis.fetch>().mockResolvedValue(response())).execute(oneSource, ctx);
    expect(result).toMatchObject({ ok: false, status: "failed", results: [] });
    expect(result.evidence.sources[0].status).toBe("invalid_response");
  });
});
