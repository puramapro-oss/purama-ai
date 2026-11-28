import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isProxy } from "node:util/types";
import { bounded } from "../runtime/lifecycle.js";

/** Provider transports only. The caller must qualify and authorize each account,
 * destination and disclosure, reserve its budget, and reconcile unknown charges.
 * A key is not a permission. No provider is activated by importing this module.
 */
export interface ConnectedResearchOptions {
  perplexityApiKey?: string;
  firecrawlApiKey?: string;
  /** Host-owned dependency; never accepted from a tool/model request. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ConnectedResearchSource {
  sourceId: string;
  url: string;
  title: string;
  text: string;
  contentKind: "search_excerpt" | "page_markdown";
}

export interface ConnectedResearchResult {
  provider: "perplexity" | "firecrawl";
  retrievalId: string;
  retrievedAt: string;
  providerRequestId: string | null;
  verificationStatus: "unverified";
  sourceTextTrust: "untrusted_data";
  /** Neither an API response nor its metadata independently verifies a page. */
  independentlyVerified: false;
  costMicros: null;
  sources: ConnectedResearchSource[];
}

type ErrorCode = "input_invalid" | "not_configured" | "cancelled" | "unavailable" | "busy";
export class ConnectedResearchError extends Error {
  constructor(readonly code: ErrorCode, readonly requestDispatched: boolean) {
    super("Recherche connectée indisponible.");
    this.name = "ConnectedResearchError";
  }
}

const PERPLEXITY_SEARCH = "https://api.perplexity.ai/search";
const FIRECRAWL_SCRAPE = "https://api.firecrawl.dev/v2/scrape";
const MAX_QUERY_LENGTH = 4_000;
const MAX_SOURCE_TEXT = 200_000;
const MAX_RESULTS = 20;

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every(key => typeof key === "string")
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(property => "value" in property);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.getOwnPropertyNames(value).every(key => keys.includes(key));
}

function text(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0);
}

/** Syntactic protection, not a DNS/rebinding or provider-side redirect sandbox.
 * The provider performs remote retrieval. Only its API is contacted locally.
 * IP literals, local names, credentials and common signed/private URL parameter names are
 * refused before submission; host policy must still authorize the actual URL.
 */
function publicUrl(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- Reject control characters before URL parsing normalizes them.
  if (!text(value, 8_192) || value !== value.trim() || /[\u0000-\u0020\u007f\\]/u.test(value)) throw new Error();
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || isIP(hostname) !== 0 || hostname.length > 253 || hostname.endsWith(".")
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)
    || /(?:^|\.)(?:localhost|local|localdomain|internal|intranet|lan|home|test|invalid|example|onion)$/.test(hostname)
    || hostname.endsWith(".home.arpa")
    || hostname === "metadata.google.internal") throw new Error();
  for (const key of url.searchParams.keys()) {
    if (/^(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|authorization|password|secret|signature|sig|x-amz-.+|x-goog-.+)$/i.test(key)) throw new Error();
  }
  // Anchors are not sent to an HTTP origin and may contain private application state.
  if (url.hash) throw new Error();
  return url.href;
}

function apiKey(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4_096 || /[^\x21-\x7e]/.test(value)) throw new Error();
  return value;
}

function requestOptions(value: unknown, withLimit: boolean): { signal?: AbortSignal; limit: number } {
  if (!plain(value) || !onlyKeys(value, withLimit ? ["signal", "limit"] : ["signal"])) throw new Error();
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw new Error();
  const limit = value.limit === undefined ? 5 : value.limit;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_RESULTS) throw new Error();
  return { signal: value.signal as AbortSignal | undefined, limit: Number(limit) };
}

function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* bounded cleanup */ }
}

async function readJson(response: Response, signal: AbortSignal, maximum: number): Promise<unknown> {
  const mediaType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  const length = response.headers.get("content-length");
  if (!response.body || !mediaType || !/^application\/(?:json|[a-z0-9.-]+\+json)$/.test(mediaType)
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum))) {
    cancelBody(response);
    throw new Error();
  }
  const reader = response.body.getReader();
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* bounded cleanup */ } };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new Error();
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    try { reader.releaseLock(); } catch { /* an abandoned read is still bounded */ }
  }
}

function receipt(provider: ConnectedResearchResult["provider"], rawId: unknown,
  sources: Array<Omit<ConnectedResearchSource, "sourceId">>): ConnectedResearchResult {
  const retrievalId = randomUUID();
  return {
    provider, retrievalId, retrievedAt: new Date().toISOString(),
    providerRequestId: typeof rawId === "string" && rawId.length >= 1 && rawId.length <= 128
      && !/[^a-zA-Z0-9._:-]/.test(rawId) ? rawId : null,
    verificationStatus: "unverified", sourceTextTrust: "untrusted_data", independentlyVerified: false,
    costMicros: null,
    sources: sources.map((source, index) => ({ ...source, sourceId: `${retrievalId}:${index + 1}` })),
  };
}

