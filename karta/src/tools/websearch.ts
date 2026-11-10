import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { ToolDefinition } from "../engine/types.js";
import { validateToolParams } from "../engine/tool-input.js";

const MAX_RESULTS = 5;
const MAX_RESPONSE_BYTES = 1_048_576;
const SEARCH_TIMEOUT_MS = 30_000;
type SearchResult = { title: string; url: string; snippet: string };
type SearchParams = {
  query: string;
  response_format?: "legacy" | "evidence";
  language?: string;
  time_range?: "day" | "week" | "month" | "year";
  max_age_hours?: number;
  include_domains?: string[];
  exclude_domains?: string[];
};
type SearchFilters = Omit<SearchParams, "query" | "response_format">;
type SearchExcerpt = {
  provider_rank: number;
  title: string;
  snippet: string;
  provider_published_at: string | null;
};
type SearchEvidence = {
  schema_version: 1;
  retrieval_id: string;
  provider: "tavily";
  retrieved_at: string;
  content_kind: "search_excerpt";
  verification_status: "unverified";
  page_read_by_karta: false;
  requested_filters: SearchFilters;
  provider_request_id: string | null;
  provider_reported_credits: number | null;
  provider_result_count: number;
  duplicate_urls_grouped: number;
  sources: Array<{
    source_id: string;
    result_index: number;
    url: string;
    excerpts: SearchExcerpt[];
  }>;
};
type SearchResponse = { results: SearchResult[]; evidence?: SearchEvidence };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Domain filters are search preferences, never network permissions. */
function domainFilters(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("Invalid domains");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
  if (typeof length !== "number" || !Number.isInteger(length) || length < 1 || length > 10 ||
    Reflect.ownKeys(value).length !== length + 1) throw new Error("Invalid domains");
  const domains: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid domain descriptor");
    const domain: unknown = descriptor.value;
    if (typeof domain !== "string" || domain.length > 253 || domain !== domain.trim() || /[\s/\\?#@:]/u.test(domain)) {
      throw new Error("Invalid domain");
    }
    const hostname = new URL(`https://${domain}`).hostname.toLowerCase();
    if (hostname.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
      throw new Error("Invalid domain");
    }
    domains.push(hostname);
  }
  return [...new Set(domains)];
}

/** Reuse KARTA's schema validation, then enforce bounds it cannot express yet.
 * Snapshot arrays before awaiting transport; never spread arbitrary input into
 * a provider request, and never disclose an invalid key/value in an exception.
 */
function searchParams(value: SearchParams): SearchParams {
  try {
    if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error("Invalid parameter object");
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !Object.hasOwn(webSearchTool.inputSchema!.properties, key)) {
        throw new Error("Invalid parameter key");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new Error("Invalid parameter descriptor");
      // Validate array descriptors before the shared validator can read indices
      // or invoke user-provided iteration. Only copied plain data reaches it.
      snapshot[key] = key === "include_domains" || key === "exclude_domains"
        ? domainFilters(descriptor.value) : descriptor.value;
    }
    validateToolParams(webSearchTool, snapshot);
    const input = snapshot as SearchParams;
    if (!input.query.trim() || Object.values(input).some(item => item === null)) {
      throw new Error("Invalid search parameters");
    }
    if (input.language !== undefined && !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(input.language)) {
      throw new Error("Invalid language");
    }
    const include = input.include_domains;
    const exclude = input.exclude_domains;
    if (include?.some(domain => exclude?.some(blocked => domain === blocked || domain.endsWith(`.${blocked}`)))) {
      throw new Error("Contradictory domains");
    }
    return {
      query: input.query,
      ...(input.response_format !== undefined ? { response_format: input.response_format } : {}),
      ...(input.language !== undefined ? { language: input.language.toLowerCase() } : {}),
      ...(input.time_range !== undefined ? { time_range: input.time_range } : {}),
      ...(input.max_age_hours !== undefined ? { max_age_hours: input.max_age_hours } : {}),
      ...(include ? { include_domains: include } : {}),
      ...(exclude ? { exclude_domains: exclude } : {}),
    };
  } catch {
    throw new Error("Paramètres de recherche invalides.");
  }
}