export function createConnectedResearchClient(options: ConnectedResearchOptions) {
  let keys: { perplexity?: string; firecrawl?: string };
  let timeoutMs: number;
  let maxResponseBytes: number;
  let transport: typeof fetch;
  try {
    if (!plain(options) || !onlyKeys(options, ["perplexityApiKey", "firecrawlApiKey", "fetch", "timeoutMs", "maxResponseBytes"])) throw new Error();
    keys = { perplexity: apiKey(options.perplexityApiKey), firecrawl: apiKey(options.firecrawlApiKey) };
    const timeout = options.timeoutMs === undefined ? 30_000 : options.timeoutMs;
    const byteLimit = options.maxResponseBytes === undefined ? 1_048_576 : options.maxResponseBytes;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 60_000
      || typeof byteLimit !== "number" || !Number.isSafeInteger(byteLimit) || byteLimit < 1_024 || byteLimit > 2_097_152) throw new Error();
    timeoutMs = timeout;
    maxResponseBytes = byteLimit;
    const fetcher = options.fetch === undefined ? globalThis.fetch : options.fetch;
    if (typeof fetcher !== "function") throw new Error();
    transport = fetcher as typeof fetch;
  } catch { throw new ConnectedResearchError("input_invalid", false); }

  // One operation per provider/client. Hosts must also enforce account-wide
  // concurrency and budgets across instances/processes.
  const inFlight = { perplexity: false, firecrawl: false };

  async function invoke(provider: ConnectedResearchResult["provider"], body: Record<string, unknown>,
    parent: AbortSignal | undefined, parse: (raw: unknown) => ConnectedResearchResult): Promise<ConnectedResearchResult> {
    if (parent?.aborted) throw new ConnectedResearchError("cancelled", false);
    const key = keys[provider];
    if (!key) throw new ConnectedResearchError("not_configured", false);
    if (inFlight[provider]) throw new ConnectedResearchError("busy", false);
    let dispatched = false;
    const endpoint = provider === "perplexity" ? PERPLEXITY_SEARCH : FIRECRAWL_SCRAPE;
    inFlight[provider] = true;
    // Retain admission until the underlying operation settles, even when a
    // caller timeout wins the race against a non-cooperative transport.
    let settled = false;
    try {
      return await bounded(async signal => {
        try {
          signal.throwIfAborted();
          dispatched = true;
          const init: RequestInit & { cache: "no-store" } = {
            method: "POST", redirect: "error", credentials: "omit", cache: "no-store", signal,
            headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify(body),
          };
          const response = await transport(endpoint, init);
          if (signal.aborted || !response.ok || response.redirected || (response.url && response.url !== endpoint)) {
            cancelBody(response);
            throw new Error();
          }
          const raw = await readJson(response, signal, maxResponseBytes);
          signal.throwIfAborted();
          return parse(raw);
        } finally { settled = true; inFlight[provider] = false; }
      }, timeoutMs, parent);
    } catch {
      throw new ConnectedResearchError(parent?.aborted ? "cancelled" : "unavailable", dispatched);
    } finally {
      // A pre-aborted bounded() need not invoke the closure.
      if (!dispatched || settled) inFlight[provider] = false;
    }
  }

  return {
    async search(query: string, request: { signal?: AbortSignal; limit?: number } = {}): Promise<ConnectedResearchResult> {
      let input: { signal?: AbortSignal; limit: number };
      try {
        // eslint-disable-next-line no-control-regex -- NUL and DEL are intentionally invalid search input.
        if (!text(query, MAX_QUERY_LENGTH) || /[\u0000\u007f]/u.test(query)) throw new Error();
        input = requestOptions(request, true);
      } catch { throw new ConnectedResearchError("input_invalid", false); }
      // Explicit content bounds are additional controls, not billing guarantees.
      return invoke("perplexity", { query, max_results: input.limit, max_tokens: 10_000, max_tokens_per_page: 2_000 }, input.signal, raw => {
        if (!plain(raw) || !Array.isArray(raw.results) || raw.results.length > input.limit) throw new Error();
        const sources = raw.results.map(item => {
          if (!plain(item) || !text(item.title, 4_096) || !text(item.snippet, MAX_SOURCE_TEXT, true)) throw new Error();
          return { url: publicUrl(item.url), title: item.title, text: item.snippet, contentKind: "search_excerpt" as const };
        });
        return receipt("perplexity", raw.id, sources);
      });
    },

    async scrape(url: string, request: { signal?: AbortSignal } = {}): Promise<ConnectedResearchResult> {
      let input: { signal?: AbortSignal; limit: number };
      let target: string;
      try { target = publicUrl(url); input = requestOptions(request, false); }
      catch { throw new ConnectedResearchError("input_invalid", false); }
      return invoke("firecrawl", {
        url: target, formats: ["markdown"], onlyMainContent: true, timeout: timeoutMs,
        maxAge: 0, storeInCache: false, parsers: [], proxy: "basic", skipTlsVerification: false,
      }, input.signal, raw => {
        if (!plain(raw) || raw.success !== true || !plain(raw.data) || !text(raw.data.markdown, MAX_SOURCE_TEXT)
          || (raw.data.warning !== undefined && raw.data.warning !== null && raw.data.warning !== "")
          || !plain(raw.data.metadata)) throw new Error();
        const metadata = raw.data.metadata;
        if (!Number.isInteger(metadata.statusCode) || Number(metadata.statusCode) < 200 || Number(metadata.statusCode) > 299
          || (metadata.error !== undefined && metadata.error !== null && metadata.error !== "")
          || publicUrl(metadata.sourceURL) !== target) throw new Error();
        // API redirects are disabled above. Remote page redirects are controlled
        // by Firecrawl; a changed reported URL is rejected after retrieval. This
        // does not prove no remote redirect occurred when metadata omits it.
        if (metadata.url !== undefined && publicUrl(metadata.url) !== target) throw new Error();
        if (metadata.title !== undefined && !text(metadata.title, 4_096, true)) throw new Error();
        return receipt("firecrawl", metadata.scrapeId, [{
          url: target, title: typeof metadata.title === "string" ? metadata.title : target,
          text: raw.data.markdown, contentKind: "page_markdown",
        }]);
      });
    },
  };
}