/** Optional provider dates remain estimates, not verified publication dates.
 * Only round-trippable calendar dates, UTC ISO timestamps and RFC 1123 dates
 * are retained. Unknown formats and impossible dates remain explicitly unknown.
 */
function providerDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const iso = date.toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && iso.slice(0, 10) === value) return value;
  if (value === iso || value === iso.replace(".000Z", "Z") || value === date.toUTCString()) return iso;
  return null;
}

/** Group only URL-equivalent hits; keep every distinct excerpt for that URL.
 * Query order, signatures, path case and fragments are intentionally retained.
 * IDs are local to this retrieval, never copied from untrusted provider fields.
 * This is a handoff to SATYA/PRAMANA, not a second proof store or verification.
 */
function withEvidence(results: SearchResult[], raw: unknown, params: SearchParams): SearchResponse {
  const data = raw as { results: Array<Record<string, unknown>>; request_id?: unknown; usage?: unknown };
  const retrievalId = randomUUID();
  const unique: SearchResult[] = [];
  const sources: SearchEvidence["sources"] = [];
  const byUrl = new Map<string, number>();
  results.forEach((result, index) => {
    const key = new URL(result.url).href;
    const excerpt: SearchExcerpt = {
      provider_rank: index + 1, title: result.title, snippet: result.snippet,
      provider_published_at: providerDate(data.results[index].published_date),
    };
    const existing = byUrl.get(key);
    if (existing !== undefined) {
      const previous = sources[existing].excerpts;
      if (!previous.some(item => item.title === excerpt.title && item.snippet === excerpt.snippet &&
        item.provider_published_at === excerpt.provider_published_at)) previous.push(excerpt);
      return;
    }
    const resultIndex = unique.length;
    byUrl.set(key, resultIndex);
    unique.push(result);
    sources.push({
      source_id: `${retrievalId}:${resultIndex + 1}`, result_index: resultIndex,
      url: result.url, excerpts: [excerpt],
    });
  });
  const { query: _query, response_format: _format, ...filters } = params;
  const credits = record(data.usage) ? data.usage.credits : undefined;
  return {
    results: unique,
    evidence: {
      schema_version: 1, retrieval_id: retrievalId, provider: "tavily",
      retrieved_at: new Date().toISOString(), content_kind: "search_excerpt",
      verification_status: "unverified", page_read_by_karta: false,
      requested_filters: filters,
      provider_request_id: typeof data.request_id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(data.request_id)
        ? data.request_id : null,
      provider_reported_credits: typeof credits === "number" && Number.isFinite(credits) &&
        credits >= 0 && credits <= Number.MAX_SAFE_INTEGER ? credits : null,
      provider_result_count: results.length, duplicate_urls_grouped: results.length - unique.length,
      sources,
    },
  };
}

/** Preserve the existing projection; optional Tavily fields are not execution authority.
 * Contract: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
function searchResults(value: unknown): SearchResult[] {
  if (!record(value) || !Array.isArray(value.results) || value.results.length > MAX_RESULTS) {
    throw new Error("Invalid search response");
  }
  return value.results.map((item: unknown) => {
    if (!record(item) || typeof item.title !== "string" || item.title.length > 4_096
      || typeof item.content !== "string" || item.content.length > 100_000
      || typeof item.url !== "string" || item.url.length === 0 || item.url.length > 8_192
      // eslint-disable-next-line no-control-regex -- URL parsing can normalize control bytes; reject them before parsing.
      || item.url !== item.url.trim() || /[\u0000-\u001f\u007f]/.test(item.url)) {
      throw new Error("Invalid search result");
    }
    const url = new URL(item.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error("Invalid source URL");
    }
    return { title: item.title, url: item.url, snippet: item.content };
  });
}

function assertSearchActive(signal: AbortSignal, expiresAt: number): void {
  signal.throwIfAborted();
  // Timers can run after a chain of resolved promises or synchronous work.
  // A delayed timer must never turn an expired search into a successful one.
  if (performance.now() >= expiresAt) throw new Error("Search deadline exceeded");
}

async function readSearchResponse(response: Response, signal: AbortSignal, expiresAt: number): Promise<unknown> {
  assertSearchActive(signal, expiresAt);
  if (!response.body) throw new Error("Missing search response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      assertSearchActive(signal, expiresAt);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("Search response too large");
      }
      // The producer may reuse its buffer for the next chunk.
      chunks.push(new Uint8Array(chunk.value));
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export const webSearchTool: ToolDefinition<SearchParams, SearchResponse> = {
  name: "web_search",
  description: "Recherche web via Tavily. Langue, fraîcheur et domaines sont des préférences explicites. " +
    "response_format=evidence fournit des extraits sourçables, non vérifiés ; aucune page lue par KARTA. " +
    "Envoyer seulement la requête publique nécessaire, jamais le profil privé complet.",
  sensitive: false,
  tracePolicy: "metadata_only",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 2000 },
      response_format: { type: "string", enum: ["legacy", "evidence"] },
      language: { type: "string", minLength: 2, maxLength: 5, description: "Langue souhaitée, ex. fr, en, zh-cn ; préférence de classement." },
      time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Fenêtre de publication demandée au fournisseur ; les dates inconnues peuvent subsister." },
      max_age_hours: { type: "integer", minimum: 0, maximum: 720, description: "Âge maximal demandé de la copie fournisseur, distinct de la date de publication. 0 demande une récupération récente." },
      include_domains: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
      exclude_domains: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async execute(params) {
    const requestParams = searchParams(params);
    if (!config.tavilyApiKey) throw new Error("TAVILY_API_KEY non configurée côté KARTA");
    const { query, response_format: format, ...filters } = requestParams;
    const enriched = format === "evidence";

    // Same deadline/AbortController pattern as web-access-plan: no retries or
    // new execution framework. The deadline includes reading the response body.
    const controller = new AbortController();
    const expiresAt = performance.now() + SEARCH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Search deadline exceeded"));
      }, SEARCH_TIMEOUT_MS);
    });
    const request = async () => {
      assertSearchActive(controller.signal, expiresAt);
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST", redirect: "error", signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.tavilyApiKey}` },
        body: JSON.stringify({ query, max_results: MAX_RESULTS, ...filters,
          ...(enriched ? { search_depth: "basic", topic: "general", auto_parameters: false,
            include_answer: false, include_raw_content: false, include_images: false,
            include_published_date: true, include_usage: true } : {}),
          ...(filters.include_domains ? { include_domains_mode: "restrict" } : {}),
        }),
      });
      try {
        assertSearchActive(controller.signal, expiresAt);
        if (!response.ok) throw new Error("Search request not confirmed");
        const data = await readSearchResponse(response, controller.signal, expiresAt);
        assertSearchActive(controller.signal, expiresAt);
        const results = searchResults(data);
        const result = enriched ? withEvidence(results, data, requestParams) : { results };
        assertSearchActive(controller.signal, expiresAt);
        return result;
      } catch (error) {
        // Own the body even if fetch ignores abort and returns after expiry.
        // The reader releases its lock before this cleanup; cancellation must
        // not make an error wait for a non-cooperative producer.
        void response.body?.cancel().catch(() => undefined);
        throw error;
      }
    };
    try {
      const result = await Promise.race([request(), deadline]);
      assertSearchActive(controller.signal, expiresAt);
      return result;
    } catch {
      controller.abort();
      // Transport, JSON and provider errors can contain credentials or private
      // request details. Never echo their bodies, messages or causes.
      throw new Error("Recherche Tavily indisponible : réponse invalide ou délai dépassé.");
    } finally {
      clearTimeout(timer);
    }
  },
};
